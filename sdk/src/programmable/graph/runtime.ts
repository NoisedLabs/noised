/**
 * The autopilot's per-node runtime rules, mirroring crates/noised-rules
 * src/graph.rs (`current_epoch`, `Graph::due`, `Graph::runnable`,
 * `Graph::run_cap`, `Graph::shares`), and the keeper's view of a launch's
 * autopilot (`nodeStatus`, `findDueNodes`): what the program's `run` would
 * do right now, decided by the program's own logic (`planRun`, a port of
 * programs/noised-autopilot src/logic.rs).
 *
 * - EVERY(secs): due when now >= lastRun + secs.
 * - AFTER(p): due when p's last success has a higher run sequence number
 *   than this node's (the autopilot numbers successful runs 1, 2, 3, ...).
 * - ON_GRADUATED: due once (never ran) after graduation.  WHEN: condition only.
 * - Then: runs this epoch < max, spent this epoch < budget, the condition.
 * - Epochs stay aligned to the first one (epochStart + k * epochSecs).
 * - Like the program, a run first observes the pool (once graduated) and
 *   moves the reference (reference.ts), which starts at the launch's
 *   migration price. Price conditions must hold across the reference and
 *   every price observed in the window, this run's included (review F1:
 *   PRICE_GTE on the lowest, PRICE_LTE on the highest; `graphConditionOver`).
 * - Buybacks: graduation, observations spanning a minute, spot within the
 *   premium over min(reference, lowest observed price), and a minimum out
 *   priced from that bound. With the pool's fee (`AutopilotEnv.poolFeeBps`)
 *   the status also says whether the swap can fill (market.ts) and the
 *   largest amount that does, down to the keeper's floor (1% of the pool's SOL).
 * - Tips are at most TIP_LAMPORTS, a tenth of what the run moved, and the
 *   tip epoch's cap (takeTip).
 */
import { ACTION, AUTOPILOT, BPS_DENOMINATOR, OP, TRIGGER, U64_MAX } from "../constants.js";
import { type Address, addressBytes, toAddress } from "../bytes.js";
import { type CondNode, evalCondition, evalConditionBounded } from "../cond/vm.js";
import { ProgError } from "../errors.js";
import { type AutopilotErrorName, conditionPrices, planRun } from "../autopilot/logic.js";
import { type RawGraph, verifyGraphBytes } from "./codec.js";
import { buybackFills, estimateBuybackOut, largestFillable, premiumCoversFee } from "./market.js";
import { compileGraph, type Graph } from "./model.js";
import { buybackCap, follow, keeperFloor, minOut, observe, observed, type ObsBucket, type PriceState, type Seen, seen, tokenValue } from "./reference.js";

export interface NodeRuntime {
  /** Unix time of the last successful run (0 = never). */
  lastRun: number;
  /** Run sequence number of the last successful run (0 = never). */
  lastSeq: number;
  /** Start of the epoch the counters below count. */
  epochStart: number;
  runsInEpoch: number;
  spentInEpoch: bigint;
}

/** What the `Autopilot` account holds about the active graph (numbers are unix seconds). */
export interface AutopilotState {
  nodes: NodeRuntime[];
  /** Successful runs so far, across all nodes (the last sequence number given). */
  seq: number;
  /** The reference sqrt price (Q64.64): the launch's migration price at first, then moved only by observations. */
  refSqrtPriceQ64: bigint;
  tipsInEpoch: bigint;
  tipEpochStart: number;
  /** Observations of the pool price: the program's current and previous bucket (absent: none). */
  observations?: ObsBucket[];
  /** The reference's rise allowance (sqrt-bps-seconds) and when it last accrued (absent: 0 at time 0, i.e. one hour banked). */
  refAllowance?: bigint;
  refAllowanceAt?: number;
  /** When the reference last moved. */
  refUpdatedAt?: number;
  /**
   * The stored operator, the only signer of operator-gated nodes: absent =
   * the graph's own; null = none (revoked). `autopilotStateOf` sets it from the account.
   */
  operator?: Address | null;
  /**
   * Indexed like the nodes: what keepers' partial buybacks moved of each
   * node's open run (`Autopilot.partial_spent`; audit 4, A4-2). A run moves
   * at most `p1` minus this; a completed run clears it. Absent: all 0.
   */
  partialSpent?: bigint[];
}

export interface AutopilotEnv {
  now: number;
  /** The treasury's wSOL and token balances. */
  treasurySol: bigint;
  treasuryTokens: bigint;
  /** The launch's DAMM v2 pool is bound (`bind_pool`). */
  graduated: boolean;
  /** The pool's sqrt price now (Q64.64); not read before graduation (there is no pool). */
  spotSqrtPriceQ64: bigint;
  /** The pool's SOL (its wSOL vault), lamports: the keeper's least buyback (1% of it) and, with `poolFeeBps`, the price impact. */
  poolSol?: bigint;
  /**
   * The pool's trading fee in bps (`MIGRATION_FEE_TIERS_BPS[launch.migrationFeeOption]`).
   * With it a buyback is due only if its swap can fill (estimated: market.ts);
   * without it the status only applies the program's checks.
   */
  poolFeeBps?: number;
}

/** noised_rules::NotDue, in discriminant order (same names). */
export const NOT_DUE = [
  "NoSuchNode",
  "Waiting",
  "AwaitingParent",
  "NotGraduated",
  "AlreadyRan",
  "MaxRunsReached",
  "BudgetSpent",
  "ConditionFalse",
  "Malformed",
] as const;

/** The crate's NotDue, by name. */
export type NotDueCode = (typeof NOT_DUE)[number];

/**
 * Why a node can't run now, for a UI:
 * - notDue / condition / budget / maxRuns: the graph says not now;
 * - empty: the treasury holds nothing the node could move;
 * - notGraduated: buybacks start after graduation;
 * - notObserved: no price check at least a minute old in the last 15 to 30 minutes (anyone can run `update_price`);
 * - priceAboveRef: the pool price is above the bound plus the node's premium;
 * - priceOutOfRange: the bound prices no tokens (the program refuses);
 * - noOperator: an operator-only step whose operator was removed;
 * - premiumBelowFee: the premium can never cover the pool's fee (needs `poolFeeBps`);
 * - swapShortfall: the swap would return less than the program's minimum at every allowed amount (needs `poolFeeBps`).
 */
export type BlockReason =
  | "notDue"
  | "condition"
  | "budget"
  | "maxRuns"
  | "empty"
  | "notGraduated"
  | "notObserved"
  | "priceAboveRef"
  | "priceOutOfRange"
  | "noOperator"
  | "premiumBelowFee"
  | "swapShortfall";

export interface NodeStatus {
  due: boolean;
  reason: BlockReason | null;
  /** The crate's NotDue name when the trigger / limits / condition say no. */
  notDue: NotDueCode | null;
  /** The program's error a run would fail with now (`AutopilotError` name; `SwapShortfall` for a swap that can't fill); null when due. */
  error: AutopilotErrorName | null;
  /** Plain English. */
  why: string;
  /** The most this run may move (lamports or raw tokens); 0 when not due. */
  maxAmount: bigint;
  /** The least a keeper may choose (buybacks with a known pool: 1% of its SOL, at most maxAmount; operator: 1); otherwise maxAmount. */
  minAmount: bigint;
  /**
   * What to run with: maxAmount, or for a buyback whose full amount the swap
   * would not fill, the largest amount it fills that the program accepts as
   * a partial run (at least minAmount, and leaving at least the keeper floor
   * of the cap: audit 4, A4-2). A keeper passes it as `amount` when it is
   * below maxAmount (`partial` is then true). 0 when not due.
   */
  amount: bigint;
  /**
   * The node's run cap now: `min(p1 - partialSpent, budget left this
   * epoch)` (0 when not due). `maxAmount` is this or the treasury's balance,
   * whichever is lower.
   */
  cap: bigint;
  /**
   * Running `amount` would be a keeper's partial buyback (audit 4, A4-2): it
   * spends from the budget and earns its share of a tip (TIP_LAMPORTS *
   * amount / p1 at most), but the node stays due for the rest of its run.
   */
  partial: boolean;
  /** A buyback's minimum out for `amount` (the program's), else null. */
  minOut: bigint | null;
  /** A buyback's estimated output for `amount` (with `poolFeeBps`), else null. */
  expectedOut: bigint | null;
  /** Only the operator may run it. */
  operatorOnly: boolean;
}

/** A graph with its verified raw form (compiled once). */
export interface CompiledGraph {
  graph: Graph;
  raw: RawGraph;
  /** Condition slice of each node (empty = always). */
  conds: CondNode[][];
}

const cache = new WeakMap<Graph, CompiledGraph>();

/** Compiles (and caches) a graph for the runtime; throws ProgError if invalid. */
export function compiledGraph(g: Graph): CompiledGraph {
  const hit = cache.get(g);
  if (hit) return hit;
  const raw = verifyGraphBytes(compileGraph(g));
  const out: CompiledGraph = { graph: g, raw, conds: raw.nodes.map((n) => raw.cond.slice(n.condOff, n.condOff + n.condLen)) };
  cache.set(g, out);
  return out;
}

/**
 * A fresh autopilot for `g`, as `init_autopilot` and `apply_pending` leave
 * it: the reference at `refSqrtPriceQ64` (on chain, the launch's migration
 * price: `migrationSqrtPrice` of its DBC config, or `priceToSqrtPriceQ64`).
 */
export function newAutopilotState(g: Graph, refSqrtPriceQ64: bigint): AutopilotState {
  if (typeof refSqrtPriceQ64 !== "bigint" || refSqrtPriceQ64 <= 0n || refSqrtPriceQ64 >= 1n << 128n) {
    throw new ProgError("BadModel", "newAutopilotState needs the reference sqrt price (Q64.64, > 0): the launch's migration price");
  }
  return {
    nodes: g.nodes.map(() => ({ lastRun: 0, lastSeq: 0, epochStart: 0, runsInEpoch: 0, spentInEpoch: 0n })),
    seq: 0,
    refSqrtPriceQ64,
    tipsInEpoch: 0n,
    tipEpochStart: 0,
    observations: [],
    refAllowance: 0n,
    refAllowanceAt: 0,
    refUpdatedAt: 0,
    partialSpent: g.nodes.map(() => 0n),
  };
}

/** What partial buybacks moved of node `index`'s open run (0 when the state does not track it). */
function partialOf(state: AutopilotState, index: number): bigint {
  const v = state.partialSpent?.[index];
  return typeof v === "bigint" && v > 0n ? v : 0n;
}

// ------------------------------------------------- the reference price ---

function checkRef(state: AutopilotState): bigint {
  const r = state.refSqrtPriceQ64 as bigint | null | undefined;
  if (typeof r !== "bigint" || r <= 0n) {
    throw new ProgError("BadModel", "the autopilot state has no reference price: seed it with the launch's migration price (newAutopilotState(g, migrationSqrtPrice))");
  }
  return r;
}

/** The state's reference and observations as the program's PriceState (a copy). */
export function priceStateOf(state: AutopilotState): PriceState {
  const o = state.observations ?? [];
  const copy = (i: number): ObsBucket => ({ index: o[i]?.index ?? 0, firstAt: o[i]?.firstAt ?? 0, min: o[i]?.min ?? 0n, max: o[i]?.max ?? 0n });
  return {
    reference: checkRef(state),
    updatedAt: state.refUpdatedAt ?? 0,
    allowance: state.refAllowance ?? 0n,
    allowanceAt: state.refAllowanceAt ?? 0,
    observations: [copy(0), copy(1)],
  };
}

/** Writes a PriceState back into the model state. */
export function storePriceState(state: AutopilotState, p: PriceState): void {
  state.refSqrtPriceQ64 = p.reference;
  state.refUpdatedAt = p.updatedAt;
  state.refAllowance = p.allowance;
  state.refAllowanceAt = p.allowanceAt;
  state.observations = [{ ...p.observations[0] }, { ...p.observations[1] }];
}

/**
 * What `run` does first, on a copy: once graduated, observe the pool at
 * `now`; then move the reference toward what the window agrees on.
 * `window`: what the window saw if it spans a minute (`seen`, the buyback
 * bound); `observed`: every price it holds however recent (`observed`, what
 * price conditions must hold across).
 */
export function afterObservation(
  state: AutopilotState,
  now: number,
  spot: bigint,
  graduated: boolean,
): { price: PriceState; window: Seen | null; observed: Seen | null } {
  const p = priceStateOf(state);
  if (graduated) observe(p.observations, now, spot);
  const window = seen(p.observations, now);
  follow(p, window, now);
  return { price: p, window, observed: observed(p.observations, now) };
}

/**
 * What `update_price` does (anyone, any time after graduation, free):
 * records an observation of the pool's sqrt price at `now` and moves the
 * reference toward what the window agrees on. Returns whether it moved.
 */
export function observePrice(state: AutopilotState, now: number, spotSqrtPriceQ64: bigint): boolean {
  const p = priceStateOf(state);
  const before = p.reference;
  observe(p.observations, now, spotSqrtPriceQ64);
  follow(p, seen(p.observations, now), now);
  storePriceState(state, p);
  return p.reference !== before;
}

// ------------------------------------------------- exact crate mirrors (bigint) ---

/** The crate's NodeState (i64 / u64 exact). */
export interface RawNodeState {
  lastRun: bigint;
  lastSeq: bigint;
  epochStart: bigint;
  runsInEpoch: number;
  spentInEpoch: bigint;
}

/** The crate's GraphCtx (sqrtPrice is the reference price, u128). */
export interface RawGraphCtx {
  now: bigint;
  treasurySol: bigint;
  treasuryToken: bigint;
  graduated: boolean;
  sqrtPrice: bigint;
  /** Each graph node's runs in its current epoch (16 entries). */
  runsInEpoch: readonly number[];
}

/** The crate's current_epoch, exact on i64 times. */
export function currentEpochRaw(epochSecs: number, s: RawNodeState, now: bigint): { start: bigint; runs: number; spent: bigint } {
  const stored = { start: s.epochStart, runs: s.runsInEpoch, spent: s.spentInEpoch };
  if (now < s.epochStart) return stored;
  const len = BigInt(Math.max(1, epochSecs));
  const elapsed = now - s.epochStart;
  if (elapsed < len) return stored;
  return { start: now - (elapsed % len), runs: 0, spent: 0n };
}

/** The crate's Graph::due (trigger, then max runs, then budget). null = due. */
export function graphDue(g: RawGraph, index: number, states: readonly RawNodeState[], now: bigint, graduated: boolean): NotDueCode | null {
  const n = g.nodes[index];
  const st = states[index];
  if (!n || !st) return "NoSuchNode";
  switch (n.trigger) {
    case TRIGGER.EVERY:
      if (now < st.lastRun + n.triggerArg) return "Waiting";
      break;
    case TRIGGER.AFTER: {
      const parent = n.triggerArg < BigInt(states.length) ? states[Number(n.triggerArg)] : undefined;
      if (!parent) return "NoSuchNode";
      if (parent.lastSeq <= st.lastSeq) return "AwaitingParent";
      break;
    }
    case TRIGGER.ON_GRADUATED:
      if (st.lastSeq !== 0n) return "AlreadyRan";
      if (!graduated) return "NotGraduated";
      break;
    case TRIGGER.WHEN:
      break;
    default:
      return "Malformed";
  }
  const e = currentEpochRaw(n.epochSecs, st, now);
  if (e.runs >= n.maxRunsPerEpoch) return "MaxRunsReached";
  if (e.spent >= n.budgetPerEpoch) return "BudgetSpent";
  return null;
}

/** The crate's Graph::condition (true without one; null if malformed). */
export function graphCondition(g: RawGraph, index: number, c: RawGraphCtx): boolean | null {
  const n = g.nodes[index];
  if (!n) return null;
  if (n.condLen === 0) return true;
  if (n.condOff + n.condLen > g.cond.length) return null;
  const timeLt = (arg: bigint): boolean => c.now < 0n || c.now < arg;
  return evalCondition(g.cond.slice(n.condOff, n.condOff + n.condLen), (x) => {
    switch (x.op) {
      case OP.TREASURY_SOL_GTE:
        return c.treasurySol >= x.arg;
      case OP.TREASURY_TOKEN_GTE:
        return c.treasuryToken >= x.arg;
      case OP.GRADUATED:
        return c.graduated;
      case OP.PRICE_LTE:
        return c.sqrtPrice <= x.arg;
      case OP.PRICE_GTE:
        return c.sqrtPrice >= x.arg;
      case OP.NOW_GE:
        return !timeLt(x.arg);
      case OP.NOW_LT:
        return timeLt(x.arg);
      case OP.RUNS_IN_EPOCH_LT: {
        const r = c.runsInEpoch[x.a];
        return r === undefined ? null : BigInt(r) < x.arg;
      }
      default:
        return null;
    }
  });
}

/** The crate's Graph::runnable: due, then the condition. null = runnable. */
export function graphRunnable(g: RawGraph, index: number, states: readonly RawNodeState[], c: RawGraphCtx): NotDueCode | null {
  const d = graphDue(g, index, states, c.now, c.graduated);
  if (d !== null) return d;
  const h = graphCondition(g, index, c);
  return h === null ? "Malformed" : h ? null : "ConditionFalse";
}

/** The crate's PriceRange: price conditions must hold at every sqrt price from `low` to `high`. */
export interface PriceRange {
  low: bigint;
  high: bigint;
}

/**
 * The crate's Graph::condition_over, what the program decides with (review
 * F1): node `index`'s condition holds for every sqrt price in `prices`
 * (`c.sqrtPrice` is not read). PRICE_GTE x needs `low >= x`, PRICE_LTE x
 * needs `high <= x`; under NOT the other end decides (`evalConditionBounded`),
 * so a wider range can only turn a condition false. True without one; null
 * if malformed.
 */
export function graphConditionOver(g: RawGraph, index: number, c: RawGraphCtx, prices: PriceRange): boolean | null {
  const n = g.nodes[index];
  if (!n) return null;
  if (n.condLen === 0) return true;
  if (n.condOff + n.condLen > g.cond.length) return null;
  const timeLt = (arg: bigint): boolean => c.now < 0n || c.now < arg;
  const sure = (v: boolean): [boolean, boolean] => [v, v];
  return evalConditionBounded(g.cond.slice(n.condOff, n.condOff + n.condLen), (x) => {
    switch (x.op) {
      case OP.TREASURY_SOL_GTE:
        return sure(c.treasurySol >= x.arg);
      case OP.TREASURY_TOKEN_GTE:
        return sure(c.treasuryToken >= x.arg);
      case OP.GRADUATED:
        return sure(c.graduated);
      case OP.PRICE_LTE:
        return [prices.high <= x.arg, prices.low <= x.arg];
      case OP.PRICE_GTE:
        return [prices.low >= x.arg, prices.high >= x.arg];
      case OP.NOW_GE:
        return sure(!timeLt(x.arg));
      case OP.NOW_LT:
        return sure(timeLt(x.arg));
      case OP.RUNS_IN_EPOCH_LT: {
        const r = c.runsInEpoch[x.a];
        return r === undefined ? null : sure(BigInt(r) < x.arg);
      }
      default:
        return null;
    }
  });
}

/** The crate's Graph::runnable_over: due, then the condition over `prices`. null = runnable. */
export function graphRunnableOver(g: RawGraph, index: number, states: readonly RawNodeState[], c: RawGraphCtx, prices: PriceRange): NotDueCode | null {
  const d = graphDue(g, index, states, c.now, c.graduated);
  if (d !== null) return d;
  const h = graphConditionOver(g, index, c, prices);
  return h === null ? "Malformed" : h ? null : "ConditionFalse";
}

/** The crate's Graph::run_cap: min(budget - spent this epoch, p1), saturating. */
export function graphRunCap(g: RawGraph, index: number, s: RawNodeState, now: bigint): bigint {
  const n = g.nodes[index];
  if (!n) return 0n;
  const spent = currentEpochRaw(n.epochSecs, s, now).spent;
  const left = n.budgetPerEpoch > spent ? n.budgetPerEpoch - spent : 0n;
  return left < n.p1 ? left : n.p1;
}

/** The crate's Graph::runs_in_epoch: each node's runs in its current epoch (16 entries, zero past the nodes). */
export function graphRunsInEpoch(g: RawGraph, states: readonly RawNodeState[], now: bigint): number[] {
  const out = new Array<number>(16).fill(0);
  g.nodes.forEach((n, i) => {
    const s = states[i];
    if (s && i < 16) out[i] = currentEpochRaw(n.epochSecs, s, now).runs;
  });
  return out;
}

/**
 * One recipient's share as the crate computes it: floor(amount * bps / 10000)
 * in 128 bits, and 0 if that does not fit a u64 (only with unverified bps
 * above 10,000: the program pays nothing rather than a wrapped amount).
 */
function shareOf(amount: bigint, bps: number): bigint {
  const s = (amount * BigInt(bps)) / BigInt(BPS_DENOMINATOR);
  return s > U64_MAX ? 0n : s;
}

/** The crate's Graph::shares: floor(amount * bps / 10000) per recipient (8 entries, zero past them). */
export function graphShares(g: RawGraph, amount: bigint): bigint[] {
  const out = new Array<bigint>(8).fill(0n);
  g.recipients.forEach((r, i) => {
    if (i < 8) out[i] = shareOf(amount, r.bps);
  });
  return out;
}

const rawState = (r: NodeRuntime): RawNodeState => ({
  lastRun: BigInt(r.lastRun),
  lastSeq: BigInt(r.lastSeq),
  epochStart: BigInt(r.epochStart),
  runsInEpoch: r.runsInEpoch,
  spentInEpoch: r.spentInEpoch,
});

// ------------------------------------------------- number-based runtime (keeper / simulator) ---

/**
 * The crate's current_epoch: the stored epoch while now < start + len (or the
 * clock is before it), otherwise a fresh one starting at the latest
 * start + k * len <= now.
 */
export function currentEpoch(epochSecs: number, rt: NodeRuntime, now: number): { start: number; runs: number; spent: bigint } {
  const e = currentEpochRaw(epochSecs, rawState(rt), BigInt(now));
  return { start: Number(e.start), runs: e.runs, spent: e.spent };
}

/** @deprecated alias of currentEpoch with the old field names. */
export function epochView(epochSecs: number, rt: NodeRuntime, now: number): { runs: number; spent: bigint; epochStart: number } {
  const e = currentEpoch(epochSecs, rt, now);
  return { runs: e.runs, spent: e.spent, epochStart: e.start };
}

/** The crate's Graph::due on the number-based state. null = due. */
export function nodeDue(cg: CompiledGraph, state: AutopilotState, index: number, now: number, graduated: boolean): NotDueCode | null {
  return graphDue(cg.raw, index, state.nodes.map(rawState), BigInt(now), graduated);
}

/**
 * Node `index`'s condition as a run now decides it (the crate's
 * Graph::condition_over): after this run's observation, price conditions
 * must hold across the reference and every price observed in the window
 * (`conditionPrices`).
 */
export function nodeCondition(cg: CompiledGraph, state: AutopilotState, env: AutopilotEnv, index: number): boolean | null {
  const states = state.nodes.map(rawState);
  const now = BigInt(env.now);
  const after = afterObservation(state, env.now, env.spotSqrtPriceQ64, env.graduated);
  return graphConditionOver(
    cg.raw,
    index,
    {
      now,
      treasurySol: env.treasurySol,
      treasuryToken: env.treasuryTokens,
      graduated: env.graduated,
      sqrtPrice: after.price.reference,
      runsInEpoch: graphRunsInEpoch(cg.raw, states, now),
    },
    conditionPrices(after.price.reference, after.observed),
  );
}

/** The crate's Graph::run_cap: min(budget left this epoch, p1). */
export function runCap(cg: CompiledGraph, state: AutopilotState, index: number, now: number): bigint {
  const s = state.nodes[index];
  return s ? graphRunCap(cg.raw, index, rawState(s), BigInt(now)) : 0n;
}

/** The crate's Graph::shares: floor(amount * bps / 10000) per recipient; dust stays. */
export function shares(g: Graph, amount: bigint): bigint[] {
  return g.recipients.map((r) => shareOf(amount, r.bps));
}

/** True if spot is more than `premiumBps` above the reference (compares prices exactly). */
export function priceAboveRef(spotSqrt: bigint, refSqrt: bigint, premiumBps: number): boolean {
  return spotSqrt * spotSqrt * 10_000n > refSqrt * refSqrt * BigInt(10_000 + premiumBps);
}

const NOT_DUE_TEXT: Record<NotDueCode, [BlockReason, string]> = {
  NoSuchNode: ["notDue", "There is no such step."],
  Waiting: ["notDue", "Waiting for its next turn."],
  AwaitingParent: ["notDue", "Waiting for the step before it."],
  NotGraduated: ["notDue", "Waiting for the token to graduate."],
  AlreadyRan: ["notDue", "Already ran (it runs once)."],
  MaxRunsReached: ["maxRuns", "Already ran as often as allowed this period."],
  BudgetSpent: ["budget", "Used its whole budget for this period."],
  ConditionFalse: ["condition", "Its condition isn't met right now."],
  Malformed: ["notDue", "This step is malformed."],
};

/** The program's refusals that remain once the node is due, as a UI reason. */
const PLAN_TEXT: Partial<Record<AutopilotErrorName, [BlockReason, string]>> = {
  NotGraduated: ["notGraduated", "Buybacks start after the token graduates."],
  NothingToDo: ["empty", "The treasury has nothing this step could move."],
  InvalidAmount: ["empty", "The treasury has nothing this step could move."],
  PriceNotObserved: ["notObserved", "Waiting for a price check: anyone can check the pool's price, and a buyback can run a minute later."],
  PremiumExceeded: ["priceAboveRef", "The price is too far above its recent low; waiting."],
  PriceOutOfRange: ["priceOutOfRange", "The price bound is out of range for this buyback."],
  NoOperator: ["noOperator", "Only the operator could run this step, and the operator was removed."],
};

/** The condition context and the buyback bound at env.now, after the run's own observation (computed once per snapshot). */
interface Snapshot {
  reference: bigint;
  window: Seen | null;
  /** Every price the window holds, however recent: what price conditions must hold across. */
  observed: Seen | null;
  runsInEpoch: number[];
}

/** The stored operator as 32 bytes (all zero: none). */
function operatorBytes(cg: CompiledGraph, state: AutopilotState): Uint8Array {
  const op = state.operator === undefined ? cg.graph.operator : state.operator;
  return op === null ? new Uint8Array(32) : addressBytes(toAddress(op));
}

/** nodeStatus on states already converted for the crate mirrors (shared by nodeStatus / nodeStatuses). */
function statusOf(cg: CompiledGraph, state: AutopilotState, raws: readonly RawNodeState[], snap: () => Snapshot, env: AutopilotEnv, index: number): NodeStatus {
  const n = cg.raw.nodes[index];
  const operatorOnly = n?.operatorGated === 1;
  const no = (reason: BlockReason, why: string, error: AutopilotErrorName | null, notDue: NotDueCode | null = null): NodeStatus => ({
    due: false, reason, notDue, error, why, maxAmount: 0n, minAmount: 0n, amount: 0n, cap: 0n, partial: false, minOut: null, expectedOut: null, operatorOnly,
  });
  const now = BigInt(env.now);
  // The trigger and the epoch limits, then the condition (across the reference and the window's prices, after this run's observation).
  let nd = graphDue(cg.raw, index, raws, now, env.graduated);
  if (nd === null) {
    const s = snap();
    const c = graphConditionOver(
      cg.raw,
      index,
      { now, treasurySol: env.treasurySol, treasuryToken: env.treasuryTokens, graduated: env.graduated, sqrtPrice: s.reference, runsInEpoch: s.runsInEpoch },
      conditionPrices(s.reference, s.observed),
    );
    nd = c === null ? "Malformed" : c ? null : "ConditionFalse";
  }
  if (nd !== null) {
    const [reason, why] = NOT_DUE_TEXT[nd];
    return no(reason, why, notDueErrorName(nd), nd);
  }
  const node = n!;
  const s = snap();
  const balance = node.action === ACTION.BURN ? env.treasuryTokens : env.treasurySol;
  // The program's cap: min(budget left, p1 - what partial buybacks moved of the open run) (audit 4, A4-2).
  const partialSpent = partialOf(state, index);
  const openRun = node.p1 > partialSpent ? node.p1 - partialSpent : 0n;
  const budgetCap = graphRunCap(cg.raw, index, raws[index]!, now);
  const cap = budgetCap < openRun ? budgetCap : openRun;
  const limit = cap < balance ? cap : balance;
  const operator = operatorBytes(cg, state);
  const isBuyback = node.action === ACTION.BUYBACK_BURN;
  const spot = env.graduated ? env.spotSqrtPriceQ64 : null;
  // Decide with the program's planner: a keeper takes the most (no amount); the operator (signing) chooses the most.
  const plan = (amount: bigint | null) =>
    planRun({
      graph: cg.raw,
      node: index,
      now,
      states: raws,
      operator,
      operatorSigner: operatorOnly ? operator : null,
      amount,
      treasurySol: env.treasurySol,
      treasuryToken: env.treasuryTokens,
      graduated: env.graduated,
      spot,
      reference: s.reference,
      seen: s.window,
      observed: s.observed,
      poolQuote: env.poolSol ?? 0n,
      partialSpent,
    });
  const first = plan(operatorOnly ? limit : null);
  if (!first.ok) {
    const t = PLAN_TEXT[first.error];
    if (t !== undefined) return no(t[0], node.action === ACTION.BURN && t[0] === "empty" ? "The treasury has no tokens to burn." : t[1], first.error);
    return no("notDue", `The program would refuse this run now (${first.error}).`, first.error);
  }
  // The planner accepted the whole limit (a keeper's default, the operator's most).
  const max = limit;
  if (!isBuyback || first.value.kind !== "buyback") {
    return {
      due: true, reason: null, notDue: null, error: null, why: readyText(operatorOnly), maxAmount: max, minAmount: operatorOnly ? 1n : max, amount: max, cap, partial: false,
      minOut: null, expectedOut: null, operatorOnly,
    };
  }
  // A buyback: the least a keeper may choose, and whether the swap fills.
  const floor = env.poolSol === undefined ? max : keeperFloor(env.poolSol);
  let least = operatorOnly ? 1n : floor < max ? floor : max;
  if (least < 1n) least = 1n;
  const bound = buybackCap(s.reference, s.window)!;
  const p2 = node.p2;
  if (env.poolFeeBps === undefined) {
    return {
      due: true, reason: null, notDue: null, error: null, why: readyText(operatorOnly), maxAmount: max, minAmount: least, amount: max, cap, partial: false,
      minOut: first.value.minOut, expectedOut: null, operatorOnly,
    };
  }
  const fee = env.poolFeeBps;
  const spotNow = env.spotSqrtPriceQ64;
  if (!premiumCoversFee(p2, fee)) {
    return no("premiumBelowFee", `Its premium (${fmtBps(p2)}) is below the pool's fee (${fmtBps(BigInt(fee))}), so the swap can never return the minimum the program requires.`, "SwapShortfall");
  }
  const fills = (a: bigint): boolean => buybackFills(a, bound, p2, spotNow, fee, env.poolSol);
  let amount: bigint | null;
  if (operatorOnly) amount = largestFillable(least, max, fills);
  else if (fills(max)) amount = max; // no amount: the whole limit, a completed run
  else {
    // A keeper's smaller amount is a partial run (audit 4, A4-2): it must leave at least the floor of the cap
    // (`amount == cap || cap - amount >= floor`), so it is at most cap - floor.
    const room = cap > floor ? cap - floor : 0n;
    amount = largestFillable(least, room < max ? room : max, fills);
  }
  if (amount === null) {
    return no("swapShortfall", "The pool is too shallow (or the price too far above its recent low) for even the smallest allowed buyback to return the program's minimum; waiting.", "SwapShortfall");
  }
  const partial = !operatorOnly && amount < max && amount < cap;
  return {
    due: true, reason: null, notDue: null, error: null,
    why: readyText(operatorOnly) + (amount < max ? ` A smaller buyback (${amount} of ${max} lamports) fills${partial ? "; the rest of this run stays due" : ""}.` : ""),
    maxAmount: max, minAmount: least, amount, cap, partial, minOut: minOut(amount, bound, p2), expectedOut: estimateBuybackOut(amount, spotNow, fee, env.poolSol), operatorOnly,
  };
}

const readyText = (operatorOnly: boolean): string => (operatorOnly ? "Ready for the operator." : "Ready: anyone can run it now.");
const fmtBps = (b: bigint): string => `${Number(b) / 100}%`;

function notDueErrorName(nd: NotDueCode): AutopilotErrorName {
  switch (nd) {
    case "NoSuchNode":
      return "NoSuchNode";
    case "Waiting":
    case "AwaitingParent":
    case "AlreadyRan":
      return "NodeNotDue";
    case "NotGraduated":
      return "NotGraduated";
    case "MaxRunsReached":
      return "MaxRunsReached";
    case "BudgetSpent":
      return "BudgetSpent";
    case "ConditionFalse":
      return "ConditionFalse";
    case "Malformed":
      return "InvalidGraph";
  }
}

/** The snapshot at env.now: the reference after the run's observation, each node's runs this epoch. */
function snapOf(cg: CompiledGraph, state: AutopilotState, raws: readonly RawNodeState[], env: AutopilotEnv): () => Snapshot {
  let c: Snapshot | null = null;
  return () => {
    if (c === null) {
      const { price, window, observed } = afterObservation(state, env.now, env.spotSqrtPriceQ64, env.graduated);
      c = { reference: price.reference, window, observed, runsInEpoch: graphRunsInEpoch(cg.raw, raws, BigInt(env.now)) };
    }
    return c;
  };
}

/** Whether node `index` can run now, why not, and how much it may (and should) move. */
export function nodeStatus(g: Graph, state: AutopilotState, env: AutopilotEnv, index: number): NodeStatus {
  const cg = compiledGraph(g);
  const raws = state.nodes.map(rawState);
  return statusOf(cg, state, raws, snapOf(cg, state, raws, env), env, index);
}

/**
 * A reader of node statuses over one snapshot of `state` and `env`, computed
 * on demand (stale once either changes).
 */
export function statusReader(g: Graph, state: AutopilotState, env: AutopilotEnv): (index: number) => NodeStatus {
  const cg = compiledGraph(g);
  const raws = state.nodes.map(rawState);
  const snap = snapOf(cg, state, raws, env);
  return (i) => statusOf(cg, state, raws, snap, env, i);
}

/** nodeStatus of every node at once (one pass over the state; what keepers use). */
export function nodeStatuses(g: Graph, state: AutopilotState, env: AutopilotEnv): NodeStatus[] {
  const read = statusReader(g, state, env);
  return g.nodes.map((_, i) => read(i));
}

/** Indices of the nodes that can run now (operator-gated ones included; check `operatorOnly`). */
export function findDueNodes(g: Graph, state: AutopilotState, env: AutopilotEnv): number[] {
  const out: number[] = [];
  nodeStatuses(g, state, env).forEach((st, i) => {
    if (st.due) out.push(i);
  });
  return out;
}

/**
 * Records a successful run of `amount` at `now` (`logic::record_run`): the
 * next sequence number and the node's spend this epoch; then a completed run
 * (its runs this epoch, last run and sequence number; its open run closed)
 * or, with `partial` (a keeper's partial buyback, audit 4, A4-2), only what
 * it moved of the node's open run (`partialSpent`): the node stays due.
 */
export function recordRun(g: Graph, state: AutopilotState, index: number, now: number, amount: bigint, partial = false): void {
  const n = g.nodes[index]!;
  const rt = state.nodes[index]!;
  const e = currentEpoch(n.epochSecs, rt, now);
  state.seq += 1;
  rt.epochStart = e.start;
  rt.spentInEpoch = e.spent + amount;
  if (state.partialSpent === undefined) state.partialSpent = g.nodes.map(() => 0n);
  if (partial) {
    rt.runsInEpoch = e.runs;
    state.partialSpent[index] = partialOf(state, index) + amount;
    return;
  }
  rt.runsInEpoch = e.runs + 1;
  rt.lastRun = now;
  rt.lastSeq = state.seq;
  state.partialSpent[index] = 0n;
}

/** Tip parameters (the program's constants by default; a simulation may change them). */
export interface TipOptions {
  lamports?: bigint;
  epochCap?: bigint;
  epochSecs?: number;
  /** A tip is at most this share (per 10,000) of what the run moved. */
  maxShareBps?: number;
}

/**
 * The tip for a run now that moved `value` lamports' worth (`runValue`,
 * `planValue`): min(TIP, `maxTip` (a partial buyback's share, `planMaxTip`;
 * default no further bound), the tip epoch's cap left, what the treasury
 * has, a tenth of `value`). Updates the tip counters. Tip epochs only move
 * forward. With the default options this is exactly the program's
 * `take_tip` (`takeTipRaw`).
 */
export function takeTip(state: AutopilotState, now: number, treasurySol: bigint, value: bigint, tip: TipOptions = {}, maxTip: bigint | null = null): bigint {
  const per = tip.lamports ?? AUTOPILOT.TIP_LAMPORTS;
  const cap = tip.epochCap ?? AUTOPILOT.TIP_EPOCH_CAP;
  const secs = tip.epochSecs ?? AUTOPILOT.TIP_EPOCH_SECS;
  const shareBps = BigInt(tip.maxShareBps ?? AUTOPILOT.TIP_MAX_SHARE_BPS);
  const start = now - (((now % secs) + secs) % secs);
  if (start > state.tipEpochStart) {
    state.tipEpochStart = start;
    state.tipsInEpoch = 0n;
  }
  let t = per;
  if (maxTip !== null && maxTip < t) t = maxTip;
  if (cap - state.tipsInEpoch < t) t = cap - state.tipsInEpoch;
  if (treasurySol < t) t = treasurySol;
  const share = ((value > 0n ? value : 0n) * shareBps) / BigInt(BPS_DENOMINATOR);
  if (share < t) t = share;
  if (t < 0n) t = 0n;
  state.tipsInEpoch += t;
  return t;
}

/**
 * What a run moved, in lamports (what its tip is a share of): SOL swapped or
 * paid; burned tokens at `burnPriceSqrtQ64` (since audit 4, A4-4, the
 * program values a burn at `burnPrice(graduated, reference, lowest observed)`:
 * nothing before graduation).
 */
export function runValue(action: number, amount: bigint, burnPriceSqrtQ64: bigint): bigint {
  return action === ACTION.BURN ? tokenValue(amount, burnPriceSqrtQ64) : amount;
}

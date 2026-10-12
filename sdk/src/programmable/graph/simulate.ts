/**
 * Simulates an autopilot graph over time against a mock market: a price
 * path, the pool's fee and depth, fee inflow into the treasury, graduation,
 * keepers checking every `tickSecs`, and an optional operator policy for
 * operator-gated nodes.
 *
 * Every run is decided by the program's own logic (`planRun`, a port of
 * programs/noised-autopilot src/logic.rs checked against the program's
 * vectors), on the state the program keeps: the reference price starts at
 * the launch's migration price and moves only with observations (it rises
 * at most 5% an hour, from an allowance only rises spend, and falls at
 * once); a buyback needs observations spanning a minute, the pool price
 * within its premium over min(reference, lowest observed price), and a swap
 * that returns at least the minimum priced from that bound; tips are at most
 * a tenth of what a run moved. So the simulator never shows a run the
 * program would refuse (test/programmable/sim.differential.test.ts replays
 * every timeline through an independent chain model).
 *
 * The market is the caller's assumption and is explicit: `poolFeeBps` (the
 * fee every buyback pays) and `poolSol` (the pool's depth: price impact, or
 * "none" for an upper bound) are required, as is `migrationPrice`. Keepers
 * call `update_price` at every tick and run every due node at once; a
 * keeper's buyback uses the largest amount whose swap fills, down to 1% of
 * the pool's SOL (as the program allows); a smaller amount is a partial run
 * (audit 4, A4-2: it leaves at least 1% of the pool's SOL of the node's run
 * for the rest, earns its share of a tip, and the node stays due until its
 * run is complete); a buyback moves the pool price until the next tick, when
 * the market price (`priceFn`) applies again. Burns earn no tip before
 * graduation, and after it are valued at the lower of the reference and the
 * lowest observed price (A4-4). Every recipient of a distribution is assumed
 * to have its wSOL account (one without is skipped on-chain: its share stays).
 */
import { DEFAULT_TOKEN_DECIMALS } from "../constants.js";
import { type Address, addressBytes, toAddress } from "../bytes.js";
import { ProgError } from "../errors.js";
import { burnPrice, planMaxTip, planPartial, planRun, planSpent, planValue, type RunPlan } from "../autopilot/logic.js";
import { type SolAmount, sqrtPriceQ64ToPrice, type TokenAmount, toLamports, toTokenUnits } from "../units.js";
import { estimateBuybackOut, poolAfterBuyback, premiumCoversFee } from "./market.js";
import { lowest } from "./reference.js";
import { type ActionKind, decompileGraph, type Graph } from "./model.js";
import {
  afterObservation,
  type AutopilotEnv,
  type AutopilotState,
  type BlockReason,
  compiledGraph,
  newAutopilotState,
  observePrice,
  recordRun,
  type RawNodeState,
  statusReader,
  storePriceState,
  takeTip,
  type TipOptions,
} from "./runtime.js";

export interface OperatorRequest {
  node: string;
  nodeIndex: number;
  action: ActionKind;
  /** The most the operator may choose (lamports or raw tokens). */
  max: bigint;
  /** For a buyback: the largest amount whose swap fills (estimated); otherwise `max`. */
  fillable: bigint;
  time: number;
  /** Spot SOL per token. */
  price: number;
  /** The reference price (SOL per token). */
  refPrice: number;
  treasurySol: bigint;
  treasuryTokens: bigint;
}

export interface SimulateGraphOptions {
  /** Number of timeline steps. */
  epochs: number;
  /** Length of one step (default 1 day). */
  stepSecs?: number;
  /** How often keepers check the price and run due nodes (default 600 s). */
  tickSecs?: number;
  /** Unix start time (default 2027-01-01T00:00:00Z). */
  startTime?: number;
  /** The market price, SOL per token, at each keeper check (default 0.000001). */
  priceFn?: (step: number, t: number) => number;
  /**
   * Required: the launch's migration price (SOL per token), the reference
   * price the program starts from (`init_autopilot` reads it from the DBC config).
   */
  migrationPrice: number;
  /**
   * Required: the pool's trading fee in bps, which every buyback pays
   * (`MIGRATION_FEE_TIERS_BPS[launch.migrationFeeOption]`: 25 to 600). A
   * premium below fee / (1 - fee) never fills.
   */
  poolFeeBps: number;
  /**
   * Required: the pool's SOL (its depth) for price impact: SOL (number),
   * lamports (bigint) or a function of (step, t); "none" assumes no price
   * impact, so buybacks fill more often than on a real pool (an upper bound).
   */
  poolSol: SolAmount | ((step: number, t: number) => SolAmount) | "none";
  /** SOL (number) or lamports (bigint) flowing into the treasury at the start of each step. */
  feeInflowFn?: (step: number, t: number) => SolAmount;
  /** Tokens (number) or raw units (bigint) flowing into the treasury at the start of each step. */
  tokenInflowFn?: (step: number, t: number) => TokenAmount;
  initialTreasury?: { sol?: SolAmount; tokens?: TokenAmount };
  /** Total supply at the start (default 1,000,000,000 tokens). */
  supply?: TokenAmount;
  tokenDecimals?: number;
  /** Step at which the token graduates (default 0 = already graduated; null = never). */
  graduatedAtStep?: number | null;
  /**
   * Operator policy for gated nodes: an amount (SOL / tokens / raw bigint),
   * "max", "fillable" (the largest buyback that fills), or null to skip.
   * Default "fillable". A choice above `max` is lowered to it.
   */
  operator?: (req: OperatorRequest) => SolAmount | TokenAmount | "max" | "fillable" | null;
  /** Tip parameters (default: the program's). */
  tip?: TipOptions;
}

export interface RunEvent {
  step: number;
  time: number;
  node: string;
  nodeIndex: number;
  action: ActionKind;
  by: "keeper" | "operator";
  /** What the run spent from the node's budget: lamports in (buyback), lamports paid (distribute) or raw tokens (burn). */
  amount: bigint;
  /** The amount the caller passed to `run` (null: none, the keeper's default). */
  amountArg: bigint | null;
  /** A keeper's partial buyback (audit 4, A4-2): the node stays due for the rest of its run. */
  partial: boolean;
  /** A buyback's minimum out (the program's), else null. */
  minOut: bigint | null;
  tokensBought: bigint;
  burned: bigint;
  paid: { address: Address; lamports: bigint }[];
  tip: bigint;
  /** The pool price (SOL per token) the run observed. */
  price: number;
  /** The reference price after the run. */
  refPrice: number;
}

/** Why a node did not run: the first time in a step that a node is held back for a reason (one event per node and reason per step). */
export interface BlockedEvent {
  step: number;
  time: number;
  node: string;
  nodeIndex: number;
  reason: BlockReason;
  why: string;
}

export interface TimelineStep {
  step: number;
  time: number;
  /** Spot at the end of the step. */
  price: number;
  refPrice: number;
  treasurySol: bigint;
  treasuryTokens: bigint;
  supply: bigint;
  burned: bigint;
  burnedTotal: bigint;
  solSpent: bigint;
  tokensBought: bigint;
  distributed: bigint;
  tips: bigint;
  runs: RunEvent[];
  blocked: BlockedEvent[];
}

export interface GraphTimeline {
  steps: TimelineStep[];
  totals: { burned: bigint; solSpent: bigint; tokensBought: bigint; distributed: bigint; tips: bigint; runs: number; blocked: number };
  final: { treasurySol: bigint; treasuryTokens: bigint; supply: bigint; refPrice: number };
  /** The market assumptions behind these numbers, in plain English (show them next to the results). */
  assumptions: string[];
}

const DEFAULT_START = 1_798_761_600; // 2027-01-01T00:00:00Z

/** price (SOL per token) -> sqrt Q64 (float math; fine for simulation). */
function sqrtQ64(price: number, dec: number): bigint {
  const raw = (price * 1e9) / 10 ** dec;
  if (!(raw > 0) || !Number.isFinite(raw)) return 0n;
  return BigInt(Math.floor(Math.sqrt(raw) * 2 ** 64));
}

/** Most timeline steps one simulation runs (about 27 years of days). */
export const MAX_SIM_STEPS = 10_000;

const wholeSecs = (v: number, what: string): number => {
  if (!Number.isSafeInteger(v) || v < 1) throw new ProgError("BadDuration", `${what} must be a whole number of seconds, at least 1`);
  return v;
};

/** A mock-market price: finite and > 0 (SOL per token). */
function checkPrice(p: number, step: number, what = "priceFn"): number {
  if (typeof p !== "number" || !Number.isFinite(p) || p <= 0) {
    throw new ProgError("BadAmount", `${what} returned ${String(p)} at step ${step}: a price must be a positive number of SOL per token`);
  }
  return p;
}

const pct = (bps: number): string => `${bps / 100}%`;

/**
 * Runs `g` for `opts.epochs` steps and returns the timeline. Deterministic for
 * deterministic inputs. Throws ProgError on an invalid graph or options
 * (epochs outside 0..=MAX_SIM_STEPS, non-positive step / tick lengths, a
 * price that is not a positive finite number, a missing migration price,
 * pool fee or pool depth).
 */
export function simulateGraph(input: Graph | Uint8Array, opts: SimulateGraphOptions): GraphTimeline {
  const g = input instanceof Uint8Array ? decompileGraph(input) : input;
  const cg = compiledGraph(g); // validates (throws ProgError on an invalid graph)
  if (!Number.isSafeInteger(opts.epochs) || opts.epochs < 0 || opts.epochs > MAX_SIM_STEPS) {
    throw new ProgError("BadModel", `epochs must be a whole number from 0 to ${MAX_SIM_STEPS}`);
  }
  if (opts.migrationPrice === undefined) throw new ProgError("BadModel", "migrationPrice is required: the launch's migration price, where the program's reference price starts");
  if (opts.poolFeeBps === undefined) throw new ProgError("BadModel", "poolFeeBps is required: the pool's fee, which every buyback pays (MIGRATION_FEE_TIERS_BPS[migrationFeeOption])");
  if (opts.poolSol === undefined) throw new ProgError("BadModel", 'poolSol is required: the pool\'s SOL for price impact, or "none" (an upper bound)');
  const fee = opts.poolFeeBps;
  if (!Number.isInteger(fee) || fee < 0 || fee >= 10_000) throw new ProgError("BadModel", "poolFeeBps must be a whole number of bps from 0 to 9,999");
  const dec = opts.tokenDecimals ?? g.tokenDecimals ?? DEFAULT_TOKEN_DECIMALS;
  const stepSecs = wholeSecs(opts.stepSecs ?? 86_400, "stepSecs");
  const tickSecs = Math.min(wholeSecs(opts.tickSecs ?? 600, "tickSecs"), stepSecs);
  const ticks = Math.max(1, Math.floor(stepSecs / tickSecs));
  const start = opts.startTime ?? DEFAULT_START;
  const priceFn = opts.priceFn ?? (() => 0.000001);
  const gradStep = opts.graduatedAtStep === undefined ? 0 : opts.graduatedAtStep;
  const migration = sqrtQ64(checkPrice(opts.migrationPrice, 0, "migrationPrice"), dec);
  if (migration <= 0n) throw new ProgError("BadAmount", "migrationPrice is too small to represent as a sqrt price");
  const state: AutopilotState = newAutopilotState(g, migration);
  const poolSolAt = (step: number, t: number): bigint | null => {
    if (opts.poolSol === "none") return null;
    const v = typeof opts.poolSol === "function" ? opts.poolSol(step, t) : opts.poolSol;
    const l = toLamports(v, "poolSol");
    if (l <= 0n) throw new ProgError("BadAmount", `poolSol must be more than 0 SOL (step ${step})`);
    return l;
  };
  const refOf = (): number => sqrtPriceQ64ToPrice(state.refSqrtPriceQ64, dec);
  let sol = opts.initialTreasury?.sol === undefined ? 0n : toLamports(opts.initialTreasury.sol);
  let tokens = opts.initialTreasury?.tokens === undefined ? 0n : toTokenUnits(opts.initialTreasury.tokens, dec);
  let supply = toTokenUnits(opts.supply ?? 1_000_000_000, dec, "supply");
  let burnedTotal = 0n;
  const totals = { burned: 0n, solSpent: 0n, tokensBought: 0n, distributed: 0n, tips: 0n, runs: 0, blocked: 0 };
  const steps: TimelineStep[] = [];
  let lastPrice = checkPrice(priceFn(0, start), 0);
  let refPrice = refOf();
  const operatorKey = g.operator === null ? new Uint8Array(32) : addressBytes(toAddress(g.operator));

  for (let step = 0; step < opts.epochs; step++) {
    const t0 = start + step * stepSecs;
    if (opts.feeInflowFn) sol += toLamports(opts.feeInflowFn(step, t0), "fee inflow");
    if (opts.tokenInflowFn) tokens += toTokenUnits(opts.tokenInflowFn(step, t0), dec, "token inflow");
    const graduated = gradStep !== null && step >= gradStep;
    const row: TimelineStep = {
      step, time: t0, price: lastPrice, refPrice, treasurySol: 0n, treasuryTokens: 0n, supply: 0n,
      burned: 0n, burnedTotal: 0n, solSpent: 0n, tokensBought: 0n, distributed: 0n, tips: 0n, runs: [], blocked: [],
    };
    // The first block of each node for each reason, per step.
    const blockedSeen = new Set<string>();
    const block = (i: number, now: number, reason: BlockReason, why: string): void => {
      const key = `${i}:${reason}`;
      if (reason === "notDue" || blockedSeen.has(key)) return;
      blockedSeen.add(key);
      row.blocked.push({ step, time: now, node: g.nodes[i]!.id, nodeIndex: i, reason, why });
      totals.blocked++;
    };
    for (let k = 0; k < ticks; k++) {
      const now = t0 + k * tickSecs;
      const price = checkPrice(priceFn(step, now), step);
      lastPrice = price;
      let spot = sqrtQ64(price, dec);
      let pool = graduated ? poolSolAt(step, now) : null;
      // A keeper checks the pool price (update_price) before running anything.
      if (graduated) {
        observePrice(state, now, spot);
        refPrice = refOf();
      }
      const declined = new Set<number>();
      // Keepers run every due node, in index order, re-checking from the first after each run (bounded).
      for (let guard = 0; guard < 64 * g.nodes.length; guard++) {
        const env: AutopilotEnv = { now, treasurySol: sol, treasuryTokens: tokens, graduated, spotSqrtPriceQ64: spot, poolFeeBps: fee };
        if (pool !== null) env.poolSol = pool;
        const statusAt = statusReader(g, state, env);
        let ran = false;
        for (let i = 0; i < g.nodes.length; i++) {
          if (declined.has(i)) continue;
          const node = g.nodes[i]!;
          const st = statusAt(i);
          if (!st.due) {
            block(i, now, st.reason!, st.why);
            continue;
          }
          let amount = st.amount;
          let amountArg: bigint | null = st.amount === st.maxAmount ? null : st.amount;
          const act = node.action;
          if (st.operatorOnly) {
            const choice = opts.operator
              ? opts.operator({
                  node: node.id, nodeIndex: i, action: act.kind, max: st.maxAmount, fillable: st.amount, time: now, price, refPrice,
                  treasurySol: sol, treasuryTokens: tokens,
                })
              : "fillable";
            if (choice === null) {
              declined.add(i);
              continue;
            }
            if (choice === "max") amount = st.maxAmount;
            else if (choice !== "fillable") {
              const want = act.kind === "burn" ? toTokenUnits(choice, dec) : toLamports(choice as SolAmount);
              if (want <= 0n) {
                declined.add(i);
                continue;
              }
              amount = want < st.maxAmount ? want : st.maxAmount; // the program refuses more than the most
            }
            amountArg = amount;
          }
          // The run, as the program does it: observe, move the reference, plan, act, record, tip.
          const { price: ps, window } = afterObservation(state, now, spot, graduated);
          const raws: RawNodeState[] = state.nodes.map((r) => ({
            lastRun: BigInt(r.lastRun), lastSeq: BigInt(r.lastSeq), epochStart: BigInt(r.epochStart), runsInEpoch: r.runsInEpoch, spentInEpoch: r.spentInEpoch,
          }));
          const planned = planRun({
            graph: cg.raw,
            node: i,
            now: BigInt(now),
            states: raws,
            operator: state.operator === null ? new Uint8Array(32) : operatorKey,
            operatorSigner: st.operatorOnly ? operatorKey : null,
            amount: amountArg,
            treasurySol: sol,
            treasuryToken: tokens,
            graduated,
            spot: graduated ? spot : null,
            reference: ps.reference,
            seen: window,
            poolQuote: pool ?? 0n,
            partialSpent: state.partialSpent?.[i] ?? 0n,
          });
          if (!planned.ok) {
            // Only an operator's own choice can get here (the status already applied the planner).
            block(i, now, "swapShortfall", `The program would refuse the operator's amount (${planned.error}).`);
            declined.add(i);
            continue;
          }
          const plan: RunPlan = planned.value;
          const ev: RunEvent = {
            step, time: now, node: node.id, nodeIndex: i, action: act.kind, by: st.operatorOnly ? "operator" : "keeper",
            amount: planSpent(plan), amountArg, partial: false, minOut: null, tokensBought: 0n, burned: 0n, paid: [], tip: 0n, price, refPrice,
          };
          if (plan.kind === "buyback") {
            let out = estimateBuybackOut(plan.amountIn, spot, fee, pool);
            if (out > supply) out = supply;
            if (out < plan.minOut) {
              // The swap returns less than the minimum: the program reverts the whole run (SwapShortfall).
              const why = premiumCoversFee(act.kind === "buybackBurn" ? act.maxPremiumBps : 0, fee)
                ? "The operator's amount is too large for the pool: the swap would return less than the program's minimum."
                : "Its premium is below the pool's fee: the swap can never return the program's minimum.";
              block(i, now, "swapShortfall", why);
              declined.add(i);
              continue;
            }
            ev.minOut = plan.minOut;
            sol -= plan.amountIn;
            supply -= out;
            ev.tokensBought = out;
            ev.burned = out;
            row.solSpent += plan.amountIn;
            row.tokensBought += out;
            row.burned += out;
            if (pool !== null) {
              const after = poolAfterBuyback(plan.amountIn, spot, fee, pool);
              pool = after.poolSol;
              spot = after.spotSqrtQ64; // the pool stays there until the next tick
            }
          } else if (plan.kind === "burn") {
            tokens -= plan.amount;
            supply = supply > plan.amount ? supply - plan.amount : 0n; // mock inflows may exceed the supply
            ev.burned = plan.amount;
            row.burned += plan.amount;
          } else {
            g.recipients.forEach((r, j) => ev.paid.push({ address: r.address, lamports: plan.shares[j] ?? 0n }));
            sol -= plan.total;
            row.distributed += plan.total;
          }
          storePriceState(state, ps);
          recordRun(g, state, i, now, planSpent(plan), planPartial(plan));
          refPrice = refOf();
          ev.refPrice = refPrice;
          ev.partial = planPartial(plan);
          // A burn is valued at nothing before graduation, then at min(reference, lowest observed) (audit 4, A4-4);
          // a partial buyback earns its share of a tip (A4-2).
          const value = planValue(plan, burnPrice(graduated, ps.reference, lowest(ps.observations, now)));
          ev.tip = takeTip(state, now, sol, value, opts.tip, planMaxTip(plan, cg.raw.nodes[i]!.p1));
          sol -= ev.tip;
          row.tips += ev.tip;
          row.runs.push(ev);
          ran = true;
          break; // re-check from the first node with the new balances
        }
        if (!ran) break;
      }
    }
    burnedTotal += row.burned;
    row.burnedTotal = burnedTotal;
    row.price = lastPrice;
    row.refPrice = refPrice;
    row.treasurySol = sol;
    row.treasuryTokens = tokens;
    row.supply = supply;
    totals.burned += row.burned;
    totals.solSpent += row.solSpent;
    totals.tokensBought += row.tokensBought;
    totals.distributed += row.distributed;
    totals.tips += row.tips;
    totals.runs += row.runs.length;
    steps.push(row);
  }
  const assumptions = [
    `Keepers check the pool price every ${tickSecs >= 60 ? `${Math.round(tickSecs / 60)} minutes` : `${tickSecs} seconds`} and run every step that is due straight away.`,
    `The reference price starts at the migration price (${opts.migrationPrice} SOL per token), rises at most 5% an hour and falls at once, as the program does.`,
    `Every buyback pays the pool's ${pct(fee)} fee.`,
    opts.poolSol === "none"
      ? "No price impact is assumed: on a real pool large buybacks fill less often, so these numbers are an upper bound."
      : "Price impact is estimated for a full-range pool with the SOL depth you gave; a buyback moves the price until the next check.",
    "The price path is yours: real prices, keepers and fees will differ.",
  ];
  return { steps, totals, final: { treasurySol: sol, treasuryTokens: tokens, supply, refPrice }, assumptions };
}

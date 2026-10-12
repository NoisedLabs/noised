/**
 * The autopilot program's decisions, ported from
 * programs/noised-autopilot/src/logic.rs (and the payload hashes of
 * src/launchpad.rs) line for line, on exact integers (bigint i64 / u64 /
 * u128): when a graph may be queued, which authorizations may be used,
 * whether and how much a node may move (`planRun`), how a run is recorded
 * (`recordRunRaw`) and its tip (`takeTipRaw`). Errors are the program's
 * `AutopilotError` names (code = 6000 + index in `AUTOPILOT_ERRORS`).
 *
 * test/programmable/autopilot.vectors.test.ts replays vectors the program's
 * own Rust functions produced (test/vectors/programmable/autopilot.json).
 * The simulator (`simulateGraph`) and the keeper model (`nodeStatus`) decide
 * every run with `planRun`, so they never allow what the program refuses.
 */
import { sha256 } from "@noble/hashes/sha2.js";

import { ACTION, AUTOPILOT, BPS_DENOMINATOR, U64_MAX } from "../constants.js";
import { bytesEqual, isZero, type KeyInput, toAddress, addressBytes, utf8 } from "../bytes.js";
import { ProgError } from "../errors.js";
import type { RawGraph } from "../graph/codec.js";
import { currentEpochRaw, graphRunCap, graphRunnable, graphRunsInEpoch, graphShares, type NotDueCode, type RawNodeState } from "../graph/runtime.js";
import { buybackCap, keeperFloor, minOut, type Seen, tokenValue, withinPremium } from "../graph/reference.js";

/** programs/noised-autopilot src/error.rs `AutopilotError`, in order: the code is 6000 + index. */
export const AUTOPILOT_ERRORS = [
  "NotALaunch",
  "LaunchNotLive",
  "InvalidCertificate",
  "InvalidDbcConfig",
  "MintAlreadyBound",
  "MintNotBound",
  "InvalidGraph",
  "GraphMismatch",
  "InvalidAuthorization",
  "StaleAuthorization",
  "Frozen",
  "NoActiveGraph",
  "NoPendingUpdate",
  "ActivationInPast",
  "TimelockTooShort",
  "UpdateNotDue",
  "PendingUpdateDue",
  "NoOperator",
  "NoSuchNode",
  "NodeNotDue",
  "NotGraduated",
  "MaxRunsReached",
  "BudgetSpent",
  "ConditionFalse",
  "WrongOperator",
  "AmountNotAllowed",
  "InvalidAmount",
  "NothingToDo",
  "PremiumExceeded",
  "PriceOutOfRange",
  "SwapShortfall",
  "InvalidPool",
  "InvalidDammAccounts",
  "InvalidRecipientAccounts",
  "PriceNotObserved",
  "MathOverflow",
  "UnexpectedAccounts",
  "AmountTooSmall",
  "InvalidDammConfig",
  "PoolAlreadyBound",
  "FreezeExpired",
  // Audit round 4: a keeper's partial buyback must leave a swappable remainder (A4-2); a distribution with no
  // recipient account to pay (M4).
  "RemainderTooSmall",
  "NoRecipientAccount",
] as const;

export type AutopilotErrorName = (typeof AUTOPILOT_ERRORS)[number];

/** The program's error number of `name` (6000 + its index). */
export function autopilotErrorCode(name: AutopilotErrorName): number {
  return 6000 + AUTOPILOT_ERRORS.indexOf(name);
}

/** The error name of a program error number, or null for a number the program does not define. */
export function autopilotErrorName(code: number): AutopilotErrorName | null {
  return AUTOPILOT_ERRORS[code - 6000] ?? null;
}

/** A decision: the value, or the error the program would return. */
export type Outcome<T> = { ok: true; value: T } | { ok: false; error: AutopilotErrorName };

const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });
const fail = <T>(error: AutopilotErrorName): Outcome<T> => ({ ok: false, error });

const I64_MAX = (1n << 63n) - 1n;
const I64_MIN = -(1n << 63n);
const U16_MAX = 0xffffn;

const big = (v: bigint | number, what: string): bigint => {
  if (typeof v === "bigint") return v;
  if (!Number.isSafeInteger(v)) throw new ProgError("BadModel", `${what} must be a whole number`);
  return BigInt(v);
};

// ------------------------------------------------------------ governance ---

/** The kinds of the launchpad's `Authorization` (programs/noised-autopilot src/launchpad.rs `authorization::kind`). */
export const AUTH_KIND = {
  GRAPH_ACTIVATE: 1,
  GRAPH_FREEZE: 2,
  OPERATOR_REVOKE: 3,
} as const;

/**
 * Payload-hash domains (16 bytes each), as the autopilot checks them. The
 * freeze payload is version 2 (review 4, R5): it names the last time the
 * freeze may be used. The revocation payload is version 3 (audit 4, A4-3):
 * it names the authorization that activated the running graph
 * (`Autopilot.active_auth`), so it revokes that activation's operator only.
 */
export const AUTH_DOMAINS = {
  ACTIVATE: "PHX-GRAPH-ACT-V1",
  FREEZE: "PHX-GRAPH-FRZ-V2",
  REVOKE: "PHX-OP-REVOKE-V3",
} as const;

/**
 * The default window of a freeze approval: one hour from when it is planned
 * (`planFreeze`). The identity signs the end of the window (`notAfter`), and
 * the program refuses the freeze after it (`FreezeExpired`). A longer window
 * keeps a freeze that was landed and then withheld usable that much longer.
 */
export const FREEZE_DEFAULT_VALID_SECS = 3_600n;

function hashParts(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const msg = new Uint8Array(len);
  let at = 0;
  for (const p of parts) {
    msg.set(p, at);
    at += p.length;
  }
  return sha256(msg);
}

const key32 = (k: KeyInput, what: string): Uint8Array => {
  try {
    return addressBytes(toAddress(k));
  } catch {
    throw new ProgError("BadAddress", `${what} must be a Solana address`);
  }
};

const hash32 = (h: Uint8Array, what: string): Uint8Array => {
  if (!(h instanceof Uint8Array) || h.length !== 32) throw new ProgError("BadModel", `${what} must be 32 bytes`);
  return h;
};

const i64le = (v: bigint, what: string): Uint8Array => {
  if (v < I64_MIN || v > I64_MAX) throw new ProgError("BadModel", `${what} must fit an i64`);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, v, true);
  return out;
};

/**
 * What the launch identity signs to queue a graph:
 * `SHA256("PHX-GRAPH-ACT-V1" || autopilot || graph_hash || i64le(activate_at))`
 * (`autopilot` is the `["autopilot", launch]` address).
 */
export function activationPayload(autopilot: KeyInput, graphHash: Uint8Array, activateAt: bigint | number): Uint8Array {
  return hashParts([utf8(AUTH_DOMAINS.ACTIVATE), key32(autopilot, "autopilot"), hash32(graphHash, "graphHash"), i64le(big(activateAt, "activateAt"), "activateAt")]);
}

/**
 * What the launch identity signs to freeze the active graph, usable until
 * `notAfter` (unix seconds, inclusive):
 * `SHA256("PHX-GRAPH-FRZ-V2" || autopilot || graph_hash || i64le(not_after))`
 * (review 4, R5). `notAfter` must be a bigint (TypeError) in the i64 range
 * (RangeError).
 */
export function freezePayload(autopilot: KeyInput, graphHash: Uint8Array, notAfter: bigint): Uint8Array {
  if (typeof notAfter !== "bigint") throw new TypeError("notAfter must be bigint unix seconds");
  if (notAfter < I64_MIN || notAfter > I64_MAX) throw new RangeError("notAfter must fit an i64");
  return hashParts([utf8(AUTH_DOMAINS.FREEZE), key32(autopilot, "autopilot"), hash32(graphHash, "graphHash"), i64le(notAfter, "notAfter")]);
}

/**
 * What the launch identity signs to remove the operator of the active graph
 * (payload version 3, audit 4, A4-3):
 * `SHA256("PHX-OP-REVOKE-V3" || autopilot || graph_hash || operator || active_auth)`.
 * `activeAuth` is the authorization that activated the running graph
 * (`Autopilot.active_auth`, `AutopilotAccount.activeAuth`): the revocation
 * binds that one activation, so it can never be replayed against a later
 * activation that appoints the same operator again (even of the same graph),
 * and the operator of every activation can be revoked by a new revocation.
 * Once another activation is applied, a revocation signed before it is dead:
 * sign a new one.
 */
export function revokePayload(autopilot: KeyInput, graphHash: Uint8Array, operator: KeyInput, activeAuth: KeyInput): Uint8Array {
  if (activeAuth === undefined || activeAuth === null) {
    throw new ProgError("BadAddress", "revokePayload needs activeAuth (payload v3): the authorization that activated the running graph (Autopilot.active_auth)");
  }
  return hashParts([utf8(AUTH_DOMAINS.REVOKE), key32(autopilot, "autopilot"), hash32(graphHash, "graphHash"), key32(operator, "operator"), key32(activeAuth, "activeAuth")]);
}

/** Whether a graph hash names a graph (the all-zero hash means none). */
const named = (h: Uint8Array | null | undefined): boolean => h !== null && h !== undefined && !isZero(h);

/** `logic::check_activation` inputs. Hashes: null or all zero = none. Times: unix seconds (i64). */
export interface ActivationCheck {
  activeGraph: Uint8Array | null;
  pendingGraph: Uint8Array | null;
  frozen: boolean;
  now: bigint | number;
  activateAt: bigint | number;
  /** When the authorization landed (`Authorization.unix_time`). */
  authUnixTime: bigint | number;
}

/**
 * `logic::check_activation`: never once frozen; a first graph (none active,
 * none queued) at `now` or later; otherwise at least 72 hours after both now
 * and the authorization's landing. null = allowed.
 */
export function checkActivation(c: ActivationCheck): AutopilotErrorName | null {
  if (c.frozen) return "Frozen";
  const now = big(c.now, "now");
  const at = big(c.activateAt, "activateAt");
  if (!named(c.activeGraph) && !named(c.pendingGraph)) return at >= now ? null : "ActivationInPast";
  const auth = big(c.authUnixTime, "authUnixTime");
  const earliest = (now > auth ? now : auth) + BigInt(AUTOPILOT.UPDATE_TIMELOCK_SECS);
  if (earliest > I64_MAX) return "MathOverflow";
  return at >= earliest ? null : "TimelockTooShort";
}

/** The latest authorization of one kind that was used: ordered by `(slot, address)`. */
export interface AuthMark {
  slot: bigint;
  /** The authorization account's address (32 bytes). */
  key: Uint8Array;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

const newer = (a: AuthMark, b: AuthMark): boolean => a.slot > b.slot || (a.slot === b.slot && compareBytes(a.key, b.key) > 0);

/** `logic::mark_index`: the slot of a kind in `Autopilot.auth_marks` (activate, freeze, revoke). */
export function markIndex(kind: number): number | null {
  return kind === AUTH_KIND.GRAPH_ACTIVATE ? 0 : kind === AUTH_KIND.GRAPH_FREEZE ? 1 : kind === AUTH_KIND.OPERATOR_REVOKE ? 2 : null;
}

/**
 * `logic::check_fresh`: an authorization is used only if it is newer than the
 * latest used of its own kind and of the kinds it could undo (an activation
 * never predates the latest revocation, a freeze never the latest
 * activation). null = it may be used.
 */
export function checkFresh(mark: AuthMark, marks: readonly [AuthMark, AuthMark, AuthMark], kind: number): AutopilotErrorName | null {
  const follows =
    kind === AUTH_KIND.GRAPH_ACTIVATE
      ? [AUTH_KIND.GRAPH_ACTIVATE, AUTH_KIND.OPERATOR_REVOKE]
      : kind === AUTH_KIND.GRAPH_FREEZE
        ? [AUTH_KIND.GRAPH_FREEZE, AUTH_KIND.GRAPH_ACTIVATE]
        : kind === AUTH_KIND.OPERATOR_REVOKE
          ? [AUTH_KIND.OPERATOR_REVOKE]
          : null;
  if (follows === null) return "InvalidAuthorization";
  for (const other of follows) if (!newer(mark, marks[markIndex(other)!]!)) return "StaleAuthorization";
  return null;
}

/**
 * `logic::check_freeze_window`: a freeze signed to be used until `notAfter`
 * may be used at `now` up to and including that second. null = allowed.
 * (`freeze` checks `Frozen` and `NoActiveGraph` first, then this, then the
 * authorization.)
 */
export function checkFreezeWindow(now: bigint | number, notAfter: bigint | number): "FreezeExpired" | null {
  return big(now, "now") <= big(notAfter, "notAfter") ? null : "FreezeExpired";
}

/** `logic::check_apply`: the queued graph takes effect at or after its time. null = `apply_pending` may run. */
export function checkApply(pendingGraph: Uint8Array | null, activateAt: bigint | number, frozen: boolean, now: bigint | number): AutopilotErrorName | null {
  if (frozen) return "Frozen";
  if (!named(pendingGraph)) return "NoPendingUpdate";
  return big(now, "now") >= big(activateAt, "activateAt") ? null : "UpdateNotDue";
}

// ------------------------------------------------------------ runs ---

/** `logic::not_due_error`: the program's error for a node that is not runnable. */
export function notDueError(reason: NotDueCode): AutopilotErrorName {
  switch (reason) {
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

/**
 * `logic::run_amount`: what a run moves within `limit = min(cap, available)`.
 * The operator must choose an amount in `1..=limit` on its gated nodes; a
 * keeper moves `limit`, or, where `floor` is given (buybacks), may choose one
 * from `max(1, min(floor, limit))` up to `limit`. Elsewhere a keeper must not
 * choose. A keeper's chosen amount below `cap` is a partial run (audit 4,
 * A4-2): it must leave at least `floor` of the cap for the rest
 * (`amount == cap || cap - amount >= floor`, else `RemainderTooSmall`).
 */
export function runAmount(gated: boolean, amount: bigint | null, cap: bigint, available: bigint, floor: bigint | null): Outcome<bigint> {
  const limit = cap < available ? cap : available;
  if (gated) {
    if (amount === null) return fail("InvalidAmount");
    return amount > 0n && amount <= limit ? ok(amount) : fail("InvalidAmount");
  }
  if (amount === null) return limit > 0n ? ok(limit) : fail("NothingToDo");
  if (floor === null) return fail("AmountNotAllowed");
  if (limit <= 0n) return fail("NothingToDo");
  if (amount > limit) return fail("InvalidAmount");
  let least = floor < limit ? floor : limit;
  if (least < 1n) least = 1n;
  if (amount < least) return fail("AmountTooSmall");
  return amount === cap || cap - amount >= floor ? ok(amount) : fail("RemainderTooSmall");
}

/** What a run will do (`logic::Plan`). */
export type RunPlan =
  /**
   * Swap exactly `amountIn` treasury lamports for at least `minOut` tokens on
   * the launch's pool, then burn all of them. `partial`: a keeper chose less
   * than the node's cap (audit 4, A4-2): the run spends from the budget and
   * earns its share of a tip, but leaves the node's run open (no new
   * `last_run`, not counted toward the runs per epoch).
   */
  | { kind: "buyback"; amountIn: bigint; minOut: bigint; partial: boolean }
  /** Burn `amount` treasury tokens. */
  | { kind: "burn"; amount: bigint }
  /** Pay `shares[i]` lamports to recipient i (8 entries); their sum `total` is the spend, the dust stays. */
  | { kind: "distribute"; shares: bigint[]; total: bigint };

/** `Plan::spent`: what the run counts against the node's budget. */
export function planSpent(p: RunPlan): bigint {
  return p.kind === "buyback" ? p.amountIn : p.kind === "burn" ? p.amount : p.total;
}

/**
 * `Plan::value`: what the run moved in lamports (its tip is a share of it):
 * lamports swapped; tokens burned at `burnPriceSqrtQ64` (`burnPrice`: 0
 * before graduation, after it the lower of the reference and the lowest
 * observed price; audit 4, A4-4); lamports paid, i.e. the shares less the
 * `kept` ones of recipients that had no wSOL account (audit 4, M4).
 */
export function planValue(p: RunPlan, burnPriceSqrtQ64: bigint, kept: bigint = 0n): bigint {
  if (p.kind === "buyback") return p.amountIn;
  if (p.kind === "burn") return tokenValue(p.amount, burnPriceSqrtQ64);
  return p.total > kept ? p.total - kept : 0n;
}

/** `Plan::partial`: a keeper's partial buyback (audit 4, A4-2). */
export function planPartial(p: RunPlan): boolean {
  return p.kind === "buyback" && p.partial;
}

/**
 * `Plan::max_tip`: the most the run's tip may be: `TIP_LAMPORTS`, or for a
 * partial buyback its share `TIP_LAMPORTS * amountIn / p1` (audit 4, A4-2),
 * so the partial runs of one node run together earn less than one tip.
 */
export function planMaxTip(p: RunPlan, p1: bigint): bigint {
  if (p.kind === "buyback" && p.partial) return (AUTOPILOT.TIP_LAMPORTS * p.amountIn) / (p1 > 1n ? p1 : 1n);
  return AUTOPILOT.TIP_LAMPORTS;
}

/**
 * `logic::burn_price`: the price a burn's tokens are valued at for its tip
 * (audit 4, A4-4): 0 before graduation (the only price then is the
 * migration price, which the curve can be far below: a burn earns no tip),
 * after it the lower of the reference and the lowest price observed in the
 * window (`lowestObserved`, this run's observation included).
 */
export function burnPrice(graduated: boolean, referenceSqrtQ64: bigint, lowestSqrtQ64: bigint | null): bigint {
  if (!graduated) return 0n;
  return lowestSqrtQ64 === null || referenceSqrtQ64 < lowestSqrtQ64 ? referenceSqrtQ64 : lowestSqrtQ64;
}

/** Everything `run` decides from (`logic::RunInput`). */
export interface RunInput {
  /** The active graph, verified (`verifyGraphBytes`). */
  graph: RawGraph;
  node: number;
  now: bigint;
  /** Node states, indexed like the graph's nodes (missing entries are fresh). */
  states: readonly RawNodeState[];
  /** The stored operator (32 bytes; all zero: none, or revoked). */
  operator: Uint8Array;
  /** The `operator` account of the instruction, if it signed. */
  operatorSigner: Uint8Array | null;
  /** The caller's chosen amount, if any. */
  amount: bigint | null;
  treasurySol: bigint;
  treasuryToken: bigint;
  /** The launch graduated: its DAMM v2 pool is bound. */
  graduated: boolean;
  /** The pool's sqrt price before the action (null before graduation). */
  spot: bigint | null;
  /** The reference sqrt price, after this run's observation. */
  reference: bigint;
  /** What the observation window saw, this run's observation included. */
  seen: Seen | null;
  /** The pool's wSOL, for a buyback. */
  poolQuote: bigint | null;
  /**
   * What keepers' partial buybacks of the node moved since it last completed
   * a run (`Autopilot.partial_spent[node]`; audit 4, A4-2): the run's cap is
   * `min(p1 - partialSpent, budget left)`. Default 0.
   */
  partialSpent?: bigint | undefined;
}

const FRESH: RawNodeState = { lastRun: 0n, lastSeq: 0n, epochStart: 0n, runsInEpoch: 0, spentInEpoch: 0n };

/** The 16 node states the program stores (fresh past the given ones). */
export function paddedStates(states: readonly RawNodeState[]): RawNodeState[] {
  return Array.from({ length: 16 }, (_, i) => states[i] ?? FRESH);
}

/**
 * `logic::plan_run`, check for check and in the program's order: the node
 * exists; an operator-gated node is signed by the operator; the node is due
 * and its condition holds on the reference price; a buyback only after
 * graduation, with a usable observation window, while the pool price is
 * within the premium over the lower of the reference and the lowest observed
 * price (which also prices its minimum out); the amount (`runAmount`) within
 * the node's cap, `min(p1, budget left)`, less what partial buybacks moved of
 * its open run (`partialSpent`); a distribution pays something. A keeper's
 * buyback with an amount below that cap is `partial`.
 */
export function planRun(input: RunInput): Outcome<RunPlan> {
  const g = input.graph;
  const node = g.nodes[input.node];
  if (node === undefined) return fail("NoSuchNode");
  const gated = node.operatorGated === 1;
  if (gated) {
    if (isZero(input.operator)) return fail("NoOperator");
    if (input.operatorSigner === null || !bytesEqual(input.operatorSigner, input.operator)) return fail("WrongOperator");
  }
  const states = paddedStates(input.states);
  const nd = graphRunnable(g, input.node, states, {
    now: input.now,
    treasurySol: input.treasurySol,
    treasuryToken: input.treasuryToken,
    graduated: input.graduated,
    sqrtPrice: input.reference,
    runsInEpoch: graphRunsInEpoch(g, states, input.now),
  });
  if (nd !== null) return fail(notDueError(nd));
  const partialSpent = input.partialSpent ?? 0n;
  if (typeof partialSpent !== "bigint" || partialSpent < 0n) throw new ProgError("BadModel", "partialSpent must be a non-negative bigint");
  const openRun = node.p1 > partialSpent ? node.p1 - partialSpent : 0n;
  const budgetCap = graphRunCap(g, input.node, states[input.node]!, input.now);
  const cap = budgetCap < openRun ? budgetCap : openRun;
  switch (node.action) {
    case ACTION.BUYBACK_BURN: {
      if (!input.graduated) return fail("NotGraduated");
      if (input.spot === null) return fail("InvalidPool");
      const bound = buybackCap(input.reference, input.seen);
      if (bound === null) return fail("PriceNotObserved");
      if (!withinPremium(input.spot, bound, node.p2)) return fail("PremiumExceeded");
      if (input.poolQuote === null) return fail("InvalidDammAccounts");
      const amount = runAmount(gated, input.amount, cap, input.treasurySol, keeperFloor(input.poolQuote));
      if (!amount.ok) return amount;
      const least = minOut(amount.value, bound, node.p2);
      if (least === null || least === 0n) return fail("PriceOutOfRange");
      return ok({ kind: "buyback", amountIn: amount.value, minOut: least, partial: !gated && input.amount !== null && amount.value < cap });
    }
    case ACTION.BURN: {
      const amount = runAmount(gated, input.amount, cap, input.treasuryToken, null);
      return amount.ok ? ok({ kind: "burn", amount: amount.value }) : amount;
    }
    case ACTION.DISTRIBUTE_SOL: {
      const amount = runAmount(gated, input.amount, cap, input.treasurySol, null);
      if (!amount.ok) return amount;
      const shares = graphShares(g, amount.value);
      let total = 0n;
      for (const s of shares) {
        total += s;
        if (total > U64_MAX) return fail("MathOverflow");
      }
      if (total === 0n) return fail("NothingToDo");
      return ok({ kind: "distribute", shares, total });
    }
    default:
      return fail("InvalidGraph");
  }
}

/** `recordRunRaw` options (audit 4, A4-2). */
export interface RecordRunOptions {
  /** A keeper's partial buyback (`planPartial`): it spends from the budget but leaves the node's run open. Default false. */
  partial?: boolean | undefined;
  /** What partial buybacks moved of the node's open run before this one (`Autopilot.partial_spent[node]`). Default 0. */
  partialSpent?: bigint | undefined;
}

/**
 * `logic::record_run`: a successful run of `spent` at `now` takes the next
 * sequence number and adds `spent` to the node's spend this epoch (rolled
 * over first); then either a completed run (the epoch's runs, its last run
 * and sequence number, and a closed run: `partialSpent` back to 0) or a
 * partial buyback (audit 4, A4-2: only `partialSpent` grows by `spent`; the
 * node stays due, its runs this epoch and its last run are unchanged).
 * Returns the new node state, sequence number and `partialSpent` (the inputs
 * are not changed).
 */
export function recordRunRaw(
  node: RawNodeState,
  seq: bigint,
  epochSecs: number,
  now: bigint,
  spent: bigint,
  opts: RecordRunOptions = {},
): Outcome<{ node: RawNodeState; seq: bigint; partialSpent: bigint }> {
  const epoch = currentEpochRaw(epochSecs, node, now);
  const next = seq + 1n;
  if (next > U64_MAX) return fail("MathOverflow");
  const total = epoch.spent + spent;
  if (total > U64_MAX) return fail("MathOverflow");
  if (opts.partial === true) {
    const open = (opts.partialSpent ?? 0n) + spent;
    if (open > U64_MAX) return fail("MathOverflow");
    return ok({ node: { lastRun: node.lastRun, lastSeq: node.lastSeq, epochStart: epoch.start, runsInEpoch: epoch.runs, spentInEpoch: total }, seq: next, partialSpent: open });
  }
  const runs = BigInt(epoch.runs) + 1n;
  if (runs > U16_MAX) return fail("MathOverflow");
  return ok({ node: { lastRun: now, lastSeq: next, epochStart: epoch.start, runsInEpoch: Number(runs), spentInEpoch: total }, seq: next, partialSpent: 0n });
}

/** The tip counters of an autopilot (`tip_epoch_start`, `tips_in_epoch`). */
export interface TipCounters {
  epochStart: bigint;
  inEpoch: bigint;
}

/**
 * `logic::take_tip`: the tip for a run at `now` that moved `value` lamports'
 * worth (`planValue`): min(TIP_LAMPORTS, `maxTip` (`planMaxTip`: a partial
 * buyback's share; default TIP_LAMPORTS), what is left of TIP_EPOCH_CAP this
 * UTC day, the treasury's wSOL, a tenth of `value`). Returns the tip and the
 * new counters (tip epochs only move forward).
 */
export function takeTipRaw(
  counters: TipCounters,
  now: bigint,
  treasurySol: bigint,
  value: bigint,
  maxTip: bigint = AUTOPILOT.TIP_LAMPORTS,
): { tip: bigint; counters: TipCounters } {
  const secs = BigInt(AUTOPILOT.TIP_EPOCH_SECS);
  const rem = ((now % secs) + secs) % secs;
  let start = now - rem;
  if (start < I64_MIN) start = I64_MIN;
  let { epochStart, inEpoch } = counters;
  if (start > epochStart) {
    epochStart = start;
    inEpoch = 0n;
  }
  const share = (value * BigInt(AUTOPILOT.TIP_MAX_SHARE_BPS)) / BigInt(BPS_DENOMINATOR);
  const left = AUTOPILOT.TIP_EPOCH_CAP > inEpoch ? AUTOPILOT.TIP_EPOCH_CAP - inEpoch : 0n;
  let tip: bigint = AUTOPILOT.TIP_LAMPORTS;
  if (maxTip < tip) tip = maxTip;
  if (left < tip) tip = left;
  if (treasurySol < tip) tip = treasurySol;
  if (share < tip) tip = share;
  let after = inEpoch + tip;
  if (after > U64_MAX) after = U64_MAX;
  return { tip, counters: { epochStart, inEpoch: after } };
}

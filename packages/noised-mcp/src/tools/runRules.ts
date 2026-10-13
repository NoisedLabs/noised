/**
 * The autopilot's run rules (the program as merged in audit round 4), all
 * from @noisedlabs/sdk 0.9. This module only feeds the SDK the live account; it
 * re-derives none of the program's math:
 *
 * - Whether a step can run and how much: the SDK's node status
 *   (`fetchDueNodes` -> `NodeStatus`): its cap `min(p1 - partial_spent,
 *   budget left this epoch)`, the most it may move (`maxAmount`), the least a
 *   caller may choose (`minAmount`; a keeper's buyback: 1% of the pool's SOL),
 *   what to run with (`amount`: the largest buyback the pool fills) and
 *   whether that is a keeper's partial buyback (`partial`). `partial_spent`
 *   is the SDK's decoding of the account (`AutopilotAccount.partialSpent`).
 * - A chosen amount: the program's planner (`planRun`, on the account as
 *   read, after this run's own price observation, `afterObservation`)
 *   accepts it or names the error the program would fail with (e.g. 6041
 *   RemainderTooSmall: a partial buyback must leave at least the keeper
 *   floor of the run); `planPartial` says whether it is a partial run.
 * - The tip: the program's `take_tip` (`takeTipRaw`), at most `planMaxTip`
 *   (a partial buyback's share) and a tenth of `planValue` (a burn's tokens
 *   at `burnPrice`, nothing before graduation; a payout less the shares kept
 *   for recipients without a wSOL account).
 */
import {
  afterObservation,
  AUTOPILOT_ERRORS,
  autopilotErrorCode,
  burnPrice,
  keeperFloor,
  lowestObserved,
  planMaxTip,
  planRun,
  planValue,
  takeTipRaw,
  verifyGraphBytes,
  type AutopilotErrorName,
  type DueNodes,
  type Outcome,
  type RunPlan,
} from "@noisedlabs/sdk";
import type { PublicKey } from "@solana/web3.js";

/** `Name (code)` for one of the autopilot program's errors (code 6000 + its index), else the name as given. */
export function programErrorText(name: string): string {
  return (AUTOPILOT_ERRORS as readonly string[]).includes(name) ? `${name} (${autopilotErrorCode(name as AutopilotErrorName)})` : name;
}

/** A keeper buyback's floor: 1% of the pool's SOL (the SDK's `keeperFloor`); null before graduation (no pool). */
export function keeperFloorOf(due: DueNodes): bigint | null {
  return due.view.pool === null ? null : keeperFloor(due.view.pool.sol);
}

/**
 * What the program would do running step `index` now (`planRun`, check for check in the program's order), with
 * `amount` (null: none, the most the step may move) and `operator` signing (operator-only steps). On the account as
 * read: the run that lands is decided again on-chain, on the state then.
 */
export function planStep(due: DueNodes, index: number, amount: bigint | null, operator: PublicKey | null): Outcome<RunPlan> {
  const { state, env } = due;
  const active = due.view.active;
  if (active === null || state === null || env === null) return { ok: false, error: "NoActiveGraph" };
  const raw = verifyGraphBytes(active.bytes);
  const a = due.view.autopilot;
  // `run` observes the pool first (once graduated) and moves the reference: decide on that, as the program does.
  const { price, window, observed } = afterObservation(state, env.now, env.spotSqrtPriceQ64, env.graduated);
  return planRun({
    graph: raw,
    node: index,
    now: BigInt(env.now),
    states: a.nodes.slice(0, raw.nodes.length),
    operator: a.operator.toBytes(),
    operatorSigner: operator === null ? null : operator.toBytes(),
    amount,
    treasurySol: env.treasurySol,
    treasuryToken: env.treasuryTokens,
    graduated: env.graduated,
    spot: env.graduated ? env.spotSqrtPriceQ64 : null,
    reference: price.reference,
    seen: window,
    observed,
    poolQuote: env.poolSol ?? 0n,
    partialSpent: a.partialSpent[index] ?? 0n,
  });
}

/**
 * The tip the caller should earn for `plan` (lamports): the program's `take_tip` on the account as read, an estimate
 * (the tip counters, the treasury and the price can move before the run lands). `kept`: the shares of a payout's
 * recipients without a wSOL account (skipped; their share stays in the treasury and earns no tip).
 */
export function expectedTip(due: DueNodes, index: number, plan: RunPlan, kept: bigint): bigint {
  const { state, env } = due;
  const active = due.view.active;
  if (active === null || state === null || env === null) return 0n;
  const node = verifyGraphBytes(active.bytes).nodes[index];
  if (node === undefined) return 0n;
  const a = due.view.autopilot;
  const { price } = afterObservation(state, env.now, env.spotSqrtPriceQ64, env.graduated);
  const value = planValue(plan, burnPrice(env.graduated, price.reference, lowestObserved(price.observations, env.now)), kept);
  // The tip is paid from the treasury's wSOL after the run: less what it swapped or paid out.
  const out = plan.kind === "buyback" ? plan.amountIn : plan.kind === "distribute" ? value : 0n;
  const treasury = env.treasurySol > out ? env.treasurySol - out : 0n;
  return takeTipRaw({ epochStart: a.tipEpochStart, inEpoch: a.tipsInEpoch }, BigInt(env.now), treasury, value, planMaxTip(plan, node.p1)).tip;
}

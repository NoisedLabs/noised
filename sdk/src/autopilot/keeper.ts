/**
 * A keeper for a launch's autopilot: anyone may run its due steps and is
 * tipped for it. One step at a time (`planKeeperStep`), from live accounts
 * and the program's own decisions (`fetchDueNodes`):
 *
 * 1. a queued graph that is due is applied first (`apply_pending`: every run
 *    fails with PendingUpdateDue until then);
 * 2. before ANY buyback the keeper makes its OWN price check (`update_price`,
 *    free; audit 4, OBS), even when other observations exist, and waits at
 *    least a minute after it (`KEEPER_OBSERVATION_WAIT_SECS`): pass the time
 *    it landed back as `ownObservationAt` (`runKeeper` does);
 * 3. the first due step a keeper may run (operator-only steps are the
 *    operator's) is run (`run`), a buyback only while the keeper's own
 *    observation is at least a minute old and still in the program's window
 *    (the current or previous 15-minute bucket), and while the observations
 *    the cluster holds span a minute at the cluster's clock;
 * 4. otherwise wait for the minute to pass, or idle.
 *
 * # The honest-observation dependency
 *
 * A buyback is bounded by the lower of the reference price and the lowest
 * price observed in the last 15 to 30 minutes, plus the node's premium. Its
 * protection against a manipulated pool price therefore rests on at least
 * one honest observation in that window: a keeper that only relied on
 * observations others made could be led to buy at a pumped price. So the SDK
 * keeper always observes itself first; a launch should also run an
 * independent observer that calls `update_price` at least every
 * `KEEPER_OBSERVER_INTERVAL_SECS` (10 minutes), so honest observations exist
 * whoever keeps.
 *
 * # Costs
 *
 * A keeper never pays to create anyone's account but its own tip account
 * (audit 4, M4): a distribution's recipient without a wSOL account is skipped
 * by the program and its share stays in the treasury. Every step reports
 * what it costs the keeper (`costs`) and, for a run, the tip it should earn
 * (`expectedTipLamports`, an estimate from the program's tip rules: at most
 * 100,000 lamports, 10% of what the run moved, a partial buyback's share of
 * it, nothing for a burn before graduation).
 *
 * `runKeeper` loops over these: observe, wait at least a minute, run what is
 * due.
 */
import { PublicKey, type Connection, type Keypair, type Transaction } from "@solana/web3.js";

import { clusterUnixTime } from "../launch/window.js";
import { AUTOPILOT, ACTION } from "../programmable/constants.js";
import { verifyGraphBytes } from "../programmable/graph/codec.js";
import { bucketOf, lowest, seen, tokenValue } from "../programmable/graph/reference.js";
import { graphShares } from "../programmable/graph/runtime.js";
import { burnPrice, takeTipRaw } from "../programmable/autopilot/logic.js";
import { computeUnitLimitOf, computeUnitPriceOf, priorityFeeLamports, type ComputeBudgetOptions } from "../rpc/computeBudget.js";
import { LAMPORTS_PER_SIGNATURE, sendAndConfirm } from "../rpc/index.js";
import { autopilotStateOf, fetchDueNodes, type FetchDueNodesOptions } from "./accounts.js";
import { AUTOPILOT_COMPUTE_UNITS, buildApplyPendingTx, buildRunTx, buildUpdatePriceTx, type RunCosts, type RunTx } from "./builders.js";

/** Seconds a buyback waits after the keeper's own price check: the observations must span at least a minute (`OBS_MIN_SPAN_SECS`). */
export const KEEPER_OBSERVATION_WAIT_SECS = 60;
/** How often an independent observer should call `update_price` (at most every 10 minutes), so every buyback window holds honest observations. */
export const KEEPER_OBSERVER_INTERVAL_SECS = 600;

/** What a keeper should do next. */
export type KeeperStep =
  /** A queued graph is due: apply it first. */
  | { readonly kind: "apply-pending"; readonly tx: Transaction; readonly costs: RunCosts; readonly detail: string }
  /**
   * A buyback is waiting for the keeper's own price check: send this, then
   * wait a minute (pass its landing time as `ownObservationAt`). `because`:
   * no own check yet, the last one is out of the program's window, or the
   * last one was never seen by the program (it did not land or count).
   */
  | {
      readonly kind: "update-price";
      readonly tx: Transaction;
      readonly thenWaitSecs: 60;
      readonly because: "no-own-check" | "own-check-too-old" | "own-check-not-seen";
      readonly costs: RunCosts;
      readonly detail: string;
    }
  /** A price check is counting: nothing to run before `untilSecs` (cluster unix seconds). */
  | { readonly kind: "wait"; readonly untilSecs: bigint; readonly detail: string }
  /** Run this due step: `costs` is what it costs the keeper, `expectedTipLamports` what it should earn (estimate). */
  | {
      readonly kind: "run";
      readonly node: number;
      readonly tx: Transaction;
      readonly run: RunTx;
      readonly costs: RunCosts;
      readonly expectedTipLamports: bigint;
      readonly detail: string;
    }
  /** Nothing to do now. */
  | { readonly kind: "idle"; readonly detail: string };

/** `planKeeperStep` options: the keeper's view (`fetchDueNodes`), the priority fee and the keeper's own last observation. */
export type KeeperStepOptions = FetchDueNodesOptions &
  ComputeBudgetOptions & {
    /**
     * Cluster unix seconds when THIS keeper's own `update_price` landed (null
     * or omitted: none yet). A buyback is planned only when it is at least
     * `KEEPER_OBSERVATION_WAIT_SECS` old and still in the program's window;
     * otherwise the step is the keeper's own price check (or a wait).
     */
    ownObservationAt?: bigint | null | undefined;
  };

/** The fee-only cost of a keeper transaction with one signer. */
function feeOnly(units: number, cb: ComputeBudgetOptions): RunCosts {
  const price = computeUnitPriceOf(cb);
  const priority = price === null || price === 0n ? 0n : priorityFeeLamports(price, computeUnitLimitOf(cb, units));
  return { signatureFeeLamports: LAMPORTS_PER_SIGNATURE, priorityFeeLamports: priority, rentLamports: 0n, totalLamports: LAMPORTS_PER_SIGNATURE + priority };
}

/**
 * The next keeper step for `launch`, `caller` paying (and tipped): see the
 * module docs for the order. A step built from `opts.now` (a later time)
 * may still be refused by the cluster; a buyback is never planned unless the
 * keeper's own observation (`ownObservationAt`) is at least a minute old and
 * the observations span a minute at the cluster's own clock.
 */
export async function planKeeperStep(conn: Connection, caller: PublicKey, launch: PublicKey, opts: KeeperStepOptions = {}): Promise<KeeperStep> {
  const cb: ComputeBudgetOptions = { computeUnitPrice: opts.computeUnitPrice, computeUnitLimit: opts.computeUnitLimit };
  const own = opts.ownObservationAt ?? null;
  if (own !== null && typeof own !== "bigint") throw new TypeError("ownObservationAt must be bigint cluster unix seconds (or null)");
  const view: FetchDueNodesOptions = {};
  if (opts.poolFeeBps !== undefined) view.poolFeeBps = opts.poolFeeBps;
  if (opts.now !== undefined) view.now = opts.now;
  const dn = await fetchDueNodes(conn, launch, view);
  if (dn === null) return { kind: "idle", detail: "This launch has no autopilot." };
  if (dn.applyPendingFirst) {
    return {
      kind: "apply-pending",
      tx: await buildApplyPendingTx(conn, caller, launch, cb),
      costs: feeOnly(AUTOPILOT_COMPUTE_UNITS.applyPending, cb),
      detail: "A new plan's start time has come: switching it on before anything else runs.",
    };
  }
  const active = dn.view.active;
  if (dn.graph === null || active === null) {
    return { kind: "idle", detail: dn.view.autopilot.mintBound ? "No plan is running yet." : "The autopilot isn't linked to the token yet." };
  }
  const raw = verifyGraphBytes(active.bytes);
  const a = dn.view.autopilot;
  const clusterNow = Number(dn.view.now);
  // The observations the program holds, at the cluster's clock.
  const observations = autopilotStateOf(a, raw.nodes.length).observations ?? [];
  const observedNow = seen(observations, clusterNow) !== null;
  // The keeper's own observation: at least a minute old, and still in the window (current or previous bucket).
  const ownInWindow = own !== null && Number(own) <= clusterNow && bucketOf(Number(own)) >= bucketOf(clusterNow) - 1;
  const ownReady = ownInWindow && clusterNow - Number(own) >= KEEPER_OBSERVATION_WAIT_SECS;

  const keeperNodes = dn.statuses.flatMap((s, i) => (s.operatorOnly ? [] : [{ s, i }]));
  const isBuyback = (i: number): boolean => raw.nodes[i]!.action === ACTION.BUYBACK_BURN;
  // Waiting for a price check: the program's notObserved, or a buyback due but without the keeper's own minute-old observation.
  const waitingForPrice = keeperNodes.filter(({ s, i }) => s.reason === "notObserved" || (s.due && isBuyback(i) && !(ownReady && observedNow)));
  // The keeper's own check is needed again: none yet, too old for the window, or a minute old but never seen by the program.
  const because = own === null ? "no-own-check" : !ownInWindow ? "own-check-too-old" : ownReady && !observedNow ? "own-check-not-seen" : null;
  if (waitingForPrice.length > 0 && because !== null && a.graduated) {
    return {
      kind: "update-price",
      tx: await buildUpdatePriceTx(conn, caller, launch, cb),
      thenWaitSecs: KEEPER_OBSERVATION_WAIT_SECS,
      because,
      costs: feeOnly(AUTOPILOT_COMPUTE_UNITS.updatePrice, cb),
      detail: `Checking the pool's price first: a buyback (step ${waitingForPrice.map(({ i }) => i).join(", ")}) runs only a minute after this keeper's own price check.`,
    };
  }
  const skipped: string[] = [];
  for (const { s, i } of keeperNodes) {
    if (!s.due) continue;
    const buyback = isBuyback(i);
    if (buyback && !(ownReady && observedNow)) continue; // never without the keeper's own minute-old observation
    // A smaller buyback (what the pool fills, leaving at least the keeper floor of the run): pass it; else no amount.
    const amount = buyback && s.amount > 0n && s.amount < s.maxAmount ? s.amount : null;
    try {
      const run = await buildRunTx(conn, caller, launch, i, { ...cb, amount });
      const tip = expectedTip(dn, raw, i, s.amount, buyback && amount !== null && s.partial, run);
      const skippedText = run.skippedRecipients.length > 0 ? ` ${run.skippedRecipients.length} recipient(s) without a wSOL account are skipped (their share stays in the treasury).` : "";
      return {
        kind: "run",
        node: i,
        tx: run.tx,
        run,
        costs: run.costs,
        expectedTipLamports: tip,
        detail: `Running step ${i}: ${s.why}${skippedText} Costs about ${run.costs.totalLamports} lamports; the tip should be about ${tip}.`,
      };
    } catch (e) {
      skipped.push(`step ${i}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (waitingForPrice.length > 0 && ownInWindow && a.graduated) {
    return {
      kind: "wait",
      untilSecs: own! + BigInt(KEEPER_OBSERVATION_WAIT_SECS),
      detail: `Waiting for this keeper's price check to be a minute old before a buyback (step ${waitingForPrice.map(({ i }) => i).join(", ")}) can run.`,
    };
  }
  return { kind: "idle", detail: skipped.length > 0 ? `Nothing could run now (${skipped.join("; ")}).` : "Nothing is due right now." };
}

/** The tip a run should earn (the program's `take_tip`, on the state as read: an estimate). */
function expectedTip(
  dn: NonNullable<Awaited<ReturnType<typeof fetchDueNodes>>>,
  raw: ReturnType<typeof verifyGraphBytes>,
  i: number,
  amount: bigint,
  partial: boolean,
  run: RunTx,
): bigint {
  const a = dn.view.autopilot;
  const node = raw.nodes[i]!;
  const now = dn.view.now;
  let value: bigint;
  let spent = amount;
  if (node.action === ACTION.BURN) {
    const obs = autopilotStateOf(a, raw.nodes.length).observations ?? [];
    value = tokenValue(amount, burnPrice(a.graduated, a.refSqrtPrice, lowest(obs, Number(now))));
    spent = 0n;
  } else if (node.action === ACTION.DISTRIBUTE_SOL) {
    // Paid: the shares of the recipients that have a wSOL account (a skipped one's share stays; audit 4, M4).
    const shares = graphShares(raw, amount);
    const skipped = new Set(run.skippedRecipients.map((k) => k.toBase58()));
    value = 0n;
    raw.recipients.forEach((r, j) => {
      if (!skipped.has(new PublicKey(r.key).toBase58())) value += shares[j] ?? 0n;
    });
    spent = value;
  } else value = amount;
  const maxTip = partial ? (AUTOPILOT.TIP_LAMPORTS * amount) / (node.p1 > 1n ? node.p1 : 1n) : AUTOPILOT.TIP_LAMPORTS;
  const treasury = dn.view.treasury.sol > spent ? dn.view.treasury.sol - spent : 0n;
  return takeTipRaw({ epochStart: a.tipEpochStart, inEpoch: a.tipsInEpoch }, now, treasury, value, maxTip).tip;
}

/** `runKeeper` options. */
export interface RunKeeperOptions extends ComputeBudgetOptions {
  /** Pays every transaction and receives the tips. */
  readonly caller: Keypair;
  readonly launch: PublicKey;
  /** Signs and sends a transaction, returning its signature (default: `caller` signs, `sendAndConfirm`). */
  readonly send?: ((tx: Transaction) => Promise<string>) | undefined;
  /** Waits `ms` milliseconds (default `setTimeout`). */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Stop after this many steps (default 20). */
  readonly maxSteps?: number | undefined;
  /** The pool's trading fee in bps (see `fetchDueNodes`). */
  readonly poolFeeBps?: number | undefined;
}

/** One step `runKeeper` took. */
export interface KeeperRunStep {
  readonly kind: KeeperStep["kind"];
  readonly detail: string;
  /** The step run, for `run`. */
  readonly node: number | null;
  /** The transaction sent, if any. */
  readonly signature: string | null;
  /** What the step cost the keeper (null: nothing was sent). */
  readonly costs: RunCosts | null;
  /** A run's expected tip (estimate; null for other steps). */
  readonly expectedTipLamports: bigint | null;
}

/** What `runKeeper` did. */
export interface KeeperRunResult {
  readonly steps: KeeperRunStep[];
  readonly signatures: string[];
  /** `idle`: nothing left to do; `max-steps`: the step budget ran out; `error`: a send failed or a price check did not count. */
  readonly stopped: "idle" | "max-steps" | "error";
  readonly detail: string;
  readonly error: unknown;
  /** What the sent transactions cost the keeper in total (fees and rent), lamports. */
  readonly costLamports: bigint;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `launch`'s autopilot as a keeper until nothing is left to do: apply a
 * due graph, make its own price check, wait at least a minute (on the
 * cluster's clock), run what is due, again (`planKeeperStep` each time, with
 * the time its own price check landed). Never runs a buyback without its own
 * observation a minute old; never runs operator-only steps; never pays for a
 * recipient's account. Stops when idle, after `maxSteps`, or at the first
 * failed send.
 */
export async function runKeeper(conn: Connection, opts: RunKeeperOptions): Promise<KeeperRunResult> {
  const caller = opts.caller;
  const maxSteps = opts.maxSteps ?? 20;
  if (!Number.isInteger(maxSteps) || maxSteps < 1) throw new RangeError("maxSteps must be a positive integer");
  const sleep = opts.sleep ?? defaultSleep;
  const send =
    opts.send ??
    (async (tx: Transaction): Promise<string> => {
      tx.sign(caller);
      return sendAndConfirm(conn, tx);
    });
  const steps: KeeperRunStep[] = [];
  const signatures: string[] = [];
  let cost = 0n;
  let ownObservationAt: bigint | null = null;
  for (let n = 0; n < maxSteps; n++) {
    const stepOpts: KeeperStepOptions = { computeUnitPrice: opts.computeUnitPrice, computeUnitLimit: opts.computeUnitLimit, ownObservationAt };
    if (opts.poolFeeBps !== undefined) stepOpts.poolFeeBps = opts.poolFeeBps;
    const step = await planKeeperStep(conn, caller.publicKey, opts.launch, stepOpts);
    if (step.kind === "idle") {
      steps.push({ kind: "idle", detail: step.detail, node: null, signature: null, costs: null, expectedTipLamports: null });
      return { steps, signatures, stopped: "idle", detail: step.detail, error: null, costLamports: cost };
    }
    if (step.kind === "wait") {
      const now = await clusterUnixTime(conn);
      const secs = step.untilSecs > now ? step.untilSecs - now : 0n;
      steps.push({ kind: "wait", detail: step.detail, node: null, signature: null, costs: null, expectedTipLamports: null });
      await sleep(Number(secs) * 1_000 + 1_000);
      continue;
    }
    if (step.kind === "update-price" && step.because === "own-check-not-seen") {
      const detail = "the price check did not count (the program never saw this keeper's observation): stopping instead of checking again";
      return { steps, signatures, stopped: "error", detail, error: null, costLamports: cost };
    }
    let signature: string;
    try {
      signature = await send(step.tx);
    } catch (e) {
      steps.push({ kind: step.kind, detail: step.detail, node: step.kind === "run" ? step.node : null, signature: null, costs: null, expectedTipLamports: null });
      return { steps, signatures, stopped: "error", detail: `sending failed: ${e instanceof Error ? e.message : String(e)}`, error: e, costLamports: cost };
    }
    // The keeper's own observation: the cluster time once it landed (at or after its real time: never early).
    if (step.kind === "update-price") ownObservationAt = await clusterUnixTime(conn);
    cost += step.costs.totalLamports;
    signatures.push(signature);
    steps.push({
      kind: step.kind,
      detail: step.detail,
      node: step.kind === "run" ? step.node : null,
      signature,
      costs: step.costs,
      expectedTipLamports: step.kind === "run" ? step.expectedTipLamports : null,
    });
  }
  return { steps, signatures, stopped: "max-steps", detail: `stopped after ${maxSteps} steps`, error: null, costLamports: cost };
}

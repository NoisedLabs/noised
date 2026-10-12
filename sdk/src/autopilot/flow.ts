/**
 * Switching a launch's autopilot to a graph, end to end: publish the graph
 * (anyone), approve it with the launch's post-quantum identity
 * (`pq_authorize`, kind 1, over `activationPayload(autopilot, graphHash,
 * activateAt)`), queue it (`activate`), and, once its time came, make it the
 * running one (`apply_pending`, anyone). A first graph may start at once; a
 * replacement starts no earlier than 72 hours after both its queuing and
 * its approval's landing (`GRAPH_TIMELOCK_SECS`), so everyone sees it coming.
 *
 * `planGraphActivation` fixes the start time (it is part of what the identity
 * signs: keep the plan, a rebuild from the same plan gives the same leaf and
 * signature bytes), `getGraphActivationStatus` says where a plan stands (with
 * a plain-English line for the UI) and `buildNextGraphActivationTx` builds
 * whatever comes next. Every time is also given as an absolute UTC date
 * (`activateAtIso`, `applyAtIso`; audit 4, ID-F5), and the graph's payees are
 * checked like fee recipients before anything is planned (audit 4, C1:
 * `checkGraphRecipients`).
 */
import { PublicKey, type Connection, type Keypair, type Transaction } from "@solana/web3.js";

import { bytesEqual } from "../codec/bytes.js";
import { fetchAuthorization, fetchLaunch } from "../launch/accounts.js";
import { checkGraphRecipients } from "../launch/recipients.js";
import { clusterUnixTime, unixToIso, unixToUtcText } from "../launch/window.js";
import { authorizationAddress, autopilotAddress } from "../pda.js";
import { activationPayload, checkActivation, checkFresh, type AuthMark } from "../programmable/autopilot/logic.js";
import { verifyGraph, verifyGraphBytes } from "../programmable/graph/codec.js";
import { explainGraph } from "../programmable/graph/explain.js";
import { graphHash as hashGraph } from "../programmable/hash.js";
import { buildPqAuthorizeTx, type PqAuthorizeTx } from "../pq/authorize.js";
import type { PqIdentity } from "../pq/identity.js";
import type { LeafLedger } from "../pq/leafLedger.js";
import type { LedgerLock } from "../pq/ledgerLock.js";
import { checkClockSkew, type ClockCheckOptions } from "../rpc/clock.js";
import type { ComputeBudgetOptions } from "../rpc/computeBudget.js";
import { fetchAutopilot, fetchGraph } from "./accounts.js";
import {
  buildApplyPendingTx,
  buildInitAutopilotTx,
  buildPublishGraphTx,
  buildPublishGraphV1Tx,
  PUBLISH_GRAPH_LEGACY_MAX_BYTES,
  type PublishGraphAlreadyPublished,
  type PublishGraphReady,
  type PublishGraphV1Ready,
} from "./builders.js";
import { buildActivateTx } from "./governance.js";

/** The wait before a replacement graph may start: 72 hours (the program's `UPDATE_TIMELOCK_SECS`). */
export const GRAPH_TIMELOCK_SECS = 259_200n;
/** Default seconds added to the earliest start time, to leave room for the approval to land. */
const DEFAULT_MARGIN_SECS = 600n;

/** A graph activation, fixed before anything is signed. */
export interface GraphActivationPlan {
  readonly launch: PublicKey;
  /** `["autopilot", launch]`. */
  readonly autopilot: PublicKey;
  readonly graphHash: Uint8Array;
  /** The PXG1 bytes (verified). */
  readonly graphBytes: Uint8Array;
  /** When the graph may take effect (unix seconds): part of what the identity signs. */
  readonly activateAt: bigint;
  /** `activateAt` as an absolute UTC date (`unixToIso`): show it, not only "in N days". */
  readonly activateAtIso: string;
  /** `activationPayload(autopilot, graphHash, activateAt)`. */
  readonly payloadHash: Uint8Array;
  readonly kind: 1;
  /** Where the approval will be written: `["auth", launch, [1], payloadHash]`. */
  readonly authorization: PublicKey;
  /** No graph active or queued when planned: it may start at once (else 72 hours after its approval lands). */
  readonly firstGraph: boolean;
  /** The earliest start the program would accept when planned (cluster clock). */
  readonly earliestActivateAt: bigint;
  /** `earliestActivateAt` as an absolute UTC date. */
  readonly earliestActivateAtIso: string;
  /** What the graph does, in plain English (`explainGraph`). */
  readonly explanation: string[];
  /**
   * Cautions about the graph's payees (`checkGraphRecipients`): an account of
   * another program (only it can move what it receives), or a payee without
   * a wSOL account yet (skipped, its share kept in the treasury, until it
   * creates one). A payee whose share would be lost is refused instead.
   */
  readonly warnings: string[];
}

/** `planGraphActivation` options. */
export interface PlanGraphActivationOptions extends ClockCheckOptions {
  /** When the graph may take effect (unix seconds; default: the earliest the program accepts plus `marginSecs`). */
  activateAt?: bigint;
  /** Seconds added to the earliest start (default 600). */
  marginSecs?: bigint;
}

/** The graph's payees as `PublicKey`s, in PXG1 order. */
function graphRecipientKeys(graphBytes: Uint8Array): PublicKey[] {
  return verifyGraphBytes(graphBytes).recipients.map((r) => new PublicKey(r.key));
}

/**
 * Plan switching `launch`'s autopilot to the graph `graphBytes` (verified
 * first). Default start: a first graph (nothing active or queued) the
 * cluster time plus `marginSecs` (default 600); a replacement the cluster
 * time plus 72 hours plus `marginSecs`. An explicit `activateAt` earlier than
 * the program would accept is refused, and so is a frozen autopilot. The
 * graph's payees are checked like fee recipients first (audit 4, C1): a PQ
 * vault of another mint (it never releases wSOL: the share would be lost
 * forever), token accounts, mints, programs and off-curve addresses with no
 * account are refused; other cautions are in `warnings`. The cluster clock
 * must agree with this device's (`ClockSkewError`; audit 4, ID-F1b). Keep
 * the plan: its start time is signed, and a rebuild from the same plan gives
 * the same signature.
 */
export async function planGraphActivation(conn: Connection, launch: PublicKey, graphBytes: Uint8Array, opts: PlanGraphActivationOptions = {}): Promise<GraphActivationPlan> {
  if (!(graphBytes instanceof Uint8Array)) throw new TypeError("graphBytes must be the PXG1 bytes (compileGraph)");
  const v = verifyGraph(graphBytes);
  if (!v.ok) throw new Error(`the graph does not verify as PXG1 (${v.code}: ${v.message})`);
  const payees = await checkGraphRecipients(conn, graphRecipientKeys(graphBytes));
  if (!payees.ok) {
    throw new Error(`refusing to plan this graph: a payee could never receive its share:\n${payees.refusals.join("\n")}`);
  }
  const margin = opts.marginSecs ?? DEFAULT_MARGIN_SECS;
  if (typeof margin !== "bigint" || margin < 0n) throw new RangeError("marginSecs must be a non-negative bigint");
  if (opts.activateAt !== undefined && typeof opts.activateAt !== "bigint") throw new TypeError("activateAt must be bigint unix seconds");
  if ((await fetchLaunch(conn, launch)) === null) throw new Error(`launch ${launch.toBase58()} does not exist`);
  const ap = await fetchAutopilot(conn, launch);
  if (ap !== null && ap.frozen) throw new Error("this launch's autopilot is frozen forever: no graph can be switched on");
  const now = (await checkClockSkew(conn, opts)).clusterSecs;
  const firstGraph = ap === null || (!ap.hasActiveGraph && !ap.hasPendingGraph);
  const earliestActivateAt = firstGraph ? now : now + GRAPH_TIMELOCK_SECS;
  const activateAt = opts.activateAt ?? earliestActivateAt + margin;
  if (activateAt < earliestActivateAt) {
    throw new RangeError(
      firstGraph
        ? `activateAt ${unixToUtcText(activateAt)} has already passed (cluster time ${unixToUtcText(now)}): the program would refuse it (ActivationInPast)`
        : `a replacement graph may start no earlier than 72 hours from now (${unixToUtcText(earliestActivateAt)}, and 72 hours after its approval lands); ${unixToUtcText(activateAt)} is too early (TimelockTooShort)`,
    );
  }
  const graphHash = hashGraph(graphBytes);
  const autopilot = autopilotAddress(launch);
  const payloadHash = activationPayload(autopilot, graphHash, activateAt);
  return {
    launch,
    autopilot,
    graphHash,
    graphBytes: Uint8Array.from(graphBytes),
    activateAt,
    activateAtIso: unixToIso(activateAt),
    payloadHash,
    kind: 1,
    authorization: authorizationAddress(launch, 1, payloadHash),
    firstGraph,
    earliestActivateAt,
    earliestActivateAtIso: unixToIso(earliestActivateAt),
    explanation: explainGraph(graphBytes),
    warnings: payees.warnings,
  };
}

/** Where a planned activation stands, and what comes next. */
export interface GraphActivationStatus {
  readonly stage:
    | "no-autopilot"
    | "graph-not-published"
    | "awaiting-authorization"
    | "authorization-burned"
    | "ready-to-activate"
    | "queued"
    | "due"
    | "active"
    | "frozen"
    | "superseded";
  readonly next: "init-autopilot" | "publish-graph" | "authorize" | "activate" | "wait" | "apply-pending" | "done" | "none";
  /** When the graph takes (or would take) effect, unix seconds; null once it runs or can't any more. */
  readonly applyAt: bigint | null;
  /** `applyAt` as an absolute UTC date (`unixToIso`), or null. */
  readonly applyAtIso: string | null;
  /** Seconds from the cluster clock to `applyAt` (0 once reached), or null. */
  readonly secondsLeft: bigint | null;
  /** One plain-English line for the UI. */
  readonly plain: string;
}

/** "about 3 days", "about 5 hours", "about 12 minutes", "less than a minute". Internal (also used by `./freeze.ts`). */
export function inWords(secs: bigint): string {
  const s = secs < 0n ? 0n : secs;
  const round = (unit: bigint): bigint => (s + unit / 2n) / unit;
  if (s < 60n) return "less than a minute";
  if (s < 3_600n) {
    const m = round(60n);
    return `about ${m} minute${m === 1n ? "" : "s"}`;
  }
  if (s < 2n * 86_400n) {
    const h = round(3_600n);
    return `about ${h} hour${h === 1n ? "" : "s"}`;
  }
  return `about ${round(86_400n)} days`;
}

function checkPlan(launch: PublicKey, plan: GraphActivationPlan): void {
  if (plan === null || typeof plan !== "object" || plan.kind !== 1) throw new TypeError("plan must come from planGraphActivation");
  if (!plan.launch.equals(launch)) throw new Error("this plan is for another launch");
  if (!bytesEqual(activationPayload(plan.autopilot, plan.graphHash, plan.activateAt), plan.payloadHash) || !autopilotAddress(launch).equals(plan.autopilot)) {
    throw new Error("this plan's approval does not match its graph and start time (a modified plan?)");
  }
}

/**
 * Where `plan` stands on live accounts (the cluster clock for time):
 * no autopilot yet, the graph not published, the approval missing (or only a
 * burned leaf at its address), approved and ready to queue, queued (waiting
 * for its time), due (`apply_pending`), active, frozen (it can never be
 * switched on), or superseded (its approval was used or overtaken by a newer
 * change, or its start time can no longer be accepted: plan again).
 */
export async function getGraphActivationStatus(conn: Connection, launch: PublicKey, plan: GraphActivationPlan): Promise<GraphActivationStatus> {
  checkPlan(launch, plan);
  const now = await clusterUnixTime(conn);
  const timing = (applyAt: bigint | null): Pick<GraphActivationStatus, "applyAt" | "applyAtIso" | "secondsLeft"> => ({
    applyAt,
    applyAtIso: applyAt === null ? null : unixToIso(applyAt),
    secondsLeft: applyAt === null ? null : applyAt > now ? applyAt - now : 0n,
  });
  const ap = await fetchAutopilot(conn, launch);
  if (ap === null) {
    return { stage: "no-autopilot", next: "init-autopilot", ...timing(plan.activateAt), plain: "Automation isn't set up for this launch yet. The first step sets it up (anyone can do it)." };
  }
  if (ap.hasActiveGraph && bytesEqual(ap.activeGraph, plan.graphHash)) {
    return { stage: "active", next: "done", ...timing(null), plain: ap.frozen ? "This plan is running, and it's locked for good." : "This plan is running." };
  }
  if (ap.hasPendingGraph && bytesEqual(ap.pendingGraph, plan.graphHash)) {
    if (now >= ap.pendingActivateAt) {
      return { stage: "due", next: "apply-pending", ...timing(ap.pendingActivateAt), plain: "It's time: one last step switches this plan on (anyone can do it)." };
    }
    const left = ap.pendingActivateAt - now;
    return {
      stage: "queued",
      next: "wait",
      ...timing(ap.pendingActivateAt),
      plain: `Scheduled: this plan switches on in ${inWords(left)} (${unixToUtcText(ap.pendingActivateAt)}).${ap.hasActiveGraph ? " Changes to a running plan wait 72 hours so everyone can see them coming." : ""}`,
    };
  }
  if (ap.frozen) {
    return { stage: "frozen", next: "none", ...timing(null), plain: "Automation for this launch is locked for good, so this plan can't be switched on." };
  }
  if ((await fetchGraph(conn, launch, plan.graphHash)) === null) {
    return { stage: "graph-not-published", next: "publish-graph", ...timing(plan.activateAt), plain: "This plan isn't saved on-chain yet. The next step saves it so anyone can read exactly what it does." };
  }
  const auth = await fetchAuthorization(conn, launch, 1, plan.payloadHash);
  if (auth === null) {
    return {
      stage: "awaiting-authorization",
      next: "authorize",
      ...timing(plan.activateAt),
      plain: `This plan is saved. Next, approve it with your launch's quantum key. It would switch on at ${unixToUtcText(plan.activateAt)}.`,
    };
  }
  if (!auth.authorized) {
    return {
      stage: "authorization-burned",
      next: "authorize",
      ...timing(plan.activateAt),
      plain: "An approval was sent for this plan but didn't count (it wasn't signed by this launch's quantum key). Approve it again with the right key.",
    };
  }
  const marks = ap.authMarks.map((m) => ({ slot: m.slot, key: m.key.toBytes() })) as unknown as readonly [AuthMark, AuthMark, AuthMark];
  if (checkFresh({ slot: auth.slot, key: plan.authorization.toBytes() }, marks, 1) !== null) {
    return {
      stage: "superseded",
      next: "none",
      ...timing(null),
      plain: "This approval was already used, or a newer change was approved after it, so it can't switch the plan on any more. Make a new plan if you still want it.",
    };
  }
  if (checkActivation({ activeGraph: ap.activeGraph, pendingGraph: ap.pendingGraph, frozen: ap.frozen, now, activateAt: plan.activateAt, authUnixTime: auth.unixTime }) !== null) {
    return {
      stage: "superseded",
      next: "none",
      ...timing(null),
      plain: "The start time in this plan is too early now (it has passed, or the 72-hour wait wouldn't be over). Make a new plan with a later start.",
    };
  }
  return {
    stage: "ready-to-activate",
    next: "activate",
    ...timing(plan.activateAt),
    plain: `Approved. Next, schedule it: it can switch on in ${inWords(plan.activateAt - now)}, at ${unixToUtcText(plan.activateAt)} (anyone can send this step).`,
  };
}

/** `buildNextGraphActivationTx` options. */
export interface NextGraphActivationOptions extends ComputeBudgetOptions {
  /** Pays the legacy transactions (setup, publish, activate, apply): the wallet. */
  readonly payer: PublicKey;
  /** The throwaway fee payer of the v1 transactions: the approval (`pq_authorize`) and a graph too large for a legacy publish. */
  readonly throwaway?: Keypair | undefined;
  /** The launch's identity (to approve). */
  readonly identity?: PqIdentity | undefined;
  /** The identity's leaf ledger (to approve). */
  readonly ledger?: LeafLedger | undefined;
  /** The wallet that created the launch (default `payer`). */
  readonly creator?: PublicKey | undefined;
  /** Accept an identity derived for localnet (see `assertCluster`). */
  readonly allowLocalnet?: boolean | undefined;
  /** Commitment the launch must have reached before the identity signs (default `finalized`). */
  readonly launchCommitment?: "finalized" | "confirmed" | undefined;
  /** The approval's `acknowledgeExtraSignatures` (`buildPqAuthorizeTx`; audit 4, ID-F2). */
  readonly acknowledgeExtraSignatures?: boolean | undefined;
  /** The approval's `signingLock` (in a browser `(name, fn) => navigator.locks.request(name, fn)`; audit 4, ID-F4). */
  readonly signingLock?: LedgerLock | undefined;
  /** This device's unix seconds for the clock check (default its clock; audit 4, ID-F1b). */
  readonly localNowSecs?: bigint | undefined;
  /** A second, independent RPC for the clock check. */
  readonly secondConnection?: Connection | undefined;
  /** Most seconds the clocks may differ (default 120). */
  readonly maxClockSkewSecs?: bigint | undefined;
}

/** The next transaction of a planned activation, with the status it was built from. */
export type NextGraphActivationTx =
  | { readonly step: "init-autopilot"; readonly status: GraphActivationStatus; readonly result: Transaction }
  | { readonly step: "publish-graph"; readonly status: GraphActivationStatus; readonly result: PublishGraphReady | PublishGraphV1Ready | PublishGraphAlreadyPublished }
  | { readonly step: "authorize"; readonly status: GraphActivationStatus; readonly result: PqAuthorizeTx }
  | { readonly step: "activate"; readonly status: GraphActivationStatus; readonly result: Transaction }
  | { readonly step: "apply-pending"; readonly status: GraphActivationStatus; readonly result: Transaction };

/**
 * Build what `plan` needs next (`getGraphActivationStatus`): `init_autopilot`;
 * the graph's publication (a legacy transaction from `payer` when it fits,
 * else a v1 transaction signed by `throwaway`); the approval
 * (`buildPqAuthorizeTx` with `identity`, `ledger` and `throwaway` as its fee
 * payer); `activate`; `apply_pending`. Null while waiting for the start
 * time, once done, or when the plan can't go further (frozen, superseded).
 */
export async function buildNextGraphActivationTx(conn: Connection, launch: PublicKey, plan: GraphActivationPlan, opts: NextGraphActivationOptions): Promise<NextGraphActivationTx | null> {
  const status = await getGraphActivationStatus(conn, launch, plan);
  const cb: ComputeBudgetOptions = { computeUnitPrice: opts.computeUnitPrice, computeUnitLimit: opts.computeUnitLimit };
  switch (status.next) {
    case "init-autopilot":
      return { step: "init-autopilot", status, result: await buildInitAutopilotTx(conn, opts.payer, launch, cb) };
    case "publish-graph": {
      if (plan.graphBytes.length <= PUBLISH_GRAPH_LEGACY_MAX_BYTES) return { step: "publish-graph", status, result: await buildPublishGraphTx(conn, opts.payer, launch, plan.graphBytes, cb) };
      if (opts.throwaway === undefined) {
        throw new TypeError(`a ${plan.graphBytes.length}-byte graph is published in a v1 transaction signed by a throwaway key: pass throwaway (a funded Keypair)`);
      }
      return { step: "publish-graph", status, result: await buildPublishGraphV1Tx(conn, opts.throwaway, launch, plan.graphBytes, cb) };
    }
    case "authorize": {
      if (opts.identity === undefined || opts.ledger === undefined) throw new TypeError("approving the plan needs the launch's identity and its leaf ledger: pass identity and ledger");
      const result = await buildPqAuthorizeTx(conn, {
        launch,
        creator: opts.creator ?? opts.payer,
        identity: opts.identity,
        ledger: opts.ledger,
        kind: 1,
        payloadHash: plan.payloadHash,
        payer: opts.throwaway,
        allowLocalnet: opts.allowLocalnet,
        launchCommitment: opts.launchCommitment,
        computeUnitPrice: opts.computeUnitPrice,
        acknowledgeExtraSignatures: opts.acknowledgeExtraSignatures,
        signingLock: opts.signingLock,
        localNowSecs: opts.localNowSecs,
        secondConnection: opts.secondConnection,
        maxClockSkewSecs: opts.maxClockSkewSecs,
      });
      return { step: "authorize", status, result };
    }
    case "activate":
      return { step: "activate", status, result: await buildActivateTx(conn, opts.payer, launch, { ...cb, graphHash: plan.graphHash, activateAt: plan.activateAt }) };
    case "apply-pending":
      return { step: "apply-pending", status, result: await buildApplyPendingTx(conn, opts.payer, launch, cb) };
    default:
      return null;
  }
}

/**
 * Freezing a launch's autopilot, end to end: approve the freeze with the
 * launch's post-quantum identity (`pq_authorize`, kind 2, over
 * `freezePayload(autopilot, activeGraph, notAfter)`), then send
 * `freeze(not_after)` (anyone) no later than `notAfter`. Once frozen, the
 * running graph never changes again (a queued graph is cancelled); its
 * operator can still be removed.
 *
 * A freeze names the last second it may be used (`notAfter`, inclusive;
 * review 4, R5): an approval that was landed and then withheld cannot be
 * used at a time its signer did not choose. `planFreeze` fixes it (default:
 * the cluster time plus one hour, `FREEZE_DEFAULT_VALID_SECS`; at most 24
 * hours after this device's clock, `FREEZE_MAX_VALID_SECS`, and only while
 * the cluster clock agrees with this device's: audit 4, ID-F5). It is part
 * of what the identity signs: keep the plan, a rebuild from the same plan
 * gives the same leaf and signature bytes. `getFreezeStatus` says where a
 * plan stands (with a plain-English line for the UI, and the expiry as an
 * absolute date) and `buildNextFreezeTx` builds whatever comes next. Past
 * `notAfter` the plan is expired: plan a new freeze and approve it again.
 */
import type { Connection, PublicKey, Transaction } from "@solana/web3.js";

import { bytesEqual } from "../codec/bytes.js";
import { fetchAuthorization, fetchLaunch } from "../launch/accounts.js";
import { clusterUnixTime, unixToIso, unixToUtcText } from "../launch/window.js";
import { authorizationAddress, autopilotAddress } from "../pda.js";
import { checkFresh, FREEZE_DEFAULT_VALID_SECS, freezePayload, type AuthMark } from "../programmable/autopilot/logic.js";
import { buildPqAuthorizeTx, FREEZE_MAX_VALID_SECS, type PqAuthorizeTx } from "../pq/authorize.js";
import { checkClockSkew, type ClockCheckOptions } from "../rpc/clock.js";
import type { ComputeBudgetOptions } from "../rpc/computeBudget.js";
import { fetchAutopilot } from "./accounts.js";
import { inWords, type NextGraphActivationOptions } from "./flow.js";
import { buildFreezeTx, checkUnixSecs, unixTimeText } from "./governance.js";

/** A freeze, fixed before anything is signed. */
export interface FreezePlan {
  readonly launch: PublicKey;
  /** `["autopilot", launch]`. */
  readonly autopilot: PublicKey;
  /** The graph to freeze: the one running when planned. */
  readonly graphHash: Uint8Array;
  /** The last second the freeze may be used (unix seconds, inclusive): part of what the identity signs. */
  readonly notAfter: bigint;
  /** `notAfter` as an absolute UTC date (`unixToIso`): show it, not only "about an hour". */
  readonly notAfterIso: string;
  /** `freezePayload(autopilot, graphHash, notAfter)`. */
  readonly payloadHash: Uint8Array;
  readonly kind: 2;
  /** Where the approval will be written: `["auth", launch, [2], payloadHash]`. */
  readonly authorization: PublicKey;
  /** A graph was queued when planned: the freeze cancels it. */
  readonly cancelsPendingGraph: boolean;
}

function validFor(v: bigint | number | undefined): bigint {
  if (v === undefined) return FREEZE_DEFAULT_VALID_SECS;
  const s = typeof v === "bigint" ? v : Number.isSafeInteger(v) ? BigInt(v) : null;
  if (s === null || s < 1n) throw new RangeError("validForSecs must be a positive whole number of seconds");
  if (s > FREEZE_MAX_VALID_SECS) throw new RangeError(`validForSecs must be at most ${FREEZE_MAX_VALID_SECS} (24 hours): a freeze approval that was landed and then withheld stays usable that long`);
  return s;
}

/** `planFreeze` options. */
export interface PlanFreezeOptions extends ClockCheckOptions {
  /** The last second the freeze may be used (unix seconds); at most 24 hours after this device's clock. */
  notAfter?: bigint;
  /** Or: how long from the cluster clock (default 3,600 s; at most 86,400). */
  validForSecs?: bigint | number;
}

/**
 * Plan freezing `launch`'s autopilot on the graph running now. The freeze
 * may be used until `notAfter` (default: the cluster time plus
 * `validForSecs`, default 3,600). Refuses, up front: a cluster clock that
 * disagrees with this device's by more than 120 s (`ClockSkewError`; audit
 * 4, ID-F1b), a launch or autopilot that does not exist, an autopilot
 * already frozen (`Frozen`), no graph running (`NoActiveGraph`), a
 * `notAfter` already past (`FreezeExpired`) or more than 24 hours after this
 * device's clock (`FREEZE_MAX_VALID_SECS`; ID-F5: a freeze that was landed
 * and then withheld stays usable that long). Keep the plan: its `notAfter`
 * is signed, and a rebuild from the same plan gives the same signature.
 */
export async function planFreeze(conn: Connection, launch: PublicKey, opts: PlanFreezeOptions = {}): Promise<FreezePlan> {
  if (opts.notAfter !== undefined && opts.validForSecs !== undefined) throw new TypeError("pass notAfter or validForSecs, not both");
  if (opts.notAfter !== undefined) checkUnixSecs("notAfter", opts.notAfter);
  const window = validFor(opts.validForSecs);
  if ((await fetchLaunch(conn, launch)) === null) throw new Error(`launch ${launch.toBase58()} does not exist`);
  const ap = await fetchAutopilot(conn, launch);
  if (ap === null) throw new Error("this launch has no autopilot: there is nothing to freeze");
  if (ap.frozen) throw new Error("this launch's autopilot is already frozen forever (Frozen)");
  if (!ap.hasActiveGraph) throw new Error("no graph is running on this launch's autopilot: there is nothing to freeze (NoActiveGraph)");
  const clock = await checkClockSkew(conn, opts);
  const now = clock.clusterSecs;
  const notAfter = opts.notAfter ?? now + window;
  checkUnixSecs("notAfter", notAfter);
  if (now > notAfter) throw new RangeError(`notAfter ${unixTimeText(notAfter)} has already passed (cluster time ${unixTimeText(now)}): the program would refuse the freeze (FreezeExpired)`);
  if (notAfter > clock.localSecs + FREEZE_MAX_VALID_SECS) {
    throw new RangeError(
      `notAfter ${unixTimeText(notAfter)} is more than 24 hours after this device's clock (${unixTimeText(clock.localSecs)}): a freeze approval that was landed and then withheld would stay usable that long; choose an earlier time`,
    );
  }
  const autopilot = autopilotAddress(launch);
  const graphHash = Uint8Array.from(ap.activeGraph);
  const payloadHash = freezePayload(autopilot, graphHash, notAfter);
  return {
    launch,
    autopilot,
    graphHash,
    notAfter,
    notAfterIso: unixToIso(notAfter),
    payloadHash,
    kind: 2,
    authorization: authorizationAddress(launch, 2, payloadHash),
    cancelsPendingGraph: ap.hasPendingGraph,
  };
}

/** Where a planned freeze stands, and what comes next. */
export interface FreezeStatus {
  readonly stage: "no-autopilot" | "awaiting-authorization" | "authorization-burned" | "ready-to-freeze" | "frozen" | "expired" | "superseded";
  readonly next: "authorize" | "freeze" | "done" | "none";
  /** The plan's `notAfter` (unix seconds) while it matters (still usable, or expired); null once frozen or superseded. */
  readonly expiresAt: bigint | null;
  /** `expiresAt` as an absolute UTC date (`unixToIso`), or null. */
  readonly expiresAtIso: string | null;
  /** Seconds from the cluster clock to `expiresAt` (0 once passed), or null. */
  readonly secondsLeft: bigint | null;
  /** One plain-English line for the UI. */
  readonly plain: string;
}

function checkFreezePlan(launch: PublicKey, plan: FreezePlan): void {
  if (plan === null || typeof plan !== "object" || plan.kind !== 2) throw new TypeError("plan must come from planFreeze");
  if (!plan.launch.equals(launch)) throw new Error("this plan is for another launch");
  if (!autopilotAddress(launch).equals(plan.autopilot) || !bytesEqual(freezePayload(plan.autopilot, plan.graphHash, plan.notAfter), plan.payloadHash)) {
    throw new Error("this plan's approval does not match its graph and expiry (a modified plan?)");
  }
}

/**
 * Where `plan` stands on live accounts (the cluster clock for time): no
 * autopilot, frozen (done: the planned graph is locked), superseded (the
 * running graph changed, the autopilot was frozen on another graph, or a
 * newer activation was used after the approval: plan again), expired (the
 * cluster clock is past `notAfter`: plan a new freeze and approve it again),
 * the approval missing (or only a burned leaf at its address), or approved
 * and ready to freeze.
 */
export async function getFreezeStatus(conn: Connection, launch: PublicKey, plan: FreezePlan): Promise<FreezeStatus> {
  checkFreezePlan(launch, plan);
  const now = await clusterUnixTime(conn);
  const left = plan.notAfter > now ? plan.notAfter - now : 0n;
  const live = { expiresAt: plan.notAfter, expiresAtIso: unixToIso(plan.notAfter), secondsLeft: left };
  const over = { expiresAt: null, expiresAtIso: null, secondsLeft: null };
  const until = unixToUtcText(plan.notAfter);
  const ap = await fetchAutopilot(conn, launch);
  if (ap === null) return { stage: "no-autopilot", next: "none", ...over, plain: "Automation isn't set up for this launch, so there is nothing to lock." };
  if (ap.frozen) {
    if (bytesEqual(ap.activeGraph, plan.graphHash)) return { stage: "frozen", next: "done", ...over, plain: "Locked for good: the running plan can never change again." };
    return { stage: "superseded", next: "none", ...over, plain: "Automation for this launch was already locked with a different plan running, so this freeze isn't needed." };
  }
  if (!ap.hasActiveGraph || !bytesEqual(ap.activeGraph, plan.graphHash)) {
    return { stage: "superseded", next: "none", ...over, plain: "The running plan changed since this freeze was planned, so this approval can't lock it. Plan the freeze again." };
  }
  if (now > plan.notAfter) {
    return {
      stage: "expired",
      next: "none",
      ...live,
      plain: `This freeze approval expired at ${until} (an approval to lock automation only works for a limited time). Plan the freeze again and approve the new plan.`,
    };
  }
  const auth = await fetchAuthorization(conn, launch, 2, plan.payloadHash);
  if (auth === null) {
    return {
      stage: "awaiting-authorization",
      next: "authorize",
      ...live,
      plain: `Next, approve locking automation with your launch's quantum key. This plan can be used for ${inWords(left)}, until ${until}.`,
    };
  }
  if (!auth.authorized) {
    return {
      stage: "authorization-burned",
      next: "authorize",
      ...live,
      plain: "An approval was sent for this freeze but didn't count (it wasn't signed by this launch's quantum key). Approve it again with the right key.",
    };
  }
  const marks = ap.authMarks.map((m) => ({ slot: m.slot, key: m.key.toBytes() })) as unknown as readonly [AuthMark, AuthMark, AuthMark];
  if (checkFresh({ slot: auth.slot, key: plan.authorization.toBytes() }, marks, 2) !== null) {
    return {
      stage: "superseded",
      next: "none",
      ...over,
      plain: "A newer change was scheduled after this approval was signed, so it can't lock automation any more. Plan the freeze again if you still want it.",
    };
  }
  return { stage: "ready-to-freeze", next: "freeze", ...live, plain: `Approved. Next, lock it (anyone can send this step). The approval expires in ${inWords(left)}, at ${until}.` };
}

/** `buildNextFreezeTx` options (`payer` pays the freeze, `throwaway` the approval). */
export interface NextFreezeOptions extends NextGraphActivationOptions {
  /**
   * Seconds kept for a step to land before `notAfter`: the approval is not
   * signed (default 60) and the freeze not built (default 0) with less left.
   */
  readonly landingMarginSecs?: bigint | undefined;
}

/** The next transaction of a planned freeze, with the status it was built from. */
export type NextFreezeTx =
  | { readonly step: "authorize"; readonly status: FreezeStatus; readonly result: PqAuthorizeTx }
  | { readonly step: "freeze"; readonly status: FreezeStatus; readonly result: Transaction };

/**
 * Build what `plan` needs next (`getFreezeStatus`): the approval
 * (`buildPqAuthorizeTx`, kind 2, with `identity`, `ledger`, `throwaway` as
 * its fee payer and the plan's `notAfter`), then `freeze(notAfter)` from
 * `payer`. Neither is built when too little time is left before `notAfter`
 * (a plain error: plan the freeze again). Null once frozen, or when the plan
 * can't go further (expired, superseded, no autopilot): `getFreezeStatus`
 * says which.
 */
export async function buildNextFreezeTx(conn: Connection, launch: PublicKey, plan: FreezePlan, opts: NextFreezeOptions): Promise<NextFreezeTx | null> {
  const status = await getFreezeStatus(conn, launch, plan);
  const cb: ComputeBudgetOptions = { computeUnitPrice: opts.computeUnitPrice, computeUnitLimit: opts.computeUnitLimit };
  switch (status.next) {
    case "authorize": {
      if (opts.identity === undefined || opts.ledger === undefined) throw new TypeError("approving the freeze needs the launch's identity and its leaf ledger: pass identity and ledger");
      const result = await buildPqAuthorizeTx(conn, {
        launch,
        creator: opts.creator ?? opts.payer,
        identity: opts.identity,
        ledger: opts.ledger,
        kind: 2,
        payloadHash: plan.payloadHash,
        freezeNotAfter: plan.notAfter,
        freezeLandingMarginSecs: opts.landingMarginSecs,
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
    case "freeze":
      return { step: "freeze", status, result: await buildFreezeTx(conn, opts.payer, launch, { ...cb, notAfter: plan.notAfter, landingMarginSecs: opts.landingMarginSecs }) };
    default:
      return null;
  }
}

/**
 * Guards around one launch's post-quantum signatures (audit 4, ID-F2 and
 * ID-F4), shared by `buildAttestLaunchTx` and `buildPqAuthorizeTx`.
 *
 * # One signer at a time per launch (ID-F4)
 *
 * "Is an earlier signature still pending? Reserve a leaf. Sign." is a
 * check-then-act sequence: two calls racing (a double click, two tabs, a
 * retry loop) could both pass the check and both sign. Each builder runs the
 * whole sequence inside a lock named after the launch
 * (`signingLockName(launch)`): by default an in-process mutex (one tab, one
 * Node process); in a browser pass `signingLock: (name, fn) =>
 * navigator.locks.request(name, fn)` so every tab shares it.
 *
 * # A cap on signatures that never landed (ID-F2)
 *
 * Every signature that never landed with success can still be landed by
 * whoever holds it (a relayer that dropped it, a lost tab). A ledger makes at
 * most `MAX_UNLANDED_SIGNATURES` (3) such signatures per launch for
 * attestations, and per (launch, kind) for `pq_authorize`, before it refuses
 * a new one (`SignatureCapError`) unless the caller passes
 * `acknowledgeExtraSignatures: true` after the user confirmed. Counted: every
 * recorded signature of that launch (and kind) that has not been seen landing
 * with success (unlanded, or landed only burning its leaf), except those
 * landed on purpose to retire them (`landOrBurnPending`). A rebuild of a
 * recorded signature makes none and is never refused.
 */
import type { PublicKey } from "@solana/web3.js";

import { PQ_IDENTITY } from "../constants.js";
import { withLegacyLock } from "./legacyNamespace.js";
import { processLock, type LedgerLock } from "./ledgerLock.js";
import type { LeafRecord } from "./leafLedger.js";

/** Most signatures of one launch (attestations), or of one (launch, kind) (`pq_authorize`), that never landed with success before a new one needs `acknowledgeExtraSignatures` (3). */
export const MAX_UNLANDED_SIGNATURES = PQ_IDENTITY.MAX_UNLANDED_SIGNATURES;

/** The default per-launch signing lock: one in-process mutex per launch (pass a cross-tab lock in a browser). */
const defaultLock: LedgerLock = processLock();

/** The name of a launch's signing lock: `"noised/pq/sign/v1/<launch base58>"`. */
export function signingLockName(launch: PublicKey): string {
  return `noised/pq/sign/v1/${launch.toBase58()}`;
}

/**
 * Run `fn` holding `launch`'s signing lock (`lock`, default an in-process mutex), taken under its name from before the
 * rename to Noised (`phalanx/pq/sign/v1/<launch>`, which earlier clients take) and then under its own. Internal.
 */
export function withSigningLock<T>(launch: PublicKey, lock: LedgerLock | undefined, fn: () => Promise<T>): Promise<T> {
  if (lock !== undefined && typeof lock !== "function") throw new TypeError("signingLock must be a function (name, fn) => Promise");
  return withLegacyLock(lock ?? defaultLock)(signingLockName(launch), fn);
}

/** Whether a record's signature counts against the cap: it holds one, and it has not landed with success (nor been retired on purpose). */
export function countsAsUnlanded(r: Pick<LeafRecord, "signature" | "status" | "attested" | "retired">): boolean {
  if (r.signature === null) return false;
  if (r.retired === true) return false;
  return !(r.status === "landed" && r.attested === true);
}

/** Nothing was signed: this ledger already made `MAX_UNLANDED_SIGNATURES` signatures for this launch (and kind) that never landed with success. */
export class SignatureCapError extends Error {
  readonly launch: PublicKey;
  /** `"attestation"`, or the `pq_authorize` kind (1 activate, 2 freeze, 3 remove the operator). */
  readonly what: "attestation" | 1 | 2 | 3;
  /** Signatures counted (their leaves). */
  readonly leaves: number[];
  readonly count: number;
  readonly max: number;
  constructor(launch: PublicKey, what: "attestation" | 1 | 2 | 3, leaves: number[], max: number) {
    const name = what === "attestation" ? "launch signatures" : what === 1 ? "plan approvals" : what === 2 ? "lock approvals" : "operator-removal approvals";
    super(
      `Nothing was signed: ${leaves.length} earlier ${name} for this launch were signed but never landed with success, and each one can still be landed by whoever holds it. Land them, or wait for them to expire, before signing another; to sign one more anyway, confirm it (acknowledgeExtraSignatures).`,
    );
    this.name = "SignatureCapError";
    this.launch = launch;
    this.what = what;
    this.leaves = leaves;
    this.count = leaves.length;
    this.max = max;
  }
}

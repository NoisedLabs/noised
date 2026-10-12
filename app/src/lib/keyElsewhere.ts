/**
 * "This quantum key was used on another device or app" (SDK 0.9.0
 * `UnknownLeavesError`, audit 4 ID-F1): what the app checks before it lets the
 * person confirm that nothing unsent is left elsewhere.
 *
 * The SDK refused because the key's record on Solana (its leaf bitmap) shows
 * one-time signatures this browser's records never made. The safe answer is to
 * import the other device's records. Confirming instead tells the ledger to
 * treat those signatures as spent, so it is offered ONLY when:
 *   - the count is small (`UNKNOWN_LEAVES_CONFIRM_MAX`, 3): a network
 *     connection that lies about the record would show many, and confirming
 *     those would steer the key to the one slot an attacker left free;
 *   - the record was read again just now and, when the build lists a second
 *     RPC, that second connection shows exactly the same record;
 *   - the person typed the confirmation (`CONFIRM_PHRASE`), seeing the count;
 * and the SDK itself refuses unless the count it finds then is the one shown
 * (`acknowledgeUnknownLeaves` with `expectedCount`).
 */
import type { Connection } from "@solana/web3.js";

import { acknowledgeUnknownLeaves, fetchIdentityLeaves, PQ_IDENTITY, pqIdentity, type LeafLedger } from "./noised";
import { confirmable, UNKNOWN_LEAVES_CONFIRM_MAX } from "./signErrors";

/** Leaves `used` shows that `ledger` never signed at: no record, or a reservation that never signed (the SDK's rule). */
export async function unknownLeaves(ledger: LeafLedger, identityId: Uint8Array, used: Uint8Array): Promise<number[]> {
  const known = new Set(await ledger.leaves(identityId));
  const out: number[] = [];
  for (let q = 0; q < PQ_IDENTITY.LEAVES; q++) {
    if (!pqIdentity.leafUsed(used, q)) continue;
    if (!known.has(q)) {
      out.push(q);
      continue;
    }
    let rec: Awaited<ReturnType<LeafLedger["get"]>>;
    try {
      rec = await ledger.get(identityId, q);
    } catch {
      continue; // unreadable: taken, never free
    }
    if (rec === null || (rec.status === "reserved" && rec.signature === null)) out.push(q);
  }
  return out;
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** What a fresh read of the key's record says. */
export interface UnknownRecheck {
  /** Signatures on Solana this browser's records do not know, read just now. */
  count: number;
  /** The record (leaf bitmap) read just now, on the selected connection: what a confirmation covers. */
  used: Uint8Array;
  /** The second connection's read: true = the same record, false = a different one, null = no second connection. */
  secondAgrees: boolean | null;
  /** Whether the person may confirm now. */
  canConfirm: boolean;
  /** Why not, in plain words (null when they may, or when there is nothing left to confirm). */
  why: string | null;
}

/** Read the key's record again (and on the second connection, when there is one) and decide whether a confirmation may be offered. */
export async function recheckUnknown(args: {
  conn: Connection;
  second: Connection | null;
  ledger: LeafLedger;
  identityId: Uint8Array;
  /** How a connection reads the record (default: the backend's `fetchIdentityLeaves`; tests pass their own). */
  read?: (conn: Connection, identityId: Uint8Array) => Promise<Uint8Array>;
}): Promise<UnknownRecheck> {
  const read = args.read ?? fetchIdentityLeaves;
  const [used, other] = await Promise.all([read(args.conn, args.identityId), args.second === null ? Promise.resolve(null) : read(args.second, args.identityId)]);
  const count = (await unknownLeaves(args.ledger, args.identityId, used)).length;
  const secondAgrees = other === null ? null : sameBytes(used, other);
  if (count === 0) return { count, used, secondAgrees, canConfirm: false, why: null };
  if (secondAgrees === false) {
    return {
      count,
      used,
      secondAgrees,
      canConfirm: false,
      why: "The two network connections show different records for this key, so one of them is wrong. Don't confirm anything: import the other device's records instead.",
    };
  }
  if (!confirmable(count)) {
    return {
      count,
      used,
      secondAgrees,
      canConfirm: false,
      why: `That is more than ${UNKNOWN_LEAVES_CONFIRM_MAX} signatures, so it can't be confirmed here. Import the other device's records, or use a new quantum key.`,
    };
  }
  return { count, used, secondAgrees, canConfirm: true, why: null };
}

/**
 * Record the confirmed signatures as spent (the SDK's `acknowledgeUnknownLeaves`): it refuses unless the count it finds
 * in `used` is exactly `count`, the one the person confirmed. Only ever called for a confirmable count.
 */
export async function confirmUnknown(ledger: LeafLedger, lmsPublicKey: Uint8Array, used: Uint8Array, count: number): Promise<number> {
  if (!confirmable(count)) throw new Error(`More than ${UNKNOWN_LEAVES_CONFIRM_MAX} signatures can't be confirmed here.`);
  const done = await acknowledgeUnknownLeaves(ledger, lmsPublicKey, used, { expectedCount: count });
  return done.added.length + done.burned.length;
}

/**
 * The PHX-PQV4 withdraw message (vault v4, SPEC §3): the exact 185 bytes a
 * vault key signs, byte-identical to programs/noised-vault/src/message.rs.
 * Shared by the vault client (`./vault.ts`, which re-exports it) and the
 * vault-key ledger (`./vaultLedger.ts`, which authenticates imported records
 * with it).
 */
import { PublicKey } from "@solana/web3.js";

import { bytesEqual, concatBytes, isU64, u64le, utf8 } from "../codec/bytes.js";
import { PROGRAM_IDS, VAULT } from "../constants.js";

const TAG = utf8(VAULT.MESSAGE_TAG);

/**
 * The exact 185 bytes a vault key signs to authorize a withdrawal:
 * `"PHX-PQV4" | 0x01 | program_id | vault | mint | sequence u64 LE |
 * destination_owner | max_amount u64 LE | next_key_id`.
 * `sequence` is the vault's sequence before this withdrawal;
 * `destinationOwner` is a wallet: `release` pays its canonical ATA.
 */
export function withdrawMessage(
  vault: PublicKey,
  mint: PublicKey,
  sequence: bigint,
  destinationOwner: PublicKey,
  maxAmount: bigint,
  nextKeyId: Uint8Array,
): Uint8Array {
  if (!isU64(sequence)) throw new RangeError("sequence must be a u64");
  if (!isU64(maxAmount)) throw new RangeError("maxAmount must be a u64");
  if (!(nextKeyId instanceof Uint8Array) || nextKeyId.length !== 32) throw new RangeError("next key id must be 32 bytes");
  const msg = concatBytes([
    TAG,
    Uint8Array.of(VAULT.OP_WITHDRAW),
    PROGRAM_IDS.vault.toBytes(),
    vault.toBytes(),
    mint.toBytes(),
    u64le(sequence),
    destinationOwner.toBytes(),
    u64le(maxAmount),
    nextKeyId,
  ]);
  if (msg.length !== VAULT.WITHDRAW_MESSAGE_LEN) throw new Error("withdraw message length mismatch");
  return msg;
}

/** Labelled byte ranges of a withdraw message, for display. */
export const WITHDRAW_MESSAGE_FIELDS: readonly { readonly name: string; readonly start: number; readonly end: number }[] = [
  { name: `Tag "${VAULT.MESSAGE_TAG}"`, start: 0, end: 8 },
  { name: "Operation (1 = withdraw)", start: 8, end: 9 },
  { name: "Vault program id", start: 9, end: 41 },
  { name: "Vault", start: 41, end: 73 },
  { name: "Mint", start: 73, end: 105 },
  { name: "Sequence (u64 LE)", start: 105, end: 113 },
  { name: "Recipient wallet (destination owner)", start: 113, end: 145 },
  { name: "Max amount (u64 LE)", start: 145, end: 153 },
  { name: "Next key id", start: 153, end: 185 },
];

export interface ParsedWithdrawMessage {
  programId: PublicKey;
  vault: PublicKey;
  mint: PublicKey;
  sequence: bigint;
  destinationOwner: PublicKey;
  maxAmount: bigint;
  nextKeyId: Uint8Array;
}

/** Parse and validate a withdraw message (length, tag, op, program id). */
export function parseWithdrawMessage(msg: Uint8Array): ParsedWithdrawMessage {
  if (!(msg instanceof Uint8Array) || msg.length !== VAULT.WITHDRAW_MESSAGE_LEN) throw new Error(`not a ${VAULT.WITHDRAW_MESSAGE_LEN}-byte withdraw message`);
  if (!bytesEqual(msg.subarray(0, 8), TAG) || msg[8] !== VAULT.OP_WITHDRAW) throw new Error(`not a ${VAULT.MESSAGE_TAG} withdraw message`);
  const programId = new PublicKey(msg.subarray(9, 41));
  if (!programId.equals(PROGRAM_IDS.vault)) throw new Error("withdraw message names another program");
  const view = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  return {
    programId,
    vault: new PublicKey(msg.subarray(41, 73)),
    mint: new PublicKey(msg.subarray(73, 105)),
    sequence: view.getBigUint64(105, true),
    destinationOwner: new PublicKey(msg.subarray(113, 145)),
    maxAmount: view.getBigUint64(145, true),
    nextKeyId: msg.slice(153, 185),
  };
}

/**
 * Test support for the attest, publish and launch-flow tests: an in-memory
 * connection that also answers rent, sends and confirmations
 * (`AttestConnection`), and independent models of the launchpad's
 * instructions that land a sent v1 transaction on the mocked accounts:
 *
 * - `emulatePublishMetadata` (programs/noised-launchpad/src/instructions/
 *   publish_metadata.rs, policy.rs `validate_metadata`): the strings decoded
 *   as UTF-8, the launch Configured, the rules in the program's order, the
 *   record at the PDA of its content hash (ConstraintSeeds otherwise),
 *   idempotent, a pre-funded address taken over, the account bytes written
 *   from the documented layout;
 * - `emulateAttestLaunch` (attest_launch.rs, message v3): payer signature,
 *   fee and rent (the payer must end at zero or rent-exempt), the record
 *   account exactly the PDA of the signed hash and the rules account exactly
 *   the PDA of the signed rules hash, or the program id for the zero hash
 *   (ConstraintSeeds before anything else), identity PDA of the key sent,
 *   LMS verification, the leaf bitmap (PqLeafUsed), and the attestation
 *   written only when its slot is free (empty, or another message's whose
 *   window passed while the launch is Configured: audit round 3 F1, every
 *   field overwritten), the key is the launch's identity, the metadata
 *   record and (for a non-zero rules hash) the rules record exist and the
 *   window has at least 60 s left at the clock;
 * - `emulatePublishRules` (publish_rules.rs): the launch Configured, the
 *   record at the PDA of its content hash, idempotent, a pre-funded address
 *   taken over (the bytes' verification is the SDK's `verifyRules`);
 * - `emulatePqAuthorize` (pq_authorize.rs): the 140-byte message, the leaf
 *   bitmap shared with attestations, the authorization written once and
 *   only by the launch's identity (any other landing only burns its leaf).
 *
 * Neither model uses the SDK's metadata or window code: the rules, hashes
 * and layouts are written here again from the program's sources (and
 * AUDIT3_FIXES.md F1 for the attestation slot and the window).
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { PublicKey, SystemProgram } from "@solana/web3.js";

import { encodeBase58 } from "../src/codec/base58.js";
import { BorshReader } from "../src/codec/borsh.js";
import { bytesEqual, concatBytes, u32le } from "../src/codec/bytes.js";
import { camelCase } from "../src/codec/idl.js";
import { PQ_IDENTITY, PROGRAM_IDS } from "../src/constants.js";
import { idlCodecs } from "../src/idl/index.js";
import { decodeAttestation, decodeIdentity, decodeLaunch } from "../src/launch/accounts.js";
import { attestationAddress, identityAddress } from "../src/pda.js";
import { attestationMessage } from "../src/pq/identity.js";
import { lmsVerify } from "../src/pq/lms.js";
import { decodeV1Transaction, verifyV1Signatures } from "../src/tx/v1.js";
import { MockConnection, type MockAccount } from "./helpers.js";
import { accountBytes, clock } from "./world.js";

export const SYSVAR_CLOCK = new PublicKey("SysvarC1ock11111111111111111111111111111111");
const SYSVAR_OWNER = new PublicKey("Sysvar1111111111111111111111111111111111111");
const enc = new TextEncoder();
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A launchpad error the emulator raises (the transaction fails, nothing changes). */
export class ProgramError extends Error {
  constructor(
    readonly code: number,
    name: string,
  ) {
    super(name);
  }
}

export class AttestConnection extends MockConnection {
  /** Rent: (128 + size) * this * 2 (3,480 = the default rent, 2,540 = mainnet's 5,080 lamports per byte). */
  rentPerByteYear = 3_480;
  /** Accounts that exist at `confirmed` but not yet at `finalized`. */
  readonly hiddenAtFinalized = new Set<string>();
  /** Every transaction sent (wire bytes). */
  readonly sent: Uint8Array[] = [];
  /** Lands a sent transaction; a thrown `ProgramError` fails it. */
  land: ((wire: Uint8Array) => void) | null = null;
  /** Drop every send (the RPC refuses it, nothing lands). */
  dropSends = false;
  /** What a lagging RPC node answers for an address instead of its current account (null: nothing). */
  readonly staleReads = new Map<string, MockAccount | null>();
  private lastErr: unknown = null;

  override async getAccountInfo(address: PublicKey, commitment?: unknown): ReturnType<MockConnection["getAccountInfo"]> {
    if (commitment === "finalized" && this.hiddenAtFinalized.has(address.toBase58())) return null;
    const stale = this.staleReads.get(address.toBase58());
    if (stale !== undefined) {
      const real = this.get(address);
      if (stale === null) this.delete(address);
      else this.set(address, stale);
      try {
        return await super.getAccountInfo(address);
      } finally {
        if (real === undefined) this.delete(address);
        else this.set(address, real);
      }
    }
    return super.getAccountInfo(address);
  }

  override async getMinimumBalanceForRentExemption(size: number): Promise<number> {
    return (128 + size) * this.rentPerByteYear * 2;
  }

  setClock(unix: bigint | number): this {
    return this.set(SYSVAR_CLOCK, { owner: SYSVAR_OWNER, data: clock(Number(unix)) });
  }

  clockNow(): bigint {
    const c = this.get(SYSVAR_CLOCK)!;
    return new DataView(c.data.buffer, c.data.byteOffset, c.data.byteLength).getBigInt64(32, true);
  }

  async sendRawTransaction(raw: Uint8Array): Promise<string> {
    this.sent.push(Uint8Array.from(raw));
    if (this.dropSends) throw new Error("Blockhash not found");
    const d = decodeV1Transaction(raw);
    this.lastErr = null;
    try {
      this.land?.(raw);
    } catch (e) {
      if (!(e instanceof ProgramError)) throw e;
      this.lastErr = { InstructionError: [0, { Custom: e.code }] };
    }
    return encodeBase58(d.signatures[0]!);
  }

  async confirmTransaction(): Promise<{ context: { slot: number }; value: { err: unknown } }> {
    return { context: { slot: this.slot }, value: { err: this.lastErr } };
  }

  async getBlockHeight(): Promise<number> {
    return 100;
  }
}

/** The launchpad's `Identity` account bytes (196). */
export function identityAccountBytes(lmsPublicKey: Uint8Array, used: Uint8Array, bump = 255): Uint8Array {
  let count = 0;
  for (const b of used) for (let x = b; x !== 0; x &= x - 1) count++;
  return accountBytes("launchpad", "Identity", { version: 1, bump, publicKey: lmsPublicKey, used, usedCount: count });
}

export interface AttestationFields {
  version: number;
  bump: number;
  launch: PublicKey;
  pqIdentity: Uint8Array;
  leaf: number;
  metadataHash: Uint8Array;
  /** Attestation v3 (P1c); default all zero. */
  rulesHash?: Uint8Array;
  messageHash: Uint8Array;
  slot: bigint;
  notBefore: bigint;
  notAfter: bigint;
  signature: Uint8Array;
}

/** The launchpad's `Attestation` account bytes (v3), zero-padded to 2,708 like the program allocates. */
export function attestationAccountBytes(f: AttestationFields): Uint8Array {
  const b = accountBytes("launchpad", "Attestation", { ...f, rulesHash: f.rulesHash ?? new Uint8Array(32) });
  return concatBytes([b, new Uint8Array(PQ_IDENTITY.ATTESTATION_ACCOUNT_LEN - b.length)]);
}

/** A leaf bitmap with `leaves` set. */
export function bitmapOf(leaves: Iterable<number>): Uint8Array {
  const used = new Uint8Array(PQ_IDENTITY.LEAF_BITMAP_LEN);
  for (const q of leaves) used[q >> 3]! |= 1 << (q & 7);
  return used;
}

// ------------------------------------------------- the record, again ---

/** `TokenMeta`'s discriminator: sha256("account:TokenMeta")[..8]. */
export const TOKEN_META_DISCRIMINATOR = sha256(enc.encode("account:TokenMeta")).slice(0, 8);

/** `pq::metadata_hash_v2`, written again from pq.rs. */
export function emulatedMetadataHash(name: Uint8Array, symbol: Uint8Array, flags: number, uri: Uint8Array, doc: Uint8Array): Uint8Array {
  const len = (b: Uint8Array): Uint8Array => u32le(b.length);
  return sha256(concatBytes([enc.encode("PHX-META-V2"), len(name), name, len(symbol), symbol, Uint8Array.of(flags), len(uri), uri, len(doc), doc]));
}

/** `["metadata", launch, hash]` and its canonical bump. */
function recordPda(launch: PublicKey, hash: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([enc.encode("metadata"), launch.toBytes(), hash], PROGRAM_IDS.launchpad);
}

/** The bytes `publish_metadata` writes (state.rs `TokenMeta`, borsh, written again here). */
export function emulatedTokenMetaBytes(launch: PublicKey, name: Uint8Array, symbol: Uint8Array, flags: number, uri: Uint8Array, doc: Uint8Array): Uint8Array {
  const hash = emulatedMetadataHash(name, symbol, flags, uri, doc);
  const [, bump] = recordPda(launch, hash);
  const s = (b: Uint8Array): Uint8Array[] => [u32le(b.length), b];
  return concatBytes([TOKEN_META_DISCRIMINATOR, Uint8Array.of(1, bump, flags), launch.toBytes(), hash, ...s(name), ...s(symbol), ...s(uri), ...s(doc)]);
}

/** `policy::validate_metadata`, in the program's order: the error number of the first failing rule, or null. */
export function emulatedMetadataError(name: Uint8Array, symbol: Uint8Array, flags: number, uri: Uint8Array, doc: Uint8Array): number | null {
  if (![0, 1, 2].includes(flags)) return 6045;
  if (doc.length > 3_072 || uri.length > 200) return 6046;
  if (name.length < 1 || name.length > 32 || symbol.length < 1 || symbol.length > 10) return 6016;
  if (flags === 2) {
    const prefix = enc.encode("https://");
    const ok = uri.length >= 9 && uri.length <= 200 && prefix.every((b, i) => uri[i] === b) && uri.every((b) => b >= 0x21 && b <= 0x7e);
    if (!ok) return 6016;
  } else if (uri.length > 0) return 6045;
  if (flags === 1 && doc.length === 0) return 6045;
  return null;
}

/** Whether `info` at `address` is the record of (launch, hash): `pq::is_metadata_record` plus the address. */
function isRecord(conn: AttestConnection, address: PublicKey, launch: PublicKey, hash: Uint8Array): boolean {
  const [pda, bump] = recordPda(launch, hash);
  const a = conn.get(address);
  if (!pda.equals(address) || a === undefined || !a.owner.equals(PROGRAM_IDS.launchpad)) return false;
  const d = a.data;
  return (
    d.length >= 91 &&
    bytesEqual(d.subarray(0, 8), TOKEN_META_DISCRIMINATOR) &&
    d[8] === 1 &&
    d[9] === bump &&
    bytesEqual(d.subarray(11, 43), launch.toBytes()) &&
    bytesEqual(d.subarray(43, 75), hash)
  );
}

// ------------------------------------------------------------ emulators ---

/** The arguments of an `attest_launch` instruction (IDL-decoded). */
export function decodeAttestArgs(data: Uint8Array): { lmsPk: Uint8Array; lmsSig: Uint8Array; metadataHash: Uint8Array; rulesHash: Uint8Array; notBefore: bigint; notAfter: bigint } {
  const def = idlCodecs().launchpad.instruction("attest_launch");
  if (!bytesEqual(data.subarray(0, 8), Uint8Array.from(def.discriminator))) throw new Error("not attest_launch");
  const codec = idlCodecs().launchpad;
  const r = new BorshReader(data.subarray(8));
  const out: Record<string, unknown> = {};
  for (const a of def.args) out[camelCase(a.name)] = codec.decode(a.type, r);
  if (r.remaining !== 0) throw new Error("trailing instruction data");
  return out as ReturnType<typeof decodeAttestArgs>;
}

/** The raw strings and flags of `publish_metadata` data (no UTF-8 check). */
export function decodePublishArgs(data: Uint8Array): { name: Uint8Array; symbol: Uint8Array; flags: number; uri: Uint8Array; doc: Uint8Array } {
  const def = idlCodecs().launchpad.instruction("publish_metadata");
  if (!bytesEqual(data.subarray(0, 8), Uint8Array.from(def.discriminator))) throw new Error("not publish_metadata");
  const r = new BorshReader(data.subarray(8));
  const name = r.bytes();
  const symbol = r.bytes();
  const flags = r.u8();
  const uri = r.bytes();
  const doc = r.bytes();
  if (r.remaining !== 0) throw new Error("trailing instruction data");
  return { name, symbol, flags, uri, doc };
}

/** `pq::launch_window_is_valid` with audit round 3 F1, written again: 60..=3,600 s, `max(now, nb) + 60 <= na`, opening within 7 days. */
export function emulatedWindowIsValid(now: bigint, nb: bigint, na: bigint): boolean {
  const start = now > nb ? now : nb;
  return na - nb >= 60n && na - nb <= 3_600n && start + 60n <= na && nb <= now + 604_800n;
}

function rentOf(conn: AttestConnection, size: number): bigint {
  return BigInt((128 + size) * conn.rentPerByteYear * 2);
}

/** Debit `spend` from the fee payer: it must hold it and end at zero or rent-exempt. */
function pay(conn: AttestConnection, payer: PublicKey, spend: bigint): bigint {
  const balance = BigInt(conn.get(payer)?.lamports ?? 0);
  if (balance < spend) throw new ProgramError(1, "insufficient funds");
  const left = balance - spend;
  if (left !== 0n && left < rentOf(conn, 0)) throw new ProgramError(1, "InsufficientFundsForRent");
  return left;
}

function oneLaunchpadInstruction(wire: Uint8Array): { d: ReturnType<typeof decodeV1Transaction>; keys: PublicKey[]; data: Uint8Array } {
  const d = decodeV1Transaction(wire);
  if (!verifyV1Signatures(d)) throw new ProgramError(1, "signature verification failed");
  if (d.instructions.length !== 1) throw new ProgramError(1, "one instruction expected");
  const ins = d.instructions[0]!;
  if (!d.accountKeys[ins.programIdIndex]!.equals(PROGRAM_IDS.launchpad)) throw new ProgramError(1, "not the launchpad");
  return { d, keys: ins.accounts.map((i) => d.accountKeys[i]!), data: ins.data };
}

/**
 * Land a `publish_metadata` transaction as the program would: throws
 * `ProgramError` (102 for text that is not UTF-8, 3012 without a launch,
 * 6018 for a live launch, the record's rule errors, 2006 for another
 * address, 1 for funds) and changes nothing on failure.
 */
export function emulatePublishMetadata(conn: AttestConnection, wire: Uint8Array): void {
  const { d, keys, data } = oneLaunchpadInstruction(wire);
  const [payer, launch, tokenMeta, system] = keys;
  if (keys.length !== 4 || !system!.equals(SystemProgram.programId) || !payer!.equals(d.accountKeys[0]!)) throw new ProgramError(1, "accounts");
  const a = decodePublishArgs(data);
  for (const b of [a.name, a.symbol, a.uri, a.doc]) {
    try {
      strictUtf8.decode(b);
    } catch {
      throw new ProgramError(102, "InstructionDidNotDeserialize");
    }
  }
  const launchAcc = conn.get(launch!);
  if (launchAcc === undefined || !launchAcc.owner.equals(PROGRAM_IDS.launchpad)) throw new ProgramError(3012, "AccountNotInitialized");
  if (decodeLaunch(launch!, launchAcc.data).status !== "configured") throw new ProgramError(6018, "WrongLaunchState");
  const hash = emulatedMetadataHash(a.name, a.symbol, a.flags, a.uri, a.doc);
  const [pda] = recordPda(launch!, hash);
  if (!pda.equals(tokenMeta!)) throw new ProgramError(2006, "ConstraintSeeds");
  const err = emulatedMetadataError(a.name, a.symbol, a.flags, a.uri, a.doc);
  if (err !== null) throw new ProgramError(err, "metadata");
  const fee = 5_000n * BigInt(d.header.numRequiredSignatures) + (d.priorityFeeLamports ?? 0n);
  const existing = conn.get(tokenMeta!);
  if (existing !== undefined && existing.owner.equals(PROGRAM_IDS.launchpad) && existing.data.length > 0) {
    // Published already: nothing is written.
    conn.set(payer!, { owner: SystemProgram.programId, data: new Uint8Array(0), lamports: Number(pay(conn, payer!, fee)) });
    return;
  }
  const bytes = emulatedTokenMetaBytes(launch!, a.name, a.symbol, a.flags, a.uri, a.doc);
  const held = BigInt(existing?.lamports ?? 0);
  const rent = rentOf(conn, bytes.length);
  const topUp = held >= rent ? 0n : rent - held;
  conn.set(payer!, { owner: SystemProgram.programId, data: new Uint8Array(0), lamports: Number(pay(conn, payer!, fee + topUp)) });
  conn.set(tokenMeta!, { owner: PROGRAM_IDS.launchpad, data: bytes, lamports: Number(held + topUp) });
}

/**
 * Land an attest transaction on `conn` as the program would, at the mocked
 * clock: throws `ProgramError` (2006 ConstraintSeeds, 6040
 * InvalidPqSignature, 6041 PqLeafUsed, 1 for funds) and changes nothing on
 * failure.
 */
/** `pq::rules_hash`, written again: SHA256("PHX-RULES-V1" || bytes). */
export function emulatedRulesHash(bytes: Uint8Array): Uint8Array {
  return sha256(concatBytes([enc.encode("PHX-RULES-V1"), bytes]));
}

/** `["rules", launch, hash]` and its canonical bump. */
export function rulesPda(launch: PublicKey, hash: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([enc.encode("rules"), launch.toBytes(), hash], PROGRAM_IDS.launchpad);
}

/** `LaunchRules`' discriminator: sha256("account:LaunchRules")[..8]. */
export const LAUNCH_RULES_DISCRIMINATOR = sha256(enc.encode("account:LaunchRules")).slice(0, 8);

/** The bytes `publish_rules` writes (state.rs `LaunchRules`, borsh, written again here): 78 + len. */
export function emulatedLaunchRulesBytes(launch: PublicKey, bytes: Uint8Array): Uint8Array {
  const hash = emulatedRulesHash(bytes);
  const [, bump] = rulesPda(launch, hash);
  return concatBytes([LAUNCH_RULES_DISCRIMINATOR, Uint8Array.of(1, bump), launch.toBytes(), hash, u32le(bytes.length), bytes]);
}

/** `pq::is_rules_record` plus the address. */
function isRulesRecord(conn: AttestConnection, address: PublicKey, launch: PublicKey, hash: Uint8Array): boolean {
  const [pda, bump] = rulesPda(launch, hash);
  const a = conn.get(address);
  if (!pda.equals(address) || a === undefined || !a.owner.equals(PROGRAM_IDS.launchpad)) return false;
  const d = a.data;
  return d.length >= 78 && bytesEqual(d.subarray(0, 8), LAUNCH_RULES_DISCRIMINATOR) && d[8] === 1 && d[9] === bump && bytesEqual(d.subarray(10, 42), launch.toBytes()) && bytesEqual(d.subarray(42, 74), hash);
}

/** The 221-byte message v3 (pq.rs `attestation_message`), written again. */
export function emulatedAttestMessage(launch: PublicKey, paramsHash: Uint8Array, creator: PublicKey, metadataHash: Uint8Array, rulesHash: Uint8Array, notBefore: bigint, notAfter: bigint): Uint8Array {
  const i64 = (v: bigint): Uint8Array => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigInt64(0, v, true);
    return b;
  };
  return concatBytes([enc.encode("PHX-ATTEST-V3"), PROGRAM_IDS.launchpad.toBytes(), launch.toBytes(), paramsHash, creator.toBytes(), metadataHash, rulesHash, i64(notBefore), i64(notAfter)]);
}

/**
 * Land a `publish_rules` transaction as the program would (publish_rules.rs):
 * 3012 without a launch, 6018 for a live launch, 6048 for bytes `verify`
 * refuses (passed in: the SDK's verifier stands for the crate's), 2006 for
 * another address; idempotent; a pre-funded address taken over.
 */
export function emulatePublishRules(conn: AttestConnection, wire: Uint8Array, verify: (bytes: Uint8Array, guardSecs: number) => boolean): void {
  const { d, keys, data } = oneLaunchpadInstruction(wire);
  const [payer, launch, rules, system] = keys;
  if (keys.length !== 4 || !system!.equals(SystemProgram.programId) || !payer!.equals(d.accountKeys[0]!)) throw new ProgramError(1, "accounts");
  const def = idlCodecs().launchpad.instruction("publish_rules");
  if (!bytesEqual(data.subarray(0, 8), Uint8Array.from(def.discriminator))) throw new ProgramError(101, "not publish_rules");
  const r = new BorshReader(data.subarray(8));
  const bytes = r.bytes();
  if (r.remaining !== 0) throw new ProgramError(102, "InstructionDidNotDeserialize");
  const launchAcc = conn.get(launch!);
  if (launchAcc === undefined || !launchAcc.owner.equals(PROGRAM_IDS.launchpad)) throw new ProgramError(3012, "AccountNotInitialized");
  const l = decodeLaunch(launch!, launchAcc.data);
  if (l.status !== "configured") throw new ProgramError(6018, "WrongLaunchState");
  const hash = emulatedRulesHash(bytes);
  if (!rulesPda(launch!, hash)[0].equals(rules!)) throw new ProgramError(2006, "ConstraintSeeds");
  if (!verify(bytes, l.guardSecs)) throw new ProgramError(6048, "InvalidRules");
  const fee = 5_000n * BigInt(d.header.numRequiredSignatures) + (d.priorityFeeLamports ?? 0n);
  const existing = conn.get(rules!);
  if (existing !== undefined && existing.owner.equals(PROGRAM_IDS.launchpad) && existing.data.length > 0) {
    conn.set(payer!, { owner: SystemProgram.programId, data: new Uint8Array(0), lamports: Number(pay(conn, payer!, fee)) });
    return;
  }
  const record = emulatedLaunchRulesBytes(launch!, bytes);
  const held = BigInt(existing?.lamports ?? 0);
  const rent = rentOf(conn, record.length);
  const topUp = held >= rent ? 0n : rent - held;
  conn.set(payer!, { owner: SystemProgram.programId, data: new Uint8Array(0), lamports: Number(pay(conn, payer!, fee + topUp)) });
  conn.set(rules!, { owner: PROGRAM_IDS.launchpad, data: record, lamports: Number(held + topUp) });
}

/** The 140-byte authorization message (pq.rs `authorization_message`), written again. */
export function emulatedAuthMessage(launch: PublicKey, creator: PublicKey, kind: number, payloadHash: Uint8Array): Uint8Array {
  return concatBytes([enc.encode("PHX-AUTH-V1"), PROGRAM_IDS.launchpad.toBytes(), launch.toBytes(), creator.toBytes(), Uint8Array.of(kind), payloadHash]);
}

/** `Authorization`'s discriminator: sha256("account:Authorization")[..8]. */
export const AUTHORIZATION_DISCRIMINATOR = sha256(enc.encode("account:Authorization")).slice(0, 8);

/**
 * Land a `pq_authorize` transaction as the program would (pq_authorize.rs):
 * ConstraintSeeds for an identity or authorization account the signed data
 * does not name, InvalidPqSignature, PqLeafUsed; then the authorization is
 * written whole (version 1, the clock's time and slot) only if it is empty
 * and the key is the launch's identity; otherwise the leaf only burns.
 */
export function emulatePqAuthorize(conn: AttestConnection, wire: Uint8Array): void {
  const { d, keys, data } = oneLaunchpadInstruction(wire);
  const [payer, launch, identityKey, authKey, system] = keys;
  if (keys.length !== 5 || !system!.equals(SystemProgram.programId) || !payer!.equals(d.accountKeys[0]!)) throw new ProgramError(1, "accounts");
  const def = idlCodecs().launchpad.instruction("pq_authorize");
  if (!bytesEqual(data.subarray(0, 8), Uint8Array.from(def.discriminator))) throw new ProgramError(101, "not pq_authorize");
  const r = new BorshReader(data.subarray(8));
  const lmsPk = r.fixed(56);
  const lmsSig = r.bytes();
  const kind = r.u8();
  const payloadHash = r.fixed(32);
  if (r.remaining !== 0) throw new ProgramError(102, "InstructionDidNotDeserialize");
  const launchAcc = conn.get(launch!);
  if (launchAcc === undefined || !launchAcc.owner.equals(PROGRAM_IDS.launchpad)) throw new ProgramError(3012, "AccountNotInitialized");
  const l = decodeLaunch(launch!, launchAcc.data);
  if (!identityAddress(lmsPk).equals(identityKey!)) throw new ProgramError(2006, "ConstraintSeeds");
  const [authPda, authBump] = PublicKey.findProgramAddressSync([enc.encode("auth"), launch!.toBytes(), Uint8Array.of(kind), payloadHash], PROGRAM_IDS.launchpad);
  if (!authPda.equals(authKey!)) throw new ProgramError(2006, "ConstraintSeeds");
  const pqIdentity = sha256(concatBytes([Uint8Array.of(0x21), lmsPk]));
  const idAcc = conn.get(identityKey!);
  const used = idAcc === undefined ? new Uint8Array(PQ_IDENTITY.LEAF_BITMAP_LEN) : Uint8Array.from(decodeIdentity(identityKey!, idAcc.data).used);
  const message = emulatedAuthMessage(launch!, l.creator, kind, payloadHash);
  const q = lmsVerify(lmsPk, message, lmsSig);
  if (q === null) throw new ProgramError(6040, "InvalidPqSignature");
  if ((used[q >> 3]! & (1 << (q & 7))) !== 0) throw new ProgramError(6041, "PqLeafUsed");
  used[q >> 3]! |= 1 << (q & 7);
  const authAcc = conn.get(authKey!);
  const fee = 5_000n * BigInt(d.header.numRequiredSignatures) + (d.priorityFeeLamports ?? 0n);
  const left = pay(conn, payer!, fee + (idAcc === undefined ? rentOf(conn, PQ_IDENTITY.IDENTITY_ACCOUNT_LEN) : 0n) + (authAcc === undefined ? rentOf(conn, 2_669) : 0n));
  conn.set(payer!, { owner: SystemProgram.programId, data: new Uint8Array(0), lamports: Number(left) });
  conn.set(identityKey!, { owner: PROGRAM_IDS.launchpad, data: identityAccountBytes(lmsPk, used) });
  const empty = authAcc === undefined || authAcc.data[8] === 0;
  const fields = (authorized: boolean): Uint8Array =>
    accountBytes("launchpad", "Authorization", {
      version: authorized ? 1 : 0,
      bump: authorized ? authBump : 0,
      launch: authorized ? launch! : PublicKey.default,
      pqIdentity: authorized ? pqIdentity : new Uint8Array(32),
      kind: authorized ? kind : 0,
      payloadHash: authorized ? payloadHash : new Uint8Array(32),
      messageHash: authorized ? sha256(message) : new Uint8Array(32),
      unixTime: authorized ? conn.clockNow() : 0n,
      slot: authorized ? BigInt(conn.slot) : 0n,
      leaf: authorized ? q : 0,
      signature: authorized ? lmsSig : new Uint8Array(0),
    });
  if (empty && bytesEqual(pqIdentity, l.pqIdentity)) {
    conn.set(authKey!, { owner: PROGRAM_IDS.launchpad, data: fields(true) });
  } else if (authAcc === undefined) {
    const b = fields(false);
    conn.set(authKey!, { owner: PROGRAM_IDS.launchpad, data: concatBytes([b, new Uint8Array(2_669 - b.length)]) });
  }
}

export function emulateAttestLaunch(conn: AttestConnection, wire: Uint8Array): void {
  const { d, keys, data } = oneLaunchpadInstruction(wire);
  const [payer, launch, identityKey, attestationKey, tokenMeta, system, rulesKey] = keys;
  if (keys.length !== 7 || !system!.equals(SystemProgram.programId) || !payer!.equals(d.accountKeys[0]!)) throw new ProgramError(1, "accounts");
  const a = decodeAttestArgs(data);

  const launchAcc = conn.get(launch!);
  if (launchAcc === undefined || !launchAcc.owner.equals(PROGRAM_IDS.launchpad)) throw new ProgramError(3012, "AccountNotInitialized");
  const l = decodeLaunch(launch!, launchAcc.data);
  if (!identityAddress(a.lmsPk).equals(identityKey!)) throw new ProgramError(2006, "ConstraintSeeds");
  if (!attestationAddress(launch!).equals(attestationKey!)) throw new ProgramError(2006, "ConstraintSeeds");
  // The record account must be the address of the signed hash, whatever is there (checked before the signature).
  const [record] = recordPda(launch!, a.metadataHash);
  if (!record.equals(tokenMeta!)) throw new ProgramError(2006, "ConstraintSeeds");
  // The rules account: the record of the signed rules hash, or the program id for the zero hash.
  const noRules = a.rulesHash.every((b) => b === 0);
  const rulesWant = noRules ? PROGRAM_IDS.launchpad : rulesPda(launch!, a.rulesHash)[0];
  if (!rulesWant.equals(rulesKey!)) throw new ProgramError(2006, "ConstraintSeeds");

  const pqIdentity = sha256(concatBytes([Uint8Array.of(0x21), a.lmsPk]));
  const idAcc = conn.get(identityKey!);
  const used = idAcc === undefined ? new Uint8Array(PQ_IDENTITY.LEAF_BITMAP_LEN) : Uint8Array.from(decodeIdentity(identityKey!, idAcc.data).used);
  const message = emulatedAttestMessage(launch!, l.paramsHash, l.creator, a.metadataHash, a.rulesHash, a.notBefore, a.notAfter);
  if (message.length !== 221) throw new Error("message v3 is 221 bytes");
  if (!bytesEqual(message, attestationMessage({ launch: launch!, paramsHash: l.paramsHash, creator: l.creator, metadataHash: a.metadataHash, rulesHash: a.rulesHash, notBefore: a.notBefore, notAfter: a.notAfter }))) {
    throw new Error("the SDK's attestationMessage differs from the model's");
  }
  const q = lmsVerify(a.lmsPk, message, a.lmsSig);
  if (q === null) throw new ProgramError(6040, "InvalidPqSignature");
  if ((used[q >> 3]! & (1 << (q & 7))) !== 0) throw new ProgramError(6041, "PqLeafUsed");
  used[q >> 3]! |= 1 << (q & 7);

  // Fee and rent: the payer must end at zero or rent-exempt.
  const attAcc = conn.get(attestationKey!);
  const fee = 5_000n * BigInt(d.header.numRequiredSignatures) + (d.priorityFeeLamports ?? 0n);
  const left = pay(conn, payer!, fee + (idAcc === undefined ? rentOf(conn, PQ_IDENTITY.IDENTITY_ACCOUNT_LEN) : 0n) + (attAcc === undefined ? rentOf(conn, PQ_IDENTITY.ATTESTATION_ACCOUNT_LEN) : 0n));

  const now = conn.clockNow();
  const att = attAcc === undefined ? null : decodeAttestation(attestationKey!, attAcc.data);
  // F1: the slot is free when empty, or when its window passed unused while the launch is still Configured.
  const slotFree = att === null || att.launch.equals(PublicKey.default) || (l.status === "configured" && now > att.notAfter);
  const attests =
    slotFree &&
    bytesEqual(pqIdentity, l.pqIdentity) &&
    emulatedWindowIsValid(now, a.notBefore, a.notAfter) && // the program judges any i64 clock
    isRecord(conn, tokenMeta!, launch!, a.metadataHash) &&
    (noRules || isRulesRecord(conn, rulesKey!, launch!, a.rulesHash));
  const bump = PublicKey.findProgramAddressSync([enc.encode("attestation"), launch!.toBytes()], PROGRAM_IDS.launchpad)[1];

  // Commit the state changes.
  conn.set(payer!, { owner: SystemProgram.programId, data: new Uint8Array(0), lamports: Number(left) });
  conn.set(identityKey!, { owner: PROGRAM_IDS.launchpad, data: identityAccountBytes(a.lmsPk, used) });
  if (attests) {
    conn.set(attestationKey!, {
      owner: PROGRAM_IDS.launchpad,
      data: attestationAccountBytes({
        version: 3,
        bump,
        launch: launch!,
        pqIdentity,
        leaf: q,
        metadataHash: a.metadataHash,
        rulesHash: a.rulesHash,
        messageHash: sha256(message),
        slot: BigInt(conn.slot),
        notBefore: a.notBefore,
        notAfter: a.notAfter,
        signature: a.lmsSig,
      }),
    });
  } else if (att === null) {
    conn.set(attestationKey!, {
      owner: PROGRAM_IDS.launchpad,
      data: attestationAccountBytes({
        version: 0,
        bump,
        launch: PublicKey.default,
        pqIdentity: new Uint8Array(32),
        leaf: 0,
        metadataHash: new Uint8Array(32),
        messageHash: new Uint8Array(32),
        slot: 0n,
        notBefore: 0n,
        notAfter: 0n,
        signature: new Uint8Array(0),
      }),
    });
  }
}

/**
 * Land any launchpad transaction this module models (`publish_metadata`,
 * `publish_rules` with `verifyRules`, `attest_launch`, `pq_authorize`), by
 * its discriminator.
 */
export function emulateLaunchpad(conn: AttestConnection, wire: Uint8Array, verifyRules?: (bytes: Uint8Array, guardSecs: number) => boolean): void {
  const { data } = oneLaunchpadInstruction(wire);
  const disc = (name: string): Uint8Array => Uint8Array.from(idlCodecs().launchpad.instruction(name).discriminator);
  if (bytesEqual(data.subarray(0, 8), disc("publish_metadata"))) emulatePublishMetadata(conn, wire);
  else if (bytesEqual(data.subarray(0, 8), disc("attest_launch"))) emulateAttestLaunch(conn, wire);
  else if (bytesEqual(data.subarray(0, 8), disc("pq_authorize"))) emulatePqAuthorize(conn, wire);
  else if (bytesEqual(data.subarray(0, 8), disc("publish_rules"))) {
    if (verifyRules === undefined) throw new Error("emulateLaunchpad: pass a rules verifier to land publish_rules");
    emulatePublishRules(conn, wire, verifyRules);
  } else throw new ProgramError(101, "InstructionFallbackNotFound");
}

/**
 * Durable one-signature-per-key records for PQ vault keys (LM-OTS).
 *
 * # Why
 *
 * Every vault key is a one-time key (LM-OTS, W4): two signatures of two
 * different withdrawals under one key reveal enough Winternitz chain values
 * for anyone holding both to forge a third withdrawal, to themselves, at that
 * sequence (the recipient, amount and next-key fields give free bits to grind
 * with). The history search (`findPendingWithdrawal`) only sees what landed,
 * and an in-memory guard only covers one tab. A signature that was revealed
 * and never landed (a simulation sends it to the RPC, a send was dropped, the
 * tab was reloaded, another tab or device signed) is invisible to both. So,
 * as for the LMS leaves of a creator identity (`./leafLedger.ts`), the client
 * must remember, durably and before any signature bytes exist, which message
 * each vault key belongs to.
 *
 * # The rule
 *
 * 1. `reserve(keyId, message, { vault, sequence, key })` writes the record
 *    "this key belongs to this withdrawal" BEFORE signing, with the store's
 *    atomic `add`: whichever tab or device adds first owns the key, and every
 *    other message is refused. The record holds the one-time public key
 *    itself (it must hash to `keyId` and have `q = sequence`), so every
 *    signature recorded later is verified against it. A record is never
 *    deleted or given to another message; the one exception is a reservation
 *    that never released a signature, replaced by a signature of this key
 *    found on chain (`adoptFound`) or imported from another device
 *    (`importRecord`): that signature exists already, and the reservation's
 *    own message can then never be signed, because `recordSignature`
 *    refuses it.
 * 2. Only then is the message signed, deterministically (signing the same
 *    message again gives the identical bytes).
 * 3. The signature is recorded (`recordSignature`, which verifies it under
 *    the recorded key) before it is returned, so before anyone can simulate
 *    or broadcast it.
 * 4. A key holding a record never signs another message: `prepareWithdrawal`
 *    and `signWithdrawal` throw `VaultKeyInUseError` (with the recorded
 *    withdrawal to re-broadcast), and `buildWithdrawTxWithFallback` simulates
 *    (reveals) only a signature this ledger holds.
 *
 * # Storage
 *
 * `createVaultKeyLedger(store)` runs on the same `LeafLedgerStore` interface
 * as the leaf ledger (one store can hold both: keys are namespaced). Its
 * `add` MUST be atomic (IndexedDB `add()`, SQL `INSERT` without `REPLACE`,
 * an exclusive file create): that single primitive is what keeps two tabs or
 * devices sharing the store from signing two messages with one key. A store
 * atomic within one tab only (Web Storage, `singleRealmOnly`) needs a lock
 * shared by every tab (`opts.lock = (name, fn) => navigator.locks.request(name, fn)`).
 * A record that cannot be parsed counts as taken, never as free. Records hold
 * public data only (key id, key, vault, message, signature, next key).
 *
 * # Several devices (the multi-device rule)
 *
 * The recovery phrase derives every vault key on every device, but each
 * device's ledger only knows its own records: two devices with two ledgers
 * can each sign a different withdrawal with the same key before either one
 * lands, and anyone who sees both signatures can forge a third. So, for every
 * vault account, either:
 *
 * - every device uses ONE shared ledger (a store all devices and tabs reach,
 *   with an atomic `add`): the only arrangement that closes the race; or
 * - a device imports the records of every other device that may have signed
 *   BEFORE it signs: `exportVaultKeyRecords` there, `importVaultKeyRecords`
 *   here. An import is authenticated (each record's signature must verify
 *   under its recorded key over its recorded withdrawal, and nothing is
 *   written if one record fails), only adds (a key another device signed
 *   becomes taken; a local reservation that never signed is replaced by the
 *   other device's signature), and reports a key the two devices gave to two
 *   messages (`conflicts`), a key holding two signatures (`compromised`:
 *   broadcast one of the two withdrawals at once; once one executes, the key
 *   is retired and the forgery window closes) and a key the other device
 *   signed with but could not export (`unverifiable`: a record of SDK 0.2.0
 *   without its key; do not sign until that device ran
 *   `completeVaultKeyRecords` and exported again). This narrows the race to
 *   the moments the devices did not sync; it does not close it; or
 * - each device uses its own vault accounts (account numbers), so no key is
 *   ever shared.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { PublicKey } from "@solana/web3.js";

import { bytesEqual, fromHex, isU64, toHex } from "../codec/bytes.js";
import { VAULT } from "../constants.js";
import type { WithdrawTxArgs } from "../types.js";
import { withLegacyLock, withLegacyNamespace } from "./legacyNamespace.js";
import { ledgerLock, type LedgerLock } from "./ledgerLock.js";
import type { LeafLedgerStore, LeafReservation } from "./leafLedger.js";
import * as lmots from "./lmots.js";
import type { LmotsPublicKey } from "./lmots.js";
import { parseWithdrawMessage, type ParsedWithdrawMessage } from "./withdrawMessage.js";

/** `reserved`: no signature was ever released; `signed`: the signature is recorded (and may be revealed). */
export type VaultKeyStatus = "reserved" | "signed";

/** An LM-OTS public key as JSON-safe hex fields. */
export interface VaultKeyHex {
  /** Hex of the 16-byte key identifier `I`. */
  readonly id: string;
  /** The leaf index `q` (u32): a vault key's `q` is its sequence. */
  readonly q: number;
  /** Hex of the 32-byte public key hash `K`. */
  readonly k: string;
}

/** One vault key's record (JSON-safe: hex strings, base58, decimal sequence). */
export interface VaultKeyRecord {
  /** Hex of the one-time key's 32-byte key id (`lmots.keyId`). */
  readonly keyId: string;
  /** Base58 of the vault. */
  readonly vault: string;
  /** Decimal vault sequence the key signs for. */
  readonly sequence: string;
  /** Hex of the 185-byte withdraw message this key belongs to. */
  readonly message: string;
  /** Hex of SHA-256 of `message`. */
  readonly messageHash: string;
  readonly status: VaultKeyStatus;
  /** Hex of the 2,176-byte LM-OTS signature, once signed. */
  readonly signature: string | null;
  /**
   * The one-time key itself (hashes to `keyId`, `q` = `sequence`): every
   * signature recorded here verifies under it. Null only in records written
   * by SDK 0.2.0: they cannot be exported until they get their key
   * (`completeVaultKeyRecords`, or `prepareWithdrawal` / `signWithdrawal`
   * with that key).
   */
  readonly key: VaultKeyHex | null;
  /** The next key the withdrawal installs (it hashes to the message's next key id), once known. */
  readonly nextKey: VaultKeyHex | null;
  /** `signed`: signed through this ledger; `found`: found on chain; `imported`: from another device's export (`importVaultKeyRecords`). */
  readonly origin: "signed" | "found" | "imported";
  /** Local wall-clock milliseconds (bookkeeping only). */
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Where a vault key signs, and the key itself (`reserve`, `adoptFound`). */
export interface VaultKeyInfo {
  readonly vault: PublicKey;
  readonly sequence: bigint;
  /** The one-time public key whose key id is the record's (`q` = `sequence`, the key-index binding). */
  readonly key: LmotsPublicKey;
}

/** What `importRecord` did with one record. */
export interface VaultKeyImportOutcome {
  /** Hex key id. */
  readonly keyId: string;
  /**
   * `added`: the key was unknown here; `merged`: this ledger's record of the
   * same withdrawal was completed (signature, next key, key); `unchanged`;
   * `conflict`: the key belongs to two withdrawals (this ledger's reservation,
   * if it never signed, was replaced by the imported signature).
   */
  readonly outcome: "added" | "merged" | "unchanged" | "conflict";
  /** Two different signatures of this key exist: anyone holding both can forge a withdrawal at its sequence. */
  readonly compromised: boolean;
}

/** Durable vault-key records (see the module docs). */
export interface VaultKeyLedger {
  /** Reserve the one-time key `keyId` (`info.key`) for the 185-byte withdraw `message`, before any signature exists. */
  reserve(keyId: Uint8Array, message: Uint8Array, info: VaultKeyInfo): Promise<LeafReservation>;
  /** The key's record, or null. Throws `VaultLedgerError` on a record that cannot be parsed (it counts as taken). */
  get(keyId: Uint8Array): Promise<VaultKeyRecord | null>;
  /** Every record, by key id. Throws `VaultLedgerError` on a record that cannot be parsed. */
  list(): Promise<VaultKeyRecord[]>;
  /**
   * Store the signature of the reserved message (byte-identical if one is
   * already stored), before it is returned. Refused unless it verifies under
   * the recorded key over the reserved message and `nextKey` hashes to the
   * message's next key id.
   */
  recordSignature(keyId: Uint8Array, message: Uint8Array, signature: Uint8Array, nextKey: LmotsPublicKey): Promise<void>;
  /**
   * Record a signature of this key over `message` found on chain (public
   * already; verified here under `info.key`). Fills an empty record;
   * completes a record of the same message; replaces a reservation of
   * another message that never released a signature. Throws
   * `VaultKeyInUseError` when the key already holds another message's
   * signature (both are revealed).
   */
  adoptFound(keyId: Uint8Array, message: Uint8Array, signature: Uint8Array, nextKey: LmotsPublicKey | null, info: VaultKeyInfo): Promise<void>;
  /**
   * Merge one record exported by another device (prefer
   * `importVaultKeyRecords`, which authenticates the whole export before
   * writing anything). Authenticated here too (`VaultLedgerError` otherwise):
   * a signed record whose signature verifies under its key over its message.
   * Only adds: an unknown key becomes taken, a record of the same message is
   * completed, a reservation of another message that never signed is
   * replaced; a key holding another signature is a `conflict` and nothing is
   * written.
   */
  importRecord(record: VaultKeyRecord): Promise<VaultKeyImportOutcome>;
}

/** A record is missing, unreadable or fails authentication, or a transition breaks the rule. */
export class VaultLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultLedgerError";
  }
}

/**
 * The vault key already belongs to another withdrawal (reserved or signed),
 * in this ledger: never sign a second message with it. When `withdrawal` is
 * set, re-broadcast it (`buildWithdrawTxWithFallback` / `buildWithdrawTx`);
 * when it is null the key was reserved for `record`'s message and never
 * signed: prepare that same withdrawal to finish it.
 */
export class VaultKeyInUseError extends Error {
  readonly record: VaultKeyRecord;
  /** The recorded withdrawal, ready to rebuild (null when only reserved). */
  readonly withdrawal: WithdrawTxArgs | null;

  constructor(record: VaultKeyRecord, withdrawal: WithdrawTxArgs | null, detail = "") {
    super(
      record.signature !== null
        ? `refusing to sign: this one-time vault key already signed a different withdrawal${detail}; re-broadcast that one (error.withdrawal), never sign a second message with one key`
        : `refusing to sign: this one-time vault key is already reserved for a different withdrawal${detail}, which was never signed; prepare that same withdrawal to finish it, never sign a second message with one key`,
    );
    this.name = "VaultKeyInUseError";
    this.record = record;
    this.withdrawal = withdrawal;
  }
}

const NAMESPACE = "noised/pq/vault-ledger/v1/";
const KEY_PREFIX = `${NAMESPACE}key/`;
const recordKey = (id: string) => `${KEY_PREFIX}${id}`;
const isHex = (s: unknown, len: number): s is string => typeof s === "string" && s.length === len && /^[0-9a-f]*$/.test(s);
const ORIGINS: readonly VaultKeyRecord["origin"][] = ["signed", "found", "imported"];

function keyIdHex(keyId: Uint8Array): string {
  if (!(keyId instanceof Uint8Array) || keyId.length !== 32) throw new RangeError("key id must be 32 bytes");
  return toHex(keyId);
}

function checkMessage(message: Uint8Array): void {
  if (!(message instanceof Uint8Array) || message.length !== VAULT.WITHDRAW_MESSAGE_LEN) throw new RangeError(`message must be the ${VAULT.WITHDRAW_MESSAGE_LEN}-byte withdraw message`);
}

function checkSignature(signature: Uint8Array): void {
  if (!(signature instanceof Uint8Array) || signature.length !== VAULT.SIGNATURE_LEN) throw new RangeError(`signature must be ${VAULT.SIGNATURE_LEN} bytes`);
}

function keyHex(k: LmotsPublicKey, what: string): VaultKeyHex {
  if (
    k === null ||
    typeof k !== "object" ||
    !(k.id instanceof Uint8Array) ||
    k.id.length !== 16 ||
    !(k.k instanceof Uint8Array) ||
    k.k.length !== 32 ||
    !Number.isInteger(k.q) ||
    k.q < 0 ||
    k.q > 0xffff_ffff
  ) {
    throw new RangeError(`${what} must be an LM-OTS public key (16-byte id, u32 q, 32-byte k)`);
  }
  return { id: toHex(k.id), q: k.q, k: toHex(k.k) };
}

const keyFromHex = (k: VaultKeyHex): LmotsPublicKey => ({ id: fromHex(k.id), q: k.q, k: fromHex(k.k) });

/**
 * `info` against `keyId` and `message`: the key hashes to the key id, has
 * `q = sequence` (key-index binding), and the message is a PHX-PQV4
 * withdrawal of this program naming `info.vault` at `info.sequence`.
 */
function checkInfo(id: string, message: Uint8Array, info: VaultKeyInfo): { vault: string; sequence: string; key: VaultKeyHex; parsed: ParsedWithdrawMessage } {
  if (info === null || typeof info !== "object") throw new TypeError("info must be { vault, sequence, key }");
  if (!(info.vault instanceof PublicKey)) throw new TypeError("info.vault must be a PublicKey");
  if (!isU64(info.sequence)) throw new RangeError("info.sequence must be a u64");
  if (info.key === undefined) throw new TypeError("info.key (the one-time public key being reserved) is required: every recorded signature is verified under it");
  const key = keyHex(info.key, "info.key");
  if (toHex(lmots.keyId(info.key)) !== id) throw new RangeError("info.key does not hash to the key id");
  if (BigInt(info.key.q) !== info.sequence) throw new RangeError(`info.key has q = ${info.key.q}, but the key of sequence ${info.sequence} has q = ${info.sequence} (key-index binding)`);
  const parsed = parseWithdrawMessage(message);
  if (!parsed.vault.equals(info.vault) || parsed.sequence !== info.sequence) throw new RangeError("the message names another vault or sequence than info");
  return { vault: info.vault.toBase58(), sequence: info.sequence.toString(), key, parsed };
}

/** `nextKey` hashes to the message's next key id (the withdrawal could not execute otherwise). */
function checkNextKey(nextKey: LmotsPublicKey, parsed: ParsedWithdrawMessage): VaultKeyHex {
  const nk = keyHex(nextKey, "nextKey");
  if (!bytesEqual(lmots.keyId(nextKey), parsed.nextKeyId)) throw new VaultLedgerError("the next key does not hash to the message's next key id: nothing was recorded");
  return nk;
}

function parseKeyHex(v: unknown): VaultKeyHex | null | undefined {
  if (v === null || v === undefined) return null;
  const k = v as { id?: unknown; q?: unknown; k?: unknown };
  if (typeof v !== "object" || !isHex(k.id, 32) || typeof k.q !== "number" || !Number.isInteger(k.q) || k.q < 0 || k.q > 0xffff_ffff || !isHex(k.k, 64)) return undefined;
  return { id: k.id, q: k.q, k: k.k };
}

function parseRecord(raw: string, id: string): VaultKeyRecord {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new VaultLedgerError(`vault key record ${id} is not JSON`);
  }
  const r = v as Partial<Record<keyof VaultKeyRecord, unknown>>;
  const key = typeof v === "object" && v !== null ? parseKeyHex(r.key) : undefined;
  const nextKey = typeof v === "object" && v !== null ? parseKeyHex(r.nextKey) : undefined;
  const ok =
    typeof v === "object" &&
    v !== null &&
    r.keyId === id &&
    typeof r.vault === "string" &&
    typeof r.sequence === "string" &&
    /^[0-9]+$/.test(r.sequence) &&
    isHex(r.message, 2 * VAULT.WITHDRAW_MESSAGE_LEN) &&
    isHex(r.messageHash, 64) &&
    (r.status === "reserved" || r.status === "signed") &&
    (r.status === "signed" ? isHex(r.signature, 2 * VAULT.SIGNATURE_LEN) : r.signature === null) &&
    key !== undefined &&
    nextKey !== undefined &&
    ORIGINS.includes(r.origin as VaultKeyRecord["origin"]) &&
    typeof r.createdAt === "number" &&
    typeof r.updatedAt === "number";
  if (!ok) throw new VaultLedgerError(`vault key record ${id} is malformed`);
  try {
    new PublicKey(r.vault as string);
  } catch {
    throw new VaultLedgerError(`vault key record ${id} is malformed`);
  }
  return {
    keyId: id,
    vault: r.vault as string,
    sequence: r.sequence as string,
    message: r.message as string,
    messageHash: r.messageHash as string,
    status: r.status as VaultKeyStatus,
    signature: (r.signature as string | null) ?? null,
    key,
    nextKey,
    origin: r.origin as VaultKeyRecord["origin"],
    createdAt: r.createdAt as number,
    updatedAt: r.updatedAt as number,
  };
}

/**
 * Authenticate a record from another device, without the store: well formed;
 * signed; it holds its key, which hashes to `keyId` and has `q = sequence`;
 * its message is a PHX-PQV4 withdrawal of this program naming its vault and
 * sequence and hashing to `messageHash`; its signature verifies under its key
 * over its message; its next key, when set, hashes to the message's next key
 * id and has `q = sequence + 1`. Returns the normalized record.
 */
function authenticate(record: unknown): VaultKeyRecord {
  if (record === null || typeof record !== "object") throw new VaultLedgerError("an imported vault key record must be an object");
  const id = (record as { keyId?: unknown }).keyId;
  if (!isHex(id, 64)) throw new VaultLedgerError("an imported vault key record has no 64-character lower-case hex keyId");
  const r = parseRecord(JSON.stringify(record), id);
  const fail = (why: string): never => {
    throw new VaultLedgerError(`imported vault key record ${id}: ${why}`);
  };
  if (r.status !== "signed" || r.signature === null) fail("it holds no signature (only signed records can be authenticated)");
  if (r.key === null) fail("it holds no key (a record of SDK 0.2.0): it cannot be authenticated");
  const key = keyFromHex(r.key!);
  if (toHex(lmots.keyId(key)) !== id) fail("its key does not hash to its key id");
  if (BigInt(key.q) !== BigInt(r.sequence)) fail(`its key has q = ${key.q}, but the key of sequence ${r.sequence} has q = ${r.sequence}`);
  const message = fromHex(r.message);
  let parsed: ParsedWithdrawMessage;
  try {
    parsed = parseWithdrawMessage(message);
  } catch (e) {
    return fail(`its message is not a withdrawal of this program (${e instanceof Error ? e.message : String(e)})`);
  }
  if (parsed.vault.toBase58() !== r.vault || parsed.sequence !== BigInt(r.sequence)) fail("its message names another vault or sequence");
  if (toHex(sha256(message)) !== r.messageHash) fail("its message does not hash to its message hash");
  if (!lmots.verify(key, message, fromHex(r.signature!))) fail("its signature does not verify under its key over its message");
  if (r.nextKey !== null) {
    const nk = keyFromHex(r.nextKey);
    if (!bytesEqual(lmots.keyId(nk), parsed.nextKeyId)) fail("its next key does not hash to the message's next key id");
    if (BigInt(nk.q) !== parsed.sequence + 1n) fail(`its next key has q = ${nk.q}, not ${parsed.sequence + 1n}`);
  }
  return r;
}

/** Options of `createVaultKeyLedger`. */
export interface VaultKeyLedgerOptions {
  /**
   * Serializes the operations on one key (name =
   * `noised/pq/vault-ledger/v1/<key id hex>`). Default: an in-process mutex;
   * required (a lock shared by every tab, `navigator.locks`) when the store is
   * `singleRealmOnly`.
   */
  lock?: LedgerLock | undefined;
  /** Wall clock in milliseconds (bookkeeping fields only). */
  now?: () => number;
}

/** A vault-key ledger on `store` (its `add` must be atomic; see the module docs). */
export function createVaultKeyLedger(rawStore: LeafLedgerStore, opts: VaultKeyLedgerOptions = {}): VaultKeyLedger {
  const lock = withLegacyLock(ledgerLock(rawStore, opts.lock, "createVaultKeyLedger"));
  // Records of the earlier name (`phalanx/pq/vault-ledger/v1/`) are migrated and honoured: see legacyNamespace.ts.
  const store = withLegacyNamespace(rawStore, NAMESPACE);
  const now = opts.now ?? (() => Date.now());
  const locked = <T>(id: string, fn: () => Promise<T>): Promise<T> => lock(`${NAMESPACE}${id}`, fn);

  const read = async (id: string): Promise<VaultKeyRecord | null> => {
    const raw = await store.get(recordKey(id));
    return raw === null || raw === undefined ? null : parseRecord(raw, id);
  };
  const write = (rec: VaultKeyRecord): Promise<void> => store.put(recordKey(rec.keyId), JSON.stringify(rec));

  return {
    async reserve(keyId, message, info) {
      const id = keyIdHex(keyId);
      checkMessage(message);
      const { parsed: _parsed, ...where } = checkInfo(id, message, info);
      const mh = toHex(sha256(message));
      return locked(id, async (): Promise<LeafReservation> => {
        const verdict = (raw: string | null | undefined): LeafReservation | null => {
          if (raw === null || raw === undefined) return null;
          try {
            return parseRecord(raw, id).messageHash === mh ? "same" : "conflict";
          } catch {
            return "conflict"; // unreadable: taken, never free
          }
        };
        const existing = verdict(await store.get(recordKey(id)));
        if (existing !== null) return existing;
        const t = now();
        const rec: VaultKeyRecord = {
          keyId: id,
          ...where,
          message: toHex(message),
          messageHash: mh,
          status: "reserved",
          signature: null,
          nextKey: null,
          origin: "signed",
          createdAt: t,
          updatedAt: t,
        };
        if (!(await store.add(recordKey(id), JSON.stringify(rec)))) return verdict(await store.get(recordKey(id))) ?? "conflict";
        return "reserved";
      });
    },

    async get(keyId) {
      return read(keyIdHex(keyId));
    },

    async list() {
      const out: VaultKeyRecord[] = [];
      for (const k of (await store.keys(KEY_PREFIX)).sort()) {
        const id = k.slice(KEY_PREFIX.length);
        if (!isHex(id, 64)) continue;
        const rec = await read(id);
        if (rec !== null) out.push(rec);
      }
      return out;
    },

    async recordSignature(keyId, message, signature, nextKey) {
      const id = keyIdHex(keyId);
      checkMessage(message);
      checkSignature(signature);
      const nk = checkNextKey(nextKey, parseWithdrawMessage(message));
      return locked(id, async () => {
        const rec = await read(id);
        if (rec === null) throw new VaultLedgerError(`vault key ${id} has no record: reserve it first`);
        if (rec.messageHash !== toHex(sha256(message))) throw new VaultLedgerError(`vault key ${id} belongs to another withdrawal: never sign a second message with one key`);
        if (rec.key !== null && !lmots.verify(keyFromHex(rec.key), message, signature)) {
          throw new VaultLedgerError(`vault key ${id}: the signature does not verify under the recorded key over this withdrawal: nothing was recorded`);
        }
        const sigHex = toHex(signature);
        if (rec.signature !== null) {
          if (rec.signature !== sigHex) throw new VaultLedgerError(`vault key ${id} already holds a different signature of this withdrawal`);
          if (rec.nextKey === null) await write({ ...rec, nextKey: nk, updatedAt: now() });
          return;
        }
        await write({ ...rec, status: "signed", signature: sigHex, nextKey: nk, updatedAt: now() });
      });
    },

    async adoptFound(keyId, message, signature, nextKey, info) {
      const id = keyIdHex(keyId);
      checkMessage(message);
      checkSignature(signature);
      const { parsed, ...where } = checkInfo(id, message, info);
      if (!lmots.verify(info.key, message, signature)) throw new VaultLedgerError(`vault key ${id}: the found signature does not verify under this key over its withdrawal: nothing was recorded`);
      const nk = nextKey === null ? null : checkNextKey(nextKey, parsed);
      const mh = toHex(sha256(message));
      const sigHex = toHex(signature);
      return locked(id, async () => {
        for (let attempt = 0; attempt < 2; attempt++) {
          const raw = await store.get(recordKey(id));
          const t = now();
          const found: VaultKeyRecord = { keyId: id, ...where, message: toHex(message), messageHash: mh, status: "signed", signature: sigHex, nextKey: nk, origin: "found", createdAt: t, updatedAt: t };
          if (raw === null || raw === undefined) {
            if (await store.add(recordKey(id), JSON.stringify(found))) return;
            continue; // added meanwhile: merge with it
          }
          const rec = parseRecord(raw, id); // unreadable: throws, nothing is adopted
          if (rec.messageHash === mh) {
            if (rec.signature !== null && rec.signature !== sigHex) throw new VaultLedgerError(`vault key ${id} holds another signature of this withdrawal`);
            if (rec.signature === null || (rec.nextKey === null && nk !== null) || rec.key === null) {
              await write({ ...rec, status: "signed", signature: sigHex, nextKey: rec.nextKey ?? nk, key: rec.key ?? where.key, updatedAt: t });
            }
            return;
          }
          if (rec.signature !== null) throw new VaultKeyInUseError(rec, null, " (and another signature of this key is on chain: both are revealed)");
          // A reservation that never released a signature: the found signature replaces it, and the reserved message can never be signed now.
          await write({ ...found, createdAt: rec.createdAt });
          return;
        }
        throw new VaultLedgerError(`vault key ${id}: could not record the found signature`);
      });
    },

    async importRecord(record) {
      const incoming = authenticate(record);
      const id = incoming.keyId;
      return locked(id, async (): Promise<VaultKeyImportOutcome> => {
        for (let attempt = 0; attempt < 2; attempt++) {
          const raw = await store.get(recordKey(id));
          const t = now();
          if (raw === null || raw === undefined) {
            if (!(await store.add(recordKey(id), JSON.stringify({ ...incoming, origin: "imported", createdAt: t, updatedAt: t } satisfies VaultKeyRecord)))) continue; // added meanwhile: merge with it
            return { keyId: id, outcome: "added", compromised: false };
          }
          let local: VaultKeyRecord;
          try {
            local = parseRecord(raw, id);
          } catch {
            return { keyId: id, outcome: "conflict", compromised: false }; // unreadable here: taken, never free; nothing written
          }
          if (local.messageHash === incoming.messageHash) {
            // One message signed twice (two randomizers): both signatures exist.
            if (local.signature !== null && local.signature !== incoming.signature) return { keyId: id, outcome: "conflict", compromised: true };
            const merged: VaultKeyRecord = {
              ...local,
              status: "signed",
              signature: incoming.signature,
              nextKey: local.nextKey ?? incoming.nextKey,
              key: local.key ?? incoming.key,
            };
            const same = local.signature !== null && merged.nextKey === local.nextKey && merged.key === local.key;
            if (same) return { keyId: id, outcome: "unchanged", compromised: false };
            await write({ ...merged, updatedAt: t });
            return { keyId: id, outcome: "merged", compromised: false };
          }
          // Two withdrawals for one key. A local reservation that never signed gives way to the other device's signature.
          if (local.signature === null) await write({ ...incoming, origin: "imported", createdAt: local.createdAt, updatedAt: t });
          return { keyId: id, outcome: "conflict", compromised: local.signature !== null };
        }
        return { keyId: id, outcome: "conflict", compromised: false };
      });
    },
  };
}

/** A vault-key ledger in memory (tests, or a single session that persists elsewhere). */
export function createMemoryVaultKeyLedger(opts: VaultKeyLedgerOptions = {}): VaultKeyLedger {
  const m = new Map<string, string>();
  return createVaultKeyLedger(
    {
      get: (key) => Promise.resolve(m.get(key) ?? null),
      add: (key, value) => {
        if (m.has(key)) return Promise.resolve(false);
        m.set(key, value);
        return Promise.resolve(true);
      },
      put: (key, value) => {
        m.set(key, value);
        return Promise.resolve();
      },
      keys: (prefix) => Promise.resolve([...m.keys()].filter((k) => k.startsWith(prefix))),
    },
    opts,
  );
}

// ------------------------------------------------------ several devices ---

/** Format tag of `exportVaultKeyRecords`. */
export const VAULT_KEY_LEDGER_EXPORT_FORMAT = "noised/pq/vault-key-ledger-export/v1";
/** The same format as exported before the rename to Noised (still imported). */
export const LEGACY_VAULT_KEY_LEDGER_EXPORT_FORMAT = "phalanx/pq/vault-key-ledger-export/v1";

/** Signed vault-key records, to carry to another device (JSON-safe; public data only). */
export interface VaultKeyLedgerExport {
  /** `VAULT_KEY_LEDGER_EXPORT_FORMAT` (exports made before the rename carry `LEGACY_VAULT_KEY_LEDGER_EXPORT_FORMAT`; both import). */
  readonly format: typeof VAULT_KEY_LEDGER_EXPORT_FORMAT | typeof LEGACY_VAULT_KEY_LEDGER_EXPORT_FORMAT;
  /** Every signed record that holds its key (each is authenticated by the importer). */
  readonly records: readonly VaultKeyRecord[];
  /**
   * Records left out, by hex key id: `reserved` (no signature was ever
   * released, so there is nothing to authenticate and nothing another device
   * must avoid) or `no-key` (a signed record of SDK 0.2.0, which does not hold
   * its key: it cannot be authenticated, yet that key IS spent). The import
   * reports `no-key` entries as `unverifiable`: the importing device must
   * not sign with those keys. Run `completeVaultKeyRecords` on the exporting
   * device (it holds the phrase) and export again, so they are carried as
   * authenticated records.
   */
  readonly skipped: readonly { readonly keyId: string; readonly reason: "reserved" | "no-key" }[];
}

/**
 * The signed records of `ledger` (of one vault with `opts.vault`), for
 * `importVaultKeyRecords` on another device that holds the same phrase,
 * BEFORE that device signs (see "Several devices" in the module docs).
 * A signed record without its key (SDK 0.2.0) cannot be carried: it is
 * listed in `skipped` (`no-key`), which the importer reports as
 * `unverifiable`; run `completeVaultKeyRecords` first so that it is not.
 * Throws `VaultLedgerError` when a record cannot be parsed.
 */
export async function exportVaultKeyRecords(ledger: VaultKeyLedger, opts: { readonly vault?: PublicKey | undefined } = {}): Promise<VaultKeyLedgerExport> {
  if (opts.vault !== undefined && !(opts.vault instanceof PublicKey)) throw new TypeError("opts.vault must be a PublicKey");
  const vault = opts.vault?.toBase58();
  const records: VaultKeyRecord[] = [];
  const skipped: { keyId: string; reason: "reserved" | "no-key" }[] = [];
  for (const r of await ledger.list()) {
    if (vault !== undefined && r.vault !== vault) continue;
    if (r.signature === null) skipped.push({ keyId: r.keyId, reason: "reserved" });
    else if (r.key === null) skipped.push({ keyId: r.keyId, reason: "no-key" });
    else records.push(r);
  }
  return { format: VAULT_KEY_LEDGER_EXPORT_FORMAT, records, skipped };
}

/** What `importVaultKeyRecords` did. */
export interface VaultKeyImportSummary {
  readonly added: number;
  readonly merged: number;
  readonly unchanged: number;
  /** Hex key ids the two ledgers gave to two withdrawals (a local reservation that never signed was replaced by the imported signature). */
  readonly conflicts: string[];
  /** Hex key ids holding two different signatures: broadcast one of the two withdrawals now (anyone holding both can forge one at that sequence until one executes). */
  readonly compromised: string[];
  /**
   * Hex key ids the other device signed with but could not export (its
   * records of SDK 0.2.0 without their key: `skipped`, reason `no-key`).
   * Nothing was written for them, because nothing could authenticate them,
   * yet those keys are spent: never sign with them on this device (do not
   * sign for their vaults at all while this is not empty). On the other
   * device, run `completeVaultKeyRecords`, export again and import that.
   */
  readonly unverifiable: string[];
}

/**
 * Merge `exported` (another device's `exportVaultKeyRecords`) into `ledger`,
 * before this device signs for those vaults. Every record is authenticated
 * first, and NOTHING is written if one fails (`VaultLedgerError`): it must be
 * signed, hold its key (hashing to its key id, `q` = its sequence), carry a
 * PHX-PQV4 withdrawal of this program naming its vault and sequence, and its
 * signature must verify under that key over that withdrawal; a key id may
 * appear once. The import only adds: a key it did not know becomes taken
 * (any other withdrawal for it throws `VaultKeyInUseError`, with this one to
 * re-broadcast), a record of the same withdrawal is completed, and a local
 * reservation of another withdrawal that never signed is replaced; it never
 * frees a key, removes a signature or reassigns a signed key. Signed keys
 * the export could not carry (`skipped`, reason `no-key`) are reported in
 * `unverifiable`: check it before signing.
 */
export async function importVaultKeyRecords(ledger: VaultKeyLedger, exported: VaultKeyLedgerExport): Promise<VaultKeyImportSummary> {
  if (
    exported === null ||
    typeof exported !== "object" ||
    (exported.format !== VAULT_KEY_LEDGER_EXPORT_FORMAT && (exported.format as string) !== LEGACY_VAULT_KEY_LEDGER_EXPORT_FORMAT) ||
    !Array.isArray(exported.records) ||
    !Array.isArray(exported.skipped)
  ) {
    throw new VaultLedgerError(`not a vault-key ledger export (format ${VAULT_KEY_LEDGER_EXPORT_FORMAT}, with records and skipped)`);
  }
  const unverifiable: string[] = [];
  for (const s of exported.skipped as readonly unknown[]) {
    const e = s as { keyId?: unknown; reason?: unknown } | null;
    if (e === null || typeof e !== "object" || !isHex(e.keyId, 64) || (e.reason !== "reserved" && e.reason !== "no-key")) {
      throw new VaultLedgerError("the export's skipped list is malformed (each entry: { keyId: 64 hex characters, reason: \"reserved\" | \"no-key\" })");
    }
    if (e.reason === "no-key" && !unverifiable.includes(e.keyId)) unverifiable.push(e.keyId);
  }
  const seen = new Set<string>();
  const records = exported.records.map((r) => {
    const a = authenticate(r);
    if (seen.has(a.keyId)) throw new VaultLedgerError(`the export holds key ${a.keyId} twice`);
    seen.add(a.keyId);
    return a;
  });
  const summary = { added: 0, merged: 0, unchanged: 0, conflicts: [] as string[], compromised: [] as string[], unverifiable };
  for (const r of records) {
    const o = await ledger.importRecord(r);
    if (o.outcome === "conflict") summary.conflicts.push(o.keyId);
    else summary[o.outcome]++;
    if (o.compromised) summary.compromised.push(o.keyId);
  }
  return summary;
}

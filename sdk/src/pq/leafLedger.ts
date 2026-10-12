/**
 * Durable one-time-leaf records for PQ creator identities (amendment A13).
 *
 * # Why
 *
 * An LMS leaf is a one-time key. Two signatures at one leaf (two messages,
 * or one message under two randomizers) reveal enough Winternitz chain
 * values for anyone to forge signatures at that leaf. The identity account's
 * on-chain bitmap only records signatures that LANDED; a signature that was
 * revealed and never landed (a simulation sends it to the RPC, a failed
 * transaction keeps it on-chain in its data, a second device or a lost tab
 * may still broadcast it) leaves its leaf clear on-chain. So the client must
 * remember, durably and before any signature bytes exist, which leaf it has
 * given to which message.
 *
 * # The rule
 *
 * 1. `reserve(identity, leaf, messageHash)` writes the record "this leaf
 *    belongs to this message" BEFORE signing. A leaf is reserved for exactly
 *    one message, forever: a record is never deleted or reassigned, whatever
 *    its status.
 * 2. Only then is the message signed, with the deterministic randomizer
 *    (`LmsKeyPair` has no public signing method; `reserveAndSign` is the
 *    way in): signing the same message at the same leaf again yields
 *    byte-identical bytes, so retries are idempotent.
 * 3. The signature is recorded (`recordSignature`) before it is returned, so
 *    before anyone can simulate or broadcast it; a recorded signature is
 *    re-broadcast, never replaced.
 * 4. A leaf reserved for one message is never signed for another
 *    (`reserve` answers `"conflict"`), and a message holds at most one live
 *    leaf per identity (another reservation also answers `"conflict"`; use
 *    `findByMessage` and retry that leaf). A leaf whose landing only burned
 *    it (`landed`, `attested: false`) no longer holds its message: the same
 *    message may then be signed again at another leaf (another one-time key,
 *    so no forgery; it spends that leaf, which `buildAttestLaunchTx` caps
 *    per launch), for example once a missing metadata record is published.
 *
 * `reserveAndSign` does 1-3 in order (checking that the record the ledger
 * returns is this identity's reservation of that leaf for that message, and
 * remembering in-process which message each leaf signed, so that no ledger
 * passed later can make one process sign a second message at a leaf);
 * `selectLeaf` picks the message's leaf from the SECRET probe, these records
 * and the leaves this process signed (never from the on-chain bitmap, which
 * an RPC can fake: audit 4, ID-F1), and refuses before anything is reserved
 * when the bitmap shows used leaves the records do not know
 * (`UnknownLeavesError`); `signAtNextLeaf` combines both.
 *
 * Statuses: `reserved` (no signature was ever released), `signed` (the
 * signature is recorded and may have been revealed), `landed` (this
 * message's signature set the leaf's bit; `attested` says whether it
 * attested or only burned the leaf; `retired` that it was landed on purpose
 * to retire it, `landOrBurnPending`), `burned` (the leaf's bit is set by
 * something else while this record never released a signature: the message
 * moves to another leaf, this one stays reserved).
 *
 * # Every signed window of a launch (audit round 3, review info #2)
 *
 * A signed attestation names its launch and its window inside the 221 signed
 * bytes, and the ledger keeps those bytes: `launchSignatures(ledger, id,
 * launch)` lists every (window, message hash) the identity signed for a
 * launch, read from the signed message itself. Since audit round 3 F1 an
 * attestation whose window passed unused can be replaced, so a signature
 * that was sent but never landed is not inert: once the current window
 * passes, anyone holding it can land it (if its own window still has a
 * minute left) and take the slot first. `buildAttestLaunchTx` therefore
 * refuses to sign a new message for a launch while an earlier signature of
 * it has not landed and its window has not ended (`PendingAttestationError`);
 * `landOrBurnPending` lands them (an attestation, or a burned leaf) first.
 *
 * # Storage
 *
 * `createLeafLedger(store)` runs on any key-value store implementing
 * `LeafLedgerStore`. Its `add` MUST be atomic (write only if absent:
 * IndexedDB `add()`, SQL `INSERT` without `REPLACE`, a compare-and-set):
 * that single primitive guarantees one message per leaf (rule 4, the one
 * that prevents forgeries) even across tabs or devices sharing the store. A
 * record that cannot be parsed is treated as taken, never as free. Ledger
 * operations of one identity are serialized by `opts.lock` (default: an
 * in-process mutex; in a browser pass
 * `(name, fn) => navigator.locks.request(name, fn)`); "one live leaf per
 * message" relies on that lock across tabs, and without it two tabs could at
 * worst spend two leaves on one message (two different one-time keys, no
 * forgery). `storageLeafLedgerStore` (Web Storage) is atomic within one tab
 * only, so `createLeafLedger` refuses it without `opts.lock`. In a browser,
 * also ask for persistent storage (`navigator.storage.persist()`): evicted
 * site data is a lost ledger. Records hold public data only (identity id,
 * leaf, message, signature, slot).
 *
 * # One identity, several devices
 *
 * The same 24 words (or a synced passkey) give the same identity on every
 * device, but each device's ledger only knows its own records. A message's
 * leaf is the first leaf the records do not hold after a SECRET start
 * derived from the identity's SEED and the message (audit 4, ID-F1a: nobody
 * else can predict or steer it), so two devices that never share records
 * sign two different messages at the same leaf with probability about
 * (1 + the run of recorded leaves before it) / 1,024 per message. That is
 * two one-time signatures at one leaf whenever both are revealed (sent,
 * simulated or dropped), and anyone holding both can forge at that leaf.
 * So, ONE device per identity unless its records are synced:
 *
 * - keep ONE ledger per identity (a store every device and tab shares), or
 * - move records between devices: `exportLeafRecords` on the device that
 *   signed, `importLeafRecords` on the other one BEFORE it signs (an import
 *   only ever adds taken leaves: a record without a signature only marks its
 *   leaf taken, never assigns a message; a leaf two devices gave to two
 *   messages is reported, and a local reservation that never signed is
 *   burned there), or
 * - give each device its own identity index (`deriveIdentity(master,
 *   cluster, index)`): indexes never share leaves.
 *
 * When the identity's on-chain bitmap shows a used leaf this ledger never
 * signed at, nothing new is signed (`UnknownLeavesError`, with the counts)
 * until the other device's records are imported or the user confirms
 * (`acknowledgeUnknownLeaves`).
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { PublicKey } from "@solana/web3.js";

import { bytesEqual, fromHex, isUint, toHex } from "../codec/bytes.js";
import { chooseLeaf, identityId, leafUsed, parseAttestationMessage, type LeafChoice } from "./identity.js";
import { withLegacyLock, withLegacyNamespace } from "./legacyNamespace.js";
import { ledgerLock, type LedgerLock } from "./ledgerLock.js";
import { LMS_LEAVES, LMS_PUBLIC_KEY_LEN, LMS_SIGNATURE_LEN, LmsKeyPair, lmsVerify, signLeafDeterministic } from "./lms.js";

export type { LedgerLock } from "./ledgerLock.js";

/** Result of `reserve`. */
export type LeafReservation = "reserved" | "same" | "conflict";

/** See the module docs. */
export type LeafStatus = "reserved" | "signed" | "landed" | "burned";

/** One leaf's record (JSON-safe: hex strings, decimal slot). */
export interface LeafRecord {
  /** Hex of the 32-byte identity id. */
  readonly identityId: string;
  readonly leaf: number;
  /** Hex of SHA-256 of the message this leaf belongs to. */
  readonly messageHash: string;
  readonly status: LeafStatus;
  /** Base58 of the launch, if given at reservation (informational). */
  readonly launch: string | null;
  /** Hex of the signed message, once signed. */
  readonly message: string | null;
  /** Hex of the 2,508-byte signature, once signed. */
  readonly signature: string | null;
  /** Decimal slot of the landing, if known. */
  readonly landedSlot: string | null;
  /** Whether the landing attested (`landed` only; null if unknown). */
  readonly attested: boolean | null;
  /**
   * `landed` on purpose to retire it (`landOrBurnPending`: an older
   * signature of a launch landed while it could only burn its leaf). Not
   * counted against `maxBurnOnlyLandings`. Absent in records of SDK 0.4.0
   * and older.
   */
  readonly retired?: boolean | undefined;
  /** Local wall-clock milliseconds (bookkeeping only). */
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * Key-value storage of a ledger. Values are strings (JSON). `add` must be
 * atomic: write only if `key` is absent and say whether it wrote. The same
 * interface (and one store) serves the vault-key ledger (`./vaultLedger.ts`):
 * keys are namespaced.
 */
export interface LeafLedgerStore {
  get(key: string): Promise<string | null | undefined>;
  add(key: string, value: string): Promise<boolean>;
  put(key: string, value: string): Promise<void>;
  /** Every key starting with `prefix`. */
  keys(prefix: string): Promise<string[]>;
  /**
   * True when `add` is atomic within one JavaScript realm only (Web Storage:
   * one tab). A ledger on such a store requires `opts.lock` shared by every
   * realm (`navigator.locks`).
   */
  readonly singleRealmOnly?: boolean | undefined;
}

/** Durable leaf records (see the module docs). */
export interface LeafLedger {
  /** Reserve `leaf` of `identityId` for the message with this SHA-256, before any signature exists. */
  reserve(identityId: Uint8Array, leaf: number, messageHash: Uint8Array, info?: { launch?: PublicKey | string }): Promise<LeafReservation>;
  get(identityId: Uint8Array, leaf: number): Promise<LeafRecord | null>;
  /** Every record of the identity, by leaf. Throws on a record that cannot be parsed. */
  list(identityId: Uint8Array): Promise<LeafRecord[]>;
  /** Every leaf with a record (parsable or not): leaves a new message must not take. */
  leaves(identityId: Uint8Array): Promise<number[]>;
  /** The message's live record (reserved, signed or landed), else its latest burned one, else null. */
  findByMessage(identityId: Uint8Array, messageHash: Uint8Array): Promise<LeafRecord | null>;
  /** Store the signature of the reserved message (byte-identical if one is already stored). */
  recordSignature(identityId: Uint8Array, leaf: number, message: Uint8Array, signature: Uint8Array): Promise<void>;
  /** This record's message landed at its leaf (`attested`: whether it attested or only burned the leaf; `retired`: landed on purpose to retire it). */
  markLanded(identityId: Uint8Array, leaf: number, info?: { slot?: bigint; attested?: boolean; retired?: boolean }): Promise<void>;
  /** The leaf's bit was set by something else and this record never released a signature. */
  markBurned(identityId: Uint8Array, leaf: number): Promise<void>;
  /**
   * Merge a record exported by another ledger of the same identity (prefer
   * `importLeafRecords`, which authenticates the records first). A leaf this
   * ledger does not know becomes taken: a record without a signature only as
   * `burned` (leaf taken, no message assigned: nothing authenticates which
   * message it was for; audit 4, ID-F3), a signed one as `signed` (its
   * landing claims are not trusted: the landing is read from the chain
   * again). A record of the same message is completed with its signature. A
   * leaf the two ledgers gave to two signed messages is a `conflict` (and this
   * ledger's record, if it never signed, is burned: the message moves to
   * another leaf). An import never re-points the message index of a message
   * that holds a live record at another leaf (ID-F2b).
   */
  importRecord(record: LeafRecord): Promise<LeafImportOutcome>;
}

/** What `importRecord` did with one record. */
export interface LeafImportOutcome {
  readonly leaf: number;
  /** `added`: the leaf was unknown here; `merged`: this ledger's record of the same message was completed; `unchanged`; `conflict`: the leaf belongs to two messages. */
  readonly outcome: "added" | "merged" | "unchanged" | "conflict";
  /** Two signatures exist at this leaf (two messages, or one message twice): anyone holding both can forge at it. */
  readonly compromised: boolean;
}

/** A leaf or message already belongs elsewhere. */
export class LeafConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeafConflictError";
  }
}

/** A record is missing, unreadable, or a transition breaks the rule. */
export class LeafLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeafLedgerError";
  }
}

const NAMESPACE = "noised/pq/leaf-ledger/v1/";
const STATUSES: readonly LeafStatus[] = ["reserved", "signed", "landed", "burned"];

function idHex(identityId: Uint8Array): string {
  if (!(identityId instanceof Uint8Array) || identityId.length !== 32) throw new RangeError("identity id must be 32 bytes");
  return toHex(identityId);
}

function hashHex(messageHash: Uint8Array): string {
  if (!(messageHash instanceof Uint8Array) || messageHash.length !== 32) throw new RangeError("message hash must be 32 bytes (SHA-256 of the message)");
  return toHex(messageHash);
}

function checkLeaf(leaf: number): void {
  if (!isUint(leaf, LMS_LEAVES - 1)) throw new RangeError(`leaf must be in 0..${LMS_LEAVES - 1}`);
}

const leafPrefix = (id: string) => `${NAMESPACE}leaf/${id}/`;
const leafKey = (id: string, leaf: number) => `${leafPrefix(id)}${String(leaf).padStart(4, "0")}`;
const messageKey = (id: string, mh: string) => `${NAMESPACE}message/${id}/${mh}`;

const isHex = (s: unknown, len: number): s is string => typeof s === "string" && s.length === len && /^[0-9a-f]*$/.test(s);

function parseRecord(raw: string, id: string, leaf: number): LeafRecord {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new LeafLedgerError(`leaf record ${id}/${leaf} is not JSON`);
  }
  const r = v as Partial<Record<keyof LeafRecord, unknown>>;
  const ok =
    typeof v === "object" &&
    v !== null &&
    r.identityId === id &&
    r.leaf === leaf &&
    isHex(r.messageHash, 64) &&
    STATUSES.includes(r.status as LeafStatus) &&
    (r.launch === null || typeof r.launch === "string") &&
    (r.message === null || (typeof r.message === "string" && /^[0-9a-f]*$/.test(r.message))) &&
    (r.signature === null || isHex(r.signature, 2 * LMS_SIGNATURE_LEN)) &&
    (r.landedSlot === null || (typeof r.landedSlot === "string" && /^[0-9]+$/.test(r.landedSlot))) &&
    (r.attested === null || typeof r.attested === "boolean") &&
    (r.retired === undefined || typeof r.retired === "boolean") &&
    typeof r.createdAt === "number" &&
    typeof r.updatedAt === "number";
  if (!ok) throw new LeafLedgerError(`leaf record ${id}/${leaf} is malformed`);
  return r as LeafRecord;
}

/** Options of `createLeafLedger`. */
export interface LeafLedgerOptions {
  /**
   * Serializes the ledger operations of one identity (name =
   * `noised/pq/leaf-ledger/v1/<identity id hex>`). Default: an in-process
   * mutex; required (a lock shared by every tab, `navigator.locks`) when the
   * store is `singleRealmOnly`.
   */
  lock?: LedgerLock | undefined;
  /** Wall clock in milliseconds (bookkeeping fields only). */
  now?: () => number;
}

/** A ledger on `store` (see `LeafLedgerStore` for the atomicity it needs). */
export function createLeafLedger(rawStore: LeafLedgerStore, opts: LeafLedgerOptions = {}): LeafLedger {
  const lock = withLegacyLock(ledgerLock(rawStore, opts.lock, "createLeafLedger"));
  // Records of the earlier name (`phalanx/pq/leaf-ledger/v1/`) are migrated and honoured: see legacyNamespace.ts.
  const store = withLegacyNamespace(rawStore, NAMESPACE);
  const now = opts.now ?? (() => Date.now());
  const locked = <T>(id: string, fn: () => Promise<T>): Promise<T> => lock(`${NAMESPACE}${id}`, fn);

  const read = async (id: string, leaf: number): Promise<LeafRecord | null> => {
    const raw = await store.get(leafKey(id, leaf));
    return raw === null || raw === undefined ? null : parseRecord(raw, id, leaf);
  };

  const mustRead = async (id: string, leaf: number): Promise<LeafRecord> => {
    const rec = await read(id, leaf);
    if (rec === null) throw new LeafLedgerError(`leaf ${leaf} of identity ${id} has no record: reserve it first`);
    return rec;
  };

  const write = (rec: LeafRecord): Promise<void> => store.put(leafKey(rec.identityId, rec.leaf), JSON.stringify(rec));

  const leavesOf = async (id: string): Promise<number[]> => {
    const prefix = leafPrefix(id);
    const out = new Set<number>();
    for (const k of await store.keys(prefix)) {
      const tail = k.slice(prefix.length);
      if (!/^[0-9]{4}$/.test(tail)) continue;
      const q = Number(tail);
      if (q < LMS_LEAVES) out.add(q);
    }
    return [...out].sort((a, b) => a - b);
  };

  const listOf = async (id: string): Promise<LeafRecord[]> => {
    const out: LeafRecord[] = [];
    for (const q of await leavesOf(id)) {
      const rec = await read(id, q);
      if (rec !== null) out.push(rec);
    }
    return out;
  };

  const live = holdsMessageLeaf;

  const findMessage = async (id: string, mh: string): Promise<LeafRecord | null> => {
    const indexed = await store.get(messageKey(id, mh));
    if (indexed !== null && indexed !== undefined && /^[0-9]+$/.test(indexed) && Number(indexed) < LMS_LEAVES) {
      const rec = await read(id, Number(indexed));
      if (rec !== null && rec.messageHash === mh && live(rec)) return rec;
    }
    // The index is a hint (written after the leaf record): fall back to a scan.
    const all = (await listOf(id)).filter((r) => r.messageHash === mh);
    return all.find(live) ?? all.sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
  };

  return {
    async reserve(identityId, leaf, messageHash, info = {}) {
      const id = idHex(identityId);
      const mh = hashHex(messageHash);
      checkLeaf(leaf);
      const launch = info.launch === undefined ? null : typeof info.launch === "string" ? new PublicKey(info.launch).toBase58() : info.launch.toBase58();
      return locked(id, async (): Promise<LeafReservation> => {
        const verdict = (raw: string | null | undefined): LeafReservation | null => {
          if (raw === null || raw === undefined) return null;
          try {
            return parseRecord(raw, id, leaf).messageHash === mh ? "same" : "conflict";
          } catch {
            return "conflict"; // unreadable: taken, never free
          }
        };
        const existing = verdict(await store.get(leafKey(id, leaf)));
        if (existing !== null) return existing;
        const other = await findMessage(id, mh);
        if (other !== null && other.leaf !== leaf && live(other)) return "conflict";
        const t = now();
        const rec: LeafRecord = {
          identityId: id,
          leaf,
          messageHash: mh,
          status: "reserved",
          launch,
          message: null,
          signature: null,
          landedSlot: null,
          attested: null,
          createdAt: t,
          updatedAt: t,
        };
        if (!(await store.add(leafKey(id, leaf), JSON.stringify(rec)))) {
          return verdict(await store.get(leafKey(id, leaf))) ?? "conflict";
        }
        await store.put(messageKey(id, mh), String(leaf));
        return "reserved";
      });
    },

    async get(identityId, leaf) {
      const id = idHex(identityId);
      checkLeaf(leaf);
      return read(id, leaf);
    },

    async list(identityId) {
      return listOf(idHex(identityId));
    },

    async leaves(identityId) {
      return leavesOf(idHex(identityId));
    },

    async findByMessage(identityId, messageHash) {
      return findMessage(idHex(identityId), hashHex(messageHash));
    },

    async recordSignature(identityId, leaf, message, signature) {
      const id = idHex(identityId);
      checkLeaf(leaf);
      if (!(message instanceof Uint8Array)) throw new TypeError("message must be a Uint8Array");
      if (!(signature instanceof Uint8Array) || signature.length !== LMS_SIGNATURE_LEN) throw new RangeError(`signature must be ${LMS_SIGNATURE_LEN} bytes`);
      return locked(id, async () => {
        const rec = await mustRead(id, leaf);
        if (rec.messageHash !== toHex(sha256(message))) throw new LeafConflictError(`leaf ${leaf} is reserved for another message: never sign a second message at a leaf`);
        const sigHex = toHex(signature);
        if (rec.signature !== null) {
          if (rec.signature !== sigHex) throw new LeafLedgerError(`leaf ${leaf} already holds a different signature of this message: two signatures at one leaf are forgeries`);
          return;
        }
        if (rec.status !== "reserved") throw new LeafLedgerError(`leaf ${leaf} is ${rec.status} without a signature: never sign at it`);
        await write({ ...rec, status: "signed", message: toHex(message), signature: sigHex, updatedAt: now() });
      });
    },

    async markLanded(identityId, leaf, info = {}) {
      const id = idHex(identityId);
      checkLeaf(leaf);
      if (info.slot !== undefined && (typeof info.slot !== "bigint" || info.slot < 0n)) throw new RangeError("slot must be a non-negative bigint");
      if (info.retired === true && info.attested === true) throw new LeafLedgerError(`leaf ${leaf}: a landing that attested is not a retired one`);
      return locked(id, async () => {
        const rec = await mustRead(id, leaf);
        if (rec.status === "burned") throw new LeafLedgerError(`leaf ${leaf} was marked burned by something else: it cannot have landed this message`);
        if (rec.signature === null) throw new LeafLedgerError(`leaf ${leaf} holds no signature: nothing of this record can have landed`);
        await write({
          ...rec,
          status: "landed",
          landedSlot: info.slot === undefined ? rec.landedSlot : info.slot.toString(),
          attested: info.attested ?? rec.attested,
          ...(info.retired === true || rec.retired === true ? { retired: true } : {}),
          updatedAt: now(),
        });
      });
    },

    async markBurned(identityId, leaf) {
      const id = idHex(identityId);
      checkLeaf(leaf);
      return locked(id, async () => {
        const rec = await mustRead(id, leaf);
        if (rec.status === "burned") return;
        if (rec.status === "landed") throw new LeafLedgerError(`leaf ${leaf} landed this record's message; it is not burned by something else`);
        await write({ ...rec, status: "burned", updatedAt: now() });
      });
    },

    async importRecord(record) {
      if (record === null || typeof record !== "object") throw new TypeError("record must be a LeafRecord");
      if (!isHex(record.identityId, 64)) throw new LeafLedgerError("imported record: identityId must be 64 lower-case hex characters");
      const id = record.identityId;
      checkLeaf(record.leaf);
      const leaf = record.leaf;
      const incoming = parseRecord(JSON.stringify(record), id, leaf);
      if (incoming.signature !== null && (incoming.message === null || toHex(sha256(fromHex(incoming.message))) !== incoming.messageHash)) {
        throw new LeafLedgerError(`imported leaf record ${id}/${leaf}: its message does not hash to its message hash`);
      }
      // Audit 4, ID-F3: a record that never released a signature only marks its leaf taken here (status burned, no
      // message assigned): nothing authenticates which message it was for. A signed record is authenticated (its
      // signature), but its landing claims are not: it comes in as "signed" and a landing is read from the chain
      // again (ID-F4: an old signature stays pending until its landing is seen with its outcome).
      const taken: LeafRecord | null =
        incoming.signature === null
          ? { ...incoming, status: "burned", message: null, landedSlot: null, attested: null, retired: undefined }
          : null;
      const claimed: LeafRecord = taken ?? { ...incoming, status: "signed", landedSlot: null, attested: null, retired: undefined };
      return locked(id, async (): Promise<LeafImportOutcome> => {
        // ID-F2b: an import never re-points the index of a message that holds a live record at another leaf.
        const pointIfFree = async (rec: LeafRecord): Promise<void> => {
          if (!live(rec)) return;
          const current = await findMessage(id, rec.messageHash);
          if (current !== null && current.leaf !== rec.leaf && live(current)) return;
          await store.put(messageKey(id, rec.messageHash), String(rec.leaf));
        };
        for (let attempt = 0; attempt < 2; attempt++) {
          const raw = await store.get(leafKey(id, leaf));
          if (raw === null || raw === undefined) {
            const rec: LeafRecord = { ...claimed, updatedAt: now() };
            if (!(await store.add(leafKey(id, leaf), JSON.stringify(rec)))) continue; // added meanwhile: merge with it
            await pointIfFree(rec);
            return { leaf, outcome: "added", compromised: false };
          }
          let local: LeafRecord;
          try {
            local = parseRecord(raw, id, leaf);
          } catch {
            return { leaf, outcome: "conflict", compromised: false }; // unreadable here: taken, never free
          }
          // An unsigned record adds nothing to a leaf this ledger already holds (the leaf is taken either way).
          if (taken !== null) return { leaf, outcome: "unchanged", compromised: false };
          if (local.messageHash === claimed.messageHash) {
            if (local.signature !== null && local.signature !== claimed.signature) {
              return { leaf, outcome: "conflict", compromised: true }; // one message signed twice at one leaf
            }
            const status: LeafStatus = local.status === "landed" ? "landed" : "signed";
            const merged: LeafRecord = { ...local, status, message: local.message ?? claimed.message, signature: claimed.signature };
            const same = (["status", "message", "signature"] as const).every((k) => merged[k] === local[k]);
            if (same) return { leaf, outcome: "unchanged", compromised: false };
            await write({ ...merged, updatedAt: now() });
            await pointIfFree(merged);
            return { leaf, outcome: "merged", compromised: false };
          }
          // Two messages at one leaf: this ledger's record must never sign once the other one did.
          if (local.signature === null && local.status !== "burned") {
            await write({ ...local, status: "burned", updatedAt: now() });
          }
          return { leaf, outcome: "conflict", compromised: local.signature !== null };
        }
        return { leaf, outcome: "conflict", compromised: false };
      });
    },
  };
}

/**
 * Whether a record still holds its message's leaf: it is not burned, and it
 * is not a landing that only burned the leaf (`landed` with `attested:
 * false`). The message of a record that does not may be signed again at a
 * new leaf (rule 4).
 */
export function holdsMessageLeaf(r: Pick<LeafRecord, "status" | "attested">): boolean {
  return r.status !== "burned" && !(r.status === "landed" && r.attested === false);
}

// -------------------------------------------------------------- stores ---

/** An in-memory `LeafLedgerStore` (tests, or a session that persists elsewhere). */
export function memoryLeafLedgerStore(): LeafLedgerStore {
  const m = new Map<string, string>();
  return {
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
  };
}

/** The subset of Web Storage (`localStorage`) a store needs. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  key(index: number): string | null;
  readonly length: number;
}

/**
 * A store on Web Storage. `add` is check-then-set: atomic within one tab
 * (synchronous), but NOT across tabs, so the store is `singleRealmOnly` and a
 * ledger on it requires a cross-tab lock
 * (`opts.lock = (name, fn) => navigator.locks.request(name, fn)`). `setItem`
 * throws when the quota is full: the ledger then refuses to reserve, and
 * nothing is signed. Ask for persistent storage
 * (`navigator.storage.persist()`) so the browser does not evict the ledger.
 */
export function storageLeafLedgerStore(storage: StorageLike): LeafLedgerStore {
  return {
    singleRealmOnly: true,
    get: (key) => Promise.resolve(storage.getItem(key)),
    add: (key, value) => {
      if (storage.getItem(key) !== null) return Promise.resolve(false);
      storage.setItem(key, value);
      return Promise.resolve(true);
    },
    put: (key, value) => {
      storage.setItem(key, value);
      return Promise.resolve();
    },
    keys: (prefix) => {
      const out: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k !== null && k.startsWith(prefix)) out.push(k);
      }
      return Promise.resolve(out);
    },
  };
}

/** `createLeafLedger(memoryLeafLedgerStore())`. */
export function createMemoryLeafLedger(opts: LeafLedgerOptions = {}): LeafLedger {
  return createLeafLedger(memoryLeafLedgerStore(), opts);
}

// --------------------------------------------------------------- signing ---

/**
 * `<identity id hex>/<leaf>` -> hex SHA-256 of the one message this process
 * signed, or returned a recorded signature of, at that leaf. Whatever ledger
 * a later call is given (a fresh memory ledger per attempt, a cleared store,
 * a custom `LeafLedger` that does not keep the contract), this process never
 * signs a second message at a leaf.
 */
const leavesThisSession = new Map<string, string>();

/**
 * Reserve `leaf` for `message`, then sign it, then record the signature, and
 * only then return it (the rule's steps 1-3). Signing the same message at the
 * same leaf again returns the recorded bytes (checked to equal a fresh
 * deterministic signature). Throws `LeafConflictError` when the leaf belongs
 * to another message or the message holds another live leaf, and refuses to
 * sign at a leaf whose record is burned or landed without a signature.
 *
 * It trusts no ledger blindly: the record read back after the reservation
 * must be this identity's record of this leaf for exactly this message
 * (`LeafLedgerError` otherwise), and, in one process, a leaf that signed (or
 * returned a signature of) one message never signs another, whatever ledger
 * is passed (`LeafConflictError`, before anything is written). `message` is
 * copied at entry.
 */
export async function reserveAndSign(ledger: LeafLedger, keyPair: LmsKeyPair, leaf: number, message: Uint8Array, info: { launch?: PublicKey | string } = {}): Promise<Uint8Array> {
  if (!(message instanceof Uint8Array)) throw new TypeError("message must be a Uint8Array");
  checkLeaf(leaf);
  const msg = Uint8Array.from(message);
  const id = keyPair.identityId;
  const idH = toHex(id);
  const mh = sha256(msg);
  const mhHex = toHex(mh);
  const slot = `${idH}/${leaf}`;
  const notSignedElsewhere = (): void => {
    const previous = leavesThisSession.get(slot);
    if (previous !== undefined && previous !== mhHex) {
      throw new LeafConflictError(`leaf ${leaf} already signed a different message in this process: never sign a second message at a leaf (whatever the ledger says)`);
    }
  };
  notSignedElsewhere(); // before the reservation: nothing is written for a message this process must never sign
  const r = await ledger.reserve(id, leaf, mh, info);
  if (r === "conflict") {
    throw new LeafConflictError(`leaf ${leaf} belongs to another message, or this message already holds another leaf: never sign a second message at a leaf (use findByMessage / selectLeaf)`);
  }
  const rec = await ledger.get(id, leaf);
  if (rec === null) throw new LeafLedgerError(`leaf ${leaf}: the reservation was not persisted`);
  if (rec.identityId !== idH || rec.leaf !== leaf || rec.messageHash !== mhHex) {
    throw new LeafLedgerError(`leaf ${leaf}: the ledger's record is not this identity's reservation of this leaf for this message (a ledger that does not keep the leaf-ledger contract): nothing was signed`);
  }
  notSignedElsewhere();
  if (rec.signature !== null) {
    const recorded = fromHex(rec.signature);
    if (!bytesEqual(signLeafDeterministic(keyPair, leaf, msg), recorded)) {
      throw new LeafLedgerError(`leaf ${leaf}: the recorded signature is not this key's deterministic signature of this message (another key, or a corrupted record)`);
    }
    leavesThisSession.set(slot, mhHex);
    return recorded;
  }
  if (rec.status !== "reserved") throw new LeafLedgerError(`leaf ${leaf} is ${rec.status} and holds no signature: never sign at it`);
  leavesThisSession.set(slot, mhHex); // synchronously, right before the signature exists
  const signature = signLeafDeterministic(keyPair, leaf, msg);
  await ledger.recordSignature(id, leaf, msg, signature);
  return signature;
}

/** Where a message's signature goes, from `selectLeaf`. */
export type LeafSelection =
  /** The message already holds this leaf: retry it (same leaf, same bytes). `onChain`: the leaf's bit is set (check the attestation, then `markLanded` or `markBurned`). */
  | { readonly kind: "existing"; readonly leaf: number; readonly record: LeafRecord; readonly onChain: boolean; readonly choice: LeafChoice }
  /** A leaf clear on-chain and absent from the records. */
  | { readonly kind: "fresh"; readonly leaf: number; readonly choice: LeafChoice }
  /** No leaf left: move to the next identity index. */
  | { readonly kind: "exhausted"; readonly choice: LeafChoice };

/** Leaves of `idHex` this process signed (or returned a signature of) a message other than `mhHex` at. */
function leavesTakenThisSession(idHex: string, mhHex: string): number[] {
  const out: number[] = [];
  const prefix = `${idHex}/`;
  for (const [slot, signed] of leavesThisSession) if (slot.startsWith(prefix) && signed !== mhHex) out.push(Number(slot.slice(prefix.length)));
  return out;
}

/**
 * Nothing was signed: the identity's on-chain bitmap shows used leaves this
 * ledger (and this process) never signed at, or the leaf the message would
 * take is set on-chain (audit 4, ID-F1). Another device, or a cleared store,
 * signed with this identity, and its signatures that never landed are
 * invisible here: a new signature could meet one of them at a leaf. (An RPC
 * that lies about the bitmap gets the same answer: nothing is signed.) Import
 * that device's records (`importLeafRecords`), or, once the user confirmed no
 * other device holds signatures that have not landed, mark these leaves taken
 * (`acknowledgeUnknownLeaves` with `expectedCount: unknownCount`), then try
 * again.
 */
export class UnknownLeavesError extends Error {
  /** The identity (32-byte id). */
  readonly identityId: Uint8Array;
  /** Leaves set on-chain that this ledger and this process never signed at (ascending). */
  readonly unknownLeaves: number[];
  /** `unknownLeaves.length`: what the UI shows and `acknowledgeUnknownLeaves` expects. */
  readonly unknownCount: number;
  /** Leaves set on-chain in total. */
  readonly usedOnChain: number;
  /** Leaves this ledger holds a record of. */
  readonly knownToLedger: number;
  /** The leaf the message would take (null: none left). */
  readonly chosenLeaf: number | null;
  /** That leaf is itself set on-chain. */
  readonly chosenLeafSetOnChain: boolean;
  constructor(identityId: Uint8Array, unknownLeaves: number[], usedOnChain: number, knownToLedger: number, chosenLeaf: number | null, chosenLeafSetOnChain: boolean) {
    const n = unknownLeaves.length;
    super(
      `Nothing was signed: this quantum key was used elsewhere. ${n} signature${n === 1 ? "" : "s"} on the chain ${n === 1 ? "is" : "are"} not in this device's records (another device, or this browser's data was cleared)${
        chosenLeafSetOnChain ? ", including the slot this signature would use" : ""
      }. Import the other device's records first (importLeafRecords). If you are sure every signature made elsewhere has landed, confirm it (acknowledgeUnknownLeaves) and try again.`,
    );
    this.name = "UnknownLeavesError";
    this.identityId = identityId;
    this.unknownLeaves = unknownLeaves;
    this.unknownCount = n;
    this.usedOnChain = usedOnChain;
    this.knownToLedger = knownToLedger;
    this.chosenLeaf = chosenLeaf;
    this.chosenLeafSetOnChain = chosenLeafSetOnChain;
  }
}

/**
 * Leaves set in `used` that this ledger and this process never signed at:
 * no record at all (and not signed in this process), or a `reserved` record
 * that never released a signature (something else set its bit). Records
 * holding a signature, `burned` records (already acknowledged as someone
 * else's) and unreadable records (taken, never free) count as known.
 */
async function unknownUsedLeaves(ledger: LeafLedger, id: Uint8Array, used: Uint8Array, ledgerLeaves: ReadonlySet<number>): Promise<number[]> {
  const idH = toHex(id);
  const out: number[] = [];
  for (let q = 0; q < LMS_LEAVES; q++) {
    if (!leafUsed(used, q) || leavesThisSession.has(`${idH}/${q}`)) continue;
    if (!ledgerLeaves.has(q)) {
      out.push(q);
      continue;
    }
    let rec: LeafRecord | null;
    try {
      rec = await ledger.get(id, q);
    } catch {
      continue; // unreadable: taken
    }
    if (rec === null || (rec.status === "reserved" && rec.signature === null)) out.push(q);
  }
  return out;
}

/**
 * The leaf for `message` signed by `keyPair`, given the identity account's
 * bitmap `used` (all zero when the account does not exist yet), chosen from
 * the LEDGER and this process's signatures only (audit 4, ID-F1): the
 * message's own record if it holds a live one with its signature
 * (`holdsMessageLeaf`; a rebuild: same leaf, same bytes, never refused),
 * else the first leaf from the message's SECRET probe start
 * (`keyPair.leafProbeStart`) absent from the records and from this
 * process's signatures. The bitmap never moves the choice; before anything
 * new is reserved or signed it is compared: if it shows any used leaf this
 * ledger never signed at (`unknownUsedLeaves`), or the chosen leaf (a fresh
 * one, or the message's reserved one) is set, this throws
 * `UnknownLeavesError`. Leaves this process signed another message at count
 * as taken, even when `ledger` has no record of them.
 */
export async function selectLeaf(ledger: LeafLedger, args: { keyPair: LmsKeyPair; message: Uint8Array; used: Uint8Array }): Promise<LeafSelection> {
  const keyPair = args.keyPair;
  if (!(keyPair instanceof LmsKeyPair)) {
    throw new TypeError("selectLeaf needs { keyPair, message, used } (since 0.9.0 the leaf probe is secret: pass the identity's keyPair, not its public key)");
  }
  const id = identityId(keyPair.publicKey);
  const mh = sha256(args.message);
  const ledgerLeaves = new Set(await ledger.leaves(id));
  const taken = [...new Set([...ledgerLeaves, ...leavesTakenThisSession(toHex(id), toHex(mh))])].sort((x, y) => x - y);
  const simple = chooseLeaf(keyPair, args.message, args.used, taken);
  const unknownUsed = await unknownUsedLeaves(ledger, id, args.used, ledgerLeaves);
  const choice: LeafChoice = { ...simple, unknownUsed };
  const refuse = (leaf: number | null): UnknownLeavesError =>
    new UnknownLeavesError(id, unknownUsed, choice.usedCount, ledgerLeaves.size, leaf, leaf !== null && leafUsed(args.used, leaf));
  const mine = await ledger.findByMessage(id, mh);
  if (mine !== null && holdsMessageLeaf(mine)) {
    const onChain = leafUsed(args.used, mine.leaf);
    // A recorded signature is re-sent, never made again: no check can make it more revealed than it is.
    if (mine.signature !== null) return { kind: "existing", leaf: mine.leaf, record: mine, onChain, choice };
    // Reserved, never signed: signing it now makes the first signature at that leaf.
    if (onChain || unknownUsed.length > 0) throw refuse(mine.leaf);
    return { kind: "existing", leaf: mine.leaf, record: mine, onChain, choice };
  }
  if (choice.leaf === null) return { kind: "exhausted", choice };
  if (choice.leafSetOnChain || unknownUsed.length > 0) throw refuse(choice.leaf);
  return { kind: "fresh", leaf: choice.leaf, choice };
}

/** What `acknowledgeUnknownLeaves` marked taken. */
export interface AcknowledgedLeaves {
  /** Leaves recorded as taken (burned, no message) that had no record. */
  readonly added: number[];
  /** Reserved records (never signed) whose bit was set: marked burned. */
  readonly burned: number[];
}

/**
 * After the user confirmed it (audit 4, ID-F1c: "this key was used
 * elsewhere"), record every leaf `used` shows that this ledger never signed
 * at as taken, so new signatures can be made again: a leaf without a record
 * gets a `burned` record with no message, a `reserved` record that never
 * signed is marked burned. `expectedCount` must equal the number of such
 * leaves now (`UnknownLeavesError.unknownCount`, as shown to the user), so a
 * confirmation never covers leaves the user did not see. Only confirm when
 * no other device holds signatures of this identity that have not landed
 * (better: import its records, `importLeafRecords`).
 */
export async function acknowledgeUnknownLeaves(
  ledger: LeafLedger,
  publicKey: Uint8Array,
  used: Uint8Array,
  opts: { readonly expectedCount: number },
): Promise<AcknowledgedLeaves> {
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== LMS_PUBLIC_KEY_LEN) throw new RangeError(`publicKey must be the ${LMS_PUBLIC_KEY_LEN}-byte LMS public key`);
  if (opts === null || typeof opts !== "object" || !Number.isInteger(opts.expectedCount) || opts.expectedCount < 0) {
    throw new TypeError("pass { expectedCount }: the number of unknown leaves the user confirmed (UnknownLeavesError.unknownCount)");
  }
  const id = identityId(publicKey);
  const ledgerLeaves = new Set(await ledger.leaves(id));
  const unknown = await unknownUsedLeaves(ledger, id, used, ledgerLeaves);
  if (unknown.length !== opts.expectedCount) {
    throw new LeafLedgerError(`the chain now shows ${unknown.length} unknown used leaf/leaves, not the ${opts.expectedCount} confirmed: show the new count and confirm again`);
  }
  const idH = toHex(id);
  const added: number[] = [];
  const burned: number[] = [];
  for (const q of unknown) {
    if (ledgerLeaves.has(q)) {
      await ledger.markBurned(id, q);
      burned.push(q);
      continue;
    }
    const t = Date.now();
    const o = await ledger.importRecord({
      identityId: idH,
      leaf: q,
      messageHash: "0".repeat(64),
      status: "burned",
      launch: null,
      message: null,
      signature: null,
      landedSlot: null,
      attested: null,
      createdAt: t,
      updatedAt: t,
    });
    if (o.outcome === "added") added.push(q);
  }
  return { added, burned };
}

/** Result of `signAtNextLeaf`. */
export interface LeafSignature {
  readonly leaf: number;
  /** 2,508-byte LMS signature, recorded in the ledger before it was returned. */
  readonly signature: Uint8Array;
  readonly selection: LeafSelection;
}

/**
 * `selectLeaf`, then `reserveAndSign` at that leaf (retrying the selection if
 * another tab took the leaf in between). Throws when the identity is
 * exhausted, and `UnknownLeavesError` (before anything is reserved) when the
 * bitmap shows used leaves this ledger never signed at. When
 * `selection.onChain` is true the leaf's bit is already set: check the
 * attestation before broadcasting again.
 */
export async function signAtNextLeaf(
  ledger: LeafLedger,
  keyPair: LmsKeyPair,
  message: Uint8Array,
  used: Uint8Array,
  info: { launch?: PublicKey | string } = {},
): Promise<LeafSignature> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const selection = await selectLeaf(ledger, { keyPair, message, used });
    if (selection.kind === "exhausted") throw new LeafLedgerError("every leaf of this identity is used: move to the next identity index");
    try {
      return { leaf: selection.leaf, signature: await reserveAndSign(ledger, keyPair, selection.leaf, message, info), selection };
    } catch (e) {
      if (!(e instanceof LeafConflictError) || selection.kind === "existing") throw e;
    }
  }
  throw new LeafLedgerError("could not reserve a leaf: other writers keep taking them");
}

/** Records whose signature may be revealed but has not been seen landing: land these before choosing new leaves (A13 step 3). */
export async function pendingSignatures(ledger: LeafLedger, identityId: Uint8Array): Promise<LeafRecord[]> {
  return (await ledger.list(identityId)).filter((r) => r.status === "signed");
}

/** One attestation signature the ledger holds for a launch (`launchSignatures`). */
export interface LaunchSignature {
  readonly leaf: number;
  /** SHA-256 of the signed 221-byte message (v3). */
  readonly messageHash: Uint8Array;
  /** The window the signature attests, read from the signed bytes (unix seconds, inclusive). */
  readonly window: { readonly notBefore: bigint; readonly notAfter: bigint };
  /** The metadata record's hash the signature names. */
  readonly metadataHash: Uint8Array;
  /** The creator rules' hash the signature names (all zero: none). */
  readonly rulesHash: Uint8Array;
  /** The 221 signed bytes. */
  readonly message: Uint8Array;
  /** The 2,508-byte LMS signature. */
  readonly signature: Uint8Array;
  /** The record (its status says what the ledger saw: `signed` = never seen landing). */
  readonly record: LeafRecord;
}

/**
 * Every (window, message hash) the identity signed for `launch`, from the
 * ledger's records: each record holding a signature whose message is an
 * attestation message (`PHX-ATTEST-V3`) of `launch`. The window and the
 * launch are read from the signed message itself, never from bookkeeping
 * fields, so they cannot disagree with what was signed. Oldest first.
 * Records without a signature never released one and are not listed.
 */
export async function launchSignatures(ledger: LeafLedger, identityId: Uint8Array, launch: PublicKey): Promise<LaunchSignature[]> {
  if (!(launch instanceof PublicKey)) throw new TypeError("launch must be a PublicKey");
  const out: LaunchSignature[] = [];
  for (const r of await ledger.list(identityId)) {
    if (r.signature === null || r.message === null) continue;
    const message = fromHex(r.message);
    let f: ReturnType<typeof parseAttestationMessage>;
    try {
      f = parseAttestationMessage(message);
    } catch {
      continue; // another kind of message
    }
    if (!f.launch.equals(launch)) continue;
    out.push({
      leaf: r.leaf,
      messageHash: fromHex(r.messageHash),
      window: { notBefore: f.notBefore, notAfter: f.notAfter },
      metadataHash: f.metadataHash,
      rulesHash: f.rulesHash,
      message,
      signature: fromHex(r.signature),
      record: r,
    });
  }
  return out.sort((a, b) => a.record.createdAt - b.record.createdAt || a.leaf - b.leaf);
}

// ------------------------------------------------------ several devices ---

/** Format tag of `exportLeafRecords`. */
export const LEAF_LEDGER_EXPORT_FORMAT = "noised/pq/leaf-ledger-export/v1";
/** The same format as exported before the rename to Noised (still imported). */
export const LEGACY_LEAF_LEDGER_EXPORT_FORMAT = "phalanx/pq/leaf-ledger-export/v1";

/** Every record of one identity, to carry to another device (JSON-safe; public data only). */
export interface LeafLedgerExport {
  /** `LEAF_LEDGER_EXPORT_FORMAT` (exports made before the rename carry `LEGACY_LEAF_LEDGER_EXPORT_FORMAT`; both import). */
  readonly format: typeof LEAF_LEDGER_EXPORT_FORMAT | typeof LEGACY_LEAF_LEDGER_EXPORT_FORMAT;
  /** Hex of the identity id. */
  readonly identityId: string;
  readonly records: readonly LeafRecord[];
}

/** Every record of `identityId` in `ledger`, for `importLeafRecords` on another device. */
export async function exportLeafRecords(ledger: LeafLedger, identityId: Uint8Array): Promise<LeafLedgerExport> {
  return { format: LEAF_LEDGER_EXPORT_FORMAT, identityId: idHex(identityId), records: await ledger.list(identityId) };
}

/** What `importLeafRecords` did. */
export interface LeafImportSummary {
  readonly added: number;
  readonly merged: number;
  readonly unchanged: number;
  /** Leaves the two ledgers gave to two messages (this ledger's record, if it never signed, was burned). */
  readonly conflicts: number[];
  /** Leaves holding two signatures: anyone holding both can forge at them (move launches to a fresh identity index). */
  readonly compromised: number[];
}

/**
 * Merge `exported` (another device's `exportLeafRecords` of the identity
 * whose 56-byte LMS key is `publicKey`) into `ledger`, before this device
 * signs anything with that identity. Every record is authenticated first,
 * and nothing is written if one fails: it must belong to this identity, and
 * a signed one must hash to its message hash and verify at its leaf under
 * `publicKey`. An import only adds taken leaves and completes records; it
 * never frees or reassigns a leaf.
 */
export async function importLeafRecords(ledger: LeafLedger, publicKey: Uint8Array, exported: LeafLedgerExport): Promise<LeafImportSummary> {
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== LMS_PUBLIC_KEY_LEN) throw new RangeError(`publicKey must be the ${LMS_PUBLIC_KEY_LEN}-byte LMS public key`);
  if (
    exported === null ||
    typeof exported !== "object" ||
    (exported.format !== LEAF_LEDGER_EXPORT_FORMAT && (exported.format as string) !== LEGACY_LEAF_LEDGER_EXPORT_FORMAT) ||
    !Array.isArray(exported.records)
  ) {
    throw new LeafLedgerError(`not a leaf-ledger export (format ${LEAF_LEDGER_EXPORT_FORMAT})`);
  }
  const id = toHex(identityId(publicKey));
  if (exported.identityId !== id) throw new LeafLedgerError("the export belongs to another identity");
  for (const r of exported.records) {
    if (r === null || typeof r !== "object" || r.identityId !== id) throw new LeafLedgerError("the export holds a record of another identity");
    checkLeaf(r.leaf);
    parseRecord(JSON.stringify(r), id, r.leaf);
    if (r.signature !== null) {
      if (r.message === null) throw new LeafLedgerError(`leaf ${r.leaf}: a signature without its message`);
      const message = fromHex(r.message);
      if (toHex(sha256(message)) !== r.messageHash) throw new LeafLedgerError(`leaf ${r.leaf}: the message does not hash to the record's message hash`);
      if (lmsVerify(publicKey, message, fromHex(r.signature)) !== r.leaf) throw new LeafLedgerError(`leaf ${r.leaf}: the signature does not verify at this leaf under this identity`);
    }
  }
  const summary = { added: 0, merged: 0, unchanged: 0, conflicts: [] as number[], compromised: [] as number[] };
  for (const r of exported.records) {
    const o = await ledger.importRecord(r);
    if (o.outcome === "conflict") summary.conflicts.push(o.leaf);
    else summary[o.outcome]++;
    if (o.compromised) summary.compromised.push(o.leaf);
  }
  return summary;
}

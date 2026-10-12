/**
 * The durable signing ledgers of this browser profile (M1): ONE vault-key
 * ledger and ONE LMS leaf ledger, shared by every tab, on IndexedDB.
 *
 * A one-time key (a vault key, an LMS leaf) that signs two different
 * messages can be forged. The SDK's ledgers reserve a key for one message
 * BEFORE any signature exists and record the signature before returning it;
 * this module gives them what they need in a browser:
 *   - a store whose `add` is atomic across tabs: an IndexedDB `add` in a
 *     readwrite transaction fails (ConstraintError) when the key exists, and
 *     IndexedDB serializes readwrite transactions on one object store across
 *     every connection of the profile; writes use strict durability;
 *   - a lock shared by every tab (`navigator.locks`), required: without the
 *     Web Locks API, or without IndexedDB, nothing opens and nothing signs
 *     (fail closed, `LedgerUnavailableError`);
 *   - `navigator.storage.persist()`, so the browser does not evict the
 *     ledger under storage pressure (asked once; the answer is shown);
 *   - the signed withdrawals this app kept in localStorage before the
 *     ledgers existed (lib/storage.ts), migrated into the vault-key ledger
 *     before the ledgers are handed out, so signing is only ever enabled on
 *     a ledger that knows every key this browser already used;
 *   - a refresh signal when any tab writes (BroadcastChannel), for lists.
 *
 * Nothing secret is stored: ledgers hold public keys, messages and
 * signatures (public once broadcast); tree caches hold public LMS nodes.
 */
import { PublicKey } from "@solana/web3.js";

import {
  createVaultKeyLedger,
  lmots,
  leafLedger as leafLedgers,
  type LeafLedger,
  type LeafLedgerStore,
  type LedgerLock,
  type VaultKeyLedger,
} from "./noised";
import type { lms } from "@noisedlabs/sdk";
import { openExistingDb } from "./legacyDb";
import { decodeHex, decodeKey, integrityOf, loadArchivedWithdrawals, loadWithdrawals, type StoredWithdrawal } from "./storage";

/** IndexedDB database of the ledgers (one per origin and browser profile). */
export const LEDGER_DB = "noised-ledgers";
/**
 * The same database under the project's earlier name (the rename to Noised). When this browser has it, its entries
 * are copied in once the ledgers open (`migrateLegacyDb`), and it stays bridged for the key records
 * (`idbLedgerStore`): a tab still running the earlier release keeps writing there, and its reservations must keep
 * binding their keys here.
 */
export const LEGACY_LEDGER_DB = "phalanx-ledgers";
const DB_VERSION = 1;
/** Ledger records (the SDK namespaces vault-key and leaf records in one store). */
const RECORDS = "records";
/** App bookkeeping: migration, keys another device signed with but could not export, passkey credentials. */
const META = "meta";
/** LMS tree caches (public, tagged by the key that made them). */
const TREES = "trees";
/** BroadcastChannel every tab of this origin listens on. */
export const LEDGER_CHANNEL = "noised-ledgers";

/** Why the ledgers could not open. Nothing may be signed without them. */
export class LedgerUnavailableError extends Error {
  readonly reason: "locks" | "indexeddb" | "open";

  constructor(reason: "locks" | "indexeddb" | "open", message: string) {
    super(message);
    this.name = "LedgerUnavailableError";
    this.reason = reason;
  }
}

/** The part of the Web Locks API the ledgers use. */
export interface LockManagerLike {
  request<T>(name: string, options: { mode: "exclusive" }, callback: (lock: unknown) => Promise<T>): Promise<T>;
}

/** A lock shared by every tab of this origin: `navigator.locks` (null without the Web Locks API). */
export function webLock(locks: LockManagerLike | null | undefined): LedgerLock | null {
  if (locks === null || locks === undefined || typeof locks.request !== "function") return null;
  return <T>(name: string, fn: () => Promise<T>): Promise<T> => locks.request(name, { mode: "exclusive" }, () => fn());
}

/** Run `fn` in one transaction and resolve once it committed (strict durability for writes). */
function inTx<T>(db: IDBDatabase, store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = mode === "readwrite" ? db.transaction(store, mode, { durability: "strict" }) : db.transaction(store, mode);
    let result: T;
    const r = fn(t.objectStore(store));
    r.onsuccess = () => {
      result = r.result;
    };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error ?? r.error ?? new Error("IndexedDB transaction failed"));
    t.onabort = () => reject(t.error ?? r.error ?? new Error("IndexedDB transaction aborted"));
  });
}

/** One record of `store` as JSON text (null when absent). */
async function getText(db: IDBDatabase, store: string, key: string): Promise<string | null> {
  const v = await inTx<unknown>(db, store, "readonly", (s) => s.get(key));
  return typeof v === "string" ? v : v === undefined || v === null ? null : JSON.stringify(v);
}

/** Write `value` under `key` only if the key is absent (one readwrite transaction: atomic for every tab); says whether it wrote. */
function addIfAbsent(db: IDBDatabase, store: string, key: string, value: unknown): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const t = db.transaction(store, "readwrite", { durability: "strict" });
    const r = t.objectStore(store).add(value, key);
    let added = false;
    r.onsuccess = () => {
      added = true;
    };
    r.onerror = (ev) => {
      // The key exists: another tab (or this one) holds it. Not an error of the transaction.
      if (r.error?.name === "ConstraintError") {
        ev.preventDefault();
        ev.stopPropagation();
      }
    };
    t.oncomplete = () => resolve(added);
    t.onabort = () => reject(t.error ?? r.error ?? new Error("IndexedDB add aborted"));
  });
}

async function keysOf(db: IDBDatabase, store: string, prefix: string): Promise<string[]> {
  const all = await inTx<IDBValidKey[]>(db, store, "readonly", (s) => s.getAllKeys());
  return all.filter((k): k is string => typeof k === "string" && k.startsWith(prefix));
}

/** Key prefix of the SDK's records under the project's earlier name (the SDK copies them to `noised/` and keeps honouring them). */
const LEGACY_KEY_PREFIX = "phalanx/";

/**
 * A `LeafLedgerStore` on an IndexedDB object store. `add` is atomic for
 * every tab of the profile (not `singleRealmOnly`): it writes only when the
 * key is absent, inside one readwrite transaction, and says whether it
 * wrote. `onWrite` runs after every committed write.
 *
 * `legacy`: the database of the project's earlier name, when this browser
 * has one (`LEGACY_LEDGER_DB`). The SDK reads and claims every record under
 * its earlier key too (`phalanx/pq/...`: SDK legacyNamespace.ts); here those
 * keys also reach the earlier database, where a tab still running the
 * earlier release keeps its records: a read falls back to it, `keys` lists
 * both, and `add` claims the key there first (atomic against that tab), then
 * here. Nothing is ever written there otherwise.
 */
export function idbLedgerStore(db: IDBDatabase, onWrite: () => void = () => undefined, legacy: IDBDatabase | null = null): LeafLedgerStore {
  const bridged = (key: string): boolean => legacy !== null && key.startsWith(LEGACY_KEY_PREFIX);
  return {
    async get(key) {
      const v = await getText(db, RECORDS, key);
      return v === null && legacy !== null && bridged(key) ? getText(legacy, RECORDS, key) : v;
    },
    async add(key, value) {
      if (legacy !== null && bridged(key) && !(await addIfAbsent(legacy, RECORDS, key, value))) return false;
      const added = await addIfAbsent(db, RECORDS, key, value);
      if (added) onWrite();
      return added;
    },
    async put(key, value) {
      await inTx(db, RECORDS, "readwrite", (s) => s.put(value, key));
      onWrite();
    },
    async keys(prefix) {
      const own = await keysOf(db, RECORDS, prefix);
      const old = legacy !== null && bridged(prefix) ? await keysOf(legacy, RECORDS, prefix) : [];
      return [...new Set([...own, ...old])].sort();
    },
    singleRealmOnly: false,
  };
}

/** LMS tree caches on IndexedDB (public data; each cache is tagged by its key's SEED and checked on load). */
export function idbTreeCacheStore(db: IDBDatabase): lms.LmsTreeCacheStore {
  return {
    async get(key) {
      const v = await inTx<unknown>(db, TREES, "readonly", (s) => s.get(key));
      return v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : null;
    },
    async put(key, value) {
      await inTx(db, TREES, "readwrite", (s) => s.put(Uint8Array.from(value), key));
    },
  };
}

/** App bookkeeping next to the ledgers. */
export interface MetaStore {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}

function idbMetaStore(db: IDBDatabase, onWrite: () => void): MetaStore {
  return {
    get: (key) => inTx<unknown>(db, META, "readonly", (s) => s.get(key)),
    async put(key, value) {
      await inTx(db, META, "readwrite", (s) => s.put(value, key));
      onWrite();
    },
  };
}

/** What `migrateLegacyDb` copied from the database of the project's earlier name. */
export interface LegacyDbMigration {
  /** Entries copied, per object store. */
  copied: { records: number; meta: number; trees: number };
  /** Entries this database already held (left as they are), per object store. */
  alreadyThere: { records: number; meta: number; trees: number };
}

/**
 * Copy every entry of the earlier database (`LEGACY_LEDGER_DB`) into this one, store by store: never overwriting an
 * entry this one holds, never deleting anything there (it stays as it is: a backup, and bridged by `idbLedgerStore`).
 * Idempotent. Key records keep their earlier keys (`phalanx/pq/...`): the SDK copies them to their `noised/pq/...`
 * keys and keeps honouring the earlier ones.
 */
export async function migrateLegacyDb(db: IDBDatabase, legacy: IDBDatabase): Promise<LegacyDbMigration> {
  const out: LegacyDbMigration = { copied: { records: 0, meta: 0, trees: 0 }, alreadyThere: { records: 0, meta: 0, trees: 0 } };
  for (const [store, field] of [
    [RECORDS, "records"],
    [META, "meta"],
    [TREES, "trees"],
  ] as const) {
    for (const key of await keysOf(legacy, store, "")) {
      const value = await inTx<unknown>(legacy, store, "readonly", (s) => s.get(key));
      if (value === undefined) continue;
      if (await addIfAbsent(db, store, key, value)) out.copied[field]++;
      else out.alreadyThere[field]++;
    }
  }
  return out;
}

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    let r: IDBOpenDBRequest;
    try {
      r = factory.open(LEDGER_DB, DB_VERSION);
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const name of [RECORDS, META, TREES]) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("IndexedDB open failed"));
    r.onblocked = () => reject(new Error("IndexedDB is blocked by another tab running an older version of this app: close it and reload."));
  });
}

// ------------------------------------------------------------- migration ---

/** What `migrateLegacyWithdrawals` did. */
export interface LegacyMigration {
  /** Records whose signature is now in the vault-key ledger. */
  migrated: number;
  /** Records the ledger already held. */
  alreadyThere: number;
  /** Hex key ids the ledger holds for another withdrawal: this browser has two signatures of one key on file. */
  conflicts: string[];
  /** Records that cannot be a ledger record (damaged, or a key that does not fit its sequence), with why. */
  skipped: { vault: string; sequence: string; reason: string }[];
}

/**
 * Put every signed withdrawal this browser kept before the ledgers existed
 * (lib/storage.ts: the active records first, then the archived ones) into
 * the vault-key ledger: `reserve(keyId, message, { vault, sequence, key })`
 * then `recordSignature`. Each key that signed is then taken for exactly
 * that message. Idempotent: a record the ledger holds is left as it is.
 */
export async function migrateLegacyWithdrawals(ledger: VaultKeyLedger, records: readonly StoredWithdrawal[]): Promise<LegacyMigration> {
  const out: LegacyMigration = { migrated: 0, alreadyThere: 0, conflicts: [], skipped: [] };
  for (const w of records) {
    const integrity = integrityOf(w);
    if (!integrity.ok) {
      out.skipped.push({ vault: w.vault, sequence: w.sequence, reason: integrity.reason ?? "damaged record" });
      continue;
    }
    try {
      const key = decodeKey(w.key);
      const keyId = lmots.keyId(key);
      const message = decodeHex(w.message);
      const existing = await ledger.get(keyId);
      if (existing !== null && existing.signature === w.signature.toLowerCase()) {
        out.alreadyThere++;
        continue;
      }
      const reservation = await ledger.reserve(keyId, message, { vault: new PublicKey(w.vault), sequence: BigInt(w.sequence), key });
      if (reservation === "conflict") {
        out.conflicts.push(Array.from(keyId, (b) => b.toString(16).padStart(2, "0")).join(""));
        continue;
      }
      await ledger.recordSignature(keyId, message, decodeHex(w.signature), decodeKey(w.nextKey));
      out.migrated++;
    } catch (e) {
      out.skipped.push({ vault: w.vault, sequence: w.sequence, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

// ------------------------------------------------------------- the ledgers ---

export interface BrowserLedgers {
  /** The vault-key ledger every vault signature of this profile goes through. */
  readonly vaultKeys: VaultKeyLedger;
  /** The LMS leaf ledger every launch attestation of this profile goes through. */
  readonly leaves: LeafLedger;
  /** LMS tree caches (so an identity loads in milliseconds after its first derivation). */
  readonly trees: lms.LmsTreeCacheStore;
  /** App bookkeeping (see `MetaStore`). */
  readonly meta: MetaStore;
  /** Whether the browser promised to keep this storage (`navigator.storage.persist()`); null when it cannot say. */
  readonly persisted: boolean | null;
  /** The legacy records migrated when the ledgers opened. */
  readonly migration: LegacyMigration;
  /** What was copied from the database of the project's earlier name (null: this browser has none). */
  readonly legacyDb: LegacyDbMigration | null;
  /**
   * The lock every tab of this profile shares (`navigator.locks`, `webLock`): the ledgers use it, and so does every
   * quantum signature as its `signingLock` (SDK 0.9.0, audit 4 ID-F4: "is an earlier signature pending, reserve, sign"
   * runs under it, so two tabs never both sign). It honours the name the SDK gives (`signingLockName(launch)`, distinct
   * from the ledger's and the launch tracker's), so nesting them cannot deadlock.
   */
  readonly lock: LedgerLock;
}

/** What `openBrowserLedgers` uses from the browser (injectable for tests). */
export interface LedgerEnv {
  indexedDB?: IDBFactory | null | undefined;
  locks?: LockManagerLike | null | undefined;
  persist?: (() => Promise<boolean>) | null | undefined;
  /** Legacy records to migrate (default: lib/storage.ts, active then archived). */
  legacy?: () => StoredWithdrawal[];
  /** Called after every committed write (default: tell the other tabs). */
  onWrite?: () => void;
}

function browserEnv(): LedgerEnv {
  const nav = (globalThis as { navigator?: { locks?: LockManagerLike; storage?: { persist?: () => Promise<boolean> } } }).navigator;
  let factory: IDBFactory | null = null;
  try {
    factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB ?? null;
  } catch {
    factory = null;
  }
  const persist = nav?.storage?.persist;
  return {
    indexedDB: factory,
    locks: nav?.locks ?? null,
    persist: typeof persist === "function" ? () => persist.call(nav?.storage) : null,
  };
}

/**
 * Open the ledgers of this browser profile, fail closed: no Web Locks API
 * or no IndexedDB throws `LedgerUnavailableError` (signing then stays off).
 * Asks for persistent storage, then migrates the legacy withdrawal records
 * before returning.
 */
export async function openBrowserLedgers(env: LedgerEnv = browserEnv()): Promise<BrowserLedgers> {
  const lock = webLock(env.locks);
  if (lock === null) {
    throw new LedgerUnavailableError(
      "locks",
      "This browser cannot keep its tabs from signing at the same time (no Web Locks API: an outdated browser, or the page is not served over https). Use a current browser over https; nothing can be signed here.",
    );
  }
  if (env.indexedDB === null || env.indexedDB === undefined) {
    throw new LedgerUnavailableError("indexeddb", "This browser has no IndexedDB here (a private window may block it), so it cannot remember which one-time keys were used. Nothing can be signed here.");
  }
  let db: IDBDatabase;
  try {
    db = await openDb(env.indexedDB);
  } catch (e) {
    throw new LedgerUnavailableError("open", `This browser could not open its key records (${e instanceof Error ? e.message : String(e)}). Nothing can be signed here.`);
  }
  const onWrite = env.onWrite ?? announceWrite;
  // The rename to Noised: the earlier database's entries are copied in before anything is handed out (under a lock
  // every tab shares), and its key records stay bridged.
  let legacyDb: IDBDatabase | null = null;
  let legacyCopy: LegacyDbMigration | null = null;
  try {
    legacyDb = await openExistingDb(env.indexedDB, LEGACY_LEDGER_DB, [RECORDS, META, TREES]);
    if (legacyDb !== null) {
      const from = legacyDb;
      legacyCopy = await lock("noised/ledger-db-migration/v1", () => migrateLegacyDb(db, from));
    }
  } catch (e) {
    throw new LedgerUnavailableError("open", `This browser could not copy its earlier key records (${e instanceof Error ? e.message : String(e)}). Nothing can be signed here.`);
  }
  const store = idbLedgerStore(db, onWrite, legacyDb);
  let persisted: boolean | null = null;
  try {
    persisted = env.persist ? await env.persist() : null;
  } catch {
    persisted = null;
  }
  const vaultKeys = createVaultKeyLedger(store, { lock });
  const leaves = leafLedgers.createLeafLedger(store, { lock });
  const meta = idbMetaStore(db, onWrite);
  const legacy = env.legacy ?? (() => [...loadWithdrawals(), ...loadArchivedWithdrawals()]);
  const migration = await migrateLegacyWithdrawals(vaultKeys, legacy());
  await meta.put("migration/last", { at: Date.now(), ...migration });
  if (legacyCopy !== null) await meta.put("migration/legacy-db", { at: Date.now(), from: LEGACY_LEDGER_DB, ...legacyCopy });
  return { vaultKeys, leaves, trees: idbTreeCacheStore(db), meta, persisted, migration, legacyDb: legacyCopy, lock };
}

let shared: Promise<BrowserLedgers> | null = null;

/** This page's ledgers (opened once; a failed open is retried on the next call). */
export function browserLedgers(): Promise<BrowserLedgers> {
  if (shared === null) {
    shared = openBrowserLedgers();
    shared.catch(() => {
      shared = null;
    });
  }
  return shared;
}

// ------------------------------------------------------- cross-tab refresh ---

const listeners = new Set<() => void>();
let channel: BroadcastChannel | null = null;

function notifyLocal(): void {
  for (const l of [...listeners]) l();
}

function announceWrite(): void {
  notifyLocal();
  try {
    channel?.postMessage("changed");
  } catch {
    // The other tabs refresh on their next read.
  }
}

/**
 * Call `listener` after any tab of this browser writes a ledger record (and
 * when the legacy records change: the `storage` event). Returns an
 * unsubscribe function.
 */
export function subscribeLedgers(listener: () => void): () => void {
  listeners.add(listener);
  if (channel === null && typeof BroadcastChannel === "function") {
    channel = new BroadcastChannel(LEDGER_CHANNEL);
    channel.onmessage = () => notifyLocal();
  }
  const onStorage = (e: StorageEvent): void => {
    if (e.key === null || e.key.startsWith("noised.pq.")) listener();
  };
  globalThis.addEventListener?.("storage", onStorage);
  return () => {
    listeners.delete(listener);
    globalThis.removeEventListener?.("storage", onStorage);
    if (listeners.size === 0 && channel !== null) {
      channel.close();
      channel = null;
    }
  };
}

// ------------------------------------------------- keys from other devices ---

const UNVERIFIABLE = "vault-keys/unverifiable";

/**
 * Hex key ids another device signed with but could not export (an import's
 * `unverifiable`): nothing here can authenticate them, so no vault
 * withdrawal is signed in this browser while the list is not empty (the
 * SDK's rule). A later import that carries them as authenticated records
 * clears them.
 */
export async function unverifiableKeys(ledgers: Pick<BrowserLedgers, "meta" | "vaultKeys">): Promise<string[]> {
  const v = await ledgers.meta.get(UNVERIFIABLE);
  const list = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const left: string[] = [];
  for (const id of list) {
    const rec = await ledgers.vaultKeys.get(decodeHex(id)).catch(() => null);
    if (rec === null || rec.signature === null) left.push(id);
  }
  if (left.length !== list.length) await ledgers.meta.put(UNVERIFIABLE, left);
  return left;
}

/** Add key ids to the unverifiable list (after an import). */
export async function addUnverifiableKeys(ledgers: Pick<BrowserLedgers, "meta">, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const v = await ledgers.meta.get(UNVERIFIABLE);
  const list = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  await ledgers.meta.put(UNVERIFIABLE, [...new Set([...list, ...ids.map((x) => x.toLowerCase())])]);
}

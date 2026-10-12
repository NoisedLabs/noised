/**
 * Browser storage for things that must survive a reload: preferences, and
 * every signed PQ withdrawal (SPEC §3.10: persist the signed message before
 * broadcasting, re-broadcast it, never sign a second message with that key).
 *
 * Vault v4 withdrawals are stored one localStorage key per vault AND
 * sequence (`noised.pq.withdrawal.v4:<vault>:<sequence>`): the key that
 * signs at a sequence signs one message, ever, so a (vault, sequence) has at
 * most one record, and a write never rewrites another record (no
 * read-modify-write races between tabs). A record is written and read back
 * before anything is broadcast, and is never replaced by one that carries a
 * different signature (the exceptions, `replaceWithRevealed` and
 * `archiveWithdrawal`, keep the replaced record under an archive key).
 *
 * Which one-time key signed which message is NOT decided here: that is the
 * vault-key ledger's job (lib/ledger.ts, IndexedDB, shared by every tab),
 * which reserves a key before it signs. These records are the app's
 * bookkeeping around each signed withdrawal (its throwaway fee payer, the
 * last broadcast, a backup to download). The records kept here before the
 * ledger existed are migrated into it when it opens.
 *
 * Signing claims (`noised.pq.signing.v4:<vault>:<sequence>`) are LEGACY:
 * earlier versions wrote the exact message right before a key signed and
 * removed it once the record was stored. One that stayed means that key may
 * have signed that message. They are no longer written; each is moved into
 * the ledger as a reservation of its key for its message as soon as the
 * phrase that owns it is unlocked (lib/vaultFlow.ts), and listed until then.
 *
 * Records of vault v3 (`noised.pq.withdrawal.v1:<vault>` and the older
 * single list) are RETIRED: a "PHX-PQV3" message cannot execute on the v4
 * program, and v3 keys came from another derivation path, which this app no
 * longer derives. They are kept read-only (backup download, fee-payer
 * refund, explicit removal) and are never migrated, broadcast or signed for.
 *
 * Nothing secret about a vault is ever stored: no recovery phrase, no master
 * seed, no LM-OTS private seed. A signed withdrawal is public once broadcast.
 * The throwaway fee payer's Ed25519 key is stored with its withdrawal so its
 * SOL can be refunded after a reload; it has no authority over any vault.
 */
import { Keypair, PublicKey } from "@solana/web3.js";

import { toHex } from "./format";
// Copies the earlier name's keys (phalanx.*) to their noised.* names before anything here reads them.
import "./legacyStorage";
import { ADAPTER_MODE, lmots, VAULT, withdrawMessage, type Cluster, type LmotsPublicKey } from "./noised";

function store(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readString(key: string): string | null {
  try {
    return store()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeString(key: string, value: string | null): boolean {
  const s = store();
  if (!s) return false;
  try {
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** True if values written now can be read back (false in some private modes or when storage is full or blocked). */
export function storageWorks(): boolean {
  const probe = `noised.probe.${Math.random().toString(36).slice(2)}`;
  if (!writeString(probe, "1")) return false;
  const ok = readString(probe) === "1";
  writeString(probe, null);
  return ok;
}

function storageKeys(prefix: string): string[] {
  const s = store();
  if (!s) return [];
  const keys: string[] = [];
  try {
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k !== null && k.startsWith(prefix)) keys.push(k);
    }
  } catch {
    return [];
  }
  return keys;
}

// ------------------------------------------------------ signed withdrawals ---

/**
 * `signed`: stored, never sent from this browser; `funded`: its fee payer
 * was funded; `broadcast`: sent, outcome unknown; `executed`: the withdrawal
 * landed (its payout may still wait for delivery); `failed`: the last attempt
 * failed (re-broadcast the same signature).
 */
export type WithdrawalStatus = "signed" | "funded" | "broadcast" | "executed" | "failed";

/** Where the signature came from: signed in this browser, found already revealed on chain, or imported from a backup. */
export type WithdrawalSource = "signed" | "revealed" | "imported";

interface StoredKey {
  id: string;
  q: number;
  k: string;
}

/** One signed vault v4 withdrawal, keyed by (vault, sequence): the key of a sequence signs at most once, ever. */
export interface StoredWithdrawal {
  version: 4;
  /** The build the record was signed in: "mock" signatures are real LM-OTS signatures too (see `effectiveStatus`). */
  mode: "mock" | "live";
  cluster: Cluster;
  vault: string;
  mint: string;
  /** Vault account number of the recovery phrase. */
  account: number;
  /** The vault sequence the message names (u64, decimal). */
  sequence: string;
  /** The key that signed: the vault's key at `sequence`. */
  key: StoredKey;
  /** The key that controls the vault after this withdrawal (its key id is in the message). */
  nextKey: StoredKey;
  destinationOwner: string;
  maxAmount: string;
  /** The exact 185-byte message (hex) the signature covers. */
  message: string;
  /** LM-OTS signature `C || y` (hex, 2176 bytes). */
  signature: string;
  source: WithdrawalSource;
  /** 64-byte secret key (hex) of the throwaway fee payer. */
  feePayerSecret: string;
  feePayerRefunded: boolean;
  status: WithdrawalStatus;
  /** Whether the last broadcast carried `release` too (null before the first one). */
  lastIncludedRelease: boolean | null;
  lastTxSignature: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

const RECORD_PREFIX = "noised.pq.withdrawal.v4:";
/** A record replaced by `replaceWithRevealed` or set aside by `archiveWithdrawal` (kept, never broadcast): `<vault>:<sequence>:<signature prefix>`. */
const ARCHIVE_PREFIX = "noised.pq.withdrawal.v4-archived:";
/** The message a key is about to sign, per (vault, sequence): see `claimSigningSlot`. */
const CLAIM_PREFIX = "noised.pq.signing.v4:";
/** Vault v3 records, one per vault (retired). */
const V3_RECORD_PREFIX = "noised.pq.withdrawal.v1:";
/** Vault v3 records in the format before records were keyed by vault: one JSON array (retired). */
const V3_LIST_KEY = "noised.pq.withdrawals.v1";

const recordKey = (vault: string, sequence: string): string => `${RECORD_PREFIX}${vault}:${sequence}`;
const seqText = (sequence: bigint | string): string => (typeof sequence === "bigint" ? sequence.toString() : sequence);

function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) throw new Error("corrupt hex in stored withdrawal");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export const encodeKey = (pk: LmotsPublicKey): StoredKey => ({ id: toHex(pk.id), q: pk.q, k: toHex(pk.k) });
export const decodeKey = (k: StoredKey): LmotsPublicKey => ({ id: fromHex(k.id), q: k.q, k: fromHex(k.k) });
export const decodeHex = fromHex;

/** The arguments `buildWithdrawTx` / `buildWithdrawTxWithFallback` need to rebuild this withdrawal around its stored signature. */
export function withdrawArgsOf(w: StoredWithdrawal): {
  mint: PublicKey;
  vault: PublicKey;
  sequence: bigint;
  destinationOwner: PublicKey;
  maxAmount: bigint;
  signature: Uint8Array;
  nextKey: LmotsPublicKey;
  nextKeyId: Uint8Array;
} {
  const nextKey = decodeKey(w.nextKey);
  return {
    mint: new PublicKey(w.mint),
    vault: new PublicKey(w.vault),
    sequence: BigInt(w.sequence),
    destinationOwner: new PublicKey(w.destinationOwner),
    maxAmount: BigInt(w.maxAmount),
    signature: fromHex(w.signature),
    nextKey,
    nextKeyId: lmots.keyId(nextKey),
  };
}

/**
 * Recompute the message from the stored fields and verify the stored
 * signature with the stored key: detects a corrupted or edited record before
 * it is broadcast. (Whether the key is the vault's current one is the
 * chain's to say: `buildWithdrawTx` checks that.)
 */
export function integrityOf(w: StoredWithdrawal): { ok: boolean; reason: string | null } {
  try {
    const a = withdrawArgsOf(w);
    const msg = withdrawMessage(a.vault, a.mint, a.sequence, a.destinationOwner, a.maxAmount, a.nextKeyId);
    const stored = fromHex(w.message);
    if (msg.length !== stored.length || msg.some((b, i) => b !== stored[i])) return { ok: false, reason: "The stored message does not match its own fields." };
    if (a.signature.length !== VAULT.SIGNATURE_LEN || !lmots.verify(decodeKey(w.key), msg, a.signature)) return { ok: false, reason: "The stored signature does not verify with the stored key." };
    return { ok: true, reason: null };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "Unreadable record." };
  }
}

/**
 * The status that applies in this build. A record signed in demo mode holds a
 * real LM-OTS signature by the user's key, but its demo "broadcast" never
 * reached a cluster: in a live build it counts as signed and not yet sent,
 * and its key still must never sign anything else at that sequence.
 */
export function effectiveStatus(w: StoredWithdrawal): WithdrawalStatus {
  return w.mode === ADAPTER_MODE ? w.status : "signed";
}

export function feePayerOf(w: { feePayerSecret: string }): Keypair {
  return Keypair.fromSecretKey(fromHex(w.feePayerSecret));
}

function isStoredKey(v: unknown): v is StoredKey {
  if (typeof v !== "object" || v === null) return false;
  const k = v as Record<string, unknown>;
  return typeof k.id === "string" && typeof k.k === "string" && typeof k.q === "number";
}

function isStoredWithdrawal(v: unknown): v is StoredWithdrawal {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    o.version === 4 &&
    (o.mode === "mock" || o.mode === "live") &&
    typeof o.vault === "string" &&
    typeof o.mint === "string" &&
    typeof o.account === "number" &&
    typeof o.sequence === "string" &&
    /^\d+$/.test(o.sequence) &&
    isStoredKey(o.key) &&
    isStoredKey(o.nextKey) &&
    typeof o.signature === "string" &&
    typeof o.message === "string" &&
    typeof o.destinationOwner === "string" &&
    typeof o.maxAmount === "string" &&
    typeof o.feePayerSecret === "string"
  );
}

function parseRecord(text: string | null): StoredWithdrawal | null {
  if (text === null) return null;
  try {
    const v: unknown = JSON.parse(text);
    return isStoredWithdrawal(v) ? v : null;
  } catch {
    return null;
  }
}

/** Every vault v4 withdrawal this browser holds. */
export function loadWithdrawals(): StoredWithdrawal[] {
  const out: StoredWithdrawal[] = [];
  for (const key of storageKeys(RECORD_PREFIX)) {
    const w = parseRecord(readString(key));
    // A record is only valid under its own (vault, sequence) key.
    if (w !== null && key === recordKey(w.vault, w.sequence)) out.push(w);
  }
  return out;
}

/** The vault v4 records set aside in the archive (full records, for the key ledger: an archived signature still used its key). */
export function loadArchivedWithdrawals(): StoredWithdrawal[] {
  const out: StoredWithdrawal[] = [];
  for (const key of storageKeys(ARCHIVE_PREFIX)) {
    const w = parseRecord(readString(key));
    if (w !== null) out.push(w);
  }
  return out;
}

/** The signed withdrawal of `vault` at `sequence`, if this browser holds one. */
export function withdrawalFor(vault: PublicKey | string, sequence: bigint | string): StoredWithdrawal | null {
  const id = typeof vault === "string" ? vault : vault.toBase58();
  const seq = seqText(sequence);
  const w = parseRecord(readString(recordKey(id, seq)));
  return w !== null && w.vault === id && w.sequence === seq ? w : null;
}

/** Every record of one vault, lowest sequence first. */
export function withdrawalsOfVault(vault: PublicKey | string): StoredWithdrawal[] {
  const id = typeof vault === "string" ? vault : vault.toBase58();
  return loadWithdrawals()
    .filter((w) => w.vault === id)
    .sort((a, b) => (BigInt(a.sequence) < BigInt(b.sequence) ? -1 : 1));
}

function writeRecord(key: string, w: StoredWithdrawal): void {
  const text = JSON.stringify(w);
  if (!writeString(key, text) || readString(key) !== text) {
    throw new Error("This browser did not store the signed withdrawal. It will not be broadcast. Free up storage or leave private mode, then try again.");
  }
  notify();
}

/** `saveNewWithdrawal` found a different record of the same vault and sequence: nothing was written. */
export class DifferentWithdrawalError extends Error {
  readonly existing: StoredWithdrawal;

  constructor(existing: StoredWithdrawal) {
    super(
      `This browser already holds a different signed withdrawal for this vault at sequence ${existing.sequence}. It was not replaced: re-broadcast the stored one. A one-time key must never sign twice.`,
    );
    this.name = "DifferentWithdrawalError";
    this.existing = existing;
  }
}

/**
 * Store a newly signed (or found, or imported) withdrawal and read it back.
 * Throws if storage did not keep it (callers must not broadcast without a
 * durable record), and refuses (`DifferentWithdrawalError`) to replace a
 * record of the same vault and sequence that carries a different signature:
 * two signatures by one key would be a key reuse. A signing claim for the
 * same message is released once the record is stored.
 */
export function saveNewWithdrawal(w: StoredWithdrawal): void {
  if (!isStoredWithdrawal(w)) throw new Error("Not a vault v4 withdrawal record.");
  const existing = withdrawalFor(w.vault, w.sequence);
  if (existing !== null) {
    if (existing.signature === w.signature && existing.message === w.message) return;
    throw new DifferentWithdrawalError(existing);
  }
  writeRecord(recordKey(w.vault, w.sequence), w);
  releaseSigningClaim(w.vault, w.sequence, w.message);
}

/** Update the bookkeeping fields of a stored withdrawal (never its message, signature or keys). */
export function updateWithdrawal(
  vault: string,
  sequence: bigint | string,
  patch: Partial<Pick<StoredWithdrawal, "status" | "lastTxSignature" | "lastError" | "feePayerRefunded" | "mode" | "lastIncludedRelease">>,
): StoredWithdrawal | null {
  const current = withdrawalFor(vault, sequence);
  if (!current) return null;
  const next: StoredWithdrawal = { ...current, ...patch, updatedAt: Date.now() };
  writeRecord(recordKey(current.vault, current.sequence), next);
  return next;
}

/** Forget a withdrawal (offered only once it executed, its payout was delivered and its fee payer is empty). */
export function deleteWithdrawal(vault: string, sequence: bigint | string): void {
  writeString(recordKey(vault, seqText(sequence)), null);
  notify();
}

/**
 * Replace the record of (vault, sequence) by a withdrawal of the same key
 * that is already public on chain (a different message signed elsewhere).
 * Broadcasting the local one would reveal a second signature of a one-time
 * key, so it is archived (kept under an archive key, never broadcast) and
 * the revealed one becomes the record to re-broadcast.
 */
export function replaceWithRevealed(current: StoredWithdrawal, revealed: StoredWithdrawal): void {
  if (revealed.source !== "revealed") throw new Error("Only a withdrawal found on chain can replace a stored one.");
  if (revealed.vault !== current.vault || revealed.sequence !== current.sequence) throw new Error("The revealed withdrawal is for another vault or sequence.");
  writeArchive(current, "Archived: a different withdrawal of this key was already public, so this one must never be broadcast.");
  const key = recordKey(revealed.vault, revealed.sequence);
  writeString(key, null);
  writeRecord(key, revealed);
}

/** Keep `w` under an archive key (read back), with `reason` as its last error. Throws if storage did not keep it. */
function writeArchive(w: StoredWithdrawal, reason: string): void {
  const archive = `${ARCHIVE_PREFIX}${w.vault}:${w.sequence}:${w.signature.slice(0, 16)}`;
  const text = JSON.stringify({ ...w, lastError: reason });
  if (!writeString(archive, text) || readString(archive) !== text) throw new Error("This browser could not archive the stored withdrawal; nothing was changed.");
}

/**
 * Archive every record made for another cluster than `cluster` (this
 * build's): a withdrawal names no cluster, but its vault keys are derived
 * per cluster, so here it can never execute and must not hold a slot. It
 * stays downloadable (and removable) in the archive. Returns how many moved.
 */
export function archiveOtherClusterRecords(cluster: Cluster): number {
  let moved = 0;
  for (const w of loadWithdrawals()) {
    if (w.cluster === cluster) continue;
    try {
      archiveWithdrawal(w, `Archived: signed for ${w.cluster}; this app is built for ${cluster}, where it can never execute. Broadcast it from a ${w.cluster} build (download it first).`);
      moved++;
    } catch {
      // Changed meanwhile: left for the next pass.
    }
  }
  return moved;
}

/**
 * Move a record that can never execute out of its (vault, sequence) slot,
 * into the archive (listed with the retired records, never broadcast,
 * removable): a record whose key is not the vault's key at that sequence (a
 * forged or mistaken import, a signature of another phrase) cannot be a
 * signature of the vault's key, so it must not block that key. Only the
 * record passed is moved: if the slot now holds another one, nothing changes.
 */
export function archiveWithdrawal(w: StoredWithdrawal, reason: string): void {
  const key = recordKey(w.vault, w.sequence);
  const current = parseRecord(readString(key));
  if (current === null || current.signature !== w.signature || current.message !== w.message) {
    throw new Error("The stored withdrawal changed meanwhile; nothing was archived.");
  }
  writeArchive(current, reason);
  writeString(key, null);
  notify();
}

// ------------------------------------------------- legacy signing claims ---

/**
 * The message a vault key was about to sign at (vault, sequence), written by
 * earlier versions of this app right before it signed (LEGACY: see the
 * module docs). It holds no secret and no signature.
 */
export interface SigningClaim {
  version: 4;
  cluster: string;
  vault: string;
  mint: string;
  account: number;
  sequence: string;
  /** The exact 185-byte message (hex); "" when the stored claim is unreadable: it then stands for any message and blocks them all. */
  message: string;
  createdAt: number;
}

const claimKey = (vault: string, sequence: string): string => `${CLAIM_PREFIX}${vault}:${sequence}`;

function parseClaim(text: string | null): SigningClaim | null {
  if (text === null) return null;
  try {
    const o: unknown = JSON.parse(text);
    if (typeof o !== "object" || o === null) return null;
    const c = o as Record<string, unknown>;
    const ok =
      c.version === 4 &&
      typeof c.vault === "string" &&
      typeof c.mint === "string" &&
      typeof c.cluster === "string" &&
      typeof c.account === "number" &&
      typeof c.sequence === "string" &&
      /^\d+$/.test(c.sequence) &&
      typeof c.message === "string" &&
      /^[0-9a-f]+$/.test(c.message) &&
      typeof c.createdAt === "number";
    return ok ? (c as unknown as SigningClaim) : null;
  } catch {
    return null;
  }
}

/** The claim stored under `key`, or null if there is none. An unreadable one blocks every message (`message` ""). */
function claimAt(key: string): SigningClaim | null {
  const text = readString(key);
  if (text === null) return null;
  const slot = key.slice(CLAIM_PREFIX.length);
  const at = slot.lastIndexOf(":");
  const vault = slot.slice(0, Math.max(0, at));
  const sequence = slot.slice(at + 1);
  const c = parseClaim(text);
  if (c !== null && c.vault === vault && c.sequence === sequence) return c;
  return { version: 4, cluster: "", vault, mint: "", account: -1, sequence, message: "", createdAt: 0 };
}

/** The signing claim of (vault, sequence), if this browser holds one. */
export function signingClaimFor(vault: PublicKey | string, sequence: bigint | string): SigningClaim | null {
  const id = typeof vault === "string" ? vault : vault.toBase58();
  return claimAt(claimKey(id, seqText(sequence)));
}

/** Every signing claim this browser holds (signings that did not finish), oldest first. */
export function loadSigningClaims(): SigningClaim[] {
  return storageKeys(CLAIM_PREFIX)
    .map(claimAt)
    .filter((c): c is SigningClaim => c !== null && /^\d+$/.test(c.sequence) && c.vault !== "")
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Remove the claim of (vault, sequence) if it is for `message` (its signed record is stored, or the ledger now holds it). */
export function releaseSigningClaim(vault: string, sequence: bigint | string, message: string): void {
  const seq = seqText(sequence);
  const c = parseClaim(readString(claimKey(vault, seq)));
  if (c === null || c.message !== message) return;
  writeString(claimKey(vault, seq), null);
  notify();
}

/** Remove a claim whatever its message: only once its key can no longer sign (the vault moved past its sequence) or the ledger holds it. */
export function deleteSigningClaim(vault: string, sequence: bigint | string): void {
  writeString(claimKey(vault, seqText(sequence)), null);
  notify();
}

/** A JSON backup the user can keep outside the browser (everything except the fee payer's key). */
export function exportWithdrawal(w: StoredWithdrawal): string {
  const { feePayerSecret: _secret, ...publicPart } = w;
  return JSON.stringify(
    { ...publicPart, note: "Signed Noised PQ vault v4 withdrawal. Re-broadcast it; never sign another message with this key at this sequence." },
    null,
    2,
  );
}

/**
 * Parse a backup made by `exportWithdrawal`. A fresh throwaway fee payer is
 * generated (any fee payer can relay a signed withdrawal). Refuses vault v3
 * backups: their messages cannot execute on the v4 program. The caller must
 * check integrity before saving and broadcasting.
 */
export function parseWithdrawalBackup(text: string): StoredWithdrawal {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error("Not valid JSON.");
  }
  if (typeof v !== "object" || v === null) throw new Error("Not a withdrawal backup.");
  const o = v as Record<string, unknown>;
  if (o.version !== 4) {
    throw new Error(
      o.version === 1 || typeof o.successor === "object"
        ? "This is a vault v3 backup (PHX-PQV3). Vault v3 is retired: its message cannot execute on the current vault program. Nothing was imported."
        : "Not a vault v4 withdrawal backup.",
    );
  }
  const str = (k: string): string => {
    const x = o[k];
    if (typeof x !== "string") throw new Error(`Missing field "${k}".`);
    return x;
  };
  const key = (k: string): StoredKey => {
    const x = o[k];
    if (!isStoredKey(x)) throw new Error(`Malformed key "${k}".`);
    return { id: x.id, q: x.q, k: x.k };
  };
  const cluster = str("cluster");
  if (cluster !== "mainnet" && cluster !== "devnet" && cluster !== "localnet") throw new Error("Unknown cluster.");
  for (const k of ["vault", "mint", "destinationOwner"]) new PublicKey(str(k));
  if (!/^\d+$/.test(str("maxAmount"))) throw new Error("Malformed maxAmount.");
  if (!/^\d+$/.test(str("sequence"))) throw new Error("Malformed sequence.");
  const account = o.account;
  if (typeof account !== "number" || !Number.isInteger(account) || account < 0) throw new Error('Missing field "account".');
  const mode = o.mode === "live" || o.mode === "mock" ? o.mode : "mock";
  const now = Date.now();
  return {
    version: 4,
    mode,
    cluster,
    vault: str("vault"),
    mint: str("mint"),
    account,
    sequence: str("sequence"),
    key: key("key"),
    nextKey: key("nextKey"),
    destinationOwner: str("destinationOwner"),
    maxAmount: str("maxAmount"),
    message: str("message"),
    signature: str("signature"),
    source: "imported",
    feePayerSecret: toHex(Keypair.generate().secretKey),
    feePayerRefunded: false,
    status: "signed",
    lastIncludedRelease: null,
    lastTxSignature: null,
    lastError: null,
    createdAt: typeof o.createdAt === "number" ? o.createdAt : now,
    updatedAt: now,
  };
}

// ------------------------------------------------------- retired records ---

/** A record that can never be broadcast: a vault v3 withdrawal, or a v4 one set aside by `replaceWithRevealed` or `archiveWithdrawal`. */
export interface RetiredWithdrawal {
  /** Where it is stored (for removal); a v3 list entry is `<list key>#<index>`. */
  storageKey: string;
  kind: "v3" | "archived";
  /** Why an archived record was set aside (null for v3 records). */
  reason: string | null;
  mode: "mock" | "live";
  cluster: string;
  vault: string;
  mint: string;
  destinationOwner: string;
  maxAmount: string;
  createdAt: number;
  /** The throwaway fee payer's secret key (hex), so leftover SOL can be refunded; null if the record has none. */
  feePayerSecret: string | null;
  feePayerRefunded: boolean;
  /** The stored JSON without the fee payer's key, for a backup download. */
  backup: string;
}

function retiredFrom(storageKey: string, kind: RetiredWithdrawal["kind"], v: unknown): RetiredWithdrawal | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const str = (k: string): string => (typeof o[k] === "string" ? (o[k] as string) : "");
  if (str("vault") === "" || str("signature") === "") return null;
  const { feePayerSecret, ...publicPart } = o;
  const reason = kind === "archived" ? (str("lastError") === "" ? "Archived: a different withdrawal of the same key was already public." : str("lastError")) : null;
  return {
    storageKey,
    kind,
    reason,
    mode: o.mode === "live" ? "live" : "mock",
    cluster: str("cluster"),
    vault: str("vault"),
    mint: str("mint"),
    destinationOwner: str("destinationOwner"),
    maxAmount: str("maxAmount"),
    createdAt: typeof o.createdAt === "number" ? o.createdAt : 0,
    feePayerSecret: typeof feePayerSecret === "string" && /^[0-9a-f]{128}$/i.test(feePayerSecret) ? feePayerSecret : null,
    feePayerRefunded: o.feePayerRefunded === true,
    backup: JSON.stringify(
      {
        ...publicPart,
        note:
          kind === "v3"
            ? "Retired Noised PQ vault v3 withdrawal (PHX-PQV3). It cannot execute on the current vault program; keep it as a record only."
            : `Archived Noised PQ vault v4 withdrawal. Never broadcast this one. ${reason ?? ""}`.trim(),
      },
      null,
      2,
    ),
  };
}

/** Vault v3 records (both storage formats) and archived v4 records. Nothing here is ever broadcast or signed for. */
export function loadRetiredWithdrawals(): RetiredWithdrawal[] {
  const out: RetiredWithdrawal[] = [];
  for (const key of storageKeys(V3_RECORD_PREFIX)) {
    try {
      const r = retiredFrom(key, "v3", JSON.parse(readString(key) ?? "null"));
      if (r !== null) out.push(r);
    } catch {
      // Unreadable: left in place, not shown.
    }
  }
  try {
    const list: unknown = JSON.parse(readString(V3_LIST_KEY) ?? "null");
    if (Array.isArray(list)) {
      list.forEach((item, i) => {
        const r = retiredFrom(`${V3_LIST_KEY}#${i}`, "v3", item);
        if (r !== null) out.push(r);
      });
    }
  } catch {
    // Unreadable: left in place, not shown.
  }
  for (const key of storageKeys(ARCHIVE_PREFIX)) {
    try {
      const r = retiredFrom(key, "archived", JSON.parse(readString(key) ?? "null"));
      if (r !== null) out.push(r);
    } catch {
      // Unreadable: left in place, not shown.
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

function updateRetired(storageKey: string, patch: ((o: Record<string, unknown>) => Record<string, unknown>) | null): void {
  const hash = storageKey.lastIndexOf("#");
  if (storageKey.startsWith(`${V3_LIST_KEY}#`) && hash > 0) {
    const index = Number(storageKey.slice(hash + 1));
    const list: unknown = JSON.parse(readString(V3_LIST_KEY) ?? "null");
    if (!Array.isArray(list) || !Number.isInteger(index) || index < 0 || index >= list.length) return;
    const next = patch === null ? list.filter((_, i) => i !== index) : list.map((x, i) => (i === index && typeof x === "object" && x !== null ? patch(x as Record<string, unknown>) : x));
    writeString(V3_LIST_KEY, next.length === 0 ? null : JSON.stringify(next));
  } else if (storageKey.startsWith(V3_RECORD_PREFIX) || storageKey.startsWith(ARCHIVE_PREFIX)) {
    if (patch === null) writeString(storageKey, null);
    else {
      const o: unknown = JSON.parse(readString(storageKey) ?? "null");
      if (typeof o === "object" && o !== null) writeString(storageKey, JSON.stringify(patch(o as Record<string, unknown>)));
    }
  }
  notify();
}

/** Remember that a retired record's fee payer was refunded. */
export function markRetiredRefunded(storageKey: string): void {
  updateRetired(storageKey, (o) => ({ ...o, feePayerRefunded: true }));
}

/** Remove a retired record (only on the user's explicit request). */
export function deleteRetiredWithdrawal(storageKey: string): void {
  updateRetired(storageKey, null);
}

// ------------------------------------------------------------- listeners ---

const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

/**
 * Subscribe to changes of the withdrawal records, archives and signing
 * claims, made in this tab or in another tab of this browser (the `storage`
 * event). Returns an unsubscribe function.
 */
export function subscribeWithdrawals(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent): void => {
    if (e.key === null || e.key.startsWith("noised.pq.withdrawal") || e.key.startsWith(CLAIM_PREFIX) || e.key === V3_LIST_KEY) listener();
  };
  globalThis.addEventListener?.("storage", onStorage);
  return () => {
    listeners.delete(listener);
    globalThis.removeEventListener?.("storage", onStorage);
  };
}

export function parseKey(text: string): PublicKey | null {
  try {
    const k = new PublicKey(text.trim());
    return k;
  } catch {
    return null;
  }
}

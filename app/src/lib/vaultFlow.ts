/**
 * The PQ vault withdrawal flow (SPEC §3.10), in the order the app runs it:
 *
 *   the key ledger of this browser (lib/ledger.ts: IndexedDB with an atomic
 *   add, a Web Lock shared by every tab, the older records migrated in) is
 *   open, and holds no key another device signed with but could not export
 *   -> checkCluster (the endpoint must serve this build's cluster)
 *   -> an exclusive Web Lock on (cluster, vault, sequence), shared by every
 *      tab of this browser (none: refuse; another tab signing: refuse)
 *   -> fetchVault: the vault waits at the reviewed sequence and the phrase
 *      holds its current key; an unfinished signing of an older version of
 *      this app becomes a ledger reservation of that key; a stored record of
 *      another key is archived (it can never execute)
 *   -> prepareWithdrawal (the SDK's, or the simulated chain's twin): the
 *      user's confirmation of the recipient (one acknowledgment per kind of
 *      caution) -> the endpoint's genesis hash -> the vault -> the ledger's
 *      record of the current key (another withdrawal: never sign again) ->
 *      the history search (a revealed signature is recorded and
 *      re-broadcast; an incomplete search signs nothing and can be
 *      continued) -> the recipient re-checked -> reserve the key, sign
 *      (deterministic), record the signature, return it
 *   -> this app's record of the withdrawal (its throwaway fee payer, the
 *      broadcasts) saved and read back
 *
 * then the broadcast: withdraw + release in one v1 transaction, or the
 * withdrawal alone with the SAME signature when the release would fail now
 * (the payout stays reserved for `release` / `release_to` later).
 *
 * Chain access is passed in (`VaultChain`), so the same code runs against
 * the live SDK, the simulated chain and test stubs. The app never holds a
 * one-time private seed: the SDK derives it from its own copy of the master
 * seed, signs once and wipes it.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";

import type { ChainBackend } from "./backend/types";
import { clusterMismatchText, clusterRefusal } from "./clusterGate";
import { errorMessage, toHex } from "./format";
import { migrateLegacyWithdrawals, unverifiableKeys, type BrowserLedgers } from "./ledger";
import {
  ClusterMismatchError,
  deriveVaultKey,
  IncompleteSearchError,
  keySequence,
  lmots,
  parseWithdrawMessage,
  RecipientConfirmationError,
  vaultAddress,
  VaultKeyInUseError,
  VaultLedgerError,
  withdrawMessage,
  type Cluster,
  type LmotsPublicKey,
  type PayoutAccount,
  type PendingWithdrawal,
  type PendingWithdrawalContinuation,
  type PendingWithdrawalSearch,
  type RecipientCheck,
  type RecipientConfirmation,
  type VaultInfo,
  type VaultKeyLedger,
  type VaultKeyRecord,
  type WithdrawTxArgs,
  type WithdrawTxWithFallback,
} from "./noised";
import {
  archiveWithdrawal,
  decodeHex,
  decodeKey,
  deleteSigningClaim,
  DifferentWithdrawalError,
  encodeKey,
  feePayerOf,
  integrityOf,
  parseWithdrawalBackup,
  saveNewWithdrawal,
  signingClaimFor,
  storageWorks,
  withdrawalFor,
  withdrawArgsOf,
  type StoredWithdrawal,
  type WithdrawalSource,
} from "./storage";

/** The chain reads the flow needs (the live SDK, the simulated chain, or a stub). */
export type VaultChain = Pick<
  ChainBackend,
  "mode" | "checkCluster" | "fetchVault" | "fetchPayout" | "checkRecipient" | "findPendingWithdrawal" | "prepareWithdrawal" | "buildWithdrawTx" | "buildWithdrawTxWithFallback" | "simulateAndExplain"
>;

/** The ledgers the flow signs through (lib/ledger.ts `browserLedgers()`, or a test's). */
export type SigningLedgers = Pick<BrowserLedgers, "vaultKeys" | "meta">;

/** The highest key sequence: keys exist for sequences 0..=2^32-1, and signing at `s` names the key of `s + 1`. */
const LAST_SIGNABLE_SEQUENCE = 0xffff_fffen;
const U64_MAX = (1n << 64n) - 1n;

export interface WithdrawRequest {
  cluster: Cluster;
  mint: PublicKey;
  /** Vault account number of the recovery phrase. */
  account: number;
  /** The vault of `account` (its genesis key's PDA). */
  vault: PublicKey;
  /** The recipient WALLET (never a token account). */
  destinationOwner: PublicKey;
  /** Upper bound; the withdrawal reserves `min(maxAmount, balance - reserved)`. */
  maxAmount: bigint;
  /** The connected wallet: its own token accounts for the mint are refused as recipients. */
  wallet?: PublicKey | null | undefined;
}

export interface RecipientReview {
  /** The vault as read now. */
  vault: VaultInfo;
  /** The SDK's `checkRecipient` result: it names the recipient, mint, vault and wallet it was made for. */
  check: RecipientCheck;
}

/** Step 1: read the vault and check the recipient (no key is touched). */
export async function reviewRecipient(chain: Pick<VaultChain, "fetchVault" | "checkRecipient">, conn: Connection, req: WithdrawRequest): Promise<RecipientReview> {
  const vault = await chain.fetchVault(conn, req.vault);
  if (vault === null) throw new Error(`Vault ${req.vault.toBase58()} is not open on this cluster.`);
  if (!vault.mint.equals(req.mint)) throw new Error("This vault holds another mint.");
  const check = await chain.checkRecipient(conn, req.destinationOwner, req.mint, req.vault, { wallet: req.wallet ?? null });
  return { vault, check };
}

/** What the user confirmed, kind by kind (L4): each is its own checkbox, never one "I accept everything". */
export interface Acknowledgments {
  /** The warnings about this recipient (`check.recipientWarnings`). */
  recipientWarnings: boolean;
  /** The warnings about the token and the vault (`check.mintWarnings`). */
  mintWarnings: boolean;
  /** The off-curve recipient with no account (`check.offCurveConfirmation`): a possible permanent loss. */
  offCurveConfirmation: boolean;
}

/** Whether every kind of caution `check` holds has its own acknowledgment. */
export function allAcknowledged(check: RecipientCheck, acks: Acknowledgments): boolean {
  return (
    check.ok &&
    (check.recipientWarnings.length === 0 || acks.recipientWarnings) &&
    (check.mintWarnings.length === 0 || acks.mintWarnings) &&
    (check.offCurveConfirmation === null || acks.offCurveConfirmation)
  );
}

/** The SDK's `opts.confirm`: the reviewed check, and true exactly for the kinds the user acknowledged. */
export function confirmationOf(check: RecipientCheck, acks: Acknowledgments): RecipientConfirmation {
  return { recipient: check, acknowledged: { recipientWarnings: acks.recipientWarnings, mintWarnings: acks.mintWarnings, offCurveConfirmation: acks.offCurveConfirmation } };
}

export type SignOutcome =
  /** The withdrawal is stored and read back (`signedNow` false: the key ledger already held this exact one; nothing was signed). */
  | { kind: "stored"; record: StoredWithdrawal; signedNow: boolean }
  /** The vault's current key already signed a withdrawal that is public on chain: it was recorded for re-broadcast, nothing was signed. */
  | { kind: "revealed"; record: StoredWithdrawal; search: PendingWithdrawalSearch }
  /**
   * The key ledger holds ANOTHER withdrawal of this key, signed (here, in
   * another tab, or on a device whose records were imported): nothing was
   * signed. Re-broadcast that one (`record`, stored for it; null if it could
   * not be stored here).
   */
  | { kind: "in-use"; record: StoredWithdrawal | null; withdrawal: WithdrawTxArgs }
  /**
   * The key ledger reserved this key for ANOTHER withdrawal that never
   * finished signing: nothing was signed. Only that same withdrawal may be
   * signed with this key: prepare it again (the signature is identical).
   */
  | { kind: "reserved"; destinationOwner: PublicKey; maxAmount: bigint }
  /** Nothing was signed. `check` is set when a fresh recipient check stopped it: show it and ask again. */
  | { kind: "refused"; code: RefusalCode; reason: string; check: RecipientCheck | null }
  /**
   * Nothing was signed: the history search could not rule out a revealed
   * signature of the current key. There is no override: when
   * `search.continuation` is set, sign again with it as `continueFrom` to
   * continue the search (it signs only once the search completes).
   */
  | { kind: "incomplete"; note: string; search: PendingWithdrawalSearch }
  /** Signed and in the key ledger, but this browser did not keep the app's record: download it; re-preparing the same withdrawal returns the same signature. */
  | { kind: "unsaved"; record: StoredWithdrawal; error: string };

/**
 * Why nothing was signed: `storage` (this browser cannot keep the record of
 * the withdrawal), `ledger` (the key ledger is unavailable or refused),
 * `unverifiable` (an import named keys this browser cannot check: sign on
 * the other device, or import a complete backup), `network` (the RPC
 * endpoint is not known to serve this build's cluster), `locks` (no Web
 * Locks API), `busy` (another tab is signing for this vault and sequence),
 * `locked` (the phrase was locked or changed while the flow ran), `vault`
 * (missing, another mint, not this phrase's account, last sequence),
 * `moved` (the vault's sequence changed since the review: review again),
 * `recipient` (refused now), `stale` (the recipient check changed since the
 * user confirmed it: confirm the new one), `confirm` (the confirmation does
 * not match the withdrawal: review again), `key` (the phrase does not hold
 * the current key), `signer` (the signer refused).
 */
export type RefusalCode =
  | "storage"
  | "ledger"
  | "unverifiable"
  | "network"
  | "locks"
  | "busy"
  | "locked"
  | "vault"
  | "moved"
  | "recipient"
  | "stale"
  | "confirm"
  | "key"
  | "signer";

export interface SignOptions {
  /** The sequence the user reviewed: signing stops if the vault moved since. */
  reviewedSequence: bigint;
  /** The user's confirmation of the reviewed recipient check (`confirmationOf`). */
  confirm: RecipientConfirmation;
  /** Continue an incomplete history search: the `search.continuation` of the last "incomplete" outcome. */
  continueFrom?: PendingWithdrawalContinuation | null | undefined;
  /** Fee payer of the record (default: a fresh throwaway key). */
  feePayer?: Keypair | undefined;
}

/** The part of the Web Locks API (`navigator.locks`) the flow uses. */
export interface SigningLocks {
  request<T>(name: string, options: { mode: "exclusive"; ifAvailable: true }, callback: (lock: unknown) => Promise<T>): Promise<T>;
}

/** The browser's lock manager, shared by every tab of this origin (null without the Web Locks API). */
function browserLocks(): SigningLocks | null {
  try {
    const locks = (globalThis as { navigator?: { locks?: unknown } }).navigator?.locks;
    if (typeof locks !== "object" || locks === null || typeof (locks as { request?: unknown }).request !== "function") return null;
    return locks as SigningLocks;
  } catch {
    return null;
  }
}

/** The Web Lock every tab takes before signing for (cluster, vault, sequence). */
export function signingLockName(cluster: Cluster, vault: PublicKey, sequence: bigint): string {
  return `noised-pq-sign:${cluster}:${vault.toBase58()}:${sequence.toString()}`;
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** A 64-byte seed that is not all zero (a wiped one is no phrase's seed, and every key derived from it is public). */
const isLiveSeed = (master: Uint8Array): boolean => master instanceof Uint8Array && master.length === 64 && master.some((b) => b !== 0);

/** The public key and key id of the phrase's key at `sequence`; its private seed is wiped at once. */
function publicKeyAt(seed: Uint8Array, req: Pick<WithdrawRequest, "cluster" | "mint" | "account">, sequence: bigint): { pk: LmotsPublicKey; keyId: Uint8Array } {
  const k = deriveVaultKey(seed, req.cluster, req.mint, req.account, keySequence(sequence));
  k.skSeed.fill(0);
  return { pk: k.pk, keyId: k.keyId };
}

/**
 * Whether a stored record can be a signature of the vault's current key: it
 * names that key, or its signature verifies with it over its stored message.
 * Anything else (a forged or mistaken import, a signature of another phrase,
 * cluster or sequence) can never execute and can never be a second
 * signature of that key.
 */
export function couldBeSignatureOf(w: StoredWithdrawal, vault: Pick<VaultInfo, "key">): boolean {
  const named = encodeKey(vault.key);
  if (w.key.id.toLowerCase() === named.id && w.key.q === named.q && w.key.k.toLowerCase() === named.k) return true;
  try {
    return lmots.verify(vault.key, decodeHex(w.message), decodeHex(w.signature));
  } catch {
    return false;
  }
}

function newRecord(
  chain: Pick<VaultChain, "mode">,
  req: Pick<WithdrawRequest, "cluster" | "mint" | "account" | "vault">,
  fields: { key: LmotsPublicKey; args: WithdrawTxArgs; source: WithdrawalSource; feePayer: Keypair },
): StoredWithdrawal {
  const now = Date.now();
  const a = fields.args;
  return {
    version: 4,
    mode: chain.mode,
    cluster: req.cluster,
    vault: req.vault.toBase58(),
    mint: req.mint.toBase58(),
    account: req.account,
    sequence: a.sequence.toString(),
    key: encodeKey(fields.key),
    nextKey: encodeKey(a.nextKey),
    destinationOwner: a.destinationOwner.toBase58(),
    maxAmount: a.maxAmount.toString(),
    message: toHex(withdrawMessage(a.vault, a.mint, a.sequence, a.destinationOwner, a.maxAmount, a.nextKeyId)),
    signature: toHex(a.signature),
    source: fields.source,
    feePayerSecret: toHex(fields.feePayer.secretKey),
    feePayerRefunded: false,
    status: "signed",
    lastIncludedRelease: null,
    lastTxSignature: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** A record for a withdrawal found on chain (its signature is public; any fee payer can relay it). `p.nextKey` must be authenticated. */
export function recordFromRevealed(
  chain: Pick<VaultChain, "mode">,
  req: Pick<WithdrawRequest, "cluster" | "mint" | "account" | "vault">,
  key: LmotsPublicKey,
  p: PendingWithdrawal,
  feePayer: Keypair,
): StoredWithdrawal {
  if (p.nextKey === null) throw new Error("This public withdrawal carries no authentic next key, so it cannot be re-broadcast as found.");
  const r = newRecord(chain, req, {
    key,
    args: { mint: p.mint, vault: p.vault, sequence: p.sequence, destinationOwner: p.destinationOwner, maxAmount: p.maxAmount, signature: p.signature, nextKey: p.nextKey, nextKeyId: p.nextKeyId },
    source: "revealed",
    feePayer,
  });
  return { ...r, status: p.failed ? "failed" : "broadcast", lastTxSignature: p.txSignature };
}

const refused = (code: RefusalCode, reason: string, check: RecipientCheck | null = null): SignOutcome => ({ kind: "refused", code, reason, check });

/**
 * Save `record` (and read it back), or say why not. A record of this slot
 * that cannot be a signature of the vault's key is archived first (L2); one
 * that can, with another signature, stays and wins.
 */
function keepRecord(record: StoredWithdrawal, vault: VaultInfo): { ok: true } | { ok: false; error: string } {
  try {
    saveNewWithdrawal(record);
    return { ok: true };
  } catch (e) {
    if (e instanceof DifferentWithdrawalError && !couldBeSignatureOf(e.existing, vault)) {
      try {
        archiveWithdrawal(e.existing, `Archived: its key is not the key of vault ${e.existing.vault} at sequence ${e.existing.sequence}, so it could never execute.`);
        saveNewWithdrawal(record);
        return { ok: true };
      } catch (again) {
        return { ok: false, error: errorMessage(again) };
      }
    }
    return { ok: false, error: errorMessage(e) };
  }
}

/**
 * Sign one withdrawal with the vault's current key, at most once, ever (see
 * the module docs for the order). Every refusal happens before the key
 * signs, and nothing is written to the key ledger before the SDK reserves
 * the key for exactly this message.
 *
 * `master` must stay unchanged while this runs: if it changes (the page's
 * Lock wipes it), the signer refuses and nothing is signed.
 */
export async function signWithdrawalOnce(chain: VaultChain, conn: Connection, master: Uint8Array, req: WithdrawRequest, ledgers: SigningLedgers, opts: SignOptions): Promise<SignOutcome> {
  if (!isLiveSeed(master)) return refused("locked", "Your quantum key is locked (its secret was wiped). Unlock it again; nothing was signed.");
  const seed = Uint8Array.from(master);
  try {
    if (!storageWorks()) {
      return refused("storage", "This browser cannot store data right now (private mode, blocked or full storage). Nothing was signed: a signed withdrawal must be saved before it can be broadcast.");
    }
    let blocked: readonly string[];
    try {
      blocked = await unverifiableKeys(ledgers);
    } catch (e) {
      return refused("ledger", `This browser's key records could not be read (${errorMessage(e)}). Nothing was signed.`);
    }
    if (blocked.length > 0) {
      return refused(
        "unverifiable",
        `A backup imported from another device says it signed with ${blocked.length} key${blocked.length === 1 ? "" : "s"} it could not include. Until a complete backup from that device is imported, this browser signs no withdrawals: it cannot tell whether one of those keys is the one it would use. Nothing was signed.`,
      );
    }
    const network = clusterRefusal(await chain.checkCluster(conn, req.cluster), req.cluster, chain.mode);
    if (network !== null) {
      return refused("network", `${network} Nothing was signed: a withdrawal message names no cluster, so a vault key signs only against an endpoint known to serve ${req.cluster}.`);
    }
    const locks = browserLocks();
    if (locks === null) {
      return refused(
        "locks",
        "This browser cannot keep its tabs from signing at the same time (it has no Web Locks API: an outdated browser, or the page is not served over https). Nothing was signed: two tabs could otherwise sign two different withdrawals with one one-time key. Use a current browser and open the app over https.",
      );
    }
    const outcome = await locks.request(signingLockName(req.cluster, req.vault, opts.reviewedSequence), { mode: "exclusive", ifAvailable: true }, async (lock) =>
      lock === null || lock === undefined ? null : signHoldingLock(chain, conn, master, seed, req, ledgers.vaultKeys, opts),
    );
    return (
      outcome ??
      refused("busy", "Another tab of this browser is signing a withdrawal of this vault at this sequence right now. Let it finish, then review again here; nothing was signed in this tab.")
    );
  } finally {
    seed.fill(0);
  }
}

async function signHoldingLock(
  chain: VaultChain,
  conn: Connection,
  master: Uint8Array,
  seed: Uint8Array,
  req: WithdrawRequest,
  ledger: VaultKeyLedger,
  opts: SignOptions,
): Promise<SignOutcome> {
  // 1. The vault as it is now, and the phrase's key for its current sequence (from the copy of the seed).
  const vault = await chain.fetchVault(conn, req.vault);
  if (vault === null) return refused("vault", `Vault ${req.vault.toBase58()} is not open on this cluster. Nothing was signed.`);
  if (!vault.mint.equals(req.mint)) return refused("vault", "This vault holds another mint. Nothing was signed.");
  if (vault.sequence !== opts.reviewedSequence) {
    return refused("moved", `The vault moved from sequence ${opts.reviewedSequence} to ${vault.sequence} since you reviewed this withdrawal (a withdrawal executed elsewhere). Review it again; nothing was signed.`);
  }
  if (vault.sequence > LAST_SIGNABLE_SEQUENCE) return refused("vault", "This vault has used its last key sequence. Nothing was signed.");
  const sequence = vault.sequence;
  const genesis = publicKeyAt(seed, req, 0n);
  if (!vaultAddress(req.mint, genesis.keyId).equals(req.vault)) return refused("vault", `Vault ${req.vault.toBase58()} is not account #${req.account} of your quantum key. Nothing was signed.`);
  const held = publicKeyAt(seed, req, sequence);
  if (!sameBytes(held.keyId, vault.keyId)) {
    return refused("key", `Your quantum key does not hold the vault's current key (vault account #${req.account}, sequence ${sequence}). Nothing was signed.`);
  }

  // 2. What this browser already knows about this key goes into the ledger first (older versions of this app).
  try {
    const local = withdrawalFor(req.vault, sequence);
    if (local !== null) {
      // A signature of the vault's current key is recorded under that key (even if the record's own key field is damaged).
      if (couldBeSignatureOf(local, vault)) {
        const migrated = await migrateLegacyWithdrawals(ledger, [{ ...local, key: encodeKey(vault.key) }]);
        if (migrated.skipped.length > 0) return refused("ledger", `This browser holds a withdrawal of this key that its key records cannot take (${migrated.skipped[0]?.reason ?? "unreadable"}). Nothing was signed.`);
      } else {
        archiveWithdrawal(
          local,
          `Archived: its key is not the key of vault ${local.vault} at sequence ${local.sequence}, so it could never execute (a forged or mistaken import, or a signature of another quantum key). It no longer blocks that key.`,
        );
      }
    }
    const claim = signingClaimFor(req.vault, sequence);
    if (claim !== null && claim.message !== "") {
      // An unfinished signing of an older version: this key may have signed that message, so it is reserved for it.
      const r = await ledger.reserve(held.keyId, decodeHex(claim.message), { vault: req.vault, sequence, key: held.pk });
      if (r !== "conflict") deleteSigningClaim(req.vault.toBase58(), sequence);
    } else if (claim !== null) {
      return refused("ledger", "An unreadable record of an unfinished signing holds this vault's key in this browser, so the key may have signed something. Nothing was signed.");
    }
  } catch (e) {
    return refused("ledger", `This browser's earlier records of this key could not be moved into its key records (${errorMessage(e)}). Nothing was signed.`);
  }

  // 3. The SDK's signer: confirmation, cluster, vault, ledger, history, recipient, then reserve, sign, record.
  let prepared: Awaited<ReturnType<VaultChain["prepareWithdrawal"]>>;
  try {
    prepared = await chain.prepareWithdrawal(
      conn,
      master,
      req.cluster,
      req.mint,
      req.account,
      { destinationOwner: req.destinationOwner, maxAmount: req.maxAmount },
      {
        ledger,
        confirm: opts.confirm,
        allowLocalnet: req.cluster === "localnet",
        ...(opts.continueFrom === undefined || opts.continueFrom === null ? {} : { continueFrom: opts.continueFrom }),
      },
    );
  } catch (e) {
    return refusalOf(e, chain, req, vault, held.pk, master, seed, opts);
  }

  const feePayer = opts.feePayer ?? Keypair.generate();
  if (prepared.signed !== null) {
    const record = newRecord(chain, req, { key: held.pk, args: prepared.signed.args, source: "signed", feePayer });
    const existing = withdrawalFor(req.vault, sequence);
    if (existing !== null && existing.signature === record.signature && existing.message === record.message) return { kind: "stored", record: existing, signedNow: false };
    const kept = keepRecord(record, vault);
    return kept.ok ? { kind: "stored", record, signedNow: !prepared.signed.reused } : { kind: "unsaved", record, error: kept.error };
  }
  const pending = prepared.pending;
  const search = prepared.search;
  if (pending === null || search === null) return refused("signer", "The signer returned neither a signature nor a withdrawal to re-broadcast. Nothing was signed.");
  const record = recordFromRevealed(chain, req, held.pk, pending, feePayer);
  if (search.all.length > 1) {
    record.lastError = `This key already signed ${search.all.length} different withdrawals (on another device or browser). Execute this one now: until one executes, the key's signatures could be combined into a forgery.`;
  }
  const kept = keepRecord(record, vault);
  return kept.ok ? { kind: "revealed", record, search } : { kind: "unsaved", record, error: kept.error };
}

/** What a refusal of the signer means for the user (nothing was signed in any of these cases). */
function refusalOf(e: unknown, chain: VaultChain, req: WithdrawRequest, vault: VaultInfo, key: LmotsPublicKey, master: Uint8Array, seed: Uint8Array, opts: SignOptions): SignOutcome {
  if (!isLiveSeed(master) || !sameBytes(master, seed)) {
    return refused("locked", "Your quantum key was locked (or changed) while the checks ran. Nothing was signed: unlock it and sign again.");
  }
  if (e instanceof VaultKeyInUseError) {
    if (e.withdrawal !== null) {
      const source: WithdrawalSource = e.record.origin === "found" ? "revealed" : e.record.origin === "imported" ? "imported" : "signed";
      const record = newRecord(chain, req, { key, args: e.withdrawal, source, feePayer: opts.feePayer ?? Keypair.generate() });
      const existing = withdrawalFor(req.vault, vault.sequence);
      if (existing !== null && existing.signature === record.signature) return { kind: "in-use", record: existing, withdrawal: e.withdrawal };
      return { kind: "in-use", record: keepRecord(record, vault).ok ? record : null, withdrawal: e.withdrawal };
    }
    try {
      const m = parseWithdrawMessage(decodeHex(e.record.message));
      return { kind: "reserved", destinationOwner: m.destinationOwner, maxAmount: m.maxAmount };
    } catch {
      return refused("ledger", "This key is reserved in this browser's key records for a withdrawal whose record cannot be read. Nothing was signed.");
    }
  }
  if (e instanceof RecipientConfirmationError) {
    if (e.reason === "stale") return refused("stale", "The recipient check changed since you confirmed it. Read the new check and confirm again; nothing was signed.", e.current);
    if (e.reason === "refused") return refused("recipient", "The recipient check refuses this recipient now. Nothing was signed.", e.current);
    return refused("confirm", `Your confirmation does not match this withdrawal (${e.reason}): review the recipient again. Nothing was signed.`);
  }
  if (e instanceof IncompleteSearchError) return { kind: "incomplete", note: e.search.note ?? "The vault's history could not be read back far enough.", search: e.search };
  if (e instanceof ClusterMismatchError) return refused("network", clusterMismatchText(e) ?? e.message);
  if (e instanceof VaultLedgerError) return refused("ledger", `This browser's key records refused: ${e.message} Nothing was signed.`);
  return refused("signer", `Not signed: ${errorMessage(e)}`);
}

// ------------------------------------------------------------------- import ---

/** The vault-key ledger record of a stored withdrawal (authenticated by the ledger's `importRecord`). */
export function ledgerRecordOf(w: StoredWithdrawal, origin: VaultKeyRecord["origin"]): VaultKeyRecord {
  const key = decodeKey(w.key);
  const message = decodeHex(w.message);
  return {
    keyId: toHex(lmots.keyId(key)),
    vault: w.vault,
    sequence: w.sequence,
    message: w.message.toLowerCase(),
    messageHash: toHex(sha256(message)),
    status: "signed",
    signature: w.signature.toLowerCase(),
    key: { id: w.key.id.toLowerCase(), q: w.key.q, k: w.key.k.toLowerCase() },
    nextKey: { id: w.nextKey.id.toLowerCase(), q: w.nextKey.q, k: w.nextKey.k.toLowerCase() },
    origin,
    createdAt: w.createdAt,
    updatedAt: Date.now(),
  };
}

/**
 * Import a backup made by `exportWithdrawal` (for example from another
 * device). Accepted only when it verifies on its own, is for this build's
 * cluster, and the vault exists here, waits at the backup's sequence and its
 * CURRENT key verifies the backup's signature: a backup of any other key
 * (forged, or of another phrase or cluster) could never execute and is
 * refused. The key ledger then records the key as used for this withdrawal
 * (authenticated; a key it holds for another withdrawal refuses the
 * import). A stored record of this slot that cannot be a signature of the
 * vault's key is archived; one that can is never replaced. Nothing is
 * imported when this throws.
 */
export async function importWithdrawalBackup(chain: Pick<ChainBackend, "fetchVault">, conn: Connection, text: string, cluster: Cluster, ledger: VaultKeyLedger): Promise<StoredWithdrawal> {
  const w = parseWithdrawalBackup(text);
  const integrity = integrityOf(w);
  if (!integrity.ok) throw new Error(`${integrity.reason ?? "The backup does not verify."} Nothing was imported.`);
  if (w.cluster !== cluster) throw new Error(`This backup is for ${w.cluster}; this app is built for ${cluster}. Import it in a ${w.cluster} build. Nothing was imported.`);
  const args = withdrawArgsOf(w);
  const vault = await chain.fetchVault(conn, args.vault);
  if (vault === null) throw new Error(`There is no vault at ${w.vault} on ${cluster}. Nothing was imported.`);
  if (!vault.mint.equals(args.mint)) throw new Error("This backup names another mint than the vault holds: it could never execute. Nothing was imported.");
  if (vault.sequence > args.sequence) throw new Error(`The vault is at sequence ${vault.sequence}: sequence ${args.sequence} was already used, so this withdrawal can never execute. Nothing was imported.`);
  if (vault.sequence < args.sequence) throw new Error(`The vault is at sequence ${vault.sequence}; this withdrawal is for sequence ${args.sequence} and cannot execute. Nothing was imported.`);
  const message = withdrawMessage(args.vault, vault.mint, args.sequence, args.destinationOwner, args.maxAmount, args.nextKeyId);
  if (!lmots.verify(vault.key, message, args.signature)) {
    throw new Error(`This backup was not signed by the key of vault ${w.vault} at sequence ${w.sequence}, so it could never execute (a forged backup, or one of another quantum key). Nothing was imported.`);
  }
  const existing = withdrawalFor(w.vault, w.sequence);
  if (existing !== null) {
    if (existing.signature === w.signature && existing.message === w.message) throw new Error("This browser already holds this signed withdrawal.");
    if (couldBeSignatureOf(existing, vault)) {
      throw new Error(
        `This browser holds a different withdrawal of the same key at sequence ${w.sequence}: this key signed two messages. Execute one of them now (re-broadcast the stored one). Nothing was imported.`,
      );
    }
  }
  const outcome = await ledger.importRecord(ledgerRecordOf(w, "imported"));
  if (outcome.outcome === "conflict") {
    throw new Error(
      `This browser's key records hold a different withdrawal of this key at sequence ${w.sequence}${outcome.compromised ? ", already signed: this key signed two messages, so execute one of them now" : ""}. Nothing was imported.`,
    );
  }
  if (existing !== null) archiveWithdrawal(existing, `Archived: its key is not the key of vault ${existing.vault} at sequence ${existing.sequence}, so it could never execute; an imported withdrawal of that key replaced it.`);
  saveNewWithdrawal(w);
  return w;
}

// ---------------------------------------------------------------- broadcast ---

/** A different withdrawal of the same key and sequence is already public: broadcasting the stored one would reveal a second signature. */
export class RevealedConflictError extends Error {
  readonly revealed: PendingWithdrawal;

  constructor(revealed: PendingWithdrawal) {
    super(
      `A different withdrawal of this vault's current key is already public (transaction ${revealed.txSignature}, to ${revealed.destinationOwner.toBase58()}). Broadcasting the stored one would reveal a second signature of a one-time key, so it is blocked. Re-broadcast the public one instead.`,
    );
    this.name = "RevealedConflictError";
    this.revealed = revealed;
  }
}

/** `planBroadcast` stopped before building: the history search could not rule out a different public withdrawal of this key. */
export class IncompleteBroadcastSearchError extends Error {
  readonly search: PendingWithdrawalSearch;

  constructor(search: PendingWithdrawalSearch) {
    super(
      `The vault's history could not be fully checked for a different withdrawal of this key (${search.note ?? "incomplete history"}). Nothing was built or sent: ${
        search.continuation === null ? "" : "continue the search, or "
      }confirm explicitly that you want to broadcast anyway.`,
    );
    this.name = "IncompleteBroadcastSearchError";
    this.search = search;
  }
}

export interface BroadcastOptions {
  /** Continue an incomplete history search: the `search.continuation` of the last `IncompleteBroadcastSearchError`. */
  continueFrom?: PendingWithdrawalContinuation | null | undefined;
  /** The user explicitly confirmed broadcasting although the search could not rule out a different public withdrawal of this key. */
  broadcastDespiteIncompleteSearch?: boolean | undefined;
}

export interface BroadcastPlan extends WithdrawTxWithFallback {
  /** Why the history search could not rule out other revealed signatures (null when it could). */
  searchNote: string | null;
}

/**
 * Withdraw + release when the pair passes simulation now, else the
 * withdrawal alone, for a signature that is ALREADY public on chain (so
 * simulating reveals nothing new) but that the key ledger cannot hold: the
 * ledger holds another signature of this key, unrevealed, from this browser.
 */
async function publicWithdrawal(chain: VaultChain, conn: Connection, payer: Keypair, args: Omit<WithdrawTxArgs, "includeRelease">): Promise<WithdrawTxWithFallback> {
  let releaseError = "";
  try {
    const pair = await chain.buildWithdrawTx(conn, payer, { ...args, includeRelease: true });
    const simulation = await chain.simulateAndExplain(conn, pair.tx);
    if (simulation.ok || simulation.failedInstruction === 0) return { ...pair, releaseError: null, simulation };
    releaseError = simulation.failedInstruction === 1 ? `the release fails: ${simulation.error ?? "unknown error"}` : `withdraw + release fails as a whole: ${simulation.error ?? "unknown error"}`;
  } catch (e) {
    releaseError = `withdraw + release could not be built (${errorMessage(e)})`;
  }
  const alone = await chain.buildWithdrawTx(conn, payer, { ...args, includeRelease: false });
  return { ...alone, releaseError, simulation: await chain.simulateAndExplain(conn, alone.tx) };
}

/**
 * The transaction that broadcasts (or re-broadcasts) a stored withdrawal:
 * the stored signature, a fresh blockhash, the record's throwaway fee
 * payer. Refuses a damaged record, a vault that moved past the record's
 * sequence, and a record whose key already revealed a DIFFERENT signature
 * (`RevealedConflictError`). When the history search is incomplete it stops
 * before building or simulating anything (`IncompleteBroadcastSearchError`)
 * unless the user confirmed explicitly. Simulating reveals the signature, so
 * it must be in the key ledger first (an older record is added, authenticated)
 * or already public. Never signs with a vault key.
 */
export async function planBroadcast(chain: VaultChain, conn: Connection, w: StoredWithdrawal, ledger: VaultKeyLedger, opts: BroadcastOptions = {}): Promise<BroadcastPlan> {
  const integrity = integrityOf(w);
  if (!integrity.ok) throw new Error(`This record cannot be broadcast: ${integrity.reason ?? "damaged"}`);
  const args = withdrawArgsOf(w);
  const search = await chain.findPendingWithdrawal(conn, args.vault, opts.continueFrom === undefined || opts.continueFrom === null ? {} : { continueFrom: opts.continueFrom });
  if (search.vault.sequence > args.sequence) {
    throw new Error(`The vault is at sequence ${search.vault.sequence}: the withdrawal of sequence ${args.sequence} has already executed. Deliver its payout if it is still pending; never sign again for an old sequence.`);
  }
  if (search.vault.sequence < args.sequence) throw new Error(`The vault is at sequence ${search.vault.sequence}; this withdrawal is for sequence ${args.sequence} and cannot execute yet.`);
  const other = search.all.find((p) => toHex(p.signature) !== w.signature.toLowerCase());
  if (other !== undefined) throw new RevealedConflictError(other);
  if (!search.complete && opts.broadcastDespiteIncompleteSearch !== true) throw new IncompleteBroadcastSearchError(search);
  const searchNote = search.complete ? null : (search.note ?? "The vault's history could not be read back far enough.");
  const keyId = lmots.keyId(decodeKey(w.key));
  let held = await ledger.get(keyId);
  if (held === null || held.signature !== w.signature.toLowerCase()) {
    // A record of an older version of this app (or one whose migration failed): the ledger learns it first.
    await migrateLegacyWithdrawals(ledger, [w]);
    held = await ledger.get(keyId);
  }
  if (held !== null && held.signature === w.signature.toLowerCase()) {
    return { ...(await chain.buildWithdrawTxWithFallback(conn, feePayerOf(w), args, { ledger })), searchNote };
  }
  if (search.all.some((p) => toHex(p.signature) === w.signature.toLowerCase())) return { ...(await publicWithdrawal(chain, conn, feePayerOf(w), args)), searchNote };
  throw new Error(
    "This browser's key records hold a different withdrawal of this key, so this one is not broadcast: it would reveal a second signature of a one-time key. Re-broadcast the withdrawal the key records hold.",
  );
}

// ------------------------------------------------------------------ verdict ---

export type RecordVerdict =
  /** No vault at the record's address on this cluster. */
  | { kind: "missing" }
  /** The vault waits at the record's sequence and the stored signature verifies with its current key: broadcast it. */
  | { kind: "pending"; vault: VaultInfo }
  /** The vault is at the record's sequence but its current key is not the record's: this signature can never execute. */
  | { kind: "dead"; vault: VaultInfo }
  /** The vault is at an earlier sequence: this withdrawal cannot execute yet. */
  | { kind: "early"; vault: VaultInfo }
  /**
   * The record's sequence was used. `payout` is the payout of that sequence
   * while it waits for delivery (null once delivered); `ours` says whether
   * it names this record's recipient (null when the payout is gone).
   */
  | { kind: "executed"; vault: VaultInfo; payout: PayoutAccount | null; ours: boolean | null };

/** What the chain says about a stored withdrawal now. */
export async function recordVerdict(chain: Pick<ChainBackend, "fetchVault" | "fetchPayout">, conn: Connection, w: StoredWithdrawal): Promise<RecordVerdict> {
  const args = withdrawArgsOf(w);
  const vault = await chain.fetchVault(conn, args.vault);
  if (vault === null) return { kind: "missing" };
  if (vault.sequence < args.sequence) return { kind: "early", vault };
  if (vault.sequence === args.sequence) {
    const msg = withdrawMessage(args.vault, args.mint, args.sequence, args.destinationOwner, args.maxAmount, args.nextKeyId);
    return lmots.verify(vault.key, msg, args.signature) ? { kind: "pending", vault } : { kind: "dead", vault };
  }
  const payout = await chain.fetchPayout(conn, args.vault, args.sequence);
  return { kind: "executed", vault, payout, ours: payout === null ? null : payout.destinationOwner.equals(args.destinationOwner) };
}

/** A record that can never execute (its key was never the vault's at its sequence, or another withdrawal used that sequence): removing it cannot lose a usable signature. */
export function cannotExecute(v: RecordVerdict | undefined): boolean {
  return v !== undefined && (v.kind === "dead" || (v.kind === "executed" && v.ours === false));
}

/** Plain words for a maximum amount (u64 max is "everything available"). */
export function maxAmountText(maxAmount: bigint): string {
  return maxAmount === U64_MAX ? "everything available" : `${maxAmount} base units`;
}

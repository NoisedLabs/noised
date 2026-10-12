/**
 * PQ vault client, vault v4 (SPEC §3): the 185-byte `PHX-PQV4` message
 * (byte-identical to programs/noised-vault/src/message.rs), deterministic
 * signing, the mint policy of `open_vault`, recipient checks, and builders
 * for open / deposit / withdraw (v1) / release / release_to.
 *
 * A vault lives at `["vault", mint, genesis_key_id]` forever. Every
 * withdrawal is signed by the vault's current key over its current
 * `sequence`; it reserves `min(max_amount, balance - reserved)` in a payout
 * PDA `["payout", vault, u64le(sequence)]` and hands the vault to the next
 * key. `release` (anyone, to the recipient's canonical ATA) or `release_to`
 * (signed by the recipient, to any token account of the mint) delivers it.
 *
 * Rules every caller must follow (SPEC §3.10):
 * 1. One key, one signature, ever. Every signing entry point
 *    (`prepareWithdrawal`, `signWithdrawal`) takes a durable vault-key ledger
 *    (`./vaultLedger.ts`, no default): the key is reserved for the message
 *    in it (atomic add) BEFORE any signature exists, the signature is
 *    recorded in it before it is returned, and a key holding a record never
 *    signs another message (`VaultKeyInUseError`, with the recorded
 *    withdrawal to re-broadcast). `buildWithdrawTxWithFallback` simulates
 *    (reveals) only a signature that ledger holds. Before signing for a
 *    vault's current sequence, also look for an already revealed signature
 *    on chain (`findPendingWithdrawal`) and re-broadcast it instead; never
 *    sign while that search is incomplete (continue it instead). Signing is
 *    deterministic (the identical message gives the identical signature).
 *    Every device holding the phrase must share one ledger (or use its own
 *    vault accounts). Within one process, a key that signed, or was seen
 *    signing, one withdrawal (computed, read back from a ledger, found on
 *    chain) never signs another, whatever ledger a later call passes.
 * 2. Confirm the recipient BEFORE signing: the program cannot tell a wallet
 *    from a token account, a mint or a PDA, and a signed message cannot be
 *    changed. Every signing entry point requires `opts.confirm`
 *    (`RecipientConfirmation`): `checkRecipient` for this exact recipient,
 *    mint and vault, plus the user's acknowledgment of each kind of caution
 *    it holds (recipient warnings, mint warnings, the off-curve
 *    confirmation). It refuses (`RecipientConfirmationError`, no signature,
 *    no ledger write) a check with refusals, a caution not acknowledged, a
 *    check of another recipient, mint or vault, and a stale one (the check
 *    re-run right before signing finds a refusal or caution the user was not
 *    shown). What is signed is what was confirmed: the signers work on
 *    private copies of their inputs taken at the call, and match the
 *    confirmation against the exact bytes right before signing.
 * 3. The fee payer of a withdrawal is a throwaway Ed25519 key with no
 *    authority over the vault; fund it with a little SOL only.
 * 4. Sign only against the cluster the keys are for: every signing entry
 *    point (`prepareWithdrawal`, `signWithdrawal`) takes the Connection and
 *    checks its genesis hash first (`assertCluster`). A signature names
 *    accounts that exist at the same addresses on every cluster, so a
 *    mislabeled devnet run must never sign with mainnet keys.
 * 5. Keys sit at their positions (vault key-index binding): the genesis key
 *    has `q = 0` and the withdrawal at `sequence` names the next key of
 *    `q = sequence + 1` (the program refuses anything else, InvalidKeyIndex).
 *    The SDK refuses to sign or build anything else.
 *
 * Deposits go to the vault's token account, ATA(vault, mint). Native SOL or
 * tokens of another mint sent to the vault PDA itself are unrecoverable.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { createSyncNativeInstruction, createTransferCheckedWithTransferHookInstruction } from "@solana/spl-token";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  type AccountMeta,
  type Connection,
  type Keypair,
  type TransactionInstruction,
} from "@solana/web3.js";
import { Buffer } from "buffer";

import { encodeBase58 } from "../codec/base58.js";
import { bytesEqual, fromHex, isAllZero, isU64, toHex, U32_MAX } from "../codec/bytes.js";
import { buildInstruction } from "../codec/ix.js";
import { FEE_PAYER_FUNDING_LAMPORTS, KNOWN_ACCOUNTS, PROGRAM_IDS, VAULT, WSOL_MINT, type Cluster } from "../constants.js";
import { idlCodecs } from "../idl/index.js";
import { clusterUnixTime } from "../launch/window.js";
import { associatedTokenAddress, payoutAddress, vaultAddress } from "../pda.js";
import { assertCluster, type AssertClusterOptions } from "../rpc/cluster.js";
import { computeBudgetInstructions, computeUnitLimitOf, computeUnitPriceOf, MAX_COMPUTE_UNIT_LIMIT, priorityFeeLamports, type ComputeBudgetOptions } from "../rpc/computeBudget.js";
import { getAccount, getAccounts, ownedBy, rpcRequest, type RawAccount } from "../rpc/fetch.js";
import { LEGACY_MAX_TRANSACTION_SIZE, simulateAndExplain } from "../rpc/index.js";
import { launchGuardEndTs, mutableOwnerRefusal, resolveHookAccounts } from "../token/hook.js";
import {
  defaultAccountStateOf,
  ExtensionType,
  extensionName,
  MintParseError,
  mintCloseAuthorityOf,
  hasImmutableOwner,
  parseMint,
  parseTokenAccount,
  pausableOf,
  permanentDelegateOf,
  TOKEN_ACCOUNT_SIZE,
  tokenAccountExtensions,
  transferFeeConfigOf,
  transferHookOf,
  type ParsedMint,
} from "../token/mint.js";
import { compileV1Message, decodeV1Transaction, signV1Message, v1TransactionId } from "../tx/v1.js";
import type {
  CheckRecipientOptions,
  PayoutAccount,
  PayoutListing,
  PendingWithdrawal,
  PendingWithdrawalContinuation,
  PendingWithdrawalSearch,
  PendingWithdrawalSearchOptions,
  RecipientCheck,
  RecipientConfirmation,
  ScannedVault,
  SimulationReport,
  VaultAccount,
  VaultInfo,
  VaultKeyMaterial,
  VaultMintCheck,
  WithdrawTxArgs,
} from "../types.js";
import { checkMaster, deriveVaultKey, GENESIS_KEY_INDEX, keySequence, nextKeyIndex } from "./keys.js";
import * as lmots from "./lmots.js";
import { VaultKeyInUseError, VaultLedgerError, type VaultKeyLedger, type VaultKeyRecord } from "./vaultLedger.js";
import { parseWithdrawMessage, withdrawMessage, type ParsedWithdrawMessage } from "./withdrawMessage.js";

export { payoutAddress, vaultAddress };

/**
 * Default compute-unit limits (tight, with margin). Measured in LiteSVM with
 * the mainnet feature set and SBPF v3 builds, 27 runs logged on 2026-10-08
 * and 2026-10-09 (tests/integration `withdraw_and_release_sizes_and_compute`,
 * key-index binding included): `withdraw` 81k-110k;
 * `release` creating the recipient's ATA 34k-58k (SPL Token) and 64k-96k
 * (Token-2022 with the Launch Guard hook); both together 116k-172k and
 * 145k-190k. LM-OTS verification walks 990 chain steps at worst against
 * about 510 on average (about 150 CU each), so `withdraw` is sized for the
 * worst possible digest. A transfer hook other than the Launch Guard can
 * cost anything, so its release keeps a wide limit. Running out of compute
 * units only fails the transaction: rebuild it with a higher
 * `computeUnitLimit` and re-broadcast the SAME signature.
 */
export const VAULT_COMPUTE_UNITS = {
  /** `withdraw` (either token program; it moves no tokens): worst digest ~170k. */
  withdraw: 200_000,
  /** `release` / `release_to`, SPL Token, creating the recipient's ATA. */
  releaseSplToken: 80_000,
  /** `release` / `release_to`, Token-2022 without a hook or with the Launch Guard hook. */
  releaseToken2022: 130_000,
  /** `release` / `release_to` of a mint with any other transfer hook program. */
  releaseOtherHook: 300_000,
} as const;

/** The default compute-unit limit of a payout transfer of `parsed` (see `VAULT_COMPUTE_UNITS`). */
function releaseComputeUnits(tokenProgram: PublicKey, parsed: ParsedMint): number {
  if (!tokenProgram.equals(KNOWN_ACCOUNTS.token2022)) return VAULT_COMPUTE_UNITS.releaseSplToken;
  let hook: PublicKey | null = null;
  try {
    hook = transferHookOf(parsed)?.programId ?? null;
  } catch {
    return VAULT_COMPUTE_UNITS.releaseOtherHook;
  }
  return hook === null || hook.equals(PROGRAM_IDS.hook) ? VAULT_COMPUTE_UNITS.releaseToken2022 : VAULT_COMPUTE_UNITS.releaseOtherHook;
}

/** Wire size of a legacy transaction with all its signatures (unsigned ones count as 64 bytes). */
function legacySize(tx: Transaction): number {
  const message = tx.compileMessage();
  const signatures = message.header.numRequiredSignatures;
  return (signatures < 0x80 ? 1 : 2) + 64 * signatures + message.serialize().length;
}

/** Refuse a legacy transaction over 1,232 bytes (it could never be sent). */
function checkLegacySize(tx: Transaction, what: string): Transaction {
  const size = legacySize(tx);
  if (size > LEGACY_MAX_TRANSACTION_SIZE) throw new RangeError(`${what} would be ${size} bytes, over the ${LEGACY_MAX_TRANSACTION_SIZE}-byte legacy limit (too many transfer-hook accounts?)`);
  return tx;
}

/** Extensions `vaultMintPolicy` explains (or that are purely descriptive); any other present type is listed. */
const EXPLAINED_EXTENSIONS: ReadonlySet<number> = new Set([
  ExtensionType.TransferFeeConfig,
  ExtensionType.NonTransferable,
  ExtensionType.PermanentDelegate,
  ExtensionType.Pausable,
  ExtensionType.TransferHook,
  ExtensionType.DefaultAccountState,
  ExtensionType.MintCloseAuthority,
  ExtensionType.ConfidentialMintBurn,
  ExtensionType.InterestBearingConfig,
  ExtensionType.ScaledUiAmount,
  ExtensionType.MetadataPointer,
  ExtensionType.TokenMetadata,
  ExtensionType.GroupPointer,
  ExtensionType.TokenGroup,
  ExtensionType.GroupMemberPointer,
  ExtensionType.TokenGroupMember,
]);

// ------------------------------------------------------------- message ---

export { parseWithdrawMessage, WITHDRAW_MESSAGE_FIELDS, withdrawMessage } from "./withdrawMessage.js";
export type { ParsedWithdrawMessage } from "./withdrawMessage.js";

// ------------------------------------------------------------- signing ---

/**
 * The deterministic randomizer `C` of a withdrawal signature:
 * `HMAC-SHA256(SEED, "phalanx/pq/lmots/C" || I || u32be(q) || msg)`
 * (`noised_lmots::PrivateKey::randomizer`).
 */
export function randomizer(skSeed: Uint8Array, pk: lmots.LmotsPublicKey, msg: Uint8Array): Uint8Array {
  return lmots.randomizer({ id: pk.id, q: pk.q, seed: skSeed }, msg);
}

/**
 * Key id (hex) -> the message (hex) this process has seen that key sign: a
 * signature it computed, one it returned or read back from a vault-key
 * ledger, or one it found on chain. The first message seen for a key wins,
 * and `signChecked` refuses any other: whatever ledger a later call is given
 * (a fresh one, a cleared store), this process never signs a second message
 * with a key it knows is spent.
 */
const signedThisSession = new Map<string, string>();

/** This process has seen `pk` sign `msg` (a signature verified under `pk`): arm the one-message-per-key guard. */
function sawSignature(pk: lmots.LmotsPublicKey, msg: Uint8Array): void {
  const id = toHex(lmots.keyId(pk));
  if (!signedThisSession.has(id)) signedThisSession.set(id, toHex(msg));
}

/**
 * Every local refusal of a withdrawal signature (no RPC). Returns the parsed
 * message; throws, without consuming the key, when the message is not a
 * well-formed PHX-PQV4 withdrawal of this program, the seed does not
 * re-derive `pk`, the keys break the key-index binding (the signing key's
 * `q` must be the message's sequence; `nextKey` must hash to the message's
 * next key id and have `q = sequence + 1`), the next key is empty or this
 * same key, or the recipient is the vault itself or the all-zero address.
 */
function checkSignable(skSeed: Uint8Array, pk: lmots.LmotsPublicKey, msg: Uint8Array, nextKey: lmots.LmotsPublicKey): ParsedWithdrawMessage {
  const parsed = parseWithdrawMessage(msg);
  if (!(skSeed instanceof Uint8Array) || skSeed.length !== lmots.N) throw new Error("refusing to sign: the seed must be 32 bytes");
  if (!bytesEqual(lmots.publicKey({ id: pk.id, q: pk.q, seed: skSeed }).k, pk.k)) throw new Error("refusing to sign: the seed does not match the vault key");
  if (BigInt(pk.q) !== parsed.sequence) {
    throw new Error(`refusing to sign: the message is for sequence ${parsed.sequence}, but this is the key of sequence ${pk.q} (a vault's key at sequence n has q = n)`);
  }
  const wantQ = nextKeyIndex(parsed.sequence);
  if (wantQ === null) throw new Error(`refusing to sign: sequence ${parsed.sequence} is a vault's last; no next key can follow it (InvalidKeyIndex)`);
  const keyId = lmots.keyId(pk);
  if (isAllZero(parsed.nextKeyId)) throw new Error("refusing to sign: empty next key id");
  if (bytesEqual(parsed.nextKeyId, keyId)) throw new Error("refusing to sign: the next key must be a different key");
  let nextId: Uint8Array;
  try {
    nextId = lmots.keyId(nextKey);
  } catch {
    throw new Error("refusing to sign: the next key is malformed");
  }
  if (!bytesEqual(nextId, parsed.nextKeyId)) {
    throw new Error("refusing to sign: the next key does not hash to the message's next key id (KeyIdMismatch): the withdrawal could never execute");
  }
  if (nextKey.q !== wantQ) {
    throw new Error(
      `refusing to sign: the next key has index q = ${nextKey.q}, but the withdrawal at sequence ${parsed.sequence} must name the key of index ${wantQ} (InvalidKeyIndex): it could never execute`,
    );
  }
  if (parsed.destinationOwner.equals(parsed.vault)) {
    throw new Error("refusing to sign: the recipient is the vault itself, so nothing would be paid; name the wallet that should receive the tokens");
  }
  if (parsed.destinationOwner.equals(PublicKey.default)) throw new Error("refusing to sign: the recipient is the all-zero address");
  return parsed;
}

/**
 * The signature itself, synchronously: every check of `checkSignable`, then
 * the one-signature-per-key guard of this process, the deterministic
 * signature and its self-verification. Callers check the cluster and the
 * vault first (`signWithdrawal`, `prepareWithdrawal`).
 */
function signChecked(skSeed: Uint8Array, pk: lmots.LmotsPublicKey, msg: Uint8Array, nextKey: lmots.LmotsPublicKey): Uint8Array {
  checkSignable(skSeed, pk, msg, nextKey);
  const id = toHex(lmots.keyId(pk));
  const message = toHex(msg);
  const previous = signedThisSession.get(id);
  if (previous !== undefined && previous !== message) {
    throw new Error("refusing to sign: this one-time key already signed a different withdrawal in this session; re-broadcast that stored signature instead");
  }
  signedThisSession.set(id, message);
  const sk = { id: pk.id, q: pk.q, seed: skSeed };
  const sig = lmots.signDeterministic(sk, msg);
  if (sig.length !== VAULT.SIGNATURE_LEN || !lmots.verify(pk, msg, sig)) throw new Error("signature self-check failed");
  return sig;
}

/** The ledger an entry point was given (refused before anything else when missing: there is no default). */
function requireLedger(opts: { readonly ledger?: VaultKeyLedger | undefined } | undefined, what: string): VaultKeyLedger {
  const ledger = opts?.ledger;
  if (ledger === undefined || ledger === null || typeof ledger !== "object" || typeof ledger.reserve !== "function" || typeof ledger.get !== "function") {
    throw new TypeError(
      `${what} needs opts.ledger, a durable vault-key ledger (createVaultKeyLedger on a persistent store with an atomic add, shared by every tab and device holding the phrase): a one-time key must be recorded before it signs`,
    );
  }
  return ledger;
}

/** The withdrawal a record holds, ready to rebuild (null when it was never signed or its next key is unknown). */
export function withdrawalFromRecord(record: VaultKeyRecord): WithdrawTxArgs | null {
  if (record.signature === null || record.nextKey === null) return null;
  const m = parseWithdrawMessage(fromHex(record.message));
  return {
    mint: m.mint,
    vault: m.vault,
    sequence: m.sequence,
    destinationOwner: m.destinationOwner,
    maxAmount: m.maxAmount,
    signature: fromHex(record.signature),
    nextKey: { id: fromHex(record.nextKey.id), q: record.nextKey.q, k: fromHex(record.nextKey.k) },
    nextKeyId: m.nextKeyId,
  };
}

/**
 * `VaultKeyInUseError` for `record`. When the record holds a signature that
 * verifies under `pk` (the key it is for), this process has now seen that key
 * sign the record's withdrawal: the session guard is armed with it.
 */
function inUse(record: VaultKeyRecord, pk: lmots.LmotsPublicKey): VaultKeyInUseError {
  let detail = "";
  try {
    const message = fromHex(record.message);
    const m = parseWithdrawMessage(message);
    detail = ` (max ${m.maxAmount} base units to ${m.destinationOwner.toBase58()}, sequence ${m.sequence})`;
    if (record.signature !== null && lmots.verify(pk, message, fromHex(record.signature))) sawSignature(pk, message);
  } catch {
    detail = "";
  }
  return new VaultKeyInUseError(record, withdrawalFromRecord(record), detail);
}

/**
 * A signed record without its key (written by SDK 0.2.0) cannot be exported
 * (`exportVaultKeyRecords` skips it as `no-key`), so another device would
 * never learn that the key is spent. Whenever this process holds the
 * record's key `pk`, the record gets it: `importRecord` authenticates the
 * completed record (its signature must verify under `pk` over its message)
 * before writing it. Best effort: a record that does not authenticate stays
 * as it is, and is still enforced by this ledger. Returns the record as it
 * is now.
 */
async function completeRecordKey(ledger: VaultKeyLedger, rec: VaultKeyRecord | null, pk: lmots.LmotsPublicKey): Promise<VaultKeyRecord | null> {
  if (rec === null || rec.key !== null || rec.signature === null || rec.keyId !== toHex(lmots.keyId(pk))) return rec;
  try {
    await ledger.importRecord({ ...rec, key: { id: toHex(pk.id), q: pk.q, k: toHex(pk.k) } });
    return (await ledger.get(lmots.keyId(pk))) ?? rec;
  } catch {
    return rec;
  }
}

/**
 * The ledger rule around `signChecked`: reserve `pk`'s key id for `msg`
 * (atomic add) BEFORE any signature exists, sign, record the signature, and
 * only then return it. A key already recorded for this exact message returns
 * the recorded signature (verified, never re-signed); a key recorded for any
 * other message throws `VaultKeyInUseError`. `beforeSign` runs synchronously
 * right before the signature is computed (no await in between). `msg`,
 * `skSeed`, `pk` and `nextKey` are the caller's private copies.
 */
async function signRecorded(
  ledger: VaultKeyLedger,
  skSeed: Uint8Array,
  pk: lmots.LmotsPublicKey,
  msg: Uint8Array,
  nextKey: lmots.LmotsPublicKey,
  beforeSign: () => void = () => undefined,
): Promise<{ signature: Uint8Array; reused: boolean }> {
  const parsed = checkSignable(skSeed, pk, msg, nextKey);
  const keyId = lmots.keyId(pk);
  const seen = signedThisSession.get(toHex(keyId));
  if (seen !== undefined && seen !== toHex(msg)) {
    // This process saw the key sign another withdrawal: refused before anything is written to this ledger
    // (with the ledger's own record of that withdrawal when it has one).
    const known = await ledger.get(keyId);
    if (known !== null && known.messageHash !== toHex(sha256(msg))) throw inUse(known, pk);
    throw new Error("refusing to sign: this one-time key already signed a different withdrawal in this session; re-broadcast that stored signature instead");
  }
  const reservation = await ledger.reserve(keyId, msg, { vault: parsed.vault, sequence: parsed.sequence, key: pk });
  const rec = await ledger.get(keyId);
  if (rec === null) throw new VaultLedgerError("the vault-key reservation was not persisted: nothing was signed");
  if (reservation === "conflict" || rec.messageHash !== toHex(sha256(msg))) throw inUse(rec, pk);
  if (rec.signature !== null) {
    const recorded = fromHex(rec.signature);
    if (!lmots.verify(pk, msg, recorded)) throw new VaultLedgerError("the recorded signature does not verify with this key over this withdrawal (another key, or a corrupted record): nothing was signed");
    sawSignature(pk, msg);
    if (rec.nextKey === null) await ledger.recordSignature(keyId, msg, recorded, nextKey);
    await completeRecordKey(ledger, rec, pk);
    return { signature: recorded, reused: true };
  }
  beforeSign();
  const signature = signChecked(skSeed, pk, msg, nextKey);
  await ledger.recordSignature(keyId, msg, signature, nextKey);
  // A reservation written by SDK 0.2.0 (no key) is now signed: give it its key so that it can be exported.
  if (rec.key === null) await completeRecordKey(ledger, await ledger.get(keyId), pk);
  return { signature, reused: false };
}

/** A private copy of an LM-OTS public key (malformed fields are kept as they are, for the signer's own checks to refuse). */
function copyLmotsKey(k: lmots.LmotsPublicKey): lmots.LmotsPublicKey {
  if (k === null || typeof k !== "object") return k;
  return {
    id: k.id instanceof Uint8Array ? Uint8Array.from(k.id) : k.id,
    q: k.q,
    k: k.k instanceof Uint8Array ? Uint8Array.from(k.k) : k.k,
  };
}

/** `signWithdrawal` options: the vault-key ledger (required) and `allowLocalnet` (see `assertCluster`). */
export interface SignWithdrawalOptions extends AssertClusterOptions {
  /** Durable vault-key records (`createVaultKeyLedger`); required, no default. */
  readonly ledger: VaultKeyLedger;
  /** The user's confirmation of `checkRecipient` for the message's recipient, mint and vault; required, no default (`RecipientConfirmation`). */
  readonly confirm: RecipientConfirmation;
}

/**
 * Sign a withdraw message with the vault's current key `key`, naming
 * `nextKey` (the key `msg`'s next key id commits to), with the deterministic
 * randomizer: signing the identical message again returns the identical
 * signature, so a retry never becomes a second one-time signature.
 *
 * In order, refusing (throwing) without consuming the key:
 * 1. `opts.ledger` and `opts.confirm` are present (no defaults); the local
 *    checks: a well-formed PHX-PQV4 withdrawal of this program;
 *    `key.skSeed` re-derives `key.pk`; the key-index binding (`key.pk.q` is
 *    the message's sequence; `nextKey` hashes to the message's next key id
 *    and has `q = sequence + 1`, so the withdrawal can execute); the next key
 *    is not empty nor this key; the recipient is neither the vault itself
 *    nor the all-zero address;
 * 2. the recipient confirmation, still without the network
 *    (`RecipientConfirmationError`): `opts.confirm.recipient` is the
 *    `checkRecipient` result for the message's recipient, mint and vault,
 *    with no refusal, and the user acknowledged each kind of caution it
 *    holds;
 * 3. `assertCluster(conn, cluster, opts)`: the endpoint must serve the
 *    cluster `key` was derived for (localnet only with `allowLocalnet`);
 * 4. the vault the message names exists on that cluster, holds its mint, is
 *    at the message's sequence and its current key is `key` (never a
 *    signature by a future or a spent key);
 * 5. unless the ledger already holds this exact withdrawal's signature
 *    (nothing new is signed then), `checkRecipient` runs again: a refusal,
 *    or a caution the confirmed check did not hold, refuses (`stale`);
 * 6. the ledger (`opts.ledger`): the key is reserved for `msg` (atomic add)
 *    before any signature exists. A key already recorded for this exact
 *    message returns the recorded signature; a key recorded for any other
 *    message throws `VaultKeyInUseError` (with the recorded withdrawal to
 *    re-broadcast);
 * 7. right before signing, with no await in between: `key.skSeed` must be
 *    unchanged (a "lock" that wipes it stops the signature), the
 *    confirmation is matched again against the exact bytes about to be
 *    signed, and the local checks run again; this key must not have signed
 *    (or been seen signing) a DIFFERENT message in this process either,
 *    whatever ledger (that is also refused before the reservation).
 * The signature is verified, then recorded in the ledger, and only then
 * returned. Every refusal before step 6 leaves the ledger untouched.
 *
 * Every input is copied at entry (`msg`, `key`, `nextKey` and
 * `opts.confirm`, its keys, cautions and acknowledgments): what is checked,
 * confirmed and signed is what the caller passed at the call, even if the
 * caller's objects change while the call awaits the network. The copy of
 * `key.skSeed` is wiped before returning; `key.skSeed` itself is compared
 * with it before the reservation and right before signing.
 *
 * Before calling it: `findPendingWithdrawal` (re-broadcast instead of
 * signing again); `prepareWithdrawal` does all of it.
 */
export async function signWithdrawal(
  conn: Connection,
  cluster: Cluster,
  key: Pick<VaultKeyMaterial, "skSeed" | "pk">,
  nextKey: lmots.LmotsPublicKey,
  msg: Uint8Array,
  opts: SignWithdrawalOptions,
): Promise<Uint8Array> {
  const ledger = requireLedger(opts, "signWithdrawal");
  const confirm = requireConfirmation(opts, "signWithdrawal");
  // Private copies, taken now: a buffer or key edited while this call awaits the network never changes what is signed.
  const message = msg instanceof Uint8Array ? Uint8Array.from(msg) : msg;
  const seed = key !== null && typeof key === "object" && key.skSeed instanceof Uint8Array ? Uint8Array.from(key.skSeed) : (key?.skSeed as Uint8Array);
  const pk = copyLmotsKey(key?.pk as lmots.LmotsPublicKey);
  const next = copyLmotsKey(nextKey);
  try {
    const parsed = checkSignable(seed, pk, message, next);
    assertConfirmed(confirm, parsed);
    await assertCluster(conn, cluster, opts);
    const v = await fetchVaultAccount(conn, parsed.vault);
    if (v === null) throw new Error(`refusing to sign: vault ${parsed.vault.toBase58()} does not exist on ${cluster}`);
    if (!v.mint.equals(parsed.mint)) throw new Error("refusing to sign: the vault holds a different mint than the message names");
    if (v.sequence !== parsed.sequence) {
      throw new Error(
        `refusing to sign: the vault is at sequence ${v.sequence}, the message is for sequence ${parsed.sequence}${
          v.sequence > parsed.sequence ? " (that withdrawal already executed: never sign for an old sequence)" : ""
        }`,
      );
    }
    if (!bytesEqual(v.keyId, lmots.keyId(pk))) throw new Error("refusing to sign: this key is not the vault's current key");
    const recorded = await completeRecordKey(ledger, await ledger.get(lmots.keyId(pk)), pk);
    const alreadySigned = recorded !== null && recorded.signature !== null && recorded.messageHash === toHex(sha256(message));
    if (!alreadySigned) await recheckRecipient(conn, confirm, parsed);
    const unchanged = (): void => {
      if (!(key.skSeed instanceof Uint8Array) || !bytesEqual(key.skSeed, seed)) {
        throw new Error("refusing to sign: key.skSeed changed while signWithdrawal ran (was it wiped by a lock?); nothing was signed");
      }
    };
    unchanged(); // before the reservation: a lock meanwhile leaves no record behind
    return (
      await signRecorded(ledger, seed, pk, message, next, () => {
        unchanged();
        // Synchronously before signing: the bytes about to be signed name the confirmed recipient, mint and vault.
        assertConfirmed(confirm, parseWithdrawMessage(message));
      })
    ).signature;
  } finally {
    if (seed instanceof Uint8Array) seed.fill(0);
  }
}

// ------------------------------------------------------------- accounts ---

interface RawVault {
  version: number;
  bump: number;
  mint: PublicKey;
  genesisKeyId: Uint8Array;
  sequence: bigint;
  keyId: Uint8Array;
  keyIdent: Uint8Array;
  keyQ: number;
  keyK: Uint8Array;
  reserved: bigint;
}

/** Decode a `Vault` account; refuses other versions and accounts that are not at their own PDA. */
export function decodeVault(publicKey: PublicKey, data: Uint8Array): VaultAccount {
  const v = idlCodecs().vault.decodeAccount<RawVault>("Vault", data);
  if (v.version !== VAULT.VERSION) throw new Error(`vault ${publicKey.toBase58()} has version ${v.version}; this SDK reads version ${VAULT.VERSION}`);
  const key: lmots.LmotsPublicKey = { id: v.keyIdent, q: v.keyQ, k: v.keyK };
  if (!vaultAddress(v.mint, v.genesisKeyId).equals(publicKey)) throw new Error(`vault ${publicKey.toBase58()} is not the PDA of its mint and genesis key`);
  if (!bytesEqual(lmots.keyId(key), v.keyId)) throw new Error(`vault ${publicKey.toBase58()}: key id does not match its key`);
  return {
    publicKey,
    version: v.version,
    bump: v.bump,
    mint: v.mint,
    genesisKeyId: v.genesisKeyId,
    sequence: v.sequence,
    keyId: v.keyId,
    key,
    reserved: v.reserved,
  };
}

/** Decode a `Payout` account; refuses accounts that are not at their own PDA. */
export function decodePayout(publicKey: PublicKey, data: Uint8Array): PayoutAccount {
  const p = idlCodecs().vault.decodeAccount<Omit<PayoutAccount, "publicKey">>("Payout", data);
  if (p.version !== VAULT.PAYOUT_VERSION) throw new Error(`payout ${publicKey.toBase58()} has version ${p.version}`);
  if (!payoutAddress(p.vault, p.sequence).equals(publicKey)) throw new Error(`payout ${publicKey.toBase58()} is not the PDA of its vault and sequence`);
  return { ...p, publicKey };
}

async function fetchVaultAccount(conn: Connection, vault: PublicKey): Promise<VaultAccount | null> {
  const acc = ownedBy(await getAccount(conn, vault), PROGRAM_IDS.vault, "Vault");
  return acc === null ? null : decodeVault(vault, acc.data);
}

function tokenProgramOf(mint: RawAccount | null, address: PublicKey): PublicKey {
  if (mint === null) throw new Error(`mint ${address.toBase58()} does not exist`);
  if (!mint.owner.equals(KNOWN_ACCOUNTS.splToken) && !mint.owner.equals(KNOWN_ACCOUNTS.token2022)) {
    throw new Error(`mint ${address.toBase58()} is owned by ${mint.owner.toBase58()}, not a token program`);
  }
  return mint.owner;
}

function tokenBalance(acc: RawAccount | null | undefined): bigint {
  return acc === null || acc === undefined || acc.data.length === 0 ? 0n : parseTokenAccount(acc.owner, acc.data).amount;
}

function withBalance(v: VaultAccount, tokenProgram: PublicKey, tokenAccount: RawAccount | null | undefined): VaultInfo {
  const balance = tokenBalance(tokenAccount);
  return {
    ...v,
    tokenProgram,
    tokenAccount: associatedTokenAddress(v.publicKey, v.mint, tokenProgram),
    balance,
    available: balance > v.reserved ? balance - v.reserved : 0n,
  };
}

/** A vault with its token account balance, or null if it does not exist. */
export async function fetchVault(conn: Connection, vault: PublicKey): Promise<VaultInfo | null> {
  const v = await fetchVaultAccount(conn, vault);
  if (v === null) return null;
  const [mintAcc, spl, t22] = await getAccounts(conn, [
    v.mint,
    associatedTokenAddress(vault, v.mint, KNOWN_ACCOUNTS.splToken),
    associatedTokenAddress(vault, v.mint, KNOWN_ACCOUNTS.token2022),
  ]);
  const tokenProgram = tokenProgramOf(mintAcc ?? null, v.mint);
  return withBalance(v, tokenProgram, tokenProgram.equals(KNOWN_ACCOUNTS.token2022) ? t22 : spl);
}

/** The payout of `vault` at `sequence`, or null (never withdrawn at that sequence, or already released). */
export async function fetchPayout(conn: Connection, vault: PublicKey, sequence: bigint): Promise<PayoutAccount | null> {
  const address = payoutAddress(vault, sequence);
  const acc = ownedBy(await getAccount(conn, address), PROGRAM_IDS.vault, "Payout");
  return acc === null ? null : decodePayout(address, acc.data);
}

/** `Payout.vault` offset: discriminator (8), version (1), bump (1). */
const PAYOUT_VAULT_OFFSET = 10;
/** Payout PDAs probed when the RPC refuses `getProgramAccounts`. */
const PAYOUT_PROBE_LIMIT = 1_000;

/**
 * A listing of `v`'s payouts: `complete` only if the method covered every
 * sequence and the amounts add up to the vault's `reserved` (every reserved
 * token belongs to exactly one unreleased payout; zero payouts add nothing).
 */
function listing(v: VaultAccount, payouts: PayoutAccount[], method: PayoutListing["method"], covered: boolean, note: string | null): PayoutListing {
  payouts.sort((a, b) => (a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0));
  const sum = payouts.reduce((total, p) => total + p.amount, 0n);
  if (sum === v.reserved) return { payouts, complete: covered, method, note };
  const gap = `The listed payouts add up to ${sum} but the vault reserves ${v.reserved}: some are missing (or one was just released; read again).`;
  return { payouts, complete: false, method, note: note === null ? gap : `${note} ${gap}` };
}

async function listPayoutsOf(conn: Connection, v: VaultAccount): Promise<PayoutListing> {
  const codec = idlCodecs().vault;
  let refused: string;
  try {
    const accounts = await conn.getProgramAccounts(PROGRAM_IDS.vault, {
      commitment: "confirmed",
      filters: [
        { dataSize: codec.accountSize("Payout") },
        { memcmp: { offset: 0, bytes: encodeBase58(codec.accountDiscriminator("Payout")) } },
        { memcmp: { offset: PAYOUT_VAULT_OFFSET, bytes: v.publicKey.toBase58() } },
      ],
    });
    const payouts: PayoutAccount[] = [];
    for (const a of accounts) {
      try {
        const p = decodePayout(a.pubkey, new Uint8Array(a.account.data.buffer, a.account.data.byteOffset, a.account.data.byteLength));
        if (p.vault.equals(v.publicKey)) payouts.push(p);
      } catch {
        // Not a payout of this vault (or malformed): the reserved-sum check reports a gap.
      }
    }
    return listing(v, payouts, "getProgramAccounts", true, null);
  } catch (e) {
    refused = e instanceof Error ? e.message : String(e);
  }
  // Degrade: payouts sit at deterministic PDAs below the vault's sequence.
  const from = v.sequence > BigInt(PAYOUT_PROBE_LIMIT) ? v.sequence - BigInt(PAYOUT_PROBE_LIMIT) : 0n;
  const sequences: bigint[] = [];
  for (let s = from; s < v.sequence; s++) sequences.push(s);
  const accounts = await getAccounts(conn, sequences.map((s) => payoutAddress(v.publicKey, s)));
  const payouts: PayoutAccount[] = [];
  accounts.forEach((acc, i) => {
    if (acc === null || acc === undefined || !acc.owner.equals(PROGRAM_IDS.vault)) return;
    try {
      payouts.push(decodePayout(payoutAddress(v.publicKey, sequences[i]!), acc.data));
    } catch {
      // Not a payout: the reserved-sum check reports a gap.
    }
  });
  const covered = from === 0n;
  const note = `The RPC refused getProgramAccounts (${refused}); probed the payout addresses of sequences ${from}..${v.sequence}${covered ? "" : ": older payouts were not checked"}.`;
  return listing(v, payouts, "probe", covered, note);
}

/**
 * The vault's unreleased payouts: one `getProgramAccounts` with a memcmp on
 * the payout's vault field. If the RPC refuses it, the payout PDAs of the
 * last 1,000 sequences are probed instead. `complete` says whether every
 * sequence was covered and the amounts add up to the vault's `reserved`.
 */
export async function listPayouts(conn: Connection, vault: PublicKey): Promise<PayoutListing> {
  const v = await fetchVaultAccount(conn, vault);
  if (v === null) throw new Error(`vault ${vault.toBase58()} does not exist`);
  return listPayoutsOf(conn, v);
}

// ---------------------------------------------------------- mint policy ---

/**
 * Pure mirror of `open_vault`'s mint checks (`token::require_supported_mint`
 * plus Anchor's `InterfaceAccount<Mint>` deserialization) and the warnings
 * clients must show (SPEC §3.5).
 */
export function vaultMintPolicy(account: RawAccount | null): VaultMintCheck {
  const refusals: string[] = [];
  const warnings: string[] = [];
  if (account === null || account.data.length === 0) {
    return { eligible: false, refusals: ["The mint account does not exist."], warnings, tokenProgram: null };
  }
  const isT22 = account.owner.equals(KNOWN_ACCOUNTS.token2022);
  if (!isT22 && !account.owner.equals(KNOWN_ACCOUNTS.splToken)) {
    return { eligible: false, refusals: [`Not a token mint: owned by ${account.owner.toBase58()}.`], warnings, tokenProgram: null };
  }
  let mint: ParsedMint;
  try {
    mint = parseMint(account.owner, account.data);
  } catch (e) {
    const why = e instanceof MintParseError ? e.message : String(e);
    return { eligible: false, refusals: [`The vault program cannot parse this mint (${why}); open_vault would fail.`], warnings, tokenProgram: account.owner };
  }
  const types = new Set(mint.extensions.map((x) => x.type));
  const safely = <T>(f: () => T): T | "malformed" => {
    try {
      return f();
    } catch (e) {
      if (e instanceof MintParseError) return "malformed";
      throw e;
    }
  };
  // The refusals of `require_supported_mint` (which stops at the first one).
  if (types.has(ExtensionType.NonTransferable)) refusals.push("NonTransferable: tokens could never leave the vault.");
  if (types.has(ExtensionType.PermanentDelegate)) {
    const d = safely(() => permanentDelegateOf(mint));
    const who = d === "malformed" ? "a malformed delegate" : d ? d.toBase58() : "no delegate set now";
    refusals.push(`PermanentDelegate (${who}): an Ed25519 key could move tokens out of any account, the vault's included.`);
  }
  if (types.has(ExtensionType.MintCloseAuthority)) {
    const c = safely(() => mintCloseAuthorityOf(mint));
    if (c === "malformed" || c === undefined) refusals.push("MintCloseAuthority cannot be parsed; open_vault would fail.");
    else if (c !== null) {
      refusals.push(
        `MintCloseAuthority ${c.toBase58()}: at zero supply the mint could be closed and re-created at the same address with a permanent delegate, which would drain the vault.`,
      );
    }
  }
  if (types.has(ExtensionType.TransferFeeConfig)) {
    const cfg = safely(() => transferFeeConfigOf(mint));
    if (cfg === "malformed" || cfg === null) {
      refusals.push("TransferFeeConfig cannot be parsed; open_vault would fail.");
    } else {
      if (cfg.configAuthority !== null) refusals.push(`TransferFeeConfig authority ${cfg.configAuthority.toBase58()} could raise the fee to 100% and take payouts.`);
      if (cfg.withdrawWithheldAuthority !== null) refusals.push(`Withdraw-withheld authority ${cfg.withdrawWithheldAuthority.toBase58()} could collect fees withheld from the vault's transfers.`);
      const bps = Math.max(cfg.olderTransferFee.basisPoints, cfg.newerTransferFee.basisPoints);
      if (cfg.configAuthority === null && cfg.withdrawWithheldAuthority === null && bps > 0) {
        warnings.push(`A fixed transfer fee of up to ${bps} bps (max ${cfg.newerTransferFee.maximumFee} base units) applies to deposits and payouts; no authority can change it.`);
      }
    }
  }
  if (mint.mintAuthority !== null) warnings.push(`Mint authority ${mint.mintAuthority.toBase58()} can mint more tokens (dilution); it cannot take vaulted tokens.`);
  warnings.push(...releaseDelayWarnings(mint));
  if (types.has(ExtensionType.ConfidentialMintBurn)) warnings.push("ConfidentialMintBurn: part of the supply can be minted or burned confidentially.");
  if (types.has(ExtensionType.InterestBearingConfig) || types.has(ExtensionType.ScaledUiAmount)) {
    warnings.push("Displayed amounts are rescaled by an authority-controlled rate; raw vault balances are unaffected.");
  }
  if (isT22) warnings.push("Token-2022 is upgradeable by a 4-of-6 multisig of Ed25519 keys; SPL Token mints (e.g. wSOL) give the strongest custody.");
  for (const t of types) {
    if (!EXPLAINED_EXTENSIONS.has(t)) warnings.push(`Extension ${extensionName(t)} is present.`);
  }
  return { eligible: refusals.length === 0, refusals, warnings, tokenProgram: mint.programId };
}

/** Mint powers that can delay a payout (freeze, pause, transfer hook, default-frozen accounts); none can block `withdraw`. */
function releaseDelayWarnings(mint: ParsedMint): string[] {
  const warnings: string[] = [];
  const types = new Set(mint.extensions.map((x) => x.type));
  const safely = <T>(f: () => T): T | null => {
    try {
      return f();
    } catch (e) {
      if (e instanceof MintParseError) return null;
      throw e;
    }
  };
  if (mint.freezeAuthority !== null) {
    warnings.push(`Freeze authority ${mint.freezeAuthority.toBase58()} can freeze the vault's or the recipient's token account and delay payouts until thawed.`);
  }
  if (types.has(ExtensionType.Pausable)) {
    const p = safely(() => pausableOf(mint));
    if (p !== null) warnings.push(`Pause authority ${p.authority?.toBase58() ?? "(none)"} can halt all transfers of this token and delay payouts${p.paused ? "; the mint is paused right now" : ""}.`);
    else warnings.push("Pausable: transfers of this token can be halted, delaying payouts.");
  }
  if (types.has(ExtensionType.TransferHook)) {
    const h = safely(() => transferHookOf(mint));
    if (h !== null) {
      if (h.programId !== null) warnings.push(`Transfer hook program ${h.programId.toBase58()} runs on every transfer and can refuse a payout for a while (the payout stays reserved; release it later, never re-sign).`);
      if (h.authority !== null) warnings.push(`Transfer-hook authority ${h.authority.toBase58()} can ${h.programId === null ? "install" : "replace"} the hook program.`);
    }
  }
  if (types.has(ExtensionType.DefaultAccountState) && safely(() => defaultAccountStateOf(mint)) === 2) {
    warnings.push("New token accounts start frozen: a recipient's new account must be thawed by the freeze authority before a payout can land.");
  }
  return warnings;
}

/** `open_vault`'s refusals for `mint` plus the warnings clients must show. */
export async function checkVaultMint(conn: Connection, mint: PublicKey): Promise<VaultMintCheck> {
  return vaultMintPolicy(await getAccount(conn, mint));
}

// ----------------------------------------------------------- recipients ---

/** `MemoTransfer.require_incoming_transfer_memos`. */
function requiresMemo(data: Uint8Array): boolean {
  const e = tokenAccountExtensions(data).find((x) => x.type === ExtensionType.MemoTransfer);
  return e !== undefined && e.data[0] === 1;
}

/** `ConfidentialTransferAccount.allow_non_confidential_credits` (byte 262 of the 295-byte extension); true without the extension. */
function acceptsNonConfidentialCredits(data: Uint8Array): boolean {
  const e = tokenAccountExtensions(data).find((x) => x.type === ExtensionType.ConfidentialTransferAccount);
  if (e === undefined) return true;
  if (e.data.length !== 295) throw new MintParseError("ConfidentialTransferAccount has an unexpected length");
  return e.data[262] === 1;
}

/**
 * Why a payout into token account `acc` would fail now (null if it would
 * not). `moving`: a non-zero amount is transferred (a frozen or
 * confidential-only account only matters then).
 */
function destinationProblem(acc: RawAccount, mint: PublicKey, tokenProgram: PublicKey, moving: boolean): string | null {
  if (!acc.owner.equals(tokenProgram)) return `it is owned by ${acc.owner.toBase58()}, not the mint's token program`;
  const t = parseTokenAccount(acc.owner, acc.data);
  if (!t.mint.equals(mint)) return "it holds another mint";
  if (!moving) return null;
  if (t.state === 2) return "it is frozen";
  if (tokenProgram.equals(KNOWN_ACCOUNTS.token2022) && !acceptsNonConfidentialCredits(acc.data)) return "it refuses non-confidential credits (confidential-only account)";
  return null;
}

/**
 * Payout PDAs of the vault that `checkRecipient` recognises, whether they
 * exist or not: every sequence up to this many before the vault's current
 * one (released payouts have no account any more, and a payout made to one
 * is lost), the current one, and this many after it.
 */
const RECIPIENT_PAYOUTS_BEFORE = 1_024n;
const RECIPIENT_PAYOUTS_AFTER = 64n;

/**
 * The refusal for a recipient address this check recognises as one that can
 * never use a payout (null if it recognises none): the all-zero address, the
 * vault, the vault's own token account, the connected wallet's own token
 * account, or a payout PDA of this vault. The token accounts and payouts are
 * PDAs, so they are only compared with off-curve addresses.
 */
function recognisedRecipient(destinationOwner: PublicKey, mint: PublicKey, vault: PublicKey, vaultSequence: bigint | null, wallet: PublicKey | null): string | null {
  const who = destinationOwner.toBase58();
  if (destinationOwner.equals(PublicKey.default)) return "The recipient is the all-zero address: nobody can ever sign for it.";
  if (destinationOwner.equals(vault)) {
    return "The recipient is this vault itself: the withdrawal would pay nothing and only rotate the key. Name the wallet that should receive the tokens.";
  }
  if (PublicKey.isOnCurve(destinationOwner.toBytes())) return null;
  const tokenPrograms = [KNOWN_ACCOUNTS.splToken, KNOWN_ACCOUNTS.token2022];
  if (tokenPrograms.some((tp) => associatedTokenAddress(vault, mint, tp).equals(destinationOwner))) {
    return `${who} is this vault's own token account (its deposit address), not a wallet: the payout would go to a token account owned by that address, which nobody can use. Name the wallet that should receive the tokens.`;
  }
  if (wallet !== null && tokenPrograms.some((tp) => associatedTokenAddress(wallet, mint, tp).equals(destinationOwner))) {
    return `${who} is your connected wallet's own token account for this mint, not a wallet: the payout would go to a token account owned by that address, which nobody can use. Name your wallet address ${wallet.toBase58()} instead.`;
  }
  const around = vaultSequence ?? 0n;
  const from = around > RECIPIENT_PAYOUTS_BEFORE ? around - RECIPIENT_PAYOUTS_BEFORE : 0n;
  for (let s = from; s <= around + RECIPIENT_PAYOUTS_AFTER; s++) {
    if (payoutAddress(vault, s).equals(destinationOwner)) {
      return `${who} is the payout address of this vault's withdrawal at sequence ${s} (a Noised vault program address), not a wallet: nobody could ever move a payout made to it. Withdraw to a wallet.`;
    }
  }
  return null;
}

/**
 * Whether `destinationOwner` can safely be named as the recipient of a
 * withdrawal from `vault` (C2 of the audit). Run it before signing: the
 * program cannot tell a wallet from a token account, a mint or a PDA, and a
 * signed message cannot be changed.
 *
 * Refuses (`refusals`): the all-zero address; the vault itself (nothing
 * would be paid); the vault's own token account, for either token program;
 * the connected wallet's own token account for this mint, for either token
 * program (`opts.wallet`); a payout PDA of this vault (the 1,024 sequences
 * before the vault's current one, that one and the 64 after it), whether it
 * exists or not (a released payout has no account); any account owned
 * by SPL Token or Token-2022 (a token account, mint or multisig: the payout
 * would go to a token account owned by that address, which nobody can use);
 * any account of the vault program (a vault or a payout); a mint that does
 * not exist or is not a token mint.
 *
 * `offCurveConfirmation`: an off-curve recipient with no account on chain
 * (a never-used program wallet, or a closed or not-yet-created token
 * account, an unopened vault or payout address: a permanent loss). It needs
 * its own explicit confirmation.
 *
 * `recipientWarnings`: a program or an account of another program; an
 * existing off-curve account (a program wallet: only its program can sign
 * `release_to`); a canonical ATA that was reassigned, requires memos (fine:
 * the program adds one), refuses non-confidential credits, is frozen
 * (`release_to` needed) or cannot be read. `mintWarnings`: mint powers that
 * can delay a payout, an unparseable mint, the vault's token account frozen
 * right now. Warnings never block the withdrawal itself.
 *
 * The result names the recipient, mint, vault and wallet it was made for:
 * pass it with the user's acknowledgments as `opts.confirm` to
 * `prepareWithdrawal` / `signWithdrawal` (`RecipientConfirmation`).
 */
export async function checkRecipient(
  conn: Connection,
  destinationOwner: PublicKey,
  mint: PublicKey,
  vault: PublicKey,
  opts: CheckRecipientOptions = {},
): Promise<RecipientCheck> {
  if (!(destinationOwner instanceof PublicKey) || !(mint instanceof PublicKey) || !(vault instanceof PublicKey)) throw new TypeError("destinationOwner, mint and vault must be PublicKeys");
  if (opts.wallet !== undefined && opts.wallet !== null && !(opts.wallet instanceof PublicKey)) throw new TypeError("opts.wallet must be a PublicKey");
  const refusals: string[] = [];
  const recipientWarnings: string[] = [];
  const mintWarnings: string[] = [];
  let offCurveConfirmation: string | null = null;
  const who = destinationOwner.toBase58();
  const ataSpl = associatedTokenAddress(destinationOwner, mint, KNOWN_ACCOUNTS.splToken);
  const ataT22 = associatedTokenAddress(destinationOwner, mint, KNOWN_ACCOUNTS.token2022);
  const [ownerAcc, mintAcc, splAcc, t22Acc, vaultSplAcc, vaultT22Acc, vaultAcc] = await getAccounts(conn, [
    destinationOwner,
    mint,
    ataSpl,
    ataT22,
    associatedTokenAddress(vault, mint, KNOWN_ACCOUNTS.splToken),
    associatedTokenAddress(vault, mint, KNOWN_ACCOUNTS.token2022),
    vault,
  ]);
  let vaultSequence: bigint | null = null;
  try {
    const owned = ownedBy(vaultAcc ?? null, PROGRAM_IDS.vault, "Vault");
    if (owned !== null) vaultSequence = decodeVault(vault, owned.data).sequence;
  } catch {
    // Not a readable vault: payout PDAs are recognised around sequence 0.
  }

  const recognised = recognisedRecipient(destinationOwner, mint, vault, vaultSequence, opts.wallet ?? null);
  const owner = ownerAcc ?? null;
  if (recognised !== null) refusals.push(recognised);
  else if (owner !== null && (owner.data.length > 0 || owner.executable)) {
    if (owner.owner.equals(KNOWN_ACCOUNTS.splToken) || owner.owner.equals(KNOWN_ACCOUNTS.token2022)) {
      const kind = owner.data.length === 82 || (owner.data.length > TOKEN_ACCOUNT_SIZE && owner.data[TOKEN_ACCOUNT_SIZE] === 1) ? "mint" : owner.data.length === 355 ? "token multisig" : "token account";
      refusals.push(
        `${who} is a ${kind} (owned by ${owner.owner.toBase58()}), not a wallet: the payout would go to a token account owned by that address, which nobody can use. Name the wallet that owns it instead.`,
      );
    } else if (owner.owner.equals(PROGRAM_IDS.vault)) {
      refusals.push(`${who} is an account of the Noised vault program (a vault or a payout), not a wallet: it cannot sign release_to and nobody could move a payout made to it. Withdraw to a wallet.`);
    } else if (owner.executable) {
      recipientWarnings.push(`${who} is a program, not a wallet: tokens paid to its token account can be moved only by whoever holds that address's private key, if anyone.`);
    } else if (!owner.owner.equals(KNOWN_ACCOUNTS.system)) {
      recipientWarnings.push(`${who} is an account of program ${owner.owner.toBase58()}, not a plain wallet: make sure that program can use tokens paid to its canonical token account.`);
    }
  }
  if (refusals.length === 0 && !PublicKey.isOnCurve(destinationOwner.toBytes())) {
    if (owner === null) {
      offCurveConfirmation = `${who} is off the Ed25519 curve (no private key exists for it) and has no account on chain. It can be a program's wallet that was never used, such as a multisig vault: then release pays its canonical token account and only that program can move the tokens. But if it is the address of a token account (an associated token account that was closed or not created yet), of a vault or a payout, or any address no program controls, the payout is lost forever. Confirm only if you know which program controls ${who} and that it can use tokens of this mint.`;
    } else {
      recipientWarnings.push(
        `${who} is a program address (off the Ed25519 curve) with no private key: release can pay its canonical token account, but release_to (needed if that account cannot receive) can only be signed by its program.`,
      );
    }
  }

  let canonicalAta: PublicKey | null = null;
  let parsed: ParsedMint | null = null;
  const m = mintAcc ?? null;
  if (m === null || m.data.length === 0) refusals.push(`The mint ${mint.toBase58()} does not exist.`);
  else if (!m.owner.equals(KNOWN_ACCOUNTS.splToken) && !m.owner.equals(KNOWN_ACCOUNTS.token2022)) refusals.push(`${mint.toBase58()} is not a token mint.`);
  else {
    canonicalAta = m.owner.equals(KNOWN_ACCOUNTS.token2022) ? ataT22 : ataSpl;
    try {
      parsed = parseMint(m.owner, m.data);
    } catch (e) {
      mintWarnings.push(`The mint cannot be parsed (${e instanceof Error ? e.message : String(e)}): payouts may fail.`);
    }
  }
  const ata = canonicalAta === null ? null : ((canonicalAta.equals(ataT22) ? t22Acc : splAcc) ?? null);
  if (canonicalAta !== null && ata !== null && ata.data.length > 0) {
    const where = `The recipient's token account ${canonicalAta.toBase58()} (where release pays)`;
    try {
      const t = parseTokenAccount(ata.owner, ata.data);
      if (!t.owner.equals(destinationOwner)) {
        recipientWarnings.push(`${where} has been reassigned to ${t.owner.toBase58()}: release pays it anyway (only the recipient could have reassigned it), so ${t.owner.toBase58()} controls the payout.`);
      }
      const blocked = destinationProblem(ata, mint, m!.owner, true);
      if (blocked !== null) {
        recipientWarnings.push(`${where}: ${blocked}. release will fail until that changes; the recipient can sign release_to to another token account of this mint instead.`);
      }
      if (m!.owner.equals(KNOWN_ACCOUNTS.token2022) && requiresMemo(ata.data)) {
        recipientWarnings.push(`${where} requires incoming memos: fine, release and release_to add one.`);
      }
    } catch (e) {
      recipientWarnings.push(`${where} cannot be read (${e instanceof Error ? e.message : String(e)}): release may fail; release_to can pay another account.`);
    }
  }
  const vaultAta = canonicalAta === null ? null : ((canonicalAta.equals(ataT22) ? vaultT22Acc : vaultSplAcc) ?? null);
  if (vaultAta !== null && vaultAta.data.length > 0) {
    try {
      if (parseTokenAccount(vaultAta.owner, vaultAta.data).state === 2) {
        mintWarnings.push("The vault's token account is frozen right now: the withdrawal still executes, but its payout waits until the freeze authority thaws the account.");
      }
    } catch {
      // Unreadable vault token account: the withdrawal builder reports it.
    }
  }
  if (parsed !== null) mintWarnings.push(...releaseDelayWarnings(parsed));
  return {
    ok: refusals.length === 0,
    refusals,
    recipientWarnings,
    mintWarnings,
    offCurveConfirmation,
    canonicalAta,
    destinationOwner,
    mint,
    vault,
    wallet: opts.wallet ?? null,
  };
}

// ------------------------------------------------- recipient confirmation ---

/** Why a recipient confirmation was refused (`RecipientConfirmationError.reason`). */
export type RecipientConfirmationProblem =
  /** No `opts.confirm` (or not `{ recipient, acknowledged }` with a `checkRecipient` result). */
  | "missing"
  /** The check is for another recipient, mint or vault (or predates this SDK's binding fields). */
  | "mismatch"
  /** The check (or the one re-run before signing) refuses the recipient. */
  | "refused"
  /** A caution of the check was not acknowledged. */
  | "unacknowledged"
  /** The check re-run right before signing found a caution the user was not shown. */
  | "stale";

/**
 * A vault signer refused to sign: the recipient was not confirmed for this
 * withdrawal (see `RecipientConfirmation`). Nothing was signed and nothing
 * was written to the vault-key ledger.
 */
export class RecipientConfirmationError extends Error {
  readonly reason: RecipientConfirmationProblem;
  /** The check re-run right before signing, when it caused the refusal (`refused` or `stale` found there): show it and ask again. Else null. */
  readonly current: RecipientCheck | null;

  constructor(reason: RecipientConfirmationProblem, message: string, current: RecipientCheck | null = null) {
    super(`refusing to sign: ${message}`);
    this.name = "RecipientConfirmationError";
    this.reason = reason;
    this.current = current;
  }
}

const isKey = (v: unknown): v is PublicKey => v instanceof PublicKey;
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
/** A private copy of a `PublicKey` (anything else is left out: the confirmation is then refused as `mismatch`). */
const copyKey = (v: unknown): PublicKey | undefined => (isKey(v) ? new PublicKey(v.toBytes()) : undefined);

/**
 * `opts.confirm`, refused when absent or misshapen (before anything that
 * could sign or write), as a private, frozen copy taken now: the check's
 * keys, refusals and cautions and the user's acknowledgments as they are at
 * the call. Everything after (the match against the message, the re-check,
 * the last match right before signing) uses only this copy, so a
 * confirmation object edited while the call awaits the network (a reactive
 * form state) can never change what was confirmed.
 */
function requireConfirmation(opts: { readonly confirm?: RecipientConfirmation | undefined } | undefined, what: string): RecipientConfirmation {
  const c = opts?.confirm;
  if (c === undefined || c === null || typeof c !== "object" || c.recipient === null || typeof c.recipient !== "object" || c.acknowledged === null || typeof c.acknowledged !== "object") {
    throw new RecipientConfirmationError(
      "missing",
      `${what} needs opts.confirm: { recipient: await checkRecipient(conn, destinationOwner, mint, vault, { wallet }), acknowledged: { recipientWarnings?, mintWarnings?, offCurveConfirmation? } }: the user confirms the recipient before anything is signed`,
    );
  }
  const r = c.recipient;
  const refusals: unknown = r.refusals;
  const recipientWarnings: unknown = r.recipientWarnings;
  const mintWarnings: unknown = r.mintWarnings;
  const offCurveConfirmation: unknown = r.offCurveConfirmation;
  const wallet: unknown = r.wallet;
  if (
    !isStrings(refusals) ||
    !isStrings(recipientWarnings) ||
    !isStrings(mintWarnings) ||
    (offCurveConfirmation !== null && typeof offCurveConfirmation !== "string") ||
    (wallet !== undefined && wallet !== null && !isKey(wallet))
  ) {
    throw new RecipientConfirmationError("missing", "opts.confirm.recipient is not a checkRecipient result");
  }
  const a = c.acknowledged;
  const recipient = Object.freeze({
    ok: r.ok === true,
    refusals: Object.freeze([...refusals]),
    recipientWarnings: Object.freeze([...recipientWarnings]),
    mintWarnings: Object.freeze([...mintWarnings]),
    offCurveConfirmation,
    canonicalAta: copyKey(r.canonicalAta) ?? null,
    destinationOwner: copyKey(r.destinationOwner),
    mint: copyKey(r.mint),
    vault: copyKey(r.vault),
    wallet: copyKey(wallet) ?? null,
  }) as unknown as RecipientCheck;
  const acknowledged = Object.freeze({
    recipientWarnings: a.recipientWarnings === true,
    mintWarnings: a.mintWarnings === true,
    offCurveConfirmation: a.offCurveConfirmation === true,
  });
  return Object.freeze({ recipient, acknowledged });
}

/**
 * The confirmation, without the network: a check of exactly this recipient,
 * mint and vault, with no refusal, and each kind of caution it holds
 * acknowledged.
 */
function assertConfirmed(c: RecipientConfirmation, expected: { destinationOwner: PublicKey; mint: PublicKey; vault: PublicKey }): void {
  const r = c.recipient;
  if (!isKey(r.destinationOwner) || !isKey(r.mint) || !isKey(r.vault)) {
    throw new RecipientConfirmationError("mismatch", "the recipient check does not name its recipient, mint and vault (run checkRecipient from this SDK version)");
  }
  const differs = [
    r.destinationOwner.equals(expected.destinationOwner) ? null : `recipient ${r.destinationOwner.toBase58()} (signing for ${expected.destinationOwner.toBase58()})`,
    r.mint.equals(expected.mint) ? null : `mint ${r.mint.toBase58()} (signing for ${expected.mint.toBase58()})`,
    r.vault.equals(expected.vault) ? null : `vault ${r.vault.toBase58()} (signing for ${expected.vault.toBase58()})`,
  ].filter((x) => x !== null);
  if (differs.length > 0) throw new RecipientConfirmationError("mismatch", `the recipient check is for another ${differs.join(", ")}: check this exact withdrawal's recipient`);
  if (r.refusals.length > 0 || r.ok !== true) throw new RecipientConfirmationError("refused", `the recipient check refuses this recipient: ${r.refusals.join(" ")}`);
  const a = c.acknowledged;
  const missing = [
    r.recipientWarnings.length > 0 && a.recipientWarnings !== true ? "recipientWarnings" : null,
    r.mintWarnings.length > 0 && a.mintWarnings !== true ? "mintWarnings" : null,
    r.offCurveConfirmation !== null && a.offCurveConfirmation !== true ? "offCurveConfirmation" : null,
  ].filter((x) => x !== null);
  if (missing.length > 0) {
    const offCurve = r.offCurveConfirmation !== null && missing.includes("offCurveConfirmation") ? `: ${r.offCurveConfirmation}` : "";
    throw new RecipientConfirmationError(
      "unacknowledged",
      `the user has not confirmed the recipient check's ${missing.join(", ")} (set acknowledged.${missing.join(", acknowledged.")} to true only after showing them)${offCurve}`,
    );
  }
}

/**
 * Right before signing: `checkRecipient` again, for the recipient, mint and
 * vault of the message being signed (`expected`, which the confirmation was
 * matched against) and with the confirmed check's wallet, refused when it
 * now refuses, or holds a caution the confirmed check did not (the chain
 * changed since the user saw it). Returns the fresh check.
 */
async function recheckRecipient(conn: Connection, c: RecipientConfirmation, expected: { destinationOwner: PublicKey; mint: PublicKey; vault: PublicKey }): Promise<RecipientCheck> {
  const r = c.recipient;
  const fresh = await checkRecipient(conn, expected.destinationOwner, expected.mint, expected.vault, { wallet: r.wallet ?? null });
  if (!fresh.ok) throw new RecipientConfirmationError("refused", `the recipient check refuses this recipient now: ${fresh.refusals.join(" ")}`, fresh);
  const unseen = [
    ...fresh.recipientWarnings.filter((w) => !r.recipientWarnings.includes(w)),
    ...fresh.mintWarnings.filter((w) => !r.mintWarnings.includes(w)),
    ...(fresh.offCurveConfirmation !== null && fresh.offCurveConfirmation !== r.offCurveConfirmation ? [fresh.offCurveConfirmation] : []),
  ];
  if (unseen.length > 0) {
    throw new RecipientConfirmationError("stale", `the recipient check changed since the user confirmed it (show error.current and confirm again): ${unseen.join(" ")}`, fresh);
  }
  return fresh;
}

// ------------------------------------------------------------- builders ---

async function finishLegacy(conn: Connection, feePayer: PublicKey, ixs: TransactionInstruction[]): Promise<Transaction> {
  const tx = new Transaction().add(...ixs);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.feePayer = feePayer;
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  return tx;
}

/**
 * Open the vault whose genesis key is `pk` for `mint` (fails early where
 * `open_vault` would). The vault address `["vault", mint, key_id(pk)]` never
 * changes; deposits go to its token account. `pk` must be a genesis key
 * (`deriveVaultKey(..., account, 0)`, so `q = 0`).
 */
export async function buildOpenVaultTx(conn: Connection, payer: PublicKey, mint: PublicKey, pk: lmots.LmotsPublicKey): Promise<Transaction> {
  if (pk.q !== GENESIS_KEY_INDEX) throw new Error(`a vault opens with its genesis key (sequence 0, q = ${GENESIS_KEY_INDEX}); this key has q = ${pk.q} (InvalidKeyIndex)`);
  const genesisKeyId = lmots.keyId(pk);
  const vault = vaultAddress(mint, genesisKeyId);
  const [mintAcc, vaultAcc] = await getAccounts(conn, [mint, vault]);
  const policy = vaultMintPolicy(mintAcc ?? null);
  if (!policy.eligible || policy.tokenProgram === null) throw new Error(`open_vault would refuse this mint: ${policy.refusals.join(" ")}`);
  if (ownedBy(vaultAcc ?? null, PROGRAM_IDS.vault, "Vault") !== null) throw new Error(`vault ${vault.toBase58()} is already open; a genesis key opens one vault only`);
  const ix = buildInstruction(
    idlCodecs().vault,
    PROGRAM_IDS.vault,
    "open_vault",
    { payer, mint, vault, vaultTokenAccount: associatedTokenAddress(vault, mint, policy.tokenProgram), tokenProgram: policy.tokenProgram },
    { keyIdArg: genesisKeyId, key: { id: pk.id, q: pk.q, k: pk.k } },
  );
  return finishLegacy(conn, payer, [ix]);
}

/**
 * Deposit `amount` base units from `owner` into the vault's token account
 * (the deposit address, ATA(vault, mint)). For wSOL the SOL is sent straight
 * into that account and synced (`SyncNative`); other mints transfer from the
 * owner's ATA, with transfer-hook accounts resolved. Native SOL or another
 * mint sent to the vault PDA itself is unrecoverable: never send there.
 */
export async function buildDepositTx(conn: Connection, owner: PublicKey, mint: PublicKey, vault: PublicKey, amount: bigint): Promise<Transaction> {
  if (!isU64(amount) || amount === 0n) throw new RangeError("amount must be a positive u64");
  const v = await fetchVaultAccount(conn, vault);
  if (v === null) throw new Error(`vault ${vault.toBase58()} does not exist`);
  if (!v.mint.equals(mint)) throw new Error("vault holds a different mint");
  const mintAcc = await getAccount(conn, mint);
  const tokenProgram = tokenProgramOf(mintAcc, mint);
  const parsed = parseMint(tokenProgram, mintAcc!.data);
  const destination = associatedTokenAddress(vault, mint, tokenProgram);
  const destAcc = await getAccount(conn, destination);
  if (destAcc === null || destAcc.data.length === 0) throw new Error(`the vault's token account ${destination.toBase58()} does not exist`);
  const ixs: TransactionInstruction[] = [];
  if (mint.equals(WSOL_MINT)) {
    ixs.push(SystemProgram.transfer({ fromPubkey: owner, toPubkey: destination, lamports: amount }));
    ixs.push(createSyncNativeInstruction(destination, tokenProgram));
  } else {
    const source = associatedTokenAddress(owner, mint, tokenProgram);
    ixs.push(await createTransferCheckedWithTransferHookInstruction(conn, source, mint, destination, owner, amount, parsed.decimals, [], "confirmed", tokenProgram));
  }
  return finishLegacy(conn, owner, ixs);
}

/** Hook accounts for a payout transfer out of the vault's token account (resolver order, as the Rust reference client). */
async function payoutHookAccounts(
  conn: Connection,
  mint: PublicKey,
  parsed: ParsedMint,
  vault: PublicKey,
  vaultTokenAccount: PublicKey,
  destination: PublicKey,
  amount: bigint,
): Promise<AccountMeta[]> {
  return resolveHookAccounts(conn, mint, parsed, [{ source: vaultTokenAccount, destination, authority: vault, amount }], "confirmed", "resolver");
}

function releaseInstruction(
  payer: PublicKey,
  mint: PublicKey,
  vault: PublicKey,
  vaultTokenAccount: PublicKey,
  payout: PublicKey,
  rentPayer: PublicKey,
  destinationOwner: PublicKey,
  destination: PublicKey,
  tokenProgram: PublicKey,
  hookAccounts: AccountMeta[],
): TransactionInstruction {
  return buildInstruction(
    idlCodecs().vault,
    PROGRAM_IDS.vault,
    "release",
    { payer, mint, vault, vaultTokenAccount, payout, rentPayer, destinationOwner, destination, tokenProgram },
    {},
    hookAccounts,
  );
}

export interface WithdrawTx {
  /** Signed v1 wire bytes (message || fee-payer signature). */
  tx: Uint8Array;
  /** Transaction id (fee-payer signature, base58). */
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
  vault: PublicKey;
  /** The payout PDA this withdrawal creates: `["payout", vault, u64le(sequence)]`. */
  payout: PublicKey;
  /** `release` is in the same transaction. */
  includesRelease: boolean;
  /** What the withdrawal reserves at today's balance: `min(maxAmount, available)` (0 when paying the vault). */
  expectedAmount: bigint;
  /** The compute-unit limit config word. */
  computeUnitLimit: number;
  /** The priority-fee config word in lamports (0 when no `computeUnitPrice` was given). */
  priorityFeeLamports: bigint;
}

/**
 * The signed v1 withdrawal (SPEC §3.9): `withdraw` with the program's
 * account order, optionally followed by `release` of the same payout,
 * signed by the throwaway `payer` (no authority over the vault; it pays and
 * gets back the payout's rent).
 *
 * Compute budget (v1 ignores ComputeBudget instructions, so both go in the
 * config words): the compute-unit limit is `opts.computeUnitLimit` or the
 * measured tight default (`VAULT_COMPUTE_UNITS.withdraw`, plus the release's
 * for the mint when `release` is included); a `computeUnitPrice`
 * (micro-lamports per unit) becomes the priority-fee word,
 * `ceil(price * limit / 1e6)` lamports. The loaded-accounts data limit is
 * 4 MiB. Neither is part of what the vault key signed: a withdrawal that
 * ran out of units is rebuilt with a higher limit from the SAME signature.
 *
 * Checks before building: the next key hashes to `nextKeyId`, which is not
 * empty and not the current key, and has the index `q = sequence + 1` the
 * program requires (InvalidKeyIndex); the vault exists, holds `mint` and is
 * at `sequence` (a higher sequence means this withdrawal already executed);
 * the LM-OTS signature verifies over the exact message with the vault's
 * current key; the transaction fits in 4,096 bytes.
 *
 * The same stored signature can be rebuilt and re-broadcast any number of
 * times (new blockhash, any fee payer). If the combined transaction fails
 * because of the release, send the withdrawal alone: see
 * `buildWithdrawTxWithFallback`.
 */
export async function buildWithdrawTx(conn: Connection, payer: Keypair, args: WithdrawTxArgs, opts: ComputeBudgetOptions = {}): Promise<WithdrawTx> {
  return (await buildWithdraw(conn, payer, args, opts)).tx;
}

/** `buildWithdrawTx`, plus the key id of the vault key the signature verified with. */
async function buildWithdraw(conn: Connection, payer: Keypair, args: WithdrawTxArgs, opts: ComputeBudgetOptions): Promise<{ tx: WithdrawTx; keyId: Uint8Array }> {
  const { mint, vault, sequence, destinationOwner, maxAmount, signature, nextKey, nextKeyId } = args;
  if (!(signature instanceof Uint8Array) || signature.length !== VAULT.SIGNATURE_LEN) throw new RangeError(`signature must be ${VAULT.SIGNATURE_LEN} bytes`);
  if (!isU64(sequence)) throw new RangeError("sequence must be a u64");
  if (!isU64(maxAmount)) throw new RangeError("maxAmount must be a u64");
  if (!(nextKeyId instanceof Uint8Array) || nextKeyId.length !== 32 || isAllZero(nextKeyId)) throw new RangeError("nextKeyId must be a non-zero 32-byte key id");
  if (!bytesEqual(lmots.keyId(nextKey), nextKeyId)) throw new Error("the next key does not hash to nextKeyId (KeyIdMismatch)");
  const wantQ = nextKeyIndex(sequence);
  if (nextKey.q !== wantQ) {
    throw new Error(
      wantQ === null
        ? `no withdrawal can execute at sequence ${sequence}: no next key index follows it (InvalidKeyIndex)`
        : `the next key has index q = ${nextKey.q}, but the withdrawal at sequence ${sequence} must name the key of index ${wantQ} (InvalidKeyIndex): this signature can never execute`,
    );
  }
  const price = computeUnitPriceOf(opts);
  if (opts.computeUnitLimit !== undefined) computeUnitLimitOf(opts, 1);

  const [mintAcc, vaultAcc, splAta, t22Ata] = await getAccounts(conn, [
    mint,
    vault,
    associatedTokenAddress(vault, mint, KNOWN_ACCOUNTS.splToken),
    associatedTokenAddress(vault, mint, KNOWN_ACCOUNTS.token2022),
  ]);
  const owned = ownedBy(vaultAcc ?? null, PROGRAM_IDS.vault, "Vault");
  if (owned === null) throw new Error(`vault ${vault.toBase58()} does not exist`);
  const v = decodeVault(vault, owned.data);
  if (!v.mint.equals(mint)) throw new Error("vault holds a different mint");
  if (v.sequence > sequence) {
    throw new Error(
      `the withdrawal at sequence ${sequence} has already executed (the vault is at sequence ${v.sequence}): release its payout if it is still pending; never sign again for an old sequence`,
    );
  }
  if (v.sequence < sequence) throw new Error(`the message is for sequence ${sequence} but the vault is at sequence ${v.sequence}: it cannot execute`);
  if (bytesEqual(nextKeyId, v.keyId)) throw new Error("the next key must differ from the vault's current key (InvalidNextKey)");
  const message = withdrawMessage(vault, mint, sequence, destinationOwner, maxAmount, nextKeyId);
  if (!lmots.verify(v.key, message, signature)) {
    throw new Error("the LM-OTS signature does not verify with the vault's current key over this withdrawal (wrong key, sequence, recipient, amount or next key)");
  }

  const tokenProgram = tokenProgramOf(mintAcc ?? null, mint);
  const vaultTokenAccount = associatedTokenAddress(vault, mint, tokenProgram);
  const payout = payoutAddress(vault, sequence);
  const balance = tokenBalance(tokenProgram.equals(KNOWN_ACCOUNTS.token2022) ? t22Ata : splAta);
  const available = balance > v.reserved ? balance - v.reserved : 0n;
  const expectedAmount = destinationOwner.equals(vault) ? 0n : maxAmount < available ? maxAmount : available;

  const ixs: TransactionInstruction[] = [
    buildInstruction(
      idlCodecs().vault,
      PROGRAM_IDS.vault,
      "withdraw",
      { payer: payer.publicKey, mint, vault, vaultTokenAccount, payout, tokenProgram },
      { args: { signature, destinationOwner, maxAmount, nextKeyId, nextKey: { id: nextKey.id, q: nextKey.q, k: nextKey.k } } },
    ),
  ];
  let defaultLimit: number = VAULT_COMPUTE_UNITS.withdraw;
  const includesRelease = args.includeRelease === true;
  if (includesRelease) {
    const parsed = parseMint(tokenProgram, mintAcc!.data);
    const destination = associatedTokenAddress(destinationOwner, mint, tokenProgram);
    const hook = await payoutHookAccounts(conn, mint, parsed, vault, vaultTokenAccount, destination, expectedAmount);
    ixs.push(releaseInstruction(payer.publicKey, mint, vault, vaultTokenAccount, payout, payer.publicKey, destinationOwner, destination, tokenProgram, hook));
    defaultLimit = Math.min(MAX_COMPUTE_UNIT_LIMIT, defaultLimit + releaseComputeUnits(tokenProgram, parsed));
  }
  const computeUnitLimit = computeUnitLimitOf(opts, defaultLimit);
  const fee = price === null ? 0n : priorityFeeLamports(price, computeUnitLimit);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const compiled = compileV1Message(payer.publicKey, ixs, blockhash, {
    computeUnitLimit,
    loadedAccountsDataSizeLimit: VAULT.WITHDRAW_LOADED_ACCOUNTS_BYTES,
    ...(price === null ? {} : { priorityFeeLamports: fee }),
  });
  const tx = signV1Message(compiled, [payer]);
  return {
    tx: {
      tx,
      signature: v1TransactionId(tx),
      blockhash,
      lastValidBlockHeight,
      vault,
      payout,
      includesRelease,
      expectedAmount,
      computeUnitLimit,
      priorityFeeLamports: fee,
    },
    keyId: v.keyId,
  };
}

export interface WithdrawTxWithFallback extends WithdrawTx {
  /** Why `release` was left out (null when the transaction includes it). */
  releaseError: string | null;
  /** Simulation of the returned transaction: send it only if `simulation.ok`. */
  simulation: SimulationReport;
}

/** `buildWithdrawTxWithFallback` options: the vault-key ledger (required) and the compute budget. */
export interface WithdrawFallbackOptions extends ComputeBudgetOptions {
  /** The ledger that recorded the signature (`prepareWithdrawal` / `signWithdrawal`); required, no default. */
  readonly ledger: VaultKeyLedger;
}

/**
 * Withdraw and release in one v1 transaction when the pair succeeds in
 * simulation now; otherwise the withdrawal alone, with the SAME signature
 * (the payout stays reserved: release it later, or have the recipient sign
 * `release_to`). Never signs anything with the vault key.
 *
 * Simulating sends the signature to the RPC, so it is revealed from then on:
 * this builder refuses (before any simulation) a signature that
 * `opts.ledger` does not hold for the vault's current key and this exact
 * withdrawal. Every signature `prepareWithdrawal` returns (signed here, or
 * found on chain) is recorded there; one made by any other means is refused.
 *
 * The withdrawal alone is built first, so every check of the withdrawal
 * itself (`buildWithdrawTx`) throws as usual. Then withdraw + release is
 * built and simulated. It falls back to the withdrawal alone on ANY failure
 * of the release leg: building it (hook accounts that cannot be resolved,
 * over 4,096 bytes), the release instruction failing (recipient account
 * frozen, confidential-only, a hook refusal, out of compute units), or a
 * transaction-level failure of the pair. It never falls back from a failure
 * of the withdraw leg (instruction 0): the pair is returned with its failing
 * simulation. The fallback is simulated too: send what is returned only if
 * `simulation.ok`.
 */
export async function buildWithdrawTxWithFallback(
  conn: Connection,
  payer: Keypair,
  args: Omit<WithdrawTxArgs, "includeRelease">,
  opts: WithdrawFallbackOptions,
): Promise<WithdrawTxWithFallback> {
  const ledger = requireLedger(opts, "buildWithdrawTxWithFallback");
  const built = await buildWithdraw(conn, payer, { ...args, includeRelease: false }, opts);
  const alone = built.tx;
  const rec = await ledger.get(built.keyId);
  const message = withdrawMessage(args.vault, args.mint, args.sequence, args.destinationOwner, args.maxAmount, args.nextKeyId);
  if (rec === null || rec.signature === null || rec.messageHash !== toHex(sha256(message)) || rec.signature !== toHex(args.signature)) {
    throw new VaultLedgerError(
      "refusing to simulate: the vault-key ledger does not hold this signature for this withdrawal, and a simulation reveals it to the RPC. Sign through prepareWithdrawal or signWithdrawal with this ledger (a withdrawal found on chain is recorded by prepareWithdrawal).",
    );
  }
  let releaseError: string;
  let combined: WithdrawTx | null = null;
  try {
    combined = await buildWithdrawTx(conn, payer, { ...args, includeRelease: true }, opts);
  } catch (e) {
    releaseError = `withdraw + release could not be built (${e instanceof Error ? e.message : String(e)})`;
  }
  if (combined !== null) {
    const simulation = await simulateAndExplain(conn, combined.tx);
    if (simulation.ok || simulation.failedInstruction === 0) return { ...combined, releaseError: null, simulation };
    releaseError =
      simulation.failedInstruction === 1
        ? `the release fails: ${simulation.error ?? "unknown error"}`
        : `withdraw + release fails as a whole: ${simulation.error ?? "unknown error"}`;
  }
  return { ...alone, releaseError: releaseError!, simulation: await simulateAndExplain(conn, alone.tx) };
}

interface PayoutContext {
  v: VaultAccount;
  payout: PayoutAccount;
  tokenProgram: PublicKey;
  parsed: ParsedMint;
  vaultTokenAccount: PublicKey;
}

async function payoutContext(conn: Connection, vault: PublicKey, mint: PublicKey, sequence: bigint): Promise<PayoutContext> {
  if (!isU64(sequence)) throw new RangeError("sequence must be a u64");
  const payoutKey = payoutAddress(vault, sequence);
  const [mintAcc, vaultAcc, payoutAcc] = await getAccounts(conn, [mint, vault, payoutKey]);
  const owned = ownedBy(vaultAcc ?? null, PROGRAM_IDS.vault, "Vault");
  if (owned === null) throw new Error(`vault ${vault.toBase58()} does not exist`);
  const v = decodeVault(vault, owned.data);
  if (!v.mint.equals(mint)) throw new Error("vault holds a different mint");
  const p = ownedBy(payoutAcc ?? null, PROGRAM_IDS.vault, "Payout");
  if (p === null) {
    throw new Error(
      sequence < v.sequence
        ? `the payout of sequence ${sequence} has already been released`
        : `there is no payout at sequence ${sequence} yet (the vault is at sequence ${v.sequence}): broadcast the withdrawal first`,
    );
  }
  const payout = decodePayout(payoutKey, p.data);
  if (!payout.vault.equals(vault)) throw new Error("payout belongs to another vault");
  const tokenProgram = tokenProgramOf(mintAcc ?? null, mint);
  return { v, payout, tokenProgram, parsed: parseMint(tokenProgram, mintAcc!.data), vaultTokenAccount: associatedTokenAddress(vault, mint, tokenProgram) };
}

/**
 * `release` (permissionless): pay the payout at `sequence` to its
 * recipient's canonical ATA, creating it if missing (`payer` pays that rent;
 * the payout's rent returns to its `rent_payer`). Refuses when the canonical
 * account exists but cannot receive (frozen, confidential-only): the
 * recipient can sign `buildReleaseToTx` instead.
 *
 * Legacy transaction: SetComputeUnitLimit (`opts.computeUnitLimit` or the
 * measured default for the mint, `VAULT_COMPUTE_UNITS`), SetComputeUnitPrice
 * when `opts.computeUnitPrice` is set, then `release`. Refused if it would
 * not fit 1,232 bytes.
 */
export async function buildReleaseTx(
  conn: Connection,
  payer: PublicKey,
  args: { vault: PublicKey; mint: PublicKey; sequence: bigint },
  opts: ComputeBudgetOptions = {},
): Promise<Transaction> {
  const { vault, mint, sequence } = args;
  computeUnitPriceOf(opts);
  if (opts.computeUnitLimit !== undefined) computeUnitLimitOf(opts, 1);
  const c = await payoutContext(conn, vault, mint, sequence);
  const destination = associatedTokenAddress(c.payout.destinationOwner, mint, c.tokenProgram);
  if (c.payout.amount > 0n) {
    const dest = await getAccount(conn, destination);
    if (dest !== null && dest.data.length > 0) {
      const blocked = destinationProblem(dest, mint, c.tokenProgram, true);
      if (blocked !== null) {
        throw new Error(`the recipient's token account ${destination.toBase58()} cannot receive: ${blocked}. The recipient can sign release_to (buildReleaseToTx) to another token account of this mint.`);
      }
    }
  }
  const hook = await payoutHookAccounts(conn, mint, c.parsed, vault, c.vaultTokenAccount, destination, c.payout.amount);
  const ix = releaseInstruction(payer, mint, vault, c.vaultTokenAccount, c.payout.publicKey, c.payout.rentPayer, c.payout.destinationOwner, destination, c.tokenProgram, hook);
  const tx = await finishLegacy(conn, payer, [...computeBudgetInstructions(opts, releaseComputeUnits(c.tokenProgram, c.parsed)), ix]);
  return checkLegacySize(tx, "the release transaction");
}

/**
 * `release_to`: the payout's recipient wallet pays itself into any token
 * account of the mint (`destination`), for recipients whose canonical
 * account cannot receive. Unsigned legacy transaction; `recipient` is the
 * fee payer and must sign. Compute budget and size as `buildReleaseTx`.
 */
export async function buildReleaseToTx(
  conn: Connection,
  recipient: PublicKey,
  args: { vault: PublicKey; mint: PublicKey; sequence: bigint; destination: PublicKey },
  opts: ComputeBudgetOptions = {},
): Promise<Transaction> {
  const { vault, mint, sequence, destination } = args;
  computeUnitPriceOf(opts);
  if (opts.computeUnitLimit !== undefined) computeUnitLimitOf(opts, 1);
  const c = await payoutContext(conn, vault, mint, sequence);
  if (!c.payout.destinationOwner.equals(recipient)) {
    throw new Error(`only the payout's recipient ${c.payout.destinationOwner.toBase58()} can sign release_to`);
  }
  const dest = await getAccount(conn, destination);
  if (dest === null || dest.data.length === 0) throw new Error(`destination ${destination.toBase58()} does not exist: create a token account of this mint first`);
  const blocked = destinationProblem(dest, mint, c.tokenProgram, c.payout.amount > 0n);
  if (blocked !== null) throw new Error(`destination ${destination.toBase58()} cannot receive this payout: ${blocked}`);
  // Audit round 3 F2: while the Launch Guard is on, its hook refuses a payout into an account whose owner can be reassigned.
  if (c.payout.amount > 0n && !hasImmutableOwner(dest.data)) {
    const guardEnd = await launchGuardEndTs(conn, mint, c.parsed);
    if (guardEnd !== null && (await clusterUnixTime(conn)) < guardEnd) {
      throw new Error(`destination ${destination.toBase58()} cannot receive this payout now: ${mutableOwnerRefusal(guardEnd)}`);
    }
  }
  const hook = await payoutHookAccounts(conn, mint, c.parsed, vault, c.vaultTokenAccount, destination, c.payout.amount);
  const ix = buildInstruction(
    idlCodecs().vault,
    PROGRAM_IDS.vault,
    "release_to",
    {
      destinationOwner: recipient,
      mint,
      vault,
      vaultTokenAccount: c.vaultTokenAccount,
      payout: c.payout.publicKey,
      rentPayer: c.payout.rentPayer,
      destination,
      tokenProgram: c.tokenProgram,
    },
    {},
    hook,
  );
  const tx = await finishLegacy(conn, recipient, [...computeBudgetInstructions(opts, releaseComputeUnits(c.tokenProgram, c.parsed)), ix]);
  return checkLegacySize(tx, "the release_to transaction");
}

// ------------------------------------------------- pending withdrawals ---

/** Transactions read at once (public endpoints rate-limit bursts). */
const HISTORY_BATCH = 4;
/** Default `maxTransactions`: transactions one `findPendingWithdrawal` call reads. */
const HISTORY_LIMIT = 1_000;
/** Default `maxSignaturePages`: `getSignaturesForAddress` pages one call reads. */
const HISTORY_PAGE_LIMIT = 200;
/** Entries per `getSignaturesForAddress` page (the RPC's maximum). */
const HISTORY_PAGE_SIZE = 1_000;
/** The oldest successful vault transactions kept, to find `open_vault` when the history ends without the installing withdrawal. */
const OPENING_WINDOW = 16;

interface RawTransaction {
  slot?: number;
  meta?: { err: unknown; loadedAddresses?: { writable?: unknown; readonly?: unknown } | null } | null;
  transaction?: unknown;
}

interface Instr {
  programId: PublicKey | undefined;
  accounts: (PublicKey | undefined)[];
  data: Uint8Array;
}

/** Addresses a v0 transaction loaded from lookup tables (`meta.loadedAddresses`: writable, then read-only); empty when absent. */
function loadedAddressesOf(meta: RawTransaction["meta"]): PublicKey[] {
  const loaded = meta?.loadedAddresses;
  if (loaded === null || loaded === undefined) return [];
  const keys = (x: unknown): PublicKey[] => (Array.isArray(x) ? x.map((k) => new PublicKey(String(k))) : []);
  return [...keys(loaded.writable), ...keys(loaded.readonly)];
}

/** Top-level instructions of raw wire bytes: v1 (SPEC §3.9), legacy, or v0 (lookup-table addresses from `loaded`). */
function instructionsOf(bytes: Uint8Array, loaded: PublicKey[]): Instr[] {
  if (bytes[0] === 0x81) {
    const d = decodeV1Transaction(bytes);
    return d.instructions.map((ix) => ({ programId: d.accountKeys[ix.programIdIndex], accounts: ix.accounts.map((i) => d.accountKeys[i]), data: ix.data }));
  }
  const t = VersionedTransaction.deserialize(bytes);
  const keys = [...t.message.staticAccountKeys, ...(t.version === 0 ? loaded : [])];
  return t.message.compiledInstructions.map((ix) => ({
    programId: keys[ix.programIdIndex],
    accounts: ix.accountKeyIndexes.map((i) => keys[i]),
    data: Uint8Array.from(ix.data),
  }));
}

function accountIndex(name: string, ixName: string): number {
  const i = idlCodecs()
    .vault.instruction(ixName)
    .accounts.findIndex((a) => a.name === name);
  if (i < 0) throw new Error(`vault IDL: ${ixName} has no account ${name}`);
  return i;
}

/** One entry of an address's signature list (`getSignaturesForAddress`). */
interface Listed {
  signature: string;
  /** null when the RPC did not report it: nothing is then decided by slot. */
  slot: number | null;
  /** The list says the transaction failed. */
  failed: boolean;
}

function listed(h: { signature: string; slot?: unknown; err?: unknown }): Listed {
  return { signature: h.signature, slot: typeof h.slot === "number" ? h.slot : null, failed: h.err !== null && h.err !== undefined };
}

/** Pages must go back in time: no known slot newer than the previous one. */
function inOrder(entries: readonly Listed[], previous: number | null): boolean {
  let last = previous;
  for (const e of entries) {
    if (e.slot === null) continue;
    if (last !== null && e.slot > last) return false;
    last = e.slot;
  }
  return true;
}

/** Another address's signature list, paged lazily, to tell whether a vault transaction also names that address. */
interface SlotList {
  address: PublicKey;
  /** Loaded entries the vault walk has not gone past yet, newest first. */
  buf: Listed[];
  before: string | undefined;
  /** Slot of the oldest entry loaded so far. */
  lastSlot: number | null;
  ended: boolean;
  /** Paged wrongly or without slots: membership is unknown (every transaction asked about counts as named). */
  broken: boolean;
}

/** A stretch of the vault's own history, walked newest first. */
interface Segment {
  /** 0 for the walk back to the installing transaction; each continuation adds a newer stretch with a higher number. */
  gen: number;
  before: string | undefined;
  /** Exclusive end: the newest vault entry when the previous call started (undefined: walk back to the installing transaction). */
  until: string | undefined;
  /** Loaded entries not handled yet, newest first. */
  buf: Listed[];
  lastSlot: number | null;
  ended: boolean;
  /** The RPC repeated a page or paged out of order: this stretch could not be read to its end. */
  broken: boolean;
  /** The current sequence's payout PDA: every attempt at this sequence names it. */
  payout: SlotList;
  /** The previous sequence's payout PDA (null at sequence 0 and in newer stretches): the installing withdrawal names it. */
  previous: SlotList | null;
}

/** A vault entry to read, with the stretch it belongs to. */
interface Tracked extends Listed {
  gen: number;
  /** Position in the walk (newest first): ranks what is found by where it sits in the history, not by when it was read. */
  pos: number;
}

/** Everything a search knows; a continuation holds a copy. */
interface SearchState {
  vault: PublicKey;
  sequence: bigint;
  keyId: Uint8Array;
  /** The newest vault entry when the latest call started: the next call first reads what is newer. */
  head: string | null;
  /** Newest first; the last one (gen 0) walks back to the installing transaction. */
  segments: Segment[];
  nextGen: number;
  found: Map<string, { p: PendingWithdrawal; gen: number; order: number }>;
  /** Next walk position (`Tracked.pos`). */
  order: number;
  /**
   * Successful vault entries that name the current payout PDA but not the
   * previous one (audit 4, C2): a successful transaction cannot have run a
   * withdrawal at the current sequence (the vault would have moved on), so
   * it can only carry a copy of a signature passed to another program; anyone
   * can land such transactions for the base fee. Read after the walk (after
   * every failed attempt), before `tail`.
   */
  late: Tracked[];
  /**
   * Failed vault entries that do not name the current payout PDA, read after
   * everything else: anyone can add such transactions for the base fee, and
   * every real attempt at this sequence names that PDA.
   */
  tail: Tracked[];
  read: Set<string>;
  examined: number;
  /** Transactions that could not be fetched or decoded: retried by the next call. */
  unreadable: Map<string, Tracked>;
  /** The transaction that installed the current key (or `open_vault`): nothing older matters. */
  boundary: { signature: string; slot: number | null } | null;
  /** The oldest successful entries of the gen-0 walk, newest first. */
  window: Listed[];
}

/** What one call may still read. */
interface SearchCall {
  conn: Connection;
  rpc: ReturnType<typeof rpcRequest>;
  v: VaultAccount;
  st: SearchState;
  txLeft: number;
  pagesLeft: number;
  previousPayout: PublicKey | null;
  withdrawDisc: Uint8Array;
  openDisc: Uint8Array;
  /** Account positions in `withdraw` and `open_vault`. */
  at: { vault: number; payout: number; openVault: number };
  /** Stop before the low-priority tail once a re-broadcastable withdrawal is found (`prepareWithdrawal`: nothing new will be signed). */
  stopAtPending: boolean;
  /** Set when this call stopped for that reason. */
  tailDeferred: boolean;
}

const continuations = new WeakMap<PendingWithdrawalContinuation, SearchState>();

function slotList(address: PublicKey): SlotList {
  return { address, buf: [], before: undefined, lastSlot: null, ended: false, broken: false };
}

function newSegment(gen: number, until: string | undefined, v: VaultAccount): Segment {
  return {
    gen,
    before: undefined,
    until,
    buf: [],
    lastSlot: null,
    ended: false,
    broken: false,
    payout: slotList(payoutAddress(v.publicKey, v.sequence)),
    previous: gen === 0 && v.sequence > 0n ? slotList(payoutAddress(v.publicKey, v.sequence - 1n)) : null,
  };
}

function newSearch(v: VaultAccount): SearchState {
  return {
    vault: v.publicKey,
    sequence: v.sequence,
    keyId: v.keyId,
    head: null,
    segments: [newSegment(0, undefined, v)],
    nextGen: 1,
    found: new Map(),
    order: 0,
    late: [],
    tail: [],
    read: new Set(),
    examined: 0,
    unreadable: new Map(),
    boundary: null,
    window: [],
  };
}

/** A copy whose containers can change without touching `s` (entries themselves are never mutated). */
function copySearch(s: SearchState): SearchState {
  const list = (l: SlotList): SlotList => ({ ...l, buf: [...l.buf] });
  return {
    ...s,
    segments: s.segments.map((g) => ({ ...g, buf: [...g.buf], payout: list(g.payout), previous: g.previous === null ? null : list(g.previous) })),
    found: new Map(s.found),
    late: [...s.late],
    tail: [...s.tail],
    read: new Set(s.read),
    unreadable: new Map(s.unreadable),
    boundary: s.boundary === null ? null : { ...s.boundary },
    window: [...s.window],
  };
}

/** Load the next page of a stretch of the vault's history; false when this call has no page left. */
async function pageVault(c: SearchCall, seg: Segment): Promise<boolean> {
  if (c.pagesLeft <= 0) return false;
  c.pagesLeft--;
  const first = seg.before === undefined;
  const page = await c.conn.getSignaturesForAddress(
    c.v.publicKey,
    { limit: HISTORY_PAGE_SIZE, ...(first ? {} : { before: seg.before }), ...(seg.until === undefined ? {} : { until: seg.until }) },
    "confirmed",
  );
  if (page.length === 0) {
    seg.ended = true;
    return true;
  }
  let entries = page.map(listed);
  // An RPC that ignores `before` returns the same page forever.
  if ((!first && entries.some((e) => e.signature === seg.before)) || !inOrder(entries, seg.lastSlot)) {
    seg.ended = true;
    seg.broken = true;
    return true;
  }
  seg.before = entries[entries.length - 1]!.signature;
  // `until` is exclusive; stop there even if the RPC ignored it.
  if (seg.until !== undefined) {
    const stop = entries.findIndex((e) => e.signature === seg.until);
    if (stop >= 0) {
      entries = entries.slice(0, stop);
      seg.ended = true;
    }
  }
  if (first && seg === c.st.segments[0] && entries[0] !== undefined) c.st.head = entries[0].signature;
  for (const e of entries) if (e.slot !== null) seg.lastSlot = e.slot;
  seg.buf.push(...entries);
  return true;
}

async function pageList(c: SearchCall, l: SlotList): Promise<void> {
  c.pagesLeft--;
  const page = await c.conn.getSignaturesForAddress(l.address, { limit: HISTORY_PAGE_SIZE, ...(l.before === undefined ? {} : { before: l.before }) }, "confirmed");
  if (page.length === 0) {
    l.ended = true;
    return;
  }
  const entries = page.map(listed);
  if ((l.before !== undefined && entries.some((e) => e.signature === l.before)) || entries.some((e) => e.slot === null) || !inOrder(entries, l.lastSlot)) {
    l.broken = true;
    return;
  }
  l.before = entries[entries.length - 1]!.signature;
  l.lastSlot = entries[entries.length - 1]!.slot;
  l.buf.push(...entries);
}

/**
 * Whether vault entry `e` also names `l`'s address: true, false, null
 * (unknown: treat it as named) or "budget" (no page left in this call).
 * Merges by slot: `l` is paged only down to `e`'s slot.
 */
async function alsoNames(c: SearchCall, l: SlotList, e: Listed): Promise<boolean | null | "budget"> {
  if (l.broken || e.slot === null) return null;
  while (!(l.ended || (l.lastSlot !== null && l.lastSlot < e.slot))) {
    if (c.pagesLeft <= 0) return "budget";
    await pageList(c, l);
    if (l.broken) return null;
  }
  // Entries newer than `e` can never match again: the walk only goes back in time.
  let newer = 0;
  while (newer < l.buf.length && l.buf[newer]!.slot! > e.slot) newer++;
  if (newer > 0) l.buf.splice(0, newer);
  for (const x of l.buf) {
    if (x.slot !== e.slot) break;
    if (x.signature === e.signature) return true;
  }
  return false;
}

/**
 * Whether, and when, to read vault entry `e` (ranked by what the vault's
 * history and the payout PDAs' histories show; what a transaction carries is
 * known only once it is read):
 *
 * - "read": a FAILED transaction that also names the current payout PDA,
 *   withdraw-shaped (an attempt at this sequence that did not execute names
 *   both): read in history order;
 * - "now": in the gen-0 walk, a successful one that also names the previous
 *   payout PDA (the installing withdrawal): read before going further back;
 * - "late": a SUCCESSFUL one that names the current payout PDA but not the
 *   previous one (audit 4, C2): it cannot have run a withdrawal at this
 *   sequence (the vault would have moved on), so it can only carry a copy of
 *   a signature passed to another program, and anyone can land it for the
 *   base fee: read after the walk, after every failed attempt;
 * - "tail": a failed one that does not name the current payout PDA (a
 *   signature passed with another payout account, or to another program;
 *   also base-fee spam): read after everything else.
 */
async function classify(c: SearchCall, seg: Segment, e: Listed): Promise<"skip" | "read" | "now" | "late" | "tail" | "budget"> {
  if (c.st.read.has(e.signature)) return "skip";
  const named = await alsoNames(c, seg.payout, e);
  if (named === "budget") return "budget";
  if (e.failed) return named === false ? "tail" : "read";
  if (seg.previous !== null) {
    const installs = await alsoNames(c, seg.previous, e);
    if (installs === "budget") return "budget";
    if (installs !== false) return seg.gen === 0 ? "now" : "read";
  }
  return named === false ? "skip" : "late";
}

function remember(st: SearchState, e: Listed): void {
  if (st.window.some((x) => x.signature === e.signature)) return;
  st.window.push(e);
  if (st.window.length > OPENING_WINDOW) st.window.shift();
}

const startsWith = (data: Uint8Array, prefix: Uint8Array): boolean => data.length >= prefix.length && bytesEqual(data.subarray(0, prefix.length), prefix);

/**
 * Inspect one transaction: record every signature of the current key over
 * this vault's current sequence it carries (whatever program or accounts
 * the instruction named); "boundary" if, in the gen-0 walk, it is known to
 * have succeeded and installed the current key (the withdrawal of
 * `sequence - 1` naming the current key as its next key) or opened the
 * vault; "unreadable" if its bytes cannot be decoded.
 */
function inspect(c: SearchCall, e: Tracked, raw: RawTransaction): "boundary" | "read" | "unreadable" {
  const encoded = Array.isArray(raw.transaction) ? raw.transaction[0] : undefined;
  if (typeof encoded !== "string") return "unreadable";
  const succeeded = !e.failed && raw.meta !== null && raw.meta !== undefined && (raw.meta.err === null || raw.meta.err === undefined);
  let ixs: Instr[];
  try {
    ixs = instructionsOf(Uint8Array.from(Buffer.from(encoded, "base64")), loadedAddressesOf(raw.meta));
  } catch {
    return "unreadable";
  }
  const { v, st, withdrawDisc, openDisc, at } = c;
  const installing = succeeded && e.gen === 0;
  let boundary = false;
  for (const ix of ixs) {
    const ours = ix.programId?.equals(PROGRAM_IDS.vault) === true;
    if (ours && startsWith(ix.data, openDisc)) {
      if (installing && ix.accounts[at.openVault]?.equals(v.publicKey) === true && ix.data.length >= 40 && bytesEqual(ix.data.subarray(8, 40), v.genesisKeyId)) boundary = true;
      continue;
    }
    if (!startsWith(ix.data, withdrawDisc)) continue;
    let args: { signature: Uint8Array; destinationOwner: PublicKey; maxAmount: bigint; nextKeyId: Uint8Array; nextKey: lmots.LmotsPublicKey };
    try {
      args = idlCodecs().vault.decodeType("WithdrawArgs", ix.data.subarray(withdrawDisc.length));
    } catch {
      continue;
    }
    if (
      installing &&
      ours &&
      c.previousPayout !== null &&
      ix.accounts[at.vault]?.equals(v.publicKey) === true &&
      ix.accounts[at.payout]?.equals(c.previousPayout) === true &&
      bytesEqual(args.nextKeyId, v.keyId)
    ) {
      boundary = true;
    }
    if (args.signature.length !== VAULT.SIGNATURE_LEN) continue;
    let message: Uint8Array;
    try {
      message = withdrawMessage(v.publicKey, v.mint, v.sequence, args.destinationOwner, args.maxAmount, args.nextKeyId);
    } catch {
      continue;
    }
    if (!lmots.verify(v.key, message, args.signature)) continue;
    // The current key signed this exact message: it counts as revealed
    // whatever else the instruction carried. Its next key is authenticated
    // separately: it must hash to the signed next key id. Anyone can copy a
    // revealed signature into a cheap failing transaction next to a junk
    // next key; such a copy never becomes the withdrawal to re-broadcast and
    // never hides the genuine one (the search goes on and prefers an
    // occurrence whose next key is authentic).
    let authentic = false;
    try {
      authentic = bytesEqual(lmots.keyId(args.nextKey), args.nextKeyId);
    } catch {
      authentic = false;
    }
    const nextKey: lmots.LmotsPublicKey | null = authentic ? { id: args.nextKey.id, q: args.nextKey.q, k: args.nextKey.k } : null;
    const occurrence = {
      txSignature: e.signature,
      failed: !succeeded,
      executable: nextKey !== null && nextKey.q === nextKeyIndex(v.sequence) && !bytesEqual(args.nextKeyId, v.keyId),
      slot: typeof raw.slot === "number" ? raw.slot : e.slot,
      nextKey,
    };
    const id = toHex(message);
    const seen = st.found.get(id);
    if (seen !== undefined) {
      // Same message seen in a newer transaction: keep its place, but take this occurrence's next key if only this one is authentic.
      if (seen.p.nextKey === null && nextKey !== null) st.found.set(id, { ...seen, p: { ...seen.p, ...occurrence } });
      continue;
    }
    st.found.set(id, {
      gen: e.gen,
      order: e.pos,
      p: {
        ...occurrence,
        vault: v.publicKey,
        mint: v.mint,
        sequence: v.sequence,
        destinationOwner: args.destinationOwner,
        maxAmount: args.maxAmount,
        nextKeyId: args.nextKeyId,
        signature: args.signature,
        message,
      },
    });
  }
  return boundary ? "boundary" : "read";
}

/** Read up to `c.txLeft` of `batch` (in parallel); returns how many were read. */
async function readBatch(c: SearchCall, batch: readonly Tracked[]): Promise<number> {
  const take = batch.slice(0, Math.max(0, c.txLeft));
  const results = await Promise.all(
    take.map((e) => c.rpc<RawTransaction | null>("getTransaction", [e.signature, { encoding: "base64", commitment: "confirmed", maxSupportedTransactionVersion: 1 }])),
  );
  results.forEach((res, j) => {
    const e = take[j]!;
    if (res.error !== undefined) throw new Error(`could not read transaction ${e.signature}: ${res.error.message}`);
    c.txLeft--;
    c.st.examined++;
    c.st.read.add(e.signature);
    const outcome = res.result === null || res.result === undefined ? "unreadable" : inspect(c, e, res.result);
    if (outcome === "unreadable") c.st.unreadable.set(e.signature, e);
    else c.st.unreadable.delete(e.signature);
    if (outcome === "boundary" && c.st.boundary === null) {
      c.st.boundary = { signature: e.signature, slot: e.slot ?? (typeof res.result?.slot === "number" ? res.result.slot : null) };
    }
  });
  return take.length;
}

/** Walk a stretch back in time: "done" when it ended (gen 0: past the installing transaction's slot), "budget" when this call ran out. */
async function walkSegment(c: SearchCall, seg: Segment): Promise<"done" | "budget"> {
  const st = c.st;
  for (;;) {
    const batch: Tracked[] = [];
    let now = false;
    while (batch.length < HISTORY_BATCH && !now) {
      if (seg.buf.length === 0) {
        if (seg.ended || batch.length > 0) break;
        if (!(await pageVault(c, seg))) return "budget";
        continue;
      }
      const e = seg.buf[0]!;
      if (seg.gen === 0 && st.boundary !== null && !(e.slot !== null && e.slot === st.boundary.slot)) {
        // Past the installing transaction and its slot: nothing older can hold a signature of the current key.
        seg.buf = [];
        seg.ended = true;
        break;
      }
      const verdict = await classify(c, seg, e);
      if (verdict === "budget") {
        seg.buf.unshift(...batch);
        return "budget";
      }
      seg.buf.shift();
      if (seg.gen === 0 && !e.failed) remember(st, e);
      if (verdict === "skip") continue;
      const tracked: Tracked = { ...e, gen: seg.gen, pos: st.order++ };
      if (verdict === "tail") {
        st.tail.push(tracked);
        continue;
      }
      if (verdict === "late") {
        st.late.push(tracked);
        continue;
      }
      batch.push(tracked);
      now = verdict === "now";
    }
    if (batch.length === 0) return "done";
    const read = await readBatch(c, batch);
    if (read < batch.length) {
      seg.buf.unshift(...batch.slice(read));
      return "budget";
    }
  }
}

/**
 * The gen-0 walk reached the end of the history without the installing
 * withdrawal (e.g. it executed through another program): if the oldest
 * successful entries include this vault's `open_vault`, everything since the
 * vault opened was examined. False when this call ran out.
 */
async function findOpening(c: SearchCall): Promise<boolean> {
  // One at a time, oldest first: the opening is almost always the very oldest.
  for (const e of [...c.st.window].reverse()) {
    if (c.st.boundary !== null) break;
    if (c.st.read.has(e.signature)) continue;
    if ((await readBatch(c, [{ ...e, gen: 0, pos: c.st.order++ }])) === 0) return false;
  }
  return true;
}

/** An unreadable transaction still matters unless it is older than the installing transaction (gen-0 walk, known slots). */
function stillMatters(u: Tracked, boundary: SearchState["boundary"]): boolean {
  return !(boundary !== null && u.gen === 0 && boundary.slot !== null && u.slot !== null && u.slot < boundary.slot);
}

/** Run one call of the search; false when it stopped at this call's limits. */
async function runSearch(c: SearchCall): Promise<boolean> {
  const retry = [...c.st.unreadable.values()].filter((u) => stillMatters(u, c.st.boundary));
  for (let i = 0; i < retry.length; i += HISTORY_BATCH) {
    const batch = retry.slice(i, i + HISTORY_BATCH);
    if ((await readBatch(c, batch)) < batch.length) return false;
  }
  for (let i = 0; i < c.st.segments.length; ) {
    const seg = c.st.segments[i]!;
    if ((await walkSegment(c, seg)) === "budget") return false;
    // A newer stretch that could not be read to its end stays: the search cannot be complete.
    if (seg.gen !== 0 && !seg.broken) c.st.segments.splice(i, 1);
    else i++;
  }
  if (c.st.boundary === null && !(await findOpening(c))) return false;
  if (!(await readDeferred(c, "late"))) return false;
  return readDeferred(c, "tail");
}

/** Read the deferred transactions (`SearchState.late`, then `SearchState.tail`); false when this call ran out or deferred them. */
async function readDeferred(c: SearchCall, which: "late" | "tail"): Promise<boolean> {
  const st = c.st;
  st[which] = st[which].filter((t) => !st.read.has(t.signature) && stillMatters(t, st.boundary));
  const list = st[which];
  if (list.length > 0 && c.stopAtPending && [...st.found.values()].some((f) => f.p.executable)) {
    c.tailDeferred = true;
    return false;
  }
  while (list.length > 0) {
    const batch = list.slice(0, HISTORY_BATCH);
    const read = await readBatch(c, batch);
    list.splice(0, read);
    if (read < batch.length) return false;
  }
  return true;
}

/**
 * Look for a withdrawal the vault's CURRENT key has already signed (C1 of
 * the audit: never produce a second signature).
 *
 * Pages the vault's signature list (`getSignaturesForAddress`, 1,000
 * entries per call) back to the transaction that installed the current key:
 * the successful withdrawal of `sequence - 1` that named it as the next key
 * (or `open_vault`). It reads (`getTransaction`) only the transactions that
 * can matter, ranked by what the histories show (a transaction's
 * instructions are known only once it is read; audit 4, C2): first, in
 * history order, every FAILED one that also names the current payout PDA
 * (withdraw-shaped: an attempt at this sequence that did not execute names
 * both; the two lists are merged by slot) and the candidates for the
 * installing withdrawal (successful ones also naming the previous payout
 * PDA); then every SUCCESSFUL one that names the current payout PDA (it
 * cannot have run a withdrawal at this sequence, the vault would have moved
 * on; it can only carry a copy of a signature passed to another program);
 * and LAST every other failed one naming the vault (it could carry a
 * signature passed with another payout account or to another program).
 * Transactions that name only the payout PDA, which anyone can predict and
 * spam, are never read. Every `withdraw` instruction found, whatever program or accounts it
 * named, is authenticated: the message is rebuilt from its own fields for
 * the current sequence and must verify with the current key (LM-OTS);
 * anything that does not (spam, junk) is ignored and the search goes on. A
 * verified signature always counts as revealed. Its next key is
 * authenticated separately (it must hash to the signed next key id): a
 * revealed signature copied next to a junk next key into a cheap failing
 * transaction never becomes `pending` and never hides the genuine
 * occurrence (the search keeps going and takes the authentic next key from
 * any transaction that carries it). `pending` is the newest withdrawal that
 * can be re-broadcast as found (authentic next key of index
 * `q = sequence + 1`, as the program requires); `all` also lists, marked
 * `executable: false`, any the current key signed that cannot (no
 * authentic next key on chain, or a next key of another index: no SDK signs
 * one; the key must not sign again either). Not looked for: an attempt that does not
 * name the vault at all (no SDK builder makes one); a successful transaction
 * naming the vault but not the current payout PDA (a withdrawal at this
 * sequence that executed would have moved the vault); a signature carried in
 * anything but `withdraw` instruction data. The search sees what the RPC
 * returns: a lagging or dishonest RPC can hide a revealed signature (for
 * large amounts, search on two independent RPCs).
 *
 * One call reads at most `maxTransactions` transactions (default 1,000) and
 * `maxSignaturePages` pages (default 200). Past them it returns `complete:
 * false`, `incompleteReason: "limit"` and a `continuation`: pass it back as
 * `continueFrom` to continue (that call first reads what landed since).
 * Transactions that could not be fetched or decoded are retried the same
 * way. `complete` is true only when everything that could hold a signature
 * of the current key was read back to the installing transaction.
 *
 * Cost asymmetry: anyone can land a transaction that names the vault (and
 * even the current payout PDA) for the base fee (5,000 lamports), and each
 * one costs this search one `getTransaction`. Spam that succeeded, or that
 * does not name the current payout PDA, is read after every failed attempt
 * at this sequence, so it never delays finding one (`pending`:
 * `prepareWithdrawal` then returns it without reading that spam at all).
 * FAILED spam that names the vault and the current payout PDA looks exactly
 * like an attempt until it is read: it is read in history order with the
 * genuine attempts, so N such transactions newer than a genuine attempt
 * delay finding it by N reads (about N / 1,000 calls, `continueFrom`).
 * Re-broadcasting a withdrawal the vault-key ledger holds needs no search
 * at all. Signing a NEW withdrawal still needs a complete search: N spam
 * transactions cost N reads.
 *
 * If `pending` is set, re-broadcast it (`buildWithdrawTx` with its fields)
 * instead of signing; to re-broadcast it through
 * `buildWithdrawTxWithFallback`, record it in the vault-key ledger first
 * (`recordPendingWithdrawal`; `prepareWithdrawal` does both). Never sign a
 * new withdrawal while `complete` is false, nor while `all` is not empty.
 */
export async function findPendingWithdrawal(conn: Connection, vault: PublicKey, opts: PendingWithdrawalSearchOptions = {}): Promise<PendingWithdrawalSearch> {
  return searchPending(conn, vault, opts, false);
}

/** `findPendingWithdrawal`; with `stopAtPending`, it stops before the low-priority tail once a withdrawal to re-broadcast is found. */
async function searchPending(conn: Connection, vault: PublicKey, opts: PendingWithdrawalSearchOptions, stopAtPending: boolean): Promise<PendingWithdrawalSearch> {
  const maxTransactions = opts.maxTransactions ?? HISTORY_LIMIT;
  const maxPages = opts.maxSignaturePages ?? HISTORY_PAGE_LIMIT;
  if (!Number.isInteger(maxTransactions) || maxTransactions < 1) throw new RangeError("maxTransactions must be a positive integer");
  if (!Number.isInteger(maxPages) || maxPages < 2) throw new RangeError("maxSignaturePages must be an integer of at least 2 (a continued call first reads a page of what landed since)");
  let saved: SearchState | null = null;
  if (opts.continueFrom !== undefined && opts.continueFrom !== null) {
    const s = continuations.get(opts.continueFrom);
    if (s === undefined) throw new RangeError("continueFrom is not a continuation returned by findPendingWithdrawal in this process");
    if (!s.vault.equals(vault)) throw new RangeError(`continueFrom continues the search of vault ${s.vault.toBase58()}, not of ${vault.toBase58()}`);
    saved = s;
  }
  const v = await fetchVaultAccount(conn, vault);
  if (v === null) throw new Error(`vault ${vault.toBase58()} does not exist`);
  let st: SearchState;
  if (saved !== null && saved.sequence === v.sequence && bytesEqual(saved.keyId, v.keyId)) {
    st = copySearch(saved);
    // What landed since the last call is read first.
    if (st.head !== null) st.segments.unshift(newSegment(st.nextGen++, st.head, v));
  } else {
    st = newSearch(v);
  }
  const codec = idlCodecs().vault;
  const c: SearchCall = {
    conn,
    rpc: rpcRequest(conn),
    v,
    st,
    txLeft: maxTransactions,
    pagesLeft: maxPages,
    previousPayout: v.sequence > 0n ? payoutAddress(vault, v.sequence - 1n) : null,
    withdrawDisc: Uint8Array.from(codec.instruction("withdraw").discriminator),
    openDisc: Uint8Array.from(codec.instruction("open_vault").discriminator),
    at: { vault: accountIndex("vault", "withdraw"), payout: accountIndex("payout", "withdraw"), openVault: accountIndex("vault", "open_vault") },
    stopAtPending,
    tailDeferred: false,
  };
  const stopped = !(await runSearch(c));

  const b = st.boundary;
  const relevant = [...st.unreadable.values()].filter((u) => stillMatters(u, b)).length;
  const newerBroken = st.segments.some((g) => g.gen !== 0 && g.broken);
  const oldest = st.segments[st.segments.length - 1]!;
  const complete = !stopped && b !== null && relevant === 0 && !newerBroken;
  const incompleteReason: PendingWithdrawalSearch["incompleteReason"] = complete ? null : relevant > 0 ? "unreadable" : stopped ? "limit" : "history";
  const notes: string[] = [];
  if (relevant > 0) {
    notes.push(`The RPC could not return or this SDK could not decode ${relevant} transaction(s) of the history: a signature in them could not be checked (continuing the search retries them).`);
  }
  if (stopped && c.tailDeferred) {
    notes.push(
      `A withdrawal the current key already signed was found: re-broadcast it. ${st.late.length + st.tail.length} low-priority transaction(s) were left unread (successful ones naming this sequence's payout account, which cannot have run a withdrawal, and failed ones naming the vault but not that account; anyone can land either for the base fee): continue the search (continueFrom) to read them.`,
    );
  } else if (stopped) {
    notes.push(
      `The search stopped at this call's limit (maxTransactions ${maxTransactions}, maxSignaturePages ${maxPages}) with transactions still to check (${st.examined} read so far): continue it (continueFrom).`,
    );
    if (st.late.length + st.tail.length > 0) {
      notes.push(
        `${st.late.length + st.tail.length} of them are successful transactions naming this sequence's payout account (they cannot have run a withdrawal) or failed transactions that name the vault but not that account: anyone can land those for the base fee, and they are read last; a failed attempt at this sequence names the payout account and is read first.`,
      );
    }
  } else if (newerBroken) {
    notes.push("The RPC returned the vault's newest history out of order or repeated a page (it may ignore `before`): what landed since the search started could not be checked. Search again with another RPC.");
  } else if (b === null && oldest.broken) {
    notes.push("The RPC returned the vault's history out of order or repeated a page (it may ignore `before`) before the transaction that installed the current key: an older revealed signature could not be ruled out. Search again with another RPC.");
  } else if (b === null) {
    notes.push("The RPC's history ends before the transaction that installed the current key (it may not keep old history): an older revealed signature could not be checked. Search with an RPC that keeps the full history.");
  }
  let continuation: PendingWithdrawalContinuation | null = null;
  if (incompleteReason === "limit" || incompleteReason === "unreadable") {
    continuation = Object.freeze({ vault, sequence: v.sequence, examined: st.examined });
    continuations.set(continuation, copySearch(st));
  }
  const all = [...st.found.values()].sort((x, y) => y.gen - x.gen || x.order - y.order).map((f) => f.p);
  // Each one verified under the current key (`inspect`): this process has seen that key sign it.
  for (const p of all) sawSignature(v.key, p.message);
  const pending = all.find((p) => p.executable) ?? null;
  return { vault: v, pending, all, complete, incompleteReason, continuation, examined: st.examined, note: notes.length === 0 ? null : notes.join(" ") };
}

// ------------------------------------------------------ safe signing flow ---

/**
 * Record `search.pending` (a withdrawal the vault's current key already
 * signed, found by `findPendingWithdrawal`) in the vault-key ledger, so that
 * `buildWithdrawTxWithFallback` (which simulates only signatures the ledger
 * holds) can re-broadcast it, and so that no other withdrawal is ever signed
 * with that key through this ledger. The ledger verifies the signature under
 * the vault's current key from the search before writing (`adoptFound`).
 * Returns the withdrawal to rebuild. Refuses when the search found nothing
 * executable (`pending` null: never sign while `all` is not empty either).
 * `prepareWithdrawal` records what it finds on its own.
 */
export async function recordPendingWithdrawal(ledger: VaultKeyLedger, search: PendingWithdrawalSearch): Promise<WithdrawTxArgs> {
  requireLedger({ ledger }, "recordPendingWithdrawal");
  const p = search?.pending ?? null;
  if (p === null || p.nextKey === null || !p.executable) throw new Error("the search found no withdrawal of the current key that can be re-broadcast (search.pending is null)");
  const v = search.vault;
  if (!p.vault.equals(v.publicKey) || p.sequence !== v.sequence) throw new Error("search.pending is not a withdrawal of the searched vault at its current sequence");
  await ledger.adoptFound(v.keyId, p.message, p.signature, p.nextKey, { vault: v.publicKey, sequence: v.sequence, key: v.key });
  if (lmots.verify(v.key, p.message, p.signature)) sawSignature(v.key, p.message);
  return { mint: p.mint, vault: p.vault, sequence: p.sequence, destinationOwner: p.destinationOwner, maxAmount: p.maxAmount, signature: p.signature, nextKey: p.nextKey, nextKeyId: p.nextKeyId };
}


/** `prepareWithdrawal` refused to sign: the history search could not rule out an already revealed signature of the current key. */
export class IncompleteSearchError extends Error {
  /** The incomplete search: when its `continuation` is set, pass it as `continueFrom` and prepare again. */
  readonly search: PendingWithdrawalSearch;

  constructor(search: PendingWithdrawalSearch) {
    super(
      `could not rule out an already revealed signature of the current key (${search.note ?? "incomplete history"}); refusing to sign${
        search.continuation === null ? "" : ": continue the search (continueFrom: error.search.continuation) and prepare again"
      }`,
    );
    this.name = "IncompleteSearchError";
    this.search = search;
  }
}

/**
 * What `prepareWithdrawal` signs. The connected wallet (whose own token
 * accounts are refused as recipients) and the off-curve confirmation are part
 * of `opts.confirm` (`checkRecipient(…, { wallet })` and
 * `acknowledged.offCurveConfirmation`).
 */
export interface WithdrawalRequest {
  /** The recipient wallet (bound by the signature; `release` pays its canonical ATA). */
  destinationOwner: PublicKey;
  maxAmount: bigint;
}

/** `prepareWithdrawal` options: the vault-key ledger and the recipient confirmation (both required), the history search's (`findPendingWithdrawal`) and the cluster check's (`allowLocalnet`). */
export interface PrepareWithdrawalOptions extends PendingWithdrawalSearchOptions, AssertClusterOptions {
  /** Durable vault-key records (`createVaultKeyLedger`, shared by every tab and device holding the phrase); required, no default. */
  readonly ledger: VaultKeyLedger;
  /**
   * The user's confirmation of `checkRecipient(conn, request.destinationOwner,
   * mint, vault, { wallet })` for this exact withdrawal (`vault` is the
   * account's vault address: `vaultAddress(mint, deriveVaultKey(master,
   * cluster, mint, account, 0).keyId)`); required, no default
   * (`RecipientConfirmation`).
   */
  readonly confirm: RecipientConfirmation;
}

export interface PreparedWithdrawal {
  vault: VaultInfo;
  /**
   * A withdrawal the vault's current key already signed, found on chain:
   * re-broadcast it (`buildWithdrawTxWithFallback` with these fields); it is
   * now recorded in the ledger, and nothing new was signed.
   */
  pending: PendingWithdrawal | null;
  /**
   * The withdrawal to broadcast (null when `pending` is set), recorded in the
   * ledger before it was returned. `reused`: the ledger already held this
   * exact withdrawal's signature (an earlier call signed it), which is
   * returned as recorded, without a new search.
   */
  signed: { message: Uint8Array; args: WithdrawTxArgs; reused: boolean } | null;
  /** The recipient check re-run right before signing (it held nothing the user had not confirmed). Null when nothing new was signed. */
  recipient: RecipientCheck | null;
  /** The history search (null when the ledger already held this exact withdrawal's signature: no search was needed). */
  search: PendingWithdrawalSearch | null;
}

/**
 * The safe way to sign a withdrawal from vault `account` of a recovery
 * phrase (SPEC §3.10), in order:
 * 0. `opts.ledger` and `opts.confirm` are required (no defaults); private
 *    copies of `master` (an all-zero one is refused), `mint`,
 *    `request.destinationOwner`, `request.maxAmount` (a u64) and
 *    `opts.confirm` are taken now, and only they are used from here on; the
 *    recipient confirmation, without the network
 *    (`RecipientConfirmationError`): `opts.confirm.recipient` is
 *    `checkRecipient`'s result for `request.destinationOwner`, `mint` and
 *    this account's vault, with no refusal, and the user acknowledged each
 *    kind of caution it holds (recipient warnings, mint warnings, off-curve
 *    confirmation); then check the cluster: `conn`'s genesis hash must be
 *    `cluster`'s (`assertCluster`; localnet only with `opts.allowLocalnet`),
 *    so keys of one cluster never sign against another;
 * 1. read the vault; the phrase's key at (account, vault.sequence) must be
 *    the vault's current key; the next key (account, sequence + 1, so
 *    `q = sequence + 1` as the program requires) and the exact message are
 *    fixed now, from the copies;
 * 1b. the ledger's record of the current key: one for another withdrawal
 *    (reserved or signed, by this or another tab or device sharing the
 *    ledger) throws `VaultKeyInUseError`, with the recorded withdrawal to
 *    re-broadcast; one holding this exact withdrawal's signature returns it
 *    (`signed.reused`, `search: null`): nothing new is signed (a record of
 *    SDK 0.2.0 gets its key on the way, so it can be exported);
 * 2. `findPendingWithdrawal`: if the current key already signed, record that
 *    withdrawal in the ledger and return it to re-broadcast, signing nothing
 *    (one found only next to a junk next key is completed with this
 *    phrase's next key when it names it; if the key only signed something
 *    that cannot execute, refuse: a second message would be a second
 *    one-time signature); if the search is not complete, throw
 *    `IncompleteSearchError` (there is no override: when its
 *    `search.continuation` is set, call again with `continueFrom` to continue
 *    the search; otherwise use another RPC); if the vault moved meanwhile,
 *    refuse;
 * 3. `checkRecipient` again, for the message's recipient, mint and vault,
 *    right before reserving: a refusal now, or any caution the confirmed
 *    check did not hold (the chain changed since the user saw it), refuses
 *    (`RecipientConfirmationError` `refused` / `stale`, with `current`):
 *    nothing is signed or written;
 * 4. `master` must be unchanged; the key is reserved for the message in the
 *    ledger (atomic add); then, synchronously right before signing:
 *    `master` must still be unchanged, the signing key's id must be the
 *    vault's current key id, the confirmation matches the exact bytes about
 *    to be signed, and every local check of `signWithdrawal` (key-index
 *    binding included) passes; then sign (deterministic), record the
 *    signature in the ledger, and only then return it.
 *
 * What is signed, returned (`signed.args`) and re-checked (`recipient`) is
 * the request as it was at the call: a request or confirmation object edited
 * while the call awaits the network (a reactive form) changes nothing. Every
 * key comes from the private copy of `master` taken at entry, wiped (with
 * every derived private seed) before returning. `master` itself is compared
 * with that copy: if it changes while the call runs (e.g. a "lock" wipes
 * it), nothing is signed (if it changes during the reservation itself, the
 * key stays reserved for this request: prepare the same request again to
 * finish it). The caller then broadcasts `signed` or `pending` with
 * `buildWithdrawTxWithFallback` and the same ledger.
 */
export async function prepareWithdrawal(
  conn: Connection,
  master: Uint8Array,
  cluster: Cluster,
  mint: PublicKey,
  account: number,
  request: WithdrawalRequest,
  opts: PrepareWithdrawalOptions,
): Promise<PreparedWithdrawal> {
  const ledger = requireLedger(opts, "prepareWithdrawal");
  const confirm = requireConfirmation(opts, "prepareWithdrawal");
  if (request === null || typeof request !== "object" || !(request.destinationOwner instanceof PublicKey)) throw new TypeError("request.destinationOwner must be a PublicKey");
  if (!(mint instanceof PublicKey)) throw new TypeError("mint must be a PublicKey");
  // Private copies, taken now: a request edited while this call awaits the network never changes what is signed.
  const destinationOwner = new PublicKey(request.destinationOwner.toBytes());
  const maxAmount: unknown = request.maxAmount;
  if (!isU64(maxAmount)) throw new RangeError("request.maxAmount must be a u64 (bigint base units)");
  const mintKey = new PublicKey(mint.toBytes());
  checkMaster(master);
  const seed = Uint8Array.from(master);
  const secrets: Uint8Array[] = [seed];
  try {
    const genesis = deriveVaultKey(seed, cluster, mintKey, account, GENESIS_KEY_INDEX);
    secrets.push(genesis.skSeed);
    const vaultKey = vaultAddress(mintKey, genesis.keyId);
    const expected = { destinationOwner, mint: mintKey, vault: vaultKey };
    // The user confirmed this exact recipient, mint and vault, before anything is read, reserved or signed.
    assertConfirmed(confirm, expected);
    await assertCluster(conn, cluster, opts);
    const vault = await fetchVault(conn, vaultKey);
    if (vault === null) throw new Error(`vault ${vaultKey.toBase58()} (account ${account}) is not open`);
    const sequence = keySequence(vault.sequence);
    if (nextKeyIndex(vault.sequence) === null) throw new Error("this vault has used its last key sequence: no withdrawal can follow it");
    const key = deriveVaultKey(seed, cluster, mintKey, account, sequence);
    const next = deriveVaultKey(seed, cluster, mintKey, account, sequence + 1);
    secrets.push(key.skSeed, next.skSeed);
    if (!bytesEqual(key.keyId, vault.keyId)) throw new Error("this recovery phrase does not hold the vault's current key: refusing to sign");
    const message = withdrawMessage(vaultKey, mintKey, vault.sequence, destinationOwner, maxAmount, next.keyId);
    const args = (signature: Uint8Array): WithdrawTxArgs => ({
      mint: mintKey,
      vault: vaultKey,
      sequence: vault.sequence,
      destinationOwner,
      maxAmount,
      signature,
      nextKey: next.pk,
      nextKeyId: next.keyId,
    });

    // The durable record of this key comes first: it covers what no history search can see (a signature
    // revealed by a simulation or a dropped send, another tab or device sharing this ledger).
    const recorded = await completeRecordKey(ledger, await ledger.get(key.keyId), key.pk);
    if (recorded !== null) {
      if (recorded.messageHash !== toHex(sha256(message))) throw inUse(recorded, key.pk);
      if (recorded.signature !== null) {
        const signature = fromHex(recorded.signature);
        if (!lmots.verify(key.pk, message, signature)) throw new VaultLedgerError("the recorded signature does not verify with the vault's current key over this withdrawal (a corrupted record): nothing was signed");
        sawSignature(key.pk, message);
        return { vault, pending: null, signed: { message, args: args(signature), reused: true }, recipient: null, search: null };
      }
    }
    const adopt = async (p: PendingWithdrawal): Promise<PendingWithdrawal> => {
      await ledger.adoptFound(key.keyId, p.message, p.signature, p.nextKey, { vault: vaultKey, sequence: vault.sequence, key: key.pk });
      sawSignature(key.pk, p.message); // verified under the current key by the search and by adoptFound
      return p;
    };

    // Spam read last: once a withdrawal to re-broadcast is found, the low-priority tail is left unread (nothing new is signed then).
    const search = await searchPending(conn, vaultKey, opts, true);
    if (search.vault.sequence !== vault.sequence || !bytesEqual(search.vault.keyId, vault.keyId)) {
      throw new Error(`the vault moved to sequence ${search.vault.sequence} during the history search (a withdrawal executed elsewhere): nothing was signed; prepare it again`);
    }
    if (search.pending !== null) return { vault, pending: await adopt(search.pending), signed: null, recipient: null, search };
    if (search.all.length > 0) {
      // Revealed, but no transaction carried its authentic next key (a junk-keyed copy): when it names this
      // phrase's next key, that key completes it, and it is re-broadcast like any other.
      const ours = search.all.find((p) => p.nextKey === null && bytesEqual(p.nextKeyId, next.keyId));
      if (ours !== undefined) return { vault, pending: await adopt({ ...ours, nextKey: next.pk, executable: true }), signed: null, recipient: null, search };
      throw new Error(
        `refusing to sign: the vault's current key already signed a withdrawal that cannot execute (transaction ${search.all[0]!.txSignature}); signing another message would be a second one-time signature`,
      );
    }
    if (!search.complete) throw new IncompleteSearchError(search);
    // The chain may have changed since the user confirmed: anything new refuses, before the reservation.
    const recipient = await recheckRecipient(conn, confirm, expected);
    const unchanged = (): void => {
      if (!bytesEqual(master, seed)) throw new Error("refusing to sign: master changed while prepareWithdrawal ran (was it wiped by a lock?); nothing was signed");
    };
    unchanged(); // before the reservation: a lock during the search leaves no record behind
    // Reserve, then (synchronously, right before signing) the last checks, sign, record, return.
    const { signature, reused } = await signRecorded(ledger, key.skSeed, key.pk, message, next.pk, () => {
      unchanged();
      if (!bytesEqual(lmots.keyId(key.pk), vault.keyId)) throw new Error("refusing to sign: the signing key is not the vault's current key");
      // The bytes about to be signed name exactly the confirmed recipient, mint and vault.
      assertConfirmed(confirm, parseWithdrawMessage(message));
    });
    return { vault, pending: null, signed: { message, args: args(signature), reused }, recipient, search };
  } finally {
    for (const s of secrets) s.fill(0);
  }
}

// ----------------------------------------------------------------- scan ---

/**
 * Vault accounts `0..=maxAccount` of a recovery phrase for `mint`: address
 * (from the genesis key of each account), sequence, balance, reserved and
 * unreleased payouts, and whether the vault's current key is this phrase's
 * key at (account, sequence). Keys come from a private copy of `master`
 * taken at entry (wiped before returning).
 */
export async function scanVaults(conn: Connection, master: Uint8Array, cluster: Cluster, mint: PublicKey, maxAccount: number): Promise<ScannedVault[]> {
  if (!Number.isInteger(maxAccount) || maxAccount < 0 || maxAccount > 1_000) throw new RangeError("maxAccount must be 0..=1000");
  checkMaster(master);
  const seed = Uint8Array.from(master);
  const keyIdAt = (account: number, sequence: number): Uint8Array => {
    const k = deriveVaultKey(seed, cluster, mint, account, sequence);
    k.skSeed.fill(0);
    return k.keyId;
  };
  try {
    const tokenProgram = tokenProgramOf(await getAccount(conn, mint), mint);
    const accounts = Array.from({ length: maxAccount + 1 }, (_, account) => {
      const keyId = keyIdAt(account, 0);
      return { account, genesisKeyId: keyId, vault: vaultAddress(mint, keyId) };
    });
    const fetched = await getAccounts(conn, accounts.flatMap((a) => [a.vault, associatedTokenAddress(a.vault, mint, tokenProgram)]));
    const out: ScannedVault[] = [];
    for (const [i, a] of accounts.entries()) {
      const owned = ownedBy(fetched[2 * i] ?? null, PROGRAM_IDS.vault, "Vault");
      const balance = tokenBalance(fetched[2 * i + 1]);
      if (owned === null) {
        out.push({ ...a, opened: false, sequence: 0n, keyId: null, keyMatches: null, balance, reserved: 0n, available: balance, pendingPayouts: [], payoutsComplete: true });
        continue;
      }
      const v = decodeVault(a.vault, owned.data);
      let keyMatches = false;
      if (v.sequence <= 0xffff_ffffn) keyMatches = bytesEqual(keyIdAt(a.account, keySequence(v.sequence)), v.keyId);
      const payouts = v.sequence === 0n ? listing(v, [], "getProgramAccounts", true, null) : await listPayoutsOf(conn, v);
      out.push({
        ...a,
        opened: true,
        sequence: v.sequence,
        keyId: v.keyId,
        keyMatches,
        balance,
        reserved: v.reserved,
        available: balance > v.reserved ? balance - v.reserved : 0n,
        pendingPayouts: payouts.payouts,
        payoutsComplete: payouts.complete,
      });
    }
    return out;
  } finally {
    seed.fill(0);
  }
}

// ------------------------------------------- vault-key records of 0.2.0 ---

/** What `completeVaultKeyRecords` did, by hex key id. */
export interface VaultKeyCompletion {
  /** Signed records without their key that now hold it (they can be exported). */
  readonly completed: string[];
  /** Signed records without their key that are not keys of this phrase's vault accounts `0..=maxAccount` of `mint` on `cluster` (or whose signature does not verify under that key): unchanged. */
  readonly remaining: string[];
}

/**
 * Give every signed record of `ledger` that does not hold its one-time key
 * (written by SDK 0.2.0) that key, re-derived from this recovery phrase:
 * vault accounts `0..=maxAccount` of `mint` on `cluster`. Such a record is
 * enforced by this ledger, but `exportVaultKeyRecords` cannot carry it
 * (`skipped`, reason `no-key`: nothing could authenticate it), so another
 * device would never learn that the key is spent. Run it before exporting
 * when the export lists `no-key` records (`importVaultKeyRecords` reports
 * them as `unverifiable` on the other device). Each completed record is
 * authenticated before it is written (`importRecord`: the key hashes to the
 * key id, has `q = sequence`, and the recorded signature verifies under it
 * over the recorded withdrawal). Nothing is signed. `prepareWithdrawal` and
 * `signWithdrawal` complete the record of the key they use on their own.
 * Keys come from a private copy of `master` (wiped before returning).
 */
export async function completeVaultKeyRecords(ledger: VaultKeyLedger, master: Uint8Array, cluster: Cluster, mint: PublicKey, maxAccount: number): Promise<VaultKeyCompletion> {
  requireLedger({ ledger }, "completeVaultKeyRecords");
  if (!Number.isInteger(maxAccount) || maxAccount < 0 || maxAccount > 1_000) throw new RangeError("maxAccount must be 0..=1000");
  if (!(mint instanceof PublicKey)) throw new TypeError("mint must be a PublicKey");
  checkMaster(master);
  const completed: string[] = [];
  const remaining: string[] = [];
  const keyless = (await ledger.list()).filter((r) => r.key === null && r.signature !== null);
  if (keyless.length === 0) return { completed, remaining };
  const seed = Uint8Array.from(master);
  try {
    const accountOf = new Map<string, number>();
    for (let account = 0; account <= maxAccount; account++) {
      const genesis = deriveVaultKey(seed, cluster, mint, account, GENESIS_KEY_INDEX);
      genesis.skSeed.fill(0);
      accountOf.set(vaultAddress(mint, genesis.keyId).toBase58(), account);
    }
    for (const r of keyless) {
      const account = accountOf.get(r.vault);
      const sequence = BigInt(r.sequence);
      if (account === undefined || sequence > BigInt(U32_MAX)) {
        remaining.push(r.keyId);
        continue;
      }
      const k = deriveVaultKey(seed, cluster, mint, account, Number(sequence));
      k.skSeed.fill(0);
      const now = await completeRecordKey(ledger, r, k.pk);
      (now !== null && now.key !== null ? completed : remaining).push(r.keyId);
    }
    return { completed, remaining };
  } finally {
    seed.fill(0);
  }
}

// --------------------------------------------------- throwaway fee payer ---

/** Fund a throwaway withdrawal fee payer from `from` (default 0.01 SOL). */
export async function buildFundFeePayerTx(
  conn: Connection,
  from: PublicKey,
  feePayer: PublicKey,
  lamports: bigint = FEE_PAYER_FUNDING_LAMPORTS,
): Promise<Transaction> {
  if (!isU64(lamports) || lamports === 0n) throw new RangeError("lamports must be a positive u64");
  return finishLegacy(conn, from, [SystemProgram.transfer({ fromPubkey: from, toPubkey: feePayer, lamports })]);
}

/**
 * Return everything left on a throwaway fee payer to `to`, minus the fee of
 * this transaction. Signed by `feePayer`; send it as is. Run it after the
 * payout is released: the payout's rent returns to the fee payer then.
 */
export async function buildRefundFeePayerTx(conn: Connection, feePayer: Keypair, to: PublicKey): Promise<Transaction> {
  const balance = BigInt(await conn.getBalance(feePayer.publicKey, "confirmed"));
  const probe = await finishLegacy(conn, feePayer.publicKey, [SystemProgram.transfer({ fromPubkey: feePayer.publicKey, toPubkey: to, lamports: 0n })]);
  const fee = (await conn.getFeeForMessage(probe.compileMessage(), "confirmed")).value;
  if (fee === null) throw new Error("could not price the refund transaction");
  const refund = balance - BigInt(fee);
  if (refund <= 0n) throw new Error("nothing to refund");
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: feePayer.publicKey, toPubkey: to, lamports: refund }));
  tx.feePayer = feePayer.publicKey;
  tx.recentBlockhash = probe.recentBlockhash!;
  tx.lastValidBlockHeight = probe.lastValidBlockHeight!;
  tx.sign(feePayer);
  return tx;
}

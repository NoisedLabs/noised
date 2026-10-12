/**
 * `attest_launch` (PQ v2, on-chain metadata): a launch's post-quantum
 * identity signs the launch, and a throwaway fee payer lands the signature
 * in a v1 transaction.
 *
 * # What is signed, and why it is one-time
 *
 * The identity's LMS key signs the 221-byte message v3 of `./identity.ts`
 * (`attestationMessage`): the launchpad, the launch, its `params_hash`, its
 * creator, the hash of the token's on-chain metadata record (`TokenMeta`,
 * `../metadata/record.ts`: name, symbol, uri mode, external uri and
 * document), the hash of its creator rules record (`LaunchRules`,
 * `../launch/rules.ts`; all zero for none) and the launch window. Each LMS
 * leaf signs ONE message, ever:
 * two signatures from one leaf let anyone forge at that leaf. So the leaf is
 * reserved durably for this message (`./leafLedger.ts`) before any signature
 * exists, the signature is deterministic (a retry gives the same bytes), and
 * it is recorded before it is returned.
 *
 * # The rules this module enforces before it signs
 *
 * A valid signature over an existing launch always lands and burns its leaf;
 * it attests only if the launch names this identity, the metadata record its
 * hash names already exists (`publish_metadata`), so does the rules record
 * its rules hash names unless that is zero (`publish_rules`; a missing,
 * pre-funded or otherwise invalid record makes the landing burn-only), the window can still be
 * used (60..=3,600 s long, at least 60 s of it left when it lands, opening
 * at most 7 days later; unix seconds) and the attestation slot is free (no
 * attestation yet, or one whose window passed unused while the launch is
 * still `Configured`: audit round 3 F1). A signature over a launch that
 * does not exist can never land at all. So `buildAttestLaunchTx` refuses,
 * before it signs:
 *
 * - an RPC endpoint that does not serve the identity's cluster (genesis hash,
 *   `assertCluster`): a leaf is per cluster, and a signature made for the
 *   wrong cluster is valid where it was not meant to be;
 * - a call without the reviewed configuration (`expectedParamsHash`,
 *   required: the creator's Ed25519 key is classical, so a forged creator
 *   can create a launch at the same PDA with its own parameters and this
 *   identity copied in; only `unsafeAcceptAnyParams: true` skips it, for
 *   tooling);
 * - a launch that is not finalized (default), not `Configured`, not created
 *   by the expected wallet, that names another identity, or that holds a
 *   configuration other than the one reviewed;
 * - a window that cannot open (checked against the cluster clock with a
 *   landing margin);
 * - a metadata record that is not published, or not yet FINALIZED (default;
 *   `metadataCommitment: "confirmed"` accepts a confirmed one): a record lost
 *   in a dropped fork turns the attestation into a burn;
 * - with a non-zero `rulesHash`, a rules record that is not published (or
 *   not a valid record: a pre-funded address, another launch's), or not yet
 *   FINALIZED (`rulesCommitment`, default `finalized`), for the same reason;
 * - a launch whose attestation holds another message whose window has not
 *   passed (it can never be replaced: a new signature would only burn a
 *   leaf); once that window passed unused, a new message (a new opening
 *   time, the same or a new record) replaces it, and the result says so;
 * - a NEW message for a launch while an earlier signature of it (in the
 *   ledger) was sent but never landed and its window has not ended
 *   (`PendingAttestationError`; audit round 3, review info #2): since F1 such
 *   a signature can still land once the current window passes and take the
 *   slot with its own window, up to 7 days later. Land it first
 *   (`landOrBurnPending`: it attests, or only burns its leaf), or wait until
 *   its window ends. A rebuild of a recorded signature is never refused;
 * - a new leaf for a launch that already had `maxBurnOnlyLandings` (default
 *   2) landings that only burned their leaf (`AttestRetryLimitError`, with
 *   the reasons): each one spends one of the identity's 1,024 leaves.
 *
 * Then it reads the identity's on-chain bitmap, picks the message's leaf
 * (`leafProbeStart`, first leaf clear on-chain and absent from the ledger,
 * +1 with wrap-around), reserves it (`ledger.reserve`; another writer's
 * reservation moves the message to the next free leaf), and only then signs.
 *
 * # After sending
 *
 * Never assume the landing attested: `confirmAttestation` checks that the
 * attestation account has version 3 and this message's hash. A landing that
 * burned the leaf without attesting (`PqLeafConsumed`, an empty version-0
 * attestation, or another message's attestation) is reported as `burned`
 * with every reason the SDK can infer, and the ledger is updated
 * (`markLanded` / `markBurned`). A transaction that did not land (expired
 * blockhash, dropped) is `pending`: build again with the same inputs, which
 * gives the same leaf and the same signature bytes; never sign anew. The
 * program refuses any account but the ones the signature names
 * (ConstraintSeeds 2006, nothing written, the leaf NOT burned): the same
 * signature is then sent again with the right accounts (`rewrapAttestTx`),
 * never re-signed. PqLeafUsed 6041 means the leaf already landed (a copy of
 * this signature): the landing is confirmed from the accounts.
 *
 * # Older signatures that never landed (audit round 3, review info #2)
 *
 * The ledger keeps every signed message, and with it the window it signed
 * (`leafLedger.launchSignatures`). `findPendingAttestations` lists the
 * signatures of a launch that were never seen landing (leaf clear on-chain)
 * and whose window has not ended, and says what landing each one now would
 * do. The safe moment to retire them is while the launch's current
 * attestation holds the slot (its window has not ended): landed then, they
 * only burn their leaf (`landOrBurnPending` with `burnOnly: true`, which
 * marks them `retired`: not counted against `maxBurnOnlyLandings`).
 * `landOrBurnPending` never makes a new signature: it re-sends recorded ones.
 * A signature only another device's ledger holds stays invisible here:
 * import that device's records first (`importLeafRecords`).
 *
 * # The throwaway fee payer
 *
 * The identity signs, not the payer: any key may pay. A fresh key per launch
 * keeps the creator's wallet out of the transaction. It needs the signature
 * fee, the priority fee and the rent of the identity (196 B, first landing
 * only) and attestation (2,708 B) accounts it creates:
 * `fundingLamportsForAttest` reads the rent from the cluster
 * (`getMinimumBalanceForRentExemption`). The same key publishes the metadata
 * record (and the rules record, `buildPublishRulesV1Tx`) first:
 * `throwawayPayerFunding` (`../metadata/publish.ts`) funds them, and
 * `buildSweepPayerTx` returns what is left.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { Keypair, PublicKey, SystemProgram, Transaction, type Connection, type TransactionInstruction } from "@solana/web3.js";

import { encodeBase58 } from "../codec/base58.js";
import { bytesEqual, fromHex, isAllZero, isU64, toHex } from "../codec/bytes.js";
import { buildInstruction } from "../codec/ix.js";
import { PQ_IDENTITY, PROGRAM_IDS, type Cluster } from "../constants.js";
import { idlCodecs } from "../idl/index.js";
import { decodeLaunch, fetchAttestation, fetchIdentity, fetchLaunch } from "../launch/accounts.js";
import {
  ATTEST_LANDING_MARGIN_SECS,
  clusterUnixTime,
  MAX_LAUNCH_WINDOW_SECS,
  MIN_LAUNCH_WINDOW_SECS,
  unixToIso,
  unixToUtcText,
  validateLaunchWindow,
  windowValidAt,
} from "../launch/window.js";
import { fetchTokenMeta } from "../metadata/record.js";
import { launchRulesRecordExists } from "../launch/rules.js";
import { attestationAddress, identityAddress, launchAddress, launchRulesAddress, tokenMetaAddress } from "../pda.js";
import { checkClockSkew, localUnixSecs } from "../rpc/clock.js";
import { assertCluster } from "../rpc/cluster.js";
import { computeUnitLimitOf, computeUnitPriceOf, priorityFeeLamports, type ComputeBudgetOptions } from "../rpc/computeBudget.js";
import { customErrorCode } from "../rpc/errors.js";
import { getAccount, getAccounts, ownedBy } from "../rpc/fetch.js";
import { LAMPORTS_PER_SIGNATURE, rentExemptLamports, sendAndConfirm } from "../rpc/index.js";
import { compileV1Message, signV1Message, V1_MAX_TRANSACTION_SIZE } from "../tx/v1.js";
import type { AttestationAccount, LaunchAccount } from "../types.js";
import { attestationMessage, identityId, leafUsed, parseAttestationMessage, usedLeafCount, type LeafChoice, type PqIdentity } from "./identity.js";
import { holdsMessageLeaf, launchSignatures, signAtNextLeaf, type LeafLedger, type LeafRecord } from "./leafLedger.js";
import type { LedgerLock } from "./ledgerLock.js";
import { LMS_PUBLIC_KEY_LEN, LMS_SIGNATURE_LEN, LmsKeyPair, lmsVerify } from "./lms.js";
import { countsAsUnlanded, MAX_UNLANDED_SIGNATURES, SignatureCapError, withSigningLock } from "./signGuard.js";

/** v1 compute-unit limit of `attest_launch` (measured at most about 114.5k CU on all 1,024 leaves; worst-case projection about 170k). */
export const ATTEST_COMPUTE_UNITS = PQ_IDENTITY.ATTEST_COMPUTE_UNITS;
/** v1 loaded-accounts-data limit of `attest_launch` (it loads about 785 KB, the launchpad program included). */
export const ATTEST_LOADED_ACCOUNTS_BYTES = PQ_IDENTITY.ATTEST_LOADED_ACCOUNTS_BYTES;
/** Landings of one launch that only burned their leaf after which `buildAttestLaunchTx` stops signing new leaves for it (default of `maxBurnOnlyLandings`). */
export const MAX_BURN_ONLY_LANDINGS = 2;
/** Anchor's ConstraintSeeds: the program refused an account the signature does not name (nothing written, no leaf burned). */
const CONSTRAINT_SEEDS = 2006;
/** `PqLeafUsed`: the leaf is already set on-chain. */
const PQ_LEAF_USED = 6041;

function checkBytes(name: string, b: unknown, len: number): asserts b is Uint8Array {
  if (!(b instanceof Uint8Array)) throw new TypeError(`${name} must be a Uint8Array`);
  if (b.length !== len) throw new RangeError(`${name} must be ${len} bytes, got ${b.length}`);
}

function checkPublicKey(name: string, k: unknown): asserts k is PublicKey {
  if (!(k instanceof PublicKey)) throw new TypeError(`${name} must be a PublicKey`);
}

// ------------------------------------------------------------ instruction ---

/**
 * Whether a new signature may replace `attestation` (audit round 3 F1):
 * its window passed unused, `nowSecs > notAfter`, while the launch is still
 * `Configured` (the caller checks the launch; a live launch's attestation
 * never changes). An empty attestation is free anyway; an unexpired one is
 * never replaced (a new signature then only burns its leaf).
 */
export function attestationReplaceable(attestation: Pick<AttestationAccount, "attested" | "notAfter">, nowSecs: bigint): boolean {
  if (typeof nowSecs !== "bigint") throw new TypeError("nowSecs must be bigint unix seconds");
  return !attestation.attested || nowSecs > attestation.notAfter;
}

/** A launch window: unix SECONDS (never `Date.now()` milliseconds), inclusive at both ends. */
export interface LaunchWindow {
  readonly notBefore: bigint;
  readonly notAfter: bigint;
}

/** Everything `attest_launch` takes, signature included. */
export interface AttestInstructionArgs {
  /** Pays the fee and the rent (a throwaway key). */
  readonly payer: PublicKey;
  readonly launch: PublicKey;
  /** The 56-byte LMS public key that signed; its identity account `["identity", SHA256(0x21 || pk)]` is derived from it. */
  readonly lmsPublicKey: Uint8Array;
  /** The 2,508-byte LMS signature. */
  readonly lmsSignature: Uint8Array;
  /** `metadataHashV2` of the record the identity signed (32 bytes); its account `["metadata", launch, hash]` is derived from it. */
  readonly metadataHash: Uint8Array;
  /** `rulesHash` of the creator rules the identity signed (32 bytes; default all zero: no rules). Its account `["rules", launch, hash]` is derived from it. */
  readonly rulesHash?: Uint8Array | undefined;
  readonly notBefore: bigint;
  readonly notAfter: bigint;
}

/** The `rules` account `attest_launch` and `launch` take for a rules hash: the record `["rules", launch, hash]`, or null (the launchpad program id in its place) for the zero hash. */
export function rulesAccountFor(launch: PublicKey, rulesHash: Uint8Array): PublicKey | null {
  checkBytes("rulesHash", rulesHash, 32);
  return isAllZero(rulesHash) ? null : launchRulesAddress(launch, rulesHash);
}

/**
 * The `attest_launch` instruction (IDL-encoded): data = discriminator
 * `b518c935f67efd4f` || `lms_pk [56]` || `lms_sig: bytes` ||
 * `metadata_hash [32]` || `rules_hash [32]` || `i64le(not_before)` ||
 * `i64le(not_after)`; accounts `[payer (signer, writable), launch, identity
 * (writable), attestation (writable), token_meta, system program, rules]`:
 * the identity is the PDA of the key sent, the attestation the launch's,
 * `token_meta` exactly `["metadata", launch, metadata_hash]`, `rules`
 * exactly `["rules", launch, rules_hash]`, or the launchpad program id for
 * the zero hash (any other account fails ConstraintSeeds, burning nothing).
 * Pure: no check of what the program would do with it.
 */
export function attestLaunchInstruction(a: AttestInstructionArgs): TransactionInstruction {
  checkPublicKey("payer", a.payer);
  checkPublicKey("launch", a.launch);
  checkBytes("LMS public key", a.lmsPublicKey, LMS_PUBLIC_KEY_LEN);
  checkBytes("LMS signature", a.lmsSignature, LMS_SIGNATURE_LEN);
  checkBytes("metadataHash", a.metadataHash, 32);
  const rulesHash = a.rulesHash ?? new Uint8Array(32);
  checkBytes("rulesHash", rulesHash, 32);
  return buildInstruction(
    idlCodecs().launchpad,
    PROGRAM_IDS.launchpad,
    "attest_launch",
    {
      payer: a.payer,
      launch: a.launch,
      identity: identityAddress(a.lmsPublicKey),
      attestation: attestationAddress(a.launch),
      tokenMeta: tokenMetaAddress(a.launch, a.metadataHash),
      rules: rulesAccountFor(a.launch, rulesHash),
    },
    { lmsPk: a.lmsPublicKey, lmsSig: a.lmsSignature, metadataHash: a.metadataHash, rulesHash, notBefore: a.notBefore, notAfter: a.notAfter },
  );
}

/** Priority fee and v1 limits of the attest transaction. */
export interface AttestTxOptions extends ComputeBudgetOptions {
  /** v1 loaded-accounts-data limit (default `ATTEST_LOADED_ACCOUNTS_BYTES`, 2 MiB). */
  loadedAccountsDataSizeLimit?: number | undefined;
}

/** The v1 config of an attest transaction: compute limit (default 300,000), loaded-data limit, and the priority fee in lamports (null: none). */
export function attestTxConfig(opts: AttestTxOptions = {}): { computeUnitLimit: number; loadedAccountsDataSizeLimit: number; priorityFeeLamports: bigint | null } {
  const computeUnitLimit = computeUnitLimitOf(opts, ATTEST_COMPUTE_UNITS);
  const price = computeUnitPriceOf(opts);
  const loadedAccountsDataSizeLimit = opts.loadedAccountsDataSizeLimit ?? ATTEST_LOADED_ACCOUNTS_BYTES;
  if (!Number.isInteger(loadedAccountsDataSizeLimit) || loadedAccountsDataSizeLimit < 1 || loadedAccountsDataSizeLimit > 0xffff_ffff) {
    throw new RangeError("loadedAccountsDataSizeLimit must be a positive u32");
  }
  return { computeUnitLimit, loadedAccountsDataSizeLimit, priorityFeeLamports: price === null || price === 0n ? null : priorityFeeLamports(price, computeUnitLimit) };
}

/** The signed v1 transaction carrying an attestation. */
export interface SignedAttestTx {
  /** v1 wire bytes (`sendAndConfirm` sends them as they are). */
  readonly tx: Uint8Array;
  /** Transaction id: base58 of the fee payer's signature. */
  readonly signature: string;
  readonly sizeBytes: number;
  readonly computeUnitLimit: number;
  readonly priorityFeeLamports: bigint | null;
}

/**
 * Compile `ix` (an `attest_launch` instruction) into a v1 transaction paid
 * and signed by `payer` alone, with the attest config words. Pure. Throws
 * when it would exceed 4,096 bytes.
 */
export function signAttestTransaction(payer: Keypair, ix: TransactionInstruction, recentBlockhash: string, opts: AttestTxOptions = {}): SignedAttestTx {
  return signAttestConfigured(payer, ix, recentBlockhash, attestTxConfig(opts));
}

/** `signAttestTransaction` with the config words already computed (a re-send keeps the original priority fee in lamports). */
function signAttestConfigured(payer: Keypair, ix: TransactionInstruction, recentBlockhash: string, config: ReturnType<typeof attestTxConfig>): SignedAttestTx {
  const message = compileV1Message(payer.publicKey, [ix], recentBlockhash, {
    computeUnitLimit: config.computeUnitLimit,
    loadedAccountsDataSizeLimit: config.loadedAccountsDataSizeLimit,
    ...(config.priorityFeeLamports === null ? {} : { priorityFeeLamports: config.priorityFeeLamports }),
  });
  if (message.header.numRequiredSignatures !== 1) throw new Error("an attest transaction is signed by its fee payer alone");
  const tx = signV1Message(message, [payer]);
  return {
    tx,
    signature: encodeBase58(tx.subarray(message.bytes.length, message.bytes.length + 64)),
    sizeBytes: tx.length,
    computeUnitLimit: config.computeUnitLimit,
    priorityFeeLamports: config.priorityFeeLamports,
  };
}

/**
 * Exact wire size (bytes) of an attest transaction: 3,005 without rules
 * (the rules account is the launchpad program id, already in the message),
 * 3,037 with rules (one more account), plus 8 with a priority fee. Otherwise
 * constant: the metadata and the rules travel as their 32-byte hashes (the
 * limit is 4,096). Computed from the real encoder and v1 compiler.
 */
export function attestTransactionSize(opts: { readonly priorityFee?: boolean; readonly rules?: boolean } = {}): number {
  const key = (b: number): PublicKey => new PublicKey(new Uint8Array(32).fill(b));
  const ix = attestLaunchInstruction({
    payer: key(1),
    launch: key(2),
    lmsPublicKey: new Uint8Array(LMS_PUBLIC_KEY_LEN),
    lmsSignature: new Uint8Array(LMS_SIGNATURE_LEN),
    metadataHash: new Uint8Array(32),
    rulesHash: opts.rules === true ? new Uint8Array(32).fill(3) : new Uint8Array(32),
    notBefore: 0n,
    notAfter: 0n,
  });
  const message = compileV1Message(key(1), [ix], encodeBase58(new Uint8Array(32)), {
    computeUnitLimit: ATTEST_COMPUTE_UNITS,
    loadedAccountsDataSizeLimit: ATTEST_LOADED_ACCOUNTS_BYTES,
    ...(opts.priorityFee === true ? { priorityFeeLamports: 1n } : {}),
  });
  return message.bytes.length + 64 * message.header.numRequiredSignatures;
}

// ---------------------------------------------------------------- funding ---

/** The fee an attest transaction pays: one signature (5,000 lamports) plus its priority fee. */
export function attestFeeLamports(opts: AttestTxOptions = {}): bigint {
  return LAMPORTS_PER_SIGNATURE + (attestTxConfig(opts).priorityFeeLamports ?? 0n);
}

/** `fundingLamportsForAttest` options. */
export interface AttestFundingOptions extends AttestTxOptions {
  /** With `lmsPublicKey`: count only the rent of the accounts that do not exist yet (else both, an upper bound). */
  launch?: PublicKey | undefined;
  lmsPublicKey?: Uint8Array | undefined;
}

/** The rent of the identity and attestation accounts `attest_launch` would create (only those missing, given `launch` and `lmsPublicKey`). */
export async function attestRentLamports(conn: Connection, launch?: PublicKey, lmsPublicKey?: Uint8Array): Promise<{ identity: bigint; attestation: bigint }> {
  let needIdentity = true;
  let needAttestation = true;
  if (launch !== undefined || lmsPublicKey !== undefined) {
    if (launch === undefined || lmsPublicKey === undefined) throw new TypeError("pass both launch and lmsPublicKey, or neither");
    checkPublicKey("launch", launch);
    checkBytes("LMS public key", lmsPublicKey, LMS_PUBLIC_KEY_LEN);
    const [identityAcc, attestationAcc] = await getAccounts(conn, [identityAddress(lmsPublicKey), attestationAddress(launch)]);
    needIdentity = ownedBy(identityAcc ?? null, PROGRAM_IDS.launchpad, "Identity") === null;
    needAttestation = ownedBy(attestationAcc ?? null, PROGRAM_IDS.launchpad, "Attestation") === null;
  }
  const [identity, attestation] = await Promise.all([
    needIdentity ? rentExemptLamports(conn, PQ_IDENTITY.IDENTITY_ACCOUNT_LEN) : Promise.resolve(0n),
    needAttestation ? rentExemptLamports(conn, PQ_IDENTITY.ATTESTATION_ACCOUNT_LEN) : Promise.resolve(0n),
  ]);
  return { identity, attestation };
}

async function requiredLamports(conn: Connection, fee: bigint, launch: PublicKey | undefined, lmsPublicKey: Uint8Array | undefined): Promise<bigint> {
  const rent = await attestRentLamports(conn, launch, lmsPublicKey);
  return rent.identity + rent.attestation + fee;
}

/**
 * Lamports a throwaway payer needs to land one attestation: `rent(196)`
 * (identity, first landing of the identity) + `rent(2,708)` (attestation) +
 * the fee, the rent read from the cluster, never hard-coded. With
 * `launch` and `lmsPublicKey`, only accounts that do not exist yet are
 * counted. Funding exactly this leaves 0 (or a rent-exempt balance) behind,
 * which the runtime requires of a fee payer. The metadata record is
 * published first by the same key: fund both with `throwawayPayerFunding`.
 */
export async function fundingLamportsForAttest(conn: Connection, opts: AttestFundingOptions = {}): Promise<bigint> {
  return requiredLamports(conn, attestFeeLamports(opts), opts.launch, opts.lmsPublicKey);
}

/**
 * The legacy transfer the wallet signs to fund a throwaway attest payer:
 * `lamports` (default `fundingLamportsForAttest(conn, opts)`) from `from` to
 * `payer`. `from` is the fee payer of this transaction.
 */
export async function buildFundAttestPayerTx(
  conn: Connection,
  from: PublicKey,
  payer: PublicKey,
  opts: AttestFundingOptions & { lamports?: bigint | undefined } = {},
): Promise<{ tx: Transaction; lamports: bigint }> {
  checkPublicKey("from", from);
  checkPublicKey("payer", payer);
  if (from.equals(payer)) throw new Error("the throwaway payer must be a fresh key, not the funding wallet");
  const lamports = opts.lamports ?? (await fundingLamportsForAttest(conn, opts));
  if (!isU64(lamports) || lamports === 0n) throw new RangeError("lamports must be a positive u64");
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: from, toPubkey: payer, lamports }));
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.feePayer = from;
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  return { tx, lamports };
}

// ---------------------------------------------------------------- building ---

/** `buildAttestLaunchTx` arguments without the reviewed configuration (see `BuildAttestLaunchArgs`). */
export interface AttestLaunchBaseArgs extends AttestTxOptions {
  readonly launch: PublicKey;
  /** The wallet that created the launch: only a launch whose creator is this wallet is signed. */
  readonly creator: PublicKey;
  /** The identity the launch names (`deriveIdentity`); its `cluster` is checked against the endpoint. */
  readonly identity: PqIdentity;
  /** Durable leaf records (`createLeafLedger` on a persistent, atomic store). */
  readonly ledger: LeafLedger;
  /** `metadataHashV2` of the published record `launch` will use (`plan.metadataHash`). */
  readonly metadataHash: Uint8Array;
  /**
   * `rulesHash` of the published creator rules `launch` will install
   * (`buildPublishRulesV1Tx`'s `rulesHash`); omit (or all zero) for a launch
   * without rules. The record must exist and be final before signing.
   */
  readonly rulesHash?: Uint8Array | undefined;
  /** Commitment the rules record must have reached before it is signed (default `finalized`). */
  readonly rulesCommitment?: "finalized" | "confirmed" | undefined;
  readonly window: LaunchWindow;
  /** Throwaway fee payer (default: a fresh `Keypair.generate()`). Pass the same one to rebuild after an expired blockhash. */
  readonly payer?: Keypair | undefined;
  /** Accept an identity derived for localnet (see `assertCluster`). */
  readonly allowLocalnet?: boolean | undefined;
  /** Seconds allowed for the attestation to land after signing (default 300). */
  readonly landingMarginSecs?: bigint | undefined;
  /** Commitment the launch must have reached before it is signed (default `finalized`). */
  readonly launchCommitment?: "finalized" | "confirmed" | undefined;
  /** Commitment the metadata record must have reached before it is signed (default `finalized`: a record lost in a dropped fork turns the attestation into a burn). */
  readonly metadataCommitment?: "finalized" | "confirmed" | undefined;
  /** Stop signing new leaves for this launch after this many burn-only landings (default `MAX_BURN_ONLY_LANDINGS`, 2). */
  readonly maxBurnOnlyLandings?: number | undefined;
  /**
   * SHA-256 of the exact 221-byte message the user reviewed (`plan.messageHash`;
   * audit 4, ID-F6): compared with the message built from the chain BEFORE any
   * leaf is reserved or anything is signed. `buildPlannedAttestTx` passes it.
   */
  readonly expectedMessageHash?: Uint8Array | undefined;
  /**
   * The user confirmed signing although this ledger already holds
   * `MAX_UNLANDED_SIGNATURES` (3) signatures of this launch that never landed
   * with success (audit 4, ID-F2; `SignatureCapError` otherwise).
   */
  readonly acknowledgeExtraSignatures?: boolean | undefined;
  /**
   * The lock around "check what is pending, reserve a leaf, sign" for this
   * launch (audit 4, ID-F4; `signingLockName(launch)`): default an
   * in-process mutex; in a browser `(name, fn) => navigator.locks.request(name, fn)`.
   */
  readonly signingLock?: LedgerLock | undefined;
  /** This device's unix seconds (default its clock): the cluster clock must agree within `maxClockSkewSecs` (audit 4, ID-F1b). */
  readonly localNowSecs?: bigint | undefined;
  /** A second, independent RPC whose cluster clock must agree too. */
  readonly secondConnection?: Connection | undefined;
  /** Most seconds the clocks may differ (default 120). */
  readonly maxClockSkewSecs?: bigint | undefined;
}

/**
 * `buildAttestLaunchTx` arguments. `expectedParamsHash` is required:
 * `launchParamsHash(params)` of the configuration the creator reviewed, so
 * the identity refuses to sign any other one. The creator's wallet key is
 * classical: whoever forges it can watch `create_launch` (which reveals the
 * launch seed), create a launch at the same PDA first with its own
 * parameters (every fee to itself) and this identity copied in, and the
 * identity would then attest that configuration as genuine.
 * `buildPlannedAttestTx` passes the plan's hash. `unsafeAcceptAnyParams:
 * true` (instead of the hash) signs whatever configuration the launch holds:
 * tooling only, never for a launch someone else could have created.
 */
export type BuildAttestLaunchArgs = AttestLaunchBaseArgs &
  (
    | { readonly expectedParamsHash: Uint8Array; readonly unsafeAcceptAnyParams?: false | undefined }
    | { readonly expectedParamsHash?: undefined; readonly unsafeAcceptAnyParams: true }
  );

interface AttestCommon {
  readonly launch: PublicKey;
  /** The 221-byte message (v3). */
  readonly message: Uint8Array;
  /** SHA-256 of `message`: what the attestation account must hold. */
  readonly messageHash: Uint8Array;
  readonly lmsPublicKey: Uint8Array;
  readonly identityId: Uint8Array;
  /** The record's hash the message signs. */
  readonly metadataHash: Uint8Array;
  /** The record's account, `["metadata", launch, metadataHash]` (`attest_launch`'s fifth account). */
  readonly tokenMeta: PublicKey;
  /** The creator rules' hash the message signs (all zero: none). */
  readonly rulesHash: Uint8Array;
  /** The rules record, `["rules", launch, rulesHash]` (`attest_launch`'s last account), or null for no rules (the program id goes in its place). */
  readonly rules: PublicKey | null;
  readonly window: LaunchWindow;
  /** The window as absolute UTC dates (`unixToIso`): show these, not only "in N hours" (audit 4, ID-F5). */
  readonly windowIso: { readonly notBefore: string; readonly notAfter: string };
  /** Cautions for the UI (an identity running out of leaves, a replaced attestation, a classical payer). */
  readonly warnings: string[];
}

/** A signed attest transaction, ready to fund and send. */
export interface AttestLaunchReady extends AttestCommon {
  readonly status: "ready";
  /** Signed v1 wire bytes. */
  readonly tx: Uint8Array;
  /** Transaction id. */
  readonly signature: string;
  /** The throwaway fee payer: keep it until `buildSweepPayerTx` returned what is left. */
  readonly payer: Keypair;
  readonly blockhash: string;
  readonly lastValidBlockHeight: number;
  readonly leaf: number;
  /** The 2,508-byte LMS signature (recorded in the ledger before it was returned). */
  readonly lmsSignature: Uint8Array;
  readonly leafChoice: LeafChoice;
  /** True when the ledger already held this signature (a rebuild: same leaf, same signature bytes, nothing new signed). */
  readonly retry: boolean;
  readonly sizeBytes: number;
  readonly computeUnitLimit: number;
  readonly priorityFeeLamports: bigint | null;
  /** What `payer` needs now: the fee plus the rent of the accounts that do not exist yet. */
  readonly fundingLamports: bigint;
}

/** This exact message already attested the launch: nothing to sign or send. */
export interface AttestLaunchAlreadyAttested extends AttestCommon {
  readonly status: "already-attested";
  readonly attestation: AttestationAccount;
  readonly leaf: number;
}

/** This message's leaf is already set on-chain: do not re-send; `confirmAttestation` tells what landed. */
export interface AttestLaunchLeafLanded extends AttestCommon {
  readonly status: "leaf-landed";
  readonly leaf: number;
}

export type AttestLaunchTx = AttestLaunchReady | AttestLaunchAlreadyAttested | AttestLaunchLeafLanded;

/** One landing of a launch that only burned its leaf, from the ledger. */
export interface BurnOnlyLanding {
  readonly leaf: number;
  /** What the SDK can infer now (empty: unknown). */
  readonly reasons: BurnReason[];
  readonly detail: string;
}

/** `buildAttestLaunchTx` refused a new leaf: this launch already had `maxBurnOnlyLandings` landings that only burned their leaf. Nothing was signed. */
export class AttestRetryLimitError extends Error {
  readonly launch: PublicKey;
  readonly landings: BurnOnlyLanding[];
  /** Every reason of every landing, once each. */
  readonly reasons: BurnReason[];
  constructor(launch: PublicKey, landings: BurnOnlyLanding[]) {
    const reasons = [...new Set(landings.flatMap((l) => l.reasons))];
    super(
      `refusing to sign: ${landings.length} landing(s) for launch ${launch.toBase58()} only burned their leaf (${
        reasons.length === 0 ? "the cause could not be inferred" : reasons.map((r) => REASON_TEXT[r]).join("; ")
      }); each new signature spends one of the identity's 1,024 leaves: fix the cause, then raise maxBurnOnlyLandings deliberately`,
    );
    this.name = "AttestRetryLimitError";
    this.launch = launch;
    this.landings = landings;
    this.reasons = reasons;
  }
}

/**
 * Whether a ledger record of `launch` is a landing that only burned its leaf
 * (recorded as such, or signed with its bit set while the attestation does
 * not hold it). A signature landed on purpose to retire it
 * (`landOrBurnPending`) does not count.
 */
function isBurnOnlyLanding(r: LeafRecord, launch: PublicKey, used: Uint8Array): boolean {
  if (r.launch !== launch.toBase58()) return false;
  if (r.retired === true) return false;
  // Only attestation messages count: the same identity signs authorizations (pq_authorize) of this launch too.
  if (!isAttestationMessageOf(r, launch)) return false;
  if (r.status === "landed") return r.attested === false;
  return r.status === "signed" && leafUsed(used, r.leaf);
}

/** Whether a record holds a v3 attestation message of `launch` (not an authorization, not a retired v2 message). */
function isAttestationMessageOf(r: LeafRecord, launch: PublicKey): boolean {
  if (r.message === null) return false;
  try {
    return parseAttestationMessage(fromHex(r.message)).launch.equals(launch);
  } catch {
    return false;
  }
}

/**
 * Sign this launch with its post-quantum identity and return the signed v1
 * transaction (from a throwaway fee payer), after every refusal listed in the
 * module docs. Order: input checks (the identity's key pair is read once),
 * `assertCluster`, the launch (finalized, `Configured`, this creator, this
 * identity, the reviewed parameters), the clock (the cluster's against this
 * device's, `ClockSkewError` beyond 120 s) and the window against both, the
 * message against the reviewed `expectedMessageHash`, the attestation
 * (already ours: nothing to do; another message's: refused), the metadata
 * and rules records (published, finalized), then, holding the launch's
 * signing lock: earlier signatures that can still land
 * (`PendingAttestationError`), the caps (`SignatureCapError`,
 * `AttestRetryLimitError`), the leaf (the secret probe and the ledger;
 * `UnknownLeavesError` when the bitmap shows leaves the ledger never signed
 * at), the reservation and only then the signature. Fund `payer`
 * (`throwawayPayerFunding` covers the record's publication too) and send
 * with `sendAttestLaunchTx`.
 */
export async function buildAttestLaunchTx(conn: Connection, args: BuildAttestLaunchArgs): Promise<AttestLaunchTx> {
  const { launch, creator, ledger } = args;
  // Read once (audit 4, ID-F6): every later use sees the same key pair and cluster.
  const identity = args.identity;
  checkPublicKey("launch", launch);
  checkPublicKey("creator", creator);
  if (identity === null || typeof identity !== "object") throw new TypeError("identity must be a PqIdentity (deriveIdentity)");
  const keyPair = identity.keyPair;
  const cluster = identity.cluster;
  const identityIdGiven = identity.identityId;
  if (!(keyPair instanceof LmsKeyPair)) throw new TypeError("identity must be a PqIdentity (deriveIdentity)");
  if (keyPair.wiped) throw new Error("this identity's key pair was wiped: derive it again");
  const lmsPublicKey = keyPair.publicKey;
  const id = identityId(lmsPublicKey);
  if (!bytesEqual(id, identityIdGiven)) throw new Error("identity.identityId is not the id of its key pair");
  checkBytes("metadataHash", args.metadataHash, 32);
  const metadataHash = Uint8Array.from(args.metadataHash);
  const rulesHash = args.rulesHash === undefined ? new Uint8Array(32) : Uint8Array.from(args.rulesHash);
  checkBytes("rulesHash", rulesHash, 32);
  const hasRules = !isAllZero(rulesHash);
  const expectedMessageHash = args.expectedMessageHash === undefined ? null : Uint8Array.from(args.expectedMessageHash);
  if (expectedMessageHash !== null) checkBytes("expectedMessageHash", expectedMessageHash, 32);
  const maxBurnOnly = args.maxBurnOnlyLandings ?? MAX_BURN_ONLY_LANDINGS;
  if (!Number.isInteger(maxBurnOnly) || maxBurnOnly < 0) throw new RangeError("maxBurnOnlyLandings must be a non-negative integer");
  const recordCommitment = args.metadataCommitment ?? "finalized";
  if (recordCommitment !== "finalized" && recordCommitment !== "confirmed") throw new RangeError('metadataCommitment must be "finalized" or "confirmed"');
  const rulesCommitment = args.rulesCommitment ?? "finalized";
  if (rulesCommitment !== "finalized" && rulesCommitment !== "confirmed") throw new RangeError('rulesCommitment must be "finalized" or "confirmed"');
  const payer = args.payer ?? Keypair.generate();
  const config = attestTxConfig(args);
  const warnings: string[] = [];
  if (payer.publicKey.equals(creator)) warnings.push("the creator's wallet pays this attestation: a fresh throwaway payer keeps the wallet out of it");
  const { notBefore, notAfter } = args.window;
  if (typeof notBefore !== "bigint" || typeof notAfter !== "bigint") throw new TypeError("the window must be bigint unix seconds");
  // The reviewed configuration is required (pure check: before any RPC, reservation or signature).
  const expectedParamsHash: Uint8Array | null = args.expectedParamsHash ?? null;
  if (expectedParamsHash === null) {
    if (args.unsafeAcceptAnyParams !== true) {
      throw new TypeError(
        "refusing to sign: expectedParamsHash is required (launchParamsHash of the parameters the creator reviewed): a forged creator wallet can create a launch at this PDA with its own parameters and this identity copied in. buildPlannedAttestTx passes it; only tooling may pass unsafeAcceptAnyParams: true instead.",
      );
    }
    warnings.push("unsafeAcceptAnyParams: the identity signs whatever parameters the launch holds, without comparing them with a reviewed configuration");
  } else {
    if (args.unsafeAcceptAnyParams === true) throw new TypeError("pass expectedParamsHash or unsafeAcceptAnyParams: true, not both");
    checkBytes("expectedParamsHash", expectedParamsHash, 32);
  }

  // The endpoint serves the cluster this identity's leaves belong to.
  await assertCluster(conn, cluster, { allowLocalnet: args.allowLocalnet });

  // The launch: finalized, Configured, this creator, this identity, the reviewed configuration.
  const commitment = args.launchCommitment ?? "finalized";
  const launchAcc = ownedBy(await getAccount(conn, launch, commitment), PROGRAM_IDS.launchpad, "Launch");
  if (launchAcc === null) {
    if (commitment === "finalized" && ownedBy(await getAccount(conn, launch, "confirmed"), PROGRAM_IDS.launchpad, "Launch") !== null) {
      throw new Error("refusing to sign: the launch is not finalized yet (wait for create_launch to finalize, about 13 s): a signature over a launch that is rolled back can never land");
    }
    throw new Error(`refusing to sign: launch ${launch.toBase58()} does not exist (a signature over it could never land)`);
  }
  const l = decodeLaunch(launch, launchAcc.data);
  if (!launchAddress(l.creator, l.launchSeed).equals(launch)) throw new Error("refusing to sign: the launch account is not at the PDA of its own creator and seed");
  if (l.status !== "configured") throw new Error("refusing to sign: the launch is already live (an attestation now would only burn a leaf)");
  if (!l.creator.equals(creator)) throw new Error(`refusing to sign: the launch was created by ${l.creator.toBase58()}, not by this wallet (${creator.toBase58()})`);
  if (!bytesEqual(l.pqIdentity, id)) throw new Error("refusing to sign: the launch names another post-quantum identity (this signature would only burn a leaf)");
  if (expectedParamsHash !== null && !bytesEqual(l.paramsHash, expectedParamsHash)) {
    throw new Error("refusing to sign: the launch's parameters are not the ones reviewed (params_hash differs); never sign a configuration you did not check");
  }

  // The clock (audit 4, ID-F1b / ID-F5): the cluster's must agree with this device's; the window must suit both.
  const clock = await checkClockSkew(conn, args);
  const now = clock.clusterSecs;
  const margin = args.landingMarginSecs ?? ATTEST_LANDING_MARGIN_SECS;
  const w = validateLaunchWindow(notBefore, notAfter, { nowSecs: now, landingMarginSecs: margin });
  if (!w.ok) throw new Error(`refusing to sign: attest_launch would only burn a leaf with this window (cluster time ${unixToUtcText(now)}):\n${w.errors.join("\n")}`);
  const local = validateLaunchWindow(notBefore, notAfter, { nowSecs: clock.localSecs, landingMarginSecs: margin });
  if (!local.ok) throw new Error(`refusing to sign: by this device's clock (${unixToUtcText(clock.localSecs)}) this window could not be used:\n${local.errors.join("\n")}`);

  const message = attestationMessage({ launch, paramsHash: l.paramsHash, creator: l.creator, metadataHash, rulesHash, notBefore, notAfter });
  const messageHash = sha256(message);
  // The message the user reviewed, before anything is reserved or signed (audit 4, ID-F6).
  if (expectedMessageHash !== null && !bytesEqual(messageHash, expectedMessageHash)) {
    throw new Error(
      "refusing to sign: the message built from the chain and these inputs differs from the one reviewed (expectedMessageHash): its launch, parameters, records or window changed. Nothing was signed; review the plan again",
    );
  }
  const common: AttestCommon = {
    launch,
    message,
    messageHash,
    lmsPublicKey,
    identityId: id,
    metadataHash,
    tokenMeta: tokenMetaAddress(launch, metadataHash),
    rulesHash,
    rules: rulesAccountFor(launch, rulesHash),
    window: { notBefore, notAfter },
    windowIso: { notBefore: unixToIso(notBefore), notAfter: unixToIso(notAfter) },
    warnings,
  };

  // Ours is done; another message's can be replaced only once its window passed unused (the launch is Configured).
  const attestation = await fetchAttestation(conn, launch);
  if (attestation !== null && attestation.attested) {
    if (bytesEqual(attestation.messageHash, messageHash)) return { ...common, status: "already-attested", attestation, leaf: attestation.leaf };
    if (!attestationReplaceable(attestation, now)) {
      throw new Error(
        "refusing to sign: this launch is already attested by another message (another device, an earlier attempt or another window or metadata record) whose window has not passed; until it has, a new signature would only burn a leaf. Launch it inside the attested window.",
      );
    }
    warnings.push(
      `the launch's attested window (${unixToUtcText(attestation.notBefore)} to ${unixToUtcText(attestation.notAfter)}) passed without a launch: this signature replaces that attestation with the new opening time`,
    );
  }

  // The record the message names must exist (finalized by default): attest_launch attests only a published record.
  if ((await fetchTokenMeta(conn, launch, metadataHash, { commitment: recordCommitment })) === null) {
    if (recordCommitment === "finalized" && (await fetchTokenMeta(conn, launch, metadataHash, { commitment: "confirmed" })) !== null) {
      throw new Error(
        "refusing to sign: the metadata record is not finalized yet (wait about 13 s after publish_metadata): a record lost in a dropped fork would turn this attestation into a burn",
      );
    }
    throw new Error(
      `refusing to sign: no metadata record is published at ${common.tokenMeta.toBase58()} (publish it with buildPublishMetadataTx and wait until it is final): attest_launch attests only a record that exists, so this signature would only burn its leaf`,
    );
  }

  // The rules record the message names must exist and be a valid record (finalized by default): attest_launch
  // attests only rules that exist; a missing, pre-funded or invalid record makes the landing burn-only.
  if (hasRules && !(await launchRulesRecordExists(conn, launch, rulesHash, rulesCommitment))) {
    if (rulesCommitment === "finalized" && (await launchRulesRecordExists(conn, launch, rulesHash, "confirmed"))) {
      throw new Error("refusing to sign: the rules record is not finalized yet (wait about 13 s after publish_rules): a record lost in a dropped fork would turn this attestation into a burn");
    }
    throw new Error(
      `refusing to sign: no valid rules record is published at ${common.rules!.toBase58()} (publish the rules with buildPublishRulesV1Tx and wait until they are final): attest_launch attests only rules that exist, so this signature would only burn its leaf`,
    );
  }

  // A signature that can never land must never exist.
  const size = attestTransactionSize({ priorityFee: config.priorityFeeLamports !== null, rules: hasRules });
  if (size > V1_MAX_TRANSACTION_SIZE) throw new Error(`refusing to sign: the attest transaction would be ${size} bytes (limit ${V1_MAX_TRANSACTION_SIZE})`);

  // Everything that needs the network, before the signature exists.
  const fundingLamports = await requiredLamports(conn, attestFeeLamports(args), launch, lmsPublicKey);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");

  // Audit 4, ID-F4: "what is pending, reserve, sign" under the launch's signing lock, so two calls never both pass.
  return withSigningLock(launch, args.signingLock, async (): Promise<AttestLaunchTx> => {
    const onChain = await fetchIdentity(conn, lmsPublicKey);
    const used = onChain === null ? new Uint8Array(PQ_IDENTITY.LEAF_BITMAP_LEN) : onChain.used;
    // A record whose message the attestation holds landed with a known outcome (the account names its hash and leaf).
    await reconcileAttested(ledger, id, attestation);
    const mine = await ledger.findByMessage(id, messageHash);
    const rebuild = mine !== null && holdsMessageLeaf(mine) && mine.signature !== null;
    if (!rebuild) {
      // Review info #2: no NEW signature while an earlier one of this launch can still land and take the slot.
      const pending = (await pendingOf(conn, { launch, lmsPublicKey, ledger, nowSecs: now, localNowSecs: clock.localSecs, used, launchAccount: l, attestation })).filter(
        (p) => !bytesEqual(p.messageHash, messageHash),
      );
      if (pending.length > 0) throw new PendingAttestationError(launch, pending);
      // ID-F2: at most MAX_UNLANDED_SIGNATURES signatures of this launch that never landed with success.
      const unlanded = (await launchSignatures(ledger, id, launch)).filter((s) => !bytesEqual(s.messageHash, messageHash) && countsAsUnlanded(s.record));
      if (unlanded.length >= MAX_UNLANDED_SIGNATURES && args.acknowledgeExtraSignatures !== true) {
        throw new SignatureCapError(launch, "attestation", unlanded.map((s) => s.leaf), MAX_UNLANDED_SIGNATURES);
      }
    }
    // Each burn-only landing spent a leaf: past the cap, no new leaf for this launch (a rebuild of a recorded signature spends none).
    const burnOnly = (await ledger.list(id)).filter((r) => isBurnOnlyLanding(r, launch, used));
    if (burnOnly.length >= maxBurnOnly && !(mine !== null && holdsMessageLeaf(mine))) {
      const landings: BurnOnlyLanding[] = [];
      for (const r of burnOnly) {
        const reasons = await recordBurnReasons(conn, r, l.pqIdentity, id, attestation);
        landings.push({ leaf: r.leaf, reasons, detail: burnDetail(r.leaf, reasons) });
      }
      throw new AttestRetryLimitError(launch, landings);
    }
    // The leaf: the secret probe and the ledger only (UnknownLeavesError before anything is reserved), then the signature.
    // A message whose leaf is set on-chain gets its recorded bytes back (no new signature) and is not re-sent.
    const { leaf, signature: lmsSignature, selection } = await signAtNextLeaf(ledger, keyPair, message, used, { launch });
    if (selection.kind === "existing" && selection.onChain) return { ...common, status: "leaf-landed", leaf };
    if (lmsVerify(lmsPublicKey, message, lmsSignature) !== leaf) throw new Error("the LMS signature does not verify at its leaf (corrupted record?)");
    if (selection.choice.warn) warnings.push(`this identity has used ${selection.choice.usedCount} of 1,024 leaves on-chain: move to the next identity index soon`);

    const ix = attestLaunchInstruction({ payer: payer.publicKey, launch, lmsPublicKey, lmsSignature, metadataHash, rulesHash, notBefore, notAfter });
    const signed = signAttestTransaction(payer, ix, blockhash, args);
    return {
      ...common,
      status: "ready",
      tx: signed.tx,
      signature: signed.signature,
      payer,
      blockhash,
      lastValidBlockHeight,
      leaf,
      lmsSignature,
      leafChoice: selection.choice,
      retry: selection.kind === "existing" && selection.record.signature !== null,
      sizeBytes: signed.sizeBytes,
      computeUnitLimit: signed.computeUnitLimit,
      priorityFeeLamports: signed.priorityFeeLamports,
      fundingLamports,
    };
  });
}

/** Mark landed (attested) the ledger's record of the message the launch's attestation holds: the account names its hash and leaf. */
async function reconcileAttested(ledger: LeafLedger, id: Uint8Array, attestation: AttestationAccount | null): Promise<void> {
  if (attestation === null || !attestation.attested || !bytesEqual(attestation.pqIdentity, id)) return;
  const rec = await ledger.get(id, attestation.leaf);
  if (rec === null || rec.signature === null || rec.messageHash !== toHex(attestation.messageHash) || rec.status === "burned") return;
  if (rec.status === "landed" && rec.attested === true) return;
  await ledger.markLanded(id, attestation.leaf, { slot: attestation.slot, attested: true });
}

// ------------------------------------------------- pending signatures ---

/** A signature of a launch the ledger holds that was never seen landing and can still land (`findPendingAttestations`). */
export interface PendingAttestation {
  readonly leaf: number;
  /** SHA-256 of the signed message. */
  readonly messageHash: Uint8Array;
  /** The 221 signed bytes. */
  readonly message: Uint8Array;
  /** The 2,508-byte LMS signature (recorded in the ledger). */
  readonly lmsSignature: Uint8Array;
  /** The window it signed (unix seconds); it has not ended. */
  readonly window: LaunchWindow;
  /** The window as absolute UTC dates (`unixToIso`). */
  readonly windowIso: { readonly notBefore: string; readonly notAfter: string };
  /** The metadata record's hash it names. */
  readonly metadataHash: Uint8Array;
  /** The creator rules' hash it names (all zero: none). */
  readonly rulesHash: Uint8Array;
  /**
   * What landing it now would do: `attests` (the slot is free, its window
   * can attest now and its record exists: it would set the launch's opening
   * time to its window) or `burns` (it would only burn its leaf).
   */
  readonly landingNow: "attests" | "burns";
  /**
   * Its leaf shows as used on-chain, but the ledger has not seen what it did
   * (audit 4, ID-F4: a bit alone never clears a pending signature; an RPC can
   * fake it): `landOrBurnPending` confirms it from the accounts.
   */
  readonly leafSetOnChain: boolean;
  /** Plain English: what it signed and what landing it now would do. */
  readonly detail: string;
}

/** `findPendingAttestations` arguments. */
export interface FindPendingAttestationsArgs {
  readonly launch: PublicKey;
  /** The identity's 56-byte LMS public key. */
  readonly lmsPublicKey: Uint8Array;
  readonly ledger: LeafLedger;
  /** Bigint unix seconds (default: the cluster clock). */
  readonly nowSecs?: bigint | undefined;
  /**
   * This device's unix seconds (default its clock): a window counts as ended
   * only once both clocks are past it (a dishonest RPC's clock cannot end a
   * pending signature early).
   */
  readonly localNowSecs?: bigint | undefined;
}

/** `pendingOf` with what the caller already read. */
interface PendingInputs extends FindPendingAttestationsArgs {
  readonly nowSecs: bigint;
  readonly used: Uint8Array;
  readonly launchAccount: LaunchAccount | null;
  readonly attestation: AttestationAccount | null;
}

async function pendingOf(conn: Connection, i: PendingInputs): Promise<PendingAttestation[]> {
  const id = identityId(i.lmsPublicKey);
  const out: PendingAttestation[] = [];
  const l = i.launchAccount;
  const a = i.attestation;
  // The program's slot rule (F1): empty, or another message's whose window passed while the launch is Configured.
  const slotFree = l !== null && l.status === "configured" && (a === null || !a.attested || i.nowSecs > a.notAfter);
  // A window has ended only once both clocks are past it (the RPC's alone could end it early).
  const local = i.localNowSecs ?? localUnixSecs();
  const ended = (notAfter: bigint): boolean => i.nowSecs > notAfter && local > notAfter;
  for (const sig of await launchSignatures(i.ledger, id, i.launch)) {
    // Audit 4, ID-F4: only a landing seen with its outcome ends a pending signature (landed, attested or not, or
    // retired); a set bit alone does not (an RPC can fake it): such a signature stays pending until confirmed.
    if (sig.record.status === "landed" || sig.record.retired === true) continue;
    // A window that has ended can never attest again: what is left of it can only burn its leaf.
    if (ended(sig.window.notAfter)) continue;
    const { notBefore, notAfter } = sig.window;
    const leafSetOnChain = leafUsed(i.used, sig.leaf);
    let attests = false;
    if (!leafSetOnChain && slotFree && l !== null && bytesEqual(l.pqIdentity, id) && windowValidAt(i.nowSecs, notBefore, notAfter)) {
      attests =
        (await fetchTokenMeta(conn, i.launch, sig.metadataHash)) !== null && (isAllZero(sig.rulesHash) || (await launchRulesRecordExists(conn, i.launch, sig.rulesHash)));
    }
    const when = `${unixToUtcText(notBefore)} to ${unixToUtcText(notAfter)}`;
    out.push({
      leaf: sig.leaf,
      messageHash: sig.messageHash,
      message: sig.message,
      lmsSignature: sig.signature,
      window: { notBefore, notAfter },
      windowIso: { notBefore: unixToIso(notBefore), notAfter: unixToIso(notAfter) },
      metadataHash: sig.metadataHash,
      rulesHash: sig.rulesHash,
      landingNow: attests ? "attests" : "burns",
      leafSetOnChain,
      detail: leafSetOnChain
        ? `leaf ${sig.leaf} signed the window ${when}; the chain shows its leaf used, but what it did was never confirmed: confirm it (landOrBurnPending) before signing a new window`
        : `leaf ${sig.leaf} signed the window ${when} and was never seen landing; ${
            attests ? "landing it now would attest that window (the launch would open then)" : "landing it now would only burn its leaf"
          }`,
    });
  }
  return out;
}

/**
 * The signatures of `launch` the ledger holds that were never seen landing
 * (their leaf is clear on-chain) and whose window has not ended: each could
 * still land (review info #2), and `landingNow` says what that would do now.
 * Reads the launch, its attestation, the identity's bitmap and the records
 * the signatures name. Empty when nothing is pending.
 */
export async function findPendingAttestations(conn: Connection, args: FindPendingAttestationsArgs): Promise<PendingAttestation[]> {
  checkPublicKey("launch", args.launch);
  checkBytes("LMS public key", args.lmsPublicKey, LMS_PUBLIC_KEY_LEN);
  const nowSecs = args.nowSecs ?? (await clusterUnixTime(conn));
  const [launchAccount, attestation, identity] = await Promise.all([fetchLaunch(conn, args.launch), fetchAttestation(conn, args.launch), fetchIdentity(conn, args.lmsPublicKey)]);
  const used = identity === null ? new Uint8Array(PQ_IDENTITY.LEAF_BITMAP_LEN) : identity.used;
  // The record of the message the attestation holds landed with a known outcome (the account names its hash and leaf).
  await reconcileAttested(args.ledger, identityId(args.lmsPublicKey), attestation);
  return pendingOf(conn, { ...args, nowSecs, used, launchAccount, attestation });
}

/** `buildAttestLaunchTx` refused a new message: earlier signatures of this launch can still land (review info #2). Nothing was signed. */
export class PendingAttestationError extends Error {
  readonly launch: PublicKey;
  readonly pending: PendingAttestation[];
  constructor(launch: PublicKey, pending: PendingAttestation[]) {
    super(
      `refusing to sign a new message: ${pending.length} earlier signature(s) for launch ${launch.toBase58()} were made but never seen landing, and their window has not ended (${pending
        .map((p) => `leaf ${p.leaf}: ${unixToUtcText(p.window.notBefore)} to ${unixToUtcText(p.window.notAfter)}${p.leafSetOnChain ? ", its leaf shows as used: confirm it" : ""}`)
        .join("; ")}). Anyone holding one can still land it and take the attestation slot with its own window. Land them first (landOrBurnPending), or wait until their windows end.`,
    );
    this.name = "PendingAttestationError";
    this.launch = launch;
    this.pending = pending;
  }
}

/** `landOrBurnPending` and `fundingLamportsForPending` arguments. */
export interface LandOrBurnPendingArgs extends AttestTxOptions {
  readonly launch: PublicKey;
  /** The identity whose ledger holds the signatures: only its public key and cluster are used (nothing is signed). */
  readonly identity: { readonly publicKey: Uint8Array; readonly cluster: Cluster };
  readonly ledger: LeafLedger;
  /** A funded throwaway fee payer (`fundingLamportsForPending`); keep it until `buildSweepPayerTx`. */
  readonly payer: Keypair;
  /**
   * Land only the signatures that would only burn their leaf now (the
   * launch's attestation holds the slot, or their window cannot attest now);
   * leave any that would attest. Default false: land every pending
   * signature; the first one that can attest sets the launch's window.
   */
  readonly burnOnly?: boolean | undefined;
  readonly allowLocalnet?: boolean | undefined;
}

/** What `landOrBurnPending` did with one pending signature. */
export interface PendingLanding {
  readonly leaf: number;
  readonly window: LaunchWindow;
  readonly messageHash: Uint8Array;
  /** `attested`, `burned` (retired: its leaf is spent), `pending` (sent, not seen landing), or `skipped` (`burnOnly`: it would have attested). */
  readonly outcome: AttestationOutcome | { readonly status: "skipped"; readonly detail: string };
  /** The transaction id, when one was sent. */
  readonly signature: string | null;
}

/** `landOrBurnPending`'s result. */
export interface LandOrBurnPendingResult {
  readonly landings: PendingLanding[];
  /** What is still pending afterwards (empty: no earlier signature stands in the way of a new window). */
  readonly remaining: PendingAttestation[];
}

/** The order to land pending signatures in: those that only burn first (oldest first), then those that attest, newest first (the creator's latest choice). */
function landingOrder(pending: readonly PendingAttestation[], created: ReadonlyMap<number, number>): PendingAttestation[] {
  const t = (p: PendingAttestation): number => created.get(p.leaf) ?? 0;
  const burns = pending.filter((p) => p.landingNow === "burns").sort((a, b) => t(a) - t(b));
  const attests = pending.filter((p) => p.landingNow === "attests").sort((a, b) => t(b) - t(a));
  return [...burns, ...attests];
}

/**
 * Lamports a throwaway payer needs to land `count` pending signatures (default:
 * all of them): the fees, the rent of the accounts a landing creates if they
 * do not exist yet, and, for more than one landing, the rent-exempt minimum
 * the payer must keep between them (return it with `buildSweepPayerTx`).
 */
export async function fundingLamportsForPending(conn: Connection, args: Omit<LandOrBurnPendingArgs, "payer" | "burnOnly" | "allowLocalnet"> & { readonly count?: number | undefined }): Promise<bigint> {
  const count = args.count ?? (await findPendingAttestations(conn, { launch: args.launch, lmsPublicKey: args.identity.publicKey, ledger: args.ledger })).length;
  if (!Number.isInteger(count) || count < 0) throw new RangeError("count must be a non-negative integer");
  if (count === 0) return 0n;
  const rent = await attestRentLamports(conn, args.launch, args.identity.publicKey);
  const floor = count > 1 ? await rentExemptLamports(conn, 0) : 0n;
  return rent.identity + rent.attestation + BigInt(count) * attestFeeLamports(args) + floor;
}

/**
 * Land this launch's pending signatures (`findPendingAttestations`) from the
 * ledger, each re-sent with its recorded bytes by `payer` (never a new
 * signature): each attests or only burns its leaf, and the ledger records
 * it (a burn is marked `retired`, so it does not count against
 * `maxBurnOnlyLandings`). Run it with `burnOnly: true` while the launch's
 * attestation holds the slot (its window has not ended): every older
 * signature then only burns its leaf, the review's recommended moment.
 * After the window passed, `burnOnly: false` lands them so that a new window
 * can be signed (the first that can attest sets the launch's opening time).
 * Checks the cluster first. A pending signature whose leaf already shows as
 * used is not sent again: what it did is read from the accounts and recorded
 * (`confirmAttestation`; audit 4, ID-F4). Stops at the first send that fails
 * (call again: what landed is no longer pending).
 */
export async function landOrBurnPending(conn: Connection, args: LandOrBurnPendingArgs): Promise<LandOrBurnPendingResult> {
  checkPublicKey("launch", args.launch);
  if (args.identity === null || typeof args.identity !== "object") throw new TypeError("identity must be the PqIdentity (or { publicKey, cluster })");
  checkBytes("LMS public key", args.identity.publicKey, LMS_PUBLIC_KEY_LEN);
  if (!(args.payer instanceof Keypair)) throw new TypeError("payer must be a funded Keypair");
  await assertCluster(conn, args.identity.cluster, { allowLocalnet: args.allowLocalnet });
  const lmsPublicKey = Uint8Array.from(args.identity.publicKey);
  const id = identityId(lmsPublicKey);
  const find = (): Promise<PendingAttestation[]> => findPendingAttestations(conn, { launch: args.launch, lmsPublicKey, ledger: args.ledger });
  const created = new Map((await args.ledger.list(id)).map((r) => [r.leaf, r.createdAt]));
  const landings: PendingLanding[] = [];
  for (const p of landingOrder(await find(), created)) {
    if (args.burnOnly === true && p.landingNow === "attests") {
      landings.push({ leaf: p.leaf, window: p.window, messageHash: p.messageHash, outcome: { status: "skipped", detail: `${p.detail}: left for later (burnOnly)` }, signature: null });
      continue;
    }
    const identity = await fetchIdentity(conn, lmsPublicKey);
    const used = identity === null ? new Uint8Array(PQ_IDENTITY.LEAF_BITMAP_LEN) : identity.used;
    if (leafUsed(used, p.leaf)) {
      // Landed already (another relayer, or never confirmed): read what it did from the accounts and record it (audit 4,
      // ID-F4); a burn is retired, as one landed here would be.
      const outcome = await confirmAttestation(conn, args.launch, p.messageHash, { leaf: p.leaf, lmsPublicKey, message: p.message, ledger: args.ledger });
      if (outcome.status === "burned") {
        const rec = await args.ledger.get(id, p.leaf);
        if (rec !== null && rec.status === "landed") await args.ledger.markLanded(id, p.leaf, { attested: false, retired: true });
      }
      landings.push({ leaf: p.leaf, window: p.window, messageHash: p.messageHash, outcome, signature: null });
      continue;
    }
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const ix = attestLaunchInstruction({
      payer: args.payer.publicKey,
      launch: args.launch,
      lmsPublicKey,
      lmsSignature: p.lmsSignature,
      metadataHash: p.metadataHash,
      rulesHash: p.rulesHash,
      notBefore: p.window.notBefore,
      notAfter: p.window.notAfter,
    });
    const signed = signAttestTransaction(args.payer, ix, blockhash, args);
    const built: AttestLaunchReady = {
      status: "ready",
      launch: args.launch,
      message: p.message,
      messageHash: p.messageHash,
      lmsPublicKey,
      identityId: id,
      metadataHash: p.metadataHash,
      tokenMeta: tokenMetaAddress(args.launch, p.metadataHash),
      rulesHash: p.rulesHash,
      rules: rulesAccountFor(args.launch, p.rulesHash),
      window: p.window,
      windowIso: p.windowIso,
      warnings: [],
      tx: signed.tx,
      signature: signed.signature,
      payer: args.payer,
      blockhash,
      lastValidBlockHeight,
      leaf: p.leaf,
      lmsSignature: p.lmsSignature,
      leafChoice: { leaf: p.leaf, probeStart: p.leaf, usedCount: usedLeafCount(used), warn: false, exhausted: false, unknownUsed: [], leafSetOnChain: false },
      retry: true,
      sizeBytes: signed.sizeBytes,
      computeUnitLimit: signed.computeUnitLimit,
      priorityFeeLamports: signed.priorityFeeLamports,
      fundingLamports: await requiredLamports(conn, attestFeeLamports(args), args.launch, lmsPublicKey),
    };
    const outcome = await sendAttestLaunchTx(conn, built, { ledger: args.ledger });
    if (outcome.status === "burned") {
      const rec = await args.ledger.get(id, p.leaf);
      if (rec !== null && rec.status === "landed") await args.ledger.markLanded(id, p.leaf, { attested: false, retired: true });
    }
    landings.push({ leaf: p.leaf, window: p.window, messageHash: p.messageHash, outcome, signature: signed.signature });
  }
  return { landings, remaining: await find() };
}

/**
 * The same signature in a new transaction: a fresh blockhash, the accounts
 * derived again from what the signature names (identity, attestation and
 * metadata record), signed by the same throwaway payer. For a send the
 * program refused with ConstraintSeeds (2006: an account it does not name;
 * nothing was written and the leaf was not burned) or one whose blockhash
 * expired: the LMS signature is never made again. Checks that the signature
 * still verifies at its leaf over the message. The compute limit and the
 * priority fee stay the built transaction's unless `opts` names new ones
 * (the payer was funded for that fee).
 */
export async function rewrapAttestTx(conn: Connection, built: AttestLaunchReady, opts: AttestTxOptions = {}): Promise<AttestLaunchReady> {
  if (built === null || typeof built !== "object" || built.status !== "ready") throw new TypeError("only a built attest transaction (status ready) can be sent again");
  const f = parseAttestationMessage(built.message);
  if (!f.launch.equals(built.launch) || !bytesEqual(f.metadataHash, built.metadataHash)) throw new Error("the built transaction's message is for another launch or record");
  if (lmsVerify(built.lmsPublicKey, built.message, built.lmsSignature) !== built.leaf) throw new Error("the recorded signature does not verify at its leaf over this message");
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  // The rules hash is read from the signed bytes: the accounts follow from what was signed, never from bookkeeping.
  const ix = attestLaunchInstruction({
    payer: built.payer.publicKey,
    launch: built.launch,
    lmsPublicKey: built.lmsPublicKey,
    lmsSignature: built.lmsSignature,
    metadataHash: built.metadataHash,
    rulesHash: f.rulesHash,
    notBefore: f.notBefore,
    notAfter: f.notAfter,
  });
  const config = attestTxConfig({ ...opts, computeUnitLimit: opts.computeUnitLimit ?? built.computeUnitLimit });
  const signed = signAttestConfigured(built.payer, ix, blockhash, opts.computeUnitPrice === undefined ? { ...config, priorityFeeLamports: built.priorityFeeLamports } : config);
  return {
    ...built,
    tokenMeta: tokenMetaAddress(built.launch, built.metadataHash),
    rulesHash: f.rulesHash,
    rules: rulesAccountFor(built.launch, f.rulesHash),
    tx: signed.tx,
    signature: signed.signature,
    blockhash,
    lastValidBlockHeight,
    retry: true,
    sizeBytes: signed.sizeBytes,
    computeUnitLimit: signed.computeUnitLimit,
    priorityFeeLamports: signed.priorityFeeLamports,
  };
}

// ----------------------------------------------------------- confirmation ---

/** Why a valid signature landed without attesting (what the SDK can tell from the accounts). */
export type BurnReason =
  /** The signing key is not the launch's `pq_identity` (e.g. another identity index of the same phrase). */
  | "wrong-identity"
  /** The metadata record the signature names did not exist when it landed (not published, or lost with a dropped fork). */
  | "record-missing"
  /** The signature names creator rules whose record did not exist (or was not a valid record: an address someone pre-funded) when it landed. */
  | "rules-missing"
  /** 60..=3,600 s long, at least 60 s of it left when it landed, opening at most 7 days later: not met. */
  | "invalid-window"
  /** The launch was already attested by another message whose window had not passed when this one landed. */
  | "already-attested";

/** What `burnReasons` looks at. */
export interface BurnReasonInput {
  /** The launch's `pq_identity` (null when unknown). */
  readonly launchPqIdentity: Uint8Array | null;
  /** The signing identity's id. */
  readonly identityId: Uint8Array;
  /** Whether the metadata record the message names exists (null or omitted: unknown). Records are never closed, so `false` read now means it was missing at the landing too. */
  readonly recordExists?: boolean | null | undefined;
  /** Whether the rules record the message names exists and is valid (null or omitted: unknown or no rules). Records are never closed, so `false` read now means it was missing at the landing too. */
  readonly rulesRecordExists?: boolean | null | undefined;
  readonly window?: LaunchWindow | undefined;
  /** Unix seconds of the landing; unknown: only the window's length is judged. */
  readonly landedAt?: bigint | null | undefined;
  /** The attestation account after the landing (another message's counts only while its window had not passed when this one landed, or with `landedAt` unknown). */
  readonly attestation: Pick<AttestationAccount, "attested" | "messageHash" | "notAfter"> | null;
  /** SHA-256 of the message that landed. */
  readonly messageHash: Uint8Array;
}

/**
 * Every reason the program would have had to burn this landing's leaf
 * without attesting (`attest_launch`: the attestation slot must be free
 * (empty, or another message's whose window passed), the key the launch's
 * identity, the metadata record must exist and the window must have at
 * least 60 s left), from what is known. Empty when none can be inferred.
 */
export function burnReasons(i: BurnReasonInput): BurnReason[] {
  const out: BurnReason[] = [];
  if (i.launchPqIdentity !== null && !bytesEqual(i.launchPqIdentity, i.identityId)) out.push("wrong-identity");
  if (i.recordExists === false) out.push("record-missing");
  if (i.rulesRecordExists === false) out.push("rules-missing");
  if (i.window !== undefined) {
    const { notBefore, notAfter } = i.window;
    const lengthOk = notAfter - notBefore >= MIN_LAUNCH_WINDOW_SECS && notAfter - notBefore <= MAX_LAUNCH_WINDOW_SECS;
    const ok = i.landedAt === undefined || i.landedAt === null ? lengthOk : windowValidAt(i.landedAt, notBefore, notAfter);
    if (!ok) out.push("invalid-window");
  }
  if (i.attestation !== null && i.attestation.attested && !bytesEqual(i.attestation.messageHash, i.messageHash)) {
    // Replaceable once its window passed (F1): then it did not block a landing after notAfter.
    if (i.landedAt === undefined || i.landedAt === null || i.landedAt <= i.attestation.notAfter) out.push("already-attested");
  }
  return out;
}

const REASON_TEXT: Readonly<Record<BurnReason, string>> = {
  "wrong-identity": "the signing key is not the identity this launch names",
  "record-missing": "the metadata record it names was not published (or not final) when it landed",
  "rules-missing": "the launch rules it names were not published (or not final, or the address held something else) when it landed",
  "invalid-window": "the window could not be used (60 s to 1 hour long, at least 60 s of it left when it landed, opening at most 7 days later, in seconds)",
  "already-attested": "the launch was already attested by another message whose window had not passed",
};

function burnDetail(leaf: number, reasons: readonly BurnReason[]): string {
  return reasons.length === 0
    ? `leaf ${leaf} is used on-chain, but the launch is not attested by this message (the cause could not be inferred)`
    : `leaf ${leaf} was burned without attesting: ${reasons.map((r) => REASON_TEXT[r]).join("; ")}`;
}

/** The reasons a recorded burn-only landing can be given now (its message's window and record, the launch's identity, the attestation). */
async function recordBurnReasons(conn: Connection, r: LeafRecord, launchPqIdentity: Uint8Array, id: Uint8Array, attestation: AttestationAccount | null): Promise<BurnReason[]> {
  if (r.message === null) return [];
  let f: ReturnType<typeof parseAttestationMessage>;
  try {
    f = parseAttestationMessage(fromHex(r.message));
  } catch {
    return []; // not an attestation message
  }
  const recordExists = (await fetchTokenMeta(conn, f.launch, f.metadataHash)) !== null;
  const rulesRecordExists = isAllZero(f.rulesHash) ? null : await launchRulesRecordExists(conn, f.launch, f.rulesHash);
  return burnReasons({
    launchPqIdentity,
    identityId: id,
    recordExists,
    rulesRecordExists,
    window: { notBefore: f.notBefore, notAfter: f.notAfter },
    attestation,
    messageHash: fromHex(r.messageHash),
  });
}

/** `confirmAttestation` options: what was sent (to tell a burn from a landing still pending, and why). */
export interface ConfirmAttestationOptions {
  /** The leaf the signature used. */
  readonly leaf?: number | undefined;
  /** The 56-byte key that signed. */
  readonly lmsPublicKey?: Uint8Array | undefined;
  /** The 221-byte message (its window and records explain a burn); must hash to the expected hash. */
  readonly message?: Uint8Array | undefined;
  /** Updated with what landed: `markLanded` (attested or not) or `markBurned`. */
  readonly ledger?: LeafLedger | undefined;
  /** Unix seconds of the landing, if known (judges the window's timing; unknown: its length only). */
  readonly landedAt?: bigint | undefined;
}

/** What became of an attestation. */
export type AttestationOutcome =
  | {
      /** The attestation holds this message (version 3): the launch can go live inside its window. */
      readonly status: "attested";
      readonly attestation: AttestationAccount;
      readonly leaf: number;
      readonly slot: bigint;
      /** Whether the ledger recorded the landing. */
      readonly ledgerUpdated: boolean;
    }
  | {
      /** The leaf is used on-chain but the attestation does not hold this message: the landing only burned the leaf. */
      readonly status: "burned";
      readonly leaf: number;
      readonly reasons: BurnReason[];
      /** Plain-English explanation. */
      readonly detail: string;
      readonly attestation: AttestationAccount | null;
      readonly ledgerUpdated: boolean;
    }
  | {
      /** Not landed (yet): re-send the same bytes (rebuild with the same inputs), never a new signature. */
      readonly status: "pending";
      readonly attestation: AttestationAccount | null;
      readonly detail: string;
    };

/**
 * Whether `launch` is attested by the message with SHA-256
 * `expectedMessageHash`: its attestation must have version 3 and hold that
 * hash. Otherwise, given `leaf` and `lmsPublicKey`, a set leaf bit means the
 * landing only burned the leaf (`burned`, with `burnReasons`: the empty
 * version-0 attestation of `PqLeafConsumed`, or another message's); a clear
 * one means it has not landed (`pending`). With `ledger`, the leaf's record
 * is updated: `markLanded` (attested or not) when it holds a signature,
 * `markBurned` when it was only reserved (something else set the bit).
 */
export async function confirmAttestation(conn: Connection, launch: PublicKey, expectedMessageHash: Uint8Array, opts: ConfirmAttestationOptions = {}): Promise<AttestationOutcome> {
  return confirm(conn, launch, expectedMessageHash, opts, false);
}

/** `confirmAttestation`; `leafKnownUsed`: the program answered PqLeafUsed for this leaf, so it is set whatever the identity account read shows. */
async function confirm(conn: Connection, launch: PublicKey, expectedMessageHash: Uint8Array, opts: ConfirmAttestationOptions, leafKnownUsed: boolean): Promise<AttestationOutcome> {
  checkPublicKey("launch", launch);
  checkBytes("expected message hash", expectedMessageHash, 32);
  let window: LaunchWindow | undefined;
  let recordHash: Uint8Array | null = null;
  let rulesHash: Uint8Array | null = null;
  if (opts.message !== undefined) {
    if (!bytesEqual(sha256(opts.message), expectedMessageHash)) throw new Error("opts.message does not hash to the expected message hash");
    const f = parseAttestationMessage(opts.message);
    if (!f.launch.equals(launch)) throw new Error("opts.message is for another launch");
    window = { notBefore: f.notBefore, notAfter: f.notAfter };
    recordHash = f.metadataHash;
    rulesHash = f.rulesHash;
  }
  const mh = toHex(expectedMessageHash);
  const attestation = await fetchAttestation(conn, launch);

  if (attestation !== null && attestation.attested && bytesEqual(attestation.messageHash, expectedMessageHash)) {
    let ledgerUpdated = false;
    if (opts.ledger !== undefined) {
      const rec = await opts.ledger.get(attestation.pqIdentity, attestation.leaf);
      if (rec !== null && rec.messageHash === mh && rec.signature !== null && rec.status !== "burned") {
        await opts.ledger.markLanded(attestation.pqIdentity, attestation.leaf, { slot: attestation.slot, attested: true });
        ledgerUpdated = true;
      }
    }
    return { status: "attested", attestation, leaf: attestation.leaf, slot: attestation.slot, ledgerUpdated };
  }

  if (opts.leaf === undefined || opts.lmsPublicKey === undefined) {
    return {
      status: "pending",
      attestation,
      detail: "the launch is not attested by this message; pass the leaf and the key that signed to tell a landing that only burned its leaf from one that has not landed",
    };
  }
  checkBytes("LMS public key", opts.lmsPublicKey, LMS_PUBLIC_KEY_LEN);
  const id = identityId(opts.lmsPublicKey);
  if (!leafKnownUsed) {
    const identity = await fetchIdentity(conn, opts.lmsPublicKey);
    if (identity === null || !leafUsed(identity.used, opts.leaf)) {
      return { status: "pending", attestation, detail: `leaf ${opts.leaf} is not used on-chain: the transaction has not landed (re-send the same signature; never sign again)` };
    }
  }

  const l = await fetchLaunch(conn, launch);
  const reasons = burnReasons({
    launchPqIdentity: l?.pqIdentity ?? null,
    identityId: id,
    recordExists: recordHash === null ? null : (await fetchTokenMeta(conn, launch, recordHash)) !== null,
    rulesRecordExists: rulesHash === null || isAllZero(rulesHash) ? null : await launchRulesRecordExists(conn, launch, rulesHash),
    window,
    landedAt: opts.landedAt,
    attestation,
    messageHash: expectedMessageHash,
  });
  const detail = burnDetail(opts.leaf, reasons);
  let ledgerUpdated = false;
  if (opts.ledger !== undefined) {
    const rec = await opts.ledger.get(id, opts.leaf);
    if (rec !== null && rec.messageHash === mh) {
      if (rec.signature !== null && rec.status !== "burned") {
        if (rec.status !== "landed" || rec.attested !== false) await opts.ledger.markLanded(id, opts.leaf, { attested: false });
        ledgerUpdated = true;
      } else if (rec.status === "reserved") {
        await opts.ledger.markBurned(id, opts.leaf);
        ledgerUpdated = true;
      }
    }
  }
  return { status: "burned", leaf: opts.leaf, reasons, detail, attestation, ledgerUpdated };
}

/** `sendAttestLaunchTx` refused before sending (nothing was broadcast). */
export class AttestPayerFundingError extends Error {
  readonly balance: bigint;
  readonly required: bigint;
  constructor(message: string, balance: bigint, required: bigint) {
    super(message);
    this.name = "AttestPayerFundingError";
    this.balance = balance;
    this.required = required;
  }
}

/**
 * Send a built attestation and report what became of it
 * (`confirmAttestation`, with the ledger updated). Before sending it checks
 * the payer's balance: at least the fee plus the rent of the accounts that
 * do not exist yet, and a remainder of 0 or at least the rent-exempt minimum
 * (the runtime refuses to leave a fee payer below it). A send the program
 * refuses with ConstraintSeeds (2006: an account the signature does not
 * name; nothing written, no leaf burned) is sent once more with the
 * accounts derived again and the SAME signature (`rewrapAttestTx`), never a
 * new one. PqLeafUsed (6041) means this leaf already landed (a copy of this
 * signature): the landing is read from the attestation. If nothing landed,
 * it throws; rebuild with the same inputs (same leaf, same bytes) and send
 * again.
 */
export async function sendAttestLaunchTx(conn: Connection, built: AttestLaunchReady, opts: { readonly ledger?: LeafLedger | undefined; readonly skipPreflight?: boolean | undefined } = {}): Promise<AttestationOutcome> {
  if (built.status !== "ready") throw new TypeError("only a built attest transaction (status ready) can be sent");
  const required = await requiredLamports(conn, LAMPORTS_PER_SIGNATURE + (built.priorityFeeLamports ?? 0n), built.launch, built.lmsPublicKey);
  const balance = BigInt(await conn.getBalance(built.payer.publicKey, "confirmed"));
  if (balance < required) {
    throw new AttestPayerFundingError(`the throwaway payer holds ${balance} lamports; it needs ${required} (fund it with buildFundThrowawayPayerTx)`, balance, required);
  }
  const floor = await rentExemptLamports(conn, 0);
  if (balance > required && balance - required < floor) {
    throw new AttestPayerFundingError(
      `the throwaway payer would keep ${balance - required} lamports, below the rent-exempt minimum of ${floor}: the runtime would refuse the transaction (fund exactly ${required}, or at least ${required + floor})`,
      balance,
      required,
    );
  }
  const send = async (b: AttestLaunchReady): Promise<unknown> => {
    try {
      await sendAndConfirm(conn, b.tx, { lastValidBlockHeight: b.lastValidBlockHeight, skipPreflight: opts.skipPreflight ?? false });
      return null;
    } catch (e) {
      return e;
    }
  };
  let sendError = await send(built);
  if (sendError !== null && customErrorCode(sendError) === CONSTRAINT_SEEDS) {
    // Nothing was written and the leaf is intact: the same signature again, with the accounts it names.
    sendError = await send(await rewrapAttestTx(conn, built));
  }
  const outcome = await confirm(
    conn,
    built.launch,
    built.messageHash,
    { leaf: built.leaf, lmsPublicKey: built.lmsPublicKey, message: built.message, ledger: opts.ledger, landedAt: await clusterUnixTime(conn) },
    sendError !== null && customErrorCode(sendError) === PQ_LEAF_USED,
  );
  if (outcome.status === "pending" && sendError !== null) {
    const refused = customErrorCode(sendError) === CONSTRAINT_SEEDS ? " The program refused the accounts twice (ConstraintSeeds): nothing was burned." : "";
    throw new Error(
      `the attestation did not land (${sendError instanceof Error ? sendError.message : String(sendError)}).${refused} Rebuild with the same inputs (same leaf, same signature bytes) and send again; never sign a new message for it`,
      { cause: sendError },
    );
  }
  return outcome;
}

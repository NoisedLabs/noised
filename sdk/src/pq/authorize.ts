/**
 * `pq_authorize` (P1c): a launch's post-quantum identity approves one change
 * to its autopilot (activate a graph, freeze it, remove its operator), and a
 * throwaway fee payer lands the signature in a v1 transaction. The autopilot
 * then uses the `Authorization` account the launchpad writes
 * (`../autopilot/governance.ts`).
 *
 * # What is signed
 *
 * The identity's LMS key signs the 140-byte message of `./identity.ts`
 * (`authorizationMessage`): `"PHX-AUTH-V1" || launchpad || launch || creator
 * || kind || payloadHash`. `kind` is 1 (activate a graph), 2 (freeze it) or 3
 * (remove its operator); `payloadHash` names the exact change
 * (`activationPayload`, `freezePayload`, `revokePayload`). The launchpad
 * writes an `Authorization` only for kinds 1 to 3: other kinds are burn-only
 * on-chain (a valid signature of one only burns its leaf), so this module
 * signs only these three. Each LMS leaf signs ONE message, ever, and the
 * bitmap is shared with the identity's attestations: the leaf is reserved
 * durably for this message (`./leafLedger.ts`) before the signature exists,
 * the signature is deterministic (a rebuild gives the same bytes) and it is
 * recorded before it is returned.
 *
 * A freeze (kind 2) names the last second it may be used, `freezeNotAfter`
 * (`freezePayload(autopilot, activeGraph, notAfter)`; review 4, R5): the
 * autopilot refuses it after that (`FreezeExpired`). It is signed to expire
 * at most 24 hours after this device's clock (`FREEZE_MAX_VALID_SECS`;
 * audit 4, ID-F5): a freeze that was landed and then withheld is usable only
 * that long (`planFreeze` defaults to one hour).
 *
 * # Before the signature (audit round 4)
 *
 * - The identity's key pair is read once at entry (ID-F6).
 * - A signature that names a time (kind 1, an activation time; kind 2, a
 *   freeze expiry) is made only when the cluster clock agrees with this
 *   device's clock (and a second RPC's, `secondConnection`) within 120 s
 *   (`ClockSkewError`; ID-F1b).
 * - "Check the earlier signatures, reserve a leaf, sign" runs under the
 *   launch's signing lock (`signingLock`; ID-F4), shared with attestations.
 * - At most 3 signatures per (launch, kind) that never landed with success
 *   (`SignatureCapError` without `acknowledgeExtraSignatures`; ID-F2).
 * - The leaf comes from the secret probe and the ledger only; nothing new is
 *   signed while the on-chain bitmap shows leaves the ledger never signed at
 *   (`UnknownLeavesError`; ID-F1).
 *
 * # What landing does
 *
 * Any valid signature of an unused leaf lands and burns its leaf. It writes
 * the `Authorization` at `["auth", launch, [kind], payloadHash]` (2,669 B,
 * with the cluster's time and slot) only when nothing was written there yet,
 * the kind is 1, 2 or 3 and the signing key is the identity the launch
 * names; any other landing only burns its leaf (`PqLeafConsumed`). So
 * `buildPqAuthorizeTx` refuses, before it signs: a kind other than 1, 2 or
 * 3; an endpoint that does not serve the identity's cluster
 * (`assertCluster`); a launch that does not exist, is not finalized
 * (default), is not at its own PDA, was created by another wallet or names
 * another identity; for a freeze, no `freezeNotAfter`, a payload that is not
 * the freeze of the autopilot's active graph until it, no autopilot or
 * nothing to freeze (no active graph, already frozen), or a cluster clock
 * (plus `freezeLandingMarginSecs`, default 60 s) past it; an authorization
 * already written at that address (`already-authorized`: nothing to sign); a
 * transaction over 4,096 bytes. A message whose leaf is already set on-chain
 * is not sent again (`leaf-landed`: `confirmAuthorization` tells what
 * landed).
 *
 * # After sending
 *
 * `sendPqAuthorizeTx` refuses to land a freeze past its `freezeNotAfter` (it
 * could never be used: landing it would only burn its leaf and the rent),
 * checks the payer's balance, sends, and reports what the
 * accounts say (`confirmAuthorization`): `authorized`, `burned` (with the
 * reasons the SDK can infer) or `pending` (not landed: rebuild with the same
 * inputs, which gives the same leaf and bytes; never sign anew). ConstraintSeeds
 * (2006: an account the signature does not name; nothing written, no leaf
 * burned) is answered by sending the SAME signature again with the accounts
 * derived from what it signed (`rewrapPqAuthorizeTx`); PqLeafUsed (6041) means
 * a copy of this signature already landed: the accounts tell the outcome.
 * `verifyAuthorization` re-checks a written authorization from account state
 * alone (message, hash, identity, leaf, LMS signature).
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { Keypair, PublicKey, type Connection, type TransactionInstruction } from "@solana/web3.js";

import { encodeBase58 } from "../codec/base58.js";
import { bytesEqual, fromHex, toHex } from "../codec/bytes.js";
import { buildInstruction } from "../codec/ix.js";
import { AUTHORIZATION, PQ_IDENTITY, PROGRAM_IDS } from "../constants.js";
import { idlCodecs } from "../idl/index.js";
import { fetchAutopilot } from "../autopilot/accounts.js";
import { checkUnixSecs, unixTimeText } from "../autopilot/governance.js";
import { decodeLaunch, fetchAuthorization, fetchIdentity, fetchLaunch } from "../launch/accounts.js";
import { clusterUnixTime, unixToIso } from "../launch/window.js";
import { authorizationAddress, identityAddress, launchAddress } from "../pda.js";
import { checkFreezeWindow, freezePayload } from "../programmable/autopilot/logic.js";
import { checkClockSkew } from "../rpc/clock.js";
import { assertCluster } from "../rpc/cluster.js";
import { computeUnitLimitOf, computeUnitPriceOf, priorityFeeLamports, type ComputeBudgetOptions } from "../rpc/computeBudget.js";
import { customErrorCode } from "../rpc/errors.js";
import { getAccount, getAccounts, ownedBy } from "../rpc/fetch.js";
import { LAMPORTS_PER_SIGNATURE, rentExemptLamports, sendAndConfirm } from "../rpc/index.js";
import { compileV1Message, signV1Message, V1_MAX_TRANSACTION_SIZE } from "../tx/v1.js";
import type { AuthorizationAccount, IdentityAccount, LaunchAccount } from "../types.js";
import { authorizationMessage, identityId, leafUsed, parseAuthorizationMessage, type PqIdentity } from "./identity.js";
import { holdsMessageLeaf, signAtNextLeaf, type LeafLedger, type LeafRecord } from "./leafLedger.js";
import type { LedgerLock } from "./ledgerLock.js";
import { LMS_PUBLIC_KEY_LEN, LMS_SIGNATURE_LEN, LmsKeyPair, lmsVerify } from "./lms.js";
import { countsAsUnlanded, MAX_UNLANDED_SIGNATURES, SignatureCapError, withSigningLock } from "./signGuard.js";

/** v1 compute-unit limit of `pq_authorize` (measured 91.0k-101.4k CU; LMS verification dominates). */
export const AUTHORIZE_COMPUTE_UNITS = AUTHORIZATION.COMPUTE_UNITS;
/** v1 loaded-accounts-data limit of `pq_authorize` (the launchpad program included). */
export const AUTHORIZE_LOADED_ACCOUNTS_BYTES = AUTHORIZATION.LOADED_ACCOUNTS_BYTES;

/** The kinds this SDK signs: 1 activate a graph, 2 freeze it, 3 remove its operator (the autopilot's). */
export type AuthorizeKind = 1 | 2 | 3;

/** Anchor's ConstraintSeeds: an account the signature does not name (nothing written, no leaf burned). */
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

/** Throws unless `kind` is 1, 2 or 3 (the launchpad writes an Authorization only for these; a signature over another only burns its leaf). */
function checkKind(kind: unknown): asserts kind is AuthorizeKind {
  if (kind !== AUTHORIZATION.KINDS.GRAPH_ACTIVATE && kind !== AUTHORIZATION.KINDS.GRAPH_FREEZE && kind !== AUTHORIZATION.KINDS.OPERATOR_REVOKE) {
    throw new RangeError(
      `refusing to sign: kind ${String(kind)} is not one the autopilot reads (1 activate a graph, 2 freeze it, 3 remove its operator); other kinds are burn-only on-chain (a signature of one only burns its leaf)`,
    );
  }
}

/** The default `freezeLandingMarginSecs` of `buildPqAuthorizeTx`: a freeze is not signed with less than a minute left to land it. */
const FREEZE_SIGN_MARGIN_SECS = 60n;
/** The latest a freeze approval may expire after this device's clock: 24 hours (audit 4, ID-F5). */
export const FREEZE_MAX_VALID_SECS = BigInt(PQ_IDENTITY.FREEZE_MAX_VALID_SECS);

function checkMargin(name: string, m: unknown): asserts m is bigint {
  if (typeof m !== "bigint" || m < 0n) throw new RangeError(`${name} must be a non-negative bigint (seconds)`);
}

// ------------------------------------------------------------ instruction ---

/** Everything `pq_authorize` takes, signature included. */
export interface PqAuthorizeInstructionArgs {
  /** Pays the fee and the rent (a throwaway key). */
  readonly payer: PublicKey;
  readonly launch: PublicKey;
  /** The 56-byte LMS public key that signed; its identity account is derived from it. */
  readonly lmsPublicKey: Uint8Array;
  /** The 2,508-byte LMS signature. */
  readonly lmsSignature: Uint8Array;
  readonly kind: AuthorizeKind;
  /** What is authorized (32 bytes); the authorization account `["auth", launch, [kind], payloadHash]` is derived from it. */
  readonly payloadHash: Uint8Array;
}

/**
 * The `pq_authorize` instruction (IDL-encoded): data = discriminator
 * `89bf3ed6b9288ff7` || `lms_pk [56]` || `lms_sig: bytes` || `kind u8` ||
 * `payload_hash [32]` (2,609 bytes); accounts `[payer (signer, writable),
 * launch, identity (writable), authorization (writable), system program]`.
 * Pure. Refuses a kind other than 1, 2 or 3.
 */
export function pqAuthorizeInstruction(a: PqAuthorizeInstructionArgs): TransactionInstruction {
  checkPublicKey("payer", a.payer);
  checkPublicKey("launch", a.launch);
  checkBytes("LMS public key", a.lmsPublicKey, LMS_PUBLIC_KEY_LEN);
  checkBytes("LMS signature", a.lmsSignature, LMS_SIGNATURE_LEN);
  checkKind(a.kind);
  checkBytes("payloadHash", a.payloadHash, 32);
  return buildInstruction(
    idlCodecs().launchpad,
    PROGRAM_IDS.launchpad,
    "pq_authorize",
    {
      payer: a.payer,
      launch: a.launch,
      identity: identityAddress(a.lmsPublicKey),
      authorization: authorizationAddress(a.launch, a.kind, a.payloadHash),
    },
    { lmsPk: a.lmsPublicKey, lmsSig: a.lmsSignature, kind: a.kind, payloadHash: a.payloadHash },
  );
}

/** Priority fee and v1 limits of an authorize transaction. */
export interface AuthorizeTxOptions extends ComputeBudgetOptions {
  /** v1 loaded-accounts-data limit (default `AUTHORIZE_LOADED_ACCOUNTS_BYTES`, 2 MiB). */
  loadedAccountsDataSizeLimit?: number | undefined;
}

/** The v1 config of an authorize transaction: compute limit (default 300,000), loaded-data limit, and the priority fee in lamports (null: none). */
export function authorizeTxConfig(opts: AuthorizeTxOptions = {}): { computeUnitLimit: number; loadedAccountsDataSizeLimit: number; priorityFeeLamports: bigint | null } {
  const computeUnitLimit = computeUnitLimitOf(opts, AUTHORIZE_COMPUTE_UNITS);
  const price = computeUnitPriceOf(opts);
  const loadedAccountsDataSizeLimit = opts.loadedAccountsDataSizeLimit ?? AUTHORIZE_LOADED_ACCOUNTS_BYTES;
  if (!Number.isInteger(loadedAccountsDataSizeLimit) || loadedAccountsDataSizeLimit < 1 || loadedAccountsDataSizeLimit > 0xffff_ffff) {
    throw new RangeError("loadedAccountsDataSizeLimit must be a positive u32");
  }
  return { computeUnitLimit, loadedAccountsDataSizeLimit, priorityFeeLamports: price === null || price === 0n ? null : priorityFeeLamports(price, computeUnitLimit) };
}

type AuthorizeConfig = ReturnType<typeof authorizeTxConfig>;

function signAuthorizeConfigured(payer: Keypair, ix: TransactionInstruction, recentBlockhash: string, config: AuthorizeConfig): { tx: Uint8Array; signature: string; sizeBytes: number } {
  const message = compileV1Message(payer.publicKey, [ix], recentBlockhash, {
    computeUnitLimit: config.computeUnitLimit,
    loadedAccountsDataSizeLimit: config.loadedAccountsDataSizeLimit,
    ...(config.priorityFeeLamports === null ? {} : { priorityFeeLamports: config.priorityFeeLamports }),
  });
  if (message.header.numRequiredSignatures !== 1) throw new Error("an authorize transaction is signed by its fee payer alone");
  const tx = signV1Message(message, [payer]);
  if (tx.length > V1_MAX_TRANSACTION_SIZE) throw new Error(`the authorize transaction would be ${tx.length} bytes (limit ${V1_MAX_TRANSACTION_SIZE})`);
  return { tx, signature: encodeBase58(tx.subarray(message.bytes.length, message.bytes.length + 64)), sizeBytes: tx.length };
}

/**
 * Exact wire size (bytes) of an authorize transaction: constant whatever the
 * kind and payload (they travel as one byte and 32 bytes), 8 more with a
 * priority fee. Computed from the real encoder and v1 compiler (limit 4,096).
 */
export function authorizeTransactionSize(opts: { readonly priorityFee?: boolean } = {}): number {
  const key = (b: number): PublicKey => new PublicKey(new Uint8Array(32).fill(b));
  const ix = pqAuthorizeInstruction({
    payer: key(1),
    launch: key(2),
    lmsPublicKey: new Uint8Array(LMS_PUBLIC_KEY_LEN).fill(3),
    lmsSignature: new Uint8Array(LMS_SIGNATURE_LEN),
    kind: 1,
    payloadHash: new Uint8Array(32).fill(4),
  });
  const message = compileV1Message(key(1), [ix], encodeBase58(new Uint8Array(32)), {
    computeUnitLimit: AUTHORIZE_COMPUTE_UNITS,
    loadedAccountsDataSizeLimit: AUTHORIZE_LOADED_ACCOUNTS_BYTES,
    ...(opts.priorityFee === true ? { priorityFeeLamports: 1n } : {}),
  });
  return message.bytes.length + 64 * message.header.numRequiredSignatures;
}

// ---------------------------------------------------------------- funding ---

/** The fee an authorize transaction pays: one signature (5,000 lamports) plus its priority fee. */
export function authorizeFeeLamports(opts: AuthorizeTxOptions = {}): bigint {
  return LAMPORTS_PER_SIGNATURE + (authorizeTxConfig(opts).priorityFeeLamports ?? 0n);
}

/** `fundingLamportsForAuthorize` options: with the launch, key, kind and payload, only the accounts that do not exist yet are counted. */
export interface AuthorizeFundingOptions extends AuthorizeTxOptions {
  launch?: PublicKey | undefined;
  lmsPublicKey?: Uint8Array | undefined;
  kind?: AuthorizeKind | undefined;
  payloadHash?: Uint8Array | undefined;
}

/** The rent of the identity (196 B) and authorization (2,669 B) accounts a landing would create (only the missing ones, given where they are). */
async function authorizeRentLamports(conn: Connection, o: AuthorizeFundingOptions): Promise<{ identity: bigint; authorization: bigint }> {
  let needIdentity = true;
  let needAuthorization = true;
  const given = [o.launch, o.lmsPublicKey, o.kind, o.payloadHash].filter((x) => x !== undefined).length;
  if (given > 0) {
    if (given !== 4) throw new TypeError("pass launch, lmsPublicKey, kind and payloadHash together, or none of them");
    checkPublicKey("launch", o.launch);
    checkBytes("LMS public key", o.lmsPublicKey, LMS_PUBLIC_KEY_LEN);
    checkKind(o.kind);
    checkBytes("payloadHash", o.payloadHash, 32);
    const [idAcc, authAcc] = await getAccounts(conn, [identityAddress(o.lmsPublicKey), authorizationAddress(o.launch, o.kind, o.payloadHash)]);
    needIdentity = ownedBy(idAcc ?? null, PROGRAM_IDS.launchpad, "Identity") === null;
    needAuthorization = ownedBy(authAcc ?? null, PROGRAM_IDS.launchpad, "Authorization") === null;
  }
  const [identity, authorization] = await Promise.all([
    needIdentity ? rentExemptLamports(conn, PQ_IDENTITY.IDENTITY_ACCOUNT_LEN) : Promise.resolve(0n),
    needAuthorization ? rentExemptLamports(conn, AUTHORIZATION.ACCOUNT_LEN) : Promise.resolve(0n),
  ]);
  return { identity, authorization };
}

/**
 * Lamports a throwaway payer needs to land one authorization: `rent(196)`
 * (the identity, if none of its signatures landed yet) + `rent(2,669)` (the
 * authorization, if the address holds nothing yet) + the fee; the rent read
 * from the cluster (`getMinimumBalanceForRentExemption`), never hard-coded.
 * Without `launch`, `lmsPublicKey`, `kind` and `payloadHash`: both rents (an
 * upper bound). Funding exactly this leaves 0 behind, which the runtime
 * accepts of a fee payer.
 */
export async function fundingLamportsForAuthorize(conn: Connection, opts: AuthorizeFundingOptions = {}): Promise<bigint> {
  const fee = authorizeFeeLamports(opts);
  const rent = await authorizeRentLamports(conn, opts);
  return rent.identity + rent.authorization + fee;
}

// ---------------------------------------------------------------- building ---

/** `buildPqAuthorizeTx` arguments. */
export interface BuildPqAuthorizeArgs extends AuthorizeTxOptions {
  readonly launch: PublicKey;
  /** The wallet that created the launch: only a launch whose creator is this wallet is signed for. */
  readonly creator: PublicKey;
  /** The identity the launch names (`deriveIdentity`); its `cluster` is checked against the endpoint. */
  readonly identity: PqIdentity;
  /** Durable leaf records, shared with the identity's attestations (`createLeafLedger` on a persistent, atomic store). */
  readonly ledger: LeafLedger;
  /** 1 activate a graph, 2 freeze it, 3 remove its operator. */
  readonly kind: AuthorizeKind;
  /** What is authorized: `activationPayload`, `freezePayload` or `revokePayload` (32 bytes). */
  readonly payloadHash: Uint8Array;
  /**
   * Kind 2 (a freeze) only, and required for it: the last second the freeze
   * may be used (unix seconds, inclusive), the `notAfter` of
   * `freezePayload(autopilot, activeGraph, notAfter)` = `payloadHash`. At
   * most 24 hours after this device's clock (`FREEZE_MAX_VALID_SECS`).
   */
  readonly freezeNotAfter?: bigint | undefined;
  /** Kind 2 only: refuse to sign when the cluster clock plus this many seconds is past `freezeNotAfter` (default 60). */
  readonly freezeLandingMarginSecs?: bigint | undefined;
  /** Throwaway fee payer (default: a fresh `Keypair.generate()`). Pass the same one to rebuild after an expired blockhash. */
  readonly payer?: Keypair | undefined;
  /** Accept an identity derived for localnet (see `assertCluster`). */
  readonly allowLocalnet?: boolean | undefined;
  /** Commitment the launch must have reached before it is signed for (default `finalized`). */
  readonly launchCommitment?: "finalized" | "confirmed" | undefined;
  /**
   * The user confirmed signing although this ledger already holds
   * `MAX_UNLANDED_SIGNATURES` (3) signatures of this launch and kind that
   * never landed with success (audit 4, ID-F2; `SignatureCapError` otherwise).
   */
  readonly acknowledgeExtraSignatures?: boolean | undefined;
  /** The launch's signing lock (audit 4, ID-F4; default an in-process mutex; in a browser `(name, fn) => navigator.locks.request(name, fn)`). */
  readonly signingLock?: LedgerLock | undefined;
  /** This device's unix seconds (default its clock): kinds 1 and 2 need the cluster clock to agree within `maxClockSkewSecs`. */
  readonly localNowSecs?: bigint | undefined;
  /** A second, independent RPC whose cluster clock must agree too. */
  readonly secondConnection?: Connection | undefined;
  /** Most seconds the clocks may differ (default 120). */
  readonly maxClockSkewSecs?: bigint | undefined;
}

interface PqAuthorizeCommon {
  readonly launch: PublicKey;
  readonly kind: AuthorizeKind;
  readonly payloadHash: Uint8Array;
  /** The authorization's address, `["auth", launch, [kind], payloadHash]`. */
  readonly authorizationAddress: PublicKey;
  /** The 140-byte message. */
  readonly message: Uint8Array;
  /** SHA-256 of `message`: what the authorization account must hold. */
  readonly messageHash: Uint8Array;
  readonly lmsPublicKey: Uint8Array;
  readonly identityId: Uint8Array;
  /** A freeze (kind 2): the last second it may be used, as signed (`sendPqAuthorizeTx` refuses to land it later); null for kinds 1 and 3. */
  readonly freezeNotAfter: bigint | null;
  /** `freezeNotAfter` as an absolute UTC date (`unixToIso`); null for kinds 1 and 3. */
  readonly freezeNotAfterIso: string | null;
  /** Cautions for the UI (leaves another device used, an identity running out of leaves, earlier approvals that can still land). */
  readonly warnings: string[];
}

/** A signed authorize transaction, ready to fund and send. */
export interface PqAuthorizeReady extends PqAuthorizeCommon {
  readonly status: "ready";
  /** Signed v1 wire bytes (`sendAndConfirm` sends them as they are). */
  readonly tx: Uint8Array;
  /** Transaction id: base58 of the fee payer's signature. */
  readonly signature: string;
  /** The throwaway fee payer: keep it until what is left was swept back. */
  readonly payer: Keypair;
  readonly blockhash: string;
  readonly lastValidBlockHeight: number;
  /** The authorization's address (same as `authorizationAddress`). */
  readonly authorization: PublicKey;
  readonly leaf: number;
  /** The 2,508-byte LMS signature (recorded in the ledger before it was returned). */
  readonly lmsSignature: Uint8Array;
  /** True when the ledger already held this signature (a rebuild: same leaf, same signature bytes, nothing new signed). */
  readonly retry: boolean;
  readonly sizeBytes: number;
  readonly computeUnitLimit: number;
  readonly priorityFeeLamports: bigint | null;
  /** What `payer` needs now: the fee plus the rent of the accounts that do not exist yet. */
  readonly fundingLamports: bigint;
}

/** This exact authorization is already written: nothing to sign or send. */
export interface PqAuthorizeAlreadyAuthorized extends PqAuthorizeCommon {
  readonly status: "already-authorized";
  readonly authorization: AuthorizationAccount;
  readonly leaf: number;
}

/** This message's leaf is already set on-chain: do not re-send; `confirmAuthorization` tells what landed. */
export interface PqAuthorizeLeafLanded extends PqAuthorizeCommon {
  readonly status: "leaf-landed";
  readonly authorization: PublicKey;
  readonly leaf: number;
}

export type PqAuthorizeTx = PqAuthorizeReady | PqAuthorizeAlreadyAuthorized | PqAuthorizeLeafLanded;

/**
 * Sign one authorization of `launch` with its post-quantum identity and
 * return the signed v1 transaction (from a throwaway fee payer), after every
 * refusal listed in the module docs. Order: input checks (the kind first,
 * then `freezeNotAfter` for a freeze), `assertCluster`, the launch
 * (finalized, at its PDA, this creator, this identity), for a freeze the
 * autopilot (something to freeze), the cluster clock plus
 * `freezeLandingMarginSecs` (not past `freezeNotAfter`) and the payload (the
 * active graph's freeze until `freezeNotAfter`), the authorization address
 * (already written: nothing to do), the size, the funding and blockhash, then the leaf (on-chain bitmap, probe,
 * ledger reservation) and only then the signature. Fund `payer`
 * (`fundingLamports`) and send with `sendPqAuthorizeTx`.
 */
export async function buildPqAuthorizeTx(conn: Connection, args: BuildPqAuthorizeArgs): Promise<PqAuthorizeTx> {
  const { launch, creator, ledger } = args;
  checkKind(args.kind);
  const kind = args.kind;
  checkPublicKey("launch", launch);
  checkPublicKey("creator", creator);
  // Read once (audit 4, ID-F6): every later use sees the same key pair and cluster.
  const identity = args.identity;
  if (identity === null || typeof identity !== "object") throw new TypeError("identity must be a PqIdentity (deriveIdentity)");
  const keyPair = identity.keyPair;
  const cluster = identity.cluster;
  const identityIdGiven = identity.identityId;
  if (!(keyPair instanceof LmsKeyPair)) throw new TypeError("identity must be a PqIdentity (deriveIdentity)");
  if (keyPair.wiped) throw new Error("this identity's key pair was wiped: derive it again");
  if (ledger === null || typeof ledger !== "object") throw new TypeError("ledger must be a LeafLedger (createLeafLedger)");
  const lmsPublicKey = keyPair.publicKey;
  const id = identityId(lmsPublicKey);
  if (!bytesEqual(id, identityIdGiven)) throw new Error("identity.identityId is not the id of its key pair");
  checkBytes("payloadHash", args.payloadHash, 32);
  const payloadHash = Uint8Array.from(args.payloadHash);
  let freezeNotAfter: bigint | null = null;
  let freezeMargin = FREEZE_SIGN_MARGIN_SECS;
  if (kind === AUTHORIZATION.KINDS.GRAPH_FREEZE) {
    if (args.freezeNotAfter === undefined) {
      throw new TypeError("refusing to sign: a freeze (kind 2) needs freezeNotAfter, the last time it may be used (the notAfter of its freezePayload)");
    }
    checkUnixSecs("freezeNotAfter", args.freezeNotAfter);
    freezeNotAfter = args.freezeNotAfter;
    freezeMargin = args.freezeLandingMarginSecs ?? FREEZE_SIGN_MARGIN_SECS;
    checkMargin("freezeLandingMarginSecs", freezeMargin);
  } else if (args.freezeNotAfter !== undefined || args.freezeLandingMarginSecs !== undefined) {
    throw new TypeError(`freezeNotAfter and freezeLandingMarginSecs are for a freeze (kind 2), not kind ${kind}`);
  }
  const commitment = args.launchCommitment ?? "finalized";
  if (commitment !== "finalized" && commitment !== "confirmed") throw new RangeError('launchCommitment must be "finalized" or "confirmed"');
  const payer = args.payer ?? Keypair.generate();
  if (!(payer instanceof Keypair)) throw new TypeError("payer must be a Keypair (the throwaway fee payer)");
  const config = authorizeTxConfig(args);
  const warnings: string[] = [];
  if (payer.publicKey.equals(creator)) warnings.push("the creator's wallet pays this authorization: a fresh throwaway payer keeps the wallet out of it");

  // The endpoint serves the cluster this identity's leaves belong to.
  await assertCluster(conn, cluster, { allowLocalnet: args.allowLocalnet });

  // The launch: finalized, at its PDA, this creator, this identity.
  const launchAcc = ownedBy(await getAccount(conn, launch, commitment), PROGRAM_IDS.launchpad, "Launch");
  if (launchAcc === null) {
    if (commitment === "finalized" && ownedBy(await getAccount(conn, launch, "confirmed"), PROGRAM_IDS.launchpad, "Launch") !== null) {
      throw new Error("refusing to sign: the launch is not finalized yet (wait about 13 s): a signature over a launch that is rolled back could never authorize anything");
    }
    throw new Error(`refusing to sign: launch ${launch.toBase58()} does not exist (a signature over it could never land)`);
  }
  const l = decodeLaunch(launch, launchAcc.data);
  if (!launchAddress(l.creator, l.launchSeed).equals(launch)) throw new Error("refusing to sign: the launch account is not at the PDA of its own creator and seed");
  if (!l.creator.equals(creator)) throw new Error(`refusing to sign: the launch was created by ${l.creator.toBase58()}, not by this wallet (${creator.toBase58()})`);
  if (!bytesEqual(l.pqIdentity, id)) throw new Error("refusing to sign: the launch names another post-quantum identity (this signature would only burn a leaf)");

  // A time it signs (an activation time, a freeze expiry): the cluster clock must agree with this device's (ID-F1b).
  const clock = kind === AUTHORIZATION.KINDS.OPERATOR_REVOKE ? null : await checkClockSkew(conn, args);

  // A freeze, in the autopilot's order: something to freeze, not expired (with room to land it), the active graph's.
  if (freezeNotAfter !== null) {
    const ap = await fetchAutopilot(conn, launch);
    if (ap === null) throw new Error("refusing to sign: this launch has no autopilot, so there is nothing to freeze (the approval could never be used)");
    if (ap.frozen) throw new Error("refusing to sign: the autopilot is already frozen forever (a freeze approval could never be used)");
    if (!ap.hasActiveGraph) throw new Error("refusing to sign: no graph is active, so there is nothing to freeze (the approval could never be used)");
    const now = clock!.clusterSecs;
    // ID-F5: a freeze approval expires at most 24 hours after this device's clock (a withheld one is never usable longer).
    if (freezeNotAfter > clock!.localSecs + FREEZE_MAX_VALID_SECS) {
      throw new Error(
        `refusing to sign: this freeze approval would stay usable until ${unixTimeText(freezeNotAfter)}, more than 24 hours from now (${unixTimeText(clock!.localSecs)} on this device). Plan the freeze again (planFreeze) with a shorter window`,
      );
    }
    if (checkFreezeWindow(now + freezeMargin, freezeNotAfter) !== null) {
      throw new Error(
        `refusing to sign: this freeze approval would expire at ${unixTimeText(freezeNotAfter)}, but the cluster time is ${now} (and ${freezeMargin} s are kept to land it): it could never be used. Plan a new freeze with a later time`,
      );
    }
    if (!bytesEqual(freezePayload(ap.publicKey, ap.activeGraph, freezeNotAfter), payloadHash)) {
      throw new Error("refusing to sign: payloadHash is not freezePayload(autopilot, active graph, freezeNotAfter): it would freeze another graph or name another time (plan the freeze again)");
    }
  }

  const message = authorizationMessage({ launch, creator: l.creator, kind, payloadHash });
  const messageHash = sha256(message);
  const address = authorizationAddress(launch, kind, payloadHash);
  const common: PqAuthorizeCommon = {
    launch,
    kind,
    payloadHash,
    authorizationAddress: address,
    message,
    messageHash,
    lmsPublicKey,
    identityId: id,
    freezeNotAfter,
    freezeNotAfterIso: freezeNotAfter === null ? null : unixToIso(freezeNotAfter),
    warnings,
  };

  // Written once, never changed: ours is done; anything else there means a new signature would only burn a leaf.
  const existing = await fetchAuthorization(conn, launch, kind, payloadHash);
  if (existing !== null && existing.authorized) {
    if (bytesEqual(existing.messageHash, messageHash) && bytesEqual(existing.pqIdentity, id)) return { ...common, status: "already-authorized", authorization: existing, leaf: existing.leaf };
    throw new Error("refusing to sign: this authorization address already holds another message (it is written once): a new signature would only burn a leaf");
  }

  // A signature that can never land must never exist.
  const size = authorizeTransactionSize({ priorityFee: config.priorityFeeLamports !== null });
  if (size > V1_MAX_TRANSACTION_SIZE) throw new Error(`refusing to sign: the authorize transaction would be ${size} bytes (limit ${V1_MAX_TRANSACTION_SIZE})`);

  // Everything that needs the network, before the signature exists.
  const fundingLamports = await fundingLamportsForAuthorize(conn, { ...args, launch, lmsPublicKey, kind, payloadHash });
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");

  // Audit 4, ID-F4: "check the earlier approvals, reserve, sign" under the launch's signing lock (shared with attestations).
  return withSigningLock(launch, args.signingLock, async (): Promise<PqAuthorizeTx> => {
    // The leaf: on-chain bitmap (shared with attestations), the secret probe and the records; reserved before the signature exists.
    const onChain = await fetchIdentity(conn, lmsPublicKey);
    const used = onChain === null ? new Uint8Array(PQ_IDENTITY.LEAF_BITMAP_LEN) : onChain.used;
    // This launch's approvals the ledger holds; those whose authorization account holds them landed with a known outcome.
    const approvals = await launchApprovals(conn, ledger, id, launch, used);
    const mine = await ledger.findByMessage(id, messageHash);
    const rebuild = mine !== null && holdsMessageLeaf(mine) && mine.signature !== null;
    const others = approvals.filter((a) => a.record.messageHash !== toHex(messageHash));
    // Earlier approvals of this launch that were signed but never seen landing can still be landed by anyone holding them.
    for (const a of others) {
      if (a.record.status === "landed" || a.record.retired === true) continue;
      warnings.push(
        `an earlier approval of kind ${a.kind} for this launch (leaf ${a.record.leaf}) was signed but never seen landing: whoever holds it can still land it. Land it, or make sure the change it approves is still one you want.`,
      );
    }
    // ID-F2: at most MAX_UNLANDED_SIGNATURES approvals of this launch and kind that never landed with success.
    if (!rebuild) {
      const unlanded = others.filter((a) => a.kind === kind && countsAsUnlanded(a.record));
      if (unlanded.length >= MAX_UNLANDED_SIGNATURES && args.acknowledgeExtraSignatures !== true) {
        throw new SignatureCapError(launch, kind, unlanded.map((a) => a.record.leaf), MAX_UNLANDED_SIGNATURES);
      }
    }
    // A message whose leaf is set on-chain gets its recorded bytes back (no new signature) and is not re-sent.
    const { leaf, signature: lmsSignature, selection } = await signAtNextLeaf(ledger, keyPair, message, used, { launch });
    if (selection.kind === "existing" && selection.onChain) return { ...common, status: "leaf-landed", authorization: address, leaf };
    if (lmsVerify(lmsPublicKey, message, lmsSignature) !== leaf) throw new Error("the LMS signature does not verify at its leaf (corrupted record?)");
    if (selection.choice.warn) warnings.push(`this identity has used ${selection.choice.usedCount} of 1,024 leaves on-chain: move to the next identity index soon`);

    const ix = pqAuthorizeInstruction({ payer: payer.publicKey, launch, lmsPublicKey, lmsSignature, kind, payloadHash });
    const signed = signAuthorizeConfigured(payer, ix, blockhash, config);
    return {
      ...common,
      status: "ready",
      tx: signed.tx,
      signature: signed.signature,
      payer,
      blockhash,
      lastValidBlockHeight,
      authorization: address,
      leaf,
      lmsSignature,
      retry: selection.kind === "existing" && selection.record.signature !== null,
      sizeBytes: signed.sizeBytes,
      computeUnitLimit: config.computeUnitLimit,
      priorityFeeLamports: config.priorityFeeLamports,
      fundingLamports,
    };
  });
}

/** One approval (`pq_authorize` message) of a launch the ledger holds a signature of. */
interface LedgerApproval {
  readonly record: LeafRecord;
  readonly kind: number;
  readonly payloadHash: Uint8Array;
}

/**
 * The approvals of `launch` the ledger holds a signature of. One whose leaf is
 * set and whose authorization account holds exactly it (this message hash,
 * identity and leaf) landed with a known outcome: it is marked landed and
 * authorized (audit 4, ID-F4: a set bit alone never counts as landed).
 */
async function launchApprovals(conn: Connection, ledger: LeafLedger, id: Uint8Array, launch: PublicKey, used: Uint8Array): Promise<LedgerApproval[]> {
  const out: LedgerApproval[] = [];
  for (const r of await ledger.list(id)) {
    if (r.signature === null || r.message === null) continue;
    let f: ReturnType<typeof parseAuthorizationMessage>;
    try {
      f = parseAuthorizationMessage(fromHex(r.message));
    } catch {
      continue; // an attestation or another message
    }
    if (!f.launch.equals(launch)) continue;
    let record = r;
    if (r.status !== "landed" && r.status !== "burned" && leafUsed(used, r.leaf) && (f.kind === 1 || f.kind === 2 || f.kind === 3)) {
      const auth = await fetchAuthorization(conn, launch, f.kind, f.payloadHash);
      if (auth !== null && auth.authorized && auth.leaf === r.leaf && bytesEqual(auth.pqIdentity, id) && toHex(auth.messageHash) === r.messageHash) {
        await ledger.markLanded(id, r.leaf, { slot: auth.slot, attested: true });
        record = (await ledger.get(id, r.leaf)) ?? r;
      }
    }
    out.push({ record, kind: f.kind, payloadHash: f.payloadHash });
  }
  return out;
}

/**
 * The same signature in a new transaction: a fresh blockhash, the accounts
 * derived again from the signed message (launch, kind, payload) and key,
 * signed by the same throwaway payer, with the built transaction's compute
 * limit and priority fee. For a send refused with ConstraintSeeds or whose
 * blockhash expired: the LMS signature is never made again. Checks that the
 * signature still verifies at its leaf over the message.
 */
export async function rewrapPqAuthorizeTx(conn: Connection, built: PqAuthorizeReady): Promise<PqAuthorizeReady> {
  if (built === null || typeof built !== "object" || built.status !== "ready") throw new TypeError("only a built authorize transaction (status ready) can be sent again");
  const f = parseAuthorizationMessage(built.message);
  checkKind(f.kind);
  if (!f.launch.equals(built.launch) || f.kind !== built.kind || !bytesEqual(f.payloadHash, built.payloadHash)) throw new Error("the built transaction's message is for another launch, kind or payload");
  if (lmsVerify(built.lmsPublicKey, built.message, built.lmsSignature) !== built.leaf) throw new Error("the recorded signature does not verify at its leaf over this message");
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const ix = pqAuthorizeInstruction({ payer: built.payer.publicKey, launch: f.launch, lmsPublicKey: built.lmsPublicKey, lmsSignature: built.lmsSignature, kind: f.kind, payloadHash: f.payloadHash });
  const config: AuthorizeConfig = { computeUnitLimit: built.computeUnitLimit, loadedAccountsDataSizeLimit: AUTHORIZE_LOADED_ACCOUNTS_BYTES, priorityFeeLamports: built.priorityFeeLamports };
  const signed = signAuthorizeConfigured(built.payer, ix, blockhash, config);
  const address = authorizationAddress(f.launch, f.kind, f.payloadHash);
  return { ...built, authorization: address, authorizationAddress: address, tx: signed.tx, signature: signed.signature, blockhash, lastValidBlockHeight, retry: true, sizeBytes: signed.sizeBytes };
}

// ----------------------------------------------------------- confirmation ---

/** Why a valid signature landed without authorizing (what the SDK can tell from the accounts). */
export type AuthorizeBurnReason =
  /** The signing key is not the launch's `pq_identity`. */
  | "wrong-identity"
  /** The authorization was already written (by another signature of it) when this one landed. */
  | "already-authorized";

/** What became of an authorization. */
export type AuthorizationOutcome =
  | {
      /** The authorization is written (version 1, this message): the autopilot can use it. */
      readonly status: "authorized";
      readonly authorization: AuthorizationAccount;
      /** The leaf that wrote it. */
      readonly leaf: number;
      readonly slot: bigint;
      /** Whether the ledger recorded the landing. */
      readonly ledgerUpdated: boolean;
    }
  | {
      /** The leaf is used on-chain but did not write this authorization: the landing only burned the leaf. */
      readonly status: "burned";
      readonly leaf: number;
      /** Plain-English explanation. */
      readonly detail: string;
      readonly reasons: AuthorizeBurnReason[];
      readonly authorization: AuthorizationAccount | null;
      readonly ledgerUpdated: boolean;
    }
  | {
      /** Not landed (yet): re-send the same bytes (rebuild with the same inputs), never a new signature. */
      readonly status: "pending";
      readonly detail: string;
    };

/** `confirmAuthorization` options: what was sent (to tell a burn from a landing still pending). */
export interface ConfirmAuthorizationOptions {
  /** The leaf the signature used. */
  readonly leaf?: number | undefined;
  /** The 56-byte key that signed. */
  readonly lmsPublicKey?: Uint8Array | undefined;
  /** Updated with what landed: `markLanded` (authorized or not) or `markBurned`. */
  readonly ledger?: LeafLedger | undefined;
}

const REASON_TEXT: Readonly<Record<AuthorizeBurnReason, string>> = {
  "wrong-identity": "the signing key is not the identity this launch names",
  "already-authorized": "this approval was already written by another signature of it",
};

function burnDetail(leaf: number, reasons: readonly AuthorizeBurnReason[]): string {
  return reasons.length === 0
    ? `leaf ${leaf} is used on-chain, but it did not write this authorization (the cause could not be inferred)`
    : `leaf ${leaf} was burned without authorizing: ${reasons.map((r) => REASON_TEXT[r]).join("; ")}`;
}

/**
 * Whether `launch` holds the authorization of `kind` over `payloadHash`. With
 * `leaf` and `lmsPublicKey` (what was sent): `authorized` when this leaf
 * wrote it (or another signature did while this one never landed), `burned`
 * when this leaf is set on-chain but did not write it (with the reasons),
 * `pending` when it is clear. Without them: `authorized` or `pending`. With
 * `ledger`, the leaf's record is updated: `markLanded` (authorized or not)
 * when it holds a signature, `markBurned` when it was only reserved.
 */
export async function confirmAuthorization(conn: Connection, launch: PublicKey, kind: AuthorizeKind, payloadHash: Uint8Array, opts: ConfirmAuthorizationOptions = {}): Promise<AuthorizationOutcome> {
  return confirm(conn, launch, kind, payloadHash, opts, false);
}

async function confirm(conn: Connection, launch: PublicKey, kind: AuthorizeKind, payloadHash: Uint8Array, opts: ConfirmAuthorizationOptions, leafKnownUsed: boolean): Promise<AuthorizationOutcome> {
  checkPublicKey("launch", launch);
  checkKind(kind);
  checkBytes("payloadHash", payloadHash, 32);
  if (opts.lmsPublicKey !== undefined) checkBytes("LMS public key", opts.lmsPublicKey, LMS_PUBLIC_KEY_LEN);
  const l = await fetchLaunch(conn, launch);
  const expected = l === null ? null : sha256(authorizationMessage({ launch, creator: l.creator, kind, payloadHash }));
  const auth = await fetchAuthorization(conn, launch, kind, payloadHash);
  const sentId = opts.lmsPublicKey === undefined ? null : identityId(opts.lmsPublicKey);

  const updateLedger = async (idBytes: Uint8Array, leaf: number, landed: { slot?: bigint; attested: boolean }): Promise<boolean> => {
    if (opts.ledger === undefined || expected === null) return false;
    const rec = await opts.ledger.get(idBytes, leaf);
    if (rec === null || rec.messageHash !== toHex(expected)) return false;
    if (rec.signature !== null && rec.status !== "burned") {
      if (landed.attested) await opts.ledger.markLanded(idBytes, leaf, { ...(landed.slot === undefined ? {} : { slot: landed.slot }), attested: true });
      else if (rec.status !== "landed" || rec.attested !== false) await opts.ledger.markLanded(idBytes, leaf, { attested: false });
      return true;
    }
    if (!landed.attested && rec.status === "reserved") {
      await opts.ledger.markBurned(idBytes, leaf);
      return true;
    }
    return false;
  };

  if (auth !== null && auth.authorized) {
    if (expected !== null && !bytesEqual(auth.messageHash, expected)) throw new Error("the authorization holds another message than this launch's (a launchpad that does not keep the layout?)");
    const ours = opts.leaf === undefined || sentId === null || (auth.leaf === opts.leaf && bytesEqual(auth.pqIdentity, sentId));
    if (ours) {
      const ledgerUpdated = await updateLedger(auth.pqIdentity, auth.leaf, { slot: auth.slot, attested: true });
      return { status: "authorized", authorization: auth, leaf: auth.leaf, slot: auth.slot, ledgerUpdated };
    }
    // Another signature wrote it: ours only burned its leaf if it landed at all.
    const identity = leafKnownUsed ? null : await fetchIdentity(conn, opts.lmsPublicKey!);
    if (!leafKnownUsed && (identity === null || !leafUsed(identity.used, opts.leaf!))) {
      const ledgerUpdated = await updateLedger(auth.pqIdentity, auth.leaf, { slot: auth.slot, attested: true });
      return { status: "authorized", authorization: auth, leaf: auth.leaf, slot: auth.slot, ledgerUpdated };
    }
    const reasons: AuthorizeBurnReason[] = [];
    if (l !== null && !bytesEqual(l.pqIdentity, sentId!)) reasons.push("wrong-identity");
    reasons.push("already-authorized");
    const ledgerUpdated = await updateLedger(sentId!, opts.leaf!, { attested: false });
    return { status: "burned", leaf: opts.leaf!, detail: burnDetail(opts.leaf!, reasons), reasons, authorization: auth, ledgerUpdated };
  }

  if (opts.leaf === undefined || sentId === null) {
    return { status: "pending", detail: "the authorization is not written; pass the leaf and the key that signed to tell a landing that only burned its leaf from one that has not landed" };
  }
  if (!leafKnownUsed) {
    const identity = await fetchIdentity(conn, opts.lmsPublicKey!);
    if (identity === null || !leafUsed(identity.used, opts.leaf)) {
      return { status: "pending", detail: `leaf ${opts.leaf} is not used on-chain: the transaction has not landed (re-send the same signature; never sign again)` };
    }
  }
  const reasons: AuthorizeBurnReason[] = l !== null && !bytesEqual(l.pqIdentity, sentId) ? ["wrong-identity"] : [];
  const ledgerUpdated = await updateLedger(sentId, opts.leaf, { attested: false });
  return { status: "burned", leaf: opts.leaf, detail: burnDetail(opts.leaf, reasons), reasons, authorization: auth, ledgerUpdated };
}

/** `sendPqAuthorizeTx` refused before sending (nothing was broadcast). */
export class AuthorizePayerFundingError extends Error {
  readonly balance: bigint;
  readonly required: bigint;
  constructor(message: string, balance: bigint, required: bigint) {
    super(message);
    this.name = "AuthorizePayerFundingError";
    this.balance = balance;
    this.required = required;
  }
}

/** `sendPqAuthorizeTx` options. */
export interface SendPqAuthorizeOptions {
  /** Updated with what landed (`confirmAuthorization`). */
  readonly ledger?: LeafLedger | undefined;
  readonly skipPreflight?: boolean | undefined;
  /**
   * A freeze (kind 2): the `notAfter` it signed (default: the built
   * transaction's `freezeNotAfter`; a different value is refused). It is not
   * sent when the cluster clock plus `freezeLandingMarginSecs` is past it.
   */
  readonly freezeNotAfter?: bigint | undefined;
  /** A freeze: seconds kept to use it after it lands (default 0: refused only once the clock is past `freezeNotAfter`). */
  readonly freezeLandingMarginSecs?: bigint | undefined;
}

/**
 * Send a built authorization and report what became of it
 * (`confirmAuthorization`, with the ledger updated). A freeze (kind 2) is
 * not sent once the cluster clock (plus `freezeLandingMarginSecs`) is past
 * its `freezeNotAfter`: the autopilot would never accept it, and landing it
 * would only burn its leaf and the rent. Before sending it checks
 * the payer's balance: at least the fee plus the rent of the accounts that do
 * not exist yet, and a remainder of 0 or at least the rent-exempt minimum
 * (the runtime refuses to leave a fee payer below it). ConstraintSeeds (2006;
 * nothing written, no leaf burned) is answered once by the SAME signature
 * with the accounts derived again (`rewrapPqAuthorizeTx`); PqLeafUsed (6041)
 * means this leaf already landed: the outcome is read from the accounts. If
 * nothing landed, it throws; rebuild with the same inputs (same leaf, same
 * bytes) and send again.
 */
export async function sendPqAuthorizeTx(conn: Connection, built: PqAuthorizeReady, opts: SendPqAuthorizeOptions = {}): Promise<AuthorizationOutcome> {
  if (built === null || typeof built !== "object" || built.status !== "ready") throw new TypeError("only a built authorize transaction (status ready) can be sent");
  if (built.kind === AUTHORIZATION.KINDS.GRAPH_FREEZE) {
    const signed = built.freezeNotAfter ?? null;
    if (opts.freezeNotAfter !== undefined) {
      checkUnixSecs("freezeNotAfter", opts.freezeNotAfter);
      if (signed !== null && opts.freezeNotAfter !== signed) throw new Error(`freezeNotAfter ${opts.freezeNotAfter} is not the time this freeze approval signed (${signed})`);
    }
    const notAfter = opts.freezeNotAfter ?? signed;
    if (notAfter !== null) {
      const margin = opts.freezeLandingMarginSecs ?? 0n;
      checkMargin("freezeLandingMarginSecs", margin);
      const now = await clusterUnixTime(conn);
      if (checkFreezeWindow(now + margin, notAfter) !== null) {
        throw new Error(
          `refusing to send: this freeze approval expired at ${unixTimeText(notAfter)} (cluster time ${now}${margin === 0n ? "" : `, plus ${margin} s to use it`}): landing it would only burn its leaf. Plan a new freeze and sign it again`,
        );
      }
    }
  } else if (opts.freezeNotAfter !== undefined || opts.freezeLandingMarginSecs !== undefined) {
    throw new TypeError(`freezeNotAfter and freezeLandingMarginSecs are for a freeze (kind 2), not kind ${built.kind}`);
  }
  const fee = LAMPORTS_PER_SIGNATURE + (built.priorityFeeLamports ?? 0n);
  const rent = await authorizeRentLamports(conn, { launch: built.launch, lmsPublicKey: built.lmsPublicKey, kind: built.kind, payloadHash: built.payloadHash });
  const required = rent.identity + rent.authorization + fee;
  const balance = BigInt(await conn.getBalance(built.payer.publicKey, "confirmed"));
  if (balance < required) {
    throw new AuthorizePayerFundingError(`the throwaway payer holds ${balance} lamports; it needs ${required} (fund it first)`, balance, required);
  }
  const floor = await rentExemptLamports(conn, 0);
  if (balance > required && balance - required < floor) {
    throw new AuthorizePayerFundingError(
      `the throwaway payer would keep ${balance - required} lamports, below the rent-exempt minimum of ${floor}: the runtime would refuse the transaction (fund exactly ${required}, or at least ${required + floor})`,
      balance,
      required,
    );
  }
  const send = async (b: PqAuthorizeReady): Promise<unknown> => {
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
    sendError = await send(await rewrapPqAuthorizeTx(conn, built));
  }
  const outcome = await confirm(conn, built.launch, built.kind, built.payloadHash, { leaf: built.leaf, lmsPublicKey: built.lmsPublicKey, ledger: opts.ledger }, sendError !== null && customErrorCode(sendError) === PQ_LEAF_USED);
  if (outcome.status === "pending" && sendError !== null) {
    const refused = customErrorCode(sendError) === CONSTRAINT_SEEDS ? " The program refused the accounts twice (ConstraintSeeds): nothing was burned." : "";
    throw new Error(
      `the authorization did not land (${sendError instanceof Error ? sendError.message : String(sendError)}).${refused} Rebuild with the same inputs (same leaf, same signature bytes) and send again; never sign a new message for it`,
      { cause: sendError },
    );
  }
  return outcome;
}

// ----------------------------------------------------------- verification ---

/** What `verifyAuthorization` checks an authorization against (account state only). */
export interface VerifyAuthorizationContext {
  readonly launch: Pick<LaunchAccount, "publicKey" | "creator" | "pqIdentity">;
  /** The identity account of the launch's identity (its key and used-leaf bitmap). */
  readonly identity: Pick<IdentityAccount, "lmsPublicKey" | "used">;
  readonly expectedKind?: number | undefined;
  readonly expectedPayloadHash?: Uint8Array | undefined;
}

/**
 * Re-verify an authorization from account state alone (no RPC): it is
 * written (version 1) for this launch at `["auth", launch, [kind],
 * payloadHash]`; the 140-byte message rebuilt from the launch (its creator)
 * hashes to the stored `messageHash`; `identityId(pk)` equals the stored
 * `pqIdentity` and the launch's; the stored leaf's bit is set; the stored LMS
 * signature verifies over the message at the stored leaf; the kind (one of
 * 1, 2, 3) and the payload are the expected ones. `leaf` is the leaf the
 * signature verifies at (null if it does not); `message` the rebuilt bytes.
 */
export function verifyAuthorization(auth: AuthorizationAccount, ctx: VerifyAuthorizationContext): { ok: boolean; problems: string[]; leaf: number | null; message: Uint8Array } {
  const problems: string[] = [];
  const { launch, identity } = ctx;
  checkBytes("identity public key", identity.lmsPublicKey, LMS_PUBLIC_KEY_LEN);
  if (!auth.authorized || auth.version !== AUTHORIZATION.VERSION) problems.push(`the authorization is not written (version ${auth.version}: a landing that only burned its leaf)`);
  if (!auth.launch.equals(launch.publicKey)) problems.push(`the authorization is for launch ${auth.launch.toBase58()}, not ${launch.publicKey.toBase58()}`);
  if (auth.kind !== 1 && auth.kind !== 2 && auth.kind !== 3) problems.push(`kind ${auth.kind} is not one the autopilot reads`);
  if (ctx.expectedKind !== undefined && auth.kind !== ctx.expectedKind) problems.push(`the authorization is of kind ${auth.kind}, expected ${ctx.expectedKind}`);
  if (ctx.expectedPayloadHash !== undefined && !bytesEqual(auth.payloadHash, ctx.expectedPayloadHash)) problems.push("the authorization approves another change (payload hash differs)");
  if (!authorizationAddress(launch.publicKey, auth.kind, auth.payloadHash).equals(auth.publicKey)) problems.push("the authorization is not at the canonical address of its launch, kind and payload");
  const message = authorizationMessage({ launch: launch.publicKey, creator: launch.creator, kind: auth.kind, payloadHash: auth.payloadHash });
  if (!bytesEqual(sha256(message), auth.messageHash)) problems.push("the stored message hash is not the hash of this launch's authorization message");
  const id = identityId(identity.lmsPublicKey);
  if (!bytesEqual(id, auth.pqIdentity)) problems.push("the authorization's identity is not this key's");
  if (!bytesEqual(launch.pqIdentity, auth.pqIdentity)) problems.push("the authorization's identity is not the one the launch names");
  if (!Number.isInteger(auth.leaf) || auth.leaf < 0 || auth.leaf >= PQ_IDENTITY.LEAVES) problems.push(`leaf ${auth.leaf} is out of range`);
  else if (!leafUsed(identity.used, auth.leaf)) problems.push(`leaf ${auth.leaf} is not set in the identity's bitmap`);
  let leaf: number | null = null;
  if (auth.signature.length !== LMS_SIGNATURE_LEN) problems.push(`the signature is ${auth.signature.length} bytes, expected ${LMS_SIGNATURE_LEN}`);
  else {
    leaf = lmsVerify(identity.lmsPublicKey, message, auth.signature);
    if (leaf === null) problems.push("the LMS signature does not verify over the message");
    else if (leaf !== auth.leaf) problems.push(`the signature verifies at leaf ${leaf}, but the authorization records leaf ${auth.leaf}`);
  }
  return { ok: problems.length === 0, problems, leaf, message };
}

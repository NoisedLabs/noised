/**
 * `publish_metadata`: the throwaway fee payer that later sends
 * `attest_launch` writes the token's metadata record first, in one v1
 * transaction (309-3,621 bytes; measured 12.7k-23.8k compute units).
 *
 * ```text
 * creator wallet (legacy)  create_launch, then fund the throwaway payer (buildFundThrowawayPayerTx)
 * throwaway payer (v1)     publish_metadata(name, symbol, flags, uri, doc)   -> TokenMeta ["metadata", launch, H]
 *                          wait until the record is FINALIZED (waitForTokenMeta)
 * throwaway payer (v1)     attest_launch(..., H, window)                     (buildAttestLaunchTx)
 * throwaway payer          buildSweepPayerTx: what is left goes back to the creator
 * ```
 *
 * The instruction is permissionless and idempotent: the address is the
 * content's hash, so a record already there holds exactly these bytes (a
 * repeat succeeds without writing, and `buildPublishMetadataTx` says so
 * instead of building), and an address pre-funded by anyone is taken over.
 * It is accepted only while the launch is `Configured` (WrongLaunchState
 * 6018 otherwise). Records are never modified or closed: an abandoned one
 * costs its payer its rent.
 */
import { Keypair, PublicKey, SystemProgram, Transaction, type Commitment, type Connection, type TransactionInstruction } from "@solana/web3.js";

import { encodeBase58 } from "../codec/base58.js";
import { bytesEqual, concatBytes, isU64 } from "../codec/bytes.js";
import { buildInstruction } from "../codec/ix.js";
import { METADATA, PROGRAM_IDS } from "../constants.js";
import { idlCodecs } from "../idl/index.js";
import { decodeLaunch, fetchLaunchRules } from "../launch/accounts.js";
import { launchRulesRentDue, launchRulesSpace, publishRulesFeeLamports } from "../launch/rules.js";
import { rulesHash as rulesHashOf } from "../programmable/hash.js";
import { tokenMetaAddress } from "../pda.js";
import { attestFeeLamports, attestRentLamports, type AttestTxOptions } from "../pq/attest.js";
import { computeUnitLimitOf, computeUnitPriceOf, priorityFeeLamports, type ComputeBudgetOptions } from "../rpc/computeBudget.js";
import { getAccount, ownedBy } from "../rpc/fetch.js";
import { LAMPORTS_PER_SIGNATURE, rentExemptLamports, sendAndConfirm } from "../rpc/index.js";
import { compileV1Message, signV1Message, V1_MAX_TRANSACTION_SIZE } from "../tx/v1.js";
import {
  fetchTokenMeta,
  metadataHashV2,
  tokenMetaBorsh,
  tokenMetaRecord,
  tokenMetaSpace,
  utf8Text,
  validateTokenMeta,
  type TokenMetaAccount,
  type TokenMetaInput,
  type TokenMetaRecord,
} from "./record.js";

/** v1 compute-unit limit of `publish_metadata` (measured at most 23.8k). */
export const PUBLISH_COMPUTE_UNITS = METADATA.PUBLISH_COMPUTE_UNITS;
/** v1 loaded-accounts-data limit of `publish_metadata`. */
export const PUBLISH_LOADED_ACCOUNTS_BYTES = METADATA.PUBLISH_LOADED_ACCOUNTS_BYTES;

function checkPublicKey(name: string, k: unknown): asserts k is PublicKey {
  if (!(k instanceof PublicKey)) throw new TypeError(`${name} must be a PublicKey`);
}

/** The text of record bytes that are UTF-8 (a BOM kept), for the IDL's string arguments. */
function text(field: string, b: Uint8Array): string {
  const t = utf8Text(b);
  if (t === null) throw new Error(`${field} is not valid UTF-8`);
  return t;
}

/**
 * The `publish_metadata` instruction: data = discriminator
 * `b3bfa861c719e592` || borsh(name, symbol, flags u8, uri, doc); accounts
 * `[payer (signer, writable), launch, token_meta (writable) = ["metadata",
 * launch, metadataHashV2(record)], system program]`. Pure; it does not
 * validate the record (`validateTokenMeta`), but refuses text that is not
 * UTF-8 (the program could not decode it).
 */
export function publishMetadataInstruction(payer: PublicKey, launch: PublicKey, input: TokenMetaInput): TransactionInstruction {
  checkPublicKey("payer", payer);
  checkPublicKey("launch", launch);
  const r = tokenMetaRecord(input);
  const ix = buildInstruction(
    idlCodecs().launchpad,
    PROGRAM_IDS.launchpad,
    "publish_metadata",
    { payer, launch, tokenMeta: tokenMetaAddress(launch, metadataHashV2(r)) },
    { name: text("name", r.name), symbol: text("symbol", r.symbol), flags: r.flags, uri: text("uri", r.uri), doc: text("doc", r.doc) },
  );
  // The IDL encoding must be exactly the record's borsh (what the hash covers).
  if (!bytesEqual(Uint8Array.from(ix.data.subarray(8)), tokenMetaBorsh(r))) throw new Error("publish_metadata data is not the record's borsh encoding");
  return ix;
}

/** Priority fee and v1 limits of the publish transaction. */
export interface PublishTxOptions extends ComputeBudgetOptions {
  /** v1 loaded-accounts-data limit (default `PUBLISH_LOADED_ACCOUNTS_BYTES`, 2 MiB). */
  loadedAccountsDataSizeLimit?: number | undefined;
}

/** The v1 config of a publish transaction: compute limit (default 100,000), loaded-data limit, and the priority fee in lamports (null: none). */
export function publishTxConfig(opts: PublishTxOptions = {}): { computeUnitLimit: number; loadedAccountsDataSizeLimit: number; priorityFeeLamports: bigint | null } {
  const computeUnitLimit = computeUnitLimitOf(opts, PUBLISH_COMPUTE_UNITS);
  const price = computeUnitPriceOf(opts);
  const loadedAccountsDataSizeLimit = opts.loadedAccountsDataSizeLimit ?? PUBLISH_LOADED_ACCOUNTS_BYTES;
  if (!Number.isInteger(loadedAccountsDataSizeLimit) || loadedAccountsDataSizeLimit < 1 || loadedAccountsDataSizeLimit > 0xffff_ffff) {
    throw new RangeError("loadedAccountsDataSizeLimit must be a positive u32");
  }
  return { computeUnitLimit, loadedAccountsDataSizeLimit, priorityFeeLamports: price === null || price === 0n ? null : priorityFeeLamports(price, computeUnitLimit) };
}

/** The fee a publish transaction pays: one signature (5,000 lamports) plus its priority fee. */
export function publishFeeLamports(opts: PublishTxOptions = {}): bigint {
  return LAMPORTS_PER_SIGNATURE + (publishTxConfig(opts).priorityFeeLamports ?? 0n);
}

/** Compile and sign `ix` (a `publish_metadata` instruction) as a v1 transaction paid by `payer` alone. Pure. */
function signPublish(payer: Keypair, ix: TransactionInstruction, recentBlockhash: string, opts: PublishTxOptions): { tx: Uint8Array; signature: string } {
  const config = publishTxConfig(opts);
  const message = compileV1Message(payer.publicKey, [ix], recentBlockhash, {
    computeUnitLimit: config.computeUnitLimit,
    loadedAccountsDataSizeLimit: config.loadedAccountsDataSizeLimit,
    ...(config.priorityFeeLamports === null ? {} : { priorityFeeLamports: config.priorityFeeLamports }),
  });
  if (message.header.numRequiredSignatures !== 1) throw new Error("a publish transaction is signed by its fee payer alone");
  const tx = signV1Message(message, [payer]);
  return { tx, signature: encodeBase58(tx.subarray(message.bytes.length, message.bytes.length + 64)) };
}

/**
 * Exact wire size (bytes) of the publish transaction of this record:
 * `307 + name + symbol + uri + doc` (UTF-8 bytes), plus 8 with a priority
 * fee. The largest record (3,314 bytes of strings) gives 3,621; the limit is
 * 4,096.
 */
export function publishTransactionSize(input: TokenMetaInput, opts: { readonly priorityFee?: boolean } = {}): number {
  const r = tokenMetaRecord(input);
  const key = (b: number): PublicKey => new PublicKey(new Uint8Array(32).fill(b));
  const empty: TokenMetaRecord = { name: new Uint8Array(0), symbol: new Uint8Array(0), flags: 0, uri: new Uint8Array(0), doc: new Uint8Array(0) };
  const message = compileV1Message(key(1), [publishMetadataInstruction(key(1), key(2), empty)], encodeBase58(new Uint8Array(32)), {
    computeUnitLimit: PUBLISH_COMPUTE_UNITS,
    loadedAccountsDataSizeLimit: PUBLISH_LOADED_ACCOUNTS_BYTES,
    ...(opts.priorityFee === true ? { priorityFeeLamports: 1n } : {}),
  });
  return message.bytes.length + 64 * message.header.numRequiredSignatures + r.name.length + r.symbol.length + r.uri.length + r.doc.length;
}

/** `buildPublishMetadataTx` arguments. */
export interface PublishMetadataArgs extends PublishTxOptions {
  readonly launch: PublicKey;
  /** The throwaway fee payer that will also send `attest_launch` (it pays the fee and the record's rent). */
  readonly payer: Keypair;
  /** The record (`buildMetadataDoc` writes its document). */
  readonly metadata: TokenMetaInput;
}

interface PublishCommon {
  readonly launch: PublicKey;
  /** The record's exact bytes. */
  readonly record: TokenMetaRecord;
  /** `metadataHashV2(record)`: what the attestation signs. */
  readonly metadataHash: Uint8Array;
  /** The record's address, `["metadata", launch, metadataHash]`. */
  readonly tokenMeta: PublicKey;
}

/** A signed publish transaction, ready to fund and send. */
export interface PublishMetadataReady extends PublishCommon {
  readonly status: "ready";
  /** Signed v1 wire bytes. */
  readonly tx: Uint8Array;
  /** Transaction id. */
  readonly signature: string;
  readonly payer: Keypair;
  readonly blockhash: string;
  readonly lastValidBlockHeight: number;
  readonly sizeBytes: number;
  readonly computeUnitLimit: number;
  readonly priorityFeeLamports: bigint | null;
  /** The record's rent still to pay: `rent(91 + strings)` read from the cluster, less what its address already holds (anyone may pre-fund it). */
  readonly rentLamports: bigint;
  /** What `payer` needs for this transaction: that rent plus the fee (fund the attestation too: `throwawayPayerFunding`). */
  readonly fundingLamports: bigint;
}

/** The record is already published (by anyone): nothing to send. */
export interface PublishMetadataAlreadyPublished extends PublishCommon {
  readonly status: "already-published";
  readonly account: TokenMetaAccount;
}

export type PublishMetadataTx = PublishMetadataReady | PublishMetadataAlreadyPublished;

/**
 * The signed v1 `publish_metadata` transaction of `args.metadata` for
 * `args.launch`, from the throwaway payer. Refuses, before signing: a record
 * the program would refuse (`validateTokenMeta`: the first error is the
 * program's), a launch that does not exist or is already live
 * (WrongLaunchState), and a transaction over 4,096 bytes. A record already
 * published at its address is reported as `already-published` (publishing
 * is idempotent). Send with `sendPublishMetadataTx`.
 */
export async function buildPublishMetadataTx(conn: Connection, args: PublishMetadataArgs): Promise<PublishMetadataTx> {
  checkPublicKey("launch", args.launch);
  if (!(args.payer instanceof Keypair)) throw new TypeError("payer must be a Keypair (the throwaway fee payer)");
  const v = validateTokenMeta(args.metadata);
  if (!v.ok) throw new Error(`refusing to publish: publish_metadata would fail with ${v.error!.name} (${v.error!.code}):\n${v.errors.join("\n")}`);
  const record = tokenMetaRecord(args.metadata);
  const metadataHash = metadataHashV2(record);
  const tokenMeta = tokenMetaAddress(args.launch, metadataHash);
  const common: PublishCommon = { launch: args.launch, record, metadataHash, tokenMeta };
  const config = publishTxConfig(args);
  const size = publishTransactionSize(record, { priorityFee: config.priorityFeeLamports !== null });
  if (size > V1_MAX_TRANSACTION_SIZE) throw new Error(`refusing to publish: the transaction would be ${size} bytes (limit ${V1_MAX_TRANSACTION_SIZE})`);

  const launchAcc = ownedBy(await getAccount(conn, args.launch), PROGRAM_IDS.launchpad, "Launch");
  if (launchAcc === null) throw new Error(`refusing to publish: launch ${args.launch.toBase58()} does not exist`);
  if (decodeLaunch(args.launch, launchAcc.data).status !== "configured") throw new Error("refusing to publish: the launch is already live (WrongLaunchState): records are published before it goes live");
  const existing = await fetchTokenMeta(conn, args.launch, metadataHash);
  if (existing !== null) return { ...common, status: "already-published", account: existing };

  const rentLamports = await recordRentDue(conn, tokenMeta, record);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const signed = signPublish(args.payer, publishMetadataInstruction(args.payer.publicKey, args.launch, record), blockhash, args);
  return {
    ...common,
    status: "ready",
    tx: signed.tx,
    signature: signed.signature,
    payer: args.payer,
    blockhash,
    lastValidBlockHeight,
    sizeBytes: signed.tx.length,
    computeUnitLimit: config.computeUnitLimit,
    priorityFeeLamports: config.priorityFeeLamports,
    rentLamports,
    fundingLamports: rentLamports + publishFeeLamports(args),
  };
}

/** The record's rent still to pay at `address`: `rent(91 + strings)` less the lamports the address already holds (a pre-funded address is taken over). */
async function recordRentDue(conn: Connection, address: PublicKey, record: TokenMetaRecord): Promise<bigint> {
  const [rent, held] = await Promise.all([rentExemptLamports(conn, tokenMetaSpace(record)), getAccount(conn, address)]);
  const lamports = BigInt(held?.lamports ?? 0);
  return lamports >= rent ? 0n : rent - lamports;
}

/** `sendPublishMetadataTx` refused before sending (nothing was broadcast): the payer cannot pay, or would keep a remainder the runtime refuses. */
export class PublishPayerFundingError extends Error {
  readonly balance: bigint;
  readonly required: bigint;
  constructor(message: string, balance: bigint, required: bigint) {
    super(message);
    this.name = "PublishPayerFundingError";
    this.balance = balance;
    this.required = required;
  }
}

/** `waitForTokenMeta` options. */
export interface WaitForTokenMetaOptions {
  /** The commitment to wait for (default `finalized`: what `buildAttestLaunchTx` requires by default). */
  readonly commitment?: "finalized" | "confirmed" | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Pause between two reads, in ms (default 2,000). */
  readonly pollIntervalMs?: number | undefined;
  /** Give up after this many ms (default 90,000). */
  readonly timeoutMs?: number | undefined;
  /** Sleep function (default `setTimeout`). */
  readonly sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Resolve with the record `metadataHash` names for `launch` once it is
 * visible at `opts.commitment` (default `finalized`, about 13 s after it was
 * confirmed), polling. Throws on timeout or abort. Send `attest_launch` only
 * after this: a record lost in a dropped fork turns the attestation into a
 * burn.
 */
export async function waitForTokenMeta(conn: Connection, launch: PublicKey, metadataHash: Uint8Array, opts: WaitForTokenMetaOptions = {}): Promise<TokenMetaAccount> {
  const poll = opts.pollIntervalMs ?? 2_000;
  const timeout = opts.timeoutMs ?? 90_000;
  if (!Number.isFinite(poll) || poll <= 0) throw new RangeError("pollIntervalMs must be positive");
  if (!Number.isFinite(timeout) || timeout < 0) throw new RangeError("timeoutMs must be non-negative");
  const sleep = opts.sleep ?? defaultSleep;
  const commitment: Commitment = opts.commitment ?? "finalized";
  for (let waited = 0; ; waited += poll) {
    if (opts.signal?.aborted === true) throw opts.signal.reason ?? new Error("aborted");
    const record = await fetchTokenMeta(conn, launch, metadataHash, { commitment });
    if (record !== null) return record;
    if (waited >= timeout) throw new Error(`the metadata record ${tokenMetaAddress(launch, metadataHash).toBase58()} is not ${commitment} after ${timeout} ms`);
    await sleep(poll, opts.signal);
  }
}

/**
 * Send a built publish transaction and wait until the record is visible at
 * `opts.commitment` (default `confirmed`; pass `finalized` to wait, or call
 * `waitForTokenMeta` before attesting). Before sending it checks the payer's
 * balance (`PublishPayerFundingError`): at least the fee plus the record's
 * rent still due, and a remainder of 0 or at least the rent-exempt minimum
 * (the runtime refuses to leave a fee payer below it; fund with
 * `throwawayPayerFunding`, which keeps that floor when the attestation's
 * accounts already exist). A send that fails while the record is there
 * anyway (published by a racing copy) still returns the record.
 */
export async function sendPublishMetadataTx(
  conn: Connection,
  built: PublishMetadataReady,
  opts: { readonly commitment?: "confirmed" | "finalized" | undefined; readonly skipPreflight?: boolean | undefined } = {},
): Promise<TokenMetaAccount> {
  if (built === null || typeof built !== "object" || built.status !== "ready") throw new TypeError("only a built publish transaction (status ready) can be sent");
  const fee = LAMPORTS_PER_SIGNATURE + (built.priorityFeeLamports ?? 0n);
  const [rentDue, balance, floor] = await Promise.all([
    recordRentDue(conn, built.tokenMeta, built.record),
    conn.getBalance(built.payer.publicKey, "confirmed").then((b) => BigInt(b)),
    rentExemptLamports(conn, 0),
  ]);
  const required = rentDue + fee;
  if (balance < required) {
    throw new PublishPayerFundingError(`the throwaway payer holds ${balance} lamports; publishing needs ${required} (fund it with buildFundThrowawayPayerTx)`, balance, required);
  }
  if (balance > required && balance - required < floor) {
    throw new PublishPayerFundingError(
      `the throwaway payer would keep ${balance - required} lamports, below the rent-exempt minimum of ${floor}: the runtime would refuse the transaction (fund it with throwawayPayerFunding)`,
      balance,
      required,
    );
  }
  let sendError: unknown = null;
  try {
    await sendAndConfirm(conn, built.tx, { lastValidBlockHeight: built.lastValidBlockHeight, skipPreflight: opts.skipPreflight ?? false, commitment: opts.commitment ?? "confirmed" });
  } catch (e) {
    sendError = e;
  }
  const record = await fetchTokenMeta(conn, built.launch, built.metadataHash, { commitment: opts.commitment ?? "confirmed" });
  if (record !== null) return record;
  if (sendError !== null) throw new Error(`publish_metadata did not land (${sendError instanceof Error ? sendError.message : String(sendError)}): build it again and send`, { cause: sendError });
  throw new Error("publish_metadata was confirmed but the record is not visible yet: read it again with waitForTokenMeta");
}

// ---------------------------------------------------- the throwaway payer ---

/** `throwawayPayerFunding` options. */
export interface ThrowawayPayerFundingOptions {
  /** The record to publish first (omit when it is published already, or by someone else). */
  readonly metadata?: TokenMetaInput | undefined;
  /** The creator rules (PXR1 bytes) to publish first with `buildPublishRulesV1Tx` (omit for none, or when published already). */
  readonly rules?: Uint8Array | null | undefined;
  /** Fee options of the rules' publish transaction. */
  readonly publishRules?: ComputeBudgetOptions | undefined;
  /** With `lmsPublicKey`: count only the accounts that do not exist yet (the record too). Else an upper bound. */
  readonly launch?: PublicKey | undefined;
  readonly lmsPublicKey?: Uint8Array | undefined;
  /** Fee options of the publish transaction (the same as `buildPublishMetadataTx`'s). */
  readonly publish?: PublishTxOptions | undefined;
  /** Fee options of the attest transaction (the same as `buildAttestLaunchTx`'s). */
  readonly attest?: AttestTxOptions | undefined;
}

/** What a throwaway payer needs to publish a record and land one attestation, item by item (lamports, rents read from the cluster). */
export interface ThrowawayPayerFunding {
  /** The total: fund exactly this (a fee payer must end every transaction at 0 or rent-exempt). */
  readonly lamports: bigint;
  /** `rent(91 + strings)` of the record still to pay (0 when it is published already or not asked for; less what a pre-funded address holds, given `launch`). */
  readonly tokenMetaRent: bigint;
  /** `rent(196)` of the identity account (0 once it exists). */
  readonly identityRent: bigint;
  /** `rent(2,708)` of the attestation account (0 once it exists). */
  readonly attestationRent: bigint;
  /** The publish transaction's fee (0 when nothing is published). */
  readonly publishFee: bigint;
  /** `rent(78 + len)` of the rules record still to pay (0 without rules, or when they are published already). */
  readonly rulesRent: bigint;
  /** The rules' publish transaction fee (0 when no rules are published). */
  readonly publishRulesFee: bigint;
  readonly attestFee: bigint;
  /**
   * The rent-exempt minimum of an empty account, kept on the payer when the
   * publish would otherwise leave it with less (the identity and the
   * attestation exist already: a new opening time, a retry): it must stay
   * rent-exempt between the two transactions. 0 otherwise. What is left
   * after the attestation goes back with `buildSweepPayerTx`.
   */
  readonly rentFloor: bigint;
}

/**
 * What the throwaway payer needs for `publish_metadata` and `attest_launch`
 * together: the record's rent and the publish fee (with `metadata`), the
 * identity's and the attestation's rents, and the attest fee. Rents come
 * from `getMinimumBalanceForRentExemption`, never hard-coded. With `launch`
 * and `lmsPublicKey`, accounts that already exist (the record, the
 * identity, the attestation) are not counted, nor what a pre-funded record
 * address holds. When the publish would leave less than the rent-exempt
 * minimum for the attestation (both its accounts exist), that minimum is
 * added (`rentFloor`): the runtime refuses a fee payer left with a balance
 * below it. The typical record (1,244 bytes) at mainnet's 5,080 lamports
 * per byte: 6,969,760 + 1,645,920 + 14,406,880 lamports of rent and two
 * 5,000-lamport fees (23,032,560). With ules, the rules record's rent
 * (ent(78 + len)) and the rules' publish fee are added.
 */
export async function throwawayPayerFunding(conn: Connection, opts: ThrowawayPayerFundingOptions = {}): Promise<ThrowawayPayerFunding> {
  const rent = await attestRentLamports(conn, opts.launch, opts.lmsPublicKey);
  let tokenMetaRent = 0n;
  let publishFee = 0n;
  if (opts.metadata !== undefined) {
    const v = validateTokenMeta(opts.metadata);
    if (!v.ok) throw new Error(`the metadata record is invalid (${v.error!.name}):\n${v.errors.join("\n")}`);
    const record = tokenMetaRecord(opts.metadata);
    const hash = metadataHashV2(record);
    const published = opts.launch !== undefined && (await fetchTokenMeta(conn, opts.launch, hash)) !== null;
    if (!published) {
      tokenMetaRent = opts.launch === undefined ? await rentExemptLamports(conn, tokenMetaSpace(record)) : await recordRentDue(conn, tokenMetaAddress(opts.launch, hash), record);
      publishFee = publishFeeLamports(opts.publish);
    }
  }
  let rulesRent = 0n;
  let publishRulesFee = 0n;
  if (opts.rules !== undefined && opts.rules !== null && opts.rules.length > 0) {
    const hash = rulesHashOf(opts.rules);
    const published = opts.launch !== undefined && (await fetchLaunchRules(conn, opts.launch, hash)) !== null;
    if (!published) {
      rulesRent = opts.launch === undefined ? await rentExemptLamports(conn, launchRulesSpace(opts.rules.length)) : await launchRulesRentDue(conn, opts.launch, opts.rules);
      publishRulesFee = publishRulesFeeLamports(opts.publishRules);
    }
  }
  const attestFee = attestFeeLamports(opts.attest);
  // Between the transactions the payer holds what the attestation needs: 0 or rent-exempt, never in between.
  const afterPublish = rent.identity + rent.attestation + attestFee;
  const floor = await rentExemptLamports(conn, 0);
  const rentFloor = publishFee + publishRulesFee > 0n && afterPublish < floor ? floor : 0n;
  return {
    lamports: tokenMetaRent + publishFee + rulesRent + publishRulesFee + afterPublish + rentFloor,
    tokenMetaRent,
    identityRent: rent.identity,
    attestationRent: rent.attestation,
    publishFee,
    rulesRent,
    publishRulesFee,
    attestFee,
    rentFloor,
  };
}

/**
 * The legacy transfer the creator's wallet signs to fund the throwaway
 * payer: `opts.lamports`, default `throwawayPayerFunding(conn, opts)`. The
 * wallet (`from`) is this transaction's fee payer.
 */
export async function buildFundThrowawayPayerTx(
  conn: Connection,
  from: PublicKey,
  payer: PublicKey,
  opts: ThrowawayPayerFundingOptions & { readonly lamports?: bigint | undefined } = {},
): Promise<{ tx: Transaction; lamports: bigint; funding: ThrowawayPayerFunding | null }> {
  checkPublicKey("from", from);
  checkPublicKey("payer", payer);
  if (from.equals(payer)) throw new Error("the throwaway payer must be a fresh key, not the funding wallet");
  const funding = opts.lamports === undefined ? await throwawayPayerFunding(conn, opts) : null;
  const lamports = opts.lamports ?? funding!.lamports;
  if (!isU64(lamports) || lamports === 0n) throw new RangeError("lamports must be a positive u64");
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: from, toPubkey: payer, lamports }));
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.feePayer = from;
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  return { tx, lamports, funding };
}

/**
 * Return everything left on the throwaway payer to `to` (the creator), minus
 * this transaction's fee: a legacy transfer signed by `payer`, ready to
 * send; null when nothing is left above the fee. Run it once the attestation
 * is confirmed (attested or burned) and nothing else is pending: a sweep
 * before the attestation lands would leave it unfunded.
 */
export async function buildSweepPayerTx(conn: Connection, payer: Keypair, to: PublicKey): Promise<{ tx: Transaction; lamports: bigint } | null> {
  if (!(payer instanceof Keypair)) throw new TypeError("payer must be the throwaway Keypair");
  checkPublicKey("to", to);
  if (to.equals(payer.publicKey)) throw new Error("sweep to another account (the creator's wallet)");
  const balance = BigInt(await conn.getBalance(payer.publicKey, "confirmed"));
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const probe = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports: 0n }));
  probe.feePayer = payer.publicKey;
  probe.recentBlockhash = blockhash;
  const fee = (await conn.getFeeForMessage(probe.compileMessage(), "confirmed")).value;
  if (fee === null) throw new Error("could not price the sweep transaction");
  const lamports = balance - BigInt(fee);
  if (lamports <= 0n) return null;
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports }));
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.sign(payer);
  return { tx, lamports };
}

/** `publish_metadata`'s instruction data for a record: discriminator `b3bfa861c719e592` || the record's borsh. */
export function publishMetadataData(input: TokenMetaInput): Uint8Array {
  const def = idlCodecs().launchpad.instruction("publish_metadata");
  return concatBytes([Uint8Array.from(def.discriminator), tokenMetaBorsh(input)]);
}

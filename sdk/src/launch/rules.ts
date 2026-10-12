/**
 * `publish_rules` (P1c): a launch's creator rules (PXR1 bytes, see
 * `../programmable`) written whole, on-chain, at `["rules", launch,
 * rules_hash]` with `rules_hash = SHA256("PHX-RULES-V1" || bytes)`, before
 * the identity signs the attestation that names them.
 *
 * ```text
 * creator wallet (legacy)  create_launch, then fund the throwaway payer (buildFundThrowawayPayerTx, with `rules`)
 * throwaway payer (v1)     publish_metadata(...)                    -> TokenMeta    ["metadata", launch, M]
 * throwaway payer (v1)     publish_rules(bytes)                     -> LaunchRules  ["rules", launch, R]
 *                          wait until both records are FINALIZED (waitForTokenMeta, waitForLaunchRules)
 * throwaway payer (v1)     attest_launch(..., M, R, window)         (buildAttestLaunchTx with `rulesHash: R`)
 * anyone (legacy)          launch: the 23rd account is the rules record (buildLaunchTx)
 * ```
 *
 * The instruction is permissionless and idempotent: the address is the
 * content, so a record already there holds exactly these bytes (a repeat
 * succeeds without writing; the builders report `already-published`), and
 * an address pre-funded by anyone is taken over. It is accepted only while
 * the launch is `Configured` (WrongLaunchState 6018) and only for bytes that
 * verify for the launch's own guard (`InvalidRules` 6048): the builders
 * run the same verifier (`verifyRules` with the launch's `guard_secs`) first.
 * Records are never modified or closed. Anyone may publish any rules under a
 * launch: only the ones its identity signs are ever used, so resolve a
 * launch's rules through its attestation or certificate, never by searching.
 *
 * Sizes: a legacy transaction (any wallet pays; both compute-budget
 * instructions) carries up to `PUBLISH_RULES_LEGACY_MAX_BYTES` of rules; the
 * largest set (1,228 bytes) needs the v1 transaction from the throwaway
 * payer (`buildPublishRulesV1Tx`).
 */
import { Keypair, PublicKey, Transaction, type Commitment, type Connection, type TransactionInstruction } from "@solana/web3.js";

import { encodeBase58 } from "../codec/base58.js";
import { bytesEqual } from "../codec/bytes.js";
import { buildInstruction } from "../codec/ix.js";
import { LAUNCH_RULES, PROGRAM_IDS } from "../constants.js";
import { idlCodecs } from "../idl/index.js";
import { launchRulesAddress, launchRulesPda } from "../pda.js";
import { verifyRules } from "../programmable/rules/codec.js";
import { rulesHash } from "../programmable/hash.js";
import { computeBudgetInstructions, computeUnitLimitOf, computeUnitPriceOf, priorityFeeLamports, type ComputeBudgetOptions } from "../rpc/computeBudget.js";
import { getAccount, ownedBy, type RawAccount } from "../rpc/fetch.js";
import { LAMPORTS_PER_SIGNATURE, LEGACY_MAX_TRANSACTION_SIZE, rentExemptLamports, sendAndConfirm } from "../rpc/index.js";
import { compileV1Message, signV1Message, V1_MAX_TRANSACTION_SIZE } from "../tx/v1.js";
import type { LaunchRulesAccount } from "../types.js";
import { decodeLaunch, decodeLaunchRules, fetchLaunchRules } from "./accounts.js";

/** Legacy compute limit of `publish_rules` (measured 11.1k-17.6k CU). */
export const PUBLISH_RULES_COMPUTE_UNITS = LAUNCH_RULES.PUBLISH_COMPUTE_UNITS;
/** v1 loaded-accounts-data limit of `publish_rules`. */
export const PUBLISH_RULES_LOADED_ACCOUNTS_BYTES = LAUNCH_RULES.PUBLISH_LOADED_ACCOUNTS_BYTES;

function checkPublicKey(name: string, k: unknown): asserts k is PublicKey {
  if (!(k instanceof PublicKey)) throw new TypeError(`${name} must be a PublicKey`);
}

function checkRules(bytes: unknown): asserts bytes is Uint8Array {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("rules must be the PXR1 bytes (Uint8Array; compileRules gives them)");
  if (bytes.length === 0) throw new RangeError("empty rules: a launch without rules publishes nothing (attest with the zero rules hash)");
}

/** A rules record's account size: `78 + len` (its exact borsh encoding). */
export function launchRulesSpace(len: number): number {
  if (!Number.isInteger(len) || len < 0) throw new RangeError("len must be a non-negative integer");
  return LAUNCH_RULES.FIXED_LEN + len;
}

/**
 * The `publish_rules(bytes)` instruction: data = discriminator
 * `d5f586baa8198fe9` || u32le(len) || bytes; accounts `[payer (signer,
 * writable), launch, rules (writable) = ["rules", launch, rulesHash(bytes)],
 * system program]`. Pure (no verification: `verifyRules`).
 */
export function publishRulesInstruction(payer: PublicKey, launch: PublicKey, bytes: Uint8Array): TransactionInstruction {
  checkPublicKey("payer", payer);
  checkPublicKey("launch", launch);
  checkRules(bytes);
  return buildInstruction(idlCodecs().launchpad, PROGRAM_IDS.launchpad, "publish_rules", { payer, launch, rules: launchRulesAddress(launch, rulesHash(bytes)) }, { bytes });
}

/**
 * Whether `acc` (the account at `["rules", launch, rulesHash]`) is the rules
 * record that hash names, exactly as `attest_launch` decides it
 * (`pq::is_rules_record`): owned by the launchpad, the `LaunchRules`
 * discriminator, version 1, the address's canonical bump, this launch and
 * this hash. Anything else there (nothing, lamports someone sent, another
 * program's account) makes an attestation naming the hash burn-only. Never
 * throws.
 */
export function isLaunchRulesRecord(acc: RawAccount | null, launch: PublicKey, hash: Uint8Array): boolean {
  if (acc === null || !acc.owner.equals(PROGRAM_IDS.launchpad)) return false;
  const d = acc.data;
  const o = LAUNCH_RULES.OFFSETS;
  if (d.length < LAUNCH_RULES.FIXED_LEN) return false;
  if (!LAUNCH_RULES.DISCRIMINATOR.every((b, i) => d[i] === b)) return false;
  let bump: number;
  try {
    bump = launchRulesPda(launch, hash)[1];
  } catch {
    return false;
  }
  return d[o.VERSION] === LAUNCH_RULES.VERSION && d[o.BUMP] === bump && bytesEqual(d.subarray(o.LAUNCH, o.LAUNCH + 32), launch.toBytes()) && bytesEqual(d.subarray(o.RULES_HASH, o.RULES_HASH + 32), hash);
}

/** Whether the rules record `hash` names for `launch` exists and is valid at `commitment` (default `confirmed`). */
export async function launchRulesRecordExists(conn: Connection, launch: PublicKey, hash: Uint8Array, commitment: "confirmed" | "finalized" = "confirmed"): Promise<boolean> {
  return isLaunchRulesRecord(await getAccount(conn, launchRulesAddress(launch, hash), commitment), launch, hash);
}

// ------------------------------------------------------------------ sizes ---

const key = (b: number): PublicKey => new PublicKey(new Uint8Array(32).fill(b));

function measuredLegacySize(len: number, priorityFee: boolean): number {
  const tx = new Transaction();
  tx.add(...computeBudgetInstructions(priorityFee ? { computeUnitPrice: 1n } : {}, PUBLISH_RULES_COMPUTE_UNITS));
  tx.add(publishRulesInstruction(key(1), key(2), new Uint8Array(len)));
  tx.feePayer = key(1);
  tx.recentBlockhash = encodeBase58(new Uint8Array(32));
  const message = tx.compileMessage();
  return 1 + 64 * message.header.numRequiredSignatures + message.serialize().length;
}

/**
 * Exact wire size of a legacy `publish_rules` transaction of `len` rule
 * bytes, with both compute-budget instructions (12 bytes less without a
 * priority fee). Sizes over the 1,232-byte limit are computed (web3.js
 * cannot serialize them): beyond 116 bytes of rules each byte adds one.
 */
export function publishRulesLegacySize(len: number, opts: { readonly priorityFee?: boolean } = {}): number {
  if (!Number.isInteger(len) || len < 1) throw new RangeError("len must be a positive integer");
  const fee = opts.priorityFee !== false;
  return len <= 200 ? measuredLegacySize(len, fee) : measuredLegacySize(200, fee) + (len - 200);
}

/** Exact wire size of a v1 `publish_rules` transaction of `len` rule bytes (a priority fee adds 8). */
export function publishRulesV1Size(len: number, opts: { readonly priorityFee?: boolean } = {}): number {
  const message = compileV1Message(key(1), [publishRulesInstruction(key(1), key(2), new Uint8Array(len))], encodeBase58(new Uint8Array(32)), {
    computeUnitLimit: PUBLISH_RULES_COMPUTE_UNITS,
    loadedAccountsDataSizeLimit: PUBLISH_RULES_LOADED_ACCOUNTS_BYTES,
    ...(opts.priorityFee === true ? { priorityFeeLamports: 1n } : {}),
  });
  return message.bytes.length + 64 * message.header.numRequiredSignatures;
}

/** The largest rule set (bytes) a legacy `publish_rules` transaction with both compute-budget instructions carries (1,232 bytes or less on the wire). */
export const PUBLISH_RULES_LEGACY_MAX_BYTES: number = (() => {
  // The size grows byte for byte with the rules once the data length needs two compact-u16 bytes (>= 128 bytes of
  // data: 116 bytes of rules); web3.js cannot serialize a message over the legacy limit, so measure below it.
  const base = publishRulesLegacySize(200) - 200;
  return Math.min(LAUNCH_RULES.MAX_RULES_LEN, LEGACY_MAX_TRANSACTION_SIZE - base);
})();

// ---------------------------------------------------------------- funding ---

/** The fee of a publish transaction: one signature plus its priority fee. */
export function publishRulesFeeLamports(opts: ComputeBudgetOptions = {}): bigint {
  const limit = computeUnitLimitOf(opts, PUBLISH_RULES_COMPUTE_UNITS);
  const price = computeUnitPriceOf(opts);
  return LAMPORTS_PER_SIGNATURE + (price === null || price === 0n ? 0n : priorityFeeLamports(price, limit));
}

/** The record's rent still to pay at its address: `rent(78 + len)` less what the address already holds (a pre-funded address is taken over). */
export async function launchRulesRentDue(conn: Connection, launch: PublicKey, bytes: Uint8Array): Promise<bigint> {
  checkRules(bytes);
  const [rent, held] = await Promise.all([rentExemptLamports(conn, launchRulesSpace(bytes.length)), getAccount(conn, launchRulesAddress(launch, rulesHash(bytes)))]);
  const lamports = BigInt(held?.lamports ?? 0);
  return lamports >= rent ? 0n : rent - lamports;
}

// --------------------------------------------------------------- building ---

/** What every publish result carries. */
interface PublishRulesCommon {
  readonly launch: PublicKey;
  /** The PXR1 bytes. */
  readonly bytes: Uint8Array;
  /** `rulesHash(bytes)`: what the attestation signs (`buildAttestLaunchTx`'s `rulesHash`). */
  readonly rulesHash: Uint8Array;
  /** The record's address, `["rules", launch, rulesHash]` (`attest_launch`'s and `launch`'s last account). */
  readonly rules: PublicKey;
}

/** The rules are already published (by anyone): nothing to send. */
export interface PublishRulesAlreadyPublished extends PublishRulesCommon {
  readonly status: "already-published";
  readonly account: LaunchRulesAccount;
}

/** An unsigned legacy publish transaction (the wallet `payer` signs it). */
export interface PublishRulesLegacyReady extends PublishRulesCommon {
  readonly status: "ready";
  readonly kind: "legacy";
  readonly tx: Transaction;
  readonly sizeBytes: number;
  /** The record's rent still to pay plus the fee. */
  readonly fundingLamports: bigint;
  readonly rentLamports: bigint;
}

/** A signed v1 publish transaction from the throwaway payer. */
export interface PublishRulesV1Ready extends PublishRulesCommon {
  readonly status: "ready";
  readonly kind: "v1";
  /** Signed v1 wire bytes. */
  readonly tx: Uint8Array;
  readonly signature: string;
  readonly payer: Keypair;
  readonly blockhash: string;
  readonly lastValidBlockHeight: number;
  readonly sizeBytes: number;
  readonly computeUnitLimit: number;
  readonly priorityFeeLamports: bigint | null;
  readonly rentLamports: bigint;
  readonly fundingLamports: bigint;
}

export type PublishRulesTx = PublishRulesLegacyReady | PublishRulesAlreadyPublished;
export type PublishRulesV1Tx = PublishRulesV1Ready | PublishRulesAlreadyPublished;

/** `buildPublishRulesTx` / `buildPublishRulesV1Tx` arguments. */
export interface PublishRulesArgs extends ComputeBudgetOptions {
  readonly launch: PublicKey;
  /** The PXR1 bytes (`compileRules(set)`). */
  readonly rules: Uint8Array;
  /** v1 only: loaded-accounts-data limit (default 2 MiB). */
  readonly loadedAccountsDataSizeLimit?: number | undefined;
}

async function prepare(conn: Connection, args: PublishRulesArgs): Promise<{ common: PublishRulesCommon; existing: LaunchRulesAccount | null }> {
  checkPublicKey("launch", args.launch);
  checkRules(args.rules);
  const bytes = Uint8Array.from(args.rules);
  if (bytes.length > LAUNCH_RULES.MAX_RULES_LEN) throw new Error(`refusing to publish: ${bytes.length} bytes of rules (at most ${LAUNCH_RULES.MAX_RULES_LEN}); the program would fail with InvalidRules`);
  const launchAcc = ownedBy(await getAccount(conn, args.launch), PROGRAM_IDS.launchpad, "Launch");
  if (launchAcc === null) throw new Error(`refusing to publish: launch ${args.launch.toBase58()} does not exist`);
  const l = decodeLaunch(args.launch, launchAcc.data);
  if (l.status !== "configured") throw new Error("refusing to publish: the launch is already live (WrongLaunchState): rules are published before it goes live");
  const v = verifyRules(bytes, { guardSecs: l.guardSecs });
  if (!v.ok) throw new Error(`refusing to publish: these rules do not verify for this launch's ${l.guardSecs}-second guard (${v.code}: ${v.message}); the program would fail with InvalidRules (6048)`);
  const hash = rulesHash(bytes);
  const common: PublishRulesCommon = { launch: args.launch, bytes, rulesHash: hash, rules: launchRulesAddress(args.launch, hash) };
  return { common, existing: await fetchLaunchRules(conn, args.launch, hash) };
}

/**
 * `publish_rules` as an unsigned legacy transaction paid by `payer` (any
 * wallet; it pays the record's rent). Refuses, before building: rules over
 * 1,228 bytes or that do not verify for the launch's guard (InvalidRules), a
 * launch that does not exist or is live (WrongLaunchState), and rules too
 * large for a legacy transaction (`PUBLISH_RULES_LEGACY_MAX_BYTES`: use
 * `buildPublishRulesV1Tx`). Rules already published are `already-published`.
 */
export async function buildPublishRulesTx(conn: Connection, payer: PublicKey, args: PublishRulesArgs): Promise<PublishRulesTx> {
  checkPublicKey("payer", payer);
  const { common, existing } = await prepare(conn, args);
  if (existing !== null) return { ...common, status: "already-published", account: existing };
  const projected = publishRulesLegacySize(common.bytes.length, { priorityFee: computeUnitPriceOf(args) !== null });
  if (projected > LEGACY_MAX_TRANSACTION_SIZE) {
    throw new Error(`refusing to build: ${common.bytes.length} bytes of rules make a ${projected}-byte legacy transaction (limit ${LEGACY_MAX_TRANSACTION_SIZE}): publish them with buildPublishRulesV1Tx`);
  }
  const tx = new Transaction();
  tx.add(...computeBudgetInstructions(args, PUBLISH_RULES_COMPUTE_UNITS));
  tx.add(publishRulesInstruction(payer, args.launch, common.bytes));
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.feePayer = payer;
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  const message = tx.compileMessage();
  const sizeBytes = 1 + 64 * message.header.numRequiredSignatures + message.serialize().length;
  if (sizeBytes > LEGACY_MAX_TRANSACTION_SIZE) {
    throw new Error(`refusing to build: ${common.bytes.length} bytes of rules make a ${sizeBytes}-byte legacy transaction (limit ${LEGACY_MAX_TRANSACTION_SIZE}): publish them with buildPublishRulesV1Tx`);
  }
  const rentLamports = await launchRulesRentDue(conn, args.launch, common.bytes);
  return { ...common, status: "ready", kind: "legacy", tx, sizeBytes, rentLamports, fundingLamports: rentLamports + publishRulesFeeLamports(args) };
}

/**
 * `publish_rules` as a v1 transaction (SIMD-0385, 4,096 bytes) signed by the
 * throwaway `payer` that will send `attest_launch` (it pays the fee and the
 * record's rent). Any verified rule set fits (the largest, 1,228 bytes,
 * makes a v1 transaction well under the limit). Same refusals as
 * `buildPublishRulesTx`. Send with `sendPublishRulesTx`.
 */
export async function buildPublishRulesV1Tx(conn: Connection, payer: Keypair, args: PublishRulesArgs): Promise<PublishRulesV1Tx> {
  if (!(payer instanceof Keypair)) throw new TypeError("payer must be a Keypair (the throwaway fee payer)");
  const { common, existing } = await prepare(conn, args);
  if (existing !== null) return { ...common, status: "already-published", account: existing };
  const computeUnitLimit = computeUnitLimitOf(args, PUBLISH_RULES_COMPUTE_UNITS);
  const price = computeUnitPriceOf(args);
  const fee = price === null || price === 0n ? null : priorityFeeLamports(price, computeUnitLimit);
  const loaded = args.loadedAccountsDataSizeLimit ?? PUBLISH_RULES_LOADED_ACCOUNTS_BYTES;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const message = compileV1Message(payer.publicKey, [publishRulesInstruction(payer.publicKey, args.launch, common.bytes)], blockhash, {
    computeUnitLimit,
    loadedAccountsDataSizeLimit: loaded,
    ...(fee === null ? {} : { priorityFeeLamports: fee }),
  });
  if (message.header.numRequiredSignatures !== 1) throw new Error("a publish transaction is signed by its fee payer alone");
  const tx = signV1Message(message, [payer]);
  if (tx.length > V1_MAX_TRANSACTION_SIZE) throw new Error(`refusing to build: the transaction would be ${tx.length} bytes (limit ${V1_MAX_TRANSACTION_SIZE})`);
  const rentLamports = await launchRulesRentDue(conn, args.launch, common.bytes);
  return {
    ...common,
    status: "ready",
    kind: "v1",
    tx,
    signature: encodeBase58(tx.subarray(message.bytes.length, message.bytes.length + 64)),
    payer,
    blockhash,
    lastValidBlockHeight,
    sizeBytes: tx.length,
    computeUnitLimit,
    priorityFeeLamports: fee,
    rentLamports,
    fundingLamports: rentLamports + LAMPORTS_PER_SIGNATURE + (fee ?? 0n),
  };
}

/**
 * Send a built v1 publish transaction (from the throwaway payer) and return
 * the record once it is visible at `opts.commitment` (default `confirmed`;
 * wait for `finalized` with `waitForLaunchRules` before attesting). A send
 * that fails while the record is there anyway (a racing copy) still returns
 * it.
 */
export async function sendPublishRulesTx(
  conn: Connection,
  built: PublishRulesV1Ready,
  opts: { readonly commitment?: "confirmed" | "finalized" | undefined; readonly skipPreflight?: boolean | undefined } = {},
): Promise<LaunchRulesAccount> {
  if (built === null || typeof built !== "object" || built.status !== "ready" || built.kind !== "v1") throw new TypeError("only a built v1 publish transaction (status ready) can be sent");
  let sendError: unknown = null;
  try {
    await sendAndConfirm(conn, built.tx, { lastValidBlockHeight: built.lastValidBlockHeight, skipPreflight: opts.skipPreflight ?? false, commitment: opts.commitment ?? "confirmed" });
  } catch (e) {
    sendError = e;
  }
  const record = await fetchLaunchRules(conn, built.launch, built.rulesHash, { commitment: opts.commitment ?? "confirmed" });
  if (record !== null) return record;
  if (sendError !== null) throw new Error(`publish_rules did not land (${sendError instanceof Error ? sendError.message : String(sendError)}): build it again and send`, { cause: sendError });
  throw new Error("publish_rules was confirmed but the record is not visible yet: read it again with waitForLaunchRules");
}

/** `waitForLaunchRules` options (as `waitForTokenMeta`'s). */
export interface WaitForLaunchRulesOptions {
  /** Default `finalized`: what `buildAttestLaunchTx` requires by default. */
  readonly commitment?: "finalized" | "confirmed" | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
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

/** Resolve with the rules record once it is visible at `opts.commitment` (default `finalized`), polling; throws on timeout or abort. */
export async function waitForLaunchRules(conn: Connection, launch: PublicKey, hash: Uint8Array, opts: WaitForLaunchRulesOptions = {}): Promise<LaunchRulesAccount> {
  const poll = opts.pollIntervalMs ?? 2_000;
  const timeout = opts.timeoutMs ?? 90_000;
  if (!Number.isFinite(poll) || poll <= 0) throw new RangeError("pollIntervalMs must be positive");
  if (!Number.isFinite(timeout) || timeout < 0) throw new RangeError("timeoutMs must be non-negative");
  const sleep = opts.sleep ?? defaultSleep;
  const commitment: Commitment = opts.commitment ?? "finalized";
  for (let waited = 0; ; waited += poll) {
    if (opts.signal?.aborted === true) throw opts.signal.reason ?? new Error("aborted");
    const record = await fetchLaunchRules(conn, launch, hash, { commitment: commitment as "confirmed" | "finalized" });
    if (record !== null) return record;
    if (waited >= timeout) throw new Error(`the rules record ${launchRulesAddress(launch, hash).toBase58()} is not ${commitment} after ${timeout} ms`);
    await sleep(poll, opts.signal);
  }
}

/** Decode a rules record from raw account data at `address` (re-exported for indexers; see `decodeLaunchRules`). */
export { decodeLaunchRules };

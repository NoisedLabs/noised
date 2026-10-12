/**
 * MOCK implementation of the SDK's launch flow (PQ v2, on-chain metadata):
 * the throwaway payer's funding, `publish_metadata`, `attest_launch`, the
 * sweep, the flow status and the record reads. Same signatures, refusal
 * order, error classes and messages as the SDK (test/launch-flow-mock.test.ts
 * compares them); `conn` is accepted and ignored.
 *
 * The transactions are the SDK's real bytes: the publish and attest
 * instructions come from the SDK's encoders, the LMS signature from the
 * leaf ledger (`signAtNextLeaf`: the leaf is reserved durably before the
 * signature exists), the v1 wire format from the SDK's compiler. What the
 * simulated chain does with them follows the program:
 *   - `publish_metadata` writes the record at the address of its own hash
 *     (idempotent; only while the launch is configured);
 *   - `attest_launch` always lands and burns its leaf in the identity's
 *     bitmap; it attests only when the launch names this identity, the
 *     record exists, the window is valid at landing (60..=3,600 s long, at
 *     least 60 s of it left, opening within 7 days) and the attestation slot
 *     is free (none yet, an empty one, or one whose window passed while the
 *     launch is still configured: audit round 3 F1, which replaces every
 *     field). Otherwise it writes an empty attestation if there is none and
 *     changes nothing else.
 * Everything is final as soon as it lands (no forks on the simulated chain).
 */
import { sha256 } from "@noble/hashes/sha2.js";
import {
  attestationAddress,
  attestationReplaceable,
  attestFeeLamports,
  attestLaunchInstruction,
  AttestPayerFundingError,
  AttestRetryLimitError,
  attestTransactionSize,
  attestTxConfig,
  ATTEST_LANDING_MARGIN_SECS,
  burnReasons,
  ClusterMismatchError,
  CLUSTERS,
  compileV1Message,
  customErrorCode,
  decodeTokenMeta,
  identityAddress,
  identityAddressFromId,
  inLaunchWindow,
  KNOWN_ACCOUNTS,
  launchAddress,
  launchPhase,
  batchOutcome,
  launchWindowProblems,
  leafLedger,
  lms,
  MAX_BURN_ONLY_LANDINGS,
  MAX_UNLANDED_SIGNATURES,
  metadataHashV2,
  PQ_IDENTITY,
  pqIdentity,
  PROGRAM_IDS,
  publishFeeLamports,
  publishMetadataInstruction,
  PublishPayerFundingError,
  publishTransactionSize,
  publishTxConfig,
  rulesAccountFor,
  SignatureCapError,
  signAttestTransaction,
  signV1Message,
  tokenMetaAccountData,
  tokenMetaAddress,
  tokenMetaRecord,
  tokenMetaSpace,
  unixToIso,
  unixToUtcText,
  V1_MAX_TRANSACTION_SIZE,
  validateLaunchWindow,
  validateTokenMeta,
  v1TransactionId,
  type AttestationAccount,
  type AttestationOutcome,
  type AttestationVerification,
  type AttestLaunchReady,
  type AttestLaunchTx,
  type BurnOnlyLanding,
  type BurnReason,
  type Cluster,
  type LaunchFlowStatus,
  type LaunchFlowStep,
  type LaunchPhase,
  type LaunchRulesAccount,
  type LeafRecord,
  type PqOrigin,
  type PublishMetadataArgs,
  type PublishMetadataTx,
  type ThrowawayPayerFunding,
  type TokenMetaAccount,
} from "@noisedlabs/sdk";
import { rulesHash as rulesHashOfBytes } from "@noisedlabs/sdk/programmable";
import { Keypair, PublicKey, SystemProgram, type Transaction } from "@solana/web3.js";

import type { ChainBackend } from "../backend/types";
import { bytesEqual, fromHex, toHex } from "./bytes";
import { chain } from "./chain";
import { attestationLanded, attestationRulesOk, launchFail, liveLaunchByMint, publishedRules, RENT, runtime, toLaunchAccount } from "./common";
import { attestedRulesOf, isZeroHash } from "./rules";
import { tokenMetaAt } from "./fixtures";
import { countsAsUnlanded, mockCheckClockSkew, withSigningLock } from "./guard";
import { fakeBlockhash, legacyTx } from "./ix";
import { buildCreateLaunchTx } from "./launch";
import { LAMPORTS_PER_SIGNATURE, register, send } from "./sim";
import { addSol, latency, nowSecs, solBalance, type MockIdentity, type MockState } from "./store";

type Sdk = typeof import("@noisedlabs/sdk");

/** Lamports per signature (the runtime's fee). */
const SIGNATURE_FEE = 5_000n;
/** Anchor's ConstraintSeeds: an account the signature does not name (nothing written, no leaf burned). */
const CONSTRAINT_SEEDS = 2006;
/** `PqLeafUsed`: the leaf is already set on-chain. */
const PQ_LEAF_USED = 6041;

/** Rent-exempt minimum of an account of `size` bytes on the simulated chain: `(128 + size) * 6,960` (the default rent). */
export function mockRent(size: number): bigint {
  return BigInt(128 + size) * 6_960n;
}

/** MOCK `rentExemptLamports`. */
export const rentExemptLamports: Sdk["rentExemptLamports"] = async (_conn, size) => {
  await latency("read");
  if (!Number.isInteger(size) || size < 0) throw new RangeError("size must be a non-negative integer");
  return mockRent(size);
};

/** MOCK `launchPayerLamports`: what the simulated `launch` takes from its payer (its accounts' rent and two signature fees). */
export const launchPayerLamports: ChainBackend["launchPayerLamports"] = async () => {
  await latency("read");
  return RENT.launchAccounts + 2n * SIGNATURE_FEE;
};

function checkPublicKey(name: string, k: unknown): asserts k is PublicKey {
  if (!(k instanceof PublicKey)) throw new TypeError(`${name} must be a PublicKey`);
}

function checkBytes(name: string, b: unknown, len: number): asserts b is Uint8Array {
  if (!(b instanceof Uint8Array)) throw new TypeError(`${name} must be a Uint8Array`);
  if (b.length !== len) throw new RangeError(`${name} must be ${len} bytes, got ${b.length}`);
}

/** The simulated chain's Identity account of an LMS public key (null before its first landing). */
function identityOf(s: MockState, lmsPublicKey: Uint8Array): MockIdentity | null {
  return s.identities[identityAddress(lmsPublicKey).toBase58()] ?? null;
}

/** The leaf bitmap of an identity id (zeros when it has no account yet). */
function usedOf(s: MockState, id: Uint8Array): Uint8Array {
  return s.identities[identityAddressFromId(id).toBase58()]?.used ?? new Uint8Array(PQ_IDENTITY.LEAF_BITMAP_LEN);
}

/** The SDK's `assertCluster` on the simulated chain (it serves the cluster the build targets). */
function assertSimulatedCluster(expected: Cluster, opts: { allowLocalnet?: boolean | undefined }): void {
  if (!Object.prototype.hasOwnProperty.call(CLUSTERS, expected)) throw new RangeError(`unknown cluster ${String(expected)}`);
  if (expected === "localnet" && opts.allowLocalnet !== true) {
    throw new ClusterMismatchError("refusing to sign for localnet without allowLocalnet: a localnet label is accepted only when the caller explicitly opts into it", expected, null);
  }
}

// ------------------------------------------------------------------ reads ---

/** MOCK `fetchTokenMetaForLaunch`: the record the launch's attestation signed (null without an attested attestation). */
export const fetchTokenMetaForLaunch: Sdk["fetchTokenMetaForLaunch"] = async (_conn, launch) => {
  await latency("read");
  checkPublicKey("launch", launch);
  const s = chain();
  const attestation = s.attestations[launch.toBase58()];
  if (attestation === undefined || !attestation.attested) return null;
  const tokenMeta = tokenMetaAt(s, launch, attestation.metadataHash);
  if (tokenMeta === null) throw new Error("the launch's attestation names a metadata record that does not exist (an RPC that is behind or dishonest)");
  return { attestation: { ...attestation }, tokenMeta };
};

/** MOCK `fetchTokenMetaForMint`: a mint's record, resolved only through its certificate (null for any other mint). */
export const fetchTokenMetaForMint: Sdk["fetchTokenMetaForMint"] = async (_conn, mint) => {
  await latency("read");
  checkPublicKey("mint", mint);
  const s = chain();
  const l = liveLaunchByMint(s, mint);
  const certificate = l?.certificate ?? null;
  if (l === null || certificate === null) return null;
  if (!certificate.baseMint.equals(mint)) throw new Error("certificate does not belong to this mint");
  const data = s.tokenMetas[certificate.metadata.toBase58()];
  if (data === undefined) throw new Error(`the certificate names the metadata record ${certificate.metadata.toBase58()}, which does not exist`);
  const tokenMeta = decodeTokenMeta(certificate.metadata, data);
  if (!tokenMeta.launch.equals(certificate.launch)) throw new Error("the certificate's metadata record belongs to another launch");
  return { certificate: { ...certificate, recipients: certificate.recipients.map((r) => ({ ...r })) }, tokenMeta };
};

/**
 * MOCK `verifyAttestation`: the attestation re-checked from the simulated chain, the way the SDK does before launch:
 * attested (version 2) by the identity the launch names, the record it signed exists at the address of its hash, and
 * the message rebuilt from the Launch account hashes to the stored hash. A signature with an identity account is
 * checked with LMS verification at its leaf (which the bitmap must mark); the demo launches' stand-in signatures have
 * no identity account and are accepted, as the simulated `verifyLaunch` accepts them.
 */
export const verifyAttestation: Sdk["verifyAttestation"] = async (_conn, launch) => {
  await latency("read");
  checkPublicKey("launch", launch);
  const s = chain();
  const ml = s.launches[launch.toBase58()];
  const l = ml === undefined ? null : toLaunchAccount(ml);
  const problems: string[] = [];
  if (l === null) problems.push(`no launchpad-owned Launch account at ${launch.toBase58()}`);
  const a = s.attestations[launch.toBase58()];
  let origin: PqOrigin | null = null;
  let record: TokenMetaAccount | null = null;
  let launchRules: LaunchRulesAccount | null = null;
  if (a === undefined || !a.attested) problems.push("the launch has no attested attestation");
  else {
    record = tokenMetaAt(s, launch, a.metadataHash);
    if (record === null) problems.push(`the metadata record the attestation signed does not exist at ${tokenMetaAddress(launch, a.metadataHash).toBase58()}`);
    if (l !== null && !bytesEqual(a.pqIdentity, l.pqIdentity)) problems.push("the attestation was signed by another identity than the one the launch names");
    if (l !== null) {
      const message = pqIdentity.attestationMessage({ launch, paramsHash: l.paramsHash, creator: l.creator, metadataHash: a.metadataHash, rulesHash: a.rulesHash, notBefore: a.notBefore, notAfter: a.notAfter });
      if (!bytesEqual(sha256(message), a.messageHash)) problems.push("the attestation's message is not the one rebuilt from the launch");
      const identity = s.identities[identityAddressFromId(a.pqIdentity).toBase58()];
      if (identity !== undefined) {
        if (lms.lmsVerify(identity.publicKey, message, a.signature) !== a.leaf) problems.push("the LMS signature does not verify at its leaf");
        if (!pqIdentity.leafUsed(identity.used, a.leaf)) problems.push("the identity's bitmap does not mark the attested leaf");
      }
    }
    // Attestation v3: the creator rules it signed must be published (none: the all-zero hash).
    const signedRules = attestedRulesOf(launch, a.rulesHash, l?.guardSecs ?? 0, l?.tokenDecimal ?? 6);
    launchRules = signedRules.record;
    if (!isZeroHash(a.rulesHash) && launchRules === null) problems.push("the launch rules the attestation signed are not published");
    origin = {
      attestation: attestationAddress(launch),
      identity: identityAddressFromId(a.pqIdentity),
      identityId: Uint8Array.from(a.pqIdentity),
      lmsPublicKey: s.identities[identityAddressFromId(a.pqIdentity).toBase58()]?.publicKey ?? null,
      leaf: a.leaf,
      attestationSlot: a.slot,
      messageHash: Uint8Array.from(a.messageHash),
      window: { notBefore: a.notBefore, notAfter: a.notAfter },
      metadataHash: Uint8Array.from(a.metadataHash),
      tokenMeta: tokenMetaAddress(launch, a.metadataHash),
      rules: signedRules.rules,
      signatureValid: !problems.some((p) => p.startsWith("the LMS signature")),
      verified: false,
    };
  }
  const verified = origin !== null && problems.length === 0;
  return { verified, problems, launch: l, origin: origin === null ? null : { ...origin, verified }, tokenMeta: record, launchRules } satisfies AttestationVerification;
};

// ------------------------------------------------------------ the payer ---

/** The identity's and the attestation's rents still to pay (only accounts that do not exist yet, given `launch` and `lmsPublicKey`). */
function attestRents(s: MockState, launch: PublicKey | undefined, lmsPublicKey: Uint8Array | undefined): { identity: bigint; attestation: bigint } {
  let needIdentity = true;
  let needAttestation = true;
  if (launch !== undefined || lmsPublicKey !== undefined) {
    if (launch === undefined || lmsPublicKey === undefined) throw new TypeError("pass both launch and lmsPublicKey, or neither");
    checkPublicKey("launch", launch);
    checkBytes("LMS public key", lmsPublicKey, PQ_IDENTITY.PUBLIC_KEY_LEN);
    needIdentity = identityOf(s, lmsPublicKey) === null;
    needAttestation = s.attestations[launch.toBase58()] === undefined;
  }
  return {
    identity: needIdentity ? mockRent(PQ_IDENTITY.IDENTITY_ACCOUNT_LEN) : 0n,
    attestation: needAttestation ? mockRent(PQ_IDENTITY.ATTESTATION_ACCOUNT_LEN) : 0n,
  };
}

/** MOCK `throwawayPayerFunding`: the SDK's arithmetic over the simulated chain's accounts and rent. */
export const throwawayPayerFunding: Sdk["throwawayPayerFunding"] = async (_conn, opts = {}) => {
  await latency("read");
  const s = chain();
  const rent = attestRents(s, opts.launch, opts.lmsPublicKey);
  let tokenMetaRent = 0n;
  let publishFee = 0n;
  if (opts.metadata !== undefined) {
    const v = validateTokenMeta(opts.metadata);
    if (!v.ok) throw new Error(`the metadata record is invalid (${v.error?.name ?? "?"}):\n${v.errors.join("\n")}`);
    const record = tokenMetaRecord(opts.metadata);
    const published = opts.launch !== undefined && tokenMetaAt(s, opts.launch, metadataHashV2(record)) !== null;
    if (!published) {
      tokenMetaRent = mockRent(tokenMetaSpace(record));
      publishFee = publishFeeLamports(opts.publish);
    }
  }
  const attestFee = attestFeeLamports(opts.attest);
  // The creator rules to publish first (attestation v3), unless they are published already.
  let rulesRent = 0n;
  let publishRulesFee = 0n;
  if (opts.rules !== undefined && opts.rules !== null && opts.rules.length > 0) {
    const published = opts.launch !== undefined && publishedRules(opts.launch.toBase58(), rulesHashOfBytes(opts.rules)) !== null;
    if (!published) {
      rulesRent = mockRent(78 + opts.rules.length);
      publishRulesFee = LAMPORTS_PER_SIGNATURE;
    }
  }
  const afterPublish = rent.identity + rent.attestation + attestFee;
  const floor = mockRent(0);
  const rentFloor = publishFee > 0n && afterPublish < floor ? floor : 0n;
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
  } satisfies ThrowawayPayerFunding;
};

/** MOCK `buildFundThrowawayPayerTx`: the wallet's legacy transfer to the throwaway payer. */
export const buildFundThrowawayPayerTx: Sdk["buildFundThrowawayPayerTx"] = async (conn, from, payer, opts = {}) => {
  checkPublicKey("from", from);
  checkPublicKey("payer", payer);
  if (from.equals(payer)) throw new Error("the throwaway payer must be a fresh key, not the funding wallet");
  const funding = opts.lamports === undefined ? await throwawayPayerFunding(conn, opts) : null;
  const lamports = opts.lamports ?? funding?.lamports ?? 0n;
  if (typeof lamports !== "bigint" || lamports <= 0n || lamports >= 1n << 64n) throw new RangeError("lamports must be a positive u64");
  await latency("build");
  const tx = legacyTx(from, [SystemProgram.transfer({ fromPubkey: from, toPubkey: payer, lamports })]);
  register(tx, {
    label: "Transfer",
    program: KNOWN_ACCOUNTS.system,
    computeUnits: 150,
    payer: from,
    rent: 0n,
    solOut: lamports,
    check: () => null,
    apply: (st) => {
      addSol(st, from, -lamports);
      addSol(st, payer, lamports);
    },
  });
  return { tx, lamports, funding };
};

/** MOCK `buildSweepPayerTx`: everything left on the throwaway payer, minus the fee, to `to`, signed by the payer (null when nothing is left). */
export const buildSweepPayerTx: Sdk["buildSweepPayerTx"] = async (_conn, payer, to) => {
  if (!(payer instanceof Keypair)) throw new TypeError("payer must be the throwaway Keypair");
  checkPublicKey("to", to);
  if (to.equals(payer.publicKey)) throw new Error("sweep to another account (the creator's wallet)");
  await latency("build");
  const lamports = solBalance(chain(), payer.publicKey) - SIGNATURE_FEE;
  if (lamports <= 0n) return null;
  const tx = legacyTx(payer.publicKey, [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports })]);
  tx.sign(payer);
  register(tx, {
    label: "Transfer",
    program: KNOWN_ACCOUNTS.system,
    computeUnits: 150,
    payer: payer.publicKey,
    rent: 0n,
    solOut: lamports,
    check: () => null,
    apply: (st) => {
      addSol(st, payer.publicKey, -lamports);
      addSol(st, to, lamports);
    },
  });
  return { tx, lamports };
};

// ---------------------------------------------------------------- publish ---

/**
 * The simulated `publish_metadata`: writes the record at the address of its own hash, only while the launch is
 * configured (WrongLaunchState); a record already there is left as it is, and its rent is not taken again.
 */
async function buildPublishMetadataTx(args: PublishMetadataArgs): Promise<PublishMetadataTx> {
  checkPublicKey("launch", args.launch);
  if (!(args.payer instanceof Keypair)) throw new TypeError("payer must be a Keypair (the throwaway fee payer)");
  const v = validateTokenMeta(args.metadata);
  if (!v.ok) throw new Error(`refusing to publish: publish_metadata would fail with ${v.error?.name ?? "?"} (${v.error?.code ?? "?"}):\n${v.errors.join("\n")}`);
  const record = tokenMetaRecord(args.metadata);
  const metadataHash = metadataHashV2(record);
  const tokenMeta = tokenMetaAddress(args.launch, metadataHash);
  const common = { launch: args.launch, record, metadataHash, tokenMeta };
  const config = publishTxConfig(args);
  const size = publishTransactionSize(record, { priorityFee: config.priorityFeeLamports !== null });
  if (size > V1_MAX_TRANSACTION_SIZE) throw new Error(`refusing to publish: the transaction would be ${size} bytes (limit ${V1_MAX_TRANSACTION_SIZE})`);

  await latency("build");
  const s = chain();
  const l = s.launches[args.launch.toBase58()];
  if (l === undefined) throw new Error(`refusing to publish: launch ${args.launch.toBase58()} does not exist`);
  if (l.state.status !== "configured") throw new Error("refusing to publish: the launch is already live (WrongLaunchState): records are published before it goes live");
  const existing = tokenMetaAt(s, args.launch, metadataHash);
  if (existing !== null) return { ...common, status: "already-published", account: existing };

  const rentLamports = mockRent(tokenMetaSpace(record));
  const blockhash = fakeBlockhash();
  const lastValidBlockHeight = s.slot + 150;
  const message = compileV1Message(args.payer.publicKey, [publishMetadataInstruction(args.payer.publicKey, args.launch, record)], blockhash, {
    computeUnitLimit: config.computeUnitLimit,
    loadedAccountsDataSizeLimit: config.loadedAccountsDataSizeLimit,
    ...(config.priorityFeeLamports === null ? {} : { priorityFeeLamports: config.priorityFeeLamports }),
  });
  const tx = signV1Message(message, [args.payer]);
  const launch = args.launch;
  const payer = args.payer.publicKey;
  register(tx, {
    label: "PublishMetadata",
    program: PROGRAM_IDS.launchpad,
    computeUnits: 15_400 + Math.round(record.doc.length * 2.6),
    payer,
    rent: rentLamports,
    solOut: 0n,
    check: (st) => (st.launches[launch.toBase58()]?.state.status === "configured" ? null : launchFail("WrongLaunchState")),
    apply: (st) => {
      const key = tokenMeta.toBase58();
      // Idempotent: a record already there holds exactly these bytes; nothing is written and no rent is taken.
      if (st.tokenMetas[key] !== undefined) addSol(st, payer, rentLamports);
      else st.tokenMetas[key] = tokenMetaAccountData(launch, record);
    },
    logs: () => [`MetadataPublished { launch: ${launch.toBase58()}, token_meta: ${tokenMeta.toBase58()}, metadata_hash: ${toHex(metadataHash)}, flags: ${record.flags}, uri_len: ${record.uri.length}, doc_len: ${record.doc.length} }`],
  });
  return {
    ...common,
    status: "ready",
    tx,
    signature: v1TransactionId(tx),
    payer: args.payer,
    blockhash,
    lastValidBlockHeight,
    sizeBytes: tx.length,
    computeUnitLimit: config.computeUnitLimit,
    priorityFeeLamports: config.priorityFeeLamports,
    rentLamports,
    fundingLamports: rentLamports + publishFeeLamports(args),
  };
}

/** MOCK `buildPlannedPublishTx`. */
export const buildPlannedPublishTx: Sdk["buildPlannedPublishTx"] = async (_conn, plan, payer, opts = {}) => {
  const built = await buildPublishMetadataTx({ ...opts, launch: plan.launch, payer, metadata: plan.metadata });
  if (!bytesEqual(built.metadataHash, plan.metadataHash)) throw new Error("the record built differs from the plan's");
  return built;
};

/** MOCK `sendPublishMetadataTx`: the SDK's balance checks (`PublishPayerFundingError`), then send and read the record back. */
export const sendPublishMetadataTx: Sdk["sendPublishMetadataTx"] = async (_conn, built) => {
  if (built === null || typeof built !== "object" || built.status !== "ready") throw new TypeError("only a built publish transaction (status ready) can be sent");
  await latency("read");
  const s = chain();
  const fee = SIGNATURE_FEE + (built.priorityFeeLamports ?? 0n);
  const rentDue = tokenMetaAt(s, built.launch, built.metadataHash) === null ? mockRent(tokenMetaSpace(built.record)) : 0n;
  const balance = solBalance(s, built.payer.publicKey);
  const floor = mockRent(0);
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
    await send(built.tx);
  } catch (e) {
    sendError = e;
  }
  const record = tokenMetaAt(chain(), built.launch, built.metadataHash);
  if (record !== null) return record;
  if (sendError !== null) throw new Error(`publish_metadata did not land (${sendError instanceof Error ? sendError.message : String(sendError)}): build it again and send`, { cause: sendError });
  throw new Error("publish_metadata was confirmed but the record is not visible yet: read it again with waitForTokenMeta");
};

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

/** MOCK `waitForTokenMeta` (everything the simulated chain holds is final). */
export const waitForTokenMeta: Sdk["waitForTokenMeta"] = async (_conn, launch, metadataHash, opts = {}) => {
  const poll = opts.pollIntervalMs ?? 2_000;
  const timeout = opts.timeoutMs ?? 90_000;
  if (!Number.isFinite(poll) || poll <= 0) throw new RangeError("pollIntervalMs must be positive");
  if (!Number.isFinite(timeout) || timeout < 0) throw new RangeError("timeoutMs must be non-negative");
  const sleep = opts.sleep ?? defaultSleep;
  const commitment = opts.commitment ?? "finalized";
  for (let waited = 0; ; waited += poll) {
    if (opts.signal?.aborted === true) throw opts.signal.reason ?? new Error("aborted");
    await latency("read");
    const record = tokenMetaAt(chain(), launch, metadataHash);
    if (record !== null) return record;
    if (waited >= timeout) throw new Error(`the metadata record ${tokenMetaAddress(launch, metadataHash).toBase58()} is not ${commitment} after ${timeout} ms`);
    await sleep(poll, opts.signal);
  }
};

// ----------------------------------------------------------------- attest ---

const REASON_TEXT: Readonly<Record<BurnReason, string>> = {
  "wrong-identity": "the signing key is not the identity this launch names",
  "record-missing": "the metadata record it names was not published (or not final) when it landed",
  "invalid-window": "the window could not be used (60 s to 1 hour long, at least 60 s of it left when it landed, opening at most 7 days later, in seconds)",
  "already-attested": "the launch was already attested by another message whose window had not passed",
  "rules-missing": "the launch rules it names were not published (or not final, or the address held something else) when it landed",
};

function burnDetail(leaf: number, reasons: readonly BurnReason[]): string {
  return reasons.length === 0
    ? `leaf ${leaf} is used on-chain, but the launch is not attested by this message (the cause could not be inferred)`
    : `leaf ${leaf} was burned without attesting: ${reasons.map((r) => REASON_TEXT[r]).join("; ")}`;
}

function isBurnOnlyLanding(r: LeafRecord, launch: PublicKey, used: Uint8Array): boolean {
  if (r.launch !== launch.toBase58()) return false;
  if (r.status === "landed") return r.attested === false;
  return r.status === "signed" && pqIdentity.leafUsed(used, r.leaf);
}

function recordBurnReasons(s: MockState, r: LeafRecord, launchPqIdentity: Uint8Array, id: Uint8Array, attestation: AttestationAccount | null): BurnReason[] {
  if (r.message === null) return [];
  const f = pqIdentity.parseAttestationMessage(fromHex(r.message));
  return burnReasons({
    launchPqIdentity,
    identityId: id,
    recordExists: tokenMetaAt(s, f.launch, f.metadataHash) !== null,
    rulesRecordExists: isZeroHash(f.rulesHash) ? null : publishedRules(f.launch.toBase58(), f.rulesHash) !== null,
    window: { notBefore: f.notBefore, notAfter: f.notAfter },
    attestation,
    messageHash: fromHex(r.messageHash),
  });
}

/** `launch_window_is_valid` at a landing (the program's rule, with the SDK's words). */
function windowValidAt(now: bigint, notBefore: bigint, notAfter: bigint): boolean {
  return launchWindowProblems(now, notBefore, notAfter).length === 0;
}

/** The empty attestation a burn-only first landing leaves: version 0, launch default. */
function emptyAttestation(launch: PublicKey): AttestationAccount {
  return {
    publicKey: attestationAddress(launch),
    version: 0,
    bump: PublicKey.findProgramAddressSync([new TextEncoder().encode("attestation"), launch.toBytes()], PROGRAM_IDS.launchpad)[1],
    attested: false,
    launch: PublicKey.default,
    pqIdentity: new Uint8Array(32),
    leaf: 0,
    metadataHash: new Uint8Array(32),
    messageHash: new Uint8Array(32),
    slot: 0n,
    notBefore: 0n,
    notAfter: 0n,
    signature: new Uint8Array(0),
    rulesHash: new Uint8Array(32),
  };
}

interface AttestEffectArgs {
  payer: PublicKey;
  launch: PublicKey;
  lmsPublicKey: Uint8Array;
  lmsSignature: Uint8Array;
  leaf: number;
  message: Uint8Array;
  metadataHash: Uint8Array;
  /** The message's rules hash (attestation v3; all zero: no creator rules). */
  rulesHash: Uint8Array;
  notBefore: bigint;
  notAfter: bigint;
}

/** What the simulated `attest_launch` does with a valid signature: burn the leaf; attest only when every rule holds. */
function registerAttest(s: MockState, tx: Uint8Array, a: AttestEffectArgs, refuse: "constraint-seeds" | null): void {
  const id = pqIdentity.identityId(a.lmsPublicKey);
  const identityKey = identityAddress(a.lmsPublicKey).toBase58();
  const launchKey = a.launch.toBase58();
  const rent = (s.identities[identityKey] === undefined ? mockRent(PQ_IDENTITY.IDENTITY_ACCOUNT_LEN) : 0n) + (s.attestations[launchKey] === undefined ? mockRent(PQ_IDENTITY.ATTESTATION_ACCOUNT_LEN) : 0n);
  const attests = (st: MockState, now: bigint): boolean => {
    const l = st.launches[launchKey];
    if (l === undefined || l.state.status !== "configured" || !bytesEqual(l.state.pqIdentity, id)) return false;
    if (tokenMetaAt(st, a.launch, a.metadataHash) === null) return false;
    if (!windowValidAt(now, a.notBefore, a.notAfter)) return false;
    // Attestation v3: a message that binds launch rules attests only when that rule set is published.
    if (!attestationRulesOk(st, launchKey, sha256(a.message), a.rulesHash)) return false;
    const cur = st.attestations[launchKey];
    return cur === undefined || !cur.attested || now > cur.notAfter;
  };
  register(tx, {
    label: "AttestLaunch",
    program: PROGRAM_IDS.launchpad,
    computeUnits: 95_000 + (a.leaf % 17) * 1_100,
    payer: a.payer,
    rent,
    solOut: 0n,
    check: (st) => {
      if (refuse === "constraint-seeds") return runtime("AnchorError caused by account: token_meta. Error Code: ConstraintSeeds. Error Number: 2006. Error Message: A seeds constraint was violated.");
      if (st.launches[launchKey] === undefined) return runtime(`AnchorError caused by account: launch. Error Code: AccountNotInitialized. Error Number: 3012. No launch at ${launchKey}.`);
      if (pqIdentity.leafUsed(st.identities[identityKey]?.used ?? new Uint8Array(PQ_IDENTITY.LEAF_BITMAP_LEN), a.leaf)) return launchFail("PqLeafUsed");
      return null;
    },
    apply: (st, nowTs) => {
      const now = BigInt(nowTs);
      const used = Uint8Array.from(st.identities[identityKey]?.used ?? new Uint8Array(PQ_IDENTITY.LEAF_BITMAP_LEN));
      pqIdentity.markLeafUsed(used, a.leaf);
      st.identities[identityKey] = { publicKey: Uint8Array.from(a.lmsPublicKey), used };
      if (attests(st, now)) {
        // Every field is written (a replaced attestation keeps nothing of the old one).
        st.attestations[launchKey] = {
          publicKey: attestationAddress(a.launch),
          version: PQ_IDENTITY.ATTESTATION_VERSION,
          bump: PublicKey.findProgramAddressSync([new TextEncoder().encode("attestation"), a.launch.toBytes()], PROGRAM_IDS.launchpad)[1],
          attested: true,
          launch: a.launch,
          pqIdentity: Uint8Array.from(id),
          leaf: a.leaf,
          metadataHash: Uint8Array.from(a.metadataHash),
          messageHash: sha256(a.message),
          slot: BigInt(st.slot + 2),
          notBefore: a.notBefore,
          notAfter: a.notAfter,
          signature: Uint8Array.from(a.lmsSignature),
          rulesHash: Uint8Array.from(a.rulesHash),
        };
        // Attestation v3: the rules hash this message binds (none: zero, no custom rules).
        attestationLanded(st, launchKey, sha256(a.message), a.rulesHash);
      } else if (st.attestations[launchKey] === undefined) {
        st.attestations[launchKey] = emptyAttestation(a.launch);
      }
    },
    logs: (st) => [
      attests(st, BigInt(nowSecs()))
        ? `LaunchAttested { launch: ${launchKey}, pq_identity: ${toHex(id)}, leaf: ${a.leaf}, metadata_hash: ${toHex(a.metadataHash)}, not_before: ${a.notBefore}, not_after: ${a.notAfter} }`
        : `PqLeafConsumed { pq_identity: ${toHex(id)}, leaf: ${a.leaf} }: the signature burned its leaf without attesting`,
    ],
  });
}

/**
 * Only for tests: the next attest transaction built is refused once with ConstraintSeeds (2006), as the program
 * refuses an account the signature does not name, to exercise "send the same signature again".
 */
let refuseNextAttest = 0;
export function refuseNextAttestForTests(times = 1): void {
  refuseNextAttest = times;
}

/** The v1 attest transaction for a signature (the SDK's instruction and compiler), registered with the simulated chain. */
function signedAttest(s: MockState, payer: Keypair, a: Omit<AttestEffectArgs, "payer">, opts: Parameters<Sdk["attestTxConfig"]>[0]): ReturnType<Sdk["signAttestTransaction"]> & { blockhash: string } {
  const blockhash = fakeBlockhash();
  const ix = attestLaunchInstruction({ payer: payer.publicKey, launch: a.launch, lmsPublicKey: a.lmsPublicKey, lmsSignature: a.lmsSignature, metadataHash: a.metadataHash, rulesHash: a.rulesHash, notBefore: a.notBefore, notAfter: a.notAfter });
  const signed = signAttestTransaction(payer, ix, blockhash, opts);
  const refuse = refuseNextAttest > 0 ? "constraint-seeds" : null;
  if (refuseNextAttest > 0) refuseNextAttest--;
  registerAttest(s, signed.tx, { ...a, payer: payer.publicKey }, refuse);
  return { ...signed, blockhash };
}

/**
 * MOCK `buildAttestLaunchTx` (through `buildPlannedAttestTx`): the SDK's refusals in its order (input, cluster, the
 * launch, the window against the clock with a landing margin, the attestation, the record, the burn-only cap), then
 * the leaf (the identity's bitmap, the ledger) and the signature (`signAtNextLeaf`).
 */
async function buildAttestLaunchTx(args: Parameters<Sdk["buildAttestLaunchTx"]>[1]): Promise<AttestLaunchTx> {
  const { launch, creator, identity, ledger } = args;
  checkPublicKey("launch", launch);
  checkPublicKey("creator", creator);
  if (identity === null || typeof identity !== "object" || identity.keyPair === undefined) throw new TypeError("identity must be a PqIdentity (deriveIdentity)");
  if (identity.keyPair.wiped) throw new Error("this identity's key pair was wiped: derive it again");
  const lmsPublicKey = identity.keyPair.publicKey;
  const id = pqIdentity.identityId(lmsPublicKey);
  if (!bytesEqual(id, identity.identityId)) throw new Error("identity.identityId is not the id of its key pair");
  checkBytes("metadataHash", args.metadataHash, 32);
  const metadataHash = Uint8Array.from(args.metadataHash);
  const rulesHash = args.rulesHash === undefined ? new Uint8Array(32) : Uint8Array.from(args.rulesHash);
  checkBytes("rulesHash", rulesHash, 32);
  const expectedMessageHash = args.expectedMessageHash === undefined ? null : Uint8Array.from(args.expectedMessageHash);
  if (expectedMessageHash !== null) checkBytes("expectedMessageHash", expectedMessageHash, 32);
  const maxBurnOnly = args.maxBurnOnlyLandings ?? MAX_BURN_ONLY_LANDINGS;
  if (!Number.isInteger(maxBurnOnly) || maxBurnOnly < 0) throw new RangeError("maxBurnOnlyLandings must be a non-negative integer");
  const recordCommitment = args.metadataCommitment ?? "finalized";
  if (recordCommitment !== "finalized" && recordCommitment !== "confirmed") throw new RangeError('metadataCommitment must be "finalized" or "confirmed"');
  const payer = args.payer ?? Keypair.generate();
  const warnings: string[] = [];
  if (payer.publicKey.equals(creator)) warnings.push("the creator's wallet pays this attestation: a fresh throwaway payer keeps the wallet out of it");
  const { notBefore, notAfter } = args.window;
  if (typeof notBefore !== "bigint" || typeof notAfter !== "bigint") throw new TypeError("the window must be bigint unix seconds");
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

  assertSimulatedCluster(identity.cluster, { allowLocalnet: args.allowLocalnet });

  await latency("read");
  const s = chain();
  const ml = s.launches[launch.toBase58()];
  if (ml === undefined) throw new Error(`refusing to sign: launch ${launch.toBase58()} does not exist (a signature over it could never land)`);
  const l = toLaunchAccount(ml);
  if (!launchAddress(l.creator, l.launchSeed).equals(launch)) throw new Error("refusing to sign: the launch account is not at the PDA of its own creator and seed");
  if (l.status !== "configured") throw new Error("refusing to sign: the launch is already live (an attestation now would only burn a leaf)");
  if (!l.creator.equals(creator)) throw new Error(`refusing to sign: the launch was created by ${l.creator.toBase58()}, not by this wallet (${creator.toBase58()})`);
  if (!bytesEqual(l.pqIdentity, id)) throw new Error("refusing to sign: the launch names another post-quantum identity (this signature would only burn a leaf)");
  if (expectedParamsHash !== null && !bytesEqual(l.paramsHash, expectedParamsHash)) {
    throw new Error("refusing to sign: the launch's parameters are not the ones reviewed (params_hash differs); never sign a configuration you did not check");
  }

  // The clock (audit 4, ID-F1b / ID-F5): the network's must agree with this device's; the window must suit both.
  const clock = mockCheckClockSkew(args);
  const now = clock.clusterSecs;
  const margin = args.landingMarginSecs ?? ATTEST_LANDING_MARGIN_SECS;
  const w = validateLaunchWindow(notBefore, notAfter, { nowSecs: now, landingMarginSecs: margin });
  if (!w.ok) throw new Error(`refusing to sign: attest_launch would only burn a leaf with this window (cluster time ${unixToUtcText(now)}):\n${w.errors.join("\n")}`);
  const local = validateLaunchWindow(notBefore, notAfter, { nowSecs: clock.localSecs, landingMarginSecs: margin });
  if (!local.ok) throw new Error(`refusing to sign: by this device's clock (${unixToUtcText(clock.localSecs)}) this window could not be used:\n${local.errors.join("\n")}`);

  const message = pqIdentity.attestationMessage({ launch, paramsHash: l.paramsHash, creator: l.creator, metadataHash, rulesHash, notBefore, notAfter });
  const messageHash = sha256(message);
  // The message the user reviewed, before anything is reserved or signed (audit 4, ID-F6).
  if (expectedMessageHash !== null && !bytesEqual(messageHash, expectedMessageHash)) {
    throw new Error(
      "refusing to sign: the message built from the chain and these inputs differs from the one reviewed (expectedMessageHash): its launch, parameters, records or window changed. Nothing was signed; review the plan again",
    );
  }
  const common = {
    launch,
    message,
    messageHash,
    lmsPublicKey,
    identityId: id,
    metadataHash,
    rulesHash,
    rules: rulesAccountFor(launch, rulesHash),
    tokenMeta: tokenMetaAddress(launch, metadataHash),
    window: { notBefore, notAfter },
    windowIso: { notBefore: unixToIso(notBefore), notAfter: unixToIso(notAfter) },
    warnings,
  };

  const current = s.attestations[launch.toBase58()];
  const attestation = current === undefined ? null : { ...current };
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

  if (tokenMetaAt(s, launch, metadataHash) === null) {
    throw new Error(
      `refusing to sign: no metadata record is published at ${common.tokenMeta.toBase58()} (publish it with buildPublishMetadataTx and wait until it is final): attest_launch attests only a record that exists, so this signature would only burn its leaf`,
    );
  }

  // Attestation v3: a signature over rules that are not published would only burn its leaf.
  if (!isZeroHash(rulesHash) && publishedRules(launch.toBase58(), rulesHash) === null) {
    throw new Error(
      `refusing to sign: no valid rules record is published at ${common.rules?.toBase58() ?? "?"} (publish the rules with buildPublishRulesV1Tx and wait until they are final): attest_launch attests only rules that exist, so this signature would only burn its leaf`,
    );
  }
  const size = attestTransactionSize({ priorityFee: attestTxConfig(args).priorityFeeLamports !== null, rules: !isZeroHash(rulesHash) });
  if (size > V1_MAX_TRANSACTION_SIZE) throw new Error(`refusing to sign: the attest transaction would be ${size} bytes (limit ${V1_MAX_TRANSACTION_SIZE})`);
  const rents = attestRents(s, launch, lmsPublicKey);
  const fundingLamports = rents.identity + rents.attestation + attestFeeLamports(args);

  // Audit 4, ID-F4: "the cap, reserve, sign" under the launch's signing lock, so two calls never both pass.
  return withSigningLock(launch, args.signingLock, async (): Promise<AttestLaunchTx> => {
    const st = chain();
    const used = usedOf(st, id);
    // A record whose message the attestation holds landed with a known outcome (the account names its hash and leaf).
    if (attestation !== null && attestation.attested) {
      const rec = await ledger.get(id, attestation.leaf);
      if (rec !== null && rec.messageHash === toHex(attestation.messageHash) && rec.signature !== null && !(rec.status === "landed" && rec.attested === true)) {
        await ledger.markLanded(id, attestation.leaf, { slot: attestation.slot, attested: true });
      }
    }
    const mine = await ledger.findByMessage(id, messageHash);
    const rebuild = mine !== null && mine.signature !== null && leafLedger.holdsMessageLeaf(mine);
    if (!rebuild) {
      // ID-F2: at most MAX_UNLANDED_SIGNATURES signatures of this launch that never landed with success.
      const unlanded = (await leafLedger.launchSignatures(ledger, id, launch)).filter((x) => !bytesEqual(x.messageHash, messageHash) && countsAsUnlanded(x.record));
      if (unlanded.length >= MAX_UNLANDED_SIGNATURES && args.acknowledgeExtraSignatures !== true) {
        throw new SignatureCapError(launch, "attestation", unlanded.map((x) => x.leaf), MAX_UNLANDED_SIGNATURES);
      }
    }
    // Each burn-only landing spent a leaf: past the cap, no new leaf for this launch (a rebuild of a recorded signature spends none).
    const burnOnly = (await ledger.list(id)).filter((r) => isBurnOnlyLanding(r, launch, used));
    if (burnOnly.length >= maxBurnOnly && !(mine !== null && leafLedger.holdsMessageLeaf(mine))) {
      const landings: BurnOnlyLanding[] = burnOnly.map((r) => {
        const reasons = recordBurnReasons(st, r, l.pqIdentity, id, attestation);
        return { leaf: r.leaf, reasons, detail: burnDetail(r.leaf, reasons) };
      });
      throw new AttestRetryLimitError(launch, landings);
    }
    // The leaf: the secret probe and the ledger only (UnknownLeavesError before anything is reserved), then the signature.
    // A message whose leaf is set on-chain gets its recorded bytes back (no new signature) and is not re-sent.
    const { leaf, signature: lmsSignature, selection } = await leafLedger.signAtNextLeaf(ledger, identity.keyPair, message, used, { launch });
    if (selection.kind === "existing" && selection.onChain) return { ...common, status: "leaf-landed", leaf };
    if (lms.lmsVerify(lmsPublicKey, message, lmsSignature) !== leaf) throw new Error("the LMS signature does not verify at its leaf (corrupted record?)");
    if (selection.choice.warn) warnings.push(`this identity has used ${selection.choice.usedCount} of 1,024 leaves on-chain: move to the next identity index soon`);

    const signed = signedAttest(st, payer, { launch, lmsPublicKey, lmsSignature, leaf, message, metadataHash, rulesHash, notBefore, notAfter }, args);
    return {
      ...common,
      status: "ready",
      tx: signed.tx,
      signature: signed.signature,
      payer,
      blockhash: signed.blockhash,
      lastValidBlockHeight: st.slot + 150,
      leaf,
      lmsSignature,
      leafChoice: selection.choice,
      retry: selection.kind === "existing" && selection.record.signature !== null,
      sizeBytes: signed.sizeBytes,
      computeUnitLimit: signed.computeUnitLimit,
      priorityFeeLamports: signed.priorityFeeLamports,
      fundingLamports,
    } satisfies AttestLaunchReady;
  });
}

/** MOCK `buildPlannedAttestTx`. */
export const buildPlannedAttestTx: Sdk["buildPlannedAttestTx"] = async (_conn, plan, args) => {
  if (!bytesEqual(args.identity.identityId, plan.pqIdentity)) throw new Error("this identity is not the one the plan names");
  const built = await buildAttestLaunchTx({
    ...args,
    launch: plan.launch,
    creator: plan.creator,
    metadataHash: plan.metadataHash,
    rulesHash: plan.rulesHash,
    window: plan.window,
    expectedParamsHash: plan.paramsHash,
    // SDK 0.9.0: a changed plan is refused before anything is reserved (audit 4, ID-F6).
    expectedMessageHash: plan.messageHash,
  });
  return built;
};

/** MOCK `rewrapAttestTx`: the same signature in a new transaction (a fresh blockhash), signed by the same payer. */
function rewrapAttestTx(built: AttestLaunchReady): AttestLaunchReady {
  const f = pqIdentity.parseAttestationMessage(built.message);
  if (!f.launch.equals(built.launch) || !bytesEqual(f.metadataHash, built.metadataHash)) throw new Error("the built transaction's message is for another launch or record");
  if (lms.lmsVerify(built.lmsPublicKey, built.message, built.lmsSignature) !== built.leaf) throw new Error("the recorded signature does not verify at its leaf over this message");
  const s = chain();
  const signed = signedAttest(
    s,
    built.payer,
    { launch: built.launch, lmsPublicKey: built.lmsPublicKey, lmsSignature: built.lmsSignature, leaf: built.leaf, message: built.message, metadataHash: built.metadataHash, rulesHash: f.rulesHash, notBefore: f.notBefore, notAfter: f.notAfter },
    { computeUnitLimit: built.computeUnitLimit },
  );
  return { ...built, tx: signed.tx, signature: signed.signature, blockhash: signed.blockhash, lastValidBlockHeight: s.slot + 150, retry: true, sizeBytes: signed.sizeBytes };
}

/** The SDK's `confirm`: what became of a message's attestation, with the ledger updated. */
async function confirm(
  launch: PublicKey,
  expectedMessageHash: Uint8Array,
  opts: Parameters<Sdk["confirmAttestation"]>[3] & {},
  leafKnownUsed: boolean,
): Promise<AttestationOutcome> {
  checkPublicKey("launch", launch);
  checkBytes("expected message hash", expectedMessageHash, 32);
  let window: { notBefore: bigint; notAfter: bigint } | undefined;
  let recordHash: Uint8Array | null = null;
  if (opts.message !== undefined) {
    if (!bytesEqual(sha256(opts.message), expectedMessageHash)) throw new Error("opts.message does not hash to the expected message hash");
    const f = pqIdentity.parseAttestationMessage(opts.message);
    if (!f.launch.equals(launch)) throw new Error("opts.message is for another launch");
    window = { notBefore: f.notBefore, notAfter: f.notAfter };
    recordHash = f.metadataHash;
  }
  const mh = toHex(expectedMessageHash);
  await latency("read");
  const s = chain();
  const current = s.attestations[launch.toBase58()];
  const attestation = current === undefined ? null : { ...current };
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
  checkBytes("LMS public key", opts.lmsPublicKey, PQ_IDENTITY.PUBLIC_KEY_LEN);
  const id = pqIdentity.identityId(opts.lmsPublicKey);
  if (!leafKnownUsed) {
    const identity = identityOf(s, opts.lmsPublicKey);
    if (identity === null || !pqIdentity.leafUsed(identity.used, opts.leaf)) {
      return { status: "pending", attestation, detail: `leaf ${opts.leaf} is not used on-chain: the transaction has not landed (re-send the same signature; never sign again)` };
    }
  }
  const l = s.launches[launch.toBase58()];
  const reasons = burnReasons({
    launchPqIdentity: l?.state.pqIdentity ?? null,
    identityId: id,
    recordExists: recordHash === null ? null : tokenMetaAt(s, launch, recordHash) !== null,
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

/**
 * MOCK `landOrBurnPending`: the simulated chain lands every send at once and keeps no signature of the flow pending
 * (`buildAttestLaunchTx` never refuses with `PendingAttestationError` here), so there is nothing to land.
 */
export const landOrBurnPending: Sdk["landOrBurnPending"] = async (_conn, args) => {
  checkPublicKey("launch", args.launch);
  await latency("read");
  return { landings: [], remaining: [] };
};

/** MOCK `confirmAttestation`. */
export const confirmAttestation: Sdk["confirmAttestation"] = (_conn, launch, expectedMessageHash, opts = {}) => confirm(launch, expectedMessageHash, opts, false);

/**
 * MOCK `sendAttestLaunchTx`: the SDK's balance checks (`AttestPayerFundingError`), the send, one more send of the
 * SAME signature after a ConstraintSeeds refusal, then what became of it (attested / burned / pending).
 */
export const sendAttestLaunchTx: Sdk["sendAttestLaunchTx"] = async (_conn, built, opts = {}) => {
  if (built.status !== "ready") throw new TypeError("only a built attest transaction (status ready) can be sent");
  await latency("read");
  const s = chain();
  const rents = attestRents(s, built.launch, built.lmsPublicKey);
  const required = rents.identity + rents.attestation + SIGNATURE_FEE + (built.priorityFeeLamports ?? 0n);
  const balance = solBalance(s, built.payer.publicKey);
  if (balance < required) {
    throw new AttestPayerFundingError(`the throwaway payer holds ${balance} lamports; it needs ${required} (fund it with buildFundThrowawayPayerTx)`, balance, required);
  }
  const floor = mockRent(0);
  if (balance > required && balance - required < floor) {
    throw new AttestPayerFundingError(
      `the throwaway payer would keep ${balance - required} lamports, below the rent-exempt minimum of ${floor}: the runtime would refuse the transaction (fund exactly ${required}, or at least ${required + floor})`,
      balance,
      required,
    );
  }
  const sendOnce = async (b: AttestLaunchReady): Promise<unknown> => {
    try {
      await send(b.tx);
      return null;
    } catch (e) {
      return e;
    }
  };
  let sendError = await sendOnce(built);
  if (sendError !== null && customErrorCode(sendError) === CONSTRAINT_SEEDS) {
    // Nothing was written and the leaf is intact: the same signature again, with the accounts it names.
    sendError = await sendOnce(rewrapAttestTx(built));
  }
  const outcome = await confirm(
    built.launch,
    built.messageHash,
    { leaf: built.leaf, lmsPublicKey: built.lmsPublicKey, message: built.message, ledger: opts.ledger, landedAt: BigInt(nowSecs()) },
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
};

// ----------------------------------------------------------------- create ---

/** MOCK `buildPlannedCreateLaunchTx`: create_launch for the plan (its seed), refusing another address than the plan's. */
export const buildPlannedCreateLaunchTx: Sdk["buildPlannedCreateLaunchTx"] = async (conn, plan, opts = {}) => {
  const r = await buildCreateLaunchTx(conn, plan.creator, plan.params, { ...opts, launchSeed: plan.launchSeed });
  if (!r.launch.equals(plan.launch)) throw new Error("create_launch derived another launch address than the plan");
  return { tx: r.tx as Transaction, launch: r.launch, warnings: r.warnings };
};

// ----------------------------------------------------------------- status ---

const max0 = (v: bigint): bigint => (v > 0n ? v : 0n);

/** What the SDK's `getLaunchFlowStatus` warns at a missed window (SDK 0.5.0, review info #2). */
const WINDOW_MISSED_WARNING =
  "An earlier signature for this launch that was sent but never landed can still take its place if its own time window has not ended: land it first (landOrBurnPending) or wait until that window ends.";

/** MOCK `getLaunchFlowStatus`: the SDK's steps and summaries over the simulated chain. */
export const getLaunchFlowStatus: Sdk["getLaunchFlowStatus"] = async (_conn, launch, opts = {}) => {
  checkPublicKey("launch", launch);
  if (opts.nowSecs !== undefined) inLaunchWindow(opts.nowSecs, 0n, 0n); // the SDK's checks of a "now"
  await latency("read");
  const s = chain();
  const ml = s.launches[launch.toBase58()];
  const account = ml === undefined ? null : toLaunchAccount(ml);
  const raw = s.attestations[launch.toBase58()];
  const attestation = raw === undefined ? null : { ...raw };
  const nowSecsValue = opts.nowSecs ?? BigInt(nowSecs());
  const commit = opts.owner === undefined ? null : (s.commits[`${launch.toBase58()}:${opts.owner.toBase58()}`] ?? null);
  const attestationState = attestation === null ? "none" : attestation.attested ? "attested" : "empty";
  const attested = attestation !== null && attestation.attested ? attestation : null;
  if (opts.expectedMetadataHash !== undefined && (!(opts.expectedMetadataHash instanceof Uint8Array) || opts.expectedMetadataHash.length !== 32)) {
    throw new RangeError("expectedMetadataHash must be 32 bytes");
  }
  const recordHash = attested?.metadataHash ?? opts.expectedMetadataHash ?? null;
  const tokenMeta = recordHash === null || account === null ? null : tokenMetaAt(s, launch, recordHash);
  const window = attested === null ? null : { notBefore: attested.notBefore, notAfter: attested.notAfter };
  const attestedMessageMatches = opts.expectedMessageHash === undefined || attested === null ? null : bytesEqual(attested.messageHash, opts.expectedMessageHash);
  // Attestation v3: the creator rules (the attested ones, else the ones this client publishes).
  const rulesKnown = attested !== null && !isZeroHash(attested.rulesHash) ? attested.rulesHash : opts.expectedRulesHash !== undefined && !isZeroHash(opts.expectedRulesHash) ? opts.expectedRulesHash : null;
  const base = {
    launch,
    nowSecs: nowSecsValue,
    account,
    attestation,
    attestationState,
    attestedMessageMatches,
    tokenMeta,
    metadataPublished: recordHash === null || account === null ? null : tokenMeta !== null,
    rulesPublished: rulesKnown === null || account === null ? null : publishedRules(launch.toBase58(), rulesKnown) !== null,
    window,
    windowIso: window === null ? null : { notBefore: unixToIso(window.notBefore), notAfter: unixToIso(window.notAfter) },
    secondsUntilWindowOpens: window === null ? null : max0(window.notBefore - nowSecsValue),
    secondsUntilWindowCloses: window === null ? null : max0(window.notAfter - nowSecsValue),
    commit: commit === null ? null : { ...commit },
  } as const;
  const done = (step: LaunchFlowStep, summary: string, extra: { canLaunchNow?: boolean; phase?: LaunchPhase | null; batch?: LaunchFlowStatus["batch"] } = {}): LaunchFlowStatus => ({
    ...base,
    step,
    summary,
    canLaunchNow: extra.canLaunchNow ?? false,
    phase: extra.phase ?? null,
    batch: extra.batch ?? null,
    // SDK 0.5.0: the simulated chain keeps no unlanded signatures apart from the flow's own (never pending here), and a
    // missed window carries the SDK's warning about an earlier signature that could still land.
    pendingSignatures: null,
    warnings: step === "window-missed" ? [WINDOW_MISSED_WARNING] : [],
  });
  if (account === null) return done("create", "No launch at this address yet: the creator's wallet signs create_launch.");
  if (account.status === "configured") {
    if (window === null && opts.expectedMetadataHash !== undefined && tokenMeta === null) {
      return done("publish", "Created: publish the token's metadata record (name, symbol, description, icon), wait until it is final, then the identity attests.");
    }
    if (window === null) {
      return done(
        "attest",
        attestationState === "empty"
          ? "A signature only burned its leaf without attesting (wrong identity, a metadata record that was not published, or the window): the identity must attest again."
          : "Created: the creator's post-quantum identity must attest it (after its metadata record is published and final) before it can go live.",
      );
    }
    if (nowSecsValue < window.notBefore) return done("wait-for-window", `Attested: anyone may launch it from ${window.notBefore} (unix seconds), in ${window.notBefore - nowSecsValue} s.`);
    if (inLaunchWindow(nowSecsValue, window.notBefore, window.notAfter)) {
      return done("launch", "Inside the launch window: anyone may launch it now; the first launch transaction to land wins.", { canLaunchNow: true });
    }
    return done("window-missed", "Window passed: sign a new opening time. Nobody launched it in time, so the creator's identity signs a new window (the same token details can be reused).");
  }
  const phase = launchPhase(account, nowSecsValue);
  const batch = batchOutcome(account, nowSecsValue);
  const extra = { phase, batch };
  if (nowSecsValue < account.commitEndTs) return done("commit", "Live: the fair-open batch takes commits now.", extra);
  if (!account.executed && nowSecsValue < account.executeEndTs) {
    return account.totalCommitted > 0n
      ? done("execute", "The commit window closed: anyone may execute the batch now (keepers pay a priority fee).", extra)
      : done("trading", "Nobody committed to the batch: there is nothing to execute or claim.", extra);
  }
  if (account.totalCommitted === 0n) return done("trading", "Nobody committed to the batch: there is nothing to claim.", extra);
  if (opts.owner !== undefined) {
    if (commit === null) return done("trading", "This wallet has no commit in the batch.", extra);
    if (commit.claimed) return done("trading", "This commit has been claimed.", extra);
  }
  return done(
    "claim",
    account.executed ? "The batch executed: claims pay each commit's tokens and unspent SOL to its payout owners." : "Nobody executed the batch in time: claims refund every commit in full.",
    extra,
  );
};

/** Only for tests: the leaf bitmap the simulated chain holds for an identity id (zeros before its first landing). */
export function identityBitmapForTests(id: Uint8Array): Uint8Array {
  return Uint8Array.from(usedOf(chain(), id));
}


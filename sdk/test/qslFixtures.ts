/**
 * A certified, attested Noised launch for the QSL-1 tests, built from the
 * real layouts and the Rust vectors (tests/integration/vectors, copied in
 * `vectors/`):
 *
 * - `qslWorld()` is the launch of `lms.json`: the Attestation (version 3,
 *   2,708 bytes, no rules), Identity and TokenMeta accounts are the bytes the
 *   Rust vector writer produced (`lms.json` `accounts`: launch DD2NGj...,
 *   identity leaf 511 used, the attestation at leaf 511 in slot 400,000,000
 *   with the window 1,767,225,600..1,767,229,200, the record "Noised Vector
 *   Token"), verbatim;
 * - `programmableWorld()` is the launch of `programmable.json` (6viSy7...):
 *   its attestation v3 binds the "typical" launch rules, whose LaunchRules
 *   record is the Rust bytes verbatim; the certificate binds them (checks
 *   8,191) and the hook policy v2 holds them: QSL-1 level 2, programmable
 *   (its rules);
 * - the Launch account is the vector's bytes (what `create_launch` wrote
 *   for the attestation: creator, seed, params_hash, pq_identity) completed
 *   at QSL-1 §5.2's offsets as `launch` leaves it (Live, the mint, the pool,
 *   the timeline, an executed batch);
 * - the Certificate (§5.1: version 4, 519 bytes; `legacy()` makes it the
 *   version-3 generation: certificate 487 bytes, attestation v2 signed over
 *   message v2, policy v1 of 275 bytes) and the hook policy (§5.6) are
 *   written byte by byte at the standard's offsets, and the hook account list
 *   is §5.7's hex (the tests check these bytes decode through the programs'
 *   IDLs to the same fields);
 * - `addAutopilot` adds an autopilot running a published graph, activated by
 *   an authorization the vector identity signs (written at the
 *   Authorization offsets, checked against the Rust vector's bytes), and
 *   `addVectorActivation` the Rust vector's own kind-1 authorization;
 * - the mint is Token-2022's layout (§5.8) holding the record's name and
 *   symbol and the derived (empty) uri;
 * - Meteora's accounts (DBC config and pool, DAMM v2 pool and position) are
 *   encoded with Meteora's IDLs, as §5.9 reads them;
 * - program accounts are the upgradeable loader's layout, and the RPC's
 *   genesis hash is mainnet-beta's.
 *
 * Every field is a mutable input of `build()`, and `patch` edits raw bytes
 * after it, so each test breaks exactly one condition.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { PublicKey } from "@solana/web3.js";

import { concatBytes, fromHex, u32le, utf8 } from "../src/codec/bytes.js";
import { DAMM_V2_MIGRATION_CONFIGS, KNOWN_ACCOUNTS, PROGRAM_IDS, TRUST_ANCHORS, WSOL_MINT } from "../src/constants.js";
import {
  attestationAddress,
  autopilotAddress,
  certificateAddress,
  dammV2PoolAddress,
  dammV2PositionAddress,
  dammV2PositionNftAccountAddress,
  dbcPoolAddress,
  dbcTokenVaultAddress,
  extraAccountMetaListAddress,
  graphRecordAddress,
  hookPolicyAddress,
  identityAddressFromId,
  launchPdasFromLaunch,
  programDataAddress,
  type LaunchPdas,
} from "../src/pda.js";
import { attestationMessage, authorizationMessage } from "../src/pq/identity.js";
import { signLeafDeterministic } from "../src/pq/lms.js";
import { activationPayload, freezePayload } from "../src/programmable/autopilot/logic.js";
import { graphHash } from "../src/programmable/hash.js";
import { QSL1 } from "../src/qsl/layouts.js";
import { GENESIS_HASHES } from "../src/rpc/cluster.js";
import { emulatedMetadataHash, emulatedTokenMetaBytes } from "./attest_world.js";
import { ext, key, MockConnection, mintBytes, readJson, T22, tokenAccountBytes, upgradeableProgram, type TlvSpec } from "./helpers.js";
import { LMS, pristinePoolFees, vectorIdentity } from "./verifyFixtures.js";
import { accountBytes, zeroed } from "./world.js";

export const SUPPLY = 1_000_000_000_000_000n;
export const THRESHOLD = 85_000_000_000n;

// ------------------------------------------------------ byte writers ---

function w8(d: Uint8Array, o: number, v: number): void {
  d[o] = v;
}
function w16(d: Uint8Array, o: number, v: number): void {
  new DataView(d.buffer, d.byteOffset, d.byteLength).setUint16(o, v, true);
}
function w32(d: Uint8Array, o: number, v: number): void {
  new DataView(d.buffer, d.byteOffset, d.byteLength).setUint32(o, v, true);
}
function w64(d: Uint8Array, o: number, v: bigint): void {
  new DataView(d.buffer, d.byteOffset, d.byteLength).setBigUint64(o, BigInt.asUintN(64, v), true);
}
function wkey(d: Uint8Array, o: number, k: PublicKey | Uint8Array): void {
  d.set(k instanceof PublicKey ? k.toBytes() : k, o);
}
function wrecipients(d: Uint8Array, o: number, r: readonly { wallet: PublicKey; bps: number }[]): void {
  r.forEach((x, i) => {
    wkey(d, o + 34 * i, x.wallet);
    w16(d, o + 34 * i + 32, x.bps);
  });
}

export interface Recipient {
  wallet: PublicKey;
  bps: number;
}

/** The certificate's fields (QSL-1 §5.1); booleans as bytes. */
export interface CertFields {
  version: number;
  bump: number;
  launch: PublicKey;
  baseMint: PublicKey;
  pool: PublicKey;
  dbcConfig: PublicKey;
  creator: PublicKey;
  launchedAt: bigint;
  tokenDecimal: number;
  initialSupply: bigint;
  checks: number;
  migrationQuoteThreshold: bigint;
  migrationFeeOption: number;
  snipeShieldEndTs: bigint;
  executeEndTs: bigint;
  guardEndTs: bigint;
  maxWallet: bigint;
  maxBuy: bigint;
  p2pLocked: number;
  platformFeeBps: number;
  recipients: Recipient[];
  paramsHash: Uint8Array;
  policyVersion: number;
  pqIdentity: Uint8Array;
  pqLeaf: number;
  attestedSlot: bigint;
  metadata: PublicKey;
  /** 487..519: the 519-byte layout (version 4); null writes the 487-byte layout (version 3). */
  rulesHash: Uint8Array | null;
}

/** QSL-1 §5.1, written at its offsets (519 bytes with `rulesHash`, 487 without). */
export function certificateBytes(f: CertFields): Uint8Array {
  const d = new Uint8Array(f.rulesHash === null ? QSL1.CERTIFICATE.V3_LEN : QSL1.CERTIFICATE.LEN);
  d.set(fromHex(QSL1.CERTIFICATE.DISCRIMINATOR), 0);
  w8(d, 8, f.version);
  w8(d, 9, f.bump);
  wkey(d, 10, f.launch);
  wkey(d, 42, f.baseMint);
  wkey(d, 74, f.pool);
  wkey(d, 106, f.dbcConfig);
  wkey(d, 138, f.creator);
  w64(d, 170, f.launchedAt);
  w8(d, 178, f.tokenDecimal);
  w64(d, 179, f.initialSupply);
  w32(d, 187, f.checks);
  w64(d, 191, f.migrationQuoteThreshold);
  w8(d, 199, f.migrationFeeOption);
  w64(d, 200, f.snipeShieldEndTs);
  w64(d, 208, f.executeEndTs);
  w64(d, 216, f.guardEndTs);
  w64(d, 224, f.maxWallet);
  w64(d, 232, f.maxBuy);
  w8(d, 240, f.p2pLocked);
  w16(d, 241, f.platformFeeBps);
  wrecipients(d, 243, f.recipients);
  wkey(d, 379, f.paramsHash);
  w16(d, 411, f.policyVersion);
  wkey(d, 413, f.pqIdentity);
  w16(d, 445, f.pqLeaf);
  w64(d, 447, f.attestedSlot);
  wkey(d, 455, f.metadata);
  if (f.rulesHash !== null) wkey(d, 487, f.rulesHash);
  return d;
}

/** What `launch` and the batch write into a Launch account (QSL-1 §5.2 offsets); the rest stays the vector's. */
export interface LaunchFields {
  status: number;
  dbcConfig: PublicKey;
  launchAuthority: PublicKey;
  batchAuthority: PublicKey;
  baseMint: PublicKey;
  pool: PublicKey;
  treasury: PublicKey;
  platformFeeBps: number;
  recipients: Recipient[];
  recipientCount: number;
  tokenDecimal: number;
  migrationQuoteThreshold: bigint;
  migrationFeeOption: number;
  openDelaySecs: number;
  guardSecs: number;
  maxWalletBps: number;
  maxBuyBps: number;
  p2pLocked: number;
  batchWalletCap: bigint;
  batchTotalCap: bigint;
  launchTs: bigint;
  commitEndTs: bigint;
  executeEndTs: bigint;
  guardEndTs: bigint;
  totalCommitted: bigint;
  executed: number;
  quoteSpent: bigint;
  tokensOut: bigint;
  tokensClaimed: bigint;
  quoteRefunded: bigint;
}

/** A vector's Launch bytes (create_launch's), completed at §5.2's offsets. */
export function launchBytes(f: LaunchFields, base: Uint8Array = fromHex(LMS.accounts.launch.data), launch: PublicKey = new PublicKey(LMS.accounts.launch.address)): Uint8Array {
  const d = Uint8Array.from(base);
  const bump = (seed: string, k: PublicKey): number => PublicKey.findProgramAddressSync([utf8(seed), k.toBytes()], PROGRAM_IDS.launchpad)[1];
  w8(d, 10, bump("authority", launch));
  w8(d, 11, bump("batch", launch));
  w8(d, 12, bump("dbc-config", launch));
  w8(d, 13, f.status);
  wkey(d, 78, f.dbcConfig);
  wkey(d, 110, f.launchAuthority);
  wkey(d, 142, f.batchAuthority);
  wkey(d, 174, f.baseMint);
  wkey(d, 206, f.pool);
  wkey(d, 238, f.treasury);
  w16(d, 270, f.platformFeeBps);
  wrecipients(d, 272, f.recipients);
  w8(d, 408, f.recipientCount);
  w8(d, 409, f.tokenDecimal);
  w64(d, 410, f.migrationQuoteThreshold);
  w8(d, 418, f.migrationFeeOption);
  w32(d, 419, f.openDelaySecs);
  w32(d, 423, f.guardSecs);
  w16(d, 427, f.maxWalletBps);
  w16(d, 429, f.maxBuyBps);
  w8(d, 431, f.p2pLocked);
  w64(d, 432, f.batchWalletCap);
  w64(d, 440, f.batchTotalCap);
  w64(d, 480, f.launchTs);
  w64(d, 488, f.commitEndTs);
  w64(d, 496, f.executeEndTs);
  w64(d, 504, f.guardEndTs);
  w64(d, 512, f.totalCommitted);
  w8(d, 520, f.executed);
  w64(d, 521, f.quoteSpent);
  w64(d, 529, f.tokensOut);
  w64(d, 537, f.tokensClaimed);
  w64(d, 545, f.quoteRefunded);
  return d;
}

/** The hook policy's fields (QSL-1 §5.6). */
export interface PolicyFields {
  version: number;
  bump: number;
  mint: PublicKey;
  pool: PublicKey;
  baseVault: PublicKey;
  launchTs: bigint;
  snipeShieldEndTs: bigint;
  guardEndTs: bigint;
  maxWallet: bigint;
  maxBuy: bigint;
  p2pLocked: number;
  exempt: PublicKey[];
  /** Version 2's rule bytes (u32 length at 275, bytes from 279; empty for none); null writes the 275-byte layout (version 1). */
  rules: Uint8Array | null;
}

/** QSL-1 §5.6, written at its offsets (`279 + rules` bytes, or 275 without the rules field). */
export function policyBytes(f: PolicyFields): Uint8Array {
  const d = new Uint8Array(f.rules === null ? QSL1.HOOK_POLICY.V1_LEN : QSL1.HOOK_POLICY.LEN + f.rules.length);
  d.set(fromHex(QSL1.HOOK_POLICY.DISCRIMINATOR), 0);
  w8(d, 8, f.version);
  w8(d, 9, f.bump);
  wkey(d, 10, f.mint);
  wkey(d, 42, f.pool);
  wkey(d, 74, f.baseVault);
  w64(d, 106, f.launchTs);
  w64(d, 114, f.snipeShieldEndTs);
  w64(d, 122, f.guardEndTs);
  w64(d, 130, f.maxWallet);
  w64(d, 138, f.maxBuy);
  w8(d, 146, f.p2pLocked);
  f.exempt.forEach((k, i) => wkey(d, 147 + 32 * i, k));
  if (f.rules !== null) {
    w32(d, 275, f.rules.length);
    d.set(f.rules, 279);
  }
  return d;
}

/** The attestation's fields (QSL-1 §5.3). */
export interface AttestationFields {
  version: number;
  bump: number;
  launch: PublicKey;
  pqIdentity: Uint8Array;
  leaf: number;
  metadataHash: Uint8Array;
  /** 108..140 of the 2,708-byte layout (version 3); null writes the 2,676-byte layout (version 2). */
  rulesHash: Uint8Array | null;
  messageHash: Uint8Array;
  slot: bigint;
  notBefore: bigint;
  notAfter: bigint;
  signature: Uint8Array;
}

/** QSL-1 §5.3, written at its offsets (2,708 bytes with `rulesHash`, 2,676 without). */
export function attestationBytes(f: AttestationFields): Uint8Array {
  const v3 = f.rulesHash !== null;
  const s = v3 ? 32 : 0;
  const d = new Uint8Array(v3 ? QSL1.ATTESTATION.LEN : QSL1.ATTESTATION.V2_LEN);
  d.set(fromHex(QSL1.ATTESTATION.DISCRIMINATOR), 0);
  w8(d, 8, f.version);
  w8(d, 9, f.bump);
  wkey(d, 10, f.launch);
  wkey(d, 42, f.pqIdentity);
  w16(d, 74, f.leaf);
  wkey(d, 76, f.metadataHash);
  if (f.rulesHash !== null) wkey(d, 108, f.rulesHash);
  wkey(d, 108 + s, f.messageHash);
  w64(d, 140 + s, f.slot);
  w64(d, 148 + s, f.notBefore);
  w64(d, 156 + s, f.notAfter);
  w32(d, 164 + s, f.signature.length);
  d.set(f.signature, 168 + s);
  return d;
}

/** The 189-byte message v2 that launches with a version-3 certificate signed (QSL-1 §7.7.4), written here from the standard. */
export function attestationMessageV2(f: { launch: PublicKey; paramsHash: Uint8Array; creator: PublicKey; metadataHash: Uint8Array; notBefore: bigint; notAfter: bigint }): Uint8Array {
  const i64 = (v: bigint): Uint8Array => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigInt64(0, v, true);
    return b;
  };
  return concatBytes([utf8("PHX-ATTEST-V2"), PROGRAM_IDS.launchpad.toBytes(), f.launch.toBytes(), f.paramsHash, f.creator.toBytes(), f.metadataHash, i64(f.notBefore), i64(f.notAfter)]);
}

/** A LaunchRules record (§6.4 P.R3): discriminator, version 8, bump 9, launch 10, rules_hash 42, u32 length 74, bytes from 78. */
export function launchRulesBytes(f: { version: number; bump: number; launch: PublicKey; rulesHash: Uint8Array; bytes: Uint8Array }): Uint8Array {
  const d = new Uint8Array(QSL1.LAUNCH_RULES.FIXED_LEN + f.bytes.length);
  d.set(fromHex(QSL1.LAUNCH_RULES.DISCRIMINATOR), 0);
  w8(d, 8, f.version);
  w8(d, 9, f.bump);
  wkey(d, 10, f.launch);
  wkey(d, 42, f.rulesHash);
  w32(d, 74, f.bytes.length);
  d.set(f.bytes, 78);
  return d;
}

/** The fields of an Authorization (§6.4 P.G3; pq_authorize). */
export interface AuthorizationFields {
  version: number;
  bump: number;
  launch: PublicKey;
  pqIdentity: Uint8Array;
  kind: number;
  payloadHash: Uint8Array;
  messageHash: Uint8Array;
  unixTime: bigint;
  slot: bigint;
  leaf: number;
  signature: Uint8Array;
}

/** An Authorization written at its offsets (2,669 bytes). */
export function authorizationBytes(f: AuthorizationFields): Uint8Array {
  const d = new Uint8Array(QSL1.AUTHORIZATION.LEN);
  d.set(fromHex(QSL1.AUTHORIZATION.DISCRIMINATOR), 0);
  w8(d, 8, f.version);
  w8(d, 9, f.bump);
  wkey(d, 10, f.launch);
  wkey(d, 42, f.pqIdentity);
  w8(d, 74, f.kind);
  wkey(d, 75, f.payloadHash);
  wkey(d, 107, f.messageHash);
  w64(d, 139, f.unixTime);
  w64(d, 147, f.slot);
  w16(d, 155, f.leaf);
  w32(d, 157, f.signature.length);
  d.set(f.signature, 161);
  return d;
}

/** The fields of an Autopilot account a verifier reads (§6.4 P.G1); the rest (run state, prices, nodes) is zero. */
export interface AutopilotFields {
  version: number;
  bump: number;
  treasuryBump: number;
  launch: PublicKey;
  mint: PublicKey;
  dammPool: PublicKey;
  activeGraph: Uint8Array;
  pendingGraph: Uint8Array;
  pendingActivateAt: bigint;
  pendingOperator: PublicKey;
  activatedAt: bigint;
  frozen: number;
  operator: PublicKey;
  authMarks: { slot: bigint; key: PublicKey }[];
  seq: bigint;
  /** Audit 4 (A4-S): the authorization that activated the running graph (the default key: none recorded) and its activate_at. */
  activeAuth: PublicKey;
  activeActivateAt: bigint;
}

/** An Autopilot account written at its offsets (1,244 bytes since audit round 4). */
export function autopilotBytes(f: AutopilotFields): Uint8Array {
  const d = new Uint8Array(QSL1.AUTOPILOT.LEN);
  d.set(fromHex(QSL1.AUTOPILOT.DISCRIMINATOR), 0);
  w8(d, 8, f.version);
  w8(d, 9, f.bump);
  w8(d, 10, f.treasuryBump);
  wkey(d, 11, f.launch);
  wkey(d, 43, f.mint);
  wkey(d, 75, f.dammPool);
  wkey(d, 107, f.activeGraph);
  wkey(d, 139, f.pendingGraph);
  w64(d, 171, f.pendingActivateAt);
  wkey(d, 179, f.pendingOperator);
  w64(d, 211, f.activatedAt);
  w8(d, 219, f.frozen);
  wkey(d, 220, f.operator);
  f.authMarks.forEach((m, i) => {
    w64(d, 252 + 40 * i, m.slot);
    wkey(d, 260 + 40 * i, m.key);
  });
  w64(d, 372, f.seq);
  wkey(d, 1_076, f.activeAuth);
  w64(d, 1_108, f.activeActivateAt);
  return d;
}

/** A GraphRecord written at its offsets (`78 + len` bytes). */
export function graphRecordBytes(f: { version: number; bump: number; launch: PublicKey; graphHash: Uint8Array; bytes: Uint8Array }): Uint8Array {
  const d = new Uint8Array(QSL1.GRAPH_RECORD.FIXED_LEN + f.bytes.length);
  d.set(fromHex(QSL1.GRAPH_RECORD.DISCRIMINATOR), 0);
  w8(d, 8, f.version);
  w8(d, 9, f.bump);
  wkey(d, 10, f.launch);
  wkey(d, 42, f.graphHash);
  w32(d, 74, f.bytes.length);
  d.set(f.bytes, 78);
  return d;
}

// ------------------------------------------------------------- vectors ---

/** The parts of `programmable.json` the QSL tests read. */
export interface ProgrammableVectors {
  attestation: { accountData: string; address: string; notBefore: number; notAfter: number; q: number; rulesHash: string };
  authorizations: {
    activateAt: number;
    activeAuth: string;
    freezeNotAfter: number;
    autopilot: string;
    graphHash: string;
    operator: string;
    cases: { accountData: string; address: string; bump: number; kind: number; name: string; payloadHash: string; messageHash: string; message: string; q: number; signature: string }[];
  };
  identity: { address: string; data: string };
  launch: { address: string; creator: string; data: string; guardSecs: number; landsAt: number; metadataHash: string; paramsHash: string; pqIdentity: string; publicKey: string; slot: number; tokenMeta: string; tokenMetaData: string };
  rules: { accountData: string; address: string; bump: number; bytes: string; len: number; name: string; rulesHash: string }[];
}

export const PROG = readJson<ProgrammableVectors>("./vectors/programmable.json");

/** A valid PXG1 graph of the crate's vectors ("daily buyback and burn", 102 bytes). */
export const VECTOR_GRAPH: Uint8Array = fromHex(readJson<{ valid: { name: string; hex: string }[] }>("./vectors/programmable/graph.json").valid.find((v) => v.name === "daily buyback and burn")!.hex);

/** A record's raw fields. */
export interface RecordInput {
  name: string;
  symbol: string;
  flags: number;
  uri: string;
  doc: string;
}

/** A TokenMeta record's text fields (§5.5: flags at 10, then four borsh strings from 75). */
function recordText(d: Uint8Array): RecordInput {
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  let at = 75;
  const str = (): string => {
    const n = view.getUint32(at, true);
    const s = new TextDecoder().decode(d.subarray(at + 4, at + 4 + n));
    at += 4 + n;
    return s;
  };
  const flags = d[10]!;
  return { flags, name: str(), symbol: str(), uri: str(), doc: str() };
}

/** The launch a world is built on: a Rust vector's create_launch, attestation, identity and record. */
export interface VectorSource {
  launch: PublicKey;
  launchData: Uint8Array;
  creator: PublicKey;
  paramsHash: Uint8Array;
  pqIdentity: Uint8Array;
  attestation: Uint8Array;
  leaf: number;
  slot: bigint;
  notBefore: bigint;
  notAfter: bigint;
  identity: Uint8Array;
  tokenMeta: PublicKey;
  tokenMetaData: Uint8Array;
  record: RecordInput;
  guardSecs: number;
}

/** `lms.json`: no launch rules. */
export const LMS_SOURCE: VectorSource = {
  launch: new PublicKey(LMS.accounts.launch.address),
  launchData: fromHex(LMS.accounts.launch.data),
  creator: new PublicKey(LMS.attestation.creator),
  paramsHash: fromHex(LMS.attestation.paramsHash),
  pqIdentity: fromHex(LMS.identity.identityId),
  attestation: fromHex(LMS.accounts.attestation.data),
  leaf: LMS.accounts.attestation.leaf,
  slot: BigInt(LMS.accounts.attestation.slot),
  notBefore: BigInt(LMS.attestation.notBefore),
  notAfter: BigInt(LMS.attestation.notAfter),
  identity: fromHex(LMS.accounts.identity.data),
  tokenMeta: new PublicKey(LMS.accounts.tokenMeta.address),
  tokenMetaData: fromHex(LMS.accounts.tokenMeta.data),
  record: { name: LMS.metadata.name, symbol: LMS.metadata.symbol, flags: LMS.metadata.flags, uri: LMS.metadata.uri, doc: LMS.metadata.doc },
  guardSecs: 6 * 3_600,
};

/** `programmable.json`: the attestation binds the "typical" launch rules (leaf 534). */
export const PROGRAMMABLE_SOURCE: VectorSource = {
  launch: new PublicKey(PROG.launch.address),
  launchData: fromHex(PROG.launch.data),
  creator: new PublicKey(PROG.launch.creator),
  paramsHash: fromHex(PROG.launch.paramsHash),
  pqIdentity: fromHex(PROG.launch.pqIdentity),
  attestation: fromHex(PROG.attestation.accountData),
  leaf: PROG.attestation.q,
  slot: BigInt(PROG.launch.slot),
  notBefore: BigInt(PROG.attestation.notBefore),
  notAfter: BigInt(PROG.attestation.notAfter),
  identity: fromHex(PROG.identity.data),
  tokenMeta: new PublicKey(PROG.launch.tokenMeta),
  tokenMetaData: fromHex(PROG.launch.tokenMetaData),
  record: recordText(fromHex(PROG.launch.tokenMetaData)),
  guardSecs: PROG.launch.guardSecs,
};

// ------------------------------------------------------------- the world ---

/** The token's TokenMetadata as the mint stores it (raw); `additional` = extra key/value pairs (none on a launched mint). */
export interface MintMetadata {
  name: string;
  symbol: string;
  uri: string;
  additional: [string, string][];
  /** Default None (zero key). */
  updateAuthority?: PublicKey;
  /** The mint the metadata names (default: the mint itself). */
  metadataMint?: PublicKey;
}

export interface QslWorld {
  conn: MockConnection;
  source: VectorSource;
  mint: PublicKey;
  launch: PublicKey;
  pdas: LaunchPdas;
  creator: PublicKey;
  window: { notBefore: bigint; notAfter: bigint };
  cert: CertFields;
  launchState: LaunchFields;
  policy: PolicyFields;
  mintOpts: { mintAuthority: PublicKey | null; freezeAuthority: PublicKey | null; supply: bigint; decimals: number; owner: PublicKey; extensions: TlvSpec[]; trailing?: Uint8Array };
  /** Null: the TokenMetadata the mint holds is the record's name, symbol and derived uri. */
  mintMetadata: MintMetadata | null;
  config: Record<string, unknown> & { config: Record<string, unknown> };
  poolState: Record<string, unknown> & { poolState: Record<string, unknown> };
  /** Raw account bytes (Rust vectors by default). */
  attestation: Uint8Array;
  identity: Uint8Array;
  record: Uint8Array;
  /** The record's text fields (for the mint's metadata). */
  recordText: RecordInput;
  metaList: Uint8Array;
  /** The LaunchRules record (owner: the launchpad), when the launch has rules. */
  rulesRecord: { address: PublicKey; data: Uint8Array } | null;
  /** Upgrade authority of each Noised program (null: finalized). */
  upgradeAuthority: { launchpad: PublicKey | null; hook: PublicKey | null; autopilot: PublicKey | null };
  genesisHash: string;
  /** Raw edits applied after every account is written. */
  patches: ((w: QslWorld) => void)[];
  build(): void;
}

const tokenMetadataTlv = (mint: PublicKey, m: MintMetadata): TlvSpec => {
  const str = (s: string): Uint8Array => {
    const b = utf8(s);
    return concatBytes([u32le(b.length), b]);
  };
  return {
    type: 19,
    data: concatBytes([m.updateAuthority?.toBytes() ?? new Uint8Array(32), (m.metadataMint ?? mint).toBytes(), str(m.name), str(m.symbol), str(m.uri), u32le(m.additional.length), ...m.additional.flatMap(([k, v]) => [str(k), str(v)])]),
  };
};

/** The vector record's text, from `lms.json`. */
export const VECTOR_RECORD: RecordInput = { ...LMS_SOURCE.record };

/** The certified launch of the module docs: QSL-1 level 2 on mainnet with finalized programs (certificate v4, no rules). */
export function qslWorld(source: VectorSource = LMS_SOURCE): QslWorld {
  const conn = new MockConnection();
  const launch = source.launch;
  const creator = source.creator;
  const pdas = launchPdasFromLaunch(launch);
  const mint = key(source === LMS_SOURCE ? "qsl/mint" : "qsl/mint/programmable");
  const pool = dbcPoolAddress(pdas.dbcConfig, mint, WSOL_MINT);
  const notBefore = source.notBefore;
  const notAfter = source.notAfter;
  const launchTs = notBefore + 30n;
  const openDelay = 300;
  const guard = source.guardSecs;
  const commitEnd = launchTs + BigInt(openDelay);
  const executeEnd = commitEnd + 600n;
  const guardEnd = launchTs + BigInt(guard);
  const recipients: Recipient[] = [
    { wallet: key("qsl/r1"), bps: 7_000 },
    { wallet: key("qsl/r2"), bps: 3_000 },
    { wallet: PublicKey.default, bps: 0 },
    { wallet: PublicKey.default, bps: 0 },
  ];
  const maxWallet = (SUPPLY * 100n) / 10_000n;
  const maxBuy = (SUPPLY * 50n) / 10_000n;
  const [, certBump] = PublicKey.findProgramAddressSync([utf8("certificate"), mint.toBytes()], PROGRAM_IDS.launchpad);
  const [, policyBump] = PublicKey.findProgramAddressSync([utf8("policy"), mint.toBytes()], PROGRAM_IDS.hook);

  const w: QslWorld = {
    conn,
    source,
    mint,
    launch,
    pdas,
    creator,
    window: { notBefore, notAfter },
    cert: {
      version: 4,
      bump: certBump,
      launch,
      baseMint: mint,
      pool,
      dbcConfig: pdas.dbcConfig,
      creator,
      launchedAt: launchTs,
      tokenDecimal: 6,
      initialSupply: SUPPLY,
      checks: 4_095,
      migrationQuoteThreshold: THRESHOLD,
      migrationFeeOption: 2,
      snipeShieldEndTs: executeEnd,
      executeEndTs: executeEnd,
      guardEndTs: guardEnd,
      maxWallet,
      maxBuy,
      p2pLocked: 0,
      platformFeeBps: 1_000,
      recipients: recipients.map((r) => ({ ...r })),
      paramsHash: source.paramsHash,
      policyVersion: 3,
      pqIdentity: source.pqIdentity,
      pqLeaf: source.leaf,
      attestedSlot: source.slot,
      metadata: source.tokenMeta,
      rulesHash: new Uint8Array(32),
    },
    launchState: {
      status: 1,
      dbcConfig: pdas.dbcConfig,
      launchAuthority: pdas.launchAuthority,
      batchAuthority: pdas.batchAuthority,
      baseMint: mint,
      pool,
      treasury: key("qsl/treasury"),
      platformFeeBps: 1_000,
      recipients: recipients.map((r) => ({ ...r })),
      recipientCount: 2,
      tokenDecimal: 6,
      migrationQuoteThreshold: THRESHOLD,
      migrationFeeOption: 2,
      openDelaySecs: openDelay,
      guardSecs: guard,
      maxWalletBps: 100,
      maxBuyBps: 50,
      p2pLocked: 0,
      batchWalletCap: 5_000_000_000n,
      batchTotalCap: THRESHOLD,
      launchTs,
      commitEndTs: commitEnd,
      executeEndTs: executeEnd,
      guardEndTs: guardEnd,
      totalCommitted: 10_000_000_000n,
      executed: 1,
      quoteSpent: 9_900_000_000n,
      tokensOut: 50_000_000_000_000n,
      tokensClaimed: 0n,
      quoteRefunded: 0n,
    },
    policy: {
      version: 2,
      bump: policyBump,
      mint,
      pool,
      baseVault: dbcTokenVaultAddress(mint, pool),
      launchTs,
      // The batch executed: execute_batch ended the snipe shield then.
      snipeShieldEndTs: commitEnd + 42n,
      guardEndTs: guardEnd,
      maxWallet,
      maxBuy,
      p2pLocked: 0,
      exempt: [pdas.batchAuthority, pdas.launchAuthority, PublicKey.default, PublicKey.default],
      rules: new Uint8Array(0),
    },
    mintOpts: {
      mintAuthority: null,
      freezeAuthority: null,
      supply: SUPPLY,
      decimals: 6,
      owner: T22,
      extensions: [ext.metadataPointer(null, mint), ext.transferHook(KNOWN_ACCOUNTS.dbcPoolAuthority, PROGRAM_IDS.hook)],
    },
    mintMetadata: null,
    config: zeroed("dbc", "ConfigWithTransferHook") as QslWorld["config"],
    poolState: zeroed("dbc", "TransferHookPool") as QslWorld["poolState"],
    attestation: Uint8Array.from(source.attestation),
    identity: Uint8Array.from(source.identity),
    record: Uint8Array.from(source.tokenMetaData),
    recordText: { ...source.record },
    metaList: fromHex(QSL1.META_LIST_HEX),
    rulesRecord: null,
    upgradeAuthority: { launchpad: null, hook: null, autopilot: null },
    genesisHash: GENESIS_HASHES.mainnet,
    patches: [],
    build() {
      conn.accounts.clear();
      conn.genesisHash = w.genesisHash;
      const t = w.recordText;
      const meta = w.mintMetadata ?? { name: t.name, symbol: t.symbol, uri: t.flags === 2 ? t.uri : t.flags === 1 ? `data:application/json;base64,${btoa(t.doc)}` : "", additional: [] };
      const exts = [...w.mintOpts.extensions];
      exts.splice(1, 0, tokenMetadataTlv(w.mint, meta));
      const { owner, ...mintFields } = w.mintOpts;
      conn.set(w.mint, { owner, data: mintBytes({ ...mintFields, extensions: exts }) });
      conn.set(certificateAddress(w.mint), { owner: PROGRAM_IDS.launchpad, data: certificateBytes(w.cert) });
      conn.set(w.launch, { owner: PROGRAM_IDS.launchpad, data: launchBytes(w.launchState, w.source.launchData, w.launch) });
      conn.set(w.pdas.dbcConfig, { owner: PROGRAM_IDS.dbc, data: accountBytes("dbc", "ConfigWithTransferHook", w.config) });
      conn.set(pool, { owner: PROGRAM_IDS.dbc, data: accountBytes("dbc", "TransferHookPool", w.poolState) });
      conn.set(hookPolicyAddress(w.mint), { owner: PROGRAM_IDS.hook, data: policyBytes(w.policy) });
      conn.set(extraAccountMetaListAddress(w.mint), { owner: PROGRAM_IDS.hook, data: w.metaList });
      conn.set(attestationAddress(w.launch), { owner: PROGRAM_IDS.launchpad, data: w.attestation });
      conn.set(identityAddressFromId(w.source.pqIdentity), { owner: PROGRAM_IDS.launchpad, data: w.identity });
      conn.set(w.source.tokenMeta, { owner: PROGRAM_IDS.launchpad, data: w.record });
      if (w.rulesRecord !== null) conn.set(w.rulesRecord.address, { owner: PROGRAM_IDS.launchpad, data: w.rulesRecord.data });
      upgradeableProgram(conn, PROGRAM_IDS.launchpad, programDataAddress(PROGRAM_IDS.launchpad), 300n, w.upgradeAuthority.launchpad);
      upgradeableProgram(conn, PROGRAM_IDS.hook, programDataAddress(PROGRAM_IDS.hook), 301n, w.upgradeAuthority.hook);
      upgradeableProgram(conn, PROGRAM_IDS.autopilot, programDataAddress(PROGRAM_IDS.autopilot), 302n, w.upgradeAuthority.autopilot);
      upgradeableProgram(conn, PROGRAM_IDS.dbc, programDataAddress(PROGRAM_IDS.dbc), TRUST_ANCHORS.dbcLastDeploySlot, TRUST_ANCHORS.meteoraUpgradeAuthority);
      upgradeableProgram(conn, PROGRAM_IDS.dammV2, programDataAddress(PROGRAM_IDS.dammV2), TRUST_ANCHORS.dammV2LastDeploySlot, TRUST_ANCHORS.meteoraUpgradeAuthority);
      upgradeableProgram(conn, KNOWN_ACCOUNTS.token2022, programDataAddress(KNOWN_ACCOUNTS.token2022), 420_000_000n, TRUST_ANCHORS.token2022UpgradeAuthority);
      for (const p of w.patches) p(w);
    },
  };

  const c = w.config.config;
  Object.assign(c, {
    quoteMint: WSOL_MINT,
    feeClaimer: pdas.launchAuthority,
    leftoverReceiver: pdas.launchAuthority,
    collectFeeMode: 0,
    migrationOption: 1,
    activationType: 1,
    tokenDecimal: 6,
    tokenType: 1,
    partnerPermanentLockedLiquidityPercentage: 100,
    migrationFeeOption: 2,
    tokenUpdateAuthority: 1,
    migrationQuoteThreshold: THRESHOLD,
  });
  (c["poolFees"] as { baseFee: Record<string, unknown> }).baseFee["cliffFeeNumerator"] = 10_000_000n;
  w.config["transferHookProgram"] = PROGRAM_IDS.hook;
  Object.assign(w.poolState.poolState, {
    config: pdas.dbcConfig,
    creator: pdas.launchAuthority,
    baseMint: mint,
    baseVault: dbcTokenVaultAddress(mint, pool),
    quoteVault: dbcTokenVaultAddress(WSOL_MINT, pool),
    quoteReserve: 20_000_000_000n,
    baseReserve: 900_000_000_000_000n,
    sqrtPrice: 1n << 60n,
    hasSwap: 1,
  });
  w.build();
  return w;
}

/** The "typical" launch rules of `programmable.json` (286 bytes), their hash and the Rust LaunchRules record. */
export const TYPICAL_RULES = PROG.rules.find((r) => r.name === "typical")!;

/**
 * The launch of `programmable.json` with its attested "typical" launch rules
 * bound: the certificate's rules_hash and checks 8,191, the hook policy v2
 * holding the bytes, the Rust LaunchRules record verbatim. QSL-1 level 2 on
 * mainnet with finalized programs, programmable by its rules (component R).
 */
export function programmableWorld(): QslWorld {
  const w = qslWorld(PROGRAMMABLE_SOURCE);
  w.cert.rulesHash = fromHex(TYPICAL_RULES.rulesHash);
  w.cert.checks = QSL1.CHECKS_WITH_RULES;
  w.policy.rules = fromHex(TYPICAL_RULES.bytes);
  w.rulesRecord = { address: new PublicKey(TYPICAL_RULES.address), data: fromHex(TYPICAL_RULES.accountData) };
  w.build();
  return w;
}

/**
 * The version-3 generation (launches before programmable launches): the
 * certificate of 487 bytes (version 3, checks exactly 4,095), the
 * attestation v2 (2,676 bytes) signed over message v2, the hook policy v1
 * (275 bytes). Level 2 as before.
 */
export function legacy(w: QslWorld): void {
  w.cert.version = 3;
  w.cert.rulesHash = null;
  w.cert.checks = 4_095;
  w.policy.version = 1;
  w.policy.rules = null;
  w.rulesRecord = null;
  attestRecord(w, w.recordText, w.source.leaf);
}

/** The curve completed: DBC revoked the hook (program and authority None); `migrated`: the liquidity moved to DAMM v2. */
export function graduate(w: QslWorld, migrated: boolean): void {
  Object.assign(w.poolState.poolState, { quoteReserve: THRESHOLD, migrationProgress: migrated ? 3 : 1, isMigrated: migrated ? 1 : 0 });
  w.mintOpts.extensions[1] = ext.transferHook(null, null);
}

/** One DAMM v2 position held by the launch authority, as DBC's migration leaves it (canonical config of fee option 2 by default). */
export interface LpFixture {
  nftMint: PublicKey;
  pool: PublicKey;
  position: PublicKey;
  nftAccount: PublicKey;
  poolState: Record<string, unknown>;
  positionState: Record<string, unknown>;
  /** Token units held by the launch authority's NFT account (1 for a position NFT). */
  amount: bigint;
}

export function addLp(w: QslWorld, o: { canonical?: boolean; label?: string } = {}): LpFixture {
  const nftMint = key(`qsl/${o.label ?? "nft"}`);
  const pool = o.canonical === false ? key(`qsl/other-pool/${o.label ?? "nft"}`) : dammV2PoolAddress(DAMM_V2_MIGRATION_CONFIGS[2]!, w.mint, WSOL_MINT);
  const poolState = zeroed("dammV2", "Pool");
  Object.assign(poolState, { tokenAMint: w.mint, tokenBMint: WSOL_MINT, creator: KNOWN_ACCOUNTS.dbcPoolAuthority, poolStatus: 0, liquidity: 10n ** 20n, sqrtPrice: 1n << 64n, feeVersion: 1 });
  pristinePoolFees(poolState["poolFees"] as Record<string, unknown>, 2, 1n << 64n);
  const positionState = zeroed("dammV2", "Position");
  Object.assign(positionState, { pool, nftMint, permanentLockedLiquidity: 10n ** 20n, unlockedLiquidity: 0n, vestedLiquidity: 0n });
  const lp: LpFixture = { nftMint, pool, position: dammV2PositionAddress(nftMint), nftAccount: dammV2PositionNftAccountAddress(nftMint), poolState, positionState, amount: 1n };
  w.patches.push(() => {
    w.conn.set(lp.pool, { owner: PROGRAM_IDS.dammV2, data: accountBytes("dammV2", "Pool", lp.poolState) });
    w.conn.set(lp.position, { owner: PROGRAM_IDS.dammV2, data: accountBytes("dammV2", "Position", lp.positionState) });
    w.conn.set(lp.nftAccount, { owner: T22, data: tokenAccountBytes({ mint: nftMint, owner: w.pdas.launchAuthority, amount: lp.amount, token2022: true }) });
  });
  return lp;
}

/** Edit the raw bytes of an account after the build. */
export function patch(w: QslWorld, address: PublicKey, edit: (d: Uint8Array) => Uint8Array | void): void {
  w.patches.push(() => {
    const a = w.conn.get(address);
    if (a === undefined) throw new Error(`no account ${address.toBase58()} to patch`);
    const d = Uint8Array.from(a.data);
    w.conn.set(address, { ...a, data: edit(d) ?? d });
  });
}

/** Mark `leaf` used in the world's identity (bitmap and count), as a landed signature does. */
export function markLeafUsed(w: QslWorld, leaf: number): void {
  const id = Uint8Array.from(w.identity);
  id[66 + (leaf >> 3)]! |= 1 << (leaf & 7);
  let count = 0;
  for (const b of id.subarray(66, 194)) for (let x = b; x !== 0; x &= x - 1) count++;
  new DataView(id.buffer).setUint16(194, count, true);
  w.identity = id;
}

/**
 * Attest the world with another record (published at its address), signed by
 * the vector identity at `leaf` over the message the program rebuilds: v3
 * (221 bytes, binding the certificate's rules hash) for a version-4
 * certificate, v2 (189 bytes) for version 3. What `publish_metadata` +
 * `attest_launch` + `launch` would leave for that record. The record bytes
 * are written by the test's own model of the program (`attest_world.ts`),
 * whatever rules they break.
 */
export function attestRecord(w: QslWorld, r: RecordInput, leaf: number = w.source.leaf): void {
  const name = utf8(r.name);
  const symbol = utf8(r.symbol);
  const uri = utf8(r.uri);
  const doc = utf8(r.doc);
  const hash = emulatedMetadataHash(name, symbol, r.flags, uri, doc);
  const fields = { launch: w.launch, paramsHash: w.source.paramsHash, creator: w.creator, metadataHash: hash, notBefore: w.window.notBefore, notAfter: w.window.notAfter };
  const rulesHash = w.cert.rulesHash;
  const message = rulesHash === null ? attestationMessageV2(fields) : attestationMessage({ ...fields, rulesHash });
  const [record] = PublicKey.findProgramAddressSync([utf8("metadata"), w.launch.toBytes(), hash], PROGRAM_IDS.launchpad);
  const [, attBump] = PublicKey.findProgramAddressSync([utf8("attestation"), w.launch.toBytes()], PROGRAM_IDS.launchpad);
  w.attestation = attestationBytes({
    version: rulesHash === null ? 2 : 3,
    bump: attBump,
    launch: w.launch,
    pqIdentity: w.source.pqIdentity,
    leaf,
    metadataHash: hash,
    rulesHash,
    messageHash: sha256(message),
    slot: w.cert.attestedSlot,
    notBefore: w.window.notBefore,
    notAfter: w.window.notAfter,
    signature: signLeafDeterministic(vectorIdentity(), leaf, message),
  });
  w.recordText = { ...r };
  w.cert.metadata = record;
  w.cert.pqLeaf = leaf;
  const bytes = emulatedTokenMetaBytes(w.launch, name, symbol, r.flags, uri, doc);
  w.patches.push(() => w.conn.set(record, { owner: PROGRAM_IDS.launchpad, data: bytes }));
  // The identity marks the leaf used.
  markLeafUsed(w, leaf);
}

// ------------------------------------------------------------- autopilot ---

/** An authorization as written: its address, raw bytes and fields. */
export interface AuthorizationFixture {
  address: PublicKey;
  fields: AuthorizationFields;
  /** The raw account (tests may edit it; null: not written). */
  data: Uint8Array | null;
}

/**
 * What `pq_authorize` writes for the vector identity signing `kind` over
 * `payloadHash` at `leaf` (landing at `unixTime`, slot `slot`); the leaf is
 * marked used in the world's identity.
 */
export function signAuthorization(w: QslWorld, kind: number, payloadHash: Uint8Array, leaf: number, unixTime: bigint, slot: bigint = 400_000_100n): AuthorizationFixture {
  const message = authorizationMessage({ launch: w.launch, creator: w.creator, kind, payloadHash });
  const [address, bump] = PublicKey.findProgramAddressSync([utf8("auth"), w.launch.toBytes(), Uint8Array.of(kind), payloadHash], PROGRAM_IDS.launchpad);
  const fields: AuthorizationFields = {
    version: 1,
    bump,
    launch: w.launch,
    pqIdentity: w.source.pqIdentity,
    kind,
    payloadHash,
    messageHash: sha256(message),
    unixTime,
    slot,
    leaf,
    signature: signLeafDeterministic(vectorIdentity(), leaf, message),
  };
  markLeafUsed(w, leaf);
  return { address, fields, data: authorizationBytes(fields) };
}

/** The autopilot a test adds: every part is mutable before `build()` (run). */
export interface AutopilotFixture {
  address: PublicKey;
  fields: AutopilotFields;
  /** The running graph's record (null: none written). */
  graph: { address: PublicKey; bytes: Uint8Array; data: Uint8Array } | null;
  activation: AuthorizationFixture;
  /** The activate_at the activation signed. */
  activateAt: bigint;
  freeze: AuthorizationFixture | null;
  /** The `not_after` the freeze authorization signed (freeze payload v2); null without a freeze. */
  freezeNotAfter: bigint | null;
  pending: AuthorizationFixture | null;
  /** Written by the launchpad: every authorization above, owner L. */
  extra: { address: PublicKey; owner: PublicKey; data: Uint8Array }[];
}

/**
 * An autopilot for the world's launch running `graph` (default: the crate's
 * "daily buyback and burn"), activated by an authorization the vector
 * identity signed at `leaf` (default 100) over `activateAt` (default
 * launch + 600), landing 600 s before it, applied `delay` s after it
 * (default 30). `frozen` adds a freeze authorization (leaf 101) after the
 * activation; `pending` queues another graph (by its hash) with its own
 * authorization (leaf 102), to take effect `wait` s (default 72 hours) after
 * that authorization lands. The account stores the running graph's
 * activation (`active_auth`, `active_activate_at`; audit 4, A4-S) unless
 * `legacy` (an account that records none: P.G3 then searches).
 */
export function addAutopilot(
  w: QslWorld,
  o: { graph?: Uint8Array; leaf?: number; activateAt?: bigint; delay?: bigint; lead?: bigint; frozen?: boolean; pending?: { graphHash: Uint8Array; wait?: bigint }; legacy?: boolean } = {},
): AutopilotFixture {
  const bytes = o.graph ?? VECTOR_GRAPH;
  const hash = graphHash(bytes);
  const address = autopilotAddress(w.launch);
  const activateAt = o.activateAt ?? w.cert.launchedAt + 600n;
  const unixTime = activateAt - (o.lead ?? 600n);
  const activation = signAuthorization(w, 1, activationPayload(address, hash, activateAt), o.leaf ?? 100, unixTime, 400_000_100n);
  // The freeze lands 100 s after the activation and was signed (payload v2) to be usable for about an hour, as the SDK does.
  const freezeNotAfter = activateAt + 100n + 3_540n;
  const freeze = o.frozen === true ? signAuthorization(w, 2, freezePayload(address, hash, freezeNotAfter), 101, activateAt + 100n, 400_000_200n) : null;
  let pending: AuthorizationFixture | null = null;
  let pendingGraph: Uint8Array = new Uint8Array(32);
  let pendingActivateAt = 0n;
  if (o.pending !== undefined) {
    pendingGraph = o.pending.graphHash;
    const landed = activateAt + 1_000n;
    pendingActivateAt = landed + (o.pending.wait ?? 259_200n);
    pending = signAuthorization(w, 1, activationPayload(address, pendingGraph, pendingActivateAt), 102, landed, 400_000_300n);
  }
  const [, bump] = PublicKey.findProgramAddressSync([utf8("autopilot"), w.launch.toBytes()], PROGRAM_IDS.autopilot);
  const [, treasuryBump] = PublicKey.findProgramAddressSync([utf8("treasury"), w.launch.toBytes()], PROGRAM_IDS.autopilot);
  const [graphAddr, graphBump] = PublicKey.findProgramAddressSync([utf8("graph"), w.launch.toBytes(), hash], PROGRAM_IDS.autopilot);
  const latestActivation = pending ?? activation;
  const fx: AutopilotFixture = {
    address,
    fields: {
      version: 1,
      bump,
      treasuryBump,
      launch: w.launch,
      mint: w.mint,
      dammPool: PublicKey.default,
      activeGraph: hash,
      pendingGraph,
      pendingActivateAt,
      pendingOperator: PublicKey.default,
      activatedAt: activateAt + (o.delay ?? 30n),
      frozen: freeze === null ? 0 : 1,
      operator: PublicKey.default,
      authMarks: [
        { slot: latestActivation.fields.slot, key: latestActivation.address },
        freeze === null ? { slot: 0n, key: PublicKey.default } : { slot: freeze.fields.slot, key: freeze.address },
        { slot: 0n, key: PublicKey.default },
      ],
      seq: 0n,
      activeAuth: o.legacy === true ? PublicKey.default : activation.address,
      activeActivateAt: o.legacy === true ? 0n : activateAt,
    },
    graph: { address: graphAddr, bytes, data: graphRecordBytes({ version: 1, bump: graphBump, launch: w.launch, graphHash: hash, bytes }) },
    activation,
    activateAt,
    freeze,
    freezeNotAfter: freeze === null ? null : freezeNotAfter,
    pending,
    extra: [],
  };
  w.patches.push(() => {
    w.conn.set(fx.address, { owner: PROGRAM_IDS.autopilot, data: autopilotBytes(fx.fields) });
    if (fx.graph !== null) w.conn.set(fx.graph.address, { owner: PROGRAM_IDS.autopilot, data: fx.graph.data });
    for (const a of [fx.activation, fx.freeze, fx.pending]) if (a !== null && a.data !== null) w.conn.set(a.address, { owner: PROGRAM_IDS.launchpad, data: a.data });
    for (const x of fx.extra) w.conn.set(x.address, { owner: x.owner, data: x.data });
  });
  return fx;
}

/**
 * The Rust vector's own kind-1 authorization (`programmable.json`: leaf 46,
 * over the fixed graph hash at activateAt 1,767,226,200), for
 * `programmableWorld()`: the autopilot at its address runs that graph,
 * applied `delay` s after activateAt. The vector's graph hash is a fixed
 * value, not the hash of a published graph, so no graph record exists for it
 * (P.G2 fails); `frozen` adds the vector's kind-2 authorization (its
 * `not_after` is `authorizations.freezeNotAfter`, 1,767,229,200).
 */
export function addVectorActivation(w: QslWorld, o: { delay?: bigint; frozen?: boolean; legacy?: boolean } = {}): AutopilotFixture {
  const address = autopilotAddress(w.launch);
  if (address.toBase58() !== PROG.authorizations.autopilot) throw new Error("addVectorActivation needs programmableWorld()");
  const byKind = (kind: number): AuthorizationFixture => {
    const c = PROG.authorizations.cases.find((x) => x.kind === kind)!;
    const data = fromHex(c.accountData);
    const view = new DataView(data.buffer);
    return {
      address: new PublicKey(c.address),
      data,
      fields: {
        version: data[8]!,
        bump: data[9]!,
        launch: new PublicKey(data.slice(10, 42)),
        pqIdentity: data.slice(42, 74),
        kind: data[74]!,
        payloadHash: data.slice(75, 107),
        messageHash: data.slice(107, 139),
        unixTime: view.getBigInt64(139, true),
        slot: view.getBigUint64(147, true),
        leaf: view.getUint16(155, true),
        signature: data.slice(161, 2_669),
      },
    };
  };
  const activation = byKind(1);
  const freeze = o.frozen === true ? byKind(2) : null;
  const activateAt = BigInt(PROG.authorizations.activateAt);
  const [, bump] = PublicKey.findProgramAddressSync([utf8("autopilot"), w.launch.toBytes()], PROGRAM_IDS.autopilot);
  const fx: AutopilotFixture = {
    address,
    fields: {
      version: 1,
      bump,
      treasuryBump: 0,
      launch: w.launch,
      mint: w.mint,
      dammPool: PublicKey.default,
      activeGraph: fromHex(PROG.authorizations.graphHash),
      pendingGraph: new Uint8Array(32),
      pendingActivateAt: 0n,
      pendingOperator: PublicKey.default,
      activatedAt: activateAt + (o.delay ?? 30n),
      frozen: freeze === null ? 0 : 1,
      operator: new PublicKey(PROG.authorizations.operator),
      authMarks: [
        { slot: activation.fields.slot, key: activation.address },
        freeze === null ? { slot: 0n, key: PublicKey.default } : { slot: freeze.fields.slot, key: freeze.address },
        { slot: 0n, key: PublicKey.default },
      ],
      seq: 0n,
      activeAuth: o.legacy === true ? PublicKey.default : activation.address,
      activeActivateAt: o.legacy === true ? 0n : activateAt,
    },
    graph: null,
    activation,
    activateAt,
    freeze,
    freezeNotAfter: freeze === null ? null : BigInt(PROG.authorizations.freezeNotAfter),
    pending: null,
    extra: [],
  };
  w.patches.push(() => {
    w.conn.set(fx.address, { owner: PROGRAM_IDS.autopilot, data: autopilotBytes(fx.fields) });
    for (const a of [fx.activation, fx.freeze]) if (a !== null && a.data !== null) w.conn.set(a.address, { owner: PROGRAM_IDS.launchpad, data: a.data });
  });
  return fx;
}

/** The running graph's record address of a world's autopilot. */
export const graphAddressOf = (w: QslWorld, hash: Uint8Array): PublicKey => graphRecordAddress(w.launch, hash);

/**
 * QSL-1 §5: the account layouts a QSL-1 verifier reads, at the standard's
 * normative offsets (discriminator included), read as raw bytes.
 *
 * These readers deliberately do not use the IDL codecs the rest of the SDK
 * decodes with: the standard is written as offsets, and `test/qsl.test.ts`
 * checks that bytes written at these offsets decode through the programs'
 * IDLs to the same fields (and that the Rust vectors' accounts read the same
 * way), so a drift between the standard and the programs fails a test.
 * Callers check owner, length and discriminator first (QSL-1 §6.1 rule 4);
 * every reader assumes the length its layout names.
 *
 * Two generations of launch accounts exist, and a certificate's version says
 * which one a launch has:
 *
 * - certificate version 3 (487 bytes), attestation version 2 (2,676 bytes,
 *   message v2 of 189 bytes), hook policy version 1 (275 bytes): launches
 *   before programmable launches (P1c);
 * - certificate version 4 (519 bytes: `rules_hash` at 487), attestation
 *   version 3 (2,708 bytes: `rules_hash` at 108, message v3 of 221 bytes),
 *   hook policy version 2 (`279 + len` bytes: the rule bytes at 279): what
 *   the programs write now.
 *
 * The programmable component (§6.4, a description, not a level) adds the
 * launch rules record, the post-quantum authorization, and the autopilot's
 * `Autopilot` and `GraphRecord` accounts.
 */
import { PublicKey } from "@solana/web3.js";

import { fromHex } from "../codec/bytes.js";

/** QSL-1's identifiers and bounds (§3.1, §5, §6.4, §6.5, Appendix B). */
export const QSL1 = {
  STANDARD: "QSL-1",
  MAINNET_GENESIS_HASH: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  /**
   * §6.5: the twelve bits every certificate holds (`checks::ALL`); L1 bits
   * 0x3FF, L2 bits 0xC00. Test `(checks & ALL_CHECKS) === ALL_CHECKS`, never
   * `checks === ALL_CHECKS`: a version-4 certificate with rules also carries
   * `RULES_BOUND` (8,191).
   */
  ALL_CHECKS: 4_095,
  /** §6.5 (amendment A2): set on a version-4 certificate in addition to the twelve bits when `rules_hash` is not zero. */
  RULES_BOUND: 4_096,
  /** `ALL_CHECKS | RULES_BOUND`: a version-4 certificate with rules (P.R1). */
  CHECKS_WITH_RULES: 8_191,
  L1_BITS: 0x3ff,
  L2_BITS: 0xc00,
  PQ_ATTESTED: 1_024,
  METADATA_ONCHAIN: 2_048,
  /** §5.1: version 4 (519 bytes, `rules_hash` at 487) and version 3 (487 bytes) are known. */
  CERTIFICATE: { LEN: 519, V3_LEN: 487, DISCRIMINATOR: "cae5dedc74144a43", VERSION: 4, V3_VERSION: 3, KNOWN_VERSIONS: [3, 4] as readonly number[], RULES_HASH_OFFSET: 487, POLICY_VERSION: 3 },
  LAUNCH: { LEN: 585, DISCRIMINATOR: "903333a3ce55d526", VERSION: 2, STATUS_CONFIGURED: 0, STATUS_LIVE: 1 },
  /** §5.3: version 3 (2,708 bytes) goes with certificate version 4, version 2 (2,676 bytes) with certificate version 3. */
  ATTESTATION: { LEN: 2_708, V2_LEN: 2_676, DISCRIMINATOR: "987db75624927949", VERSION: 3, V2_VERSION: 2, SIGNATURE_LEN: 2_508, MESSAGE_LEN: 221, V2_MESSAGE_LEN: 189, V2_MESSAGE_TAG: "PHX-ATTEST-V2" },
  IDENTITY: { LEN: 196, DISCRIMINATOR: "3a84050cb0a45570", VERSION: 1, LEAVES: 1_024 },
  TOKEN_META: { DISCRIMINATOR: "8257ae23152c5c13", VERSION: 1 },
  /** §5.6: version 2 (`279 + len` bytes, rules from 279) goes with certificate version 4, version 1 (275 bytes) with certificate version 3. */
  HOOK_POLICY: { LEN: 279, V1_LEN: 275, DISCRIMINATOR: "6772f6550f16bec3", VERSION: 2, V1_VERSION: 1, RULES_LEN_OFFSET: 275, RULES_OFFSET: 279 },
  /** §6.4 P.R3: `PDA(L; "rules", launch, rules_hash)`, `78 + len` bytes. */
  LAUNCH_RULES: { FIXED_LEN: 78, DISCRIMINATOR: "ee49471de730278d", VERSION: 1, MAX_RULES_LEN: 1_228 },
  /** §6.4 P.G3: `PDA(L; "auth", launch, [kind], payload_hash)`, 2,669 bytes; message "PHX-AUTH-V1" (140 bytes). */
  AUTHORIZATION: { LEN: 2_669, DISCRIMINATOR: "0344a8f3c3a8204b", VERSION: 1, SIGNATURE_LEN: 2_508, KIND_ACTIVATE: 1, KIND_FREEZE: 2 },
  /**
   * §6.4 P.G1: `PDA(AUTOPILOT; "autopilot", launch)`, 1,244 bytes since audit
   * round 4 (`active_auth` at 1,076, `active_activate_at` at 1,108,
   * `partial_spent` at 1,116; version still 1).
   */
  AUTOPILOT: { LEN: 1_244, DISCRIMINATOR: "71c3e5399efa3186", VERSION: 1, ACTIVE_AUTH_OFFSET: 1_076, ACTIVE_ACTIVATE_AT_OFFSET: 1_108, PARTIAL_SPENT_OFFSET: 1_116 },
  /** §6.4 P.G2: `PDA(AUTOPILOT; "graph", launch, graph_hash)`, `78 + len` bytes. */
  GRAPH_RECORD: { FIXED_LEN: 78, DISCRIMINATOR: "765f5c156716b378", VERSION: 1, MAX_GRAPH_LEN: 2_044 },
  /** P.G4: a graph that replaces another takes effect at least 72 hours after its authorization landed. */
  UPDATE_TIMELOCK_SECS: 259_200n,
  /** P.G3: the default bound of the activation-time search, in candidate seconds (8 days). */
  ACTIVATE_AT_SEARCH_CAP: 691_200,
  /** P.G4: the default bound of the freeze `not_after` search (freeze payload v2), in candidate seconds (8 days). */
  FREEZE_NOT_AFTER_SEARCH_CAP: 691_200,
  /** The freeze payload's domain (v2, with `not_after`; review 4, R5). */
  FREEZE_DOMAIN: "PHX-GRAPH-FRZ-V2",
  /** §5.7: the hook account list, exactly (86 bytes). */
  META_LIST_HEX:
    "692565c54bfb661a4a00000002000000010106706f6c69637903010000000000000000000000000000000000000000000000" +
    "000006a7d517187bd16635dad40455fdc2c0c124c68f215675a5dbbacb5f080000000000",
  /** C1.21 and Appendix B. */
  MAX_GUARD_SECS: 259_200n,
  MAX_SNIPE_SHIELD_SECS: 3_600n,
  MIN_MAX_WALLET_DIVISOR: 1_000n,
  MIN_MAX_BUY_DIVISOR: 10_000n,
  /** C1.20. */
  MAX_PLATFORM_FEE_BPS: 5_000,
  BPS: 10_000,
  /** C2.3. */
  MIN_WINDOW_SECS: 60n,
  MAX_WINDOW_SECS: 3_600n,
} as const;

/** Whether this checker knows certificate `version` (3 and 4; §10.2 rule 4). */
export const isKnownCertificateVersion = (version: number): boolean => QSL1.CERTIFICATE.KNOWN_VERSIONS.includes(version);

const dv = (d: Uint8Array): DataView => new DataView(d.buffer, d.byteOffset, d.byteLength);
const key = (d: Uint8Array, o: number): PublicKey => new PublicKey(d.slice(o, o + 32));
const u16 = (d: Uint8Array, o: number): number => dv(d).getUint16(o, true);
const u32 = (d: Uint8Array, o: number): number => dv(d).getUint32(o, true);
const u64 = (d: Uint8Array, o: number): bigint => dv(d).getBigUint64(o, true);
const i64 = (d: Uint8Array, o: number): bigint => dv(d).getBigInt64(o, true);

/** Whether `d` starts with the discriminator `hex` (16 hex digits). */
export function hasDiscriminator(d: Uint8Array, hex: string): boolean {
  const want = fromHex(hex);
  return d.length >= 8 && want.every((b, i) => d[i] === b);
}

/** One of the four fee-recipient slots (`wallet` 32, `bps` u16). */
export interface QslRecipient {
  readonly wallet: PublicKey;
  readonly bps: number;
}

function recipients(d: Uint8Array, o: number): QslRecipient[] {
  return [0, 1, 2, 3].map((i) => ({ wallet: key(d, o + 34 * i), bps: u16(d, o + 34 * i + 32) }));
}

/** §5.1 Certificate (version 3, 487 bytes; version 4, 519 bytes). Booleans are raw bytes. */
export interface QslCertificate {
  readonly version: number;
  readonly bump: number;
  readonly launch: PublicKey;
  readonly baseMint: PublicKey;
  readonly pool: PublicKey;
  readonly dbcConfig: PublicKey;
  readonly creator: PublicKey;
  readonly launchedAt: bigint;
  readonly tokenDecimal: number;
  readonly initialSupply: bigint;
  readonly checks: number;
  readonly migrationQuoteThreshold: bigint;
  readonly migrationFeeOption: number;
  readonly snipeShieldEndTs: bigint;
  readonly executeEndTs: bigint;
  readonly guardEndTs: bigint;
  readonly maxWallet: bigint;
  readonly maxBuy: bigint;
  readonly p2pLocked: number;
  readonly platformFeeBps: number;
  readonly recipients: QslRecipient[];
  readonly paramsHash: Uint8Array;
  readonly policyVersion: number;
  readonly pqIdentity: Uint8Array;
  readonly pqLeaf: number;
  readonly attestedSlot: bigint;
  readonly metadata: PublicKey;
  /** 487..519 (the 519-byte layout, version 4): the attested rules' hash, all zero for none; null for the 487-byte layout. */
  readonly rulesHash: Uint8Array | null;
}

export function readCertificate(d: Uint8Array): QslCertificate {
  return {
    version: d[8]!,
    bump: d[9]!,
    launch: key(d, 10),
    baseMint: key(d, 42),
    pool: key(d, 74),
    dbcConfig: key(d, 106),
    creator: key(d, 138),
    launchedAt: i64(d, 170),
    tokenDecimal: d[178]!,
    initialSupply: u64(d, 179),
    checks: u32(d, 187),
    migrationQuoteThreshold: u64(d, 191),
    migrationFeeOption: d[199]!,
    snipeShieldEndTs: i64(d, 200),
    executeEndTs: i64(d, 208),
    guardEndTs: i64(d, 216),
    maxWallet: u64(d, 224),
    maxBuy: u64(d, 232),
    p2pLocked: d[240]!,
    platformFeeBps: u16(d, 241),
    recipients: recipients(d, 243),
    paramsHash: d.slice(379, 411),
    policyVersion: u16(d, 411),
    pqIdentity: d.slice(413, 445),
    pqLeaf: u16(d, 445),
    attestedSlot: u64(d, 447),
    metadata: key(d, 455),
    rulesHash: d.length >= QSL1.CERTIFICATE.LEN ? d.slice(487, 519) : null,
  };
}

/** §5.2 Launch (version 2, 585 bytes): the fields a verifier reads. */
export interface QslLaunch {
  readonly version: number;
  readonly status: number;
  readonly launchSeed: Uint8Array;
  readonly creator: PublicKey;
  readonly dbcConfig: PublicKey;
  readonly launchAuthority: PublicKey;
  readonly batchAuthority: PublicKey;
  readonly baseMint: PublicKey;
  readonly pool: PublicKey;
  readonly treasury: PublicKey;
  readonly platformFeeBps: number;
  readonly recipients: QslRecipient[];
  readonly recipientCount: number;
  readonly tokenDecimal: number;
  readonly migrationQuoteThreshold: bigint;
  readonly migrationFeeOption: number;
  readonly openDelaySecs: number;
  readonly guardSecs: number;
  readonly maxWalletBps: number;
  readonly maxBuyBps: number;
  readonly p2pLocked: number;
  readonly batchWalletCap: bigint;
  readonly batchTotalCap: bigint;
  readonly paramsHash: Uint8Array;
  readonly launchTs: bigint;
  readonly commitEndTs: bigint;
  readonly executeEndTs: bigint;
  readonly guardEndTs: bigint;
  readonly totalCommitted: bigint;
  readonly executed: number;
  readonly quoteSpent: bigint;
  readonly tokensOut: bigint;
  readonly tokensClaimed: bigint;
  readonly quoteRefunded: bigint;
  readonly pqIdentity: Uint8Array;
}

export function readLaunch(d: Uint8Array): QslLaunch {
  return {
    version: d[8]!,
    status: d[13]!,
    launchSeed: d.slice(14, 46),
    creator: key(d, 46),
    dbcConfig: key(d, 78),
    launchAuthority: key(d, 110),
    batchAuthority: key(d, 142),
    baseMint: key(d, 174),
    pool: key(d, 206),
    treasury: key(d, 238),
    platformFeeBps: u16(d, 270),
    recipients: recipients(d, 272),
    recipientCount: d[408]!,
    tokenDecimal: d[409]!,
    migrationQuoteThreshold: u64(d, 410),
    migrationFeeOption: d[418]!,
    openDelaySecs: u32(d, 419),
    guardSecs: u32(d, 423),
    maxWalletBps: u16(d, 427),
    maxBuyBps: u16(d, 429),
    p2pLocked: d[431]!,
    batchWalletCap: u64(d, 432),
    batchTotalCap: u64(d, 440),
    paramsHash: d.slice(448, 480),
    launchTs: i64(d, 480),
    commitEndTs: i64(d, 488),
    executeEndTs: i64(d, 496),
    guardEndTs: i64(d, 504),
    totalCommitted: u64(d, 512),
    executed: d[520]!,
    quoteSpent: u64(d, 521),
    tokensOut: u64(d, 529),
    tokensClaimed: u64(d, 537),
    quoteRefunded: u64(d, 545),
    pqIdentity: d.slice(553, 585),
  };
}

/** §5.3 Attestation: version 3 (2,708 bytes) or version 2 (2,676 bytes, no `rules_hash`). */
export interface QslAttestation {
  readonly version: number;
  readonly bump: number;
  readonly launch: PublicKey;
  readonly pqIdentity: Uint8Array;
  readonly leaf: number;
  readonly metadataHash: Uint8Array;
  /** 108..140 of the 2,708-byte layout (all zero: no rules); null for the 2,676-byte layout. */
  readonly rulesHash: Uint8Array | null;
  readonly messageHash: Uint8Array;
  readonly slot: bigint;
  readonly notBefore: bigint;
  readonly notAfter: bigint;
  readonly signatureLen: number;
  readonly signature: Uint8Array;
}

/** Reads the 2,708-byte layout (version 3) or, for any shorter account, the 2,676-byte one (version 2). */
export function readAttestation(d: Uint8Array): QslAttestation {
  const v3 = d.length >= QSL1.ATTESTATION.LEN;
  const s = v3 ? 32 : 0; // version 3 inserts rules_hash (32 bytes) at 108
  return {
    version: d[8]!,
    bump: d[9]!,
    launch: key(d, 10),
    pqIdentity: d.slice(42, 74),
    leaf: u16(d, 74),
    metadataHash: d.slice(76, 108),
    rulesHash: v3 ? d.slice(108, 140) : null,
    messageHash: d.slice(108 + s, 140 + s),
    slot: u64(d, 140 + s),
    notBefore: i64(d, 148 + s),
    notAfter: i64(d, 156 + s),
    signatureLen: u32(d, 164 + s),
    signature: d.slice(168 + s, 2_676 + s),
  };
}

/** §5.4 Identity (version 1, 196 bytes). */
export interface QslIdentity {
  readonly version: number;
  readonly publicKey: Uint8Array;
  readonly used: Uint8Array;
  readonly usedCount: number;
}

export function readIdentity(d: Uint8Array): QslIdentity {
  return { version: d[8]!, publicKey: d.slice(10, 66), used: d.slice(66, 194), usedCount: u16(d, 194) };
}

/** Leaf `q` is used when `used[q >> 3] & (1 << (q & 7)) != 0` (§5.4). */
export function leafBitSet(used: Uint8Array, q: number): boolean {
  return q >= 0 && q < 1_024 && ((used[q >> 3] ?? 0) & (1 << (q & 7))) !== 0;
}

/** §5.6 Hook policy: version 2 (`279 + len` bytes) or version 1 (275 bytes, no rules). */
export interface QslHookPolicy {
  readonly version: number;
  readonly mint: PublicKey;
  readonly pool: PublicKey;
  readonly baseVault: PublicKey;
  readonly launchTs: bigint;
  readonly snipeShieldEndTs: bigint;
  readonly guardEndTs: bigint;
  readonly maxWallet: bigint;
  readonly maxBuy: bigint;
  readonly p2pLocked: number;
  readonly exempt: PublicKey[];
  /** The u32 at 275 (version 2: the rule bytes' length); null for an account shorter than 279 bytes. */
  readonly rulesLen: number | null;
  /** The rule bytes from 279 (at most `rulesLen` of them, as many as the account holds); null for an account shorter than 279 bytes. */
  readonly rules: Uint8Array | null;
}

export function readHookPolicy(d: Uint8Array): QslHookPolicy {
  const withRules = d.length >= QSL1.HOOK_POLICY.RULES_OFFSET;
  const rulesLen = withRules ? u32(d, QSL1.HOOK_POLICY.RULES_LEN_OFFSET) : null;
  return {
    version: d[8]!,
    mint: key(d, 10),
    pool: key(d, 42),
    baseVault: key(d, 74),
    launchTs: i64(d, 106),
    snipeShieldEndTs: i64(d, 114),
    guardEndTs: i64(d, 122),
    maxWallet: u64(d, 130),
    maxBuy: u64(d, 138),
    p2pLocked: d[146]!,
    exempt: [0, 1, 2, 3].map((i) => key(d, 147 + 32 * i)),
    rulesLen,
    rules: rulesLen === null ? null : d.slice(QSL1.HOOK_POLICY.RULES_OFFSET, QSL1.HOOK_POLICY.RULES_OFFSET + Math.min(rulesLen, d.length)),
  };
}

/** §6.4 P.R3: a launch rules record (`LaunchRules`, version 1): u32 length at 74, the PXR1 bytes from 78. */
export interface QslLaunchRules {
  readonly version: number;
  readonly bump: number;
  readonly launch: PublicKey;
  readonly rulesHash: Uint8Array;
  readonly len: number;
  /** The bytes from 78 (at most `len` of them, as many as the account holds). */
  readonly bytes: Uint8Array;
}

export function readLaunchRules(d: Uint8Array): QslLaunchRules {
  const len = u32(d, 74);
  return { version: d[8]!, bump: d[9]!, launch: key(d, 10), rulesHash: d.slice(42, 74), len, bytes: d.slice(78, 78 + Math.min(len, d.length)) };
}

/** §6.4 P.G3: a post-quantum authorization (`Authorization`, version 1, 2,669 bytes). */
export interface QslAuthorization {
  readonly version: number;
  readonly bump: number;
  readonly launch: PublicKey;
  readonly pqIdentity: Uint8Array;
  readonly kind: number;
  readonly payloadHash: Uint8Array;
  readonly messageHash: Uint8Array;
  readonly unixTime: bigint;
  readonly slot: bigint;
  readonly leaf: number;
  readonly signatureLen: number;
  readonly signature: Uint8Array;
}

export function readAuthorization(d: Uint8Array): QslAuthorization {
  return {
    version: d[8]!,
    bump: d[9]!,
    launch: key(d, 10),
    pqIdentity: d.slice(42, 74),
    kind: d[74]!,
    payloadHash: d.slice(75, 107),
    messageHash: d.slice(107, 139),
    unixTime: i64(d, 139),
    slot: u64(d, 147),
    leaf: u16(d, 155),
    signatureLen: u32(d, 157),
    signature: d.slice(161, 2_669),
  };
}

/** The latest authorization the autopilot used of one kind (`AuthMark`: slot u64, key 32). */
export interface QslAuthMark {
  readonly slot: bigint;
  readonly key: PublicKey;
}

/** §6.4 P.G1: the fields of an `Autopilot` account (version 1, 1,244 bytes) a verifier reads. Booleans are raw bytes. */
export interface QslAutopilot {
  readonly version: number;
  readonly bump: number;
  readonly treasuryBump: number;
  readonly launch: PublicKey;
  readonly mint: PublicKey;
  readonly dammPool: PublicKey;
  readonly activeGraph: Uint8Array;
  readonly pendingGraph: Uint8Array;
  readonly pendingActivateAt: bigint;
  readonly pendingOperator: PublicKey;
  readonly activatedAt: bigint;
  readonly frozen: number;
  readonly operator: PublicKey;
  /** Activate, freeze, revoke: the latest authorization used of each kind. */
  readonly authMarks: readonly [QslAuthMark, QslAuthMark, QslAuthMark];
  /**
   * The Authorization that activated the running graph and the `activate_at`
   * it signed (audit 4, A4-S; the default key and 0 until a graph runs): with
   * `activeGraph` they re-verify the running graph's approval directly (P.G3).
   */
  readonly activeAuth: PublicKey;
  readonly activeActivateAt: bigint;
}

export function readAutopilot(d: Uint8Array): QslAutopilot {
  const mark = (i: number): QslAuthMark => ({ slot: u64(d, 252 + 40 * i), key: key(d, 260 + 40 * i) });
  return {
    version: d[8]!,
    bump: d[9]!,
    treasuryBump: d[10]!,
    launch: key(d, 11),
    mint: key(d, 43),
    dammPool: key(d, 75),
    activeGraph: d.slice(107, 139),
    pendingGraph: d.slice(139, 171),
    pendingActivateAt: i64(d, 171),
    pendingOperator: key(d, 179),
    activatedAt: i64(d, 211),
    frozen: d[219]!,
    operator: key(d, 220),
    authMarks: [mark(0), mark(1), mark(2)],
    activeAuth: key(d, QSL1.AUTOPILOT.ACTIVE_AUTH_OFFSET),
    activeActivateAt: i64(d, QSL1.AUTOPILOT.ACTIVE_ACTIVATE_AT_OFFSET),
  };
}

/** §6.4 P.G2: a published graph (`GraphRecord`, version 1): u32 length at 74, the PXG1 bytes from 78. */
export interface QslGraphRecord {
  readonly version: number;
  readonly bump: number;
  readonly launch: PublicKey;
  readonly graphHash: Uint8Array;
  readonly len: number;
  /** The bytes from 78 (at most `len` of them, as many as the account holds). */
  readonly bytes: Uint8Array;
}

export function readGraphRecord(d: Uint8Array): QslGraphRecord {
  const len = u32(d, 74);
  return { version: d[8]!, bump: d[9]!, launch: key(d, 10), graphHash: d.slice(42, 74), len, bytes: d.slice(78, 78 + Math.min(len, d.length)) };
}

/**
 * The upgradeable loader's `ProgramData` (C1.24): u32le tag at 0..4 (3),
 * the last deploy slot at 4..12, the upgrade authority's option tag at 12
 * (0: None, the program is finalized) and the key at 13..45.
 */
export function readProgramData(d: Uint8Array): { tag: number; slot: bigint; authorityTag: number; authority: PublicKey | null } | null {
  if (d.length < 13) return null;
  const authorityTag = d[12]!;
  return { tag: u32(d, 0), slot: u64(d, 4), authorityTag, authority: authorityTag === 1 && d.length >= 45 ? key(d, 13) : null };
}

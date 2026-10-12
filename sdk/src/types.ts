/**
 * Data types of the SPEC §4.1 API: camelCase mirrors of the on-chain structs,
 * `bigint` for u64/u128/i64, `number` for u8/u16/u32, `PublicKey` from web3.js v1.
 */
import type { PublicKey } from "@solana/web3.js";

import type { Cluster } from "./constants.js";
import type { ParsedMetadataDoc } from "./metadata/doc.js";
import type { TokenMetaAccount, TokenMetaInput } from "./metadata/record.js";
import type { LmotsPublicKey } from "./pq/lmots.js";

// ---------------------------------------------------------------- launch ---

export interface CurvePoint {
  sqrtPrice: bigint;
  liquidity: bigint;
}

/** DBC fee scheduler: firstFactor = periods, secondFactor = period seconds, thirdFactor = reduction. */
export interface BaseFeeParams {
  cliffFeeNumerator: bigint;
  firstFactor: number;
  secondFactor: bigint;
  thirdFactor: bigint;
  /** 0 = linear, 1 = exponential. */
  baseFeeMode: number;
}

export interface DynamicFeeParams {
  binStep: number;
  binStepU128: bigint;
  filterPeriod: number;
  decayPeriod: number;
  reductionFactor: number;
  maxVolatilityAccumulator: number;
  variableFeeControl: number;
}

export interface FeeRecipient {
  wallet: PublicKey;
  bps: number;
}

/** Everything a creator chooses (SPEC §1.2). Field order = borsh order = `params_hash`. */
export interface LaunchParams {
  tokenDecimal: number;
  sqrtStartPrice: bigint;
  curve: CurvePoint[];
  migrationQuoteThreshold: bigint;
  baseFee: BaseFeeParams;
  dynamicFee: DynamicFeeParams | null;
  migrationFeeOption: number;
  openDelaySecs: number;
  guardSecs: number;
  maxWalletBps: number;
  maxBuyBps: number;
  p2pLocked: boolean;
  batchWalletCap: bigint;
  batchTotalCap: bigint;
  recipients: FeeRecipient[];
  /**
   * The creator's post-quantum identity: `SHA256(0x21 || LMS public key)`
   * (32 bytes, never all zero; `create_launch` refuses zero with
   * InvalidPqIdentity). `launch` runs only after this identity attested the
   * launch (`attest_launch`), inside the window it signed. Covered by
   * `params_hash`. Derive it from the identity key, never from a wallet.
   */
  pqIdentity: Uint8Array;
}

/**
 * A token's metadata: the on-chain record (`TokenMeta`) its identity signs,
 * `{ name, symbol, flags?, uri?, doc? }` (`TokenMetaInput`). `{ name,
 * symbol, uri: "" }` is a valid record without a document.
 */
export type LaunchMetadata = TokenMetaInput;

/**
 * What `buildCreateLaunchTx` takes: the launch parameters. The metadata is
 * no longer part of them (0.4.0): it is a record published on its own
 * (`buildPublishMetadataTx`) and signed with the attestation.
 */
export type LaunchParamsInput = LaunchParams;

export type PresetName = "fair" | "community" | "turbo";

export interface LaunchPreset {
  name: PresetName;
  title: string;
  summary: string;
  /** Every creator-chosen value except the creator's own fee recipients and post-quantum identity. */
  params: Omit<LaunchParams, "recipients" | "pqIdentity">;
}

export interface ValidationResult {
  ok: boolean;
  /** Each formatted `"fieldName: message"`. */
  errors: string[];
}

export type LaunchStatus = "configured" | "live";

/** Decoded `Launch` account (programs/noised-launchpad/src/state.rs). */
export interface LaunchState {
  version: number;
  bump: number;
  authorityBump: number;
  batchBump: number;
  configBump: number;
  status: LaunchStatus;
  launchSeed: Uint8Array;
  creator: PublicKey;
  dbcConfig: PublicKey;
  launchAuthority: PublicKey;
  batchAuthority: PublicKey;
  baseMint: PublicKey;
  pool: PublicKey;
  treasury: PublicKey;
  platformFeeBps: number;
  /** Fixed array of 4; unused slots are the default key with bps 0. */
  recipients: FeeRecipient[];
  recipientCount: number;
  tokenDecimal: number;
  migrationQuoteThreshold: bigint;
  migrationFeeOption: number;
  openDelaySecs: number;
  guardSecs: number;
  maxWalletBps: number;
  maxBuyBps: number;
  p2pLocked: boolean;
  batchWalletCap: bigint;
  batchTotalCap: bigint;
  paramsHash: Uint8Array;
  launchTs: bigint;
  commitEndTs: bigint;
  executeEndTs: bigint;
  guardEndTs: bigint;
  totalCommitted: bigint;
  executed: boolean;
  quoteSpent: bigint;
  tokensOut: bigint;
  tokensClaimed: bigint;
  quoteRefunded: bigint;
  /** `LaunchParams.pq_identity`: the identity whose attestation `launch` requires. Never proof of origin on its own (anyone can name any identity): only the attestation and the certificate are. */
  pqIdentity: Uint8Array;
}

/** Live pool state the Launch account cannot tell (needed for the `graduated` phase). */
export interface MarketSnapshot {
  name: string;
  symbol: string;
  uri: string;
  /** Supply right after pool creation (from the certificate). */
  initialSupply: bigint;
  /** Current mint supply (burns only ever lower it). */
  supply: bigint;
  /** wSOL in the DBC pool (lamports). */
  quoteReserve: bigint;
  /** Base tokens left in the DBC pool (base units). */
  baseReserve: bigint;
  /** Q64.64 square root of the DBC price in quote atomic units per base atomic unit. */
  sqrtPrice: bigint;
  /** The curve reached its migration threshold (DBC revokes the hook in that swap). */
  curveComplete: boolean;
  /** DBC migrated the liquidity to DAMM v2. */
  migrated: boolean;
  /** The DAMM v2 pool holding the launch authority's LP position, once migrated. */
  dammPool: PublicKey | null;
  /** Transfer hook still active on the mint. */
  hookActive: boolean;
}

export interface LaunchAccount extends LaunchState {
  publicKey: PublicKey;
  market?: MarketSnapshot;
}

export interface CommitAccount {
  publicKey: PublicKey;
  version: number;
  bump: number;
  launch: PublicKey;
  owner: PublicKey;
  amount: bigint;
  claimed: boolean;
  /** Receives the tokens at claim (its canonical Token-2022 ATA): the committer or a PQ vault of the base mint. Fixed by the first commit. */
  tokenOwner: PublicKey;
  /** Receives the wSOL refund at claim (its canonical wSOL ATA): the committer or a PQ vault of wSOL. Fixed by the first commit. */
  refundOwner: PublicKey;
}

/**
 * Decoded `PayoutVault` (82 bytes): what every commit naming the PQ vault
 * `vault` as its token owner committed to `launch`, together. `commit`
 * holds it to `batch_wallet_cap` (CapExceeded), so a vault never receives
 * more than one wallet could; anyone may use up that quota (a donation).
 */
export interface PayoutVaultAccount {
  publicKey: PublicKey;
  version: number;
  bump: number;
  launch: PublicKey;
  vault: PublicKey;
  /** wSOL lamports committed for this vault. */
  committed: bigint;
}

/**
 * Decoded `Identity` (196 bytes) at `["identity", SHA256(0x21 || pk)]`: an
 * LMS public key and which of its 1,024 one-time leaves have signed a
 * message that landed. A used leaf can never sign again.
 */
export interface IdentityAccount {
  /** The account address. */
  publicKey: PublicKey;
  version: number;
  bump: number;
  /** The 56-byte LMS public key (`u32be(6) || u32be(3) || I || T[1]`). */
  lmsPublicKey: Uint8Array;
  /** `SHA256(0x21 || lmsPublicKey)`: the id a launch names as `pq_identity`. */
  identityId: Uint8Array;
  /** 128-byte bitmap, least significant bit first: leaf `q` is used when `used[q >> 3] & (1 << (q & 7))`. */
  used: Uint8Array;
  /** Number of bits set in `used`. */
  usedCount: number;
}

/**
 * Decoded `Attestation` (2,708 bytes) at `["attestation", launch]`. Version
 * 3: the launch's identity signed exactly this configuration, metadata
 * record, creator rules and window (`attested` true). Version 0: an empty attestation left
 * by a signature that only burned its leaf (`launch` refuses it with
 * AttestationMismatch). A client must check `attested` and that
 * `messageHash` is the SHA-256 of its own message, never assume its landing
 * attested.
 */
export interface AttestationAccount {
  publicKey: PublicKey;
  version: number;
  bump: number;
  /** Version 3 and `launch` set: `launch` can use it (inside its window). */
  attested: boolean;
  launch: PublicKey;
  pqIdentity: Uint8Array;
  /** The LMS leaf that signed (< 1,024). */
  leaf: number;
  /** `metadataHashV2` of the metadata record the identity signed; it names the record `["metadata", launch, metadataHash]`, the only one `launch` uses. */
  metadataHash: Uint8Array;
  /** `rulesHash` of the creator rules the identity signed (all zero: none); it names the record `["rules", launch, rulesHash]`, whose bytes `launch` installs in the hook policy. */
  rulesHash: Uint8Array;
  /** SHA-256 of the 221-byte attestation message (v3). */
  messageHash: Uint8Array;
  slot: bigint;
  /** The attested launch window, unix seconds, inclusive. */
  notBefore: bigint;
  notAfter: bigint;
  /** The 2,508-byte LMS signature (empty in an empty attestation). */
  signature: Uint8Array;
}

/** Decoded `Protocol` account. */
export interface ProtocolAccount {
  publicKey: PublicKey;
  version: number;
  bump: number;
  treasury: PublicKey;
  platformFeeBps: number;
}

export type LaunchPhase = "configured" | "commit" | "execute" | "guarded" | "open" | "graduated";

export type SwapSide = "buy" | "sell";

export interface SwapQuote {
  side: SwapSide;
  venue: "dbc" | "damm-v2";
  amountIn: bigint;
  expectedOut: bigint;
  /** The transaction reverts if it would receive less (slippage bound). */
  minimumOut: bigint;
  /** Trading fee charged on this swap, in the fee token's base units, when known. */
  feeAmount: bigint | null;
  /** Fee rate applied, in bps, when known. */
  feeBps: number | null;
  /** Price impact against the pre-trade spot price, in bps, when known. */
  priceImpactBps: number | null;
  /** How the quote was obtained. */
  method: "dbc-sdk" | "simulation";
}

// ---------------------------------------------------------------- verify ---

export type CheckStatus = "pass" | "warn" | "fail";

export interface VerificationCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export type TrustedPartyKind =
  | "upgrade-multisig"
  | "operator"
  | "admin"
  | "upgrade-authority"
  | "validators"
  | "infrastructure";

export interface TrustedParty {
  name: string;
  address: PublicKey | null;
  kind: TrustedPartyKind;
  note: string;
}

/** Decoded `Certificate` account (SPEC §1.5). */
export interface CertificateAccount {
  publicKey: PublicKey;
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
  p2pLocked: boolean;
  platformFeeBps: number;
  recipients: FeeRecipient[];
  paramsHash: Uint8Array;
  policyVersion: number;
  /** The post-quantum identity that attested this launch (`PQ_ATTESTED`). */
  pqIdentity: Uint8Array;
  /** The identity's LMS leaf that signed the attestation. */
  pqLeaf: number;
  /** Slot of the attestation (`["attestation", launch]` holds the signature). */
  attestedSlot: bigint;
  /** The attested metadata record (`TokenMeta`) whose name, symbol and derived uri the mint holds (`METADATA_ONCHAIN`). */
  metadata: PublicKey;
  /**
   * Version 4: the creator rules the identity attested, which the hook
   * policy holds (`RULES_BOUND` = 4,096 in `checks`); all zero for none, and
   * on a version-3 certificate (487 bytes, written before rules existed).
   */
  rulesHash: Uint8Array;
}

/**
 * Decoded `LaunchRules` (`78 + len` bytes) at `["rules", launch,
 * rulesHash]`: a launch's creator rules (PXR1), written whole by
 * `publish_rules` after they verified for the launch's guard. The decoder
 * re-hashes the bytes and checks the address, so a record is exactly the
 * content its address names.
 */
export interface LaunchRulesAccount {
  publicKey: PublicKey;
  version: number;
  bump: number;
  launch: PublicKey;
  /** `SHA256("PHX-RULES-V1" || bytes)`: the address's third seed. */
  rulesHash: Uint8Array;
  /** The PXR1 bytes (at most 1,228). */
  bytes: Uint8Array;
}

/**
 * Decoded `Authorization` (2,669 bytes) at `["auth", launch, [kind],
 * payloadHash]` (`pq_authorize`): the launch's identity signed the 140-byte
 * `PHX-AUTH-V1` message over `kind` and `payloadHash`. Version 0 is an
 * empty account a landing that did not authorize created (`authorized`
 * false). Re-verify the signature from account state before showing it
 * (`verifyAuthorization`).
 */
export interface AuthorizationAccount {
  publicKey: PublicKey;
  version: number;
  bump: number;
  /** Version 1 and `launch` set. */
  authorized: boolean;
  launch: PublicKey;
  pqIdentity: Uint8Array;
  /** 1 activate a graph, 2 freeze it, 3 revoke its operator (the autopilot's kinds). */
  kind: number;
  payloadHash: Uint8Array;
  /** SHA-256 of the 140-byte authorization message. */
  messageHash: Uint8Array;
  /** When it landed (cluster clock, unix seconds): the 72-hour timelock of a replacement graph counts from here. */
  unixTime: bigint;
  slot: bigint;
  /** The LMS leaf that signed (< 1,024; the bitmap is shared with attestations). */
  leaf: number;
  /** The 2,508-byte LMS signature (empty in an empty account). */
  signature: Uint8Array;
}

/**
 * Decoded Launch Guard policy (`HookPolicy`, version 2, `279 + rules`
 * bytes) at `["policy", mint]` (hook program).
 */
export interface HookPolicyAccount {
  publicKey: PublicKey;
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
  p2pLocked: boolean;
  exempt: PublicKey[];
  /** The creator rules (PXR1 bytes; empty for none), exactly the attested rules record's bytes. */
  rules: Uint8Array;
}

export interface VerificationReport {
  mint: PublicKey;
  overall: CheckStatus;
  phase: LaunchPhase | null;
  checks: VerificationCheck[];
  trustedParties: TrustedParty[];
  certificate: CertificateAccount | null;
  /**
   * The launch's post-quantum origin as re-verified from live accounts; null
   * when there is no attestation to show (none, an empty burn-only one, or
   * one that cannot be decoded). Show it as proof of origin only when
   * `verified` is true (the `pq.origin` check then passes).
   */
  pqOrigin: PqOrigin | null;
  /**
   * The token's on-chain metadata record, found through the certificate,
   * with its document read defensively; null when there is no certificate
   * field to follow. Show its icon, description and links only when
   * `verified` is true.
   */
  metadata: VerifiedMetadata | null;
  /**
   * The creator's launch rules as re-checked live (the `launch.rules`
   * check): the certificate's `rulesHash`, the rules record it names, what
   * the rules say in plain English, and whether the Launch Guard holds
   * exactly them. A launch without rules has the all-zero hash and the one
   * line "No launch rules: ...". Null when there is no certificate to follow.
   * Show the rules as the launch's only when `verified` is true.
   */
  rules: VerifiedRules | null;
}

/**
 * A launch's creator rules (PXR1) as its post-quantum identity signed them
 * (the attestation's `rules_hash`), read from their on-chain record and
 * explained in plain English. Without rules: the all-zero hash, no address,
 * no bytes and the one line "No launch rules: ...".
 */
export interface AttestedRules {
  /** `rules_hash` as 64 hex characters (all zeros: no launch rules). */
  hash: string;
  /** The rules record `["rules", launch, rules_hash]` (null: no launch rules). */
  address: PublicKey | null;
  /** The PXR1 bytes (empty: no launch rules, or their record is missing or invalid). */
  bytes: Uint8Array;
  /**
   * One plain-English line per rule, then what always holds (`explainRules`
   * for the launch's guard); `["No launch rules: ..."]` without rules; empty
   * when the rules cannot be read or are not valid for the launch.
   */
  explanation: string[];
}

/** A launch's creator rules as `verifyLaunch` re-checked them (`VerificationReport.rules`). */
export interface VerifiedRules extends AttestedRules {
  /** The Launch Guard policy holds exactly these bytes (no launch rules: it holds none). */
  boundInPolicy: boolean;
  /**
   * Every rules check passed: the certificate records the rules the identity
   * signed, the Launch Guard holds exactly the published record's bytes, the
   * certificate's `RULES_BOUND` flag is set exactly when there are rules,
   * and the rules are valid for the launch's guard.
   */
  verified: boolean;
}

/** A token's metadata record as `verifyLaunch` re-checked it. */
export interface VerifiedMetadata {
  /** The record's address (`Certificate.metadata`). */
  address: PublicKey;
  /** The decoded record (null when it is missing or invalid). */
  record: TokenMetaAccount | null;
  /** The record's document, read defensively (`parseMetadataDoc`; never fetched). Null without a record. */
  document: ParsedMetadataDoc | null;
  /** The record is the attested one (canonical address, hash recomputed) and the mint holds exactly its name, symbol and derived uri. */
  verified: boolean;
}

/**
 * A launch's post-quantum origin, re-checked off-chain (`verifyLaunch`,
 * `verifyAttestation`): the attestation `["attestation", launch]` holds an
 * LMS signature by the identity the launch names; the 221-byte message v3
 * is rebuilt from on-chain data alone (launch, `params_hash`, creator, the
 * hash of the on-chain metadata record, recomputed from the record itself,
 * the creator rules' hash, and the window) and the signature re-verified
 * against the identity account's LMS public key.
 */
export interface PqOrigin {
  /** The attestation account (`["attestation", launch]`). */
  attestation: PublicKey;
  /** The identity account (`["identity", identityId]`): LMS public key and used-leaf bitmap. */
  identity: PublicKey;
  /** `SHA256(0x21 || LMS public key)`: the launch's `pq_identity`. */
  identityId: Uint8Array;
  /** The identity's 56-byte LMS public key (null if its account is missing or unreadable). */
  lmsPublicKey: Uint8Array | null;
  /** The one-time LMS leaf that signed (0..1023). */
  leaf: number;
  /** Slot in which the attestation landed. */
  attestationSlot: bigint;
  /** SHA-256 of the 221-byte message (v3), as stored. */
  messageHash: Uint8Array;
  /** The window `launch` was allowed to run in (unix seconds, inclusive). */
  window: { notBefore: bigint; notAfter: bigint };
  /** `metadataHashV2` of the signed metadata record. */
  metadataHash: Uint8Array;
  /** The signed record's address, `["metadata", launch, metadataHash]`. */
  tokenMeta: PublicKey;
  /**
   * The creator rules the identity signed (the attestation's `rules_hash`),
   * read from their record and explained in plain English; the all-zero
   * hash and "No launch rules: ..." when it signed none.
   */
  rules: AttestedRules;
  /** The stored signature verifies, at `leaf`, over the message rebuilt from on-chain data. */
  signatureValid: boolean;
  /** Every PQ-origin check passed (signature, message, identity, certificate fields, window). */
  verified: boolean;
}

// -------------------------------------------------------------------- pq ---

export interface VaultKeyMaterial {
  /** LM-OTS private seed. Keep in memory only; never log or persist it. */
  skSeed: Uint8Array;
  pk: LmotsPublicKey;
  keyId: Uint8Array;
}

/** Decoded `Vault` account, vault v4 (programs/noised-vault/src/state.rs). */
export interface VaultAccount {
  publicKey: PublicKey;
  version: number;
  bump: number;
  mint: PublicKey;
  /** Key id of the key that opened the vault: the PDA seed, fixed forever. */
  genesisKeyId: Uint8Array;
  /** Withdrawals executed so far; the next withdrawal signs this value. */
  sequence: bigint;
  /** Key id of the current key (the one that signs at `sequence`). */
  keyId: Uint8Array;
  /** The current LM-OTS public key. */
  key: LmotsPublicKey;
  /** Tokens held for payouts that have not been released yet. */
  reserved: bigint;
}

/** A vault and its token account (`fetchVault`). */
export interface VaultInfo extends VaultAccount {
  /** SPL Token or Token-2022: the mint's owner. */
  tokenProgram: PublicKey;
  /** The deposit address: ATA(vault, mint). SOL or other tokens sent to the vault PDA itself are unrecoverable. */
  tokenAccount: PublicKey;
  /** Balance of the token account (0 if it does not exist). */
  balance: bigint;
  /** What the next withdrawal can reserve: `balance - reserved` (0 if negative). */
  available: bigint;
}

/** Decoded `Payout` account: tokens a withdrawal reserved, waiting for `release` / `release_to`. */
export interface PayoutAccount {
  publicKey: PublicKey;
  version: number;
  bump: number;
  vault: PublicKey;
  /** The withdrawal's sequence (PDA seed). */
  sequence: bigint;
  /** The wallet the signed message names. */
  destinationOwner: PublicKey;
  amount: bigint;
  /** Paid the rent; receives it back when the payout is released. */
  rentPayer: PublicKey;
}

/** A vault's unreleased payouts (`listPayouts`). */
export interface PayoutListing {
  /** Sorted by sequence. */
  payouts: PayoutAccount[];
  /** True when every unreleased payout is listed. */
  complete: boolean;
  /** `getProgramAccounts`, or probing the payout PDAs below the vault's sequence when the RPC refuses it. */
  method: "getProgramAccounts" | "probe";
  /** Why the listing may be incomplete (null when complete). */
  note: string | null;
}

export interface WithdrawTxArgs {
  mint: PublicKey;
  vault: PublicKey;
  /** The vault sequence the signature was made for (the message's `sequence`). */
  sequence: bigint;
  /** Recipient wallet (bound by the signature); `release` pays its canonical ATA. */
  destinationOwner: PublicKey;
  maxAmount: bigint;
  /** `C || y` (2176 bytes) over `withdrawMessage(...)`. */
  signature: Uint8Array;
  /** The key that controls the vault afterwards; must hash to `nextKeyId`. */
  nextKey: LmotsPublicKey;
  nextKeyId: Uint8Array;
  /** Append `release` to the same v1 transaction, so the recipient is paid at once. */
  includeRelease?: boolean;
}

/** One vault account number of a recovery phrase (`scanVaults`). */
export interface ScannedVault {
  account: number;
  vault: PublicKey;
  genesisKeyId: Uint8Array;
  /** The vault exists (opened). */
  opened: boolean;
  sequence: bigint;
  /** Key id of the vault's current key (null when not opened). */
  keyId: Uint8Array | null;
  /** The current key is this phrase's key at (account, sequence), so this phrase can sign (null when not opened). */
  keyMatches: boolean | null;
  /** Token account balance (tokens can arrive before the vault is opened). */
  balance: bigint;
  reserved: bigint;
  available: bigint;
  pendingPayouts: PayoutAccount[];
  /** Every unreleased payout is listed and their amounts add up to `reserved`. */
  payoutsComplete: boolean;
}

/**
 * `checkRecipient`: whether a recipient wallet can safely be named in a
 * signed withdrawal. Never sign while `refusals` is not empty. The three
 * kinds of caution need three separate confirmations from the user:
 * `recipientWarnings` (about this recipient), `mintWarnings` (the same for
 * every recipient of this mint and vault) and `offCurveConfirmation` (a
 * possible permanent loss, confirmed on its own).
 */
export interface RecipientCheck {
  /** No refusal: signing a withdrawal to this recipient is not known to lose or strand the payout. */
  ok: boolean;
  /** Reasons not to sign: the payout would be lost, stranded or nothing. */
  refusals: string[];
  /**
   * About this recipient address and its canonical token account: a program
   * or an account of another program, a program wallet (off-curve, so only
   * its program can sign `release_to`), a canonical token account that was
   * reassigned, is frozen, refuses non-confidential credits, requires memos
   * or cannot be read. They can delay or redirect this payout; they never
   * block the withdrawal itself.
   */
  recipientWarnings: string[];
  /**
   * About the mint and the vault, the same for every recipient: powers that
   * can delay any payout (freeze, pause, transfer hook, default-frozen
   * accounts), a mint that cannot be parsed, the vault's token account frozen
   * right now. They never block the withdrawal itself.
   */
  mintWarnings: string[];
  /**
   * Set when the recipient is off the Ed25519 curve (no private key exists
   * for it) and has no account on chain: it may be a program's wallet that
   * was never used (a multisig vault: legitimate), or an address nobody can
   * use (an associated token account that was closed or not created yet, a
   * vault or payout address): then the payout is lost forever. The exact
   * text to show; signing needs its own explicit confirmation, separate from
   * the warnings. Null when it does not apply.
   */
  offCurveConfirmation: string | null;
  /** Where `release` pays: the recipient's canonical ATA for the mint (null if the mint is unreadable). */
  canonicalAta: PublicKey | null;
  /** The recipient wallet this check is for: a confirmation binds to it (and to `mint` and `vault`). */
  destinationOwner: PublicKey;
  /** The mint the recipient was checked for. */
  mint: PublicKey;
  /** The vault the withdrawal comes from. */
  vault: PublicKey;
  /** The connected wallet whose own token accounts were refused as recipients (null when none was given). */
  wallet: PublicKey | null;
}

/** `checkRecipient` options. */
export interface CheckRecipientOptions {
  /** The wallet the user is connected with: its own token accounts for the mint (both token programs) are refused as recipients. */
  wallet?: PublicKey | null | undefined;
}

/**
 * The user's confirmation of a recipient, required by every call that signs
 * a vault withdrawal (`prepareWithdrawal`, `signWithdrawal`) BEFORE any
 * signature exists: a signed message cannot be changed, and the program
 * cannot tell a wallet from a token account, a mint or a PDA.
 *
 * Run `checkRecipient(conn, destinationOwner, mint, vault, { wallet })` for
 * the exact withdrawal, show its `refusals` (never sign then),
 * `recipientWarnings`, `mintWarnings` and `offCurveConfirmation`, and pass
 * what the user confirmed. Each acknowledgment is required (`true`) exactly
 * when the check holds that kind of caution; with nothing to confirm,
 * `acknowledged: {}` will do. The signer refuses
 * (`RecipientConfirmationError`, before any signature or ledger write) a
 * check of another recipient, mint or vault, one with refusals, a caution
 * the user did not acknowledge, and a stale check: it re-runs
 * `checkRecipient` right before signing, and any refusal or caution the user
 * was not shown (the chain changed since) refuses too.
 */
export interface RecipientConfirmation {
  /** `checkRecipient`'s result for this exact recipient, mint and vault, as shown to the user. */
  readonly recipient: RecipientCheck;
  /** What the user explicitly confirmed (three separate confirmations). */
  readonly acknowledged: {
    /** Required when `recipient.recipientWarnings` is not empty. */
    readonly recipientWarnings?: boolean | undefined;
    /** Required when `recipient.mintWarnings` is not empty. */
    readonly mintWarnings?: boolean | undefined;
    /** Required when `recipient.offCurveConfirmation` is set: a possible permanent loss, confirmed on its own. */
    readonly offCurveConfirmation?: boolean | undefined;
  };
}

/** A withdrawal signed by a vault's current key, found on chain (`findPendingWithdrawal`). */
export interface PendingWithdrawal {
  /** The transaction that revealed the signature. */
  txSignature: string;
  /** That transaction landed but failed: the signature is public all the same. */
  failed: boolean;
  /**
   * It can be re-broadcast as found: its next key is known (`nextKey` not
   * null), has the index `q = sequence + 1` the program requires
   * (InvalidKeyIndex otherwise) and is not the current key. Every withdrawal
   * the SDK signs can. One that cannot still means the key signed: never
   * sign another message with it.
   */
  executable: boolean;
  slot: number | null;
  vault: PublicKey;
  mint: PublicKey;
  sequence: bigint;
  destinationOwner: PublicKey;
  maxAmount: bigint;
  nextKeyId: Uint8Array;
  /**
   * The next key, authenticated: it hashes to `nextKeyId`. Null when every
   * transaction that carried this signature paired it with a next key that
   * does not (a copy with a junk key): the signature is revealed all the
   * same, and only the signer can supply the genuine next key
   * (`prepareWithdrawal` derives it from the phrase).
   */
  nextKey: LmotsPublicKey | null;
  /** The LM-OTS signature to re-broadcast (never sign again). */
  signature: Uint8Array;
  /** The 185-byte message it signs. */
  message: Uint8Array;
}

export interface PendingWithdrawalSearch {
  vault: VaultAccount;
  /**
   * The newest revealed withdrawal for the current sequence that can be
   * re-broadcast as found (`executable`): its signature verifies with the
   * vault's current key over the message rebuilt from its own fields, and its
   * next key hashes to its next key id. Null if none was found.
   */
  pending: PendingWithdrawal | null;
  /**
   * Every distinct message the current key signed (verified over the
   * message rebuilt from its own fields), newest first, including any that
   * cannot be re-broadcast as found (`executable: false`: a junk-keyed copy,
   * or a next key of the wrong index). More than one means the key signed
   * twice: execute one now. Never sign while this is not empty.
   */
  all: PendingWithdrawal[];
  /**
   * Every transaction that could hold a signature of the current key was
   * read, back to the transaction that installed that key (so nothing older
   * can hold one). Never sign a new withdrawal while this is false.
   */
  complete: boolean;
  /**
   * Why `complete` is false (null when complete): `"limit"` (this call's
   * `maxTransactions` or `maxSignaturePages` ran out: continue the search);
   * `"unreadable"` (transactions that could not be fetched or decoded: they
   * are retried when the search continues); `"history"` (the RPC's history
   * ends, or pages wrongly, before the installing transaction: continuing on
   * this RPC cannot help; use an RPC that keeps the full history).
   */
  incompleteReason: "limit" | "unreadable" | "history" | null;
  /** Pass it back as `continueFrom` to continue this search (non-null when continuing can help: `"limit"` and `"unreadable"`). */
  continuation: PendingWithdrawalContinuation | null;
  /** Transactions read (`getTransaction`), over every call of this search. */
  examined: number;
  /** Why the search may be incomplete (null when complete). */
  note: string | null;
}

/**
 * Where an incomplete `findPendingWithdrawal` stopped. Opaque: only the
 * object a search returned is accepted, in the process that made it. Passing
 * it back as `continueFrom` first reads what landed in the vault's history
 * since, then resumes where the search stopped; it is ignored (the search
 * starts over) once the vault moved to another sequence.
 */
export interface PendingWithdrawalContinuation {
  readonly vault: PublicKey;
  /** The vault sequence (and so the key) the search is about. */
  readonly sequence: bigint;
  /** Transactions read so far. */
  readonly examined: number;
}

/** `findPendingWithdrawal` options. */
export interface PendingWithdrawalSearchOptions {
  /** Most transactions this call reads with `getTransaction` (default 1,000); past it the search stops, incomplete, with a continuation. */
  maxTransactions?: number | undefined;
  /**
   * Most `getSignaturesForAddress` pages (1,000 entries each) this call reads
   * (default 200; at least 2, as a continued call first reads a page of what
   * landed since); past it the search stops, incomplete, with a continuation.
   */
  maxSignaturePages?: number | undefined;
  /** Continue an incomplete search of the same vault: the `continuation` of its last result. */
  continueFrom?: PendingWithdrawalContinuation | null | undefined;
}

export interface VaultMintCheck {
  eligible: boolean;
  /** Reasons `open_vault` would refuse this mint (empty = it would accept it). */
  refusals: string[];
  /** Powers that can delay a payout or change value but cannot take vaulted tokens. */
  warnings: string[];
  tokenProgram: PublicKey | null;
}

export type { Cluster };

// ---------------------------------------------------------------- shield ---

/** Decoded `Shield` account (programs/noised-shield/src/state.rs). */
export interface ShieldAccount {
  publicKey: PublicKey;
  version: number;
  bump: number;
  authorityBump: number;
  zMintBump: number;
  decimals: number;
  baseMint: PublicKey;
  baseTokenProgram: PublicKey;
  zMint: PublicKey;
  escrow: PublicKey;
  createdAt: bigint;
}

// ------------------------------------------------------------------- rpc ---

export interface ProgramInvocation {
  programId: PublicKey;
  /** Human name if the program is one this SDK knows, else null. */
  name: string | null;
}

export interface SimulationReport {
  ok: boolean;
  /** Human explanation of the failure, mapped from program error codes. */
  error: string | null;
  /** Raw error, e.g. `{ program: "noised_launchpad", code: 6023, name: "NotCommitWindow" }`. */
  errorCode: { program: string; code: number; name: string } | null;
  /**
   * Index of the failing top-level instruction (null on success or for
   * transaction-level errors). `simulateAndExplain` always sets it; it is
   * optional so reports built elsewhere stay valid.
   */
  failedInstruction?: number | null;
  logs: string[];
  unitsConsumed: number | null;
  /** Every top-level program the transaction invokes. */
  programs: ProgramInvocation[];
  /** Top-level programs this SDK does not recognise (signing should be refused). */
  unknownPrograms: PublicKey[];
  signers: PublicKey[];
  writableAccounts: PublicKey[];
  /** Base fee of the message (signatures), when the RPC reports it. */
  feeLamports: bigint | null;
  /** Wire size in bytes and the limit for this transaction format. */
  sizeBytes: number;
  sizeLimit: number;
  format: "legacy" | "v1";
}

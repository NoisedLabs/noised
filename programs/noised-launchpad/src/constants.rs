//! Seeds, external program ids and the safety-policy bounds (SPEC §1.1-1.2).

use crate::{pubkey::pubkey, Pubkey};

pub const PROTOCOL_SEED: &[u8] = b"protocol";
pub const LAUNCH_SEED: &[u8] = b"launch";
pub const AUTHORITY_SEED: &[u8] = b"authority";
pub const BATCH_SEED: &[u8] = b"batch";
pub const DBC_CONFIG_SEED: &[u8] = b"dbc-config";
pub const CERTIFICATE_SEED: &[u8] = b"certificate";
pub const COMMIT_SEED: &[u8] = b"commit";
/// `["identity", pq_identity]`: a creator's post-quantum identity and its
/// one-time-leaf bitmap.
pub const IDENTITY_SEED: &[u8] = b"identity";
/// `["attestation", launch]`: the launch's post-quantum attestation.
pub const ATTESTATION_SEED: &[u8] = b"attestation";
/// `["payout-vault", launch, vault]`: what every commit naming the PQ vault
/// `vault` as its token owner committed to `launch`, held to one wallet's
/// batch cap.
pub const PAYOUT_VAULT_SEED: &[u8] = b"payout-vault";
/// `["metadata", launch, metadata_hash]`: a token's metadata record
/// (`TokenMeta`), at the address its content hashes to.
pub const METADATA_SEED: &[u8] = b"metadata";
/// Must equal `noised_hook::state::HOOK_AUTHORITY_SEED` (checked in tests).
pub const HOOK_AUTHORITY_SEED: &[u8] = b"hook-authority";
/// `["rules", launch, rules_hash]`: a launch's creator rules (`LaunchRules`),
/// at the address their content hashes to.
pub const RULES_SEED: &[u8] = b"rules";
/// `["auth", launch, [kind], payload_hash]`: an `Authorization` by the
/// launch's post-quantum identity.
pub const AUTH_SEED: &[u8] = b"auth";
/// The kinds `pq_authorize` writes an `Authorization` for: the autopilot's
/// GRAPH_ACTIVATE (1), GRAPH_FREEZE (2) and OPERATOR_REVOKE (3). A valid
/// signature of any other kind only burns its leaf (review 4, Ra).
pub const AUTHORIZATION_KINDS: core::ops::RangeInclusive<u8> = 1..=3;

/// Meteora Dynamic Bonding Curve 0.2.1.
pub const DBC_PROGRAM_ID: Pubkey = pubkey!("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
/// DBC `pool_authority` PDA: owns DBC vaults and the transfer-hook authority of every DBC mint.
pub const DBC_POOL_AUTHORITY: Pubkey = pubkey!("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
/// DBC `__event_authority` PDA (emit_cpi).
pub const DBC_EVENT_AUTHORITY: Pubkey = pubkey!("8Ks12pbrD6PXxfty1hVQiE9sc289zgU1zHkvXhrSdriF");
/// Meteora DAMM v2 (cp_amm).
pub const DAMM_V2_PROGRAM_ID: Pubkey = pubkey!("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
pub const DAMM_V2_POOL_AUTHORITY: Pubkey = pubkey!("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
pub const DAMM_V2_EVENT_AUTHORITY: Pubkey = pubkey!("3rmHSu74h1ZcmAisVcWerTCiRDQbUrBKmcwptYGjHfet");
/// Wrapped SOL (SPL Token): no freeze authority, no badge, no transfer fee.
pub const WSOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");

/// The Noised PQ vault program (`noised_vault`) and the bytes of its
/// `Vault` account (version 4) that identify a vault and its mint. The
/// treasury and a commit's payout owners may be such vaults; they are
/// recognized by these bytes alone (pinned against the vault crate in
/// tests), so the launchpad does not link the vault program.
pub mod pq_vault {
    use crate::{pubkey::pubkey, Pubkey};

    pub const PROGRAM_ID: Pubkey = pubkey!("7BQ6FQomidBkd5z7fQfwr9Zt87oahMvMV5dFnw6Dz7nb");
    /// `sha256("account:Vault")[..8]`.
    pub const VAULT_DISCRIMINATOR: [u8; 8] = [211, 8, 232, 43, 2, 152, 117, 119];
    /// `Vault::VERSION`, the byte after the discriminator.
    pub const VAULT_VERSION: u8 = 4;
    pub const VERSION_OFFSET: usize = 8;
    /// `Vault::mint` follows `version` and `bump`.
    pub const MINT_OFFSET: usize = 10;
}

/// Version of the rules in `policy.rs`, written into every certificate.
/// Version 2: post-quantum attestation required (it also fixes the launch
/// window, and `launch` is permissionless inside it), minute-long commit
/// windows, the ten-minute execution window the batch ends early, batch-cap
/// floors, payout vaults held to one wallet's batch cap.
/// Version 3: the token's metadata (name, symbol, uri mode and document) is
/// an on-chain record the attestation signs, and the mint's metadata is
/// checked against it after the pool CPI (`checks::METADATA_ONCHAIN`).
pub const SAFETY_POLICY_VERSION: u16 = 3;

/// The launch window an attestation signs (`attest_launch`): `launch` runs
/// only from `not_before` to `not_after` (inclusive), and anyone may run it
/// then. So the creator's hash-based key, not an Ed25519 key a quantum
/// computer could forge, decides when a launch opens. A window lasts from a
/// minute (time to land the launch) to an hour, opens at most a week after
/// its attestation lands, and has at least a minute left when it lands
/// (`pq::launch_window_is_valid`); an attestation of any other window only
/// burns its leaf, so neither a client's mistake (seconds versus
/// milliseconds, a swapped pair) nor a late or held-back landing fixes a
/// window `launch` has no time to use. A window that passes without
/// `launch` fixes nothing either: while the launch is Configured, the next
/// attesting signature of its identity replaces it (`attest_launch`). So no
/// attestation ever fixes a launch that cannot open: until it is Live, its
/// identity can sign a new window with any of its unused leaves.
pub const MIN_LAUNCH_WINDOW_SECS: i64 = 60;
pub const MAX_LAUNCH_WINDOW_SECS: i64 = 3_600;
pub const MAX_LAUNCH_LEAD_SECS: i64 = 7 * 86_400;

pub const BPS_DENOMINATOR: u64 = 10_000;
/// Window after the commit window in which the batch must execute; the hook
/// blocks every other buy until it ends, or until the batch executes
/// (`execute_batch` then ends the shield at once, so a long window never
/// delays trading). Anyone can write-lock the batch's accounts and fill their
/// per-block compute budget; ten minutes only makes forcing an expiry cost
/// ten minutes of that contention. It raises the cost linearly and does not
/// remove it: keepers still need priority fees and tight compute limits.
pub const EXECUTION_GRACE_SECS: u32 = 600;
/// Shortest commit window. A party that fills the `Launch` account's
/// per-block write budget keeps every commit out while it pays, and its cost
/// grows with the length of the window, so the window is never seconds. Like
/// the execution window, this only raises the cost of that exclusion
/// linearly (about 0.02 SOL for a minute against commits that pay no
/// priority fee); it does not remove it.
pub const MIN_OPEN_DELAY: u32 = 60;
pub const MAX_OPEN_DELAY: u32 = 1_800;
pub const MAX_GUARD_SECS: u32 = 72 * 3_600;
pub const LAMPORTS_PER_SOL: u64 = 1_000_000_000;
pub const MIN_THRESHOLD: u64 = LAMPORTS_PER_SOL;
pub const MAX_THRESHOLD: u64 = 100_000 * LAMPORTS_PER_SOL;
pub const MAX_PLATFORM_FEE_BPS: u16 = 5_000;
/// A non-zero `batch_total_cap` is at least `migration_quote_threshold / 10`
/// (10% of the raise), so a creator cannot shrink the fair open to dust.
pub const MIN_BATCH_TOTAL_CAP_DIVISOR: u64 = 10;
/// A non-zero `batch_wallet_cap` is at least the resolved `batch_total_cap /
/// 200`: about 200 wallets fill the batch, so a tiny per-wallet cap cannot
/// keep it near-empty either.
pub const MIN_BATCH_WALLET_CAP_DIVISOR: u64 = 200;
pub const MIN_TOKEN_DECIMALS: u8 = 6;
pub const MAX_TOKEN_DECIMALS: u8 = 9;
/// DBC accepts up to 16; 8 keeps the largest `create_launch` (8 points, 4
/// recipients, a dynamic fee, `pq_identity`, compute-budget instructions)
/// inside a legacy 1,232-byte transaction, which every wallet can sign.
pub const MAX_CURVE_POINTS: usize = 8;
pub const MAX_RECIPIENTS: usize = 4;
/// Smallest non-zero max-wallet: 0.1% of supply (matches the hook's floor).
pub const MIN_MAX_WALLET_BPS: u16 = 10;
/// Metadata limits, in UTF-8 bytes (not characters).
pub const MAX_NAME_LEN: usize = 32;
pub const MAX_SYMBOL_LEN: usize = 10;
/// An external uri (`META_FLAG_EXTERNAL_URI`): the Metaplex DAS indexer
/// stores the uri in a `varchar(200)` and drops a token whose uri is longer.
pub const MAX_URI_LEN: usize = 200;
/// The metadata document (`TokenMeta::doc`): UTF-8 the program does not
/// parse (the SDK writes compact JSON with a 32x32 PNG icon inline). Its
/// `publish_metadata` transaction fits a v1 transaction with room to spare.
pub const MAX_DOC_LEN: usize = 3_072;

/// `TokenMeta::flags`, signed with the rest of the record. At most one of
/// the two uri modes; every other bit is 0. Without either, `launch` gives
/// the mint the empty uri, which every wallet and indexer handles (they show
/// the on-chain name and symbol).
pub const META_FLAG_INLINE_URI: u8 = 1;
/// The mint's uri is the record's own `uri`: an `https://` link the creator
/// chose (for wallets that only show icons from hosted JSON). The record's
/// document stays the canonical metadata.
pub const META_FLAG_EXTERNAL_URI: u8 = 2;
/// With `META_FLAG_INLINE_URI`, the mint's uri is this prefix followed by the
/// standard base64 (RFC 4648, padded) of the document.
pub const INLINE_URI_PREFIX: &str = "data:application/json;base64,";
/// The only scheme an external uri may have; at least one byte follows it.
pub const EXTERNAL_URI_PREFIX: &str = "https://";
/// The longest uri `launch` derives: an inline uri of a `MAX_DOC_LEN`
/// document (4,125 bytes; mainnet DBC handled 8,625).
pub const MAX_INLINE_URI_LEN: usize = INLINE_URI_PREFIX.len() + MAX_DOC_LEN.div_ceil(3) * 4;

/// Hard ceiling on what a trade can cost once the fee schedule has ended
/// (floor base fee + the largest possible dynamic fee). DBC itself allows
/// 99%, which would turn every sell after the batch into a honeypot.
pub const MAX_TRADING_FEE_BPS: u64 = 1_000;

/// Mirrors of the DBC 0.2.1 config validation constants, so `create_launch`
/// never accepts parameters that would make the DBC CPI fail.
pub mod dbc {
    pub const MIN_SQRT_PRICE: u128 = 4_295_048_016;
    pub const MAX_SQRT_PRICE: u128 = 79_226_673_521_066_979_257_578_248_091;
    pub const FEE_DENOMINATOR: u64 = 1_000_000_000;
    /// 0.25%: the smallest fee DBC accepts at any point of the schedule.
    pub const MIN_FEE_NUMERATOR: u64 = 2_500_000;
    /// 99%: the largest cliff fee DBC accepts.
    pub const MAX_FEE_NUMERATOR: u64 = 990_000_000;
    pub const BASE_FEE_MODE_LINEAR: u8 = 0;
    pub const BASE_FEE_MODE_EXPONENTIAL: u8 = 1;
    /// Dynamic fee: DBC only accepts a bin step of 1 bps.
    pub const DYNAMIC_BIN_STEP: u16 = 1;
    /// `(1 << 64) / 10_000`, the Q64.64 bin step DBC requires.
    pub const DYNAMIC_BIN_STEP_U128: u128 = 1_844_674_407_370_955;
    pub const U24_MAX: u32 = 0x00ff_ffff;
    /// Scale of DBC's variable fee: `ceil((va * bin_step)^2 * vfc / 1e11)`.
    pub const VARIABLE_FEE_SCALE: u128 = 100_000_000_000;
    pub const MAX_MIGRATION_FEE_OPTION: u8 = 5;

    // Fixed `ConfigParameters` values (SPEC §1.2).
    pub const COLLECT_FEE_MODE_QUOTE: u8 = 0;
    pub const MIGRATION_OPTION_DAMM_V2: u8 = 1;
    pub const ACTIVATION_TYPE_TIMESTAMP: u8 = 1;
    pub const TOKEN_TYPE_TOKEN_2022: u8 = 1;
    pub const TOKEN_UPDATE_AUTHORITY_IMMUTABLE: u8 = 1;
    pub const SWAP_MODE_PARTIAL_FILL: u8 = 1;
}

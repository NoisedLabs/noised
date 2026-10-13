//! Account layouts and creator-facing parameter types (SPEC §1.1, §1.2, §1.5,
//! PQ v2 §2.2).
//!
//! No account here is ever closed and no instruction rewrites a launch's
//! fee recipients, hook policy or DBC config after `create_launch`, except
//! that `execute_batch` ends the hook policy's snipe shield at the batch.

use anchor_lang::prelude::*;
use noised_lmots::{LMS_LEAVES, LMS_PUBLIC_KEY_LEN, LMS_SIG_LEN};

use crate::constants::MAX_RECIPIENTS;

/// Bytes of an identity's one-time-leaf bitmap: one bit per LMS leaf.
pub const LEAF_BITMAP_LEN: usize = LMS_LEAVES as usize / 8;

/// Global, immutable after `initialize_protocol`.
#[account]
#[derive(InitSpace)]
pub struct Protocol {
    pub version: u8,
    pub bump: u8,
    pub treasury: Pubkey,
    pub platform_fee_bps: u16,
}

impl Protocol {
    pub const VERSION: u8 = 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum LaunchStatus {
    /// DBC config created; pool not launched yet.
    Configured,
    /// Pool, hook policy and certificate exist.
    Live,
}

/// Per-launch state, at `["launch", creator, launch_seed]` (a launch's
/// address names its creator: nobody can take another creator's address).
/// Everything that shapes the launch is fixed at `create_launch`; later
/// instructions only advance the timeline and batch.
#[account]
#[derive(InitSpace)]
pub struct Launch {
    pub version: u8,
    pub bump: u8,
    pub authority_bump: u8,
    pub batch_bump: u8,
    pub config_bump: u8,
    pub status: LaunchStatus,
    pub launch_seed: [u8; 32],
    /// Signed `create_launch`; part of the attestation message. It has no
    /// powers afterwards: its post-quantum identity attests the launch and
    /// anyone may then launch it inside the attested window.
    pub creator: Pubkey,
    pub dbc_config: Pubkey,
    pub launch_authority: Pubkey,
    pub batch_authority: Pubkey,
    /// Default until `launch`.
    pub base_mint: Pubkey,
    /// Default until `launch`.
    pub pool: Pubkey,
    /// Snapshots of the immutable `Protocol` taken at creation.
    pub treasury: Pubkey,
    pub platform_fee_bps: u16,
    /// Unused slots are default with bps 0.
    pub recipients: [FeeRecipient; MAX_RECIPIENTS],
    pub recipient_count: u8,
    pub token_decimal: u8,
    pub migration_quote_threshold: u64,
    pub migration_fee_option: u8,
    pub open_delay_secs: u32,
    pub guard_secs: u32,
    pub max_wallet_bps: u16,
    pub max_buy_bps: u16,
    pub p2p_locked: bool,
    /// 0 = no per-wallet cap.
    pub batch_wallet_cap: u64,
    /// Resolved cap (a creator's 0 becomes the migration threshold).
    pub batch_total_cap: u64,
    /// sha256 of the borsh-serialized `LaunchParams`.
    pub params_hash: [u8; 32],
    pub launch_ts: i64,
    pub commit_end_ts: i64,
    pub execute_end_ts: i64,
    pub guard_end_ts: i64,
    pub total_committed: u64,
    pub executed: bool,
    pub quote_spent: u64,
    pub tokens_out: u64,
    /// Running totals that bound every payout (SPEC §7 invariant 4).
    pub tokens_claimed: u64,
    pub quote_refunded: u64,
    /// `LaunchParams::pq_identity`: the creator's post-quantum identity, the
    /// SHA-256 name of its LMS public key. `launch` requires an attestation
    /// signed by it.
    pub pq_identity: [u8; 32],
}

impl Launch {
    pub const VERSION: u8 = 2;
}

/// One participant's fair-open batch commitment.
#[account]
#[derive(InitSpace)]
pub struct Commit {
    pub version: u8,
    pub bump: u8,
    pub launch: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub claimed: bool,
    /// Receives the tokens: `owner` itself or a PQ vault of the base mint.
    /// Fixed by the first commit; `claim` pays only its canonical ATA.
    pub token_owner: Pubkey,
    /// Receives the wSOL refund: `owner` itself or a PQ vault of wSOL.
    /// Fixed by the first commit; `claim` pays only its canonical ATA.
    pub refund_owner: Pubkey,
}

impl Commit {
    pub const VERSION: u8 = 2;
}

/// `["payout-vault", launch, vault]`: what the commits naming the PQ vault
/// `vault` as their token owner have committed to `launch`, together. Claims
/// are exempt from the Launch Guard, so shares paid to one account would add
/// up past `max_wallet` and around `p2p_locked` while the guard runs:
/// `commit` holds this total to `batch_wallet_cap`, like one wallet's own
/// commit, so a vault never receives more than one wallet could. Created by
/// the first commit naming the vault; never closed.
#[account]
#[derive(InitSpace)]
pub struct PayoutVault {
    pub version: u8,
    pub bump: u8,
    pub launch: Pubkey,
    pub vault: Pubkey,
    /// wSOL committed by every commit whose token owner is `vault`.
    pub committed: u64,
}

impl PayoutVault {
    pub const VERSION: u8 = 1;
}

/// A creator's post-quantum identity (PQ v2 §2.2): an LMS public key
/// (RFC 8554 `LMS_SHA256_M32_H10` over `LMOTS_SHA256_N32_W4`, 1,024 one-time
/// leaves) at `["identity", SHA256(0x21 || public_key)]`, and which of its
/// leaves have signed an attestation message that landed. A leaf is accepted
/// once, ever. Created by the first of its signatures that lands; never
/// closed.
#[account]
#[derive(InitSpace)]
pub struct Identity {
    pub version: u8,
    pub bump: u8,
    /// `u32be(6) || u32be(3) || I || T[1]`.
    pub public_key: [u8; LMS_PUBLIC_KEY_LEN],
    /// Leaf `q` is used when `used[q >> 3] & (1 << (q & 7)) != 0`
    /// (least significant bit first; see `pq::leaf_bit`).
    pub used: [u8; LEAF_BITMAP_LEN],
    /// Number of bits set in `used`.
    pub used_count: u16,
}

impl Identity {
    pub const VERSION: u8 = 1;
}

/// A launch's post-quantum attestation (PQ v2 §2.2), at
/// `["attestation", launch]`: a valid LMS signature by the launch's identity
/// over its attestation message (`pq::attestation_message`) whose metadata
/// record exists, whose rules record exists if it names one, and whose
/// window has a minute left when it lands, kept in
/// full so anyone can re-verify it from account state alone. A landing that
/// does not attest leaves it as it is: empty (version 0 and `launch`
/// default, with only its bump set), which `launch` refuses, or the
/// attestation already written. Written by the first attesting signature;
/// rewritten whole only by an attesting signature landing after its window
/// ended while the launch was still Configured (`attest_launch`); never
/// modified once the launch is Live (the certificate keeps the one `launch`
/// used), never closed.
#[account]
#[derive(InitSpace)]
pub struct Attestation {
    pub version: u8,
    pub bump: u8,
    pub launch: Pubkey,
    pub pq_identity: [u8; 32],
    /// The LMS leaf `q` that signed (< 1,024).
    pub leaf: u16,
    /// `pq::metadata_hash_v2` of the metadata record the identity signed,
    /// which names its `TokenMeta` (`["metadata", launch, metadata_hash]`);
    /// `launch` uses only that record.
    pub metadata_hash: [u8; 32],
    /// `noised_rules::rules_hash` of the creator rules the identity signed,
    /// which names their `LaunchRules` (`["rules", launch, rules_hash]`);
    /// all zero for none. `launch` installs exactly those rules.
    pub rules_hash: [u8; 32],
    /// SHA-256 of the 221-byte attestation message.
    pub message_hash: [u8; 32],
    /// Slot the attestation landed in.
    pub slot: u64,
    /// The launch window the identity signed (unix seconds, inclusive):
    /// `launch` runs only inside it.
    pub not_before: i64,
    pub not_after: i64,
    /// The 2,508-byte LMS signature.
    #[max_len(LMS_SIG_LEN)]
    pub signature: Vec<u8>,
}

impl Attestation {
    /// Version 3: message v3, which binds `rules_hash`.
    pub const VERSION: u8 = 3;
}

/// A token's metadata, on-chain (`publish_metadata`), at
/// `["metadata", launch, metadata_hash]` where `metadata_hash =
/// pq::metadata_hash_v2(name, symbol, flags, uri, doc)`: the address is the
/// content, so nobody can put other bytes at an address an identity signed.
/// The space is exactly the content (`TokenMeta::space`). Created whole by
/// one instruction (anyone may pay), never modified or closed.
///
/// Anyone may publish records under any launch, each at its own address;
/// only the one an attestation names (`Attestation::metadata_hash`, then
/// `Certificate::metadata`) is the launch's. Readers resolve it through
/// those, never by searching for records of a launch.
#[account]
pub struct TokenMeta {
    pub version: u8,
    pub bump: u8,
    /// `META_FLAG_*`: how `launch` derives the mint's uri.
    pub flags: u8,
    pub launch: Pubkey,
    /// The address's third seed, stored for readers.
    pub metadata_hash: [u8; 32],
    /// UTF-8, 1..=32 bytes.
    pub name: String,
    /// UTF-8, 1..=10 bytes.
    pub symbol: String,
    /// Empty unless `META_FLAG_EXTERNAL_URI`: then `https://`, printable
    /// ASCII, at most 200 bytes.
    pub uri: String,
    /// The metadata document (UTF-8, at most 3,072 bytes; the SDK writes
    /// compact JSON). Not empty with `META_FLAG_INLINE_URI`.
    pub doc: String,
}

impl TokenMeta {
    pub const VERSION: u8 = 1;
    /// Byte offsets (discriminator included) of the fixed fields that
    /// `attest_launch` reads without decoding the record.
    pub const VERSION_OFFSET: usize = 8;
    pub const BUMP_OFFSET: usize = 9;
    pub const FLAGS_OFFSET: usize = 10;
    pub const LAUNCH_OFFSET: usize = 11;
    pub const METADATA_HASH_OFFSET: usize = 43;
    /// Discriminator, version, bump, flags, launch, metadata hash and the
    /// four strings' length prefixes: 91 bytes.
    pub const FIXED_LEN: usize = 8 + 3 + 32 + 32 + 4 * 4;

    /// Account space of a record with strings of these lengths (in bytes):
    /// exactly its borsh encoding.
    pub fn space(name: usize, symbol: usize, uri: usize, doc: usize) -> usize {
        Self::FIXED_LEN + name + symbol + uri + doc
    }
}

/// A launch's creator rules (PXR1, `noised_rules::rules`), on-chain
/// (`publish_rules`), at `["rules", launch, rules_hash]` where `rules_hash =
/// noised_rules::rules_hash(bytes)`: the address is the content. Verified
/// against the launch's guard when written; the space is exactly the
/// content (`LaunchRules::space`). Created whole by one instruction (anyone
/// may pay), never modified or closed. Only the record an attestation names
/// (`Attestation::rules_hash`, then `Certificate::rules_hash`) is the
/// launch's.
#[account]
pub struct LaunchRules {
    pub version: u8,
    pub bump: u8,
    pub launch: Pubkey,
    /// The address's third seed, stored for readers.
    pub rules_hash: [u8; 32],
    /// The PXR1 bytes (at most 1,228).
    pub bytes: Vec<u8>,
}

impl LaunchRules {
    pub const VERSION: u8 = 1;
    /// Byte offsets (discriminator included) of the fixed fields that
    /// `attest_launch` reads without decoding the record.
    pub const VERSION_OFFSET: usize = 8;
    pub const BUMP_OFFSET: usize = 9;
    pub const LAUNCH_OFFSET: usize = 10;
    pub const RULES_HASH_OFFSET: usize = 42;
    /// Discriminator, version, bump, launch, rules hash and the bytes'
    /// length prefix: 78 bytes.
    pub const FIXED_LEN: usize = 8 + 2 + 32 + 32 + 4;

    /// Account space of a record of `len` rule bytes: exactly its borsh
    /// encoding.
    pub fn space(len: usize) -> usize {
        Self::FIXED_LEN + len
    }
}

/// A post-quantum authorization (`pq_authorize`, programmable launches §2,
/// amendment A1), at `["auth", launch, [kind], payload_hash]`: a valid LMS
/// signature by the launch's identity over `pq::authorization_message`,
/// kept in full so anyone can re-verify it from account state alone.
/// Written once, by the first such signature (the account a landing that
/// does not authorize creates stays empty: version 0); never modified or
/// closed. The launchpad gives `kind` no meaning; the autopilot reads kinds
/// 1 (GRAPH_ACTIVATE), 2 (GRAPH_FREEZE) and 3 (OPERATOR_REVOKE), by layout.
#[account]
#[derive(InitSpace)]
pub struct Authorization {
    pub version: u8,
    pub bump: u8,
    pub launch: Pubkey,
    /// The launch's identity, which signed.
    pub pq_identity: [u8; 32],
    pub kind: u8,
    /// What is authorized (the consumer's payload hash).
    pub payload_hash: [u8; 32],
    /// SHA-256 of the 140-byte authorization message.
    pub message_hash: [u8; 32],
    /// When it landed (`Clock`).
    pub unix_time: i64,
    pub slot: u64,
    /// The LMS leaf that signed (< 1,024).
    pub leaf: u16,
    /// The 2,508-byte LMS signature.
    #[max_len(LMS_SIG_LEN)]
    pub signature: Vec<u8>,
}

impl Authorization {
    pub const VERSION: u8 = 1;
}

/// Immutable launch certificate (SPEC §1.5). Written once, never modified.
#[account]
#[derive(InitSpace)]
pub struct Certificate {
    pub version: u8,
    pub bump: u8,
    pub launch: Pubkey,
    pub base_mint: Pubkey,
    pub pool: Pubkey,
    pub dbc_config: Pubkey,
    /// Informational only: has no powers.
    pub creator: Pubkey,
    pub launched_at: i64,
    pub token_decimal: u8,
    pub initial_supply: u64,
    /// `checks::*` bitflags; all are set on every certificate.
    pub checks: u32,
    pub migration_quote_threshold: u64,
    pub migration_fee_option: u8,
    /// The scheduled end of the snipe shield (= `execute_end_ts`). When the
    /// batch executes before it, the live policy's end becomes the moment of
    /// the batch (`noised_hook::end_snipe_shield`); the certificate keeps
    /// the schedule.
    pub snipe_shield_end_ts: i64,
    pub execute_end_ts: i64,
    pub guard_end_ts: i64,
    pub max_wallet: u64,
    pub max_buy: u64,
    pub p2p_locked: bool,
    pub platform_fee_bps: u16,
    pub recipients: [FeeRecipient; MAX_RECIPIENTS],
    pub params_hash: [u8; 32],
    pub policy_version: u16,
    /// The post-quantum identity that attested this launch (`checks::PQ_ATTESTED`).
    pub pq_identity: [u8; 32],
    /// The identity's LMS leaf that signed the attestation.
    pub pq_leaf: u16,
    /// Slot of the attestation (`["attestation", launch]` holds the signature).
    pub attested_slot: u64,
    /// The `TokenMeta` record the identity attested, whose name, symbol and
    /// derived uri the mint holds (`checks::METADATA_ONCHAIN`).
    pub metadata: Pubkey,
    /// The creator rules the identity attested, which the hook policy
    /// holds (`checks::RULES_BOUND`); all zero for none.
    pub rules_hash: [u8; 32],
}

impl Certificate {
    /// Version 4: `rules_hash` and `checks::RULES_BOUND`.
    pub const VERSION: u8 = 4;
}

/// Certificate check bits (SPEC §1.5).
pub mod checks {
    pub const MINT_AUTHORITY_NONE: u32 = 1;
    pub const FREEZE_AUTHORITY_NONE: u32 = 2;
    pub const METADATA_UPDATE_AUTHORITY_NONE: u32 = 4;
    pub const METADATA_POINTER_AUTHORITY_NONE: u32 = 8;
    pub const EXTENSION_SET_EXACT: u32 = 16;
    pub const HOOK_IS_NOISED: u32 = 32;
    pub const LP_PERMANENTLY_LOCKED: u32 = 64;
    pub const NO_MIGRATION_FEE: u32 = 128;
    pub const NO_CREATOR_ALLOCATION: u32 = 256;
    pub const QUOTE_IS_WSOL: u32 = 512;
    /// The launch's identity signed its configuration and metadata with a
    /// hash-based (LMS) signature that the program verified on-chain.
    pub const PQ_ATTESTED: u32 = 1024;
    /// The mint's TokenMetadata, re-read after the pool CPI, holds exactly
    /// the attested record's name and symbol and the uri derived from it,
    /// and nothing else.
    pub const METADATA_ONCHAIN: u32 = 2048;
    /// Every check above: what `launch` requires.
    pub const ALL: u32 = 4095;
    /// Informational, never required: the launch has creator rules, and the
    /// hook policy, re-read after it was written, holds exactly the attested
    /// rules record's bytes.
    pub const RULES_BOUND: u32 = 4096;
}

#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace,
)]
pub struct FeeRecipient {
    pub wallet: Pubkey,
    pub bps: u16,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CurvePoint {
    pub sqrt_price: u128,
    pub liquidity: u128,
}

/// DBC base fee. Only fee-scheduler modes are accepted: 0 linear, 1 exponential.
/// `first_factor` = number of periods, `second_factor` = period length in
/// seconds, `third_factor` = reduction factor.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BaseFeeParams {
    pub cliff_fee_numerator: u64,
    pub first_factor: u16,
    pub second_factor: u64,
    pub third_factor: u64,
    pub base_fee_mode: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DynamicFeeParams {
    pub bin_step: u16,
    pub bin_step_u128: u128,
    pub filter_period: u16,
    pub decay_period: u16,
    pub reduction_factor: u16,
    pub max_volatility_accumulator: u32,
    pub variable_fee_control: u32,
}

/// Everything a creator chooses (SPEC §1.2). Field order is part of the
/// certificate's `params_hash`, so it must never change.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct LaunchParams {
    pub token_decimal: u8,
    pub sqrt_start_price: u128,
    pub curve: Vec<CurvePoint>,
    pub migration_quote_threshold: u64,
    pub base_fee: BaseFeeParams,
    pub dynamic_fee: Option<DynamicFeeParams>,
    pub migration_fee_option: u8,
    pub open_delay_secs: u32,
    pub guard_secs: u32,
    pub max_wallet_bps: u16,
    pub max_buy_bps: u16,
    pub p2p_locked: bool,
    pub batch_wallet_cap: u64,
    pub batch_total_cap: u64,
    pub recipients: Vec<FeeRecipient>,
    /// The creator's post-quantum identity: `SHA256(0x21 || LMS public key)`
    /// (`noised_lmots::identity_id`), never all zero. `launch` runs only
    /// after this identity attested the launch (`attest_launch`), inside the
    /// window it signed.
    pub pq_identity: [u8; 32],
}

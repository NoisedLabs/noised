//! Account layouts and creator-facing parameter types (SPEC §1.1, §1.2, §1.5,
//! PQ v2 §2.2).
//!
//! No account here is ever closed and no instruction rewrites a launch's
//! fee recipients, hook policy or DBC config after `create_launch`, except
//! that `execute_batch` ends the hook policy's snipe shield at the batch.
//!
//! Every account is the 8-byte discriminator (`sha256("account:<Name>")
//! [..8]`) followed by its fields in Borsh, exactly as the Anchor build's
//! `#[account]` wrote them. On-chain each type reads (`ProgramAccount`) and
//! writes itself at those offsets; off-chain the Anchor attributes give the
//! clients and tests `AccountDeserialize`, `AccountSerialize`,
//! `Discriminator` and `INIT_SPACE` as before.

use alloc::{string::String, vec::Vec};

#[cfg(not(target_os = "solana"))]
use anchor_lang::{AnchorDeserialize, AnchorSerialize, Discriminator};
use noised_lmots::{LMS_LEAVES, LMS_PUBLIC_KEY_LEN, LMS_SIG_LEN};
use noised_onchain::{accounts::ProgramAccount, args::Reader, AccountView, ProgramError};

use crate::{constants::MAX_RECIPIENTS, discriminator, Pubkey};

/// Bytes of an identity's one-time-leaf bitmap: one bit per LMS leaf.
pub const LEAF_BITMAP_LEN: usize = LMS_LEAVES as usize / 8;

// ------------------------------------------------------------ byte access

/// `L` bytes of `data` at `at` (callers stay within the data; zero beyond
/// it, so the program has no panicking path here).
#[inline(always)]
fn array<const L: usize>(data: &[u8], at: usize) -> [u8; L] {
    data.get(at..)
        .and_then(|rest| rest.first_chunk::<L>())
        .copied()
        .unwrap_or([0; L])
}

#[inline(always)]
fn key(data: &[u8], at: usize) -> Pubkey {
    Pubkey::new_from_array(array(data, at))
}

#[inline(always)]
fn u16_at(data: &[u8], at: usize) -> u16 {
    u16::from_le_bytes(array(data, at))
}

#[inline(always)]
fn u32_at(data: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(array(data, at))
}

#[inline(always)]
fn u64_at(data: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(array(data, at))
}

#[inline(always)]
fn i64_at(data: &[u8], at: usize) -> i64 {
    i64::from_le_bytes(array(data, at))
}

/// A Borsh `bool`: 0 or 1, anything else does not decode.
#[inline(always)]
fn bool_at(data: &[u8], at: usize) -> Option<bool> {
    match data.get(at)? {
        0 => Some(false),
        1 => Some(true),
        _ => None,
    }
}

#[inline(always)]
fn put(data: &mut [u8], at: usize, bytes: &[u8]) {
    if let Some(slot) = data.get_mut(at..at + bytes.len()) {
        slot.copy_from_slice(bytes);
    }
}

/// The recipients array (4 x (wallet, bps)) at `at`.
fn read_recipients(data: &[u8], at: usize) -> [FeeRecipient; MAX_RECIPIENTS] {
    core::array::from_fn(|i| {
        let at = at + i * FeeRecipient::LEN;
        FeeRecipient {
            wallet: key(data, at),
            bps: u16_at(data, at + 32),
        }
    })
}

fn write_recipients(data: &mut [u8], at: usize, recipients: &[FeeRecipient; MAX_RECIPIENTS]) {
    for (i, r) in recipients.iter().enumerate() {
        let at = at + i * FeeRecipient::LEN;
        put(data, at, r.wallet.as_ref());
        put(data, at + 32, &r.bps.to_le_bytes());
    }
}

/// Encodes `fields` (Borsh, after the discriminator) into `data`; `false`
/// when `data` is too short (Anchor's `AccountDidNotSerialize`).
fn write_with(data: &mut [u8], discriminator: &[u8; 8], fields: &[&[u8]]) -> bool {
    let len: usize = fields.iter().map(|f| f.len()).sum();
    let Some(out) = data.get_mut(..8 + len) else {
        return false;
    };
    out[..8].copy_from_slice(discriminator);
    let mut at = 8;
    for field in fields {
        out[at..at + field.len()].copy_from_slice(field);
        at += field.len();
    }
    true
}

// ---------------------------------------------------------------- Protocol

/// Global, immutable after `initialize_protocol`.
#[cfg_attr(not(target_os = "solana"), anchor_lang::account)]
#[cfg_attr(not(target_os = "solana"), derive(anchor_lang::InitSpace))]
#[cfg_attr(target_os = "solana", derive(Clone))]
#[derive(Debug, PartialEq, Eq)]
pub struct Protocol {
    pub version: u8,
    pub bump: u8,
    pub treasury: Pubkey,
    pub platform_fee_bps: u16,
}

impl Protocol {
    pub const VERSION: u8 = 1;
    /// Account size: discriminator and fields.
    pub const LEN: usize = 8 + 1 + 1 + 32 + 2;

    pub fn read(data: &[u8; Self::LEN]) -> Self {
        Self {
            version: data[8],
            bump: data[9],
            treasury: key(data, 10),
            platform_fee_bps: u16_at(data, 42),
        }
    }

    pub fn write(&self, data: &mut [u8; Self::LEN]) {
        data[..8].copy_from_slice(&discriminator::PROTOCOL);
        data[8] = self.version;
        data[9] = self.bump;
        put(data, 10, self.treasury.as_ref());
        put(data, 42, &self.platform_fee_bps.to_le_bytes());
    }
}

impl Protocol {
    /// Whether `data` holds the fields (any bytes decode).
    pub fn decodes(data: &[u8]) -> bool {
        data.len() >= Self::LEN
    }

    /// The fields of a checked account.
    pub fn load(account: &AccountView) -> Result<Self, ProgramError> {
        let data = account.try_borrow()?;
        Self::try_read(&data).ok_or(ProgramError::InvalidAccountData)
    }
}

impl ProgramAccount for Protocol {
    const ACCOUNT_DISCRIMINATOR: [u8; 8] = discriminator::PROTOCOL;

    fn try_read(data: &[u8]) -> Option<Self> {
        data.first_chunk::<{ Self::LEN }>().map(Self::read)
    }
}

// ------------------------------------------------------------------ Launch

#[cfg_attr(
    not(target_os = "solana"),
    derive(AnchorSerialize, AnchorDeserialize, anchor_lang::InitSpace)
)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LaunchStatus {
    /// DBC config created; pool not launched yet.
    Configured,
    /// Pool, hook policy and certificate exist.
    Live,
}

impl LaunchStatus {
    /// The Borsh variant index; anything but 0 or 1 does not decode.
    pub fn from_u8(tag: u8) -> Option<Self> {
        match tag {
            0 => Some(Self::Configured),
            1 => Some(Self::Live),
            _ => None,
        }
    }
}

/// Per-launch state, at `["launch", creator, launch_seed]` (a launch's
/// address names its creator: nobody can take another creator's address).
/// Everything that shapes the launch is fixed at `create_launch`; later
/// instructions only advance the timeline and batch.
#[cfg_attr(not(target_os = "solana"), anchor_lang::account)]
#[cfg_attr(not(target_os = "solana"), derive(anchor_lang::InitSpace))]
#[cfg_attr(target_os = "solana", derive(Clone))]
#[derive(Debug, PartialEq, Eq)]
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
    /// Account size: discriminator and fields.
    pub const LEN: usize = 585;

    /// Decodes the fields (`None` for a `status` or `bool` byte Borsh does
    /// not accept).
    #[inline(never)]
    pub fn read(d: &[u8; Self::LEN]) -> Option<Self> {
        Some(Self {
            version: d[8],
            bump: d[9],
            authority_bump: d[10],
            batch_bump: d[11],
            config_bump: d[12],
            status: LaunchStatus::from_u8(d[13])?,
            launch_seed: array(d, 14),
            creator: key(d, 46),
            dbc_config: key(d, 78),
            launch_authority: key(d, 110),
            batch_authority: key(d, 142),
            base_mint: key(d, 174),
            pool: key(d, 206),
            treasury: key(d, 238),
            platform_fee_bps: u16_at(d, 270),
            recipients: read_recipients(d, 272),
            recipient_count: d[408],
            token_decimal: d[409],
            migration_quote_threshold: u64_at(d, 410),
            migration_fee_option: d[418],
            open_delay_secs: u32_at(d, 419),
            guard_secs: u32_at(d, 423),
            max_wallet_bps: u16_at(d, 427),
            max_buy_bps: u16_at(d, 429),
            p2p_locked: bool_at(d, 431)?,
            batch_wallet_cap: u64_at(d, 432),
            batch_total_cap: u64_at(d, 440),
            params_hash: array(d, 448),
            launch_ts: i64_at(d, 480),
            commit_end_ts: i64_at(d, 488),
            execute_end_ts: i64_at(d, 496),
            guard_end_ts: i64_at(d, 504),
            total_committed: u64_at(d, 512),
            executed: bool_at(d, 520)?,
            quote_spent: u64_at(d, 521),
            tokens_out: u64_at(d, 529),
            tokens_claimed: u64_at(d, 537),
            quote_refunded: u64_at(d, 545),
            pq_identity: array(d, 553),
        })
    }

    /// Encodes discriminator and fields.
    #[inline(never)]
    pub fn write(&self, d: &mut [u8; Self::LEN]) {
        d[..8].copy_from_slice(&discriminator::LAUNCH_ACCOUNT);
        d[8] = self.version;
        d[9] = self.bump;
        d[10] = self.authority_bump;
        d[11] = self.batch_bump;
        d[12] = self.config_bump;
        d[13] = self.status as u8;
        put(d, 14, &self.launch_seed);
        put(d, 46, self.creator.as_ref());
        put(d, 78, self.dbc_config.as_ref());
        put(d, 110, self.launch_authority.as_ref());
        put(d, 142, self.batch_authority.as_ref());
        put(d, 174, self.base_mint.as_ref());
        put(d, 206, self.pool.as_ref());
        put(d, 238, self.treasury.as_ref());
        put(d, 270, &self.platform_fee_bps.to_le_bytes());
        write_recipients(d, 272, &self.recipients);
        d[408] = self.recipient_count;
        d[409] = self.token_decimal;
        put(d, 410, &self.migration_quote_threshold.to_le_bytes());
        d[418] = self.migration_fee_option;
        put(d, 419, &self.open_delay_secs.to_le_bytes());
        put(d, 423, &self.guard_secs.to_le_bytes());
        put(d, 427, &self.max_wallet_bps.to_le_bytes());
        put(d, 429, &self.max_buy_bps.to_le_bytes());
        d[431] = u8::from(self.p2p_locked);
        put(d, 432, &self.batch_wallet_cap.to_le_bytes());
        put(d, 440, &self.batch_total_cap.to_le_bytes());
        put(d, 448, &self.params_hash);
        put(d, 480, &self.launch_ts.to_le_bytes());
        put(d, 488, &self.commit_end_ts.to_le_bytes());
        put(d, 496, &self.execute_end_ts.to_le_bytes());
        put(d, 504, &self.guard_end_ts.to_le_bytes());
        put(d, 512, &self.total_committed.to_le_bytes());
        d[520] = u8::from(self.executed);
        put(d, 521, &self.quote_spent.to_le_bytes());
        put(d, 529, &self.tokens_out.to_le_bytes());
        put(d, 537, &self.tokens_claimed.to_le_bytes());
        put(d, 545, &self.quote_refunded.to_le_bytes());
        put(d, 553, &self.pq_identity);
    }
}

impl ProgramAccount for Launch {
    const ACCOUNT_DISCRIMINATOR: [u8; 8] = discriminator::LAUNCH_ACCOUNT;

    fn try_read(data: &[u8]) -> Option<Self> {
        Self::read(data.first_chunk::<{ Self::LEN }>()?)
    }
}

/// Byte offsets of `Launch`'s fields (the 8-byte discriminator included),
/// as its Borsh encoding lays them out.
pub mod launch_offsets {
    pub const VERSION: usize = 8;
    pub const BUMP: usize = 9;
    pub const AUTHORITY_BUMP: usize = 10;
    pub const BATCH_BUMP: usize = 11;
    pub const CONFIG_BUMP: usize = 12;
    pub const STATUS: usize = 13;
    pub const LAUNCH_SEED: usize = 14;
    pub const CREATOR: usize = 46;
    pub const DBC_CONFIG: usize = 78;
    pub const LAUNCH_AUTHORITY: usize = 110;
    pub const BATCH_AUTHORITY: usize = 142;
    pub const BASE_MINT: usize = 174;
    pub const POOL: usize = 206;
    pub const TREASURY: usize = 238;
    pub const PLATFORM_FEE_BPS: usize = 270;
    pub const RECIPIENTS: usize = 272;
    pub const RECIPIENT_COUNT: usize = 408;
    pub const TOKEN_DECIMAL: usize = 409;
    pub const MIGRATION_QUOTE_THRESHOLD: usize = 410;
    pub const MIGRATION_FEE_OPTION: usize = 418;
    pub const OPEN_DELAY_SECS: usize = 419;
    pub const GUARD_SECS: usize = 423;
    pub const MAX_WALLET_BPS: usize = 427;
    pub const MAX_BUY_BPS: usize = 429;
    pub const P2P_LOCKED: usize = 431;
    pub const BATCH_WALLET_CAP: usize = 432;
    pub const BATCH_TOTAL_CAP: usize = 440;
    pub const PARAMS_HASH: usize = 448;
    pub const LAUNCH_TS: usize = 480;
    pub const COMMIT_END_TS: usize = 488;
    pub const EXECUTE_END_TS: usize = 496;
    pub const GUARD_END_TS: usize = 504;
    pub const TOTAL_COMMITTED: usize = 512;
    pub const EXECUTED: usize = 520;
    pub const QUOTE_SPENT: usize = 521;
    pub const TOKENS_OUT: usize = 529;
    pub const TOKENS_CLAIMED: usize = 537;
    pub const QUOTE_REFUNDED: usize = 545;
    pub const PQ_IDENTITY: usize = 553;
}

/// A `Launch` account's bytes (discriminator included), as the program
/// handles it: read once, its fields read and written at their offsets
/// (`launch_offsets`), written back whole at exit. Equal, field by field, to
/// `Launch::read` / `Launch::write` (ABI tests).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LaunchData(pub [u8; Launch::LEN]);

impl LaunchData {
    /// Whether these bytes decode as a `Launch` (Borsh: `status` 0 or 1,
    /// `p2p_locked` and `executed` 0 or 1).
    pub fn decodes(data: &[u8]) -> bool {
        use launch_offsets::*;
        data.len() >= Launch::LEN
            && data[STATUS] <= 1
            && data[P2P_LOCKED] <= 1
            && data[EXECUTED] <= 1
    }

    /// The first `Launch::LEN` bytes of `data` (`decodes` held).
    pub fn copy_from(data: &[u8]) -> Self {
        let mut bytes = [0u8; Launch::LEN];
        if let Some(head) = data.first_chunk::<{ Launch::LEN }>() {
            bytes = *head;
        }
        Self(bytes)
    }

    #[inline(always)]
    pub fn byte(&self, at: usize) -> u8 {
        self.0.get(at).copied().unwrap_or(0)
    }

    #[inline(always)]
    pub fn key(&self, at: usize) -> Pubkey {
        key(&self.0, at)
    }

    #[inline(always)]
    pub fn array32(&self, at: usize) -> [u8; 32] {
        array(&self.0, at)
    }

    #[inline(always)]
    pub fn u16(&self, at: usize) -> u16 {
        u16_at(&self.0, at)
    }

    #[inline(always)]
    pub fn u32(&self, at: usize) -> u32 {
        u32_at(&self.0, at)
    }

    #[inline(always)]
    pub fn u64(&self, at: usize) -> u64 {
        u64_at(&self.0, at)
    }

    #[inline(always)]
    pub fn i64(&self, at: usize) -> i64 {
        i64_at(&self.0, at)
    }

    #[inline(always)]
    pub fn status(&self) -> u8 {
        self.byte(launch_offsets::STATUS)
    }

    #[inline(always)]
    pub fn flag(&self, at: usize) -> bool {
        self.byte(at) != 0
    }

    #[inline(always)]
    pub fn set(&mut self, at: usize, bytes: &[u8]) {
        put(&mut self.0, at, bytes);
    }

    /// The stored recipients (all four slots).
    pub fn recipients(&self) -> [FeeRecipient; MAX_RECIPIENTS] {
        read_recipients(&self.0, launch_offsets::RECIPIENTS)
    }
}

// ------------------------------------------------------------------ Commit

/// One participant's fair-open batch commitment.
#[cfg_attr(not(target_os = "solana"), anchor_lang::account)]
#[cfg_attr(not(target_os = "solana"), derive(anchor_lang::InitSpace))]
#[cfg_attr(target_os = "solana", derive(Clone))]
#[derive(Debug, PartialEq, Eq)]
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
    /// Account size: discriminator and fields.
    pub const LEN: usize = 147;

    pub fn read(d: &[u8; Self::LEN]) -> Option<Self> {
        Some(Self {
            version: d[8],
            bump: d[9],
            launch: key(d, 10),
            owner: key(d, 42),
            amount: u64_at(d, 74),
            claimed: bool_at(d, 82)?,
            token_owner: key(d, 83),
            refund_owner: key(d, 115),
        })
    }

    pub fn write(&self, d: &mut [u8; Self::LEN]) {
        d[..8].copy_from_slice(&discriminator::COMMIT_ACCOUNT);
        d[8] = self.version;
        d[9] = self.bump;
        put(d, 10, self.launch.as_ref());
        put(d, 42, self.owner.as_ref());
        put(d, 74, &self.amount.to_le_bytes());
        d[82] = u8::from(self.claimed);
        put(d, 83, self.token_owner.as_ref());
        put(d, 115, self.refund_owner.as_ref());
    }
}

impl Commit {
    /// Whether `data` holds the fields (`claimed` 0 or 1).
    pub fn decodes(data: &[u8]) -> bool {
        data.len() >= Self::LEN && data[82] <= 1
    }

    /// The fields of a checked account.
    pub fn load(account: &AccountView) -> Result<Self, ProgramError> {
        let data = account.try_borrow()?;
        Self::try_read(&data).ok_or(ProgramError::InvalidAccountData)
    }
}

impl ProgramAccount for Commit {
    const ACCOUNT_DISCRIMINATOR: [u8; 8] = discriminator::COMMIT_ACCOUNT;

    fn try_read(data: &[u8]) -> Option<Self> {
        Self::read(data.first_chunk::<{ Self::LEN }>()?)
    }
}

// ------------------------------------------------------------- PayoutVault

/// `["payout-vault", launch, vault]`: what the commits naming the PQ vault
/// `vault` as their token owner have committed to `launch`, together. Claims
/// are exempt from the Launch Guard, so shares paid to one account would add
/// up past `max_wallet` and around `p2p_locked` while the guard runs:
/// `commit` holds this total to `batch_wallet_cap`, like one wallet's own
/// commit, so a vault never receives more than one wallet could. Created by
/// the first commit naming the vault; never closed.
#[cfg_attr(not(target_os = "solana"), anchor_lang::account)]
#[cfg_attr(not(target_os = "solana"), derive(anchor_lang::InitSpace))]
#[cfg_attr(target_os = "solana", derive(Clone))]
#[derive(Debug, PartialEq, Eq)]
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
    /// Account size: discriminator and fields.
    pub const LEN: usize = 82;

    pub fn read(d: &[u8; Self::LEN]) -> Self {
        Self {
            version: d[8],
            bump: d[9],
            launch: key(d, 10),
            vault: key(d, 42),
            committed: u64_at(d, 74),
        }
    }

    pub fn write(&self, d: &mut [u8; Self::LEN]) {
        d[..8].copy_from_slice(&discriminator::PAYOUT_VAULT);
        d[8] = self.version;
        d[9] = self.bump;
        put(d, 10, self.launch.as_ref());
        put(d, 42, self.vault.as_ref());
        put(d, 74, &self.committed.to_le_bytes());
    }
}

impl PayoutVault {
    /// Whether `data` holds the fields (any bytes decode).
    pub fn decodes(data: &[u8]) -> bool {
        data.len() >= Self::LEN
    }

    /// The fields of a checked account.
    pub fn load(account: &AccountView) -> Result<Self, ProgramError> {
        let data = account.try_borrow()?;
        Self::try_read(&data).ok_or(ProgramError::InvalidAccountData)
    }
}

impl ProgramAccount for PayoutVault {
    const ACCOUNT_DISCRIMINATOR: [u8; 8] = discriminator::PAYOUT_VAULT;

    fn try_read(data: &[u8]) -> Option<Self> {
        data.first_chunk::<{ Self::LEN }>().map(Self::read)
    }
}

// ---------------------------------------------------------------- Identity

/// A creator's post-quantum identity (PQ v2 §2.2): an LMS public key
/// (RFC 8554 `LMS_SHA256_M32_H10` over `LMOTS_SHA256_N32_W4`, 1,024 one-time
/// leaves) at `["identity", SHA256(0x21 || public_key)]`, and which of its
/// leaves have signed an attestation message that landed. A leaf is accepted
/// once, ever. Created by the first of its signatures that lands; never
/// closed.
#[cfg_attr(not(target_os = "solana"), anchor_lang::account)]
#[cfg_attr(not(target_os = "solana"), derive(anchor_lang::InitSpace))]
#[cfg_attr(target_os = "solana", derive(Clone))]
#[derive(Debug, PartialEq, Eq)]
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
    /// Account size: discriminator and fields.
    pub const LEN: usize = 196;

    pub fn read(d: &[u8; Self::LEN]) -> Self {
        Self {
            version: d[8],
            bump: d[9],
            public_key: array(d, 10),
            used: array(d, 66),
            used_count: u16_at(d, 194),
        }
    }

    pub fn write(&self, d: &mut [u8; Self::LEN]) {
        d[..8].copy_from_slice(&discriminator::IDENTITY);
        d[8] = self.version;
        d[9] = self.bump;
        put(d, 10, &self.public_key);
        put(d, 66, &self.used);
        put(d, 194, &self.used_count.to_le_bytes());
    }
}

impl Identity {
    /// Whether `data` holds the fields (any bytes decode).
    pub fn decodes(data: &[u8]) -> bool {
        data.len() >= Self::LEN
    }

    /// The fields of a checked account (all zero if just created).
    pub fn load(account: &AccountView) -> Result<Self, ProgramError> {
        let data = account.try_borrow()?;
        Self::try_read(&data).ok_or(ProgramError::InvalidAccountData)
    }
}

impl ProgramAccount for Identity {
    const ACCOUNT_DISCRIMINATOR: [u8; 8] = discriminator::IDENTITY;

    fn try_read(data: &[u8]) -> Option<Self> {
        data.first_chunk::<{ Self::LEN }>().map(Self::read)
    }
}

// ------------------------------------------------------------- Attestation

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
#[cfg_attr(not(target_os = "solana"), anchor_lang::account)]
#[cfg_attr(not(target_os = "solana"), derive(anchor_lang::InitSpace))]
#[cfg_attr(target_os = "solana", derive(Clone))]
#[derive(Debug, PartialEq, Eq)]
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
    #[cfg_attr(not(target_os = "solana"), max_len(LMS_SIG_LEN))]
    pub signature: Vec<u8>,
}

impl Attestation {
    /// Version 3: message v3, which binds `rules_hash`.
    pub const VERSION: u8 = 3;
    /// Bytes before the signature's bytes (its length prefix included).
    pub const FIXED_LEN: usize = 200;
    /// Account space: the fields with a 2,508-byte signature.
    pub const LEN: usize = Self::FIXED_LEN + LMS_SIG_LEN;

    pub fn read(d: &[u8]) -> Option<Self> {
        let fixed = d.first_chunk::<{ Self::FIXED_LEN }>()?;
        let len = u32_at(fixed, 196) as usize;
        let signature = d.get(Self::FIXED_LEN..)?.get(..len)?;
        Some(Self {
            version: fixed[8],
            bump: fixed[9],
            launch: key(fixed, 10),
            pq_identity: array(fixed, 42),
            leaf: u16_at(fixed, 74),
            metadata_hash: array(fixed, 76),
            rules_hash: array(fixed, 108),
            message_hash: array(fixed, 140),
            slot: u64_at(fixed, 172),
            not_before: i64_at(fixed, 180),
            not_after: i64_at(fixed, 188),
            signature: signature.to_vec(),
        })
    }

    /// Encodes discriminator and fields into `d`; `false` when they do not
    /// fit.
    pub fn write(&self, d: &mut [u8]) -> bool {
        write_with(
            d,
            &discriminator::ATTESTATION,
            &[
                &[self.version, self.bump],
                self.launch.as_ref(),
                &self.pq_identity,
                &self.leaf.to_le_bytes(),
                &self.metadata_hash,
                &self.rules_hash,
                &self.message_hash,
                &self.slot.to_le_bytes(),
                &self.not_before.to_le_bytes(),
                &self.not_after.to_le_bytes(),
                &(self.signature.len() as u32).to_le_bytes(),
                &self.signature,
            ],
        )
    }
}

impl ProgramAccount for Attestation {
    const ACCOUNT_DISCRIMINATOR: [u8; 8] = discriminator::ATTESTATION;

    fn try_read(data: &[u8]) -> Option<Self> {
        Self::read(data)
    }
}

// --------------------------------------------------------------- TokenMeta

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
#[cfg_attr(not(target_os = "solana"), anchor_lang::account)]
#[cfg_attr(target_os = "solana", derive(Clone))]
#[derive(Debug, PartialEq, Eq)]
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

/// A `TokenMeta` read in place: its fixed fields and its four strings
/// (Borsh: valid UTF-8, each within the data).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TokenMetaRef<'a> {
    pub version: u8,
    pub bump: u8,
    pub flags: u8,
    pub launch: Pubkey,
    pub metadata_hash: [u8; 32],
    pub name: &'a str,
    pub symbol: &'a str,
    pub uri: &'a str,
    pub doc: &'a str,
}

impl<'a> TokenMetaRef<'a> {
    /// Decodes the fields after the discriminator (Anchor's
    /// `try_deserialize_unchecked`); `None` when they do not decode.
    pub fn read(data: &'a [u8]) -> Option<Self> {
        let mut r = Reader::new(data.get(8..)?);
        let [version, bump, flags] = *r.array::<3>()?;
        Some(Self {
            version,
            bump,
            flags,
            launch: r.address()?,
            metadata_hash: *r.array::<32>()?,
            name: r.str()?,
            symbol: r.str()?,
            uri: r.str()?,
            doc: r.str()?,
        })
    }
}

impl ProgramAccount for TokenMeta {
    const ACCOUNT_DISCRIMINATOR: [u8; 8] = discriminator::TOKEN_META;

    fn try_read(data: &[u8]) -> Option<Self> {
        let r = TokenMetaRef::read(data)?;
        Some(Self {
            version: r.version,
            bump: r.bump,
            flags: r.flags,
            launch: r.launch,
            metadata_hash: r.metadata_hash,
            name: r.name.into(),
            symbol: r.symbol.into(),
            uri: r.uri.into(),
            doc: r.doc.into(),
        })
    }
}

// ------------------------------------------------------------- LaunchRules

/// A launch's creator rules (PXR1, `noised_rules::rules`), on-chain
/// (`publish_rules`), at `["rules", launch, rules_hash]` where `rules_hash =
/// noised_rules::rules_hash(bytes)`: the address is the content. Verified
/// against the launch's guard when written; the space is exactly the
/// content (`LaunchRules::space`). Created whole by one instruction (anyone
/// may pay), never modified or closed. Only the record an attestation names
/// (`Attestation::rules_hash`, then `Certificate::rules_hash`) is the
/// launch's.
#[cfg_attr(not(target_os = "solana"), anchor_lang::account)]
#[cfg_attr(target_os = "solana", derive(Clone))]
#[derive(Debug, PartialEq, Eq)]
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

/// A `LaunchRules` read in place.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LaunchRulesRef<'a> {
    pub version: u8,
    pub bump: u8,
    pub launch: Pubkey,
    pub rules_hash: [u8; 32],
    pub bytes: &'a [u8],
}

impl<'a> LaunchRulesRef<'a> {
    /// Decodes the fields after the discriminator; `None` when they do not
    /// decode.
    pub fn read(data: &'a [u8]) -> Option<Self> {
        let mut r = Reader::new(data.get(8..)?);
        let [version, bump] = *r.array::<2>()?;
        Some(Self {
            version,
            bump,
            launch: r.address()?,
            rules_hash: *r.array::<32>()?,
            bytes: r.bytes()?,
        })
    }
}

impl ProgramAccount for LaunchRules {
    const ACCOUNT_DISCRIMINATOR: [u8; 8] = discriminator::LAUNCH_RULES;

    fn try_read(data: &[u8]) -> Option<Self> {
        let r = LaunchRulesRef::read(data)?;
        Some(Self {
            version: r.version,
            bump: r.bump,
            launch: r.launch,
            rules_hash: r.rules_hash,
            bytes: r.bytes.to_vec(),
        })
    }
}

// ----------------------------------------------------------- Authorization

/// A post-quantum authorization (`pq_authorize`, programmable launches §2,
/// amendment A1), at `["auth", launch, [kind], payload_hash]`: a valid LMS
/// signature by the launch's identity over `pq::authorization_message`,
/// kept in full so anyone can re-verify it from account state alone.
/// Written once, by the first such signature (the account a landing that
/// does not authorize creates stays empty: version 0); never modified or
/// closed. The launchpad gives `kind` no meaning; the autopilot reads kinds
/// 1 (GRAPH_ACTIVATE), 2 (GRAPH_FREEZE) and 3 (OPERATOR_REVOKE), by layout.
#[cfg_attr(not(target_os = "solana"), anchor_lang::account)]
#[cfg_attr(not(target_os = "solana"), derive(anchor_lang::InitSpace))]
#[cfg_attr(target_os = "solana", derive(Clone))]
#[derive(Debug, PartialEq, Eq)]
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
    #[cfg_attr(not(target_os = "solana"), max_len(LMS_SIG_LEN))]
    pub signature: Vec<u8>,
}

impl Authorization {
    pub const VERSION: u8 = 1;
    /// Bytes before the signature's bytes (its length prefix included).
    pub const FIXED_LEN: usize = 161;
    /// Account space: the fields with a 2,508-byte signature.
    pub const LEN: usize = Self::FIXED_LEN + LMS_SIG_LEN;

    pub fn read(d: &[u8]) -> Option<Self> {
        let fixed = d.first_chunk::<{ Self::FIXED_LEN }>()?;
        let len = u32_at(fixed, 157) as usize;
        let signature = d.get(Self::FIXED_LEN..)?.get(..len)?;
        Some(Self {
            version: fixed[8],
            bump: fixed[9],
            launch: key(fixed, 10),
            pq_identity: array(fixed, 42),
            kind: fixed[74],
            payload_hash: array(fixed, 75),
            message_hash: array(fixed, 107),
            unix_time: i64_at(fixed, 139),
            slot: u64_at(fixed, 147),
            leaf: u16_at(fixed, 155),
            signature: signature.to_vec(),
        })
    }

    /// Encodes discriminator and fields into `d`; `false` when they do not
    /// fit.
    pub fn write(&self, d: &mut [u8]) -> bool {
        write_with(
            d,
            &discriminator::AUTHORIZATION,
            &[
                &[self.version, self.bump],
                self.launch.as_ref(),
                &self.pq_identity,
                &[self.kind],
                &self.payload_hash,
                &self.message_hash,
                &self.unix_time.to_le_bytes(),
                &self.slot.to_le_bytes(),
                &self.leaf.to_le_bytes(),
                &(self.signature.len() as u32).to_le_bytes(),
                &self.signature,
            ],
        )
    }
}

impl ProgramAccount for Authorization {
    const ACCOUNT_DISCRIMINATOR: [u8; 8] = discriminator::AUTHORIZATION;

    fn try_read(data: &[u8]) -> Option<Self> {
        Self::read(data)
    }
}

// ------------------------------------------------------------- Certificate

/// Immutable launch certificate (SPEC §1.5). Written once, never modified.
#[cfg_attr(not(target_os = "solana"), anchor_lang::account)]
#[cfg_attr(not(target_os = "solana"), derive(anchor_lang::InitSpace))]
#[cfg_attr(target_os = "solana", derive(Clone))]
#[derive(Debug, PartialEq, Eq)]
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
    /// Account size: discriminator and fields.
    pub const LEN: usize = 519;

    pub fn read(d: &[u8; Self::LEN]) -> Option<Self> {
        Some(Self {
            version: d[8],
            bump: d[9],
            launch: key(d, 10),
            base_mint: key(d, 42),
            pool: key(d, 74),
            dbc_config: key(d, 106),
            creator: key(d, 138),
            launched_at: i64_at(d, 170),
            token_decimal: d[178],
            initial_supply: u64_at(d, 179),
            checks: u32_at(d, 187),
            migration_quote_threshold: u64_at(d, 191),
            migration_fee_option: d[199],
            snipe_shield_end_ts: i64_at(d, 200),
            execute_end_ts: i64_at(d, 208),
            guard_end_ts: i64_at(d, 216),
            max_wallet: u64_at(d, 224),
            max_buy: u64_at(d, 232),
            p2p_locked: bool_at(d, 240)?,
            platform_fee_bps: u16_at(d, 241),
            recipients: read_recipients(d, 243),
            params_hash: array(d, 379),
            policy_version: u16_at(d, 411),
            pq_identity: array(d, 413),
            pq_leaf: u16_at(d, 445),
            attested_slot: u64_at(d, 447),
            metadata: key(d, 455),
            rules_hash: array(d, 487),
        })
    }

    pub fn write(&self, d: &mut [u8; Self::LEN]) {
        d[..8].copy_from_slice(&discriminator::CERTIFICATE);
        d[8] = self.version;
        d[9] = self.bump;
        put(d, 10, self.launch.as_ref());
        put(d, 42, self.base_mint.as_ref());
        put(d, 74, self.pool.as_ref());
        put(d, 106, self.dbc_config.as_ref());
        put(d, 138, self.creator.as_ref());
        put(d, 170, &self.launched_at.to_le_bytes());
        d[178] = self.token_decimal;
        put(d, 179, &self.initial_supply.to_le_bytes());
        put(d, 187, &self.checks.to_le_bytes());
        put(d, 191, &self.migration_quote_threshold.to_le_bytes());
        d[199] = self.migration_fee_option;
        put(d, 200, &self.snipe_shield_end_ts.to_le_bytes());
        put(d, 208, &self.execute_end_ts.to_le_bytes());
        put(d, 216, &self.guard_end_ts.to_le_bytes());
        put(d, 224, &self.max_wallet.to_le_bytes());
        put(d, 232, &self.max_buy.to_le_bytes());
        d[240] = u8::from(self.p2p_locked);
        put(d, 241, &self.platform_fee_bps.to_le_bytes());
        write_recipients(d, 243, &self.recipients);
        put(d, 379, &self.params_hash);
        put(d, 411, &self.policy_version.to_le_bytes());
        put(d, 413, &self.pq_identity);
        put(d, 445, &self.pq_leaf.to_le_bytes());
        put(d, 447, &self.attested_slot.to_le_bytes());
        put(d, 455, self.metadata.as_ref());
        put(d, 487, &self.rules_hash);
    }
}

impl ProgramAccount for Certificate {
    const ACCOUNT_DISCRIMINATOR: [u8; 8] = discriminator::CERTIFICATE;

    fn try_read(data: &[u8]) -> Option<Self> {
        Self::read(data.first_chunk::<{ Self::LEN }>()?)
    }
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

// --------------------------------------------------------- parameter types

#[cfg_attr(
    not(target_os = "solana"),
    derive(AnchorSerialize, AnchorDeserialize, anchor_lang::InitSpace)
)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FeeRecipient {
    pub wallet: Pubkey,
    pub bps: u16,
}

impl FeeRecipient {
    /// Borsh size: wallet and bps.
    pub const LEN: usize = 34;
}

#[cfg_attr(not(target_os = "solana"), derive(AnchorSerialize, AnchorDeserialize))]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CurvePoint {
    pub sqrt_price: u128,
    pub liquidity: u128,
}

/// DBC base fee. Only fee-scheduler modes are accepted: 0 linear, 1 exponential.
/// `first_factor` = number of periods, `second_factor` = period length in
/// seconds, `third_factor` = reduction factor.
#[cfg_attr(not(target_os = "solana"), derive(AnchorSerialize, AnchorDeserialize))]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BaseFeeParams {
    pub cliff_fee_numerator: u64,
    pub first_factor: u16,
    pub second_factor: u64,
    pub third_factor: u64,
    pub base_fee_mode: u8,
}

#[cfg_attr(not(target_os = "solana"), derive(AnchorSerialize, AnchorDeserialize))]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
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
#[cfg_attr(not(target_os = "solana"), derive(AnchorSerialize, AnchorDeserialize))]
#[derive(Clone, Debug, PartialEq, Eq)]
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

impl LaunchParams {
    /// Borsh decoding (`AnchorDeserialize`) from the start of `r`'s data.
    pub fn read(r: &mut Reader) -> Option<Self> {
        // token_decimal, sqrt_start_price.
        let head = r.array::<17>()?;
        let curve_len = r.vec_len()?;
        let mut curve = Vec::new();
        for _ in 0..curve_len {
            let point = r.array::<32>()?;
            curve.push(CurvePoint {
                sqrt_price: u128::from_le_bytes(array(point, 0)),
                liquidity: u128::from_le_bytes(array(point, 16)),
            });
        }
        // migration_quote_threshold, base_fee.
        let fees = r.array::<35>()?;
        let dynamic_fee = r
            .option(|r| r.array::<32>().copied())?
            .map(|d| DynamicFeeParams {
                bin_step: u16_at(&d, 0),
                bin_step_u128: u128::from_le_bytes(array(&d, 2)),
                filter_period: u16_at(&d, 18),
                decay_period: u16_at(&d, 20),
                reduction_factor: u16_at(&d, 22),
                max_volatility_accumulator: u32_at(&d, 24),
                variable_fee_control: u32_at(&d, 28),
            });
        // migration_fee_option, open_delay_secs, guard_secs, max_wallet_bps,
        // max_buy_bps, p2p_locked, batch_wallet_cap, batch_total_cap.
        let rest = r.array::<30>()?;
        let p2p_locked = bool_at(rest, 13)?;
        let recipients_len = r.vec_len()?;
        let mut recipients = Vec::new();
        for _ in 0..recipients_len {
            let recipient = r.array::<34>()?;
            recipients.push(FeeRecipient {
                wallet: key(recipient, 0),
                bps: u16_at(recipient, 32),
            });
        }
        Some(Self {
            token_decimal: head[0],
            sqrt_start_price: u128::from_le_bytes(array(head, 1)),
            curve,
            migration_quote_threshold: u64_at(fees, 0),
            base_fee: BaseFeeParams {
                cliff_fee_numerator: u64_at(fees, 8),
                first_factor: u16_at(fees, 16),
                second_factor: u64_at(fees, 18),
                third_factor: u64_at(fees, 26),
                base_fee_mode: fees[34],
            },
            dynamic_fee,
            migration_fee_option: rest[0],
            open_delay_secs: u32_at(rest, 1),
            guard_secs: u32_at(rest, 5),
            max_wallet_bps: u16_at(rest, 9),
            max_buy_bps: u16_at(rest, 11),
            p2p_locked,
            batch_wallet_cap: u64_at(rest, 14),
            batch_total_cap: u64_at(rest, 22),
            recipients,
            pq_identity: *r.array::<32>()?,
        })
    }
}

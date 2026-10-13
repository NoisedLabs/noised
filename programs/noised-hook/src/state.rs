//! The policy account and the `create_policy` arguments: layouts, readers
//! and writers (the Anchor build's Borsh encoding, byte for byte).

#[cfg(any(not(target_os = "solana"), feature = "cpi"))]
use anchor_lang::{AnchorDeserialize, AnchorSerialize, Discriminator};
use noised_onchain::args::Reader;
use pinocchio::error::ProgramError;

use crate::{
    discriminator,
    error::{anchor, fail},
    Pubkey,
};

pub const POLICY_SEED: &[u8] = b"policy";
pub const META_LIST_SEED: &[u8] = b"extra-account-metas";
/// PDA of the launchpad program that alone may create policies and end
/// their snipe shield.
pub const HOOK_AUTHORITY_SEED: &[u8] = b"hook-authority";
/// Meteora DBC base-vault PDA prefix (`token_vault`, base_mint, pool).
pub const DBC_TOKEN_VAULT_SEED: &[u8] = b"token_vault";
pub const MAX_EXEMPT: usize = 4;
/// The largest PXR1 rule set (`noised_rules::rules::MAX_LEN`).
pub const MAX_RULES_LEN: usize = noised_rules::rules::MAX_LEN;

/// Per-mint launch policy. Written once by the launchpad; no instruction can
/// close it, and the only change any instruction can make is
/// `end_snipe_shield` moving `snipe_shield_end_ts` earlier once the batch has
/// bought. It stops mattering when DBC revokes the hook at curve completion.
/// Its space is exactly its content (`HookPolicy::space`).
///
/// Account data: the 8-byte discriminator `sha256("account:HookPolicy")[..8]`,
/// then the fields in Borsh, in this order ([`HookPolicy::FIXED_LEN`] bytes
/// through the rules' `u32` length, then the rule bytes). On-chain the
/// program reads it in place ([`PolicyHead`], [`PolicyView`]) and writes it
/// with [`write_policy`]; this owned type is the clients' (Anchor's
/// `AccountDeserialize` / `AccountSerialize` off-chain).
#[cfg_attr(any(not(target_os = "solana"), feature = "cpi"), anchor_lang::account)]
#[cfg_attr(
    any(not(target_os = "solana"), feature = "cpi"),
    derive(anchor_lang::InitSpace)
)]
#[cfg_attr(all(target_os = "solana", not(feature = "cpi")), derive(Clone))]
#[derive(Debug)]
pub struct HookPolicy {
    pub version: u8,
    pub bump: u8,
    pub mint: Pubkey,
    /// Meteora DBC pool of this launch.
    pub pool: Pubkey,
    /// DBC base vault: transfers into it (sells) are always allowed and
    /// transfers out of it are buys.
    pub base_vault: Pubkey,
    pub launch_ts: i64,
    /// Until this time nobody can buy from the pool except the batch. Written
    /// as the end of the launchpad's execution window; when the batch
    /// executes earlier, `end_snipe_shield` sets it to that moment.
    pub snipe_shield_end_ts: i64,
    /// From this time on every transfer is allowed.
    pub guard_end_ts: i64,
    /// Max balance of a receiving account during the guard (0 = off).
    pub max_wallet: u64,
    /// Max tokens received per transfer during the guard (0 = off).
    pub max_buy: u64,
    /// Pause wallet-to-wallet transfers during the guard.
    pub p2p_locked: bool,
    /// Owners whose transfers skip the rules (launchpad PDAs). Unused slots
    /// are `Pubkey::default()`, which never matches.
    pub exempt: [Pubkey; MAX_EXEMPT],
    /// The creator's launch rules (PXR1, `noised_rules::rules`), verified
    /// by `create_policy` against `guard_secs`; empty for none. They can
    /// only refuse, and are checked after every built-in allow and denial
    /// (`rules::evaluate`).
    #[cfg_attr(
        any(not(target_os = "solana"), feature = "cpi"),
        max_len(MAX_RULES_LEN)
    )]
    pub rules: alloc::vec::Vec<u8>,
}

/// Byte offsets of the policy's fields in the account data (the 8-byte
/// discriminator included): its Borsh layout.
pub mod layout {
    pub const VERSION: usize = 8;
    pub const BUMP: usize = 9;
    pub const MINT: usize = 10;
    pub const POOL: usize = 42;
    pub const BASE_VAULT: usize = 74;
    pub const LAUNCH_TS: usize = 106;
    pub const SNIPE_SHIELD_END_TS: usize = 114;
    pub const GUARD_END_TS: usize = 122;
    pub const MAX_WALLET: usize = 130;
    pub const MAX_BUY: usize = 138;
    pub const P2P_LOCKED: usize = 146;
    pub const EXEMPT: usize = 147;
    /// The rules' `u32` length.
    pub const RULES_LEN: usize = 275;
    /// The rule bytes.
    pub const RULES: usize = 279;
}

impl HookPolicy {
    /// Version 2: `rules`.
    pub const VERSION: u8 = 2;
    /// Bytes before the rule bytes: discriminator, the fixed fields and the
    /// rules' `u32` length (`8 + INIT_SPACE - MAX_RULES_LEN`).
    pub const FIXED_LEN: usize = layout::RULES;

    /// Account space of a policy with `rules_len` rule bytes: exactly its
    /// borsh encoding (`INIT_SPACE` counts the largest rule set).
    pub fn space(rules_len: usize) -> usize {
        Self::FIXED_LEN + rules_len
    }

    pub fn is_exempt(&self, owner: &Pubkey) -> bool {
        PolicyView::from(self).is_exempt(owner)
    }
}

/// `L` bytes of `data` at `at` (`at + L` within `N`: no check remains).
#[inline(always)]
fn array<const L: usize, const N: usize>(data: &[u8; N], at: usize) -> [u8; L] {
    let mut out = [0u8; L];
    out.copy_from_slice(&data[at..at + L]);
    out
}

#[inline(always)]
fn key<const N: usize>(data: &[u8; N], at: usize) -> Pubkey {
    Pubkey::new_from_array(array(data, at))
}

#[inline(always)]
fn i64_at<const N: usize>(data: &[u8; N], at: usize) -> i64 {
    i64::from_le_bytes(array(data, at))
}

#[inline(always)]
fn u64_at<const N: usize>(data: &[u8; N], at: usize) -> u64 {
    u64::from_le_bytes(array(data, at))
}

/// What `execute` reads of a policy before decoding the rest: enough to let
/// every sell and everything after the guard through (review 4, R3), so no
/// layout or version of the fields after `guard_end_ts` can ever block
/// them. Read at fixed offsets, which every version has in the same place
/// (version 1 had no `rules`; version 2 appends them).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PolicyHead {
    pub mint: Pubkey,
    pub base_vault: Pubkey,
    pub guard_end_ts: i64,
}

impl PolicyHead {
    /// Byte offsets of the fields, the 8-byte discriminator included.
    pub const MINT_OFFSET: usize = 10;
    pub const BASE_VAULT_OFFSET: usize = 74;
    pub const GUARD_END_TS_OFFSET: usize = 122;
    /// Bytes through `guard_end_ts`.
    pub const LEN: usize = 130;

    /// The head of a policy account's `data`: it must start with
    /// `HookPolicy`'s discriminator and hold at least `LEN` bytes (the same
    /// errors as Anchor's decoding, logged as the Anchor build logged them:
    /// no account named); nothing after `LEN` is read.
    pub fn read(data: &[u8]) -> Result<Self, ProgramError> {
        let Some(discriminator) = data.first_chunk::<8>() else {
            return Err(fail(anchor::ACCOUNT_DISCRIMINATOR_NOT_FOUND, None));
        };
        if *discriminator != discriminator::HOOK_POLICY {
            return Err(fail(anchor::ACCOUNT_DISCRIMINATOR_MISMATCH, None));
        }
        let Some(head) = data.first_chunk::<{ Self::LEN }>() else {
            return Err(fail(anchor::ACCOUNT_DID_NOT_DESERIALIZE, None));
        };
        Ok(Self {
            mint: key(head, Self::MINT_OFFSET),
            base_vault: key(head, Self::BASE_VAULT_OFFSET),
            guard_end_ts: i64_at(head, Self::GUARD_END_TS_OFFSET),
        })
    }
}

/// The fields of a policy the decision reads (`rules::built_ins`,
/// `rules::creator_rules`), borrowed from the account data on-chain
/// ([`PolicyView::read`]) or from a [`HookPolicy`] (`From`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PolicyView<'a> {
    pub base_vault: Pubkey,
    pub launch_ts: i64,
    pub snipe_shield_end_ts: i64,
    pub guard_end_ts: i64,
    pub max_wallet: u64,
    pub max_buy: u64,
    pub p2p_locked: bool,
    pub exempt: [Pubkey; MAX_EXEMPT],
    pub rules: &'a [u8],
}

impl<'a> PolicyView<'a> {
    /// `HookPolicy`'s Borsh decoding of a policy account's data (the
    /// discriminator is the caller's to check): `None` exactly when Anchor's
    /// `try_deserialize` fails after the discriminator
    /// (`AccountDidNotDeserialize`): fewer than [`HookPolicy::FIXED_LEN`]
    /// bytes, `p2p_locked` neither 0 nor 1, or fewer rule bytes than their
    /// length says. Bytes after the rules are ignored.
    #[inline]
    pub fn read(data: &'a [u8]) -> Option<Self> {
        let (fixed, rest) = data.split_first_chunk::<{ HookPolicy::FIXED_LEN }>()?;
        let p2p_locked = match fixed[layout::P2P_LOCKED] {
            0 => false,
            1 => true,
            _ => return None,
        };
        let rules_len = u32::from_le_bytes(array(fixed, layout::RULES_LEN));
        let rules = rest.get(..rules_len as usize)?;
        Some(Self {
            base_vault: key(fixed, layout::BASE_VAULT),
            launch_ts: i64_at(fixed, layout::LAUNCH_TS),
            snipe_shield_end_ts: i64_at(fixed, layout::SNIPE_SHIELD_END_TS),
            guard_end_ts: i64_at(fixed, layout::GUARD_END_TS),
            max_wallet: u64_at(fixed, layout::MAX_WALLET),
            max_buy: u64_at(fixed, layout::MAX_BUY),
            p2p_locked,
            exempt: [
                key(fixed, layout::EXEMPT),
                key(fixed, layout::EXEMPT + 32),
                key(fixed, layout::EXEMPT + 64),
                key(fixed, layout::EXEMPT + 96),
            ],
            rules,
        })
    }

    pub fn is_exempt(&self, owner: &Pubkey) -> bool {
        *owner != Pubkey::default() && self.exempt.iter().any(|e| e == owner)
    }
}

impl<'a> From<&'a HookPolicy> for PolicyView<'a> {
    fn from(p: &'a HookPolicy) -> Self {
        Self {
            base_vault: p.base_vault,
            launch_ts: p.launch_ts,
            snipe_shield_end_ts: p.snipe_shield_end_ts,
            guard_end_ts: p.guard_end_ts,
            max_wallet: p.max_wallet,
            max_buy: p.max_buy,
            p2p_locked: p.p2p_locked,
            exempt: p.exempt,
            rules: &p.rules,
        }
    }
}

/// What `end_snipe_shield` uses of its `Account<HookPolicy>`, read from the
/// account data at the policy's offsets once [`PolicyView::read`] has
/// accepted the whole layout.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PolicyKeys {
    pub bump: u8,
    pub mint: Pubkey,
    pub pool: Pubkey,
    pub snipe_shield_end_ts: i64,
}

impl PolicyKeys {
    /// The fields of a policy whose layout decodes (`Account<HookPolicy>`'s
    /// deserialization): `None` exactly when [`PolicyView::read`] is `None`.
    pub fn read(data: &[u8]) -> Option<Self> {
        let view = PolicyView::read(data)?;
        let fixed = data.first_chunk::<{ HookPolicy::FIXED_LEN }>()?;
        Some(Self {
            bump: fixed[layout::BUMP],
            mint: key(fixed, layout::MINT),
            pool: key(fixed, layout::POOL),
            snipe_shield_end_ts: view.snipe_shield_end_ts,
        })
    }
}

/// The fields `create_policy` writes.
pub struct NewPolicy<'a> {
    pub bump: u8,
    pub mint: &'a Pubkey,
    pub pool: &'a Pubkey,
    pub base_vault: &'a Pubkey,
    pub launch_ts: i64,
    pub snipe_shield_end_ts: i64,
    pub guard_end_ts: i64,
    pub max_wallet: u64,
    pub max_buy: u64,
    pub p2p_locked: bool,
    pub exempt: &'a [Pubkey; MAX_EXEMPT],
    pub rules: &'a [u8],
}

/// `HookPolicy::try_serialize` of a version-[`HookPolicy::VERSION`] policy
/// into `data`: the discriminator and every field, `None` when `data` is
/// shorter than [`HookPolicy::space`] (`AccountDidNotSerialize`). Bytes
/// after the rules are left as they are.
pub fn write_policy(data: &mut [u8], p: &NewPolicy) -> Option<()> {
    let (fixed, rest) = data.split_first_chunk_mut::<{ HookPolicy::FIXED_LEN }>()?;
    let rules = rest.get_mut(..p.rules.len())?;
    fixed[..8].copy_from_slice(&discriminator::HOOK_POLICY);
    fixed[layout::VERSION] = HookPolicy::VERSION;
    fixed[layout::BUMP] = p.bump;
    fixed[layout::MINT..layout::MINT + 32].copy_from_slice(p.mint.as_ref());
    fixed[layout::POOL..layout::POOL + 32].copy_from_slice(p.pool.as_ref());
    fixed[layout::BASE_VAULT..layout::BASE_VAULT + 32].copy_from_slice(p.base_vault.as_ref());
    fixed[layout::LAUNCH_TS..layout::LAUNCH_TS + 8].copy_from_slice(&p.launch_ts.to_le_bytes());
    fixed[layout::SNIPE_SHIELD_END_TS..layout::SNIPE_SHIELD_END_TS + 8]
        .copy_from_slice(&p.snipe_shield_end_ts.to_le_bytes());
    fixed[layout::GUARD_END_TS..layout::GUARD_END_TS + 8]
        .copy_from_slice(&p.guard_end_ts.to_le_bytes());
    fixed[layout::MAX_WALLET..layout::MAX_WALLET + 8].copy_from_slice(&p.max_wallet.to_le_bytes());
    fixed[layout::MAX_BUY..layout::MAX_BUY + 8].copy_from_slice(&p.max_buy.to_le_bytes());
    fixed[layout::P2P_LOCKED] = u8::from(p.p2p_locked);
    for (i, owner) in p.exempt.iter().enumerate() {
        let at = layout::EXEMPT + 32 * i;
        fixed[at..at + 32].copy_from_slice(owner.as_ref());
    }
    fixed[layout::RULES_LEN..layout::RULES].copy_from_slice(&(p.rules.len() as u32).to_le_bytes());
    rules.copy_from_slice(p.rules);
    Some(())
}

#[cfg_attr(
    any(not(target_os = "solana"), feature = "cpi"),
    derive(AnchorSerialize, AnchorDeserialize)
)]
#[derive(Clone, Debug)]
pub struct PolicyParams {
    pub pool: Pubkey,
    pub snipe_shield_secs: u32,
    pub guard_secs: u32,
    pub max_wallet: u64,
    pub max_buy: u64,
    pub p2p_locked: bool,
    pub exempt: [Pubkey; MAX_EXEMPT],
    /// PXR1 bytes (empty for none), stored as given once they verify.
    pub rules: alloc::vec::Vec<u8>,
}

/// `PolicyParams` read in place from the instruction data (Borsh; trailing
/// bytes ignored), the rules borrowed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PolicyParamsRef<'a> {
    pub pool: Pubkey,
    pub snipe_shield_secs: u32,
    pub guard_secs: u32,
    pub max_wallet: u64,
    pub max_buy: u64,
    pub p2p_locked: bool,
    pub exempt: [Pubkey; MAX_EXEMPT],
    pub rules: &'a [u8],
}

impl<'a> PolicyParamsRef<'a> {
    /// Borsh decoding of `create_policy(params: PolicyParams)`'s argument:
    /// `None` exactly when `PolicyParams::deserialize` fails
    /// (`InstructionDidNotDeserialize`).
    pub fn parse(data: &'a [u8]) -> Option<Self> {
        let mut r = Reader::new(data);
        Some(Self {
            pool: r.address()?,
            snipe_shield_secs: r.u32()?,
            guard_secs: r.u32()?,
            max_wallet: r.u64()?,
            max_buy: r.u64()?,
            p2p_locked: r.bool()?,
            exempt: [r.address()?, r.address()?, r.address()?, r.address()?],
            rules: r.bytes()?,
        })
    }
}

#[cfg(test)]
mod tests {
    use anchor_lang::{error::ErrorCode, AccountDeserialize, AccountSerialize};

    use super::*;

    fn key(b: u8) -> Pubkey {
        Pubkey::new_from_array([b; 32])
    }

    fn policy(rules: Vec<u8>) -> HookPolicy {
        HookPolicy {
            version: HookPolicy::VERSION,
            bump: 254,
            mint: key(1),
            pool: key(2),
            base_vault: key(3),
            launch_ts: 0x0101_0101,
            snipe_shield_end_ts: 0x0202_0202,
            guard_end_ts: 0x0102_0304_0506_0708,
            max_wallet: 5,
            max_buy: 6,
            p2p_locked: true,
            exempt: [key(9), key(10), Pubkey::default(), Pubkey::default()],
            rules,
        }
    }

    fn bytes(p: &HookPolicy) -> Vec<u8> {
        let mut data = Vec::new();
        p.try_serialize(&mut data).unwrap();
        data
    }

    fn head_of(p: &HookPolicy) -> PolicyHead {
        PolicyHead {
            mint: p.mint,
            base_vault: p.base_vault,
            guard_end_ts: p.guard_end_ts,
        }
    }

    /// Anchor's error, as the program returns it.
    fn anchor_error(e: ErrorCode) -> ProgramError {
        ProgramError::Custom(e.into())
    }

    /// The head's offsets are the policy's borsh layout: discriminator,
    /// version, bump, mint, pool, base vault, `launch_ts`,
    /// `snipe_shield_end_ts`, `guard_end_ts`; each field is read from its
    /// own bytes (little-endian for the time).
    #[test]
    fn the_head_is_read_at_the_policys_offsets() {
        assert_eq!(PolicyHead::MINT_OFFSET, 8 + 1 + 1);
        assert_eq!(PolicyHead::BASE_VAULT_OFFSET, 8 + 2 + 32 + 32);
        assert_eq!(PolicyHead::GUARD_END_TS_OFFSET, 8 + 2 + 3 * 32 + 8 + 8);
        assert_eq!(PolicyHead::LEN, PolicyHead::GUARD_END_TS_OFFSET + 8);
        let p = policy(vec![7; 20]);
        let data = bytes(&p);
        assert_eq!(PolicyHead::read(&data).unwrap(), head_of(&p));
        for (at, len) in [
            (PolicyHead::MINT_OFFSET, 32),
            (PolicyHead::BASE_VAULT_OFFSET, 32),
            (PolicyHead::GUARD_END_TS_OFFSET, 8),
        ] {
            for i in at..at + len {
                let mut flipped = data.clone();
                flipped[i] ^= 0x80;
                let head = PolicyHead::read(&flipped).unwrap();
                let mut want = p.clone();
                match at {
                    PolicyHead::MINT_OFFSET => {
                        want.mint = Pubkey::try_from(&flipped[at..at + 32]).unwrap()
                    }
                    PolicyHead::BASE_VAULT_OFFSET => {
                        want.base_vault = Pubkey::try_from(&flipped[at..at + 32]).unwrap()
                    }
                    _ => {
                        want.guard_end_ts =
                            i64::from_le_bytes(flipped[at..at + 8].try_into().unwrap())
                    }
                }
                assert_eq!(head, head_of(&want), "byte {i}");
                assert_ne!(head, head_of(&p), "byte {i}");
            }
        }
        // The other fields of the head's bytes are not read.
        for i in (8..PolicyHead::LEN).filter(|i| {
            !(PolicyHead::MINT_OFFSET..PolicyHead::MINT_OFFSET + 32).contains(i)
                && !(PolicyHead::BASE_VAULT_OFFSET..PolicyHead::BASE_VAULT_OFFSET + 32).contains(i)
                && !(PolicyHead::GUARD_END_TS_OFFSET..PolicyHead::LEN).contains(i)
        }) {
            let mut other = data.clone();
            other[i] ^= 0xFF;
            assert_eq!(PolicyHead::read(&other).unwrap(), head_of(&p), "byte {i}");
        }
    }

    /// Review 4, R4-4 (the reviewer's PoC, with what changes): a version-1
    /// policy (no `rules` length, 275 bytes) still does not decode as a
    /// version-2 `HookPolicy`, but its head reads exactly as version 2's
    /// does, so `execute` decides its sells and everything after its guard
    /// without decoding it. So does any account from the head's length on,
    /// whatever follows the head.
    #[test]
    fn a_version_1_or_any_longer_policy_has_the_same_head() {
        let p = policy(vec![]);
        let v2 = bytes(&p);
        let v1 = &v2[..v2.len() - 4];
        assert_eq!(v1.len(), 8 + 2 + 3 * 32 + 5 * 8 + 1 + 4 * 32);
        assert_eq!(v1.len(), 275);
        assert!(HookPolicy::try_deserialize(&mut &v2[..]).is_ok());
        assert!(HookPolicy::try_deserialize(&mut &v1[..]).is_err());
        assert!(PolicyView::read(&v2).is_some());
        assert!(PolicyView::read(v1).is_none());
        assert_eq!(PolicyHead::read(v1).unwrap(), head_of(&p));
        let mut r = 0x9E37_79B9_7F4A_7C15u64;
        for len in PolicyHead::LEN..v2.len() + 64 {
            let mut data: Vec<u8> = (0..len)
                .map(|_| {
                    r = r.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
                    (r >> 56) as u8
                })
                .collect();
            data[..PolicyHead::LEN].copy_from_slice(&v2[..PolicyHead::LEN]);
            assert_eq!(PolicyHead::read(&data).unwrap(), head_of(&p), "{len} bytes");
        }
    }

    /// Fails closed, with Anchor's errors, on what is not a policy's head:
    /// no discriminator, another discriminator, fewer bytes than the head.
    #[test]
    fn the_head_needs_the_discriminator_and_its_length() {
        let data = bytes(&policy(vec![]));
        let err = |d: &[u8]| PolicyHead::read(d).unwrap_err();
        for n in 0..8 {
            assert_eq!(
                err(&data[..n]),
                anchor_error(ErrorCode::AccountDiscriminatorNotFound),
                "{n}"
            );
        }
        for n in 8..PolicyHead::LEN {
            assert_eq!(
                err(&data[..n]),
                anchor_error(ErrorCode::AccountDidNotDeserialize),
                "{n}"
            );
        }
        for i in 0..8 {
            let mut other = data.clone();
            other[i] ^= 1;
            assert_eq!(
                err(&other),
                anchor_error(ErrorCode::AccountDiscriminatorMismatch)
            );
        }
        assert!(PolicyHead::read(&data[..PolicyHead::LEN]).is_ok());
        // Logged as the Anchor build logged them (no account named).
        let _ = noised_onchain::sys::take_logs();
        let _ = err(&data[..3]);
        assert_eq!(
            noised_onchain::host::take_log_lines(),
            vec!["Program log: AnchorError occurred. Error Code: AccountDiscriminatorNotFound. Error Number: 3001. Error Message: No discriminator was found on the account.".to_string()]
        );
    }
}

use anchor_lang::prelude::*;

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
#[account]
#[derive(InitSpace, Debug)]
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
    #[max_len(MAX_RULES_LEN)]
    pub rules: Vec<u8>,
}

impl HookPolicy {
    /// Version 2: `rules`.
    pub const VERSION: u8 = 2;

    /// Account space of a policy with `rules_len` rule bytes: exactly its
    /// borsh encoding (`INIT_SPACE` counts the largest rule set).
    pub fn space(rules_len: usize) -> usize {
        8 + Self::INIT_SPACE - MAX_RULES_LEN + rules_len
    }

    pub fn is_exempt(&self, owner: &Pubkey) -> bool {
        *owner != Pubkey::default() && self.exempt.iter().any(|e| e == owner)
    }
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
    /// errors as Anchor's decoding); nothing after `LEN` is read.
    pub fn read(data: &[u8]) -> Result<Self> {
        let discriminator = data
            .get(..8)
            .ok_or(ErrorCode::AccountDiscriminatorNotFound)?;
        require!(
            discriminator == HookPolicy::DISCRIMINATOR,
            ErrorCode::AccountDiscriminatorMismatch
        );
        let head = data
            .get(..Self::LEN)
            .ok_or(ErrorCode::AccountDidNotDeserialize)?;
        let field = |at: usize, len: usize| &head[at..at + len];
        Ok(Self {
            mint: Pubkey::try_from(field(Self::MINT_OFFSET, 32))
                .map_err(|_| ErrorCode::AccountDidNotDeserialize)?,
            base_vault: Pubkey::try_from(field(Self::BASE_VAULT_OFFSET, 32))
                .map_err(|_| ErrorCode::AccountDidNotDeserialize)?,
            guard_end_ts: i64::from_le_bytes(
                field(Self::GUARD_END_TS_OFFSET, 8)
                    .try_into()
                    .map_err(|_| ErrorCode::AccountDidNotDeserialize)?,
            ),
        })
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct PolicyParams {
    pub pool: Pubkey,
    pub snipe_shield_secs: u32,
    pub guard_secs: u32,
    pub max_wallet: u64,
    pub max_buy: u64,
    pub p2p_locked: bool,
    pub exempt: [Pubkey; MAX_EXEMPT],
    /// PXR1 bytes (empty for none), stored as given once they verify.
    pub rules: Vec<u8>,
}

#[cfg(test)]
mod tests {
    use anchor_lang::{AccountDeserialize, AccountSerialize};

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
                ErrorCode::AccountDiscriminatorNotFound.into(),
                "{n}"
            );
        }
        for n in 8..PolicyHead::LEN {
            assert_eq!(
                err(&data[..n]),
                ErrorCode::AccountDidNotDeserialize.into(),
                "{n}"
            );
        }
        for i in 0..8 {
            let mut other = data.clone();
            other[i] ^= 1;
            assert_eq!(err(&other), ErrorCode::AccountDiscriminatorMismatch.into());
        }
        assert!(PolicyHead::read(&data[..PolicyHead::LEN]).is_ok());
    }
}

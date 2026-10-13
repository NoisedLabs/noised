#[cfg(not(target_os = "solana"))]
use anchor_lang::{AnchorDeserialize, AnchorSerialize, Discriminator};
use noised_lmots::{PublicKey, Sha256, ID_LEN, N};
use noised_onchain::accounts::ProgramAccount;

use crate::{discriminator, Pubkey};

pub const VAULT_SEED: &[u8] = b"vault";
pub const PAYOUT_SEED: &[u8] = b"payout";

/// SHA-256 through the `sol_sha256` syscall (host builds use the same API).
pub struct SolSha256;

impl Sha256 for SolSha256 {
    fn hashv(parts: &[&[u8]]) -> [u8; 32] {
        noised_onchain::hashv(parts)
    }
}

pub fn key_id(pk: &PublicKey) -> [u8; 32] {
    noised_lmots::key_id::<SolSha256>(pk)
}

/// LM-OTS leaf index `q` of the key that opens a vault.
pub const GENESIS_KEY_INDEX: u32 = 0;

/// The LM-OTS leaf index `q` of the key that the withdrawal at `sequence`
/// installs: `sequence + 1`. Every key of a vault is bound to its position
/// (the genesis key has `q = 0`, the key at sequence `s` has `q = s`), and
/// `q` is hashed into the key id and into every LM-OTS hash, so no key can
/// ever control a vault twice: a spent key cannot be reinstalled.
///
/// `None` once `sequence + 1` does not fit a `u32`: a vault supports at most
/// `u32::MAX` (4,294,967,295) withdrawals. At sequence `u32::MAX` no
/// withdrawal can execute (payouts already reserved can still be released),
/// so clients refuse to sign there.
pub fn next_key_index(sequence: u64) -> Option<u32> {
    sequence
        .checked_add(1)
        .and_then(|next| u32::try_from(next).ok())
}

/// LM-OTS public key as passed in instructions (Borsh: `id`, `q` as `u32`
/// little-endian, `k`; 52 bytes).
#[cfg_attr(not(target_os = "solana"), derive(AnchorSerialize, AnchorDeserialize))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VaultKey {
    /// LM-OTS key identifier `I`.
    pub id: [u8; ID_LEN],
    /// LM-OTS leaf index `q`.
    pub q: u32,
    /// LM-OTS public key hash `K`.
    pub k: [u8; N],
}

impl VaultKey {
    pub const LEN: usize = ID_LEN + 4 + N;

    pub fn public_key(&self) -> PublicKey {
        PublicKey {
            id: self.id,
            q: self.q,
            k: self.k,
        }
    }

    /// Borsh decoding from the first [`VaultKey::LEN`] bytes of `data`.
    pub fn read(data: &[u8; Self::LEN]) -> Self {
        let mut id = [0u8; ID_LEN];
        id.copy_from_slice(&data[..ID_LEN]);
        let mut q = [0u8; 4];
        q.copy_from_slice(&data[ID_LEN..ID_LEN + 4]);
        let mut k = [0u8; N];
        k.copy_from_slice(&data[ID_LEN + 4..]);
        Self {
            id,
            q: u32::from_le_bytes(q),
            k,
        }
    }
}

/// A vault: one mint, one current LM-OTS key. The address, the token account
/// and the balance stay put for the vault's lifetime; every withdrawal
/// replaces the key and increments `sequence`. Never closed.
///
/// Account data: the 8-byte discriminator `sha256("account:Vault")[..8]`,
/// then the fields in Borsh, in this order ([`Vault::LEN`] = 174 bytes).
#[cfg_attr(not(target_os = "solana"), anchor_lang::account)]
#[cfg_attr(not(target_os = "solana"), derive(anchor_lang::InitSpace))]
#[cfg_attr(target_os = "solana", derive(Clone))]
#[derive(Debug, PartialEq, Eq)]
pub struct Vault {
    pub version: u8,
    pub bump: u8,
    pub mint: Pubkey,
    /// key_id of the first key: the PDA seed, so a vault address commits to
    /// the key that opened it.
    pub genesis_key_id: [u8; 32],
    /// Withdrawals executed so far; signed into every withdrawal message.
    pub sequence: u64,
    /// SHA-256 commitment to the current public key.
    pub key_id: [u8; 32],
    pub key_ident: [u8; ID_LEN],
    /// The current key's LM-OTS leaf index: always equal to `sequence`
    /// (`open_vault` requires 0, every withdrawal installs `sequence + 1`).
    pub key_q: u32,
    pub key_k: [u8; N],
    /// Tokens held for payouts that have not been released yet.
    pub reserved: u64,
}

/// `L` bytes of `data` at `at`.
fn array<const L: usize>(data: &[u8], at: usize) -> [u8; L] {
    let mut out = [0u8; L];
    out.copy_from_slice(&data[at..at + L]);
    out
}

impl Vault {
    pub const VERSION: u8 = 4;
    /// Account size: discriminator and fields.
    pub const LEN: usize = 8 + 1 + 1 + 32 + 32 + 8 + 32 + ID_LEN + 4 + N + 8;

    pub fn init(&mut self, bump: u8, mint: Pubkey, key_id: [u8; 32], key: &VaultKey) {
        self.version = Self::VERSION;
        self.bump = bump;
        self.mint = mint;
        self.genesis_key_id = key_id;
        self.sequence = 0;
        self.set_key(key_id, key);
        self.reserved = 0;
    }

    pub fn set_key(&mut self, key_id: [u8; 32], key: &VaultKey) {
        self.key_id = key_id;
        self.key_ident = key.id;
        self.key_q = key.q;
        self.key_k = key.k;
    }

    pub fn public_key(&self) -> PublicKey {
        PublicKey {
            id: self.key_ident,
            q: self.key_q,
            k: self.key_k,
        }
    }

    /// Decodes the fields from the first [`Vault::LEN`] bytes of account
    /// data (the discriminator is the caller's to check; bytes after them
    /// are ignored, as Borsh deserialization from a slice ignores them).
    pub fn read(data: &[u8; Self::LEN]) -> Self {
        Self {
            version: data[8],
            bump: data[9],
            mint: Pubkey::new_from_array(array(data, 10)),
            genesis_key_id: array(data, 42),
            sequence: u64::from_le_bytes(array(data, 74)),
            key_id: array(data, 82),
            key_ident: array(data, 114),
            key_q: u32::from_le_bytes(array(data, 130)),
            key_k: array(data, 134),
            reserved: u64::from_le_bytes(array(data, 166)),
        }
    }

    /// Encodes discriminator and fields (the first [`Vault::LEN`] bytes of
    /// account data).
    pub fn write(&self, data: &mut [u8; Self::LEN]) {
        data[..8].copy_from_slice(&discriminator::VAULT);
        data[8] = self.version;
        data[9] = self.bump;
        data[10..42].copy_from_slice(self.mint.as_ref());
        data[42..74].copy_from_slice(&self.genesis_key_id);
        data[74..82].copy_from_slice(&self.sequence.to_le_bytes());
        data[82..114].copy_from_slice(&self.key_id);
        data[114..130].copy_from_slice(&self.key_ident);
        data[130..134].copy_from_slice(&self.key_q.to_le_bytes());
        data[134..166].copy_from_slice(&self.key_k);
        data[166..174].copy_from_slice(&self.reserved.to_le_bytes());
    }
}

impl ProgramAccount for Vault {
    const ACCOUNT_DISCRIMINATOR: [u8; 8] = discriminator::VAULT;

    fn try_read(data: &[u8]) -> Option<Self> {
        data.first_chunk::<{ Self::LEN }>().map(Self::read)
    }
}

/// Tokens a withdrawal set aside for its recipient. They stay in the vault's
/// token account, counted in `Vault::reserved`, until `release` or
/// `release_to` delivers them; then this account closes.
///
/// Account data: the 8-byte discriminator `sha256("account:Payout")[..8]`,
/// then the fields in Borsh, in this order ([`Payout::LEN`] = 122 bytes).
#[cfg_attr(not(target_os = "solana"), anchor_lang::account)]
#[cfg_attr(not(target_os = "solana"), derive(anchor_lang::InitSpace))]
#[cfg_attr(target_os = "solana", derive(Clone))]
#[derive(Debug, PartialEq, Eq)]
pub struct Payout {
    pub version: u8,
    pub bump: u8,
    pub vault: Pubkey,
    /// The withdrawal's sequence number (PDA seed).
    pub sequence: u64,
    /// The wallet the signed message names.
    pub destination_owner: Pubkey,
    pub amount: u64,
    /// Paid the rent; receives it back when the payout closes.
    pub rent_payer: Pubkey,
}

impl Payout {
    pub const VERSION: u8 = 1;
    /// Account size: discriminator and fields.
    pub const LEN: usize = 8 + 1 + 1 + 32 + 8 + 32 + 8 + 32;

    /// Decodes the fields from the first [`Payout::LEN`] bytes of account
    /// data (the discriminator is the caller's to check).
    pub fn read(data: &[u8; Self::LEN]) -> Self {
        Self {
            version: data[8],
            bump: data[9],
            vault: Pubkey::new_from_array(array(data, 10)),
            sequence: u64::from_le_bytes(array(data, 42)),
            destination_owner: Pubkey::new_from_array(array(data, 50)),
            amount: u64::from_le_bytes(array(data, 82)),
            rent_payer: Pubkey::new_from_array(array(data, 90)),
        }
    }

    /// Encodes discriminator and fields (the first [`Payout::LEN`] bytes of
    /// account data).
    pub fn write(&self, data: &mut [u8; Self::LEN]) {
        data[..8].copy_from_slice(&discriminator::PAYOUT);
        data[8] = self.version;
        data[9] = self.bump;
        data[10..42].copy_from_slice(self.vault.as_ref());
        data[42..50].copy_from_slice(&self.sequence.to_le_bytes());
        data[50..82].copy_from_slice(self.destination_owner.as_ref());
        data[82..90].copy_from_slice(&self.amount.to_le_bytes());
        data[90..122].copy_from_slice(self.rent_payer.as_ref());
    }
}

impl ProgramAccount for Payout {
    const ACCOUNT_DISCRIMINATOR: [u8; 8] = discriminator::PAYOUT;

    fn try_read(data: &[u8]) -> Option<Self> {
        data.first_chunk::<{ Self::LEN }>().map(Self::read)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic pseudo-random stream for property checks.
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            self.0 >> 11
        }
    }

    #[test]
    fn key_indices_follow_the_sequence_up_to_u32_max() {
        assert_eq!(GENESIS_KEY_INDEX, 0);
        assert_eq!(next_key_index(0), Some(1));
        assert_eq!(next_key_index(41), Some(42));
        let last = u64::from(u32::MAX);
        assert_eq!(
            next_key_index(last - 1),
            Some(u32::MAX),
            "the u32::MAX-th withdrawal"
        );
        assert_eq!(next_key_index(last), None, "no withdrawal after that");
        assert_eq!(next_key_index(last + 1), None);
        assert_eq!(next_key_index(u64::MAX), None, "never wraps to 0");
        let mut r = Lcg(23);
        for _ in 0..100_000 {
            let sequence = r.next() % (last + 2);
            let want = (sequence < last).then(|| sequence as u32 + 1);
            assert_eq!(next_key_index(sequence), want, "{sequence}");
            // Never an index the vault already used (0..=sequence).
            if let Some(q) = next_key_index(sequence) {
                assert!(u64::from(q) > sequence);
            }
        }
    }

    /// Walks a vault's key chain as `open_vault` and `withdraw` enforce it:
    /// the one index `withdraw` accepts is never one the vault has used, so
    /// no key, spent or current, is ever installed again. Near the end the
    /// chain stops at `u32::MAX` instead of wrapping to a used index.
    #[test]
    fn a_used_key_index_is_never_accepted_again() {
        let mut used = std::collections::BTreeSet::from([GENESIS_KEY_INDEX]);
        for sequence in 0..10_000u64 {
            let q = next_key_index(sequence).expect("far from u32::MAX");
            assert!(used.insert(q), "index {q} accepted twice");
            assert_eq!(used.len() as u64, sequence + 2);
        }
        let mut current = u32::MAX - 3;
        for sequence in u64::from(current).. {
            match next_key_index(sequence) {
                Some(q) => {
                    assert!(q > current);
                    current = q;
                }
                None => {
                    assert_eq!((sequence, current), (u64::from(u32::MAX), u32::MAX));
                    break;
                }
            }
        }
    }

    /// `q` is hashed into the key id: the same `I` and `K` at another index
    /// is another key, so binding `q` to the position binds the key.
    #[test]
    fn the_key_id_commits_to_the_index() {
        let pk = |q: u32| PublicKey {
            id: [0x22; ID_LEN],
            q,
            k: [0x33; N],
        };
        let ids: Vec<[u8; 32]> = [0, 1, 2, u32::MAX]
            .iter()
            .map(|&q| key_id(&pk(q)))
            .collect();
        for (i, a) in ids.iter().enumerate() {
            for b in &ids[i + 1..] {
                assert_ne!(a, b);
            }
        }
        let vk = VaultKey {
            id: [0x22; ID_LEN],
            q: 7,
            k: [0x33; N],
        };
        assert_eq!(key_id(&vk.public_key()), key_id(&pk(7)));
    }

    /// `init` and `set_key` keep the current key's index next to the
    /// sequence it signs at (the invariant `key_q == sequence`).
    #[test]
    fn the_stored_index_tracks_the_sequence() {
        let key = |q: u32| VaultKey {
            id: [q as u8; ID_LEN],
            q,
            k: [0x44; N],
        };
        let mut vault = Vault {
            version: 0,
            bump: 0,
            mint: Pubkey::default(),
            genesis_key_id: [0; 32],
            sequence: 0,
            key_id: [0; 32],
            key_ident: [0; ID_LEN],
            key_q: 0,
            key_k: [0; N],
            reserved: 0,
        };
        let genesis = key(GENESIS_KEY_INDEX);
        vault.init(254, Pubkey::new_from_array([5; 32]), [1; 32], &genesis);
        assert_eq!((vault.sequence, vault.key_q), (0, 0));
        assert_eq!(vault.public_key().q, GENESIS_KEY_INDEX);
        for _ in 0..5 {
            let q = next_key_index(vault.sequence).unwrap();
            vault.sequence += 1;
            vault.set_key([q as u8; 32], &key(q));
            assert_eq!(u64::from(vault.key_q), vault.sequence);
            assert_eq!(vault.public_key(), key(q).public_key());
        }
    }
}

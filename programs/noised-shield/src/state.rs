#[cfg(not(target_os = "solana"))]
use anchor_lang::{AnchorDeserialize, AnchorSerialize, Discriminator};
use noised_onchain::accounts::ProgramAccount;

use crate::{discriminator, Pubkey};

pub const SHIELD_SEED: &[u8] = b"shield";
/// Mint authority of the zToken and owner of the escrow. Only this program
/// can sign for it, and it only signs inside `wrap` (mint) and `unwrap`
/// (escrow release), each bound 1:1 to a measured escrow balance change.
pub const SHIELD_AUTHORITY_SEED: &[u8] = b"shield-authority";
pub const Z_MINT_SEED: &[u8] = b"z-mint";

/// One shield per base mint. Written once by `create_shield`; no instruction
/// modifies or closes it.
///
/// Account data: the 8-byte discriminator `sha256("account:Shield")[..8]`,
/// then the fields in Borsh, in this order ([`Shield::LEN`] = 149 bytes).
#[cfg_attr(not(target_os = "solana"), anchor_lang::account)]
#[cfg_attr(not(target_os = "solana"), derive(anchor_lang::InitSpace))]
#[cfg_attr(target_os = "solana", derive(Clone))]
#[derive(Debug, PartialEq, Eq)]
pub struct Shield {
    pub version: u8,
    pub bump: u8,
    pub authority_bump: u8,
    pub z_mint_bump: u8,
    /// Decimals of both the base mint and the zToken.
    pub decimals: u8,
    pub base_mint: Pubkey,
    /// SPL Token or Token-2022: the program that owns `base_mint`.
    pub base_token_program: Pubkey,
    /// Token-2022 zToken mint (PDA `["z-mint", base_mint]`).
    pub z_mint: Pubkey,
    /// ATA(shield authority, base_mint, base_token_program).
    pub escrow: Pubkey,
    pub created_at: i64,
}

/// `L` bytes of `data` at `at`.
fn array<const L: usize>(data: &[u8], at: usize) -> [u8; L] {
    let mut out = [0u8; L];
    out.copy_from_slice(&data[at..at + L]);
    out
}

impl Shield {
    pub const VERSION: u8 = 1;
    /// Account size: discriminator and fields.
    pub const LEN: usize = 8 + 1 + 1 + 1 + 1 + 1 + 32 + 32 + 32 + 32 + 8;

    /// Decodes the fields from the first [`Shield::LEN`] bytes of account
    /// data (the discriminator is the caller's to check; bytes after them
    /// are ignored, as Borsh deserialization from a slice ignores them).
    pub fn read(data: &[u8; Self::LEN]) -> Self {
        Self {
            version: data[8],
            bump: data[9],
            authority_bump: data[10],
            z_mint_bump: data[11],
            decimals: data[12],
            base_mint: Pubkey::new_from_array(array(data, 13)),
            base_token_program: Pubkey::new_from_array(array(data, 45)),
            z_mint: Pubkey::new_from_array(array(data, 77)),
            escrow: Pubkey::new_from_array(array(data, 109)),
            created_at: i64::from_le_bytes(array(data, 141)),
        }
    }

    /// Encodes discriminator and fields (the first [`Shield::LEN`] bytes of
    /// account data).
    pub fn write(&self, data: &mut [u8; Self::LEN]) {
        data[..8].copy_from_slice(&discriminator::SHIELD);
        data[8] = self.version;
        data[9] = self.bump;
        data[10] = self.authority_bump;
        data[11] = self.z_mint_bump;
        data[12] = self.decimals;
        data[13..45].copy_from_slice(self.base_mint.as_ref());
        data[45..77].copy_from_slice(self.base_token_program.as_ref());
        data[77..109].copy_from_slice(self.z_mint.as_ref());
        data[109..141].copy_from_slice(self.escrow.as_ref());
        data[141..149].copy_from_slice(&self.created_at.to_le_bytes());
    }
}

impl ProgramAccount for Shield {
    const ACCOUNT_DISCRIMINATOR: [u8; 8] = discriminator::SHIELD;

    fn try_read(data: &[u8]) -> Option<Self> {
        data.first_chunk::<{ Self::LEN }>().map(Self::read)
    }
}

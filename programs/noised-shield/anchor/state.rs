use anchor_lang::prelude::*;

pub const SHIELD_SEED: &[u8] = b"shield";
/// Mint authority of the zToken and owner of the escrow. Only this program
/// can sign for it, and it only signs inside `wrap` (mint) and `unwrap`
/// (escrow release), each bound 1:1 to a measured escrow balance change.
pub const SHIELD_AUTHORITY_SEED: &[u8] = b"shield-authority";
pub const Z_MINT_SEED: &[u8] = b"z-mint";

/// One shield per base mint. Written once by `create_shield`; no instruction
/// modifies or closes it.
#[account]
#[derive(InitSpace, Debug)]
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

impl Shield {
    pub const VERSION: u8 = 1;
}

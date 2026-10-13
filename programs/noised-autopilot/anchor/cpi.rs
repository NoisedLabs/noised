//! The only cross-program calls the treasury authority ever signs, each to a
//! program id fixed here (never one taken from an account): a DAMM v2 swap
//! of treasury wSOL into the token (never the other way), a Token-2022 burn
//! of treasury tokens, and SPL Token transfers of treasury wSOL. There is no
//! close, approve, set-authority or arbitrary invoke.

use anchor_lang::{
    prelude::*,
    solana_program::{
        instruction::{AccountMeta, Instruction},
        program::invoke_signed,
    },
};
use anchor_spl::{token, token_2022, token_interface::spl_token_2022};

use crate::{
    constants::{DAMM_V2_PROGRAM_ID, WSOL_DECIMALS},
    external::DAMM_SWAP_DISCRIMINATOR,
};

/// SPL Token `transfer_checked` of `amount` wSOL from a treasury account.
pub fn transfer_wsol<'info>(
    token_program: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    wsol_mint: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    amount: u64,
    seeds: &[&[u8]],
) -> Result<()> {
    let ix = spl_token_2022::instruction::transfer_checked(
        &token::ID,
        from.key,
        wsol_mint.key,
        to.key,
        authority.key,
        &[],
        amount,
        WSOL_DECIMALS,
    )?;
    invoke_signed(
        &ix,
        &[
            from.clone(),
            wsol_mint.clone(),
            to.clone(),
            authority.clone(),
            token_program.clone(),
        ],
        &[seeds],
    )?;
    Ok(())
}

/// Token-2022 `burn_checked` of `amount` tokens from a treasury account.
pub fn burn<'info>(
    token_2022_program: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    amount: u64,
    decimals: u8,
    seeds: &[&[u8]],
) -> Result<()> {
    let ix = spl_token_2022::instruction::burn_checked(
        &token_2022::ID,
        from.key,
        mint.key,
        authority.key,
        &[],
        amount,
        decimals,
    )?;
    invoke_signed(
        &ix,
        &[
            from.clone(),
            mint.clone(),
            authority.clone(),
            token_2022_program.clone(),
        ],
        &[seeds],
    )?;
    Ok(())
}

/// The accounts of a DAMM v2 `swap` buying the token (A) with wSOL (B).
pub struct DammSwap<'a, 'info> {
    pub pool_authority: &'a AccountInfo<'info>,
    pub pool: &'a AccountInfo<'info>,
    /// The treasury's wSOL account.
    pub input: &'a AccountInfo<'info>,
    /// The treasury's token account.
    pub output: &'a AccountInfo<'info>,
    pub token_a_vault: &'a AccountInfo<'info>,
    pub token_b_vault: &'a AccountInfo<'info>,
    pub token_a_mint: &'a AccountInfo<'info>,
    pub token_b_mint: &'a AccountInfo<'info>,
    /// The treasury authority (signs).
    pub payer: &'a AccountInfo<'info>,
    pub token_a_program: &'a AccountInfo<'info>,
    pub token_b_program: &'a AccountInfo<'info>,
    pub event_authority: &'a AccountInfo<'info>,
    pub program: &'a AccountInfo<'info>,
}

/// DAMM v2 `swap` (exact in, no referral): `amount_in` of the input account
/// for at least `min_out` into the output account.
pub fn damm_swap(
    a: &DammSwap<'_, '_>,
    amount_in: u64,
    min_out: u64,
    seeds: &[&[u8]],
) -> Result<()> {
    let mut data = Vec::with_capacity(24);
    data.extend_from_slice(&DAMM_SWAP_DISCRIMINATOR);
    data.extend_from_slice(&amount_in.to_le_bytes());
    data.extend_from_slice(&min_out.to_le_bytes());
    let ix = Instruction {
        program_id: DAMM_V2_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(*a.pool_authority.key, false),
            AccountMeta::new(*a.pool.key, false),
            AccountMeta::new(*a.input.key, false),
            AccountMeta::new(*a.output.key, false),
            AccountMeta::new(*a.token_a_vault.key, false),
            AccountMeta::new(*a.token_b_vault.key, false),
            AccountMeta::new_readonly(*a.token_a_mint.key, false),
            AccountMeta::new_readonly(*a.token_b_mint.key, false),
            AccountMeta::new_readonly(*a.payer.key, true),
            AccountMeta::new_readonly(token_2022::ID, false),
            AccountMeta::new_readonly(token::ID, false),
            // No referral account (Anchor's `None`: the program id).
            AccountMeta::new_readonly(DAMM_V2_PROGRAM_ID, false),
            AccountMeta::new_readonly(*a.event_authority.key, false),
            AccountMeta::new_readonly(DAMM_V2_PROGRAM_ID, false),
        ],
        data,
    };
    invoke_signed(
        &ix,
        &[
            a.pool_authority.clone(),
            a.pool.clone(),
            a.input.clone(),
            a.output.clone(),
            a.token_a_vault.clone(),
            a.token_b_vault.clone(),
            a.token_a_mint.clone(),
            a.token_b_mint.clone(),
            a.payer.clone(),
            a.token_a_program.clone(),
            a.token_b_program.clone(),
            a.event_authority.clone(),
            a.program.clone(),
        ],
        &[seeds],
    )?;
    Ok(())
}

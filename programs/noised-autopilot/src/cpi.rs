//! The only cross-program calls the treasury authority ever signs, each to a
//! program id fixed here (never one taken from an account): a DAMM v2 swap
//! of treasury wSOL into the token (never the other way), a Token-2022 burn
//! of treasury tokens, and SPL Token transfers of treasury wSOL. There is no
//! close, approve, set-authority or arbitrary invoke.
//!
//! Each builds the instruction the Anchor build built (the SPL builders
//! `spl_token_2022::instruction::{transfer_checked, burn_checked}` and the
//! DAMM v2 `swap` of the launchpad's `declare_program!` client; the bytes
//! are checked against them in `tests/abi.rs`) and invokes it signed by the
//! treasury.

use noised_onchain::{
    cpi::invoke,
    ids::{TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID},
    token::{burn_checked_data, transfer_checked_data},
};
use pinocchio::{cpi::Signer, instruction::InstructionAccount, AccountView, ProgramResult};

use crate::{
    constants::{DAMM_V2_PROGRAM_ID, WSOL_DECIMALS},
    external::DAMM_SWAP_DISCRIMINATOR,
};

/// SPL Token `transfer_checked` of `amount` wSOL from a treasury account
/// (`from`, writable; `wsol_mint`; `to`, writable; `authority`, signer).
#[inline(never)]
pub fn transfer_wsol(
    token_program: &AccountView,
    from: &AccountView,
    wsol_mint: &AccountView,
    to: &AccountView,
    authority: &AccountView,
    amount: u64,
    signers: &[Signer],
) -> ProgramResult {
    invoke(
        &TOKEN_PROGRAM_ID,
        &[
            InstructionAccount::writable(from.address()),
            InstructionAccount::readonly(wsol_mint.address()),
            InstructionAccount::writable(to.address()),
            InstructionAccount::readonly_signer(authority.address()),
        ],
        &transfer_checked_data(amount, WSOL_DECIMALS),
        &[from, wsol_mint, to, authority, token_program],
        signers,
    )
}

/// Token-2022 `burn_checked` of `amount` tokens from a treasury account
/// (`from`, writable; `mint`, writable; `authority`, signer).
#[inline(never)]
pub fn burn(
    token_2022_program: &AccountView,
    from: &AccountView,
    mint: &AccountView,
    authority: &AccountView,
    amount: u64,
    decimals: u8,
    signers: &[Signer],
) -> ProgramResult {
    invoke(
        &TOKEN_2022_PROGRAM_ID,
        &[
            InstructionAccount::writable(from.address()),
            InstructionAccount::writable(mint.address()),
            InstructionAccount::readonly_signer(authority.address()),
        ],
        &burn_checked_data(amount, decimals),
        &[from, mint, authority, token_2022_program],
        signers,
    )
}

/// The accounts of a DAMM v2 `swap` buying the token (A) with wSOL (B).
pub struct DammSwap<'a> {
    pub pool_authority: &'a AccountView,
    pub pool: &'a AccountView,
    /// The treasury's wSOL account.
    pub input: &'a AccountView,
    /// The treasury's token account.
    pub output: &'a AccountView,
    pub token_a_vault: &'a AccountView,
    pub token_b_vault: &'a AccountView,
    pub token_a_mint: &'a AccountView,
    pub token_b_mint: &'a AccountView,
    /// The treasury authority (signs).
    pub payer: &'a AccountView,
    pub token_a_program: &'a AccountView,
    pub token_b_program: &'a AccountView,
    pub event_authority: &'a AccountView,
    pub program: &'a AccountView,
}

/// The DAMM v2 `swap` instruction data: `sha256("global:swap")[..8]`, then
/// `SwapParameters { amount_in, minimum_amount_out }`.
#[inline]
pub fn damm_swap_data(amount_in: u64, min_out: u64) -> [u8; 24] {
    let mut data = [0u8; 24];
    data[..8].copy_from_slice(&DAMM_SWAP_DISCRIMINATOR);
    data[8..16].copy_from_slice(&amount_in.to_le_bytes());
    data[16..].copy_from_slice(&min_out.to_le_bytes());
    data
}

/// DAMM v2 `swap` (exact in, no referral): `amount_in` of the input account
/// for at least `min_out` into the output account.
#[inline(never)]
pub fn damm_swap(a: &DammSwap, amount_in: u64, min_out: u64, signers: &[Signer]) -> ProgramResult {
    invoke(
        &DAMM_V2_PROGRAM_ID,
        &[
            InstructionAccount::readonly(a.pool_authority.address()),
            InstructionAccount::writable(a.pool.address()),
            InstructionAccount::writable(a.input.address()),
            InstructionAccount::writable(a.output.address()),
            InstructionAccount::writable(a.token_a_vault.address()),
            InstructionAccount::writable(a.token_b_vault.address()),
            InstructionAccount::readonly(a.token_a_mint.address()),
            InstructionAccount::readonly(a.token_b_mint.address()),
            InstructionAccount::readonly_signer(a.payer.address()),
            InstructionAccount::readonly(&TOKEN_2022_PROGRAM_ID),
            InstructionAccount::readonly(&TOKEN_PROGRAM_ID),
            // No referral account (Anchor's `None`: the program id).
            InstructionAccount::readonly(&DAMM_V2_PROGRAM_ID),
            InstructionAccount::readonly(a.event_authority.address()),
            InstructionAccount::readonly(&DAMM_V2_PROGRAM_ID),
        ],
        &damm_swap_data(amount_in, min_out),
        &[
            a.pool_authority,
            a.pool,
            a.input,
            a.output,
            a.token_a_vault,
            a.token_b_vault,
            a.token_a_mint,
            a.token_b_mint,
            a.payer,
            a.token_a_program,
            a.token_b_program,
            a.event_authority,
            a.program,
        ],
        signers,
    )
}

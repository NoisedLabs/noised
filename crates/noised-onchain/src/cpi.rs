//! Cross-program invocations of the system program, built as anchor-lang's
//! `system_program` CPI helpers build them (`SystemInstruction` in bincode:
//! a `u32` variant index, then the fields), and Anchor's
//! `create_account_or_fund_allocate_assign`, which every `init` runs.
//!
//! [`invoke`] makes any other CPI. The caller must not hold a borrow of any
//! account's data across a CPI: [`crate::sys::invoke`] fails with
//! `AccountBorrowFailed` when one of the instruction's accounts is still
//! borrowed, as solana-cpi does.

use pinocchio::{
    cpi::Signer, instruction::InstructionAccount, AccountView, Address, ProgramResult,
};

pub use crate::sys::invoke;
use crate::{
    error::{anchor::TRYING_TO_INIT_PAYER_AS_PROGRAM_ACCOUNT, fail_keys},
    ids::SYSTEM_PROGRAM_ID,
    same,
    sysvar::Rent,
    Program,
};

/// `InstructionAccount::writable_signer(account.address())`.
#[inline(always)]
pub fn writable_signer(account: &AccountView) -> InstructionAccount<'_> {
    InstructionAccount::writable_signer(account.address())
}

/// `SystemInstruction::CreateAccount { lamports, space, owner }`.
#[inline]
pub fn create_account_data(lamports: u64, space: u64, owner: &Address) -> [u8; 52] {
    let mut data = [0u8; 52];
    data[4..12].copy_from_slice(&lamports.to_le_bytes());
    data[12..20].copy_from_slice(&space.to_le_bytes());
    data[20..52].copy_from_slice(owner.as_ref());
    data
}

/// `SystemInstruction::Assign { owner }`.
#[inline]
pub fn assign_data(owner: &Address) -> [u8; 36] {
    let mut data = [0u8; 36];
    data[0] = 1;
    data[4..36].copy_from_slice(owner.as_ref());
    data
}

/// `SystemInstruction::Transfer { lamports }`.
#[inline]
pub fn transfer_data(lamports: u64) -> [u8; 12] {
    let mut data = [0u8; 12];
    data[0] = 2;
    data[4..12].copy_from_slice(&lamports.to_le_bytes());
    data
}

/// `SystemInstruction::Allocate { space }`.
#[inline]
pub fn allocate_data(space: u64) -> [u8; 12] {
    let mut data = [0u8; 12];
    data[0] = 8;
    data[4..12].copy_from_slice(&space.to_le_bytes());
    data
}

/// `system_program::create_account`: `payer` funds `account` with
/// `lamports`, allocates `space` bytes and assigns it to `owner`. Both sign
/// (a PDA through `signers`).
#[inline]
pub fn create_account(
    payer: &AccountView,
    account: &AccountView,
    lamports: u64,
    space: u64,
    owner: &Address,
    signers: &[Signer],
) -> ProgramResult {
    invoke(
        &SYSTEM_PROGRAM_ID,
        &[writable_signer(payer), writable_signer(account)],
        &create_account_data(lamports, space, owner),
        &[payer, account],
        signers,
    )
}

/// `system_program::transfer` of `lamports` from `from` (a signer, or a PDA
/// through `signers`) to `to`.
#[inline]
pub fn transfer(
    from: &AccountView,
    to: &AccountView,
    lamports: u64,
    signers: &[Signer],
) -> ProgramResult {
    invoke(
        &SYSTEM_PROGRAM_ID,
        &[
            writable_signer(from),
            InstructionAccount::writable(to.address()),
        ],
        &transfer_data(lamports),
        &[from, to],
        signers,
    )
}

/// `system_program::allocate` of `space` bytes for `account`.
#[inline]
pub fn allocate(account: &AccountView, space: u64, signers: &[Signer]) -> ProgramResult {
    invoke(
        &SYSTEM_PROGRAM_ID,
        &[writable_signer(account)],
        &allocate_data(space),
        &[account],
        signers,
    )
}

/// `system_program::assign` of `account` to `owner`.
#[inline]
pub fn assign(account: &AccountView, owner: &Address, signers: &[Signer]) -> ProgramResult {
    invoke(
        &SYSTEM_PROGRAM_ID,
        &[writable_signer(account)],
        &assign_data(owner),
        &[account],
        signers,
    )
}

/// [A] `create_account_or_fund_allocate_assign` (every `init`): an account
/// without lamports is created by `create_account` (rent-exempt minimum for
/// `space`, owned by `owner`); one that already holds lamports (anyone can
/// send lamports to a known address) must not be the payer
/// (`TryingToInitPayerAsProgramAccount`, with both keys, no account named),
/// is topped up to the rent-exempt minimum (at least 1 lamport) by `payer`,
/// then allocated and assigned. `account` signs with `signers` (its PDA
/// seeds and bump; none for a keypair account, which signs the
/// transaction).
#[inline]
pub fn create_account_or_fund_allocate_assign<P: Program>(
    payer: &AccountView,
    account: &AccountView,
    space: usize,
    owner: &Address,
    rent: &Rent,
    signers: &[Signer],
) -> ProgramResult {
    let current = account.lamports();
    if current == 0 {
        return create_account(
            payer,
            account,
            rent.minimum_balance(space),
            space as u64,
            owner,
            signers,
        );
    }
    // require_keys_neq!(payer, account, TryingToInitPayerAsProgramAccount)
    if same(payer.address(), account.address()) {
        return Err(fail_keys::<P>(
            TRYING_TO_INIT_PAYER_AS_PROGRAM_ACCOUNT,
            None,
            payer.address(),
            account.address(),
        ));
    }
    let required = rent.minimum_balance(space).max(1).saturating_sub(current);
    if required > 0 {
        transfer(payer, account, required, &[])?;
    }
    allocate(account, space as u64, signers)?;
    assign(account, owner, signers)
}

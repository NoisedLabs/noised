//! Program derived addresses and Anchor's `seeds` constraint.
//!
//! * `seeds = [...], bump` (no value; and every `init` with seeds):
//!   [`check_seeds`] (`find_program_address`; the canonical bump).
//! * `seeds = [...], bump = <expr>` on an existing account:
//!   [`check_seeds_with_bump`] (`create_program_address` with the given
//!   bump, usually the stored one).
//! * `seeds::program = <id>`: pass that id instead of the program's.

use pinocchio::{error::ProgramError, AccountView, Address};

use crate::{
    error::{anchor::CONSTRAINT_SEEDS, fail, fail_keys, fail_values},
    same, Program,
};

/// `Pubkey::find_program_address` (a syscall on-chain). Panics, as
/// Anchor's does, when no bump gives an off-curve address.
#[inline(never)]
pub fn find_program_address(seeds: &[&[u8]], program_id: &Address) -> (Address, u8) {
    Address::find_program_address(seeds, program_id)
}

/// `Pubkey::create_program_address`: `None` when the seeds are invalid or
/// the address is on the curve.
#[inline]
pub fn create_program_address(seeds: &[&[u8]], program_id: &Address) -> Option<Address> {
    Address::create_program_address(seeds, program_id).ok()
}

/// [A] `seeds = [...], bump`: the account is
/// `find_program_address(seeds, program_id)` (`ConstraintSeeds`, with the
/// given and the derived keys). Returns the canonical bump
/// (`ctx.bumps.<field>`).
#[inline]
pub fn check_seeds<P: Program>(
    account: &AccountView,
    seeds: &[&[u8]],
    program_id: &Address,
    name: &'static str,
) -> Result<u8, ProgramError> {
    let (pda, bump) = find_program_address(seeds, program_id);
    if !same(account.address(), &pda) {
        return Err(fail_keys::<P>(
            CONSTRAINT_SEEDS,
            Some(name),
            account.address(),
            &pda,
        ));
    }
    Ok(bump)
}

/// [A] `init, seeds = [...], bump = <expected>`: [`check_seeds`], then the
/// canonical bump must be `expected` (`ConstraintSeeds` with both values).
#[inline]
pub fn check_seeds_canonical_bump<P: Program>(
    account: &AccountView,
    seeds: &[&[u8]],
    program_id: &Address,
    expected: u8,
    name: &'static str,
) -> Result<u8, ProgramError> {
    let bump = check_seeds::<P>(account, seeds, program_id, name)?;
    if bump != expected {
        return Err(fail_values::<P>(
            CONSTRAINT_SEEDS,
            Some(name),
            u64::from(bump),
            u64::from(expected),
        ));
    }
    Ok(bump)
}

/// [A] `seeds = [...], bump = <bump>` on an existing account:
/// `create_program_address(seeds_with_bump, program_id)` (the last seed is
/// the bump). Invalid seeds are `ConstraintSeeds` (no keys); another
/// address is `ConstraintSeeds` with the given and the derived keys.
#[inline]
pub fn check_seeds_with_bump<P: Program>(
    account: &AccountView,
    seeds_with_bump: &[&[u8]],
    program_id: &Address,
    name: &'static str,
) -> Result<(), ProgramError> {
    let Some(pda) = create_program_address(seeds_with_bump, program_id) else {
        return Err(fail::<P>(CONSTRAINT_SEEDS, Some(name)));
    };
    if !same(account.address(), &pda) {
        return Err(fail_keys::<P>(
            CONSTRAINT_SEEDS,
            Some(name),
            account.address(),
            &pda,
        ));
    }
    Ok(())
}

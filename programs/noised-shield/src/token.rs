//! Token accounts and the backing invariant. Token-2022 parsing, the
//! transfer-hook account resolution and the token CPIs are
//! `noised_onchain::token` (written from, and tested against, the SPL crates
//! the Anchor build used through anchor-spl).

pub use noised_onchain::token::{
    ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
};
use noised_onchain::{
    error::anchor::ACCOUNT_OWNED_BY_WRONG_PROGRAM,
    owned_by,
    token::{unpack_mint, unpack_token_account},
};
use pinocchio::{error::ProgramError, AccountView, ProgramResult};

use crate::error::{fail, shield, ShieldError};

/// Full backing: the escrow always holds at least the zToken supply.
///
/// Equality is what every shield instruction preserves (wrap/unwrap check
/// their exact deltas), but it cannot be an on-chain invariant: anyone can
/// transfer base tokens straight into the escrow, and any holder can burn
/// zTokens with a plain Token-2022 `Burn`. Requiring equality would let a
/// one-unit donation or burn brick every later wrap and unwrap, locking all
/// escrowed funds. Such surplus stays in the escrow and is never paid out.
#[inline(always)]
pub fn require_backed(escrow_balance: u64, z_supply: u64) -> ProgramResult {
    if escrow_balance < z_supply {
        return Err(shield(ShieldError::Undercollateralized));
    }
    Ok(())
}

/// `InterfaceAccount::reload`'s owner check (`T::check_owner`): SPL Token or
/// Token-2022, else `AccountOwnedByWrongProgram`. (Anchor names the owner's
/// address as the account in that log line; here no account is named. No
/// CPI of the shield can reassign the escrow or the zToken mint.)
fn check_token_program_owner(account: &AccountView) -> ProgramResult {
    if !owned_by(account, &TOKEN_PROGRAM_ID) && !owned_by(account, &TOKEN_2022_PROGRAM_ID) {
        return Err(fail(ACCOUNT_OWNED_BY_WRONG_PROGRAM, None));
    }
    Ok(())
}

/// `InterfaceAccount<TokenAccount>::reload()`, then its amount: the owner
/// check, then `StateWithExtensions::<Account>::unpack` (its errors as they
/// are).
#[inline(always)]
pub fn reload_amount(account: &AccountView) -> Result<u64, ProgramError> {
    reload(account, false)
}

/// `InterfaceAccount<Mint>::reload()`, then its supply: the owner check,
/// then `StateWithExtensions::<Mint>::unpack` (its errors as they are).
#[inline(always)]
pub fn reload_supply(mint: &AccountView) -> Result<u64, ProgramError> {
    reload(mint, true)
}

/// [`reload_amount`] or [`reload_supply`], one routine for both.
#[inline(never)]
fn reload(account: &AccountView, is_mint: bool) -> Result<u64, ProgramError> {
    check_token_program_owner(account)?;
    let data = account.try_borrow()?;
    if is_mint {
        Ok(unpack_mint(&data)?.supply())
    } else {
        Ok(unpack_token_account(&data)?.amount())
    }
}

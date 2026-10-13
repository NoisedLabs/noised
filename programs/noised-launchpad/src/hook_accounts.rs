//! The accounts a transfer of a Noised-hooked mint needs while the hook is
//! active: the meta list PDA, the policy PDA, the instructions sysvar and the
//! hook program.

use noised_onchain::{pda::find_program_address, AccountView, ProgramError};

use crate::{
    error::{raise, LaunchpadError},
    external::hook::{self as noised_hook, INSTRUCTIONS_SYSVAR_ID, META_LIST_SEED, POLICY_SEED},
    Pubkey,
};

pub const HOOK_ACCOUNT_COUNT: usize = 4;
/// Position of the instructions sysvar in `expected`.
pub const INSTRUCTIONS_SYSVAR_INDEX: usize = 2;

/// `[extra_account_meta_list, policy, instructions_sysvar, hook_program]` for `mint`.
pub fn expected(mint: &Pubkey) -> [Pubkey; HOOK_ACCOUNT_COUNT] {
    let (meta_list, _) = find_program_address(&[META_LIST_SEED, mint.as_ref()], &noised_hook::ID);
    let (policy, _) = find_program_address(&[POLICY_SEED, mint.as_ref()], &noised_hook::ID);
    [meta_list, policy, INSTRUCTIONS_SYSVAR_ID, noised_hook::ID]
}

/// Require exactly the hook accounts of `mint`, in canonical order.
#[inline(never)]
pub fn validate(accounts: &[AccountView], mint: &Pubkey) -> Result<(), ProgramError> {
    if accounts.len() != HOOK_ACCOUNT_COUNT {
        return Err(raise(LaunchpadError::InvalidHookAccounts));
    }
    let want = expected(mint);
    if !accounts
        .iter()
        .zip(want.iter())
        .all(|(a, w)| a.address() == w)
    {
        return Err(raise(LaunchpadError::InvalidHookAccounts));
    }
    Ok(())
}

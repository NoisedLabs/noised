//! Token CPIs signed by launchpad PDAs.

use alloc::vec::Vec;

use noised_onchain::{
    cpi::invoke,
    owned_by,
    pinocchio::instruction::InstructionAccount,
    same,
    token::{
        associated_token_address, burn_checked, create_associated_token_account, hook,
        hook_program_id, transfer_checked_data, unpack_mint, unpack_token_account,
        TOKEN_2022_PROGRAM_ID,
    },
    AccountView, ProgramError, ProgramResult, Signer,
};

use crate::{
    error::{fail_keys, raise, LaunchpadError},
    Pubkey,
};

/// The mint's active transfer-hook program, if any (DBC revokes it at curve
/// completion, after which transfers need no extra accounts).
#[inline(never)]
pub fn hook_program_of(mint: &AccountView) -> Result<Option<Pubkey>, ProgramError> {
    if !owned_by(mint, &TOKEN_2022_PROGRAM_ID) {
        return Ok(None);
    }
    let data = mint.try_borrow()?;
    let state = unpack_mint(&data)?;
    Ok(hook_program_id(state.tlv))
}

/// `transfer_checked` from a PDA-owned account. When the mint has an active
/// hook, the hook's accounts are resolved from `hook_accounts`; Token-2022
/// re-derives and checks them, so a caller cannot redirect the hook call.
/// A resolution that fails is `InvalidHookAccounts`.
#[allow(clippy::too_many_arguments)]
#[inline(never)]
pub fn transfer_signed(
    token_program: &AccountView,
    mint: &AccountView,
    decimals: u8,
    from: &AccountView,
    to: &AccountView,
    authority: &AccountView,
    amount: u64,
    signers: &[Signer],
    hook_accounts: &[AccountView],
) -> ProgramResult {
    let data = transfer_checked_data(amount, decimals);
    let mut entries: Vec<hook::Entry<AccountView>> = Vec::with_capacity(16);
    entries.push(hook::Entry::new(from, false, true));
    entries.push(hook::Entry::new(mint, false, false));
    entries.push(hook::Entry::new(to, false, true));
    entries.push(hook::Entry::new(authority, true, false));
    if let Some(hook_program) = hook_program_of(mint)? {
        hook::add_extra_accounts_for_execute_cpi(
            &mut entries,
            &hook_program,
            from,
            mint,
            to,
            authority,
            amount,
            hook_accounts,
        )
        .map_err(|_| raise(LaunchpadError::InvalidHookAccounts))?;
    }
    let metas: Vec<InstructionAccount> = entries
        .iter()
        .map(|e| InstructionAccount::new(e.account.address(), e.is_writable, e.is_signer))
        .collect();
    let infos: Vec<&AccountView> = entries.iter().map(|e| e.account).collect();
    invoke(token_program.address(), &metas, &data, &infos, signers)
}

/// `InterfaceAccount<TokenAccount>::reload()`, then its amount: owned by a
/// token program (`AccountOwnedByWrongProgram`, no account named), then
/// unpacked (its errors as they are).
#[inline(never)]
pub fn reload_amount(account: &AccountView) -> Result<u64, ProgramError> {
    if !owned_by(account, &noised_onchain::ids::TOKEN_PROGRAM_ID)
        && !owned_by(account, &TOKEN_2022_PROGRAM_ID)
    {
        return Err(crate::error::fail(
            crate::error::anchor::ACCOUNT_OWNED_BY_WRONG_PROGRAM,
            None,
        ));
    }
    let data = account.try_borrow()?;
    Ok(unpack_token_account(&data)?.amount())
}

/// `transfer_checked` signed by `authority` itself (anchor-spl's
/// `token_interface::transfer_checked`: no transfer-hook accounts).
pub fn transfer_plain(
    token_program: &AccountView,
    from: &AccountView,
    mint: &AccountView,
    to: &AccountView,
    authority: &AccountView,
    amount: u64,
    decimals: u8,
) -> ProgramResult {
    invoke(
        token_program.address(),
        &[
            InstructionAccount::writable(from.address()),
            InstructionAccount::readonly(mint.address()),
            InstructionAccount::writable(to.address()),
            InstructionAccount::readonly_signer(authority.address()),
        ],
        &transfer_checked_data(amount, decimals),
        &[from, mint, to, authority],
        &[],
    )
}

/// `burn_checked` of `amount` from a PDA-owned account.
#[allow(clippy::too_many_arguments)]
pub fn burn_signed(
    token_program: &AccountView,
    mint: &AccountView,
    decimals: u8,
    from: &AccountView,
    authority: &AccountView,
    amount: u64,
    signers: &[Signer],
) -> ProgramResult {
    burn_checked(
        token_program,
        from,
        mint,
        authority,
        amount,
        decimals,
        signers,
    )
}

/// Accounts needed to create an associated token account on demand (the
/// instruction must also carry the associated-token program account).
pub struct AtaCreator<'a> {
    pub payer: &'a AccountView,
    pub mint: &'a AccountView,
    pub token_program: &'a AccountView,
    pub system_program: &'a AccountView,
}

impl AtaCreator<'_> {
    /// Require `ata` to be the canonical ATA of `wallet` for this mint and
    /// create it if it does not exist yet. The token-account owner field is
    /// deliberately not compared: only the ATA program can create an account
    /// at this address, and a wallet that reassigned its own ATA chose where
    /// its share goes (refusing would let one recipient block everyone).
    #[inline(never)]
    pub fn ensure(&self, wallet: &AccountView, ata: &AccountView) -> ProgramResult {
        let invalid = LaunchpadError::InvalidRecipientAccounts.code();
        let expected = associated_token_address(
            wallet.address(),
            self.mint.address(),
            self.token_program.address(),
        );
        if !same(ata.address(), &expected) {
            return Err(fail_keys(invalid, None, ata.address(), &expected));
        }
        if !ata.is_writable() {
            return Err(raise(LaunchpadError::InvalidRecipientAccounts));
        }
        if ata.is_data_empty() {
            // create_associated_token_account_idempotent
            create_associated_token_account(
                true,
                self.payer,
                &expected,
                ata,
                wallet,
                self.mint,
                self.system_program,
                self.token_program,
            )?;
        }
        if !owned_by(ata, self.token_program.address()) {
            return Err(fail_keys(
                invalid,
                None,
                ata.owner(),
                self.token_program.address(),
            ));
        }
        let data = ata.try_borrow()?;
        let account = unpack_token_account(&data)
            .map_err(|_| raise(LaunchpadError::InvalidRecipientAccounts))?;
        let account_mint = account.mint();
        if !same(&account_mint, self.mint.address()) {
            return Err(fail_keys(invalid, None, &account_mint, self.mint.address()));
        }
        Ok(())
    }
}

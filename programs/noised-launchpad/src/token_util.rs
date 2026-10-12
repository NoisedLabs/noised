//! Token CPIs signed by launchpad PDAs.

use anchor_lang::{prelude::*, solana_program::program::invoke_signed};
use anchor_spl::{
    associated_token::{self, get_associated_token_address_with_program_id},
    token_interface::{
        spl_token_2022::{
            self,
            extension::{transfer_hook, StateWithExtensions},
        },
        Mint, TokenAccount,
    },
};

use crate::error::LaunchpadError;

/// The mint's active transfer-hook program, if any (DBC revokes it at curve
/// completion, after which transfers need no extra accounts).
pub fn hook_program_of(mint: &AccountInfo) -> Result<Option<Pubkey>> {
    if *mint.owner != spl_token_2022::ID {
        return Ok(None);
    }
    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&data)?;
    Ok(transfer_hook::get_program_id(&state))
}

/// `transfer_checked` from a PDA-owned account. When the mint has an active
/// hook, the hook's accounts are resolved from `hook_accounts`; Token-2022
/// re-derives and checks them, so a caller cannot redirect the hook call.
#[allow(clippy::too_many_arguments)]
pub fn transfer_signed<'info>(
    token_program: &AccountInfo<'info>,
    mint: &InterfaceAccount<'info, Mint>,
    from: &InterfaceAccount<'info, TokenAccount>,
    to: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    amount: u64,
    seeds: &[&[u8]],
    hook_accounts: &[AccountInfo<'info>],
) -> Result<()> {
    let mut ix = spl_token_2022::instruction::transfer_checked(
        token_program.key,
        &from.key(),
        &mint.key(),
        to.key,
        authority.key,
        &[],
        amount,
        mint.decimals,
    )?;
    let mut infos = vec![
        from.to_account_info(),
        mint.to_account_info(),
        to.clone(),
        authority.clone(),
    ];
    if let Some(hook_program) = hook_program_of(&mint.to_account_info())? {
        spl_transfer_hook_interface::onchain::add_extra_accounts_for_execute_cpi(
            &mut ix,
            &mut infos,
            &hook_program,
            from.to_account_info(),
            mint.to_account_info(),
            to,
            authority,
            amount,
            hook_accounts,
        )
        .map_err(|_| error!(LaunchpadError::InvalidHookAccounts))?;
    }
    infos.push(token_program.clone());
    invoke_signed(&ix, &infos, &[seeds])?;
    Ok(())
}

/// `burn_checked` of `amount` from a PDA-owned account.
pub fn burn_signed<'info>(
    token_program: &AccountInfo<'info>,
    mint: &InterfaceAccount<'info, Mint>,
    from: &InterfaceAccount<'info, TokenAccount>,
    authority: AccountInfo<'info>,
    amount: u64,
    seeds: &[&[u8]],
) -> Result<()> {
    let ix = spl_token_2022::instruction::burn_checked(
        token_program.key,
        &from.key(),
        &mint.key(),
        authority.key,
        &[],
        amount,
        mint.decimals,
    )?;
    invoke_signed(
        &ix,
        &[
            from.to_account_info(),
            mint.to_account_info(),
            authority,
            token_program.clone(),
        ],
        &[seeds],
    )?;
    Ok(())
}

/// Accounts needed to create an associated token account on demand (the
/// instruction must also carry the associated-token program account).
pub struct AtaCreator<'a, 'info> {
    pub payer: &'a AccountInfo<'info>,
    pub mint: &'a AccountInfo<'info>,
    pub token_program: &'a AccountInfo<'info>,
    pub system_program: &'a AccountInfo<'info>,
}

impl<'info> AtaCreator<'_, 'info> {
    /// Require `ata` to be the canonical ATA of `wallet` for this mint and
    /// create it if it does not exist yet. The token-account owner field is
    /// deliberately not compared: only the ATA program can create an account
    /// at this address, and a wallet that reassigned its own ATA chose where
    /// its share goes (refusing would let one recipient block everyone).
    pub fn ensure(&self, wallet: &AccountInfo<'info>, ata: &AccountInfo<'info>) -> Result<()> {
        let expected = get_associated_token_address_with_program_id(
            wallet.key,
            self.mint.key,
            self.token_program.key,
        );
        require_keys_eq!(*ata.key, expected, LaunchpadError::InvalidRecipientAccounts);
        require!(ata.is_writable, LaunchpadError::InvalidRecipientAccounts);
        if ata.data_is_empty() {
            associated_token::create_idempotent(CpiContext::new(
                associated_token::ID,
                associated_token::Create {
                    payer: self.payer.clone(),
                    associated_token: ata.clone(),
                    authority: wallet.clone(),
                    mint: self.mint.clone(),
                    system_program: self.system_program.clone(),
                    token_program: self.token_program.clone(),
                },
            ))?;
        }
        require_keys_eq!(
            *ata.owner,
            *self.token_program.key,
            LaunchpadError::InvalidRecipientAccounts
        );
        let data = ata.try_borrow_data()?;
        let account = StateWithExtensions::<spl_token_2022::state::Account>::unpack(&data)
            .map_err(|_| error!(LaunchpadError::InvalidRecipientAccounts))?;
        require_keys_eq!(
            account.base.mint,
            *self.mint.key,
            LaunchpadError::InvalidRecipientAccounts
        );
        Ok(())
    }
}

use anchor_lang::{prelude::*, solana_program::program::invoke_signed};
use anchor_spl::{
    token_2022::spl_token_2022::{
        self,
        extension::{transfer_hook, StateWithExtensions},
    },
    token_interface::Mint,
};

use crate::error::ShieldError;

/// The transfer-hook program of `mint`, if it is a Token-2022 mint with an
/// active hook (DBC revokes Noised hooks at graduation: program = None).
fn hook_program_id(mint: &InterfaceAccount<Mint>) -> Result<Option<Pubkey>> {
    let info = mint.to_account_info();
    if *info.owner != spl_token_2022::ID {
        return Ok(None);
    }
    let data = info.try_borrow_data()?;
    let state = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&data)?;
    Ok(transfer_hook::get_program_id(&state))
}

/// `transfer_checked` (SPL Token or Token-2022), adding the mint's
/// transfer-hook accounts from `extra` when it has an active hook. Token-2022
/// resolves and checks those accounts again before calling the hook, and
/// passes every account to the hook without signer privileges, so `extra`
/// cannot borrow the shield authority's signature.
#[allow(clippy::too_many_arguments)]
pub fn transfer_checked<'info>(
    token_program: &AccountInfo<'info>,
    mint: &InterfaceAccount<'info, Mint>,
    from: AccountInfo<'info>,
    to: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    amount: u64,
    signer_seeds: &[&[&[u8]]],
    extra: &'info [AccountInfo<'info>],
) -> Result<()> {
    let mut ix = spl_token_2022::instruction::transfer_checked(
        token_program.key,
        from.key,
        &mint.key(),
        to.key,
        authority.key,
        &[],
        amount,
        mint.decimals,
    )?;
    let mut infos = vec![
        from.clone(),
        mint.to_account_info(),
        to.clone(),
        authority.clone(),
    ];
    if let Some(hook_program_id) = hook_program_id(mint)? {
        spl_transfer_hook_interface::onchain::add_extra_accounts_for_execute_cpi(
            &mut ix,
            &mut infos,
            &hook_program_id,
            from,
            mint.to_account_info(),
            to,
            authority,
            amount,
            extra,
        )?;
    }
    invoke_signed(&ix, &infos, signer_seeds)?;
    Ok(())
}

/// Full backing: the escrow always holds at least the zToken supply.
///
/// Equality is what every shield instruction preserves (wrap/unwrap check
/// their exact deltas), but it cannot be an on-chain invariant: anyone can
/// transfer base tokens straight into the escrow, and any holder can burn
/// zTokens with a plain Token-2022 `Burn`. Requiring equality would let a
/// one-unit donation or burn brick every later wrap and unwrap, locking all
/// escrowed funds. Such surplus stays in the escrow and is never paid out.
pub fn require_backed(escrow_balance: u64, z_supply: u64) -> Result<()> {
    require!(escrow_balance >= z_supply, ShieldError::Undercollateralized);
    Ok(())
}

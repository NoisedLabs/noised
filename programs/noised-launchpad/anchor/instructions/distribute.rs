use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::Token,
    token_2022::Token2022,
    token_interface::{Mint, TokenAccount},
};

use crate::{
    constants::*,
    error::LaunchpadError,
    events::Distributed,
    math,
    state::{Launch, LaunchStatus},
    token_util::{self, AtaCreator},
};

/// Permissionless: route the launch authority's whole wSOL balance by the
/// rules fixed at `create_launch` (platform share, then recipients) and burn
/// its whole base-token balance.
///
/// Remaining accounts: `[wallet_i, wsol_ata_i]` for every stored recipient,
/// in order. Missing ATAs are created (payer = caller).
pub fn handle_distribute<'info>(ctx: Context<'info, Distribute<'info>>) -> Result<()> {
    let launch = &ctx.accounts.launch;
    let count = usize::from(launch.recipient_count);
    let recipients = &launch.recipients[..count];
    let remaining = ctx.remaining_accounts;
    require!(
        remaining.len() == 2 * count,
        LaunchpadError::InvalidRecipientAccounts
    );

    let balance = ctx.accounts.authority_quote_ata.amount;
    let base_balance = ctx.accounts.authority_base_ata.amount;
    require!(balance > 0 || base_balance > 0, LaunchpadError::NothingToDo);

    let split = math::split_fees(balance, launch.platform_fee_bps, recipients)
        .ok_or(LaunchpadError::MathOverflow)?;
    require!(
        split.total() == Some(balance),
        LaunchpadError::PayoutExceedsEscrow
    );

    let launch_key = launch.key();
    let bump = [launch.authority_bump];
    let seeds: &[&[u8]] = &[AUTHORITY_SEED, launch_key.as_ref(), &bump];
    let a = &ctx.accounts;
    let token_program = a.token_program.to_account_info();
    let authority = a.launch_authority.to_account_info();
    let creator = AtaCreator {
        payer: &a.payer.to_account_info(),
        mint: &a.quote_mint.to_account_info(),
        token_program: &token_program,
        system_program: &a.system_program.to_account_info(),
    };

    if split.platform > 0 {
        let treasury_ata = a.treasury_quote_ata.to_account_info();
        creator.ensure(&a.treasury.to_account_info(), &treasury_ata)?;
        token_util::transfer_signed(
            &token_program,
            &a.quote_mint,
            &a.authority_quote_ata,
            treasury_ata,
            authority.clone(),
            split.platform,
            seeds,
            &[],
        )?;
    }

    for (i, recipient) in recipients.iter().enumerate() {
        let wallet = &remaining[2 * i];
        let ata = &remaining[2 * i + 1];
        require_keys_eq!(
            *wallet.key,
            recipient.wallet,
            LaunchpadError::InvalidRecipientAccounts
        );
        creator.ensure(wallet, ata)?;
        let amount = split.recipients[i];
        if amount > 0 {
            token_util::transfer_signed(
                &token_program,
                &a.quote_mint,
                &a.authority_quote_ata,
                ata.clone(),
                authority.clone(),
                amount,
                seeds,
                &[],
            )?;
        }
    }

    // LP fees paid in the launched token are destroyed, never sold.
    if base_balance > 0 {
        token_util::burn_signed(
            &a.token_2022_program.to_account_info(),
            &a.base_mint,
            &a.authority_base_ata,
            authority,
            base_balance,
            seeds,
        )?;
    }

    let recipients_amount = balance
        .checked_sub(split.platform)
        .ok_or(LaunchpadError::MathOverflow)?;
    emit!(Distributed {
        launch: launch_key,
        platform_amount: split.platform,
        recipients_amount,
        base_burned: base_balance,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct Distribute<'info> {
    /// Anyone; pays for missing token accounts.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        has_one = base_mint @ LaunchpadError::AccountMismatch,
        has_one = launch_authority @ LaunchpadError::AccountMismatch,
        has_one = treasury @ LaunchpadError::AccountMismatch,
        constraint = launch.status == LaunchStatus::Live @ LaunchpadError::WrongLaunchState,
    )]
    pub launch: Box<Account<'info, Launch>>,

    /// CHECK: launch authority PDA bound to `launch`; signs every transfer.
    pub launch_authority: UncheckedAccount<'info>,

    /// CHECK: the treasury snapshotted from `Protocol` at creation.
    pub treasury: UncheckedAccount<'info>,

    /// Writable: burning reduces supply.
    #[account(mut)]
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(address = WSOL_MINT @ LaunchpadError::AccountMismatch)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = quote_mint,
        associated_token::authority = launch_authority,
        associated_token::token_program = token_program,
    )]
    pub authority_quote_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = base_mint,
        associated_token::authority = launch_authority,
        associated_token::token_program = token_2022_program,
    )]
    pub authority_base_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: must be the treasury's canonical wSOL ATA; created if missing
    /// (same rules as recipient ATAs, see `AtaCreator::ensure`).
    #[account(mut)]
    pub treasury_quote_ata: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

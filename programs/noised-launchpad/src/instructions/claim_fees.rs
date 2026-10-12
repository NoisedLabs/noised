use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::Token,
    token_2022::Token2022,
    token_interface::{Mint, TokenAccount},
};

use crate::{
    checks,
    constants::*,
    dynamic_bonding_curve::{self, types::TransferHookAccountsInfo},
    error::LaunchpadError,
    events::FeesClaimed,
    state::{Launch, LaunchStatus},
};

/// Permissionless: claim the partner trading fees (wSOL only, the config
/// collects fees in quote) into the launch authority's wSOL account.
pub fn handle_claim_fees(ctx: Context<ClaimFees>) -> Result<()> {
    let before = ctx.accounts.authority_quote_ata.amount;
    let launch_key = ctx.accounts.launch.key();
    let bump = [ctx.accounts.launch.authority_bump];
    let seeds: &[&[u8]] = &[AUTHORITY_SEED, launch_key.as_ref(), &bump];
    let a = &ctx.accounts;
    dynamic_bonding_curve::cpi::claim_trading_fee2(
        CpiContext::new_with_signer(
            DBC_PROGRAM_ID,
            dynamic_bonding_curve::cpi::accounts::ClaimTradingFee2 {
                pool_authority: a.dbc_pool_authority.to_account_info(),
                config: a.dbc_config.to_account_info(),
                pool: a.pool.to_account_info(),
                token_a_account: a.authority_base_ata.to_account_info(),
                token_b_account: a.authority_quote_ata.to_account_info(),
                base_vault: a.base_vault.to_account_info(),
                quote_vault: a.quote_vault.to_account_info(),
                base_mint: a.base_mint.to_account_info(),
                quote_mint: a.quote_mint.to_account_info(),
                fee_claimer: a.launch_authority.to_account_info(),
                token_base_program: a.token_2022_program.to_account_info(),
                token_quote_program: a.token_program.to_account_info(),
                event_authority: a.dbc_event_authority.to_account_info(),
                program: a.dbc_program.to_account_info(),
            },
            &[seeds],
        ),
        // Base fees are never collected by this config; never move base here.
        0,
        u64::MAX,
        TransferHookAccountsInfo { slices: vec![] },
    )?;
    ctx.accounts.authority_quote_ata.reload()?;
    let claimed = ctx
        .accounts
        .authority_quote_ata
        .amount
        .checked_sub(before)
        .ok_or(LaunchpadError::MathOverflow)?;
    require!(claimed > 0, LaunchpadError::NothingToDo);
    emit!(FeesClaimed {
        launch: launch_key,
        quote_amount: claimed,
        surplus: false,
    });
    Ok(())
}

/// Permissionless, after the curve completes: withdraw the partner and
/// creator surplus (both roles are the launch authority) into its wSOL account.
pub fn handle_claim_surplus(ctx: Context<ClaimSurplus>) -> Result<()> {
    let (partner_done, creator_done) = {
        let pool = checks::read_dbc_pool(&ctx.accounts.pool)?;
        (
            pool.pool_state.is_partner_withdraw_surplus != 0,
            pool.pool_state.is_creator_withdraw_surplus != 0,
        )
    };
    require!(!(partner_done && creator_done), LaunchpadError::NothingToDo);

    let before = ctx.accounts.authority_quote_ata.amount;
    let launch_key = ctx.accounts.launch.key();
    let bump = [ctx.accounts.launch.authority_bump];
    let seeds: &[&[u8]] = &[AUTHORITY_SEED, launch_key.as_ref(), &bump];
    let a = &ctx.accounts;
    if !partner_done {
        dynamic_bonding_curve::cpi::partner_withdraw_surplus(CpiContext::new_with_signer(
            DBC_PROGRAM_ID,
            dynamic_bonding_curve::cpi::accounts::PartnerWithdrawSurplus {
                pool_authority: a.dbc_pool_authority.to_account_info(),
                config: a.dbc_config.to_account_info(),
                virtual_pool: a.pool.to_account_info(),
                token_quote_account: a.authority_quote_ata.to_account_info(),
                quote_vault: a.quote_vault.to_account_info(),
                quote_mint: a.quote_mint.to_account_info(),
                fee_claimer: a.launch_authority.to_account_info(),
                token_quote_program: a.token_program.to_account_info(),
                event_authority: a.dbc_event_authority.to_account_info(),
                program: a.dbc_program.to_account_info(),
            },
            &[seeds],
        ))?;
    }
    if !creator_done {
        dynamic_bonding_curve::cpi::creator_withdraw_surplus(CpiContext::new_with_signer(
            DBC_PROGRAM_ID,
            dynamic_bonding_curve::cpi::accounts::CreatorWithdrawSurplus {
                pool_authority: a.dbc_pool_authority.to_account_info(),
                config: a.dbc_config.to_account_info(),
                virtual_pool: a.pool.to_account_info(),
                token_quote_account: a.authority_quote_ata.to_account_info(),
                quote_vault: a.quote_vault.to_account_info(),
                quote_mint: a.quote_mint.to_account_info(),
                creator: a.launch_authority.to_account_info(),
                token_quote_program: a.token_program.to_account_info(),
                event_authority: a.dbc_event_authority.to_account_info(),
                program: a.dbc_program.to_account_info(),
            },
            &[seeds],
        ))?;
    }
    ctx.accounts.authority_quote_ata.reload()?;
    let claimed = ctx
        .accounts
        .authority_quote_ata
        .amount
        .checked_sub(before)
        .ok_or(LaunchpadError::MathOverflow)?;
    emit!(FeesClaimed {
        launch: launch_key,
        quote_amount: claimed,
        surplus: true,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ClaimFees<'info> {
    /// Anyone; pays for the launch authority's token accounts if missing.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        has_one = pool @ LaunchpadError::AccountMismatch,
        has_one = base_mint @ LaunchpadError::AccountMismatch,
        has_one = dbc_config @ LaunchpadError::AccountMismatch,
        has_one = launch_authority @ LaunchpadError::AccountMismatch,
        constraint = launch.status == LaunchStatus::Live @ LaunchpadError::WrongLaunchState,
    )]
    pub launch: Box<Account<'info, Launch>>,

    /// CHECK: launch authority PDA bound to `launch`; signs as fee claimer.
    pub launch_authority: UncheckedAccount<'info>,

    /// CHECK: this launch's DBC config (DBC checks it against the pool).
    pub dbc_config: UncheckedAccount<'info>,

    /// CHECK: this launch's DBC pool.
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,

    /// CHECK: DBC checks it equals the pool's base vault.
    #[account(mut)]
    pub base_vault: UncheckedAccount<'info>,

    /// CHECK: DBC checks it equals the pool's quote vault.
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,

    pub base_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(address = WSOL_MINT @ LaunchpadError::AccountMismatch)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = base_mint,
        associated_token::authority = launch_authority,
        associated_token::token_program = token_2022_program,
    )]
    pub authority_base_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = quote_mint,
        associated_token::authority = launch_authority,
        associated_token::token_program = token_program,
    )]
    pub authority_quote_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: DBC pool authority.
    #[account(address = DBC_POOL_AUTHORITY @ LaunchpadError::AccountMismatch)]
    pub dbc_pool_authority: UncheckedAccount<'info>,

    /// CHECK: Meteora DBC.
    #[account(address = DBC_PROGRAM_ID @ LaunchpadError::AccountMismatch, executable)]
    pub dbc_program: UncheckedAccount<'info>,

    /// CHECK: DBC event authority PDA.
    #[account(address = DBC_EVENT_AUTHORITY @ LaunchpadError::AccountMismatch)]
    pub dbc_event_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimSurplus<'info> {
    /// Anyone; pays for the launch authority's wSOL account if missing.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        has_one = pool @ LaunchpadError::AccountMismatch,
        has_one = dbc_config @ LaunchpadError::AccountMismatch,
        has_one = launch_authority @ LaunchpadError::AccountMismatch,
        constraint = launch.status == LaunchStatus::Live @ LaunchpadError::WrongLaunchState,
    )]
    pub launch: Box<Account<'info, Launch>>,

    /// CHECK: launch authority PDA bound to `launch`; signs as partner and creator.
    pub launch_authority: UncheckedAccount<'info>,

    /// CHECK: this launch's DBC config (DBC checks it against the pool).
    pub dbc_config: UncheckedAccount<'info>,

    /// CHECK: this launch's DBC pool (bound by `has_one`; owner and type
    /// checked when its surplus flags are read).
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,

    /// CHECK: DBC checks it equals the pool's quote vault.
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,

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

    /// CHECK: DBC pool authority.
    #[account(address = DBC_POOL_AUTHORITY @ LaunchpadError::AccountMismatch)]
    pub dbc_pool_authority: UncheckedAccount<'info>,

    /// CHECK: Meteora DBC.
    #[account(address = DBC_PROGRAM_ID @ LaunchpadError::AccountMismatch, executable)]
    pub dbc_program: UncheckedAccount<'info>,

    /// CHECK: DBC event authority PDA.
    #[account(address = DBC_EVENT_AUTHORITY @ LaunchpadError::AccountMismatch)]
    pub dbc_event_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

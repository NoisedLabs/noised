use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::Token,
    token_interface::{Mint, TokenAccount},
};

use crate::{
    constants::*, error::AutopilotError, events::AutopilotInitialized, external, launchpad,
    state::Autopilot,
};

/// Permissionless, once per launch (configured or live): create the
/// launch's autopilot and its treasury's wSOL account. The reference price
/// starts at the launch's migration price, read from its DBC config: fixed
/// at `create_launch`, the price DBC opens the DAMM v2 pool at, and out of
/// anyone's reach. No graph runs until the launch's identity authorizes one.
pub fn handle_init_autopilot(ctx: Context<InitAutopilot>) -> Result<()> {
    let launch = launchpad::read_launch(&ctx.accounts.launch)?;
    let dbc_config = &ctx.accounts.dbc_config;
    require_keys_eq!(
        dbc_config.key(),
        launch.dbc_config,
        AutopilotError::InvalidDbcConfig
    );
    let ref_sqrt_price =
        external::migration_sqrt_price(dbc_config.owner, &dbc_config.try_borrow_data()?)?;

    let ap = &mut ctx.accounts.autopilot;
    ap.version = Autopilot::VERSION;
    ap.bump = ctx.bumps.autopilot;
    ap.treasury_bump = ctx.bumps.treasury;
    ap.launch = ctx.accounts.launch.key();
    ap.ref_sqrt_price = ref_sqrt_price;
    emit!(AutopilotInitialized {
        autopilot: ap.key(),
        launch: ap.launch,
        treasury: ctx.accounts.treasury.key(),
        ref_sqrt_price,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct InitAutopilot<'info> {
    /// Anyone: pays the autopilot's and the treasury wSOL account's rent.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: a launchpad `Launch`, read by layout (`launchpad::read_launch`).
    pub launch: UncheckedAccount<'info>,

    /// CHECK: the launch's DBC config, read by layout
    /// (`external::migration_sqrt_price`).
    pub dbc_config: UncheckedAccount<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + Autopilot::INIT_SPACE,
        seeds = [AUTOPILOT_SEED, launch.key().as_ref()],
        bump,
    )]
    pub autopilot: Box<Account<'info, Autopilot>>,

    /// CHECK: the treasury authority PDA; owns no lamports and signs only
    /// this program's CPIs.
    #[account(seeds = [TREASURY_SEED, launch.key().as_ref()], bump)]
    pub treasury: UncheckedAccount<'info>,

    #[account(address = WSOL_MINT @ AutopilotError::InvalidRecipientAccounts)]
    pub wsol_mint: Box<InterfaceAccount<'info, Mint>>,

    /// The treasury's wSOL account (created if `distribute` has not yet).
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = wsol_mint,
        associated_token::authority = treasury,
        associated_token::token_program = token_program,
    )]
    pub treasury_wsol: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::Token2022,
    token_interface::{Mint, TokenAccount},
};

use crate::{
    constants::*,
    error::AutopilotError,
    events::MintBound,
    launchpad::{self, certificate},
    state::Autopilot,
};

/// Permissionless, once, after the launch went live: bind the autopilot to
/// the launch's certified mint and create the treasury's token account. The
/// certificate must be the launchpad's for this launch and mint with every
/// safety check set. (The pool is bound after migration: `bind_pool`.)
pub fn handle_bind_mint(ctx: Context<BindMint>) -> Result<()> {
    let launch = launchpad::read_launch(&ctx.accounts.launch)?;
    require!(launch.live, AutopilotError::LaunchNotLive);
    let mint = ctx.accounts.mint.key();
    require_keys_eq!(mint, launch.base_mint, AutopilotError::InvalidCertificate);
    let cert = &ctx.accounts.certificate;
    launchpad::check_certificate(
        cert.owner,
        &cert.try_borrow_data()?,
        &ctx.accounts.launch.key(),
        &mint,
    )?;

    let ap = &mut ctx.accounts.autopilot;
    ap.mint = mint;
    emit!(MintBound {
        autopilot: ap.key(),
        mint,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct BindMint<'info> {
    /// Anyone: pays the treasury token account's rent.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [AUTOPILOT_SEED, launch.key().as_ref()],
        bump = autopilot.bump,
        constraint = autopilot.mint == Pubkey::default() @ AutopilotError::MintAlreadyBound,
    )]
    pub autopilot: Box<Account<'info, Autopilot>>,

    /// CHECK: the launchpad `Launch`, read by layout.
    pub launch: UncheckedAccount<'info>,

    /// CHECK: `["certificate", mint]` under the launchpad, read by layout
    /// (`launchpad::check_certificate`).
    #[account(
        seeds = [certificate::SEED, mint.key().as_ref()],
        bump,
        seeds::program = LAUNCHPAD_PROGRAM_ID,
    )]
    pub certificate: UncheckedAccount<'info>,

    /// The launch's mint (Token-2022).
    #[account(mint::token_program = token_2022_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: the treasury authority PDA.
    #[account(seeds = [TREASURY_SEED, launch.key().as_ref()], bump = autopilot.treasury_bump)]
    pub treasury: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = treasury,
        associated_token::token_program = token_2022_program,
    )]
    pub treasury_token: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

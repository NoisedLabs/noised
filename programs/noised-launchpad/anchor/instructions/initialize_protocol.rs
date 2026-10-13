use anchor_lang::prelude::*;

use crate::{
    constants::{MAX_PLATFORM_FEE_BPS, PROTOCOL_SEED, WSOL_MINT},
    error::LaunchpadError,
    events::ProtocolInitialized,
    pq,
    program::NoisedLaunchpad,
    state::Protocol,
};

/// One-time init, gated on the program's upgrade authority so it cannot be
/// front-run. There is no instruction that changes `Protocol` afterwards.
///
/// The treasury must be an existing Noised PQ vault of wSOL: `distribute`
/// pays the platform share to its canonical wSOL ATA, the vault's own token
/// account, which only the vault's hash-based signature can move.
pub fn handle_initialize_protocol(
    ctx: Context<InitializeProtocol>,
    platform_fee_bps: u16,
) -> Result<()> {
    let treasury = ctx.accounts.treasury.key();
    require!(
        platform_fee_bps <= MAX_PLATFORM_FEE_BPS
            && pq::is_vault_of(&ctx.accounts.treasury, &WSOL_MINT)?,
        LaunchpadError::InvalidProtocolParams
    );
    let protocol = &mut ctx.accounts.protocol;
    protocol.version = Protocol::VERSION;
    protocol.bump = ctx.bumps.protocol;
    protocol.treasury = treasury;
    protocol.platform_fee_bps = platform_fee_bps;
    emit!(ProtocolInitialized {
        treasury,
        platform_fee_bps,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + Protocol::INIT_SPACE,
        seeds = [PROTOCOL_SEED],
        bump,
    )]
    pub protocol: Account<'info, Protocol>,

    /// CHECK: the treasury: an existing PQ vault of wSOL (checked in the
    /// handler by owner, discriminator, version and mint).
    pub treasury: UncheckedAccount<'info>,

    #[account(
        constraint = program.programdata_address()? == Some(program_data.key())
            @ LaunchpadError::NotUpgradeAuthority,
    )]
    pub program: Program<'info, NoisedLaunchpad>,

    #[account(
        constraint = program_data.upgrade_authority_address == Some(authority.key())
            @ LaunchpadError::NotUpgradeAuthority,
    )]
    pub program_data: Account<'info, ProgramData>,

    pub system_program: Program<'info, System>,
}

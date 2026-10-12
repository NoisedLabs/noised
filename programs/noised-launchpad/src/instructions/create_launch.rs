use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

use crate::{
    constants::*,
    dbc_params, dynamic_bonding_curve,
    error::LaunchpadError,
    events::LaunchCreated,
    policy,
    state::{Launch, LaunchParams, LaunchStatus, Protocol},
};

/// Validate the creator's parameters against the safety policy and create the
/// launch's DBC transfer-hook config with every other field fixed. The
/// launch names its creator's post-quantum identity (`params.pq_identity`,
/// covered by `params_hash`); it can go live only once that identity has
/// attested it (`attest_launch`), inside the window it signed. Its address
/// is `["launch", creator, launch_seed]`.
pub fn handle_create_launch(
    ctx: Context<CreateLaunch>,
    launch_seed: [u8; 32],
    params: LaunchParams,
) -> Result<()> {
    let launch_key = ctx.accounts.launch.key();
    let launch_authority = ctx.accounts.launch_authority.key();
    let (batch_authority, batch_bump) =
        Pubkey::find_program_address(&[BATCH_SEED, launch_key.as_ref()], &crate::ID);
    let validated = policy::validate(&params, &[launch_authority, batch_authority])?;

    let mut encoded = Vec::new();
    params.serialize(&mut encoded)?;
    let params_hash = solana_sha256_hasher::hash(&encoded).to_bytes();

    let config_bump = ctx.bumps.dbc_config;
    let config_seeds: &[&[u8]] = &[DBC_CONFIG_SEED, launch_key.as_ref(), &[config_bump]];
    let a = &ctx.accounts;
    dynamic_bonding_curve::cpi::create_config_with_transfer_hook(
        CpiContext::new_with_signer(
            DBC_PROGRAM_ID,
            dynamic_bonding_curve::cpi::accounts::CreateConfigWithTransferHook {
                config: a.dbc_config.to_account_info(),
                fee_claimer: a.launch_authority.to_account_info(),
                leftover_receiver: a.launch_authority.to_account_info(),
                quote_mint: a.quote_mint.to_account_info(),
                transfer_hook_program: a.hook_program.to_account_info(),
                payer: a.creator.to_account_info(),
                system_program: a.system_program.to_account_info(),
                event_authority: a.dbc_event_authority.to_account_info(),
                program: a.dbc_program.to_account_info(),
            },
            &[config_seeds],
        ),
        dbc_params::config_parameters(&params),
    )?;
    require_keys_eq!(
        *ctx.accounts.dbc_config.owner,
        DBC_PROGRAM_ID,
        LaunchpadError::UnsafeConfig
    );

    let protocol = &ctx.accounts.protocol;
    let launch = &mut ctx.accounts.launch;
    launch.version = Launch::VERSION;
    launch.bump = ctx.bumps.launch;
    launch.authority_bump = ctx.bumps.launch_authority;
    launch.batch_bump = batch_bump;
    launch.config_bump = config_bump;
    launch.status = LaunchStatus::Configured;
    launch.launch_seed = launch_seed;
    launch.creator = ctx.accounts.creator.key();
    launch.dbc_config = ctx.accounts.dbc_config.key();
    launch.launch_authority = launch_authority;
    launch.batch_authority = batch_authority;
    launch.treasury = protocol.treasury;
    launch.platform_fee_bps = protocol.platform_fee_bps;
    launch.recipients = validated.recipients;
    launch.recipient_count = validated.recipient_count;
    launch.token_decimal = params.token_decimal;
    launch.migration_quote_threshold = params.migration_quote_threshold;
    launch.migration_fee_option = params.migration_fee_option;
    launch.open_delay_secs = params.open_delay_secs;
    launch.guard_secs = params.guard_secs;
    launch.max_wallet_bps = params.max_wallet_bps;
    launch.max_buy_bps = params.max_buy_bps;
    launch.p2p_locked = params.p2p_locked;
    launch.batch_wallet_cap = params.batch_wallet_cap;
    launch.batch_total_cap = validated.batch_total_cap;
    launch.params_hash = params_hash;
    launch.pq_identity = params.pq_identity;

    emit!(LaunchCreated {
        launch: launch_key,
        creator: launch.creator,
        dbc_config: launch.dbc_config,
        params_hash,
        platform_fee_bps: launch.platform_fee_bps,
        pq_identity: launch.pq_identity,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(launch_seed: [u8; 32])]
pub struct CreateLaunch<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(seeds = [PROTOCOL_SEED], bump = protocol.bump)]
    pub protocol: Box<Account<'info, Protocol>>,

    /// `["launch", creator, launch_seed]`: a creator's own address space,
    /// so nobody can take the address another creator's launch is meant for.
    #[account(
        init,
        payer = creator,
        space = 8 + Launch::INIT_SPACE,
        seeds = [LAUNCH_SEED, creator.key().as_ref(), launch_seed.as_ref()],
        bump,
    )]
    pub launch: Box<Account<'info, Launch>>,

    /// CHECK: PDA without data; DBC fee claimer, leftover receiver and pool creator.
    #[account(seeds = [AUTHORITY_SEED, launch.key().as_ref()], bump)]
    pub launch_authority: UncheckedAccount<'info>,

    /// CHECK: PDA address of the DBC config; DBC creates it with this PDA as signer.
    #[account(mut, seeds = [DBC_CONFIG_SEED, launch.key().as_ref()], bump)]
    pub dbc_config: UncheckedAccount<'info>,

    #[account(address = WSOL_MINT @ LaunchpadError::AccountMismatch)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: the Noised Launch Guard hook program.
    #[account(address = noised_hook::ID @ LaunchpadError::AccountMismatch, executable)]
    pub hook_program: UncheckedAccount<'info>,

    /// CHECK: Meteora DBC.
    #[account(address = DBC_PROGRAM_ID @ LaunchpadError::AccountMismatch, executable)]
    pub dbc_program: UncheckedAccount<'info>,

    /// CHECK: DBC event authority PDA.
    #[account(address = DBC_EVENT_AUTHORITY @ LaunchpadError::AccountMismatch)]
    pub dbc_event_authority: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

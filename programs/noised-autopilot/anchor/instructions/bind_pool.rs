use anchor_lang::prelude::*;

use crate::{constants::*, error::AutopilotError, events::PoolBound, external, state::Autopilot};

/// Permissionless, once, after DBC migrated the launch's curve: bind the
/// autopilot to the DAMM v2 pool DBC created, from then on the only pool a
/// buyback trades on and the price the autopilot observes. From this point
/// the launch counts as graduated (ON_GRADUATED, GRADUATED, buybacks).
///
/// The pool is identified by how it was made, not by an address fixed in
/// advance: DBC migrates through any DAMM v2 config whose fields match the
/// launch's migration fee option, but every config it can use has DBC's pool
/// authority as its only pool creator. So `damm_config` must be such a
/// config (`external::check_migration_config`) and `damm_pool` its pool of
/// `(mint, wSOL)`, existing: the pool DBC's migration created for this
/// launch's curve, whose LP the launchpad holds permanently locked. No other
/// pool (a pool anyone made for the same pair under another config, with
/// liquidity they could withdraw) can be bound.
pub fn handle_bind_pool(ctx: Context<BindPool>) -> Result<()> {
    let config = &ctx.accounts.damm_config;
    external::check_migration_config(config.owner, &config.try_borrow_data()?)?;
    let mint = ctx.accounts.autopilot.mint;
    let pool = &ctx.accounts.damm_pool;
    require_keys_eq!(
        pool.key(),
        external::pool_address(&config.key(), &mint),
        AutopilotError::InvalidPool
    );
    external::read_pool(pool.owner, &pool.try_borrow_data()?, &mint)?
        .ok_or(AutopilotError::NotGraduated)?;

    let (damm_pool, damm_config) = (pool.key(), config.key());
    let ap = &mut ctx.accounts.autopilot;
    ap.damm_pool = damm_pool;
    emit!(PoolBound {
        autopilot: ap.key(),
        damm_pool,
        damm_config,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct BindPool<'info> {
    #[account(
        mut,
        seeds = [AUTOPILOT_SEED, autopilot.launch.as_ref()],
        bump = autopilot.bump,
        constraint = autopilot.mint != Pubkey::default() @ AutopilotError::MintNotBound,
        constraint = autopilot.damm_pool == Pubkey::default() @ AutopilotError::PoolAlreadyBound,
    )]
    pub autopilot: Box<Account<'info, Autopilot>>,

    /// CHECK: the DAMM v2 config DBC migrated through, read by layout
    /// (`external::check_migration_config`).
    pub damm_config: UncheckedAccount<'info>,

    /// CHECK: its pool of the launch's mint and wSOL, read by layout
    /// (`external::read_pool`).
    pub damm_pool: UncheckedAccount<'info>,
}

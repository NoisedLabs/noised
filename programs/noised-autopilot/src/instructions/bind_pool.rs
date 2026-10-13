use alloc::boxed::Box;

use pinocchio::ProgramResult;

use crate::processor::*;
use crate::{error::AutopilotError, events::PoolBound, external, state::Autopilot, Pubkey};

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
///
/// Accounts (`BindPool`): autopilot (writable), damm_config, damm_pool
/// (both read by layout).
pub fn bind_pool(mut accounts: Accounts) -> ProgramResult {
    log_instruction("Instruction: BindPool");
    let (autopilot, mut ap) = accounts.account::<Box<Autopilot>>(AUTOPILOT)?;
    let config = accounts.unchecked(DAMM_CONFIG)?;
    let pool = accounts.unchecked(DAMM_POOL)?;

    // [A] autopilot: seeds = [AUTOPILOT_SEED, autopilot.launch], bump =
    // autopilot.bump; mut; constraint = autopilot.mint != Pubkey::default()
    // @ MintNotBound; constraint = autopilot.damm_pool == Pubkey::default()
    // @ PoolAlreadyBound.
    check_autopilot(autopilot, &ap, &ap.launch)?;
    check_autopilot_constraint(ap.mint != Pubkey::default(), AutopilotError::MintNotBound)?;
    check_autopilot_constraint(
        ap.damm_pool == Pubkey::default(),
        AutopilotError::PoolAlreadyBound,
    )?;

    // Handler.
    external::check_migration_config(config.owner(), &config.try_borrow()?)?;
    let mint = ap.mint;
    require_keys_eq!(
        *pool.address(),
        external::pool_address(config.address(), &mint),
        AutopilotError::InvalidPool
    );
    external::read_pool(pool.owner(), &pool.try_borrow()?, &mint)?
        .ok_or(AutopilotError::NotGraduated)?;

    let (damm_pool, damm_config) = (*pool.address(), *config.address());
    ap.damm_pool = damm_pool;
    PoolBound {
        autopilot: *autopilot.address(),
        damm_pool,
        damm_config,
    }
    .emit();

    // Exit.
    write_autopilot(autopilot, &ap)
}

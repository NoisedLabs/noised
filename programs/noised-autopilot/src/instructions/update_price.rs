use alloc::boxed::Box;

use noised_onchain::accounts::check_keys;
use pinocchio::ProgramResult;

use crate::processor::*;
use crate::{
    error::AutopilotError, events::ReferencePriceUpdated, external, reference, state::Autopilot,
    Pubkey,
};

/// Permissionless, any time after graduation, free (no tip: it moves no
/// value): observe the pool's price (`reference::observe`) and move the
/// reference toward what the observations of the window agree on
/// (`reference::follow`). A buyback needs observations spanning at least a
/// minute: a keeper calls this, then runs a minute later. Every observation
/// also caps the next buybacks at the lowest price seen, so anyone can
/// protect the treasury after the market falls by calling it once.
///
/// Accounts (`UpdatePrice`): autopilot (writable), damm_pool (the launch's
/// DAMM v2 pool, read by layout).
pub fn update_price(mut accounts: Accounts) -> ProgramResult {
    log_instruction("Instruction: UpdatePrice");
    let (autopilot, mut ap) = accounts.account::<Box<Autopilot>>(AUTOPILOT)?;
    let pool = accounts.unchecked(DAMM_POOL)?;

    // [A] autopilot: seeds = [AUTOPILOT_SEED, autopilot.launch], bump =
    // autopilot.bump; mut; constraint = autopilot.damm_pool !=
    // Pubkey::default() @ NotGraduated. damm_pool: address =
    // autopilot.damm_pool @ InvalidPool.
    check_autopilot(autopilot, &ap, &ap.launch)?;
    check_autopilot_constraint(
        ap.damm_pool != Pubkey::default(),
        AutopilotError::NotGraduated,
    )?;
    check_keys::<P>(
        pool.address(),
        &ap.damm_pool,
        AutopilotError::InvalidPool.code(),
        DAMM_POOL,
    )?;

    // Handler.
    let now = now()?;
    let spot = {
        let data = pool.try_borrow()?;
        external::read_pool(pool.owner(), &data, &ap.mint)?
    }
    .ok_or(AutopilotError::InvalidPool)?
    .sqrt_price;
    let mut price = ap.price_state();
    let old = price.reference;
    reference::observe(&mut price.observations, now, spot);
    let seen = reference::seen(&price.observations, now);
    reference::follow(&mut price, seen, now);
    ap.set_price_state(&price);
    ReferencePriceUpdated {
        autopilot: *autopilot.address(),
        old_sqrt_price: old,
        new_sqrt_price: price.reference,
        spot_sqrt_price: spot,
    }
    .emit();

    // Exit.
    write_autopilot(autopilot, &ap)
}

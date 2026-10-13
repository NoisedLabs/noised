use anchor_lang::prelude::*;

use crate::{
    constants::*, error::AutopilotError, events::ReferencePriceUpdated, external, reference,
    state::Autopilot,
};

/// Permissionless, any time after graduation, free (no tip: it moves no
/// value): observe the pool's price (`reference::observe`) and move the
/// reference toward what the observations of the window agree on
/// (`reference::follow`). A buyback needs observations spanning at least a
/// minute: a keeper calls this, then runs a minute later. Every observation
/// also caps the next buybacks at the lowest price seen, so anyone can
/// protect the treasury after the market falls by calling it once.
pub fn handle_update_price(ctx: Context<UpdatePrice>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let ap: &mut Autopilot = &mut ctx.accounts.autopilot;
    let spot = {
        let info = ctx.accounts.damm_pool.to_account_info();
        let data = info.try_borrow_data()?;
        external::read_pool(info.owner, &data, &ap.mint)?
    }
    .ok_or(AutopilotError::InvalidPool)?
    .sqrt_price;
    let mut price = ap.price_state();
    let old = price.reference;
    reference::observe(&mut price.observations, now, spot);
    let seen = reference::seen(&price.observations, now);
    reference::follow(&mut price, seen, now);
    ap.set_price_state(&price);
    emit!(ReferencePriceUpdated {
        autopilot: ctx.accounts.autopilot.key(),
        old_sqrt_price: old,
        new_sqrt_price: price.reference,
        spot_sqrt_price: spot,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct UpdatePrice<'info> {
    #[account(
        mut,
        seeds = [AUTOPILOT_SEED, autopilot.launch.as_ref()],
        bump = autopilot.bump,
        constraint = autopilot.damm_pool != Pubkey::default() @ AutopilotError::NotGraduated,
    )]
    pub autopilot: Box<Account<'info, Autopilot>>,

    /// CHECK: the launch's DAMM v2 pool, read by layout.
    #[account(address = autopilot.damm_pool @ AutopilotError::InvalidPool)]
    pub damm_pool: UncheckedAccount<'info>,
}

//! Events. Anchor's `emit!` is `sol_log_data` of one slice: the event's
//! 8-byte discriminator (`sha256("event:<Name>")[..8]`) followed by its
//! fields in Borsh ([`crate::args::Writer`] builds it). `emit_cpi!` (the
//! `event-cpi` feature) instead invokes the program itself with
//! [`EVENT_IX_TAG_LE`] and that payload, signed by the event authority PDA.

use alloc::vec::Vec;

use pinocchio::{
    cpi::{Seed, Signer},
    instruction::InstructionAccount,
    AccountView, Address, ProgramResult,
};

use crate::{error::anchor, error::fail, error::fail_keys, same, sys, Program};

/// Anchor's `EVENT_IX_TAG` (`0x1d9acb512ea545e4`), little-endian: the
/// instruction tag of a self-CPI event. A program built without `event-cpi`
/// answers it with `EventInstructionStub`.
pub const EVENT_IX_TAG_LE: [u8; 8] = [228, 69, 165, 46, 81, 203, 154, 29];

/// Seed of the event authority PDA (`[b"__event_authority"]`).
pub const EVENT_AUTHORITY_SEED: &[u8] = b"__event_authority";

/// Anchor's name of the event authority account in errors.
pub const EVENT_AUTHORITY: &str = "event_authority";

/// `emit!(event)`: `sol_log_data` of the discriminator and Borsh fields.
#[inline]
pub fn emit(data: &[u8]) {
    sys::log_data(data)
}

/// `emit_cpi!(event)`: invoke the program itself (`P::ID`) with
/// `EVENT_IX_TAG_LE ++ data`, the event authority as the only, read-only,
/// signer account, signed with `[EVENT_AUTHORITY_SEED, bump]`. The
/// instruction must also carry the program account (Anchor's `program`
/// field) so the runtime can find the callee.
pub fn emit_cpi<P: Program>(event_authority: &AccountView, bump: u8, data: &[u8]) -> ProgramResult {
    let mut ix_data = Vec::with_capacity(EVENT_IX_TAG_LE.len() + data.len());
    ix_data.extend_from_slice(&EVENT_IX_TAG_LE);
    ix_data.extend_from_slice(data);
    let bump = [bump];
    let seeds = [Seed::from(EVENT_AUTHORITY_SEED), Seed::from(&bump)];
    sys::invoke(
        &P::ID,
        &[InstructionAccount::readonly_signer(
            event_authority.address(),
        )],
        &ix_data,
        &[event_authority],
        &[Signer::from(&seeds)],
    )
}

/// The `event-cpi` instruction handler (`__event_dispatch`): the first
/// account must sign (`ConstraintSigner`) and be the event authority
/// `authority` (`ConstraintSeeds`, with both keys). No account at all is
/// `NotEnoughAccountKeys` (`next_account_info`), not Anchor's 3005.
pub fn event_dispatch<P: Program>(accounts: &[AccountView], authority: &Address) -> ProgramResult {
    let Some(given) = accounts.first() else {
        return Err(pinocchio::error::ProgramError::NotEnoughAccountKeys);
    };
    if !given.is_signer() {
        return Err(fail::<P>(anchor::CONSTRAINT_SIGNER, Some(EVENT_AUTHORITY)));
    }
    if !same(given.address(), authority) {
        return Err(fail_keys::<P>(
            anchor::CONSTRAINT_SEEDS,
            Some(EVENT_AUTHORITY),
            given.address(),
            authority,
        ));
    }
    Ok(())
}

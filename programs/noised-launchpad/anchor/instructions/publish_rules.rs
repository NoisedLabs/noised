use anchor_lang::prelude::*;
use noised_rules::RuleSet;

use crate::{
    constants::*,
    error::LaunchpadError,
    events::RulesPublished,
    pq,
    state::{Launch, LaunchRules, LaunchStatus},
};

/// Permissionless: write a launch's creator rules (PXR1 bytes) whole, at
/// `["rules", launch, rules_hash(bytes)]`, once they verify for the launch's
/// guard (`noised_rules::RuleSet::verify` with `guard_secs`; `InvalidRules`
/// otherwise). A client publishes them (from the throwaway key that then
/// sends `attest_launch`) and waits for confirmation before it sends the
/// attestation, which attests only rules that exist.
///
/// The address is the content, so the instruction is idempotent: a record
/// already there holds exactly these bytes, and a retry or a racing relayer
/// succeeds without writing. An address pre-funded by anyone is taken over.
/// Records are never modified or closed. Anyone may publish any rules under
/// a launch while it is configured; only the ones its identity signs are
/// ever used.
pub fn handle_publish_rules(ctx: Context<PublishRules>, bytes: Vec<u8>) -> Result<()> {
    require!(
        RuleSet::verify(&bytes, ctx.accounts.launch.guard_secs).is_ok(),
        LaunchpadError::InvalidRules
    );
    let launch_key = ctx.accounts.launch.key();
    let rules_key = ctx.accounts.rules.key();
    let record = &mut ctx.accounts.rules;
    if record.version != 0 {
        // Published already: the address is the hash of these bytes.
        return Ok(());
    }
    let rules_hash = pq::rules_hash(&bytes);
    // At most 1,228 bytes (verified).
    let len = bytes.len() as u16;
    record.version = LaunchRules::VERSION;
    record.bump = ctx.bumps.rules;
    record.launch = launch_key;
    record.rules_hash = rules_hash;
    record.bytes = bytes;
    emit!(RulesPublished {
        launch: launch_key,
        rules: rules_key,
        rules_hash,
        len,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(bytes: Vec<u8>)]
pub struct PublishRules<'info> {
    /// Anyone (in practice the throwaway key of the attestation): pays the
    /// fee and the record's rent.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// The launch the rules are for; rules are published before it goes
    /// live, and verified for its guard.
    #[account(
        constraint = launch.status == LaunchStatus::Configured @ LaunchpadError::WrongLaunchState,
    )]
    pub launch: Box<Account<'info, Launch>>,

    /// The record, at the address its content hashes to: created whole here
    /// (an account pre-funded by anyone is taken over), or already there
    /// with exactly this content.
    #[account(
        init_if_needed,
        payer = payer,
        space = LaunchRules::space(bytes.len()),
        seeds = [RULES_SEED, launch.key().as_ref(), &pq::rules_hash(&bytes)],
        bump,
    )]
    pub rules: Box<Account<'info, LaunchRules>>,

    pub system_program: Program<'info, System>,
}

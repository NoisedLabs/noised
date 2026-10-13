//! `publish_rules(bytes)`.

use noised_onchain::{args::Reader, sysvar::Rent, ProgramResult, Seed};
use noised_rules::RuleSet;

use crate::{
    constants::*,
    discriminator,
    error::LaunchpadError,
    events::RulesPublished,
    pq,
    processor::{
        check_seeds, check_status, check_writable, did_not_deserialize, init_if_needed,
        log_instruction, require, write_back_parts, Accounts, PAYER, SYSTEM_PROGRAM,
    },
    state::{LaunchRules, LaunchRulesRef, LaunchStatus},
};

const RULES: &str = "rules";

/// Whether an existing record decodes as a `LaunchRules` (Anchor's
/// `Account::try_from`).
fn decodes(data: &[u8]) -> bool {
    LaunchRulesRef::read(data).is_some()
}

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
///
/// Accounts: payer (signer, writable), launch, rules (writable, the
/// record's PDA, created if needed), system_program.
pub fn process(mut accounts: Accounts, args: &[u8]) -> ProgramResult {
    log_instruction("Instruction: PublishRules");
    let Some(bytes) = Reader::new(args).bytes() else {
        return Err(did_not_deserialize());
    };

    let payer = accounts.signer(PAYER)?;
    let (launch, launch_state) = accounts.launch()?;
    let rules = accounts.init()?;
    accounts.program(&noised_onchain::ids::SYSTEM_PROGRAM_ID, SYSTEM_PROGRAM)?;

    // [A] rules: init_if_needed, payer = payer, space =
    // LaunchRules::space(bytes.len()), seeds = [RULES_SEED, launch,
    // rules_hash(bytes)], bump; then mut and rent exemption.
    let rent = Rent::get()?;
    let rules_hash = pq::rules_hash(bytes);
    let launch_key = *launch.address();
    let bump = check_seeds(
        rules,
        &[RULES_SEED, launch_key.as_ref(), &rules_hash],
        RULES,
    )?;
    let bump_seed = [bump];
    let existed = init_if_needed(
        payer,
        rules,
        LaunchRules::space(bytes.len()),
        &rent,
        &[
            Seed::from(RULES_SEED),
            Seed::from(launch_key.as_ref()),
            Seed::from(&rules_hash),
            Seed::from(&bump_seed),
        ],
        RULES,
        &discriminator::LAUNCH_RULES,
        decodes,
    )?;

    // [A] payer: mut. launch: constraint = launch.status == Configured @
    // WrongLaunchState.
    check_writable(payer, PAYER)?;
    check_status(&launch_state, LaunchStatus::Configured)?;

    // Handler.
    require(
        RuleSet::verify(
            bytes,
            launch_state.u32(crate::state::launch_offsets::GUARD_SECS),
        )
        .is_ok(),
        LaunchpadError::InvalidRules,
    )?;
    if existed && rules.try_borrow()?.get(LaunchRules::VERSION_OFFSET) != Some(&0) {
        // Published already: the address is the hash of these bytes (and
        // writing the record back would not change a byte).
        return Ok(());
    }
    // At most 1,228 bytes (verified).
    let len = bytes.len() as u16;
    RulesPublished::log(&launch_key, rules.address(), &rules_hash, len);

    // Exit: the record, whole: discriminator, version, bump, launch, rules
    // hash, then the bytes in Borsh.
    write_back_parts(
        rules,
        RULES,
        &[
            &discriminator::LAUNCH_RULES,
            &[LaunchRules::VERSION, bump],
            launch_key.as_ref(),
            &rules_hash,
            &(bytes.len() as u32).to_le_bytes(),
            bytes,
        ],
    )
}

use noised_onchain::{
    accounts::{check_keys, check_mut, check_rent_exempt, init_program_account, write_back},
    ids::{ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID},
    pda::check_seeds,
    sysvar::Rent,
    token::{init_associated_token_account, AssociatedToken},
};
use pinocchio::{
    cpi::{Seed, Signer},
    ProgramResult,
};

use crate::processor::*;
use crate::{
    constants::*, error::AutopilotError, events::AutopilotInitialized, external, launchpad,
    state::Autopilot, ID,
};

/// Permissionless, once per launch (configured or live): create the
/// launch's autopilot and its treasury's wSOL account. The reference price
/// starts at the launch's migration price, read from its DBC config: fixed
/// at `create_launch`, the price DBC opens the DAMM v2 pool at, and out of
/// anyone's reach. No graph runs until the launch's identity authorizes one.
///
/// Accounts (`InitAutopilot`): payer (signer, writable; pays the
/// autopilot's and the treasury wSOL account's rent), launch (a launchpad
/// `Launch`, read by layout), dbc_config (the launch's DBC config, read by
/// layout), autopilot (writable, PDA `["autopilot", launch]`, created),
/// treasury (PDA `["treasury", launch]`), wsol_mint, treasury_wsol
/// (writable, the treasury's wSOL ATA, created if missing), token_program,
/// associated_token_program, system_program.
pub fn init_autopilot(mut accounts: Accounts) -> ProgramResult {
    log_instruction("Instruction: InitAutopilot");
    let payer = accounts.signer(PAYER)?;
    let launch_info = accounts.unchecked(LAUNCH)?;
    let dbc_config = accounts.unchecked(DBC_CONFIG)?;
    let autopilot = accounts.next(None)?;
    let treasury = accounts.unchecked(TREASURY)?;
    let (wsol_mint, _) = accounts.mint(WSOL_MINT_FIELD)?;
    let treasury_wsol = accounts.next(None)?;
    let token_program = accounts.program(&TOKEN_PROGRAM_ID, TOKEN_PROGRAM)?;
    accounts.program(&ASSOCIATED_TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM)?;
    let system_program = accounts.program(&SYSTEM_PROGRAM_ID, SYSTEM_PROGRAM)?;
    let launch_key = launch_info.address();

    // [A] autopilot: init, payer = payer, space = 8 + Autopilot::INIT_SPACE,
    // seeds = [AUTOPILOT_SEED, launch.key()], bump; then mut and rent
    // exemption.
    let rent = Rent::get()?;
    let bump = check_seeds::<P>(
        autopilot,
        &[AUTOPILOT_SEED, launch_key.as_ref()],
        &ID,
        AUTOPILOT,
    )?;
    let bump_seed = [bump];
    init_program_account::<P>(
        payer,
        autopilot,
        Autopilot::LEN,
        &rent,
        &[Signer::from(&[
            Seed::from(AUTOPILOT_SEED),
            Seed::from(launch_key.as_ref()),
            Seed::from(&bump_seed),
        ])],
        AUTOPILOT,
    )?;
    check_rent_exempt::<P>(autopilot, &rent, AUTOPILOT)?;

    // [A] treasury_wsol: init_if_needed, payer = payer,
    // associated_token::mint = wsol_mint, associated_token::authority =
    // treasury, associated_token::token_program = token_program, then mut
    // and rent exemption. Anyone may have created it first (`distribute`).
    init_associated_token_account::<P, true>(
        &AssociatedToken {
            payer,
            account: treasury_wsol,
            authority: treasury,
            mint: wsol_mint,
            token_program,
            system_program,
        },
        &rent,
        TREASURY_WSOL,
    )?;

    // [A] duplicate mutable accounts: treasury_wsol is the only candidate
    // (autopilot is a plain init). Then payer: mut; treasury: seeds =
    // [TREASURY_SEED, launch.key()], bump; wsol_mint: address = WSOL_MINT @
    // InvalidRecipientAccounts.
    check_mut::<P>(payer, PAYER)?;
    let treasury_bump = check_seeds::<P>(
        treasury,
        &[TREASURY_SEED, launch_key.as_ref()],
        &ID,
        TREASURY,
    )?;
    check_keys::<P>(
        wsol_mint.address(),
        &WSOL_MINT,
        AutopilotError::InvalidRecipientAccounts.code(),
        WSOL_MINT_FIELD,
    )?;

    // Handler.
    let launch = launchpad::read_launch(launch_info)?;
    require_keys_eq!(
        *dbc_config.address(),
        launch.dbc_config,
        AutopilotError::InvalidDbcConfig
    );
    let ref_sqrt_price =
        external::migration_sqrt_price(dbc_config.owner(), &dbc_config.try_borrow()?)?;

    AutopilotInitialized {
        autopilot: *autopilot.address(),
        launch: *launch_key,
        treasury: *treasury.address(),
        ref_sqrt_price,
    }
    .emit();

    // Exit: the account as `init` left it (zeroed), with the version, the
    // bumps, the launch and the reference price set.
    write_back::<P, { Autopilot::LEN }>(autopilot, AUTOPILOT, |data| {
        Autopilot::write_new(data, bump, treasury_bump, launch_key, ref_sqrt_price)
    })
}

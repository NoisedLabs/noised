use alloc::boxed::Box;

use noised_onchain::{
    accounts::{check_distinct, check_mut},
    ids::{ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID},
    pda::check_seeds,
    sysvar::Rent,
    token::{check_mint_token_program, init_associated_token_account, AssociatedToken},
};
use pinocchio::ProgramResult;

use crate::processor::*;
use crate::{
    constants::*,
    error::AutopilotError,
    events::MintBound,
    launchpad::{self, certificate},
    state::Autopilot,
    Pubkey,
};

/// Permissionless, once, after the launch went live: bind the autopilot to
/// the launch's certified mint and create the treasury's token account. The
/// certificate must be the launchpad's for this launch and mint with every
/// safety check set. (The pool is bound after migration: `bind_pool`.)
///
/// Accounts (`BindMint`): payer (signer, writable; pays the treasury token
/// account's rent), autopilot (writable), launch, certificate
/// (`["certificate", mint]` under the launchpad, read by layout), mint (the
/// launch's Token-2022 mint), treasury, treasury_token (writable, the
/// treasury's ATA of the mint, created if missing), token_2022_program,
/// associated_token_program, system_program.
pub fn bind_mint(mut accounts: Accounts) -> ProgramResult {
    log_instruction("Instruction: BindMint");
    let payer = accounts.signer(PAYER)?;
    let (autopilot, mut ap) = accounts.account::<Box<Autopilot>>(AUTOPILOT)?;
    let launch_info = accounts.unchecked(LAUNCH)?;
    let cert = accounts.unchecked(CERTIFICATE)?;
    let (mint_info, _) = accounts.mint(MINT)?;
    let treasury = accounts.unchecked(TREASURY)?;
    let treasury_token = accounts.next(None)?;
    let token_2022_program = accounts.program(&TOKEN_2022_PROGRAM_ID, TOKEN_2022_PROGRAM)?;
    accounts.program(&ASSOCIATED_TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM)?;
    let system_program = accounts.program(&SYSTEM_PROGRAM_ID, SYSTEM_PROGRAM)?;

    // [A] treasury_token: init_if_needed, payer = payer,
    // associated_token::mint = mint, associated_token::authority = treasury,
    // associated_token::token_program = token_2022_program, then mut and
    // rent exemption.
    let rent = Rent::get()?;
    init_associated_token_account::<P, true>(
        &AssociatedToken {
            payer,
            account: treasury_token,
            authority: treasury,
            mint: mint_info,
            token_program: token_2022_program,
            system_program,
        },
        &rent,
        TREASURY_TOKEN,
    )?;

    // [A] duplicate mutable accounts: autopilot, treasury_token.
    check_distinct::<P>(&[(autopilot, AUTOPILOT), (treasury_token, TREASURY_TOKEN)])?;
    // [A] payer: mut.
    check_mut::<P>(payer, PAYER)?;
    // [A] autopilot: seeds = [AUTOPILOT_SEED, launch.key()], bump =
    // autopilot.bump; mut; constraint = autopilot.mint == Pubkey::default()
    // @ MintAlreadyBound.
    check_autopilot(autopilot, &ap, launch_info.address())?;
    check_autopilot_constraint(
        ap.mint == Pubkey::default(),
        AutopilotError::MintAlreadyBound,
    )?;
    // [A] certificate: seeds = [certificate::SEED, mint.key()], bump,
    // seeds::program = LAUNCHPAD_PROGRAM_ID.
    check_seeds::<P>(
        cert,
        &[certificate::SEED, mint_info.address().as_ref()],
        &LAUNCHPAD_PROGRAM_ID,
        CERTIFICATE,
    )?;
    // [A] mint: mint::token_program = token_2022_program.
    check_mint_token_program::<P>(mint_info, token_2022_program)?;
    // [A] treasury: seeds = [TREASURY_SEED, launch.key()], bump =
    // autopilot.treasury_bump.
    check_treasury(treasury, launch_info.address(), ap.treasury_bump)?;

    // Handler.
    let launch = launchpad::read_launch(launch_info)?;
    require!(launch.live, AutopilotError::LaunchNotLive);
    let mint = *mint_info.address();
    require_keys_eq!(mint, launch.base_mint, AutopilotError::InvalidCertificate);
    launchpad::check_certificate(
        cert.owner(),
        &cert.try_borrow()?,
        launch_info.address(),
        &mint,
    )?;

    ap.mint = mint;
    MintBound {
        autopilot: *autopilot.address(),
        mint,
    }
    .emit();

    // Exit.
    write_autopilot(autopilot, &ap)
}

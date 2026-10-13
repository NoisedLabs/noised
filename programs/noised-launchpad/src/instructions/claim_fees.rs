//! `claim_fees()` and `claim_surplus()`.

use noised_onchain::{
    accounts::check_distinct,
    ids::{
        ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
    },
    sysvar::Rent,
    token::{init_associated_token_account, AssociatedToken},
    ProgramResult, Seed, Signer,
};

use crate::{
    checks,
    constants::*,
    error::{raise, LaunchpadError},
    events::FeesClaimed,
    external::dbc,
    processor::{
        check_address_mismatch, check_program_address, check_status, check_writable,
        launch_has_one, log_instruction, math_overflow, Accounts, ASSOCIATED_TOKEN_PROGRAM,
        BASE_MINT, BASE_VAULT, DBC_CONFIG, DBC_EVENT_AUTHORITY_FIELD, DBC_POOL_AUTHORITY_FIELD,
        DBC_PROGRAM, LAUNCH_AUTHORITY, P, PAYER, POOL, QUOTE_MINT, QUOTE_VAULT, SYSTEM_PROGRAM,
        TOKEN_2022_PROGRAM, TOKEN_PROGRAM,
    },
    state::{launch_offsets as at, LaunchStatus},
    token_util,
};

const AUTHORITY_BASE_ATA: &str = "authority_base_ata";
const AUTHORITY_QUOTE_ATA: &str = "authority_quote_ata";

/// Permissionless: claim the partner trading fees (wSOL only, the config
/// collects fees in quote) into the launch authority's wSOL account.
///
/// Accounts: payer (signer, writable), launch, launch_authority, dbc_config,
/// pool, base_vault, quote_vault (writable), base_mint, quote_mint,
/// authority_base_ata, authority_quote_ata (the launch authority's ATAs,
/// created if needed), dbc_pool_authority, dbc_program, dbc_event_authority,
/// token_program, token_2022_program, associated_token_program,
/// system_program.
pub fn process_claim_fees(mut accounts: Accounts) -> ProgramResult {
    log_instruction("Instruction: ClaimFees");
    let payer = accounts.signer(PAYER)?;
    let (launch, launch_state) = accounts.launch()?;
    let launch_authority = accounts.unchecked(LAUNCH_AUTHORITY)?;
    let dbc_config = accounts.unchecked(DBC_CONFIG)?;
    let pool = accounts.unchecked(POOL)?;
    let base_vault = accounts.unchecked(BASE_VAULT)?;
    let quote_vault = accounts.unchecked(QUOTE_VAULT)?;
    let (base_mint, _) = accounts.mint(BASE_MINT)?;
    let (quote_mint, _) = accounts.mint(QUOTE_MINT)?;
    let authority_base_ata = accounts.init()?;
    let authority_quote_ata = accounts.init()?;
    let dbc_pool_authority = accounts.unchecked(DBC_POOL_AUTHORITY_FIELD)?;
    let dbc_program = accounts.unchecked(DBC_PROGRAM)?;
    let dbc_event_authority = accounts.unchecked(DBC_EVENT_AUTHORITY_FIELD)?;
    let token_program = accounts.program(&TOKEN_PROGRAM_ID, TOKEN_PROGRAM)?;
    let token_2022_program = accounts.program(&TOKEN_2022_PROGRAM_ID, TOKEN_2022_PROGRAM)?;
    accounts.program(&ASSOCIATED_TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM)?;
    let system_program = accounts.program(&SYSTEM_PROGRAM_ID, SYSTEM_PROGRAM)?;

    // [A] authority_base_ata: init_if_needed, associated_token::mint =
    // base_mint, authority = launch_authority, token_program =
    // token_2022_program. authority_quote_ata: init_if_needed,
    // associated_token::mint = quote_mint, authority = launch_authority,
    // token_program = token_program.
    let rent = Rent::get()?;
    init_associated_token_account::<P, true>(
        &AssociatedToken {
            payer,
            account: authority_base_ata,
            authority: launch_authority,
            mint: base_mint,
            token_program: token_2022_program,
            system_program,
        },
        &rent,
        AUTHORITY_BASE_ATA,
    )?;
    let quote_ata = init_associated_token_account::<P, true>(
        &AssociatedToken {
            payer,
            account: authority_quote_ata,
            authority: launch_authority,
            mint: quote_mint,
            token_program,
            system_program,
        },
        &rent,
        AUTHORITY_QUOTE_ATA,
    )?;

    // [A] duplicate mutable accounts: the two ATAs. payer: mut. launch:
    // has_one = pool, base_mint, dbc_config, launch_authority (@
    // AccountMismatch), constraint = status == Live @ WrongLaunchState. pool,
    // base_vault, quote_vault: mut. quote_mint, dbc_pool_authority,
    // dbc_event_authority: address @ AccountMismatch. dbc_program: address @
    // AccountMismatch, executable.
    check_distinct::<P>(&[
        (authority_base_ata, AUTHORITY_BASE_ATA),
        (authority_quote_ata, AUTHORITY_QUOTE_ATA),
    ])?;
    check_writable(payer, PAYER)?;
    launch_has_one(&launch_state, at::POOL, pool)?;
    launch_has_one(&launch_state, at::BASE_MINT, base_mint)?;
    launch_has_one(&launch_state, at::DBC_CONFIG, dbc_config)?;
    launch_has_one(&launch_state, at::LAUNCH_AUTHORITY, launch_authority)?;
    check_status(&launch_state, LaunchStatus::Live)?;
    check_writable(pool, POOL)?;
    check_writable(base_vault, BASE_VAULT)?;
    check_writable(quote_vault, QUOTE_VAULT)?;
    check_address_mismatch(quote_mint, &WSOL_MINT, QUOTE_MINT)?;
    check_address_mismatch(
        dbc_pool_authority,
        &DBC_POOL_AUTHORITY,
        DBC_POOL_AUTHORITY_FIELD,
    )?;
    check_program_address(dbc_program, &DBC_PROGRAM_ID, DBC_PROGRAM)?;
    check_address_mismatch(
        dbc_event_authority,
        &DBC_EVENT_AUTHORITY,
        DBC_EVENT_AUTHORITY_FIELD,
    )?;

    // Handler.
    let before = quote_ata.amount;
    let launch_key = *launch.address();
    let bump = [launch_state.byte(at::AUTHORITY_BUMP)];
    dbc::claim_trading_fee2(
        &dbc::ClaimTradingFee2 {
            pool_authority: dbc_pool_authority,
            config: dbc_config,
            pool,
            token_a_account: authority_base_ata,
            token_b_account: authority_quote_ata,
            base_vault,
            quote_vault,
            base_mint,
            quote_mint,
            fee_claimer: launch_authority,
            token_base_program: token_2022_program,
            token_quote_program: token_program,
            event_authority: dbc_event_authority,
            program: dbc_program,
        },
        // Base fees are never collected by this config; never move base here.
        0,
        u64::MAX,
        &[Signer::from(&[
            Seed::from(AUTHORITY_SEED),
            Seed::from(launch_key.as_ref()),
            Seed::from(&bump),
        ])],
    )?;
    let claimed = token_util::reload_amount(authority_quote_ata)?
        .checked_sub(before)
        .ok_or_else(math_overflow)?;
    if claimed == 0 {
        return Err(raise(LaunchpadError::NothingToDo));
    }
    FeesClaimed::log(&launch_key, claimed, false);
    Ok(())
}

/// Permissionless, after the curve completes: withdraw the partner and
/// creator surplus (both roles are the launch authority) into its wSOL account.
///
/// Accounts: payer (signer, writable), launch, launch_authority, dbc_config,
/// pool, quote_vault (writable), quote_mint, authority_quote_ata (the launch
/// authority's wSOL ATA, created if needed), dbc_pool_authority,
/// dbc_program, dbc_event_authority, token_program,
/// associated_token_program, system_program.
pub fn process_claim_surplus(mut accounts: Accounts) -> ProgramResult {
    log_instruction("Instruction: ClaimSurplus");
    let payer = accounts.signer(PAYER)?;
    let (launch, launch_state) = accounts.launch()?;
    let launch_authority = accounts.unchecked(LAUNCH_AUTHORITY)?;
    let dbc_config = accounts.unchecked(DBC_CONFIG)?;
    let pool = accounts.unchecked(POOL)?;
    let quote_vault = accounts.unchecked(QUOTE_VAULT)?;
    let (quote_mint, _) = accounts.mint(QUOTE_MINT)?;
    let authority_quote_ata = accounts.init()?;
    let dbc_pool_authority = accounts.unchecked(DBC_POOL_AUTHORITY_FIELD)?;
    let dbc_program = accounts.unchecked(DBC_PROGRAM)?;
    let dbc_event_authority = accounts.unchecked(DBC_EVENT_AUTHORITY_FIELD)?;
    let token_program = accounts.program(&TOKEN_PROGRAM_ID, TOKEN_PROGRAM)?;
    accounts.program(&ASSOCIATED_TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM)?;
    let system_program = accounts.program(&SYSTEM_PROGRAM_ID, SYSTEM_PROGRAM)?;

    // [A] authority_quote_ata: init_if_needed, associated_token::mint =
    // quote_mint, authority = launch_authority, token_program =
    // token_program.
    let rent = Rent::get()?;
    let quote_ata = init_associated_token_account::<P, true>(
        &AssociatedToken {
            payer,
            account: authority_quote_ata,
            authority: launch_authority,
            mint: quote_mint,
            token_program,
            system_program,
        },
        &rent,
        AUTHORITY_QUOTE_ATA,
    )?;

    // [A] duplicate mutable accounts: authority_quote_ata only. payer: mut.
    // launch: has_one = pool, dbc_config, launch_authority (@
    // AccountMismatch), constraint = status == Live @ WrongLaunchState. pool,
    // quote_vault: mut. quote_mint, dbc_pool_authority, dbc_event_authority:
    // address @ AccountMismatch. dbc_program: address @ AccountMismatch,
    // executable.
    check_writable(payer, PAYER)?;
    launch_has_one(&launch_state, at::POOL, pool)?;
    launch_has_one(&launch_state, at::DBC_CONFIG, dbc_config)?;
    launch_has_one(&launch_state, at::LAUNCH_AUTHORITY, launch_authority)?;
    check_status(&launch_state, LaunchStatus::Live)?;
    check_writable(pool, POOL)?;
    check_writable(quote_vault, QUOTE_VAULT)?;
    check_address_mismatch(quote_mint, &WSOL_MINT, QUOTE_MINT)?;
    check_address_mismatch(
        dbc_pool_authority,
        &DBC_POOL_AUTHORITY,
        DBC_POOL_AUTHORITY_FIELD,
    )?;
    check_program_address(dbc_program, &DBC_PROGRAM_ID, DBC_PROGRAM)?;
    check_address_mismatch(
        dbc_event_authority,
        &DBC_EVENT_AUTHORITY,
        DBC_EVENT_AUTHORITY_FIELD,
    )?;

    // Handler.
    let (partner_done, creator_done) = checks::dbc_pool_surplus_withdrawn(pool)?;
    if partner_done && creator_done {
        return Err(raise(LaunchpadError::NothingToDo));
    }

    let before = quote_ata.amount;
    let launch_key = *launch.address();
    let bump = [launch_state.byte(at::AUTHORITY_BUMP)];
    let seeds = [
        Seed::from(AUTHORITY_SEED),
        Seed::from(launch_key.as_ref()),
        Seed::from(&bump),
    ];
    let accounts = dbc::WithdrawSurplus {
        pool_authority: dbc_pool_authority,
        config: dbc_config,
        virtual_pool: pool,
        token_quote_account: authority_quote_ata,
        quote_vault,
        quote_mint,
        claimer: launch_authority,
        token_quote_program: token_program,
        event_authority: dbc_event_authority,
        program: dbc_program,
    };
    if !partner_done {
        dbc::withdraw_surplus(
            &accounts,
            &dbc::PARTNER_WITHDRAW_SURPLUS,
            &[Signer::from(&seeds)],
        )?;
    }
    if !creator_done {
        dbc::withdraw_surplus(
            &accounts,
            &dbc::CREATOR_WITHDRAW_SURPLUS,
            &[Signer::from(&seeds)],
        )?;
    }
    let claimed = token_util::reload_amount(authority_quote_ata)?
        .checked_sub(before)
        .ok_or_else(math_overflow)?;
    FeesClaimed::log(&launch_key, claimed, true);
    Ok(())
}

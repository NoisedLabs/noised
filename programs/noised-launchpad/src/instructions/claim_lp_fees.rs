//! `claim_lp_fees()`.

use noised_onchain::{
    accounts::check_distinct,
    ids::{
        ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
    },
    sysvar::Rent,
    token::{
        check_token_authority, check_token_token_program, init_associated_token_account,
        AssociatedToken,
    },
    ProgramResult, Seed, Signer,
};

use crate::{
    checks,
    constants::*,
    error::{raise, LaunchpadError},
    events::LpFeesClaimed,
    external::damm,
    processor::{
        check_address_mismatch, check_program_address, check_status, check_writable,
        launch_has_one, log_instruction, math_overflow, require_named, Accounts,
        ASSOCIATED_TOKEN_PROGRAM, BASE_MINT, LAUNCH_AUTHORITY, P, PAYER, QUOTE_MINT,
        SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM,
    },
    state::{launch_offsets as at, LaunchStatus},
    token_util,
};

const DAMM_POOL: &str = "damm_pool";
const POSITION: &str = "position";
const POSITION_NFT_ACCOUNT: &str = "position_nft_account";
const TOKEN_A_VAULT: &str = "token_a_vault";
const TOKEN_B_VAULT: &str = "token_b_vault";
const AUTHORITY_BASE_ATA: &str = "authority_base_ata";
const AUTHORITY_QUOTE_ATA: &str = "authority_quote_ata";
const DAMM_POOL_AUTHORITY: &str = "damm_pool_authority";
const DAMM_PROGRAM: &str = "damm_program";
const DAMM_EVENT_AUTHORITY: &str = "damm_event_authority";

/// Permissionless, after migration: claim the fees of an LP position held by
/// the launch authority in a DAMM v2 pool of (base mint, wSOL). Base tokens
/// land in the launch authority's base account (burned by `distribute`),
/// wSOL in its wSOL account.
///
/// Accounts: payer (signer, writable), launch, launch_authority, damm_pool,
/// position (writable), position_nft_account, token_a_vault, token_b_vault
/// (writable), base_mint, quote_mint, authority_base_ata,
/// authority_quote_ata (created if needed), damm_pool_authority,
/// damm_program, damm_event_authority, token_program, token_2022_program,
/// associated_token_program, system_program.
pub fn process(mut accounts: Accounts) -> ProgramResult {
    log_instruction("Instruction: ClaimLpFees");
    let payer = accounts.signer(PAYER)?;
    let (launch, launch_state) = accounts.launch()?;
    let launch_authority = accounts.unchecked(LAUNCH_AUTHORITY)?;
    let damm_pool = accounts.unchecked(DAMM_POOL)?;
    let position = accounts.unchecked(POSITION)?;
    let (position_nft_account, nft) = accounts.token_account(POSITION_NFT_ACCOUNT)?;
    let token_a_vault = accounts.unchecked(TOKEN_A_VAULT)?;
    let token_b_vault = accounts.unchecked(TOKEN_B_VAULT)?;
    let (base_mint, _) = accounts.mint(BASE_MINT)?;
    let (quote_mint, _) = accounts.mint(QUOTE_MINT)?;
    let authority_base_ata = accounts.init()?;
    let authority_quote_ata = accounts.init()?;
    let damm_pool_authority = accounts.unchecked(DAMM_POOL_AUTHORITY)?;
    let damm_program = accounts.unchecked(DAMM_PROGRAM)?;
    let damm_event_authority = accounts.unchecked(DAMM_EVENT_AUTHORITY)?;
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
    let base_ata = init_associated_token_account::<P, true>(
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
    // has_one = base_mint, launch_authority (@ AccountMismatch), constraint =
    // status == Live @ WrongLaunchState. position: mut.
    // position_nft_account: constraint = amount == 1 @ InvalidPosition,
    // token::authority = launch_authority, token::token_program =
    // token_2022_program. token_a_vault, token_b_vault: mut. quote_mint,
    // damm_pool_authority, damm_event_authority: address @ AccountMismatch.
    // damm_program: address @ AccountMismatch, executable.
    check_distinct::<P>(&[
        (authority_base_ata, AUTHORITY_BASE_ATA),
        (authority_quote_ata, AUTHORITY_QUOTE_ATA),
    ])?;
    check_writable(payer, PAYER)?;
    launch_has_one(&launch_state, at::BASE_MINT, base_mint)?;
    launch_has_one(&launch_state, at::LAUNCH_AUTHORITY, launch_authority)?;
    check_status(&launch_state, LaunchStatus::Live)?;
    check_writable(position, POSITION)?;
    require_named(
        nft.amount == 1,
        LaunchpadError::InvalidPosition,
        POSITION_NFT_ACCOUNT,
    )?;
    check_token_authority::<P>(&nft, launch_authority.address(), POSITION_NFT_ACCOUNT)?;
    check_token_token_program::<P>(
        position_nft_account,
        token_2022_program,
        POSITION_NFT_ACCOUNT,
    )?;
    check_writable(token_a_vault, TOKEN_A_VAULT)?;
    check_writable(token_b_vault, TOKEN_B_VAULT)?;
    check_address_mismatch(quote_mint, &WSOL_MINT, QUOTE_MINT)?;
    check_address_mismatch(
        damm_pool_authority,
        &DAMM_V2_POOL_AUTHORITY,
        DAMM_POOL_AUTHORITY,
    )?;
    check_program_address(damm_program, &DAMM_V2_PROGRAM_ID, DAMM_PROGRAM)?;
    check_address_mismatch(
        damm_event_authority,
        &DAMM_V2_EVENT_AUTHORITY,
        DAMM_EVENT_AUTHORITY,
    )?;

    // Handler.
    checks::verify_lp_position(damm_pool, position, &nft.mint, base_mint.address())?;
    let base_before = base_ata.amount;
    let quote_before = quote_ata.amount;
    let launch_key = *launch.address();
    let bump = [launch_state.byte(at::AUTHORITY_BUMP)];
    damm::claim_position_fee(
        &damm::ClaimPositionFee {
            pool_authority: damm_pool_authority,
            pool: damm_pool,
            position,
            token_a_account: authority_base_ata,
            token_b_account: authority_quote_ata,
            token_a_vault,
            token_b_vault,
            token_a_mint: base_mint,
            token_b_mint: quote_mint,
            position_nft_account,
            signer: launch_authority,
            token_a_program: token_2022_program,
            token_b_program: token_program,
            event_authority: damm_event_authority,
            program: damm_program,
        },
        &[Signer::from(&[
            Seed::from(AUTHORITY_SEED),
            Seed::from(launch_key.as_ref()),
            Seed::from(&bump),
        ])],
    )?;
    let base_after = token_util::reload_amount(authority_base_ata)?;
    let quote_after = token_util::reload_amount(authority_quote_ata)?;
    let base_amount = base_after
        .checked_sub(base_before)
        .ok_or_else(math_overflow)?;
    let quote_amount = quote_after
        .checked_sub(quote_before)
        .ok_or_else(math_overflow)?;
    if !(base_amount > 0 || quote_amount > 0) {
        return Err(raise(LaunchpadError::NothingToDo));
    }
    LpFeesClaimed::log(&launch_key, position.address(), base_amount, quote_amount);
    Ok(())
}

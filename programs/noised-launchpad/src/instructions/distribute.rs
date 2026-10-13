//! `distribute()`.

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
    constants::*,
    error::{fail_keys, raise, LaunchpadError},
    events::Distributed,
    math,
    processor::{
        check_address_mismatch, check_status, check_writable, launch_has_one, log_instruction,
        math_overflow, Accounts, ASSOCIATED_TOKEN_PROGRAM, BASE_MINT, LAUNCH_AUTHORITY, P, PAYER,
        QUOTE_MINT, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM,
    },
    state::{launch_offsets as at, LaunchStatus},
    token_util::{self, AtaCreator},
};

const TREASURY: &str = "treasury";
const AUTHORITY_QUOTE_ATA: &str = "authority_quote_ata";
const AUTHORITY_BASE_ATA: &str = "authority_base_ata";
const TREASURY_QUOTE_ATA: &str = "treasury_quote_ata";

/// Permissionless: route the launch authority's whole wSOL balance by the
/// rules fixed at `create_launch` (platform share, then recipients) and burn
/// its whole base-token balance.
///
/// Remaining accounts: `[wallet_i, wsol_ata_i]` for every stored recipient,
/// in order. Missing ATAs are created (payer = caller).
///
/// Accounts: payer (signer, writable), launch, launch_authority, treasury,
/// base_mint (writable), quote_mint, authority_quote_ata,
/// authority_base_ata (the launch authority's ATAs, created if needed),
/// treasury_quote_ata (writable), token_program, token_2022_program,
/// associated_token_program, system_program.
pub fn process(mut accounts: Accounts) -> ProgramResult {
    log_instruction("Instruction: Distribute");
    let payer = accounts.signer(PAYER)?;
    let (launch, launch_state) = accounts.launch()?;
    let launch_authority = accounts.unchecked(LAUNCH_AUTHORITY)?;
    let treasury = accounts.unchecked(TREASURY)?;
    let (base_mint, base_decimals) = accounts.mint(BASE_MINT)?;
    let (quote_mint, quote_decimals) = accounts.mint(QUOTE_MINT)?;
    let authority_quote_ata = accounts.init()?;
    let authority_base_ata = accounts.init()?;
    let treasury_quote_ata = accounts.unchecked(TREASURY_QUOTE_ATA)?;
    let token_program = accounts.program(&TOKEN_PROGRAM_ID, TOKEN_PROGRAM)?;
    let token_2022_program = accounts.program(&TOKEN_2022_PROGRAM_ID, TOKEN_2022_PROGRAM)?;
    accounts.program(&ASSOCIATED_TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM)?;
    let system_program = accounts.program(&SYSTEM_PROGRAM_ID, SYSTEM_PROGRAM)?;
    let remaining = accounts.remaining();

    // [A] authority_quote_ata: init_if_needed, associated_token::mint =
    // quote_mint, authority = launch_authority, token_program =
    // token_program. authority_base_ata: init_if_needed,
    // associated_token::mint = base_mint, authority = launch_authority,
    // token_program = token_2022_program.
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

    // [A] duplicate mutable accounts: base_mint, the two ATAs. payer: mut.
    // launch: has_one = base_mint, launch_authority, treasury (@
    // AccountMismatch), constraint = status == Live @ WrongLaunchState.
    // base_mint: mut. quote_mint: address = WSOL_MINT @ AccountMismatch.
    // treasury_quote_ata: mut.
    check_distinct::<P>(&[
        (base_mint, BASE_MINT),
        (authority_quote_ata, AUTHORITY_QUOTE_ATA),
        (authority_base_ata, AUTHORITY_BASE_ATA),
    ])?;
    check_writable(payer, PAYER)?;
    launch_has_one(&launch_state, at::BASE_MINT, base_mint)?;
    launch_has_one(&launch_state, at::LAUNCH_AUTHORITY, launch_authority)?;
    launch_has_one(&launch_state, at::TREASURY, treasury)?;
    check_status(&launch_state, LaunchStatus::Live)?;
    check_writable(base_mint, BASE_MINT)?;
    check_address_mismatch(quote_mint, &WSOL_MINT, QUOTE_MINT)?;
    check_writable(treasury_quote_ata, TREASURY_QUOTE_ATA)?;

    // Handler.
    let count = usize::from(launch_state.byte(at::RECIPIENT_COUNT));
    let stored = launch_state.recipients();
    // At most `MAX_RECIPIENTS` (`create_launch` validated them).
    let recipients = stored
        .get(..count)
        .ok_or_else(|| raise(LaunchpadError::InvalidRecipientAccounts))?;
    if remaining.len() != 2 * count {
        return Err(raise(LaunchpadError::InvalidRecipientAccounts));
    }

    let balance = quote_ata.amount;
    let base_balance = base_ata.amount;
    if !(balance > 0 || base_balance > 0) {
        return Err(raise(LaunchpadError::NothingToDo));
    }

    let split = math::split_fees(balance, launch_state.u16(at::PLATFORM_FEE_BPS), recipients)
        .ok_or_else(math_overflow)?;
    if split.total() != Some(balance) {
        return Err(raise(LaunchpadError::PayoutExceedsEscrow));
    }

    let launch_key = *launch.address();
    let bump = [launch_state.byte(at::AUTHORITY_BUMP)];
    let seeds = [
        Seed::from(AUTHORITY_SEED),
        Seed::from(launch_key.as_ref()),
        Seed::from(&bump),
    ];
    let signers = [Signer::from(&seeds)];
    let creator = AtaCreator {
        payer,
        mint: quote_mint,
        token_program,
        system_program,
    };

    if split.platform > 0 {
        creator.ensure(treasury, treasury_quote_ata)?;
        token_util::transfer_signed(
            token_program,
            quote_mint,
            quote_decimals,
            authority_quote_ata,
            treasury_quote_ata,
            launch_authority,
            split.platform,
            &signers,
            &[],
        )?;
    }

    // `[wallet_i, wsol_ata_i]` pairs, one per recipient (counted above).
    let pairs = remaining.as_chunks::<2>().0;
    for ((recipient, [wallet, ata]), amount) in recipients.iter().zip(pairs).zip(split.recipients) {
        if wallet.address() != &recipient.wallet {
            return Err(fail_keys(
                LaunchpadError::InvalidRecipientAccounts.code(),
                None,
                wallet.address(),
                &recipient.wallet,
            ));
        }
        creator.ensure(wallet, ata)?;
        if amount > 0 {
            token_util::transfer_signed(
                token_program,
                quote_mint,
                quote_decimals,
                authority_quote_ata,
                ata,
                launch_authority,
                amount,
                &signers,
                &[],
            )?;
        }
    }

    // LP fees paid in the launched token are destroyed, never sold.
    if base_balance > 0 {
        token_util::burn_signed(
            token_2022_program,
            base_mint,
            base_decimals,
            authority_base_ata,
            launch_authority,
            base_balance,
            &signers,
        )?;
    }

    let recipients_amount = balance
        .checked_sub(split.platform)
        .ok_or_else(math_overflow)?;
    Distributed::log(&launch_key, split.platform, recipients_amount, base_balance);
    Ok(())
}

//! `claim(owner)`.

use noised_onchain::{
    accounts::check_distinct,
    ids::{
        ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
    },
    sysvar::Clock,
    token::check_associated_token_account,
    AccountView, ProgramResult, Seed, Signer,
};

use crate::{
    constants::*,
    discriminator,
    error::{raise, LaunchpadError},
    events::BatchClaimed,
    hook_accounts, math,
    processor::{
        check_address_mismatch, check_seeds_with_bump, check_status, check_writable,
        did_not_deserialize, launch_has_one, log_instruction, math_overflow, require_keys_named,
        require_named, write_back, write_back_launch, Accounts, ASSOCIATED_TOKEN_PROGRAM,
        BASE_MINT, BATCH_AUTHORITY, LAUNCH, P, PAYER, QUOTE_MINT, SYSTEM_PROGRAM,
        TOKEN_2022_PROGRAM, TOKEN_PROGRAM,
    },
    state::{launch_offsets as at, Commit, LaunchStatus},
    token_util::{self, hook_program_of, AtaCreator},
    Pubkey,
};

const COMMIT: &str = "commit";
const TOKEN_OWNER: &str = "token_owner";
const REFUND_OWNER: &str = "refund_owner";
const BATCH_QUOTE_ESCROW: &str = "batch_quote_escrow";
const BATCH_BASE_ESCROW: &str = "batch_base_escrow";
const REFUND_OWNER_ATA: &str = "refund_owner_ata";
const TOKEN_OWNER_ATA: &str = "token_owner_ata";

/// A required optional account is missing: `AccountMismatch`.
fn required(account: Option<&AccountView>) -> Result<&AccountView, noised_onchain::ProgramError> {
    account.ok_or_else(|| raise(LaunchpadError::AccountMismatch))
}

/// Permissionless: pay one commit its pro-rata share of an executed batch
/// (tokens + unspent wSOL), or its full refund if the batch expired. Funds
/// only ever go to the payout owners the first commit fixed (the committer,
/// or its PQ vaults): tokens to the token owner's canonical base-token ATA,
/// wSOL to the refund owner's canonical wSOL ATA, created if missing. As in
/// `distribute`, their owner field is not compared (`AtaCreator::ensure`):
/// only that owner can reassign its own ATA (a vault never does), so nobody
/// else can block a claim or choose where a share goes.
///
/// Accounts: payer (signer, writable), launch (writable), commit (writable),
/// token_owner, refund_owner, batch_authority, base_mint, quote_mint,
/// batch_quote_escrow (writable), batch_base_escrow (writable, optional),
/// refund_owner_ata (writable, optional), token_owner_ata (writable,
/// optional), token_program, token_2022_program, associated_token_program,
/// system_program; then the mint's transfer-hook accounts.
pub fn process(mut accounts: Accounts, args: &[u8]) -> ProgramResult {
    log_instruction("Instruction: Claim");
    let Some(owner) = args.first_chunk::<32>() else {
        return Err(did_not_deserialize());
    };
    let owner = Pubkey::new_from_array(*owner);

    let payer = accounts.signer(PAYER)?;
    let (launch, mut launch_state) = accounts.launch()?;
    let commit = accounts.account(&discriminator::COMMIT_ACCOUNT, Commit::decodes, COMMIT)?;
    let mut commit_state = Commit::load(commit)?;
    let token_owner = accounts.unchecked(TOKEN_OWNER)?;
    let refund_owner = accounts.unchecked(REFUND_OWNER)?;
    let batch_authority = accounts.unchecked(BATCH_AUTHORITY)?;
    let (base_mint, base_decimals) = accounts.mint(BASE_MINT)?;
    let (quote_mint, quote_decimals) = accounts.mint(QUOTE_MINT)?;
    let (batch_quote_escrow, quote_escrow) = accounts.token_account(BATCH_QUOTE_ESCROW)?;
    let batch_base_escrow = match accounts.optional(Some(BATCH_BASE_ESCROW))? {
        Some(account) => Some((
            account,
            noised_onchain::token::load_token_account::<P>(account, Some(BATCH_BASE_ESCROW))?,
        )),
        None => None,
    };
    let refund_owner_ata = accounts.optional(Some(REFUND_OWNER_ATA))?;
    let token_owner_ata = accounts.optional(Some(TOKEN_OWNER_ATA))?;
    let token_program = accounts.program(&TOKEN_PROGRAM_ID, TOKEN_PROGRAM)?;
    let token_2022_program = accounts.program(&TOKEN_2022_PROGRAM_ID, TOKEN_2022_PROGRAM)?;
    accounts.program(&ASSOCIATED_TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM)?;
    let system_program = accounts.program(&SYSTEM_PROGRAM_ID, SYSTEM_PROGRAM)?;
    let remaining = accounts.remaining();

    // [A] duplicate mutable accounts: launch, commit, batch_quote_escrow,
    // batch_base_escrow (when given). payer: mut. launch: mut, has_one =
    // base_mint, batch_authority (@ AccountMismatch), constraint = status ==
    // Live @ WrongLaunchState. commit: seeds = [COMMIT_SEED, launch, owner],
    // bump = commit.bump; mut; has_one = launch @ AccountMismatch;
    // constraint = commit.owner == owner @ AccountMismatch. token_owner,
    // refund_owner: address = commit.<owner> @ InvalidPayoutOwner.
    // quote_mint: address = WSOL_MINT @ AccountMismatch. batch_quote_escrow,
    // batch_base_escrow (when given): associated_token (.., batch_authority,
    // token program), mut. refund_owner_ata, token_owner_ata (when given):
    // mut.
    match &batch_base_escrow {
        Some((account, _)) => check_distinct::<P>(&[
            (launch, LAUNCH),
            (commit, COMMIT),
            (batch_quote_escrow, BATCH_QUOTE_ESCROW),
            (account, BATCH_BASE_ESCROW),
        ])?,
        None => check_distinct::<P>(&[
            (launch, LAUNCH),
            (commit, COMMIT),
            (batch_quote_escrow, BATCH_QUOTE_ESCROW),
        ])?,
    }
    check_writable(payer, PAYER)?;
    check_writable(launch, LAUNCH)?;
    launch_has_one(&launch_state, at::BASE_MINT, base_mint)?;
    launch_has_one(&launch_state, at::BATCH_AUTHORITY, batch_authority)?;
    check_status(&launch_state, LaunchStatus::Live)?;
    let launch_key = *launch.address();
    check_seeds_with_bump(
        commit,
        &[
            COMMIT_SEED,
            launch_key.as_ref(),
            owner.as_ref(),
            &[commit_state.bump],
        ],
        COMMIT,
    )?;
    check_writable(commit, COMMIT)?;
    require_keys_named(
        &commit_state.launch,
        &launch_key,
        LaunchpadError::AccountMismatch,
        COMMIT,
    )?;
    require_named(
        commit_state.owner == owner,
        LaunchpadError::AccountMismatch,
        COMMIT,
    )?;
    require_keys_named(
        token_owner.address(),
        &commit_state.token_owner,
        LaunchpadError::InvalidPayoutOwner,
        TOKEN_OWNER,
    )?;
    require_keys_named(
        refund_owner.address(),
        &commit_state.refund_owner,
        LaunchpadError::InvalidPayoutOwner,
        REFUND_OWNER,
    )?;
    check_address_mismatch(quote_mint, &WSOL_MINT, QUOTE_MINT)?;
    check_associated_token_account::<P>(
        batch_quote_escrow,
        &quote_escrow,
        batch_authority,
        quote_mint,
        token_program,
        BATCH_QUOTE_ESCROW,
    )?;
    check_writable(batch_quote_escrow, BATCH_QUOTE_ESCROW)?;
    if let Some((account, state)) = &batch_base_escrow {
        check_associated_token_account::<P>(
            account,
            state,
            batch_authority,
            base_mint,
            token_2022_program,
            BATCH_BASE_ESCROW,
        )?;
        check_writable(account, BATCH_BASE_ESCROW)?;
    }
    if let Some(account) = refund_owner_ata {
        check_writable(account, REFUND_OWNER_ATA)?;
    }
    if let Some(account) = token_owner_ata {
        check_writable(account, TOKEN_OWNER_ATA)?;
    }

    // Handler.
    let now = Clock::get()?.unix_timestamp;
    if commit_state.claimed {
        return Err(raise(LaunchpadError::AlreadyClaimed));
    }
    let (tokens, refund, expired, refundable) = if launch_state.flag(at::EXECUTED) {
        let share = math::batch_share(
            commit_state.amount,
            launch_state.u64(at::TOTAL_COMMITTED),
            launch_state.u64(at::QUOTE_SPENT),
            launch_state.u64(at::TOKENS_OUT),
        )
        .ok_or_else(math_overflow)?;
        let unspent = launch_state
            .u64(at::TOTAL_COMMITTED)
            .checked_sub(launch_state.u64(at::QUOTE_SPENT))
            .ok_or_else(math_overflow)?;
        (share.tokens, share.refund, false, unspent)
    } else if now >= launch_state.i64(at::EXECUTE_END_TS) {
        (
            0,
            commit_state.amount,
            true,
            launch_state.u64(at::TOTAL_COMMITTED),
        )
    } else {
        return Err(raise(LaunchpadError::BatchPending));
    };

    // Hard invariant: cumulative payouts never exceed what the batch holds.
    let tokens_claimed = launch_state
        .u64(at::TOKENS_CLAIMED)
        .checked_add(tokens)
        .ok_or_else(math_overflow)?;
    let quote_refunded = launch_state
        .u64(at::QUOTE_REFUNDED)
        .checked_add(refund)
        .ok_or_else(math_overflow)?;
    if !(tokens_claimed <= launch_state.u64(at::TOKENS_OUT) && quote_refunded <= refundable) {
        return Err(raise(LaunchpadError::PayoutExceedsEscrow));
    }

    let batch_bump = [launch_state.byte(at::BATCH_BUMP)];
    let seeds = [
        Seed::from(BATCH_SEED),
        Seed::from(launch_key.as_ref()),
        Seed::from(&batch_bump),
    ];
    let signers = [Signer::from(&seeds)];

    commit_state.claimed = true;
    launch_state.set(at::TOKENS_CLAIMED, &tokens_claimed.to_le_bytes());
    launch_state.set(at::QUOTE_REFUNDED, &quote_refunded.to_le_bytes());

    if tokens > 0 {
        let (escrow, _) = batch_base_escrow
            .as_ref()
            .ok_or_else(|| raise(LaunchpadError::AccountMismatch))?;
        let destination = required(token_owner_ata)?;
        AtaCreator {
            payer,
            mint: base_mint,
            token_program: token_2022_program,
            system_program,
        }
        .ensure(token_owner, destination)?;
        // While the curve runs the hook is active and needs its accounts;
        // transfers out of the batch escrow are exempt from its rules.
        if hook_program_of(base_mint)?.is_some() {
            hook_accounts::validate(remaining, base_mint.address())?;
        }
        token_util::transfer_signed(
            token_2022_program,
            base_mint,
            base_decimals,
            escrow,
            destination,
            batch_authority,
            tokens,
            &signers,
            remaining,
        )?;
    }
    if refund > 0 {
        let destination = required(refund_owner_ata)?;
        AtaCreator {
            payer,
            mint: quote_mint,
            token_program,
            system_program,
        }
        .ensure(refund_owner, destination)?;
        token_util::transfer_signed(
            token_program,
            quote_mint,
            quote_decimals,
            batch_quote_escrow,
            destination,
            batch_authority,
            refund,
            &signers,
            &[],
        )?;
    }

    BatchClaimed::log(
        &launch_key,
        &owner,
        tokens,
        refund,
        expired,
        token_owner.address(),
        refund_owner.address(),
    );

    // Exit: launch, commit.
    write_back_launch(launch, &launch_state)?;
    let mut commit_data = [0u8; Commit::LEN];
    commit_state.write(&mut commit_data);
    write_back(commit, COMMIT, &commit_data)
}

//! `commit(amount)`.

use noised_onchain::{
    accounts::check_distinct,
    ids::{ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID},
    sysvar::{Clock, Rent},
    token::{
        check_token_authority, check_token_mint, check_token_token_program,
        init_associated_token_account, AssociatedToken,
    },
    ProgramResult, Seed,
};

use crate::{
    constants::*,
    discriminator,
    error::{raise_error, LaunchpadError},
    events::Committed,
    pq,
    processor::{
        check_address_mismatch, check_seeds, check_status, check_writable, did_not_deserialize,
        init_if_needed, launch_has_one, log_instruction, math_overflow, require, write_back,
        write_back_launch, Accounts, ASSOCIATED_TOKEN_PROGRAM, BATCH_AUTHORITY, LAUNCH, P,
        QUOTE_MINT, SYSTEM_PROGRAM, TOKEN_PROGRAM,
    },
    state::{launch_offsets as at, Commit, LaunchStatus, PayoutVault},
    token_util,
};

const OWNER: &str = "owner";
const COMMIT: &str = "commit";
const OWNER_QUOTE_ACCOUNT: &str = "owner_quote_account";
const BATCH_QUOTE_ESCROW: &str = "batch_quote_escrow";
const TOKEN_OWNER: &str = "token_owner";
const REFUND_OWNER: &str = "refund_owner";
const PAYOUT_VAULT: &str = "payout_vault";

/// Commit wSOL to the fair-open batch during the commit window.
///
/// The total cap never refuses a commit: an oversubscribed batch buys
/// `batch_total_cap` and refunds the rest pro rata at claim, so committing
/// early (even inside the launch transaction) gives no advantage.
///
/// The first commit fixes who receives the payouts: `token_owner` (the
/// tokens) and `refund_owner` (the unspent or refunded wSOL), each the
/// committer itself or a Noised PQ vault of that mint, so a committer can
/// have its share land straight in post-quantum custody. Later commits must
/// pass the same two accounts, and `claim` (permissionless) pays only them:
/// no key, Ed25519 or other, can redirect a share afterwards.
///
/// Claims are exempt from the Launch Guard, so shares paid to one account
/// would add up past `max_wallet` and around `p2p_locked` while the guard
/// runs. A committer's own wallet receives one commit's share, and that
/// commit is held to `batch_wallet_cap`; a vault can be named by several
/// committers, so its `["payout-vault", launch, vault]` account adds up
/// every commit naming it, and holds them to the same cap together.
///
/// Accounts: owner (signer, writable), launch (writable), commit (writable,
/// PDA `["commit", launch, owner]`, created if needed), batch_authority,
/// quote_mint, owner_quote_account (writable), batch_quote_escrow
/// (writable, the batch authority's wSOL ATA, created if needed),
/// token_program, associated_token_program, system_program, token_owner,
/// refund_owner, payout_vault (writable, PDA `["payout-vault", launch,
/// token_owner]`, created if needed; the program id when the token owner is
/// the committer).
pub fn process(mut accounts: Accounts, args: &[u8]) -> ProgramResult {
    log_instruction("Instruction: Commit");
    let Some(amount) = args.first_chunk::<8>() else {
        return Err(did_not_deserialize());
    };
    let amount = u64::from_le_bytes(*amount);

    let owner = accounts.signer(OWNER)?;
    let (launch, mut launch_state) = accounts.launch()?;
    let commit = accounts.init()?;
    let batch_authority = accounts.unchecked(BATCH_AUTHORITY)?;
    let (quote_mint, decimals) = accounts.mint(QUOTE_MINT)?;
    let (owner_quote_account, owner_quote) = accounts.token_account(OWNER_QUOTE_ACCOUNT)?;
    let batch_quote_escrow = accounts.init()?;
    let token_program = accounts.program(&TOKEN_PROGRAM_ID, TOKEN_PROGRAM)?;
    accounts.program(&ASSOCIATED_TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM)?;
    let system_program = accounts.program(&SYSTEM_PROGRAM_ID, SYSTEM_PROGRAM)?;
    let token_owner = accounts.unchecked(TOKEN_OWNER)?;
    let refund_owner = accounts.unchecked(REFUND_OWNER)?;
    let payout_vault = accounts.optional(None)?;

    // [A] commit: init_if_needed, payer = owner, space = 8 +
    // Commit::INIT_SPACE, seeds = [COMMIT_SEED, launch, owner], bump; then
    // mut and rent exemption.
    let rent = Rent::get()?;
    let launch_key = *launch.address();
    let owner_key = *owner.address();
    let commit_bump = check_seeds(
        commit,
        &[COMMIT_SEED, launch_key.as_ref(), owner_key.as_ref()],
        COMMIT,
    )?;
    let commit_bump_seed = [commit_bump];
    init_if_needed(
        owner,
        commit,
        Commit::LEN,
        &rent,
        &[
            Seed::from(COMMIT_SEED),
            Seed::from(launch_key.as_ref()),
            Seed::from(owner_key.as_ref()),
            Seed::from(&commit_bump_seed),
        ],
        COMMIT,
        &discriminator::COMMIT_ACCOUNT,
        Commit::decodes,
    )?;
    // [A] batch_quote_escrow: init_if_needed, payer = owner,
    // associated_token::mint = quote_mint, associated_token::authority =
    // batch_authority, associated_token::token_program = token_program.
    init_associated_token_account::<P, true>(
        &AssociatedToken {
            payer: owner,
            account: batch_quote_escrow,
            authority: batch_authority,
            mint: quote_mint,
            token_program,
            system_program,
        },
        &rent,
        BATCH_QUOTE_ESCROW,
    )?;
    // [A] payout_vault (when given): init_if_needed, payer = owner, space =
    // 8 + PayoutVault::INIT_SPACE, seeds = [PAYOUT_VAULT_SEED, launch,
    // token_owner], bump; then mut and rent exemption.
    let token_owner_key = *token_owner.address();
    let mut payout_bump = 0;
    if let Some(account) = payout_vault {
        payout_bump = check_seeds(
            account,
            &[
                PAYOUT_VAULT_SEED,
                launch_key.as_ref(),
                token_owner_key.as_ref(),
            ],
            PAYOUT_VAULT,
        )?;
        let bump_seed = [payout_bump];
        init_if_needed(
            owner,
            account,
            PayoutVault::LEN,
            &rent,
            &[
                Seed::from(PAYOUT_VAULT_SEED),
                Seed::from(launch_key.as_ref()),
                Seed::from(token_owner_key.as_ref()),
                Seed::from(&bump_seed),
            ],
            PAYOUT_VAULT,
            &discriminator::PAYOUT_VAULT,
            PayoutVault::decodes,
        )?;
    }

    // [A] duplicate mutable accounts: launch, commit, owner_quote_account,
    // batch_quote_escrow, payout_vault (when given).
    check_distinct::<P>(
        &[
            (launch, LAUNCH),
            (commit, COMMIT),
            (owner_quote_account, OWNER_QUOTE_ACCOUNT),
            (batch_quote_escrow, BATCH_QUOTE_ESCROW),
            (payout_vault.unwrap_or(batch_quote_escrow), PAYOUT_VAULT),
        ][..if payout_vault.is_some() { 5 } else { 4 }],
    )?;
    // [A] owner: mut. launch: mut, has_one = batch_authority @
    // AccountMismatch, constraint = status == Live @ WrongLaunchState.
    // quote_mint: address = WSOL_MINT @ AccountMismatch. owner_quote_account:
    // mut, token::authority = owner, token::mint = quote_mint,
    // token::token_program = token_program.
    check_writable(owner, OWNER)?;
    check_writable(launch, LAUNCH)?;
    launch_has_one(&launch_state, at::BATCH_AUTHORITY, batch_authority)?;
    check_status(&launch_state, LaunchStatus::Live)?;
    check_address_mismatch(quote_mint, &WSOL_MINT, QUOTE_MINT)?;
    check_writable(owner_quote_account, OWNER_QUOTE_ACCOUNT)?;
    check_token_authority::<P>(&owner_quote, owner.address(), OWNER_QUOTE_ACCOUNT)?;
    check_token_mint::<P>(&owner_quote, quote_mint.address(), OWNER_QUOTE_ACCOUNT)?;
    check_token_token_program::<P>(owner_quote_account, token_program, OWNER_QUOTE_ACCOUNT)?;

    // Handler.
    require(amount > 0, LaunchpadError::ZeroAmount)?;
    let now = Clock::get()?.unix_timestamp;
    require(
        now >= launch_state.i64(at::LAUNCH_TS) && now < launch_state.i64(at::COMMIT_END_TS),
        LaunchpadError::NotCommitWindow,
    )?;
    // Defense in depth (audit 4, L-i2): the batch executes only once the
    // commit window closed, so no commit can follow it.
    require(
        !launch_state.flag(at::EXECUTED),
        LaunchpadError::AlreadyExecuted,
    )?;

    let refund_owner_key = *refund_owner.address();
    let mut commit_state = Commit::load(commit)?;
    if commit_state.owner == crate::Pubkey::default() {
        require(
            pq::is_payout_owner(token_owner, &owner_key, &launch_state.key(at::BASE_MINT))
                .map_err(raise_error)?
                && pq::is_payout_owner(refund_owner, &owner_key, &WSOL_MINT)
                    .map_err(raise_error)?,
            LaunchpadError::InvalidPayoutOwner,
        )?;
        commit_state.version = Commit::VERSION;
        commit_state.bump = commit_bump;
        commit_state.launch = launch_key;
        commit_state.owner = owner_key;
        commit_state.token_owner = token_owner_key;
        commit_state.refund_owner = refund_owner_key;
    } else {
        require(
            commit_state.token_owner == token_owner_key
                && commit_state.refund_owner == refund_owner_key,
            LaunchpadError::InvalidPayoutOwner,
        )?;
    }
    let owner_total = commit_state
        .amount
        .checked_add(amount)
        .ok_or_else(math_overflow)?;
    let total = launch_state
        .u64(at::TOTAL_COMMITTED)
        .checked_add(amount)
        .ok_or_else(math_overflow)?;
    let cap = launch_state.u64(at::BATCH_WALLET_CAP);
    require(cap == 0 || owner_total <= cap, LaunchpadError::CapExceeded)?;
    commit_state.amount = owner_total;
    // The tokens' receiving account takes at most one wallet's cap.
    let payout = match (token_owner_key == owner_key, payout_vault) {
        (true, None) => None,
        (false, Some(account)) => {
            let mut record = PayoutVault::load(account)?;
            if record.version == 0 {
                record.version = PayoutVault::VERSION;
                record.bump = payout_bump;
                record.launch = launch_key;
                record.vault = token_owner_key;
            }
            let vault_total = record
                .committed
                .checked_add(amount)
                .ok_or_else(math_overflow)?;
            require(cap == 0 || vault_total <= cap, LaunchpadError::CapExceeded)?;
            record.committed = vault_total;
            Some((account, record))
        }
        _ => return require(false, LaunchpadError::InvalidPayoutOwner),
    };

    token_util::transfer_plain(
        token_program,
        owner_quote_account,
        quote_mint,
        batch_quote_escrow,
        owner,
        amount,
        decimals,
    )?;

    launch_state.set(at::TOTAL_COMMITTED, &total.to_le_bytes());
    Committed::log(
        &launch_key,
        &owner_key,
        amount,
        owner_total,
        total,
        &token_owner_key,
        &refund_owner_key,
    );

    // Exit: launch, commit, payout_vault.
    write_back_launch(launch, &launch_state)?;
    let mut commit_data = [0u8; Commit::LEN];
    commit_state.write(&mut commit_data);
    write_back(commit, COMMIT, &commit_data)?;
    if let Some((account, record)) = payout {
        let mut data = [0u8; PayoutVault::LEN];
        record.write(&mut data);
        write_back(account, PAYOUT_VAULT, &data)?;
    }
    Ok(())
}

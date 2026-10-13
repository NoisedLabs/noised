//! `execute_batch()`.

use noised_onchain::{
    accounts::check_distinct,
    ids::{
        ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
    },
    pda,
    sysvar::{Clock, Rent},
    token::{check_associated_token_account, init_associated_token_account, AssociatedToken},
    ProgramResult, Seed, Signer,
};

use crate::{
    checks,
    constants::{dbc::SWAP_MODE_PARTIAL_FILL, *},
    error::{raise, LaunchpadError},
    events::BatchExecuted,
    external::{dbc, hook},
    hook_accounts,
    processor::{
        check_address_mismatch, check_program_address, check_seeds, check_status, check_writable,
        launch_has_one, log_instruction, math_overflow, write_back_launch, Accounts,
        ASSOCIATED_TOKEN_PROGRAM, BASE_MINT, BASE_VAULT, BATCH_AUTHORITY, DBC_CONFIG,
        DBC_EVENT_AUTHORITY_FIELD, DBC_POOL_AUTHORITY_FIELD, DBC_PROGRAM, HOOK_AUTHORITY,
        HOOK_PROGRAM, LAUNCH, P, PAYER, POOL, QUOTE_MINT, QUOTE_VAULT, SYSTEM_PROGRAM,
        TOKEN_2022_PROGRAM, TOKEN_PROGRAM,
    },
    state::{launch_offsets as at, LaunchStatus},
    token_util,
};

const BATCH_QUOTE_ESCROW: &str = "batch_quote_escrow";
const BATCH_BASE_ESCROW: &str = "batch_base_escrow";
const POLICY: &str = "policy";

/// Permissionless, once: buy for the whole batch in one DBC swap. Nobody
/// else can buy before the batch: until `execute_end_ts` the hook refuses
/// every buy that is not inside this instruction, so the batch gets the
/// opening price and every participant the same average price. Once the
/// batch has bought, this instruction ends the snipe shield at once
/// (`noised_hook::end_snipe_shield`), so a long execution window never
/// delays public trading. An oversubscribed batch spends at most
/// `batch_total_cap`; claims refund the rest pro rata.
///
/// Accounts: payer (signer, writable), launch (writable), batch_authority,
/// dbc_config, pool, base_vault, quote_vault (writable), base_mint
/// (writable), quote_mint, batch_quote_escrow (writable), batch_base_escrow
/// (writable, created if needed), dbc_pool_authority, dbc_program,
/// dbc_event_authority, token_program, token_2022_program,
/// associated_token_program, system_program, hook_authority, policy
/// (writable), hook_program; then the four hook accounts of the swap.
pub fn process(mut accounts: Accounts) -> ProgramResult {
    log_instruction("Instruction: ExecuteBatch");
    let payer = accounts.signer(PAYER)?;
    let (launch, mut launch_state) = accounts.launch()?;
    let batch_authority = accounts.unchecked(BATCH_AUTHORITY)?;
    let dbc_config = accounts.unchecked(DBC_CONFIG)?;
    let pool = accounts.unchecked(POOL)?;
    let base_vault = accounts.unchecked(BASE_VAULT)?;
    let quote_vault = accounts.unchecked(QUOTE_VAULT)?;
    let (base_mint, _) = accounts.mint(BASE_MINT)?;
    let (quote_mint, _) = accounts.mint(QUOTE_MINT)?;
    let (batch_quote_escrow, quote_escrow) = accounts.token_account(BATCH_QUOTE_ESCROW)?;
    let batch_base_escrow = accounts.init()?;
    let dbc_pool_authority = accounts.unchecked(DBC_POOL_AUTHORITY_FIELD)?;
    let dbc_program = accounts.unchecked(DBC_PROGRAM)?;
    let dbc_event_authority = accounts.unchecked(DBC_EVENT_AUTHORITY_FIELD)?;
    let token_program = accounts.program(&TOKEN_PROGRAM_ID, TOKEN_PROGRAM)?;
    let token_2022_program = accounts.program(&TOKEN_2022_PROGRAM_ID, TOKEN_2022_PROGRAM)?;
    accounts.program(&ASSOCIATED_TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM)?;
    let system_program = accounts.program(&SYSTEM_PROGRAM_ID, SYSTEM_PROGRAM)?;
    let hook_authority = accounts.unchecked(HOOK_AUTHORITY)?;
    let policy = accounts.unchecked(POLICY)?;
    let hook_program = accounts.unchecked(HOOK_PROGRAM)?;
    let remaining = accounts.remaining();

    // [A] batch_base_escrow: init_if_needed, payer = payer,
    // associated_token::mint = base_mint, associated_token::authority =
    // batch_authority, associated_token::token_program = token_2022_program.
    let rent = Rent::get()?;
    let base_escrow = init_associated_token_account::<P, true>(
        &AssociatedToken {
            payer,
            account: batch_base_escrow,
            authority: batch_authority,
            mint: base_mint,
            token_program: token_2022_program,
            system_program,
        },
        &rent,
        BATCH_BASE_ESCROW,
    )?;

    // [A] duplicate mutable accounts: launch, base_mint, batch_quote_escrow,
    // batch_base_escrow. payer: mut. launch: mut, has_one = pool, base_mint,
    // dbc_config, batch_authority (@ AccountMismatch), constraint = status
    // == Live @ WrongLaunchState. pool, base_vault, quote_vault, base_mint:
    // mut. quote_mint: address = WSOL_MINT @ AccountMismatch.
    // batch_quote_escrow: associated_token (quote_mint, batch_authority,
    // token_program), mut. dbc_pool_authority, dbc_event_authority: address
    // @ AccountMismatch. dbc_program, hook_program: address @
    // AccountMismatch, executable. hook_authority: seeds =
    // [HOOK_AUTHORITY_SEED], bump. policy: seeds = [POLICY_SEED, base_mint],
    // bump, seeds::program = the hook; mut.
    check_distinct::<P>(&[
        (launch, LAUNCH),
        (base_mint, BASE_MINT),
        (batch_quote_escrow, BATCH_QUOTE_ESCROW),
        (batch_base_escrow, BATCH_BASE_ESCROW),
    ])?;
    check_writable(payer, PAYER)?;
    check_writable(launch, LAUNCH)?;
    launch_has_one(&launch_state, at::POOL, pool)?;
    launch_has_one(&launch_state, at::BASE_MINT, base_mint)?;
    launch_has_one(&launch_state, at::DBC_CONFIG, dbc_config)?;
    launch_has_one(&launch_state, at::BATCH_AUTHORITY, batch_authority)?;
    check_status(&launch_state, LaunchStatus::Live)?;
    check_writable(pool, POOL)?;
    check_writable(base_vault, BASE_VAULT)?;
    check_writable(quote_vault, QUOTE_VAULT)?;
    check_writable(base_mint, BASE_MINT)?;
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
    let hook_bump = check_seeds(hook_authority, &[HOOK_AUTHORITY_SEED], HOOK_AUTHORITY)?;
    let mint_key = *base_mint.address();
    pda::check_seeds::<P>(
        policy,
        &[hook::POLICY_SEED, mint_key.as_ref()],
        &hook::ID,
        POLICY,
    )?;
    check_writable(policy, POLICY)?;
    check_program_address(hook_program, &hook::ID, HOOK_PROGRAM)?;

    // Handler.
    let now = Clock::get()?.unix_timestamp;
    if launch_state.flag(at::EXECUTED) {
        return Err(raise(LaunchpadError::AlreadyExecuted));
    }
    if !(now >= launch_state.i64(at::COMMIT_END_TS) && now < launch_state.i64(at::EXECUTE_END_TS)) {
        return Err(raise(LaunchpadError::NotExecuteWindow));
    }
    let total = launch_state.u64(at::TOTAL_COMMITTED);
    if total == 0 {
        return Err(raise(LaunchpadError::EmptyBatch));
    }
    let amount_in = total.min(launch_state.u64(at::BATCH_TOTAL_CAP));
    // The batch must be the pool's first swap. The hook refuses every other
    // buy until execute_end_ts and nobody holds tokens to sell, so this only
    // fails if something got past the shield: then the batch expires and
    // refunds in full instead of buying at a moved price or fee.
    if checks::dbc_pool_has_swapped(pool)? {
        return Err(raise(LaunchpadError::PoolAlreadyTraded));
    }
    hook_accounts::validate(remaining, &launch_state.key(at::BASE_MINT))?;

    let quote_before = quote_escrow.amount;
    let base_before = base_escrow.amount;

    let launch_key = *launch.address();
    let batch_bump = [launch_state.byte(at::BATCH_BUMP)];
    dbc::swap2_with_transfer_hook(
        &dbc::Swap2 {
            pool_authority: dbc_pool_authority,
            config: dbc_config,
            pool,
            input_token_account: batch_quote_escrow,
            output_token_account: batch_base_escrow,
            base_vault,
            quote_vault,
            base_mint,
            quote_mint,
            payer: batch_authority,
            token_base_program: token_2022_program,
            token_quote_program: token_program,
            event_authority: dbc_event_authority,
            program: dbc_program,
        },
        amount_in,
        // No minimum: the hook guarantees nobody else can buy first.
        0,
        SWAP_MODE_PARTIAL_FILL,
        remaining,
        &[Signer::from(&[
            Seed::from(BATCH_SEED),
            Seed::from(launch_key.as_ref()),
            Seed::from(&batch_bump),
        ])],
    )?;

    let quote_spent = quote_before
        .checked_sub(token_util::reload_amount(batch_quote_escrow)?)
        .ok_or_else(math_overflow)?;
    let tokens_out = token_util::reload_amount(batch_base_escrow)?
        .checked_sub(base_before)
        .ok_or_else(math_overflow)?;
    if quote_spent > amount_in {
        return Err(raise(LaunchpadError::PayoutExceedsEscrow));
    }
    // Committers must never pay for nothing; if this reverts every time the
    // batch expires and everyone is refunded in full.
    if tokens_out == 0 {
        return Err(raise(LaunchpadError::EmptySwap));
    }

    // The batch has bought, as the pool's first swap: the shield has nothing
    // left to protect, so public trading opens now rather than at
    // `execute_end_ts`. The hook only moves the end earlier, only this
    // instruction signs for it (as the top-level instruction, which the hook
    // checks), and only for its own launch's policy. The hook does not read
    // the mint, so this also works when the swap completed the curve and DBC
    // revoked the hook.
    let hook_bump_seed = [hook_bump];
    hook::end_snipe_shield(
        hook_authority,
        policy,
        // Checked by `hook_accounts::validate` above (and by the hook).
        remaining
            .get(hook_accounts::INSTRUCTIONS_SYSVAR_INDEX)
            .ok_or_else(|| raise(LaunchpadError::InvalidHookAccounts))?,
        &[Signer::from(&[
            Seed::from(HOOK_AUTHORITY_SEED),
            Seed::from(&hook_bump_seed),
        ])],
    )?;

    launch_state.set(at::EXECUTED, &[1]);
    launch_state.set(at::QUOTE_SPENT, &quote_spent.to_le_bytes());
    launch_state.set(at::TOKENS_OUT, &tokens_out.to_le_bytes());
    BatchExecuted::log(&launch_key, total, quote_spent, tokens_out);

    // Exit.
    write_back_launch(launch, &launch_state)
}

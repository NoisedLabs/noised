use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::Token,
    token_2022::Token2022,
    token_interface::{Mint, TokenAccount},
};
use noised_hook::state::POLICY_SEED;

use crate::{
    checks,
    constants::{dbc::SWAP_MODE_PARTIAL_FILL, *},
    dynamic_bonding_curve::{
        self,
        types::{AccountsType, RemainingAccountsSlice, SwapParameters2, TransferHookAccountsInfo},
    },
    error::LaunchpadError,
    events::BatchExecuted,
    hook_accounts::{self, HOOK_ACCOUNT_COUNT},
    state::{Launch, LaunchStatus},
};

/// Permissionless, once: buy for the whole batch in one DBC swap. Nobody
/// else can buy before the batch: until `execute_end_ts` the hook refuses
/// every buy that is not inside this instruction, so the batch gets the
/// opening price and every participant the same average price. Once the
/// batch has bought, this instruction ends the snipe shield at once
/// (`noised_hook::end_snipe_shield`), so a long execution window never
/// delays public trading. An oversubscribed batch spends at most
/// `batch_total_cap`; claims refund the rest pro rata.
pub fn handle_execute_batch<'info>(ctx: Context<'info, ExecuteBatch<'info>>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let launch = &ctx.accounts.launch;
    require!(!launch.executed, LaunchpadError::AlreadyExecuted);
    require!(
        now >= launch.commit_end_ts && now < launch.execute_end_ts,
        LaunchpadError::NotExecuteWindow
    );
    let total = launch.total_committed;
    require!(total > 0, LaunchpadError::EmptyBatch);
    let amount_in = total.min(launch.batch_total_cap);
    // The batch must be the pool's first swap. The hook refuses every other
    // buy until execute_end_ts and nobody holds tokens to sell, so this only
    // fails if something got past the shield: then the batch expires and
    // refunds in full instead of buying at a moved price or fee.
    require!(
        !checks::dbc_pool_has_swapped(&ctx.accounts.pool)?,
        LaunchpadError::PoolAlreadyTraded
    );
    hook_accounts::validate(ctx.remaining_accounts, &launch.base_mint)?;

    let quote_before = ctx.accounts.batch_quote_escrow.amount;
    let base_before = ctx.accounts.batch_base_escrow.amount;

    let launch_key = launch.key();
    let batch_bump = [launch.batch_bump];
    let batch_seeds: &[&[u8]] = &[BATCH_SEED, launch_key.as_ref(), &batch_bump];
    let a = &ctx.accounts;
    dynamic_bonding_curve::cpi::swap2_with_transfer_hook(
        CpiContext::new_with_signer(
            DBC_PROGRAM_ID,
            dynamic_bonding_curve::cpi::accounts::Swap2WithTransferHook {
                pool_authority: a.dbc_pool_authority.to_account_info(),
                config: a.dbc_config.to_account_info(),
                pool: a.pool.to_account_info(),
                input_token_account: a.batch_quote_escrow.to_account_info(),
                output_token_account: a.batch_base_escrow.to_account_info(),
                base_vault: a.base_vault.to_account_info(),
                quote_vault: a.quote_vault.to_account_info(),
                base_mint: a.base_mint.to_account_info(),
                quote_mint: a.quote_mint.to_account_info(),
                payer: a.batch_authority.to_account_info(),
                token_base_program: a.token_2022_program.to_account_info(),
                token_quote_program: a.token_program.to_account_info(),
                referral_token_account: None,
                event_authority: a.dbc_event_authority.to_account_info(),
                program: a.dbc_program.to_account_info(),
            },
            &[batch_seeds],
        )
        .with_remaining_accounts(ctx.remaining_accounts.to_vec()),
        SwapParameters2 {
            amount_0: amount_in,
            // No minimum: the hook guarantees nobody else can buy first.
            amount_1: 0,
            swap_mode: SWAP_MODE_PARTIAL_FILL,
        },
        TransferHookAccountsInfo {
            slices: vec![RemainingAccountsSlice {
                accounts_type: AccountsType::TransferHookBase,
                length: HOOK_ACCOUNT_COUNT as u8,
            }],
        },
    )?;

    ctx.accounts.batch_quote_escrow.reload()?;
    ctx.accounts.batch_base_escrow.reload()?;
    let quote_spent = quote_before
        .checked_sub(ctx.accounts.batch_quote_escrow.amount)
        .ok_or(LaunchpadError::MathOverflow)?;
    let tokens_out = ctx
        .accounts
        .batch_base_escrow
        .amount
        .checked_sub(base_before)
        .ok_or(LaunchpadError::MathOverflow)?;
    require!(
        quote_spent <= amount_in,
        LaunchpadError::PayoutExceedsEscrow
    );
    // Committers must never pay for nothing; if this reverts every time the
    // batch expires and everyone is refunded in full.
    require!(tokens_out > 0, LaunchpadError::EmptySwap);

    // The batch has bought, as the pool's first swap: the shield has nothing
    // left to protect, so public trading opens now rather than at
    // `execute_end_ts`. The hook only moves the end earlier, only this
    // instruction signs for it (as the top-level instruction, which the hook
    // checks), and only for its own launch's policy. The hook does not read
    // the mint, so this also works when the swap completed the curve and DBC
    // revoked the hook.
    let hook_bump = [ctx.bumps.hook_authority];
    let hook_seeds: &[&[u8]] = &[HOOK_AUTHORITY_SEED, &hook_bump];
    let a = &ctx.accounts;
    noised_hook::cpi::end_snipe_shield(CpiContext::new_with_signer(
        noised_hook::ID,
        noised_hook::cpi::accounts::EndSnipeShield {
            launchpad_authority: a.hook_authority.to_account_info(),
            policy: a.policy.to_account_info(),
            // Checked by `hook_accounts::validate` above (and by the hook).
            instructions: ctx.remaining_accounts[hook_accounts::INSTRUCTIONS_SYSVAR_INDEX].clone(),
        },
        &[hook_seeds],
    ))?;

    let launch = &mut ctx.accounts.launch;
    launch.executed = true;
    launch.quote_spent = quote_spent;
    launch.tokens_out = tokens_out;
    emit!(BatchExecuted {
        launch: launch_key,
        total_committed: total,
        quote_spent,
        tokens_out,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ExecuteBatch<'info> {
    /// Anyone; pays for the batch base escrow if it does not exist yet.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        has_one = pool @ LaunchpadError::AccountMismatch,
        has_one = base_mint @ LaunchpadError::AccountMismatch,
        has_one = dbc_config @ LaunchpadError::AccountMismatch,
        has_one = batch_authority @ LaunchpadError::AccountMismatch,
        constraint = launch.status == LaunchStatus::Live @ LaunchpadError::WrongLaunchState,
    )]
    pub launch: Box<Account<'info, Launch>>,

    /// CHECK: batch authority PDA bound to `launch`; signs the swap.
    pub batch_authority: UncheckedAccount<'info>,

    /// CHECK: this launch's DBC config (DBC checks it against the pool).
    pub dbc_config: UncheckedAccount<'info>,

    /// CHECK: this launch's DBC pool.
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,

    /// CHECK: DBC checks it equals the pool's base vault.
    #[account(mut)]
    pub base_vault: UncheckedAccount<'info>,

    /// CHECK: DBC checks it equals the pool's quote vault.
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,

    /// Writable: DBC revokes the hook here if this swap completes the curve.
    #[account(mut)]
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(address = WSOL_MINT @ LaunchpadError::AccountMismatch)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = quote_mint,
        associated_token::authority = batch_authority,
        associated_token::token_program = token_program,
    )]
    pub batch_quote_escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = base_mint,
        associated_token::authority = batch_authority,
        associated_token::token_program = token_2022_program,
    )]
    pub batch_base_escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: DBC pool authority.
    #[account(address = DBC_POOL_AUTHORITY @ LaunchpadError::AccountMismatch)]
    pub dbc_pool_authority: UncheckedAccount<'info>,

    /// CHECK: Meteora DBC.
    #[account(address = DBC_PROGRAM_ID @ LaunchpadError::AccountMismatch, executable)]
    pub dbc_program: UncheckedAccount<'info>,

    /// CHECK: DBC event authority PDA.
    #[account(address = DBC_EVENT_AUTHORITY @ LaunchpadError::AccountMismatch)]
    pub dbc_event_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,

    /// CHECK: the only signer `noised_hook::end_snipe_shield` accepts.
    #[account(seeds = [HOOK_AUTHORITY_SEED], bump)]
    pub hook_authority: UncheckedAccount<'info>,

    /// CHECK: this launch's Launch Guard policy, `["policy", base_mint]`
    /// under the hook program, which owns, checks and writes it: its shield
    /// ends once the batch has bought. Writable in the transaction (it is
    /// also among the swap's read-only hook accounts).
    #[account(
        mut,
        seeds = [POLICY_SEED, base_mint.key().as_ref()],
        bump,
        seeds::program = noised_hook::ID,
    )]
    pub policy: UncheckedAccount<'info>,

    /// CHECK: the Noised Launch Guard hook program.
    #[account(address = noised_hook::ID @ LaunchpadError::AccountMismatch, executable)]
    pub hook_program: UncheckedAccount<'info>,
}

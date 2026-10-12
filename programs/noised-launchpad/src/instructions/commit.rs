use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::Token,
    token_interface::{self, Mint, TokenAccount, TransferChecked},
};

use crate::{
    constants::*,
    error::LaunchpadError,
    events::Committed,
    pq,
    state::{Commit, Launch, LaunchStatus, PayoutVault},
};

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
pub fn handle_commit(ctx: Context<CommitToBatch>, amount: u64) -> Result<()> {
    require!(amount > 0, LaunchpadError::ZeroAmount);
    let now = Clock::get()?.unix_timestamp;
    let launch = &ctx.accounts.launch;
    require!(
        now >= launch.launch_ts && now < launch.commit_end_ts,
        LaunchpadError::NotCommitWindow
    );
    // Defense in depth (audit 4, L-i2): the batch executes only once the
    // commit window closed, so no commit can follow it.
    require!(!launch.executed, LaunchpadError::AlreadyExecuted);

    let owner = ctx.accounts.owner.key();
    let token_owner = ctx.accounts.token_owner.key();
    let refund_owner = ctx.accounts.refund_owner.key();
    let commit = &mut ctx.accounts.commit;
    if commit.owner == Pubkey::default() {
        require!(
            pq::is_payout_owner(&ctx.accounts.token_owner, &owner, &launch.base_mint)?
                && pq::is_payout_owner(&ctx.accounts.refund_owner, &owner, &WSOL_MINT)?,
            LaunchpadError::InvalidPayoutOwner
        );
        commit.version = Commit::VERSION;
        commit.bump = ctx.bumps.commit;
        commit.launch = launch.key();
        commit.owner = owner;
        commit.token_owner = token_owner;
        commit.refund_owner = refund_owner;
    } else {
        require!(
            commit.token_owner == token_owner && commit.refund_owner == refund_owner,
            LaunchpadError::InvalidPayoutOwner
        );
    }
    let owner_total = commit
        .amount
        .checked_add(amount)
        .ok_or(LaunchpadError::MathOverflow)?;
    let total = launch
        .total_committed
        .checked_add(amount)
        .ok_or(LaunchpadError::MathOverflow)?;
    let cap = launch.batch_wallet_cap;
    require!(cap == 0 || owner_total <= cap, LaunchpadError::CapExceeded);
    commit.amount = owner_total;
    // The tokens' receiving account takes at most one wallet's cap.
    match (
        token_owner == owner,
        ctx.accounts.payout_vault.as_deref_mut(),
    ) {
        (true, None) => {}
        (false, Some(record)) => {
            if record.version == 0 {
                record.version = PayoutVault::VERSION;
                record.bump = ctx
                    .bumps
                    .payout_vault
                    .ok_or(LaunchpadError::InvalidPayoutOwner)?;
                record.launch = launch.key();
                record.vault = token_owner;
            }
            let vault_total = record
                .committed
                .checked_add(amount)
                .ok_or(LaunchpadError::MathOverflow)?;
            require!(cap == 0 || vault_total <= cap, LaunchpadError::CapExceeded);
            record.committed = vault_total;
        }
        _ => return err!(LaunchpadError::InvalidPayoutOwner),
    }

    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.owner_quote_account.to_account_info(),
                mint: ctx.accounts.quote_mint.to_account_info(),
                to: ctx.accounts.batch_quote_escrow.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.quote_mint.decimals,
    )?;

    let launch = &mut ctx.accounts.launch;
    launch.total_committed = total;
    emit!(Committed {
        launch: launch.key(),
        owner,
        amount,
        owner_total,
        total_committed: total,
        token_owner,
        refund_owner,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct CommitToBatch<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = batch_authority @ LaunchpadError::AccountMismatch,
        constraint = launch.status == LaunchStatus::Live @ LaunchpadError::WrongLaunchState,
    )]
    pub launch: Box<Account<'info, Launch>>,

    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + Commit::INIT_SPACE,
        seeds = [COMMIT_SEED, launch.key().as_ref(), owner.key().as_ref()],
        bump,
    )]
    pub commit: Box<Account<'info, Commit>>,

    /// CHECK: batch authority PDA bound to `launch`.
    pub batch_authority: UncheckedAccount<'info>,

    #[account(address = WSOL_MINT @ LaunchpadError::AccountMismatch)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        token::mint = quote_mint,
        token::authority = owner,
        token::token_program = token_program,
    )]
    pub owner_quote_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = quote_mint,
        associated_token::authority = batch_authority,
        associated_token::token_program = token_program,
    )]
    pub batch_quote_escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,

    /// CHECK: receives the tokens at claim: `owner`, or a PQ vault of the
    /// base mint (checked on the first commit, then fixed).
    pub token_owner: UncheckedAccount<'info>,

    /// CHECK: receives the wSOL refund at claim: `owner`, or a PQ vault of
    /// wSOL (checked on the first commit, then fixed).
    pub refund_owner: UncheckedAccount<'info>,

    /// `["payout-vault", launch, token_owner]`, when `token_owner` is a
    /// vault (and omitted when it is the committer): the total committed by
    /// every commit naming that vault, held to `batch_wallet_cap`.
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + PayoutVault::INIT_SPACE,
        seeds = [PAYOUT_VAULT_SEED, launch.key().as_ref(), token_owner.key().as_ref()],
        bump,
    )]
    pub payout_vault: Option<Box<Account<'info, PayoutVault>>>,
}

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::Token,
    token_2022::Token2022,
    token_interface::{Mint, TokenAccount},
};

use crate::{
    constants::*,
    error::LaunchpadError,
    events::BatchClaimed,
    hook_accounts, math,
    state::{Commit, Launch, LaunchStatus},
    token_util::{self, hook_program_of, AtaCreator},
};

/// Permissionless: pay one commit its pro-rata share of an executed batch
/// (tokens + unspent wSOL), or its full refund if the batch expired. Funds
/// only ever go to the payout owners the first commit fixed (the committer,
/// or its PQ vaults): tokens to the token owner's canonical base-token ATA,
/// wSOL to the refund owner's canonical wSOL ATA, created if missing. As in
/// `distribute`, their owner field is not compared (`AtaCreator::ensure`):
/// only that owner can reassign its own ATA (a vault never does), so nobody
/// else can block a claim or choose where a share goes.
pub fn handle_claim<'info>(ctx: Context<'info, Claim<'info>>, owner: Pubkey) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let launch = &ctx.accounts.launch;
    let commit = &ctx.accounts.commit;
    require!(!commit.claimed, LaunchpadError::AlreadyClaimed);

    let (tokens, refund, expired, refundable) = if launch.executed {
        let share = math::batch_share(
            commit.amount,
            launch.total_committed,
            launch.quote_spent,
            launch.tokens_out,
        )
        .ok_or(LaunchpadError::MathOverflow)?;
        let unspent = launch
            .total_committed
            .checked_sub(launch.quote_spent)
            .ok_or(LaunchpadError::MathOverflow)?;
        (share.tokens, share.refund, false, unspent)
    } else if now >= launch.execute_end_ts {
        (0, commit.amount, true, launch.total_committed)
    } else {
        return err!(LaunchpadError::BatchPending);
    };

    // Hard invariant: cumulative payouts never exceed what the batch holds.
    let tokens_claimed = launch
        .tokens_claimed
        .checked_add(tokens)
        .ok_or(LaunchpadError::MathOverflow)?;
    let quote_refunded = launch
        .quote_refunded
        .checked_add(refund)
        .ok_or(LaunchpadError::MathOverflow)?;
    require!(
        tokens_claimed <= launch.tokens_out && quote_refunded <= refundable,
        LaunchpadError::PayoutExceedsEscrow
    );

    let launch_key = launch.key();
    let batch_bump = [launch.batch_bump];
    let seeds: &[&[u8]] = &[BATCH_SEED, launch_key.as_ref(), &batch_bump];

    ctx.accounts.commit.claimed = true;
    let launch = &mut ctx.accounts.launch;
    launch.tokens_claimed = tokens_claimed;
    launch.quote_refunded = quote_refunded;

    let a = &ctx.accounts;
    let payer = a.payer.to_account_info();
    let token_owner = a.token_owner.to_account_info();
    let refund_owner = a.refund_owner.to_account_info();
    let system_program = a.system_program.to_account_info();
    if tokens > 0 {
        let escrow = a
            .batch_base_escrow
            .as_ref()
            .ok_or(LaunchpadError::AccountMismatch)?;
        let destination = a
            .token_owner_ata
            .as_ref()
            .ok_or(LaunchpadError::AccountMismatch)?
            .to_account_info();
        AtaCreator {
            payer: &payer,
            mint: &a.base_mint.to_account_info(),
            token_program: &a.token_2022_program.to_account_info(),
            system_program: &system_program,
        }
        .ensure(&token_owner, &destination)?;
        // While the curve runs the hook is active and needs its accounts;
        // transfers out of the batch escrow are exempt from its rules.
        if hook_program_of(&a.base_mint.to_account_info())?.is_some() {
            hook_accounts::validate(ctx.remaining_accounts, &a.base_mint.key())?;
        }
        token_util::transfer_signed(
            &a.token_2022_program.to_account_info(),
            &a.base_mint,
            escrow,
            destination,
            a.batch_authority.to_account_info(),
            tokens,
            seeds,
            ctx.remaining_accounts,
        )?;
    }
    if refund > 0 {
        let destination = a
            .refund_owner_ata
            .as_ref()
            .ok_or(LaunchpadError::AccountMismatch)?
            .to_account_info();
        AtaCreator {
            payer: &payer,
            mint: &a.quote_mint.to_account_info(),
            token_program: &a.token_program.to_account_info(),
            system_program: &system_program,
        }
        .ensure(&refund_owner, &destination)?;
        token_util::transfer_signed(
            &a.token_program.to_account_info(),
            &a.quote_mint,
            &a.batch_quote_escrow,
            destination,
            a.batch_authority.to_account_info(),
            refund,
            seeds,
            &[],
        )?;
    }

    emit!(BatchClaimed {
        launch: launch_key,
        owner,
        tokens,
        refund,
        expired,
        token_owner: token_owner.key(),
        refund_owner: refund_owner.key(),
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(owner: Pubkey)]
pub struct Claim<'info> {
    /// Anyone; pays for the owner's ATAs if they do not exist.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        has_one = base_mint @ LaunchpadError::AccountMismatch,
        has_one = batch_authority @ LaunchpadError::AccountMismatch,
        constraint = launch.status == LaunchStatus::Live @ LaunchpadError::WrongLaunchState,
    )]
    pub launch: Box<Account<'info, Launch>>,

    #[account(
        mut,
        seeds = [COMMIT_SEED, launch.key().as_ref(), owner.as_ref()],
        bump = commit.bump,
        has_one = launch @ LaunchpadError::AccountMismatch,
        constraint = commit.owner == owner @ LaunchpadError::AccountMismatch,
    )]
    pub commit: Box<Account<'info, Commit>>,

    /// CHECK: the commit's token owner (the committer or its PQ vault of
    /// the base mint); only receives tokens.
    #[account(address = commit.token_owner @ LaunchpadError::InvalidPayoutOwner)]
    pub token_owner: UncheckedAccount<'info>,

    /// CHECK: the commit's refund owner (the committer or its PQ vault of
    /// wSOL); only receives wSOL.
    #[account(address = commit.refund_owner @ LaunchpadError::InvalidPayoutOwner)]
    pub refund_owner: UncheckedAccount<'info>,

    /// CHECK: batch authority PDA bound to `launch`.
    pub batch_authority: UncheckedAccount<'info>,

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

    /// Required when tokens are paid.
    #[account(
        mut,
        associated_token::mint = base_mint,
        associated_token::authority = batch_authority,
        associated_token::token_program = token_2022_program,
    )]
    pub batch_base_escrow: Option<Box<InterfaceAccount<'info, TokenAccount>>>,

    /// CHECK: required when wSOL is refunded: the refund owner's canonical
    /// wSOL ATA, checked and created if missing by `AtaCreator::ensure`.
    #[account(mut)]
    pub refund_owner_ata: Option<UncheckedAccount<'info>>,

    /// CHECK: required when tokens are paid: the token owner's canonical
    /// base-token ATA, checked and created if missing by `AtaCreator::ensure`.
    #[account(mut)]
    pub token_owner_ata: Option<UncheckedAccount<'info>>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

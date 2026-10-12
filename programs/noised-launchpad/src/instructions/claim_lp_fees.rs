use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::Token,
    token_2022::Token2022,
    token_interface::{Mint, TokenAccount},
};

use crate::{
    checks,
    constants::*,
    cp_amm,
    error::LaunchpadError,
    events::LpFeesClaimed,
    state::{Launch, LaunchStatus},
};

/// Permissionless, after migration: claim the fees of an LP position held by
/// the launch authority in a DAMM v2 pool of (base mint, wSOL). Base tokens
/// land in the launch authority's base account (burned by `distribute`),
/// wSOL in its wSOL account.
pub fn handle_claim_lp_fees(ctx: Context<ClaimLpFees>) -> Result<()> {
    checks::verify_lp_position(
        &ctx.accounts.damm_pool,
        &ctx.accounts.position,
        &ctx.accounts.position_nft_account.mint,
        &ctx.accounts.base_mint.key(),
    )?;
    let base_before = ctx.accounts.authority_base_ata.amount;
    let quote_before = ctx.accounts.authority_quote_ata.amount;
    let launch_key = ctx.accounts.launch.key();
    let bump = [ctx.accounts.launch.authority_bump];
    let seeds: &[&[u8]] = &[AUTHORITY_SEED, launch_key.as_ref(), &bump];
    let a = &ctx.accounts;
    cp_amm::cpi::claim_position_fee(CpiContext::new_with_signer(
        DAMM_V2_PROGRAM_ID,
        cp_amm::cpi::accounts::ClaimPositionFee {
            pool_authority: a.damm_pool_authority.to_account_info(),
            pool: a.damm_pool.to_account_info(),
            position: a.position.to_account_info(),
            token_a_account: a.authority_base_ata.to_account_info(),
            token_b_account: a.authority_quote_ata.to_account_info(),
            token_a_vault: a.token_a_vault.to_account_info(),
            token_b_vault: a.token_b_vault.to_account_info(),
            token_a_mint: a.base_mint.to_account_info(),
            token_b_mint: a.quote_mint.to_account_info(),
            position_nft_account: a.position_nft_account.to_account_info(),
            signer: a.launch_authority.to_account_info(),
            token_a_program: a.token_2022_program.to_account_info(),
            token_b_program: a.token_program.to_account_info(),
            event_authority: a.damm_event_authority.to_account_info(),
            program: a.damm_program.to_account_info(),
        },
        &[seeds],
    ))?;
    ctx.accounts.authority_base_ata.reload()?;
    ctx.accounts.authority_quote_ata.reload()?;
    let base_amount = ctx
        .accounts
        .authority_base_ata
        .amount
        .checked_sub(base_before)
        .ok_or(LaunchpadError::MathOverflow)?;
    let quote_amount = ctx
        .accounts
        .authority_quote_ata
        .amount
        .checked_sub(quote_before)
        .ok_or(LaunchpadError::MathOverflow)?;
    require!(
        base_amount > 0 || quote_amount > 0,
        LaunchpadError::NothingToDo
    );
    emit!(LpFeesClaimed {
        launch: launch_key,
        position: ctx.accounts.position.key(),
        base_amount,
        quote_amount,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ClaimLpFees<'info> {
    /// Anyone; pays for the launch authority's token accounts if missing.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        has_one = base_mint @ LaunchpadError::AccountMismatch,
        has_one = launch_authority @ LaunchpadError::AccountMismatch,
        constraint = launch.status == LaunchStatus::Live @ LaunchpadError::WrongLaunchState,
    )]
    pub launch: Box<Account<'info, Launch>>,

    /// CHECK: launch authority PDA bound to `launch`; owns the position NFT.
    pub launch_authority: UncheckedAccount<'info>,

    /// CHECK: a DAMM v2 pool whose mints are exactly (base mint, wSOL);
    /// checked in the handler (`checks::verify_lp_position`).
    pub damm_pool: UncheckedAccount<'info>,

    /// CHECK: a DAMM v2 position of `damm_pool` for the NFT below; checked
    /// in the handler (`checks::verify_lp_position`).
    #[account(mut)]
    pub position: UncheckedAccount<'info>,

    /// The position NFT, held by the launch authority.
    #[account(
        token::authority = launch_authority,
        token::token_program = token_2022_program,
        constraint = position_nft_account.amount == 1 @ LaunchpadError::InvalidPosition,
    )]
    pub position_nft_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: DAMM v2 checks it equals the pool's token A vault.
    #[account(mut)]
    pub token_a_vault: UncheckedAccount<'info>,

    /// CHECK: DAMM v2 checks it equals the pool's token B vault.
    #[account(mut)]
    pub token_b_vault: UncheckedAccount<'info>,

    pub base_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(address = WSOL_MINT @ LaunchpadError::AccountMismatch)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = base_mint,
        associated_token::authority = launch_authority,
        associated_token::token_program = token_2022_program,
    )]
    pub authority_base_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = quote_mint,
        associated_token::authority = launch_authority,
        associated_token::token_program = token_program,
    )]
    pub authority_quote_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: DAMM v2 pool authority.
    #[account(address = DAMM_V2_POOL_AUTHORITY @ LaunchpadError::AccountMismatch)]
    pub damm_pool_authority: UncheckedAccount<'info>,

    /// CHECK: Meteora DAMM v2.
    #[account(address = DAMM_V2_PROGRAM_ID @ LaunchpadError::AccountMismatch, executable)]
    pub damm_program: UncheckedAccount<'info>,

    /// CHECK: DAMM v2 event authority PDA.
    #[account(address = DAMM_V2_EVENT_AUTHORITY @ LaunchpadError::AccountMismatch)]
    pub damm_event_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

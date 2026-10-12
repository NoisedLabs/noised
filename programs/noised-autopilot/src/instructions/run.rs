use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::get_associated_token_address_with_program_id,
    token::{self, Token},
    token_2022::Token2022,
    token_interface::{spl_token_2022, Mint, TokenAccount},
};
use noised_rules::graph::{action, Graph};

use crate::{
    constants::*,
    cpi,
    error::AutopilotError,
    events::NodeRan,
    external::{self, PoolView},
    logic::{self, Plan, RunInput},
    reference,
    state::{Autopilot, GraphRecord},
};

/// Number of remaining accounts a buyback takes: DAMM v2's pool authority,
/// the pool's token A and B vaults, its event authority and the program.
pub const BUYBACK_ACCOUNTS: usize = 5;

/// Run node `node` of the active graph (spec §4 `run`). Permissionless,
/// except that an operator-gated node needs the operator's signature and
/// its `amount`; a keeper may choose a smaller `amount` for a buyback, down
/// to `logic::keeper_floor` (a partial buyback, audit 4, A4-2: it spends
/// from the budget and earns its share of a tip, but the node's run stays
/// open for the rest). Every guard is in `logic::plan_run`; then exactly
/// one action, through fixed program ids only:
///
/// * BUYBACK_BURN: swap the planned treasury lamports for the token on the
///   launch's DAMM v2 pool, for at least the minimum out priced at the
///   buyback's price bound plus the node's premium, and burn every token
///   received, in this instruction. Remaining accounts: DAMM v2's pool
///   authority, token A vault, token B vault, event authority, program.
/// * BURN: burn the planned treasury tokens. No remaining accounts.
/// * DISTRIBUTE_SOL: pay each recipient's share in wSOL to its canonical
///   wSOL ATA. Remaining accounts: those ATAs' addresses, in the graph's
///   order, writable. A recipient with no wSOL account there is skipped
///   and its share stays in the treasury (audit 4, M4: nobody has to pay
///   for a recipient's account); a run that could pay nobody refuses.
///
/// Before planning, once graduated, the run observes the pool's price and
/// moves the reference as `update_price` does (a burn or a distribution
/// that cannot read the pool skips this: only a buyback needs it). After
/// the action the run is recorded and the caller's tip is paid from the
/// treasury's wSOL (`logic::take_tip`; a burn's tokens are valued at
/// `logic::burn_price`). A failed check changes nothing.
pub fn handle_run<'info>(
    ctx: Context<'info, Run<'info>>,
    node: u8,
    amount: Option<u64>,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let ap = &ctx.accounts.autopilot;
    require!(
        ap.pending_graph == [0; 32] || now < ap.pending_activate_at,
        AutopilotError::PendingUpdateDue
    );
    let record = &ctx.accounts.graph;
    // Verified when published; parse is the O(1) layout check.
    let graph = Graph::parse(&record.bytes).map_err(|_| AutopilotError::InvalidGraph)?;
    let index = usize::from(node);
    let is_buyback = graph.node(index).map(|n| n.action) == Some(action::BUYBACK_BURN);
    let mint = ctx.accounts.mint.key();

    // Graduated once the pool is bound. A buyback needs the pool; the other
    // actions only observe it when they can read it.
    let graduated = ap.damm_pool != Pubkey::default();
    let pool = if graduated {
        let info = ctx
            .accounts
            .damm_pool
            .as_ref()
            .ok_or(AutopilotError::InvalidPool)?
            .to_account_info();
        let data = info.try_borrow_data()?;
        let read = external::read_pool(info.owner, &data, &mint);
        if is_buyback {
            Some(read?.ok_or(AutopilotError::InvalidPool)?)
        } else {
            read.ok().flatten()
        }
    } else {
        None
    };
    let mut price = ap.price_state();
    if let Some(p) = pool {
        reference::observe(&mut price.observations, now, p.sqrt_price);
    }
    let seen = reference::seen(&price.observations, now);
    reference::follow(&mut price, seen, now);
    let pool_quote = match (is_buyback, pool) {
        (true, Some(p)) => Some(damm_accounts(ctx.remaining_accounts, &p)?),
        _ => None,
    };

    let states = ap.node_states();
    let partial_spent = ap.partial_spent.get(index).copied().unwrap_or(0);
    let plan = logic::plan_run(&RunInput {
        graph: &graph,
        node: index,
        now,
        states: &states,
        operator: ap.operator,
        operator_signer: ctx.accounts.operator.as_ref().map(|s| s.key()),
        amount,
        treasury_sol: ctx.accounts.treasury_wsol.amount,
        treasury_token: ctx.accounts.treasury_token.amount,
        graduated,
        spot: pool.map(|p| p.sqrt_price),
        reference: price.reference,
        seen,
        pool_quote,
        partial_spent,
    })?;
    let gnode = graph.node(index).ok_or(AutopilotError::NoSuchNode)?;

    let launch = ap.launch;
    let bump = [ap.treasury_bump];
    let seeds: &[&[u8]] = &[TREASURY_SEED, launch.as_ref(), &bump];
    let (mut skipped, mut kept) = (0u8, 0u64);
    let (bought, burned) = match plan {
        Plan::Buyback {
            amount_in, min_out, ..
        } => buyback(&ctx, amount_in, min_out, seeds)?,
        Plan::Burn { amount } => {
            require!(
                ctx.remaining_accounts.is_empty(),
                AutopilotError::UnexpectedAccounts
            );
            let a = &ctx.accounts;
            cpi::burn(
                &a.token_2022_program.to_account_info(),
                &a.treasury_token.to_account_info(),
                &a.mint.to_account_info(),
                &a.treasury.to_account_info(),
                amount,
                a.mint.decimals,
                seeds,
            )?;
            (0, amount)
        }
        Plan::Distribute { shares, .. } => {
            (skipped, kept) = distribute(&ctx, &graph, &shares, seeds)?;
            (0, 0)
        }
    };

    // Record the run and the price, then the tip from what the action left.
    ctx.accounts.treasury_wsol.reload()?;
    let treasury_sol = ctx.accounts.treasury_wsol.amount;
    let caller = ctx.accounts.caller.key();
    let autopilot_key = ctx.accounts.autopilot.key();
    let ap: &mut Autopilot = &mut ctx.accounts.autopilot;
    ap.set_price_state(&price);
    let slot = ap.nodes.get_mut(index).ok_or(AutopilotError::NoSuchNode)?;
    let open = ap
        .partial_spent
        .get_mut(index)
        .ok_or(AutopilotError::NoSuchNode)?;
    logic::record_run(
        slot,
        open,
        &mut ap.seq,
        gnode.epoch_secs,
        now,
        plan.spent(),
        plan.partial(),
    )?;
    let burn_price = logic::burn_price(
        graduated,
        price.reference,
        reference::lowest(&price.observations, now),
    );
    let tip = logic::take_tip(
        &mut ap.tip_epoch_start,
        &mut ap.tips_in_epoch,
        now,
        treasury_sol,
        plan.value(burn_price, kept),
        plan.max_tip(gnode.p1),
    );
    let seq = ap.seq;
    if tip > 0 {
        let a = &ctx.accounts;
        cpi::transfer_wsol(
            &a.token_program.to_account_info(),
            &a.treasury_wsol.to_account_info(),
            &a.wsol_mint.to_account_info(),
            &a.tip_account.to_account_info(),
            &a.treasury.to_account_info(),
            tip,
            seeds,
        )?;
    }
    emit!(NodeRan {
        autopilot: autopilot_key,
        node,
        action: gnode.action,
        seq,
        spent: plan.spent(),
        bought,
        burned,
        tip,
        caller,
        spot_sqrt_price: pool.map_or(0, |p| p.sqrt_price),
        ref_sqrt_price: price.reference,
        partial: plan.partial(),
        skipped,
        kept,
    });
    Ok(())
}

/// Check a buyback's remaining accounts (DAMM v2's, exactly, for `pool`)
/// and return the pool's wSOL (its token B vault's balance).
fn damm_accounts(rest: &[AccountInfo], pool: &PoolView) -> Result<u64> {
    require!(
        rest.len() == BUYBACK_ACCOUNTS,
        AutopilotError::InvalidDammAccounts
    );
    let (pool_authority, vault_a, vault_b, event_authority, program) =
        (&rest[0], &rest[1], &rest[2], &rest[3], &rest[4]);
    require!(
        *pool_authority.key == DAMM_V2_POOL_AUTHORITY
            && *vault_a.key == pool.token_a_vault
            && *vault_b.key == pool.token_b_vault
            && *event_authority.key == DAMM_V2_EVENT_AUTHORITY
            && *program.key == DAMM_V2_PROGRAM_ID
            && program.executable,
        AutopilotError::InvalidDammAccounts
    );
    token_amount(vault_b)
}

/// The buyback: swap exactly `amount_in` treasury lamports on the pool for
/// at least `min_out` tokens, then burn exactly what arrived. The remaining
/// accounts are DAMM v2's, checked before planning (`damm_accounts`).
/// Returns (bought, burned).
fn buyback<'info>(
    ctx: &Context<'info, Run<'info>>,
    amount_in: u64,
    min_out: u64,
    seeds: &[&[u8]],
) -> Result<(u64, u64)> {
    let rest = ctx.remaining_accounts;
    let (pool_authority, vault_a, vault_b, event_authority, program) =
        (&rest[0], &rest[1], &rest[2], &rest[3], &rest[4]);
    let a = &ctx.accounts;
    let pool_account = a
        .damm_pool
        .as_ref()
        .ok_or(AutopilotError::InvalidPool)?
        .to_account_info();
    let sol_before = a.treasury_wsol.amount;
    let tokens_before = a.treasury_token.amount;
    cpi::damm_swap(
        &cpi::DammSwap {
            pool_authority,
            pool: &pool_account,
            input: &a.treasury_wsol.to_account_info(),
            output: &a.treasury_token.to_account_info(),
            token_a_vault: vault_a,
            token_b_vault: vault_b,
            token_a_mint: &a.mint.to_account_info(),
            token_b_mint: &a.wsol_mint.to_account_info(),
            payer: &a.treasury.to_account_info(),
            token_a_program: &a.token_2022_program.to_account_info(),
            token_b_program: &a.token_program.to_account_info(),
            event_authority,
            program,
        },
        amount_in,
        min_out,
        seeds,
    )?;
    let sol_after = token_amount(&a.treasury_wsol.to_account_info())?;
    let tokens_after = token_amount(&a.treasury_token.to_account_info())?;
    let bought = tokens_after
        .checked_sub(tokens_before)
        .ok_or(AutopilotError::SwapShortfall)?;
    require!(
        sol_before.checked_sub(sol_after) == Some(amount_in) && bought >= min_out,
        AutopilotError::SwapShortfall
    );
    cpi::burn(
        &a.token_2022_program.to_account_info(),
        &a.treasury_token.to_account_info(),
        &a.mint.to_account_info(),
        &a.treasury.to_account_info(),
        bought,
        a.mint.decimals,
        seeds,
    )?;
    // Everything bought is gone: the treasury holds what it held before.
    require!(
        token_amount(&a.treasury_token.to_account_info())? == tokens_before,
        AutopilotError::SwapShortfall
    );
    Ok((bought, bought))
}

/// Pay each recipient its share, to its canonical wSOL ATA. The caller
/// names exactly those addresses, writable; whether a recipient's wSOL
/// account is there is the ledger's state, which no caller chooses: a
/// recipient without one (`is_wsol_account_of`) is skipped and its share
/// stays in the treasury (audit 4, M4). Returns the skipped recipients (bit
/// `i`: recipient `i`) and their shares' sum; refuses if nobody was paid.
fn distribute<'info>(
    ctx: &Context<'info, Run<'info>>,
    graph: &Graph,
    shares: &[u64],
    seeds: &[&[u8]],
) -> Result<(u8, u64)> {
    let rest = ctx.remaining_accounts;
    require!(
        rest.len() == graph.recipient_count(),
        AutopilotError::InvalidRecipientAccounts
    );
    let a = &ctx.accounts;
    let (mut skipped, mut kept, mut paid) = (0u8, 0u64, 0u64);
    for (i, ata) in rest.iter().enumerate() {
        let recipient = graph
            .recipient(i)
            .ok_or(AutopilotError::InvalidRecipientAccounts)?;
        let owner = Pubkey::new_from_array(recipient.key);
        let expected = get_associated_token_address_with_program_id(&owner, &WSOL_MINT, &token::ID);
        require!(
            *ata.key == expected && ata.is_writable,
            AutopilotError::InvalidRecipientAccounts
        );
        let share = shares.get(i).copied().unwrap_or(0);
        if share == 0 {
            continue;
        }
        if !is_wsol_account_of(ata, &owner) {
            skipped |= 1 << i;
            kept = kept
                .checked_add(share)
                .ok_or(AutopilotError::MathOverflow)?;
            continue;
        }
        cpi::transfer_wsol(
            &a.token_program.to_account_info(),
            &a.treasury_wsol.to_account_info(),
            &a.wsol_mint.to_account_info(),
            ata,
            &a.treasury.to_account_info(),
            share,
            seeds,
        )?;
        paid = paid
            .checked_add(share)
            .ok_or(AutopilotError::MathOverflow)?;
    }
    require!(paid > 0, AutopilotError::NoRecipientAccount);
    Ok((skipped, kept))
}

/// Whether `info` is an SPL Token wSOL account of `owner` that can receive
/// a transfer (initialized, not frozen).
fn is_wsol_account_of(info: &AccountInfo, owner: &Pubkey) -> bool {
    if *info.owner != token::ID {
        return false;
    }
    let Ok(data) = info.try_borrow_data() else {
        return false;
    };
    let Ok(state) =
        spl_token_2022::extension::StateWithExtensions::<spl_token_2022::state::Account>::unpack(
            &data,
        )
    else {
        return false;
    };
    state.base.mint == WSOL_MINT
        && state.base.owner == *owner
        && state.base.state == spl_token_2022::state::AccountState::Initialized
}

/// A token account's amount (read after a CPI changed it, or from an
/// account checked by address).
fn token_amount(info: &AccountInfo) -> Result<u64> {
    let data = info.try_borrow_data()?;
    let state =
        spl_token_2022::extension::StateWithExtensions::<spl_token_2022::state::Account>::unpack(
            &data,
        )?;
    Ok(state.base.amount)
}

#[derive(Accounts)]
pub struct Run<'info> {
    /// Anyone: the keeper (or the operator). Receives the tip.
    pub caller: Signer<'info>,

    /// The graph's operator: required for operator-gated nodes.
    pub operator: Option<Signer<'info>>,

    #[account(
        mut,
        seeds = [AUTOPILOT_SEED, autopilot.launch.as_ref()],
        bump = autopilot.bump,
        constraint = autopilot.mint != Pubkey::default() @ AutopilotError::MintNotBound,
        constraint = autopilot.active_graph != [0; 32] @ AutopilotError::NoActiveGraph,
    )]
    pub autopilot: Box<Account<'info, Autopilot>>,

    /// The active graph.
    #[account(
        seeds = [GRAPH_SEED, autopilot.launch.as_ref(), autopilot.active_graph.as_ref()],
        bump = graph.bump,
    )]
    pub graph: Box<Account<'info, GraphRecord>>,

    /// CHECK: the treasury authority PDA; signs the action's CPIs.
    #[account(
        seeds = [TREASURY_SEED, autopilot.launch.as_ref()],
        bump = autopilot.treasury_bump,
    )]
    pub treasury: UncheckedAccount<'info>,

    #[account(
        mut,
        associated_token::mint = wsol_mint,
        associated_token::authority = treasury,
        associated_token::token_program = token_program,
    )]
    pub treasury_wsol: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = treasury,
        associated_token::token_program = token_2022_program,
    )]
    pub treasury_token: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Writable: burns reduce the supply.
    #[account(mut, address = autopilot.mint @ AutopilotError::MintNotBound)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(address = WSOL_MINT @ AutopilotError::InvalidRecipientAccounts)]
    pub wsol_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: the launch's DAMM v2 pool once bound (`bind_pool`), read by
    /// layout (`external::read_pool`); none before. Writable in the
    /// transaction only for a buyback.
    #[account(address = autopilot.damm_pool @ AutopilotError::InvalidPool)]
    pub damm_pool: Option<UncheckedAccount<'info>>,

    /// Any wSOL account: receives the tip.
    #[account(
        mut,
        token::mint = wsol_mint,
        token::token_program = token_program,
    )]
    pub tip_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
}

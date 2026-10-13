use alloc::boxed::Box;

use noised_onchain::{
    accounts::{check_distinct, check_keys, check_mut},
    args::Reader,
    error::anchor::{ACCOUNT_NOT_SIGNER, INSTRUCTION_DID_NOT_DESERIALIZE},
    ids::{TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID},
    owned_by, same,
    token::{
        associated_token_address, check_associated_token_account, check_token_mint,
        check_token_token_program, unpack_token_account, TokenAccount, ACCOUNT_STATE_INITIALIZED,
    },
};
use noised_rules::graph::{action, Graph};
use pinocchio::{cpi::Signer, AccountView, ProgramResult};

use crate::processor::*;
use crate::{
    constants::*,
    cpi,
    error::{fail, AutopilotError},
    events::NodeRan,
    external::{self, PoolView},
    logic::{self, Plan, RunInput},
    reference::{self, Seen},
    state::{Autopilot, GraphRecord},
    ProgramError, Pubkey,
};

/// Number of remaining accounts a buyback takes: DAMM v2's pool authority,
/// the pool's token A and B vaults, its event authority and the program.
pub const BUYBACK_ACCOUNTS: usize = 5;

/// `run(node: u8, amount: Option<u64>)` arguments (Borsh; trailing bytes
/// ignored): `None` is `InstructionDidNotDeserialize`.
pub fn parse_args(data: &[u8]) -> Option<(u8, Option<u64>)> {
    let mut r = Reader::new(data);
    Some((r.u8()?, r.option(|r| r.u64())?))
}

/// The accounts of `run` (`Run`), loaded in order and checked by type.
struct RunAccounts<'a> {
    caller: &'a AccountView,
    operator: Option<&'a AccountView>,
    autopilot: &'a AccountView,
    ap: Box<Autopilot>,
    graph: &'a AccountView,
    record: GraphRecord,
    treasury: &'a AccountView,
    treasury_wsol: &'a AccountView,
    /// As loaded: the balance before the action.
    wsol_state: TokenAccount,
    treasury_token: &'a AccountView,
    /// As loaded: the balance before the action.
    token_state: TokenAccount,
    mint: &'a AccountView,
    /// The mint's decimals, as loaded.
    decimals: u8,
    wsol_mint: &'a AccountView,
    damm_pool: Option<&'a AccountView>,
    tip_account: &'a AccountView,
    tip_state: TokenAccount,
    token_program: &'a AccountView,
    token_2022_program: &'a AccountView,
    /// The action's accounts.
    remaining: &'a [AccountView],
}

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
///
/// Arguments: `node: u8, amount: Option<u64>`. Accounts (`Run`): caller
/// (signer; receives the tip), operator (optional signer: required for
/// operator-gated nodes), autopilot (writable), graph (the active record),
/// treasury, treasury_wsol (writable), treasury_token (writable), mint
/// (writable: burns reduce the supply), wsol_mint, damm_pool (optional: the
/// bound pool, writable in the transaction only for a buyback), tip_account
/// (writable, any wSOL account), token_program, token_2022_program; then
/// the action's remaining accounts.
pub fn run(mut accounts: Accounts, data: &[u8]) -> ProgramResult {
    log_instruction("Instruction: Run");
    let Some((node, amount)) = parse_args(data) else {
        return Err(fail(INSTRUCTION_DID_NOT_DESERIALIZE, None));
    };
    let mut a = load(&mut accounts)?;
    // [A] duplicate mutable accounts: autopilot, treasury_wsol,
    // treasury_token, mint, tip_account.
    check_distinct::<P>(&[
        (a.autopilot, AUTOPILOT),
        (a.treasury_wsol, TREASURY_WSOL),
        (a.treasury_token, TREASURY_TOKEN),
        (a.mint, MINT),
        (a.tip_account, TIP_ACCOUNT),
    ])?;
    check_run_accounts(&a)?;
    handle_run(&mut a, node, amount)?;
    // Exit.
    write_autopilot(a.autopilot, &a.ap)
}

/// [A] `Run::try_accounts`, deserialization: each field in order, checked
/// by its type.
#[inline(never)]
fn load<'a>(accounts: &mut Accounts<'a>) -> Result<RunAccounts<'a>, ProgramError> {
    let caller = accounts.signer(CALLER)?;
    let operator = accounts.optional(Some(OPERATOR))?;
    if let Some(operator) = operator {
        // Option<Signer<'info>>: a given account must sign.
        if !operator.is_signer() {
            return Err(fail(ACCOUNT_NOT_SIGNER, Some(OPERATOR)));
        }
    }
    let (autopilot, ap) = accounts.account::<Box<Autopilot>>(AUTOPILOT)?;
    let (graph, record) = accounts.account::<GraphRecord>(GRAPH)?;
    let treasury = accounts.unchecked(TREASURY)?;
    let (treasury_wsol, wsol_state) = accounts.token_account(TREASURY_WSOL)?;
    let (treasury_token, token_state) = accounts.token_account(TREASURY_TOKEN)?;
    let (mint, decimals) = accounts.mint(MINT)?;
    let (wsol_mint, _) = accounts.mint(WSOL_MINT_FIELD)?;
    let damm_pool = accounts.optional(Some(DAMM_POOL))?;
    let (tip_account, tip_state) = accounts.token_account(TIP_ACCOUNT)?;
    let token_program = accounts.program(&TOKEN_PROGRAM_ID, TOKEN_PROGRAM)?;
    let token_2022_program = accounts.program(&TOKEN_2022_PROGRAM_ID, TOKEN_2022_PROGRAM)?;
    Ok(RunAccounts {
        caller,
        operator,
        autopilot,
        ap,
        graph,
        record,
        treasury,
        treasury_wsol,
        wsol_state,
        treasury_token,
        token_state,
        mint,
        decimals,
        wsol_mint,
        damm_pool,
        tip_account,
        tip_state,
        token_program,
        token_2022_program,
        remaining: accounts.remaining(),
    })
}

/// [A] Every field's constraints, in field order.
#[inline(never)]
fn check_run_accounts(a: &RunAccounts) -> ProgramResult {
    let ap = &*a.ap;
    // autopilot: seeds = [AUTOPILOT_SEED, autopilot.launch], bump =
    // autopilot.bump; mut; constraint = autopilot.mint != Pubkey::default()
    // @ MintNotBound; constraint = autopilot.active_graph != [0; 32] @
    // NoActiveGraph.
    check_autopilot(a.autopilot, ap, &ap.launch)?;
    check_autopilot_constraint(ap.mint != Pubkey::default(), AutopilotError::MintNotBound)?;
    check_autopilot_constraint(ap.active_graph != [0; 32], AutopilotError::NoActiveGraph)?;
    // graph: seeds = [GRAPH_SEED, autopilot.launch, autopilot.active_graph],
    // bump = graph.bump.
    check_graph(a.graph, &ap.launch, &ap.active_graph, a.record.bump)?;
    // treasury: seeds = [TREASURY_SEED, autopilot.launch], bump =
    // autopilot.treasury_bump.
    check_treasury(a.treasury, &ap.launch, ap.treasury_bump)?;
    // treasury_wsol: associated_token::mint = wsol_mint,
    // associated_token::authority = treasury,
    // associated_token::token_program = token_program; mut.
    check_associated_token_account::<P>(
        a.treasury_wsol,
        &a.wsol_state,
        a.treasury,
        a.wsol_mint,
        a.token_program,
        TREASURY_WSOL,
    )?;
    check_mut::<P>(a.treasury_wsol, TREASURY_WSOL)?;
    // treasury_token: associated_token::mint = mint,
    // associated_token::authority = treasury,
    // associated_token::token_program = token_2022_program; mut.
    check_associated_token_account::<P>(
        a.treasury_token,
        &a.token_state,
        a.treasury,
        a.mint,
        a.token_2022_program,
        TREASURY_TOKEN,
    )?;
    check_mut::<P>(a.treasury_token, TREASURY_TOKEN)?;
    // mint: mut, address = autopilot.mint @ MintNotBound.
    check_mut::<P>(a.mint, MINT)?;
    check_keys::<P>(
        a.mint.address(),
        &ap.mint,
        AutopilotError::MintNotBound.code(),
        MINT,
    )?;
    // wsol_mint: address = WSOL_MINT @ InvalidRecipientAccounts.
    check_keys::<P>(
        a.wsol_mint.address(),
        &WSOL_MINT,
        AutopilotError::InvalidRecipientAccounts.code(),
        WSOL_MINT_FIELD,
    )?;
    // damm_pool (when given): address = autopilot.damm_pool @ InvalidPool.
    if let Some(pool) = a.damm_pool {
        check_keys::<P>(
            pool.address(),
            &ap.damm_pool,
            AutopilotError::InvalidPool.code(),
            DAMM_POOL,
        )?;
    }
    // tip_account: mut, token::mint = wsol_mint, token::token_program =
    // token_program.
    check_mut::<P>(a.tip_account, TIP_ACCOUNT)?;
    check_token_mint::<P>(&a.tip_state, a.wsol_mint.address(), TIP_ACCOUNT)?;
    check_token_token_program::<P>(a.tip_account, a.token_program, TIP_ACCOUNT)
}

/// The handler: decide (no update due, the pool observed once graduated,
/// the reference moved, a buyback's accounts checked, `logic::plan_run`),
/// act, record the run and the price, tip the caller, emit `NodeRan`.
#[inline(never)]
fn handle_run(a: &mut RunAccounts, node: u8, amount: Option<u64>) -> ProgramResult {
    let now = now()?;
    require!(
        a.ap.pending_graph == [0; 32] || now < a.ap.pending_activate_at,
        AutopilotError::PendingUpdateDue
    );
    // Verified when published; parse is the O(1) layout check.
    let graph = Graph::parse(&a.record.bytes).map_err(|_| AutopilotError::InvalidGraph)?;
    let index = usize::from(node);
    let is_buyback = graph.node(index).map(|n| n.action) == Some(action::BUYBACK_BURN);
    let mint = *a.mint.address();

    // Graduated once the pool is bound. A buyback needs the pool; the other
    // actions only observe it when they can read it.
    let graduated = a.ap.damm_pool != Pubkey::default();
    let pool = if graduated {
        let info = a.damm_pool.ok_or(AutopilotError::InvalidPool)?;
        let data = info.try_borrow()?;
        let read = external::read_pool(info.owner(), &data, &mint);
        if is_buyback {
            Some(read?.ok_or(AutopilotError::InvalidPool)?)
        } else {
            read.ok().flatten()
        }
    } else {
        None
    };
    let mut price = a.ap.price_state();
    if let Some(p) = &pool {
        reference::observe(&mut price.observations, now, p.sqrt_price);
    }
    let seen = reference::seen(&price.observations, now);
    reference::follow(&mut price, seen, now);
    let pool_quote = match (is_buyback, &pool) {
        (true, Some(p)) => Some(damm_accounts(a.remaining, p)?),
        _ => None,
    };
    let plan = plan(
        a,
        &graph,
        index,
        now,
        amount,
        graduated,
        pool.as_ref().map(|p| p.sqrt_price),
        price.reference,
        seen,
        pool_quote,
    )?;
    let gnode = graph.node(index).ok_or(AutopilotError::NoSuchNode)?;

    let launch = a.ap.launch;
    let seeds = TreasurySeeds::new(&launch, a.ap.treasury_bump);
    let seeds = seeds.seeds();
    let signers = [Signer::from(&seeds)];
    let (mut skipped, mut kept) = (0u8, 0u64);
    let (bought, burned) = match &plan {
        Plan::Buyback {
            amount_in, min_out, ..
        } => buyback(a, *amount_in, *min_out, &signers)?,
        Plan::Burn { amount } => {
            require!(a.remaining.is_empty(), AutopilotError::UnexpectedAccounts);
            cpi::burn(
                a.token_2022_program,
                a.treasury_token,
                a.mint,
                a.treasury,
                *amount,
                a.decimals,
                &signers,
            )?;
            (0, *amount)
        }
        Plan::Distribute { shares, .. } => {
            (skipped, kept) = distribute(a, &graph, shares, &signers)?;
            (0, 0)
        }
    };

    // Record the run and the price, then the tip from what the action left.
    let treasury_sol = reload_amount(a.treasury_wsol)?;
    let caller = *a.caller.address();
    let autopilot_key = *a.autopilot.address();
    let ap = &mut *a.ap;
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
        cpi::transfer_wsol(
            a.token_program,
            a.treasury_wsol,
            a.wsol_mint,
            a.tip_account,
            a.treasury,
            tip,
            &signers,
        )?;
    }
    NodeRan {
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
    }
    .emit();
    Ok(())
}

/// `logic::plan_run` of this run (the node states in this frame, not the
/// handler's).
#[allow(clippy::too_many_arguments)]
#[inline(never)]
fn plan(
    a: &RunAccounts,
    graph: &Graph,
    index: usize,
    now: i64,
    amount: Option<u64>,
    graduated: bool,
    spot: Option<u128>,
    reference: u128,
    seen: Option<Seen>,
    pool_quote: Option<u64>,
) -> Result<Plan, ProgramError> {
    let ap = &*a.ap;
    let states = ap.node_states();
    let partial_spent = ap.partial_spent.get(index).copied().unwrap_or(0);
    Ok(logic::plan_run(&RunInput {
        graph,
        node: index,
        now,
        states: &states,
        operator: ap.operator,
        operator_signer: a.operator.map(|s| *s.address()),
        amount,
        treasury_sol: a.wsol_state.amount,
        treasury_token: a.token_state.amount,
        graduated,
        spot,
        reference,
        seen,
        pool_quote,
        partial_spent,
    })?)
}

/// Check a buyback's remaining accounts (DAMM v2's, exactly, for `pool`)
/// and return the pool's wSOL (its token B vault's balance).
fn damm_accounts(rest: &[AccountView], pool: &PoolView) -> Result<u64, ProgramError> {
    require!(
        rest.len() == BUYBACK_ACCOUNTS,
        AutopilotError::InvalidDammAccounts
    );
    // The first five, as the Anchor source's `rest[0]`..`rest[4]`: the
    // length check above is the only one (an exact-length pattern here or in
    // `buyback` would repeat it, and hide a mutant of it). The `else` is
    // unreachable.
    let [pool_authority, vault_a, vault_b, event_authority, program, ..] = rest else {
        return err!(AutopilotError::InvalidDammAccounts);
    };
    require!(
        same(pool_authority.address(), &DAMM_V2_POOL_AUTHORITY)
            && same(vault_a.address(), &pool.token_a_vault)
            && same(vault_b.address(), &pool.token_b_vault)
            && same(event_authority.address(), &DAMM_V2_EVENT_AUTHORITY)
            && same(program.address(), &DAMM_V2_PROGRAM_ID)
            && program.executable(),
        AutopilotError::InvalidDammAccounts
    );
    token_amount(vault_b)
}

/// The buyback: swap exactly `amount_in` treasury lamports on the pool for
/// at least `min_out` tokens, then burn exactly what arrived. The remaining
/// accounts are DAMM v2's, checked before planning (`damm_accounts`).
/// Returns (bought, burned).
fn buyback(
    a: &RunAccounts,
    amount_in: u64,
    min_out: u64,
    signers: &[Signer],
) -> Result<(u64, u64), ProgramError> {
    // The first five, as in `damm_accounts` (the Anchor source indexes
    // `rest[0]`..`rest[4]` here too). The `else` is unreachable.
    let [pool_authority, vault_a, vault_b, event_authority, program, ..] = a.remaining else {
        return err!(AutopilotError::InvalidDammAccounts);
    };
    let pool_account = a.damm_pool.ok_or(AutopilotError::InvalidPool)?;
    let sol_before = a.wsol_state.amount;
    let tokens_before = a.token_state.amount;
    cpi::damm_swap(
        &cpi::DammSwap {
            pool_authority,
            pool: pool_account,
            input: a.treasury_wsol,
            output: a.treasury_token,
            token_a_vault: vault_a,
            token_b_vault: vault_b,
            token_a_mint: a.mint,
            token_b_mint: a.wsol_mint,
            payer: a.treasury,
            token_a_program: a.token_2022_program,
            token_b_program: a.token_program,
            event_authority,
            program,
        },
        amount_in,
        min_out,
        signers,
    )?;
    let sol_after = token_amount(a.treasury_wsol)?;
    let tokens_after = token_amount(a.treasury_token)?;
    let bought = tokens_after
        .checked_sub(tokens_before)
        .ok_or(AutopilotError::SwapShortfall)?;
    require!(
        sol_before.checked_sub(sol_after) == Some(amount_in) && bought >= min_out,
        AutopilotError::SwapShortfall
    );
    cpi::burn(
        a.token_2022_program,
        a.treasury_token,
        a.mint,
        a.treasury,
        bought,
        a.decimals,
        signers,
    )?;
    // Everything bought is gone: the treasury holds what it held before.
    require!(
        token_amount(a.treasury_token)? == tokens_before,
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
fn distribute(
    a: &RunAccounts,
    graph: &Graph,
    shares: &[u64],
    signers: &[Signer],
) -> Result<(u8, u64), ProgramError> {
    let rest = a.remaining;
    require!(
        rest.len() == graph.recipient_count(),
        AutopilotError::InvalidRecipientAccounts
    );
    let (mut skipped, mut kept, mut paid) = (0u8, 0u64, 0u64);
    for (i, ata) in rest.iter().enumerate() {
        let recipient = graph
            .recipient(i)
            .ok_or(AutopilotError::InvalidRecipientAccounts)?;
        let owner = Pubkey::new_from_array(recipient.key);
        let expected = associated_token_address(&owner, &WSOL_MINT, &TOKEN_PROGRAM_ID);
        require!(
            same(ata.address(), &expected) && ata.is_writable(),
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
            a.token_program,
            a.treasury_wsol,
            a.wsol_mint,
            ata,
            a.treasury,
            share,
            signers,
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
fn is_wsol_account_of(info: &AccountView, owner: &Pubkey) -> bool {
    if !owned_by(info, &TOKEN_PROGRAM_ID) {
        return false;
    }
    let Ok(data) = info.try_borrow() else {
        return false;
    };
    let Ok(state) = unpack_token_account(&data) else {
        return false;
    };
    same(&state.mint(), &WSOL_MINT)
        && same(&state.owner(), owner)
        && state.state() == ACCOUNT_STATE_INITIALIZED
}

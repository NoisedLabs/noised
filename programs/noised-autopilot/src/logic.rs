//! Every decision the autopilot makes, as pure functions of its state and
//! inputs (host-tested in `tests/`): when a graph may be queued, which
//! authorizations may be used, whether and how much a node may move, how a
//! run is recorded and the tip (the reference price: `reference.rs`). The
//! instruction handlers read accounts, call these, then perform exactly the
//! planned CPIs.

use noised_rules::graph::{action, current_epoch, Graph, GraphCtx, NodeState, NotDue};

use crate::{
    constants::{
        BPS_DENOMINATOR, KEEPER_MIN_POOL_BPS, TIP_EPOCH_CAP, TIP_EPOCH_SECS, TIP_LAMPORTS,
        TIP_MAX_SHARE_BPS, UPDATE_TIMELOCK_SECS,
    },
    error::AutopilotError,
    launchpad::authorization::kind,
    price,
    reference::{self, Seen},
    state::{AuthMark, NodeRecord, MAX_NODES},
    Pubkey, Result,
};

/// Whether a graph may be queued to take effect at `activate_at` (spec §4
/// `activate`), given what is active and queued now:
///
/// * never once frozen;
/// * a first graph (none active, none queued): at `now` or later;
/// * otherwise (replacing an active graph, or a queued one holders can
///   already see): at least `UPDATE_TIMELOCK_SECS` after both now (when it
///   becomes visible in the autopilot) and the authorization landed.
pub fn check_activation(
    active: &[u8; 32],
    pending: &[u8; 32],
    frozen: bool,
    now: i64,
    activate_at: i64,
    auth_unix_time: i64,
) -> Result<()> {
    require!(!frozen, AutopilotError::Frozen);
    if *active == [0; 32] && *pending == [0; 32] {
        require!(activate_at >= now, AutopilotError::ActivationInPast);
    } else {
        let earliest = now
            .max(auth_unix_time)
            .checked_add(UPDATE_TIMELOCK_SECS)
            .ok_or(AutopilotError::MathOverflow)?;
        require!(activate_at >= earliest, AutopilotError::TimelockTooShort);
    }
    Ok(())
}

/// Authorizations are ordered by `(slot, address)`.
fn newer(a: &AuthMark, b: &AuthMark) -> bool {
    (a.slot, a.key) > (b.slot, b.key)
}

/// The index of a kind's mark in `Autopilot::auth_marks`.
pub fn mark_index(k: u8) -> Result<usize> {
    match k {
        kind::GRAPH_ACTIVATE => Ok(0),
        kind::GRAPH_FREEZE => Ok(1),
        kind::OPERATOR_REVOKE => Ok(2),
        _ => err!(AutopilotError::InvalidAuthorization),
    }
}

/// An authorization of kind `k` at `mark` is used only if it is newer than
/// the latest one used of its own kind (none is replayed, none older than a
/// decision already applied overrides it) and of the kinds it could undo:
///
/// * an activation never predates the latest revocation (it could appoint
///   a revoked operator again);
/// * a freeze never predates the latest activation (it would cancel a newer
///   queued graph).
///
/// A revocation only follows other revocations: no activation or freeze,
/// however new, voids a pending revocation of a compromised operator.
pub fn check_fresh(mark: &AuthMark, marks: &[AuthMark; 3], k: u8) -> Result<()> {
    let follows: &[u8] = match k {
        kind::GRAPH_ACTIVATE => &[kind::GRAPH_ACTIVATE, kind::OPERATOR_REVOKE],
        kind::GRAPH_FREEZE => &[kind::GRAPH_FREEZE, kind::GRAPH_ACTIVATE],
        kind::OPERATOR_REVOKE => &[kind::OPERATOR_REVOKE],
        _ => return err!(AutopilotError::InvalidAuthorization),
    };
    for other in follows {
        require!(
            newer(mark, &marks[mark_index(*other)?]),
            AutopilotError::StaleAuthorization
        );
    }
    Ok(())
}

/// Whether a freeze signed to be used until `not_after` may be used at `now`
/// (`freeze`; review 4, R5): up to and including that second.
pub fn check_freeze_window(now: i64, not_after: i64) -> Result<()> {
    require!(now <= not_after, AutopilotError::FreezeExpired);
    Ok(())
}

/// Whether the pending update is due at `now` (`apply_pending`).
pub fn check_apply(pending: &[u8; 32], activate_at: i64, frozen: bool, now: i64) -> Result<()> {
    require!(!frozen, AutopilotError::Frozen);
    require!(*pending != [0; 32], AutopilotError::NoPendingUpdate);
    require!(now >= activate_at, AutopilotError::UpdateNotDue);
    Ok(())
}

/// The error for a node that is not runnable.
pub fn not_due_error(reason: NotDue) -> AutopilotError {
    match reason {
        NotDue::NoSuchNode => AutopilotError::NoSuchNode,
        NotDue::Waiting | NotDue::AwaitingParent | NotDue::AlreadyRan => AutopilotError::NodeNotDue,
        NotDue::NotGraduated => AutopilotError::NotGraduated,
        NotDue::MaxRunsReached => AutopilotError::MaxRunsReached,
        NotDue::BudgetSpent => AutopilotError::BudgetSpent,
        NotDue::ConditionFalse => AutopilotError::ConditionFalse,
        NotDue::Malformed => AutopilotError::InvalidGraph,
    }
}

/// The least a keeper may choose for a buyback: `KEEPER_MIN_POOL_BPS` of
/// the pool's wSOL (`pool_quote`).
pub fn keeper_floor(pool_quote: u64) -> u64 {
    // At most pool_quote: fits.
    (u128::from(pool_quote) * u128::from(KEEPER_MIN_POOL_BPS) / u128::from(BPS_DENOMINATOR)) as u64
}

/// What a run moves, within `limit = min(cap, available)`:
///
/// * the operator chooses an amount in `1..=limit` on its gated nodes, and
///   must choose one;
/// * a keeper moves `limit`, or, where `keeper_floor` is given (buybacks),
///   chooses an amount from `min(floor, limit)` (at least 1) up to `limit`:
///   a buyback too large for the pool within the premium still runs in
///   smaller steps, and nobody can waste a run on dust. Elsewhere a keeper
///   must not choose. A chosen amount below `cap` is a partial run (audit
///   4, A4-2: it leaves the node's run open) and must leave at least the
///   floor of the cap for the run's remainder, so no partial run can leave
///   a remainder too small to swap.
pub fn run_amount(
    gated: bool,
    amount: Option<u64>,
    cap: u64,
    available: u64,
    keeper_floor: Option<u64>,
) -> Result<u64> {
    let limit = cap.min(available);
    match (gated, amount) {
        (true, Some(amount)) => {
            require!(amount > 0 && amount <= limit, AutopilotError::InvalidAmount);
            Ok(amount)
        }
        (true, None) => err!(AutopilotError::InvalidAmount),
        (false, None) => {
            require!(limit > 0, AutopilotError::NothingToDo);
            Ok(limit)
        }
        (false, Some(amount)) => {
            let floor = keeper_floor.ok_or(AutopilotError::AmountNotAllowed)?;
            require!(limit > 0, AutopilotError::NothingToDo);
            require!(amount <= limit, AutopilotError::InvalidAmount);
            require!(
                amount >= floor.min(limit).max(1),
                AutopilotError::AmountTooSmall
            );
            require!(
                amount == cap || cap - amount >= floor,
                AutopilotError::RemainderTooSmall
            );
            Ok(amount)
        }
    }
}

/// What a run will do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Plan {
    /// Swap exactly `amount_in` treasury lamports for at least `min_out`
    /// tokens on the launch's pool, then burn every token received.
    /// `partial`: a keeper chose less than the node's cap (audit 4, A4-2);
    /// the run spends from the budget but leaves the node's run open.
    Buyback {
        amount_in: u64,
        min_out: u64,
        partial: bool,
    },
    /// Burn `amount` treasury tokens.
    Burn { amount: u64 },
    /// Pay `shares[i]` lamports to recipient `i` (their sum is the spend;
    /// rounding dust stays in the treasury).
    Distribute {
        shares: [u64; noised_rules::graph::MAX_RECIPIENTS as usize],
        total: u64,
    },
}

impl Plan {
    /// What the run counts against the node's budget.
    pub fn spent(&self) -> u64 {
        match *self {
            Plan::Buyback { amount_in, .. } => amount_in,
            Plan::Burn { amount } => amount,
            Plan::Distribute { total, .. } => total,
        }
    }

    /// What the run moved, in lamports (what its tip is a share of):
    /// lamports swapped; tokens burned at `burn_price` ([`burn_price`]);
    /// lamports paid (the shares less the `kept` ones of recipients that
    /// had no account, audit 4, M4).
    pub fn value(&self, burn_price: u128, kept: u64) -> u64 {
        match *self {
            Plan::Buyback { amount_in, .. } => amount_in,
            Plan::Burn { amount } => price::token_value(amount, burn_price),
            Plan::Distribute { total, .. } => total.saturating_sub(kept),
        }
    }

    /// A keeper's partial buyback (audit 4, A4-2).
    pub fn partial(&self) -> bool {
        matches!(*self, Plan::Buyback { partial: true, .. })
    }

    /// The most the run's tip may be: `TIP_LAMPORTS`, or for a partial
    /// buyback its share `TIP_LAMPORTS * amount_in / p1` (audit 4, A4-2), so
    /// the partial runs of a node's run together earn less than one tip.
    pub fn max_tip(&self, p1: u64) -> u64 {
        match *self {
            Plan::Buyback {
                amount_in,
                partial: true,
                ..
            } => {
                // amount_in < p1: below TIP_LAMPORTS, fits.
                (u128::from(TIP_LAMPORTS) * u128::from(amount_in) / u128::from(p1.max(1))) as u64
            }
            _ => TIP_LAMPORTS,
        }
    }
}

/// The price a burn's tokens are valued at for its tip (audit 4, A4-4):
/// none before graduation (the only price then is the migration price,
/// which the curve can be far below: a burn earns no tip), after it the
/// lower of the reference and the lowest price observed in the window
/// (`reference::lowest`, this run's observation included).
pub fn burn_price(graduated: bool, reference: u128, lowest: Option<u128>) -> u128 {
    if !graduated {
        return 0;
    }
    lowest.map_or(reference, |l| reference.min(l))
}

/// Everything `run` decides from.
pub struct RunInput<'a, 'g> {
    pub graph: &'a Graph<'g>,
    pub node: usize,
    pub now: i64,
    pub states: &'a [NodeState; MAX_NODES],
    /// The stored operator (default: none or revoked).
    pub operator: Pubkey,
    /// The `operator` account of the instruction, if it signed.
    pub operator_signer: Option<Pubkey>,
    /// The caller's chosen amount, if any.
    pub amount: Option<u64>,
    pub treasury_sol: u64,
    pub treasury_token: u64,
    /// The launch graduated: its DAMM v2 pool is bound.
    pub graduated: bool,
    /// The pool's sqrt price before the action (`None` before graduation,
    /// or if an action that does not trade could not read it).
    pub spot: Option<u128>,
    /// The reference sqrt price, after this run's observation.
    pub reference: u128,
    /// What the observation window saw, this run's observation included.
    pub seen: Option<Seen>,
    /// The pool's wSOL, for a buyback.
    pub pool_quote: Option<u64>,
    /// What partial buybacks of the node moved since it last completed a
    /// run (`Autopilot::partial_spent`).
    pub partial_spent: u64,
}

/// Decide a run (spec §4 `run`), checking in this order: the node exists;
/// an operator-gated node is signed by the operator; the node is due
/// (trigger, runs this epoch, budget) and its condition holds (on the
/// reference price); a buyback only after graduation, only with a usable
/// observation window, and only while the pool price is within the node's
/// premium over the lower of the reference and the lowest observed price
/// (`reference::buyback_cap`), which also prices its minimum out; the
/// amount (see [`run_amount`]) within the node's cap, `min(p1, budget
/// left)`, less what partial buybacks moved of its open run; a distribution
/// pays something.
pub fn plan_run(input: &RunInput) -> Result<Plan> {
    let g = input.graph;
    let node = g.node(input.node).ok_or(AutopilotError::NoSuchNode)?;
    let gated = node.operator_gated == 1;
    if gated {
        require!(
            input.operator != Pubkey::default(),
            AutopilotError::NoOperator
        );
        require!(
            input.operator_signer == Some(input.operator),
            AutopilotError::WrongOperator
        );
    }
    let ctx = GraphCtx {
        now: input.now,
        treasury_sol: input.treasury_sol,
        treasury_token: input.treasury_token,
        graduated: input.graduated,
        sqrt_price: input.reference,
        runs_in_epoch: g.runs_in_epoch(input.states, input.now),
    };
    g.runnable(input.node, input.states, &ctx)
        .map_err(not_due_error)?;
    let state = input
        .states
        .get(input.node)
        .ok_or(AutopilotError::NoSuchNode)?;
    let cap = g
        .run_cap(input.node, state, input.now)
        .min(node.p1.saturating_sub(input.partial_spent));
    match node.action {
        action::BUYBACK_BURN => {
            require!(input.graduated, AutopilotError::NotGraduated);
            let spot = input.spot.ok_or(AutopilotError::InvalidPool)?;
            let bound = reference::buyback_cap(input.reference, input.seen)
                .ok_or(AutopilotError::PriceNotObserved)?;
            require!(
                price::within_premium(spot, bound, node.p2),
                AutopilotError::PremiumExceeded
            );
            let quote = input
                .pool_quote
                .ok_or(AutopilotError::InvalidDammAccounts)?;
            let amount_in = run_amount(
                gated,
                input.amount,
                cap,
                input.treasury_sol,
                Some(keeper_floor(quote)),
            )?;
            let min_out = price::min_out(amount_in, bound, node.p2)
                .filter(|m| *m > 0)
                .ok_or(AutopilotError::PriceOutOfRange)?;
            Ok(Plan::Buyback {
                amount_in,
                min_out,
                partial: !gated && input.amount.is_some() && amount_in < cap,
            })
        }
        action::BURN => {
            let amount = run_amount(gated, input.amount, cap, input.treasury_token, None)?;
            Ok(Plan::Burn { amount })
        }
        action::DISTRIBUTE_SOL => {
            let amount = run_amount(gated, input.amount, cap, input.treasury_sol, None)?;
            let shares = g.shares(amount);
            let total = shares
                .iter()
                .try_fold(0u64, |sum, s| sum.checked_add(*s))
                .ok_or(AutopilotError::MathOverflow)?;
            require!(total > 0, AutopilotError::NothingToDo);
            Ok(Plan::Distribute { shares, total })
        }
        _ => err!(AutopilotError::InvalidGraph),
    }
}

/// Record a successful run of `spent` at `now`: the next sequence number,
/// the node's spend this epoch (rolled over first), then either
///
/// * a completed run: the epoch's runs, its last run and sequence number,
///   and a closed run (`partial_spent` cleared); or
/// * a partial buyback (audit 4, A4-2): only what it moved of the open run
///   (`partial_spent`). It is no run: the node stays due, its runs this
///   epoch and its last run are unchanged.
pub fn record_run(
    node: &mut NodeRecord,
    partial_spent: &mut u64,
    seq: &mut u64,
    epoch_secs: u32,
    now: i64,
    spent: u64,
    partial: bool,
) -> Result<()> {
    let epoch = current_epoch(epoch_secs, &NodeState::from(*node), now);
    *seq = seq.checked_add(1).ok_or(AutopilotError::MathOverflow)?;
    node.epoch_start = epoch.start;
    node.spent_in_epoch = epoch
        .spent
        .checked_add(spent)
        .ok_or(AutopilotError::MathOverflow)?;
    if partial {
        node.runs_in_epoch = epoch.runs;
        *partial_spent = partial_spent
            .checked_add(spent)
            .ok_or(AutopilotError::MathOverflow)?;
        return Ok(());
    }
    node.runs_in_epoch = epoch
        .runs
        .checked_add(1)
        .ok_or(AutopilotError::MathOverflow)?;
    node.last_run = now;
    node.last_seq = *seq;
    *partial_spent = 0;
    Ok(())
}

/// The tip for a run at `now` that moved `value` lamports' worth
/// (`Plan::value`): `min(TIP_LAMPORTS, max_tip (Plan::max_tip), what is
/// left of TIP_EPOCH_CAP this tip epoch, the treasury's wSOL,
/// TIP_MAX_SHARE_BPS of value)`, counted. Tip epochs are UTC days and only
/// ever move forward.
pub fn take_tip(
    epoch_start: &mut i64,
    in_epoch: &mut u64,
    now: i64,
    treasury_sol: u64,
    value: u64,
    max_tip: u64,
) -> u64 {
    let start = now.saturating_sub(crate::int::rem_euclid(now, TIP_EPOCH_SECS));
    if start > *epoch_start {
        *epoch_start = start;
        *in_epoch = 0;
    }
    // At most value: fits.
    let share =
        (u128::from(value) * u128::from(TIP_MAX_SHARE_BPS) / u128::from(BPS_DENOMINATOR)) as u64;
    let tip = TIP_LAMPORTS
        .min(max_tip)
        .min(TIP_EPOCH_CAP.saturating_sub(*in_epoch))
        .min(treasury_sol)
        .min(share);
    *in_epoch = in_epoch.saturating_add(tip);
    tip
}

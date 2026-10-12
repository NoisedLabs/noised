//! Every decision in `logic`, each guard at its edges and in its order.

use noised_rules::{
    graph::{action::*, trigger::*, NodeState, NotDue},
    op, Graph, Node,
};

use super::*;
use crate::{
    constants::*,
    launchpad::authorization::kind,
    logic::{self, Plan, RunInput},
    price,
    reference::Seen,
    state::{AuthMark, NodeRecord, MAX_NODES},
};

const NOW: i64 = 1_800_000_000;

#[test]
fn bounds_are_the_documented_ones() {
    // Spec §4 and the SDK's AUTOPILOT constants
    // (sdk/src/programmable/constants.ts).
    assert_eq!(UPDATE_TIMELOCK_SECS, 259_200);
    assert_eq!(TIP_LAMPORTS, 100_000);
    assert_eq!(TIP_EPOCH_SECS, 86_400);
    assert_eq!(TIP_EPOCH_CAP, 5_000_000);
    assert_eq!(TIP_MAX_SHARE_BPS, 1_000);
    assert_eq!(KEEPER_MIN_POOL_BPS, 100);
    assert_eq!((OBS_BUCKET_SECS, OBS_MIN_SPAN_SECS), (900, 60));
    assert_eq!(REF_UP_SQRT_BPS_PER_HOUR, 243);
    assert_eq!(REF_ALLOWANCE_MAX, 243 * 3_600);
    assert_eq!(REF_ALLOWANCE_SCALE, u128::from(BPS_DENOMINATOR) * 3_600);
    // However a rise is split, at most e^0.0243 in sqrt price an hour:
    // under 1.0246, so under 5% of price.
    let hour = (REF_UP_SQRT_BPS_PER_HOUR as f64 / 10_000.0).exp();
    assert!(hour <= 1.0246 && hour * hour <= 1.05 && hour * hour > 1.0497);
}

#[test]
fn first_graph_activates_now_or_later() {
    let none = [0u8; 32];
    logic::check_activation(&none, &none, false, NOW, NOW, NOW).unwrap();
    logic::check_activation(&none, &none, false, NOW, NOW + 1, NOW).unwrap();
    assert_err(
        logic::check_activation(&none, &none, false, NOW, NOW - 1, NOW),
        AutopilotError::ActivationInPast,
    );
    assert_err(
        logic::check_activation(&none, &none, true, NOW, NOW + 10, NOW),
        AutopilotError::Frozen,
    );
}

#[test]
fn replacement_waits_for_the_timelock() {
    let none = [0u8; 32];
    let active = [7u8; 32];
    let t = UPDATE_TIMELOCK_SECS;
    assert_eq!(t, 72 * 3_600);
    logic::check_activation(&active, &none, false, NOW, NOW + t, NOW - 100).unwrap();
    assert_err(
        logic::check_activation(&active, &none, false, NOW, NOW + t - 1, NOW - 100),
        AutopilotError::TimelockTooShort,
    );
    // Counted from the later of now and the authorization's landing.
    logic::check_activation(&active, &none, false, NOW, NOW + 50 + t, NOW + 50).unwrap();
    assert_err(
        logic::check_activation(&active, &none, false, NOW, NOW + 49 + t, NOW + 50),
        AutopilotError::TimelockTooShort,
    );
    // An authorization signed long ago does not shorten it.
    assert_err(
        logic::check_activation(&active, &none, false, NOW, NOW + 10, NOW - 10 * t),
        AutopilotError::TimelockTooShort,
    );
    assert_err(
        logic::check_activation(&active, &none, true, NOW, NOW + 2 * t, NOW),
        AutopilotError::Frozen,
    );
    assert_err(
        logic::check_activation(&active, &none, false, i64::MAX - 5, i64::MAX, 0),
        AutopilotError::MathOverflow,
    );
}

#[test]
fn replacing_a_queued_first_graph_waits_for_the_timelock() {
    // Review (info): a first graph counting down is visible to holders; a
    // replacement must not take effect sooner than 72 hours.
    let none = [0u8; 32];
    let queued = [9u8; 32];
    let t = UPDATE_TIMELOCK_SECS;
    assert_err(
        logic::check_activation(&none, &queued, false, NOW, NOW, NOW),
        AutopilotError::TimelockTooShort,
    );
    assert_err(
        logic::check_activation(&none, &queued, false, NOW, NOW + t - 1, NOW),
        AutopilotError::TimelockTooShort,
    );
    logic::check_activation(&none, &queued, false, NOW, NOW + t, NOW).unwrap();
}

fn mark(slot: u64, k: u8) -> AuthMark {
    AuthMark { slot, key: key(k) }
}

#[test]
fn authorizations_are_ordered_by_slot_then_address() {
    let none = [AuthMark::default(); 3];
    for k in [
        kind::GRAPH_ACTIVATE,
        kind::GRAPH_FREEZE,
        kind::OPERATOR_REVOKE,
    ] {
        logic::check_fresh(&mark(1, 1), &none, k).unwrap();
        // Slot 0 with any real address is still newer than nothing.
        logic::check_fresh(&mark(0, 1), &none, k).unwrap();
        assert_err(
            logic::check_fresh(&AuthMark::default(), &none, k),
            AutopilotError::StaleAuthorization,
        );
        let i = logic::mark_index(k).unwrap();
        let mut used = none;
        used[i] = mark(100, 5);
        // Replayed, older, same slot below: stale. Same slot above, later: fresh.
        for (m, ok) in [
            (mark(100, 5), false),
            (mark(99, 9), false),
            (mark(100, 4), false),
            (mark(100, 6), true),
            (mark(101, 0), true),
        ] {
            let r = logic::check_fresh(&m, &used, k);
            if ok {
                r.unwrap();
            } else {
                assert_err(r, AutopilotError::StaleAuthorization);
            }
        }
    }
    assert_err(
        logic::check_fresh(&mark(1, 1), &none, 4),
        AutopilotError::InvalidAuthorization,
    );
    assert_err(logic::mark_index(0), AutopilotError::InvalidAuthorization);
    assert_eq!([1, 2, 3].map(|k| logic::mark_index(k).unwrap()), [0, 1, 2]);
}

#[test]
fn kinds_only_void_what_they_could_undo() {
    use kind::*;
    let at = |k: u8, slot: u64| {
        let mut m = [AuthMark::default(); 3];
        m[logic::mark_index(k).unwrap()] = mark(slot, 1);
        m
    };
    // Review F3: a newer activation (or freeze) never voids a pending
    // revocation of a compromised operator.
    logic::check_fresh(&mark(10, 1), &at(GRAPH_ACTIVATE, 11), OPERATOR_REVOKE).unwrap();
    logic::check_fresh(&mark(10, 1), &at(GRAPH_FREEZE, 11), OPERATOR_REVOKE).unwrap();
    // An activation signed before the latest revocation could appoint the
    // revoked operator again: void.
    assert_err(
        logic::check_fresh(&mark(10, 1), &at(OPERATOR_REVOKE, 11), GRAPH_ACTIVATE),
        AutopilotError::StaleAuthorization,
    );
    logic::check_fresh(&mark(12, 1), &at(OPERATOR_REVOKE, 11), GRAPH_ACTIVATE).unwrap();
    // A freeze signed before the latest activation would cancel the newer
    // queued graph: void.
    assert_err(
        logic::check_fresh(&mark(10, 1), &at(GRAPH_ACTIVATE, 11), GRAPH_FREEZE),
        AutopilotError::StaleAuthorization,
    );
    logic::check_fresh(&mark(12, 1), &at(GRAPH_ACTIVATE, 11), GRAPH_FREEZE).unwrap();
    // A freeze does not void activations (a frozen graph refuses them
    // anyway), nor a revocation freezes.
    logic::check_fresh(&mark(10, 1), &at(GRAPH_FREEZE, 11), GRAPH_ACTIVATE).unwrap();
    logic::check_fresh(&mark(10, 1), &at(OPERATOR_REVOKE, 11), GRAPH_FREEZE).unwrap();
}

/// Review 4, R5: a freeze is used up to and including the `not_after` it
/// was signed with, never after.
#[test]
fn a_freeze_is_used_only_until_its_not_after() {
    logic::check_freeze_window(NOW, NOW).unwrap();
    logic::check_freeze_window(NOW - 1, NOW).unwrap();
    logic::check_freeze_window(i64::MIN, i64::MAX).unwrap();
    assert_err(
        logic::check_freeze_window(NOW + 1, NOW),
        AutopilotError::FreezeExpired,
    );
    assert_err(
        logic::check_freeze_window(i64::MAX, i64::MAX - 1),
        AutopilotError::FreezeExpired,
    );
}

/// Clients map error numbers to messages: variants are only ever appended
/// (review 4 appended `FreezeExpired`, audit 4 `RemainderTooSmall` and
/// `NoRecipientAccount`).
#[test]
fn error_numbers_only_grow() {
    assert_eq!(num(AutopilotError::NotALaunch), 6_000);
    assert_eq!(num(AutopilotError::InvalidAuthorization), 6_008);
    assert_eq!(num(AutopilotError::Frozen), 6_010);
    assert_eq!(num(AutopilotError::PoolAlreadyBound), 6_039);
    assert_eq!(num(AutopilotError::FreezeExpired), 6_040);
    assert_eq!(num(AutopilotError::RemainderTooSmall), 6_041);
    assert_eq!(num(AutopilotError::NoRecipientAccount), 6_042);
}

#[test]
fn pending_applies_at_its_time() {
    let p = [3u8; 32];
    logic::check_apply(&p, NOW, false, NOW).unwrap();
    logic::check_apply(&p, NOW, false, NOW + 1).unwrap();
    assert_err(
        logic::check_apply(&p, NOW, false, NOW - 1),
        AutopilotError::UpdateNotDue,
    );
    assert_err(
        logic::check_apply(&[0; 32], NOW, false, NOW),
        AutopilotError::NoPendingUpdate,
    );
    assert_err(
        logic::check_apply(&p, NOW, true, NOW),
        AutopilotError::Frozen,
    );
}

#[test]
fn not_due_reasons_map_to_errors() {
    use AutopilotError as E;
    let cases = [
        (NotDue::NoSuchNode, E::NoSuchNode),
        (NotDue::Waiting, E::NodeNotDue),
        (NotDue::AwaitingParent, E::NodeNotDue),
        (NotDue::NotGraduated, E::NotGraduated),
        (NotDue::AlreadyRan, E::NodeNotDue),
        (NotDue::MaxRunsReached, E::MaxRunsReached),
        (NotDue::BudgetSpent, E::BudgetSpent),
        (NotDue::ConditionFalse, E::ConditionFalse),
        (NotDue::Malformed, E::InvalidGraph),
    ];
    assert_eq!(cases.len(), NotDue::ALL.len());
    for (reason, error) in cases {
        assert_eq!(num(logic::not_due_error(reason)), num(error), "{reason:?}");
    }
}

#[test]
fn run_amount_keepers_take_the_most_operators_choose() {
    use AutopilotError as E;
    assert_eq!(logic::run_amount(false, None, 10, 100, None).unwrap(), 10);
    assert_eq!(logic::run_amount(false, None, 10, 7, None).unwrap(), 7);
    assert_err(logic::run_amount(false, None, 10, 0, None), E::NothingToDo);
    assert_err(
        logic::run_amount(false, Some(5), 10, 100, None),
        E::AmountNotAllowed,
    );
    assert_eq!(logic::run_amount(true, Some(1), 10, 100, None).unwrap(), 1);
    assert_eq!(
        logic::run_amount(true, Some(10), 10, 100, None).unwrap(),
        10
    );
    assert_eq!(logic::run_amount(true, Some(7), 10, 7, None).unwrap(), 7);
    assert_err(
        logic::run_amount(true, Some(11), 10, 100, None),
        E::InvalidAmount,
    );
    assert_err(
        logic::run_amount(true, Some(8), 10, 7, None),
        E::InvalidAmount,
    );
    assert_err(
        logic::run_amount(true, Some(0), 10, 100, None),
        E::InvalidAmount,
    );
    assert_err(
        logic::run_amount(true, None, 10, 100, None),
        E::InvalidAmount,
    );
    // The operator is not bound by a keeper's floor.
    assert_eq!(
        logic::run_amount(true, Some(1), 10, 100, Some(5)).unwrap(),
        1
    );
}

#[test]
fn keepers_may_shrink_a_buyback_down_to_the_floor() {
    // Review F4: a buyback too large for the pool within the premium runs
    // in smaller steps; the floor (1% of the pool's wSOL) keeps dust out.
    use AutopilotError as E;
    assert_eq!(logic::keeper_floor(10_000_000_000), 100_000_000);
    assert_eq!(logic::keeper_floor(99), 0);
    assert_eq!(logic::keeper_floor(u64::MAX), u64::MAX / 100);
    let floor = Some(100);
    // No amount: the most, as before.
    assert_eq!(
        logic::run_amount(false, None, 1_000, 5_000, floor).unwrap(),
        1_000
    );
    // From the floor to the most.
    assert_eq!(
        logic::run_amount(false, Some(100), 1_000, 5_000, floor).unwrap(),
        100
    );
    assert_eq!(
        logic::run_amount(false, Some(1_000), 1_000, 5_000, floor).unwrap(),
        1_000
    );
    assert_err(
        logic::run_amount(false, Some(99), 1_000, 5_000, floor),
        E::AmountTooSmall,
    );
    assert_err(
        logic::run_amount(false, Some(1_001), 1_000, 5_000, floor),
        E::InvalidAmount,
    );
    assert_err(
        logic::run_amount(false, Some(1), 1_000, 5_000, floor),
        E::AmountTooSmall,
    );
    // A floor above the most: only the most.
    assert_eq!(
        logic::run_amount(false, Some(50), 50, 5_000, floor).unwrap(),
        50
    );
    assert_err(
        logic::run_amount(false, Some(49), 50, 5_000, floor),
        E::AmountTooSmall,
    );
    // The treasury bounds it too; a zero floor still means at least 1.
    assert_eq!(
        logic::run_amount(false, Some(30), 1_000, 30, floor).unwrap(),
        30
    );
    assert_err(
        logic::run_amount(false, Some(0), 1_000, 5_000, Some(0)),
        E::AmountTooSmall,
    );
    assert_eq!(
        logic::run_amount(false, Some(1), 1_000, 5_000, Some(0)).unwrap(),
        1
    );
    assert_err(
        logic::run_amount(false, Some(5), 1_000, 0, floor),
        E::NothingToDo,
    );
}

/// A fixture: a graph, its node states and the inputs of a run.
struct Fx {
    bytes: Vec<u8>,
    states: [NodeState; MAX_NODES],
    operator: Pubkey,
    signer: Option<Pubkey>,
    amount: Option<u64>,
    sol: u64,
    tokens: u64,
    graduated: bool,
    spot: Option<u128>,
    reference: u128,
    seen: Option<Seen>,
    pool_quote: Option<u64>,
    now: i64,
    partial_spent: u64,
}

const ONE: u128 = 1u128 << 64;
const OPERATOR: u8 = 0xEE;

fn seen_at(price: u128) -> Option<Seen> {
    Some(Seen {
        min: price,
        max: price,
    })
}

impl Fx {
    fn new(nodes: Vec<GNode>, cond: Vec<Node>) -> Self {
        let gated = nodes.iter().any(|n| n.operator_gated == 1);
        let operator = gated.then(|| key(OPERATOR));
        Fx {
            bytes: encode(&program(nodes, cond, operator)),
            states: [NodeState::default(); MAX_NODES],
            operator: operator.unwrap_or_default(),
            signer: None,
            amount: None,
            sol: 50_000_000_000,
            tokens: 1_000_000_000,
            graduated: true,
            spot: Some(ONE),
            reference: ONE,
            seen: seen_at(ONE),
            pool_quote: Some(100_000_000_000),
            now: NOW,
            partial_spent: 0,
        }
    }

    /// Graduated, the pool at `sqrt_price` and observed there.
    fn pool_at(&mut self, sqrt_price: u128) {
        self.graduated = true;
        self.spot = Some(sqrt_price);
        self.seen = seen_at(sqrt_price);
    }

    fn not_graduated(&mut self) {
        self.graduated = false;
        self.spot = None;
        self.seen = None;
        self.pool_quote = None;
    }

    fn plan(&self, node: usize) -> Result<Plan> {
        let g = Graph::parse(&self.bytes).unwrap();
        logic::plan_run(&RunInput {
            graph: &g,
            node,
            now: self.now,
            states: &self.states,
            operator: self.operator,
            operator_signer: self.signer,
            amount: self.amount,
            treasury_sol: self.sol,
            treasury_token: self.tokens,
            graduated: self.graduated,
            spot: self.spot,
            reference: self.reference,
            seen: self.seen,
            pool_quote: self.pool_quote,
            partial_spent: self.partial_spent,
        })
    }
}

#[test]
fn plan_buyback_burn_distribute() {
    let fx = Fx::new(
        vec![
            every(3_600, BUYBACK_BURN, 1_000_000_000, 300),
            every(3_600, BURN, 5_000, 0),
            every(3_600, DISTRIBUTE_SOL, 1_000_000_001, 0),
        ],
        vec![],
    );
    let min_out = price::min_out(1_000_000_000, ONE, 300).unwrap();
    assert_eq!(
        fx.plan(0).unwrap(),
        Plan::Buyback {
            amount_in: 1_000_000_000,
            min_out,
            partial: false
        }
    );
    assert_eq!(fx.plan(1).unwrap(), Plan::Burn { amount: 5_000 });
    let mut shares = [0u64; 8];
    shares[0] = 700_000_000; // floor(1_000_000_001 * 0.7)
    shares[1] = 300_000_000;
    assert_eq!(
        fx.plan(2).unwrap(),
        Plan::Distribute {
            shares,
            total: 1_000_000_000
        }
    );
    assert_eq!(fx.plan(2).unwrap().spent(), 1_000_000_000);
    assert_eq!(fx.plan(0).unwrap().spent(), 1_000_000_000);
    assert_err(fx.plan(3), AutopilotError::NoSuchNode);
    assert_err(fx.plan(255), AutopilotError::NoSuchNode);
}

#[test]
fn plan_value_is_what_the_run_moves() {
    // Lamports for buybacks and distributions (what was paid: audit 4,
    // M4, the shares kept for recipients without an account do not count);
    // burned tokens at the burn price.
    let b = Plan::Buyback {
        amount_in: 7,
        min_out: 1,
        partial: false,
    };
    assert_eq!(b.value(ONE * 1_000, 0), 7);
    let d = Plan::Distribute {
        shares: [0; 8],
        total: 9,
    };
    assert_eq!(d.value(1, 0), 9);
    assert_eq!(d.value(1, 4), 5);
    assert_eq!(d.value(1, 9), 0);
    let burn = Plan::Burn { amount: 1_000 };
    // sqrt 2^64: one lamport per raw token; sqrt 2^63: a quarter.
    assert_eq!(burn.value(ONE, 0), 1_000);
    assert_eq!(burn.value(ONE / 2, 0), 250);
    assert_eq!(burn.value(1, 0), 0);
    // Before graduation a burn is worth nothing (audit 4, A4-4).
    assert_eq!(burn.value(logic::burn_price(false, ONE, Some(ONE)), 0), 0);
}

#[test]
fn plan_amount_is_bounded_by_cap_budget_and_treasury() {
    let mut n = every(3_600, BUYBACK_BURN, 1_000, 2_000);
    n.budget_per_epoch = 2_500;
    let mut fx = Fx::new(vec![n, every(3_600, BURN, 1_000, 0)], vec![]);
    // Budget left 500 < p1.
    fx.states[0].epoch_start = NOW - 10;
    fx.states[0].spent_in_epoch = 2_000;
    fx.states[0].runs_in_epoch = 2;
    match fx.plan(0).unwrap() {
        Plan::Buyback { amount_in, .. } => assert_eq!(amount_in, 500),
        p => panic!("{p:?}"),
    }
    // Treasury below the cap.
    fx.sol = 321;
    match fx.plan(0).unwrap() {
        Plan::Buyback { amount_in, .. } => assert_eq!(amount_in, 321),
        p => panic!("{p:?}"),
    }
    fx.sol = 0;
    assert_err(fx.plan(0), AutopilotError::NothingToDo);
    fx.tokens = 0;
    assert_err(fx.plan(1), AutopilotError::NothingToDo);
    fx.tokens = 999;
    assert_eq!(fx.plan(1).unwrap(), Plan::Burn { amount: 999 });
    // A new epoch restores the budget.
    fx.sol = 10_000;
    fx.now = NOW - 10 + 86_400;
    match fx.plan(0).unwrap() {
        Plan::Buyback { amount_in, .. } => assert_eq!(amount_in, 1_000),
        p => panic!("{p:?}"),
    }
}

#[test]
fn plan_keeper_amounts_only_on_buybacks() {
    use AutopilotError as E;
    let mut fx = Fx::new(
        vec![
            every(3_600, BUYBACK_BURN, 1_000_000_000, 500),
            every(3_600, BURN, 10, 0),
            every(3_600, DISTRIBUTE_SOL, 1_000, 0),
        ],
        vec![],
    );
    // The pool holds 10 SOL: the floor is 0.1 SOL.
    fx.pool_quote = Some(10_000_000_000);
    fx.amount = Some(100_000_000);
    match fx.plan(0).unwrap() {
        Plan::Buyback {
            amount_in, min_out, ..
        } => {
            assert_eq!(amount_in, 100_000_000);
            assert_eq!(min_out, price::min_out(100_000_000, ONE, 500).unwrap());
        }
        p => panic!("{p:?}"),
    }
    fx.amount = Some(99_999_999);
    assert_err(fx.plan(0), E::AmountTooSmall);
    fx.amount = Some(1_000_000_001);
    assert_err(fx.plan(0), E::InvalidAmount);
    // Burns and distributions: no amount from a keeper.
    fx.amount = Some(5);
    assert_err(fx.plan(1), E::AmountNotAllowed);
    assert_err(fx.plan(2), E::AmountNotAllowed);
    // A buyback without DAMM v2's accounts read: refused.
    fx.amount = None;
    fx.pool_quote = None;
    assert_err(fx.plan(0), E::InvalidDammAccounts);
}

#[test]
fn plan_refuses_when_not_due() {
    let mut fx = Fx::new(
        vec![
            every(3_600, BURN, 10, 0),
            gnode(AFTER, 0, BURN, 10, 0),
            gnode(ON_GRADUATED, 0, BURN, 10, 0),
        ],
        vec![],
    );
    // EVERY: due at last_run + secs exactly.
    fx.states[0].last_run = NOW - 3_599;
    fx.states[0].last_seq = 1;
    assert_err(fx.plan(0), AutopilotError::NodeNotDue);
    fx.states[0].last_run = NOW - 3_600;
    fx.plan(0).unwrap();
    // AFTER: once per parent success.
    fx.states[1].last_seq = 1;
    assert_err(fx.plan(1), AutopilotError::NodeNotDue);
    fx.states[0].last_seq = 2;
    fx.plan(1).unwrap();
    // ON_GRADUATED: after graduation (the pool bound), once; a pool the
    // run could not read does not matter.
    fx.not_graduated();
    assert_err(fx.plan(2), AutopilotError::NotGraduated);
    fx.graduated = true;
    fx.plan(2).unwrap();
    fx.states[2].last_seq = 3;
    assert_err(fx.plan(2), AutopilotError::NodeNotDue);
}

#[test]
fn plan_refuses_past_runs_or_budget() {
    let mut n = every(600, BURN, 10, 0);
    n.max_runs_per_epoch = 2;
    n.budget_per_epoch = 15;
    let mut fx = Fx::new(vec![n], vec![]);
    fx.states[0].epoch_start = NOW - 100;
    fx.states[0].runs_in_epoch = 2;
    assert_err(fx.plan(0), AutopilotError::MaxRunsReached);
    fx.states[0].runs_in_epoch = 1;
    fx.states[0].spent_in_epoch = 15;
    assert_err(fx.plan(0), AutopilotError::BudgetSpent);
    fx.states[0].spent_in_epoch = 14;
    assert_eq!(fx.plan(0).unwrap(), Plan::Burn { amount: 1 });
}

fn leaf(op: u8, a: u8, arg: u64) -> Node {
    Node { op, a, arg }
}

#[test]
fn plan_checks_the_condition_on_the_reference_price() {
    // WHEN price <= 1.0 (sqrt 2^64) AND treasury SOL >= 2 SOL.
    let mut n = gnode(WHEN, 0, BURN, 10, 0);
    n.cond_len = 3;
    let cond = vec![
        leaf(op::graph::PRICE_LTE, 0, u64::MAX),
        leaf(op::graph::TREASURY_SOL_GTE, 0, 2_000_000_000),
        leaf(op::AND, 0, 0),
    ];
    let mut fx = Fx::new(vec![n], cond);
    fx.reference = ONE - 1;
    fx.sol = 2_000_000_000;
    fx.plan(0).unwrap();
    fx.sol = 1_999_999_999;
    assert_err(fx.plan(0), AutopilotError::ConditionFalse);
    fx.sol = 2_000_000_000;
    // The spot price and the observations do not matter, the reference does.
    fx.pool_at(ONE * 4);
    fx.plan(0).unwrap();
    fx.reference = ONE;
    assert_err(fx.plan(0), AutopilotError::ConditionFalse);
}

#[test]
fn plan_condition_sees_runs_in_epoch() {
    // Node 1 runs while node 0 ran fewer than 2 times this epoch.
    let mut n1 = gnode(WHEN, 0, BURN, 10, 0);
    n1.cond_len = 1;
    let mut fx = Fx::new(
        vec![every(600, BURN, 10, 0), n1],
        vec![leaf(op::graph::RUNS_IN_EPOCH_LT, 0, 2)],
    );
    fx.states[0].epoch_start = NOW - 10;
    fx.states[0].runs_in_epoch = 1;
    fx.plan(1).unwrap();
    fx.states[0].runs_in_epoch = 2;
    assert_err(fx.plan(1), AutopilotError::ConditionFalse);
    // Its epoch rolled over: zero runs this epoch.
    fx.now = NOW - 10 + 86_400;
    fx.plan(1).unwrap();
}

#[test]
fn plan_buyback_bounds() {
    let mut fx = Fx::new(vec![every(3_600, BUYBACK_BURN, 1_000_000, 300)], vec![]);
    fx.not_graduated();
    assert_err(fx.plan(0), AutopilotError::NotGraduated);
    // Graduated, but a buyback without the pool's price: refused.
    fx.graduated = true;
    fx.pool_quote = Some(100_000_000_000);
    fx.seen = seen_at(ONE);
    assert_err(fx.plan(0), AutopilotError::InvalidPool);
    // Spot 3% above the bound (price): exactly the premium.
    let r = 1u128 << 70;
    fx.reference = r;
    fx.seen = seen_at(r);
    // sqrt(1.03) = 1.014889...
    fx.spot = Some(r + r / 1_000_000 * 14_889);
    fx.plan(0).unwrap();
    fx.spot = Some(r + r / 1_000_000 * 14_890);
    assert_err(fx.plan(0), AutopilotError::PremiumExceeded);
    // Below the bound: always within.
    fx.spot = Some(r / 2);
    fx.plan(0).unwrap();
    // A bound too low to price the swap.
    fx.reference = (1u128 << 32) - 1;
    fx.pool_at(1);
    assert_err(fx.plan(0), AutopilotError::PriceOutOfRange);
    // A minimum out of zero (dust in) never swaps.
    fx.reference = 1u128 << 90; // price 2^52 lamports per unit
    fx.pool_at(1u128 << 90);
    fx.sol = 1_000;
    assert_err(fx.plan(0), AutopilotError::PriceOutOfRange);
}

#[test]
fn plan_buyback_needs_observations_and_takes_the_lowest() {
    // Review F1: a buyback is priced from the lower of the reference and
    // the lowest price observed in the window, and needs that window.
    let mut fx = Fx::new(vec![every(3_600, BUYBACK_BURN, 1_000_000, 500)], vec![]);
    fx.seen = None;
    assert_err(fx.plan(0), AutopilotError::PriceNotObserved);
    // The reference is stale-high (the market fell to half); somebody
    // observed the fall. The pool pumped back to the reference: refused,
    // though it is within the premium of the reference.
    let r = 1u128 << 70;
    fx.reference = r;
    fx.seen = Some(Seen {
        min: r * 7_071 / 10_000, // price 0.5
        max: r,
    });
    fx.spot = Some(r);
    assert_err(fx.plan(0), AutopilotError::PremiumExceeded);
    // At the observed low the buyback runs, priced from it.
    fx.spot = Some(r * 7_071 / 10_000);
    match fx.plan(0).unwrap() {
        Plan::Buyback { min_out, .. } => {
            assert_eq!(
                min_out,
                price::min_out(1_000_000, r * 7_071 / 10_000, 500).unwrap()
            );
            assert!(min_out > price::min_out(1_000_000, r, 500).unwrap());
        }
        p => panic!("{p:?}"),
    }
    // Observations above the reference never raise the bound past it.
    fx.seen = Some(Seen {
        min: r * 2,
        max: r * 3,
    });
    fx.spot = Some(r);
    match fx.plan(0).unwrap() {
        Plan::Buyback { min_out, .. } => {
            assert_eq!(min_out, price::min_out(1_000_000, r, 500).unwrap())
        }
        p => panic!("{p:?}"),
    }
    // Burns and distributions need no observation.
    let mut fx = Fx::new(
        vec![
            every(3_600, BURN, 10, 0),
            every(3_600, DISTRIBUTE_SOL, 1_000, 0),
        ],
        vec![],
    );
    fx.seen = None;
    fx.spot = None;
    fx.plan(0).unwrap();
    fx.plan(1).unwrap();
}

#[test]
fn plan_distribute_never_pays_nothing() {
    let mut fx = Fx::new(vec![every(3_600, DISTRIBUTE_SOL, 1_000, 0)], vec![]);
    fx.sol = 1;
    assert_err(fx.plan(0), AutopilotError::NothingToDo);
    fx.sol = 4; // 2 + 1
    match fx.plan(0).unwrap() {
        Plan::Distribute { shares, total } => {
            assert_eq!(&shares[..2], &[2, 1]);
            assert_eq!(total, 3);
        }
        p => panic!("{p:?}"),
    }
}

#[test]
fn plan_gated_nodes_need_the_operator() {
    use AutopilotError as E;
    let mut gated = every(3_600, BUYBACK_BURN, 1_000_000, 300);
    gated.operator_gated = 1;
    let mut fx = Fx::new(vec![gated, every(3_600, BURN, 10, 0)], vec![]);
    assert_err(fx.plan(0), E::WrongOperator);
    fx.signer = Some(key(1));
    assert_err(fx.plan(0), E::WrongOperator);
    fx.signer = Some(key(OPERATOR));
    assert_err(fx.plan(0), E::InvalidAmount);
    fx.amount = Some(1_000_001);
    assert_err(fx.plan(0), E::InvalidAmount);
    fx.amount = Some(400_000);
    match fx.plan(0).unwrap() {
        Plan::Buyback { amount_in, .. } => assert_eq!(amount_in, 400_000),
        p => panic!("{p:?}"),
    }
    // The operator's signature is checked before due-ness.
    fx.states[0].last_run = NOW;
    fx.states[0].last_seq = 1;
    fx.signer = None;
    assert_err(fx.plan(0), E::WrongOperator);
    fx.signer = Some(key(OPERATOR));
    assert_err(fx.plan(0), E::NodeNotDue);
    // A revoked operator: nobody runs gated nodes.
    fx.operator = Pubkey::default();
    fx.states[0] = NodeState::default();
    assert_err(fx.plan(0), E::NoOperator);
    fx.signer = Some(Pubkey::default());
    assert_err(fx.plan(0), E::NoOperator);
    // Other nodes take no amount (a burn), from anyone.
    fx.signer = Some(key(OPERATOR));
    fx.operator = key(OPERATOR);
    assert_err(fx.plan(1), E::AmountNotAllowed);
    fx.amount = None;
    assert_eq!(fx.plan(1).unwrap(), Plan::Burn { amount: 10 });
}

#[test]
fn record_run_counts_in_aligned_epochs() {
    let mut node = NodeRecord::default();
    let mut seq = 41;
    let mut open = 0;
    logic::record_run(&mut node, &mut open, &mut seq, 86_400, NOW, 5, false).unwrap();
    assert_eq!(seq, 42);
    let start = NOW - NOW % 86_400;
    assert_eq!(
        node,
        NodeRecord {
            last_run: NOW,
            last_seq: 42,
            epoch_start: start,
            runs_in_epoch: 1,
            spent_in_epoch: 5
        }
    );
    logic::record_run(&mut node, &mut open, &mut seq, 86_400, NOW + 10, 7, false).unwrap();
    assert_eq!(
        (node.runs_in_epoch, node.spent_in_epoch, node.last_seq),
        (2, 12, 43)
    );
    assert_eq!(node.epoch_start, start);
    // Next epoch: counters restart, aligned to the first epoch.
    logic::record_run(
        &mut node,
        &mut open,
        &mut seq,
        86_400,
        start + 86_400 * 3 + 5,
        1,
        false,
    )
    .unwrap();
    assert_eq!(node.epoch_start, start + 86_400 * 3);
    assert_eq!((node.runs_in_epoch, node.spent_in_epoch), (1, 1));
    let mut full = NodeRecord {
        epoch_start: NOW,
        spent_in_epoch: u64::MAX,
        ..NodeRecord::default()
    };
    assert_err(
        logic::record_run(&mut full, &mut open, &mut seq, 86_400, NOW, 1, false),
        AutopilotError::MathOverflow,
    );
    let mut s = u64::MAX;
    assert_err(
        logic::record_run(
            &mut NodeRecord::default(),
            &mut open,
            &mut s,
            86_400,
            NOW,
            1,
            false,
        ),
        AutopilotError::MathOverflow,
    );
    assert_eq!(open, 0);
}

/// Enough value for a full tip.
const RICH: u64 = 10 * TIP_LAMPORTS;

#[test]
fn tips_are_capped_per_day_and_by_the_treasury() {
    let (mut start, mut paid) = (0i64, 0u64);
    let day = NOW - NOW.rem_euclid(TIP_EPOCH_SECS);
    assert_eq!(
        logic::take_tip(&mut start, &mut paid, NOW, u64::MAX, RICH, TIP_LAMPORTS),
        TIP_LAMPORTS
    );
    assert_eq!((start, paid), (day, TIP_LAMPORTS));
    // 50 tips a day, then nothing until the next UTC day.
    for _ in 1..50 {
        assert_eq!(
            logic::take_tip(&mut start, &mut paid, NOW + 1, u64::MAX, RICH, TIP_LAMPORTS),
            TIP_LAMPORTS
        );
    }
    assert_eq!(paid, TIP_EPOCH_CAP);
    assert_eq!(
        logic::take_tip(
            &mut start,
            &mut paid,
            day + TIP_EPOCH_SECS - 1,
            u64::MAX,
            RICH,
            TIP_LAMPORTS
        ),
        0
    );
    assert_eq!(
        logic::take_tip(
            &mut start,
            &mut paid,
            day + TIP_EPOCH_SECS,
            u64::MAX,
            RICH,
            TIP_LAMPORTS
        ),
        TIP_LAMPORTS
    );
    assert_eq!(paid, TIP_LAMPORTS);
    // A clock that steps back does not reopen an old day.
    assert_eq!(
        logic::take_tip(&mut start, &mut paid, day + 5, u64::MAX, RICH, TIP_LAMPORTS),
        TIP_LAMPORTS
    );
    assert_eq!(start, day + TIP_EPOCH_SECS);
    assert_eq!(paid, 2 * TIP_LAMPORTS);
    // The treasury pays what it has, never more.
    assert_eq!(
        logic::take_tip(
            &mut start,
            &mut paid,
            day + TIP_EPOCH_SECS,
            7,
            RICH,
            TIP_LAMPORTS
        ),
        7
    );
    assert_eq!(
        logic::take_tip(
            &mut start,
            &mut paid,
            day + TIP_EPOCH_SECS,
            0,
            RICH,
            TIP_LAMPORTS
        ),
        0
    );
    assert_eq!(paid, 2 * TIP_LAMPORTS + 7);
    // The cap's remainder.
    paid = TIP_EPOCH_CAP - 3;
    assert_eq!(
        logic::take_tip(
            &mut start,
            &mut paid,
            day + TIP_EPOCH_SECS,
            u64::MAX,
            RICH,
            TIP_LAMPORTS
        ),
        3
    );
    // Days before 1970 are aligned too.
    let (mut s, mut p) = (i64::MIN, 0);
    logic::take_tip(&mut s, &mut p, -1, u64::MAX, RICH, TIP_LAMPORTS);
    assert_eq!(s, -TIP_EPOCH_SECS);
}

#[test]
fn a_tip_is_at_most_a_tenth_of_what_the_run_moved() {
    // Review F5: dust runs earn dust, so feeding the treasury dust to farm
    // tips loses at least nine times what it earns.
    let (mut start, mut paid) = (0i64, 0u64);
    let tip = |value: u64, start: &mut i64, paid: &mut u64| {
        logic::take_tip(start, paid, NOW, u64::MAX, value, TIP_LAMPORTS)
    };
    assert_eq!(tip(0, &mut start, &mut paid), 0);
    assert_eq!(tip(9, &mut start, &mut paid), 0);
    assert_eq!(tip(10, &mut start, &mut paid), 1);
    assert_eq!(tip(123_456, &mut start, &mut paid), 12_345);
    assert_eq!(
        tip(TIP_LAMPORTS * 10 - 10, &mut start, &mut paid),
        TIP_LAMPORTS - 1
    );
    assert_eq!(tip(TIP_LAMPORTS * 10, &mut start, &mut paid), TIP_LAMPORTS);
    assert_eq!(tip(u64::MAX, &mut start, &mut paid), TIP_LAMPORTS);
    // Only what was paid counts against the day.
    assert_eq!(paid, 1 + 12_345 + TIP_LAMPORTS - 1 + 2 * TIP_LAMPORTS);
    // A dust burn: one raw token at a price far below a lamport.
    let dust = Plan::Burn { amount: 1 }.value(ONE >> 10, 0);
    assert_eq!(tip(dust, &mut start, &mut paid), 0);
}

/// Audit 4, A4-2: a keeper's buyback of less than the node's cap is
/// partial. It leaves the node's run open (the node stays due), and the
/// run's later parts move at most the rest of `p1`; it must leave at least
/// the keeper floor of the cap. A full amount, no amount, or an operator's
/// amount is a run, as before.
#[test]
fn a_keepers_partial_buyback_leaves_the_run_open() {
    use AutopilotError as E;
    let mut gated = every(3_600, BUYBACK_BURN, 1_000_000_000, 500);
    gated.operator_gated = 1;
    let mut fx = Fx::new(
        vec![every(86_400, BUYBACK_BURN, 1_000_000_000, 500), gated],
        vec![],
    );
    // The pool holds 10 SOL: the floor is 0.1 SOL.
    fx.pool_quote = Some(10_000_000_000);
    let partial = |p: Plan| match p {
        Plan::Buyback {
            amount_in, partial, ..
        } => (amount_in, partial),
        p => panic!("{p:?}"),
    };
    // No amount, or the whole cap: a run.
    assert_eq!(partial(fx.plan(0).unwrap()), (1_000_000_000, false));
    fx.amount = Some(1_000_000_000);
    assert_eq!(partial(fx.plan(0).unwrap()), (1_000_000_000, false));
    // Less: partial, down to the floor, leaving at least the floor.
    fx.amount = Some(100_000_000);
    assert_eq!(partial(fx.plan(0).unwrap()), (100_000_000, true));
    fx.amount = Some(900_000_000);
    assert_eq!(partial(fx.plan(0).unwrap()), (900_000_000, true));
    fx.amount = Some(900_000_001);
    assert_err(fx.plan(0), E::RemainderTooSmall);
    fx.amount = Some(999_999_999);
    assert_err(fx.plan(0), E::RemainderTooSmall);
    // What partial runs moved comes off the cap until the run completes.
    fx.partial_spent = 400_000_000;
    fx.amount = None;
    assert_eq!(partial(fx.plan(0).unwrap()), (600_000_000, false));
    fx.amount = Some(600_000_000);
    assert_eq!(partial(fx.plan(0).unwrap()), (600_000_000, false));
    fx.amount = Some(500_000_000);
    assert_eq!(partial(fx.plan(0).unwrap()), (500_000_000, true));
    fx.amount = Some(500_000_001);
    assert_err(fx.plan(0), E::RemainderTooSmall);
    fx.amount = Some(600_000_001);
    assert_err(fx.plan(0), E::InvalidAmount);
    // The budget left is the cap when lower: it is partial against it.
    fx.partial_spent = 0;
    fx.states[0].epoch_start = NOW - 10;
    fx.states[0].spent_in_epoch = 9_700_000_000;
    fx.amount = Some(200_000_000);
    assert_eq!(partial(fx.plan(0).unwrap()), (200_000_000, true));
    fx.states[0].spent_in_epoch = 9_800_000_000;
    fx.amount = Some(100_000_000);
    assert_eq!(partial(fx.plan(0).unwrap()), (100_000_000, true));
    fx.amount = Some(200_000_000);
    assert_eq!(partial(fx.plan(0).unwrap()), (200_000_000, false));
    fx.amount = Some(150_000_000);
    assert_err(fx.plan(0), E::RemainderTooSmall);
    // A treasury below the cap: a keeper moving all of it passes no amount.
    fx.states[0] = NodeState::default();
    fx.sol = 950_000_000;
    fx.amount = Some(950_000_000);
    assert_err(fx.plan(0), E::RemainderTooSmall);
    fx.amount = None;
    assert_eq!(partial(fx.plan(0).unwrap()), (950_000_000, false));
    // The operator's amount is its run, whatever it is.
    fx.sol = 50_000_000_000;
    fx.signer = Some(key(OPERATOR));
    fx.amount = Some(400_000_000);
    assert_eq!(partial(fx.plan(1).unwrap()), (400_000_000, false));
}

#[test]
fn a_partial_buyback_is_recorded_as_no_run() {
    let mut node = NodeRecord::default();
    let (mut open, mut seq) = (0u64, 7u64);
    let start = NOW - NOW % 86_400;
    logic::record_run(&mut node, &mut open, &mut seq, 86_400, NOW, 30, true).unwrap();
    // The spend and the sequence count; the run, its time and its number do not.
    assert_eq!(seq, 8);
    assert_eq!(open, 30);
    assert_eq!(
        node,
        NodeRecord {
            last_run: 0,
            last_seq: 0,
            epoch_start: start,
            runs_in_epoch: 0,
            spent_in_epoch: 30
        }
    );
    logic::record_run(&mut node, &mut open, &mut seq, 86_400, NOW + 5, 20, true).unwrap();
    assert_eq!((open, node.spent_in_epoch, node.runs_in_epoch), (50, 50, 0));
    // The run that completes it: a run, and the open run is closed.
    logic::record_run(&mut node, &mut open, &mut seq, 86_400, NOW + 9, 50, false).unwrap();
    assert_eq!(open, 0);
    assert_eq!(
        node,
        NodeRecord {
            last_run: NOW + 9,
            last_seq: 10,
            epoch_start: start,
            runs_in_epoch: 1,
            spent_in_epoch: 100
        }
    );
    // A partial run in a later epoch rolls the epoch over, and keeps its runs at zero.
    logic::record_run(
        &mut node,
        &mut open,
        &mut seq,
        86_400,
        start + 86_400 + 1,
        5,
        true,
    )
    .unwrap();
    assert_eq!(
        (
            node.epoch_start,
            node.runs_in_epoch,
            node.spent_in_epoch,
            open
        ),
        (start + 86_400, 0, 5, 5)
    );
    assert_eq!(node.last_run, NOW + 9);
    let mut huge = u64::MAX;
    assert_err(
        logic::record_run(&mut node, &mut huge, &mut seq, 86_400, NOW, 1, true),
        AutopilotError::MathOverflow,
    );
}

/// Audit 4, A4-2: a partial buyback earns its share of a tip, so the
/// partial runs of a node's run earn less than one tip together.
#[test]
fn a_partial_buyback_earns_its_share_of_a_tip() {
    let p = |amount_in: u64, partial: bool| Plan::Buyback {
        amount_in,
        min_out: 1,
        partial,
    };
    assert_eq!(p(400, true).max_tip(1_000), TIP_LAMPORTS * 4 / 10);
    assert_eq!(p(999, true).max_tip(1_000), TIP_LAMPORTS * 999 / 1_000);
    assert_eq!(p(1, true).max_tip(u64::MAX), 0);
    assert_eq!(p(400, false).max_tip(1_000), TIP_LAMPORTS);
    assert_eq!(Plan::Burn { amount: 1 }.max_tip(1_000), TIP_LAMPORTS);
    assert!(p(1, true).partial() && !p(1, false).partial());
    assert!(!Plan::Burn { amount: 1 }.partial());
    let (mut start, mut paid) = (0i64, 0u64);
    assert_eq!(
        logic::take_tip(&mut start, &mut paid, NOW, u64::MAX, RICH, 40_000),
        40_000
    );
    assert_eq!(
        logic::take_tip(&mut start, &mut paid, NOW, u64::MAX, RICH, u64::MAX),
        TIP_LAMPORTS
    );
    assert_eq!(paid, 40_000 + TIP_LAMPORTS);
}

/// Audit 4, A4-4: burns earn no tip before graduation; after it their
/// tokens are valued at the lower of the reference and the lowest price
/// observed in the window.
#[test]
fn burns_are_valued_at_nothing_before_graduation_then_at_the_lowest_price() {
    assert_eq!(logic::burn_price(false, ONE, None), 0);
    assert_eq!(logic::burn_price(false, ONE, Some(ONE / 2)), 0);
    assert_eq!(logic::burn_price(true, ONE, None), ONE);
    assert_eq!(logic::burn_price(true, ONE, Some(ONE / 2)), ONE / 2);
    assert_eq!(logic::burn_price(true, ONE, Some(ONE * 2)), ONE);
    let burn = Plan::Burn {
        amount: 10 * TIP_LAMPORTS,
    };
    let (mut start, mut paid) = (0i64, 0u64);
    let v = burn.value(logic::burn_price(false, ONE, Some(ONE)), 0);
    assert_eq!(
        logic::take_tip(&mut start, &mut paid, NOW, u64::MAX, v, TIP_LAMPORTS),
        0
    );
    // sqrt price / 2: a quarter of the value, a quarter of the tip.
    let v = burn.value(logic::burn_price(true, ONE, Some(ONE / 2)), 0);
    assert_eq!(v, 10 * TIP_LAMPORTS / 4);
    assert_eq!(
        logic::take_tip(&mut start, &mut paid, NOW, u64::MAX, v, TIP_LAMPORTS),
        TIP_LAMPORTS / 4
    );
}

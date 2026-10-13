//! Review F1 (2026-10-13, framework-free rewrite review): price conditions
//! against the real programs (mainnet DBC, DAMM v2 and Token-2022).
//!
//! The reference moves only toward what every observation of its window
//! agrees on, so one observation on the other side vetoes its move, and a
//! run observes the pool before it decides. A pumped observation in the
//! run's own transaction therefore kept the reference, and a `PRICE_GTE`
//! condition read on it, stale after a fall (a dumped one, a `PRICE_LTE`
//! condition after a rise). A price condition now has to hold across the
//! reference and every price observed in the window (`logic::condition_prices`,
//! `Graph::runnable_over`): `PRICE_GTE` on the lowest, `PRICE_LTE` on the
//! highest, so an observation can make a condition false, never true.
//!
//! The first two tests are the review's probes (`review_probe.rs`): the
//! control still passes, and the pump that kept the node running is now
//! refused. Then the mirror for `PRICE_LTE`, a condition every observation
//! agrees on (it still runs), and a fresh honest observation (it counts at
//! once, before the window could move the reference).

#[path = "../../../../noised-launchpad/tests/litesvm/tests/common/mod.rs"]
mod common;

mod ap;

use ap::*;
use common::{launch::base_ata, lifecycle::damm_swap, Expect, LAMPORTS_PER_SOL};
use noised_autopilot::error::AutopilotError as E;
use noised_rules::{
    graph::{action::*, trigger::*},
    op, GNode, GraphProgram, Node,
};
use solana_signer::Signer;

/// One WHEN node that burns 1 treasury token per run while `cond` holds.
fn burn_while(cond: Node) -> GraphProgram {
    GraphProgram {
        flags: 0,
        operator: [0; 32],
        recipients: vec![],
        nodes: vec![GNode {
            trigger: WHEN,
            trigger_arg: 0,
            cond_off: 0,
            cond_len: 1,
            action: BURN,
            operator_gated: 0,
            epoch_secs: 86_400,
            budget_per_epoch: 10,
            p1: 1,
            p2: 0,
            max_runs_per_epoch: 10,
            reserved: [0; 5],
        }],
        cond: vec![cond],
    }
}

fn price_gte(sqrt: u128) -> Node {
    Node {
        op: op::graph::PRICE_GTE,
        a: 0,
        arg: sqrt as u64,
    }
}

fn price_lte(sqrt: u128) -> Node {
    Node {
        op: op::graph::PRICE_LTE,
        a: 0,
        arg: sqrt as u64,
    }
}

/// The keeper's run of node 0 with `before` in the same transaction (signed
/// by carol, who trades).
fn run_after(
    t: &mut ApWorld,
    h: &[u8; 32],
    before: solana_instruction::Instruction,
) -> Result<common::Sent, common::Failed> {
    let carol = t.carol.insecure_clone();
    let keeper = t.keeper.insecure_clone();
    let named = run_accounts(
        &t.a,
        &keeper.pubkey(),
        None,
        h,
        Some(t.d.pool),
        &t.keeper_tip(),
    );
    let run = run_ix(named, 0, None, &Extra::None);
    t.send(&[before, run], &[&carol, &keeper])
}

/// A graduated world with a graph that burns treasury tokens only while the
/// price is at least where the reference started (`PRICE_GTE`); then the
/// market falls (carol dumps) and an honest observation is made; a minute
/// later the node is due. Returns the world, the graph and the start
/// reference.
fn fallen_market() -> (ApWorld, [u8; 32], u128) {
    let mut t = ap_world(true);
    let reference = t.state().ref_sqrt_price;
    t.fund_tokens(100);
    let h = t.activate_now(&burn_while(price_gte(reference)));
    let carol = t.carol.pubkey();
    let held = t.w.env.token_amount(&base_ata(&carol, &t.k.mint));
    t.carol_sells(held / 2);
    assert!(t.pool_sqrt_price() < reference * 9 / 10, "the market fell");
    t.observe_and_wait();
    (t, h, reference)
}

/// Control (the review's): with only honest observations the run's own
/// observation agrees with them, the reference falls at once and the node
/// is refused.
#[test]
fn honest_observations_stop_a_price_gte_node_after_a_fall() {
    let (mut t, h, reference) = fallen_market();
    t.run(&h, 0, &Extra::None).fails_with(
        ap_code(E::ConditionFalse),
        "ConditionFalse",
        "the condition is false after the fall",
    );
    t.observe().expect_ok("update_price");
    assert!(t.state().ref_sqrt_price < reference, "the reference fell");
}

/// The review's F1 proof of concept, now refused: one pumped observation in
/// the run's own transaction vetoes the reference's fall, but the condition
/// must hold for the honest low observations of the window too.
#[test]
fn one_pumped_observation_in_the_run_tx_cannot_keep_a_price_gte_node_running() {
    let (mut t, h, reference) = fallen_market();
    let tokens_before = t.tokens();
    let pump = damm_swap(&t.carol.pubkey(), &t.k, &t.d, false, 20 * LAMPORTS_PER_SOL);
    run_after(&mut t, &h, pump).fails_with(
        ap_code(E::ConditionFalse),
        "ConditionFalse",
        "a pump and the run in one transaction",
    );
    assert_eq!(t.tokens(), tokens_before, "nothing burned");
    assert_eq!(t.state().ref_sqrt_price, reference, "nothing recorded");
    // The pump alone (it lands; then the run in a later transaction):
    // still refused while the window holds the honest low observations.
    t.carol_buys(20 * LAMPORTS_PER_SOL);
    assert!(t.pool_sqrt_price() >= reference, "the pump went above it");
    t.run(&h, 0, &Extra::None).fails_with(
        ap_code(E::ConditionFalse),
        "ConditionFalse",
        "a run after a pump, with the fall still in the window",
    );
    assert_eq!(t.tokens(), tokens_before, "nothing burned");
}

/// The mirror: a graph that burns only while the price is at most where the
/// reference started (`PRICE_LTE`); the market rises (carol buys) and an
/// honest observation is made.
fn risen_market() -> (ApWorld, [u8; 32], u128) {
    let mut t = ap_world(true);
    let reference = t.state().ref_sqrt_price;
    t.fund_tokens(100);
    let h = t.activate_now(&burn_while(price_lte(reference)));
    t.carol_buys(20 * LAMPORTS_PER_SOL);
    assert!(t.pool_sqrt_price() > reference * 11 / 10, "the market rose");
    t.observe_and_wait();
    (t, h, reference)
}

/// Control: honest observations above the threshold refuse a `PRICE_LTE`
/// node after a rise.
#[test]
fn honest_observations_stop_a_price_lte_node_after_a_rise() {
    let (mut t, h, _) = risen_market();
    let tokens_before = t.tokens();
    t.run(&h, 0, &Extra::None).fails_with(
        ap_code(E::ConditionFalse),
        "ConditionFalse",
        "the condition is false after the rise",
    );
    assert_eq!(t.tokens(), tokens_before);
}

/// One dumped observation in the run's own transaction vetoes the
/// reference's rise, so the reference stays where the condition held; the
/// condition must also hold for the honest high observations: refused.
#[test]
fn one_dumped_observation_in_the_run_tx_cannot_keep_a_price_lte_node_running() {
    let (mut t, h, reference) = risen_market();
    let tokens_before = t.tokens();
    let carol = t.carol.pubkey();
    let held = t.w.env.token_amount(&base_ata(&carol, &t.k.mint));
    let dump = damm_swap(&carol, &t.k, &t.d, true, held / 2);
    run_after(&mut t, &h, dump).fails_with(
        ap_code(E::ConditionFalse),
        "ConditionFalse",
        "a dump and the run in one transaction",
    );
    assert_eq!(t.tokens(), tokens_before, "nothing burned");
    assert!(t.state().ref_sqrt_price >= reference);
}

/// Liveness: a price condition that the reference and every observation of
/// the window agree on still runs, at once and again later.
#[test]
fn a_price_condition_every_observation_agrees_on_still_runs() {
    let mut t = ap_world(true);
    let reference = t.state().ref_sqrt_price;
    let spot = t.pool_sqrt_price();
    t.fund_tokens(100);
    // At least 90% of the lower of the two (in sqrt terms), with no trade
    // in between: every observation agrees.
    let threshold = reference.min(spot) * 9 / 10;
    let h = t.activate_now(&burn_while(price_gte(threshold)));
    t.observe_and_wait();
    let before = t.tokens();
    t.run(&h, 0, &Extra::None)
        .expect_ok("a condition every observation agrees on");
    assert_eq!(t.tokens(), before - 1, "the node burned");
    let now = t.now();
    t.env().set_time(now + 61);
    t.run(&h, 0, &Extra::None)
        .expect_ok("and again (WHEN, 10 runs a day)");
    assert_eq!(t.tokens(), before - 2);
}

/// The observations a condition is judged on need not be a minute old: a
/// fresh honest observation of a fall counts at once, before the reference
/// could move (that needs a window spanning a minute), so a pump right after
/// it is refused too.
#[test]
fn a_fresh_honest_observation_counts_at_once() {
    let mut t = ap_world(true);
    let reference = t.state().ref_sqrt_price;
    t.fund_tokens(100);
    let h = t.activate_now(&burn_while(price_gte(reference)));
    // Every earlier observation leaves the window (two 15-minute buckets).
    let now = t.now();
    t.env().set_time(now + 31 * 60);
    let carol = t.carol.pubkey();
    let held = t.w.env.token_amount(&base_ata(&carol, &t.k.mint));
    t.carol_sells(held / 2);
    assert!(t.pool_sqrt_price() < reference * 9 / 10, "the market fell");
    t.observe()
        .expect_ok("an honest observation of the fall, just now");
    let tokens_before = t.tokens();
    let pump = damm_swap(&carol, &t.k, &t.d, false, 20 * LAMPORTS_PER_SOL);
    run_after(&mut t, &h, pump).fails_with(
        ap_code(E::ConditionFalse),
        "ConditionFalse",
        "a pump and the run right after a fresh honest observation",
    );
    assert_eq!(t.tokens(), tokens_before, "nothing burned");
    assert_eq!(
        t.state().ref_sqrt_price,
        reference,
        "a window under a minute old does not move the reference"
    );
}

//! Regressions for audit round 4 (autopilot and custody lenses): each test
//! ports a finding's proof of concept against the real programs (our SBPF
//! builds of the launchpad, hook, vault and autopilot; mainnet DBC, DAMM v2
//! and Token-2022) and asserts the fixed behaviour. Every one of them fails
//! on the program as audited.
//!
//! * A4-2: a keeper's buyback of the least it may choose (1% of the pool's
//!   SOL) used up an EVERY node's run for its period, throttling the daily
//!   buyback, for a full tip. Now such a partial buyback leaves the run
//!   open (the rest runs the same day, the promised amount is bought back)
//!   and earns its share of a tip; the run's parts never move more than the
//!   run would, even across epochs.
//! * A4-3: a revocation of an operator appointed again (the same graph,
//!   activated again) could never be authorized (same payload, so the same
//!   `Authorization`, already used). Now a revocation names the activation
//!   it revokes (payload v3, `Autopilot::active_auth`).
//! * A4-S: the running graph's activation (its authorization and the
//!   `activate_at` it signed) is kept in the account.
//! * A4-4: before graduation burns were valued at the migration price, so
//!   tokens bought early on the curve and burned through the treasury
//!   earned more in tips than they cost. Now burns earn no tip before
//!   graduation, and after it are valued at the lower of the reference and
//!   the lowest price observed in the window.
//! * M4 (custody): a distribution needed every recipient's wSOL account, so
//!   recipients that closed theirs made keepers pay their rent (2,039,280
//!   lamports each, every run, for a tip of at most 100,000). Now a
//!   recipient without one is skipped and its share stays in the treasury.

#[path = "../../../../noised-launchpad/tests/litesvm/tests/common/mod.rs"]
mod common;

mod ap;

use anchor_lang::prelude::Pubkey;
use anchor_spl::token_interface::spl_token_2022;
use ap::*;
use common::{
    events, invoked,
    launch::{base_ata, create_ata, dbc_swap_mode, hooked_transfer, wsol_ata},
    pq, Expect, Failed, Sent, ATA_PROGRAM_ID, LAMPORTS_PER_SOL, TOKEN_PROGRAM_ID,
};
use noised_autopilot::{
    constants::*,
    error::AutopilotError as E,
    events::NodeRan,
    launchpad::{self as lp, authorization::kind},
    price,
};
use noised_launchpad::events::Authorized;
use noised_rules::{
    graph::{action::*, trigger::*, FLAG_HAS_OPERATOR},
    GNode, GraphProgram, Recipient,
};
use solana_keypair::Keypair;
use solana_signer::Signer;

const SOL: u64 = LAMPORTS_PER_SOL;
const DAY: i64 = 86_400;

#[track_caller]
fn refused(r: Result<Sent, Failed>, e: E, what: &str) -> Failed {
    r.fails_with(ap_code(e), &format!("{e:?}"), what)
}

fn gnode(trig: u8, trigger_arg: u64, act: u8, p1: u64, p2: u64) -> GNode {
    GNode {
        trigger: trig,
        trigger_arg,
        cond_off: 0,
        cond_len: 0,
        action: act,
        operator_gated: 0,
        epoch_secs: 86_400,
        budget_per_epoch: p1 * 10,
        p1,
        p2,
        max_runs_per_epoch: 10,
        reserved: [0; 5],
    }
}

/// The SDK's "Daily buyback and burn" template: once a day (EVERY 1d,
/// epoch 1d, so one run per epoch), up to `max_in` lamports.
fn daily_buyback(max_in: u64, premium_bps: u64) -> GNode {
    let mut n = gnode(EVERY, 86_400, BUYBACK_BURN, max_in, premium_bps);
    n.budget_per_epoch = max_in;
    n.max_runs_per_epoch = 1;
    n
}

fn graph(nodes: Vec<GNode>) -> GraphProgram {
    GraphProgram {
        flags: 0,
        operator: [0; 32],
        recipients: vec![],
        nodes,
        cond: vec![],
    }
}

fn ran(sent: &Sent) -> NodeRan {
    events::<NodeRan>(&sent.logs).pop().expect("NodeRan")
}

/// A4-2, ported. The daily buyback template, a quarter SOL a day (which
/// this pool takes within a 10% premium). Each day, as soon as the node is
/// due, a griefing keeper runs it with the least amount it may choose (1%
/// of the pool's SOL). As audited, that was the node's run for the day:
/// the honest keeper's full run was refused all day, and 3 days bought
/// back 0.30 of the promised 0.75 SOL. Now the griefer's run is partial:
/// the honest keeper runs the rest the same day, every day buys back the
/// whole quarter SOL, and the griefer earns its share of a tip.
#[test]
fn a4_2_a_partial_buyback_does_not_use_up_the_daily_run() {
    let mut t = ap_world(true);
    let p1 = SOL / 4;
    let h = t.activate_now(&graph(vec![daily_buyback(p1, 1_000)]));
    t.fund_sol(5 * SOL);
    let extra = t.buyback();
    let (mut bought_sol, mut griefer_tips) = (0u64, 0u64);
    for day in 0..3 {
        t.observe_and_wait();
        let quote = t.w.env.token_amount(&t.d.token_b_vault);
        let floor = quote / 100;
        // A griefer cannot leave a remainder too small to swap.
        refused(
            t.run_amount(&h, 0, Some(p1 - floor + 1), &extra),
            E::RemainderTooSmall,
            "a partial run leaving less than the floor",
        );
        let ev = ran(&t
            .run_amount(&h, 0, Some(floor), &extra)
            .expect_ok("the griefer's 1% run"));
        assert_eq!((ev.spent, ev.partial), (floor, true));
        assert_eq!(ev.tip, TIP_LAMPORTS * floor / p1, "its share of a tip");
        assert!(ev.tip < TIP_LAMPORTS / 2);
        let st = t.state();
        assert_eq!(
            (st.nodes[0].runs_in_epoch, st.partial_spent[0]),
            (0, floor),
            "no run: the node stays due"
        );
        bought_sol += ev.spent;
        griefer_tips += ev.tip;
        // The honest keeper's run, the same day: the rest of the quarter SOL.
        let ev = ran(&t.run(&h, 0, &extra).expect_ok("the honest keeper's run"));
        assert_eq!(
            (ev.spent, ev.partial, ev.tip),
            (p1 - floor, false, TIP_LAMPORTS)
        );
        bought_sol += ev.spent;
        let st = t.state();
        assert_eq!(
            (
                st.nodes[0].runs_in_epoch,
                st.nodes[0].spent_in_epoch,
                st.partial_spent[0]
            ),
            (1, p1, 0)
        );
        // The day's run is done: nothing more until tomorrow, from anyone.
        refused(
            t.run(&h, 0, &extra),
            E::NodeNotDue,
            "a second run the same day",
        );
        refused(
            t.run_amount(&h, 0, Some(floor), &extra),
            E::NodeNotDue,
            "a second partial run the same day",
        );
        println!(
            "A4-2 day {day}: pool {:.2} SOL; griefer ran {floor} lamports (tip {}), the honest keeper the rest ({} lamports)",
            quote as f64 / SOL as f64,
            TIP_LAMPORTS * floor / p1,
            p1 - floor
        );
        let now = t.now();
        t.env().set_time(now + DAY);
    }
    println!(
        "A4-2: 3 days bought back {bought_sol} lamports (promised {}); griefer tips {griefer_tips}",
        3 * p1
    );
    assert_eq!(
        bought_sol,
        3 * p1,
        "every day bought back the promised amount"
    );
}

/// A4-2: the parts of a run never move more than the run would, even when
/// they span epochs whose budget renews: a once-only node (ON_GRADUATED)
/// split over three days moves its `p1` once, and then never runs again.
#[test]
fn a4_2_partial_runs_never_move_more_than_the_run() {
    let mut t = ap_world(true);
    let p1 = SOL / 2;
    let mut once = gnode(ON_GRADUATED, 0, BUYBACK_BURN, p1, 1_000);
    once.budget_per_epoch = p1;
    let h = t.activate_now(&graph(vec![once]));
    t.fund_sol(5 * SOL);
    let extra = t.buyback();
    let mut moved = 0;
    for day in 0..2 {
        t.observe_and_wait();
        let floor = t.w.env.token_amount(&t.d.token_b_vault) / 100;
        let ev = ran(&t
            .run_amount(&h, 0, Some(floor), &extra)
            .expect_ok("a partial run"));
        assert!(ev.partial, "day {day}");
        moved += ev.spent;
        let now = t.now();
        t.env().set_time(now + DAY);
    }
    // A new epoch, a new budget: still only the rest of the run.
    t.observe_and_wait();
    refused(
        t.run_amount(&h, 0, Some(p1 - moved + 1), &extra),
        E::InvalidAmount,
        "more than the rest of the run",
    );
    let ev = ran(&t.run(&h, 0, &extra).expect_ok("the rest"));
    assert_eq!((ev.spent, ev.partial), (p1 - moved, false));
    moved += ev.spent;
    assert_eq!(moved, p1);
    let now = t.now();
    t.env().set_time(now + DAY);
    t.observe_and_wait();
    refused(
        t.run(&h, 0, &extra),
        E::NodeNotDue,
        "a once-only node, again",
    );
    let floor = t.w.env.token_amount(&t.d.token_b_vault) / 100;
    refused(
        t.run_amount(&h, 0, Some(floor), &extra),
        E::NodeNotDue,
        "a partial run of a once-only node, again",
    );
}

/// A4-2: what partial runs moved belongs to the graph that ran them: a
/// replacement starts with none (its runs move their whole `p1`).
#[test]
fn a4_2_a_new_graph_starts_with_no_partial_runs() {
    let mut t = ap_world(true);
    let a = t.a;
    let p1 = SOL / 4;
    let h1 = t.activate_now(&graph(vec![daily_buyback(p1, 1_000)]));
    t.fund_sol(5 * SOL);
    let extra = t.buyback();
    t.observe_and_wait();
    let floor = t.w.env.token_amount(&t.d.token_b_vault) / 100;
    t.run_amount(&h1, 0, Some(floor), &extra)
        .expect_ok("a partial run of g1");
    assert_eq!(t.state().partial_spent[0], floor);
    let mut n2 = daily_buyback(p1, 1_000);
    n2.trigger_arg = 2 * 86_400;
    let (b2, h2) = compile(&graph(vec![n2]));
    let payer = t.payer();
    t.send(&[publish_graph(&payer, &a, &b2)], &[])
        .expect_ok("publish g2");
    let at = t.now() + UPDATE_TIMELOCK_SECS;
    let slot = t.state().auth_marks[0].slot + 1;
    let auth = activation_auth(t.env(), &a, &h2, at, Some(slot));
    t.send(&[activate(&a, &h2, &auth, at)], &[])
        .expect_ok("queue g2");
    assert_eq!(t.state().partial_spent[0], floor, "until it applies");
    t.env().set_time(at);
    t.send(&[apply_pending(&a, &h2)], &[]).expect_ok("apply g2");
    assert_eq!(t.state().partial_spent, [0; 16]);
    t.observe_and_wait();
    let ev = ran(&t.run(&h2, 0, &extra).expect_ok("g2's first run"));
    assert_eq!((ev.spent, ev.partial), (p1, false));
}

/// A graph with an operator-gated burn and a keeper burn.
fn operated(operator: &Keypair) -> GraphProgram {
    let node = |gated: u8| GNode {
        trigger: EVERY,
        trigger_arg: 600,
        cond_off: 0,
        cond_len: 0,
        action: BURN,
        operator_gated: gated,
        epoch_secs: 86_400,
        budget_per_epoch: 1_000,
        p1: 100,
        p2: 0,
        max_runs_per_epoch: 10,
        reserved: [0; 5],
    };
    GraphProgram {
        flags: FLAG_HAS_OPERATOR,
        operator: operator.pubkey().to_bytes(),
        recipients: vec![],
        nodes: vec![node(1), node(0)],
        cond: vec![],
    }
}

/// `pq_authorize` by the launch's identity (the launchpad build verifies
/// the LMS signature and writes the account), then a minute passes.
fn authorize(t: &mut ApWorld, k: u8, payload: [u8; 32]) -> Sent {
    let launch = t.a.launch;
    let sent = pq::try_authorize_by(t.env(), pq::identity(), &launch, k, payload)
        .expect_ok("pq_authorize");
    let now = t.now();
    t.env().set_time(now + 60);
    sent
}

/// A4-3, ported (and A4-S). The creator revokes its operator as a
/// precaution, then (the alarm was false) appoints it again by activating
/// the same graph again. As audited, no revocation of it could ever be used
/// after that: a new signature over the revocation had the same payload
/// (the launchpad only burned its leaf), and the existing authorization was
/// the latest revocation used, so stale. Now each revocation names the
/// activation it revokes: the old one cannot reach the re-appointed
/// operator, and a new one revokes it.
#[test]
fn a4_3_a_reappointed_operator_is_revoked_again() {
    let mut t = ap_world(true);
    let a = t.a;
    let operator = t.w.env.funded(2);
    t.send(
        &[create_ata(
            &operator.pubkey(),
            &operator.pubkey(),
            &WSOL_MINT,
            &TOKEN_PROGRAM_ID,
        )],
        &[&operator],
    )
    .expect_ok("operator's wSOL account");
    let (bytes, h) = compile(&operated(&operator));
    let payer = t.payer();
    t.send(&[publish_graph(&payer, &a, &bytes)], &[])
        .expect_ok("publish_graph");
    t.fund_sol(SOL);
    let carol = t.carol.pubkey();
    let carol_tokens = t.w.env.token_amount(&base_ata(&carol, &t.k.mint));
    t.fund_tokens(carol_tokens / 100);
    assert_eq!(
        (t.state().active_auth, t.state().active_activate_at),
        (Pubkey::default(), 0),
        "nothing active yet"
    );

    // First activation (at once), applied: the account keeps it (A4-S).
    let at = t.now() + 60;
    let p1 = lp::activation_payload(&a.autopilot, &h, at);
    authorize(&mut t, kind::GRAPH_ACTIVATE, p1);
    let act1 = pq::auth_pda(&a.launch, kind::GRAPH_ACTIVATE, &p1);
    t.send(&[activate(&a, &h, &act1, at)], &[])
        .expect_ok("activate");
    assert_eq!(
        t.state().active_auth,
        Pubkey::default(),
        "queued is not active"
    );
    t.send(&[apply_pending(&a, &h)], &[])
        .expect_ok("apply_pending");
    let st = t.state();
    assert_eq!(st.operator, operator.pubkey());
    assert_eq!((st.active_auth, st.active_activate_at), (act1, at));
    // Anyone re-verifies the running graph's authorization from the account.
    let again = lp::activation_payload(&a.autopilot, &st.active_graph, st.active_activate_at);
    assert_eq!(
        pq::auth_pda(&a.launch, kind::GRAPH_ACTIVATE, &again),
        st.active_auth
    );

    // A precautionary revocation (of this activation).
    let rv1 = lp::revoke_payload(&a.autopilot, &h, &operator.pubkey(), &act1);
    authorize(&mut t, kind::OPERATOR_REVOKE, rv1);
    let r1 = pq::auth_pda(&a.launch, kind::OPERATOR_REVOKE, &rv1);
    t.send(&[revoke_operator(&a, &r1)], &[])
        .expect_ok("revoke_operator");
    assert_eq!(t.state().operator, Pubkey::default());

    // False alarm: the same graph again (72-hour timelock), same operator.
    let at2 = t.now() + 120 + UPDATE_TIMELOCK_SECS;
    let p2 = lp::activation_payload(&a.autopilot, &h, at2);
    authorize(&mut t, kind::GRAPH_ACTIVATE, p2);
    let act2 = pq::auth_pda(&a.launch, kind::GRAPH_ACTIVATE, &p2);
    t.send(&[activate(&a, &h, &act2, at2)], &[])
        .expect_ok("re-activate");
    assert_eq!(t.state().active_auth, act1, "until it applies");
    t.env().set_time(at2);
    t.send(&[apply_pending(&a, &h)], &[])
        .expect_ok("apply the re-activation");
    let st = t.state();
    assert_eq!(st.operator, operator.pubkey());
    assert_eq!((st.active_auth, st.active_activate_at), (act2, at2));

    // The old revocation does not reach the re-appointed operator.
    refused(
        t.send(&[revoke_operator(&a, &r1)], &[]),
        E::InvalidAuthorization,
        "the revocation of the previous activation",
    );
    assert_eq!(t.state().operator, operator.pubkey());
    t.run_as(&operator, &h, 0, Some(100), &Extra::None)
        .expect_ok("the re-appointed operator runs");

    // Now it is compromised: a new revocation names the new activation, is
    // a new authorization, and revokes it.
    let rv2 = lp::revoke_payload(&a.autopilot, &h, &operator.pubkey(), &act2);
    assert_ne!(rv2, rv1);
    let sent = authorize(&mut t, kind::OPERATOR_REVOKE, rv2);
    assert_eq!(
        events::<Authorized>(&sent.logs).len(),
        1,
        "a new authorization"
    );
    let r2 = pq::auth_pda(&a.launch, kind::OPERATOR_REVOKE, &rv2);
    t.send(&[revoke_operator(&a, &r2)], &[])
        .expect_ok("revoke the re-appointed operator");
    assert_eq!(t.state().operator, Pubkey::default());
    let now = t.now();
    t.env().set_time(now + 600);
    refused(
        t.run_as(&operator, &h, 0, Some(100), &Extra::None),
        E::NoOperator,
        "the revoked operator",
    );
    t.run(&h, 1, &Extra::None)
        .expect_ok("keeper nodes still run");
}

/// A4-S: the activation kept with the active graph changes only when a
/// graph is applied; a queued replacement, a revocation and a freeze leave
/// it.
#[test]
fn a4_s_the_running_graphs_activation_is_kept() {
    let mut t = ap_world(true);
    let a = t.a;
    let payer = t.payer();
    let (b1, h1) = compile(&graph(vec![gnode(EVERY, 600, BURN, 1, 0)]));
    let (b2, h2) = compile(&graph(vec![gnode(EVERY, 600, BURN, 2, 0)]));
    for b in [&b1, &b2] {
        t.send(&[publish_graph(&payer, &a, b)], &[])
            .expect_ok("publish");
    }
    let at1 = t.now() + 30;
    let auth1 = activation_auth(t.env(), &a, &h1, at1, None);
    t.send(&[activate(&a, &h1, &auth1, at1)], &[])
        .expect_ok("queue g1");
    t.env().set_time(at1 + 5);
    t.send(&[apply_pending(&a, &h1)], &[]).expect_ok("apply g1");
    let st = t.state();
    assert_eq!((st.active_auth, st.active_activate_at), (auth1, at1));
    assert_eq!(
        st.activated_at,
        at1 + 5,
        "when it applied, not what it signed"
    );
    let at2 = t.now() + UPDATE_TIMELOCK_SECS;
    let slot = st.auth_marks[0].slot + 1;
    let auth2 = activation_auth(t.env(), &a, &h2, at2, Some(slot));
    t.send(&[activate(&a, &h2, &auth2, at2)], &[])
        .expect_ok("queue g2");
    assert_eq!(
        t.state().active_auth,
        auth1,
        "a queued graph is not the running one"
    );
    t.env().set_time(at2);
    t.send(&[apply_pending(&a, &h2)], &[]).expect_ok("apply g2");
    let st = t.state();
    assert_eq!(
        (st.active_graph, st.active_auth, st.active_activate_at),
        (h2, auth2, at2)
    );
    let na = t.now() + 600;
    let f = freeze_auth(t.env(), &a, &h2, na, Some(slot + 1));
    t.send(&[freeze(&a, &f, na)], &[]).expect_ok("freeze");
    let st = t.state();
    assert!(st.frozen);
    assert_eq!((st.active_auth, st.active_activate_at), (auth2, at2));
}

/// A4-4, ported. Before graduation the reference is the migration price,
/// 25x the curve's opening price in this launch. As audited, tokens bought
/// early on the curve and sent to the treasury before each run of a burn
/// node earned tips (a tenth of their value at the migration price) worth
/// more than they cost: 50 burns took the day's 5,000,000-lamport tip cap
/// for 2.4 million lamports of tokens. Now a burn earns no tip before
/// graduation.
#[test]
fn a4_4_burns_earn_no_tips_before_graduation() {
    let mut t = ap_world(false);
    let mut n = gnode(EVERY, 600, BURN, 1 << 50, 0);
    n.budget_per_epoch = 1 << 60;
    n.max_runs_per_epoch = 144;
    t.fund_sol(SOL);
    let h = t.activate_now(&graph(vec![n]));
    let l: noised_launchpad::state::Launch = t.w.env.anchor(&t.k.launch);
    let start = l.execute_end_ts.max(l.guard_end_ts);
    t.env().set_time(start - start % DAY + DAY + 1);
    // The attacker (carol) buys on the curve.
    let carol = t.carol.insecure_clone();
    let tok = |t: &ApWorld| t.w.env.token_amount(&base_ata(&carol.pubkey(), &t.k.mint));
    t.send(
        &[dbc_swap_mode(&carol.pubkey(), &t.k, true, SOL / 2, 0, true)],
        &[&carol],
    )
    .expect_ok("carol buys on the curve");
    // Tokens worth 1,000,000 lamports at the reference: a full tip as
    // audited.
    let reference = t.state().ref_sqrt_price;
    let chunk =
        u64::try_from((1_000_000u128 << 64) / price::price_q64(reference).unwrap()).unwrap() + 1;
    let (tip_acct, sol0) = (t.keeper_tip(), t.sol());
    let tip0 = t.w.env.token_amount(&tip_acct);
    let mut runs = 0;
    while runs < 60 && tok(&t) >= chunk {
        let ix = hooked_transfer(&t.k, &carol.pubkey(), &t.a.treasury, chunk);
        t.send(&[ix], &[&carol]).expect_ok("tokens to the treasury");
        let ev = ran(&t.run(&h, 0, &Extra::None).expect_ok("burn"));
        assert_eq!((ev.burned, ev.tip), (chunk, 0));
        runs += 1;
        let now = t.now();
        t.env().set_time(now + 600);
    }
    assert!(runs >= 50, "{runs} burns");
    assert_eq!(t.w.env.token_amount(&tip_acct), tip0);
    assert_eq!(t.sol(), sol0);
    assert_eq!(t.state().tips_in_epoch, 0);
    println!("A4-4: {runs} burns of {chunk} curve tokens before graduation paid no tips");
}

/// A4-4: after graduation a burn's tokens are valued at the lower of the
/// reference and the lowest price observed in the window, the run's own
/// observation included: after a fall nobody observed, the run sees it.
#[test]
fn a4_4_burns_after_graduation_are_valued_at_the_lowest_observed_price() {
    let mut t = ap_world(true);
    let n = gnode(EVERY, 600, BURN, 1 << 50, 0);
    let h = t.activate_now(&graph(vec![n]));
    t.fund_sol(SOL);
    let reference = t.state().ref_sqrt_price;
    // Tokens worth 1,000,000 lamports at the reference: a full tip there.
    let amount =
        u64::try_from((1_000_000u128 << 64) / price::price_q64(reference).unwrap()).unwrap() + 1;
    assert!(price::token_value(amount, reference) / 10 >= TIP_LAMPORTS);
    // With the pool at the reference: the full tip.
    t.fund_tokens(amount);
    let ev = ran(&t
        .run(&h, 0, &Extra::None)
        .expect_ok("burn at the reference"));
    assert_eq!((ev.spot_sqrt_price, ev.tip), (reference, TIP_LAMPORTS));
    // The market falls about 30%; nobody observes it.
    let now = t.now();
    t.env().set_time(now + 600);
    let reserve_a = t.w.env.token_amount(&t.d.token_a_vault);
    let carol_tokens =
        t.w.env
            .token_amount(&base_ata(&t.carol.pubkey(), &t.k.mint));
    t.carol_sells((reserve_a * 18 / 100).min(carol_tokens / 2));
    let fallen = t.pool_sqrt_price();
    assert!(fallen < reference);
    t.fund_tokens(amount);
    let ev = ran(&t.run(&h, 0, &Extra::None).expect_ok("burn"));
    assert_eq!((ev.burned, ev.spot_sqrt_price), (amount, fallen));
    assert_eq!(
        ev.ref_sqrt_price, reference,
        "the window saw both prices: the reference stays"
    );
    let expected = price::token_value(amount, fallen) / 10;
    assert!(expected < TIP_LAMPORTS);
    assert_eq!(ev.tip, expected);
    println!(
        "A4-4: after a fall of {:.1}% nobody observed, a burn worth a full tip at the reference earned {expected}",
        100.0 - (fallen as f64 / reference as f64).powi(2) * 100.0
    );
}

/// The keeper rent-drain (custody lens, M4), ported. A creator's graph pays
/// three recipients that close their wSOL accounts after every payout (or
/// never have one). As audited, a distribution needed every recipient's
/// account, so the SDK keeper created them each run, paying 2,039,280
/// lamports of rent per account (which the recipient reclaimed by closing
/// it) for a tip of at most 100,000. Now a recipient without an account is
/// skipped and its share stays in the treasury: the run creates nothing,
/// the keeper pays only its fee, and the event lists who was skipped.
#[test]
fn m4_recipients_without_accounts_are_skipped_and_cost_keepers_nothing() {
    let mut t = ap_world(true);
    let payer = t.w.env.payer.insecure_clone();
    let r: Vec<Keypair> = (0..3).map(|_| t.w.env.funded(1)).collect();
    // A tiny payout: a tip of a tenth of what is paid.
    let p1 = 1_000_000;
    let mut p = graph(vec![gnode(EVERY, 600, DISTRIBUTE_SOL, p1, 0)]);
    p.recipients = [5_000u16, 3_000, 2_000]
        .iter()
        .zip(&r)
        .map(|(bps, k)| Recipient {
            key: k.pubkey().to_bytes(),
            bps: *bps,
        })
        .collect();
    t.fund_sol(SOL);
    let h = t.activate_now(&p);
    let atas: Vec<Pubkey> = r.iter().map(|k| wsol_ata(&k.pubkey())).collect();
    for i in [0, 2] {
        t.send(
            &[create_ata(
                &payer.pubkey(),
                &r[i].pubkey(),
                &WSOL_MINT,
                &TOKEN_PROGRAM_ID,
            )],
            &[],
        )
        .expect_ok("a recipient's wSOL account");
    }
    let shares = [p1 / 2, p1 * 3 / 10, p1 / 5];
    // The keeper pays the fee itself.
    let keeper = t.keeper.insecure_clone();
    let run = |t: &mut ApWorld| {
        let named = run_accounts(
            &t.a,
            &keeper.pubkey(),
            None,
            &h,
            t.bound_pool(),
            &t.keeper_tip(),
        );
        let ix = run_ix(named, 0, None, &Extra::Distribute(atas.clone()));
        let before = t.w.env.svm.get_balance(&keeper.pubkey()).unwrap();
        let sent = t.w.env.send_with(&keeper.pubkey(), &[ix], &[&keeper], true);
        let after = t.w.env.svm.get_balance(&keeper.pubkey()).unwrap();
        (sent, before - after)
    };
    // `skipped`: the recipients skipped; `absent`: those of them with no
    // account at all (none is created).
    let check = |t: &ApWorld, sent: &Sent, cost: u64, skipped: u8, absent: u8| {
        assert_eq!(cost, 5_000, "the keeper paid its fee, nothing else");
        assert!(!invoked(&sent.logs, &ATA_PROGRAM_ID));
        assert!(!invoked(&sent.logs, &anchor_lang::system_program::ID));
        let ev = ran(sent);
        let kept: u64 = (0..3)
            .filter(|i| skipped & (1 << i) != 0)
            .map(|i| shares[i])
            .sum();
        assert_eq!((ev.spent, ev.skipped, ev.kept), (p1, skipped, kept));
        // A tip of a tenth of what was paid, not of the shares kept.
        assert_eq!(ev.tip, (p1 - kept) / 10);
        for (i, ata) in atas.iter().enumerate() {
            if absent & (1 << i) != 0 {
                let exists =
                    t.w.env
                        .account(ata)
                        .is_some_and(|a| a.owner == TOKEN_PROGRAM_ID);
                assert!(!exists, "nothing created for recipient {i}");
            }
        }
        ev
    };

    // Recipient 1 never had an account: skipped, its share stays.
    let (sol0, paid0) = (t.sol(), [0, 2].map(|i| t.w.env.token_amount(&atas[i])));
    let (sent, cost) = run(&mut t);
    let sent = sent.expect_ok("a distribution with a recipient missing");
    println!(
        "M4: run DISTRIBUTE_SOL (3 recipients, 1 skipped): {} CU",
        sent.cu
    );
    let ev = check(&t, &sent, cost, 0b010, 0b010);
    assert_eq!(t.w.env.token_amount(&atas[0]), paid0[0] + shares[0]);
    assert_eq!(t.w.env.token_amount(&atas[2]), paid0[1] + shares[2]);
    assert_eq!(t.sol(), sol0 - (p1 - shares[1]) - ev.tip);
    // The budget counts the run's whole amount: a skipped share never goes
    // to the other recipients.
    assert_eq!(t.state().nodes[0].spent_in_epoch, p1);

    // Recipient 2 takes its payout and closes its account (as the attack
    // does after every payout); somebody leaves lamports at recipient 1's
    // address (a system account, no token account).
    let close = spl_token_2022::instruction::close_account(
        &TOKEN_PROGRAM_ID,
        &atas[2],
        &r[2].pubkey(),
        &r[2].pubkey(),
        &[],
    )
    .unwrap();
    t.send(&[close], &[&r[2]])
        .expect_ok("recipient 2 closes its account");
    let donor = t.w.env.funded(1);
    t.send(
        &[anchor_lang::solana_program::system_instruction::transfer(
            &donor.pubkey(),
            &atas[1],
            10_000_000,
        )],
        &[&donor],
    )
    .expect_ok("lamports at recipient 1's address");
    let now = t.now();
    t.env().set_time(now + 600);
    let (sent, cost) = run(&mut t);
    let sent = sent.expect_ok("a distribution with two recipients missing");
    check(&t, &sent, cost, 0b110, 0b110);

    // Recipient 1 creates its account (the funded address is fine): paid.
    let now = t.now();
    t.env().set_time(now + 600);
    t.send(
        &[create_ata(
            &payer.pubkey(),
            &r[1].pubkey(),
            &WSOL_MINT,
            &TOKEN_PROGRAM_ID,
        )],
        &[],
    )
    .expect_ok("recipient 1's wSOL account");
    // (The lamports left there became its wrapped SOL.)
    let held = t.w.env.token_amount(&atas[1]);
    let (sent, cost) = run(&mut t);
    let sent = sent.expect_ok("recipient 1 paid");
    check(&t, &sent, cost, 0b100, 0b100);
    assert_eq!(t.w.env.token_amount(&atas[1]), held + shares[1]);

    // Recipient 0 hands its account to another owner (SPL Token lets an
    // owner reassign it): no longer recipient 0's wSOL account, skipped.
    let other = Keypair::new().pubkey();
    let reassign = spl_token_2022::instruction::set_authority(
        &TOKEN_PROGRAM_ID,
        &atas[0],
        Some(&other),
        spl_token_2022::instruction::AuthorityType::AccountOwner,
        &r[0].pubkey(),
        &[],
    )
    .unwrap();
    t.send(&[reassign], &[&r[0]])
        .expect_ok("recipient 0 reassigns its account");
    let now = t.now();
    t.env().set_time(now + 600);
    let held = t.w.env.token_amount(&atas[0]);
    let (sent, cost) = run(&mut t);
    let sent = sent.expect_ok("a distribution with recipient 0's account reassigned");
    check(&t, &sent, cost, 0b101, 0b100);
    assert_eq!(t.w.env.token_amount(&atas[0]), held);
}

/// M4: a share that rounds to nothing is paid nothing and is no skip, with
/// or without the recipient's account.
#[test]
fn m4_a_share_of_nothing_is_no_skip() {
    let mut t = ap_world(true);
    let payer = t.payer();
    let (big, dust) = (Keypair::new().pubkey(), Keypair::new().pubkey());
    t.send(
        &[create_ata(&payer, &big, &WSOL_MINT, &TOKEN_PROGRAM_ID)],
        &[],
    )
    .expect_ok("a recipient's wSOL account");
    // 9,999 lamports a run: 9,998 and 0 (dust: 9,999 * 1 / 10,000).
    let mut p = graph(vec![gnode(EVERY, 600, DISTRIBUTE_SOL, 9_999, 0)]);
    p.recipients = vec![
        Recipient {
            key: big.to_bytes(),
            bps: 9_999,
        },
        Recipient {
            key: dust.to_bytes(),
            bps: 1,
        },
    ];
    t.fund_sol(SOL);
    let h = t.activate_now(&p);
    let ev = ran(&t
        .run(
            &h,
            0,
            &Extra::Distribute(vec![wsol_ata(&big), wsol_ata(&dust)]),
        )
        .expect_ok("a distribution with a share of nothing"));
    assert_eq!((ev.spent, ev.skipped, ev.kept), (9_998, 0, 0));
    assert_eq!(t.w.env.token_amount(&wsol_ata(&big)), 9_998);
    assert!(t.w.env.account(&wsol_ata(&dust)).is_none());
}

//! The autopilot end to end against mainnet DAMM v2 and Token-2022, on a
//! launch the launchpad made, graduated and migrated: every instruction,
//! every action, every refusal, the reference price, tips, the sandwich
//! bound, compute and transaction sizes. How to build and run: see
//! `src/lib.rs` of this crate.

#[path = "../../../../noised-launchpad/tests/litesvm/tests/common/mod.rs"]
mod common;

mod ap;

use ap::*;
use common::{
    events,
    launch::{create_ata, create_launch, params, wsol_ata, Keys},
    pq,
    vault::open_vault,
    Expect, Failed, Sent, LAMPORTS_PER_SOL, TOKEN_PROGRAM_ID,
};
use noised_autopilot::{
    constants::*,
    error::AutopilotError as E,
    events::{
        GraphActivated, GraphFrozen, GraphPublished, GraphQueued, NodeRan, OperatorRevoked,
        ReferencePriceUpdated,
    },
    launchpad::authorization::kind,
};
use noised_rules::{
    graph::{action::*, trigger::*, FLAG_HAS_OPERATOR},
    op, GNode, GraphProgram, Node, Recipient,
};
use solana_instruction::AccountMeta;
use solana_keypair::Keypair;
use solana_signer::Signer;

const SOL: u64 = LAMPORTS_PER_SOL;
const HOUR: i64 = 3_600;
const DAY: i64 = 86_400;

/// Fails with this autopilot error (number and name, as Anchor logs them).
#[track_caller]
fn refused(r: Result<Sent, Failed>, e: E, what: &str) -> Failed {
    r.fails_with(ap_code(e), &format!("{e:?}"), what)
}

/// Fails with an Anchor framework error.
#[track_caller]
fn refused_by_anchor(r: Result<Sent, Failed>, code: u32, name: &str, what: &str) -> Failed {
    r.fails_with(code, name, what)
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

fn graph(nodes: Vec<GNode>) -> GraphProgram {
    GraphProgram {
        flags: 0,
        operator: [0; 32],
        recipients: vec![],
        nodes,
        cond: vec![],
    }
}

fn leaf(op: u8, a: u8, arg: u64) -> Node {
    Node { op, a, arg }
}

/// The last `NodeRan` of a transaction.
fn ran(sent: &Sent) -> NodeRan {
    events::<NodeRan>(&sent.logs).pop().expect("NodeRan")
}

#[test]
fn buyback_burn_and_distribute_end_to_end() {
    let mut t = ap_world(true);
    let st = t.state();
    assert_eq!((st.mint, st.damm_pool), (t.k.mint, t.d.pool));
    assert_eq!(st.active_graph, [0; 32]);
    // The reference starts at the migration price, where DBC opened the pool.
    assert_eq!(st.ref_sqrt_price, t.pool_sqrt_price());
    let from_fees = t.sol();
    assert!(from_fees > 0, "distribute paid the treasury its fee share");
    println!("treasury from fees: {from_fees} lamports");

    // A recipient wallet and a PQ vault of wSOL.
    let payer = t.w.env.payer.insecure_clone();
    let vault = open_vault(
        t.env(),
        &payer,
        &WSOL_MINT,
        &TOKEN_PROGRAM_ID,
        "autopilot-dist",
    );
    let alice = Keypair::new().pubkey();
    t.send(
        &[create_ata(
            &payer.pubkey(),
            &alice,
            &WSOL_MINT,
            &TOKEN_PROGRAM_ID,
        )],
        &[],
    )
    .expect_ok("alice's wSOL account");
    // A quarter SOL moves this pool's price about 5%: a 10% premium leaves
    // room for the next run before the reference catches up.
    let mut buyback = gnode(EVERY, 3_600, BUYBACK_BURN, SOL / 4, 1_000);
    buyback.budget_per_epoch = SOL / 2;
    buyback.max_runs_per_epoch = 3;
    let mut burn = gnode(AFTER, 0, BURN, 1 << 60, 0);
    burn.budget_per_epoch = 1 << 62;
    let dist = gnode(EVERY, 86_400, DISTRIBUTE_SOL, 2 * SOL, 0);
    let mut p = graph(vec![buyback, burn, dist]);
    p.recipients = vec![
        Recipient {
            key: alice.to_bytes(),
            bps: 6_000,
        },
        Recipient {
            key: vault.address.to_bytes(),
            bps: 4_000,
        },
    ];
    t.fund_sol(10 * SOL);
    let carol_tokens =
        t.w.env
            .token_amount(&common::launch::base_ata(&t.carol.pubkey(), &t.k.mint));
    t.fund_tokens(carol_tokens / 100);
    // At the start of a day, so that the runs below share one epoch.
    let now = t.now();
    t.env().set_time(now - now % DAY + DAY + 1);
    let h = t.activate_now(&p);
    assert_eq!(t.state().active_graph, h);

    // Buyback: the keeper observes the pool, a minute later runs: exactly a
    // quarter SOL into the pool, everything bought burned.
    let extra = t.buyback();
    refused(
        t.run(&h, 0, &extra),
        E::PriceNotObserved,
        "a buyback with no observation of the pool",
    );
    t.observe().expect_ok("update_price");
    refused(
        t.run(&h, 0, &extra),
        E::PriceNotObserved,
        "observed less than a minute ago",
    );
    let now = t.now();
    t.env().set_time(now + OBS_MIN_SPAN_SECS);
    let (sol0, tok0, sup0) = (t.sol(), t.tokens(), supply(&t.w.env, &t.k.mint));
    let vb0 = t.w.env.token_amount(&t.d.token_b_vault);
    let tip0 = t.w.env.token_amount(&t.keeper_tip());
    let sent = t.run(&h, 0, &extra).expect_ok("buyback");
    println!(
        "run BUYBACK_BURN: {} CU, {} bytes (legacy)",
        sent.cu, sent.size
    );
    let ev = ran(&sent);
    assert_eq!(
        (ev.node, ev.action, ev.seq, ev.spent),
        (0, BUYBACK_BURN, 1, SOL / 4)
    );
    assert!(ev.bought > 0 && ev.bought == ev.burned);
    assert_eq!(ev.tip, TIP_LAMPORTS);
    assert_eq!(t.sol(), sol0 - SOL / 4 - TIP_LAMPORTS);
    assert_eq!(t.tokens(), tok0, "nothing bought stays in the treasury");
    assert_eq!(supply(&t.w.env, &t.k.mint), sup0 - ev.bought);
    assert_eq!(t.w.env.token_amount(&t.d.token_b_vault), vb0 + SOL / 4);
    assert_eq!(t.w.env.token_amount(&t.keeper_tip()), tip0 + TIP_LAMPORTS);
    assert!(sent.cu < 1_400_000);
    // The pool was at the reference: nothing to follow.
    assert_eq!(t.state().ref_sqrt_price, ev.ref_sqrt_price);
    assert_eq!(ev.ref_sqrt_price, ev.spot_sqrt_price);

    // BURN runs once after each buyback, and only then.
    let (tok1, sup1) = (t.tokens(), supply(&t.w.env, &t.k.mint));
    let sent = t.run(&h, 1, &Extra::None).expect_ok("burn");
    println!("run BURN: {} CU, {} bytes", sent.cu, sent.size);
    let ev = ran(&sent);
    assert_eq!((ev.spent, ev.burned, ev.bought), (tok1, tok1, 0));
    // Every run observes the pool: the burn saw the price the buyback left.
    assert!(ev.spot_sqrt_price > ev.ref_sqrt_price);
    assert_eq!(t.state().observations[0].max, ev.spot_sqrt_price);
    assert_eq!(t.tokens(), 0);
    assert_eq!(supply(&t.w.env, &t.k.mint), sup1 - tok1);
    refused(
        t.run(&h, 1, &Extra::None),
        E::NodeNotDue,
        "burn before the next buyback",
    );

    // DISTRIBUTE: 2 SOL split 60/40, wallet and PQ vault.
    let sol2 = t.sol();
    let atas = vec![wsol_ata(&alice), vault.token_account];
    let sent = t
        .run(&h, 2, &Extra::Distribute(atas.clone()))
        .expect_ok("distribute");
    println!(
        "run DISTRIBUTE_SOL (2 recipients): {} CU, {} bytes",
        sent.cu, sent.size
    );
    assert_eq!(t.w.env.token_amount(&atas[0]), 2 * SOL * 6 / 10);
    assert_eq!(t.w.env.token_amount(&atas[1]), 2 * SOL * 4 / 10);
    assert_eq!(t.sol(), sol2 - 2 * SOL - TIP_LAMPORTS);
    refused(
        t.run(&h, 2, &Extra::Distribute(atas)),
        E::NodeNotDue,
        "distribute twice a day",
    );

    // The buyback waits its hour, runs within its budget and run limit.
    refused(
        t.run(&h, 0, &extra),
        E::NodeNotDue,
        "buyback before its hour",
    );
    let now = t.now();
    t.env().set_time(now + HOUR);
    refused(
        t.run(&h, 0, &extra),
        E::PriceNotObserved,
        "the last observation is an hour old",
    );
    t.observe_and_wait();
    let ev = ran(&t.run(&h, 0, &extra).expect_ok("second buyback"));
    assert_eq!(ev.spent, SOL / 4);
    let now = t.now();
    t.env().set_time(now + HOUR);
    refused(
        t.run(&h, 0, &extra),
        E::BudgetSpent,
        "budget of half a SOL a day",
    );
    let st = t.state();
    assert_eq!(
        (st.nodes[0].runs_in_epoch, st.nodes[0].spent_in_epoch),
        (2, SOL / 2)
    );
    assert_eq!(st.seq, 4);
}

#[test]
fn runs_refuse_when_not_due_condition_budget_or_run_limit() {
    let mut t = ap_world(true);
    let mut capped = gnode(EVERY, 600, BURN, 10, 0);
    capped.budget_per_epoch = 25;
    capped.max_runs_per_epoch = 5;
    let mut when = gnode(WHEN, 0, BURN, 1, 0);
    when.cond_len = 1;
    let mut limited = gnode(EVERY, 600, BURN, 1, 0);
    limited.max_runs_per_epoch = 2;
    let mut p = graph(vec![capped, when, limited]);
    p.cond = vec![leaf(op::graph::TREASURY_SOL_GTE, 0, 100 * SOL)];
    t.fund_tokens(1_000);
    // Align to the start of a day, so that every run below is in one epoch.
    let now = t.now();
    t.env().set_time(now - now % DAY + DAY + 1);
    let h = t.activate_now(&p);

    assert_eq!(
        ran(&t.run(&h, 0, &Extra::None).expect_ok("run 1")).spent,
        10
    );
    refused(
        t.run(&h, 0, &Extra::None),
        E::NodeNotDue,
        "within its period",
    );
    let t0 = t.now();
    t.env().set_time(t0 + 599);
    refused(
        t.run(&h, 0, &Extra::None),
        E::NodeNotDue,
        "one second early",
    );
    t.env().set_time(t0 + 600);
    assert_eq!(
        ran(&t.run(&h, 0, &Extra::None).expect_ok("run 2")).spent,
        10
    );
    t.env().set_time(t0 + 1_200);
    assert_eq!(
        ran(&t
            .run(&h, 0, &Extra::None)
            .expect_ok("run 3: the rest of the budget"))
        .spent,
        5
    );
    t.env().set_time(t0 + 1_800);
    refused(t.run(&h, 0, &Extra::None), E::BudgetSpent, "budget spent");
    // A new epoch, a new budget.
    t.env().set_time(t0 + DAY);
    assert_eq!(
        ran(&t.run(&h, 0, &Extra::None).expect_ok("next epoch")).spent,
        10
    );

    refused(
        t.run(&h, 1, &Extra::None),
        E::ConditionFalse,
        "treasury below 100 SOL",
    );
    t.fund_sol(100 * SOL);
    t.run(&h, 1, &Extra::None).expect_ok("condition holds");

    t.run(&h, 2, &Extra::None).expect_ok("limited 1");
    let t1 = t.now();
    t.env().set_time(t1 + 600);
    t.run(&h, 2, &Extra::None).expect_ok("limited 2");
    t.env().set_time(t1 + 1_200);
    refused(
        t.run(&h, 2, &Extra::None),
        E::MaxRunsReached,
        "two runs per epoch",
    );

    refused(t.run(&h, 3, &Extra::None), E::NoSuchNode, "node 3 of 3");
    refused(t.run(&h, 255, &Extra::None), E::NoSuchNode, "node 255");
}

#[test]
fn nothing_runs_before_activation_or_graduation() {
    let mut t = ap_world(false);
    // A published graph is not an active one.
    let (gb, gh) = compile(&graph(vec![gnode(EVERY, 600, BURN, 7, 0)]));
    let (a, payer) = (t.a, t.payer());
    t.send(&[publish_graph(&payer, &a, &gb)], &[])
        .expect_ok("publish");
    let keeper = t.keeper.pubkey();
    let tip = t.keeper_tip();
    let named = run_accounts(&t.a, &keeper, None, &gh, None, &tip);
    let keeper_kp = t.keeper.insecure_clone();
    refused(
        t.send(&[run_ix(named, 0, None, &Extra::None)], &[&keeper_kp]),
        E::NoActiveGraph,
        "no graph yet",
    );
    // Before graduation the pool does not exist: buybacks and price
    // updates refuse, burns run.
    let mut p = graph(vec![
        gnode(EVERY, 600, BUYBACK_BURN, SOL / 10, 500),
        gnode(EVERY, 600, BURN, 5, 0),
        gnode(ON_GRADUATED, 0, BURN, 5, 0),
    ]);
    p.nodes[1].budget_per_epoch = 50;
    let tokens =
        t.w.env
            .token_amount(&common::launch::base_ata(&t.carol.pubkey(), &t.k.mint));
    assert_eq!(tokens, 0, "nobody bought yet");
    t.fund_sol(SOL);
    let h = t.activate_now(&p);
    let extra = t.buyback();
    refused(
        t.run(&h, 0, &extra),
        E::NotGraduated,
        "buyback before migration",
    );
    refused(
        t.run(&h, 2, &Extra::None),
        E::NotGraduated,
        "on-graduation node",
    );
    refused(
        t.run(&h, 1, &Extra::None),
        E::NothingToDo,
        "no tokens to burn",
    );
    let a = t.a;
    let pool = t.d.pool;
    refused(
        t.send(&[update_price(&a, &pool)], &[]),
        E::NotGraduated,
        "price before migration",
    );
    let (config, pool) = (t.d.config, t.d.pool);
    refused(
        t.send(&[bind_pool(&a, &config, &pool)], &[]),
        E::NotGraduated,
        "bind a pool that does not exist yet",
    );
    // Burns run on the curve, and leave the reference price alone.
    let l: noised_launchpad::state::Launch = t.w.env.anchor(&t.k.launch);
    t.env().set_time(l.execute_end_ts);
    let carol = t.carol.insecure_clone();
    t.send(
        &[common::launch::dbc_swap_mode(
            &carol.pubkey(),
            &t.k,
            true,
            SOL / 10,
            0,
            true,
        )],
        &[&carol],
    )
    .expect_ok("carol buys on the curve");
    // The hook is still active: a transfer with its accounts.
    let ix = common::launch::hooked_transfer(&t.k, &carol.pubkey(), &t.a.treasury, 100);
    t.send(&[ix], &[&carol])
        .expect_ok("tokens to the treasury on the curve");
    let before = t.state();
    assert_eq!(
        ran(&t.run(&h, 1, &Extra::None).expect_ok("burn on the curve")).spent,
        5
    );
    let after = t.state();
    assert_eq!(
        (after.ref_sqrt_price, after.ref_updated_at),
        (before.ref_sqrt_price, before.ref_updated_at)
    );
    assert_eq!(after.ref_updated_at, 0);
}

#[test]
fn buyback_refuses_above_the_premium_until_the_reference_follows() {
    let mut t = ap_world(true);
    let p = graph(vec![gnode(EVERY, 600, BUYBACK_BURN, SOL / 10, 300)]);
    t.fund_sol(5 * SOL);
    let h = t.activate_now(&p);
    let reference = t.state().ref_sqrt_price;
    // Carol pumps the pool about 20% (sqrt about 10%) and it stays there.
    t.carol_buys(SOL);
    let spot = t.pool_sqrt_price();
    assert!(spot > reference * 105 / 100, "spot {spot} ref {reference}");
    let extra = t.buyback();
    t.observe_and_wait();
    refused(
        t.run(&h, 0, &extra),
        E::PremiumExceeded,
        "pool above ref + 3%",
    );

    // The reference follows what every observation agrees on: one
    // observation alone moves nothing; a minute of them moves it by the
    // allowance (one hour banked), by anyone.
    let sent = t.observe().expect_ok("update_price");
    println!("update_price: {} CU, {} bytes", sent.cu, sent.size);
    let ev = events::<ReferencePriceUpdated>(&sent.logs).pop().unwrap();
    assert_eq!(ev.old_sqrt_price, reference);
    let up = |r: u128| r + r * u128::from(REF_ALLOWANCE_MAX) / REF_ALLOWANCE_SCALE;
    assert_eq!(ev.new_sqrt_price, up(reference));
    assert_eq!(ev.spot_sqrt_price, spot);
    // Calling again moves nothing (the allowance is spent), and costs
    // nothing but the fee: no refusal.
    let sent = t.observe().expect_ok("update_price again");
    let ev2 = events::<ReferencePriceUpdated>(&sent.logs).pop().unwrap();
    assert_eq!(ev2.old_sqrt_price, ev2.new_sqrt_price);
    let mut hours = 0;
    loop {
        let now = t.now();
        t.env().set_time(now + HOUR);
        // A new window: its first observation alone moves nothing.
        let before = t.state().ref_sqrt_price;
        t.observe_and_wait();
        assert_eq!(t.state().ref_sqrt_price, before);
        t.observe().expect_ok("a minute later");
        let after = t.state().ref_sqrt_price;
        assert!(after > before && after <= up(before), "{before} -> {after}");
        hours += 1;
        if after == spot {
            break;
        }
        assert!(hours < 10);
    }
    println!(
        "reference caught up with a ~20% move in {} hours",
        hours + 1
    );
    let ev = ran(&t
        .run(&h, 0, &extra)
        .expect_ok("buyback at the new reference"));
    assert!(ev.bought > 0);
    assert_eq!(t.state().ref_sqrt_price, spot);
}

#[test]
fn a_sandwich_gains_at_most_the_premium() {
    // A keeper sandwiches a buyback: buys first (as much as still lets the
    // buyback through), runs the buyback, sells after. The treasury gets at
    // least the minimum out priced at the reference plus the premium, and
    // the attacker's gain is bounded by the premium on the run's amount.
    let mut t = ap_world(true);
    let p1 = SOL / 5;
    let premium = 500;
    let p = graph(vec![gnode(EVERY, 600, BUYBACK_BURN, p1, premium)]);
    t.fund_sol(5 * SOL);
    let h = t.activate_now(&p);
    let reference = t.state().ref_sqrt_price;
    let extra = t.buyback();
    t.observe_and_wait();
    let carol = t.carol.pubkey();
    let carol_sol = |t: &ApWorld| t.w.env.token_amount(&wsol_ata(&carol));
    let carol_tok = |t: &ApWorld| {
        t.w.env
            .token_amount(&common::launch::base_ata(&carol, &t.k.mint))
    };

    // Unsandwiched, for comparison.
    let clean = {
        let snapshot = t.w.env.svm.clone();
        let ev = ran(&t.run(&h, 0, &extra).expect_ok("clean buyback"));
        t.w.env.svm = snapshot;
        ev.bought
    };
    // The largest pump after which the buyback still goes through.
    let (mut lo, mut hi) = (0u64, 5 * SOL);
    while hi - lo > SOL / 1_000 {
        let mid = (lo + hi) / 2;
        let snapshot = t.w.env.svm.clone();
        t.carol_buys(mid);
        let ok = t.run(&h, 0, &extra).is_ok();
        t.w.env.svm = snapshot;
        if ok {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    assert!(lo > 0, "some pump still lets the buyback through");
    let (sol_before, tok_before) = (carol_sol(&t), carol_tok(&t));
    t.carol_buys(lo);
    let pumped = carol_tok(&t) - tok_before;
    let ev = ran(&t.run(&h, 0, &extra).expect_ok("sandwiched buyback"));
    t.carol_sells(pumped);
    let gain = carol_sol(&t) as i128 - sol_before as i128;
    let floor = noised_autopilot::price::min_out(ev.spent, reference, premium).unwrap();
    println!(
        "sandwich: pump {lo} lamports; treasury got {} tokens for {} lamports (unsandwiched {clean}, floor {floor}); attacker gain {gain} lamports (premium x p1 = {})",
        ev.bought,
        ev.spent,
        p1 * premium / 10_000
    );
    assert_eq!(ev.spent, p1);
    assert!(ev.bought >= floor, "the minimum out holds");
    assert!(
        u128::from(clean - ev.bought) * 10_000 <= u128::from(clean) * u128::from(premium),
        "the treasury lost at most the premium"
    );
    assert!(gain <= (p1 * premium / 10_000) as i128, "gain {gain}");
    // Past the premium the buyback refuses outright.
    let now = t.now();
    t.env().set_time(now + 600);
    t.carol_buys(SOL);
    refused(
        t.run(&h, 0, &extra),
        E::PremiumExceeded,
        "pump past the premium",
    );
}

#[test]
fn operator_gated_nodes_and_revocation() {
    let mut t = ap_world(true);
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
    let mut gated = gnode(EVERY, 600, BUYBACK_BURN, SOL / 4, 800);
    gated.operator_gated = 1;
    let mut p = graph(vec![gated, gnode(EVERY, 600, BURN, 100, 0)]);
    p.flags = FLAG_HAS_OPERATOR;
    p.operator = operator.pubkey().to_bytes();
    t.fund_sol(3 * SOL);
    t.fund_tokens(1_000);
    let h = t.activate_now(&p);
    assert_eq!(t.state().operator, operator.pubkey());
    let extra = t.buyback();
    t.observe_and_wait();

    refused(
        t.run(&h, 0, &extra),
        E::WrongOperator,
        "a keeper runs a gated node",
    );
    let impostor = t.w.env.funded(1);
    t.send(
        &[create_ata(
            &impostor.pubkey(),
            &impostor.pubkey(),
            &WSOL_MINT,
            &TOKEN_PROGRAM_ID,
        )],
        &[&impostor],
    )
    .expect_ok("impostor's wSOL account");
    refused(
        t.run_as(&impostor, &h, 0, Some(SOL / 10), &extra),
        E::WrongOperator,
        "another signer",
    );
    refused(
        t.run_as(&operator, &h, 0, None, &extra),
        E::InvalidAmount,
        "no amount",
    );
    refused(
        t.run_as(&operator, &h, 0, Some(0), &extra),
        E::InvalidAmount,
        "zero",
    );
    refused(
        t.run_as(&operator, &h, 0, Some(SOL / 4 + 1), &extra),
        E::InvalidAmount,
        "above p1",
    );
    let sent = t
        .run_as(&operator, &h, 0, Some(SOL / 10), &extra)
        .expect_ok("operator buyback");
    println!(
        "run BUYBACK_BURN (operator): {} CU, {} bytes",
        sent.cu, sent.size
    );
    assert_eq!(ran(&sent).spent, SOL / 10);
    refused(
        t.run_as(&operator, &h, 1, Some(5), &Extra::None),
        E::AmountNotAllowed,
        "amount on a keeper node",
    );
    t.run_as(&operator, &h, 1, None, &Extra::None)
        .expect_ok("operator runs a keeper node");

    // The identity revokes the operator: its nodes stop.
    let a = t.a;
    let wrong = revoke_auth(t.env(), &a, &h, &impostor.pubkey(), None);
    refused(
        t.send(&[revoke_operator(&a, &wrong)], &[]),
        E::InvalidAuthorization,
        "revoke of another key",
    );
    let other_graph = revoke_auth(t.env(), &a, &[0x77; 32], &operator.pubkey(), None);
    refused(
        t.send(&[revoke_operator(&a, &other_graph)], &[]),
        E::InvalidAuthorization,
        "revoke on another graph",
    );
    let auth = revoke_auth(t.env(), &a, &h, &operator.pubkey(), Some(u64::MAX / 2));
    let sent = t
        .send(&[revoke_operator(&a, &auth)], &[])
        .expect_ok("revoke_operator");
    println!("revoke_operator: {} CU, {} bytes", sent.cu, sent.size);
    let ev = events::<OperatorRevoked>(&sent.logs).pop().unwrap();
    assert_eq!(ev.operator, operator.pubkey());
    assert!(!ev.pending_cleared);
    assert_eq!(t.state().operator, anchor_lang::prelude::Pubkey::default());
    let now = t.now();
    t.env().set_time(now + 600);
    refused(
        t.run_as(&operator, &h, 0, Some(SOL / 10), &extra),
        E::NoOperator,
        "revoked operator",
    );
    refused(
        t.send(&[revoke_operator(&a, &auth)], &[]),
        E::NoOperator,
        "revoked twice",
    );
    t.run(&h, 1, &Extra::None)
        .expect_ok("keeper nodes still run");
}

#[test]
fn graph_changes_need_the_identity_and_the_timelock() {
    let mut t = ap_world(true);
    let a = t.a;
    let payer = t.payer();
    let g1 = graph(vec![gnode(EVERY, 600, BURN, 1, 0)]);
    let g2 = graph(vec![gnode(EVERY, 1_200, BURN, 2, 0)]);
    let g3 = graph(vec![gnode(EVERY, 1_800, BURN, 3, 0)]);
    let (b1, h1) = compile(&g1);
    let (b2, h2) = compile(&g2);
    let (b3, h3) = compile(&g3);
    for b in [&b1, &b2, &b3] {
        let sent = t
            .send(&[publish_graph(&payer, &a, b)], &[])
            .expect_ok("publish");
        assert_eq!(events::<GraphPublished>(&sent.logs).len(), 1);
    }
    t.fund_tokens(1_000);
    let now = t.now();
    let at = now + 100;

    // Authorizations that are not the identity's authorization of this.
    let nobody = Keypair::new().pubkey();
    refused(
        t.send(&[activate(&a, &h1, &nobody, at)], &[]),
        E::InvalidAuthorization,
        "no account",
    );
    let auth = activation_auth(t.env(), &a, &h1, at, None);
    refused(
        t.send(&[activate(&a, &h1, &auth, at + 1)], &[]),
        E::InvalidAuthorization,
        "another time",
    );
    refused(
        t.send(&[activate(&a, &h2, &auth, at)], &[]),
        E::InvalidAuthorization,
        "another graph",
    );
    let payload = noised_autopilot::launchpad::activation_payload(&a.autopilot, &h1, at);
    let other_kind = put_authorization(t.env(), &a, kind::GRAPH_FREEZE, payload, None);
    refused(
        t.send(&[activate(&a, &h1, &other_kind, at)], &[]),
        E::InvalidAuthorization,
        "another kind",
    );
    let forged = put_authorization_with(
        t.env(),
        &a.launch,
        pq::identity_id(),
        kind::GRAPH_ACTIVATE,
        noised_autopilot::launchpad::activation_payload(&a.autopilot, &h1, at + 2),
        None,
        noised_autopilot::ID,
    );
    refused(
        t.send(&[activate(&a, &h1, &forged, at + 2)], &[]),
        E::InvalidAuthorization,
        "not the launchpad's",
    );
    let other_id = put_authorization_with(
        t.env(),
        &a.launch,
        [0x42; 32],
        kind::GRAPH_ACTIVATE,
        noised_autopilot::launchpad::activation_payload(&a.autopilot, &h1, at + 3),
        None,
        noised_launchpad::ID,
    );
    refused(
        t.send(&[activate(&a, &h1, &other_id, at + 3)], &[]),
        E::InvalidAuthorization,
        "another identity",
    );
    let past = activation_auth(t.env(), &a, &h1, now - 1, None);
    refused(
        t.send(&[activate(&a, &h1, &past, now - 1)], &[]),
        E::ActivationInPast,
        "first graph in the past",
    );

    let na = t.now() + 3_600;
    let early = freeze_auth(t.env(), &a, &[0; 32], na, None);
    refused(
        t.send(&[freeze(&a, &early, na)], &[]),
        E::NoActiveGraph,
        "freeze before any graph",
    );

    // The first graph: queued, applied at its time.
    let sent = t
        .send(&[activate(&a, &h1, &auth, at)], &[])
        .expect_ok("activate");
    println!("activate: {} CU, {} bytes", sent.cu, sent.size);
    let ev = events::<GraphQueued>(&sent.logs).pop().unwrap();
    assert_eq!(
        (ev.graph_hash, ev.activate_at, ev.authorization),
        (h1, at, auth)
    );
    refused(
        t.send(&[activate(&a, &h1, &auth, at)], &[]),
        E::StaleAuthorization,
        "replayed",
    );
    refused(
        t.send(&[apply_pending(&a, &h1)], &[]),
        E::UpdateNotDue,
        "before its time",
    );
    refused(
        t.run(&h1, 0, &Extra::None),
        E::NoActiveGraph,
        "queued is not active",
    );
    t.env().set_time(at);
    let sent = t
        .send(&[apply_pending(&a, &h1)], &[])
        .expect_ok("apply_pending");
    println!("apply_pending: {} CU, {} bytes", sent.cu, sent.size);
    assert_eq!(
        events::<GraphActivated>(&sent.logs)
            .pop()
            .unwrap()
            .graph_hash,
        h1
    );
    refused(
        t.send(&[apply_pending(&a, &h1)], &[]),
        E::NoPendingUpdate,
        "applied twice",
    );
    t.run(&h1, 0, &Extra::None).expect_ok("g1 runs");

    // A replacement: 72 hours after it is queued, not one second less.
    let now = t.now();
    let short = activation_auth(t.env(), &a, &h2, now + UPDATE_TIMELOCK_SECS - 1, None);
    refused(
        t.send(
            &[activate(&a, &h2, &short, now + UPDATE_TIMELOCK_SECS - 1)],
            &[],
        ),
        E::TimelockTooShort,
        "71:59:59",
    );
    let at2 = now + UPDATE_TIMELOCK_SECS;
    let slot2 = t.state().auth_marks[0].slot + 10;
    let auth2 = activation_auth(t.env(), &a, &h2, at2, Some(slot2));
    t.send(&[activate(&a, &h2, &auth2, at2)], &[])
        .expect_ok("queue g2");
    // An older authorization never overrides a newer one.
    let old = activation_auth(t.env(), &a, &h3, at2 + 10, Some(slot2 - 1));
    refused(
        t.send(&[activate(&a, &h3, &old, at2 + 10)], &[]),
        E::StaleAuthorization,
        "older than the one used",
    );
    // The active graph runs until the switch; then the switch must be applied first.
    t.env().set_time(at2 - 1);
    t.run(&h1, 0, &Extra::None).expect_ok("g1 still runs");
    refused(
        t.send(&[apply_pending(&a, &h2)], &[]),
        E::UpdateNotDue,
        "one second early",
    );
    t.env().set_time(at2);
    refused(
        t.run(&h1, 0, &Extra::None),
        E::PendingUpdateDue,
        "the update is due",
    );
    t.send(&[apply_pending(&a, &h2)], &[]).expect_ok("apply g2");
    let st = t.state();
    assert_eq!((st.active_graph, st.pending_graph), (h2, [0; 32]));
    assert_eq!(st.nodes[0], Default::default(), "fresh node states");
    let g1_run = t.run(&h1, 0, &Extra::None);
    refused_by_anchor(g1_run, 2_006, "ConstraintSeeds", "the old graph's account");
    assert_eq!(
        ran(&t.run(&h2, 0, &Extra::None).expect_ok("g2 runs")).spent,
        2
    );

    // Freeze: only the active graph, then nothing changes it again.
    let now = t.now();
    let at3 = now + UPDATE_TIMELOCK_SECS + 5;
    let auth3 = activation_auth(t.env(), &a, &h3, at3, Some(slot2 + 10));
    t.send(&[activate(&a, &h3, &auth3, at3)], &[])
        .expect_ok("queue g3");
    let na = now + 3_600;
    let not_active = freeze_auth(t.env(), &a, &h1, na, Some(slot2 + 20));
    refused(
        t.send(&[freeze(&a, &not_active, na)], &[]),
        E::InvalidAuthorization,
        "freeze of another graph",
    );
    // Review 4, R5: a freeze is used only until the `not_after` it signs,
    // and only with that `not_after`. A refused freeze changes nothing.
    let f = freeze_auth(t.env(), &a, &h2, na, Some(slot2 + 30));
    refused(
        t.send(&[freeze(&a, &f, na + 1)], &[]),
        E::InvalidAuthorization,
        "a freeze sent with another not_after than it signed",
    );
    let past = t.now() - 1;
    let expired = freeze_auth(t.env(), &a, &h2, past, Some(slot2 + 31));
    refused(
        t.send(&[freeze(&a, &expired, past)], &[]),
        E::FreezeExpired,
        "a freeze one second past its not_after",
    );
    let st = t.state();
    assert!(!st.frozen && st.pending_graph == h3, "nothing changed");
    // Up to and including its not_after.
    t.env().set_time(na);
    let sent = t.send(&[freeze(&a, &f, na)], &[]).expect_ok("freeze");
    println!("freeze: {} CU, {} bytes", sent.cu, sent.size);
    let ev = events::<GraphFrozen>(&sent.logs).pop().unwrap();
    assert_eq!((ev.graph_hash, ev.cancelled), (h2, h3));
    let st = t.state();
    assert!(st.frozen);
    assert_eq!(st.pending_graph, [0; 32], "the queued update is cancelled");
    t.env().set_time(at3);
    refused(
        t.send(&[apply_pending(&a, &h3)], &[]),
        E::NoPendingUpdate,
        "cancelled update",
    );
    let again = activation_auth(
        t.env(),
        &a,
        &h3,
        at3 + UPDATE_TIMELOCK_SECS,
        Some(slot2 + 40),
    );
    refused(
        t.send(
            &[activate(&a, &h3, &again, at3 + UPDATE_TIMELOCK_SECS)],
            &[],
        ),
        E::Frozen,
        "frozen",
    );
    let na2 = t.now() + 3_600;
    let f2 = freeze_auth(t.env(), &a, &h2, na2, Some(slot2 + 50));
    refused(
        t.send(&[freeze(&a, &f2, na2)], &[]),
        E::Frozen,
        "frozen twice",
    );
    t.run(&h2, 0, &Extra::None)
        .expect_ok("a frozen graph runs forever");
}

#[test]
fn init_bind_and_publish_rules() {
    let mut t = ap_world(true);
    let payer = t.payer();
    let (k, a) = (t.k, t.a);
    // Once per launch.
    assert!(
        t.send(&[init_autopilot(&payer, &k)], &[]).is_err(),
        "init twice"
    );
    refused(
        t.send(&[bind_mint(&payer, &k, &a)], &[]),
        E::MintAlreadyBound,
        "bind twice",
    );
    let (config, pool) = (t.d.config, t.d.pool);
    refused(
        t.send(&[bind_pool(&a, &config, &pool)], &[]),
        E::PoolAlreadyBound,
        "bind the pool twice",
    );

    // A launch that is configured, not live: init works, bind waits.
    let mint = Keypair::new();
    let creator = t.w.creator.insecure_clone();
    let k2 = Keys::new(&creator.pubkey(), [0x5E; 32], mint.pubkey());
    let p = params(&[(t.fee_recipient, 10_000)]);
    t.send(&[create_launch(&creator.pubkey(), &k2, p)], &[&creator])
        .expect_ok("create_launch");
    let a2 = ApKeys::new(&k2.launch, &k2.mint);
    refused(
        t.send(&[init_autopilot_with(&payer, k2.launch, k.dbc_config)], &[]),
        E::InvalidDbcConfig,
        "another launch's config",
    );
    refused(
        t.send(&[init_autopilot_with(&payer, k2.launch, k2.pool)], &[]),
        E::InvalidDbcConfig,
        "not a config",
    );
    let sent = t
        .send(&[init_autopilot(&payer, &k2)], &[])
        .expect_ok("init on a configured launch");
    println!("init_autopilot: {} CU, {} bytes", sent.cu, sent.size);
    let cfg: noised_launchpad::dynamic_bonding_curve::accounts::ConfigWithTransferHook = {
        let acct = t.w.env.account(&k2.dbc_config).unwrap();
        anchor_lang::__private::bytemuck::pod_read_unaligned(&acct.data[8..])
    };
    assert_eq!(
        autopilot(&t.w.env, &a2).ref_sqrt_price,
        cfg.config.migration_sqrt_price
    );
    refused(
        t.send(&[bind_mint_with(&payer, &a2, k.mint, k.certificate)], &[]),
        E::LaunchNotLive,
        "not live",
    );
    // Not a launch at all.
    refused(
        t.send(
            &[init_autopilot_with(&payer, k.certificate, k.dbc_config)],
            &[],
        ),
        E::NotALaunch,
        "a certificate as the launch",
    );
    // Bind needs the launch's own mint and certificate.
    let w_first = t.w.k;
    let creator_launch = ApKeys::new(&w_first.launch, &w_first.mint);
    t.send(&[init_autopilot(&payer, &w_first)], &[])
        .expect_ok("init the first launch's autopilot");
    refused(
        t.send(
            &[bind_mint_with(
                &payer,
                &creator_launch,
                k.mint,
                k.certificate,
            )],
            &[],
        ),
        E::InvalidCertificate,
        "another launch's mint",
    );
    // Nothing runs on an unbound autopilot, even with every account in
    // place (anyone may create the treasury's token account early).
    let (gb, gh) = compile(&graph(vec![gnode(EVERY, 600, BURN, 1, 0)]));
    t.send(&[publish_graph(&payer, &creator_launch, &gb)], &[])
        .expect_ok("publish");
    t.send(
        &[create_ata(
            &payer,
            &creator_launch.treasury,
            &w_first.mint,
            &common::TOKEN_2022_PROGRAM_ID,
        )],
        &[],
    )
    .expect_ok("the treasury's token account, early");
    let keeper = t.keeper.insecure_clone();
    let named = run_accounts(
        &creator_launch,
        &keeper.pubkey(),
        None,
        &gh,
        None,
        &t.keeper_tip(),
    );
    refused(
        t.send(&[run_ix(named, 0, None, &Extra::None)], &[&keeper]),
        E::MintNotBound,
        "run before bind",
    );
    refused(
        t.send(&[bind_pool(&creator_launch, &config, &pool)], &[]),
        E::MintNotBound,
        "bind a pool before the mint",
    );
    let sent = t
        .send(&[bind_mint(&payer, &w_first, &creator_launch)], &[])
        .expect_ok("bind");
    println!("bind_mint: {} CU, {} bytes", sent.cu, sent.size);

    // Publishing.
    let mut bad = graph(vec![gnode(EVERY, 599, BURN, 1, 0)]).encode().unwrap();
    let f = refused(
        t.send(&[publish_graph(&payer, &a, &bad)], &[]),
        E::InvalidGraph,
        "every 599 s",
    );
    assert!(f.logs.iter().any(|l| l.contains("PXG1: EveryTooShort")));
    bad[4] = 2;
    let f = refused(
        t.send(&[publish_graph(&payer, &a, &bad)], &[]),
        E::InvalidGraph,
        "version 2",
    );
    assert!(f.logs.iter().any(|l| l.contains("PXG1: BadVersion")));
    let (bytes, h) = compile(&graph(vec![gnode(EVERY, 600, BURN, 2, 0)]));
    let sent = t
        .send(&[publish_graph(&payer, &a, &bytes)], &[])
        .expect_ok("publish");
    println!(
        "publish_graph ({} bytes): {} CU, {} bytes",
        bytes.len(),
        sent.cu,
        sent.size
    );
    let ev = events::<GraphPublished>(&sent.logs).pop().unwrap();
    assert_eq!((ev.graph_hash, ev.len as usize), (h, bytes.len()));
    let rec = graph_record(&t.w.env, &a, &h);
    assert_eq!(
        (rec.bytes, rec.launch, rec.graph_hash),
        (bytes.clone(), a.launch, h)
    );
    let sent = t
        .send(&[publish_graph(&payer, &a, &bytes)], &[])
        .expect_ok("republish");
    assert!(
        events::<GraphPublished>(&sent.logs).is_empty(),
        "idempotent"
    );
    refused(
        t.send(
            &[publish_graph(
                &payer,
                &ApKeys::new(&k.certificate, &k.mint),
                &bytes,
            )],
            &[],
        ),
        E::NotALaunch,
        "publish under a non-launch",
    );
    // A graph published for one launch cannot be activated for another.
    let now = t.now();
    let auth = activation_auth(t.env(), &creator_launch, &h, now, None);
    refused_by_anchor(
        t.send(&[activate(&creator_launch, &h, &auth, now)], &[]),
        3_012,
        "AccountNotInitialized",
        "another launch's graph",
    );
}

#[test]
fn wrong_accounts_are_refused() {
    let mut t = ap_world(true);
    let alice = Keypair::new().pubkey();
    let payer = t.payer();
    t.send(
        &[create_ata(&payer, &alice, &WSOL_MINT, &TOKEN_PROGRAM_ID)],
        &[],
    )
    .expect_ok("alice's wSOL account");
    let mut p = graph(vec![
        gnode(EVERY, 600, BUYBACK_BURN, SOL / 10, 800),
        gnode(EVERY, 600, DISTRIBUTE_SOL, SOL / 10, 0),
        gnode(EVERY, 600, BURN, 1, 0),
    ]);
    p.recipients = vec![Recipient {
        key: alice.to_bytes(),
        bps: 10_000,
    }];
    t.fund_sol(2 * SOL);
    t.fund_tokens(10);
    let h = t.activate_now(&p);
    t.observe_and_wait();
    let (a, d) = (t.a, t.d);
    let keeper = t.keeper.insecure_clone();
    let kp = keeper.pubkey();
    let tip = t.keeper_tip();
    let named = || run_accounts(&a, &kp, None, &h, Some(d.pool), &tip);
    let carol = t.carol.pubkey();
    let send =
        |t: &mut ApWorld, named: noised_autopilot::accounts::Run, node: u8, extra: &Extra| {
            t.send(&[run_ix(named, node, None, extra)], &[&keeper])
        };
    let buy = Extra::Buyback(d);

    // The pool: only the bound one, and it must be there once bound.
    let mut n = named();
    n.damm_pool = Some(t.k.pool);
    refused(
        send(&mut t, n, 0, &buy),
        E::InvalidPool,
        "the DBC pool as the DAMM pool",
    );
    let mut n = named();
    n.damm_pool = None;
    refused(send(&mut t, n, 0, &buy), E::InvalidPool, "no pool");
    let mut n = named();
    n.damm_pool = None;
    refused(
        send(&mut t, n, 2, &Extra::None),
        E::InvalidPool,
        "no pool, for a burn",
    );
    // DAMM v2's accounts, exactly.
    let damm = |vault_a: anchor_lang::prelude::Pubkey, vault_b, program| {
        Extra::Raw(vec![
            AccountMeta::new_readonly(noised_launchpad::constants::DAMM_V2_POOL_AUTHORITY, false),
            AccountMeta::new(vault_a, false),
            AccountMeta::new(vault_b, false),
            AccountMeta::new_readonly(noised_launchpad::constants::DAMM_V2_EVENT_AUTHORITY, false),
            AccountMeta::new_readonly(program, false),
        ])
    };
    let damm_id = noised_launchpad::constants::DAMM_V2_PROGRAM_ID;
    refused(
        send(
            &mut t,
            named(),
            0,
            &damm(d.token_b_vault, d.token_a_vault, damm_id),
        ),
        E::InvalidDammAccounts,
        "vaults swapped",
    );
    refused(
        send(
            &mut t,
            named(),
            0,
            &damm(wsol_ata(&carol), d.token_b_vault, damm_id),
        ),
        E::InvalidDammAccounts,
        "carol's account as vault A",
    );
    let with = |i: usize, key: anchor_lang::prelude::Pubkey| {
        let mut m = match damm(d.token_a_vault, d.token_b_vault, damm_id) {
            Extra::Raw(m) => m,
            _ => unreachable!(),
        };
        m[i].pubkey = key;
        Extra::Raw(m)
    };
    refused(
        send(&mut t, named(), 0, &with(0, carol)),
        E::InvalidDammAccounts,
        "another pool authority",
    );
    refused(
        send(&mut t, named(), 0, &with(3, carol)),
        E::InvalidDammAccounts,
        "another event authority",
    );
    refused(
        send(
            &mut t,
            named(),
            0,
            &damm(d.token_a_vault, wsol_ata(&carol), damm_id),
        ),
        E::InvalidDammAccounts,
        "carol's account as a vault",
    );
    refused(
        send(
            &mut t,
            named(),
            0,
            &damm(d.token_a_vault, d.token_b_vault, TOKEN_PROGRAM_ID),
        ),
        E::InvalidDammAccounts,
        "another program",
    );
    refused(
        send(
            &mut t,
            named(),
            0,
            &damm(d.token_a_vault, d.token_b_vault, noised_autopilot::ID),
        ),
        E::InvalidDammAccounts,
        "our own program",
    );
    refused(
        send(&mut t, named(), 0, &Extra::None),
        E::InvalidDammAccounts,
        "no DAMM accounts",
    );
    let mut more = match damm(d.token_a_vault, d.token_b_vault, damm_id) {
        Extra::Raw(m) => m,
        _ => unreachable!(),
    };
    more.push(AccountMeta::new(wsol_ata(&carol), false));
    refused(
        send(&mut t, named(), 0, &Extra::Raw(more)),
        E::InvalidDammAccounts,
        "an extra account",
    );
    // A read-only pool: the swap cannot write it.
    let f = send(
        &mut t,
        named(),
        0,
        &Extra::Raw(match damm(d.token_a_vault, d.token_b_vault, damm_id) {
            Extra::Raw(m) => m,
            _ => unreachable!(),
        }),
    );
    assert!(f.is_err(), "the pool must be writable for a swap");

    // Treasury accounts, mints and programs.
    let mut n = named();
    n.treasury_wsol = wsol_ata(&carol);
    assert!(
        send(&mut t, n, 0, &buy).is_err(),
        "carol's wSOL as the treasury's"
    );
    let mut n = named();
    n.treasury_token = common::launch::base_ata(&carol, &t.k.mint);
    assert!(
        send(&mut t, n, 0, &buy).is_err(),
        "carol's tokens as the treasury's"
    );
    let mut n = named();
    n.treasury = carol;
    refused_by_anchor(
        send(&mut t, n, 0, &buy),
        2_006,
        "ConstraintSeeds",
        "another treasury authority",
    );
    let mut n = named();
    n.mint = t.w.k.mint;
    assert!(send(&mut t, n, 0, &buy).is_err(), "another mint");
    let mut n = named();
    n.token_program = noised_launchpad::constants::DAMM_V2_PROGRAM_ID;
    assert!(send(&mut t, n, 0, &buy).is_err(), "a fake token program");
    let mut n = named();
    n.tip_account = common::launch::base_ata(&carol, &t.k.mint);
    assert!(
        send(&mut t, n, 0, &buy).is_err(),
        "a token account as the tip account"
    );
    let mut n = named();
    n.autopilot = ApKeys::new(&t.w.k.launch, &t.w.k.mint).autopilot;
    assert!(
        send(&mut t, n, 0, &buy).is_err(),
        "another launch's autopilot"
    );

    // Distribution: only the recipients' canonical wSOL accounts, writable.
    refused(
        send(
            &mut t,
            named(),
            1,
            &Extra::Distribute(vec![wsol_ata(&carol)]),
        ),
        E::InvalidRecipientAccounts,
        "carol instead of alice",
    );
    refused(
        send(&mut t, named(), 1, &Extra::Distribute(vec![])),
        E::InvalidRecipientAccounts,
        "missing",
    );
    refused(
        send(
            &mut t,
            named(),
            1,
            &Extra::Distribute(vec![wsol_ata(&alice), wsol_ata(&carol)]),
        ),
        E::InvalidRecipientAccounts,
        "an extra one",
    );
    refused(
        send(
            &mut t,
            named(),
            1,
            &Extra::Raw(vec![AccountMeta::new_readonly(wsol_ata(&alice), false)]),
        ),
        E::InvalidRecipientAccounts,
        "read-only",
    );
    // An empty account as the pool: not the bound pool, even for a burn.
    let mut n = named();
    n.damm_pool = Some(Keypair::new().pubkey());
    refused(
        send(&mut t, n, 2, &Extra::None),
        E::InvalidPool,
        "an empty account as the pool",
    );
    let a2 = t.a;
    refused(
        t.send(&[update_price(&a2, &Keypair::new().pubkey())], &[]),
        E::InvalidPool,
        "update_price with another pool",
    );
    // A burn takes no remaining accounts.
    refused(
        send(&mut t, named(), 2, &buy),
        E::UnexpectedAccounts,
        "DAMM accounts on a burn",
    );
    refused(
        send(
            &mut t,
            named(),
            2,
            &Extra::Distribute(vec![wsol_ata(&alice)]),
        ),
        E::UnexpectedAccounts,
        "an account on a burn",
    );
    // Nothing moved; the right accounts work.
    assert_eq!(t.w.env.token_amount(&wsol_ata(&alice)), 0);
    send(&mut t, named(), 2, &Extra::None).expect_ok("burn");
    send(
        &mut t,
        named(),
        1,
        &Extra::Distribute(vec![wsol_ata(&alice)]),
    )
    .expect_ok("distribute");
    send(&mut t, named(), 0, &buy).expect_ok("buyback");
}

#[test]
fn distribute_pays_only_recipients_with_an_account() {
    // A recipient without a wSOL account is skipped (audit 4, M4: nobody
    // pays for a recipient's account); a run that could pay nobody refuses
    // and changes nothing.
    let mut t = ap_world(true);
    let bob = Keypair::new().pubkey();
    let mut p = graph(vec![gnode(EVERY, 600, DISTRIBUTE_SOL, SOL / 10, 0)]);
    p.recipients = vec![Recipient {
        key: bob.to_bytes(),
        bps: 10_000,
    }];
    t.fund_sol(SOL);
    let h = t.activate_now(&p);
    let before = t.state();
    refused(
        t.run(&h, 0, &Extra::Distribute(vec![wsol_ata(&bob)])),
        E::NoRecipientAccount,
        "no wSOL account",
    );
    assert_eq!(t.state().nodes, before.nodes);
    let payer = t.payer();
    t.send(
        &[create_ata(&payer, &bob, &WSOL_MINT, &TOKEN_PROGRAM_ID)],
        &[],
    )
    .expect_ok("bob's wSOL account");
    t.run(&h, 0, &Extra::Distribute(vec![wsol_ata(&bob)]))
        .expect_ok("distribute");
    assert_eq!(t.w.env.token_amount(&wsol_ata(&bob)), SOL / 10);
    // A run that empties the treasury pays no tip: tips only come from what
    // the action left.
    let mut p = graph(vec![gnode(EVERY, 600, DISTRIBUTE_SOL, 1_000 * SOL, 0)]);
    p.recipients = vec![Recipient {
        key: bob.to_bytes(),
        bps: 10_000,
    }];
    let (bytes, h2) = compile(&p);
    let (a, payer) = (t.a, t.payer());
    t.send(&[publish_graph(&payer, &a, &bytes)], &[])
        .expect_ok("publish");
    let at = t.now() + UPDATE_TIMELOCK_SECS;
    let floor = t.state().auth_marks[0].slot;
    let auth = activation_auth(t.env(), &a, &h2, at, Some(floor + 1));
    t.send(&[activate(&a, &h2, &auth, at)], &[])
        .expect_ok("queue");
    t.env().set_time(at);
    t.send(&[apply_pending(&a, &h2)], &[]).expect_ok("apply");
    let all = t.sol();
    let bob_before = t.w.env.token_amount(&wsol_ata(&bob));
    let ev = ran(&t
        .run(&h2, 0, &Extra::Distribute(vec![wsol_ata(&bob)]))
        .expect_ok("drain"));
    assert_eq!((ev.spent, ev.tip), (all, 0));
    assert_eq!(t.sol(), 0);
    assert_eq!(t.w.env.token_amount(&wsol_ata(&bob)), bob_before + all);
}

#[test]
fn damm_configs_are_dbcs_migration_configs() {
    // The six configs DBC migrates through on mainnet today: DBC's pool
    // authority is their only pool creator (so `bind_pool` accepts them),
    // and their fees are the migration fee options 0..=5 (0.25%, 0.3%, 1%,
    // 2%, 4%, 6%), as mainnet holds them.
    let mut env = common::Env::new();
    let fees = [25u64, 30, 100, 200, 400, 600];
    let configs = [
        "7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd",
        "2nHK1kju6XjphBLbNxpM5XRGFj7p9U8vvNzyZiha1z6k",
        "Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp",
        "2c4cYd4reUYVRAB9kUUkrq55VPyy2FNQ3FDL4o12JXmq",
        "AkmQWebAwFvWk55wBoCr5D62C6VVDTzi84NJuD9H7cFD",
        "DbCRBj8McvPYHJG1ukj8RE15h2dCNUdTAESG49XpQ44u",
    ]
    .map(|k| k.parse::<anchor_lang::prelude::Pubkey>().unwrap());
    for (option, config) in configs.iter().enumerate() {
        let key = env.load_account_json(&common::fixture(&format!("accounts/{config}.json")));
        assert_eq!(key, *config);
        let account = env.account(config).unwrap();
        assert_eq!(
            account.owner,
            noised_launchpad::constants::DAMM_V2_PROGRAM_ID
        );
        let cfg: noised_launchpad::cp_amm::accounts::Config =
            anchor_lang::__private::bytemuck::pod_read_unaligned(&account.data[8..]);
        assert_eq!(
            cfg.pool_creator_authority, DBC_POOL_AUTHORITY,
            "option {option}"
        );
        noised_autopilot::external::check_migration_config(&account.owner, &account.data)
            .unwrap_or_else(|e| panic!("option {option}: {e:?}"));
        // `BaseFeeInfo::data` starts with the cliff fee numerator (u64, of 1e9).
        let cliff = u64::from_le_bytes(cfg.pool_fees.base_fee.data[..8].try_into().unwrap());
        assert_eq!(cliff, fees[option] * 100_000, "option {option}");
    }
}

#[test]
fn tips_are_capped_per_day_and_come_only_from_the_treasury() {
    let mut t = ap_world(true);
    // Each burn worth 0.002 SOL at the reference price: a full tip (at
    // most a tenth of what a run moves).
    let price = noised_autopilot::price::price_q64(t.state().ref_sqrt_price).unwrap();
    let per_run = u64::try_from((2_000_000u128 << 64) / price + 1).unwrap();
    assert!(
        noised_autopilot::price::token_value(per_run, t.state().ref_sqrt_price)
            >= 10 * TIP_LAMPORTS
    );
    let mut n = gnode(EVERY, 600, BURN, per_run, 0);
    n.budget_per_epoch = u64::MAX / 2;
    n.max_runs_per_epoch = 1_000;
    t.fund_tokens(per_run * 52);
    let now = t.now();
    t.env().set_time(now - now % DAY + DAY);
    let h = t.activate_now(&graph(vec![n]));
    // Tips come from the treasury's wSOL (its fee share), never more than
    // it holds.
    let sol = t.sol();
    let mut paid = 0;
    for i in 0..51 {
        let ev = ran(&t.run(&h, 0, &Extra::None).expect_ok("run"));
        let expected = if i < 50 {
            TIP_LAMPORTS.min(sol - paid)
        } else {
            0
        };
        assert_eq!(ev.tip, expected, "run {i}");
        paid += ev.tip;
        let now = t.now();
        t.env().set_time(now + 600);
    }
    assert!(paid <= TIP_EPOCH_CAP);
    assert_eq!(t.sol(), sol - paid);
    // The next day, tips again.
    let now = t.now();
    t.env().set_time(now - now % DAY + DAY);
    let ev = ran(&t.run(&h, 0, &Extra::None).expect_ok("next day"));
    assert_eq!(ev.tip, TIP_LAMPORTS.min(sol - paid));
}

#[test]
fn transaction_sizes_and_compute_at_the_limits() {
    // The largest graph (8 recipients, 16 nodes, 96 condition nodes):
    // publish fits a v1 transaction; a distribution to 8 recipients and a
    // gated buyback fit legacy transactions.
    let mut t = ap_world(true);
    let operator = t.w.env.funded(2);
    let opk = operator.pubkey();
    t.send(
        &[create_ata(&opk, &opk, &WSOL_MINT, &TOKEN_PROGRAM_ID)],
        &[&operator],
    )
    .expect_ok("operator's wSOL account");
    let payer = t.payer();
    let recipients: Vec<anchor_lang::prelude::Pubkey> =
        (0..8).map(|_| Keypair::new().pubkey()).collect();
    for r in &recipients {
        t.send(&[create_ata(&payer, r, &WSOL_MINT, &TOKEN_PROGRAM_ID)], &[])
            .expect_ok("recipient wSOL account");
    }
    let mut nodes = Vec::new();
    let mut cond = Vec::new();
    for i in 0..16u8 {
        let mut n = match i {
            0 => gnode(EVERY, 600, BUYBACK_BURN, SOL / 10, 800),
            1 => gnode(EVERY, 600, DISTRIBUTE_SOL, SOL, 0),
            _ => gnode(AFTER, u64::from(i - 1), BURN, 1, 0),
        };
        if i == 0 {
            n.operator_gated = 1;
        }
        // Node 15: the longest condition (81 nodes: 41 leaves, 40 ORs), so
        // that the 96 condition nodes are all used.
        let len: usize = if i == 15 { 81 } else { 1 };
        n.cond_off = cond.len() as u8;
        n.cond_len = len as u8;
        if len == 1 {
            cond.push(leaf(op::graph::TREASURY_SOL_GTE, 0, 0));
        } else {
            cond.push(leaf(op::graph::TIME_GE, 0, 0));
            for _ in 0..40 {
                cond.push(leaf(op::graph::RUNS_IN_EPOCH_LT, 3, 1_000));
                cond.push(leaf(op::OR, 0, 0));
            }
        }
        nodes.push(n);
    }
    assert_eq!(cond.len(), 96);
    let p = GraphProgram {
        flags: FLAG_HAS_OPERATOR,
        operator: opk.to_bytes(),
        recipients: recipients
            .iter()
            .map(|r| Recipient {
                key: r.to_bytes(),
                bps: 1_250,
            })
            .collect(),
        nodes,
        cond,
    };
    let (bytes, h) = compile(&p);
    assert_eq!(bytes.len(), noised_rules::graph::MAX_LEN);
    let a = t.a;
    let fee_payer = t.w.env.funded(1);
    let config = solana_message::v1::TransactionConfig::empty()
        .with_compute_unit_limit(200_000)
        .with_loaded_accounts_data_size_limit(1024 * 1024);
    let sent =
        t.w.env
            .send_v1(
                &fee_payer,
                &[publish_graph(&fee_payer.pubkey(), &a, &bytes)],
                &[],
                config,
            )
            .expect_ok("publish the largest graph");
    println!(
        "publish_graph (2,044-byte graph): {} CU, {} bytes (v1)",
        sent.cu, sent.size
    );
    let now = t.now();
    let auth = activation_auth(t.env(), &a, &h, now, None);
    t.send(&[activate(&a, &h, &auth, now)], &[])
        .expect_ok("activate");
    t.send(&[apply_pending(&a, &h)], &[]).expect_ok("apply");
    t.fund_sol(3 * SOL);
    let extra = t.buyback();
    t.observe_and_wait();
    let sent = t
        .run_as(&operator, &h, 0, Some(SOL / 10), &extra)
        .expect_ok("gated buyback");
    println!(
        "run BUYBACK_BURN (gated, largest graph): {} CU, {} bytes (legacy)",
        sent.cu, sent.size
    );
    assert!(sent.cu < 1_400_000 && sent.size <= common::PACKET_DATA_SIZE);
    let atas: Vec<_> = recipients.iter().map(wsol_ata).collect();
    let sent = t
        .run(&h, 1, &Extra::Distribute(atas.clone()))
        .expect_ok("distribute to 8");
    println!(
        "run DISTRIBUTE_SOL (8 recipients): {} CU, {} bytes (legacy)",
        sent.cu, sent.size
    );
    assert!(sent.size <= common::PACKET_DATA_SIZE);
    for r in &atas {
        assert_eq!(t.w.env.token_amount(r), SOL / 8);
    }
    // The longest condition (node 15) once its parent ran: the chain of
    // AFTER nodes 2..=15 each burn after the previous one.
    t.fund_tokens(1_000);
    for i in 2..=15u8 {
        let sent = t.run(&h, i, &Extra::None).expect_ok("burn chain");
        if i == 15 {
            println!(
                "run BURN (81-node condition, 16-node graph): {} CU, {} bytes",
                sent.cu, sent.size
            );
        }
    }
}

#[test]
fn ref_price_conditions_read_the_reference_not_spot() {
    let mut t = ap_world(true);
    let reference = t.state().ref_sqrt_price;
    // Burn while the reference price is at least 4% (sqrt 2%) above where
    // it started.
    let target = reference * 102 / 100;
    assert!(target <= u128::from(u64::MAX));
    let mut n = gnode(WHEN, 0, BURN, 1, 0);
    n.cond_len = 1;
    let mut p = graph(vec![n]);
    p.cond = vec![leaf(op::graph::PRICE_GTE, 0, target as u64)];
    t.fund_tokens(100);
    let h = t.activate_now(&p);
    // Spot jumps well past it: the condition still reads the reference.
    t.carol_buys(SOL);
    assert!(t.pool_sqrt_price() > target);
    refused(
        t.run(&h, 0, &Extra::None),
        E::ConditionFalse,
        "spot is not the reference",
    );
    // One observation alone moves nothing; a minute of them does.
    t.observe().expect_ok("update_price");
    assert_eq!(t.state().ref_sqrt_price, reference);
    refused(
        t.run(&h, 0, &Extra::None),
        E::ConditionFalse,
        "one observation",
    );
    t.observe_and_wait();
    t.observe().expect_ok("update_price, a minute later");
    assert!(t.state().ref_sqrt_price >= target);
    t.run(&h, 0, &Extra::None).expect_ok("the reference moved");
}

//! Treasury invariants on the real programs (spec §4 "Invariants"), over
//! seeded random histories: time passing, fee inflows, trades on the pool
//! (pumps and dumps), price observations, runs of every node by keepers
//! (choosing buyback amounts or not), the operator and impostors (with
//! right and wrong accounts and amounts), and a timelocked graph
//! replacement. After every transaction:
//!
//! * value left the treasury only to the allowed sinks: the canonical
//!   pool's wSOL vault in a buyback whose tokens were all burned in the same
//!   instruction, the graph's recipients, the caller's tip account, and
//!   burns; to the lamport and the token unit, and nowhere else;
//! * the treasury never sold the token (the pool's token vault only ever
//!   loses tokens to a buyback) and never lost an account;
//! * a failed transaction changed nothing;
//! * per node and epoch, runs and spend stay within the graph's bounds (a
//!   keeper's partial buyback is no run, and a run with its partial parts
//!   moves at most `p1`: audit 4, A4-2), and tips within a tenth of what
//!   the run moved (a partial buyback: its share of a tip) and their daily
//!   cap;
//! * a buyback paid at most its price bound plus the premium: it got at
//!   least the minimum out priced at the lower of the reference and every
//!   price observed in the window.
//!
//! At the end: the launch account, the hook policy, the mint's authorities
//! and the locked LP position are exactly as before.

#[path = "../../../../noised-launchpad/tests/litesvm/tests/common/mod.rs"]
mod common;

mod ap;

use std::collections::{BTreeMap, HashMap};

use anchor_lang::prelude::Pubkey;
use anchor_spl::token_interface::spl_token_2022::{extension::StateWithExtensions, state::Mint};
use ap::*;
use common::{
    events,
    launch::{base_ata, create_ata, wsol_ata},
    lifecycle::Damm,
    vault::open_vault,
    Expect, LAMPORTS_PER_SOL, TOKEN_PROGRAM_ID,
};
use noised_autopilot::{constants::*, events::NodeRan};
use noised_rules::{
    current_epoch,
    graph::{action::*, trigger::*, FLAG_HAS_OPERATOR},
    op, GNode, Graph, GraphProgram, Node, NodeState, Recipient,
};
use solana_keypair::Keypair;
use solana_signer::Signer;

const SOL: u64 = LAMPORTS_PER_SOL;

struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        let x = self.0;
        (x ^ (x >> 29)).wrapping_mul(0xBF58_476D_1CE4_E5B9) ^ (x >> 32)
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
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
        budget_per_epoch: p1 * 4,
        p1,
        p2,
        max_runs_per_epoch: 4,
        reserved: [0; 5],
    }
}

/// The graph of the history: every action, a gated node, a condition.
fn first_graph(recipients: [Pubkey; 2], operator: Pubkey) -> GraphProgram {
    let mut buyback = gnode(EVERY, 600, BUYBACK_BURN, SOL / 5, 1_000);
    buyback.epoch_secs = 7_200;
    let burn_after = gnode(AFTER, 0, BURN, u64::MAX / 4, 0);
    let mut dist = gnode(EVERY, 3_600, DISTRIBUTE_SOL, SOL / 2, 0);
    dist.budget_per_epoch = SOL;
    let mut gated = gnode(WHEN, 0, BUYBACK_BURN, 3 * SOL / 10, 1_500);
    gated.operator_gated = 1;
    gated.cond_len = 1;
    gated.max_runs_per_epoch = 3;
    let mut burn = gnode(EVERY, 600, BURN, 1_000_000, 0);
    burn.max_runs_per_epoch = 3;
    burn.epoch_secs = 3_600;
    GraphProgram {
        flags: FLAG_HAS_OPERATOR,
        operator: operator.to_bytes(),
        recipients: vec![
            Recipient {
                key: recipients[0].to_bytes(),
                bps: 5_000,
            },
            Recipient {
                key: recipients[1].to_bytes(),
                bps: 5_000,
            },
        ],
        nodes: vec![buyback, burn_after, dist, gated, burn],
        cond: vec![Node {
            op: op::graph::TREASURY_SOL_GTE,
            a: 0,
            arg: 3 * SOL,
        }],
    }
}

/// The replacement: other bounds, no operator, one recipient.
fn second_graph(recipient: Pubkey) -> GraphProgram {
    let mut buyback = gnode(EVERY, 1_200, BUYBACK_BURN, SOL / 8, 700);
    buyback.max_runs_per_epoch = 6;
    GraphProgram {
        flags: 0,
        operator: [0; 32],
        recipients: vec![Recipient {
            key: recipient.to_bytes(),
            bps: 10_000,
        }],
        nodes: vec![
            buyback,
            gnode(EVERY, 600, DISTRIBUTE_SOL, SOL / 4, 0),
            gnode(EVERY, 600, BURN, 2_000_000, 0),
        ],
        cond: vec![],
    }
}

/// Every balance the history can touch.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Snapshot {
    tokens: BTreeMap<Pubkey, u64>,
    supply: u64,
    autopilot: Vec<u8>,
}

fn snapshot(t: &ApWorld, watched: &[Pubkey]) -> Snapshot {
    Snapshot {
        tokens: watched
            .iter()
            .map(|k| (*k, t.w.env.token_amount(k)))
            .collect(),
        supply: supply(&t.w.env, &t.k.mint),
        autopilot: t.w.env.account(&t.a.autopilot).unwrap().data,
    }
}

fn delta(before: &Snapshot, after: &Snapshot, k: &Pubkey) -> i128 {
    after.tokens[k] as i128 - before.tokens[k] as i128
}

/// The autopilot as the snapshot holds it.
fn autopilot_before(before: &Snapshot) -> noised_autopilot::state::Autopilot {
    anchor_lang::AccountDeserialize::try_deserialize(&mut before.autopilot.as_slice()).unwrap()
}

#[test]
fn treasury_value_leaves_only_to_allowed_sinks() {
    // Successful runs of each action, and of the operator's gated node.
    let mut by_action: HashMap<u8, u32> = HashMap::new();
    let mut gated = 0;
    for seed in 1u64..=6 {
        let (actions, g) = history(seed);
        for (a, n) in actions {
            *by_action.entry(a).or_default() += n;
        }
        gated += g;
    }
    println!("runs by action: {by_action:?}, gated: {gated}");
    for a in [BUYBACK_BURN, BURN, DISTRIBUTE_SOL] {
        assert!(
            by_action.get(&a).copied().unwrap_or(0) >= 10,
            "action {a}: {by_action:?}"
        );
    }
    assert!(gated >= 3, "gated runs: {gated}");
}

fn history(seed: u64) -> (HashMap<u8, u32>, u32) {
    let mut rng = Lcg(seed);
    let mut t = ap_world(true);
    let payer = t.w.env.payer.insecure_clone();
    let alice = Keypair::new().pubkey();
    let vault = open_vault(t.env(), &payer, &WSOL_MINT, &TOKEN_PROGRAM_ID, "invariants");
    let operator = t.w.env.funded(5);
    let impostor = t.w.env.funded(5);
    for owner in [alice, operator.pubkey(), impostor.pubkey()] {
        t.send(
            &[create_ata(
                &payer.pubkey(),
                &owner,
                &WSOL_MINT,
                &TOKEN_PROGRAM_ID,
            )],
            &[],
        )
        .expect_ok("wSOL account");
    }
    let recipients = [alice, vault.address];
    let recipient_atas = [wsol_ata(&alice), vault.token_account];
    let launch_before = t.w.env.account(&t.k.launch).unwrap().data;
    let policy_before = t.w.env.account(&t.k.policy).unwrap().data;
    let position_before =
        t.w.env
            .account(&Damm::position(&t.positions[0]))
            .unwrap()
            .data;

    let g1 = first_graph(recipients, operator.pubkey());
    let g2 = second_graph(vault.address);
    let (b2, h2) = compile(&g2);
    let h1 = t.activate_now(&g1);
    let a = t.a;
    t.send(&[publish_graph(&payer.pubkey(), &a, &b2)], &[])
        .expect_ok("publish g2");
    t.fund_sol(4 * SOL);
    let carol_tokens =
        t.w.env
            .token_amount(&base_ata(&t.carol.pubkey(), &t.k.mint));
    t.fund_tokens(carol_tokens / 50);

    let carol = t.carol.pubkey();
    let watched: Vec<Pubkey> = vec![
        a.treasury_wsol,
        a.treasury_token,
        t.d.token_a_vault,
        t.d.token_b_vault,
        recipient_atas[0],
        recipient_atas[1],
        t.keeper_tip(),
        wsol_ata(&operator.pubkey()),
        wsol_ata(&impostor.pubkey()),
        wsol_ata(&carol),
        base_ata(&carol, &t.k.mint),
        wsol_ata(&t.fee_recipient),
    ];

    let (mut active, mut graph_bytes) = (h1, g1.encode().unwrap());
    let mut queued: Option<(i64, [u8; 32])> = None;
    let mut done: HashMap<([u8; 32], usize, i64), (u16, u64)> = HashMap::new();
    let mut tips_by_day: HashMap<i64, u64> = HashMap::new();
    let (mut runs, mut refusals) = (0u32, 0u32);
    let mut by_action: HashMap<u8, u32> = HashMap::new();
    let mut gated_runs = 0u32;
    let mut keeper_amounts = 0u32;
    let mut partials = 0u32;

    for step in 0..240 {
        let now = t.now();
        t.env()
            .set_time(now + [0, 1, 300, 600, 1_800, 3_600, 7_200][rng.below(7) as usize]);
        // The world moves.
        match rng.below(8) {
            0 => t.fund_sol(rng.below(2 * SOL)),
            1 => {
                let have = t.w.env.token_amount(&base_ata(&carol, &t.k.mint));
                if have > 1_000 {
                    t.fund_tokens(1 + rng.below(have / 200));
                }
            }
            2 => t.carol_buys(1 + rng.below(SOL / 2)),
            3 => {
                let have = t.w.env.token_amount(&base_ata(&carol, &t.k.mint));
                if have > 1_000 {
                    t.carol_sells(1 + rng.below(have / 20));
                }
            }
            4 | 5 => {
                let pool = t.d.pool;
                let _ = t.send(&[update_price(&a, &pool)], &[]);
            }
            _ => {}
        }
        // Halfway: the identity queues the replacement (72 h timelock).
        if step == 100 {
            let at = t.now() + UPDATE_TIMELOCK_SECS;
            let floor = t.state().auth_marks[0].slot;
            let auth = activation_auth(t.env(), &a, &h2, at, Some(floor + 1));
            t.send(&[activate(&a, &h2, &auth, at)], &[])
                .expect_ok("queue g2");
            queued = Some((at, h2));
        }
        if let Some((at, h)) = queued {
            if t.now() >= at {
                t.send(&[apply_pending(&a, &h)], &[]).expect_ok("apply g2");
                active = h;
                graph_bytes = b2.clone();
                queued = None;
            }
        }

        // A run attempt.
        let g = Graph::parse(&graph_bytes).unwrap();
        let node = rng.below(g.node_count() as u64 + 1) as u8;
        let who = rng.below(3);
        let signer =
            [&t.keeper.insecure_clone(), &operator, &impostor][who as usize].insecure_clone();
        let as_operator = who != 0 && rng.below(4) != 0;
        let action = g.node(usize::from(node)).map(|n| n.action);
        let amount = if as_operator {
            (rng.below(5) != 0).then(|| 1 + rng.below(SOL / 2))
        } else if action == Some(BUYBACK_BURN) {
            // A keeper sometimes sizes a buyback itself (any amount: below
            // the floor, within it, above the cap).
            (rng.below(3) == 0).then(|| 1 + rng.below(SOL / 4))
        } else {
            (rng.below(20) == 0).then(|| 1 + rng.below(SOL))
        };
        // Before a buyback a keeper usually observes the pool and waits a
        // minute (as the SDK keeper does); sometimes it does not.
        if action == Some(BUYBACK_BURN) && rng.below(4) != 0 {
            let pool = t.d.pool;
            let _ = t.send(&[update_price(&a, &pool)], &[]);
            let now = t.now();
            t.env().set_time(now + OBS_MIN_SPAN_SECS);
        }
        let extra = match action {
            Some(BUYBACK_BURN) if rng.below(10) != 0 => t.buyback(),
            Some(DISTRIBUTE_SOL) if rng.below(10) != 0 => Extra::Distribute(
                (0..g.recipient_count())
                    .map(|i| wsol_ata(&Pubkey::new_from_array(g.recipient(i).unwrap().key)))
                    .collect(),
            ),
            // Sometimes the wrong accounts for the action.
            _ => [
                Extra::None,
                t.buyback(),
                Extra::Distribute(recipient_atas.to_vec()),
            ][rng.below(3) as usize]
                .clone(),
        };
        let mut named = run_accounts(
            &a,
            &signer.pubkey(),
            as_operator.then(|| signer.pubkey()),
            &active,
            Some(t.d.pool),
            &wsol_ata(&signer.pubkey()),
        );
        if rng.below(15) == 0 {
            named.tip_account = a.treasury_wsol;
        }
        let tip_account = named.tip_account;
        let open = t
            .state()
            .partial_spent
            .get(usize::from(node))
            .copied()
            .unwrap_or(0);
        let before = snapshot(&t, &watched);
        let result = t.send(&[run_ix(named, node, amount, &extra)], &[&signer]);
        let after = snapshot(&t, &watched);
        let sent = match result {
            Err(_) => {
                refusals += 1;
                assert_eq!(
                    before, after,
                    "a refused run changed something (step {step})"
                );
                continue;
            }
            Ok(s) => s,
        };
        runs += 1;
        let ev = events::<NodeRan>(&sent.logs).pop().unwrap();
        let gn = g.node(usize::from(node)).unwrap();
        assert_eq!(ev.action, gn.action);
        let d_sol = delta(&before, &after, &a.treasury_wsol);
        let d_tok = delta(&before, &after, &a.treasury_token);
        let d_vault_b = delta(&before, &after, &t.d.token_b_vault);
        let d_vault_a = delta(&before, &after, &t.d.token_a_vault);
        let d_supply = after.supply as i128 - before.supply as i128;
        let tip = ev.tip as i128;
        // The tip is at most a tenth of what the run moved (burns at most
        // at the reference price, distributions what they paid).
        let value = match gn.action {
            BURN => noised_autopilot::price::token_value(ev.spent, ev.ref_sqrt_price),
            DISTRIBUTE_SOL => ev.spent - ev.kept,
            _ => ev.spent,
        };
        assert!(
            u128::from(ev.tip) * 10 <= u128::from(value),
            "tip {} for {value}",
            ev.tip
        );
        let to_recipients: i128 = recipient_atas
            .iter()
            .map(|k| delta(&before, &after, k))
            .sum();
        // The tip went to the named tip account (a keeper's, or the
        // treasury itself, which then keeps it).
        let tip_seen = if tip_account == a.treasury_wsol {
            0
        } else {
            delta(&before, &after, &tip_account)
        };
        match gn.action {
            BUYBACK_BURN => {
                // Priced at the bound: at least the minimum out at the
                // lower of the reference and the window's lowest price,
                // which the run observed and kept.
                let st = t.state();
                let window_min = st
                    .observations
                    .iter()
                    .filter(|b| !b.is_empty() && b.index >= st.observations[0].index - 1)
                    .map(|b| b.min)
                    .min()
                    .unwrap();
                let bound = window_min.min(ev.ref_sqrt_price);
                let floor = noised_autopilot::price::min_out(ev.spent, bound, gn.p2).unwrap();
                assert!(ev.bought >= floor, "bought {} < {floor}", ev.bought);
                if !as_operator {
                    if let Some(a) = amount {
                        assert_eq!(ev.spent, a, "the keeper's amount");
                        keeper_amounts += 1;
                    }
                }
                assert_eq!(d_vault_b, ev.spent as i128, "lamports in = spent");
                assert_eq!(d_vault_a, -(ev.bought as i128), "tokens out = bought");
                assert_eq!(ev.bought, ev.burned);
                assert_eq!(d_tok, 0, "nothing bought stays");
                assert_eq!(
                    d_supply,
                    -(ev.bought as i128),
                    "everything bought is burned"
                );
                assert_eq!(to_recipients, 0);
            }
            BURN => {
                assert_eq!(d_tok, -(ev.spent as i128));
                assert_eq!(d_supply, -(ev.spent as i128));
                assert_eq!((d_vault_a, d_vault_b, to_recipients), (0, 0, 0));
            }
            DISTRIBUTE_SOL => {
                assert_eq!(to_recipients, (ev.spent - ev.kept) as i128);
                assert_eq!((d_vault_a, d_vault_b, d_tok, d_supply), (0, 0, 0, 0));
            }
            _ => unreachable!(),
        }
        // Conservation: every lamport that left went to a sink.
        let swapped = if gn.action == BUYBACK_BURN {
            d_vault_b
        } else {
            0
        };
        let tip_out = if tip_account == a.treasury_wsol {
            0
        } else {
            tip
        };
        assert_eq!(
            -d_sol,
            swapped + to_recipients + tip_out,
            "treasury wSOL (step {step})"
        );
        assert_eq!(tip_seen, tip_out, "the tip landed in the tip account");
        // Nobody else gained or lost anything.
        for k in &watched {
            let sink = *k == a.treasury_wsol
                || *k == a.treasury_token
                || *k == t.d.token_a_vault
                || *k == t.d.token_b_vault
                || recipient_atas.contains(k)
                || *k == tip_account;
            if !sink {
                assert_eq!(delta(&before, &after, k), 0, "{k} changed (step {step})");
            }
        }
        assert!(ev.tip <= TIP_LAMPORTS);
        let day = t.now() - t.now() % 86_400;
        *tips_by_day.entry(day).or_default() += ev.tip;
        // Bounds: per run, per epoch.
        assert!(ev.spent > 0 && ev.spent <= gn.p1);
        let st = t.state();
        let rec = st.nodes[usize::from(node)];
        let epoch = current_epoch(
            gn.epoch_secs,
            &NodeState {
                last_run: rec.last_run,
                last_seq: rec.last_seq,
                epoch_start: rec.epoch_start,
                runs_in_epoch: rec.runs_in_epoch,
                spent_in_epoch: rec.spent_in_epoch,
            },
            t.now(),
        );
        let e = done
            .entry((active, usize::from(node), epoch.start))
            .or_default();
        // A partial buyback: a keeper's chosen amount, no run, at most its
        // share of a tip; a run with its partial parts moves at most p1.
        assert!(open + ev.spent <= gn.p1);
        if ev.partial {
            assert!(gn.action == BUYBACK_BURN && gn.operator_gated == 0 && amount.is_some());
            assert!(
                u128::from(ev.tip) * u128::from(gn.p1)
                    <= u128::from(TIP_LAMPORTS) * u128::from(ev.spent)
            );
            assert_eq!(st.partial_spent[usize::from(node)], open + ev.spent);
            assert_eq!(
                rec.last_seq,
                autopilot_before(&before).nodes[usize::from(node)].last_seq
            );
            partials += 1;
        } else {
            assert_eq!(st.partial_spent[usize::from(node)], 0);
            assert_eq!(rec.last_run, t.now());
            e.0 += 1;
        }
        e.1 += ev.spent;
        assert!(e.0 <= gn.max_runs_per_epoch && e.1 <= gn.budget_per_epoch);
        if gn.operator_gated == 1 {
            assert_eq!(signer.pubkey(), operator.pubkey());
            gated_runs += 1;
        }
        *by_action.entry(gn.action).or_default() += 1;
    }
    assert!(tips_by_day.values().all(|v| *v <= TIP_EPOCH_CAP));
    println!(
        "seed {seed}: {runs} runs, {refusals} refusals, {keeper_amounts} keeper-sized buybacks ({partials} partial)"
    );
    assert!(runs >= 15, "seed {seed}: too few runs ({runs})");
    assert!(refusals >= 30, "seed {seed}: too few refusals ({refusals})");

    // Nothing else changed: launch, hook policy, LP position, mint
    // authorities.
    assert_eq!(t.w.env.account(&t.k.launch).unwrap().data, launch_before);
    assert_eq!(t.w.env.account(&t.k.policy).unwrap().data, policy_before);
    assert_eq!(
        t.w.env
            .account(&Damm::position(&t.positions[0]))
            .unwrap()
            .data,
        position_before
    );
    let mint = t.w.env.account(&t.k.mint).unwrap();
    let mint = StateWithExtensions::<Mint>::unpack(&mint.data).unwrap();
    assert!(mint.base.mint_authority.is_none() && mint.base.freeze_authority.is_none());
    // The treasury's accounts still exist, owned by the treasury.
    assert_eq!(t.w.env.token_owner(&a.treasury_wsol), a.treasury);
    assert_eq!(t.w.env.token_owner(&a.treasury_token), a.treasury);
    (by_action, gated_runs)
}

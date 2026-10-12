//! Treasury invariants over random graphs and random histories, on the
//! program's own decision code (`logic`) with a model of the accounts and
//! the pool. The LiteSVM suite checks the same invariants against the real
//! programs; this one explores far more histories.
//!
//! After every attempted run, whatever the graph, the timing, the caller
//! and the operator's choices:
//!
//! 1. value leaves the treasury only as planned: wSOL to the pool (a buyback
//!    whose tokens are all burned), wSOL to the graph's recipients, wSOL
//!    tips, and burned tokens; the treasury's token balance never drops
//!    except by a burn, and never grows from a buyback;
//! 2. a node never moves more than `p1` per run, more than its budget per
//!    epoch, or more often than `max_runs_per_epoch` per epoch; a keeper's
//!    partial buyback (audit 4, A4-2) is no run, and a run with its partial
//!    parts never moves more than `p1`;
//! 3. tips are at most `TIP_LAMPORTS` per run (a partial buyback: its share
//!    of it), a tenth of what the run moved (burns valued at nothing before
//!    graduation, then at the lower of the reference and the lowest price
//!    observed in the window: audit 4, A4-4), and `TIP_EPOCH_CAP` per day;
//! 4. a refused run changes nothing;
//! 5. a gated node only ever runs for the operator; a non-gated node takes
//!    an amount only for a buyback, and then at least the keeper's floor;
//! 6. a buyback is never priced above the reference nor above any price
//!    observed in the current or previous bucket (observations come from
//!    anyone, at any price, and from every run), and never runs on
//!    observations younger than a minute.

use std::collections::HashMap;

use noised_rules::{
    graph::{action::*, current_epoch, trigger::*, NodeState},
    op, Graph, Node,
};

use super::*;
use crate::{
    constants::*,
    logic::{self, Plan, RunInput},
    price,
    reference::{self, PriceState},
    state::{NodeRecord, MAX_NODES},
};

const OPERATOR: u8 = 0xEE;

/// A random valid graph of 1..=6 nodes.
fn random_graph(rng: &mut Lcg) -> Vec<u8> {
    loop {
        let n = 1 + rng.below(6) as usize;
        let mut nodes = Vec::new();
        let mut cond = Vec::new();
        let mut gated_any = false;
        for i in 0..n {
            let act = [BUYBACK_BURN, BURN, DISTRIBUTE_SOL][rng.below(3) as usize];
            let p1 = 1 + rng.bits128(40) as u64;
            let mut node = gnode(EVERY, 600, act, p1, 0);
            node.trigger = match rng.below(4) {
                0 => EVERY,
                1 if i > 0 => AFTER,
                2 => ON_GRADUATED,
                _ => WHEN,
            };
            node.trigger_arg = match node.trigger {
                EVERY => 600 + rng.below(3) * 1_800,
                AFTER => rng.below(i as u64),
                _ => 0,
            };
            if act == BUYBACK_BURN {
                node.p2 = rng.below(2_001);
            }
            node.epoch_secs = [3_600, 7_200, 86_400][rng.below(3) as usize];
            node.max_runs_per_epoch = 1 + rng.below(4) as u16;
            node.budget_per_epoch = p1.saturating_mul(1 + rng.below(4)) - rng.below(2).min(p1 - 1);
            node.operator_gated = u8::from(rng.below(4) == 0);
            gated_any |= node.operator_gated == 1;
            if node.trigger == WHEN || rng.below(3) == 0 {
                node.cond_off = cond.len() as u8;
                node.cond_len = 1;
                cond.push(match rng.below(3) {
                    0 => Node {
                        op: op::graph::TREASURY_SOL_GTE,
                        a: 0,
                        arg: rng.bits128(36) as u64,
                    },
                    1 => Node {
                        op: op::graph::GRADUATED,
                        a: 0,
                        arg: 0,
                    },
                    _ => Node {
                        op: op::graph::RUNS_IN_EPOCH_LT,
                        a: rng.below(n as u64) as u8,
                        arg: rng.below(4),
                    },
                });
            }
            nodes.push(node);
        }
        let p = program(nodes, cond, gated_any.then(|| key(OPERATOR)));
        let bytes = p.encode().unwrap();
        if Graph::verify(&bytes).is_ok() {
            return bytes;
        }
    }
}

/// The model: balances, the pool, node states and what left the treasury.
struct World {
    sol: u64,
    tokens: u64,
    supply: u64,
    pool_sqrt: u128,
    /// The pool's wSOL.
    pool_quote: u64,
    graduated: bool,
    price: PriceState,
    /// Every observation made: (time, sqrt price).
    log: Vec<(i64, u128)>,
    nodes: [NodeRecord; MAX_NODES],
    /// What partial buybacks moved of each node's open run.
    partial: [u64; MAX_NODES],
    seq: u64,
    tip_start: i64,
    tips_in_day: u64,
    operator: Pubkey,
    /// Lamports each sink received.
    to_pool: u64,
    to_recipients: HashMap<[u8; 32], u64>,
    to_tips: u64,
    burned: u64,
}

#[test]
fn treasury_outflows_only_to_allowed_sinks() {
    let mut rng = Lcg(0xA11CE);
    let mut runs = 0u64;
    let (mut buybacks, mut keeper_amounts, mut partials) = (0u64, 0u64, 0u64);
    let mut refusals: HashMap<u32, u64> = HashMap::new();
    for _graph in 0..300 {
        let bytes = random_graph(&mut rng);
        let g = Graph::verify(&bytes).unwrap();
        let mut w = World {
            sol: rng.bits128(40) as u64,
            tokens: rng.bits128(40) as u64,
            supply: u64::MAX,
            pool_sqrt: 1u128 << 60,
            pool_quote: rng.bits128(40) as u64,
            graduated: rng.below(2) == 0,
            price: PriceState {
                reference: 1u128 << 60,
                ..PriceState::default()
            },
            log: Vec::new(),
            nodes: [NodeRecord::default(); MAX_NODES],
            partial: [0; MAX_NODES],
            seq: 0,
            tip_start: 0,
            tips_in_day: 0,
            operator: g
                .operator()
                .map_or(Pubkey::default(), |k| Pubkey::new_from_array(*k)),
            to_pool: 0,
            to_recipients: HashMap::new(),
            to_tips: 0,
            burned: 0,
        };
        let mut now = 1_800_000_000i64;
        // Per node, per epoch start: (runs, spent) actually done.
        let mut done: HashMap<(usize, i64), (u16, u64)> = HashMap::new();
        let mut tips_by_day: HashMap<i64, u64> = HashMap::new();
        for _step in 0..120 {
            now += [0, 1, 599, 600, 3_600, 86_400][rng.below(6) as usize];
            match rng.below(10) {
                0 => w.sol = w.sol.saturating_add(rng.bits128(36) as u64),
                1 => w.tokens = w.tokens.saturating_add(rng.bits128(30) as u64),
                2 => {
                    // Anyone moves the pool price (within DAMM's range).
                    let f = 9_000 + rng.below(2_200) as u128;
                    w.pool_sqrt = (w.pool_sqrt * f / 10_000).clamp(1u128 << 40, 1u128 << 80);
                }
                3 => w.graduated = true,
                4 | 5 if w.graduated => {
                    // Anyone observes (`update_price`), at the pool's price
                    // or one it moved for the length of its transaction.
                    let seen = if rng.below(2) == 0 {
                        w.pool_sqrt
                    } else {
                        w.pool_sqrt * (1 + rng.below(3) as u128)
                    };
                    reference::observe(&mut w.price.observations, now, seen);
                    w.log.push((now, seen));
                    let s = reference::seen(&w.price.observations, now);
                    reference::follow(&mut w.price, s, now);
                }
                6 => w.pool_quote = rng.bits128(40) as u64,
                _ => {}
            }
            let index = rng.below(g.node_count() as u64 + 1) as usize;
            let caller_is_operator = rng.below(2) == 0;
            let amount = (rng.below(2) == 0).then(|| rng.bits128(42) as u64);
            let states = w.nodes.map(NodeState::from);
            let before = (
                w.sol,
                w.tokens,
                w.nodes,
                w.partial,
                w.seq,
                w.price,
                w.tips_in_day,
                w.log.len(),
            );
            // The run observes the pool and moves the reference first
            // (kept only if the run succeeds).
            let mut price_after = w.price;
            if w.graduated {
                reference::observe(&mut price_after.observations, now, w.pool_sqrt);
            }
            let seen = reference::seen(&price_after.observations, now);
            reference::follow(&mut price_after, seen, now);
            let open = w.partial.get(index).copied().unwrap_or(0);
            let plan = logic::plan_run(&RunInput {
                graph: &g,
                node: index,
                now,
                states: &states,
                operator: w.operator,
                operator_signer: caller_is_operator.then_some(key(OPERATOR)),
                amount,
                treasury_sol: w.sol,
                treasury_token: w.tokens,
                graduated: w.graduated,
                spot: w.graduated.then_some(w.pool_sqrt),
                reference: price_after.reference,
                seen,
                pool_quote: w.graduated.then_some(w.pool_quote),
                partial_spent: open,
            });
            let plan = match plan {
                Err(e) => {
                    *refusals.entry(code::<()>(Err(e))).or_default() += 1;
                    // 4. Nothing changed.
                    assert_eq!(
                        before,
                        (
                            w.sol,
                            w.tokens,
                            w.nodes,
                            w.partial,
                            w.seq,
                            w.price,
                            w.tips_in_day,
                            w.log.len()
                        )
                    );
                    continue;
                }
                Ok(p) => p,
            };
            let node = g.node(index).unwrap();
            // 5. Gating and amounts.
            if node.operator_gated == 1 {
                assert!(caller_is_operator && w.operator == key(OPERATOR));
                assert!(amount.is_some());
            } else if let Some(a) = amount {
                assert_eq!(node.action, BUYBACK_BURN);
                let cap = g.run_cap(index, &states[index], now).min(node.p1 - open);
                let limit = cap.min(w.sol);
                let floor = logic::keeper_floor(w.pool_quote);
                assert!(a >= floor.min(limit).max(1));
                // A partial amount leaves at least the floor for the rest.
                assert!(a == cap || cap - a >= floor);
                assert_eq!(plan.partial(), a < cap);
                keeper_amounts += 1;
            }
            // Only a keeper's chosen amount is partial.
            if plan.partial() {
                assert!(node.operator_gated == 0 && amount.is_some());
                partials += 1;
            }
            let spent = plan.spent();
            // 2. Per run, with what partial runs moved of it.
            assert!(spent > 0 && spent <= node.p1);
            assert!(open + spent <= node.p1, "a run moves at most p1 in all");
            if plan.partial() {
                assert!(open + spent < node.p1);
            }
            if let Some(a) = amount {
                if node.action != DISTRIBUTE_SOL {
                    assert_eq!(spent, a);
                }
            }
            match plan {
                Plan::Buyback {
                    amount_in, min_out, ..
                } => {
                    assert!(w.graduated);
                    // 6. The bound: the reference and every observation of
                    // the window, this run's included, cap it; younger than
                    // a minute, none.
                    let bucket = reference::bucket_of(now);
                    let this_run = (now, w.pool_sqrt);
                    let window: Vec<&(i64, u128)> = w
                        .log
                        .iter()
                        .chain(std::iter::once(&this_run))
                        .filter(|(t, _)| reference::bucket_of(*t) >= bucket - 1)
                        .collect();
                    let oldest = window.iter().map(|(t, _)| *t).min().unwrap();
                    assert!(
                        now - oldest >= OBS_MIN_SPAN_SECS,
                        "observed {oldest}, run {now}"
                    );
                    let lowest = window.iter().map(|(_, p)| *p).min().unwrap();
                    let bound = price_after.reference.min(lowest);
                    assert_eq!(
                        Some(bound),
                        reference::buyback_cap(price_after.reference, seen)
                    );
                    assert!(price::within_premium(w.pool_sqrt, bound, node.p2));
                    assert_eq!(Some(min_out), price::min_out(amount_in, bound, node.p2));
                    assert!(amount_in <= w.sol);
                    buybacks += 1;
                    // The pool (1% fee, no impact in this model).
                    let p = price::price_q64(w.pool_sqrt).unwrap();
                    let out = ((u128::from(amount_in) << 64) / p * 99 / 100) as u64;
                    if out < min_out || out == 0 {
                        // DAMM refuses: the transaction fails, nothing moves.
                        continue;
                    }
                    w.sol -= amount_in;
                    w.to_pool += amount_in;
                    // Bought and burned in the same instruction.
                    w.supply = w.supply.saturating_sub(out);
                    w.burned += out;
                }
                Plan::Burn { amount } => {
                    assert!(amount <= w.tokens);
                    w.tokens -= amount;
                    w.supply = w.supply.saturating_sub(amount);
                    w.burned += amount;
                }
                Plan::Distribute { shares, total } => {
                    assert!(total <= w.sol);
                    let mut sum = 0;
                    for (i, s) in shares.iter().enumerate() {
                        if i >= g.recipient_count() {
                            assert_eq!(*s, 0, "no share past the recipients");
                            continue;
                        }
                        let r = g.recipient(i).unwrap();
                        *w.to_recipients.entry(r.key).or_default() += s;
                        sum += s;
                    }
                    assert_eq!(sum, total);
                    w.sol -= total;
                }
            }
            if w.graduated {
                w.log.push((now, w.pool_sqrt));
            }
            w.price = price_after;
            let mut slot = w.nodes[index];
            let mut partial = w.partial[index];
            logic::record_run(
                &mut slot,
                &mut partial,
                &mut w.seq,
                node.epoch_secs,
                now,
                spent,
                plan.partial(),
            )
            .unwrap();
            if plan.partial() {
                assert_eq!(partial, open + spent);
                assert_eq!(
                    (slot.last_run, slot.last_seq),
                    (w.nodes[index].last_run, w.nodes[index].last_seq)
                );
            } else {
                assert_eq!((partial, slot.last_run), (0, now));
            }
            w.nodes[index] = slot;
            w.partial[index] = partial;
            // Burns: nothing before graduation, then the lower of the
            // reference and the lowest price observed in the window (this
            // run's observation in the log now).
            let bucket = reference::bucket_of(now);
            let lowest = w
                .log
                .iter()
                .filter(|(t, _)| reference::bucket_of(*t) >= bucket - 1)
                .map(|(_, p)| *p)
                .min();
            let burn_price = if w.graduated {
                lowest.map_or(w.price.reference, |l| l.min(w.price.reference))
            } else {
                0
            };
            assert_eq!(
                burn_price,
                logic::burn_price(
                    w.graduated,
                    w.price.reference,
                    reference::lowest(&w.price.observations, now)
                )
            );
            let value = plan.value(burn_price, 0);
            let max_tip = plan.max_tip(node.p1);
            let tip = logic::take_tip(
                &mut w.tip_start,
                &mut w.tips_in_day,
                now,
                w.sol,
                value,
                max_tip,
            );
            // 3. Per run.
            assert!(tip <= TIP_LAMPORTS && tip <= w.sol && tip <= max_tip);
            assert!(u128::from(tip) * 10 <= u128::from(value));
            if plan.partial() {
                assert!(
                    u128::from(tip) * u128::from(node.p1)
                        <= u128::from(TIP_LAMPORTS) * u128::from(spent)
                );
            }
            w.sol -= tip;
            w.to_tips += tip;
            *tips_by_day
                .entry(now - now.rem_euclid(TIP_EPOCH_SECS))
                .or_default() += tip;
            runs += 1;
            // 2. Per epoch, counted independently of the program's counters.
            let epoch = current_epoch(node.epoch_secs, &NodeState::from(slot), now);
            let e = done.entry((index, epoch.start)).or_default();
            if !plan.partial() {
                e.0 += 1;
            }
            e.1 += spent;
            assert!(e.0 <= node.max_runs_per_epoch, "runs per epoch");
            assert!(e.1 <= node.budget_per_epoch, "budget per epoch");
            assert_eq!((epoch.runs, epoch.spent), *e);
        }
        // 1. Every lamport and token that left is accounted for by a sink.
        // 3. Tips per day.
        assert!(tips_by_day.values().all(|t| *t <= TIP_EPOCH_CAP));
        let recipients: Vec<[u8; 32]> = (0..g.recipient_count())
            .map(|i| g.recipient(i).unwrap().key)
            .collect();
        assert!(w.to_recipients.keys().all(|k| recipients.contains(k)));
    }
    assert!(runs > 2_000, "too few runs exercised: {runs}");
    assert!(
        buybacks > 100 && keeper_amounts > 20 && partials > 10,
        "{buybacks} buybacks, {keeper_amounts} keeper amounts, {partials} partial"
    );
    // Every kind of refusal was exercised.
    use AutopilotError as E;
    for e in [
        E::NoSuchNode,
        E::NodeNotDue,
        E::NotGraduated,
        E::MaxRunsReached,
        E::BudgetSpent,
        E::ConditionFalse,
        E::WrongOperator,
        E::AmountNotAllowed,
        E::InvalidAmount,
        E::NothingToDo,
        E::PremiumExceeded,
        E::PriceNotObserved,
        E::AmountTooSmall,
        E::RemainderTooSmall,
    ] {
        assert!(
            refusals.get(&num(e)).copied().unwrap_or(0) > 0,
            "never refused with {e:?}: {refusals:?}"
        );
    }
}

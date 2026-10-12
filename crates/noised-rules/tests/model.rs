//! A model of the Launch Guard hook with launch rules (spec section 1.2):
//! the existing decision (noised-hook `rules::evaluate`) with the rule set
//! evaluated last, after every structural allow and every built-in denial.
//!
//! Properties, over random verified rule sets, policies and transfers:
//! * rules only add restrictions: allowed with rules => allowed without;
//! * every built-in refusal is unchanged by rules;
//! * sells, claims (exempt owners), zero amounts, the batch and everything
//!   at or after the guard end are decided without evaluating the rules;
//! * after the guard end the decision is identical to no rules.

mod common;

use std::cell::Cell;

use common::*;
use noised_rules::{RuleSet, TransferCtx, Violation};

#[derive(Clone, Debug)]
struct Policy {
    base_vault: [u8; 32],
    shield_end: i64,
    guard_end: i64,
    max_buy: u64,
    max_wallet: u64,
    p2p_locked: bool,
    exempt: Vec<[u8; 32]>,
    supply: u64,
}

#[derive(Clone, Copy, Debug)]
struct Transfer {
    now_rel: i64,
    amount: u64,
    source: [u8; 32],
    source_owner: [u8; 32],
    destination: [u8; 32],
    destination_owner: [u8; 32],
    destination_balance: u64,
    in_batch: bool,
    top_program: [u8; 32],
    tx_ix_count: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Decision {
    Allow,
    SnipeShield,
    TransfersLocked,
    MaxBuy,
    MaxWallet,
    Rule(Violation),
}

/// The hook with `rules` (if any) evaluated last; `calls` counts rule
/// evaluations.
fn hook(p: &Policy, rules: Option<&RuleSet<'_>>, t: &Transfer, calls: &Cell<u32>) -> Decision {
    let is_buy = t.source == p.base_vault;
    // Sells are decided from keys alone.
    if t.destination == p.base_vault && !is_buy {
        return Decision::Allow;
    }
    if t.now_rel >= p.guard_end {
        return Decision::Allow;
    }
    if is_buy && t.now_rel < p.shield_end && !t.in_batch {
        return Decision::SnipeShield;
    }
    if t.amount == 0 {
        return Decision::Allow;
    }
    // Claims, escrow and other protocol accounts.
    if p.exempt.contains(&t.source_owner) || p.exempt.contains(&t.destination_owner) {
        return Decision::Allow;
    }
    if !is_buy && p.p2p_locked {
        return Decision::TransfersLocked;
    }
    if p.max_buy != 0 && t.amount > p.max_buy {
        return Decision::MaxBuy;
    }
    if p.max_wallet != 0 && t.destination_balance > p.max_wallet {
        return Decision::MaxWallet;
    }
    // The batch buy is never subject to launch rules.
    if t.in_batch {
        return Decision::Allow;
    }
    if let Some(set) = rules {
        calls.set(calls.get() + 1);
        let ctx = TransferCtx {
            now_rel: t.now_rel,
            is_buy,
            // Neither side is the pool (not a buy, not a sell) or the
            // protocol (exempt owners returned above).
            is_p2p: !is_buy,
            amount: t.amount,
            dest_balance_after: t.destination_balance,
            supply: p.supply,
            dest_owner: t.destination_owner,
            src_owner: t.source_owner,
            top_program: t.top_program,
            tx_ix_count: t.tx_ix_count,
        };
        if let Err(v) = set.evaluate(&ctx) {
            return Decision::Rule(v);
        }
    }
    Decision::Allow
}

fn gen_policy(rng: &mut Rng, guard: u32) -> Policy {
    Policy {
        base_vault: key(0xBA),
        shield_end: rng.below(120) as i64,
        guard_end: guard as i64,
        max_buy: if rng.coin() { 0 } else { rng.below(1 << 30) },
        max_wallet: if rng.coin() { 0 } else { rng.below(1 << 32) },
        p2p_locked: rng.one_in(3),
        exempt: vec![key(0xE1), key(0xE2)],
        supply: rng.pick(&[1_000_000_000, 1 << 50, 1_000_000_000_000_000_000]),
    }
}

fn gen_transfer(rng: &mut Rng, p: &Policy, rules: &noised_rules::RulesProgram) -> Transfer {
    let c = gen_ctx(rng, rules, p.guard_end as u32);
    let accounts = [p.base_vault, key(1), key(2), key(3)];
    let owners: Vec<[u8; 32]> = [key(0xE1), key(0xE2), key(7), key(8)]
        .into_iter()
        .chain(rules.keys.iter().copied())
        .collect();
    let source = rng.pick(&accounts);
    let destination = if rng.one_in(4) {
        p.base_vault
    } else {
        rng.pick(&accounts)
    };
    Transfer {
        now_rel: if rng.one_in(6) {
            p.guard_end + rng.pick(&[0i64, 1, 3_600, i64::MAX / 4])
        } else {
            c.now_rel
        },
        amount: if rng.one_in(8) { 0 } else { c.amount },
        source,
        source_owner: rng.pick(&owners),
        destination,
        destination_owner: rng.pick(&owners),
        destination_balance: c.dest_balance_after,
        in_batch: rng.one_in(6),
        top_program: c.top_program,
        tx_ix_count: c.tx_ix_count,
    }
}

#[test]
fn rules_only_add_restrictions_in_the_hook() {
    let mut rng = Rng::new(0x400C);
    let (mut sells, mut claims, mut late, mut batch, mut evaluated, mut rejected) =
        (0, 0, 0, 0, 0, 0);
    for _ in 0..3_000 {
        let guard = rng.pick(&[600, 3_600, 86_400, GUARD]);
        let program = gen_rules(&mut rng, guard);
        let bytes = enc(&program);
        let set = RuleSet::verify(&bytes, guard).unwrap();
        let policy = gen_policy(&mut rng, guard);
        for _ in 0..60 {
            let t = gen_transfer(&mut rng, &policy, &program);
            let (with_calls, without_calls) = (Cell::new(0), Cell::new(0));
            let with = hook(&policy, Some(&set), &t, &with_calls);
            let without = hook(&policy, None, &t, &without_calls);
            assert_eq!(without_calls.get(), 0);
            // Allowed with rules => allowed without.
            if with == Decision::Allow {
                assert_eq!(without, Decision::Allow, "{t:?}");
            }
            // A built-in refusal stays exactly the same.
            if without != Decision::Allow {
                assert_eq!(with, without, "{t:?}");
                assert_eq!(with_calls.get(), 0, "rules are evaluated last");
            }
            // The only difference rules make is a rule rejection.
            if with != without {
                assert!(matches!(with, Decision::Rule(_)), "{t:?}");
                rejected += 1;
            }
            let is_buy = t.source == policy.base_vault;
            let is_sell = t.destination == policy.base_vault && !is_buy;
            let is_claim = policy.exempt.contains(&t.source_owner)
                || policy.exempt.contains(&t.destination_owner);
            if is_sell {
                sells += 1;
                assert_eq!(with, Decision::Allow, "sells always pass");
                assert_eq!(with_calls.get(), 0, "rules never see a sell");
            }
            if t.now_rel >= policy.guard_end {
                late += 1;
                assert_eq!(with, Decision::Allow, "after the guard, as without rules");
                assert_eq!(with, without);
                assert_eq!(with_calls.get(), 0);
            }
            if is_claim
                && !is_sell
                && t.amount > 0
                && !(is_buy && t.now_rel < policy.shield_end && !t.in_batch)
            {
                claims += 1;
                assert_eq!(with, without);
                assert_eq!(with_calls.get(), 0, "rules never see a claim");
            }
            if t.in_batch {
                batch += 1;
                assert_eq!(with_calls.get(), 0, "rules never see the batch");
                assert_eq!(with, without);
            }
            if t.amount == 0 {
                assert_eq!(with_calls.get(), 0);
            }
            evaluated += with_calls.get();
        }
    }
    // Every path is exercised.
    for (what, n) in [
        ("sells", sells),
        ("claims", claims),
        ("late", late),
        ("batch", batch),
        ("evaluated", evaluated),
        ("rejected", rejected),
    ] {
        assert!(n > 1_000, "{what}: {n}");
    }
}

/// The evaluator on its own never needs the hook's guard check: verified
/// windows end by the guard, so at or after it nothing is active.
#[test]
fn rule_sets_are_inert_after_the_guard_even_without_the_hook() {
    let mut rng = Rng::new(0x1A7E);
    for _ in 0..2_000 {
        let guard = rng.pick(&[2, 600, 3_600, 86_400, GUARD]);
        let program = gen_rules(&mut rng, guard);
        let bytes = enc(&program);
        let set = RuleSet::verify(&bytes, guard).unwrap();
        for _ in 0..30 {
            let mut c = gen_ctx(&mut rng, &program, guard);
            c.now_rel = guard as i64 + rng.below(1 << 40) as i64;
            assert_eq!(set.evaluate(&c), Ok(()));
            // And before the guard start nothing is active either.
            c.now_rel = -1 - rng.below(1 << 40) as i64;
            assert_eq!(set.evaluate(&c), Ok(()));
        }
    }
}

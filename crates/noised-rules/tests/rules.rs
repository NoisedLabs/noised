//! PXR1: layout, every verifier check, every leaf predicate, every effect,
//! windows, limits and the evaluator's order.

mod common;

use common::cases::{rules_base, rules_invalid, rules_max, rules_valid};
use common::*;
use noised_rules::rules::{self, effect, CODE_MALFORMED, MAX_LEN};
use noised_rules::{
    exceeds, op, rules_hash, threshold, Error, Node, Rule, RuleSet, RulesProgram, Sha2,
    TransferCtx, Violation, BPS_FLAG,
};

fn verify(p: &RulesProgram) -> Result<(), Error> {
    RuleSet::verify(&enc(p), GUARD).map(|_| ())
}

/// Encode, verify for the 72-hour guard and evaluate.
fn eval(p: &RulesProgram, c: &TransferCtx) -> Result<(), Violation> {
    let bytes = enc(p);
    let set = RuleSet::verify(&bytes, GUARD).expect("valid");
    set.evaluate(c)
}

fn denied(rule: u8, code: u8) -> Result<(), Violation> {
    Err(Violation { rule, code })
}

/// A one-rule set denying whenever `cond` holds, during the whole guard.
fn when(keys: &[[u8; 32]], cond: &[Node]) -> RulesProgram {
    rules_prog(keys, &[deny(0, GUARD, 7, cond)])
}

/// Whether `cond` holds for `c` (through a DENY rule).
fn holds(keys: &[[u8; 32]], cond: &[Node], c: &TransferCtx) -> bool {
    match eval(&when(keys, cond), c) {
        Ok(()) => false,
        Err(v) => {
            assert_eq!(v, Violation { rule: 0, code: 7 });
            true
        }
    }
}

#[test]
fn layout_matches_an_independent_encoding() {
    // Built with Python's struct module from the spec.
    let expected =
        "505852310100010100000000000000007800000000010101000000000000000010000000000000000000";
    assert_eq!(hex(&enc(&simple_rules())), expected);
    assert_eq!(
        hex(&rules_hash::<Sha2>(&enc(&simple_rules()))),
        "046d7000bf4435929f7b675dffd36aff1f761af9adfd7e60c3f93196cb35675f"
    );
    assert_eq!(rules::HASH_DOMAIN, b"PHX-RULES-V1");
    assert_eq!(rules::NO_RULES_HASH, [0; 32]);
}

#[test]
fn rule_and_node_codecs_round_trip() {
    let r = Rule {
        from_rel: 0x0102_0304,
        to_rel: 0xA0B0_C0D0,
        cond_off: 5,
        cond_len: 6,
        effect: 2,
        code: 63,
        arg: 0x1122_3344_5566_7788,
    };
    let b = r.to_bytes();
    assert_eq!(
        b,
        [
            4, 3, 2, 1, 0xD0, 0xC0, 0xB0, 0xA0, 5, 6, 2, 63, 0x88, 0x77, 0x66, 0x55, 0x44, 0x33,
            0x22, 0x11
        ]
    );
    assert_eq!(Rule::from_bytes(&b), r);
    let n = Node::new(0x16, 0xA5, 0x0102_0304_0506_0708);
    assert_eq!(n.to_bytes(), [0x16, 0xA5, 8, 7, 6, 5, 4, 3, 2, 1]);
    assert_eq!(Node::from_bytes(&n.to_bytes()), n);
}

#[test]
fn every_invalid_case_fails_with_its_error() {
    let cases = rules_invalid();
    assert!(cases.len() >= 40);
    for c in &cases {
        assert_eq!(
            RuleSet::verify(&c.bytes, c.guard).err(),
            Some(c.error),
            "{}",
            c.name
        );
    }
}

#[test]
fn every_valid_case_verifies_and_round_trips() {
    let cases = rules_valid();
    assert!(cases.len() >= 40);
    for c in &cases {
        let bytes = enc(&c.program);
        let set = RuleSet::verify(&bytes, c.guard).unwrap_or_else(|e| panic!("{}: {e}", c.name));
        assert_eq!(RulesProgram::from_set(&set), c.program, "{}", c.name);
        assert_eq!(RulesProgram::decode(&bytes).unwrap(), c.program);
        assert_eq!(
            bytes.len(),
            rules::encoded_len(
                c.program.keys.len() as u8,
                c.program.rules.len() as u8,
                c.program.nodes.len() as u8
            )
        );
    }
}

#[test]
fn the_largest_rule_set_is_exactly_the_maximum() {
    let p = rules_max();
    let bytes = enc(&p);
    assert_eq!((p.keys.len(), p.rules.len(), p.nodes.len()), (8, 16, 64));
    assert_eq!(bytes.len(), MAX_LEN);
    assert_eq!(MAX_LEN, 1_228);
    assert_eq!(rules::encoded_len(8, 16, 64), MAX_LEN);
    RuleSet::verify(&bytes, GUARD).unwrap();
    // One more of anything is refused.
    let mut more = p.clone();
    more.keys.push([9; 32]);
    assert_eq!(verify(&more), Err(Error::TooManyKeys));
    let mut more = p.clone();
    more.rules.push(more.rules[0]);
    assert_eq!(verify(&more), Err(Error::TooManyRules));
    let mut more = p;
    more.nodes.push(T);
    assert_eq!(verify(&more), Err(Error::TooManyNodes));
}

#[test]
fn counts_at_their_limits() {
    // 16 rules of one node each, 8 keys, and a 64-node set are fine.
    let keys: Vec<[u8; 32]> = (1..=8u8).map(|i| [i; 32]).collect();
    let mut rs = vec![deny(0, 10, 1, &[T]); 15];
    rs.push(deny(0, 10, 1, &[dest_in(0xFF)]));
    assert_eq!(verify(&rules_prog(&keys, &rs)), Ok(()));
    let nodes: Vec<Node> = [[T; 32].as_slice(), &[AND; 31]].concat();
    let p = rules_prog(&[], &[deny(0, 10, 1, &nodes), deny(0, 10, 1, &[F])]);
    assert_eq!(p.nodes.len(), 64);
    // 32 values deep is too deep, so build 64 nodes from shallow pieces.
    assert_eq!(verify(&p), Err(Error::StackOverflow));
    let shallow: Vec<Node> = std::iter::once(T)
        .chain([T, AND].repeat(31))
        .chain([NOT])
        .collect();
    assert_eq!(shallow.len(), 64);
    assert_eq!(
        verify(&rules_prog(&[], &[deny(0, 10, 1, &shallow)])),
        Ok(())
    );
    let mut too_long = shallow.clone();
    too_long.extend([NOT]);
    assert_eq!(
        verify(&rules_prog(&[], &[deny(0, 10, 1, &too_long)])),
        Err(Error::TooManyNodes)
    );
    // No keys at all is fine.
    assert_eq!(verify(&simple_rules()), Ok(()));
}

#[test]
fn parse_checks_only_the_layout() {
    let mut p = rules_base();
    p.rules[0].effect = 9;
    p.keys[0] = [0; 32];
    let bytes = enc(&p);
    let set = RuleSet::parse(&bytes).unwrap();
    assert_eq!(set.rule_count(), 3);
    assert_eq!(set.node_count(), 7);
    assert_eq!(set.keys().len(), 2);
    assert_eq!(set.rule(0).unwrap().effect, 9);
    assert_eq!(set.rule(3), None);
    assert_eq!(set.node(6), Some(AND));
    assert_eq!(set.node(7), None);
    assert_eq!(RuleSet::verify(&bytes, GUARD).err(), Some(Error::ZeroKey));
}

// ------------------------------------------------------------ windows ---

#[test]
fn a_rule_applies_from_its_start_until_just_before_its_end() {
    let p = rules_prog(&[], &[deny(10, 20, 5, &[T])]);
    let at = |t: i64| {
        eval(
            &p,
            &TransferCtx {
                now_rel: t,
                ..ctx()
            },
        )
    };
    assert_eq!(at(9), Ok(()));
    assert_eq!(at(10), denied(0, 5));
    assert_eq!(at(19), denied(0, 5));
    assert_eq!(at(20), Ok(()));
    assert_eq!(at(-1), Ok(()));
    assert_eq!(at(i64::MIN), Ok(()));
    assert_eq!(at(i64::MAX), Ok(()));
    let r = Rule {
        from_rel: 0,
        to_rel: 1,
        ..Rule::default()
    };
    assert!(!r.active_at(-1));
    assert!(r.active_at(0));
    assert!(!r.active_at(1));
}

#[test]
fn windows_end_by_the_guard_and_never_after_72_hours() {
    let p = |to: u32| rules_prog(&[], &[deny(0, to, 1, &[T])]);
    assert_eq!(RuleSet::verify(&enc(&p(600)), 600).map(|_| ()), Ok(()));
    assert_eq!(
        RuleSet::verify(&enc(&p(601)), 600).err(),
        Some(Error::WindowPastGuard)
    );
    assert_eq!(
        RuleSet::verify(&enc(&p(259_200)), u32::MAX).map(|_| ()),
        Ok(())
    );
    assert_eq!(
        RuleSet::verify(&enc(&p(259_201)), u32::MAX).err(),
        Some(Error::WindowPastGuard)
    );
    assert_eq!(
        RuleSet::verify(&enc(&p(1)), 0).err(),
        Some(Error::WindowPastGuard)
    );
    assert_eq!(rules::MAX_GUARD_SECS, 259_200);
}

/// After the guard every verified rule set allows everything, whatever the
/// hook does: windows end by the guard.
#[test]
fn nothing_is_active_at_or_after_the_guard_end() {
    let mut rng = Rng::new(41);
    for _ in 0..3_000 {
        let guard = rng.pick(&[2, 60, 600, 86_400, GUARD, u32::MAX]);
        let p = gen_rules(&mut rng, guard);
        let bytes = enc(&p);
        let set = RuleSet::verify(&bytes, guard).unwrap();
        for _ in 0..20 {
            let mut c = gen_ctx(&mut rng, &p, guard.min(GUARD));
            c.now_rel = guard.min(GUARD) as i64 + rng.pick(&[0i64, 1, 1_000, i64::MAX / 2]);
            assert_eq!(set.evaluate(&c), Ok(()));
        }
    }
}

// --------------------------------------------------------------- leaves ---

#[test]
fn is_buy_and_is_p2p() {
    let mut c = ctx();
    (c.is_buy, c.is_p2p) = (true, false);
    assert!(holds(&[], &[is_buy()], &c));
    assert!(!holds(&[], &[is_p2p()], &c));
    (c.is_buy, c.is_p2p) = (false, true);
    assert!(!holds(&[], &[is_buy()], &c));
    assert!(holds(&[], &[is_p2p()], &c));
}

#[test]
fn time_lt_and_time_ge() {
    let at = |t: i64| TransferCtx {
        now_rel: t,
        ..ctx()
    };
    assert!(holds(&[], &[time_lt(100)], &at(99)));
    assert!(!holds(&[], &[time_lt(100)], &at(100)));
    assert!(!holds(&[], &[time_ge(100)], &at(99)));
    assert!(holds(&[], &[time_ge(100)], &at(100)));
    // Bound 0: nothing in the window is before it.
    assert!(!holds(&[], &[time_lt(0)], &at(0)));
    assert!(holds(&[], &[time_ge(0)], &at(0)));
}

#[test]
fn negative_relative_time_is_before_every_bound() {
    // The evaluator alone (no window is active before the guard starts).
    let bytes = enc(&rules_prog(
        &[],
        &[deny(0, 10, 1, &[time_lt(0)]), deny(0, 10, 2, &[time_ge(0)])],
    ));
    let set = RuleSet::verify(&bytes, GUARD).unwrap();
    let c = TransferCtx {
        now_rel: -1,
        ..ctx()
    };
    assert_eq!(set.condition(0, &c), Some(true));
    assert_eq!(set.condition(1, &c), Some(false));
    let c = TransferCtx {
        now_rel: i64::MIN,
        ..ctx()
    };
    assert_eq!(set.condition(0, &c), Some(true));
}

#[test]
fn amount_gt_absolute() {
    let with = |amount: u64| TransferCtx { amount, ..ctx() };
    assert!(!holds(&[], &[amount_gt(1_000)], &with(1_000)));
    assert!(holds(&[], &[amount_gt(1_000)], &with(1_001)));
    assert!(!holds(&[], &[amount_gt(0)], &with(0)));
    assert!(holds(&[], &[amount_gt(0)], &with(1)));
    assert!(!holds(
        &[],
        &[amount_gt((1 << 63) - 1)],
        &with((1 << 63) - 1)
    ));
    assert!(holds(&[], &[amount_gt((1 << 63) - 1)], &with(1 << 63)));
}

#[test]
fn amount_gt_in_bps_of_supply() {
    let with = |amount: u64, supply: u64| TransferCtx {
        amount,
        supply,
        ..ctx()
    };
    // 1% of 1,000,000 = 10,000.
    assert!(!holds(
        &[],
        &[amount_gt(bps(100))],
        &with(10_000, 1_000_000)
    ));
    assert!(holds(&[], &[amount_gt(bps(100))], &with(10_001, 1_000_000)));
    // floor(999,999 * 1 / 10,000) = 99.
    assert!(!holds(&[], &[amount_gt(bps(1))], &with(99, 999_999)));
    assert!(holds(&[], &[amount_gt(bps(1))], &with(100, 999_999)));
    // 100% of the supply.
    assert!(!holds(
        &[],
        &[amount_gt(bps(10_000))],
        &with(u64::MAX, u64::MAX)
    ));
    assert!(holds(
        &[],
        &[amount_gt(bps(10_000))],
        &with(u64::MAX, u64::MAX - 1)
    ));
    // Supply 0: any non-zero amount exceeds.
    assert!(!holds(&[], &[amount_gt(bps(5_000))], &with(0, 0)));
    assert!(holds(&[], &[amount_gt(bps(5_000))], &with(1, 0)));
}

#[test]
fn dest_balance_after_gt() {
    let with = |bal: u64, supply: u64| TransferCtx {
        dest_balance_after: bal,
        supply,
        ..ctx()
    };
    assert!(!holds(&[], &[dest_bal_gt(500)], &with(500, 1)));
    assert!(holds(&[], &[dest_bal_gt(500)], &with(501, 1)));
    assert!(!holds(
        &[],
        &[dest_bal_gt(bps(200))],
        &with(20_000, 1_000_000)
    ));
    assert!(holds(
        &[],
        &[dest_bal_gt(bps(200))],
        &with(20_001, 1_000_000)
    ));
    // It looks at the balance, not the amount.
    let c = TransferCtx {
        amount: u64::MAX,
        dest_balance_after: 0,
        ..ctx()
    };
    assert!(!holds(&[], &[dest_bal_gt(0)], &c));
}

#[test]
fn owner_and_program_masks() {
    let keys: Vec<[u8; 32]> = (1..=8u8).map(|i| [i; 32]).collect();
    let all = 0xFF;
    // Use every key so the set is canonical.
    let cond = |n: Node| vec![n, dest_in(all), F, AND, OR];
    for (i, k) in keys.iter().enumerate() {
        let bit = 1u8 << i;
        let mut c = ctx();
        c.dest_owner = *k;
        c.src_owner = *k;
        c.top_program = *k;
        for leaf in [dest_in(bit), src_in(bit), top_in(bit)] {
            assert!(holds(&keys, &cond(leaf), &c), "key {i}");
            let other = Node {
                a: all & !bit,
                ..leaf
            };
            assert!(!holds(&keys, &cond(other), &c), "key {i} not in mask");
        }
    }
    // Each leaf looks at its own side.
    let mut c = ctx();
    c.dest_owner = keys[0];
    assert!(holds(&keys, &cond(dest_in(1)), &c));
    assert!(!holds(&keys, &cond(src_in(1)), &c));
    assert!(!holds(&keys, &cond(top_in(1)), &c));
    let mut c = ctx();
    c.src_owner = keys[3];
    assert!(holds(&keys, &cond(src_in(8)), &c));
    assert!(!holds(&keys, &cond(dest_in(8)), &c));
    let mut c = ctx();
    c.top_program = keys[7];
    assert!(holds(&keys, &cond(top_in(0x80)), &c));
    assert!(!holds(&keys, &cond(src_in(0x80)), &c));
    // Nobody outside the keys matches a full mask.
    assert!(!holds(
        &keys,
        &[dest_in(all), src_in(all), OR, top_in(all), OR],
        &ctx()
    ));
}

#[test]
fn tx_ix_count_gt() {
    let with = |n: u16| TransferCtx {
        tx_ix_count: n,
        ..ctx()
    };
    assert!(!holds(&[], &[ix_gt(3)], &with(3)));
    assert!(holds(&[], &[ix_gt(3)], &with(4)));
    assert!(!holds(&[], &[ix_gt(u64::MAX)], &with(u16::MAX)));
    assert!(holds(&[], &[ix_gt(0)], &with(1)));
}

#[test]
fn uses_leaf_reports_the_leaves_present() {
    let bytes = enc(&rules_base());
    let set = RuleSet::verify(&bytes, GUARD).unwrap();
    assert!(set.uses_leaf(op::rules::IS_BUY));
    assert!(set.uses_leaf(op::rules::SRC_OWNER_IN));
    assert!(set.uses_leaf(op::rules::TIME_LT));
    assert!(!set.uses_leaf(op::rules::TOP_PROGRAM_IN));
    assert!(!set.uses_leaf(op::rules::TX_IX_COUNT_GT));
}

// -------------------------------------------------------------- effects ---

#[test]
fn deny_rejects_exactly_when_the_condition_holds() {
    let p = rules_prog(&[], &[deny(0, 100, 9, &[is_buy()])]);
    assert_eq!(
        eval(
            &p,
            &TransferCtx {
                is_buy: true,
                ..ctx()
            }
        ),
        denied(0, 9)
    );
    assert_eq!(
        eval(
            &p,
            &TransferCtx {
                is_buy: false,
                ..ctx()
            }
        ),
        Ok(())
    );
}

#[test]
fn cap_amount_rejects_only_above_the_cap() {
    let p = rules_prog(&[], &[cap_amount(0, 100, 3, 1_000, &[is_buy()])]);
    let c = |amount: u64, is_buy: bool| TransferCtx {
        amount,
        is_buy,
        ..ctx()
    };
    assert_eq!(eval(&p, &c(1_000, true)), Ok(()));
    assert_eq!(eval(&p, &c(1_001, true)), denied(0, 3));
    assert_eq!(eval(&p, &c(u64::MAX, false)), Ok(()), "condition false");
    // It caps the amount, not the balance.
    let mut big_balance = c(1, true);
    big_balance.dest_balance_after = u64::MAX;
    assert_eq!(eval(&p, &big_balance), Ok(()));
}

#[test]
fn cap_amount_in_bps_of_supply() {
    let p = rules_prog(&[], &[cap_amount(0, 100, 3, bps(250), &[T])]);
    let c = |amount: u64| TransferCtx {
        amount,
        supply: 1_000_000,
        ..ctx()
    };
    assert_eq!(eval(&p, &c(25_000)), Ok(()));
    assert_eq!(eval(&p, &c(25_001)), denied(0, 3));
}

#[test]
fn cap_dest_balance_rejects_only_above_the_cap() {
    let p = rules_prog(&[], &[cap_balance(0, 100, 4, 50_000, &[T])]);
    let c = |bal: u64| TransferCtx {
        dest_balance_after: bal,
        amount: 1,
        ..ctx()
    };
    assert_eq!(eval(&p, &c(50_000)), Ok(()));
    assert_eq!(eval(&p, &c(50_001)), denied(0, 4));
    let mut huge_amount = c(1);
    huge_amount.amount = u64::MAX;
    assert_eq!(eval(&p, &huge_amount), Ok(()));
    let p = rules_prog(&[], &[cap_balance(0, 100, 4, bps(10_000), &[T])]);
    let c = |bal: u64| TransferCtx {
        dest_balance_after: bal,
        supply: 7,
        ..ctx()
    };
    assert_eq!(eval(&p, &c(7)), Ok(()));
    assert_eq!(eval(&p, &c(8)), denied(0, 4));
}

#[test]
fn a_cap_with_a_false_condition_never_rejects() {
    let p = rules_prog(
        &[],
        &[
            cap_balance(0, 100, 4, 1, &[F]),
            cap_amount(0, 100, 5, 1, &[T, NOT]),
        ],
    );
    let c = TransferCtx {
        amount: u64::MAX,
        dest_balance_after: u64::MAX,
        ..ctx()
    };
    assert_eq!(eval(&p, &c), Ok(()));
}

#[test]
fn the_first_rejecting_rule_wins_and_inactive_rules_are_skipped() {
    let p = rules_prog(
        &[],
        &[
            deny(50, 100, 1, &[T]),             // inactive at 10
            cap_amount(0, 100, 2, 5_000, &[T]), // passes at amount 1,000
            deny(0, 100, 3, &[is_p2p()]),       // condition false for a buy
            cap_balance(0, 100, 4, 10, &[T]),   // rejects
            deny(0, 100, 5, &[T]),              // would reject too
        ],
    );
    let c = TransferCtx {
        now_rel: 10,
        amount: 1_000,
        dest_balance_after: 1_000,
        is_buy: true,
        is_p2p: false,
        ..ctx()
    };
    assert_eq!(eval(&p, &c), denied(3, 4));
    assert_eq!(eval(&p, &TransferCtx { now_rel: 60, ..c }), denied(0, 1));
    assert_eq!(eval(&p, &TransferCtx { amount: 6_000, ..c }), denied(1, 2));
}

#[test]
fn no_rule_active_means_allowed() {
    let p = rules_prog(&[], &[deny(100, 200, 1, &[T])]);
    assert_eq!(eval(&p, &ctx()), Ok(()));
}

// --------------------------------------------------- unverified input ---

#[test]
fn malformed_rules_fail_closed() {
    // Unknown effect.
    let mut p = simple_rules();
    p.rules[0].effect = 7;
    let bytes = enc(&p);
    let set = RuleSet::parse(&bytes).unwrap();
    assert_eq!(set.evaluate(&ctx()), denied(0, CODE_MALFORMED));
    // Underflowing conditions.
    for op in [AND, OR, NOT] {
        let mut p = simple_rules();
        p.nodes[0] = op;
        let bytes = enc(&p);
        let set = RuleSet::parse(&bytes).unwrap();
        assert_eq!(set.evaluate(&ctx()), denied(0, CODE_MALFORMED));
        assert_eq!(set.condition(0, &ctx()), None);
    }
    // Condition past the nodes.
    let mut p = simple_rules();
    p.rules[0].cond_len = 2;
    let bytes = enc(&p);
    let set = RuleSet::parse(&bytes).unwrap();
    assert_eq!(set.evaluate(&ctx()), denied(0, CODE_MALFORMED));
    // Empty condition.
    let mut p = simple_rules();
    p.rules[0].cond_len = 0;
    let bytes = enc(&p);
    let set = RuleSet::parse(&bytes).unwrap();
    assert_eq!(set.evaluate(&ctx()), denied(0, CODE_MALFORMED));
    // A graph leaf.
    let mut p = simple_rules();
    p.nodes[0] = leaf(op::graph::GRADUATED, 0, 0);
    let bytes = enc(&p);
    let set = RuleSet::parse(&bytes).unwrap();
    assert_eq!(set.evaluate(&ctx()), denied(0, CODE_MALFORMED));
    // Seventeen values on the stack.
    let mut p = simple_rules();
    p.nodes = [vec![T; 17], vec![AND; 16]].concat();
    p.rules[0].cond_len = 33;
    let bytes = enc(&p);
    let set = RuleSet::parse(&bytes).unwrap();
    assert_eq!(set.evaluate(&ctx()), denied(0, CODE_MALFORMED));
    // Two values left.
    let mut p = simple_rules();
    p.nodes = vec![T, T];
    p.rules[0].cond_len = 2;
    let bytes = enc(&p);
    let set = RuleSet::parse(&bytes).unwrap();
    assert_eq!(set.evaluate(&ctx()), denied(0, CODE_MALFORMED));
    // But an inactive malformed rule is never looked at.
    let mut p = simple_rules();
    p.rules[0].effect = 7;
    let bytes = enc(&p);
    let set = RuleSet::parse(&bytes).unwrap();
    assert_eq!(
        set.evaluate(&TransferCtx {
            now_rel: 120,
            ..ctx()
        }),
        Ok(())
    );
    // Out of range rule index.
    assert_eq!(set.condition(1, &ctx()), None);
}

#[test]
fn malformed_caps_skip_their_condition_when_under_the_cap() {
    // A CAP rule compares its cap first; its (malformed) condition is only
    // reached when the cap is exceeded.
    let mut p = rules_prog(&[], &[cap_amount(0, 100, 3, 10, &[T])]);
    p.nodes[0] = OR;
    let bytes = enc(&p);
    let set = RuleSet::parse(&bytes).unwrap();
    assert_eq!(
        set.evaluate(&TransferCtx {
            amount: 10,
            ..ctx()
        }),
        Ok(())
    );
    assert_eq!(
        set.evaluate(&TransferCtx {
            amount: 11,
            ..ctx()
        }),
        denied(0, CODE_MALFORMED)
    );
}

// ------------------------------------------------------------ helpers ---

#[test]
fn exceeds_matches_floor_division() {
    let mut rng = Rng::new(3);
    for _ in 0..200_000 {
        let supply = rng.wide();
        let b = match rng.below(3) {
            0 => rng.pick(&[0, 1, 9_999, 10_000, 10_001, 0xFFFF]),
            _ => rng.below(10_001),
        };
        let arg = BPS_FLAG | b;
        let t = (supply as u128 * b as u128) / 10_000;
        let value = match rng.below(3) {
            0 => (t.min(u64::MAX as u128) as u64)
                .saturating_add(rng.below(3))
                .saturating_sub(1),
            _ => rng.wide(),
        };
        assert_eq!(
            exceeds(value, arg, supply),
            value as u128 > t,
            "{value} {b} {supply}"
        );
        assert_eq!(threshold(arg, supply) as u128, t.min(u64::MAX as u128));
        let plain = rng.wide() & !BPS_FLAG;
        assert_eq!(exceeds(value, plain, supply), value > plain);
        assert_eq!(threshold(plain, supply), plain);
    }
}

#[test]
fn error_names_round_trip() {
    for e in Error::ALL {
        assert_eq!(Error::from_name(e.name()), Some(*e));
        assert_eq!(format!("{e}"), e.name());
    }
    assert_eq!(Error::from_name("Nope"), None);
    assert_eq!(Error::ALL.len(), 60);
    for (i, e) in Error::ALL.iter().enumerate() {
        assert_eq!(*e as usize, i, "discriminants are dense and stable");
    }
}

#[test]
fn effects_and_codes() {
    assert_eq!(
        (effect::DENY, effect::CAP_AMOUNT, effect::CAP_DEST_BALANCE),
        (1, 2, 3)
    );
    assert_eq!(rules::MAX_CODE, 63);
    assert_eq!(CODE_MALFORMED, 0xFF);
}

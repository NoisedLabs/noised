//! Seeded property tests: no input panics; verified programs evaluate
//! without error and exactly like the reference model; codecs round-trip;
//! the verifiers are canonical where they claim to be.

mod common;

use common::*;
use noised_rules::rules::{self, CODE_MALFORMED};
use noised_rules::{graph, Graph, GraphProgram, NotDue, RuleSet, RulesProgram};

/// Run every entry point on arbitrary bytes. Returning at all is the
/// property (a panic fails the test).
fn exercise(bytes: &[u8], rng: &mut Rng) {
    let guard = rng.pick(&[0, 1, 600, GUARD, u32::MAX]);
    let _ = RuleSet::verify(bytes, guard);
    if let Ok(set) = RuleSet::parse(bytes) {
        let p = RulesProgram::decode(bytes).expect("parse ok");
        assert_eq!(p.encode().unwrap(), bytes, "decode/encode round-trip");
        for _ in 0..4 {
            let c = gen_ctx(rng, &p, GUARD);
            let _ = set.evaluate(&c);
            for i in 0..=set.rule_count() {
                let _ = set.condition(i, &c);
            }
        }
        let _ = set.uses_leaf(rng.next() as u8);
    }
    let _ = Graph::verify(bytes);
    if let Ok(g) = Graph::parse(bytes) {
        let p = GraphProgram::decode(bytes).expect("parse ok");
        assert_eq!(p.encode().unwrap(), bytes, "decode/encode round-trip");
        let extra = rng.below(2) as usize;
        let states = gen_states(rng, g.node_count() + extra);
        let c = gen_gctx(rng, &p);
        for i in 0..=g.node_count() {
            let _ = g.condition(i, &c);
            let _ = g.due(i, &states, c.now, c.graduated);
            let _ = g.runnable(i, &states, &c);
            let first = states.first().copied().unwrap_or_default();
            let _ = g.run_cap(i, &first, c.now);
        }
        let _ = g.runs_in_epoch(&states, c.now);
        let _ = g.shares(rng.wide());
    }
}

#[test]
fn random_bytes_never_panic() {
    let mut rng = Rng::new(0xF022);
    for _ in 0..60_000 {
        let len = match rng.below(4) {
            0 => rng.below(64) as usize,
            1 => rng.below(2_100) as usize,
            _ => rng.pick(&[11, 12, 13, 43, 44, 45, 42, 54, 1_228, 2_044]),
        };
        let mut bytes = rng.bytes(len);
        // Often a plausible header, so the deeper checks run too.
        if rng.coin() && bytes.len() >= 12 {
            let magic: &[u8; 4] = if rng.coin() { b"PXR1" } else { b"PXG1" };
            bytes[..4].copy_from_slice(magic);
            bytes[4] = 1;
            if rng.coin() {
                bytes[8..12].fill(0);
            }
        }
        exercise(&bytes, &mut rng);
    }
}

/// Encodings of random programs with each count set so the length is
/// exact: the parser accepts them, so evaluation runs on garbage contents.
#[test]
fn random_contents_with_exact_lengths_never_panic() {
    let mut rng = Rng::new(0xC0DE);
    for _ in 0..40_000 {
        if rng.coin() {
            let (k, r, n) = (
                rng.below(9) as u8,
                1 + rng.below(16) as u8,
                rng.below(65) as u8,
            );
            let mut b = rng.bytes(rules::encoded_len(k, r, n));
            b[..12].copy_from_slice(&[b'P', b'X', b'R', b'1', 1, k, r, n, 0, 0, 0, 0]);
            // Small condition placements, so conditions are often in range.
            for i in 0..r as usize {
                let at = 12 + 32 * k as usize + 20 * i;
                b[at + 8] = rng.below(n as u64 + 1) as u8;
                b[at + 9] = rng.below(8) as u8;
                if rng.coin() {
                    b[at + 10] = 1 + rng.below(3) as u8;
                }
            }
            for i in 0..n as usize {
                let at = 12 + 32 * k as usize + 20 * r as usize + 10 * i;
                b[at] = rng.pick(&[
                    0, 1, 2, 3, 4, 0x10, 0x12, 0x14, 0x16, 0x19, 0x20, 0x27, 0xFF,
                ]);
            }
            assert!(RuleSet::parse(&b).is_ok());
            exercise(&b, &mut rng);
        } else {
            let (r, n, c) = (
                rng.below(9) as u8,
                1 + rng.below(16) as u8,
                rng.below(97) as u8,
            );
            let mut b = rng.bytes(graph::encoded_len(r, n, c));
            b[..12].copy_from_slice(&[
                b'P',
                b'X',
                b'G',
                b'1',
                1,
                r,
                n,
                c,
                rng.below(2) as u8,
                0,
                0,
                0,
            ]);
            for i in 0..n as usize {
                let at = 44 + 34 * r as usize + 48 * i;
                b[at] = rng.below(6) as u8;
                if rng.coin() {
                    b[at + 1..at + 9].copy_from_slice(&rng.below(n as u64 + 1).to_le_bytes());
                }
                b[at + 9] = rng.below(c as u64 + 1) as u8;
                b[at + 10] = rng.below(8) as u8;
            }
            for i in 0..c as usize {
                let at = 44 + 34 * r as usize + 48 * n as usize + 10 * i;
                b[at] = rng.pick(&[0, 1, 2, 3, 4, 0x10, 0x20, 0x22, 0x25, 0x27, 0xFF]);
                b[at + 1] = rng.below(20) as u8;
            }
            assert!(Graph::parse(&b).is_ok());
            exercise(&b, &mut rng);
        }
    }
}

/// Valid programs with one to three random byte changes: never a panic,
/// and whatever still verifies evaluates without a malformed result.
#[test]
fn mutated_valid_programs_never_panic() {
    let mut rng = Rng::new(0xB17F);
    for i in 0..20_000 {
        let guard = rng.pick(&[60, 600, 86_400, GUARD]);
        let (mut bytes, is_rules) = if i % 2 == 0 {
            (enc(&gen_rules(&mut rng, guard)), true)
        } else {
            (genc(&gen_graph(&mut rng)), false)
        };
        for _ in 0..1 + rng.below(3) {
            let at = rng.below(bytes.len() as u64) as usize;
            if rng.coin() {
                bytes[at] ^= 1 << rng.below(8);
            } else {
                bytes[at] = rng.next() as u8;
            }
        }
        if rng.one_in(10) {
            bytes.truncate(rng.below(bytes.len() as u64) as usize);
        }
        exercise(&bytes, &mut rng);
        if is_rules {
            if let Ok(set) = RuleSet::verify(&bytes, guard) {
                let p = RulesProgram::decode(&bytes).unwrap();
                for _ in 0..8 {
                    let c = gen_ctx(&mut rng, &p, guard);
                    if let Err(v) = set.evaluate(&c) {
                        assert_ne!(v.code, CODE_MALFORMED);
                    }
                    assert_eq!(set.evaluate(&c), ref_rules_eval(&p, &c));
                }
            }
        } else if let Ok(g) = Graph::verify(&bytes) {
            let p = GraphProgram::decode(&bytes).unwrap();
            let c = gen_gctx(&mut rng, &p);
            for i in 0..g.node_count() {
                assert_eq!(g.condition(i, &c), ref_graph_condition(&p, i, &c));
                assert!(g.condition(i, &c).is_some());
            }
        }
    }
}

#[test]
fn verified_rule_sets_evaluate_like_the_reference() {
    let mut rng = Rng::new(0x5EED);
    let mut rejected = 0u32;
    let mut total = 0u32;
    for _ in 0..4_000 {
        let guard = rng.pick(&[2, 60, 600, 3_600, 86_400, GUARD]);
        let p = gen_rules(&mut rng, guard);
        let bytes = enc(&p);
        let set = RuleSet::verify(&bytes, guard).unwrap_or_else(|e| panic!("{e}: {p:?}"));
        assert_eq!(RulesProgram::from_set(&set), p);
        // Conditions partition the nodes: a transfer evaluates each node at
        // most once (at most 64).
        let sum: usize = p.rules.iter().map(|r| r.cond_len as usize).sum();
        assert_eq!(sum, p.nodes.len());
        assert!(sum <= 64);
        for _ in 0..50 {
            let c = gen_ctx(&mut rng, &p, guard);
            let got = set.evaluate(&c);
            assert_eq!(got, ref_rules_eval(&p, &c), "{p:?} {c:?}");
            if let Err(v) = got {
                assert_ne!(v.code, CODE_MALFORMED);
                assert!(v.code <= rules::MAX_CODE);
                rejected += 1;
            }
            total += 1;
            for i in 0..p.rules.len() {
                assert_eq!(
                    set.condition(i, &c),
                    Some(ref_rule_condition(&p, i, &c).unwrap())
                );
            }
        }
    }
    // The generator exercises both outcomes.
    assert!(
        rejected > total / 10 && rejected < total * 9 / 10,
        "{rejected}/{total}"
    );
}

#[test]
fn verified_graphs_evaluate_like_the_reference() {
    let mut rng = Rng::new(0x6EED);
    let mut outcomes = std::collections::BTreeMap::new();
    for _ in 0..4_000 {
        let p = gen_graph(&mut rng);
        let bytes = genc(&p);
        let g = Graph::verify(&bytes).unwrap_or_else(|e| panic!("{e}: {p:?}"));
        assert_eq!(GraphProgram::decode(&bytes).unwrap(), p);
        for _ in 0..10 {
            let c = gen_gctx(&mut rng, &p);
            let states = gen_states(&mut rng, p.nodes.len());
            for i in 0..p.nodes.len() {
                let cond = g.condition(i, &c);
                assert_eq!(cond, ref_graph_condition(&p, i, &c));
                assert!(cond.is_some());
                let r = g.runnable(i, &states, &c);
                assert_ne!(r, Err(NotDue::Malformed));
                assert_ne!(r, Err(NotDue::NoSuchNode));
                *outcomes.entry(format!("{r:?}")).or_insert(0u32) += 1;
            }
        }
    }
    // Every outcome shows up.
    for name in [
        "Ok(())",
        "Err(Waiting)",
        "Err(AwaitingParent)",
        "Err(NotGraduated)",
        "Err(AlreadyRan)",
        "Err(MaxRunsReached)",
        "Err(BudgetSpent)",
        "Err(ConditionFalse)",
    ] {
        assert!(
            outcomes.get(name).copied().unwrap_or(0) > 10,
            "{name}: {outcomes:?}"
        );
    }
}

#[test]
fn programs_round_trip_through_bytes() {
    let mut rng = Rng::new(0xAB);
    for _ in 0..2_000 {
        // Arbitrary field values, not only valid ones.
        let p = RulesProgram {
            keys: (0..rng.below(9)).map(|_| rng.key()).collect(),
            rules: (0..1 + rng.below(16))
                .map(|_| noised_rules::Rule::from_bytes(&rng.bytes(20).try_into().unwrap()))
                .collect(),
            nodes: (0..rng.below(65))
                .map(|_| noised_rules::Node::from_bytes(&rng.bytes(10).try_into().unwrap()))
                .collect(),
        };
        let bytes = p.encode().unwrap();
        assert_eq!(RulesProgram::decode(&bytes).unwrap(), p);
        let g = GraphProgram {
            flags: rng.below(2) as u8,
            operator: rng.key(),
            recipients: (0..rng.below(9))
                .map(|_| noised_rules::Recipient::from_bytes(&rng.bytes(34).try_into().unwrap()))
                .collect(),
            nodes: (0..1 + rng.below(16))
                .map(|_| noised_rules::GNode::from_bytes(&rng.bytes(48).try_into().unwrap()))
                .collect(),
            cond: (0..rng.below(97))
                .map(|_| noised_rules::Node::from_bytes(&rng.bytes(10).try_into().unwrap()))
                .collect(),
        };
        let bytes = g.encode().unwrap();
        assert_eq!(GraphProgram::decode(&bytes).unwrap(), g);
    }
    // Counts that do not fit a byte cannot be encoded.
    let big = RulesProgram {
        nodes: vec![T; 256],
        ..simple_rules()
    };
    assert!(big.encode().is_err());
    let big = GraphProgram {
        cond: vec![T; 256],
        ..simple_graph()
    };
    assert!(big.encode().is_err());
}

/// Rules can only ever reject: dropping any rule from a verified set never
/// turns an allowed transfer into a rejected one, and a set allows a
/// transfer exactly when each of its rules alone does.
#[test]
fn each_rule_only_adds_restrictions() {
    let mut rng = Rng::new(0xADD);
    for _ in 0..1_500 {
        let guard = GUARD;
        let p = gen_rules(&mut rng, guard);
        let bytes = enc(&p);
        let set = RuleSet::verify(&bytes, guard).unwrap();
        for _ in 0..30 {
            let c = gen_ctx(&mut rng, &p, guard);
            let all = set.evaluate(&c);
            let each: Vec<bool> = (0..p.rules.len())
                .map(|i| {
                    let mut one = p.clone();
                    one.rules = vec![p.rules[i]];
                    let r = one.rules[0];
                    one.nodes =
                        p.nodes[r.cond_off as usize..(r.cond_off + r.cond_len) as usize].to_vec();
                    one.rules[0].cond_off = 0;
                    // The single rule may not use every key: evaluate it
                    // with the reference model.
                    ref_rules_eval(&one, &c).is_ok()
                })
                .collect();
            assert_eq!(all.is_ok(), each.iter().all(|&ok| ok));
            if let Err(v) = all {
                // The reported rule is the first that rejects alone.
                assert_eq!(v.rule as usize, each.iter().position(|&ok| !ok).unwrap());
            }
        }
    }
}

#[test]
fn verification_is_deterministic_and_parse_is_weaker() {
    let mut rng = Rng::new(0xD37);
    for _ in 0..20_000 {
        let mut bytes = if rng.coin() {
            enc(&gen_rules(&mut rng, GUARD))
        } else {
            genc(&gen_graph(&mut rng))
        };
        let at = rng.below(bytes.len() as u64) as usize;
        bytes[at] = rng.next() as u8;
        let a = RuleSet::verify(&bytes, GUARD).map(|_| ());
        assert_eq!(a, RuleSet::verify(&bytes, GUARD).map(|_| ()));
        if a.is_ok() {
            assert!(RuleSet::parse(&bytes).is_ok());
        }
        if let Err(e) = RuleSet::parse(&bytes) {
            assert_eq!(RuleSet::verify(&bytes, GUARD).err(), Some(e));
        }
        let b = Graph::verify(&bytes).map(|_| ());
        if b.is_ok() {
            assert!(Graph::parse(&bytes).is_ok());
        }
        if let Err(e) = Graph::parse(&bytes) {
            assert_eq!(Graph::verify(&bytes).err(), Some(e));
        }
    }
}

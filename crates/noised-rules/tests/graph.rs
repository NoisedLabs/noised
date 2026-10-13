//! PXG1: layout, every verifier check, every leaf predicate, due-ness,
//! epochs, AFTER acyclicity and the helpers.

mod common;

use common::cases::{graph_base, graph_invalid, graph_max, graph_valid, OP, R1, R2, R3};
use common::*;
use noised_rules::graph::{self, action, trigger, MAX_LEN, MAX_PREMIUM_BPS};
use noised_rules::{
    after_acyclic, current_epoch, graph_hash, op, Epoch, Error, GNode, Graph, GraphCtx,
    GraphProgram, Node, NodeState, NotDue, PriceRange, Recipient, Sha2,
};

fn verify(p: &GraphProgram) -> Result<(), Error> {
    Graph::verify(&genc(p)).map(|_| ())
}

/// Whether `cond` holds for `c` (as the condition of a WHEN node).
fn holds(cond: &[Node], c: &GraphCtx) -> bool {
    let p = graph_prog(
        None,
        &[],
        &[(gnode(trigger::WHEN, 0, action::BURN, 1, 0), cond.to_vec())],
    );
    let bytes = genc(&p);
    let g = Graph::verify(&bytes).expect("valid");
    g.condition(0, c).expect("verified")
}

#[test]
fn layout_matches_an_independent_encoding() {
    // Built with Python's struct module from the spec.
    let expected = "5058473101000101000000000000000000000000000000000000000000000000000000000000000000000000018051010000000000000101008051010000f2052a010000000065cd1d000000002c0100000000000001000000000000200000ca9a3b00000000";
    assert_eq!(hex(&genc(&simple_graph())), expected);
    assert_eq!(
        hex(&graph_hash::<Sha2>(&genc(&simple_graph()))),
        "8888038d2f5f53b66f989d4959483ce1f7039700deac07cf1292e0e17263cb0a"
    );
    assert_eq!(graph::HASH_DOMAIN, b"PHX-GRAPH-V1");
}

#[test]
fn gnode_and_recipient_codecs_round_trip() {
    let g = GNode {
        trigger: 2,
        trigger_arg: 0x0102_0304_0506_0708,
        cond_off: 9,
        cond_len: 10,
        action: 3,
        operator_gated: 1,
        epoch_secs: 0x1112_1314,
        budget_per_epoch: 0x2122_2324_2526_2728,
        p1: 0x3132_3334_3536_3738,
        p2: 0x4142_4344_4546_4748,
        max_runs_per_epoch: 0x5152,
        reserved: [0x61, 0x62, 0x63, 0x64, 0x65],
    };
    let b = g.to_bytes();
    let expected: Vec<u8> = [
        &[2u8][..],
        &[8, 7, 6, 5, 4, 3, 2, 1],
        &[9, 10, 3, 1],
        &[0x14, 0x13, 0x12, 0x11],
        &[0x28, 0x27, 0x26, 0x25, 0x24, 0x23, 0x22, 0x21],
        &[0x38, 0x37, 0x36, 0x35, 0x34, 0x33, 0x32, 0x31],
        &[0x48, 0x47, 0x46, 0x45, 0x44, 0x43, 0x42, 0x41],
        &[0x52, 0x51],
        &[0x61, 0x62, 0x63, 0x64, 0x65],
    ]
    .concat();
    assert_eq!(b.to_vec(), expected);
    assert_eq!(GNode::from_bytes(&b), g);
    let r = Recipient {
        key: [7; 32],
        bps: 0x1234,
    };
    let rb = r.to_bytes();
    assert_eq!(&rb[..32], &[7; 32]);
    assert_eq!(&rb[32..], &[0x34, 0x12]);
    assert_eq!(Recipient::from_bytes(&rb), r);
}

#[test]
fn every_invalid_case_fails_with_its_error() {
    let cases = graph_invalid();
    assert!(cases.len() >= 40);
    for c in &cases {
        assert_eq!(Graph::verify(&c.bytes).err(), Some(c.error), "{}", c.name);
    }
}

#[test]
fn every_valid_case_verifies_and_round_trips() {
    let cases = graph_valid();
    assert!(cases.len() >= 40);
    for c in &cases {
        let bytes = genc(&c.program);
        Graph::verify(&bytes).unwrap_or_else(|e| panic!("{}: {e}", c.name));
        assert_eq!(
            GraphProgram::decode(&bytes).unwrap(),
            c.program,
            "{}",
            c.name
        );
    }
}

#[test]
fn the_largest_graph_is_exactly_the_maximum() {
    let p = graph_max();
    let bytes = genc(&p);
    assert_eq!(
        (p.recipients.len(), p.nodes.len(), p.cond.len()),
        (8, 16, 96)
    );
    assert_eq!(bytes.len(), MAX_LEN);
    assert_eq!(MAX_LEN, 2_044);
    assert_eq!(graph::encoded_len(8, 16, 96), MAX_LEN);
    Graph::verify(&bytes).unwrap();
    let mut more = p.clone();
    more.recipients.push(Recipient {
        key: [1; 32],
        bps: 1,
    });
    assert_eq!(verify(&more), Err(Error::TooManyRecipients));
    let mut more = p.clone();
    more.nodes.push(more.nodes[1]);
    assert_eq!(verify(&more), Err(Error::TooManyGraphNodes));
    let mut more = p;
    more.cond.push(T);
    assert_eq!(verify(&more), Err(Error::TooManyNodes));
}

#[test]
fn accessors() {
    let bytes = genc(&graph_base());
    let g = Graph::verify(&bytes).unwrap();
    assert_eq!(g.operator(), Some(&OP));
    assert_eq!(g.operator_field(), &OP);
    assert_eq!(g.flags(), graph::FLAG_HAS_OPERATOR);
    assert_eq!(g.recipient_count(), 2);
    assert_eq!(
        g.recipient(1),
        Some(Recipient {
            key: R2,
            bps: 4_000
        })
    );
    assert_eq!(g.recipient(2), None);
    assert_eq!(g.node_count(), 5);
    assert_eq!(g.node(1).unwrap().after_parent(), Some(0));
    assert_eq!(g.node(0).unwrap().after_parent(), None);
    assert_eq!(g.node(5), None);
    assert_eq!(g.cond_count(), 4);
    assert_eq!(g.cond_node(3), Some(AND));
    assert_eq!(g.cond_node(4), None);
    let bytes = genc(&simple_graph());
    let g = Graph::verify(&bytes).unwrap();
    assert_eq!(g.operator(), None);
    assert_eq!(g.operator_field(), &[0; 32]);
}

// ------------------------------------------------------------ verifier ---

#[test]
fn edges_of_each_bound() {
    let base = || {
        graph_prog(
            None,
            &[],
            &[(
                gnode(trigger::EVERY, 600, action::BUYBACK_BURN, 1, 0),
                vec![],
            )],
        )
    };
    assert_eq!(verify(&base()), Ok(()));
    let mut p = base();
    p.nodes[0].trigger_arg = 599;
    assert_eq!(verify(&p), Err(Error::EveryTooShort));
    let mut p = base();
    p.nodes[0].p2 = MAX_PREMIUM_BPS;
    assert_eq!(verify(&p), Ok(()));
    p.nodes[0].p2 = MAX_PREMIUM_BPS + 1;
    assert_eq!(verify(&p), Err(Error::PremiumTooHigh));
    let mut p = base();
    p.nodes[0].epoch_secs = 3_600;
    assert_eq!(verify(&p), Ok(()));
    p.nodes[0].epoch_secs = 3_599;
    assert_eq!(verify(&p), Err(Error::EpochTooShort));
    let mut p = base();
    p.nodes[0].p1 = 1;
    p.nodes[0].budget_per_epoch = 1;
    p.nodes[0].max_runs_per_epoch = 1;
    assert_eq!(verify(&p), Ok(()));
    // Time bounds up to i64::MAX.
    let t = |arg: u64| {
        graph_prog(
            None,
            &[],
            &[(
                gnode(trigger::WHEN, 0, action::BURN, 1, 0),
                vec![leaf(op::graph::TIME_GE, 0, arg)],
            )],
        )
    };
    assert_eq!(verify(&t(i64::MAX as u64)), Ok(()));
    assert_eq!(verify(&t(i64::MAX as u64 + 1)), Err(Error::TimeOutOfRange));
    // RUNS_IN_EPOCH_LT on the last node.
    let r = |a: u8| {
        graph_prog(
            None,
            &[],
            &[
                (
                    gnode(trigger::WHEN, 0, action::BURN, 1, 0),
                    vec![leaf(op::graph::RUNS_IN_EPOCH_LT, a, 1)],
                ),
                (gnode(trigger::EVERY, 600, action::BURN, 1, 0), vec![]),
            ],
        )
    };
    assert_eq!(verify(&r(1)), Ok(()));
    assert_eq!(verify(&r(2)), Err(Error::BadNodeRef));
    // AFTER the last node.
    let a = |parent: u64| {
        graph_prog(
            None,
            &[],
            &[
                (gnode(trigger::AFTER, parent, action::BURN, 1, 0), vec![]),
                (gnode(trigger::EVERY, 600, action::BURN, 1, 0), vec![]),
            ],
        )
    };
    assert_eq!(verify(&a(1)), Ok(()));
    assert_eq!(verify(&a(2)), Err(Error::BadAfterRef));
    assert_eq!(verify(&a(u64::MAX)), Err(Error::BadAfterRef));
}

#[test]
fn recipients_must_sum_to_exactly_10000() {
    let with = |r: &[([u8; 32], u16)]| {
        graph_prog(
            None,
            r,
            &[(
                gnode(trigger::EVERY, 600, action::DISTRIBUTE_SOL, 1, 0),
                vec![],
            )],
        )
    };
    assert_eq!(verify(&with(&[(R1, 10_000)])), Ok(()));
    assert_eq!(verify(&with(&[(R1, 1), (R2, 9_999)])), Ok(()));
    assert_eq!(
        verify(&with(&[(R1, 1), (R2, 9_998)])),
        Err(Error::BadRecipientBps)
    );
    assert_eq!(verify(&with(&[(R1, 10_001)])), Err(Error::BadRecipientBps));
    assert_eq!(
        verify(&with(&[(R1, 5_000), (R2, 5_000), (R3, 0)])),
        Err(Error::ZeroRecipientBps)
    );
    // Eight recipients.
    let eight: Vec<([u8; 32], u16)> = (1..=8u8).map(|i| ([i; 32], 1_250)).collect();
    assert_eq!(verify(&with(&eight)), Ok(()));
    // Duplicates anywhere in the list.
    let mut dup = eight.clone();
    dup[7].0 = [1; 32];
    assert_eq!(verify(&with(&dup)), Err(Error::DuplicateRecipient));
    let mut zero = eight;
    zero[7].0 = [0; 32];
    assert_eq!(verify(&with(&zero)), Err(Error::ZeroRecipient));
}

#[test]
fn operator_iff_gated_node() {
    let mut gated = gnode(trigger::WHEN, 0, action::BURN, 1, 0);
    gated.operator_gated = 1;
    let cond = vec![leaf(op::graph::GRADUATED, 0, 0)];
    assert_eq!(
        verify(&graph_prog(Some(OP), &[], &[(gated, cond.clone())])),
        Ok(())
    );
    assert_eq!(
        verify(&graph_prog(
            Some(OP),
            &[],
            &[(gnode(trigger::WHEN, 0, action::BURN, 1, 0), cond.clone())]
        )),
        Err(Error::OperatorUnused)
    );
    assert_eq!(
        verify(&graph_prog(None, &[], &[(gated, cond)])),
        Err(Error::GatedWithoutOperator)
    );
}

#[test]
fn after_cycles_are_refused_wherever_they_are() {
    // A 16-node cycle: 0 -> 1 -> ... -> 15 -> 0.
    let nodes: Vec<(GNode, Vec<Node>)> = (0..16u64)
        .map(|i| {
            (
                gnode(trigger::AFTER, (i + 1) % 16, action::BURN, 1, 0),
                vec![],
            )
        })
        .collect();
    assert_eq!(
        verify(&graph_prog(None, &[], &nodes)),
        Err(Error::AfterCycle)
    );
    // A cycle that does not include node 0, reached from a tail.
    let nodes = vec![
        (gnode(trigger::AFTER, 1, action::BURN, 1, 0), vec![]),
        (gnode(trigger::AFTER, 2, action::BURN, 1, 0), vec![]),
        (gnode(trigger::AFTER, 1, action::BURN, 1, 0), vec![]),
    ];
    assert_eq!(
        verify(&graph_prog(None, &[], &nodes)),
        Err(Error::AfterCycle)
    );
}

#[test]
fn after_acyclic_helper() {
    let chain = |i: usize| if i == 0 { None } else { Some(i - 1) };
    assert!(after_acyclic(16, chain));
    assert!(after_acyclic(0, chain));
    assert!(after_acyclic(1, |_| None));
    assert!(!after_acyclic(1, |_| Some(0)), "a node after itself");
    assert!(!after_acyclic(2, |i| Some(1 - i)));
    assert!(
        !after_acyclic(3, |i| if i == 2 { Some(3) } else { None }),
        "out of range"
    );
    assert!(!after_acyclic(16, |i| Some((i + 1) % 16)));
    // A long tail into a cycle at the end.
    assert!(!after_acyclic(16, |i| Some(if i == 15 {
        14
    } else {
        i + 1
    })));
    // A tree: every node after node 0.
    assert!(after_acyclic(16, |i| if i == 0 { None } else { Some(0) }));
}

// --------------------------------------------------------------- leaves ---

#[test]
fn treasury_leaves() {
    let c = GraphCtx {
        treasury_sol: 1_000,
        treasury_token: 50,
        ..gctx()
    };
    assert!(holds(&[leaf(op::graph::TREASURY_SOL_GTE, 0, 1_000)], &c));
    assert!(!holds(&[leaf(op::graph::TREASURY_SOL_GTE, 0, 1_001)], &c));
    assert!(holds(&[leaf(op::graph::TREASURY_TOKEN_GTE, 0, 50)], &c));
    assert!(!holds(&[leaf(op::graph::TREASURY_TOKEN_GTE, 0, 51)], &c));
    // Each looks at its own balance.
    assert!(!holds(&[leaf(op::graph::TREASURY_TOKEN_GTE, 0, 1_000)], &c));
    assert!(holds(
        &[leaf(op::graph::TREASURY_SOL_GTE, 0, 0)],
        &GraphCtx {
            treasury_sol: 0,
            ..gctx()
        }
    ));
}

#[test]
fn graduated_leaf() {
    assert!(holds(
        &[leaf(op::graph::GRADUATED, 0, 0)],
        &GraphCtx {
            graduated: true,
            ..gctx()
        }
    ));
    assert!(!holds(
        &[leaf(op::graph::GRADUATED, 0, 0)],
        &GraphCtx {
            graduated: false,
            ..gctx()
        }
    ));
}

#[test]
fn price_leaves() {
    let c = |p: u128| GraphCtx {
        sqrt_price: p,
        ..gctx()
    };
    let lte = |x: u64| [leaf(op::graph::PRICE_LTE, 0, x)];
    let gte = |x: u64| [leaf(op::graph::PRICE_GTE, 0, x)];
    assert!(holds(&lte(500), &c(500)));
    assert!(!holds(&lte(500), &c(501)));
    assert!(holds(&gte(500), &c(500)));
    assert!(!holds(&gte(500), &c(499)));
    // Prices above u64 compare as such.
    assert!(!holds(&lte(u64::MAX), &c(1 << 64)));
    assert!(holds(&gte(u64::MAX), &c(1 << 64)));
    assert!(holds(&gte(u64::MAX), &c(u128::MAX)));
    assert!(holds(&lte(0), &c(0)));
}

#[test]
fn time_leaves() {
    let c = |now: i64| GraphCtx { now, ..gctx() };
    let ge = |x: u64| [leaf(op::graph::TIME_GE, 0, x)];
    let lt = |x: u64| [leaf(op::graph::TIME_LT, 0, x)];
    assert!(holds(&ge(1_800_000_000), &c(1_800_000_000)));
    assert!(!holds(&ge(1_800_000_000), &c(1_799_999_999)));
    assert!(holds(&lt(1_800_000_000), &c(1_799_999_999)));
    assert!(!holds(&lt(1_800_000_000), &c(1_800_000_000)));
    // A clock before 1970 is before every bound.
    assert!(holds(&lt(0), &c(-1)));
    assert!(!holds(&ge(0), &c(-1)));
    assert!(holds(&ge(i64::MAX as u64), &c(i64::MAX)));
}

#[test]
fn runs_in_epoch_leaf() {
    let p = graph_prog(
        None,
        &[],
        &[
            (
                gnode(trigger::WHEN, 0, action::BURN, 1, 0),
                vec![leaf(op::graph::RUNS_IN_EPOCH_LT, 1, 3)],
            ),
            (gnode(trigger::EVERY, 600, action::BURN, 1, 0), vec![]),
        ],
    );
    let bytes = genc(&p);
    let g = Graph::verify(&bytes).unwrap();
    let mut c = gctx();
    c.runs_in_epoch[1] = 2;
    assert_eq!(g.condition(0, &c), Some(true));
    c.runs_in_epoch[1] = 3;
    assert_eq!(g.condition(0, &c), Some(false));
    c.runs_in_epoch[0] = 0;
    c.runs_in_epoch[1] = u16::MAX;
    assert_eq!(g.condition(0, &c), Some(false), "it reads node a's runs");
    assert_eq!(g.condition(1, &c), Some(true), "no condition");
    assert_eq!(g.condition(2, &c), None, "no such node");
}

#[test]
fn malformed_graph_conditions_fail_closed() {
    let mut p = simple_graph();
    p.cond[0] = AND;
    let bytes = genc(&p);
    let g = Graph::parse(&bytes).unwrap();
    assert_eq!(g.condition(0, &gctx()), None);
    let states = [NodeState::default()];
    assert_eq!(g.runnable(0, &states, &gctx()), Err(NotDue::Malformed));
    // A leaf naming a node past the context's array.
    let mut p = simple_graph();
    p.cond[0] = leaf(op::graph::RUNS_IN_EPOCH_LT, 200, 1);
    let bytes = genc(&p);
    let g = Graph::parse(&bytes).unwrap();
    assert_eq!(g.condition(0, &gctx()), None);
    // Seventeen values on the stack, and two values left.
    for cond in [[vec![T; 17], vec![AND; 16]].concat(), vec![T, F]] {
        let mut p = simple_graph();
        p.nodes[0].cond_len = cond.len() as u8;
        p.cond = cond;
        let bytes = genc(&p);
        let g = Graph::parse(&bytes).unwrap();
        assert_eq!(g.condition(0, &gctx()), None);
    }
    // Unknown trigger.
    let mut p = simple_graph();
    p.nodes[0].trigger = 9;
    let bytes = genc(&p);
    let g = Graph::parse(&bytes).unwrap();
    assert_eq!(g.due(0, &states, 0, true), Err(NotDue::Malformed));
}

// ------------------------------------------------------------- due-ness ---

fn one_node(trig: u8, targ: u64) -> GraphProgram {
    let mut n = gnode(trig, targ, action::BURN, 100, 0);
    n.max_runs_per_epoch = 2;
    n.budget_per_epoch = 1_000;
    n.epoch_secs = 3_600;
    let cond = if trig == trigger::WHEN {
        vec![leaf(op::graph::GRADUATED, 0, 0)]
    } else {
        vec![]
    };
    graph_prog(None, &[], &[(n, cond)])
}

#[test]
fn every_is_due_once_its_period_passed() {
    let bytes = genc(&one_node(trigger::EVERY, 600));
    let g = Graph::verify(&bytes).unwrap();
    let st = [NodeState {
        last_run: 10_000,
        last_seq: 4,
        epoch_start: 10_000,
        runs_in_epoch: 1,
        spent_in_epoch: 0,
    }];
    assert_eq!(g.due(0, &st, 10_599, false), Err(NotDue::Waiting));
    assert_eq!(g.due(0, &st, 10_600, false), Ok(()));
    // Never run: due at once (now >= 0 + period).
    assert_eq!(g.due(0, &[NodeState::default()], 600, false), Ok(()));
    assert_eq!(
        g.due(0, &[NodeState::default()], 599, false),
        Err(NotDue::Waiting)
    );
    // A huge period never overflows: last_run + period is exact.
    let bytes = genc(&one_node(trigger::EVERY, u64::MAX));
    let g = Graph::verify(&bytes).unwrap();
    assert_eq!(g.due(0, &st, i64::MAX, false), Err(NotDue::Waiting));
    assert_eq!(
        g.due(0, &[NodeState::default()], i64::MAX, false),
        Err(NotDue::Waiting)
    );
    let early = [NodeState {
        last_run: i64::MIN,
        ..NodeState::default()
    }];
    assert_eq!(g.due(0, &early, i64::MAX - 1, false), Err(NotDue::Waiting));
    assert_eq!(
        g.due(0, &early, i64::MAX, false),
        Ok(()),
        "i64::MIN + 2^64 - 1 = i64::MAX"
    );
}

#[test]
fn after_is_due_once_per_parent_success() {
    let p = graph_prog(
        None,
        &[],
        &[
            (gnode(trigger::EVERY, 600, action::BURN, 1, 0), vec![]),
            (gnode(trigger::AFTER, 0, action::BURN, 1, 0), vec![]),
        ],
    );
    let bytes = genc(&p);
    let g = Graph::verify(&bytes).unwrap();
    let st = |parent: u64, me: u64| {
        [
            NodeState {
                last_seq: parent,
                ..NodeState::default()
            },
            NodeState {
                last_seq: me,
                ..NodeState::default()
            },
        ]
    };
    assert_eq!(g.due(1, &st(0, 0), 0, false), Err(NotDue::AwaitingParent));
    assert_eq!(g.due(1, &st(1, 0), 0, false), Ok(()));
    assert_eq!(g.due(1, &st(5, 6), 0, false), Err(NotDue::AwaitingParent));
    assert_eq!(g.due(1, &st(6, 6), 0, false), Err(NotDue::AwaitingParent));
    assert_eq!(g.due(1, &st(7, 6), 0, false), Ok(()));
    // Missing states.
    assert_eq!(g.due(1, &st(7, 6)[..1], 0, false), Err(NotDue::NoSuchNode));
    assert_eq!(g.due(2, &st(7, 6), 0, false), Err(NotDue::NoSuchNode));
}

#[test]
fn on_graduated_runs_once_after_graduation() {
    let bytes = genc(&one_node(trigger::ON_GRADUATED, 0));
    let g = Graph::verify(&bytes).unwrap();
    let never = [NodeState::default()];
    let ran = [NodeState {
        last_seq: 1,
        ..NodeState::default()
    }];
    assert_eq!(g.due(0, &never, 0, false), Err(NotDue::NotGraduated));
    assert_eq!(g.due(0, &never, 0, true), Ok(()));
    assert_eq!(g.due(0, &ran, 0, true), Err(NotDue::AlreadyRan));
    assert_eq!(g.due(0, &ran, 0, false), Err(NotDue::AlreadyRan));
}

#[test]
fn when_depends_on_its_condition_only() {
    let bytes = genc(&one_node(trigger::WHEN, 0));
    let g = Graph::verify(&bytes).unwrap();
    let st = [NodeState::default()];
    assert_eq!(g.due(0, &st, 0, false), Ok(()));
    assert_eq!(
        g.runnable(
            0,
            &st,
            &GraphCtx {
                graduated: true,
                ..gctx()
            }
        ),
        Ok(())
    );
    assert_eq!(
        g.runnable(
            0,
            &st,
            &GraphCtx {
                graduated: false,
                ..gctx()
            }
        ),
        Err(NotDue::ConditionFalse)
    );
}

#[test]
fn run_limit_and_budget_per_epoch() {
    let bytes = genc(&one_node(trigger::WHEN, 0));
    let g = Graph::verify(&bytes).unwrap();
    let st = |runs: u16, spent: u64| {
        [NodeState {
            epoch_start: 7_200,
            runs_in_epoch: runs,
            spent_in_epoch: spent,
            ..NodeState::default()
        }]
    };
    // max 2 runs and a budget of 1,000 per hour.
    assert_eq!(g.due(0, &st(1, 999), 7_200, false), Ok(()));
    assert_eq!(
        g.due(0, &st(2, 0), 7_200, false),
        Err(NotDue::MaxRunsReached)
    );
    assert_eq!(
        g.due(0, &st(0, 1_000), 7_200, false),
        Err(NotDue::BudgetSpent)
    );
    // Still the same epoch one second before its end, a fresh one at it.
    assert_eq!(
        g.due(0, &st(2, 1_000), 10_799, false),
        Err(NotDue::MaxRunsReached)
    );
    assert_eq!(g.due(0, &st(2, 1_000), 10_800, false), Ok(()));
    // The trigger is checked first.
    let bytes = genc(&one_node(trigger::ON_GRADUATED, 0));
    let g = Graph::verify(&bytes).unwrap();
    assert_eq!(
        g.due(0, &st(2, 1_000), 7_200, false),
        Err(NotDue::NotGraduated)
    );
    assert_eq!(
        g.due(0, &st(2, 1_000), 7_200, true),
        Err(NotDue::MaxRunsReached)
    );
}

#[test]
fn run_cap_is_the_rest_of_the_budget_up_to_p1() {
    let bytes = genc(&one_node(trigger::WHEN, 0));
    let g = Graph::verify(&bytes).unwrap();
    let st = |spent: u64| NodeState {
        epoch_start: 0,
        spent_in_epoch: spent,
        ..NodeState::default()
    };
    assert_eq!(g.run_cap(0, &st(0), 0), 100);
    assert_eq!(g.run_cap(0, &st(950), 0), 50);
    assert_eq!(g.run_cap(0, &st(1_000), 0), 0);
    assert_eq!(g.run_cap(0, &st(u64::MAX), 0), 0);
    assert_eq!(g.run_cap(0, &st(1_000), 3_600), 100, "new epoch");
    assert_eq!(g.run_cap(1, &st(0), 0), 0, "no such node");
}

#[test]
fn epochs_roll_over_aligned_to_the_first() {
    let st = NodeState {
        epoch_start: 1_000,
        runs_in_epoch: 3,
        spent_in_epoch: 77,
        ..NodeState::default()
    };
    let same = Epoch {
        start: 1_000,
        runs: 3,
        spent: 77,
    };
    assert_eq!(current_epoch(3_600, &st, 1_000), same);
    assert_eq!(current_epoch(3_600, &st, 4_599), same);
    assert_eq!(
        current_epoch(3_600, &st, 4_600),
        Epoch {
            start: 4_600,
            runs: 0,
            spent: 0
        }
    );
    assert_eq!(
        current_epoch(3_600, &st, 1_000 + 3 * 3_600 + 5),
        Epoch {
            start: 1_000 + 3 * 3_600,
            runs: 0,
            spent: 0
        }
    );
    // A clock before the epoch keeps it.
    assert_eq!(current_epoch(3_600, &st, 999), same);
    assert_eq!(current_epoch(3_600, &st, i64::MIN), same);
    // Extremes never overflow; a zero length (never verified) acts as 1.
    let far = NodeState {
        epoch_start: i64::MIN,
        ..st
    };
    let e = current_epoch(u32::MAX, &far, i64::MAX);
    assert!(e.start > i64::MAX - u32::MAX as i64);
    assert_eq!((e.runs, e.spent), (0, 0));
    assert_eq!(
        current_epoch(0, &st, 1_001),
        Epoch {
            start: 1_001,
            runs: 0,
            spent: 0
        }
    );
    // First run of a fresh node: epochs counted from 0.
    let e = current_epoch(86_400, &NodeState::default(), 1_800_000_123);
    assert_eq!(e.start, 1_800_000_123 - 1_800_000_123 % 86_400);
}

#[test]
fn runs_in_epoch_from_states() {
    let bytes = genc(&graph_base());
    let g = Graph::verify(&bytes).unwrap();
    let states: Vec<NodeState> = (0..5)
        .map(|i| NodeState {
            epoch_start: 0,
            runs_in_epoch: i + 1,
            ..NodeState::default()
        })
        .collect();
    let runs = g.runs_in_epoch(&states, 100);
    assert_eq!(&runs[..6], &[1, 2, 3, 4, 5, 0]);
    // A day later every epoch (one day long) rolled over.
    assert_eq!(g.runs_in_epoch(&states, 86_400), [0; 16]);
    // Fewer states than nodes: zeros.
    assert_eq!(&g.runs_in_epoch(&states[..2], 100)[..3], &[1, 2, 0]);
}

#[test]
fn shares_floor_and_keep_the_dust() {
    let p = graph_prog(
        None,
        &[(R1, 3_333), (R2, 3_333), (R3, 3_334)],
        &[(
            gnode(trigger::EVERY, 600, action::DISTRIBUTE_SOL, 1, 0),
            vec![],
        )],
    );
    let bytes = genc(&p);
    let g = Graph::verify(&bytes).unwrap();
    let s = g.shares(10_000);
    assert_eq!(&s[..4], &[3_333, 3_333, 3_334, 0]);
    let s = g.shares(10);
    assert_eq!(&s[..3], &[3, 3, 3], "1 lamport of dust stays");
    let s = g.shares(u64::MAX);
    assert!(s.iter().map(|&x| x as u128).sum::<u128>() <= u64::MAX as u128);
    assert_eq!(s[2], ((u64::MAX as u128 * 3_334) / 10_000) as u64);
    assert_eq!(
        Graph::verify(&genc(&simple_graph())).unwrap().shares(5),
        [0; 8]
    );
}

#[test]
fn not_due_names_round_trip() {
    for n in NotDue::ALL {
        assert_eq!(NotDue::from_name(n.name()), Some(*n));
    }
    assert_eq!(NotDue::ALL.len(), 9);
}

// ------------------------------- conditions over a price range (review F1)

/// Whether `cond` holds over `prices` (as the condition of a WHEN node).
fn holds_over(cond: &[Node], c: &GraphCtx, prices: PriceRange) -> bool {
    let p = graph_prog(
        None,
        &[],
        &[(gnode(trigger::WHEN, 0, action::BURN, 1, 0), cond.to_vec())],
    );
    let bytes = genc(&p);
    let g = Graph::verify(&bytes).expect("valid");
    g.condition_over(0, c, prices).expect("verified")
}

/// A price condition over a range holds only if it holds at every price of
/// it: "at least" on the lowest, "at most" on the highest, and under NOT the
/// other end. Other leaves are as at one price.
#[test]
fn price_leaves_over_a_range() {
    let c = gctx();
    let r = |low: u128, high: u128| PriceRange { low, high };
    let gte = [leaf(op::graph::PRICE_GTE, 0, 500)];
    let lte = [leaf(op::graph::PRICE_LTE, 0, 500)];
    let not = leaf(op::NOT, 0, 0);
    // PRICE_GTE: the lowest price decides.
    assert!(holds_over(&gte, &c, r(500, 900)));
    assert!(!holds_over(&gte, &c, r(499, 900)));
    // PRICE_LTE: the highest.
    assert!(holds_over(&lte, &c, r(100, 500)));
    assert!(!holds_over(&lte, &c, r(100, 501)));
    // NOT PRICE_GTE ("below"): the highest must be below.
    assert!(holds_over(&[gte[0], not], &c, r(100, 499)));
    assert!(!holds_over(&[gte[0], not], &c, r(100, 500)));
    // NOT PRICE_LTE ("above"): the lowest must be above.
    assert!(holds_over(&[lte[0], not], &c, r(501, 900)));
    assert!(!holds_over(&[lte[0], not], &c, r(500, 900)));
    // Double negation is the leaf again.
    assert!(holds_over(&[gte[0], not, not], &c, r(500, 900)));
    assert!(!holds_over(&[gte[0], not, not], &c, r(499, 900)));
    // AND of both ends: inside [400, 600] means both hold.
    let inside = [
        leaf(op::graph::PRICE_GTE, 0, 400),
        leaf(op::graph::PRICE_LTE, 0, 600),
        leaf(op::AND, 0, 0),
    ];
    assert!(holds_over(&inside, &c, r(400, 600)));
    assert!(!holds_over(&inside, &c, r(399, 600)));
    assert!(!holds_over(&inside, &c, r(400, 601)));
    // Conservative, never permissive: "at least 500 or below 500" holds at
    // every single price, but not over a range that straddles 500.
    let either = [gte[0], gte[0], not, leaf(op::OR, 0, 0)];
    assert!(holds_over(&either, &c, PriceRange::at(499)));
    assert!(holds_over(&either, &c, PriceRange::at(500)));
    assert!(!holds_over(&either, &c, r(499, 500)));
    // Other leaves do not depend on the range.
    let rich = [leaf(op::graph::TREASURY_SOL_GTE, 0, c.treasury_sol)];
    assert!(holds_over(&rich, &c, r(0, u128::MAX)));
    assert!(holds_over(
        &[rich[0], gte[0], leaf(op::OR, 0, 0)],
        &c,
        r(0, 1)
    ));
    // Prices above u64 compare as such.
    let top = [leaf(op::graph::PRICE_LTE, 0, u64::MAX)];
    assert!(!holds_over(&top, &c, r(0, 1 << 64)));
    assert!(holds_over(&top, &c, r(0, u64::MAX as u128)));
}

/// The leaf-wise rule review F1 asks for, as a reference: PRICE_GTE on the
/// low end of the range, PRICE_LTE on the high end, every other leaf as at
/// one price (exact for conditions without NOT).
fn leafwise(c: &GraphCtx, prices: PriceRange, n: &Node) -> Option<bool> {
    match n.op {
        op::graph::PRICE_GTE => Some(prices.low >= u128::from(n.arg)),
        op::graph::PRICE_LTE => Some(prices.high <= u128::from(n.arg)),
        _ => ref_graph_leaf(c, n),
    }
}

/// On random graphs, contexts and ranges: a condition over a range holds
/// only if it holds at every price of the range (both ends, the middle and
/// a random price in it), widening the range never makes it hold, a single
/// price is `condition` at that price, and without NOT it is the leaf-wise
/// rule. `runnable_over` is `due` then `condition_over`.
#[test]
fn conditions_over_a_range_are_sound_monotone_and_exact_at_one_price() {
    let mut rng = Rng::new(0x00F1_00F1);
    let (mut held, mut refused, mut differs) = (0usize, 0usize, 0usize);
    for _ in 0..20_000 {
        let p = gen_graph(&mut rng);
        let bytes = genc(&p);
        let g = Graph::verify(&bytes).expect("valid by construction");
        let c = gen_gctx(&mut rng, &p);
        let args: Vec<u128> = p.cond.iter().map(|n| u128::from(n.arg)).collect();
        let price = |rng: &mut Rng| -> u128 {
            if !args.is_empty() && !rng.one_in(4) {
                rng.pick(&args)
                    .saturating_add(u128::from(rng.below(3)))
                    .saturating_sub(1)
            } else {
                u128::from(rng.wide())
            }
        };
        let (a, b) = (price(&mut rng), price(&mut rng));
        let range = PriceRange {
            low: a.min(b),
            high: a.max(b),
        };
        let states = gen_states(&mut rng, p.nodes.len());
        for i in 0..p.nodes.len() {
            let over = g.condition_over(i, &c, range).expect("verified");
            // One price: `condition`.
            assert_eq!(
                g.condition_over(i, &c, PriceRange::at(c.sqrt_price)),
                g.condition(i, &c)
            );
            // Sound: it holds at every price of the range.
            if over {
                held += 1;
                let span = range.high - range.low;
                let inside = range.low
                    + if span == 0 {
                        0
                    } else {
                        u128::from(rng.wide()) % span
                    };
                for q in [range.low, range.high, range.low + span / 2, inside] {
                    let at = GraphCtx { sqrt_price: q, ..c };
                    assert_eq!(g.condition(i, &at), Some(true), "node {i} at {q}");
                }
            } else {
                refused += 1;
            }
            // Monotone: a wider range never holds where this one does not.
            let wider = PriceRange {
                low: range.low.saturating_sub(u128::from(rng.below(1_000))),
                high: range.high.saturating_add(u128::from(rng.below(1_000))),
            };
            if g.condition_over(i, &c, wider).expect("verified") {
                assert!(over, "node {i}: a wider range holds, the narrower does not");
            }
            // Without NOT: the leaf-wise rule, exactly.
            let n = p.nodes[i];
            let start = n.cond_off as usize;
            let cond = &p.cond[start..start + n.cond_len as usize];
            if !cond.iter().any(|x| x.op == op::NOT) {
                let want = if cond.is_empty() {
                    Some(true)
                } else {
                    ref_eval(cond, &|x| leafwise(&c, range, x))
                };
                assert_eq!(Some(over), want, "node {i}");
            }
            if Some(over) != g.condition(i, &c) {
                differs += 1;
            }
            // runnable_over = due, then condition_over.
            let want = g.due(i, &states, c.now, c.graduated).and(if over {
                Ok(())
            } else {
                Err(NotDue::ConditionFalse)
            });
            assert_eq!(g.runnable_over(i, &states, &c, range), want);
        }
    }
    assert!(
        held > 1_000 && refused > 1_000 && differs > 1_000,
        "{held} {refused} {differs}"
    );
}

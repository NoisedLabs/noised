//! Named valid and invalid programs: each invalid one is a valid program
//! with exactly one defect (or two, for the precedence cases), so each
//! verifier check has an input that only that check rejects.

use super::*;
use noised_rules::graph::{action, trigger, MAX_PREMIUM_BPS};
use noised_rules::rules::effect;
use noised_rules::Error;

pub struct Invalid {
    pub name: &'static str,
    pub guard: u32,
    pub bytes: Vec<u8>,
    pub error: Error,
}

pub struct Valid<P> {
    pub name: String,
    pub guard: u32,
    pub program: P,
}

const K1: [u8; 32] = [0x11; 32];
const K2: [u8; 32] = [0x22; 32];
const K3: [u8; 32] = [0x33; 32];

/// The base of most invalid rule sets: two keys, three rules, every effect.
pub fn rules_base() -> RulesProgram {
    rules_prog(
        &[K1, K2],
        &[
            deny(0, 120, 1, &[is_buy(), src_in(0b01), AND]),
            cap_amount(0, 3_600, 2, 1_000_000, &[dest_in(0b10)]),
            cap_balance(60, 86_400, 3, bps(100), &[is_buy(), time_lt(600), AND]),
        ],
    )
}

fn with(f: impl FnOnce(&mut RulesProgram)) -> Vec<u8> {
    let mut p = rules_base();
    f(&mut p);
    enc(&p)
}

fn with_bytes(f: impl FnOnce(&mut Vec<u8>)) -> Vec<u8> {
    let mut b = enc(&rules_base());
    f(&mut b);
    b
}

/// A rule set whose only rule has condition `cond`.
fn one(cond: &[Node]) -> Vec<u8> {
    enc(&rules_prog(
        &[K1, K2],
        &[deny(0, 600, 9, &[cond, &[src_in(0b11), OR]].concat())],
    ))
}

pub fn rules_invalid() -> Vec<Invalid> {
    let g = GUARD;
    let mut v = Vec::new();
    let mut add = |name: &'static str, guard: u32, bytes: Vec<u8>, error: Error| {
        v.push(Invalid {
            name,
            guard,
            bytes,
            error,
        })
    };
    // Layout.
    add("empty input", g, vec![], Error::TooShort);
    add(
        "11 bytes",
        g,
        enc(&rules_base())[..11].to_vec(),
        Error::TooShort,
    );
    add(
        "graph magic",
        g,
        with_bytes(|b| b[..4].copy_from_slice(b"PXG1")),
        Error::BadMagic,
    );
    add(
        "lowercase magic",
        g,
        with_bytes(|b| b[..4].copy_from_slice(b"pxr1")),
        Error::BadMagic,
    );
    add(
        "magic PXR2",
        g,
        with_bytes(|b| b[3] = b'2'),
        Error::BadMagic,
    );
    add("version 0", g, with_bytes(|b| b[4] = 0), Error::BadVersion);
    add("version 2", g, with_bytes(|b| b[4] = 2), Error::BadVersion);
    add(
        "reserved byte 8 set",
        g,
        with_bytes(|b| b[8] = 1),
        Error::ReservedNonZero,
    );
    add(
        "reserved byte 11 set",
        g,
        with_bytes(|b| b[11] = 0x80),
        Error::ReservedNonZero,
    );
    add(
        "9 keys",
        g,
        with(|p| {
            p.keys = (1..=9).map(|i| [i; 32]).collect();
        }),
        Error::TooManyKeys,
    );
    add("no rules", g, with(|p| p.rules.clear()), Error::NoRules);
    add(
        "17 rules",
        g,
        enc(&rules_prog(&[], &vec![deny(0, 10, 1, &[T]); 17])),
        Error::TooManyRules,
    );
    add(
        "65 nodes",
        g,
        enc(&rules_prog(
            &[],
            &[
                deny(0, 10, 1, &[T]),
                deny(0, 10, 1, &[[F; 32].as_slice(), &[AND; 32]].concat()),
            ],
        )),
        Error::TooManyNodes,
    );
    add(
        "one byte short",
        g,
        with_bytes(|b| {
            b.pop();
        }),
        Error::BadLength,
    );
    add(
        "one byte extra",
        g,
        with_bytes(|b| b.push(0)),
        Error::BadLength,
    );
    add(
        "node count one too high",
        g,
        with_bytes(|b| b[7] += 1),
        Error::BadLength,
    );
    // Keys.
    add("zero key", g, with(|p| p.keys[1] = [0; 32]), Error::ZeroKey);
    add(
        "duplicate key",
        g,
        with(|p| p.keys[1] = K1),
        Error::DuplicateKey,
    );
    add("unused key", g, with(|p| p.keys.push(K3)), Error::UnusedKey);
    // Rules.
    add(
        "empty window",
        g,
        with(|p| p.rules[1].from_rel = 3_600),
        Error::BadWindow,
    );
    add(
        "reversed window",
        g,
        with(|p| p.rules[0].from_rel = 121),
        Error::BadWindow,
    );
    add(
        "window past the guard",
        86_399,
        enc(&rules_base()),
        Error::WindowPastGuard,
    );
    add(
        "window past 72 h with a longer guard",
        300_000,
        with(|p| p.rules[2].to_rel = 259_201),
        Error::WindowPastGuard,
    );
    add("code 64", g, with(|p| p.rules[1].code = 64), Error::BadCode);
    add(
        "code 255",
        g,
        with(|p| p.rules[0].code = 255),
        Error::BadCode,
    );
    add(
        "effect 0",
        g,
        with(|p| p.rules[0].effect = 0),
        Error::UnknownEffect,
    );
    add(
        "effect 4",
        g,
        with(|p| p.rules[2].effect = 4),
        Error::UnknownEffect,
    );
    add(
        "deny with an argument",
        g,
        with(|p| p.rules[0].arg = 1),
        Error::DenyArgNonZero,
    );
    add(
        "cap of zero",
        g,
        with(|p| p.rules[1].arg = 0),
        Error::ZeroCap,
    );
    add(
        "cap of 0 bps",
        g,
        with(|p| p.rules[2].arg = bps(0)),
        Error::BadBps,
    );
    add(
        "cap of 10001 bps",
        g,
        with(|p| p.rules[2].arg = bps(10_001)),
        Error::BadBps,
    );
    add(
        "cap bps with bit 16 set",
        g,
        with(|p| p.rules[1].arg = bps(100) | 1 << 16),
        Error::BadBps,
    );
    add(
        "leaf bps with bit 62 set",
        g,
        one(&[amount_gt(bps(5) | 1 << 62)]),
        Error::BadBps,
    );
    add("leaf bps 0", g, one(&[dest_bal_gt(bps(0))]), Error::BadBps);
    // Condition placement.
    add(
        "empty condition",
        g,
        with(|p| {
            p.rules[1].cond_len = 0;
            p.nodes.remove(3);
            p.rules[2].cond_off -= 1;
        }),
        Error::EmptyCondition,
    );
    add(
        "empty condition at another offset",
        g,
        with(|p| {
            p.rules[1].cond_len = 0;
            p.rules[1].cond_off = 0;
            p.nodes.remove(3);
            p.rules[2].cond_off -= 1;
        }),
        Error::EmptyCondition,
    );
    add(
        "condition starts late",
        g,
        with(|p| p.rules[0].cond_off = 1),
        Error::ConditionNotContiguous,
    );
    add(
        "conditions overlap",
        g,
        with(|p| {
            p.rules[1].cond_off = 2;
            p.rules[1].cond_len = 2;
        }),
        Error::ConditionNotContiguous,
    );
    add(
        "condition past the nodes",
        g,
        with(|p| p.rules[2].cond_len = 4),
        Error::ConditionOutOfRange,
    );
    add(
        "unreferenced trailing node",
        g,
        with(|p| p.nodes.push(T)),
        Error::UnreferencedNode,
    );
    // Condition nodes.
    add("op 0x05", g, one(&[leaf(0x05, 0, 0)]), Error::UnknownOp);
    add("op 0x0f", g, one(&[leaf(0x0F, 0, 0)]), Error::UnknownOp);
    add("op 0x1a", g, one(&[leaf(0x1A, 0, 0)]), Error::UnknownOp);
    add(
        "graph leaf in rules",
        g,
        one(&[leaf(op::graph::GRADUATED, 0, 0)]),
        Error::UnknownOp,
    );
    add(
        "TRUE with a",
        g,
        one(&[leaf(op::TRUE, 1, 0)]),
        Error::NonZeroOperand,
    );
    add(
        "FALSE with arg",
        g,
        one(&[leaf(op::FALSE, 0, 1)]),
        Error::NonZeroOperand,
    );
    add(
        "AND with arg",
        g,
        one(&[T, T, leaf(op::AND, 0, 1)]),
        Error::NonZeroOperand,
    );
    add(
        "OR with a",
        g,
        one(&[T, T, leaf(op::OR, 1, 0)]),
        Error::NonZeroOperand,
    );
    add(
        "NOT with a",
        g,
        one(&[T, leaf(op::NOT, 1, 0)]),
        Error::NonZeroOperand,
    );
    add(
        "IS_BUY with a",
        g,
        one(&[leaf(op::rules::IS_BUY, 1, 0)]),
        Error::NonZeroOperand,
    );
    add(
        "IS_P2P with arg",
        g,
        one(&[leaf(op::rules::IS_P2P, 0, 1)]),
        Error::NonZeroOperand,
    );
    add(
        "TIME_LT with a",
        g,
        one(&[leaf(op::rules::TIME_LT, 1, 5)]),
        Error::NonZeroOperand,
    );
    add(
        "TIME_GE with a",
        g,
        one(&[leaf(op::rules::TIME_GE, 1, 5)]),
        Error::NonZeroOperand,
    );
    add(
        "AMOUNT_GT with a",
        g,
        one(&[leaf(op::rules::AMOUNT_GT, 1, 5)]),
        Error::NonZeroOperand,
    );
    add(
        "DEST_BAL_AFTER_GT with a",
        g,
        one(&[leaf(op::rules::DEST_BAL_AFTER_GT, 1, 5)]),
        Error::NonZeroOperand,
    );
    add(
        "TX_IX_COUNT_GT with a",
        g,
        one(&[leaf(op::rules::TX_IX_COUNT_GT, 1, 5)]),
        Error::NonZeroOperand,
    );
    add(
        "DEST_OWNER_IN with arg",
        g,
        one(&[leaf(op::rules::DEST_OWNER_IN, 1, 1)]),
        Error::NonZeroOperand,
    );
    add("empty key mask", g, one(&[dest_in(0)]), Error::BadKeyMask);
    add(
        "key mask names a missing key",
        g,
        one(&[top_in(0b100)]),
        Error::BadKeyMask,
    );
    add(
        "key mask with no keys",
        g,
        enc(&rules_prog(&[], &[deny(0, 10, 1, &[src_in(1)])])),
        Error::BadKeyMask,
    );
    add(
        "TIME_LT past the guard",
        600,
        one(&[time_lt(601)]),
        Error::TimeOutOfRange,
    );
    add(
        "TIME_GE past 72 h",
        300_000,
        one(&[time_ge(259_201)]),
        Error::TimeOutOfRange,
    );
    add("AND on one value", g, one(&[T, AND]), Error::StackUnderflow);
    add("NOT on nothing", g, one(&[NOT, T]), Error::StackUnderflow);
    add("OR first", g, one(&[OR]), Error::StackUnderflow);
    add(
        "17 values on the stack",
        g,
        one(&[[T; 17].as_slice(), &[AND; 16]].concat()),
        Error::StackOverflow,
    );
    add("two values left", g, one(&[T, F]), Error::LeftoverValues);
    // Precedence.
    add(
        "zero key before a bad window",
        g,
        with(|p| {
            p.keys[0] = [0; 32];
            p.rules[0].to_rel = 0;
        }),
        Error::ZeroKey,
    );
    add(
        "bad window before a bad code",
        g,
        with(|p| {
            p.rules[0].to_rel = 0;
            p.rules[0].code = 64;
        }),
        Error::BadWindow,
    );
    add(
        "earlier rule's error first",
        g,
        with(|p| {
            p.rules[0].code = 64;
            p.rules[1].effect = 9;
        }),
        Error::BadCode,
    );
    add(
        "operand before stack",
        g,
        one(&[leaf(op::AND, 0, 1)]),
        Error::NonZeroOperand,
    );
    add(
        "length before keys",
        g,
        with_bytes(|b| {
            b[12] = 0;
            b.push(0);
        }),
        Error::BadLength,
    );
    v
}

/// `push, (push, combine) * (n - 1)`: n leaves at stack depth 2.
fn chain(n: usize, push: Node, combine: Node) -> Vec<Node> {
    let mut c = vec![push];
    for _ in 1..n {
        c.extend([push, combine]);
    }
    c
}

/// `push * n, combine * (n - 1)`: n leaves at stack depth n.
fn ladder(n: usize, push: Node, combine: Node) -> Vec<Node> {
    let mut c = vec![push; n];
    c.extend(std::iter::repeat_n(combine, n - 1));
    c
}

/// The largest rule set: 8 keys, 16 rules, 64 nodes (1,228 bytes).
pub fn rules_max() -> RulesProgram {
    let keys: Vec<[u8; 32]> = (1..=8u8).map(|i| [i; 32]).collect();
    let rs: Vec<R> = (0..16u32)
        .map(|i| {
            let cond = match i % 4 {
                0 => vec![dest_in(0xFF), is_buy(), AND, NOT],
                1 => vec![
                    src_in(1 << (i % 8)),
                    time_lt(3_600 * (i as u64 + 1)),
                    AND,
                    NOT,
                ],
                2 => vec![top_in(0x81), amount_gt(bps(25)), OR, NOT],
                _ => vec![dest_bal_gt(1 << 40), ix_gt(i as u64), OR, NOT],
            };
            let effect = 1 + (i % 3) as u8;
            let arg = match effect {
                effect::DENY => 0,
                effect::CAP_AMOUNT => 1_000 * (i as u64 + 1),
                _ => bps(100 + i as u64),
            };
            R {
                from: 60 * i,
                to: 3_600 * (i + 1),
                effect,
                code: i as u8 * 4,
                arg,
                cond,
            }
        })
        .collect();
    rules_prog(&keys, &rs)
}

pub fn rules_valid() -> Vec<Valid<RulesProgram>> {
    let mut v = Vec::new();
    let mut add = |name: &str, guard: u32, program: RulesProgram| {
        v.push(Valid {
            name: name.to_string(),
            guard,
            program,
        })
    };
    let g = GUARD;
    add(
        "fair start: no buys for 2 minutes",
        g,
        rules_prog(&[], &[deny(0, 120, 1, &[is_buy()])]),
    );
    add(
        "anti-bot: no buys from transactions with more than 3 instructions in the first 5 minutes",
        g,
        rules_prog(&[], &[deny(0, 300, 2, &[is_buy(), ix_gt(3), AND])]),
    );
    add(
        "whale cap: buys up to 1% of supply in the first hour",
        g,
        rules_prog(&[], &[cap_amount(0, 3_600, 3, bps(100), &[is_buy()])]),
    );
    add(
        "max wallet 2% for a day",
        g,
        rules_prog(&[], &[cap_balance(0, 86_400, 4, bps(200), &[T])]),
    );
    add(
        "team wallets can't buy",
        g,
        rules_prog(&[K1, K2], &[deny(0, g, 5, &[is_buy(), dest_in(0b11), AND])]),
    );
    add(
        "team wallets can't send wallet to wallet",
        g,
        rules_prog(
            &[K1, K2, K3],
            &[deny(0, g, 6, &[is_p2p(), src_in(0b111), AND])],
        ),
    );
    add(
        "first 10 minutes: buys only through one router",
        g,
        rules_prog(&[K3], &[deny(0, 600, 7, &[is_buy(), top_in(1), NOT, AND])]),
    );
    add(
        "tiered buy caps",
        g,
        rules_prog(
            &[],
            &[
                cap_amount(0, 60, 8, 1_000, &[is_buy()]),
                cap_amount(60, 300, 9, 10_000, &[is_buy()]),
                cap_amount(300, 3_600, 10, 100_000, &[is_buy()]),
            ],
        ),
    );
    add(
        "time leaves inside one window",
        g,
        rules_prog(&[], &[deny(0, 1_000, 11, &[time_ge(5), time_lt(10), AND])]),
    );
    add(
        "deny buys into wallets above 0.5% of supply",
        g,
        rules_prog(
            &[],
            &[deny(0, 3_600, 12, &[dest_bal_gt(bps(50)), is_buy(), AND])],
        ),
    );
    add(
        "no transfers of any amount for one second",
        g,
        rules_prog(&[], &[deny(0, 1, 13, &[amount_gt(0)])]),
    );
    add(
        "or and not",
        g,
        rules_prog(
            &[K1],
            &[deny(
                10,
                20,
                14,
                &[is_buy(), is_p2p(), OR, src_in(1), NOT, AND],
            )],
        ),
    );
    add(
        "deepest stack: 16 values",
        g,
        rules_prog(&[], &[deny(0, 100, 15, &ladder(16, is_buy(), AND))]),
    );
    add(
        "widest disjunction",
        g,
        rules_prog(&[], &[deny(0, 100, 16, &chain(32, is_p2p(), OR))]),
    );
    add("largest rule set (1,228 bytes)", g, rules_max());
    add(
        "window ends exactly at the guard",
        86_400,
        rules_prog(&[], &[deny(0, 86_400, 17, &[is_buy()])]),
    );
    add(
        "guard over 72 hours is capped",
        300_000,
        rules_prog(&[], &[deny(259_199, 259_200, 18, &[T])]),
    );
    add(
        "8 keys, one per mask bit",
        g,
        rules_prog(
            &(1..=8u8).map(|i| [i; 32]).collect::<Vec<_>>(),
            &(0..8)
                .map(|i| deny(0, 600, 20 + i as u8, &[dest_in(1 << i)]))
                .collect::<Vec<_>>(),
        ),
    );
    add(
        "cap of 1 bps and of 10000 bps",
        g,
        rules_prog(
            &[],
            &[
                cap_amount(0, 600, 30, bps(1), &[T]),
                cap_balance(0, 600, 31, bps(10_000), &[F, NOT]),
            ],
        ),
    );
    add(
        "largest absolute caps and code 63",
        g,
        rules_prog(
            &[],
            &[
                cap_amount(0, 600, 63, (1 << 63) - 1, &[amount_gt((1 << 63) - 1)]),
                cap_balance(0, 600, 0, 1, &[ix_gt(u64::MAX)]),
            ],
        ),
    );
    add(
        "time bound equal to the guard",
        600,
        rules_prog(&[], &[deny(0, 600, 32, &[time_lt(600), time_ge(0), AND])]),
    );
    add("the base of the invalid cases", g, rules_base());
    // Random valid programs (seeded) complete the set.
    let mut rng = Rng::new(0x5058_5231);
    for i in 0..24 {
        let guard = rng.pick(&[60, 600, 3_600, 86_400, GUARD, 300_000]);
        let program = gen_rules(&mut rng, guard);
        add(&format!("random #{i}"), guard, program);
    }
    v
}

// ---------------------------------------------------------------- graph ---

pub const OP: [u8; 32] = [0x0A; 32];
pub const R1: [u8; 32] = [0xA1; 32];
pub const R2: [u8; 32] = [0xA2; 32];
pub const R3: [u8; 32] = [0xA3; 32];

fn tsol(x: u64) -> Node {
    leaf(op::graph::TREASURY_SOL_GTE, 0, x)
}

/// The base of most invalid graphs: an operator, two recipients, every
/// trigger and action.
pub fn graph_base() -> GraphProgram {
    let mut gated = gnode(trigger::WHEN, 0, action::BUYBACK_BURN, 1_000_000_000, 300);
    gated.operator_gated = 1;
    graph_prog(
        Some(OP),
        &[(R1, 6_000), (R2, 4_000)],
        &[
            (
                gnode(
                    trigger::EVERY,
                    86_400,
                    action::BUYBACK_BURN,
                    500_000_000,
                    300,
                ),
                vec![tsol(1_000_000_000)],
            ),
            (gnode(trigger::AFTER, 0, action::BURN, 1_000_000, 0), vec![]),
            (
                gnode(trigger::ON_GRADUATED, 0, action::BURN, u64::MAX, 0),
                vec![],
            ),
            (
                gnode(
                    trigger::EVERY,
                    7 * 86_400,
                    action::DISTRIBUTE_SOL,
                    2_000_000_000,
                    0,
                ),
                vec![],
            ),
            (
                gated,
                vec![
                    leaf(op::graph::PRICE_LTE, 0, 1 << 60),
                    leaf(op::graph::GRADUATED, 0, 0),
                    AND,
                ],
            ),
        ],
    )
}

fn gwith(f: impl FnOnce(&mut GraphProgram)) -> Vec<u8> {
    let mut p = graph_base();
    f(&mut p);
    genc(&p)
}

fn gwith_bytes(f: impl FnOnce(&mut Vec<u8>)) -> Vec<u8> {
    let mut b = genc(&graph_base());
    f(&mut b);
    b
}

/// The base graph with node 0's condition replaced by `cond`.
fn gcond(cond: &[Node]) -> Vec<u8> {
    let mut p = graph_base();
    let old = p.nodes[0].cond_len as usize;
    p.cond.splice(0..old, cond.iter().copied());
    p.nodes[0].cond_len = cond.len() as u8;
    p.nodes[4].cond_off = cond.len() as u8;
    genc(&p)
}

pub fn graph_invalid() -> Vec<Invalid> {
    let mut v = Vec::new();
    let mut add = |name: &'static str, bytes: Vec<u8>, error: Error| {
        v.push(Invalid {
            name,
            guard: 0,
            bytes,
            error,
        })
    };
    // Layout.
    add("empty input", vec![], Error::TooShort);
    add(
        "43 bytes",
        genc(&graph_base())[..43].to_vec(),
        Error::TooShort,
    );
    add(
        "rules magic",
        gwith_bytes(|b| b[..4].copy_from_slice(b"PXR1")),
        Error::BadMagic,
    );
    add("magic PXG2", gwith_bytes(|b| b[3] = b'2'), Error::BadMagic);
    add("version 0", gwith_bytes(|b| b[4] = 0), Error::BadVersion);
    add("version 2", gwith_bytes(|b| b[4] = 2), Error::BadVersion);
    add("flag bit 1", gwith(|p| p.flags |= 2), Error::UnknownFlags);
    add(
        "flag bit 7",
        gwith(|p| p.flags |= 0x80),
        Error::UnknownFlags,
    );
    add(
        "reserved byte 9 set",
        gwith_bytes(|b| b[9] = 1),
        Error::ReservedNonZero,
    );
    add(
        "reserved byte 11 set",
        gwith_bytes(|b| b[11] = 1),
        Error::ReservedNonZero,
    );
    add(
        "9 recipients",
        gwith(|p| {
            p.recipients = (1..=9u8)
                .map(|i| Recipient {
                    key: [i; 32],
                    bps: if i == 9 { 2_000 } else { 1_000 },
                })
                .collect()
        }),
        Error::TooManyRecipients,
    );
    add("no nodes", gwith(|p| p.nodes.clear()), Error::NoGraphNodes);
    add(
        "17 nodes",
        genc(&graph_prog(
            None,
            &[],
            &vec![(gnode(trigger::EVERY, 600, action::BURN, 1, 0), vec![]); 17],
        )),
        Error::TooManyGraphNodes,
    );
    add(
        "97 condition nodes",
        genc(&graph_prog(
            None,
            &[],
            &[(
                gnode(trigger::WHEN, 0, action::BURN, 1, 0),
                [[F; 49].as_slice(), &[OR; 48]].concat(),
            )],
        )),
        Error::TooManyNodes,
    );
    add(
        "one byte short",
        gwith_bytes(|b| {
            b.pop();
        }),
        Error::BadLength,
    );
    add(
        "one byte extra",
        gwith_bytes(|b| b.push(0)),
        Error::BadLength,
    );
    add(
        "recipient count one too high",
        gwith_bytes(|b| b[5] += 1),
        Error::BadLength,
    );
    // Operator.
    add(
        "operator flag without a key",
        gwith(|p| p.operator = [0; 32]),
        Error::MissingOperator,
    );
    add(
        "operator key without the flag",
        gwith(|p| p.flags = 0),
        Error::UnexpectedOperator,
    );
    // Recipients.
    add(
        "zero recipient",
        gwith(|p| p.recipients[0].key = [0; 32]),
        Error::ZeroRecipient,
    );
    add(
        "duplicate recipient",
        gwith(|p| p.recipients[1].key = R1),
        Error::DuplicateRecipient,
    );
    add(
        "recipient with 0 bps",
        gwith(|p| p.recipients.push(Recipient { key: R3, bps: 0 })),
        Error::ZeroRecipientBps,
    );
    add(
        "bps sum 9999",
        gwith(|p| p.recipients[1].bps = 3_999),
        Error::BadRecipientBps,
    );
    add(
        "bps sum 10001",
        gwith(|p| p.recipients[1].bps = 4_001),
        Error::BadRecipientBps,
    );
    add(
        "bps sum over u16",
        gwith(|p| {
            p.recipients[0].bps = 60_000;
            p.recipients[1].bps = 15_536;
        }),
        Error::BadRecipientBps,
    );
    // Nodes.
    add(
        "node reserved byte set",
        gwith(|p| p.nodes[2].reserved[4] = 1),
        Error::ReservedNonZero,
    );
    add(
        "trigger 0",
        gwith(|p| p.nodes[0].trigger = 0),
        Error::UnknownTrigger,
    );
    add(
        "trigger 5",
        gwith(|p| p.nodes[3].trigger = 5),
        Error::UnknownTrigger,
    );
    add(
        "every 599 s",
        gwith(|p| p.nodes[0].trigger_arg = 599),
        Error::EveryTooShort,
    );
    add(
        "after a missing node",
        gwith(|p| p.nodes[1].trigger_arg = 5),
        Error::BadAfterRef,
    );
    add(
        "after node 2^32",
        gwith(|p| p.nodes[1].trigger_arg = 1 << 32),
        Error::BadAfterRef,
    );
    add(
        "after itself",
        gwith(|p| p.nodes[1].trigger_arg = 1),
        Error::AfterCycle,
    );
    add(
        "after itself before a later node's error",
        gwith(|p| {
            p.nodes[1].trigger_arg = 1;
            p.nodes[3].budget_per_epoch = 0;
        }),
        Error::AfterCycle,
    );
    add(
        "after cycle of two",
        gwith(|p| {
            p.nodes[0].trigger = trigger::AFTER;
            p.nodes[0].trigger_arg = 1;
        }),
        Error::AfterCycle,
    );
    add(
        "after cycle of three",
        gwith(|p| {
            p.nodes[2].trigger = trigger::AFTER;
            p.nodes[2].trigger_arg = 1;
            p.nodes[1].trigger_arg = 3;
            p.nodes[3].trigger = trigger::AFTER;
            p.nodes[3].trigger_arg = 2;
        }),
        Error::AfterCycle,
    );
    add(
        "on-graduated with an argument",
        gwith(|p| p.nodes[2].trigger_arg = 1),
        Error::TriggerArgNonZero,
    );
    add(
        "when with an argument",
        gwith(|p| p.nodes[4].trigger_arg = 600),
        Error::TriggerArgNonZero,
    );
    add(
        "when without a condition",
        gwith(|p| {
            p.nodes[0].trigger = trigger::WHEN;
            p.nodes[0].trigger_arg = 0;
            p.nodes[0].cond_len = 0;
            p.cond.remove(0);
            p.nodes[4].cond_off = 0;
        }),
        Error::WhenWithoutCondition,
    );
    add(
        "action 0",
        gwith(|p| p.nodes[1].action = 0),
        Error::UnknownAction,
    );
    add(
        "action 6",
        gwith(|p| p.nodes[1].action = 6),
        Error::UnknownAction,
    );
    add(
        "add locked liquidity (reserved)",
        gwith(|p| p.nodes[1].action = action::ADD_LOCKED_LIQUIDITY),
        Error::ReservedAction,
    );
    add(
        "merkle airdrop (reserved)",
        gwith(|p| p.nodes[2].action = action::MERKLE_AIRDROP),
        Error::ReservedAction,
    );
    add("p1 of zero", gwith(|p| p.nodes[3].p1 = 0), Error::ZeroP1);
    add(
        "premium over the maximum",
        gwith(|p| p.nodes[0].p2 = MAX_PREMIUM_BPS + 1),
        Error::PremiumTooHigh,
    );
    add(
        "burn with p2",
        gwith(|p| p.nodes[1].p2 = 1),
        Error::P2NonZero,
    );
    add(
        "distribute with p2",
        gwith(|p| p.nodes[3].p2 = 1),
        Error::P2NonZero,
    );
    add(
        "distribute without recipients",
        genc(&graph_prog(
            None,
            &[],
            &[(
                gnode(trigger::EVERY, 600, action::DISTRIBUTE_SOL, 1, 0),
                vec![],
            )],
        )),
        Error::NoRecipients,
    );
    add(
        "operator_gated 2",
        gwith(|p| p.nodes[4].operator_gated = 2),
        Error::BadOperatorGated,
    );
    add(
        "gated without an operator",
        gwith(|p| {
            p.flags = 0;
            p.operator = [0; 32];
        }),
        Error::GatedWithoutOperator,
    );
    add(
        "epoch 3599 s",
        gwith(|p| p.nodes[2].epoch_secs = 3_599),
        Error::EpochTooShort,
    );
    add(
        "zero budget",
        gwith(|p| p.nodes[1].budget_per_epoch = 0),
        Error::ZeroBudget,
    );
    add(
        "zero max runs",
        gwith(|p| p.nodes[3].max_runs_per_epoch = 0),
        Error::ZeroMaxRuns,
    );
    // Conditions.
    add(
        "empty condition at an offset",
        gwith(|p| p.nodes[1].cond_off = 1),
        Error::ConditionNotContiguous,
    );
    add(
        "condition starts late",
        gwith(|p| p.nodes[4].cond_off = 2),
        Error::ConditionNotContiguous,
    );
    add(
        "conditions overlap",
        gwith(|p| {
            p.nodes[4].cond_off = 0;
        }),
        Error::ConditionNotContiguous,
    );
    add(
        "condition past the nodes",
        gwith(|p| p.nodes[4].cond_len = 4),
        Error::ConditionOutOfRange,
    );
    add(
        "unreferenced trailing node",
        gwith(|p| p.cond.push(T)),
        Error::UnreferencedNode,
    );
    add(
        "rules leaf in a graph",
        gcond(&[is_buy()]),
        Error::UnknownOp,
    );
    add("op 0x28", gcond(&[leaf(0x28, 0, 0)]), Error::UnknownOp);
    add(
        "GRADUATED with arg",
        gcond(&[leaf(op::graph::GRADUATED, 0, 1)]),
        Error::NonZeroOperand,
    );
    add(
        "TREASURY_SOL_GTE with a",
        gcond(&[leaf(op::graph::TREASURY_SOL_GTE, 1, 1)]),
        Error::NonZeroOperand,
    );
    add(
        "TREASURY_TOKEN_GTE with a",
        gcond(&[leaf(op::graph::TREASURY_TOKEN_GTE, 1, 1)]),
        Error::NonZeroOperand,
    );
    add(
        "PRICE_LTE with a",
        gcond(&[leaf(op::graph::PRICE_LTE, 1, 1)]),
        Error::NonZeroOperand,
    );
    add(
        "PRICE_GTE with a",
        gcond(&[leaf(op::graph::PRICE_GTE, 1, 1)]),
        Error::NonZeroOperand,
    );
    add(
        "TIME_GE with a",
        gcond(&[leaf(op::graph::TIME_GE, 1, 1)]),
        Error::NonZeroOperand,
    );
    add(
        "TIME_LT past i64",
        gcond(&[leaf(op::graph::TIME_LT, 0, 1 << 63)]),
        Error::TimeOutOfRange,
    );
    add(
        "TIME_GE past i64",
        gcond(&[leaf(op::graph::TIME_GE, 0, u64::MAX)]),
        Error::TimeOutOfRange,
    );
    add(
        "runs of a missing node",
        gcond(&[leaf(op::graph::RUNS_IN_EPOCH_LT, 5, 1)]),
        Error::BadNodeRef,
    );
    add("NOT first", gcond(&[NOT]), Error::StackUnderflow);
    add(
        "17 values",
        gcond(&[[T; 17].as_slice(), &[OR; 16]].concat()),
        Error::StackOverflow,
    );
    add("two values left", gcond(&[T, T]), Error::LeftoverValues);
    // Graph-wide.
    add(
        "operator but nothing gated",
        gwith(|p| p.nodes[4].operator_gated = 0),
        Error::OperatorUnused,
    );
    add(
        "recipients but no distribute node",
        gwith(|p| p.nodes[3].action = action::BURN),
        Error::RecipientsUnused,
    );
    // Precedence.
    add(
        "operator before recipients",
        gwith(|p| {
            p.operator = [0; 32];
            p.recipients[0].key = [0; 32];
        }),
        Error::MissingOperator,
    );
    add(
        "trigger before action",
        gwith(|p| {
            p.nodes[0].trigger_arg = 1;
            p.nodes[0].action = 9;
        }),
        Error::EveryTooShort,
    );
    add(
        "node error before a cycle",
        gwith(|p| {
            p.nodes[0].trigger = trigger::AFTER;
            p.nodes[0].trigger_arg = 1;
            p.nodes[3].budget_per_epoch = 0;
        }),
        Error::ZeroBudget,
    );
    v
}

/// The largest graph: 8 recipients, 16 nodes, 96 condition nodes (2,044 bytes).
pub fn graph_max() -> GraphProgram {
    let recipients: Vec<([u8; 32], u16)> = (1..=8u8).map(|i| ([0xB0 + i; 32], 1_250)).collect();
    let mut nodes = Vec::new();
    for i in 0..16u64 {
        let act = [action::BUYBACK_BURN, action::BURN, action::DISTRIBUTE_SOL][i as usize % 3];
        let (trig, targ) = match i {
            0 => (trigger::EVERY, 3_600),
            1 => (trigger::ON_GRADUATED, 0),
            _ if i % 4 == 0 => (trigger::WHEN, 0),
            _ => (trigger::AFTER, i - 1),
        };
        let p2 = if act == action::BUYBACK_BURN {
            i * 100
        } else {
            0
        };
        let mut g = gnode(trig, targ, act, 1_000 + i, p2);
        g.operator_gated = u8::from(i % 5 == 0);
        g.max_runs_per_epoch = 1 + i as u16;
        // Six nodes per condition: 96 in all.
        let cond = vec![
            tsol(i * 1_000),
            leaf(op::graph::RUNS_IN_EPOCH_LT, i as u8, 3),
            AND,
            leaf(op::graph::TIME_GE, 0, 1_700_000_000 + i),
            NOT,
            AND,
        ];
        nodes.push((g, cond));
    }
    graph_prog(Some(OP), &recipients, &nodes)
}

pub fn graph_valid() -> Vec<Valid<GraphProgram>> {
    let mut v = Vec::new();
    let mut add = |name: &str, program: GraphProgram| {
        v.push(Valid {
            name: name.to_string(),
            guard: 0,
            program,
        })
    };
    add("daily buyback and burn", simple_graph());
    add(
        "burn on graduation",
        graph_prog(
            None,
            &[],
            &[(
                gnode(trigger::ON_GRADUATED, 0, action::BURN, u64::MAX, 0),
                vec![],
            )],
        ),
    );
    add(
        "weekly revenue share",
        graph_prog(
            None,
            &[(R1, 5_000), (R2, 3_000), (R3, 2_000)],
            &[(
                gnode(
                    trigger::EVERY,
                    7 * 86_400,
                    action::DISTRIBUTE_SOL,
                    10_000_000_000,
                    0,
                ),
                vec![tsol(100_000_000)],
            )],
        ),
    );
    let mut ai = gnode(trigger::WHEN, 0, action::BUYBACK_BURN, 2_000_000_000, 500);
    ai.operator_gated = 1;
    ai.max_runs_per_epoch = 24;
    add(
        "AI-operated buyback",
        graph_prog(
            Some(OP),
            &[],
            &[(
                ai,
                vec![
                    leaf(op::graph::GRADUATED, 0, 0),
                    leaf(op::graph::PRICE_LTE, 0, 1 << 62),
                    AND,
                ],
            )],
        ),
    );
    add(
        "buyback, then burn after it",
        graph_prog(
            None,
            &[],
            &[
                (
                    gnode(
                        trigger::EVERY,
                        86_400,
                        action::BUYBACK_BURN,
                        1_000_000_000,
                        0,
                    ),
                    vec![],
                ),
                (
                    gnode(trigger::AFTER, 0, action::BURN, 1_000_000_000_000, 0),
                    vec![],
                ),
            ],
        ),
    );
    add("largest graph (2,044 bytes)", graph_max());
    add(
        "between two dates while the treasury holds 5 SOL",
        graph_prog(
            None,
            &[],
            &[(
                gnode(trigger::WHEN, 0, action::BURN, 1, 0),
                vec![
                    leaf(op::graph::TIME_GE, 0, 1_800_000_000),
                    leaf(op::graph::TIME_LT, 0, 1_900_000_000),
                    AND,
                    tsol(5_000_000_000),
                    AND,
                ],
            )],
        ),
    );
    add(
        "chain of 16 after-triggers",
        graph_prog(
            None,
            &[],
            &(0..16u64)
                .map(|i| {
                    let t = if i == 0 {
                        (trigger::EVERY, 600)
                    } else {
                        (trigger::AFTER, i - 1)
                    };
                    (gnode(t.0, t.1, action::BURN, 1, 0), vec![])
                })
                .collect::<Vec<_>>(),
        ),
    );
    add(
        "after-triggers pointing forward",
        graph_prog(
            None,
            &[],
            &[
                (gnode(trigger::AFTER, 2, action::BURN, 1, 0), vec![]),
                (gnode(trigger::AFTER, 0, action::BURN, 1, 0), vec![]),
                (gnode(trigger::EVERY, 600, action::BURN, 1, 0), vec![]),
            ],
        ),
    );
    let mut edges = gnode(
        trigger::EVERY,
        600,
        action::BUYBACK_BURN,
        u64::MAX,
        MAX_PREMIUM_BPS,
    );
    edges.epoch_secs = 3_600;
    edges.budget_per_epoch = u64::MAX;
    edges.max_runs_per_epoch = u16::MAX;
    add(
        "every limit at its edge",
        graph_prog(
            None,
            &[],
            &[(
                edges,
                vec![
                    leaf(op::graph::TIME_LT, 0, i64::MAX as u64),
                    leaf(op::graph::RUNS_IN_EPOCH_LT, 0, u64::MAX),
                    AND,
                    leaf(op::graph::TREASURY_TOKEN_GTE, 0, u64::MAX),
                    NOT,
                    AND,
                ],
            )],
        ),
    );
    add(
        "zero premium and a single recipient",
        graph_prog(
            None,
            &[(R1, 10_000)],
            &[
                (
                    gnode(trigger::EVERY, 86_400, action::BUYBACK_BURN, 1, 0),
                    vec![],
                ),
                (
                    gnode(trigger::AFTER, 0, action::DISTRIBUTE_SOL, 1, 0),
                    vec![],
                ),
            ],
        ),
    );
    add(
        "deepest stack: 16 values",
        graph_prog(
            None,
            &[],
            &[(
                gnode(trigger::WHEN, 0, action::BURN, 1, 0),
                [
                    [leaf(op::graph::GRADUATED, 0, 0); 16].as_slice(),
                    &[AND; 15],
                ]
                .concat(),
            )],
        ),
    );
    add("the base of the invalid cases", graph_base());
    let mut rng = Rng::new(0x5058_4731);
    for i in 0..28 {
        add(&format!("random #{i}"), gen_graph(&mut rng));
    }
    v
}

//! Shared test support: a seeded generator, builders, random valid programs
//! and an independent reference model of the semantics (written from the
//! spec, sharing no evaluation code with the crate).
#![allow(dead_code)]

pub mod cases;

use noised_rules::graph::{self, action, trigger, GNode, GraphCtx, NodeState, Recipient};
use noised_rules::rules::{self, effect, Rule, TransferCtx, Violation};
use noised_rules::vm::MAX_STACK;
use noised_rules::{op, GraphProgram, Node, RulesProgram, BPS_FLAG};

/// SplitMix64: deterministic, seeded.
#[derive(Clone)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed)
    }
    pub fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    /// Uniform in `0..n` (n > 0).
    pub fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    /// Uniform in `lo..=hi`.
    pub fn range(&mut self, lo: u64, hi: u64) -> u64 {
        lo + self.below(hi - lo + 1)
    }
    pub fn coin(&mut self) -> bool {
        self.next() & 1 == 1
    }
    /// True with probability 1/n.
    pub fn one_in(&mut self, n: u64) -> bool {
        self.below(n) == 0
    }
    pub fn pick<T: Copy>(&mut self, items: &[T]) -> T {
        items[self.below(items.len() as u64) as usize]
    }
    pub fn bytes(&mut self, len: usize) -> Vec<u8> {
        (0..len).map(|_| self.next() as u8).collect()
    }
    pub fn key(&mut self) -> [u8; 32] {
        let mut k = [0u8; 32];
        for b in k.iter_mut() {
            *b = self.next() as u8;
        }
        k[0] |= 1; // never all zero
        k
    }
    /// A u64 biased toward edges.
    pub fn wide(&mut self) -> u64 {
        match self.below(6) {
            0 => self.pick(&[0, 1, 2, u64::MAX, u64::MAX - 1, 1 << 63, (1 << 63) - 1]),
            1 => self.below(1_000),
            2 => self.below(1 << 20),
            3 => self.below(1 << 40),
            _ => self.next(),
        }
    }
}

pub fn key(b: u8) -> [u8; 32] {
    [b; 32]
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

// ---------------------------------------------------------------- nodes ---

pub const T: Node = Node::new(op::TRUE, 0, 0);
pub const F: Node = Node::new(op::FALSE, 0, 0);
pub const AND: Node = Node::new(op::AND, 0, 0);
pub const OR: Node = Node::new(op::OR, 0, 0);
pub const NOT: Node = Node::new(op::NOT, 0, 0);

pub fn leaf(op: u8, a: u8, arg: u64) -> Node {
    Node::new(op, a, arg)
}
pub fn is_buy() -> Node {
    leaf(op::rules::IS_BUY, 0, 0)
}
pub fn is_p2p() -> Node {
    leaf(op::rules::IS_P2P, 0, 0)
}
pub fn time_lt(secs: u64) -> Node {
    leaf(op::rules::TIME_LT, 0, secs)
}
pub fn time_ge(secs: u64) -> Node {
    leaf(op::rules::TIME_GE, 0, secs)
}
pub fn amount_gt(arg: u64) -> Node {
    leaf(op::rules::AMOUNT_GT, 0, arg)
}
pub fn dest_bal_gt(arg: u64) -> Node {
    leaf(op::rules::DEST_BAL_AFTER_GT, 0, arg)
}
pub fn dest_in(mask: u8) -> Node {
    leaf(op::rules::DEST_OWNER_IN, mask, 0)
}
pub fn src_in(mask: u8) -> Node {
    leaf(op::rules::SRC_OWNER_IN, mask, 0)
}
pub fn top_in(mask: u8) -> Node {
    leaf(op::rules::TOP_PROGRAM_IN, mask, 0)
}
pub fn ix_gt(n: u64) -> Node {
    leaf(op::rules::TX_IX_COUNT_GT, 0, n)
}
pub fn bps(b: u64) -> u64 {
    BPS_FLAG | b
}

// ---------------------------------------------------------------- rules ---

pub const GUARD: u32 = 259_200;

/// A rule without its condition placement.
#[derive(Clone, Debug)]
pub struct R {
    pub from: u32,
    pub to: u32,
    pub effect: u8,
    pub code: u8,
    pub arg: u64,
    pub cond: Vec<Node>,
}

pub fn deny(from: u32, to: u32, code: u8, cond: &[Node]) -> R {
    R {
        from,
        to,
        effect: effect::DENY,
        code,
        arg: 0,
        cond: cond.to_vec(),
    }
}
pub fn cap_amount(from: u32, to: u32, code: u8, cap: u64, cond: &[Node]) -> R {
    R {
        from,
        to,
        effect: effect::CAP_AMOUNT,
        code,
        arg: cap,
        cond: cond.to_vec(),
    }
}
pub fn cap_balance(from: u32, to: u32, code: u8, cap: u64, cond: &[Node]) -> R {
    R {
        from,
        to,
        effect: effect::CAP_DEST_BALANCE,
        code,
        arg: cap,
        cond: cond.to_vec(),
    }
}

/// A rule set with conditions laid out back to back.
pub fn rules_prog(keys: &[[u8; 32]], rs: &[R]) -> RulesProgram {
    let mut rules = Vec::new();
    let mut nodes = Vec::new();
    for r in rs {
        rules.push(Rule {
            from_rel: r.from,
            to_rel: r.to,
            cond_off: nodes.len() as u8,
            cond_len: r.cond.len() as u8,
            effect: r.effect,
            code: r.code,
            arg: r.arg,
        });
        nodes.extend_from_slice(&r.cond);
    }
    RulesProgram {
        keys: keys.to_vec(),
        rules,
        nodes,
    }
}

pub fn enc(p: &RulesProgram) -> Vec<u8> {
    p.encode().unwrap()
}

/// A simple valid rule set: deny buys in the first 120 s.
pub fn simple_rules() -> RulesProgram {
    rules_prog(&[], &[deny(0, 120, 1, &[is_buy()])])
}

pub fn ctx() -> TransferCtx {
    TransferCtx {
        now_rel: 10,
        is_buy: true,
        is_p2p: false,
        amount: 1_000,
        dest_balance_after: 1_000,
        supply: 1_000_000_000,
        dest_owner: key(0xD0),
        src_owner: key(0x50),
        top_program: key(0x70),
        tx_ix_count: 2,
    }
}

// ------------------------------------------------- reference semantics ---

/// Reference postfix evaluation on a `Vec<bool>` stack.
pub fn ref_eval(nodes: &[Node], leaf: &dyn Fn(&Node) -> Option<bool>) -> Option<bool> {
    let mut stack: Vec<bool> = Vec::new();
    for n in nodes {
        match n.op {
            op::TRUE => stack.push(true),
            op::FALSE => stack.push(false),
            op::AND | op::OR => {
                let x = stack.pop()?;
                let y = stack.pop()?;
                stack.push(if n.op == op::AND { x && y } else { x || y });
            }
            op::NOT => {
                let x = stack.pop()?;
                stack.push(!x);
            }
            _ => stack.push(leaf(n)?),
        }
        if stack.len() > MAX_STACK as usize {
            return None;
        }
    }
    if stack.len() == 1 {
        stack.pop()
    } else {
        None
    }
}

/// Reference threshold: `arg`, or `floor(supply * bps / 10_000)`.
pub fn ref_threshold(arg: u64, supply: u64) -> u128 {
    if arg & BPS_FLAG == 0 {
        arg as u128
    } else {
        (supply as u128 * (arg & 0xFFFF) as u128) / 10_000
    }
}

pub fn ref_rules_leaf(p: &RulesProgram, c: &TransferCtx, n: &Node) -> Option<bool> {
    let in_mask = |who: &[u8; 32]| {
        p.keys
            .iter()
            .enumerate()
            .any(|(i, k)| i < 8 && n.a & (1 << i) != 0 && k == who)
    };
    let now = c.now_rel as i128;
    Some(match n.op {
        op::rules::IS_BUY => c.is_buy,
        op::rules::IS_P2P => c.is_p2p,
        op::rules::TIME_LT => now < n.arg as i128,
        op::rules::TIME_GE => now >= n.arg as i128,
        op::rules::AMOUNT_GT => c.amount as u128 > ref_threshold(n.arg, c.supply),
        op::rules::DEST_BAL_AFTER_GT => {
            c.dest_balance_after as u128 > ref_threshold(n.arg, c.supply)
        }
        op::rules::DEST_OWNER_IN => in_mask(&c.dest_owner),
        op::rules::SRC_OWNER_IN => in_mask(&c.src_owner),
        op::rules::TOP_PROGRAM_IN => in_mask(&c.top_program),
        op::rules::TX_IX_COUNT_GT => c.tx_ix_count as u64 > n.arg,
        _ => return None,
    })
}

pub fn ref_rule_condition(p: &RulesProgram, i: usize, c: &TransferCtx) -> Option<bool> {
    let r = p.rules[i];
    let start = r.cond_off as usize;
    let cond = p.nodes.get(start..start + r.cond_len as usize)?;
    ref_eval(cond, &|n| ref_rules_leaf(p, c, n))
}

/// Reference rules decision, straight from the spec: active rules in order,
/// the first whose condition holds and whose effect is violated rejects.
pub fn ref_rules_eval(p: &RulesProgram, c: &TransferCtx) -> Result<(), Violation> {
    for (i, r) in p.rules.iter().enumerate() {
        let active = (r.from_rel as i64) <= c.now_rel && c.now_rel < r.to_rel as i64;
        if !active {
            continue;
        }
        let cond = ref_rule_condition(p, i, c).expect("verified");
        let violated = match r.effect {
            effect::DENY => true,
            effect::CAP_AMOUNT => c.amount as u128 > ref_threshold(r.arg, c.supply),
            effect::CAP_DEST_BALANCE => {
                c.dest_balance_after as u128 > ref_threshold(r.arg, c.supply)
            }
            _ => panic!("verified"),
        };
        if cond && violated {
            return Err(Violation {
                rule: i as u8,
                code: r.code,
            });
        }
    }
    Ok(())
}

pub fn ref_graph_leaf(c: &GraphCtx, n: &Node) -> Option<bool> {
    Some(match n.op {
        op::graph::TREASURY_SOL_GTE => c.treasury_sol >= n.arg,
        op::graph::TREASURY_TOKEN_GTE => c.treasury_token >= n.arg,
        op::graph::GRADUATED => c.graduated,
        op::graph::PRICE_LTE => c.sqrt_price <= n.arg as u128,
        op::graph::PRICE_GTE => c.sqrt_price >= n.arg as u128,
        op::graph::TIME_GE => c.now as i128 >= n.arg as i128,
        op::graph::TIME_LT => (c.now as i128) < n.arg as i128,
        op::graph::RUNS_IN_EPOCH_LT => (*c.runs_in_epoch.get(n.a as usize)? as u64) < n.arg,
        _ => return None,
    })
}

pub fn ref_graph_condition(p: &GraphProgram, i: usize, c: &GraphCtx) -> Option<bool> {
    let g = p.nodes[i];
    if g.cond_len == 0 {
        return Some(true);
    }
    let start = g.cond_off as usize;
    let cond = p.cond.get(start..start + g.cond_len as usize)?;
    ref_eval(cond, &|n| ref_graph_leaf(c, n))
}

// --------------------------------------------------- random programs ---

/// Random valid postfix condition of at most `max_len` nodes (>= 1) with
/// leaves from `leaf`.
pub fn gen_cond(
    rng: &mut Rng,
    max_len: usize,
    leaf: &mut dyn FnMut(&mut Rng) -> Node,
) -> Vec<Node> {
    assert!(max_len >= 1);
    let max_leaves = max_len.div_ceil(2);
    let leaves = 1 + rng.below(max_leaves.min(24) as u64) as usize;
    let mut out = Vec::new();
    let (mut depth, mut left) = (0usize, leaves);
    while left > 0 || depth > 1 {
        let can_push = left > 0 && depth < MAX_STACK as usize;
        let can_combine = depth >= 2;
        if can_push && (!can_combine || rng.below(3) != 0) {
            out.push(if rng.one_in(8) {
                if rng.coin() {
                    T
                } else {
                    F
                }
            } else {
                leaf(rng)
            });
            left -= 1;
            depth += 1;
        } else {
            out.push(if rng.coin() { AND } else { OR });
            depth -= 1;
        }
        // Nodes still needed: the remaining pushes and the combines.
        let needed = left + (depth + left).saturating_sub(1);
        if out.len() + 1 + needed <= max_len && rng.one_in(5) {
            out.push(NOT);
        }
    }
    assert!(out.len() <= max_len, "{} > {max_len}", out.len());
    out
}

fn gen_bps_arg(rng: &mut Rng) -> u64 {
    bps(rng.pick(&[1, 2, 10, 50, 100, 250, 1_000, 5_000, 9_999, 10_000]))
}

/// A random rules leaf valid for `n_keys` keys and the guard.
pub fn gen_rules_leaf(rng: &mut Rng, n_keys: usize, guard: u32) -> Node {
    loop {
        let n = match rng.below(10) {
            0 => is_buy(),
            1 => is_p2p(),
            2 => time_lt(rng.range(0, guard as u64)),
            3 => time_ge(rng.range(0, guard as u64)),
            4 => amount_gt(if rng.coin() {
                gen_bps_arg(rng)
            } else {
                rng.wide() & !BPS_FLAG
            }),
            5 => dest_bal_gt(if rng.coin() {
                gen_bps_arg(rng)
            } else {
                rng.wide() & !BPS_FLAG
            }),
            6..=8 if n_keys > 0 => {
                let all = ((1u16 << n_keys) - 1) as u8;
                let mask = (rng.next() as u8 & all).max(1);
                leaf(op::rules::DEST_OWNER_IN + rng.below(3) as u8, mask, 0)
            }
            9 => ix_gt(rng.below(20)),
            _ => continue,
        };
        return n;
    }
}

/// A random valid rule set (valid by construction) for `guard`.
pub fn gen_rules(rng: &mut Rng, guard: u32) -> RulesProgram {
    let guard = guard.clamp(2, rules::MAX_GUARD_SECS);
    let n_rules = 1 + rng.below(16) as usize;
    let mut n_keys = rng.below(9) as usize;
    let keys: Vec<[u8; 32]> = (0..n_keys).map(|_| rng.key()).collect();
    let budget = if rng.one_in(4) {
        64
    } else {
        8 + rng.below(57) as usize
    }
    .max(n_rules);
    let mut left = budget;
    let mut rs = Vec::new();
    for i in 0..n_rules {
        let rules_after = n_rules - i - 1;
        let max_len = (left - rules_after).clamp(1, 24);
        let cond = gen_cond(rng, max_len, &mut |r| gen_rules_leaf(r, n_keys, guard));
        left -= cond.len();
        let from = rng.below(guard as u64) as u32;
        let to = rng.range(from as u64 + 1, guard as u64) as u32;
        let code = rng.below(64) as u8;
        let effect = 1 + rng.below(3) as u8;
        let arg = match effect {
            effect::DENY => 0,
            _ if rng.coin() => gen_bps_arg(rng),
            _ => rng.wide().clamp(1, (1 << 63) - 1),
        };
        rs.push(R {
            from,
            to,
            effect,
            code,
            arg,
            cond,
        });
    }
    let mut p = rules_prog(&keys, &rs);
    // Every key must be used: widen an existing mask, or drop the keys.
    let all = if n_keys == 0 {
        0
    } else {
        ((1u16 << n_keys) - 1) as u8
    };
    let used = p
        .nodes
        .iter()
        .filter(|n| (op::rules::DEST_OWNER_IN..=op::rules::TOP_PROGRAM_IN).contains(&n.op))
        .fold(0u8, |m, n| m | n.a);
    if used != all {
        match p
            .nodes
            .iter_mut()
            .find(|n| (op::rules::DEST_OWNER_IN..=op::rules::TOP_PROGRAM_IN).contains(&n.op))
        {
            Some(n) => n.a |= all & !used,
            None => {
                n_keys = 0;
                p.keys.clear();
            }
        }
    }
    let _ = n_keys;
    p
}

/// A random transfer for a rule set: edges around its windows and caps.
pub fn gen_ctx(rng: &mut Rng, p: &RulesProgram, guard: u32) -> TransferCtx {
    let mut c = ctx();
    let windows: Vec<i64> = p
        .rules
        .iter()
        .flat_map(|r| [r.from_rel as i64, r.to_rel as i64])
        .collect();
    let times: Vec<u64> = p
        .nodes
        .iter()
        .filter(|n| n.op == op::rules::TIME_LT || n.op == op::rules::TIME_GE)
        .map(|n| n.arg)
        .collect();
    c.now_rel = match rng.below(5) {
        0 if !windows.is_empty() => rng.pick(&windows) + rng.pick(&[-1i64, 0, 1]),
        1 if !times.is_empty() => rng.pick(&times) as i64 + rng.pick(&[-1i64, 0, 1]),
        2 => rng.pick(&[-1i64, 0, guard as i64 - 1, guard as i64, i64::MIN, i64::MAX]),
        _ => rng.below(guard as u64 + 10) as i64 - 5,
    };
    c.is_buy = rng.coin();
    c.is_p2p = !c.is_buy && rng.coin();
    c.supply = match rng.below(4) {
        0 => rng.pick(&[0, 1, 9_999, 10_000, 10_001, u64::MAX]),
        1 => 1_000_000_000_000_000,
        _ => rng.wide(),
    };
    let thresholds: Vec<u64> = p
        .rules
        .iter()
        .filter(|r| r.effect != effect::DENY)
        .map(|r| r.arg)
        .chain(
            p.nodes
                .iter()
                .filter(|n| n.op == op::rules::AMOUNT_GT || n.op == op::rules::DEST_BAL_AFTER_GT)
                .map(|n| n.arg),
        )
        .map(|a| {
            let t = ref_threshold(a, c.supply);
            t.min(u64::MAX as u128) as u64
        })
        .collect();
    let amount = |rng: &mut Rng| {
        if !thresholds.is_empty() && rng.coin() {
            rng.pick(&thresholds)
                .saturating_add(rng.pick(&[0u64, 1, 2]))
                .saturating_sub(1)
        } else {
            rng.wide()
        }
    };
    c.amount = amount(rng);
    c.dest_balance_after = amount(rng);
    let who = |rng: &mut Rng| {
        if !p.keys.is_empty() && rng.below(3) != 0 {
            rng.pick(&p.keys)
        } else {
            rng.key()
        }
    };
    c.dest_owner = who(rng);
    c.src_owner = who(rng);
    c.top_program = who(rng);
    c.tx_ix_count = rng.pick(&[0u16, 1, 2, 3, 4, 5, 10, 19, 20, 64, u16::MAX]);
    c
}

// ---------------------------------------------------------------- graph ---

pub const DAY: u32 = 86_400;

pub fn gnode(trig: u8, targ: u64, act: u8, p1: u64, p2: u64) -> GNode {
    GNode {
        trigger: trig,
        trigger_arg: targ,
        cond_off: 0,
        cond_len: 0,
        action: act,
        operator_gated: 0,
        epoch_secs: DAY,
        budget_per_epoch: 5_000_000_000,
        p1,
        p2,
        max_runs_per_epoch: 1,
        reserved: [0; 5],
    }
}

/// A graph with conditions laid out back to back (empty ones at offset 0).
pub fn graph_prog(
    operator: Option<[u8; 32]>,
    recipients: &[([u8; 32], u16)],
    nodes: &[(GNode, Vec<Node>)],
) -> GraphProgram {
    let mut cond = Vec::new();
    let mut out = Vec::new();
    for (g, c) in nodes {
        let mut g = *g;
        g.cond_len = c.len() as u8;
        g.cond_off = if c.is_empty() { 0 } else { cond.len() as u8 };
        cond.extend_from_slice(c);
        out.push(g);
    }
    GraphProgram {
        flags: if operator.is_some() {
            graph::FLAG_HAS_OPERATOR
        } else {
            0
        },
        operator: operator.unwrap_or([0; 32]),
        recipients: recipients
            .iter()
            .map(|&(key, bps)| Recipient { key, bps })
            .collect(),
        nodes: out,
        cond,
    }
}

pub fn genc(p: &GraphProgram) -> Vec<u8> {
    p.encode().unwrap()
}

/// Daily buyback and burn.
pub fn simple_graph() -> GraphProgram {
    graph_prog(
        None,
        &[],
        &[(
            gnode(
                trigger::EVERY,
                DAY as u64,
                action::BUYBACK_BURN,
                500_000_000,
                300,
            ),
            vec![leaf(op::graph::TREASURY_SOL_GTE, 0, 1_000_000_000)],
        )],
    )
}

pub fn gctx() -> GraphCtx {
    GraphCtx {
        now: 1_800_000_000,
        treasury_sol: 2_000_000_000,
        treasury_token: 1_000_000,
        graduated: true,
        sqrt_price: 1 << 60,
        runs_in_epoch: [0; 16],
    }
}

pub fn gen_graph_leaf(rng: &mut Rng, n_nodes: usize) -> Node {
    match rng.below(8) {
        0 => leaf(op::graph::TREASURY_SOL_GTE, 0, rng.wide()),
        1 => leaf(op::graph::TREASURY_TOKEN_GTE, 0, rng.wide()),
        2 => leaf(op::graph::GRADUATED, 0, 0),
        3 => leaf(op::graph::PRICE_LTE, 0, rng.wide()),
        4 => leaf(op::graph::PRICE_GTE, 0, rng.wide()),
        5 => leaf(op::graph::TIME_GE, 0, rng.wide() & (u64::MAX >> 1)),
        6 => leaf(op::graph::TIME_LT, 0, rng.wide() & (u64::MAX >> 1)),
        _ => leaf(
            op::graph::RUNS_IN_EPOCH_LT,
            rng.below(n_nodes as u64) as u8,
            rng.below(10),
        ),
    }
}

/// A random valid graph (valid by construction).
pub fn gen_graph(rng: &mut Rng) -> GraphProgram {
    let n = 1 + rng.below(16) as usize;
    let n_rec = if rng.coin() {
        0
    } else {
        1 + rng.below(8) as usize
    };
    let mut recipients = Vec::new();
    let mut left = 10_000u16;
    for i in 0..n_rec {
        let bps = if i + 1 == n_rec {
            left
        } else {
            let max = left - (n_rec - i - 1) as u16;
            1 + rng.below(max as u64 / 2 + 1).min(max as u64 - 1) as u16
        };
        left -= bps;
        recipients.push((rng.key(), bps));
    }
    let operator = if rng.coin() { Some(rng.key()) } else { None };
    // AFTER parents come earlier in a random order, so no cycles.
    let mut order: Vec<usize> = (0..n).collect();
    for i in (1..n).rev() {
        order.swap(i, rng.below(i as u64 + 1) as usize);
    }
    let mut budget = if rng.one_in(4) {
        96
    } else {
        rng.below(97) as usize
    };
    let mut nodes = Vec::new();
    for i in 0..n {
        let pos = order.iter().position(|&x| x == i).unwrap();
        let mut trig = 1 + rng.below(4) as u8;
        if trig == trigger::AFTER && pos == 0 {
            trig = trigger::EVERY;
        }
        if trig == trigger::WHEN && budget == 0 {
            trig = trigger::ON_GRADUATED;
        }
        let targ = match trig {
            trigger::EVERY => rng.pick(&[600, 601, 3_600, 86_400, 604_800, u64::MAX]),
            trigger::AFTER => order[rng.below(pos as u64) as usize] as u64,
            _ => 0,
        };
        let act = match rng.below(3) {
            0 if n_rec > 0 => action::DISTRIBUTE_SOL,
            1 => action::BURN,
            _ => action::BUYBACK_BURN,
        };
        let mut g = gnode(trig, targ, act, rng.wide().max(1), 0);
        if act == action::BUYBACK_BURN {
            g.p2 = rng.below(2_001);
        }
        g.epoch_secs = rng.pick(&[3_600, 3_601, DAY, 7 * DAY, u32::MAX]);
        g.budget_per_epoch = rng.wide().max(1);
        g.max_runs_per_epoch = rng.pick(&[1, 2, 3, 24, u16::MAX]);
        g.operator_gated = u8::from(operator.is_some() && rng.coin());
        let cond = if budget > 0 && (trig == trigger::WHEN || rng.coin()) {
            let c = gen_cond(rng, budget.min(24), &mut |r| gen_graph_leaf(r, n));
            budget -= c.len();
            c
        } else {
            vec![]
        };
        nodes.push((g, cond));
    }
    if n_rec > 0
        && !nodes
            .iter()
            .any(|(g, _)| g.action == action::DISTRIBUTE_SOL)
    {
        nodes[0].0.action = action::DISTRIBUTE_SOL;
        nodes[0].0.p2 = 0;
    }
    if operator.is_some() && !nodes.iter().any(|(g, _)| g.operator_gated == 1) {
        nodes[0].0.operator_gated = 1;
    }
    graph_prog(operator, &recipients, &nodes)
}

pub fn gen_gctx(rng: &mut Rng, p: &GraphProgram) -> GraphCtx {
    let args: Vec<u64> = p.cond.iter().map(|n| n.arg).collect();
    let near = |rng: &mut Rng| {
        if !args.is_empty() && rng.coin() {
            rng.pick(&args)
                .saturating_add(rng.pick(&[0u64, 1, 2]))
                .saturating_sub(1)
        } else {
            rng.wide()
        }
    };
    let mut c = gctx();
    c.now = near(rng) as i64;
    if rng.one_in(8) {
        c.now = rng.pick(&[i64::MIN, -1, 0, i64::MAX]);
    }
    c.treasury_sol = near(rng);
    c.treasury_token = near(rng);
    c.graduated = rng.coin();
    c.sqrt_price = if rng.one_in(6) {
        rng.pick(&[u128::MAX, 1u128 << 64, (1u128 << 64) + 1, 0])
    } else {
        near(rng) as u128
    };
    for r in c.runs_in_epoch.iter_mut() {
        *r = rng.pick(&[0u16, 1, 2, 3, 9, 10, u16::MAX]);
    }
    c
}

pub fn gen_states(rng: &mut Rng, n: usize) -> Vec<NodeState> {
    (0..n)
        .map(|_| NodeState {
            last_run: rng.pick(&[0i64, 1_700_000_000, 1_800_000_000, -5, i64::MAX]),
            last_seq: rng.below(5),
            epoch_start: rng.pick(&[0i64, 1_799_996_400, 1_800_000_000, i64::MIN, i64::MAX]),
            runs_in_epoch: rng.pick(&[0u16, 1, 2, u16::MAX]),
            spent_in_epoch: rng.wide(),
        })
        .collect()
}

//! PXR1 launch rules: creator-defined restrictions for the Launch Guard
//! period.
//!
//! ```text
//! "PXR1" | version u8 = 1 | n_keys u8 (<= 8) | n_rules u8 (1..=16) | n_nodes u8 (<= 64) | reserved [0; 4]
//!        | keys [[u8; 32]; n_keys] | rules [Rule; n_rules] | nodes [Node; n_nodes]
//! Rule (20 B) = from_rel u32 | to_rel u32 | cond_off u8 | cond_len u8 | effect u8 | code u8 | arg u64
//! ```
//!
//! Integers are little-endian; the length must be exact (at most
//! [`MAX_LEN`] = 1,228 bytes). A rule is active while
//! `from_rel <= now_rel < to_rel` (seconds since the guard started) and
//! rejects the transfer when its condition holds:
//!
//! * DENY ([`effect::DENY`]) always;
//! * CAP_AMOUNT ([`effect::CAP_AMOUNT`]) if the amount exceeds the cap;
//! * CAP_DEST_BALANCE ([`effect::CAP_DEST_BALANCE`]) if the destination's
//!   balance after the transfer exceeds the cap.
//!
//! A cap is an amount (> 0), or with [`crate::BPS_FLAG`] set, basis points
//! of the supply (1..=10,000, see [`crate::exceeds`]).
//!
//! Canonical form, checked by [`RuleSet::verify`] on top of the limits:
//! keys are distinct, non-zero and each used by some condition; rule `i`'s
//! condition is `nodes[cond_off..cond_off + cond_len]` with `cond_off` equal
//! to the end of rule `i - 1`'s (0 for the first) and the last ending at
//! `n_nodes`, so the conditions partition the nodes in rule order and one
//! transfer evaluates each node at most once; unused operands are zero.
//!
//! The transfer hook evaluates rules last, after every built-in allow
//! (sells, the end of the guard, the batch, claims and other exemptions,
//! zero amounts) and every built-in denial; rules can only reject.

use crate::vm::{self, op, LeafCheck, LeafEval, Node, NODE_LEN};
use crate::{check_bps_arg, exceeds, take, time_lt, Error, Reader, Sha256, BPS_FLAG};

/// Magic bytes.
pub const MAGIC: [u8; 4] = *b"PXR1";
/// Format version.
pub const VERSION: u8 = 1;
/// Header bytes: magic, version, three counts, four reserved.
pub const HEADER_LEN: usize = 12;
/// Bytes per key.
pub const KEY_LEN: usize = 32;
/// Bytes per rule.
pub const RULE_LEN: usize = 20;
/// Maximum number of keys (a key mask is one byte).
pub const MAX_KEYS: u8 = 8;
/// Maximum number of rules.
pub const MAX_RULES: u8 = 16;
/// Maximum number of condition nodes.
pub const MAX_NODES: u8 = 64;
/// Largest valid rule set: 12 + 8 * 32 + 16 * 20 + 64 * 10 bytes.
pub const MAX_LEN: usize = 1_228;
/// Largest rule code (codes are shown to users; 0..=63).
pub const MAX_CODE: u8 = 63;
/// Rules never outlive the launch guard, which lasts at most 72 hours.
pub const MAX_GUARD_SECS: u32 = 72 * 60 * 60;
/// The code of a [`Violation`] raised by a malformed rule set (unknown
/// effect, malformed condition). Verified rule sets never raise it.
pub const CODE_MALFORMED: u8 = 0xFF;
/// Domain separator of [`rules_hash`].
pub const HASH_DOMAIN: &[u8; 12] = b"PHX-RULES-V1";
/// The rules hash that means "no custom rules".
pub const NO_RULES_HASH: [u8; 32] = [0; 32];

/// Rule effects.
pub mod effect {
    /// Reject the transfer if the condition holds.
    pub const DENY: u8 = 1;
    /// If the condition holds, reject when the amount exceeds the cap.
    pub const CAP_AMOUNT: u8 = 2;
    /// If the condition holds, reject when the destination's balance after
    /// the transfer exceeds the cap.
    pub const CAP_DEST_BALANCE: u8 = 3;
}

/// `SHA256("PHX-RULES-V1" || bytes)`: the content address of a rule set,
/// bound into the launch attestation. [`NO_RULES_HASH`] means none.
pub fn rules_hash<H: Sha256>(bytes: &[u8]) -> [u8; 32] {
    H::hashv(&[HASH_DOMAIN, bytes])
}

/// Encoded length for these counts.
#[allow(clippy::arithmetic_side_effects)] // at most 12 + 255 * 62: no overflow
pub const fn encoded_len(n_keys: u8, n_rules: u8, n_nodes: u8) -> usize {
    HEADER_LEN
        + KEY_LEN * n_keys as usize
        + RULE_LEN * n_rules as usize
        + NODE_LEN * n_nodes as usize
}

/// One rule (20 bytes).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Rule {
    /// First second of the window, relative to the guard start (inclusive).
    pub from_rel: u32,
    /// End of the window, relative to the guard start (exclusive).
    pub to_rel: u32,
    /// Index of the condition's first node.
    pub cond_off: u8,
    /// Number of condition nodes (at least 1).
    pub cond_len: u8,
    /// [`effect`].
    pub effect: u8,
    /// Code shown to users and logged on rejection (0..=63).
    pub code: u8,
    /// Cap of CAP effects (0 for DENY).
    pub arg: u64,
}

impl Rule {
    /// Decode 20 bytes.
    pub fn from_bytes(raw: &[u8; RULE_LEN]) -> Self {
        let mut r = Reader::new(raw);
        Self {
            from_rel: r.u32(),
            to_rel: r.u32(),
            cond_off: r.u8(),
            cond_len: r.u8(),
            effect: r.u8(),
            code: r.u8(),
            arg: r.u64(),
        }
    }

    /// Encode to 20 bytes.
    pub fn to_bytes(&self) -> [u8; RULE_LEN] {
        let [f0, f1, f2, f3] = self.from_rel.to_le_bytes();
        let [t0, t1, t2, t3] = self.to_rel.to_le_bytes();
        let [a0, a1, a2, a3, a4, a5, a6, a7] = self.arg.to_le_bytes();
        [
            f0,
            f1,
            f2,
            f3,
            t0,
            t1,
            t2,
            t3,
            self.cond_off,
            self.cond_len,
            self.effect,
            self.code,
            a0,
            a1,
            a2,
            a3,
            a4,
            a5,
            a6,
            a7,
        ]
    }

    /// Whether the rule applies at `now_rel` seconds after the guard start:
    /// `from_rel <= now_rel < to_rel`.
    pub fn active_at(&self, now_rel: i64) -> bool {
        i64::from(self.from_rel) <= now_rel && now_rel < i64::from(self.to_rel)
    }
}

/// Everything rules look at for one transfer (computed by the hook).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TransferCtx {
    /// Seconds since the guard started (`now - launch_ts`).
    pub now_rel: i64,
    /// The source is the pool's base vault.
    pub is_buy: bool,
    /// Neither side is the pool or the protocol.
    pub is_p2p: bool,
    /// Amount transferred.
    pub amount: u64,
    /// The destination's balance after the transfer.
    pub dest_balance_after: u64,
    /// The mint's current supply.
    pub supply: u64,
    /// Owner of the destination token account.
    pub dest_owner: [u8; 32],
    /// Owner of the source token account.
    pub src_owner: [u8; 32],
    /// Program id of the transaction's currently executing top-level
    /// instruction (instructions sysvar).
    pub top_program: [u8; 32],
    /// Number of top-level instructions in the transaction.
    pub tx_ix_count: u16,
}

/// A rejection: which rule (index) and its code.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Violation {
    /// Index of the rule that rejected.
    pub rule: u8,
    /// The rule's code, or [`CODE_MALFORMED`].
    pub code: u8,
}

/// A rule set over its bytes, without copying.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RuleSet<'a> {
    keys: &'a [[u8; KEY_LEN]],
    rules: &'a [[u8; RULE_LEN]],
    nodes: &'a [[u8; NODE_LEN]],
}

impl<'a> RuleSet<'a> {
    /// Check the header and the exact length only, in this order:
    /// `TooShort`, `BadMagic`, `BadVersion`, `ReservedNonZero`,
    /// `TooManyKeys`, `NoRules`, `TooManyRules`, `TooManyNodes`, `BadLength`.
    ///
    /// For bytes that were verified when they were stored (the hook's
    /// policy); everything else goes through [`RuleSet::verify`].
    pub fn parse(bytes: &'a [u8]) -> Result<Self, Error> {
        let (header, mut rest) = bytes
            .split_first_chunk::<HEADER_LEN>()
            .ok_or(Error::TooShort)?;
        let [m0, m1, m2, m3, version, n_keys, n_rules, n_nodes, r0, r1, r2, r3] = *header;
        if [m0, m1, m2, m3] != MAGIC {
            return Err(Error::BadMagic);
        }
        if version != VERSION {
            return Err(Error::BadVersion);
        }
        if [r0, r1, r2, r3] != [0; 4] {
            return Err(Error::ReservedNonZero);
        }
        if n_keys > MAX_KEYS {
            return Err(Error::TooManyKeys);
        }
        if n_rules == 0 {
            return Err(Error::NoRules);
        }
        if n_rules > MAX_RULES {
            return Err(Error::TooManyRules);
        }
        if n_nodes > MAX_NODES {
            return Err(Error::TooManyNodes);
        }
        if bytes.len() != encoded_len(n_keys, n_rules, n_nodes) {
            return Err(Error::BadLength);
        }
        let keys = take::<KEY_LEN>(&mut rest, n_keys).ok_or(Error::BadLength)?;
        let rules = take::<RULE_LEN>(&mut rest, n_rules).ok_or(Error::BadLength)?;
        let nodes = take::<NODE_LEN>(&mut rest, n_nodes).ok_or(Error::BadLength)?;
        Ok(Self { keys, rules, nodes })
    }

    /// Verify a rule set for a launch whose guard lasts `guard_secs`
    /// (capped at [`MAX_GUARD_SECS`]). Checks, in order (first failure
    /// wins):
    ///
    /// 1. [`RuleSet::parse`];
    /// 2. each key: `ZeroKey`, `DuplicateKey`;
    /// 3. each rule in order: `BadWindow` (`from_rel >= to_rel`),
    ///    `WindowPastGuard`, `BadCode`, the effect and its argument
    ///    (`UnknownEffect`, `DenyArgNonZero`, `ZeroCap`, `BadBps`),
    ///    `EmptyCondition`, `ConditionNotContiguous`, `ConditionOutOfRange`,
    ///    then each node of the condition (`UnknownOp`, operand errors, stack
    ///    errors; see [`crate::vm`]);
    /// 4. `UnreferencedNode` (the conditions do not end at `n_nodes`);
    /// 5. `UnusedKey`.
    pub fn verify(bytes: &'a [u8], guard_secs: u32) -> Result<Self, Error> {
        let set = Self::parse(bytes)?;
        for (i, key) in set.keys.iter().enumerate() {
            if *key == [0; KEY_LEN] {
                return Err(Error::ZeroKey);
            }
            if set.keys.iter().take(i).any(|k| k == key) {
                return Err(Error::DuplicateKey);
            }
        }
        let guard = guard_secs.min(MAX_GUARD_SECS);
        let all_keys = key_mask_all(set.keys.len());
        let mut leaves = RulesCheck {
            all_keys,
            guard,
            used_keys: 0,
        };
        let mut next: usize = 0;
        for raw in set.rules {
            let rule = Rule::from_bytes(raw);
            if rule.from_rel >= rule.to_rel {
                return Err(Error::BadWindow);
            }
            if rule.to_rel > guard {
                return Err(Error::WindowPastGuard);
            }
            if rule.code > MAX_CODE {
                return Err(Error::BadCode);
            }
            match rule.effect {
                effect::DENY => {
                    if rule.arg != 0 {
                        return Err(Error::DenyArgNonZero);
                    }
                }
                effect::CAP_AMOUNT | effect::CAP_DEST_BALANCE => {
                    if rule.arg & BPS_FLAG != 0 {
                        check_bps_arg(rule.arg)?;
                    } else if rule.arg == 0 {
                        return Err(Error::ZeroCap);
                    }
                }
                _ => return Err(Error::UnknownEffect),
            }
            if rule.cond_len == 0 {
                return Err(Error::EmptyCondition);
            }
            if usize::from(rule.cond_off) != next {
                return Err(Error::ConditionNotContiguous);
            }
            let end = next.saturating_add(usize::from(rule.cond_len));
            let cond = set.nodes.get(next..end).ok_or(Error::ConditionOutOfRange)?;
            vm::verify(cond, &mut leaves)?;
            next = end;
        }
        if next != set.nodes.len() {
            return Err(Error::UnreferencedNode);
        }
        if leaves.used_keys != all_keys {
            return Err(Error::UnusedKey);
        }
        Ok(set)
    }

    /// The keys condition masks refer to.
    pub fn keys(&self) -> &'a [[u8; KEY_LEN]] {
        self.keys
    }

    /// Number of rules.
    pub fn rule_count(&self) -> usize {
        self.rules.len()
    }

    /// Number of condition nodes.
    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    /// Rule `i`.
    pub fn rule(&self, i: usize) -> Option<Rule> {
        self.rules.get(i).map(Rule::from_bytes)
    }

    /// Condition node `i`.
    pub fn node(&self, i: usize) -> Option<Node> {
        self.nodes.get(i).map(Node::from_bytes)
    }

    /// Whether any condition uses leaf `op` (for example the hook reads the
    /// instructions sysvar only when [`op::rules::TOP_PROGRAM_IN`] or
    /// [`op::rules::TX_IX_COUNT_GT`] is used).
    pub fn uses_leaf(&self, leaf: u8) -> bool {
        self.nodes
            .iter()
            .any(|raw| Node::from_bytes(raw).op == leaf)
    }

    /// Whether rule `i`'s condition holds for `ctx` (whatever its window).
    /// `None` if there is no rule `i` or its condition is malformed (never
    /// for a verified rule set).
    pub fn condition(&self, i: usize, ctx: &TransferCtx) -> Option<bool> {
        let rule = self.rule(i)?;
        let start = usize::from(rule.cond_off);
        let cond = self
            .nodes
            .get(start..start.saturating_add(usize::from(rule.cond_len)))?;
        vm::eval(cond, &RulesEval::new(self.keys, ctx))
    }

    /// Decide one transfer: the active rules in order, the first one that
    /// rejects wins. A verified rule set never fails otherwise; on
    /// unverified bytes a malformed rule rejects with [`CODE_MALFORMED`]
    /// (fail closed).
    ///
    /// Cost: one pass over the rules; a condition is evaluated only for an
    /// active rule whose effect would reject (a CAP rule's cap is compared
    /// first), and since conditions partition the nodes, a transfer
    /// evaluates each node at most once.
    pub fn evaluate(&self, ctx: &TransferCtx) -> Result<(), Violation> {
        let mut leaves: Option<RulesEval<'_>> = None;
        for (i, raw) in self.rules.iter().enumerate() {
            let rule = Rule::from_bytes(raw);
            if !rule.active_at(ctx.now_rel) {
                continue;
            }
            let index = u8::try_from(i).unwrap_or(u8::MAX);
            let malformed = Violation {
                rule: index,
                code: CODE_MALFORMED,
            };
            let would_reject = match rule.effect {
                effect::DENY => true,
                effect::CAP_AMOUNT => exceeds(ctx.amount, rule.arg, ctx.supply),
                effect::CAP_DEST_BALANCE => exceeds(ctx.dest_balance_after, rule.arg, ctx.supply),
                _ => return Err(malformed),
            };
            if !would_reject {
                continue;
            }
            let start = usize::from(rule.cond_off);
            let cond = self
                .nodes
                .get(start..start.saturating_add(usize::from(rule.cond_len)))
                .ok_or(malformed)?;
            let eval = leaves.get_or_insert_with(|| RulesEval::new(self.keys, ctx));
            match vm::eval(cond, eval) {
                Some(true) => {
                    return Err(Violation {
                        rule: index,
                        code: rule.code,
                    })
                }
                Some(false) => {}
                None => return Err(malformed),
            }
        }
        Ok(())
    }
}

/// Mask with one bit per key (`n <= 8`).
fn key_mask_all(n: usize) -> u8 {
    let mut mask: u8 = 0;
    let mut bit: u8 = 1;
    for _ in 0..n.min(usize::from(MAX_KEYS)) {
        mask |= bit;
        bit = bit.wrapping_shl(1);
    }
    mask
}

/// Bit `i` set when `keys[i] == who`.
fn mask_of(keys: &[[u8; KEY_LEN]], who: &[u8; KEY_LEN]) -> u8 {
    let mut mask: u8 = 0;
    let mut bit: u8 = 1;
    for key in keys.iter().take(usize::from(MAX_KEYS)) {
        if key == who {
            mask |= bit;
        }
        bit = bit.wrapping_shl(1);
    }
    mask
}

struct RulesCheck {
    all_keys: u8,
    guard: u32,
    used_keys: u8,
}

impl RulesCheck {
    fn key_mask(&mut self, node: &Node) -> Result<(), Error> {
        if node.arg != 0 {
            return Err(Error::NonZeroOperand);
        }
        if node.a == 0 || node.a & !self.all_keys != 0 {
            return Err(Error::BadKeyMask);
        }
        self.used_keys |= node.a;
        Ok(())
    }
}

impl LeafCheck for RulesCheck {
    fn check_leaf(&mut self, node: &Node) -> Result<(), Error> {
        match node.op {
            op::rules::IS_BUY | op::rules::IS_P2P => {
                if node.a != 0 || node.arg != 0 {
                    return Err(Error::NonZeroOperand);
                }
            }
            op::rules::TIME_LT | op::rules::TIME_GE => {
                if node.a != 0 {
                    return Err(Error::NonZeroOperand);
                }
                if node.arg > u64::from(self.guard) {
                    return Err(Error::TimeOutOfRange);
                }
            }
            op::rules::AMOUNT_GT | op::rules::DEST_BAL_AFTER_GT => {
                if node.a != 0 {
                    return Err(Error::NonZeroOperand);
                }
                if node.arg & BPS_FLAG != 0 {
                    check_bps_arg(node.arg)?;
                }
            }
            op::rules::DEST_OWNER_IN | op::rules::SRC_OWNER_IN | op::rules::TOP_PROGRAM_IN => {
                self.key_mask(node)?;
            }
            op::rules::TX_IX_COUNT_GT => {
                if node.a != 0 {
                    return Err(Error::NonZeroOperand);
                }
            }
            _ => return Err(Error::UnknownOp),
        }
        Ok(())
    }
}

struct RulesEval<'c> {
    ctx: &'c TransferCtx,
    dest: u8,
    src: u8,
    top: u8,
}

impl<'c> RulesEval<'c> {
    fn new(keys: &[[u8; KEY_LEN]], ctx: &'c TransferCtx) -> Self {
        Self {
            ctx,
            dest: mask_of(keys, &ctx.dest_owner),
            src: mask_of(keys, &ctx.src_owner),
            top: mask_of(keys, &ctx.top_program),
        }
    }
}

impl LeafEval for RulesEval<'_> {
    fn eval_leaf(&self, node: &Node) -> Option<bool> {
        let c = self.ctx;
        Some(match node.op {
            op::rules::IS_BUY => c.is_buy,
            op::rules::IS_P2P => c.is_p2p,
            op::rules::TIME_LT => time_lt(c.now_rel, node.arg),
            op::rules::TIME_GE => !time_lt(c.now_rel, node.arg),
            op::rules::AMOUNT_GT => exceeds(c.amount, node.arg, c.supply),
            op::rules::DEST_BAL_AFTER_GT => exceeds(c.dest_balance_after, node.arg, c.supply),
            op::rules::DEST_OWNER_IN => self.dest & node.a != 0,
            op::rules::SRC_OWNER_IN => self.src & node.a != 0,
            op::rules::TOP_PROGRAM_IN => self.top & node.a != 0,
            op::rules::TX_IX_COUNT_GT => u64::from(c.tx_ix_count) > node.arg,
            _ => return None,
        })
    }
}

//! The condition mini-VM shared by launch rules and autopilot graphs.
//!
//! A condition is a postfix (RPN) array of [`Node`]s over a stack of
//! booleans. [`op::TRUE`], [`op::FALSE`] and every leaf predicate push one
//! value; [`op::AND`] and [`op::OR`] pop two and push one; [`op::NOT`] pops
//! one and pushes one. The leaves are context-specific: [`op::rules`] for
//! PXR1, [`op::graph`] for PXG1, and a leaf of the other context is an
//! unknown operation.
//!
//! Verification (per node, in order): the operation is known in the
//! context, the operands are valid for it (unused operands are zero), then
//! the stack effect: no underflow, never more than [`MAX_STACK`] values,
//! and exactly one value at the end. Evaluation is one pass over the nodes
//! with the stack held in the bits of a `u32`: no allocation, no recursion.
//! A second evaluator takes leaves that are uncertain (an autopilot price
//! that lies in a range) as two such stacks, "holds for every value" and
//! "holds for some", and answers the first (three-valued logic).

use crate::Error;

/// Bytes per node: `op u8 | a u8 | arg u64 (LE)`.
pub const NODE_LEN: usize = 10;
/// Maximum number of values on the stack.
pub const MAX_STACK: u8 = 16;

/// Operation codes.
pub mod op {
    /// Push true.
    pub const TRUE: u8 = 0x00;
    /// Push false.
    pub const FALSE: u8 = 0x01;
    /// Pop two, push their conjunction.
    pub const AND: u8 = 0x02;
    /// Pop two, push their disjunction.
    pub const OR: u8 = 0x03;
    /// Pop one, push its negation.
    pub const NOT: u8 = 0x04;

    /// Leaf predicates of launch rules (PXR1).
    pub mod rules {
        /// The transfer is a buy: its source is the pool's base vault.
        pub const IS_BUY: u8 = 0x10;
        /// Wallet to wallet: neither side is the pool or the protocol.
        pub const IS_P2P: u8 = 0x11;
        /// `now_rel < arg` (seconds since the guard started).
        pub const TIME_LT: u8 = 0x12;
        /// `now_rel >= arg`.
        pub const TIME_GE: u8 = 0x13;
        /// The amount exceeds `arg` (or `arg`'s bps of supply).
        pub const AMOUNT_GT: u8 = 0x14;
        /// The destination's balance after the transfer exceeds `arg` (or
        /// `arg`'s bps of supply).
        pub const DEST_BAL_AFTER_GT: u8 = 0x15;
        /// The destination's owner is one of the keys in mask `a`.
        pub const DEST_OWNER_IN: u8 = 0x16;
        /// The source's owner is one of the keys in mask `a`.
        pub const SRC_OWNER_IN: u8 = 0x17;
        /// The current top-level instruction's program is one of the keys in
        /// mask `a`.
        pub const TOP_PROGRAM_IN: u8 = 0x18;
        /// The transaction has more than `arg` top-level instructions.
        pub const TX_IX_COUNT_GT: u8 = 0x19;
    }

    /// Leaf predicates of autopilot graphs (PXG1).
    pub mod graph {
        /// The treasury holds at least `arg` lamports (wSOL).
        pub const TREASURY_SOL_GTE: u8 = 0x20;
        /// The treasury holds at least `arg` token units.
        pub const TREASURY_TOKEN_GTE: u8 = 0x21;
        /// The pool has graduated (migrated to DAMM v2).
        pub const GRADUATED: u8 = 0x22;
        /// The reference sqrt price (Q64.64) is at most `arg`.
        pub const PRICE_LTE: u8 = 0x23;
        /// The reference sqrt price (Q64.64) is at least `arg`.
        pub const PRICE_GTE: u8 = 0x24;
        /// Unix time `>= arg`.
        pub const TIME_GE: u8 = 0x25;
        /// Unix time `< arg`.
        pub const TIME_LT: u8 = 0x26;
        /// Graph node `a` ran fewer than `arg` times in its current epoch.
        pub const RUNS_IN_EPOCH_LT: u8 = 0x27;
    }
}

/// One condition node: `op u8 | a u8 | arg u64 (LE)`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Node {
    /// Operation code ([`op`]).
    pub op: u8,
    /// Small operand (key mask, node index), zero when unused.
    pub a: u8,
    /// Wide operand (amount, time, price), zero when unused.
    pub arg: u64,
}

impl Node {
    /// A node.
    pub const fn new(op: u8, a: u8, arg: u64) -> Self {
        Self { op, a, arg }
    }

    /// Decode 10 bytes.
    pub const fn from_bytes(raw: &[u8; NODE_LEN]) -> Self {
        let [op, a, b0, b1, b2, b3, b4, b5, b6, b7] = *raw;
        Self {
            op,
            a,
            arg: u64::from_le_bytes([b0, b1, b2, b3, b4, b5, b6, b7]),
        }
    }

    /// Encode to 10 bytes.
    pub const fn to_bytes(&self) -> [u8; NODE_LEN] {
        let [b0, b1, b2, b3, b4, b5, b6, b7] = self.arg.to_le_bytes();
        [self.op, self.a, b0, b1, b2, b3, b4, b5, b6, b7]
    }
}

/// Verify-time checks of a context's leaves.
pub(crate) trait LeafCheck {
    /// `Err(UnknownOp)` for an operation that is not a leaf of this
    /// context, or the operand error.
    fn check_leaf(&mut self, node: &Node) -> Result<(), Error>;
}

/// Evaluation of a context's leaves; `None` for an unknown operation.
pub(crate) trait LeafEval {
    fn eval_leaf(&self, node: &Node) -> Option<bool>;
}

fn require_no_operands(node: &Node) -> Result<(), Error> {
    if node.a != 0 || node.arg != 0 {
        return Err(Error::NonZeroOperand);
    }
    Ok(())
}

/// Verify one condition (see the module documentation for the order).
pub(crate) fn verify<L: LeafCheck>(nodes: &[[u8; NODE_LEN]], leaves: &mut L) -> Result<(), Error> {
    let mut depth: u8 = 0;
    for raw in nodes {
        let node = Node::from_bytes(raw);
        let pops: u8 = match node.op {
            op::TRUE | op::FALSE => {
                require_no_operands(&node)?;
                0
            }
            op::AND | op::OR => {
                require_no_operands(&node)?;
                2
            }
            op::NOT => {
                require_no_operands(&node)?;
                1
            }
            _ => {
                leaves.check_leaf(&node)?;
                0
            }
        };
        depth = depth.checked_sub(pops).ok_or(Error::StackUnderflow)?;
        if depth >= MAX_STACK {
            return Err(Error::StackOverflow);
        }
        depth = depth.saturating_add(1);
    }
    // Every node leaves at least one value, so a non-empty condition never
    // ends with an empty stack (callers never pass an empty one).
    if depth == 1 {
        Ok(())
    } else {
        Err(Error::LeftoverValues)
    }
}

/// Evaluate one condition. `None` only for a malformed condition (unknown
/// operation, stack underflow or overflow, not exactly one result), which
/// verification rules out.
pub(crate) fn eval<L: LeafEval>(nodes: &[[u8; NODE_LEN]], leaves: &L) -> Option<bool> {
    // Bit 0 is the top of the stack.
    let mut stack: u32 = 0;
    let mut depth: u8 = 0;
    for raw in nodes {
        let node = Node::from_bytes(raw);
        let bit: u32 = match node.op {
            op::TRUE => 1,
            op::FALSE => 0,
            op::AND | op::OR => {
                depth = depth.checked_sub(2)?;
                let x = stack & 1;
                let y = (stack >> 1) & 1;
                stack >>= 2;
                if node.op == op::AND {
                    x & y
                } else {
                    x | y
                }
            }
            op::NOT => {
                depth = depth.checked_sub(1)?;
                let x = stack & 1;
                stack >>= 1;
                x ^ 1
            }
            _ => u32::from(leaves.eval_leaf(&node)?),
        };
        if depth >= MAX_STACK {
            return None;
        }
        stack = (stack << 1) | bit;
        depth = depth.saturating_add(1);
    }
    if depth == 1 {
        Some(stack & 1 == 1)
    } else {
        None
    }
}

/// Evaluation of a context's leaves whose inputs are uncertain (a range of
/// values): each leaf as `(must, may)`, whether it holds for every value its
/// inputs may take and whether it holds for some; `None` for an unknown
/// operation.
pub(crate) trait LeafBounds {
    fn eval_leaf_bounds(&self, node: &Node) -> Option<(bool, bool)>;
}

/// Evaluate one condition whose leaves may be uncertain, in one pass, as
/// three-valued (Kleene) logic: AND and OR combine the `must` halves and
/// the `may` halves separately, NOT swaps them (`not may`, `not must`). The
/// result is the root's `must`: true only if the condition holds whatever
/// values the uncertain inputs take, so widening their range can only turn
/// it from true to false. With certain leaves (`must == may`) it is
/// [`eval`]. `None` exactly where [`eval`] gives `None`.
pub(crate) fn eval_bounded<L: LeafBounds>(nodes: &[[u8; NODE_LEN]], leaves: &L) -> Option<bool> {
    // Bit 0 is the top of each stack.
    let mut must: u32 = 0;
    let mut may: u32 = 0;
    let mut depth: u8 = 0;
    for raw in nodes {
        let node = Node::from_bytes(raw);
        let (m, y): (u32, u32) = match node.op {
            op::TRUE => (1, 1),
            op::FALSE => (0, 0),
            op::AND | op::OR => {
                depth = depth.checked_sub(2)?;
                let (m1, m2) = (must & 1, (must >> 1) & 1);
                let (y1, y2) = (may & 1, (may >> 1) & 1);
                must >>= 2;
                may >>= 2;
                if node.op == op::AND {
                    (m1 & m2, y1 & y2)
                } else {
                    (m1 | m2, y1 | y2)
                }
            }
            op::NOT => {
                depth = depth.checked_sub(1)?;
                let (m1, y1) = (must & 1, may & 1);
                must >>= 1;
                may >>= 1;
                (y1 ^ 1, m1 ^ 1)
            }
            _ => {
                let (m, y) = leaves.eval_leaf_bounds(&node)?;
                (u32::from(m), u32::from(y))
            }
        };
        if depth >= MAX_STACK {
            return None;
        }
        must = (must << 1) | m;
        may = (may << 1) | y;
        depth = depth.saturating_add(1);
    }
    if depth == 1 {
        Some(must & 1 == 1)
    } else {
        None
    }
}

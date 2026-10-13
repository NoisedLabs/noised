//! PXG1 autopilot graphs: post-launch automation of a token's treasury.
//!
//! ```text
//! "PXG1" | version u8 = 1 | n_recipients u8 (<= 8) | n_nodes_g u8 (1..=16) | n_cond u8 (<= 96)
//!        | flags u8 (bit 0 has_operator) | reserved [0; 3] | operator [u8; 32] (zero if none)
//!        | recipients [(Pubkey, bps u16); n_recipients] | gnodes [GNode; n_nodes_g] | cond nodes [Node; n_cond]
//! GNode (48 B) = trigger u8 | trigger_arg u64 | cond_off u8 | cond_len u8 | action u8 | operator_gated u8
//!                | epoch_secs u32 | budget_per_epoch u64 | p1 u64 | p2 u64 | max_runs_per_epoch u16 | reserved [0; 5]
//! ```
//!
//! Integers are little-endian; the length must be exact (at most
//! [`MAX_LEN`] = 2,044 bytes).
//!
//! Triggers ([`trigger`]): EVERY (`trigger_arg` seconds >= 600 since the
//! node's last run), AFTER (`trigger_arg` = a node index: once each time
//! that node succeeds), ON_GRADUATED (once, after migration), WHEN (the
//! condition alone). A node with `cond_len = 0` has no condition (always
//! true). Actions ([`action`]): BUYBACK_BURN (`p1` = max lamports in per
//! run, `p2` = max premium in bps over the reference price), BURN (`p1` =
//! max tokens per run), DISTRIBUTE_SOL (`p1` = max lamports per run, paid to
//! the recipients by bps). Each node spends at most `budget_per_epoch` and
//! runs at most `max_runs_per_epoch` times per epoch of `epoch_secs`.
//!
//! Canonical form, checked by [`Graph::verify`] on top of the limits:
//! recipients are distinct, non-zero, each with bps > 0, summing to 10,000,
//! and used by some DISTRIBUTE_SOL node; the operator key is set exactly
//! when the flag is, and some node is operator-gated exactly when there is
//! an operator; node `i`'s condition starts where the previous non-empty
//! condition ended (an empty one has `cond_off = 0`) and the last ends at
//! `n_cond`; AFTER references form no cycle; unused fields are zero.

use crate::vm::{self, op, LeafBounds, LeafCheck, LeafEval, Node, NODE_LEN};
use crate::{named_enum, take, time_lt, Error, Reader, Sha256, BPS_DENOMINATOR};

/// Magic bytes.
pub const MAGIC: [u8; 4] = *b"PXG1";
/// Format version.
pub const VERSION: u8 = 1;
/// Header bytes: magic, version, three counts, flags, three reserved, operator.
pub const HEADER_LEN: usize = 44;
/// Bytes per recipient: key, then bps (u16).
pub const RECIPIENT_LEN: usize = 34;
/// Bytes per graph node.
pub const GNODE_LEN: usize = 48;
/// Maximum number of recipients.
pub const MAX_RECIPIENTS: u8 = 8;
/// Maximum number of graph nodes.
pub const MAX_GRAPH_NODES: u8 = 16;
/// Maximum number of condition nodes.
pub const MAX_COND_NODES: u8 = 96;
/// Largest valid graph: 44 + 8 * 34 + 16 * 48 + 96 * 10 bytes.
pub const MAX_LEN: usize = 2_044;
/// Flag bit: the graph names an operator.
pub const FLAG_HAS_OPERATOR: u8 = 1;
/// Shortest EVERY period.
pub const MIN_EVERY_SECS: u64 = 600;
/// Shortest epoch.
pub const MIN_EPOCH_SECS: u32 = 3_600;
/// Largest buyback premium over the reference price, in bps (20%). A keeper
/// sandwiching a buyback gains at most about `premium * p1` per run.
pub const MAX_PREMIUM_BPS: u64 = 2_000;
/// Domain separator of [`graph_hash`].
pub const HASH_DOMAIN: &[u8; 12] = b"PHX-GRAPH-V1";

/// Triggers.
pub mod trigger {
    /// Due when `now >= last_run + trigger_arg` (seconds, >= 600).
    pub const EVERY: u8 = 1;
    /// Due once each time node `trigger_arg` succeeds.
    pub const AFTER: u8 = 2;
    /// Due once, after the pool graduated.
    pub const ON_GRADUATED: u8 = 3;
    /// Due whenever the condition holds (the condition is required).
    pub const WHEN: u8 = 4;
}

/// Actions (a closed catalogue).
pub mod action {
    /// Swap wSOL for the token on DAMM v2 (at most `p1` lamports in, at most
    /// `p2` bps over the reference price) and burn everything received.
    pub const BUYBACK_BURN: u8 = 1;
    /// Burn at most `p1` treasury tokens.
    pub const BURN: u8 = 2;
    /// Pay at most `p1` lamports of wSOL to the recipients by bps.
    pub const DISTRIBUTE_SOL: u8 = 3;
    /// Reserved (a later version): add permanently locked liquidity.
    pub const ADD_LOCKED_LIQUIDITY: u8 = 4;
    /// Reserved (a later version): Merkle airdrop.
    pub const MERKLE_AIRDROP: u8 = 5;
}

/// `SHA256("PHX-GRAPH-V1" || bytes)`: the content address of a graph.
pub fn graph_hash<H: Sha256>(bytes: &[u8]) -> [u8; 32] {
    H::hashv(&[HASH_DOMAIN, bytes])
}

/// Encoded length for these counts.
#[allow(clippy::arithmetic_side_effects)] // at most 44 + 255 * 92: no overflow
pub const fn encoded_len(n_recipients: u8, n_nodes: u8, n_cond: u8) -> usize {
    HEADER_LEN
        + RECIPIENT_LEN * n_recipients as usize
        + GNODE_LEN * n_nodes as usize
        + NODE_LEN * n_cond as usize
}

/// A payee of DISTRIBUTE_SOL (34 bytes).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Recipient {
    /// Owner of the recipient's wSOL account (a wallet or a PQ vault).
    pub key: [u8; 32],
    /// Share in basis points.
    pub bps: u16,
}

impl Recipient {
    /// Decode 34 bytes.
    pub fn from_bytes(raw: &[u8; RECIPIENT_LEN]) -> Self {
        let mut r = Reader::new(raw);
        Self {
            key: r.array(),
            bps: r.u16(),
        }
    }

    /// Encode to 34 bytes.
    pub fn to_bytes(&self) -> [u8; RECIPIENT_LEN] {
        let mut out = [0u8; RECIPIENT_LEN];
        let (key, bps) = out.split_at_mut(32);
        key.copy_from_slice(&self.key);
        bps.copy_from_slice(&self.bps.to_le_bytes());
        out
    }
}

/// One graph node (48 bytes).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct GNode {
    /// [`trigger`].
    pub trigger: u8,
    /// EVERY: seconds; AFTER: node index; otherwise 0.
    pub trigger_arg: u64,
    /// Index of the condition's first node (0 when there is none).
    pub cond_off: u8,
    /// Number of condition nodes; 0 = always.
    pub cond_len: u8,
    /// [`action`].
    pub action: u8,
    /// 1 if only the operator may run the node (choosing its timing and
    /// amount within the bounds), else 0.
    pub operator_gated: u8,
    /// Epoch length (>= 3,600 s).
    pub epoch_secs: u32,
    /// Spend limit per epoch (lamports, or token units for BURN).
    pub budget_per_epoch: u64,
    /// Per-run cap (see [`action`]).
    pub p1: u64,
    /// Action parameter (BUYBACK_BURN: max premium bps), else 0.
    pub p2: u64,
    /// Run limit per epoch (>= 1).
    pub max_runs_per_epoch: u16,
    /// Reserved, zero.
    pub reserved: [u8; 5],
}

impl GNode {
    /// Decode 48 bytes.
    pub fn from_bytes(raw: &[u8; GNODE_LEN]) -> Self {
        let mut r = Reader::new(raw);
        Self {
            trigger: r.u8(),
            trigger_arg: r.u64(),
            cond_off: r.u8(),
            cond_len: r.u8(),
            action: r.u8(),
            operator_gated: r.u8(),
            epoch_secs: r.u32(),
            budget_per_epoch: r.u64(),
            p1: r.u64(),
            p2: r.u64(),
            max_runs_per_epoch: r.u16(),
            reserved: r.array(),
        }
    }

    /// Encode to 48 bytes.
    pub fn to_bytes(&self) -> [u8; GNODE_LEN] {
        let mut out = [0u8; GNODE_LEN];
        let mut w: &mut [u8] = &mut out;
        for field in [
            &[self.trigger][..],
            &self.trigger_arg.to_le_bytes(),
            &[
                self.cond_off,
                self.cond_len,
                self.action,
                self.operator_gated,
            ],
            &self.epoch_secs.to_le_bytes(),
            &self.budget_per_epoch.to_le_bytes(),
            &self.p1.to_le_bytes(),
            &self.p2.to_le_bytes(),
            &self.max_runs_per_epoch.to_le_bytes(),
            &self.reserved,
        ] {
            let (head, tail) = core::mem::take(&mut w).split_at_mut(field.len());
            head.copy_from_slice(field);
            w = tail;
        }
        out
    }

    /// The AFTER parent, if this node has an AFTER trigger.
    pub fn after_parent(&self) -> Option<usize> {
        if self.trigger == trigger::AFTER {
            usize::try_from(self.trigger_arg).ok()
        } else {
            None
        }
    }
}

/// What graph conditions look at (computed by the autopilot program).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct GraphCtx {
    /// Unix time.
    pub now: i64,
    /// Treasury wSOL balance (lamports).
    pub treasury_sol: u64,
    /// Treasury token balance.
    pub treasury_token: u64,
    /// The pool migrated to DAMM v2.
    pub graduated: bool,
    /// The autopilot's reference sqrt price (Q64.64): the slow average
    /// updated by runs, never the spot price, which a caller can move
    /// within its own transaction. [`Graph::condition`] reads it;
    /// [`Graph::condition_over`] (what the autopilot decides with) reads a
    /// [`PriceRange`] instead.
    pub sqrt_price: u128,
    /// Each graph node's runs in its current epoch (see [`current_epoch`]).
    pub runs_in_epoch: [u16; MAX_GRAPH_NODES as usize],
}

/// The sqrt prices (Q64.64) a graph's price conditions must hold at: every
/// price from `low` to `high` (`low <= high`). See [`Graph::condition_over`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct PriceRange {
    /// The lowest sqrt price.
    pub low: u128,
    /// The highest sqrt price.
    pub high: u128,
}

impl PriceRange {
    /// The single price `p`: [`Graph::condition_over`] is then
    /// [`Graph::condition`] with `sqrt_price = p`.
    pub const fn at(p: u128) -> Self {
        Self { low: p, high: p }
    }
}

/// A graph node's run state, kept by the autopilot program.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct NodeState {
    /// Unix time of the last successful run (0 = never).
    pub last_run: i64,
    /// The autopilot's run sequence number at the last successful run (0 =
    /// never). The autopilot numbers successful runs 1, 2, 3, ... across all
    /// nodes, so AFTER can tell "the parent ran since I did" even within one
    /// second.
    pub last_seq: u64,
    /// Start of the epoch `runs_in_epoch` and `spent_in_epoch` count.
    pub epoch_start: i64,
    /// Successful runs in that epoch.
    pub runs_in_epoch: u16,
    /// Amount spent in that epoch.
    pub spent_in_epoch: u64,
}

/// A node's epoch at some time (see [`current_epoch`]).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Epoch {
    /// Start of the epoch.
    pub start: i64,
    /// Successful runs in it.
    pub runs: u16,
    /// Amount spent in it.
    pub spent: u64,
}

/// The epoch `state` is in at `now`: the stored one while
/// `now < epoch_start + epoch_secs` (or the clock is before it), otherwise a
/// fresh one (no runs, nothing spent) starting at the latest
/// `epoch_start + k * epoch_secs <= now`. Epochs stay aligned to the first
/// one, so callers cannot shift their boundaries by choosing when to run.
pub fn current_epoch(epoch_secs: u32, state: &NodeState, now: i64) -> Epoch {
    let stored = Epoch {
        start: state.epoch_start,
        runs: state.runs_in_epoch,
        spent: state.spent_in_epoch,
    };
    if now < state.epoch_start {
        return stored;
    }
    let len = u64::from(epoch_secs.max(1));
    let elapsed = now.abs_diff(state.epoch_start);
    if elapsed < len {
        return stored;
    }
    let into = i64::try_from(elapsed.checked_rem(len).unwrap_or(0)).unwrap_or(0);
    Epoch {
        start: now.saturating_sub(into),
        runs: 0,
        spent: 0,
    }
}

/// Whether the AFTER references `parent(i)` of nodes `0..n` are acyclic and
/// in range. `O(n^2)` steps, no recursion.
pub fn after_acyclic<F: Fn(usize) -> Option<usize>>(n: usize, parent: F) -> bool {
    for start in 0..n {
        let mut node = start;
        let mut steps: usize = 0;
        while let Some(p) = parent(node) {
            if p >= n || steps >= n {
                return false;
            }
            steps = steps.saturating_add(1);
            node = p;
        }
    }
    true
}

named_enum! {
    /// Why a graph node is not due.
    pub enum NotDue {
        /// No such node, or no state for it (or for its AFTER parent).
        NoSuchNode = 0,
        /// EVERY: the period since the last run has not passed.
        Waiting = 1,
        /// AFTER: the parent has not succeeded since this node last ran.
        AwaitingParent = 2,
        /// ON_GRADUATED: the pool has not graduated.
        NotGraduated = 3,
        /// ON_GRADUATED: it already ran.
        AlreadyRan = 4,
        /// The node ran `max_runs_per_epoch` times this epoch.
        MaxRunsReached = 5,
        /// The node spent its budget this epoch.
        BudgetSpent = 6,
        /// The condition does not hold.
        ConditionFalse = 7,
        /// Malformed node (never for a verified graph).
        Malformed = 8,
    }
}

/// A graph over its bytes, without copying.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Graph<'a> {
    flags: u8,
    operator: &'a [u8; 32],
    recipients: &'a [[u8; RECIPIENT_LEN]],
    nodes: &'a [[u8; GNODE_LEN]],
    cond: &'a [[u8; NODE_LEN]],
}

impl<'a> Graph<'a> {
    /// Check the header and the exact length only, in this order:
    /// `TooShort`, `BadMagic`, `BadVersion`, `UnknownFlags`,
    /// `ReservedNonZero`, `TooManyRecipients`, `NoGraphNodes`,
    /// `TooManyGraphNodes`, `TooManyNodes`, `BadLength`.
    pub fn parse(bytes: &'a [u8]) -> Result<Self, Error> {
        let (header, rest) = bytes.split_first_chunk::<12>().ok_or(Error::TooShort)?;
        let (operator, mut rest) = rest.split_first_chunk::<32>().ok_or(Error::TooShort)?;
        let [m0, m1, m2, m3, version, n_recipients, n_nodes, n_cond, flags, r0, r1, r2] = *header;
        if [m0, m1, m2, m3] != MAGIC {
            return Err(Error::BadMagic);
        }
        if version != VERSION {
            return Err(Error::BadVersion);
        }
        if flags & !FLAG_HAS_OPERATOR != 0 {
            return Err(Error::UnknownFlags);
        }
        if [r0, r1, r2] != [0; 3] {
            return Err(Error::ReservedNonZero);
        }
        if n_recipients > MAX_RECIPIENTS {
            return Err(Error::TooManyRecipients);
        }
        if n_nodes == 0 {
            return Err(Error::NoGraphNodes);
        }
        if n_nodes > MAX_GRAPH_NODES {
            return Err(Error::TooManyGraphNodes);
        }
        if n_cond > MAX_COND_NODES {
            return Err(Error::TooManyNodes);
        }
        if bytes.len() != encoded_len(n_recipients, n_nodes, n_cond) {
            return Err(Error::BadLength);
        }
        let recipients = take::<RECIPIENT_LEN>(&mut rest, n_recipients).ok_or(Error::BadLength)?;
        let nodes = take::<GNODE_LEN>(&mut rest, n_nodes).ok_or(Error::BadLength)?;
        let cond = take::<NODE_LEN>(&mut rest, n_cond).ok_or(Error::BadLength)?;
        Ok(Self {
            flags,
            operator,
            recipients,
            nodes,
            cond,
        })
    }

    /// Verify a graph. Checks, in order (first failure wins):
    ///
    /// 1. [`Graph::parse`];
    /// 2. the operator: `MissingOperator` (flag set, key zero),
    ///    `UnexpectedOperator` (key set, flag clear);
    /// 3. each recipient: `ZeroRecipient`, `DuplicateRecipient`,
    ///    `ZeroRecipientBps`; then `BadRecipientBps` (sum != 10,000);
    /// 4. each node in order: `ReservedNonZero`; the trigger
    ///    (`UnknownTrigger`, `EveryTooShort`, `BadAfterRef`, `AfterCycle`
    ///    for a node after itself, `TriggerArgNonZero`,
    ///    `WhenWithoutCondition`); the action (`UnknownAction`,
    ///    `ReservedAction`); `ZeroP1`; `PremiumTooHigh` / `P2NonZero`;
    ///    `NoRecipients`; `BadOperatorGated`, `GatedWithoutOperator`;
    ///    `EpochTooShort`; `ZeroBudget`; `ZeroMaxRuns`; the condition
    ///    (`ConditionNotContiguous`, `ConditionOutOfRange`, then each node:
    ///    see [`crate::vm`]);
    /// 5. `UnreferencedNode`, `AfterCycle`, `OperatorUnused`,
    ///    `RecipientsUnused`.
    pub fn verify(bytes: &'a [u8]) -> Result<Self, Error> {
        let g = Self::parse(bytes)?;
        let has_operator = g.flags & FLAG_HAS_OPERATOR != 0;
        let zero_operator = *g.operator == [0; 32];
        if has_operator && zero_operator {
            return Err(Error::MissingOperator);
        }
        if !has_operator && !zero_operator {
            return Err(Error::UnexpectedOperator);
        }
        let mut bps_sum: u32 = 0;
        for (i, raw) in g.recipients.iter().enumerate() {
            let r = Recipient::from_bytes(raw);
            if r.key == [0; 32] {
                return Err(Error::ZeroRecipient);
            }
            if g.recipients
                .iter()
                .take(i)
                .any(|o| Recipient::from_bytes(o).key == r.key)
            {
                return Err(Error::DuplicateRecipient);
            }
            if r.bps == 0 {
                return Err(Error::ZeroRecipientBps);
            }
            bps_sum = bps_sum.saturating_add(u32::from(r.bps));
        }
        if !g.recipients.is_empty() && u64::from(bps_sum) != BPS_DENOMINATOR {
            return Err(Error::BadRecipientBps);
        }

        let n = g.nodes.len();
        let mut leaves = GraphCheck { n_nodes: n };
        let mut next: usize = 0;
        let (mut any_gated, mut any_distribute) = (false, false);
        for (i, raw) in g.nodes.iter().enumerate() {
            let node = GNode::from_bytes(raw);
            if node.reserved != [0; 5] {
                return Err(Error::ReservedNonZero);
            }
            match node.trigger {
                trigger::EVERY => {
                    if node.trigger_arg < MIN_EVERY_SECS {
                        return Err(Error::EveryTooShort);
                    }
                }
                trigger::AFTER => match usize::try_from(node.trigger_arg) {
                    Ok(p) if p < n => {
                        if p == i {
                            return Err(Error::AfterCycle);
                        }
                    }
                    _ => return Err(Error::BadAfterRef),
                },
                trigger::ON_GRADUATED | trigger::WHEN => {
                    if node.trigger_arg != 0 {
                        return Err(Error::TriggerArgNonZero);
                    }
                    if node.trigger == trigger::WHEN && node.cond_len == 0 {
                        return Err(Error::WhenWithoutCondition);
                    }
                }
                _ => return Err(Error::UnknownTrigger),
            }
            match node.action {
                action::BUYBACK_BURN | action::BURN | action::DISTRIBUTE_SOL => {}
                action::ADD_LOCKED_LIQUIDITY | action::MERKLE_AIRDROP => {
                    return Err(Error::ReservedAction)
                }
                _ => return Err(Error::UnknownAction),
            }
            if node.p1 == 0 {
                return Err(Error::ZeroP1);
            }
            if node.action == action::BUYBACK_BURN {
                if node.p2 > MAX_PREMIUM_BPS {
                    return Err(Error::PremiumTooHigh);
                }
            } else if node.p2 != 0 {
                return Err(Error::P2NonZero);
            }
            if node.action == action::DISTRIBUTE_SOL {
                if g.recipients.is_empty() {
                    return Err(Error::NoRecipients);
                }
                any_distribute = true;
            }
            match node.operator_gated {
                0 => {}
                1 => {
                    if !has_operator {
                        return Err(Error::GatedWithoutOperator);
                    }
                    any_gated = true;
                }
                _ => return Err(Error::BadOperatorGated),
            }
            if node.epoch_secs < MIN_EPOCH_SECS {
                return Err(Error::EpochTooShort);
            }
            if node.budget_per_epoch == 0 {
                return Err(Error::ZeroBudget);
            }
            if node.max_runs_per_epoch == 0 {
                return Err(Error::ZeroMaxRuns);
            }
            if node.cond_len == 0 {
                if node.cond_off != 0 {
                    return Err(Error::ConditionNotContiguous);
                }
            } else {
                if usize::from(node.cond_off) != next {
                    return Err(Error::ConditionNotContiguous);
                }
                let end = next.saturating_add(usize::from(node.cond_len));
                let cond = g.cond.get(next..end).ok_or(Error::ConditionOutOfRange)?;
                vm::verify(cond, &mut leaves)?;
                next = end;
            }
        }
        if next != g.cond.len() {
            return Err(Error::UnreferencedNode);
        }
        if !after_acyclic(n, |i| g.node(i).and_then(|node| node.after_parent())) {
            return Err(Error::AfterCycle);
        }
        if has_operator && !any_gated {
            return Err(Error::OperatorUnused);
        }
        if !g.recipients.is_empty() && !any_distribute {
            return Err(Error::RecipientsUnused);
        }
        Ok(g)
    }

    /// The flags byte.
    pub fn flags(&self) -> u8 {
        self.flags
    }

    /// The operator field as stored (zero when there is no operator).
    pub fn operator_field(&self) -> &'a [u8; 32] {
        self.operator
    }

    /// The operator key, if the graph has one.
    pub fn operator(&self) -> Option<&'a [u8; 32]> {
        if self.flags & FLAG_HAS_OPERATOR != 0 {
            Some(self.operator)
        } else {
            None
        }
    }

    /// Number of recipients.
    pub fn recipient_count(&self) -> usize {
        self.recipients.len()
    }

    /// Recipient `i`.
    pub fn recipient(&self, i: usize) -> Option<Recipient> {
        self.recipients.get(i).map(Recipient::from_bytes)
    }

    /// Number of graph nodes.
    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    /// Graph node `i`.
    pub fn node(&self, i: usize) -> Option<GNode> {
        self.nodes.get(i).map(GNode::from_bytes)
    }

    /// Number of condition nodes.
    pub fn cond_count(&self) -> usize {
        self.cond.len()
    }

    /// Condition node `i`.
    pub fn cond_node(&self, i: usize) -> Option<Node> {
        self.cond.get(i).map(Node::from_bytes)
    }

    /// Whether node `i`'s condition holds (true when it has none). `None`
    /// if there is no node `i` or its condition is malformed (never for a
    /// verified graph).
    pub fn condition(&self, i: usize, ctx: &GraphCtx) -> Option<bool> {
        let node = self.node(i)?;
        if node.cond_len == 0 {
            return Some(true);
        }
        let start = usize::from(node.cond_off);
        let cond = self
            .cond
            .get(start..start.saturating_add(usize::from(node.cond_len)))?;
        vm::eval(cond, &GraphEval { ctx })
    }

    /// Each node's runs in its current epoch at `now` (zero past the
    /// nodes or the states), for [`GraphCtx::runs_in_epoch`].
    pub fn runs_in_epoch(&self, states: &[NodeState], now: i64) -> [u16; MAX_GRAPH_NODES as usize] {
        let mut runs = [0u16; MAX_GRAPH_NODES as usize];
        for ((slot, raw), state) in runs.iter_mut().zip(self.nodes).zip(states) {
            *slot = current_epoch(GNode::from_bytes(raw).epoch_secs, state, now).runs;
        }
        runs
    }

    /// Whether node `i` is due at `now` given every node's state (`states`
    /// indexed like the nodes): the trigger, then the run limit, then the
    /// budget, in this order. The condition is checked separately
    /// ([`Graph::condition`], or [`Graph::runnable`] for both).
    pub fn due(
        &self,
        i: usize,
        states: &[NodeState],
        now: i64,
        graduated: bool,
    ) -> Result<(), NotDue> {
        let node = self.node(i).ok_or(NotDue::NoSuchNode)?;
        let state = states.get(i).ok_or(NotDue::NoSuchNode)?;
        match node.trigger {
            trigger::EVERY => {
                // Exact: both terms are below 2^64 in magnitude.
                let due_at =
                    i128::from(state.last_run).saturating_add(i128::from(node.trigger_arg));
                if i128::from(now) < due_at {
                    return Err(NotDue::Waiting);
                }
            }
            trigger::AFTER => {
                let parent = node
                    .after_parent()
                    .and_then(|p| states.get(p))
                    .ok_or(NotDue::NoSuchNode)?;
                if parent.last_seq <= state.last_seq {
                    return Err(NotDue::AwaitingParent);
                }
            }
            trigger::ON_GRADUATED => {
                if state.last_seq != 0 {
                    return Err(NotDue::AlreadyRan);
                }
                if !graduated {
                    return Err(NotDue::NotGraduated);
                }
            }
            trigger::WHEN => {}
            _ => return Err(NotDue::Malformed),
        }
        let epoch = current_epoch(node.epoch_secs, state, now);
        if epoch.runs >= node.max_runs_per_epoch {
            return Err(NotDue::MaxRunsReached);
        }
        if epoch.spent >= node.budget_per_epoch {
            return Err(NotDue::BudgetSpent);
        }
        Ok(())
    }

    /// [`Graph::due`] (at `ctx.now`, with `ctx.graduated`), then the
    /// condition (`ConditionFalse`; `Malformed` never for a verified graph).
    pub fn runnable(&self, i: usize, states: &[NodeState], ctx: &GraphCtx) -> Result<(), NotDue> {
        self.due(i, states, ctx.now, ctx.graduated)?;
        match self.condition(i, ctx) {
            Some(true) => Ok(()),
            Some(false) => Err(NotDue::ConditionFalse),
            None => Err(NotDue::Malformed),
        }
    }

    /// Whether node `i`'s condition holds for **every** sqrt price in
    /// `prices` (`ctx.sqrt_price` is not read): `PRICE_GTE x` needs
    /// `prices.low >= x`, `PRICE_LTE x` needs `prices.high <= x`, and under
    /// NOT the other end decides (three-valued evaluation: a leaf "holds for
    /// every price" or "for some", and NOT swaps the two). A wider range can
    /// therefore only turn a condition false. This is what the autopilot
    /// decides with (review F1): the range spans the reference and every
    /// price observed in its window, so one pumped or dumped observation can
    /// hold a node back but never make its condition true. With a single
    /// price ([`PriceRange::at`]) it is [`Graph::condition`]. True without a
    /// condition; `None` as [`Graph::condition`].
    pub fn condition_over(&self, i: usize, ctx: &GraphCtx, prices: PriceRange) -> Option<bool> {
        let node = self.node(i)?;
        if node.cond_len == 0 {
            return Some(true);
        }
        let start = usize::from(node.cond_off);
        let cond = self
            .cond
            .get(start..start.saturating_add(usize::from(node.cond_len)))?;
        vm::eval_bounded(cond, &GraphBounds { ctx, prices })
    }

    /// [`Graph::due`], then the condition over `prices`
    /// ([`Graph::condition_over`]; `ConditionFalse`, `Malformed` never for a
    /// verified graph).
    pub fn runnable_over(
        &self,
        i: usize,
        states: &[NodeState],
        ctx: &GraphCtx,
        prices: PriceRange,
    ) -> Result<(), NotDue> {
        self.due(i, states, ctx.now, ctx.graduated)?;
        match self.condition_over(i, ctx, prices) {
            Some(true) => Ok(()),
            Some(false) => Err(NotDue::ConditionFalse),
            None => Err(NotDue::Malformed),
        }
    }

    /// What node `i` may still spend this epoch: `budget_per_epoch` minus
    /// what it spent, at most `p1` (the per-run cap).
    pub fn run_cap(&self, i: usize, state: &NodeState, now: i64) -> u64 {
        let Some(node) = self.node(i) else {
            return 0;
        };
        let epoch = current_epoch(node.epoch_secs, state, now);
        node.budget_per_epoch
            .saturating_sub(epoch.spent)
            .min(node.p1)
    }

    /// DISTRIBUTE_SOL's split of `amount`: recipient `i` gets
    /// `floor(amount * bps_i / 10_000)`; the rounding dust stays in the
    /// treasury. Entries past the recipients are zero, and so is a share
    /// that does not fit in a `u64` (only possible with unverified bps above
    /// 10,000).
    pub fn shares(&self, amount: u64) -> [u64; MAX_RECIPIENTS as usize] {
        let mut out = [0u64; MAX_RECIPIENTS as usize];
        for (slot, raw) in out.iter_mut().zip(self.recipients) {
            let bps = u128::from(Recipient::from_bytes(raw).bps);
            let share = u128::from(amount)
                .saturating_mul(bps)
                .checked_div(u128::from(BPS_DENOMINATOR))
                .unwrap_or(0);
            *slot = u64::try_from(share).unwrap_or(0);
        }
        out
    }
}

struct GraphCheck {
    n_nodes: usize,
}

impl LeafCheck for GraphCheck {
    fn check_leaf(&mut self, node: &Node) -> Result<(), Error> {
        match node.op {
            op::graph::TREASURY_SOL_GTE
            | op::graph::TREASURY_TOKEN_GTE
            | op::graph::PRICE_LTE
            | op::graph::PRICE_GTE => {
                if node.a != 0 {
                    return Err(Error::NonZeroOperand);
                }
            }
            op::graph::GRADUATED => {
                if node.a != 0 || node.arg != 0 {
                    return Err(Error::NonZeroOperand);
                }
            }
            op::graph::TIME_GE | op::graph::TIME_LT => {
                if node.a != 0 {
                    return Err(Error::NonZeroOperand);
                }
                if i64::try_from(node.arg).is_err() {
                    return Err(Error::TimeOutOfRange);
                }
            }
            op::graph::RUNS_IN_EPOCH_LT => {
                if usize::from(node.a) >= self.n_nodes {
                    return Err(Error::BadNodeRef);
                }
            }
            _ => return Err(Error::UnknownOp),
        }
        Ok(())
    }
}

struct GraphEval<'c> {
    ctx: &'c GraphCtx,
}

/// Graph leaves over a range of prices: the price leaves as (holds at every
/// price of the range, holds at some), every other leaf certain.
struct GraphBounds<'c> {
    ctx: &'c GraphCtx,
    prices: PriceRange,
}

impl LeafBounds for GraphBounds<'_> {
    fn eval_leaf_bounds(&self, node: &Node) -> Option<(bool, bool)> {
        let arg = u128::from(node.arg);
        let PriceRange { low, high } = self.prices;
        Some(match node.op {
            op::graph::PRICE_LTE => (high <= arg, low <= arg),
            op::graph::PRICE_GTE => (low >= arg, high >= arg),
            _ => {
                let v = GraphEval { ctx: self.ctx }.eval_leaf(node)?;
                (v, v)
            }
        })
    }
}

impl LeafEval for GraphEval<'_> {
    fn eval_leaf(&self, node: &Node) -> Option<bool> {
        let c = self.ctx;
        Some(match node.op {
            op::graph::TREASURY_SOL_GTE => c.treasury_sol >= node.arg,
            op::graph::TREASURY_TOKEN_GTE => c.treasury_token >= node.arg,
            op::graph::GRADUATED => c.graduated,
            op::graph::PRICE_LTE => c.sqrt_price <= u128::from(node.arg),
            op::graph::PRICE_GTE => c.sqrt_price >= u128::from(node.arg),
            op::graph::TIME_GE => !time_lt(c.now, node.arg),
            op::graph::TIME_LT => time_lt(c.now, node.arg),
            op::graph::RUNS_IN_EPOCH_LT => {
                u64::from(*c.runs_in_epoch.get(usize::from(node.a))?) < node.arg
            }
            _ => return None,
        })
    }
}

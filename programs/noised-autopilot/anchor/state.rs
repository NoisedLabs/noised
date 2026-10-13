//! Account layouts. Nothing here is ever closed.

use anchor_lang::prelude::*;
use noised_rules::graph::{NodeState, MAX_GRAPH_NODES};

use crate::reference::PriceState;

pub const MAX_NODES: usize = MAX_GRAPH_NODES as usize;

/// A graph node's run state (`noised_rules::NodeState`, stored).
#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace,
)]
pub struct NodeRecord {
    /// Unix time of the last successful run (0 = never).
    pub last_run: i64,
    /// `Autopilot::seq` at the last successful run (0 = never).
    pub last_seq: u64,
    /// Start of the epoch the two counters below count.
    pub epoch_start: i64,
    pub runs_in_epoch: u16,
    /// Lamports (BUYBACK_BURN, DISTRIBUTE_SOL) or raw tokens (BURN).
    pub spent_in_epoch: u64,
}

impl From<NodeRecord> for NodeState {
    fn from(r: NodeRecord) -> Self {
        NodeState {
            last_run: r.last_run,
            last_seq: r.last_seq,
            epoch_start: r.epoch_start,
            runs_in_epoch: r.runs_in_epoch,
            spent_in_epoch: r.spent_in_epoch,
        }
    }
}

/// The lowest and highest pool price observed during one bucket of
/// `OBS_BUCKET_SECS` (`reference.rs`). Empty while `min == 0` (no pool has a
/// zero price).
#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace,
)]
pub struct ObsBucket {
    /// `unix_time.div_euclid(OBS_BUCKET_SECS)` of the observations.
    pub index: i64,
    /// When the first of them was made.
    pub first_at: i64,
    /// Lowest and highest sqrt price (Q64.64) observed.
    pub min: u128,
    pub max: u128,
}

impl ObsBucket {
    pub fn is_empty(&self) -> bool {
        self.min == 0
    }
}

/// The latest authorization of one kind that was used (`governance.rs`):
/// authorizations are ordered by `(slot, address)`, so each is used at most
/// once and never after a newer one of the kinds that could undo it.
#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace,
)]
pub struct AuthMark {
    pub slot: u64,
    pub key: Pubkey,
}

/// A launch's autopilot, at `["autopilot", launch]` (spec §4). Created by
/// anyone; changed only by the instructions of this program: the graph only
/// through a post-quantum authorization of the launch's identity and the
/// timelock, the node states only by successful runs, the reference price
/// only toward what observations of the pool agree on (`reference.rs`).
#[account]
#[derive(InitSpace)]
pub struct Autopilot {
    pub version: u8,
    pub bump: u8,
    /// Bump of the treasury authority `["treasury", launch]`.
    pub treasury_bump: u8,
    pub launch: Pubkey,
    /// The launch's mint, bound once it is live (`bind_mint`; default until
    /// then).
    pub mint: Pubkey,
    /// The launch's DAMM v2 pool, bound once DBC migrated the curve
    /// (`bind_pool`; default until then: the launch has not graduated).
    pub damm_pool: Pubkey,
    /// Hash of the graph that runs (zero: none yet).
    pub active_graph: [u8; 32],
    /// An authorized graph waiting for `activate_at` (zero: none).
    pub pending_graph: [u8; 32],
    pub pending_activate_at: i64,
    /// The operator the pending graph gets when applied (its own, unless a
    /// revocation took it away).
    pub pending_operator: Pubkey,
    /// When the active graph took effect.
    pub activated_at: i64,
    /// The active graph can never change again (`freeze`).
    pub frozen: bool,
    /// The active graph's operator, the only signer of its operator-gated
    /// nodes (default: none, or revoked).
    pub operator: Pubkey,
    /// The latest authorization used, per kind (activate, freeze, revoke).
    pub auth_marks: [AuthMark; 3],
    /// Successful runs so far, across all nodes and graphs.
    pub seq: u64,
    /// The reference sqrt price (Q64.64), which bounds buybacks and which
    /// price conditions read together with the observed prices
    /// (`logic::condition_prices`): seeded with the launch's migration
    /// price, then moved toward the prices observations of the pool agree
    /// on, rising at most 5% per hour.
    pub ref_sqrt_price: u128,
    /// When the reference last moved (0: never).
    pub ref_updated_at: i64,
    /// The rise allowance (sqrt-bps-seconds) and when it last accrued.
    pub ref_allowance: u64,
    pub ref_allowance_at: i64,
    /// Observations of the pool price: the current bucket, then the
    /// previous one.
    pub observations: [ObsBucket; 2],
    /// The tip epoch `tips_in_epoch` counts (a multiple of `TIP_EPOCH_SECS`).
    pub tip_epoch_start: i64,
    pub tips_in_epoch: u64,
    /// Indexed like the active graph's nodes.
    pub nodes: [NodeRecord; MAX_NODES],
    /// The launchpad `Authorization` that activated the active graph and the
    /// `activate_at` it signed (audit 4, A4-S; set by `apply_pending`): with
    /// `active_graph` they give the authorization's payload hash, so anyone
    /// can re-verify the running graph's LMS signature from this account.
    /// A revocation names this authorization (`revoke_payload`). Default
    /// and 0 until a graph is active.
    pub active_auth: Pubkey,
    pub active_activate_at: i64,
    /// Indexed like the nodes: what keepers' partial buybacks moved since
    /// the node last completed a run (audit 4, A4-2). Until it does, a run
    /// moves at most `p1` minus this, so splitting a run never moves more
    /// than the run would. Cleared by a completed run and by a new graph.
    pub partial_spent: [u64; MAX_NODES],
}

impl Autopilot {
    pub const VERSION: u8 = 1;

    pub fn node_states(&self) -> [NodeState; MAX_NODES] {
        self.nodes.map(NodeState::from)
    }

    /// The reference price and the observations, as `reference.rs` uses
    /// them.
    pub fn price_state(&self) -> PriceState {
        PriceState {
            reference: self.ref_sqrt_price,
            updated_at: self.ref_updated_at,
            allowance: self.ref_allowance,
            allowance_at: self.ref_allowance_at,
            observations: self.observations,
        }
    }

    pub fn set_price_state(&mut self, p: &PriceState) {
        self.ref_sqrt_price = p.reference;
        self.ref_updated_at = p.updated_at;
        self.ref_allowance = p.allowance;
        self.ref_allowance_at = p.allowance_at;
        self.observations = p.observations;
    }
}

/// A published PXG1 graph, at `["graph", launch, graph_hash]` where
/// `graph_hash = SHA256("PHX-GRAPH-V1" || bytes)`. Created whole by
/// `publish_graph` after `Graph::verify`, never modified or closed.
#[account]
pub struct GraphRecord {
    pub version: u8,
    pub bump: u8,
    pub launch: Pubkey,
    pub graph_hash: [u8; 32],
    pub bytes: Vec<u8>,
}

impl GraphRecord {
    pub const VERSION: u8 = 1;

    /// Account space for a graph of `len` bytes: exactly its borsh encoding.
    pub fn space(len: usize) -> usize {
        8 + 1 + 1 + 32 + 32 + 4 + len
    }
}

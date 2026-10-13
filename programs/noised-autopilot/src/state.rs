//! Account layouts. Nothing here is ever closed.
//!
//! Account data is the 8-byte discriminator (`sha256("account:<Name>")[..8]`)
//! then the fields in Borsh, in declaration order (`tests/abi.rs` checks
//! [`Autopilot::read`] / [`Autopilot::write`] and the [`GraphRecord`] codec
//! against Anchor's serialization and the IDL). Off-chain the types also
//! carry Anchor's `#[account]` traits (`AccountDeserialize`, ...), as the
//! Anchor build had them.

use alloc::boxed::Box;
#[cfg(not(target_os = "solana"))]
use anchor_lang::{AnchorDeserialize, AnchorSerialize, Discriminator};

use noised_onchain::{accounts::ProgramAccount, args::Reader};
use noised_rules::graph::{NodeState, MAX_GRAPH_NODES};

use crate::{discriminator, reference::PriceState, Pubkey};

pub const MAX_NODES: usize = MAX_GRAPH_NODES as usize;

/// A graph node's run state (`noised_rules::NodeState`, stored).
#[cfg_attr(
    not(target_os = "solana"),
    derive(AnchorSerialize, AnchorDeserialize, anchor_lang::InitSpace)
)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
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
#[cfg_attr(
    not(target_os = "solana"),
    derive(AnchorSerialize, AnchorDeserialize, anchor_lang::InitSpace)
)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
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
#[cfg_attr(
    not(target_os = "solana"),
    derive(AnchorSerialize, AnchorDeserialize, anchor_lang::InitSpace)
)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AuthMark {
    pub slot: u64,
    pub key: Pubkey,
}

/// A launch's autopilot, at `["autopilot", launch]` (spec §4). Created by
/// anyone; changed only by the instructions of this program: the graph only
/// through a post-quantum authorization of the launch's identity and the
/// timelock, the node states only by successful runs, the reference price
/// only toward what observations of the pool agree on (`reference.rs`).
#[cfg_attr(not(target_os = "solana"), anchor_lang::account)]
#[cfg_attr(not(target_os = "solana"), derive(anchor_lang::InitSpace))]
#[cfg_attr(target_os = "solana", derive(Clone))]
#[derive(Debug, Default, PartialEq, Eq)]
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
    /// Account size: discriminator and fields (`8 + INIT_SPACE`).
    pub const LEN: usize = 1_244;

    /// The node states, as `noised_rules` reads them.
    #[inline(never)]
    pub fn node_states(&self) -> [NodeState; MAX_NODES] {
        let mut states = [NodeState::default(); MAX_NODES];
        for (state, node) in states.iter_mut().zip(&self.nodes) {
            *state = NodeState::from(*node);
        }
        states
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

    /// Borsh decoding of the fields from account data (discriminator
    /// included, not checked here): `None` when the data is shorter than
    /// [`Autopilot::LEN`] or `frozen` is not 0 or 1 (Anchor's
    /// `AccountDidNotDeserialize`). Bytes after the fields are ignored.
    pub fn read(data: &[u8]) -> Option<Self> {
        Self::read_boxed(data).map(|account| *account)
    }

    /// [`Autopilot::read`], decoded in place on the heap (the instructions
    /// load the account this way: `ProgramAccount` for `Box<Autopilot>`).
    #[inline(never)]
    pub fn read_boxed(data: &[u8]) -> Option<Box<Self>> {
        use layout::*;
        let d: &[u8; Self::LEN] = data.first_chunk()?;
        let frozen = match d[FROZEN] {
            0 => false,
            1 => true,
            _ => return None,
        };
        let mut s = Box::<Self>::default();
        s.version = d[VERSION];
        s.bump = d[BUMP];
        s.treasury_bump = d[TREASURY_BUMP];
        s.launch = Pubkey::new_from_array(get(d, LAUNCH));
        s.mint = Pubkey::new_from_array(get(d, MINT));
        s.damm_pool = Pubkey::new_from_array(get(d, DAMM_POOL));
        s.active_graph = get(d, ACTIVE_GRAPH);
        s.pending_graph = get(d, PENDING_GRAPH);
        s.pending_activate_at = i64::from_le_bytes(get(d, PENDING_ACTIVATE_AT));
        s.pending_operator = Pubkey::new_from_array(get(d, PENDING_OPERATOR));
        s.activated_at = i64::from_le_bytes(get(d, ACTIVATED_AT));
        s.frozen = frozen;
        s.operator = Pubkey::new_from_array(get(d, OPERATOR));
        for (i, mark) in s.auth_marks.iter_mut().enumerate() {
            let at = AUTH_MARKS + i * AUTH_MARK_LEN;
            mark.slot = u64::from_le_bytes(get(d, at));
            mark.key = Pubkey::new_from_array(get(d, at + 8));
        }
        s.seq = u64::from_le_bytes(get(d, SEQ));
        s.ref_sqrt_price = u128::from_le_bytes(get(d, REF_SQRT_PRICE));
        s.ref_updated_at = i64::from_le_bytes(get(d, REF_UPDATED_AT));
        s.ref_allowance = u64::from_le_bytes(get(d, REF_ALLOWANCE));
        s.ref_allowance_at = i64::from_le_bytes(get(d, REF_ALLOWANCE_AT));
        for (i, bucket) in s.observations.iter_mut().enumerate() {
            let at = OBSERVATIONS + i * OBS_BUCKET_LEN;
            bucket.index = i64::from_le_bytes(get(d, at));
            bucket.first_at = i64::from_le_bytes(get(d, at + 8));
            bucket.min = u128::from_le_bytes(get(d, at + 16));
            bucket.max = u128::from_le_bytes(get(d, at + 32));
        }
        s.tip_epoch_start = i64::from_le_bytes(get(d, TIP_EPOCH_START));
        s.tips_in_epoch = u64::from_le_bytes(get(d, TIPS_IN_EPOCH));
        for (i, node) in s.nodes.iter_mut().enumerate() {
            let at = NODES + i * NODE_RECORD_LEN;
            node.last_run = i64::from_le_bytes(get(d, at));
            node.last_seq = u64::from_le_bytes(get(d, at + 8));
            node.epoch_start = i64::from_le_bytes(get(d, at + 16));
            node.runs_in_epoch = u16::from_le_bytes(get(d, at + 24));
            node.spent_in_epoch = u64::from_le_bytes(get(d, at + 26));
        }
        s.active_auth = Pubkey::new_from_array(get(d, ACTIVE_AUTH));
        s.active_activate_at = i64::from_le_bytes(get(d, ACTIVE_ACTIVATE_AT));
        for (i, spent) in s.partial_spent.iter_mut().enumerate() {
            *spent = u64::from_le_bytes(get(d, PARTIAL_SPENT + i * 8));
        }
        Some(s)
    }

    /// [`Autopilot::write`] of the autopilot `init_autopilot` creates: the
    /// zeroed account with `version`, the bumps, `launch` and
    /// `ref_sqrt_price` set.
    pub fn write_new(
        d: &mut [u8; Self::LEN],
        bump: u8,
        treasury_bump: u8,
        launch: &Pubkey,
        ref_sqrt_price: u128,
    ) {
        use layout::*;
        d.fill(0);
        set(d, 0, discriminator::AUTOPILOT);
        set(d, VERSION, [Self::VERSION, bump, treasury_bump]);
        set(d, LAUNCH, launch.to_bytes());
        set(d, REF_SQRT_PRICE, ref_sqrt_price.to_le_bytes());
    }

    /// Encodes the discriminator and the fields: the first
    /// [`Autopilot::LEN`] bytes of account data (Anchor's `try_serialize`).
    #[inline(never)]
    pub fn write(&self, d: &mut [u8; Self::LEN]) {
        use layout::*;
        set(d, 0, discriminator::AUTOPILOT);
        set(d, VERSION, [self.version, self.bump, self.treasury_bump]);
        set(d, LAUNCH, self.launch.to_bytes());
        set(d, MINT, self.mint.to_bytes());
        set(d, DAMM_POOL, self.damm_pool.to_bytes());
        set(d, ACTIVE_GRAPH, self.active_graph);
        set(d, PENDING_GRAPH, self.pending_graph);
        set(
            d,
            PENDING_ACTIVATE_AT,
            self.pending_activate_at.to_le_bytes(),
        );
        set(d, PENDING_OPERATOR, self.pending_operator.to_bytes());
        set(d, ACTIVATED_AT, self.activated_at.to_le_bytes());
        set(d, FROZEN, [u8::from(self.frozen)]);
        set(d, OPERATOR, self.operator.to_bytes());
        for (i, mark) in self.auth_marks.iter().enumerate() {
            let at = AUTH_MARKS + i * AUTH_MARK_LEN;
            set(d, at, mark.slot.to_le_bytes());
            set(d, at + 8, mark.key.to_bytes());
        }
        set(d, SEQ, self.seq.to_le_bytes());
        set(d, REF_SQRT_PRICE, self.ref_sqrt_price.to_le_bytes());
        set(d, REF_UPDATED_AT, self.ref_updated_at.to_le_bytes());
        set(d, REF_ALLOWANCE, self.ref_allowance.to_le_bytes());
        set(d, REF_ALLOWANCE_AT, self.ref_allowance_at.to_le_bytes());
        for (i, bucket) in self.observations.iter().enumerate() {
            let at = OBSERVATIONS + i * OBS_BUCKET_LEN;
            set(d, at, bucket.index.to_le_bytes());
            set(d, at + 8, bucket.first_at.to_le_bytes());
            set(d, at + 16, bucket.min.to_le_bytes());
            set(d, at + 32, bucket.max.to_le_bytes());
        }
        set(d, TIP_EPOCH_START, self.tip_epoch_start.to_le_bytes());
        set(d, TIPS_IN_EPOCH, self.tips_in_epoch.to_le_bytes());
        for (i, node) in self.nodes.iter().enumerate() {
            let at = NODES + i * NODE_RECORD_LEN;
            set(d, at, node.last_run.to_le_bytes());
            set(d, at + 8, node.last_seq.to_le_bytes());
            set(d, at + 16, node.epoch_start.to_le_bytes());
            set(d, at + 24, node.runs_in_epoch.to_le_bytes());
            set(d, at + 26, node.spent_in_epoch.to_le_bytes());
        }
        set(d, ACTIVE_AUTH, self.active_auth.to_bytes());
        set(d, ACTIVE_ACTIVATE_AT, self.active_activate_at.to_le_bytes());
        for (i, spent) in self.partial_spent.iter().enumerate() {
            set(d, PARTIAL_SPENT + i * 8, spent.to_le_bytes());
        }
    }
}

/// Offsets of the [`Autopilot`] fields in account data: Borsh, in
/// declaration order, after the 8-byte discriminator (no padding;
/// `tests/abi.rs` checks them against the IDL and Anchor's serialization).
pub mod layout {
    use super::MAX_NODES;

    pub const VERSION: usize = 8;
    pub const BUMP: usize = VERSION + 1;
    pub const TREASURY_BUMP: usize = BUMP + 1;
    pub const LAUNCH: usize = TREASURY_BUMP + 1;
    pub const MINT: usize = LAUNCH + 32;
    pub const DAMM_POOL: usize = MINT + 32;
    pub const ACTIVE_GRAPH: usize = DAMM_POOL + 32;
    pub const PENDING_GRAPH: usize = ACTIVE_GRAPH + 32;
    pub const PENDING_ACTIVATE_AT: usize = PENDING_GRAPH + 32;
    pub const PENDING_OPERATOR: usize = PENDING_ACTIVATE_AT + 8;
    pub const ACTIVATED_AT: usize = PENDING_OPERATOR + 32;
    pub const FROZEN: usize = ACTIVATED_AT + 8;
    pub const OPERATOR: usize = FROZEN + 1;
    /// `[AuthMark; 3]`: `slot` (u64), `key`.
    pub const AUTH_MARKS: usize = OPERATOR + 32;
    pub const AUTH_MARK_LEN: usize = 8 + 32;
    pub const SEQ: usize = AUTH_MARKS + 3 * AUTH_MARK_LEN;
    pub const REF_SQRT_PRICE: usize = SEQ + 8;
    pub const REF_UPDATED_AT: usize = REF_SQRT_PRICE + 16;
    pub const REF_ALLOWANCE: usize = REF_UPDATED_AT + 8;
    pub const REF_ALLOWANCE_AT: usize = REF_ALLOWANCE + 8;
    /// `[ObsBucket; 2]`: `index`, `first_at` (i64), `min`, `max` (u128).
    pub const OBSERVATIONS: usize = REF_ALLOWANCE_AT + 8;
    pub const OBS_BUCKET_LEN: usize = 8 + 8 + 16 + 16;
    pub const TIP_EPOCH_START: usize = OBSERVATIONS + 2 * OBS_BUCKET_LEN;
    pub const TIPS_IN_EPOCH: usize = TIP_EPOCH_START + 8;
    /// `[NodeRecord; 16]`: `last_run`, `last_seq`, `epoch_start` (8 each),
    /// `runs_in_epoch` (u16), `spent_in_epoch` (u64).
    pub const NODES: usize = TIPS_IN_EPOCH + 8;
    pub const NODE_RECORD_LEN: usize = 8 + 8 + 8 + 2 + 8;
    pub const ACTIVE_AUTH: usize = NODES + MAX_NODES * NODE_RECORD_LEN;
    pub const ACTIVE_ACTIVATE_AT: usize = ACTIVE_AUTH + 32;
    /// `[u64; 16]`.
    pub const PARTIAL_SPENT: usize = ACTIVE_ACTIVATE_AT + 8;
    /// The account size.
    pub const END: usize = PARTIAL_SPENT + MAX_NODES * 8;
    const _: () = assert!(END == super::Autopilot::LEN);
}

/// `N` bytes of `d` at `at` (zeros past the end, which the fixed offsets
/// above never reach).
#[inline(always)]
fn get<const N: usize>(d: &[u8; Autopilot::LEN], at: usize) -> [u8; N] {
    d.get(at..)
        .and_then(|s| s.first_chunk::<N>())
        .copied()
        .unwrap_or([0; N])
}

/// Writes `v` into `d` at `at` (nothing past the end, which the fixed
/// offsets above never reach).
#[inline(always)]
fn set<const N: usize>(d: &mut [u8; Autopilot::LEN], at: usize, v: [u8; N]) {
    if let Some(out) = d.get_mut(at..).and_then(|s| s.first_chunk_mut::<N>()) {
        *out = v;
    }
}

impl ProgramAccount for Autopilot {
    const ACCOUNT_DISCRIMINATOR: [u8; 8] = discriminator::AUTOPILOT;

    fn try_read(data: &[u8]) -> Option<Self> {
        Self::read(data)
    }
}

/// `Account<'info, Autopilot>` as the instructions load it: on the heap
/// (Anchor's `Box<Account<..>>`), decoded in place.
impl ProgramAccount for Box<Autopilot> {
    const ACCOUNT_DISCRIMINATOR: [u8; 8] = discriminator::AUTOPILOT;

    fn try_read(data: &[u8]) -> Option<Self> {
        Autopilot::read_boxed(data)
    }
}

/// A published PXG1 graph, at `["graph", launch, graph_hash]` where
/// `graph_hash = SHA256("PHX-GRAPH-V1" || bytes)`. Created whole by
/// `publish_graph` after `Graph::verify`, never modified or closed.
#[cfg_attr(not(target_os = "solana"), anchor_lang::account)]
#[cfg_attr(target_os = "solana", derive(Clone))]
#[derive(Debug, PartialEq, Eq)]
pub struct GraphRecord {
    pub version: u8,
    pub bump: u8,
    pub launch: Pubkey,
    pub graph_hash: [u8; 32],
    pub bytes: alloc::vec::Vec<u8>,
}

impl GraphRecord {
    pub const VERSION: u8 = 1;
    /// Bytes before the graph: discriminator, version, bump, launch,
    /// graph_hash and the `Vec`'s `u32` length.
    pub const HEADER_LEN: usize = 8 + 1 + 1 + 32 + 32 + 4;

    /// Account space for a graph of `len` bytes: exactly its borsh encoding.
    pub fn space(len: usize) -> usize {
        8 + 1 + 1 + 32 + 32 + 4 + len
    }

    /// Borsh decoding of the fields from account data (discriminator
    /// included, not checked here): `None` when the data ends before the
    /// graph's last byte (Anchor's `AccountDidNotDeserialize`). Bytes after
    /// the fields are ignored. The graph is copied, as Anchor's `Vec<u8>`.
    #[inline(never)]
    pub fn read(data: &[u8]) -> Option<Self> {
        let mut r = Reader::new(data.get(8..)?);
        Some(Self {
            version: r.u8()?,
            bump: r.u8()?,
            launch: r.address()?,
            graph_hash: *r.array::<32>()?,
            bytes: r.bytes()?.to_vec(),
        })
    }

    /// Encodes the discriminator and the fields at the start of `data`
    /// (Anchor's `try_serialize`); `false` when they do not fit.
    pub fn write(&self, data: &mut [u8]) -> bool {
        Self::encode(
            data,
            self.version,
            self.bump,
            &self.launch,
            &self.graph_hash,
            &self.bytes,
        )
    }

    /// [`GraphRecord::write`] of a record given by its fields.
    #[inline(never)]
    pub fn encode(
        data: &mut [u8],
        version: u8,
        bump: u8,
        launch: &Pubkey,
        graph_hash: &[u8; 32],
        bytes: &[u8],
    ) -> bool {
        let Some(len) = u32::try_from(bytes.len()).ok() else {
            return false;
        };
        let Some(out) = data.get_mut(..Self::space(bytes.len())) else {
            return false;
        };
        let mut w = Cursor { data: out, at: 0 };
        w.put(&discriminator::GRAPH_RECORD);
        w.put(&[version, bump]);
        w.put(launch.as_ref());
        w.put(graph_hash);
        w.put(&len.to_le_bytes());
        w.put(bytes);
        true
    }
}

impl ProgramAccount for GraphRecord {
    const ACCOUNT_DISCRIMINATOR: [u8; 8] = discriminator::GRAPH_RECORD;

    fn try_read(data: &[u8]) -> Option<Self> {
        Self::read(data)
    }
}

/// Sequential writes into a buffer the caller sized (Borsh encoding of
/// accounts and events); bytes past its end are dropped (never the case for
/// the fixed layouts here).
pub(crate) struct Cursor<'a> {
    pub(crate) data: &'a mut [u8],
    pub(crate) at: usize,
}

impl Cursor<'_> {
    #[inline]
    pub(crate) fn put(&mut self, bytes: &[u8]) {
        if let Some(out) = self
            .data
            .get_mut(self.at..)
            .and_then(|rest| rest.get_mut(..bytes.len()))
        {
            out.copy_from_slice(bytes);
        }
        self.at = self.at.saturating_add(bytes.len());
    }
}

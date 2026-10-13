//! Events, as Anchor's `emit!` logs them: `sol_log_data` of one slice, the
//! event's discriminator (`sha256("event:<Name>")[..8]`) then its fields in
//! Borsh (pubkeys and byte arrays raw, integers little-endian, `bool` one
//! byte). Off-chain the structs carry Anchor's `#[event]` traits, so clients
//! decode the logs as before; `tests/abi.rs` checks each `log_data` against
//! Anchor's `Event::data`.

#[cfg(not(target_os = "solana"))]
use anchor_lang::{AnchorDeserialize, AnchorSerialize, Discriminator};

use crate::{discriminator, state::Cursor, Pubkey};

#[cfg_attr(not(target_os = "solana"), anchor_lang::event)]
#[derive(Debug, PartialEq, Eq)]
pub struct AutopilotInitialized {
    pub autopilot: Pubkey,
    pub launch: Pubkey,
    pub treasury: Pubkey,
    /// The launch's migration price: the first reference price.
    pub ref_sqrt_price: u128,
}

#[cfg_attr(not(target_os = "solana"), anchor_lang::event)]
#[derive(Debug, PartialEq, Eq)]
pub struct MintBound {
    pub autopilot: Pubkey,
    pub mint: Pubkey,
}

/// The launch graduated: its DAMM v2 pool, created by DBC's migration
/// through `damm_config`, is bound.
#[cfg_attr(not(target_os = "solana"), anchor_lang::event)]
#[derive(Debug, PartialEq, Eq)]
pub struct PoolBound {
    pub autopilot: Pubkey,
    pub damm_pool: Pubkey,
    pub damm_config: Pubkey,
}

/// `publish_graph` created a graph record (not emitted when it existed).
#[cfg_attr(not(target_os = "solana"), anchor_lang::event)]
#[derive(Debug, PartialEq, Eq)]
pub struct GraphPublished {
    pub launch: Pubkey,
    pub graph: Pubkey,
    pub graph_hash: [u8; 32],
    pub len: u16,
}

/// An authorized graph was queued; it takes effect at `activate_at`.
#[cfg_attr(not(target_os = "solana"), anchor_lang::event)]
#[derive(Debug, PartialEq, Eq)]
pub struct GraphQueued {
    pub autopilot: Pubkey,
    pub graph_hash: [u8; 32],
    pub activate_at: i64,
    pub authorization: Pubkey,
    /// The operator the graph will have (its own).
    pub operator: Pubkey,
}

#[cfg_attr(not(target_os = "solana"), anchor_lang::event)]
#[derive(Debug, PartialEq, Eq)]
pub struct GraphActivated {
    pub autopilot: Pubkey,
    pub graph_hash: [u8; 32],
    pub operator: Pubkey,
}

#[cfg_attr(not(target_os = "solana"), anchor_lang::event)]
#[derive(Debug, PartialEq, Eq)]
pub struct GraphFrozen {
    pub autopilot: Pubkey,
    pub graph_hash: [u8; 32],
    /// A pending update the freeze cancelled (zero: none).
    pub cancelled: [u8; 32],
}

#[cfg_attr(not(target_os = "solana"), anchor_lang::event)]
#[derive(Debug, PartialEq, Eq)]
pub struct OperatorRevoked {
    pub autopilot: Pubkey,
    pub operator: Pubkey,
    /// The queued graph named the same operator, which it will not get.
    pub pending_cleared: bool,
}

/// A node ran. Every lamport and token that left the treasury is here.
#[cfg_attr(not(target_os = "solana"), anchor_lang::event)]
#[derive(Debug, PartialEq, Eq)]
pub struct NodeRan {
    pub autopilot: Pubkey,
    pub node: u8,
    pub action: u8,
    pub seq: u64,
    /// What the node spent from its budget: lamports swapped (BUYBACK_BURN)
    /// or due to the recipients (DISTRIBUTE_SOL: paid, plus `kept`), tokens
    /// burned (BURN).
    pub spent: u64,
    /// Tokens bought by the swap (all burned in the same instruction).
    pub bought: u64,
    /// Tokens burned (bought ones, or treasury tokens).
    pub burned: u64,
    /// Lamports of wSOL paid to the caller's tip account.
    pub tip: u64,
    pub caller: Pubkey,
    /// The pool's sqrt price before the action (0 before graduation, or if
    /// a burn or a distribution could not read it).
    pub spot_sqrt_price: u128,
    /// The reference sqrt price after the run.
    pub ref_sqrt_price: u128,
    /// A keeper's partial buyback (audit 4, A4-2): it spent from the budget
    /// but did not complete the node's run, so the node stays due (not a
    /// run: `last_run`, `last_seq` and the epoch's runs are unchanged).
    pub partial: bool,
    /// DISTRIBUTE_SOL: bit `i` set when recipient `i` had no wSOL account
    /// at its canonical address (audit 4, M4): its share was not paid.
    pub skipped: u8,
    /// Lamports of those shares, which stayed in the treasury (paid =
    /// `spent - kept`).
    pub kept: u64,
}

/// `update_price` observed the pool price; the reference moved if the
/// observations of the window agreed (`old == new` otherwise).
#[cfg_attr(not(target_os = "solana"), anchor_lang::event)]
#[derive(Debug, PartialEq, Eq)]
pub struct ReferencePriceUpdated {
    pub autopilot: Pubkey,
    pub old_sqrt_price: u128,
    pub new_sqrt_price: u128,
    pub spot_sqrt_price: u128,
}

/// The `sol_log_data` payload of an event of `N` bytes: the discriminator,
/// then the fields `put` writes.
#[inline(always)]
fn payload<const N: usize>(discriminator: &[u8; 8], put: impl FnOnce(&mut Cursor)) -> [u8; N] {
    let mut data = [0u8; N];
    let mut w = Cursor {
        data: &mut data,
        at: 0,
    };
    w.put(discriminator);
    put(&mut w);
    data
}

impl AutopilotInitialized {
    pub const LEN: usize = 8 + 32 * 3 + 16;

    /// The `sol_log_data` payload (Anchor's `Event::data`).
    pub fn log_data(&self) -> [u8; Self::LEN] {
        payload(&discriminator::AUTOPILOT_INITIALIZED, |w| {
            w.put(self.autopilot.as_ref());
            w.put(self.launch.as_ref());
            w.put(self.treasury.as_ref());
            w.put(&self.ref_sqrt_price.to_le_bytes());
        })
    }

    /// `emit!(self)`.
    pub fn emit(&self) {
        noised_onchain::event::emit(&self.log_data())
    }
}

impl MintBound {
    pub const LEN: usize = 8 + 32 * 2;

    /// The `sol_log_data` payload (Anchor's `Event::data`).
    pub fn log_data(&self) -> [u8; Self::LEN] {
        payload(&discriminator::MINT_BOUND, |w| {
            w.put(self.autopilot.as_ref());
            w.put(self.mint.as_ref());
        })
    }

    /// `emit!(self)`.
    pub fn emit(&self) {
        noised_onchain::event::emit(&self.log_data())
    }
}

impl PoolBound {
    pub const LEN: usize = 8 + 32 * 3;

    /// The `sol_log_data` payload (Anchor's `Event::data`).
    pub fn log_data(&self) -> [u8; Self::LEN] {
        payload(&discriminator::POOL_BOUND, |w| {
            w.put(self.autopilot.as_ref());
            w.put(self.damm_pool.as_ref());
            w.put(self.damm_config.as_ref());
        })
    }

    /// `emit!(self)`.
    pub fn emit(&self) {
        noised_onchain::event::emit(&self.log_data())
    }
}

impl GraphPublished {
    pub const LEN: usize = 8 + 32 * 3 + 2;

    /// The `sol_log_data` payload (Anchor's `Event::data`).
    pub fn log_data(&self) -> [u8; Self::LEN] {
        payload(&discriminator::GRAPH_PUBLISHED, |w| {
            w.put(self.launch.as_ref());
            w.put(self.graph.as_ref());
            w.put(&self.graph_hash);
            w.put(&self.len.to_le_bytes());
        })
    }

    /// `emit!(self)`.
    pub fn emit(&self) {
        noised_onchain::event::emit(&self.log_data())
    }
}

impl GraphQueued {
    pub const LEN: usize = 8 + 32 * 2 + 8 + 32 * 2;

    /// The `sol_log_data` payload (Anchor's `Event::data`).
    pub fn log_data(&self) -> [u8; Self::LEN] {
        payload(&discriminator::GRAPH_QUEUED, |w| {
            w.put(self.autopilot.as_ref());
            w.put(&self.graph_hash);
            w.put(&self.activate_at.to_le_bytes());
            w.put(self.authorization.as_ref());
            w.put(self.operator.as_ref());
        })
    }

    /// `emit!(self)`.
    pub fn emit(&self) {
        noised_onchain::event::emit(&self.log_data())
    }
}

impl GraphActivated {
    pub const LEN: usize = 8 + 32 * 3;

    /// The `sol_log_data` payload (Anchor's `Event::data`).
    pub fn log_data(&self) -> [u8; Self::LEN] {
        payload(&discriminator::GRAPH_ACTIVATED, |w| {
            w.put(self.autopilot.as_ref());
            w.put(&self.graph_hash);
            w.put(self.operator.as_ref());
        })
    }

    /// `emit!(self)`.
    pub fn emit(&self) {
        noised_onchain::event::emit(&self.log_data())
    }
}

impl GraphFrozen {
    pub const LEN: usize = 8 + 32 * 3;

    /// The `sol_log_data` payload (Anchor's `Event::data`).
    pub fn log_data(&self) -> [u8; Self::LEN] {
        payload(&discriminator::GRAPH_FROZEN, |w| {
            w.put(self.autopilot.as_ref());
            w.put(&self.graph_hash);
            w.put(&self.cancelled);
        })
    }

    /// `emit!(self)`.
    pub fn emit(&self) {
        noised_onchain::event::emit(&self.log_data())
    }
}

impl OperatorRevoked {
    pub const LEN: usize = 8 + 32 * 2 + 1;

    /// The `sol_log_data` payload (Anchor's `Event::data`).
    pub fn log_data(&self) -> [u8; Self::LEN] {
        payload(&discriminator::OPERATOR_REVOKED, |w| {
            w.put(self.autopilot.as_ref());
            w.put(self.operator.as_ref());
            w.put(&[u8::from(self.pending_cleared)]);
        })
    }

    /// `emit!(self)`.
    pub fn emit(&self) {
        noised_onchain::event::emit(&self.log_data())
    }
}

impl NodeRan {
    pub const LEN: usize = 8 + 32 + 1 + 1 + 8 * 5 + 32 + 16 * 2 + 1 + 1 + 8;

    /// The `sol_log_data` payload (Anchor's `Event::data`).
    pub fn log_data(&self) -> [u8; Self::LEN] {
        payload(&discriminator::NODE_RAN, |w| {
            w.put(self.autopilot.as_ref());
            w.put(&[self.node, self.action]);
            w.put(&self.seq.to_le_bytes());
            w.put(&self.spent.to_le_bytes());
            w.put(&self.bought.to_le_bytes());
            w.put(&self.burned.to_le_bytes());
            w.put(&self.tip.to_le_bytes());
            w.put(self.caller.as_ref());
            w.put(&self.spot_sqrt_price.to_le_bytes());
            w.put(&self.ref_sqrt_price.to_le_bytes());
            w.put(&[u8::from(self.partial), self.skipped]);
            w.put(&self.kept.to_le_bytes());
        })
    }

    /// `emit!(self)`.
    pub fn emit(&self) {
        noised_onchain::event::emit(&self.log_data())
    }
}

impl ReferencePriceUpdated {
    pub const LEN: usize = 8 + 32 + 16 * 3;

    /// The `sol_log_data` payload (Anchor's `Event::data`).
    pub fn log_data(&self) -> [u8; Self::LEN] {
        payload(&discriminator::REFERENCE_PRICE_UPDATED, |w| {
            w.put(self.autopilot.as_ref());
            w.put(&self.old_sqrt_price.to_le_bytes());
            w.put(&self.new_sqrt_price.to_le_bytes());
            w.put(&self.spot_sqrt_price.to_le_bytes());
        })
    }

    /// `emit!(self)`.
    pub fn emit(&self) {
        noised_onchain::event::emit(&self.log_data())
    }
}

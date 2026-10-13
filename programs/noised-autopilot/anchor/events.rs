use anchor_lang::prelude::*;

#[event]
pub struct AutopilotInitialized {
    pub autopilot: Pubkey,
    pub launch: Pubkey,
    pub treasury: Pubkey,
    /// The launch's migration price: the first reference price.
    pub ref_sqrt_price: u128,
}

#[event]
pub struct MintBound {
    pub autopilot: Pubkey,
    pub mint: Pubkey,
}

/// The launch graduated: its DAMM v2 pool, created by DBC's migration
/// through `damm_config`, is bound.
#[event]
pub struct PoolBound {
    pub autopilot: Pubkey,
    pub damm_pool: Pubkey,
    pub damm_config: Pubkey,
}

/// `publish_graph` created a graph record (not emitted when it existed).
#[event]
pub struct GraphPublished {
    pub launch: Pubkey,
    pub graph: Pubkey,
    pub graph_hash: [u8; 32],
    pub len: u16,
}

/// An authorized graph was queued; it takes effect at `activate_at`.
#[event]
pub struct GraphQueued {
    pub autopilot: Pubkey,
    pub graph_hash: [u8; 32],
    pub activate_at: i64,
    pub authorization: Pubkey,
    /// The operator the graph will have (its own).
    pub operator: Pubkey,
}

#[event]
pub struct GraphActivated {
    pub autopilot: Pubkey,
    pub graph_hash: [u8; 32],
    pub operator: Pubkey,
}

#[event]
pub struct GraphFrozen {
    pub autopilot: Pubkey,
    pub graph_hash: [u8; 32],
    /// A pending update the freeze cancelled (zero: none).
    pub cancelled: [u8; 32],
}

#[event]
pub struct OperatorRevoked {
    pub autopilot: Pubkey,
    pub operator: Pubkey,
    /// The queued graph named the same operator, which it will not get.
    pub pending_cleared: bool,
}

/// A node ran. Every lamport and token that left the treasury is here.
#[event]
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
#[event]
pub struct ReferencePriceUpdated {
    pub autopilot: Pubkey,
    pub old_sqrt_price: u128,
    pub new_sqrt_price: u128,
    pub spot_sqrt_price: u128,
}

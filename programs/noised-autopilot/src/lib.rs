//! Noised Autopilot (spec §4): automation graphs (PXG1, crate
//! `noised-rules`) that run a launched token's treasury inside bounds the
//! chain enforces, so that a creator can promise "buy back and burn every
//! day" or "pay these recipients" and nobody, the creator included, can do
//! anything else with the treasury.
//!
//! * A launch's treasury is the PDA `["treasury", launch]` of this program:
//!   its wSOL account (funded by the creator-fee share routed to it by the
//!   launchpad's `distribute`, or by anyone) and its token account. Value
//!   leaves it only to burns, to the launch's DAMM v2 pool (the one DBC's
//!   migration created, `bind_pool`) in a buyback whose tokens are burned in
//!   the same instruction, to the graph's declared recipients, and as
//!   bounded tips to whoever runs a due node. It never sells the token and
//!   never closes an account. Value moves only through DAMM v2, Token-2022
//!   and SPL Token, at fixed ids; `init_autopilot`, `bind_mint` and
//!   `publish_graph` also call the ATA and System programs, only to create
//!   accounts (no value moves).
//! * A graph is published content-addressed (`publish_graph`, verified) and
//!   becomes active only through an `Authorization` the launchpad wrote
//!   after verifying the launch identity's hash-based (LMS) signature over
//!   the change (`activate`), at the earliest 72 hours after a replacement
//!   is queued (`apply_pending`); `freeze` makes it permanent and
//!   `revoke_operator` takes the operator's power away. No Ed25519 key can
//!   change a graph, so a quantum computer cannot either.
//! * `run` executes one due node: trigger, condition, runs and budget per
//!   epoch and the per-run cap come from the graph and `noised-rules`;
//!   buybacks are bounded by the lower of a slow reference price (seeded
//!   with the launch's migration price) and the lowest pool price anyone
//!   observed in the last 15 to 30 minutes (`reference.rs`), a maximum
//!   premium over it and a minimum out priced from it. An operator (e.g. an
//!   AI agent) chooses the timing and amount of its gated nodes, never
//!   anything outside those bounds.
//!
//! There is no admin, no pause and no configuration account, and no
//! instruction touches the launch, its hook policy, its LP or its mint's
//! authorities.
//!
//! # Invariants (audit list; each has tests that fail without it)
//!
//! 1. Treasury outflows go only to: Token-2022 burns of treasury tokens;
//!    the launch's pool's wSOL vault in a buyback, whose every received
//!    token is burned in the same instruction; the active graph's
//!    recipients' canonical wSOL accounts (a recipient without one is
//!    skipped, its share stays: nobody pays for its account); the caller's
//!    tip account, at most `TIP_LAMPORTS` per run (a partial buyback: its
//!    share of it), 10% of what the run moved (burns valued at nothing
//!    before graduation, after it at the lower of the reference and the
//!    lowest observed price) and `TIP_EPOCH_CAP` per day, never more than
//!    the action left (`cpi.rs`, `run.rs`; host `invariant_tests`, LiteSVM
//!    `invariants.rs`).
//! 2. The treasury never sells the token: the only swap's input is the
//!    treasury's wSOL account, its output the treasury's token account.
//! 3. No treasury account is closed, delegated or re-owned, and the only
//!    programs that move value are DAMM v2, Token-2022 and SPL Token, at
//!    fixed ids. Besides them, `init_autopilot`, `bind_mint` and
//!    `publish_graph` also call the Associated Token program and System
//!    (Anchor `init` / `init_if_needed`) only to create accounts (the
//!    autopilot, the treasury's wSOL and token accounts, a graph record),
//!    rent paid by their payer: no treasury value moves.
//! 4. A node runs only when the graph says so (trigger, condition on the
//!    reference price, runs and spend per epoch) and moves at most
//!    `min(p1, budget left, treasury)`; a keeper moves that maximum, or for
//!    a buyback at least 1% of the pool's wSOL (`KEEPER_MIN_POOL_BPS`); an
//!    operator chooses at most it, and only on its gated nodes. A keeper's
//!    smaller buyback is partial: it leaves the node's run open (it is no
//!    run for the trigger or the run limit, so nobody can use one up with
//!    a small amount) and the run's later parts move at most the rest of
//!    `p1`, so splitting a run never moves more than the run would.
//! 5. A buyback trades only on the pool DBC's migration created for the
//!    launch (`bind_pool`), only with observations of its price spanning at
//!    least a minute, only while its price is within the node's premium
//!    over the lower of the reference and the lowest price observed in the
//!    last 15 to 30 minutes, and requires a minimum out priced at that
//!    premium. The reference starts at the migration price and moves only
//!    toward what every observation of the window agrees on, rising at most
//!    5% per hour (`reference.rs`). Residual: a keeper who sandwiches a
//!    buyback gains at most about `premium * amount` against that bound;
//!    the bound is above the market only if the market fell and nobody
//!    observed the pool since, or if one party made every observation of a
//!    window while holding the pool up (5% per hour at most, each step
//!    paying the pool's fees both ways). Anyone dumping the pool in an
//!    observation every 15 minutes can hold buybacks back (liveness only:
//!    the treasury keeps its SOL).
//! 6. The active graph changes only through an authorization the launchpad
//!    wrote after verifying the launch identity's LMS signature over that
//!    change, each used once and never after a newer one it could undo; a
//!    replacement (of an active or a queued graph) takes effect at least 72
//!    hours after it becomes visible; a frozen graph never changes; a
//!    revoked operator can do nothing, and nothing signed before its
//!    revocation gives it power again; a revocation names the activation
//!    whose operator it revokes, so the operator of every activation can be
//!    revoked; a freeze is used only until the `not_after` it was signed
//!    with.
//! 7. A failed check changes nothing (every refusal is an error).
//!
//! # No framework
//!
//! The program is written on `pinocchio` and `noised-onchain` (the shared
//! Anchor-compatible building blocks: account checks, errors, SPL Token /
//! Token-2022 parsing, CPIs); no Anchor code is linked into it. Its ABI is
//! the one the Anchor 1.2.1 build had, byte for byte: the same program id,
//! instruction discriminators (`sha256("global:<name>")[..8]`), account
//! order and signer/writable flags, Borsh arguments, account discriminators
//! (`sha256("account:<Name>")[..8]`) and layouts (the 1,244-byte
//! `Autopilot`, `GraphRecord`), PDA seeds and bumps, events
//! (`sha256("event:<Name>")[..8]` + Borsh, through `sol_log_data`) and
//! error numbers, the framework's included (`ConstraintSeeds` 2006, ...).
//! Each instruction in [`instructions`] lists every account constraint of
//! the Anchor build (its source is kept verbatim in `anchor/`) and checks
//! them in Anchor's order; [`processor`] dispatches. The hand-maintained
//! `idls/noised_autopilot.json` describes the ABI.
//!
//! The decisions ([`logic`], [`reference`], [`price`]) and the layout
//! readers ([`launchpad`], [`external`]) are the Anchor build's, line for
//! line; only their error type changed ([`error`]).
//!
//! Off-chain (`not(target_os = "solana")`), the crate keeps the Anchor
//! client API its users have: [`accounts`], [`instruction`],
//! `program::NoisedAutopilot`, the Anchor account traits on
//! [`state::Autopilot`] and [`state::GraphRecord`] and the Anchor `Event`
//! trait on the [`events`]. That code is host-only and never part of the
//! program binary.

extern crate alloc;

/// Anchor's `require!(cond, e)`: return `e` (converted into the function's
/// error type) unless `cond` holds.
macro_rules! require {
    ($cond:expr, $err:expr $(,)?) => {
        if !($cond) {
            return Err(::core::convert::Into::into($err));
        }
    };
}

/// Anchor's `err!(e)`: `Err(e)`, converted into the function's error type.
macro_rules! err {
    ($err:expr $(,)?) => {
        Err(::core::convert::Into::into($err))
    };
}

/// Anchor's `require_keys_eq!(left, right, e)`: unless the keys are equal,
/// return `e` logged with both keys (`Left:` / `Right:`), as Anchor logs it.
macro_rules! require_keys_eq {
    ($left:expr, $right:expr, $err:expr $(,)?) => {{
        let (left, right): (&$crate::Pubkey, &$crate::Pubkey) = (&$left, &$right);
        if !noised_onchain::same(left, right) {
            return Err(::core::convert::Into::into($crate::error::keys(
                $err, left, right,
            )));
        }
    }};
}

#[cfg(not(target_os = "solana"))]
mod client;
pub mod constants;
pub mod cpi;
pub mod error;
pub mod events;
pub mod external;
pub mod instructions;
pub mod int;
pub mod launchpad;
pub mod logic;
pub mod price;
pub mod processor;
pub mod reference;
pub mod state;

#[cfg(test)]
mod tests;

#[cfg(not(target_os = "solana"))]
pub use client::{accounts, instruction};

#[cfg(not(feature = "no-entrypoint"))]
noised_onchain::entrypoint!(crate::processor::process_instruction);

/// An account address (`solana_address::Address`, which Anchor's `Pubkey`
/// also is).
pub type Pubkey = pinocchio::Address;

/// The result of the program's decisions: an [`error::AutopilotError`] by
/// default, logged when `?` turns it into the instruction's `ProgramError`.
pub type Result<T, E = error::AutopilotError> = core::result::Result<T, E>;

pub use pinocchio::error::ProgramError;

/// The program id (`declare_id!` of the Anchor build).
pub const ID: Pubkey = decode_pubkey("D5fuqCXNP7BkU3CyNrpZUFStgdZ6XwRkpURiK9v5esbx");

/// The program id.
pub const fn id() -> Pubkey {
    ID
}

/// Whether `id` is the program id.
pub fn check_id(id: &Pubkey) -> bool {
    *id == ID
}

/// The program type (`Id` off-chain, as `#[program]` generated it), and the
/// [`noised_onchain::Program`] the account checks and errors are generic
/// over.
pub mod program {
    /// The autopilot program.
    #[derive(Clone)]
    pub struct NoisedAutopilot;

    impl noised_onchain::Program for NoisedAutopilot {
        const ID: crate::Pubkey = crate::ID;
        const ERRORS: noised_onchain::ErrorTable = crate::error::ERRORS;
    }

    #[cfg(not(target_os = "solana"))]
    impl anchor_lang::Id for NoisedAutopilot {
        fn id() -> crate::Pubkey {
            crate::ID
        }
    }
}

/// Discriminators: instructions `sha256("global:<snake_case name>")[..8]`,
/// accounts `sha256("account:<Name>")[..8]`, events
/// `sha256("event:<Name>")[..8]` (checked against the IDL in `tests/abi.rs`).
pub mod discriminator {
    pub const INIT_AUTOPILOT: [u8; 8] = [120, 236, 35, 34, 115, 30, 166, 245];
    pub const BIND_MINT: [u8; 8] = [252, 89, 36, 147, 181, 231, 160, 219];
    pub const BIND_POOL: [u8; 8] = [42, 253, 183, 246, 58, 106, 92, 243];
    pub const PUBLISH_GRAPH: [u8; 8] = [107, 216, 172, 115, 29, 125, 3, 224];
    pub const ACTIVATE: [u8; 8] = [194, 203, 35, 100, 151, 55, 170, 82];
    pub const APPLY_PENDING: [u8; 8] = [88, 86, 232, 48, 42, 150, 180, 196];
    pub const FREEZE: [u8; 8] = [255, 91, 207, 84, 251, 194, 254, 63];
    pub const REVOKE_OPERATOR: [u8; 8] = [185, 25, 87, 77, 88, 8, 30, 175];
    pub const RUN: [u8; 8] = [203, 27, 228, 218, 208, 69, 35, 84];
    pub const UPDATE_PRICE: [u8; 8] = [61, 34, 117, 155, 75, 34, 123, 208];

    /// `sha256("account:Autopilot")[..8]`.
    pub const AUTOPILOT: [u8; 8] = [113, 195, 229, 57, 158, 250, 49, 134];
    /// `sha256("account:GraphRecord")[..8]`.
    pub const GRAPH_RECORD: [u8; 8] = [118, 95, 92, 21, 103, 22, 179, 120];

    pub const AUTOPILOT_INITIALIZED: [u8; 8] = [253, 56, 229, 45, 213, 208, 230, 246];
    pub const MINT_BOUND: [u8; 8] = [234, 244, 192, 242, 103, 41, 255, 18];
    pub const POOL_BOUND: [u8; 8] = [234, 212, 32, 69, 240, 237, 33, 28];
    pub const GRAPH_PUBLISHED: [u8; 8] = [93, 40, 45, 124, 250, 139, 155, 19];
    pub const GRAPH_QUEUED: [u8; 8] = [192, 247, 91, 23, 239, 238, 253, 1];
    pub const GRAPH_ACTIVATED: [u8; 8] = [90, 74, 13, 95, 27, 203, 114, 27];
    pub const GRAPH_FROZEN: [u8; 8] = [11, 115, 120, 89, 92, 55, 86, 18];
    pub const OPERATOR_REVOKED: [u8; 8] = [234, 41, 78, 23, 191, 224, 103, 64];
    pub const NODE_RAN: [u8; 8] = [181, 67, 182, 114, 33, 181, 84, 224];
    pub const REFERENCE_PRICE_UPDATED: [u8; 8] = [84, 187, 73, 53, 203, 174, 5, 238];

    /// Anchor's `EVENT_IX_TAG` (`0x1d9acb512ea545e4`, little-endian): the
    /// event-CPI instruction tag, which this program (like the Anchor build,
    /// compiled without `event-cpi`) refuses with `EventInstructionStub`.
    pub const EVENT_IX_TAG_LE: [u8; 8] = noised_onchain::event::EVENT_IX_TAG_LE;
}

/// SHA-256 through the `sol_sha256` syscall (host builds use the same API).
pub struct SolSha256;

impl noised_rules::Sha256 for SolSha256 {
    fn hashv(parts: &[&[u8]]) -> [u8; 32] {
        noised_onchain::hashv(parts)
    }
}

/// `Pubkey::from_str` of a base58 address, in const context: the address
/// constants (`constants.rs`'s `pubkey!`) are decoded at compile time (a
/// malformed one fails to compile). Each is checked against
/// `Pubkey::from_str` in `tests/abi.rs`.
#[doc(hidden)]
pub const fn decode_pubkey(text: &str) -> Pubkey {
    const ALPHABET: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let text = text.as_bytes();
    let mut out = [0u8; 32];
    let mut leading_ones = 0;
    let mut i = 0;
    while i < text.len() {
        let mut digit = 0;
        while digit < ALPHABET.len() && ALPHABET[digit] != text[i] {
            digit += 1;
        }
        assert!(digit < ALPHABET.len(), "not base58");
        if digit == 0 && leading_ones == i {
            leading_ones += 1;
        }
        // out = out * 58 + digit, big-endian.
        let mut carry = digit as u32;
        let mut j = out.len();
        while j > 0 {
            j -= 1;
            carry += out[j] as u32 * 58;
            out[j] = (carry & 0xFF) as u8;
            carry >>= 8;
        }
        assert!(carry == 0, "more than 32 bytes");
        i += 1;
    }
    // Leading '1's encode exactly the leading zero bytes.
    let mut zeros = 0;
    while zeros < out.len() && out[zeros] == 0 {
        zeros += 1;
    }
    assert!(zeros == leading_ones, "not a 32-byte address");
    Pubkey::new_from_array(out)
}

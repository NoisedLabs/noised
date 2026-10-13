// The Anchor 1.2.1 source of `noised_autopilot` (the build deployed on
// devnet), kept verbatim as the reference the framework-free program in
// `../src` implements: the same ABI, and every account check of these
// `#[derive(Accounts)]` structs in the same order (the `[A]` comments of
// `../src/instructions/*.rs`). Not compiled. The app's developer docs
// (`app/scripts/gen-docs-reference.mjs`) read the autopilot's instruction
// and account reference from it.
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

use anchor_lang::prelude::*;

pub mod constants;
pub mod cpi;
pub mod error;
pub mod events;
pub mod external;
pub mod instructions;
pub mod launchpad;
pub mod logic;
pub mod price;
pub mod reference;
pub mod state;

#[cfg(test)]
mod tests;

use instructions::*;

declare_id!("D5fuqCXNP7BkU3CyNrpZUFStgdZ6XwRkpURiK9v5esbx");

/// SHA-256 through the `sol_sha256` syscall (host builds use the same API).
pub struct SolSha256;

impl noised_rules::Sha256 for SolSha256 {
    fn hashv(parts: &[&[u8]]) -> [u8; 32] {
        solana_sha256_hasher::hashv(parts).to_bytes()
    }
}

#[program]
pub mod noised_autopilot {
    use super::*;

    /// Create a launch's autopilot and its treasury's wSOL account
    /// (permissionless, once).
    pub fn init_autopilot(ctx: Context<InitAutopilot>) -> Result<()> {
        instructions::init_autopilot::handle_init_autopilot(ctx)
    }

    /// Bind the autopilot to the launch's certified mint once the launch is
    /// live; create the treasury's token account (permissionless, once).
    pub fn bind_mint(ctx: Context<BindMint>) -> Result<()> {
        instructions::bind_mint::handle_bind_mint(ctx)
    }

    /// Bind the autopilot to the DAMM v2 pool DBC's migration created for
    /// the launch: from then on it has graduated (permissionless, once).
    pub fn bind_pool(ctx: Context<BindPool>) -> Result<()> {
        instructions::bind_pool::handle_bind_pool(ctx)
    }

    /// Publish a verified PXG1 graph at the address its content hashes to
    /// (permissionless, idempotent).
    pub fn publish_graph(ctx: Context<PublishGraph>, bytes: Vec<u8>) -> Result<()> {
        instructions::publish_graph::handle_publish_graph(ctx, bytes)
    }

    /// Queue a published graph to take effect at `activate_at`, authorized
    /// by the launch's post-quantum identity (permissionless).
    pub fn activate(ctx: Context<Activate>, activate_at: i64) -> Result<()> {
        instructions::governance::handle_activate(ctx, activate_at)
    }

    /// Make the queued graph active at or after its time (permissionless).
    pub fn apply_pending(ctx: Context<ApplyPending>) -> Result<()> {
        instructions::governance::handle_apply_pending(ctx)
    }

    /// Make the active graph permanent, authorized by the launch's
    /// post-quantum identity until `not_after`, which the authorization
    /// signs (permissionless).
    pub fn freeze(ctx: Context<Govern>, not_after: i64) -> Result<()> {
        instructions::governance::handle_freeze(ctx, not_after)
    }

    /// Clear the operator, authorized by the launch's post-quantum identity
    /// (permissionless).
    pub fn revoke_operator(ctx: Context<Govern>) -> Result<()> {
        instructions::governance::handle_revoke_operator(ctx)
    }

    /// Run one due node of the active graph and tip the caller
    /// (permissionless; operator-gated nodes need the operator and its
    /// amount; a keeper may choose a smaller buyback amount).
    pub fn run<'info>(
        ctx: Context<'info, Run<'info>>,
        node: u8,
        amount: Option<u64>,
    ) -> Result<()> {
        instructions::run::handle_run(ctx, node, amount)
    }

    /// Observe the pool's price and move the reference toward what the
    /// observations agree on (permissionless, any time after graduation).
    pub fn update_price(ctx: Context<UpdatePrice>) -> Result<()> {
        instructions::update_price::handle_update_price(ctx)
    }
}

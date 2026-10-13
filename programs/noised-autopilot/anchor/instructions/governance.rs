//! Graph changes. Every one needs an `Authorization` the launchpad wrote
//! after verifying, on-chain, an LMS signature by the launch's post-quantum
//! identity over the exact change (`launchpad.rs`), used at most once and
//! never after a newer one it could undo (`logic::check_fresh`). A
//! replacement graph takes effect only after the 72-hour timelock; a frozen
//! graph never changes again; a revoked operator gets no power back from
//! anything signed before its revocation. No Ed25519 key (the creator's
//! included) can change anything here.

use anchor_lang::prelude::*;
use noised_rules::graph::Graph;

use crate::{
    constants::*,
    error::AutopilotError,
    events::{GraphActivated, GraphFrozen, GraphQueued, OperatorRevoked},
    launchpad::{self, authorization::kind, AuthView},
    logic,
    state::{AuthMark, Autopilot, GraphRecord, NodeRecord, MAX_NODES},
};

/// Check `authorization` (of `kind` over `payload_hash`, by the launch's
/// identity), that it may be used now (`logic::check_fresh`), and record it
/// as the latest used of its kind.
fn use_authorization(
    autopilot: &mut Autopilot,
    launch: &AccountInfo,
    authorization: &AccountInfo,
    kind: u8,
    payload_hash: &[u8; 32],
) -> Result<AuthView> {
    let view = launchpad::read_launch(launch)?;
    let auth = launchpad::check_authorization(
        authorization.key,
        authorization.owner,
        &authorization.try_borrow_data()?,
        launch.key,
        &view.pq_identity,
        kind,
        payload_hash,
    )?;
    let mark = AuthMark {
        slot: auth.slot,
        key: *authorization.key,
    };
    logic::check_fresh(&mark, &autopilot.auth_marks, kind)?;
    autopilot.auth_marks[logic::mark_index(kind)?] = mark;
    Ok(auth)
}

/// Permissionless (the authorization authorizes): queue a published graph
/// to take effect at `activate_at`, with its operator. A first graph
/// (nothing active or queued) may take effect at once; otherwise at least
/// 72 hours later (`logic::check_activation`). A later activation replaces
/// a queued one.
pub fn handle_activate(ctx: Context<Activate>, activate_at: i64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let graph_hash = ctx.accounts.graph.graph_hash;
    // Verified when published; parse is the O(1) layout check.
    let operator = Graph::parse(&ctx.accounts.graph.bytes)
        .map_err(|_| AutopilotError::InvalidGraph)?
        .operator()
        .map_or(Pubkey::default(), |k| Pubkey::new_from_array(*k));
    let autopilot_key = ctx.accounts.autopilot.key();
    let payload = launchpad::activation_payload(&autopilot_key, &graph_hash, activate_at);
    let ap = &mut ctx.accounts.autopilot;
    let auth = use_authorization(
        ap,
        &ctx.accounts.launch,
        &ctx.accounts.authorization,
        kind::GRAPH_ACTIVATE,
        &payload,
    )?;
    logic::check_activation(
        &ap.active_graph,
        &ap.pending_graph,
        ap.frozen,
        now,
        activate_at,
        auth.unix_time,
    )?;
    ap.pending_graph = graph_hash;
    ap.pending_activate_at = activate_at;
    ap.pending_operator = operator;
    emit!(GraphQueued {
        autopilot: autopilot_key,
        graph_hash,
        activate_at,
        authorization: ctx.accounts.authorization.key(),
        operator,
    });
    Ok(())
}

/// Permissionless, at or after `activate_at`: the queued graph becomes the
/// active one, with fresh node states and the operator it was queued with
/// (its own, unless a revocation took it away meanwhile). The authorization
/// that queued it and the `activate_at` it signed are kept with it
/// (`active_auth`, `active_activate_at`; audit 4, A4-S): the latest
/// activation used is always the queued graph's, since every activation
/// replaces the queued graph and nothing else queues one.
pub fn handle_apply_pending(ctx: Context<ApplyPending>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let ap = &mut ctx.accounts.autopilot;
    logic::check_apply(&ap.pending_graph, ap.pending_activate_at, ap.frozen, now)?;
    let operator = ap.pending_operator;
    ap.active_auth = ap.auth_marks[logic::mark_index(kind::GRAPH_ACTIVATE)?].key;
    ap.active_activate_at = ap.pending_activate_at;
    ap.active_graph = ap.pending_graph;
    ap.pending_graph = [0; 32];
    ap.pending_activate_at = 0;
    ap.pending_operator = Pubkey::default();
    ap.activated_at = now;
    ap.operator = operator;
    ap.nodes = [NodeRecord::default(); MAX_NODES];
    ap.partial_spent = [0; MAX_NODES];
    emit!(GraphActivated {
        autopilot: ap.key(),
        graph_hash: ap.active_graph,
        operator,
    });
    Ok(())
}

/// Permissionless (the authorization authorizes): make the active graph
/// permanent. A queued update is cancelled; an authorization older than the
/// latest activation used cannot do this (`logic::check_fresh`), nor one
/// used after the `not_after` it was signed with
/// (`logic::check_freeze_window`).
pub fn handle_freeze(ctx: Context<Govern>, not_after: i64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let autopilot_key = ctx.accounts.autopilot.key();
    let ap = &mut ctx.accounts.autopilot;
    require!(!ap.frozen, AutopilotError::Frozen);
    require!(ap.active_graph != [0; 32], AutopilotError::NoActiveGraph);
    logic::check_freeze_window(now, not_after)?;
    let payload = launchpad::freeze_payload(&autopilot_key, &ap.active_graph, not_after);
    use_authorization(
        ap,
        &ctx.accounts.launch,
        &ctx.accounts.authorization,
        kind::GRAPH_FREEZE,
        &payload,
    )?;
    let cancelled = ap.pending_graph;
    ap.frozen = true;
    ap.pending_graph = [0; 32];
    ap.pending_activate_at = 0;
    ap.pending_operator = Pubkey::default();
    emit!(GraphFrozen {
        autopilot: autopilot_key,
        graph_hash: ap.active_graph,
        cancelled,
    });
    Ok(())
}

/// Permissionless (the authorization authorizes): clear the active graph's
/// operator, so its operator-gated nodes stop (nobody can run them), and
/// take the same operator from a queued graph. Allowed on a frozen graph
/// too: it only takes a power away, one the operator could already withhold
/// by never running. The authorization names the active graph and the
/// authorization that activated it (`active_auth`; audit 4, A4-3), so it
/// revokes this activation's operator only: an operator appointed again by
/// a later activation (even of the same graph) needs, and can always get, a
/// new revocation. No newer activation or freeze voids it, and no
/// activation signed before it can appoint an operator again
/// (`logic::check_fresh`).
pub fn handle_revoke_operator(ctx: Context<Govern>) -> Result<()> {
    let autopilot_key = ctx.accounts.autopilot.key();
    let ap = &mut ctx.accounts.autopilot;
    let operator = ap.operator;
    require!(operator != Pubkey::default(), AutopilotError::NoOperator);
    let payload =
        launchpad::revoke_payload(&autopilot_key, &ap.active_graph, &operator, &ap.active_auth);
    use_authorization(
        ap,
        &ctx.accounts.launch,
        &ctx.accounts.authorization,
        kind::OPERATOR_REVOKE,
        &payload,
    )?;
    ap.operator = Pubkey::default();
    let pending_cleared = ap.pending_operator == operator;
    if pending_cleared {
        ap.pending_operator = Pubkey::default();
    }
    emit!(OperatorRevoked {
        autopilot: autopilot_key,
        operator,
        pending_cleared,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct Activate<'info> {
    #[account(mut, seeds = [AUTOPILOT_SEED, launch.key().as_ref()], bump = autopilot.bump)]
    pub autopilot: Box<Account<'info, Autopilot>>,

    /// CHECK: the launchpad `Launch`, read by layout (its identity).
    pub launch: UncheckedAccount<'info>,

    /// The published graph to queue.
    #[account(
        seeds = [GRAPH_SEED, launch.key().as_ref(), graph.graph_hash.as_ref()],
        bump = graph.bump,
    )]
    pub graph: Box<Account<'info, GraphRecord>>,

    /// CHECK: the launchpad `Authorization` (GRAPH_ACTIVATE), read by layout
    /// (`launchpad::check_authorization`).
    pub authorization: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ApplyPending<'info> {
    #[account(
        mut,
        seeds = [AUTOPILOT_SEED, autopilot.launch.as_ref()],
        bump = autopilot.bump,
        constraint = autopilot.pending_graph != [0; 32] @ AutopilotError::NoPendingUpdate,
    )]
    pub autopilot: Box<Account<'info, Autopilot>>,

    /// The queued graph.
    #[account(
        seeds = [GRAPH_SEED, autopilot.launch.as_ref(), autopilot.pending_graph.as_ref()],
        bump = graph.bump,
    )]
    pub graph: Box<Account<'info, GraphRecord>>,
}

/// `freeze` and `revoke_operator`.
#[derive(Accounts)]
pub struct Govern<'info> {
    #[account(mut, seeds = [AUTOPILOT_SEED, launch.key().as_ref()], bump = autopilot.bump)]
    pub autopilot: Box<Account<'info, Autopilot>>,

    /// CHECK: the launchpad `Launch`, read by layout (its identity).
    pub launch: UncheckedAccount<'info>,

    /// CHECK: the launchpad `Authorization`, read by layout.
    pub authorization: UncheckedAccount<'info>,
}

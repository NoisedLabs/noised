//! Graph changes. Every one needs an `Authorization` the launchpad wrote
//! after verifying, on-chain, an LMS signature by the launch's post-quantum
//! identity over the exact change (`launchpad.rs`), used at most once and
//! never after a newer one it could undo (`logic::check_fresh`). A
//! replacement graph takes effect only after the 72-hour timelock; a frozen
//! graph never changes again; a revoked operator gets no power back from
//! anything signed before its revocation. No Ed25519 key (the creator's
//! included) can change anything here.

use alloc::boxed::Box;
use noised_onchain::args;
use noised_rules::graph::Graph;
use pinocchio::{AccountView, ProgramResult};

use crate::processor::*;
use crate::{
    error::AutopilotError,
    events::{GraphActivated, GraphFrozen, GraphQueued, OperatorRevoked},
    launchpad::{self, authorization::kind, AuthView},
    logic,
    state::{AuthMark, Autopilot, GraphRecord, NodeRecord, MAX_NODES},
    ProgramError, Pubkey,
};

/// The `i64` argument of `activate(activate_at)` / `freeze(not_after)`
/// (Borsh; trailing bytes ignored): `InstructionDidNotDeserialize` when
/// shorter.
pub fn parse_i64(data: &[u8]) -> Result<i64, ProgramError> {
    args::decode::<P, _>(data, |r| r.i64())
}

/// Check `authorization` (of `kind` over `payload_hash`, by the launch's
/// identity), that it may be used now (`logic::check_fresh`), and record it
/// as the latest used of its kind.
fn use_authorization(
    autopilot: &mut Autopilot,
    launch: &AccountView,
    authorization: &AccountView,
    kind: u8,
    payload_hash: &[u8; 32],
) -> Result<AuthView, ProgramError> {
    let view = launchpad::read_launch(launch)?;
    let auth = launchpad::check_authorization(
        authorization.address(),
        authorization.owner(),
        &authorization.try_borrow()?,
        launch.address(),
        &view.pq_identity,
        kind,
        payload_hash,
    )?;
    let mark = AuthMark {
        slot: auth.slot,
        key: *authorization.address(),
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
///
/// Arguments: `activate_at: i64`. Accounts (`Activate`): autopilot
/// (writable), launch (its identity), graph (the published record to
/// queue), authorization (the launchpad `Authorization`, GRAPH_ACTIVATE).
pub fn activate(mut accounts: Accounts, data: &[u8]) -> ProgramResult {
    log_instruction("Instruction: Activate");
    let activate_at = parse_i64(data)?;
    let (autopilot, mut ap) = accounts.account::<Box<Autopilot>>(AUTOPILOT)?;
    let launch = accounts.unchecked(LAUNCH)?;
    let (graph, record) = accounts.account::<GraphRecord>(GRAPH)?;
    let authorization = accounts.unchecked(AUTHORIZATION)?;

    // [A] autopilot: seeds = [AUTOPILOT_SEED, launch.key()], bump =
    // autopilot.bump; mut. graph: seeds = [GRAPH_SEED, launch.key(),
    // graph.graph_hash], bump = graph.bump.
    check_autopilot(autopilot, &ap, launch.address())?;
    check_graph(graph, launch.address(), &record.graph_hash, record.bump)?;

    // Handler.
    let now = now()?;
    let graph_hash = record.graph_hash;
    // Verified when published; parse is the O(1) layout check.
    let operator = Graph::parse(&record.bytes)
        .map_err(|_| AutopilotError::InvalidGraph)?
        .operator()
        .map_or(Pubkey::default(), |k| Pubkey::new_from_array(*k));
    let autopilot_key = *autopilot.address();
    let payload = launchpad::activation_payload(&autopilot_key, &graph_hash, activate_at);
    let auth = use_authorization(
        &mut ap,
        launch,
        authorization,
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
    GraphQueued {
        autopilot: autopilot_key,
        graph_hash,
        activate_at,
        authorization: *authorization.address(),
        operator,
    }
    .emit();

    // Exit.
    write_autopilot(autopilot, &ap)
}

/// Permissionless, at or after `activate_at`: the queued graph becomes the
/// active one, with fresh node states and the operator it was queued with
/// (its own, unless a revocation took it away meanwhile). The authorization
/// that queued it and the `activate_at` it signed are kept with it
/// (`active_auth`, `active_activate_at`; audit 4, A4-S): the latest
/// activation used is always the queued graph's, since every activation
/// replaces the queued graph and nothing else queues one.
///
/// Accounts (`ApplyPending`): autopilot (writable), graph (the queued
/// record).
pub fn apply_pending(mut accounts: Accounts) -> ProgramResult {
    log_instruction("Instruction: ApplyPending");
    let (autopilot, mut ap) = accounts.account::<Box<Autopilot>>(AUTOPILOT)?;
    let (graph, record) = accounts.account::<GraphRecord>(GRAPH)?;

    // [A] autopilot: seeds = [AUTOPILOT_SEED, autopilot.launch], bump =
    // autopilot.bump; mut; constraint = autopilot.pending_graph != [0; 32]
    // @ NoPendingUpdate. graph: seeds = [GRAPH_SEED, autopilot.launch,
    // autopilot.pending_graph], bump = graph.bump.
    check_autopilot(autopilot, &ap, &ap.launch)?;
    check_autopilot_constraint(ap.pending_graph != [0; 32], AutopilotError::NoPendingUpdate)?;
    check_graph(graph, &ap.launch, &ap.pending_graph, record.bump)?;

    // Handler.
    let now = now()?;
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
    GraphActivated {
        autopilot: *autopilot.address(),
        graph_hash: ap.active_graph,
        operator,
    }
    .emit();

    // Exit.
    write_autopilot(autopilot, &ap)
}

/// The accounts of `freeze` and `revoke_operator` (`Govern`): autopilot
/// (writable), launch (its identity), authorization.
fn govern_accounts<'a>(
    accounts: &mut Accounts<'a>,
) -> Result<
    (
        &'a AccountView,
        Box<Autopilot>,
        &'a AccountView,
        &'a AccountView,
    ),
    ProgramError,
> {
    let (autopilot, ap) = accounts.account::<Box<Autopilot>>(AUTOPILOT)?;
    let launch = accounts.unchecked(LAUNCH)?;
    let authorization = accounts.unchecked(AUTHORIZATION)?;
    // [A] autopilot: seeds = [AUTOPILOT_SEED, launch.key()], bump =
    // autopilot.bump; mut.
    check_autopilot(autopilot, &ap, launch.address())?;
    Ok((autopilot, ap, launch, authorization))
}

/// Permissionless (the authorization authorizes): make the active graph
/// permanent. A queued update is cancelled; an authorization older than the
/// latest activation used cannot do this (`logic::check_fresh`), nor one
/// used after the `not_after` it was signed with
/// (`logic::check_freeze_window`).
///
/// Arguments: `not_after: i64`. Accounts: `Govern`.
pub fn freeze(mut accounts: Accounts, data: &[u8]) -> ProgramResult {
    log_instruction("Instruction: Freeze");
    let not_after = parse_i64(data)?;
    let (autopilot, mut ap, launch, authorization) = govern_accounts(&mut accounts)?;

    // Handler.
    let now = now()?;
    let autopilot_key = *autopilot.address();
    require!(!ap.frozen, AutopilotError::Frozen);
    require!(ap.active_graph != [0; 32], AutopilotError::NoActiveGraph);
    logic::check_freeze_window(now, not_after)?;
    let payload = launchpad::freeze_payload(&autopilot_key, &ap.active_graph, not_after);
    use_authorization(&mut ap, launch, authorization, kind::GRAPH_FREEZE, &payload)?;
    let cancelled = ap.pending_graph;
    ap.frozen = true;
    ap.pending_graph = [0; 32];
    ap.pending_activate_at = 0;
    ap.pending_operator = Pubkey::default();
    GraphFrozen {
        autopilot: autopilot_key,
        graph_hash: ap.active_graph,
        cancelled,
    }
    .emit();

    // Exit.
    write_autopilot(autopilot, &ap)
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
///
/// Accounts: `Govern`.
pub fn revoke_operator(mut accounts: Accounts) -> ProgramResult {
    log_instruction("Instruction: RevokeOperator");
    let (autopilot, mut ap, launch, authorization) = govern_accounts(&mut accounts)?;

    // Handler.
    let autopilot_key = *autopilot.address();
    let operator = ap.operator;
    require!(operator != Pubkey::default(), AutopilotError::NoOperator);
    let payload =
        launchpad::revoke_payload(&autopilot_key, &ap.active_graph, &operator, &ap.active_auth);
    use_authorization(
        &mut ap,
        launch,
        authorization,
        kind::OPERATOR_REVOKE,
        &payload,
    )?;
    ap.operator = Pubkey::default();
    let pending_cleared = ap.pending_operator == operator;
    if pending_cleared {
        ap.pending_operator = Pubkey::default();
    }
    OperatorRevoked {
        autopilot: autopilot_key,
        operator,
        pending_cleared,
    }
    .emit();

    // Exit.
    write_autopilot(autopilot, &ap)
}

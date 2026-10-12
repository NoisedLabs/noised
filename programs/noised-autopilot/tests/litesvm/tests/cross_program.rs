//! The launchpad's `pq_authorize` driving the autopilot end to end: the
//! `Authorization` accounts here are written by the launchpad build itself
//! (an LMS signature by the launch's identity, verified on-chain, its leaf
//! burned in the identity's bitmap), not by hand, and the autopilot build
//! accepts exactly them for `activate`, `revoke_operator` and `freeze`.
//! Each one also passes the autopilot's own layout check
//! (`launchpad::check_authorization`) byte for byte. How to build and run:
//! see `src/lib.rs` of this crate.

#[path = "../../../../noised-launchpad/tests/litesvm/tests/common/mod.rs"]
mod common;

mod ap;

use ap::*;
use common::{events, launch::create_ata, pq, Expect, Failed, Sent, TOKEN_PROGRAM_ID};
use noised_autopilot::{
    constants::WSOL_MINT,
    error::AutopilotError as E,
    events::{GraphActivated, GraphFrozen, GraphQueued, OperatorRevoked},
    launchpad::{self, authorization::kind},
};
use noised_launchpad::events::{Authorized, PqLeafConsumed};
use noised_rules::{
    graph::{action::BURN, trigger::EVERY, FLAG_HAS_OPERATOR},
    GNode, GraphProgram,
};
use solana_keypair::Keypair;
use solana_signer::Signer;

#[track_caller]
fn refused(r: Result<Sent, Failed>, e: E, what: &str) -> Failed {
    r.fails_with(ap_code(e), &format!("{e:?}"), what)
}

/// A graph with an operator-gated burn and a keeper burn.
fn operated(operator: &Keypair) -> GraphProgram {
    let node = |gated: u8| GNode {
        trigger: EVERY,
        trigger_arg: 600,
        cond_off: 0,
        cond_len: 0,
        action: BURN,
        operator_gated: gated,
        epoch_secs: 86_400,
        budget_per_epoch: 1_000,
        p1: 100,
        p2: 0,
        max_runs_per_epoch: 10,
        reserved: [0; 5],
    };
    GraphProgram {
        flags: FLAG_HAS_OPERATOR,
        operator: operator.pubkey().to_bytes(),
        recipients: vec![],
        nodes: vec![node(1), node(0)],
        cond: vec![],
    }
}

/// `pq_authorize` by the launch's identity, landed now by the launchpad;
/// the account it wrote passes the autopilot's own check.
fn authorize(t: &mut ApWorld, kind: u8, payload: [u8; 32]) -> anchor_lang::prelude::Pubkey {
    let launch = t.a.launch;
    let sent = pq::try_authorize_by(t.env(), pq::identity(), &launch, kind, payload)
        .expect_ok("pq_authorize");
    let e = events::<Authorized>(&sent.logs).pop().expect("Authorized");
    let address = pq::auth_pda(&launch, kind, &payload);
    assert_eq!(e.authorization, address);
    let account = t.w.env.account(&address).unwrap();
    let view = launchpad::check_authorization(
        &address,
        &account.owner,
        &account.data,
        &launch,
        &pq::identity_id(),
        kind,
        &payload,
    )
    .expect("the autopilot reads the launchpad's authorization");
    assert_eq!((view.unix_time, view.slot), (e.unix_time, e.slot));
    // A minute later: each authorization lands in its own slot.
    let now = t.now();
    t.env().set_time(now + 60);
    address
}

#[test]
fn launchpad_authorizations_drive_activate_revoke_and_freeze() {
    let mut t = ap_world(true);
    let a = t.a;
    let operator = t.w.env.funded(2);
    t.send(
        &[create_ata(
            &operator.pubkey(),
            &operator.pubkey(),
            &WSOL_MINT,
            &TOKEN_PROGRAM_ID,
        )],
        &[&operator],
    )
    .expect_ok("operator's wSOL account");
    let (bytes, h) = compile(&operated(&operator));
    let payer = t.payer();
    t.send(&[publish_graph(&payer, &a, &bytes)], &[])
        .expect_ok("publish_graph");

    // Another identity's signature over the activation lands at the
    // launchpad and only burns its own leaf: no authorization exists, so
    // the autopilot refuses. (The first graph takes effect when the
    // authorization is used: a minute from now, see `authorize`.)
    let now = t.now() + 60;
    let payload = launchpad::activation_payload(&a.autopilot, &h, now);
    let sent = pq::try_authorize_by(
        t.env(),
        pq::other_identity(),
        &a.launch,
        kind::GRAPH_ACTIVATE,
        payload,
    )
    .expect_ok("another identity's signature lands");
    assert_eq!(events::<PqLeafConsumed>(&sent.logs).len(), 1);
    assert!(events::<Authorized>(&sent.logs).is_empty());
    let empty = pq::auth_pda(&a.launch, kind::GRAPH_ACTIVATE, &payload);
    refused(
        t.send(&[activate(&a, &h, &empty, now)], &[]),
        E::InvalidAuthorization,
        "an authorization another identity's signature left empty",
    );

    // The launch's identity: activate (first graph, at once) and apply.
    let auth = authorize(&mut t, kind::GRAPH_ACTIVATE, payload);
    assert_eq!(auth, empty);
    let sent = t
        .send(&[activate(&a, &h, &auth, now)], &[])
        .expect_ok("activate with the launchpad's authorization");
    let q = events::<GraphQueued>(&sent.logs).pop().unwrap();
    assert_eq!((q.graph_hash, q.authorization), (h, auth));
    let sent = t
        .send(&[apply_pending(&a, &h)], &[])
        .expect_ok("apply_pending");
    assert_eq!(events::<GraphActivated>(&sent.logs).len(), 1);
    assert_eq!(t.state().operator, operator.pubkey());
    // An authorization of another payload (another activation time) does
    // not activate.
    let other = authorize(
        &mut t,
        kind::GRAPH_ACTIVATE,
        launchpad::activation_payload(&a.autopilot, &h, now + 1),
    );
    refused(
        t.send(&[activate(&a, &h, &other, now)], &[]),
        E::InvalidAuthorization,
        "an authorization of another activation time",
    );

    // Revoke the operator (payload v3: the activation it revokes, audit 4,
    // A4-3).
    assert_eq!(t.state().active_auth, auth);
    let revoke = authorize(
        &mut t,
        kind::OPERATOR_REVOKE,
        launchpad::revoke_payload(&a.autopilot, &h, &operator.pubkey(), &auth),
    );
    // An authorization of one kind is never another kind's.
    refused(
        t.send(&[freeze(&a, &revoke, t.now())], &[]),
        E::InvalidAuthorization,
        "a revocation used as a freeze",
    );
    let sent = t
        .send(&[revoke_operator(&a, &revoke)], &[])
        .expect_ok("revoke_operator with the launchpad's authorization");
    let ev = events::<OperatorRevoked>(&sent.logs).pop().unwrap();
    assert_eq!(ev.operator, operator.pubkey());
    assert_eq!(t.state().operator, anchor_lang::prelude::Pubkey::default());

    // Freeze (payload v2, review 4, R5): only until the not_after it signs,
    // and only with that not_after.
    let not_after = t.now() + 3_600;
    let frz = authorize(
        &mut t,
        kind::GRAPH_FREEZE,
        launchpad::freeze_payload(&a.autopilot, &h, not_after),
    );
    refused(
        t.send(&[freeze(&a, &frz, not_after + 1)], &[]),
        E::InvalidAuthorization,
        "the freeze with another not_after",
    );
    let past = t.now() - 1;
    let expired = authorize(
        &mut t,
        kind::GRAPH_FREEZE,
        launchpad::freeze_payload(&a.autopilot, &h, past),
    );
    refused(
        t.send(&[freeze(&a, &expired, past)], &[]),
        E::FreezeExpired,
        "a freeze after its not_after",
    );
    assert!(!t.state().frozen);
    let sent = t
        .send(&[freeze(&a, &frz, not_after)], &[])
        .expect_ok("freeze with the launchpad's authorization");
    assert_eq!(
        events::<GraphFrozen>(&sent.logs).pop().unwrap().graph_hash,
        h
    );
    assert!(t.state().frozen);
    refused(
        t.send(&[freeze(&a, &frz, not_after)], &[]),
        E::Frozen,
        "frozen twice",
    );
    // Every authorization above burned its own leaf of the one identity.
    let id = pq::identity_account(&t.w.env, &pq::identity_id()).unwrap();
    for address in [auth, other, revoke, expired, frz] {
        let leaf = pq::authorization_account(&t.w.env, &address).unwrap().leaf;
        assert!(pq::leaf_used(&id, u32::from(leaf)));
    }
}

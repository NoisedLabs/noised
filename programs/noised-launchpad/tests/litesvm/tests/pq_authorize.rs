//! `pq_authorize`: generic post-quantum authorizations by a launch's
//! identity (programmable launches §2, amendment A1). The exact
//! `Authorization` account (the layout the autopilot reads), written once;
//! every valid signature burns its leaf in the identity's one bitmap, shared
//! with attestations; other identities, kinds the autopilot does not read
//! (review 4, Ra) and second signatures only burn; a relayer cannot
//! redirect a signature. Compute and transaction size.

mod common;

use anchor_lang::AccountSerialize;
use common::{launch::*, pq, world::*, *};
use noised_launchpad::{
    error::LaunchpadError as E,
    events::{Authorized, PqLeafConsumed},
    state::Authorization,
};
use noised_lmots::{LmsKeyPair, Sha2};
use solana_clock::Clock;
use solana_signer::Signer;

/// The single event `T` of a transaction.
#[track_caller]
fn one_event<T: anchor_lang::Event>(sent: &Sent) -> T {
    let mut all = events::<T>(&sent.logs);
    assert_eq!(all.len(), 1, "{}", sent.logs.join("\n"));
    all.remove(0)
}

fn used(env: &Env, kp: &LmsKeyPair) -> u16 {
    pq::identity_account(env, &pq::identity_id_of(&pq::public_key(kp)))
        .map_or(0, |id| id.used_count)
}

/// A signature of `launch`'s authorization message by `kp` at its next
/// free leaf: `(leaf, signature)`.
fn sign(
    env: &Env,
    kp: &LmsKeyPair,
    launch: &Pubkey,
    kind: u8,
    payload: &[u8; 32],
) -> (u32, Vec<u8>) {
    let msg = pq::auth_message(env, launch, kind, payload);
    let q = pq::next_free_leaf(env, kp, &msg);
    (q, kp.sign_deterministic::<Sha2>(q, &msg).unwrap())
}

fn land(
    env: &mut Env,
    kp: &LmsKeyPair,
    launch: &Pubkey,
    kind: u8,
    payload: [u8; 32],
    sig: Vec<u8>,
) -> Result<Sent, Failed> {
    let payer = pq::throwaway_payer(env);
    let ix = pq::pq_authorize_ix(
        &payer.pubkey(),
        launch,
        pq::public_key(kp),
        sig,
        kind,
        payload,
    );
    env.send_v1(&payer, &[ix], &[], pq::attest_config())
}

/// Every kind the autopilot reads (1, 2 and 3), on a Configured and on a
/// Live launch: the account written is exactly the documented
/// `Authorization`, with the clock's time and slot, the canonical bump, the
/// message hash and the whole signature; its leaf is burned in the identity
/// the attestations use.
#[test]
fn authorizations_are_written_exactly_once_per_kind_and_payload() {
    let mut w = created_with(|_| {});
    let k = w.k;
    let creator = w.creator.pubkey();
    for (round, kind) in [1u8, 2, 3].into_iter().enumerate() {
        if round == 2 {
            // Live from here on.
            pq::attest(&mut w.env, &k, META);
            w.env
                .send(
                    &[launch(&creator, &k, NAME, SYMBOL, URI)],
                    &[&w.creator, &w.mint],
                )
                .expect_ok("launch");
        }
        let env = &mut w.env;
        let now = env.now();
        env.set_time(now + 7);
        let payload = pq::sha256(&[b"payload", &[kind]]);
        let (q, sig) = sign(env, pq::identity(), &k.launch, kind, &payload);
        let before = used(env, pq::identity());
        let sent = land(env, pq::identity(), &k.launch, kind, payload, sig.clone())
            .expect_ok("pq_authorize");
        println!(
            "pq_authorize (kind {kind}): {} CU, {} bytes",
            sent.cu, sent.size
        );
        assert!(sent.size <= V1_MAX_TRANSACTION_SIZE && sent.cu <= 250_000);
        let clock = env.svm.get_sysvar::<Clock>();
        let address = pq::auth_pda(&k.launch, kind, &payload);
        let (_, bump) = Pubkey::find_program_address(
            &[b"auth", k.launch.as_ref(), &[kind], &payload],
            &noised_launchpad::ID,
        );
        let mut want = Vec::new();
        Authorization {
            version: 1,
            bump,
            launch: k.launch,
            pq_identity: pq::identity_id(),
            kind,
            payload_hash: payload,
            message_hash: pq::sha256(&[&pq::authorization_message(
                &k.launch, &creator, kind, &payload,
            )]),
            unix_time: clock.unix_timestamp,
            slot: clock.slot,
            leaf: q as u16,
            signature: sig.clone(),
        }
        .try_serialize(&mut want)
        .unwrap();
        let account = env.account(&address).unwrap();
        assert_eq!(account.owner, noised_launchpad::ID);
        assert_eq!(account.data.len(), 2_669);
        assert!(
            account.data == want,
            "kind {kind}: not exactly the authorization"
        );
        // The autopilot's offsets: kind at 74, unix time at 139, slot at 147.
        assert_eq!(account.data[74], kind);
        assert_eq!(&account.data[139..147], &clock.unix_timestamp.to_le_bytes());
        assert_eq!(&account.data[147..155], &clock.slot.to_le_bytes());
        let e: Authorized = one_event(&sent);
        assert_eq!(
            (
                e.launch,
                e.authorization,
                e.pq_identity,
                e.kind,
                e.payload_hash,
                u32::from(e.leaf),
                e.unix_time,
                e.slot
            ),
            (
                k.launch,
                address,
                pq::identity_id(),
                kind,
                payload,
                q,
                clock.unix_timestamp,
                clock.slot
            )
        );
        assert_eq!(used(env, pq::identity()), before + 1);
        let id = pq::identity_account(env, &pq::identity_id()).unwrap();
        assert!(pq::leaf_used(&id, q));

        // A second signature of the same authorization lands and only burns
        // its leaf; the account stays as it is.
        env.set_time(clock.unix_timestamp + 5);
        let (q2, sig2) = sign(env, pq::identity(), &k.launch, kind, &payload);
        assert_ne!(q2, q);
        let sent = land(env, pq::identity(), &k.launch, kind, payload, sig2).expect_ok("again");
        let e: PqLeafConsumed = one_event(&sent);
        assert_eq!(
            (e.pq_identity, u32::from(e.leaf), e.launch),
            (pq::identity_id(), q2, k.launch)
        );
        assert!(events::<Authorized>(&sent.logs).is_empty());
        assert_eq!(env.account(&address).unwrap().data, want);
        assert_eq!(used(env, pq::identity()), before + 2);
        // The same signature again: its leaf is used.
        land(env, pq::identity(), &k.launch, kind, payload, sig).fails_with(
            code(E::PqLeafUsed),
            "PqLeafUsed",
            "a replay",
        );
    }
}

/// One bitmap per identity: a leaf that signed an attestation cannot sign an
/// authorization, and the other way round; another identity's valid
/// signature burns only its own leaf and authorizes nothing; signatures
/// that do not verify land nothing; and the accounts are fixed by the
/// signed data.
#[test]
fn leaves_are_shared_and_only_the_launchs_identity_authorizes() {
    let mut w = created_with(|_| {});
    let k = w.k;
    let env = &mut w.env;
    pq::attest(env, &k, META);
    let attested = env
        .anchor::<noised_launchpad::state::Attestation>(&k.attestation)
        .leaf;
    let payload = [0x42; 32];
    let msg = pq::auth_message(env, &k.launch, 1, &payload);
    let sig = pq::identity()
        .sign_deterministic::<Sha2>(u32::from(attested), &msg)
        .unwrap();
    land(env, pq::identity(), &k.launch, 1, payload, sig).fails_with(
        code(E::PqLeafUsed),
        "PqLeafUsed",
        "an authorization at the attestation's leaf",
    );
    // An authorization's leaf cannot attest.
    let address = pq::authorize(env, &k.launch, 1, payload);
    let leaf = pq::authorization_account(env, &address).unwrap().leaf;
    let terms = pq::Terms::now(env);
    let signed = pq::sign_with(env, pq::identity(), u32::from(leaf), &k, META, terms);
    pq::send_attestation(env, &k, &signed, META).fails_with(
        code(E::PqLeafUsed),
        "PqLeafUsed",
        "an attestation at an authorization's leaf",
    );

    // Another identity: lands, burns its own leaf, authorizes nothing.
    let other = pq::other_identity();
    let payload2 = [0x43; 32];
    let (q, sig) = sign(env, other, &k.launch, 2, &payload2);
    let sent = land(env, other, &k.launch, 2, payload2, sig).expect_ok("another identity");
    let e: PqLeafConsumed = one_event(&sent);
    assert_eq!(
        (e.pq_identity, u32::from(e.leaf)),
        (pq::identity_id_of(&pq::public_key(other)), q)
    );
    let empty = pq::authorization_account(env, &pq::auth_pda(&k.launch, 2, &payload2)).unwrap();
    assert_eq!(
        (empty.version, empty.launch, empty.signature.len()),
        (0, Pubkey::default(), 0)
    );
    // ... and the launch's own identity still authorizes that payload.
    let address2 = pq::authorize(env, &k.launch, 2, payload2);
    assert_eq!(
        pq::authorization_account(env, &address2).unwrap().version,
        1
    );

    // Not verifying: a flipped byte, another message (other kind, payload,
    // launch), nothing landed.
    let payload3 = [0x44; 32];
    let (_, sig) = sign(env, pq::identity(), &k.launch, 3, &payload3);
    let before = used(env, pq::identity());
    let mut flipped = sig.clone();
    flipped[100] ^= 1;
    for (what, kind, payload, s) in [
        ("a flipped byte", 3u8, payload3, flipped),
        ("another kind", 1, payload3, sig.clone()),
        ("another payload", 3, [0x45; 32], sig.clone()),
    ] {
        land(env, pq::identity(), &k.launch, kind, payload, s).fails_with(
            code(E::InvalidPqSignature),
            "InvalidPqSignature",
            what,
        );
    }
    assert_eq!(used(env, pq::identity()), before);
    // A relayer cannot point the signature at another account.
    let payer = pq::throwaway_payer(env);
    let mut ix = pq::pq_authorize_ix(
        &payer.pubkey(),
        &k.launch,
        pq::public_key(pq::identity()),
        sig,
        3,
        payload3,
    );
    ix.accounts[3].pubkey = pq::auth_pda(&k.launch, 3, &[0x46; 32]);
    env.send_v1(&payer, &[ix], &[], pq::attest_config())
        .fails_with(
            CONSTRAINT_SEEDS,
            "ConstraintSeeds",
            "another authorization address",
        );
    assert_eq!(used(env, pq::identity()), before);
}

/// Review 4, Ra: only the kinds the autopilot reads (1 to 3) are written. A
/// valid signature by the launch's own identity of any other kind (0, 4,
/// the old test's 200, 255) lands and only burns its leaf, like another
/// identity's: `PqLeafConsumed`, no `Authorized`, and the account it names
/// stays empty (version 0), on a Configured and on a Live launch. The same
/// payload signed as kind 1 is then still authorized.
#[test]
fn other_kinds_only_burn_their_leaf() {
    let mut w = created_with(|_| {});
    let k = w.k;
    let creator = w.creator.pubkey();
    for (round, kind) in [0u8, 4, 200, 255].into_iter().enumerate() {
        if round == 2 {
            pq::attest(&mut w.env, &k, META);
            w.env
                .send(
                    &[launch(&creator, &k, NAME, SYMBOL, URI)],
                    &[&w.creator, &w.mint],
                )
                .expect_ok("launch");
        }
        let env = &mut w.env;
        let now = env.now();
        env.set_time(now + 7);
        let payload = pq::sha256(&[b"other kind", &[kind]]);
        let (q, sig) = sign(env, pq::identity(), &k.launch, kind, &payload);
        let before = used(env, pq::identity());
        let sent = land(env, pq::identity(), &k.launch, kind, payload, sig.clone())
            .expect_ok("a valid signature of another kind");
        let e: PqLeafConsumed = one_event(&sent);
        assert_eq!(
            (e.pq_identity, u32::from(e.leaf), e.launch),
            (pq::identity_id(), q, k.launch),
            "kind {kind}"
        );
        assert!(events::<Authorized>(&sent.logs).is_empty(), "kind {kind}");
        let empty =
            pq::authorization_account(env, &pq::auth_pda(&k.launch, kind, &payload)).unwrap();
        assert_eq!(
            (
                empty.version,
                empty.launch,
                empty.kind,
                empty.signature.len()
            ),
            (0, Pubkey::default(), 0, 0),
            "kind {kind}"
        );
        assert_eq!(used(env, pq::identity()), before + 1, "kind {kind}");
        let id = pq::identity_account(env, &pq::identity_id()).unwrap();
        assert!(pq::leaf_used(&id, q), "kind {kind}");
        // Its leaf is spent: the same signature again is a replay.
        land(env, pq::identity(), &k.launch, kind, payload, sig).fails_with(
            code(E::PqLeafUsed),
            "PqLeafUsed",
            "a replay",
        );
    }
    // The boundaries: kinds 1 and 3 authorize (2 is in the test above).
    for kind in [1u8, 3] {
        let payload = pq::sha256(&[b"other kind", &[kind]]);
        let address = pq::authorize(&mut w.env, &k.launch, kind, payload);
        let written = pq::authorization_account(&w.env, &address).unwrap();
        assert_eq!((written.version, written.kind), (1, kind));
    }
}

//! The third audit's on-chain fixes, against our SBF builds and the mainnet
//! DBC, Token-2022, SPL Token and ATA programs (the audit's PoCs, ported):
//!
//! * F1: an attestation whose window passed while the launch was still
//!   Configured is replaced, whole, by the identity's next attesting
//!   signature, and a window is recorded only with at least a minute of it
//!   left when its attestation lands. An attestation whose window has not
//!   ended, or a Live launch's, never changes. Every valid signature burns
//!   its leaf, whatever it does. So no landing, however late or held back,
//!   and no window that passes unused, leaves a launch that can never open.
//! * F2: while the Launch Guard is on, every transfer that moves tokens and
//!   is not a sell goes only into a token account whose owner can never
//!   change: one with Token-2022's ImmutableOwner extension (every ATA has
//!   it) or one an exempt launchpad PDA owns. Reassigning a token account's
//!   owner (Token-2022 `SetAuthority(AccountOwner)`) moves its tokens
//!   without a transfer, so the hook never sees it: buyers could otherwise
//!   fill such accounts and hand them over past the p2p lock and
//!   max_wallet. Sells never depend on it, the launch's own flows (the
//!   batch, claims, PQ vault payouts into ATAs) keep working, and nothing
//!   changes once the guard ends. `f2_hook_compute_on_buys_and_sells`
//!   prints what it costs.
//!
//! How to build and run: see `src/lib.rs`.

mod common;

use anchor_lang::{solana_program::system_instruction, AccountSerialize};
use anchor_spl::token_interface::spl_token_2022::{
    self,
    error::TokenError,
    extension::{
        immutable_owner::ImmutableOwner, BaseStateWithExtensions, ExtensionType,
        StateWithExtensions,
    },
    instruction::AuthorityType,
    state::Account as TokenAccount,
};
use common::{
    launch::*,
    pq::{self, Terms},
    vault::*,
    world::*,
    *,
};
use noised_hook::{state::HookPolicy, HookError};
use noised_launchpad::{
    error::LaunchpadError as E,
    events::{LaunchAttested, PqLeafConsumed},
    state::{Attestation, Certificate, Launch, LaunchStatus},
};
use noised_lmots::LmsKeyPair;
use solana_clock::Clock;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::v1;
use solana_signer::Signer;

/// Another record of the same launch, for a replacement that names it.
const META2: (&str, &str, &str) = (
    "Noised Second Window",
    "PHXSW",
    "https://example.org/noised/second-window-token-metadata.json",
);

/// The single event `T` of a transaction.
#[track_caller]
fn one_event<T: anchor_lang::Event>(sent: &Sent) -> T {
    let mut all = events::<T>(&sent.logs);
    assert_eq!(all.len(), 1, "{}", sent.logs.join("\n"));
    all.remove(0)
}

/// `kp`'s signature of launch `k`'s message for this metadata and these
/// terms, at the leaf that message probes to (the client's rule).
fn sign_next<'a>(
    env: &Env,
    kp: &LmsKeyPair,
    k: &Keys,
    meta: impl Into<pq::Meta<'a>>,
    terms: Terms,
) -> pq::Signed {
    let meta = meta.into();
    let msg = pq::message(env, k, meta, &terms);
    let q = pq::next_free_leaf(env, kp, &msg);
    pq::sign_with(env, kp, q, k, meta, terms)
}

/// How many leaves the test creator's identity has burned (0 before its
/// first landing).
fn used_count(env: &Env) -> u16 {
    pq::identity_account(env, &pq::identity_id()).map_or(0, |id| id.used_count)
}

/// Whether the test creator's identity has burned leaf `q`.
fn burned(env: &Env, q: u32) -> bool {
    pq::identity_account(env, &pq::identity_id()).is_some_and(|id| pq::leaf_used(&id, q))
}

/// `s` lands and only burns its leaf: `PqLeafConsumed` for that leaf, no
/// `LaunchAttested`, one more leaf used, and the attestation account
/// exactly as it was.
#[track_caller]
fn lands_burn_only(env: &mut Env, k: &Keys, s: &pq::Signed, meta: (&str, &str, &str), what: &str) {
    let before = env.account(&k.attestation);
    let used = used_count(env);
    let sent = pq::send_attestation(env, k, s, meta).expect_ok(what);
    assert!(events::<LaunchAttested>(&sent.logs).is_empty(), "{what}");
    let e: PqLeafConsumed = one_event(&sent);
    assert_eq!(
        (u32::from(e.leaf), e.launch, e.pq_identity),
        (s.q, k.launch, pq::identity_id()),
        "{what}"
    );
    assert_eq!(used_count(env), used + 1, "{what}");
    assert!(burned(env, s.q), "{what}");
    let after = env.account(&k.attestation);
    match before {
        Some(before) => assert_eq!(after, Some(before), "{what}: the attestation changed"),
        None => {
            // The first landing creates the account, empty: version 0,
            // launch zero, its bump set.
            let a: Attestation = env.anchor(&k.attestation);
            assert_eq!((a.version, a.launch), (0, Pubkey::default()), "{what}");
            assert_ne!(a.bump, 0, "{what}");
        }
    }
}

/// `s` lands and attests: `LaunchAttested` and no `PqLeafConsumed`, its leaf
/// burned, and the attestation account byte for byte what an attestation
/// of `s` writes (whatever was there before).
#[track_caller]
fn lands_and_attests(
    env: &mut Env,
    k: &Keys,
    s: &pq::Signed,
    meta: (&str, &str, &str),
    what: &str,
) -> LaunchAttested {
    let used = used_count(env);
    let sent = pq::send_attestation(env, k, s, meta).expect_ok(what);
    assert!(events::<PqLeafConsumed>(&sent.logs).is_empty(), "{what}");
    let e: LaunchAttested = one_event(&sent);
    let slot = env.svm.get_sysvar::<Clock>().slot;
    let metadata_hash = pq::metadata_hash(meta);
    assert_eq!(
        (
            e.launch,
            e.pq_identity,
            u32::from(e.leaf),
            e.metadata_hash,
            e.slot,
            e.not_before,
            e.not_after
        ),
        (
            k.launch,
            pq::identity_id(),
            s.q,
            metadata_hash,
            slot,
            s.terms.not_before,
            s.terms.not_after
        ),
        "{what}"
    );
    assert_eq!(used_count(env), used + 1, "{what}");
    assert!(burned(env, s.q), "{what}");
    let account = env.account(&k.attestation).expect("attestation");
    let expected = Attestation {
        version: Attestation::VERSION,
        bump: Pubkey::find_program_address(
            &[
                noised_launchpad::constants::ATTESTATION_SEED,
                k.launch.as_ref(),
            ],
            &noised_launchpad::ID,
        )
        .1,
        launch: k.launch,
        pq_identity: pq::identity_id(),
        leaf: e.leaf,
        metadata_hash,
        rules_hash: s.terms.rules_hash,
        message_hash: pq::sha256(&[&pq::message(env, k, meta, &s.terms)]),
        slot,
        not_before: s.terms.not_before,
        not_after: s.terms.not_after,
        signature: s.sig.clone(),
    };
    let mut bytes = Vec::new();
    expected.try_serialize(&mut bytes).unwrap();
    assert_eq!(
        (account.owner, account.data.len()),
        (noised_launchpad::ID, bytes.len()),
        "{what}"
    );
    assert!(
        account.data == bytes,
        "{what}: not exactly the attestation of this signature"
    );
    e
}

/// A keeper (no relation to the launch) runs `launch` with `mint`, as
/// anyone may inside the window, for the record `meta` names.
fn keeper_launch(
    env: &mut Env,
    k: &Keys,
    mint: &Keypair,
    meta: (&str, &str, &str),
) -> Result<Sent, Failed> {
    let keeper = env.funded(5);
    let kp = keeper.pubkey();
    let kx = Keys::new(&k.creator, k.seed, mint.pubkey());
    let ix = launch(&kp, &kx, meta.0, meta.1, meta.2);
    env.send_with(&kp, &[ix], &[&keeper, mint], true)
}

fn status(env: &Env, k: &Keys) -> LaunchStatus {
    env.anchor::<Launch>(&k.launch).status
}

/// F1, the audit's PoC: the attested window [t+10, t+70] passes without
/// `launch` (in the PoC, write-lock contention on the Launch PDA, its one
/// fixed writable account, keeps every `launch` out; LiteSVM has no cost
/// tracker, so here nothing is sent inside the window). The launch used to
/// stay Configured forever: every later signature only burned its leaf.
/// Now the identity's next attesting signature replaces the attestation,
/// whole: the account is byte for byte what an attestation of the new
/// signature writes, so nothing of the window that passed survives (not
/// even its record: the new signature names another one, the old record
/// cannot launch any more). The launch opens in the new window, which a
/// mint chosen at `launch` and the certificate record.
#[test]
fn f1_a_window_that_passed_unused_is_replaced_and_the_launch_opens_in_the_new_one() {
    let mut w = created_with(|_| {});
    let k = w.k;
    let mint = w.mint.insecure_clone();
    pq::publish(&mut w.env, &k, META);
    let t = w.env.now();
    let first = sign_next(
        &w.env,
        pq::identity(),
        &k,
        META,
        Terms::window(t + 10, t + 70),
    );
    lands_and_attests(&mut w.env, &k, &first, META, "the first attestation");
    let old: Attestation = w.env.anchor(&k.attestation);

    // The window passes: nobody launches any more.
    w.env.set_time(t + 71);
    for (m, what) in [
        (&mint, "a keeper, a second after the window"),
        (&Keypair::new(), "a keeper with another mint"),
    ] {
        keeper_launch(&mut w.env, &k, m, META).fails_with(
            code(E::NotLaunchWindow),
            "NotLaunchWindow",
            what,
        );
    }

    // The creator signs a new window over a new record.
    pq::publish(&mut w.env, &k, META2);
    let now = w.env.now();
    let terms = Terms::window(now + 30, now + 90);
    let second = sign_next(&w.env, pq::identity(), &k, META2, terms);
    let e = lands_and_attests(&mut w.env, &k, &second, META2, "the replacement");
    let new: Attestation = w.env.anchor(&k.attestation);
    assert!(
        new.leaf != old.leaf
            && new.metadata_hash != old.metadata_hash
            && new.message_hash != old.message_hash
            && new.slot != old.slot
            && new.not_before != old.not_before
            && new.not_after != old.not_after
            && new.signature != old.signature,
        "every field of the old attestation is gone"
    );
    // The same signature again: its leaf is used.
    pq::send_attestation(&mut w.env, &k, &second, META2).fails_with(
        code(E::PqLeafUsed),
        "PqLeafUsed",
        "the replacement again",
    );

    // Not before the new window; inside it, only with the new record.
    w.env.set_time(now + 29);
    keeper_launch(&mut w.env, &k, &mint, META2).fails_with(
        code(E::NotLaunchWindow),
        "NotLaunchWindow",
        "a second before the new window",
    );
    w.env.set_time(now + 30);
    keeper_launch(&mut w.env, &k, &mint, META).fails_with(
        CONSTRAINT_SEEDS,
        "ConstraintSeeds",
        "the old record",
    );
    keeper_launch(&mut w.env, &k, &mint, META2).expect_ok("a keeper, as the new window opens");
    assert_eq!(status(&w.env, &k), LaunchStatus::Live);
    let cert: Certificate = w.env.anchor(&k.certificate);
    assert_eq!(
        (
            cert.pq_identity,
            cert.pq_leaf,
            cert.attested_slot,
            cert.metadata,
            cert.launched_at
        ),
        (
            pq::identity_id(),
            e.leaf,
            e.slot,
            pq::token_meta_of(&k, META2),
            now + 30
        )
    );
}

/// F1, the late-landing variant: whoever holds the creator's signature over
/// [t+10, t+70] lands it, from its own fee payer, with less than a minute
/// of the window left (59 seconds here; at `not_after`, with none, in the
/// PoC). That used to record a window `launch` had no time to use, and the
/// launch was dead a second later. Now it only burns its leaf and the
/// attestation stays empty, as for a congested attestation of a window
/// ending as it lands. With exactly a minute left the window is recorded,
/// and `launch` still runs in its last second.
#[test]
fn f1_an_attestation_landing_with_less_than_a_minute_left_only_burns_its_leaf() {
    let mut w = created_with(|_| {});
    let k = w.k;
    let mint = w.mint.insecure_clone();
    pq::publish(&mut w.env, &k, META);
    let t = w.env.now();
    let held = sign_next(
        &w.env,
        pq::identity(),
        &k,
        META,
        Terms::window(t + 10, t + 70),
    );
    w.env.set_time(t + 11);
    lands_burn_only(&mut w.env, &k, &held, META, "59 seconds left");
    pq::send_attestation(&mut w.env, &k, &held, META).fails_with(
        code(E::PqLeafUsed),
        "PqLeafUsed",
        "the creator's rebroadcast",
    );
    let again = sign_next(
        &w.env,
        pq::identity(),
        &k,
        META,
        Terms::window(t + 10, t + 70),
    );
    assert_ne!(again.q, held.q, "another leaf for the same window");
    w.env.set_time(t + 70);
    lands_burn_only(&mut w.env, &k, &again, META, "at not_after: no time left");
    let now = w.env.now();
    let late = sign_next(
        &w.env,
        pq::identity(),
        &k,
        META,
        Terms::window(now - 60, now),
    );
    lands_burn_only(&mut w.env, &k, &late, META, "a window ending as it lands");
    let late = sign_next(
        &w.env,
        pq::identity(),
        &k,
        META,
        Terms::window(now - 31, now + 29),
    );
    lands_burn_only(
        &mut w.env,
        &k,
        &late,
        META,
        "half of a minute-long window left",
    );
    // Nothing was recorded: the empty attestation names no record.
    keeper_launch(&mut w.env, &k, &mint, META).fails_with(
        CONSTRAINT_SEEDS,
        "ConstraintSeeds",
        "a launch with nothing attested",
    );

    // Exactly a minute left (opened a second ago, 61 seconds long): recorded,
    // and `launch` runs in its last second.
    let now = w.env.now();
    let minute = sign_next(
        &w.env,
        pq::identity(),
        &k,
        META,
        Terms::window(now - 1, now + 60),
    );
    lands_and_attests(&mut w.env, &k, &minute, META, "exactly a minute left");
    w.env.set_time(now + 61);
    keeper_launch(&mut w.env, &k, &mint, META).fails_with(
        code(E::NotLaunchWindow),
        "NotLaunchWindow",
        "a second after that minute",
    );
}

/// F1: the minute an attestation leaves is usable: recorded with exactly a
/// minute left, the window still launches in its last second.
#[test]
fn f1_a_window_recorded_with_a_minute_left_launches_in_its_last_second() {
    let mut w = created_with(|_| {});
    let k = w.k;
    let mint = w.mint.insecure_clone();
    pq::publish(&mut w.env, &k, META);
    let now = w.env.now();
    let s = sign_next(
        &w.env,
        pq::identity(),
        &k,
        META,
        Terms::window(now - 3_540, now + 60),
    );
    lands_and_attests(&mut w.env, &k, &s, META, "an hour long, a minute left");
    w.env.set_time(now + 60);
    keeper_launch(&mut w.env, &k, &mint, META).expect_ok("the window's last second");
    assert_eq!(status(&w.env, &k), LaunchStatus::Live);
}

/// F1: an attestation whose window has not ended is never replaced, before
/// its window opens, inside it, or in its last second: a new valid
/// signature only burns its leaf and the account stays byte for byte as it
/// was. From the second after its end the next attesting signature replaces
/// it, and the launch opens in the new window.
#[test]
fn f1_an_attestation_whose_window_has_not_ended_is_never_replaced() {
    let mut w = created_with(|_| {});
    let k = w.k;
    let mint = w.mint.insecure_clone();
    pq::publish(&mut w.env, &k, META);
    let t = w.env.now();
    let first = sign_next(
        &w.env,
        pq::identity(),
        &k,
        META,
        Terms::window(t + 600, t + 660),
    );
    lands_and_attests(
        &mut w.env,
        &k,
        &first,
        META,
        "a window opening in ten minutes",
    );
    for (at, terms, what) in [
        (t, Terms::window(t + 30, t + 90), "before its window opens"),
        (
            t + 599,
            Terms::window(t + 599, t + 3_599),
            "a second before it opens",
        ),
        (
            t + 630,
            Terms::window(t + 630, t + 4_200),
            "inside its window",
        ),
        (
            t + 660,
            Terms::window(t + 660, t + 720),
            "in its last second",
        ),
    ] {
        w.env.set_time(at);
        let s = sign_next(&w.env, pq::identity(), &k, META, terms);
        lands_burn_only(&mut w.env, &k, &s, META, what);
    }
    w.env.set_time(t + 661);
    let s = sign_next(
        &w.env,
        pq::identity(),
        &k,
        META,
        Terms::window(t + 661, t + 721),
    );
    lands_and_attests(&mut w.env, &k, &s, META, "a second after its end");
    keeper_launch(&mut w.env, &k, &mint, META).expect_ok("a keeper, in the new window");
    assert_eq!(status(&w.env, &k), LaunchStatus::Live);
}

/// F1: a Live launch's attestation never changes, however long after its
/// window: the certificate keeps the attestation `launch` used, and every
/// new signature by its identity only burns its leaf.
#[test]
fn f1_a_live_launch_keeps_its_attestation_forever() {
    let mut w = launched();
    let k = w.k;
    let a: Attestation = w.env.anchor(&k.attestation);
    let certificate = w.env.account(&k.certificate);
    for (at, what) in [
        (a.not_after, "in its window's last second"),
        (a.not_after + 1, "a second after its window"),
        (a.not_after + 30 * 86_400, "a month later"),
    ] {
        w.env.set_time(at);
        let now = w.env.now();
        let s = sign_next(
            &w.env,
            pq::identity(),
            &k,
            META,
            Terms::window(now + 10, now + 70),
        );
        lands_burn_only(&mut w.env, &k, &s, META, what);
        assert_eq!(w.env.account(&k.certificate), certificate, "{what}");
    }
    assert_eq!(status(&w.env, &k), LaunchStatus::Live);
}

/// F1 end to end: a launch whose first two windows pass unused opens in its
/// third window, over another record, and runs its whole life from there
/// as any launch: commits (one paying a PQ vault), the snipe shield, the
/// batch, claims into an ATA and the vault's ATA, public trades during the
/// guard, the fees routed. Between the windows, only an attesting signature
/// replaces the expired attestation: one landing with 59 seconds left, one
/// by another identity and one naming a record nobody published only burn
/// their leaves and leave it as it was. From `launch` on, its attestation
/// and certificate never change.
#[test]
fn f1_a_launch_whose_windows_passed_runs_its_whole_lifecycle() {
    let mut w = created_with(|_| {});
    let k = w.k;
    let mint = w.mint.insecure_clone();
    pq::publish(&mut w.env, &k, META);
    let t = w.env.now();
    let first = sign_next(
        &w.env,
        pq::identity(),
        &k,
        META,
        Terms::window(t + 10, t + 70),
    );
    lands_and_attests(&mut w.env, &k, &first, META, "the first window");

    // The first window passes unused.
    w.env.set_time(t + 71);
    keeper_launch(&mut w.env, &k, &mint, META).fails_with(
        code(E::NotLaunchWindow),
        "NotLaunchWindow",
        "after the first window",
    );
    // A replacement leaving 59 seconds only burns its leaf: the expired
    // attestation stays, byte for byte, and still opens nothing.
    let now = w.env.now();
    let short = sign_next(
        &w.env,
        pq::identity(),
        &k,
        META,
        Terms::window(now - 1, now + 59),
    );
    lands_burn_only(&mut w.env, &k, &short, META, "a replacement, 59 s left");
    pq::send_attestation(&mut w.env, &k, &first, META).fails_with(
        code(E::PqLeafUsed),
        "PqLeafUsed",
        "the first signature again",
    );
    // Nor does another identity's signature replace it, or one naming a
    // record nobody published.
    let before = w.env.account(&k.attestation);
    let stranger = sign_next(
        &w.env,
        pq::other_identity(),
        &k,
        META,
        Terms::window(now + 30, now + 90),
    );
    let sent = pq::send_attestation(&mut w.env, &k, &stranger, META)
        .expect_ok("another identity's signature");
    assert!(events::<LaunchAttested>(&sent.logs).is_empty());
    let consumed: PqLeafConsumed = one_event(&sent);
    assert_eq!(
        consumed.pq_identity,
        pq::identity_id_of(&pq::public_key(pq::other_identity()))
    );
    assert_eq!(w.env.account(&k.attestation), before);
    let unpublished = sign_next(
        &w.env,
        pq::identity(),
        &k,
        META2,
        Terms::window(now + 30, now + 90),
    );
    lands_burn_only(
        &mut w.env,
        &k,
        &unpublished,
        META2,
        "a replacement naming no record",
    );
    // The second window, over the same record, passes unused too.
    let second = sign_next(
        &w.env,
        pq::identity(),
        &k,
        META,
        Terms::window(now + 30, now + 90),
    );
    lands_and_attests(&mut w.env, &k, &second, META, "the second window");
    w.env.set_time(now + 91);
    keeper_launch(&mut w.env, &k, &mint, META).fails_with(
        code(E::NotLaunchWindow),
        "NotLaunchWindow",
        "after the second window",
    );

    // The third window, over a new record, opens the launch.
    pq::publish(&mut w.env, &k, META2);
    let now = w.env.now();
    let third = sign_next(
        &w.env,
        pq::identity(),
        &k,
        META2,
        Terms::window(now, now + 600),
    );
    let e = lands_and_attests(&mut w.env, &k, &third, META2, "the third window");
    keeper_launch(&mut w.env, &k, &mint, META2).expect_ok("a keeper, in the third window");
    assert_eq!(status(&w.env, &k), LaunchStatus::Live);
    let cert: Certificate = w.env.anchor(&k.certificate);
    assert_eq!(
        (
            cert.pq_leaf,
            cert.attested_slot,
            cert.metadata,
            cert.launched_at
        ),
        (e.leaf, e.slot, pq::token_meta_of(&k, META2), now)
    );
    let attestation = w.env.account(&k.attestation);
    let certificate = w.env.account(&k.certificate);

    // The rest of its life, as any launch's.
    let env = &mut w.env;
    let payer = env.payer.pubkey();
    let l: Launch = env.anchor(&k.launch);
    assert_eq!(l.launch_ts, now);
    let alice = committer(env, 2 * LAMPORTS_PER_SOL);
    let a = alice.pubkey();
    env.send(&[commit(&a, &k, 2 * LAMPORTS_PER_SOL)], &[&alice])
        .expect_ok("alice commits");
    let carol = committer(env, 2 * LAMPORTS_PER_SOL);
    let c = carol.pubkey();
    let vault = open_vault(env, &carol, &k.mint, &TOKEN_2022_PROGRAM_ID, "f1-carol");
    env.send(
        &[commit_to(&c, &k, 2 * LAMPORTS_PER_SOL, &vault.address, &c)],
        &[&carol],
    )
    .expect_ok("carol commits, tokens to her vault");
    let mallory = buyer(env, &k);
    let m = mallory.pubkey();
    env.send(
        &[dbc_swap(&m, &k, true, LAMPORTS_PER_SOL / 100)],
        &[&mallory],
    )
    .fails_with(
        hook_code(HookError::SnipeShield),
        "SnipeShield",
        "a snipe during the commit window",
    );
    env.set_time(l.commit_end_ts);
    env.send(&[execute_batch(&payer, &k)], &[])
        .expect_ok("execute_batch");
    env.send(&[claim(&payer, &k, &a, true, true)], &[])
        .expect_ok("alice's claim");
    env.send(
        &[claim_for(&payer, &k, &c, (&vault.address, &c), true, true)],
        &[],
    )
    .expect_ok("carol's claim into her vault");
    let held = env.token_amount(&base_ata(&a, &k.mint));
    assert!(held > 0 && env.token_amount(&vault.token_account) == held);
    assert_escrow_invariants(env, &k);
    env.send(
        &[dbc_swap(&m, &k, true, LAMPORTS_PER_SOL / 200)],
        &[&mallory],
    )
    .expect_ok("a public buy during the guard");
    env.send(&[dbc_swap(&a, &k, false, held / 2)], &[&alice])
        .expect_ok("alice sells");
    env.send(&[claim_fees(&payer, &k)], &[])
        .expect_ok("claim_fees");
    env.send(&[distribute(&payer, &k, &w.treasury, &w.recipients)], &[])
        .expect_ok("distribute");
    assert!(env.token_amount(&wsol_ata(&w.treasury)) > 0);

    // A Live launch's attestation and certificate stay as `launch` left them.
    env.set_time(l.guard_end_ts);
    let now = env.now();
    let s = sign_next(
        env,
        pq::identity(),
        &k,
        META2,
        Terms::window(now + 10, now + 70),
    );
    lands_burn_only(env, &k, &s, META2, "a new window once Live");
    assert_eq!(env.account(&k.attestation), attestation);
    assert_eq!(env.account(&k.certificate), certificate);
}

/// A Token-2022 account of `mint` at a fresh address (not an ATA), owned
/// by `owner` and paid by `payer`, sized for the TransferHookAccount
/// extension a hooked mint needs. With `immutable_owner`, Token-2022's
/// ImmutableOwner extension is initialized first, as the ATA program does.
fn token_account(
    env: &mut Env,
    payer: &Keypair,
    mint: &Pubkey,
    owner: &Pubkey,
    immutable_owner: bool,
) -> Pubkey {
    let account = Keypair::new();
    let mut extensions = vec![ExtensionType::TransferHookAccount];
    if immutable_owner {
        extensions.push(ExtensionType::ImmutableOwner);
    }
    let space = ExtensionType::try_calculate_account_len::<TokenAccount>(&extensions).unwrap();
    let lamports = env.svm.minimum_balance_for_rent_exemption(space);
    let mut ixs = vec![system_instruction::create_account(
        &payer.pubkey(),
        &account.pubkey(),
        lamports,
        space as u64,
        &TOKEN_2022_PROGRAM_ID,
    )];
    if immutable_owner {
        ixs.push(
            spl_token_2022::instruction::initialize_immutable_owner(
                &TOKEN_2022_PROGRAM_ID,
                &account.pubkey(),
            )
            .unwrap(),
        );
    }
    ixs.push(
        spl_token_2022::instruction::initialize_account3(
            &TOKEN_2022_PROGRAM_ID,
            &account.pubkey(),
            mint,
            owner,
        )
        .unwrap(),
    );
    env.send(&ixs, &[payer, &account])
        .expect_ok("create a base-token account");
    account.pubkey()
}

/// Whether token `account` has Token-2022's ImmutableOwner extension, read
/// as Token-2022 reads it.
fn has_immutable_owner(env: &Env, account: &Pubkey) -> bool {
    let data = env.account(account).expect("token account").data;
    StateWithExtensions::<TokenAccount>::unpack(&data)
        .expect("token account")
        .get_extension::<ImmutableOwner>()
        .is_ok()
}

/// Token-2022 `SetAuthority(AccountOwner)` on `account`, signed by `owner`.
fn reassign_owner(account: &Pubkey, owner: &Pubkey, new_owner: &Pubkey) -> Instruction {
    spl_token_2022::instruction::set_authority(
        &TOKEN_2022_PROGRAM_ID,
        account,
        Some(new_owner),
        AuthorityType::AccountOwner,
        owner,
        &[],
    )
    .unwrap()
}

/// Token-2022 `transfer_checked` of the base token from any `source` to any
/// `destination`, signed by `authority`, with the hook's accounts.
fn transfer_between(
    k: &Keys,
    source: &Pubkey,
    authority: &Pubkey,
    destination: &Pubkey,
    amount: u64,
) -> Instruction {
    let mut ix = spl_token_2022::instruction::transfer_checked(
        &TOKEN_2022_PROGRAM_ID,
        source,
        &k.mint,
        destination,
        authority,
        &[],
        amount,
        6,
    )
    .unwrap();
    ix.accounts.extend([
        AccountMeta::new_readonly(k.policy, false),
        AccountMeta::new_readonly(noised_hook::INSTRUCTIONS_SYSVAR_ID, false),
        AccountMeta::new_readonly(noised_hook::ID, false),
        AccountMeta::new_readonly(k.meta_list, false),
    ]);
    ix
}

/// A DBC exact-in sell of `amount` base tokens from any account `input` of
/// `seller`, paid to the seller's wSOL ATA: `dbc_buy_into` with its input
/// and output token accounts swapped (DBC trades from the input account's
/// mint to the other).
fn dbc_sell_from(seller: &Pubkey, k: &Keys, input: Pubkey, amount: u64) -> Instruction {
    let mut ix = dbc_buy_into(seller, k, input, amount);
    let at = |key: Pubkey| ix.accounts.iter().position(|m| m.pubkey == key).unwrap();
    let (i, o) = (at(wsol_ata(seller)), at(input));
    ix.accounts.swap(i, o);
    ix
}

/// Move `amount` base units from `from` to `to` in the ledger: test setup
/// only (no transfer can fill an account without ImmutableOwner during the
/// guard). The supply is unchanged.
fn move_in_ledger(env: &mut Env, from: &Pubkey, to: &Pubkey, amount: u64) {
    for (key, take) in [(from, true), (to, false)] {
        let mut account = env.account(key).expect("token account");
        let mut raw = [0u8; 8];
        raw.copy_from_slice(&account.data[64..72]);
        let balance = u64::from_le_bytes(raw);
        let balance = if take {
            balance - amount
        } else {
            balance + amount
        };
        account.data[64..72].copy_from_slice(&balance.to_le_bytes());
        env.svm.set_account(*key, account).unwrap();
    }
}

/// A launch with the p2p lock on and a 72 h guard whose batch has executed
/// (public buys are open, the guard runs): one committer naming a PQ vault
/// of the base mint as its token owner, one naming itself, both claimed
/// during the guard. Before the batch, a buy into an account without
/// ImmutableOwner meets the snipe shield first. Returns the world, the vault
/// and the second committer.
fn guarded_after_the_batch() -> (World, TestVault, Keypair) {
    let mut w = launched_with(|p| {
        p.p2p_locked = true;
        p.guard_secs = 72 * 3_600;
    });
    let k = w.k;
    let env = &mut w.env;
    let payer = env.payer.pubkey();
    let carol = committer(env, 2 * LAMPORTS_PER_SOL);
    let c = carol.pubkey();
    let vault = open_vault(env, &carol, &k.mint, &TOKEN_2022_PROGRAM_ID, "carol-tokens");
    env.send(
        &[commit_to(&c, &k, 2 * LAMPORTS_PER_SOL, &vault.address, &c)],
        &[&carol],
    )
    .expect_ok("commit, tokens to carol's vault");
    let dan = committer(env, 2 * LAMPORTS_PER_SOL);
    let d = dan.pubkey();
    env.send(&[commit(&d, &k, 2 * LAMPORTS_PER_SOL)], &[&dan])
        .expect_ok("commit");
    // During the snipe shield the shield decides a buy first, into an
    // account without ImmutableOwner too.
    let eve = committer(env, LAMPORTS_PER_SOL);
    let e = eve.pubkey();
    let early = token_account(env, &eve, &k.mint, &e, false);
    env.send(
        &[dbc_buy_into(&e, &k, early, LAMPORTS_PER_SOL / 100)],
        &[&eve],
    )
    .fails_with(
        hook_code(HookError::SnipeShield),
        "SnipeShield",
        "a buy into a plain account during the shield",
    );
    let l: Launch = env.anchor(&k.launch);
    env.set_time(l.commit_end_ts);
    let sent = env
        .send(&[execute_batch(&payer, &k)], &[])
        .expect_ok("execute_batch");
    assert!(invoked(&sent.logs, &noised_hook::ID), "the batch buy");
    let policy: HookPolicy = env.anchor(&k.policy);
    assert!(policy.p2p_locked);
    assert!(env.now() >= policy.snipe_shield_end_ts && env.now() < policy.guard_end_ts);
    env.send(
        &[claim_for(&payer, &k, &c, (&vault.address, &c), true, true)],
        &[],
    )
    .expect_ok("claim into a PQ vault's ATA during the guard");
    env.send(&[claim(&payer, &k, &d, true, true)], &[])
        .expect_ok("claim into the committer's ATA during the guard");
    assert!(env.token_amount(&vault.token_account) > 0);
    assert!(env.token_amount(&base_ata(&d, &k.mint)) > 0);
    (w, vault, dan)
}

/// F2, the audit's PoC (p2p lock on, a 72 h guard, the batch executed, so
/// public buys are open): a buyer opens a token account without
/// ImmutableOwner, buys into it, then hands it with its tokens to another
/// wallet (`SetAuthority(AccountOwner)`): no transfer, so no hook, past the
/// p2p lock and max_wallet. Now that buy is refused (`MutableOwner`),
/// whatever its size, and so is every other transfer that moves tokens into
/// such an account while the guard is on (a wallet transfer, a PQ vault's
/// `release_to`), ahead of the lock and the caps; a buy that moves nothing
/// passes as before. What the launch's own flows pay into has ImmutableOwner
/// (every Token-2022 ATA: the batch escrow, claimed ATAs, a PQ vault's ATA,
/// a buyer's ATA) or belongs to an exempt launchpad PDA, and keeps working;
/// sells, from any account, never depend on it; and from the guard's end
/// everything flows again.
#[test]
fn f2_buys_and_transfers_need_an_immutable_owner_while_the_guard_is_on() {
    let (mut w, vault, dan) = guarded_after_the_batch();
    let k = w.k;
    let env = &mut w.env;
    let policy: HookPolicy = env.anchor(&k.policy);
    let sybil = committer(env, LAMPORTS_PER_SOL);
    let s = sybil.pubkey();
    let receiver = committer(env, LAMPORTS_PER_SOL);
    let r = receiver.pubkey();
    for (owner, who) in [(&s, &sybil), (&r, &receiver)] {
        env.send(
            &[create_ata(owner, owner, &k.mint, &TOKEN_2022_PROGRAM_ID)],
            &[who],
        )
        .expect_ok("base ATA");
    }
    let plain = token_account(env, &sybil, &k.mint, &s, false);
    let fixed = token_account(env, &sybil, &k.mint, &s, true);
    let exempt = token_account(env, &sybil, &k.mint, &k.batch_authority, false);
    for (what, account, immutable) in [
        (
            "the batch escrow",
            base_ata(&k.batch_authority, &k.mint),
            true,
        ),
        ("dan's claimed ATA", base_ata(&dan.pubkey(), &k.mint), true),
        ("carol's vault's ATA", vault.token_account, true),
        ("a buyer's ATA", base_ata(&s, &k.mint), true),
        ("an account opened with ImmutableOwner", fixed, true),
        ("a plain account", plain, false),
        ("a plain account of the batch authority", exempt, false),
        ("DBC's base vault", k.base_vault, false),
    ] {
        assert_eq!(has_immutable_owner(env, &account), immutable, "{what}");
    }

    // The PoC's first step: the buy into the plain account is refused by
    // the hook; nothing reaches it.
    let buy = LAMPORTS_PER_SOL / 100;
    let f = env
        .send(&[dbc_buy_into(&s, &k, plain, buy)], &[&sybil])
        .fails_with(
            hook_code(HookError::MutableOwner),
            "MutableOwner",
            "a buy into a plain account during the guard",
        );
    assert!(invoked(&f.logs, &noised_hook::ID));
    assert_eq!(env.token_amount(&plain), 0);
    // Ahead of the caps: a buy over max_buy into it is refused for its
    // account too; into the buyer's ATA the cap refuses it.
    let big = LAMPORTS_PER_SOL / 2;
    for (what, into, refusal, name) in [
        (
            "over max_buy, into a plain account",
            plain,
            HookError::MutableOwner,
            "MutableOwner",
        ),
        (
            "over max_buy, into the buyer's ATA",
            base_ata(&s, &k.mint),
            HookError::MaxBuy,
            "MaxBuy",
        ),
    ] {
        env.send(&[dbc_buy_into(&s, &k, into, big)], &[&sybil])
            .fails_with(hook_code(refusal), name, what);
    }
    // A buy whose output rounds to nothing (1 lamport, all fee) moves no
    // token: Token-2022 calls the hook with 0, which passes as before.
    let sent = env
        .send(&[dbc_buy_into(&s, &k, plain, 1)], &[&sybil])
        .expect_ok("a zero-output buy into a plain account");
    assert!(invoked(&sent.logs, &noised_hook::ID));
    assert_eq!(env.token_amount(&plain), 0);

    // Into the buyer's ATA, or an account opened with ImmutableOwner, the
    // same buy passes, and that account can never change owner.
    for (what, into) in [
        ("a buy into the buyer's ATA", base_ata(&s, &k.mint)),
        ("a buy into an account with ImmutableOwner", fixed),
    ] {
        let sent = env
            .send(&[dbc_buy_into(&s, &k, into, buy)], &[&sybil])
            .expect_ok(what);
        println!(
            "{what}: {} CU ({} in the hook)",
            sent.cu,
            program_cu(&sent.logs, &noised_hook::ID, None)
        );
        assert!(env.token_amount(&into) > 0, "{what}");
        let f = env
            .send(&[reassign_owner(&into, &s, &r)], &[&sybil])
            .err()
            .expect("reassigning an ImmutableOwner account");
        assert_eq!(
            f.custom_code(),
            Some(TokenError::ImmutableOwner as u32),
            "{what}: {:?}",
            f.err
        );
        assert_eq!(env.token_owner(&into), s);
    }
    // An exempt launchpad PDA's account receives as before: only the
    // launchpad could sign for its owner, and it never does.
    env.send(&[dbc_buy_into(&s, &k, exempt, buy)], &[&sybil])
        .expect_ok("a buy into an account the batch authority owns");

    // The empty plain account can still be handed over (Token-2022 allows
    // it), but it carries nothing, and nothing can fill it during the guard.
    env.send(&[reassign_owner(&plain, &s, &r)], &[&sybil])
        .expect_ok("reassigning the empty plain account");
    assert_eq!(env.token_owner(&plain), r);
    env.send(&[dbc_buy_into(&r, &k, plain, buy)], &[&receiver])
        .fails_with(
            hook_code(HookError::MutableOwner),
            "MutableOwner",
            "the new owner's buy into it",
        );

    // Wallet transfers: the lock as before; into a plain account the
    // immutable-owner rule refuses first.
    let from = base_ata(&s, &k.mint);
    env.send(
        &[transfer_between(&k, &from, &s, &base_ata(&r, &k.mint), 1)],
        &[&sybil],
    )
    .fails_with(
        hook_code(HookError::TransfersLocked),
        "TransfersLocked",
        "p2p into an ATA",
    );
    env.send(&[transfer_between(&k, &from, &s, &plain, 1)], &[&sybil])
        .fails_with(
            hook_code(HookError::MutableOwner),
            "MutableOwner",
            "p2p into a plain account",
        );
    // A PQ vault's payouts are wallet transfers too: carol's vault pays the
    // receiver; into an account of its choice without ImmutableOwner
    // (`release_to`) the immutable-owner rule refuses it first, into its ATA
    // (`release`) the lock does, until the guard ends.
    let payer = env.payer.pubkey();
    let relayer = env.funded(1);
    let rl = relayer.pubkey();
    let mut carols = vault.clone();
    let q = withdraw(env, &relayer, &mut carols, &r, 1_000);
    env.send(
        &[carols.release_to_ix(q, &rl, &r, &plain, k.hook_metas())],
        &[&receiver],
    )
    .fails_with(
        hook_code(HookError::MutableOwner),
        "MutableOwner",
        "a vault's release_to into a plain account",
    );
    env.send(
        &[carols.release_ix(&payer, q, &rl, &r, k.hook_metas())],
        &[],
    )
    .fails_with(
        hook_code(HookError::TransfersLocked),
        "TransfersLocked",
        "a vault's release into the receiver's ATA",
    );

    // Sells never depend on it: a plain account holding tokens sells into
    // the pool during the guard.
    let own = token_account(env, &sybil, &k.mint, &s, false);
    let held = env.token_amount(&from) / 2;
    move_in_ledger(env, &from, &own, held);
    let wsol = env.token_amount(&wsol_ata(&s));
    env.send(&[dbc_sell_from(&s, &k, own, held)], &[&sybil])
        .expect_ok("a sell from a plain account during the guard");
    assert_eq!(env.token_amount(&own), 0);
    assert!(env.token_amount(&wsol_ata(&s)) > wsol);
    assert!(env.now() < policy.guard_end_ts);

    // From the guard's end everything flows again, into any account.
    env.set_time(policy.guard_end_ts - 1);
    env.send(&[dbc_buy_into(&r, &k, plain, buy)], &[&receiver])
        .fails_with(
            hook_code(HookError::MutableOwner),
            "MutableOwner",
            "the guard's last second",
        );
    env.set_time(policy.guard_end_ts);
    env.send(&[dbc_buy_into(&r, &k, plain, buy)], &[&receiver])
        .expect_ok("a buy into the plain account at the guard's end");
    env.send(&[transfer_between(&k, &from, &s, &plain, 1)], &[&sybil])
        .expect_ok("p2p into the plain account at the guard's end");
    let before = env.token_amount(&plain);
    assert!(before > 1);
    env.send(
        &[carols.release_to_ix(q, &rl, &r, &plain, k.hook_metas())],
        &[&receiver],
    )
    .expect_ok("the vault's release_to into the plain account at the guard's end");
    assert_eq!(env.token_amount(&plain), before + 1_000);
}

/// F2 without the p2p lock: wallet-to-wallet transfers pass into an ATA
/// during the guard, and into an account without ImmutableOwner they are
/// refused (`MutableOwner`) until the guard ends.
#[test]
fn f2_without_the_lock_transfers_still_need_an_immutable_owner() {
    let mut w = launched_with(|p| p.p2p_locked = false);
    let k = w.k;
    let env = &mut w.env;
    let policy: HookPolicy = env.anchor(&k.policy);
    assert!(!policy.p2p_locked);
    // The shield's scheduled end (no batch here), well inside the guard.
    env.set_time(policy.snipe_shield_end_ts);
    let alice = buyer(env, &k);
    let bob = buyer(env, &k);
    let (a, b) = (alice.pubkey(), bob.pubkey());
    env.send(&[dbc_swap(&a, &k, true, LAMPORTS_PER_SOL / 100)], &[&alice])
        .expect_ok("alice buys into her ATA");
    let from = base_ata(&a, &k.mint);
    let bob_plain = token_account(env, &bob, &k.mint, &b, false);
    let alice_plain = token_account(env, &alice, &k.mint, &a, false);
    env.send(
        &[transfer_between(&k, &from, &a, &base_ata(&b, &k.mint), 10)],
        &[&alice],
    )
    .expect_ok("p2p into bob's ATA, lock off");
    for (what, to) in [
        ("p2p into bob's plain account", bob_plain),
        ("into alice's own plain account", alice_plain),
    ] {
        env.send(&[transfer_between(&k, &from, &a, &to, 10)], &[&alice])
            .fails_with(hook_code(HookError::MutableOwner), "MutableOwner", what);
    }
    env.set_time(policy.guard_end_ts);
    env.send(
        &[transfer_between(&k, &from, &a, &bob_plain, 10)],
        &[&alice],
    )
    .expect_ok("p2p into bob's plain account at the guard's end");
    assert_eq!(env.token_amount(&bob_plain), 10);
}

/// Vault `v`'s signed withdrawal of up to `max_amount` to wallet `to`,
/// relayed by `relayer` in a v1 transaction (its signature is 2,176 bytes):
/// the payout's sequence; `v` moves to its next key.
fn withdraw(
    env: &mut Env,
    relayer: &Keypair,
    v: &mut TestVault,
    to: &Pubkey,
    max_amount: u64,
) -> u32 {
    let ix = v.withdraw_ix(&relayer.pubkey(), to, max_amount);
    let config = v1::TransactionConfig::empty()
        .with_compute_unit_limit(400_000)
        .with_loaded_accounts_data_size_limit(4 * 1024 * 1024);
    env.send_v1(relayer, &[ix], &[], config)
        .expect_ok("the vault's signed withdrawal");
    v.sequence += 1;
    v.sequence - 1
}

/// F2 and the launch's own payouts (p2p lock off, a 72 h guard): the batch
/// buys into its escrow, an ATA of the exempt batch authority. A claim pays
/// only the canonical ATA of the commit's token owner (created by the claim
/// if missing; a PQ vault's own ATA), which always has ImmutableOwner: there
/// is no `claim_to`, and naming any other account is the launchpad's own
/// refusal (`InvalidRecipientAccounts`), during the guard and after it,
/// whatever the account's extensions. The one payout into an account of the
/// recipient's choice, a PQ vault's `release_to`, is refused
/// (`MutableOwner`) into an account without ImmutableOwner until the guard's
/// last second and goes through at its end; into an account with
/// ImmutableOwner, as `release` into the recipient's ATA, it passes during
/// the guard.
#[test]
fn f2_launch_payouts_land_only_where_the_owner_cannot_change() {
    let mut w = launched_with(|p| {
        p.p2p_locked = false;
        p.guard_secs = 72 * 3_600;
    });
    let k = w.k;
    let env = &mut w.env;
    let payer = env.payer.pubkey();
    let alice = committer(env, 2 * LAMPORTS_PER_SOL);
    let a = alice.pubkey();
    let mut vault = open_vault(env, &alice, &k.mint, &TOKEN_2022_PROGRAM_ID, "f2-alice");
    env.send(
        &[commit_to(&a, &k, 2 * LAMPORTS_PER_SOL, &vault.address, &a)],
        &[&alice],
    )
    .expect_ok("alice commits, tokens to her vault");
    let (bob, erin) = (
        committer(env, 2 * LAMPORTS_PER_SOL),
        committer(env, LAMPORTS_PER_SOL),
    );
    let (b, e) = (bob.pubkey(), erin.pubkey());
    env.send(&[commit(&b, &k, 2 * LAMPORTS_PER_SOL)], &[&bob])
        .expect_ok("bob commits");
    env.send(&[commit(&e, &k, LAMPORTS_PER_SOL)], &[&erin])
        .expect_ok("erin commits");
    let l: Launch = env.anchor(&k.launch);
    env.set_time(l.commit_end_ts);
    let escrow = base_ata(&k.batch_authority, &k.mint);
    let sent = env
        .send(&[execute_batch(&payer, &k)], &[])
        .expect_ok("execute_batch, into the escrow");
    assert!(invoked(&sent.logs, &noised_hook::ID));
    let l: Launch = env.anchor(&k.launch);
    assert!(l.tokens_out > 0 && env.token_amount(&escrow) == l.tokens_out);
    assert!(has_immutable_owner(env, &escrow));
    let policy: HookPolicy = env.anchor(&k.policy);
    assert!(!policy.p2p_locked && env.now() < policy.guard_end_ts);

    // Claims: only the canonical ATA, whatever another account has.
    let bob_plain = token_account(env, &bob, &k.mint, &b, false);
    let bob_fixed = token_account(env, &bob, &k.mint, &b, true);
    let erin_plain = token_account(env, &erin, &k.mint, &e, false);
    for (what, owner, into) in [
        ("bob's claim into a plain account", b, bob_plain),
        (
            "bob's claim into an account with ImmutableOwner",
            b,
            bob_fixed,
        ),
        ("erin's claim into a plain account", e, erin_plain),
    ] {
        env.send(
            &[claim_into(
                &payer,
                &k,
                &owner,
                Some(wsol_ata(&owner)),
                Some(into),
                true,
            )],
            &[],
        )
        .fails_with(
            code(E::InvalidRecipientAccounts),
            "InvalidRecipientAccounts",
            what,
        );
    }
    assert!(env.account(&base_ata(&b, &k.mint)).is_none());
    env.send(&[claim(&payer, &k, &b, true, true)], &[])
        .expect_ok("bob's claim, into the ATA it creates");
    assert!(has_immutable_owner(env, &base_ata(&b, &k.mint)));
    env.send(
        &[claim_for(&payer, &k, &a, (&vault.address, &a), true, true)],
        &[],
    )
    .expect_ok("alice's claim, into her vault's ATA");
    assert!(has_immutable_owner(env, &vault.token_account));
    assert!(env.token_amount(&vault.token_account) > 0);

    // Out of alice's vault, to alice: each payout is a transfer the hook
    // checks (here a small one, within the caps).
    let relayer = env.funded(1);
    let rl = relayer.pubkey();
    let alice_plain = token_account(env, &alice, &k.mint, &a, false);
    let alice_fixed = token_account(env, &alice, &k.mint, &a, true);
    let q = withdraw(env, &relayer, &mut vault, &a, 1_000);
    env.send(
        &[vault.release_to_ix(q, &rl, &a, &alice_plain, k.hook_metas())],
        &[&alice],
    )
    .fails_with(
        hook_code(HookError::MutableOwner),
        "MutableOwner",
        "release_to into a plain account",
    );
    env.send(
        &[vault.release_to_ix(q, &rl, &a, &alice_fixed, k.hook_metas())],
        &[&alice],
    )
    .expect_ok("release_to into an account with ImmutableOwner");
    let q = withdraw(env, &relayer, &mut vault, &a, 1_000);
    env.send(&[vault.release_ix(&payer, q, &rl, &a, k.hook_metas())], &[])
        .expect_ok("release into alice's ATA, created by it");
    assert!(has_immutable_owner(env, &base_ata(&a, &k.mint)));
    assert_eq!(
        (
            env.token_amount(&alice_fixed),
            env.token_amount(&base_ata(&a, &k.mint))
        ),
        (1_000, 1_000)
    );
    let q = withdraw(env, &relayer, &mut vault, &a, 1_000);
    env.set_time(policy.guard_end_ts - 1);
    env.send(
        &[vault.release_to_ix(q, &rl, &a, &alice_plain, k.hook_metas())],
        &[&alice],
    )
    .fails_with(
        hook_code(HookError::MutableOwner),
        "MutableOwner",
        "release_to into a plain account, the guard's last second",
    );

    // From the guard's end: release_to into any account. Claims still pay
    // only the canonical ATA.
    env.set_time(policy.guard_end_ts);
    env.send(
        &[vault.release_to_ix(q, &rl, &a, &alice_plain, k.hook_metas())],
        &[&alice],
    )
    .expect_ok("release_to into a plain account at the guard's end");
    assert_eq!(env.token_amount(&alice_plain), 1_000);
    env.send(
        &[claim_into(
            &payer,
            &k,
            &e,
            Some(wsol_ata(&e)),
            Some(erin_plain),
            true,
        )],
        &[],
    )
    .fails_with(
        code(E::InvalidRecipientAccounts),
        "InvalidRecipientAccounts",
        "erin's claim into a plain account after the guard",
    );
    env.send(&[claim(&payer, &k, &e, true, true)], &[])
        .expect_ok("erin's claim after the guard");
    assert!(env.token_amount(&base_ata(&e, &k.mint)) > 0);
    assert_escrow_invariants(env, &k);
}

/// F2's compute (printed as `[cu]` lines for the report, and run on the
/// pre-audit-3 builds too: nothing here depends on the fix): the whole
/// transaction and the hook's part of it, for each kind of transfer of a
/// guarded launch (p2p lock on, a 72 h guard). The hook now also reads the
/// destination's extensions on everything it does not decide from keys
/// alone: buys, claims, the batch buy; a sell is still decided from its
/// keys, and after the guard nothing is read.
#[test]
fn f2_hook_compute_on_buys_and_sells() {
    fn report(what: &str, sent: &Sent, depth: Option<usize>) {
        println!(
            "[cu] {what}: {} CU in the transaction, {} in the hook",
            sent.cu,
            program_cu(&sent.logs, &noised_hook::ID, depth)
        );
    }
    let mut w = launched_with(|p| {
        p.p2p_locked = true;
        p.guard_secs = 72 * 3_600;
    });
    let k = w.k;
    let env = &mut w.env;
    let payer = env.payer.pubkey();
    let alice = committer(env, 2 * LAMPORTS_PER_SOL);
    let a = alice.pubkey();
    env.send(&[commit(&a, &k, 2 * LAMPORTS_PER_SOL)], &[&alice])
        .expect_ok("alice commits");
    let l: Launch = env.anchor(&k.launch);
    env.set_time(l.commit_end_ts);
    let sent = env
        .send(&[execute_batch(&payer, &k)], &[])
        .expect_ok("execute_batch");
    // The hook checks the batch buy (a CPI of DBC's, depth 4) and ends the
    // shield (depth 2).
    report("execute_batch, the batch buy's check", &sent, Some(4));
    report("execute_batch, ending the shield", &sent, Some(2));
    let sent = env
        .send(&[claim(&payer, &k, &a, true, true)], &[])
        .expect_ok("claim");
    report("claim into a new ATA", &sent, None);
    let bob = buyer(env, &k);
    let b = bob.pubkey();
    let buy = LAMPORTS_PER_SOL / 200;
    let sent = env
        .send(&[dbc_swap(&b, &k, true, buy)], &[&bob])
        .expect_ok("a public buy");
    report("public buy into an ATA", &sent, None);
    let sent = env
        .send(&[dbc_swap(&b, &k, true, buy)], &[&bob])
        .expect_ok("another public buy");
    report("second public buy into the same ATA", &sent, None);
    let held = env.token_amount(&base_ata(&b, &k.mint));
    let sent = env
        .send(&[dbc_swap(&b, &k, false, held / 2)], &[&bob])
        .expect_ok("a sell");
    report("sell from an ATA", &sent, None);
    let sent = env
        .send(&[dbc_swap(&a, &k, false, held / 2)], &[&alice])
        .expect_ok("a sell of claimed tokens");
    report("sell from a claimed ATA", &sent, None);
    let policy: HookPolicy = env.anchor(&k.policy);
    env.set_time(policy.guard_end_ts);
    let sent = env
        .send(&[dbc_swap(&b, &k, true, buy)], &[&bob])
        .expect_ok("a buy after the guard");
    report("public buy after the guard", &sent, None);
}

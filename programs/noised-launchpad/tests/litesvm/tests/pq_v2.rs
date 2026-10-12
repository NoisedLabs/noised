//! PQ v2 on-chain, against our SBF builds and the mainnet DBC, Token-2022,
//! SPL Token and ATA programs:
//!
//! * every launch names its creator's post-quantum (LMS) identity in its
//!   parameters (A3), and its address names its creator; it goes live only
//!   once that identity signed the launch's configuration, the hash of its
//!   on-chain metadata record and a launch window, verified on-chain by
//!   `attest_launch` in a v1 transaction (A4-A6), and only inside that
//!   window, where anyone may launch it, with that record's metadata;
//! * a leaf signs once: the identity's on-chain bitmap refuses a landed
//!   leaf, and any valid signature lands, to burn its leaf, whatever it
//!   signed (other metadata, a window that cannot open, another identity);
//!   a client picks its leaf from the message, so two messages for one
//!   launch do not share a leaf (A5, A13 and the review's fixes);
//! * a launch naming somebody else's identity never goes live, even with
//!   that identity's stored signatures in hand (A4-A6);
//! * batch payouts go only to owners fixed at the first commit, the
//!   committer or its PQ vaults, whoever cranks the claim, and a vault takes
//!   at most one wallet's cap however many commits name it (A7);
//! * the treasury is a PQ vault of wSOL (A8), and creator fees can go to
//!   such vaults too (§1.4c);
//! * buys on DBC and, after graduation, on DAMM v2 can land straight in the
//!   buyer's PQ vault, under the Launch Guard's caps while it runs (A15).
//!
//! How to build and run: see `src/lib.rs`.

mod common;

use anchor_lang::{solana_program::system_instruction, AccountSerialize, AnchorSerialize};
use common::{
    launch::*,
    lifecycle::{damm_buy_into, migrate_to_damm_v2},
    pq::{self, Terms},
    vault::*,
    world::*,
    *,
};
use noised_hook::{state::HookPolicy, HookError};
use noised_launchpad::{
    constants::*,
    dynamic_bonding_curve::accounts::TransferHookPool,
    error::LaunchpadError as E,
    events::{BatchClaimed, Committed, LaunchAttested, LaunchCreated, Launched, PqLeafConsumed},
    state::{
        checks, Attestation, Certificate, Commit, CurvePoint, FeeRecipient, Identity, Launch,
        LaunchStatus, PayoutVault, Protocol,
    },
};
use noised_lmots::{LmsKeyPair, LMS_SIG_LEN};
use solana_account::Account;
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_instruction::AccountMeta;
use solana_keypair::Keypair;
use solana_signer::Signer;

/// A launch of the test creator created (not attested) under `seed`, in the
/// world's ledger.
fn create_another(w: &mut World, seed: [u8; 32]) -> (Keys, Keypair) {
    let mint = Keypair::new();
    let c = w.creator.pubkey();
    let k = Keys::new(&c, seed, mint.pubkey());
    let p = w.params.clone();
    w.env
        .send(&[create_launch(&c, &k, p)], &[&w.creator])
        .expect_ok("create_launch");
    (k, mint)
}

fn launch_now(w: &mut World, k: &Keys, mint: &Keypair, meta: (&str, &str, &str)) -> Sent {
    let c = w.creator.pubkey();
    w.env
        .send(
            &[launch(&c, k, meta.0, meta.1, meta.2)],
            &[&w.creator, mint],
        )
        .expect_ok("launch")
}

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

/// A3: the largest `create_launch` (8 curve points, 4 recipients, a dynamic
/// fee, the post-quantum identity, both compute-budget instructions) is a
/// legacy transaction every wallet can sign. An all-zero identity is
/// refused, and `params_hash` covers the identity.
#[test]
fn a3_the_largest_create_launch_fits_a_legacy_transaction() {
    let mut w = created_with(|_| {});
    let creator = w.creator.insecure_clone();
    let c = creator.pubkey();
    let mut p = w.params.clone();
    let start = p.sqrt_start_price;
    let main = p.curve[0];
    p.curve = (1..=7u128)
        .map(|i| CurvePoint {
            sqrt_price: start + start * i / 16,
            liquidity: main.liquidity,
        })
        .chain([main])
        .collect();
    assert_eq!(p.curve.len(), MAX_CURVE_POINTS);
    p.dynamic_fee = Some(max_dynamic_fee());
    p.recipients = [4_000, 3_000, 2_000, 1_000]
        .into_iter()
        .map(|bps| FeeRecipient {
            wallet: Keypair::new().pubkey(),
            bps,
        })
        .collect();
    assert_eq!(p.recipients.len(), MAX_RECIPIENTS);
    let k = Keys::new(&c, [0xA3; 32], Keypair::new().pubkey());
    let price = ComputeBudgetInstruction::set_compute_unit_price(1_000);

    let mut zero = p.clone();
    zero.pq_identity = [0; 32];
    w.env
        .send_with(
            &c,
            &[price.clone(), create_launch(&c, &k, zero)],
            &[&creator],
            true,
        )
        .fails_with(
            code(E::InvalidPqIdentity),
            "InvalidPqIdentity",
            "a launch naming no identity",
        );
    let sent = w
        .env
        .send_with(
            &c,
            &[price.clone(), create_launch(&c, &k, p.clone())],
            &[&creator],
            true,
        )
        .expect_ok("the largest create_launch");
    println!(
        "largest create_launch, paid by the creator: {} CU, {} bytes (limit {PACKET_DATA_SIZE})",
        sent.cu, sent.size
    );
    assert!(sent.size <= PACKET_DATA_SIZE);
    // The worst case: another account pays the fees (one more signature and
    // key in the transaction).
    let sponsored = Keys::new(&c, [0xA4; 32], Keypair::new().pubkey());
    let payer = w.env.payer.pubkey();
    let sponsored_sent = w
        .env
        .send_with(
            &payer,
            &[price, create_launch(&c, &sponsored, p.clone())],
            &[&creator],
            true,
        )
        .expect_ok("the largest create_launch, paid by another account");
    println!(
        "largest create_launch, paid by another account: {} CU, {} bytes (limit {PACKET_DATA_SIZE})",
        sponsored_sent.cu, sponsored_sent.size
    );
    assert!(sponsored_sent.size <= PACKET_DATA_SIZE);

    let l: Launch = w.env.anchor(&k.launch);
    let mut encoded = Vec::new();
    p.serialize(&mut encoded).unwrap();
    assert_eq!(
        l.params_hash,
        solana_sha256_hasher::hash(&encoded).to_bytes()
    );
    assert_eq!(
        (l.version, l.pq_identity, l.creator),
        (Launch::VERSION, pq::identity_id(), c)
    );
    let e: LaunchCreated = one_event(&sent);
    assert_eq!(
        (e.launch, e.params_hash, e.pq_identity),
        (k.launch, l.params_hash, l.pq_identity)
    );
}

/// The review's info finding on squatting: a launch's address is
/// `["launch", creator, seed]`, so another creator using the same seed gets
/// another address and cannot take the one a creator's pending
/// `create_launch` (and a signature it is about to make) is meant for; an
/// account passed at another creator's address is refused.
#[test]
fn a_launch_address_names_its_creator() {
    let mut w = created_with(|_| {});
    let k = w.k;
    let mallory = w.env.funded(20);
    let m = mallory.pubkey();
    // Mallory copies the creator's seed and parameters.
    let km = Keys::new(&m, k.seed, Keypair::new().pubkey());
    assert_ne!(km.launch, k.launch);
    w.env
        .send(&[create_launch(&m, &km, w.params.clone())], &[&mallory])
        .expect_ok("mallory's launch under the creator's seed");
    let lm: Launch = w.env.anchor(&km.launch);
    assert_eq!((lm.creator, lm.launch_seed), (m, k.seed));
    // The creator's own address under that seed is the creator's.
    let l: Launch = w.env.anchor(&k.launch);
    assert_eq!(l.creator, w.creator.pubkey());
    // Mallory cannot create at an address of the creator's.
    let squat = Keys::new(&w.creator.pubkey(), [0x5A; 32], Keypair::new().pubkey());
    let ix = create_launch(&m, &squat, w.params.clone());
    let f = w.env.send(&[ix], &[&mallory]).fails_with(
        CONSTRAINT_SEEDS,
        "ConstraintSeeds",
        "a launch at another creator's address",
    );
    assert!(f
        .logs
        .iter()
        .any(|l| l.contains("caused by account: launch")));
    let creator = w.creator.insecure_clone();
    w.env
        .send(
            &[create_launch(&creator.pubkey(), &squat, w.params.clone())],
            &[&creator],
        )
        .expect_ok("the creator's own launch at that address");
    // Every PDA of a launch follows its address.
    assert_ne!(km.attestation, k.attestation);
    assert_ne!(km.dbc_config, k.dbc_config);
}

/// A5: `attest_launch` is a v1 transaction from a throwaway fee payer with
/// the SDK's config words (300k CU, 2 MiB of loaded data), within 4,096
/// bytes and 250k CU with the largest metadata record, at every leaf tried
/// (the record is an account: the transaction's size no longer depends on
/// the metadata). The first attestation writes the attestation account (the
/// whole signature, the record's hash and the window) and the identity
/// account (key, bitmap); every later valid signature of the same launch, at
/// another leaf, only burns its leaf.
#[test]
fn a5_attest_launch_fits_a_v1_transaction_and_burns_each_leaf_once() {
    let mut w = created_with(|_| {});
    let k = w.k;
    let meta_owned = (
        "N".repeat(MAX_NAME_LEN),
        "S".repeat(MAX_SYMBOL_LEN),
        format!("https://{}", "u".repeat(MAX_URI_LEN - 8)),
    );
    let meta = (
        meta_owned.0.as_str(),
        meta_owned.1.as_str(),
        meta_owned.2.as_str(),
    );
    let pq_identity = pq::identity_id();
    assert!(pq::identity_account(&w.env, &pq_identity).is_none());
    assert!(w.env.account(&k.attestation).is_none());
    pq::publish(&mut w.env, &k, meta);

    let terms = Terms::now(&w.env);
    let msg = pq::message(&w.env, &k, meta, &terms);
    let first = pq::next_free_leaf(&w.env, pq::identity(), &msg);
    assert_eq!(first, pq::leaf_probe_start(pq::identity(), &msg));
    let signed = pq::sign_with(&w.env, pq::identity(), first, &k, meta, terms);
    let payer = pq::throwaway_payer(&mut w.env);
    let ix = pq::attest_launch_ix(
        &payer.pubkey(),
        &k,
        signed.pk,
        signed.sig.clone(),
        meta,
        &terms,
    );
    let tx = w.env.v1_tx_with(&payer, &[ix], &[], pq::attest_config());
    // Only the throwaway payer signs: no wallet signature is needed.
    assert_eq!(tx.signatures.len(), 1);
    // The 2 MiB loaded-data word covers the launchpad's programdata, which
    // mainnet meters (SIMD-0186) and LiteSVM does not.
    let loaded = w.env.loaded_accounts_data_size(&tx);
    assert!(
        loaded <= u64::from(pq::ATTEST_LOADED_ACCOUNTS_DATA_LIMIT),
        "{loaded} bytes of loaded account data"
    );
    let sent = w.env.submit(tx).expect_ok("attest_launch");
    let slot = w.env.svm.get_sysvar::<solana_clock::Clock>().slot;
    println!(
        "attest_launch (first, largest metadata): {} CU, {} bytes (v1 limit {V1_MAX_TRANSACTION_SIZE})",
        sent.cu, sent.size
    );
    assert!(sent.size <= V1_MAX_TRANSACTION_SIZE && sent.cu <= 250_000);
    // Message v3 added the rules hash (32 bytes) and its account slot.
    assert!((2_880..=3_040).contains(&sent.size), "{} bytes", sent.size);
    // What the payer of a first attestation spends, so what a client funds
    // it with (A14): the rent of both accounts and one signature's fee (no
    // priority fee). At mainnet rent (5,080 lamports per byte, counting 128
    // bytes of overhead per account; FACTS #314) that is under 0.02 SOL;
    // at the default rent of LiteSVM and local validators it is more.
    let rent = |size: usize| w.env.svm.minimum_balance_for_rent_exemption(size);
    let spent = pq::ATTEST_PAYER_LAMPORTS - w.env.account(&payer.pubkey()).unwrap().lamports;
    assert_eq!(spent, rent(196) + rent(2_708) + 5_000);
    let at_mainnet_rent = (196 + 128 + 2_708 + 128) * 5_080 + 5_000;
    println!(
        "first attestation: its payer spends {spent} lamports here, {at_mainnet_rent} at mainnet rent"
    );
    assert!(at_mainnet_rent < LAMPORTS_PER_SOL / 50);

    let a: Attestation = w.env.anchor(&k.attestation);
    assert_eq!(
        (
            a.version,
            a.launch,
            a.pq_identity,
            u32::from(a.leaf),
            a.slot
        ),
        (Attestation::VERSION, k.launch, pq_identity, first, slot)
    );
    assert_eq!(a.metadata_hash, pq::metadata_hash(meta));
    assert_eq!(a.message_hash, solana_sha256_hasher::hash(&msg).to_bytes());
    assert_eq!(
        (a.not_before, a.not_after),
        (terms.not_before, terms.not_after)
    );
    assert_eq!(a.signature, signed.sig);
    assert_eq!(a.signature.len(), LMS_SIG_LEN);
    let e: LaunchAttested = one_event(&sent);
    assert_eq!(
        (
            e.launch,
            e.pq_identity,
            u32::from(e.leaf),
            e.metadata_hash,
            e.slot
        ),
        (k.launch, pq_identity, first, a.metadata_hash, slot)
    );
    assert_eq!((e.not_before, e.not_after), (a.not_before, a.not_after));
    let id: Identity = w.env.anchor(&pq::identity_pda(&pq_identity));
    assert_eq!(
        (id.version, id.public_key, id.used_count),
        (1, signed.pk, 1)
    );
    assert!(pq::leaf_used(&id, first));
    // The accounts are rent-exempt at their documented sizes.
    for (address, size) in [
        (pq::identity_pda(&pq_identity), 196),
        (k.attestation, 2_708),
    ] {
        let account = w.env.account(&address).unwrap();
        assert_eq!(account.data.len(), size);
        assert_eq!(account.owner, noised_launchpad::ID);
        assert!(account.lamports >= w.env.svm.minimum_balance_for_rent_exemption(size));
    }

    // More valid signatures of the same launch at other leaves (another
    // device, a retry): each runs the whole verification, burns its leaf and
    // leaves the attestation as it was.
    // Compute: `lms_verify` costs 8,674 + 137 CU per chain step on SBF
    // (`noised-lmots`), at most 990 steps; the rest is the instruction's
    // own overhead, measured here for each signature.
    let verify_cu = |steps: u32| 8_674 + 137 * u64::from(steps);
    let steps = pq::chain_steps(&signed.pk, &signed.sig, &msg);
    let first_overhead = sent.cu - verify_cu(steps);
    let mut cu = vec![sent.cu];
    let mut overheads = vec![];
    let mut leaves = vec![first];
    for i in 1..=40u32 {
        let q = (first + 25 * i) % 1_024;
        let signed = pq::sign_with(&w.env, pq::identity(), q, &k, meta, terms);
        if i == 1 {
            // Now the identity and attestation accounts exist and load too.
            let payer = Keypair::new();
            let ix = pq::attest_launch_ix(
                &payer.pubkey(),
                &k,
                signed.pk,
                signed.sig.clone(),
                meta,
                &terms,
            );
            let tx = w.env.v1_tx_with(&payer, &[ix], &[], pq::attest_config());
            let loaded = w.env.loaded_accounts_data_size(&tx);
            println!(
                "attest_launch loads {loaded} bytes of account data (limit {})",
                pq::ATTEST_LOADED_ACCOUNTS_DATA_LIMIT
            );
            assert!(loaded <= u64::from(pq::ATTEST_LOADED_ACCOUNTS_DATA_LIMIT));
        }
        let sent = pq::send_attestation(&mut w.env, &k, &signed, meta)
            .expect_ok("another signature of an attested launch");
        assert!(sent.size <= V1_MAX_TRANSACTION_SIZE && sent.cu <= 250_000);
        let e: PqLeafConsumed = one_event(&sent);
        assert_eq!(
            (e.pq_identity, u32::from(e.leaf), e.launch),
            (pq_identity, q, k.launch)
        );
        assert!(events::<LaunchAttested>(&sent.logs).is_empty());
        let steps = pq::chain_steps(&signed.pk, &signed.sig, &msg);
        assert!(steps <= 990);
        overheads.push(sent.cu - verify_cu(steps));
        cu.push(sent.cu);
        leaves.push(q);
    }
    let a2: Attestation = w.env.anchor(&k.attestation);
    assert_eq!(
        (a2.leaf, a2.slot, a2.message_hash, a2.signature),
        (a.leaf, a.slot, a.message_hash, a.signature)
    );
    let id: Identity = w.env.anchor(&pq::identity_pda(&pq_identity));
    assert_eq!(usize::from(id.used_count), leaves.len());
    for q in 0..1_024 {
        assert_eq!(pq::leaf_used(&id, q), leaves.contains(&q), "leaf {q}");
    }
    cu.sort_unstable();
    println!(
        "attest_launch over {} signatures (largest metadata): {} min, {} median, {} max CU",
        cu.len(),
        cu[0],
        cu[cu.len() / 2],
        cu[cu.len() - 1]
    );
    // The overhead beyond verification barely varies, so the worst digest
    // (990 chain steps) stays far under 250k CU, first attestation included.
    let (low, high) = (
        *overheads.iter().min().unwrap(),
        *overheads.iter().max().unwrap(),
    );
    assert!(high - low < 2_000, "overheads {low}..{high}");
    let worst = verify_cu(990) + first_overhead.max(high);
    println!(
        "attest_launch: overhead beyond lms_verify {first_overhead} CU (first, creating both accounts), {low}-{high} CU (later); worst case (990 chain steps) {worst} CU"
    );
    assert!(worst <= 250_000, "{worst} CU");
}

/// A5: anyone can send lamports to the identity and attestation addresses
/// before they exist; the first attestation takes both accounts over.
#[test]
fn a5_prefunded_identity_and_attestation_addresses_block_nothing() {
    let mut w = created_with(|_| {});
    let k = w.k;
    let pq_identity = pq::identity_id();
    let mallory = w.env.funded(1);
    for address in [pq::identity_pda(&pq_identity), k.attestation] {
        let fund = system_instruction::transfer(&mallory.pubkey(), &address, 1_000_000);
        w.env
            .send(&[fund], &[&mallory])
            .expect_ok("pre-fund a PDA address");
        assert_eq!(
            w.env.account(&address).unwrap().owner,
            anchor_lang::system_program::ID
        );
    }
    pq::attest(&mut w.env, &k, META);
    let a: Attestation = w.env.anchor(&k.attestation);
    assert_eq!(a.launch, k.launch);
    let id: Identity = w.env.anchor(&pq::identity_pda(&pq_identity));
    assert_eq!(id.used_count, 1);
    let mint = w.mint.insecure_clone();
    launch_now(&mut w, &k, &mint, META);
}

/// A5: only a valid LMS signature over this launch's message (this exact
/// metadata record, so name, symbol, uri mode, uri and document, and this
/// window) lands; nothing that fails changes any account. A valid signature by another identity than
/// the one the launch names lands too, but only burns that identity's own
/// leaf: its account is the one the key names (passing the launch's
/// identity account instead is refused), and the launch stays unattested.
#[test]
fn a5_only_valid_signatures_land_and_another_identity_burns_only_its_own_leaf() {
    let mut w = created_with(|_| {});
    let k = w.k;
    let (other_k, _) = create_another(&mut w, [0x0B; 32]);
    let env = &mut w.env;
    let pq_identity = pq::identity_id();
    let terms = Terms::now(env);
    let msg = pq::message(env, &k, META, &terms);
    let q = pq::next_free_leaf(env, pq::identity(), &msg);
    let good = pq::sign_with(env, pq::identity(), q, &k, META, terms);
    let refused = |env: &mut Env, signed: &pq::Signed, meta: pq::Meta, what: &str| {
        pq::send_attestation(env, &k, signed, meta).fails_with(
            code(E::InvalidPqSignature),
            "InvalidPqSignature",
            what,
        );
    };

    // The named key with another identity's signature.
    let stranger = pq::sign_with(env, pq::other_identity(), q, &k, META, terms);
    let mixed = pq::Signed {
        sig: stranger.sig.clone(),
        ..good.clone()
    };
    refused(env, &mixed, META.into(), "another identity's signature");
    // Other metadata, document or window than signed; another launch.
    refused(
        env,
        &good,
        (NAME, SYMBOL, "https://example.org/other.json").into(),
        "other uri",
    );
    refused(env, &good, (NAME, "OTHER", URI).into(), "other symbol");
    refused(env, &good, ("Other", SYMBOL, URI).into(), "other name");
    let with_doc = pq::Meta {
        doc: b"{}",
        ..META.into()
    };
    refused(env, &good, with_doc, "another metadata document");
    let no_uri = pq::Meta {
        flags: 0,
        uri: b"",
        ..META.into()
    };
    refused(env, &good, no_uri, "another uri mode");
    for (what, edit) in [
        (
            "an earlier window",
            &(|t: &mut Terms| t.not_before -= 1) as &dyn Fn(&mut Terms),
        ),
        ("a later end", &|t: &mut Terms| t.not_after += 1),
    ] {
        let mut s = good.clone();
        edit(&mut s.terms);
        refused(env, &s, META.into(), what);
    }
    let for_other_launch = pq::sign_with(env, pq::identity(), q, &other_k, META, terms);
    refused(
        env,
        &for_other_launch,
        META.into(),
        "a signature over another launch",
    );
    // Tampered signatures: every field, and the length.
    let tamper = |at: usize| {
        let mut s = good.sig.clone();
        s[at] ^= 1;
        pq::Signed {
            sig: s,
            ..good.clone()
        }
    };
    for (what, at) in [
        ("q", 3),
        ("LM-OTS typecode", 7),
        ("C", 8),
        ("y[0]", 40),
        ("y[66]", 2_183),
        ("LMS typecode", 2_187),
        ("path[0]", 2_188),
        ("path[9]", 2_507),
    ] {
        refused(env, &tamper(at), META.into(), what);
    }
    let mut q_out_of_range = good.clone();
    q_out_of_range.sig[..4].copy_from_slice(&1_024u32.to_be_bytes());
    refused(env, &q_out_of_range, META.into(), "q = 1024");
    for len in [LMS_SIG_LEN - 1, LMS_SIG_LEN + 1, 0] {
        let mut s = good.clone();
        s.sig.resize(len, 0);
        refused(env, &s, META.into(), "a signature of the wrong length");
    }
    // A key whose typecodes are not LMS_SHA256_M32_H10 / LMOTS_SHA256_N32_W4
    // is refused even by a launch that names it.
    for (what, at, typecode) in [("LMS typecode 5", 3, 5u8), ("LM-OTS typecode 4", 7, 4)] {
        let mut pk = good.pk;
        pk[at] = typecode;
        let mut odd = w.params.clone();
        odd.pq_identity = pq::identity_id_of(&pk);
        let c = w.creator.pubkey();
        let k2 = Keys::new(&c, [0x50 + at as u8; 32], Keypair::new().pubkey());
        env.send(&[create_launch(&c, &k2, odd)], &[&w.creator])
            .expect_ok("a launch naming an odd key");
        let signed = pq::Signed {
            pk,
            ..pq::sign_with(env, pq::identity(), q, &k2, META, terms)
        };
        pq::send_attestation(env, &k2, &signed, META).fails_with(
            code(E::InvalidPqSignature),
            "InvalidPqSignature",
            what,
        );
        assert!(env
            .account(&pq::identity_pda(&pq::identity_id_of(&pk)))
            .is_none());
    }
    // Nothing landed.
    assert!(pq::identity_account(env, &pq_identity).is_none());
    assert!(env.account(&k.attestation).is_none());

    // Another identity's valid signature over this launch's message: sent
    // with the launch's identity account it is refused (that account is
    // named by another key) ...
    let payer = pq::throwaway_payer(env);
    let mut ix = pq::attest_launch_ix(
        &payer.pubkey(),
        &k,
        stranger.pk,
        stranger.sig.clone(),
        META,
        &terms,
    );
    ix.accounts[2].pubkey = pq::identity_pda(&pq_identity);
    env.send_v1(&payer, &[ix], &[], pq::attest_config())
        .fails_with(
            CONSTRAINT_SEEDS,
            "ConstraintSeeds",
            "another key with the launch's identity account",
        );
    // ... and with its own, it lands: its leaf is burned, nothing attested.
    let stranger_id = pq::identity_id_of(&stranger.pk);
    let sent = pq::send_attestation(env, &k, &stranger, META)
        .expect_ok("another identity's valid signature burns its leaf");
    let e: PqLeafConsumed = one_event(&sent);
    assert_eq!(
        (e.pq_identity, u32::from(e.leaf), e.launch),
        (stranger_id, q, k.launch)
    );
    let theirs = pq::identity_account(env, &stranger_id).expect("its identity account");
    assert_eq!((theirs.used_count, theirs.public_key), (1, stranger.pk));
    assert!(pq::leaf_used(&theirs, q));
    assert!(pq::identity_account(env, &pq_identity).is_none());
    let empty: Attestation = env.anchor(&k.attestation);
    assert_eq!(empty.launch, Pubkey::default());

    pq::publish(env, &k, META);
    pq::send_attestation(env, &k, &good, META).expect_ok("the valid signature");
    let a: Attestation = env.anchor(&k.attestation);
    assert_eq!((a.launch, u32::from(a.leaf)), (k.launch, q));
}

/// A5 and A13: a leaf is accepted once, ever, and any revealed signature can
/// be landed to burn its leaf. An identical re-broadcast and a second
/// message at a landed leaf are refused; a second valid signature of an
/// attested launch (another device, other metadata) only burns its leaf,
/// before or after the launch goes live, and the first attestation stands.
/// The client picks a leaf from the message: a retry of the same message
/// signs the same bytes at the same leaf.
#[test]
fn a5_a_leaf_signs_once_and_a_revealed_signature_always_lands() {
    let mut w = created_with(|_| {});
    let a = w.k;
    let mint_a = w.mint.insecure_clone();
    let (b, mint_b) = create_another(&mut w, [0x0B; 32]);
    let pq_identity = pq::identity_id();
    let terms = Terms::now(&w.env);
    let leaf_used = |what| (code(E::PqLeafUsed), "PqLeafUsed", what);

    pq::publish(&mut w.env, &a, META);
    let signed_a = sign_next(&w.env, pq::identity(), &a, META, terms);
    let qa = signed_a.q;
    assert_eq!(
        sign_next(&w.env, pq::identity(), &a, META, terms).sig,
        signed_a.sig,
        "a retry of the same message signs the same bytes"
    );
    pq::send_attestation(&mut w.env, &a, &signed_a, META).expect_ok("attest A");
    let (c, n, what) = leaf_used("an identical re-broadcast");
    pq::send_attestation(&mut w.env, &a, &signed_a, META).fails_with(c, n, what);
    // The same leaf signing another launch: refused, it is spent.
    let reuse = pq::sign_with(&w.env, pq::identity(), qa, &b, META, terms);
    let (c, n, what) = leaf_used("a landed leaf signing another launch");
    pq::send_attestation(&mut w.env, &b, &reuse, META).fails_with(c, n, what);
    assert!(w.env.account(&b.attestation).is_none());

    // A second device publishes and signs other metadata for A, another
    // message, at the leaf that message probes to: the signature lands and
    // burns its leaf; A's attestation is unchanged, so A launches only with
    // the record first attested (the other record exists, but is not the
    // one the attestation names).
    let other_meta = ("Second Device", "DEV2", "https://second.example/dev2.json");
    pq::publish(&mut w.env, &a, other_meta);
    let second = sign_next(&w.env, pq::identity(), &a, other_meta, terms);
    let qb = second.q;
    assert_ne!(qb, qa);
    let sent = pq::send_attestation(&mut w.env, &a, &second, other_meta)
        .expect_ok("a second attestation of A");
    let e: PqLeafConsumed = one_event(&sent);
    assert_eq!((u32::from(e.leaf), e.launch), (qb, a.launch));
    let att: Attestation = w.env.anchor(&a.attestation);
    assert_eq!(
        (u32::from(att.leaf), att.metadata_hash),
        (qa, pq::metadata_hash(META))
    );
    let c_ = w.creator.pubkey();
    w.env
        .send_with(
            &c_,
            &[launch(&c_, &a, other_meta.0, other_meta.1, other_meta.2)],
            &[&w.creator, &mint_a],
            true,
        )
        .fails_with(
            CONSTRAINT_SEEDS,
            "ConstraintSeeds",
            "launch with the second device's record",
        );
    let sent = launch_now(&mut w, &a, &mint_a, META);
    let e: Launched = one_event(&sent);
    assert_eq!((e.pq_identity, u32::from(e.pq_leaf)), (pq_identity, qa));

    // After the launch is live, a revealed signature still lands.
    let late = sign_next(&w.env, pq::identity(), &a, META, terms);
    let qc = late.q;
    let sent = pq::send_attestation(&mut w.env, &a, &late, META)
        .expect_ok("a signature landed after the launch");
    assert_eq!(u32::from(one_event::<PqLeafConsumed>(&sent).leaf), qc);
    assert_eq!(w.env.anchor::<Launch>(&a.launch).status, LaunchStatus::Live);

    // B is attested at a fresh leaf and launches.
    pq::publish(&mut w.env, &b, META);
    let signed_b = sign_next(&w.env, pq::identity(), &b, META, terms);
    let qd = signed_b.q;
    assert!(![qa, qb, qc].contains(&qd));
    pq::send_attestation(&mut w.env, &b, &signed_b, META).expect_ok("attest B");
    launch_now(&mut w, &b, &mint_b, META);
    let id: Identity = w.env.anchor(&pq::identity_pda(&pq_identity));
    assert_eq!(id.used_count, 4);
    for q in [qa, qb, qc, qd] {
        assert!(pq::leaf_used(&id, q));
    }
    let cert_b: Certificate = w.env.anchor(&b.certificate);
    assert_eq!(u32::from(cert_b.pq_leaf), qd);
}

/// A5: an identity whose 1,024 leaves have all signed refuses every further
/// signature (its owner moves to its next identity); the bitmap is written
/// in the ledger here. A single clear leaf still signs.
#[test]
fn a5_an_exhausted_identity_refuses_every_leaf() {
    let mut w = created_with(|_| {});
    let a = w.k;
    let (b, _) = create_another(&mut w, [0x0B; 32]);
    let pq_identity = pq::identity_id();
    pq::attest(&mut w.env, &a, META);
    let address = pq::identity_pda(&pq_identity);
    let mut account = w.env.account(&address).unwrap();
    account.data[66..194].fill(0xFF);
    account.data[194..196].copy_from_slice(&1_024u16.to_le_bytes());
    w.env.svm.set_account(address, account.clone()).unwrap();
    let terms = Terms::now(&w.env);
    let msg_b = pq::message(&w.env, &b, META, &terms);
    for q in [
        0,
        1,
        511,
        512,
        1_023,
        pq::leaf_probe_start(pq::identity(), &msg_b),
    ] {
        let signed = pq::sign_with(&w.env, pq::identity(), q, &b, META, terms);
        pq::send_attestation(&mut w.env, &b, &signed, META).fails_with(
            code(E::PqLeafUsed),
            "PqLeafUsed",
            "a signature of an exhausted identity",
        );
    }
    // One clear leaf: 700 (byte 87, bit 4).
    account.data[66 + 87] &= !(1 << 4);
    account.data[194..196].copy_from_slice(&1_023u16.to_le_bytes());
    w.env.svm.set_account(address, account).unwrap();
    assert_eq!(pq::next_free_leaf(&w.env, pq::identity(), &msg_b), 700);
    pq::attest_with(&mut w.env, &b, META, terms);
    let id: Identity = w.env.anchor(&address);
    assert_eq!((id.used_count, id.used), (1_024, [0xFF; 128]));
    assert_eq!(w.env.anchor::<Attestation>(&b.attestation).leaf, 700);
}

/// A6: `launch` needs this launch's attestation, by the identity the launch
/// names, and launches with exactly the metadata record it attests (other
/// records of the launch exist, published by anyone, but are refused). No
/// Ed25519 signature (all a quantum attacker could forge) can launch without
/// it or under other metadata. The certificate and the `Launched` event
/// record the identity and the leaf; the certificate names the record.
#[test]
fn a6_launch_requires_its_attestation_with_the_same_metadata() {
    let mut w = created_with(|_| {});
    let k = w.k;
    let mint = w.mint.insecure_clone();
    let (other, _) = create_another(&mut w, [0x0B; 32]);
    let c = w.creator.pubkey();
    let try_launch = |w: &mut World, ix: solana_instruction::Instruction| {
        let c = w.creator.pubkey();
        w.env.send_with(&c, &[ix], &[&w.creator, &mint], true)
    };

    let f = try_launch(&mut w, launch(&c, &k, NAME, SYMBOL, URI)).fails_with(
        ACCOUNT_NOT_INITIALIZED,
        "AccountNotInitialized",
        "launch before any attestation",
    );
    assert!(f
        .logs
        .iter()
        .any(|l| l.contains("caused by account: attestation")));
    pq::attest(&mut w.env, &other, META);
    pq::attest(&mut w.env, &k, META);

    let longer_uri = format!("{URI}x");
    for (what, meta) in [
        ("another name", ("Rugged", SYMBOL, URI)),
        ("another symbol", (NAME, "RUG", URI)),
        (
            "another uri",
            (NAME, SYMBOL, "https://example.org/rug.json"),
        ),
        (
            "a uri with one more byte",
            (NAME, SYMBOL, longer_uri.as_str()),
        ),
        ("no uri", (NAME, SYMBOL, "")),
    ] {
        // Not published: there is no such record.
        let f = try_launch(&mut w, launch(&c, &k, meta.0, meta.1, meta.2)).fails_with(
            ACCOUNT_NOT_INITIALIZED,
            "AccountNotInitialized",
            what,
        );
        assert!(f
            .logs
            .iter()
            .any(|l| l.contains("caused by account: token_meta")));
        // Published: a record of this launch, but not the attested one.
        pq::publish(&mut w.env, &k, meta);
        let f = try_launch(&mut w, launch(&c, &k, meta.0, meta.1, meta.2)).fails_with(
            CONSTRAINT_SEEDS,
            "ConstraintSeeds",
            what,
        );
        assert!(f
            .logs
            .iter()
            .any(|l| l.contains("caused by account: token_meta")));
    }
    // The attested record of another launch.
    let f = try_launch(
        &mut w,
        launch_with_record(&c, &k, pq::token_meta_of(&other, META)),
    )
    .fails_with(
        CONSTRAINT_SEEDS,
        "ConstraintSeeds",
        "another launch's record",
    );
    assert!(f
        .logs
        .iter()
        .any(|l| l.contains("caused by account: token_meta")));
    // Another launch's attestation, or the identity account, in its slot.
    let mut ix = launch(&c, &k, NAME, SYMBOL, URI);
    // [.., attestation, token_meta, rules (the program id: no rules)].
    let slot = ix.accounts.len() - 3;
    assert_eq!(ix.accounts[slot].pubkey, k.attestation);
    ix.accounts[slot].pubkey = other.attestation;
    let f = try_launch(&mut w, ix.clone()).fails_with(
        CONSTRAINT_SEEDS,
        "ConstraintSeeds",
        "another launch's attestation",
    );
    assert!(f
        .logs
        .iter()
        .any(|l| l.contains("caused by account: attestation")));
    ix.accounts[slot].pubkey = pq::identity_pda(&pq::identity_id());
    try_launch(&mut w, ix).fails_with(
        ACCOUNT_DISCRIMINATOR_MISMATCH,
        "AccountDiscriminatorMismatch",
        "the identity account as the attestation",
    );
    assert_eq!(
        w.env.anchor::<Launch>(&k.launch).status,
        LaunchStatus::Configured
    );

    let sent = try_launch(&mut w, launch(&c, &k, NAME, SYMBOL, URI)).expect_ok("launch");
    let att: Attestation = w.env.anchor(&k.attestation);
    let cert: Certificate = w.env.anchor(&k.certificate);
    assert_eq!(cert.checks, checks::ALL);
    assert_eq!(cert.metadata, pq::token_meta_of(&k, META));
    assert_eq!(
        (cert.pq_identity, cert.pq_leaf, cert.attested_slot),
        (pq::identity_id(), att.leaf, att.slot)
    );
    let e: Launched = one_event(&sent);
    assert_eq!(
        (e.launch, e.certificate, e.pq_identity, e.pq_leaf),
        (k.launch, k.certificate, pq::identity_id(), att.leaf)
    );
}

/// A6, field by field: `launch` compares the attestation's launch, identity
/// and window itself, not only the account's address (its seeds), owner and
/// discriminator. Rewritten in the ledger (address, owner, discriminator and
/// size unchanged) to name another launch, another identity, other metadata
/// or a window that is not now, the attestation is refused each time (other
/// metadata by the record's address, which its hash names); restored, the
/// launch goes live and certifies what it records.
#[test]
fn a6_launch_checks_each_attestation_field_itself() {
    let mut w = created_with(|_| {});
    let k = w.k;
    let mint = w.mint.insecure_clone();
    let (other, _) = create_another(&mut w, [0x0B; 32]);
    pq::attest(&mut w.env, &k, META);
    let original = w.env.account(&k.attestation).unwrap();
    let attested: Attestation = w.env.anchor(&k.attestation);
    let now = w.env.now();
    assert!(attested.not_before <= now && now <= attested.not_after);
    let edited = |edit: &dyn Fn(&mut Attestation)| {
        let mut a = attested.clone();
        edit(&mut a);
        a
    };
    let stranger = pq::identity_id_of(&pq::public_key(pq::other_identity()));
    let mismatch = (code(E::AttestationMismatch), "AttestationMismatch");
    let window = (code(E::NotLaunchWindow), "NotLaunchWindow");
    let c = w.creator.pubkey();
    for (what, forged, (error, name)) in [
        (
            "an attestation naming another launch",
            edited(&|a| a.launch = other.launch),
            mismatch,
        ),
        (
            "an attestation by another identity",
            edited(&|a| a.pq_identity = stranger),
            mismatch,
        ),
        (
            "an attestation of other metadata",
            edited(&|a| a.metadata_hash = pq::metadata_hash(("Rugged", SYMBOL, URI))),
            (CONSTRAINT_SEEDS, "ConstraintSeeds"),
        ),
        (
            "an attestation whose window opens in a second",
            edited(&|a| a.not_before = now + 1),
            window,
        ),
        (
            "an attestation whose window closed a second ago",
            edited(&|a| a.not_after = now - 1),
            window,
        ),
    ] {
        let mut data = Vec::new();
        forged.try_serialize(&mut data).unwrap();
        assert_eq!(data.len(), original.data.len());
        w.env
            .svm
            .set_account(
                k.attestation,
                Account {
                    data,
                    ..original.clone()
                },
            )
            .unwrap();
        w.env
            .send_with(
                &c,
                &[launch(&c, &k, NAME, SYMBOL, URI)],
                &[&w.creator, &mint],
                true,
            )
            .fails_with(error, name, what);
    }
    assert_eq!(
        w.env.anchor::<Launch>(&k.launch).status,
        LaunchStatus::Configured
    );
    w.env.svm.set_account(k.attestation, original).unwrap();
    launch_now(&mut w, &k, &mint, META);
    let cert: Certificate = w.env.anchor(&k.certificate);
    assert_eq!(
        (cert.checks, cert.pq_identity, cert.pq_leaf),
        (checks::ALL, pq::identity_id(), attested.leaf)
    );
}

/// A4-A6, identity squatting: launch parameters are the creator's free
/// choice, so anyone can create a launch naming somebody else's identity,
/// but it never goes live. That identity's signatures are public (each
/// attestation stores one), yet none covers it: the message names the
/// launch, its parameters and its creator. Mallory replays the creator's
/// stored signature (refused), lands her own identity's signature (it only
/// burns her own leaf: her launch names another identity), and tries to
/// launch without an attestation, then with the empty one (and the record
/// she published): each is refused, and the creator's identity account
/// (key, bitmap, count) is untouched.
#[test]
fn a5_a_launch_naming_another_creators_identity_never_goes_live() {
    let mut w = launched();
    let pq_identity = pq::identity_id();
    let honest: Attestation = w.env.anchor(&w.k.attestation);
    let identity_before = w.env.account(&pq::identity_pda(&pq_identity)).unwrap();
    let env = &mut w.env;
    let mallory = env.funded(20);
    let m = mallory.pubkey();
    let mint = Keypair::new();
    let km = Keys::new(&m, [0x66; 32], mint.pubkey());
    let p = params(&[(m, 10_000)]);
    assert_eq!(p.pq_identity, pq_identity);
    env.send(&[create_launch(&m, &km, p)], &[&mallory])
        .expect_ok("mallory's launch naming the creator's identity");
    let f = env
        .send_with(
            &m,
            &[launch(&m, &km, NAME, SYMBOL, URI)],
            &[&mallory, &mint],
            true,
        )
        .fails_with(
            ACCOUNT_NOT_INITIALIZED,
            "AccountNotInitialized",
            "mallory's launch without an attestation",
        );
    assert!(f
        .logs
        .iter()
        .any(|l| l.contains("caused by account: attestation")));

    // The creator's signature, as the honest attestation stores it.
    let replay = pq::Signed {
        q: u32::from(honest.leaf),
        pk: pq::public_key(pq::identity()),
        sig: honest.signature.clone(),
        terms: Terms {
            not_before: honest.not_before,
            not_after: honest.not_after,
            rules_hash: honest.rules_hash,
        },
    };
    assert_eq!(
        noised_lmots::lms_verify::<noised_lmots::Sha2>(
            &replay.pk,
            &pq::message(env, &w.k, META, &replay.terms),
            &replay.sig
        ),
        Some(replay.q),
        "a valid signature of the creator's own launch"
    );
    pq::send_attestation(env, &km, &replay, META).fails_with(
        code(E::InvalidPqSignature),
        "InvalidPqSignature",
        "the creator's stored signature replayed on mallory's launch",
    );
    let own = sign_next(env, pq::other_identity(), &km, META, Terms::now(env));
    let sent = pq::send_attestation(env, &km, &own, META)
        .expect_ok("mallory's own identity's signature burns her leaf");
    let e: PqLeafConsumed = one_event(&sent);
    assert_eq!(e.pq_identity, pq::identity_id_of(&own.pk));
    let empty: Attestation = env.anchor(&km.attestation);
    assert_eq!(empty.launch, Pubkey::default());
    // The empty attestation names no record (its hash is zero), so no
    // record passes as the attested one.
    pq::publish(env, &km, META);
    env.send_with(
        &m,
        &[launch(&m, &km, NAME, SYMBOL, URI)],
        &[&mallory, &mint],
        true,
    )
    .fails_with(
        CONSTRAINT_SEEDS,
        "ConstraintSeeds",
        "mallory's launch with an empty attestation",
    );
    assert_eq!(
        env.anchor::<Launch>(&km.launch).status,
        LaunchStatus::Configured
    );
    assert_eq!(
        env.account(&pq::identity_pda(&pq_identity)).unwrap(),
        identity_before
    );
}

/// The review's first finding (medium), with its PoC's victim: a valid
/// signature over metadata that can never be a record (here a name of 11
/// euro signs:
/// 11 characters, which a JavaScript `length` check accepts, and 33 UTF-8
/// bytes) was refused before its leaf was burned. The client's corrected
/// retry then signed a second message at the same unlanded leaf, and anyone
/// who saw both could forge a signature at that leaf (the PoC took its own
/// launch live as the victim's identity). Now any valid signature lands and
/// burns its leaf, and attests only what `launch` can use; a burned leaf
/// refuses every further signature, so even a perfect forgery at it (a
/// valid signature stands in for one here) cannot land. And the retry,
/// another message, probes from its own leaf (the third finding: leaves
/// were chosen per launch, so every message for one launch started at the
/// same unlanded leaf).
#[test]
fn review_a_signature_launch_cannot_use_burns_its_leaf_and_the_retry_takes_another() {
    let mut w = created_with(|_| {});
    let k = w.k;
    let mint = w.mint.insecure_clone();
    let pq_identity = pq::identity_id();
    let terms = Terms::now(&w.env);
    let euros = "\u{20ac}".repeat(11);
    assert_eq!((euros.chars().count(), euros.len()), (11, 33));
    let wide_symbol = "\u{20ac}".repeat(4);
    assert_eq!((wide_symbol.chars().count(), wide_symbol.len()), (4, 12));
    let long_uri = format!("https://{}", "u".repeat(MAX_URI_LEN - 7));
    assert_eq!(long_uri.len(), MAX_URI_LEN + 1);
    let not_utf8: &[u8] = &[b'P', b'H', 0xC0, 0xAF];
    let cases: [(&str, pq::Meta); 5] = [
        (
            "a name of 11 characters and 33 bytes",
            (euros.as_str(), SYMBOL, URI).into(),
        ),
        (
            "a symbol of 4 characters and 12 bytes",
            (NAME, wide_symbol.as_str(), URI).into(),
        ),
        ("an empty symbol", (NAME, "", URI).into()),
        (
            "a uri of 201 bytes",
            (NAME, SYMBOL, long_uri.as_str()).into(),
        ),
        (
            "a name that is not UTF-8",
            (not_utf8, SYMBOL.as_bytes(), URI.as_bytes()).into(),
        ),
    ];
    let mut burned = Vec::new();
    for (what, meta) in cases {
        let bad = sign_next(&w.env, pq::identity(), &k, meta, terms);
        assert!(!burned.contains(&bad.q), "{what}");
        let sent = pq::send_attestation(&mut w.env, &k, &bad, meta).expect_ok(what);
        let e: PqLeafConsumed = one_event(&sent);
        assert_eq!(
            (e.pq_identity, u32::from(e.leaf), e.launch),
            (pq_identity, bad.q, k.launch),
            "{what}"
        );
        assert!(events::<LaunchAttested>(&sent.logs).is_empty(), "{what}");
        let a: Attestation = w.env.anchor(&k.attestation);
        assert_eq!(a.launch, Pubkey::default(), "{what}: nothing attested");
        // The leaf is spent: another message signed at it is refused.
        let at_same_leaf = pq::sign_with(&w.env, pq::identity(), bad.q, &k, META, terms);
        pq::send_attestation(&mut w.env, &k, &at_same_leaf, META).fails_with(
            code(E::PqLeafUsed),
            "PqLeafUsed",
            what,
        );
        burned.push(bad.q);
    }
    let id: Identity = w.env.anchor(&pq::identity_pda(&pq_identity));
    assert_eq!(usize::from(id.used_count), burned.len());
    // Unattested, the launch cannot go live (the empty attestation names no
    // record); and no record with the bad name can exist.
    let c = w.creator.pubkey();
    w.env
        .send(&[launch(&c, &k, NAME, SYMBOL, URI)], &[&w.creator, &mint])
        .fails_with(
            ACCOUNT_NOT_INITIALIZED,
            "AccountNotInitialized",
            "launch with the empty attestation",
        );
    pq::try_publish(&mut w.env, &k, (euros.as_str(), SYMBOL, URI)).fails_with(
        code(E::InvalidMetadata),
        "InvalidMetadata",
        "a record with the 33-byte name",
    );

    // Leaves are chosen per message: 64 metadata variants of this one
    // launch start their probes at many leaves (the per-launch rule started
    // them all at one).
    let starts: std::collections::BTreeSet<u32> = (0..64)
        .map(|i| {
            let name = format!("{NAME} {i}");
            let msg = pq::message(&w.env, &k, (name.as_str(), SYMBOL, URI), &terms);
            pq::leaf_probe_start(pq::identity(), &msg)
        })
        .collect();
    assert!(starts.len() > 32, "{} distinct starts", starts.len());

    // The corrected retry: the record published, another message, a leaf
    // of its own, attested.
    pq::publish(&mut w.env, &k, META);
    let good = sign_next(&w.env, pq::identity(), &k, META, terms);
    assert!(!burned.contains(&good.q));
    let sent = pq::send_attestation(&mut w.env, &k, &good, META).expect_ok("the retry");
    let e: LaunchAttested = one_event(&sent);
    assert_eq!(u32::from(e.leaf), good.q);
    launch_now(&mut w, &k, &mint, META);
    let cert: Certificate = w.env.anchor(&k.certificate);
    assert_eq!(
        (cert.pq_identity, u32::from(cert.pq_leaf)),
        (pq_identity, good.q)
    );
}

/// The review's second finding (medium), attestation side: an attestation
/// fixes the launch window, and only a window that can still open is
/// recorded: one minute to one hour long, opening at most a week ahead,
/// with at least a minute of it left when it lands (audit 3: one landing
/// with seconds or nothing left fixed a window `launch` could not use). Any
/// other window (too short or long, swapped, over, ending as it lands, 59
/// seconds left, a week and a second ahead, milliseconds for seconds)
/// lands, burns its leaf and attests nothing, so the launch can still be
/// attested; the bounds themselves are accepted.
#[test]
fn review_an_attestation_of_a_window_that_cannot_open_only_burns_its_leaf() {
    let mut w = created_with(|_| {});
    let k = w.k;
    // The record exists, so the window alone decides.
    pq::publish(&mut w.env, &k, META);
    let now = w.env.now();
    let terms = |not_before: i64, not_after: i64| Terms::window(not_before, not_after);
    let ms = now * 1_000;
    let cases = [
        ("a window of 59 seconds", terms(now, now + 59)),
        ("a window of an hour and a second", terms(now, now + 3_601)),
        ("a swapped pair", terms(now + 600, now)),
        ("a window over a second ago", terms(now - 3_600, now - 1)),
        ("a window ending as it lands", terms(now - 60, now)),
        ("59 seconds of an hour left", terms(now - 3_541, now + 59)),
        (
            "a window opening a week and a second from now",
            terms(now + 604_801, now + 604_861),
        ),
        ("a window in milliseconds", terms(ms, ms + 3_600_000)),
        ("an opening in milliseconds", terms(ms, ms + 3_600)),
    ];
    for (what, t) in cases {
        let s = sign_next(&w.env, pq::identity(), &k, META, t);
        let sent = pq::send_attestation(&mut w.env, &k, &s, META).expect_ok(what);
        assert_eq!(
            u32::from(one_event::<PqLeafConsumed>(&sent).leaf),
            s.q,
            "{what}"
        );
        assert_eq!(
            w.env.anchor::<Attestation>(&k.attestation).launch,
            Pubkey::default(),
            "{what}"
        );
    }
    // At the bounds: an hour long, opening exactly a week from now.
    let (open, close) = (now + 604_800, now + 604_800 + 3_600);
    let sent = pq::attest_with(&mut w.env, &k, META, terms(open, close));
    let e: LaunchAttested = one_event(&sent);
    assert_eq!((e.not_before, e.not_after), (open, close));
    let a: Attestation = w.env.anchor(&k.attestation);
    assert_eq!((a.not_before, a.not_after), (open, close));
    let id: Identity = w.env.anchor(&pq::identity_pda(&pq::identity_id()));
    assert_eq!(usize::from(id.used_count), cases.len() + 1);
    // An hour long, already open, exactly a minute left: accepted too.
    let (k2, _) = create_another(&mut w, [0x0C; 32]);
    let t = w.env.now();
    let sent = pq::attest_with(&mut w.env, &k2, META, terms(t - 3_540, t + 60));
    assert_eq!(one_event::<LaunchAttested>(&sent).not_after, t + 60);
}

/// The review's second finding (medium): the attestation did not bind when
/// or by whom `launch` ran, so whoever could forge the creator's Ed25519
/// key (a quantum computer) chose the opening and could self-snipe it. Now
/// `launch` runs only inside the window the identity signed, and inside it
/// anyone may run it: no Ed25519 key decides what launches or when. Before
/// the window not even the creator can launch; at its opening a keeper with
/// no relation to the launch does, in a legacy transaction with both
/// compute-budget instructions and no creator signature; the window's last
/// second still launches, the next one does not.
#[test]
fn review_launch_runs_only_inside_its_signed_window_and_anyone_may_run_it() {
    let mut w = created_with(|_| {});
    let k = w.k;
    let mint = w.mint.insecure_clone();
    let creator = w.creator.insecure_clone();
    let c = creator.pubkey();
    let t0 = w.env.now();
    let (open, close) = (t0 + 600, t0 + 720);
    pq::attest_with(&mut w.env, &k, META, Terms::window(open, close));
    for (at, what) in [
        (t0, "the creator, ten minutes before the window"),
        (open - 1, "the creator, a second before the window"),
    ] {
        w.env.set_time(at);
        w.env
            .send(&[launch(&c, &k, NAME, SYMBOL, URI)], &[&creator, &mint])
            .fails_with(code(E::NotLaunchWindow), "NotLaunchWindow", what);
    }
    assert_eq!(
        w.env.anchor::<Launch>(&k.launch).status,
        LaunchStatus::Configured
    );
    w.env.set_time(open);
    let keeper = w.env.funded(5);
    let kp = keeper.pubkey();
    let ixs = [
        ComputeBudgetInstruction::set_compute_unit_price(1_000),
        launch(&kp, &k, NAME, SYMBOL, URI),
    ];
    let sent = w
        .env
        .send_with(&kp, &ixs, &[&keeper, &mint], true)
        .expect_ok("a keeper launches as the window opens");
    println!(
        "launch by a keeper, with a priority fee: {} CU, {} bytes (limit {PACKET_DATA_SIZE})",
        sent.cu, sent.size
    );
    assert!(sent.size <= PACKET_DATA_SIZE);
    let cert: Certificate = w.env.anchor(&k.certificate);
    assert_eq!(
        (cert.creator, cert.launched_at, cert.checks),
        (c, open, checks::ALL)
    );
    let l: Launch = w.env.anchor(&k.launch);
    assert_eq!((l.status, l.launch_ts), (LaunchStatus::Live, open));

    // The window's end: its last second launches, the next does not.
    for (seed, offset, ok) in [([0x0C; 32], 60, true), ([0x0D; 32], 61, false)] {
        let (kx, mint_x) = create_another(&mut w, seed);
        let now = w.env.now();
        pq::attest_with(&mut w.env, &kx, META, Terms::window(now, now + 60));
        w.env.set_time(now + offset);
        let sent = w
            .env
            .send(&[launch(&kp, &kx, NAME, SYMBOL, URI)], &[&keeper, &mint_x]);
        if ok {
            sent.expect_ok("a launch in the window's last second");
        } else {
            sent.fails_with(
                code(E::NotLaunchWindow),
                "NotLaunchWindow",
                "a launch a second after the window",
            );
            assert_eq!(
                w.env.anchor::<Launch>(&kx.launch).status,
                LaunchStatus::Configured
            );
        }
    }
}

/// The review's fourth finding (low): any committer could name any PQ vault
/// of the mint as its token owner, so unrelated wallets, each at the
/// per-wallet cap, piled their hook-exempt batch shares into one vault
/// during a p2p-locked guard (62x max-wallet in the review's PoC). Now what
/// the commits naming a vault commit adds up in its
/// `["payout-vault", launch, vault]` account, held to `batch_wallet_cap` like
/// one wallet's own commit, so a vault receives no more than one wallet
/// could. (Without a per-wallet cap one wallet may commit anything, and so
/// may the commits naming a vault.) The account comes with every commit
/// naming a vault and with no other, and pre-funding its address blocks
/// nothing.
#[test]
fn review_a_payout_vault_receives_at_most_one_wallet_cap() {
    let cap = LAMPORTS_PER_SOL / 2;
    let mut w = launched_with(|p| p.batch_wallet_cap = cap);
    let k = w.k;
    let env = &mut w.env;
    let l: Launch = env.anchor(&k.launch);
    assert!(l.p2p_locked && l.batch_wallet_cap == cap);
    let carol = committer(env, cap);
    let cw = carol.pubkey();
    let vault = open_vault(env, &carol, &k.mint, &TOKEN_2022_PROGRAM_ID, "carol-tokens");
    let record_address = k.payout_vault(&vault.address);
    let mallory = env.funded(1);
    let fund = system_instruction::transfer(&mallory.pubkey(), &record_address, 1_000_000);
    env.send(&[fund], &[&mallory])
        .expect_ok("pre-fund the vault's record address");

    // Unrelated wallets name carol's vault: together up to the cap.
    let parts = [cap / 4, cap / 2, cap / 4];
    let wallets: Vec<Keypair> = parts.iter().map(|&p| committer(env, p + 1)).collect();
    for (wl, part) in wallets.iter().zip(parts) {
        let o = wl.pubkey();
        let sent = env
            .send(&[commit_to(&o, &k, part, &vault.address, &o)], &[wl])
            .expect_ok("a commit naming carol's vault");
        assert_eq!(one_event::<Committed>(&sent).token_owner, vault.address);
    }
    let record: PayoutVault = env.anchor(&record_address);
    assert_eq!(
        (
            record.version,
            record.launch,
            record.vault,
            record.committed
        ),
        (1, k.launch, vault.address, cap)
    );
    // Then no further, whoever commits: a top-up of a commit within its own
    // cap, and carol herself.
    let w0 = wallets[0].pubkey();
    env.send(
        &[commit_to(&w0, &k, 1, &vault.address, &w0)],
        &[&wallets[0]],
    )
    .fails_with(
        code(E::CapExceeded),
        "CapExceeded",
        "a top-up past the vault's cap",
    );
    env.send(&[commit_to(&cw, &k, 1, &vault.address, &cw)], &[&carol])
        .fails_with(
            code(E::CapExceeded),
            "CapExceeded",
            "carol naming her full vault",
        );
    env.send(&[commit(&cw, &k, cap)], &[&carol])
        .expect_ok("carol commits to her own wallet");

    // The record comes with a vault token owner, and with nothing else.
    let dave = committer(env, cap);
    let d = dave.pubkey();
    let dave_vault = open_vault(env, &dave, &k.mint, &TOKEN_2022_PROGRAM_ID, "dave-tokens");
    let with_record = commit_to(&d, &k, 1, &dave_vault.address, &d);
    let slot = with_record.accounts.len() - 1;
    assert_eq!(
        with_record.accounts[slot].pubkey,
        k.payout_vault(&dave_vault.address)
    );
    let mut ix = with_record.clone();
    ix.accounts[slot] = AccountMeta::new_readonly(noised_launchpad::ID, false);
    env.send(&[ix], &[&dave]).fails_with(
        code(E::InvalidPayoutOwner),
        "InvalidPayoutOwner",
        "a vault token owner without its record",
    );
    let mut ix = with_record.clone();
    ix.accounts[slot].pubkey = record_address;
    env.send(&[ix], &[&dave]).fails_with(
        CONSTRAINT_SEEDS,
        "ConstraintSeeds",
        "another vault's record",
    );
    let mut ix = commit(&d, &k, 1);
    assert_eq!(ix.accounts[slot].pubkey, noised_launchpad::ID);
    ix.accounts[slot] = AccountMeta::new(k.payout_vault(&d), false);
    env.send(&[ix], &[&dave]).fails_with(
        code(E::InvalidPayoutOwner),
        "InvalidPayoutOwner",
        "a record for the committer's own wallet",
    );
    assert!(env.account(&k.payout_vault(&d)).is_none());
    env.send(&[with_record], &[&dave])
        .expect_ok("dave names his own vault");

    // The batch: the vault holds at most what one capped commit buys.
    env.set_time(l.commit_end_ts);
    let payer = env.payer.pubkey();
    env.send(&[execute_batch(&payer, &k)], &[])
        .expect_ok("execute_batch");
    let l: Launch = env.anchor(&k.launch);
    for wl in &wallets {
        let o = wl.pubkey();
        env.send(
            &[claim_for(&payer, &k, &o, (&vault.address, &o), true, true)],
            &[],
        )
        .expect_ok("a claim into carol's vault");
    }
    let held = env.token_amount(&vault.token_account);
    let one_wallet =
        (u128::from(l.tokens_out) * u128::from(cap) / u128::from(l.total_committed)) as u64;
    assert!(held > 0 && held <= one_wallet, "{held} > {one_wallet}");
    let policy: HookPolicy = env.anchor(&k.policy);
    assert!(env.now() < policy.guard_end_ts);
    assert_escrow_invariants(env, &k);

    // Without a per-wallet cap the commits naming a vault add up freely, as
    // one wallet's commit may.
    let k2 = w.launch_another([0x0E; 32], |p| p.batch_wallet_cap = 0);
    let env = &mut w.env;
    let erin = committer(env, LAMPORTS_PER_SOL);
    let vault2 = open_vault(env, &erin, &k2.mint, &TOKEN_2022_PROGRAM_ID, "erin-tokens");
    for _ in 0..2 {
        let wl = committer(env, 2 * LAMPORTS_PER_SOL);
        let o = wl.pubkey();
        env.send(
            &[commit_to(
                &o,
                &k2,
                2 * LAMPORTS_PER_SOL,
                &vault2.address,
                &o,
            )],
            &[&wl],
        )
        .expect_ok("an uncapped commit naming erin's vault");
    }
    let record: PayoutVault = env.anchor(&k2.payout_vault(&vault2.address));
    assert_eq!(record.committed, 4 * LAMPORTS_PER_SOL);
}

/// A wallet with its own base-mint and wSOL vaults.
struct VaultOwner {
    wallet: Keypair,
    tokens: TestVault,
    refunds: TestVault,
}

fn vault_owner(env: &mut Env, k: &Keys, label: &str, lamports: u64) -> VaultOwner {
    let wallet = committer(env, lamports);
    let tokens = open_vault(
        env,
        &wallet,
        &k.mint,
        &TOKEN_2022_PROGRAM_ID,
        &format!("{label}-tokens"),
    );
    let refunds = open_vault(
        env,
        &wallet,
        &WSOL_MINT,
        &TOKEN_PROGRAM_ID,
        &format!("{label}-refunds"),
    );
    VaultOwner {
        wallet,
        tokens,
        refunds,
    }
}

/// A7: the first commit fixes the payout owners, the committer itself or
/// its PQ vaults (one per mint), and every claim, whoever cranks it, pays
/// exactly them, during the guard and with `p2p_locked` too (the batch
/// escrow is exempt). A vault of the other mint, an arbitrary wallet and a
/// later change are refused, and neither a third party nor the committer's
/// own Ed25519 key can redirect a share. What the commits naming a vault
/// commit adds up in its `["payout-vault", launch, vault]` account. Tokens
/// claimed into a vault leave it only with the vault's hash-based
/// signature, and the guard still applies to that transfer: refused while
/// transfers are locked, delivered after the guard.
#[test]
fn a7_payouts_go_to_the_owners_fixed_at_the_first_commit() {
    let cap = LAMPORTS_PER_SOL;
    let mut w = launched_with(|p| p.batch_total_cap = cap);
    let k = w.k;
    let env = &mut w.env;
    let l: Launch = env.anchor(&k.launch);
    assert!(l.p2p_locked && l.batch_total_cap == l.migration_quote_threshold / 10);
    let alice = vault_owner(env, &k, "alice", 2 * LAMPORTS_PER_SOL);
    let a = alice.wallet.pubkey();
    let (av_t, av_r) = (alice.tokens.address, alice.refunds.address);
    let bob = committer(env, LAMPORTS_PER_SOL);
    let b = bob.pubkey();
    let carol = vault_owner(env, &k, "carol", LAMPORTS_PER_SOL);
    let cw = carol.wallet.pubkey();
    let stranger = Keypair::new().pubkey();

    for (what, token_owner, refund_owner) in [
        ("an arbitrary wallet for the tokens", stranger, a),
        ("an arbitrary wallet for the refund", a, stranger),
        ("another committer's wallet", b, a),
        ("a wSOL vault for the tokens", av_r, av_r),
        ("a base-mint vault for the refund", av_t, av_t),
        ("the two vaults swapped", av_r, av_t),
        (
            "another wallet's vault of the wrong mint",
            carol.refunds.address,
            a,
        ),
    ] {
        env.send(
            &[commit_to(
                &a,
                &k,
                LAMPORTS_PER_SOL,
                &token_owner,
                &refund_owner,
            )],
            &[&alice.wallet],
        )
        .fails_with(code(E::InvalidPayoutOwner), "InvalidPayoutOwner", what);
    }
    assert!(env.account(&k.commit(&a)).is_none());

    let sent = env
        .send(
            &[commit_to(&a, &k, LAMPORTS_PER_SOL, &av_t, &av_r)],
            &[&alice.wallet],
        )
        .expect_ok("alice commits into her vaults");
    println!(
        "commit naming two PQ vaults as payout owners: {} CU, {} bytes",
        sent.cu, sent.size
    );
    let e: Committed = one_event(&sent);
    assert_eq!((e.owner, e.token_owner, e.refund_owner), (a, av_t, av_r));
    let commit_a: Commit = env.anchor(&k.commit(&a));
    assert_eq!(
        (
            commit_a.version,
            commit_a.owner,
            commit_a.token_owner,
            commit_a.refund_owner
        ),
        (2, a, av_t, av_r)
    );
    let record: PayoutVault = env.anchor(&k.payout_vault(&av_t));
    assert_eq!(
        (
            record.version,
            record.launch,
            record.vault,
            record.committed
        ),
        (1, k.launch, av_t, LAMPORTS_PER_SOL)
    );
    // The refund vault (wSOL: no Launch Guard) has no record.
    assert!(env.account(&k.payout_vault(&av_r)).is_none());
    for (what, token_owner, refund_owner) in [
        ("back to her wallet", a, a),
        ("her wallet for the refund", av_t, a),
        ("her wallet for the tokens", a, av_r),
    ] {
        env.send(
            &[commit_to(&a, &k, 1, &token_owner, &refund_owner)],
            &[&alice.wallet],
        )
        .fails_with(code(E::InvalidPayoutOwner), "InvalidPayoutOwner", what);
    }
    env.send(
        &[commit_to(&a, &k, LAMPORTS_PER_SOL, &av_t, &av_r)],
        &[&alice.wallet],
    )
    .expect_ok("alice tops up with the same owners");
    let record: PayoutVault = env.anchor(&k.payout_vault(&av_t));
    assert_eq!(record.committed, 2 * LAMPORTS_PER_SOL);
    env.send(&[commit(&b, &k, LAMPORTS_PER_SOL)], &[&bob])
        .expect_ok("bob commits to himself");
    env.send(
        &[commit_to(
            &cw,
            &k,
            LAMPORTS_PER_SOL,
            &carol.tokens.address,
            &cw,
        )],
        &[&carol.wallet],
    )
    .expect_ok("carol: tokens to her vault, refund to her wallet");

    // Oversubscribed 4x: everyone gets tokens and most of the wSOL back.
    env.set_time(l.commit_end_ts);
    let payer = env.payer.pubkey();
    env.send(&[execute_batch(&payer, &k)], &[])
        .expect_ok("execute_batch");
    let l: Launch = env.anchor(&k.launch);
    assert_eq!((l.total_committed, l.quote_spent), (4 * cap, cap));
    let share = |c: u64| {
        let total = u128::from(l.total_committed);
        (
            (u128::from(l.tokens_out) * u128::from(c) / total) as u64,
            (u128::from(l.total_committed - l.quote_spent) * u128::from(c) / total) as u64,
        )
    };

    // Mallory cranks alice's claim: only the recorded owners are accepted.
    let mallory = env.funded(1);
    let m = mallory.pubkey();
    for (what, owners) in [
        ("mallory's own wallets", (m, m)),
        ("alice's wallet (her Ed25519 key)", (a, a)),
        ("alice's wallet for the tokens", (a, av_r)),
        ("alice's wallet for the refund", (av_t, a)),
    ] {
        env.send(
            &[claim_for(&m, &k, &a, (&owners.0, &owners.1), true, true)],
            &[&mallory],
        )
        .fails_with(code(E::InvalidPayoutOwner), "InvalidPayoutOwner", what);
    }
    // The right owners with another ATA in a slot.
    env.send(
        &[claim_slots(
            &m,
            &k,
            &a,
            (&av_t, &av_r),
            Some(wsol_ata(&a)),
            Some(alice.tokens.token_account),
            Some(base_ata(&k.batch_authority, &k.mint)),
            true,
        )],
        &[&mallory],
    )
    .fails_with(
        code(E::InvalidRecipientAccounts),
        "InvalidRecipientAccounts",
        "alice's own wSOL ATA as the refund destination",
    );
    assert!(l.guard_end_ts > env.now(), "inside the guard");
    let sent = env
        .send(
            &[claim_for(&m, &k, &a, (&av_t, &av_r), true, true)],
            &[&mallory],
        )
        .expect_ok("mallory cranks alice's claim into her vaults");
    println!(
        "claim into two PQ vaults, cranked by a third party: {} CU, {} bytes",
        sent.cu, sent.size
    );
    let (tokens, refund) = share(2 * LAMPORTS_PER_SOL);
    assert!(tokens > 0 && refund > 0);
    assert_eq!(env.token_amount(&alice.tokens.token_account), tokens);
    assert_eq!(env.token_amount(&alice.refunds.token_account), refund);
    assert!(env.account(&base_ata(&a, &k.mint)).is_none());
    let e: BatchClaimed = one_event(&sent);
    assert_eq!(
        (e.owner, e.token_owner, e.refund_owner, e.tokens, e.refund),
        (a, av_t, av_r, tokens, refund)
    );
    let wsol_before = env.token_amount(&wsol_ata(&cw));
    env.send(
        &[claim_for(
            &payer,
            &k,
            &cw,
            (&carol.tokens.address, &cw),
            true,
            true,
        )],
        &[],
    )
    .expect_ok("carol's claim");
    let (tokens_c, refund_c) = share(LAMPORTS_PER_SOL);
    assert_eq!(env.token_amount(&carol.tokens.token_account), tokens_c);
    assert_eq!(env.token_amount(&wsol_ata(&cw)) - wsol_before, refund_c);
    env.send(&[claim(&payer, &k, &b, true, true)], &[])
        .expect_ok("bob's claim");
    assert_eq!(env.token_amount(&base_ata(&b, &k.mint)), tokens_c);
    assert_escrow_invariants(env, &k);

    // Out of the vault: the vault's hash-based signature reserves a payout to
    // alice's wallet (a relayer sends it), and the guard refuses its delivery
    // while wallet-to-wallet transfers are locked, then delivers it.
    let relayer = env.funded(1);
    let withdraw = alice.tokens.withdraw_ix(&relayer.pubkey(), &a, tokens);
    let config = solana_message::v1::TransactionConfig::empty()
        .with_compute_unit_limit(400_000)
        .with_loaded_accounts_data_size_limit(4 * 1024 * 1024);
    env.send_v1(&relayer, &[withdraw], &[], config)
        .expect_ok("the vault's signed withdrawal");
    let release = |env: &Env| {
        alice.tokens.release_ix(
            &env.payer.pubkey(),
            0,
            &relayer.pubkey(),
            &a,
            k.hook_metas(),
        )
    };
    let ix = release(env);
    env.send(&[ix], &[]).fails_with(
        hook_code(HookError::TransfersLocked),
        "TransfersLocked",
        "a vault release during a locked guard",
    );
    env.set_time(l.guard_end_ts);
    let ix = release(env);
    env.send(&[ix], &[])
        .expect_ok("the release after the guard");
    assert_eq!(env.token_amount(&base_ata(&a, &k.mint)), tokens);
    assert_eq!(env.token_amount(&alice.tokens.token_account), 0);
}

/// A7: an expired batch refunds each commit in full to its recorded refund
/// owner, here a wSOL vault, whose token account then holds it.
#[test]
fn a7_an_expired_batch_refunds_into_a_wsol_vault() {
    let mut w = launched();
    let k = w.k;
    let env = &mut w.env;
    let l: Launch = env.anchor(&k.launch);
    let alice = committer(env, 700_000_001);
    let a = alice.pubkey();
    let refunds = open_vault(env, &alice, &WSOL_MINT, &TOKEN_PROGRAM_ID, "alice-refunds");
    env.send(
        &[commit_to(&a, &k, 700_000_001, &a, &refunds.address)],
        &[&alice],
    )
    .expect_ok("commit with a wSOL vault as refund owner");
    env.set_time(l.execute_end_ts);
    let payer = env.payer.pubkey();
    env.send(&[execute_batch(&payer, &k)], &[]).fails_with(
        code(E::NotExecuteWindow),
        "NotExecuteWindow",
        "the batch expired",
    );
    let wallet_wsol = env.token_amount(&wsol_ata(&a));
    env.send(&[claim(&payer, &k, &a, false, false)], &[])
        .fails_with(
            code(E::InvalidPayoutOwner),
            "InvalidPayoutOwner",
            "a refund to alice's wallet",
        );
    let sent = env
        .send(
            &[claim_for(
                &payer,
                &k,
                &a,
                (&a, &refunds.address),
                false,
                false,
            )],
            &[],
        )
        .expect_ok("the refund into the vault");
    assert_eq!(env.token_amount(&refunds.token_account), 700_000_001);
    assert_eq!(env.token_amount(&wsol_ata(&a)), wallet_wsol);
    let e: BatchClaimed = one_event(&sent);
    assert!(e.expired && e.refund == 700_000_001 && e.refund_owner == refunds.address);
    assert_escrow_invariants(env, &k);
}

/// A8: the treasury is an existing PQ vault of wSOL, recognized by its
/// owner program, `Vault` discriminator, version and mint. A plain wallet,
/// a vault of another mint, look-alike bytes under another owner and an
/// older vault version are refused; the platform share then lands in the
/// vault's own token account (its canonical wSOL ATA).
#[test]
fn a8_the_treasury_must_be_a_wsol_pq_vault() {
    let mut env = Env::new();
    let admin = env.funded(5);
    env.set_upgrade_authority(&noised_launchpad::ID, &admin.pubkey());
    let vault = open_vault(&mut env, &admin, &WSOL_MINT, &TOKEN_PROGRAM_ID, "treasury");
    assert_eq!(vault.token_account, wsol_ata(&vault.address));
    let vault_data = env.account(&vault.address).unwrap().data;

    let fake = |env: &mut Env, owner: Pubkey, edit: &dyn Fn(&mut Vec<u8>)| {
        let mut data = vault_data.clone();
        edit(&mut data);
        let address = Pubkey::new_unique();
        let lamports = env.svm.minimum_balance_for_rent_exemption(data.len());
        env.svm
            .set_account(
                address,
                Account {
                    lamports,
                    data,
                    owner,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        address
    };
    let other_mint = fake(&mut env, noised_vault::ID, &|d| d[10..42].fill(7));
    let look_alike = fake(&mut env, noised_launchpad::ID, &|_| {});
    let older = fake(&mut env, noised_vault::ID, &|d| d[8] = 3);
    let wallet = Keypair::new().pubkey();
    env.airdrop(&wallet, LAMPORTS_PER_SOL);
    for (what, treasury, fee) in [
        ("a plain wallet", wallet, 2_000),
        ("a vault of another mint", other_mint, 2_000),
        ("vault bytes under another program", look_alike, 2_000),
        ("a vault of version 3", older, 2_000),
        (
            "a fee over the maximum",
            vault.address,
            MAX_PLATFORM_FEE_BPS + 1,
        ),
    ] {
        env.send(
            &[initialize_protocol(&admin.pubkey(), treasury, fee)],
            &[&admin],
        )
        .fails_with(
            code(E::InvalidProtocolParams),
            "InvalidProtocolParams",
            what,
        );
    }
    env.send(
        &[initialize_protocol(&admin.pubkey(), vault.address, 2_000)],
        &[&admin],
    )
    .expect_ok("a wSOL vault treasury");
    let protocol: Protocol = env.anchor(&protocol());
    assert_eq!(
        (protocol.treasury, protocol.platform_fee_bps),
        (vault.address, 2_000)
    );
}

/// PQ v2 §1.4c with A8: a creator's fee recipient may be a PQ vault of
/// wSOL. `distribute` pays each recipient's canonical wSOL ATA, which for a
/// vault is the token account `open_vault` created, so the creator's share
/// lands in post-quantum custody, next to the treasury's. (Recipients cannot
/// be checked on-chain without overflowing the legacy `create_launch`; the
/// SDK refuses vaults of other mints and unopened off-curve addresses.)
#[test]
fn a8_creator_fees_land_in_a_wsol_vault_recipient() {
    let label = "creator-fees";
    let fee_vault = vault_address(&WSOL_MINT, label);
    let mut w = launched_with(|p| p.recipients[0].wallet = fee_vault);
    let k = w.k;
    let creator = w.creator.insecure_clone();
    let recipients = [w.params.recipients[0].wallet, w.params.recipients[1].wallet];
    assert_eq!(recipients[0], fee_vault);
    let treasury = w.treasury;
    let env = &mut w.env;
    let vault = open_vault(env, &creator, &WSOL_MINT, &TOKEN_PROGRAM_ID, label);
    assert_eq!(vault.address, fee_vault);
    assert_eq!(vault.token_account, wsol_ata(&fee_vault));

    // The batch pays the floor fee; claim it and route it.
    for _ in 0..2 {
        let who = committer(env, 2 * LAMPORTS_PER_SOL);
        env.send(&[commit(&who.pubkey(), &k, 2 * LAMPORTS_PER_SOL)], &[&who])
            .expect_ok("commit");
    }
    let l: Launch = env.anchor(&k.launch);
    env.set_time(l.commit_end_ts);
    let payer = env.payer.pubkey();
    env.send(&[execute_batch(&payer, &k)], &[])
        .expect_ok("execute_batch");
    env.send(&[claim_fees(&payer, &k)], &[])
        .expect_ok("claim_fees");
    let fees = env.token_amount(&wsol_ata(&k.launch_authority));
    assert!(fees > 0);
    let sent = env
        .send(&[distribute(&payer, &k, &treasury, &recipients)], &[])
        .expect_ok("distribute");
    println!(
        "distribute into PQ vaults (treasury and a recipient): {} CU, {} bytes",
        sent.cu, sent.size
    );
    let platform = fees * 2_000 / 10_000;
    let to_vault = (fees - platform) * 7_000 / 10_000;
    assert_eq!(env.token_amount(&vault.token_account), to_vault);
    assert_eq!(
        env.token_amount(&wsol_ata(&recipients[1])),
        fees - platform - to_vault
    );
    assert_eq!(env.token_amount(&wsol_ata(&treasury)), platform);
}

/// A15 (PQ v2 §1.4a): what a buyer buys can land straight in its PQ vault.
/// DBC's `swap2_with_transfer_hook` and, after graduation, DAMM v2's `swap`
/// pay any token account of the mint, and a vault's token account (its
/// canonical ATA) is one: the buyer's wallet signs and pays the wSOL, the
/// vault never signs. While the Launch Guard runs it treats such a buy like
/// any other: refused during the snipe shield, then capped per buy
/// (max-buy) and on the vault's balance (max-wallet: vaults are not exempt,
/// anyone can open one). After graduation the hook is gone and a DAMM v2
/// buy pays the vault without caps. The tokens leave the vault only with its
/// hash-based signature (during a locked guard not even then: see
/// `a7_payouts_go_to_the_owners_fixed_at_the_first_commit`).
#[test]
fn a15_buys_land_straight_in_a_pq_vault_under_the_guard_caps() {
    let mut w = launched();
    let k = w.k;
    let env = &mut w.env;
    let payer = env.payer.pubkey();
    let l: Launch = env.anchor(&k.launch);
    let policy: HookPolicy = env.anchor(&k.policy);
    assert!(policy.max_buy > 0 && policy.max_wallet >= 2 * policy.max_buy);
    let dave = committer(env, 5 * LAMPORTS_PER_SOL);
    let d = dave.pubkey();
    let vault = open_vault(env, &dave, &k.mint, &TOKEN_2022_PROGRAM_ID, "dave-buys");
    assert_eq!(vault.token_account, base_ata(&vault.address, &k.mint));
    let into_vault = |lamports: u64| dbc_buy_into(&d, &k, vault.token_account, lamports);
    let small = LAMPORTS_PER_SOL / 200;

    // The snipe shield holds for buys into a vault too, until the batch.
    let alice = committer(env, 2 * LAMPORTS_PER_SOL);
    env.send(
        &[commit(&alice.pubkey(), &k, 2 * LAMPORTS_PER_SOL)],
        &[&alice],
    )
    .expect_ok("alice commits");
    for (at, what) in [
        (l.launch_ts, "a buy into a vault as the launch opens"),
        (l.commit_end_ts, "a buy into a vault right before the batch"),
    ] {
        env.set_time(at);
        env.send(&[into_vault(small)], &[&dave]).fails_with(
            hook_code(HookError::SnipeShield),
            "SnipeShield",
            what,
        );
    }
    env.send(&[execute_batch(&payer, &k)], &[])
        .expect_ok("execute_batch");

    // Then it lands: dave signs and pays, the vault's token account receives.
    let wsol = env.token_amount(&wsol_ata(&d));
    let sent = env
        .send(&[into_vault(small)], &[&dave])
        .expect_ok("a DBC buy into the vault");
    println!(
        "DBC buy into a PQ vault: {} CU, {} bytes",
        sent.cu, sent.size
    );
    assert_eq!(wsol - env.token_amount(&wsol_ata(&d)), small);
    assert!(env.token_amount(&vault.token_account) > 0);
    assert!(env.account(&base_ata(&d, &k.mint)).is_none());
    // Max-buy caps each buy ...
    env.send(&[into_vault(LAMPORTS_PER_SOL)], &[&dave])
        .fails_with(
            hook_code(HookError::MaxBuy),
            "MaxBuy",
            "an oversized buy into the vault",
        );
    // ... and max-wallet the vault's balance: buys worth under 40% of
    // max-buy each (at the current spot price, which buys only raise)
    // accumulate there until one would pass the cap.
    let pool = env.anchor::<TransferHookPool>(&k.pool).pool_state;
    let lamports_per_unit = (pool.sqrt_price as f64 / 2f64.powi(64)).powi(2);
    let step = (policy.max_buy as f64 * 0.4 * lamports_per_unit) as u64;
    let mut buys = 0;
    let held = loop {
        let held = env.token_amount(&vault.token_account);
        let bought = env.send(&[into_vault(step)], &[&dave]);
        if bought.is_err() {
            bought.fails_with(
                hook_code(HookError::MaxWallet),
                "MaxWallet",
                "a buy past the vault's max-wallet cap",
            );
            break held;
        }
        let got = env.token_amount(&vault.token_account) - held;
        assert!(got > 0 && got < policy.max_buy * 2 / 5, "{got} base units");
        buys += 1;
        assert!(buys < 20, "max-wallet never reached");
    };
    assert!(buys >= 3, "{buys} buys");
    assert!(held <= policy.max_wallet && held + policy.max_buy * 2 / 5 > policy.max_wallet);
    println!(
        "DBC buys into a PQ vault: {buys} of {step} lamports each, then max-wallet at {held} of {} base units",
        policy.max_wallet
    );
    // The cap is the vault account's: the same buy into another account passes.
    let erin = buyer(env, &k);
    env.send(&[dbc_swap(&erin.pubkey(), &k, true, step)], &[&erin])
        .expect_ok("the same buy into another account");

    // After the guard nothing caps buys: one completes the curve, and DBC
    // revokes the hook. Anyone migrates to DAMM v2, whose swap pays the
    // vault's token account just the same.
    env.set_time(l.guard_end_ts);
    let carol = committer(env, 20 * LAMPORTS_PER_SOL);
    let c = carol.pubkey();
    env.send(
        &[create_ata(&c, &c, &k.mint, &TOKEN_2022_PROGRAM_ID)],
        &[&carol],
    )
    .expect_ok("carol's base ATA");
    env.send(
        &[dbc_swap_mode(
            &c,
            &k,
            true,
            20 * LAMPORTS_PER_SOL,
            dbc::SWAP_MODE_PARTIAL_FILL,
            true,
        )],
        &[&carol],
    )
    .expect_ok("a buy completing the curve");
    let pool = env.anchor::<TransferHookPool>(&k.pool).pool_state;
    assert!(pool.quote_reserve >= l.migration_quote_threshold);
    let (damm, _, _) = migrate_to_damm_v2(env, &k);
    let sent = env
        .send(
            &[damm_buy_into(
                &d,
                &k,
                &damm,
                vault.token_account,
                LAMPORTS_PER_SOL / 2,
            )],
            &[&dave],
        )
        .expect_ok("a DAMM v2 buy into the vault");
    println!(
        "DAMM v2 buy into a PQ vault: {} CU, {} bytes",
        sent.cu, sent.size
    );
    let in_vault = env.token_amount(&vault.token_account);
    assert!(in_vault > held, "{in_vault} after the DAMM v2 buy");
    assert!(env.account(&base_ata(&d, &k.mint)).is_none());

    // Out of the vault only with its hash-based signature: a relayer lands
    // the vault's signed withdrawal to dave's wallet, then anyone releases it
    // (no hook accounts once DBC revoked the hook).
    let relayer = env.funded(1);
    let withdraw = vault.withdraw_ix(&relayer.pubkey(), &d, in_vault);
    let config = solana_message::v1::TransactionConfig::empty()
        .with_compute_unit_limit(400_000)
        .with_loaded_accounts_data_size_limit(4 * 1024 * 1024);
    env.send_v1(&relayer, &[withdraw], &[], config)
        .expect_ok("the vault's signed withdrawal");
    let release = vault.release_ix(&payer, 0, &relayer.pubkey(), &d, vec![]);
    env.send(&[release], &[])
        .expect_ok("the release after graduation");
    assert_eq!(env.token_amount(&base_ata(&d, &k.mint)), in_vault);
    assert_eq!(env.token_amount(&vault.token_account), 0);
}

/// The identity's account starts with the documented layout (the SDK reads
/// the bitmap from it): discriminator, version, bump, key, bitmap, count.
#[test]
fn identity_account_layout_on_chain() {
    let mut w = created_with(|_| {});
    let k = w.k;
    pq::attest(&mut w.env, &k, META);
    let id: Identity = w.env.anchor(&pq::identity_pda(&pq::identity_id()));
    let raw = w
        .env
        .account(&pq::identity_pda(&pq::identity_id()))
        .unwrap()
        .data;
    let mut expect = Vec::new();
    id.try_serialize(&mut expect).unwrap();
    assert_eq!(raw, expect);
    assert_eq!(&raw[10..66], &pq::public_key(pq::identity())[..]);
    let q = w.env.anchor::<Attestation>(&k.attestation).leaf;
    assert_eq!(raw[66 + usize::from(q >> 3)], 1 << (q & 7));
    assert_eq!(&raw[194..196], &1u16.to_le_bytes());
}

//! PQ v2: the attestation message (version 3, with the rules hash) and the
//! metadata record's hash, the launch window an attestation must meet, the identity's leaf
//! bitmap, PQ vault recognition, account layouts and an LMS round trip
//! through the same verifier the program runs.

use std::sync::OnceLock;

use anchor_lang::{prelude::*, AccountSerialize, Discriminator, Event, InstructionData};
use noised_lmots::{
    identity_id, lms_verify, LmsKeyPair, LmsPrivateKey, Sha2, Sha256, LMS_LEAVES,
    LMS_PUBLIC_KEY_LEN, LMS_SIG_LEN,
};

use super::{good_params, key};
use crate::{
    constants::{
        pq_vault, MAX_LAUNCH_LEAD_SECS, MAX_LAUNCH_WINDOW_SECS, MIN_LAUNCH_WINDOW_SECS, WSOL_MINT,
    },
    error::LaunchpadError,
    events::{LaunchAttested, MetadataPublished, PqLeafConsumed},
    pq::{
        attestation_message, in_launch_window, is_payout_owner, is_vault_of,
        launch_window_is_valid, leaf_bit, mark_leaf_used, metadata_hash_v2, AttestedTerms,
        SolSha256, ATTEST_MESSAGE_LEN, ATTEST_MESSAGE_TAG, METADATA_HASH_TAG,
    },
    state::{
        Attestation, Certificate, Commit, Identity, Launch, PayoutVault, TokenMeta, LEAF_BITMAP_LEN,
    },
};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// One LMS identity for this test binary (a key generation is about 1.14
/// million SHA-256 compressions).
pub(super) fn identity() -> &'static LmsKeyPair {
    static KEY: OnceLock<LmsKeyPair> = OnceLock::new();
    KEY.get_or_init(|| {
        LmsPrivateKey {
            seed: [0x5E; 32],
            id: [0x1D; 16],
        }
        .keygen::<Sha2>()
    })
}

/// Signed terms with this metadata hash, no rules and a one-hour window.
fn terms(metadata_hash: [u8; 32]) -> AttestedTerms {
    AttestedTerms {
        metadata_hash,
        rules_hash: [0; 32],
        not_before: 1_767_225_600,
        not_after: 1_767_225_600 + 3_600,
    }
}

/// `metadata_hash_v2` of a record with no uri and no document.
fn record_hash(name: &[u8], symbol: &[u8]) -> [u8; 32] {
    metadata_hash_v2(name, symbol, 0, b"", b"")
}

#[test]
fn attestation_message_is_the_tag_then_the_launch_and_its_terms() {
    let (program, launch, creator) = (key(1), key(2), key(3));
    let signed = AttestedTerms {
        metadata_hash: [5; 32],
        rules_hash: [6; 32],
        not_before: 0x0102_0304_0506_0708,
        not_after: -2,
    };
    let m = attestation_message(&program, &launch, &[4; 32], &creator, &signed);
    assert_eq!(m.len(), 221);
    assert_eq!(ATTEST_MESSAGE_LEN, 221);
    assert_eq!(&m[..13], b"PHX-ATTEST-V3");
    assert_eq!(ATTEST_MESSAGE_TAG, b"PHX-ATTEST-V3");
    let mut want = b"PHX-ATTEST-V3".to_vec();
    for field in [[1u8; 32], [2; 32], [4; 32], [3; 32], [5; 32], [6; 32]] {
        want.extend_from_slice(&field);
    }
    want.extend_from_slice(&0x0102_0304_0506_0708i64.to_le_bytes());
    want.extend_from_slice(&(-2i64).to_le_bytes());
    assert_eq!(m.to_vec(), want);
    // Every byte of every field reaches the message, at its own position.
    for at in 13..221 {
        let mut bytes = want.clone();
        bytes[at] ^= 0x80;
        let field = |i: usize| -> [u8; 32] { bytes[13 + 32 * i..45 + 32 * i].try_into().unwrap() };
        let word = |i: usize| -> i64 {
            i64::from_le_bytes(bytes[205 + 8 * i..213 + 8 * i].try_into().unwrap())
        };
        let other = attestation_message(
            &Pubkey::new_from_array(field(0)),
            &Pubkey::new_from_array(field(1)),
            &field(2),
            &Pubkey::new_from_array(field(3)),
            &AttestedTerms {
                metadata_hash: field(4),
                rules_hash: field(5),
                not_before: word(0),
                not_after: word(1),
            },
        );
        let changed: Vec<usize> = (0..221).filter(|&i| other[i] != m[i]).collect();
        assert_eq!(changed, [at]);
    }
}

/// `SHA256("PHX-META-V2" || borsh(name) || borsh(symbol) || flags ||
/// borsh(uri) || borsh(doc))`: the tag, then a `TokenMeta`'s content in its
/// borsh field order, against Anchor's borsh, an independent SHA-256 and
/// known answers computed with Python's hashlib.
#[test]
fn metadata_hash_v2_is_the_tag_then_the_borsh_record() {
    assert_eq!(METADATA_HASH_TAG, b"PHX-META-V2");
    // Test data kept from the original name: the known answers below are pinned (Python's hashlib).
    let cases = [
        (
            "Phalanx",
            "PHX",
            0u8,
            "",
            "",
            "7594122f7254284cdf3b59c40495b30b805642e82d729c853ecffce40cdd1f98",
        ),
        (
            "a",
            "b",
            1,
            "",
            r#"{"name":"a"}"#,
            "5f22f96ea4f8580ad8d585f966641fb22b252cf4f535007bfefcc8960de47aba",
        ),
        (
            "Phalanx",
            "PHX",
            2,
            "https://phalanx.example/phx.json",
            "",
            "3f423d06480b67479c4091ba793b428fa7032a9843ce76bec7c74f5cfb3da7c1",
        ),
    ];
    for (name, symbol, flags, uri, doc, known) in cases {
        let mut borsh = Vec::new();
        (
            name.to_string(),
            symbol.to_string(),
            flags,
            uri.to_string(),
            doc.to_string(),
        )
            .serialize(&mut borsh)
            .unwrap();
        let independent = Sha2::hashv(&[METADATA_HASH_TAG, &borsh]);
        assert_eq!(
            metadata_hash_v2(
                name.as_bytes(),
                symbol.as_bytes(),
                flags,
                uri.as_bytes(),
                doc.as_bytes()
            ),
            independent
        );
        assert_eq!(hex(&independent), known);
    }
    // The length prefixes and the flags byte keep the fields apart.
    let h = metadata_hash_v2(b"ab", b"c", 0, b"", b"d");
    assert_ne!(h, metadata_hash_v2(b"a", b"bc", 0, b"", b"d"));
    assert_ne!(h, metadata_hash_v2(b"ab", b"", 0, b"c", b"d"));
    assert_ne!(h, metadata_hash_v2(b"ab", b"c", 0, b"d", b""));
    assert_ne!(h, metadata_hash_v2(b"ab", b"c", 1, b"", b"d"));
    assert_ne!(h, metadata_hash_v2(b"ab", b"c", 2, b"", b"d"));
    assert_ne!(h, metadata_hash_v2(b"ab", b"c", 0, b"", b"d "));
    // Version 1 hashed name, symbol and uri under another tag: no record
    // hash equals a version-1 hash of the same strings.
    let v1 = Sha2::hashv(&[
        b"PHX-META-V1",
        &2u32.to_le_bytes(),
        b"ab",
        &1u32.to_le_bytes(),
        b"c",
        &0u32.to_le_bytes(),
    ]);
    assert_ne!(v1, metadata_hash_v2(b"ab", b"c", 0, b"", b""));
}

/// The launch window an attestation may fix: one minute to one hour long,
/// opening at most a week ahead, with at least a minute of it left when the
/// attestation lands (audit 3: a late or held landing fixed a window with
/// no time left); anything else (a pair given in milliseconds, a swapped
/// pair) only burns the leaf. `launch` runs from `not_before` to
/// `not_after`, both included. No input overflows.
#[test]
fn launch_window_bounds_hold_at_every_edge() {
    assert_eq!(
        (
            MIN_LAUNCH_WINDOW_SECS,
            MAX_LAUNCH_WINDOW_SECS,
            MAX_LAUNCH_LEAD_SECS
        ),
        (60, 3_600, 604_800)
    );
    let now = 1_767_225_600i64;
    let valid = |start: i64, end: i64| launch_window_is_valid(now, start, end);
    assert!(valid(now, now + 60));
    assert!(valid(now, now + 3_600));
    assert!(!valid(now, now + 59), "59 s");
    assert!(!valid(now, now + 3_601), "an hour and a second");
    assert!(!valid(now + 60, now), "swapped");
    assert!(!valid(now, now), "empty");
    // Opened already: valid while at least a minute of it is left.
    assert!(valid(now - 3_000, now + 600));
    assert!(valid(now - 3_540, now + 60), "exactly a minute left");
    assert!(
        valid(now - 1, now + 60),
        "a minute left, opened a second ago"
    );
    assert!(!valid(now - 3_541, now + 59), "59 s left");
    assert!(!valid(now - 1, now + 59), "a minute long, 59 s left");
    assert!(!valid(now - 60, now), "ends now");
    assert!(!valid(now - 30, now + 30), "30 s left");
    assert!(!valid(now - 61, now - 1), "over a second ago");
    // Not open yet: the whole window is left (at least a minute).
    assert!(valid(now + 1, now + 61));
    assert!(valid(now + 600, now + 660));
    // Opens at most a week ahead.
    assert!(valid(now + 604_800, now + 604_860));
    assert!(
        !valid(now + 604_801, now + 604_861),
        "a week and a second ahead"
    );
    // Milliseconds instead of seconds.
    let ms = now * 1_000;
    assert!(!valid(ms, ms + 3_600_000));
    assert!(!valid(ms, ms + 3_600));
    assert!(!valid(now, ms));
    // Extremes do not overflow.
    for (a, b) in [
        (i64::MIN, i64::MAX),
        (i64::MAX, i64::MIN),
        (i64::MAX - 59, i64::MAX),
        (i64::MIN, i64::MIN + 60),
    ] {
        assert!(!valid(a, b), "{a}..{b}");
    }
    assert!(launch_window_is_valid(
        i64::MAX - 100,
        i64::MAX - 70,
        i64::MAX
    ));
    assert!(launch_window_is_valid(
        i64::MAX - 60,
        i64::MAX - 3_600,
        i64::MAX
    ));
    assert!(!launch_window_is_valid(
        i64::MAX - 59,
        i64::MAX - 3_600,
        i64::MAX
    ));
    assert!(!launch_window_is_valid(i64::MAX, i64::MAX - 60, i64::MAX));
    assert!(launch_window_is_valid(i64::MIN, i64::MIN, i64::MIN + 60));
    // `launch`: inclusive at both ends.
    assert!(in_launch_window(now, now, now + 60));
    assert!(in_launch_window(now + 60, now, now + 60));
    assert!(!in_launch_window(now - 1, now, now + 60));
    assert!(!in_launch_window(now + 61, now, now + 60));
    assert!(in_launch_window(i64::MAX, i64::MAX - 60, i64::MAX));
}

/// `launch_window_is_valid` is exactly: length within bounds, opening at
/// most a week ahead, and `max(now, not_before) + 60 <= not_after`, around
/// every boundary and at random; so every window it accepts still opens for
/// at least a minute after the landing (`in_launch_window` holds for 60
/// seconds from `max(now, not_before)`).
#[test]
fn launch_window_leaves_a_minute_at_every_landing() {
    let reference = |now: i64, nb: i64, na: i64| {
        let (now, nb, na) = (i128::from(now), i128::from(nb), i128::from(na));
        (60..=3_600).contains(&(na - nb)) && nb.max(now) + 60 <= na && nb <= now + 604_800
    };
    let t = 1_767_225_600i64;
    let mut cases = 0;
    for len in [-1, 0, 59, 60, 61, 1_800, 3_599, 3_600, 3_601] {
        for open in [
            -3_601, -3_600, -3_541, -3_540, -3_000, -61, -60, -59, -1, 0, 1, 59, 60, 604_799,
            604_800, 604_801,
        ] {
            let (nb, na) = (t + open, t + open + len);
            let valid = launch_window_is_valid(t, nb, na);
            assert_eq!(valid, reference(t, nb, na), "open {open} len {len}");
            if valid {
                let from = nb.max(t);
                assert!((from..=from + 60).all(|s| in_launch_window(s, nb, na)));
            }
            cases += 1;
        }
    }
    let mut r = super::Lcg(31);
    for _ in 0..200_000 {
        let now = t + (r.below(4_000_000) as i64) - 2_000_000;
        let nb = now + (r.below(1_300_000) as i64) - 650_000;
        let na = nb + (r.below(3_800) as i64) - 100;
        assert_eq!(
            launch_window_is_valid(now, nb, na),
            reference(now, nb, na),
            "{now} {nb} {na}"
        );
        cases += 1;
    }
    assert!(cases > 200_000);
}

#[test]
fn leaf_bitmap_is_least_significant_bit_first() {
    assert_eq!(LEAF_BITMAP_LEN, 128);
    assert_eq!(leaf_bit(0), Some((0, 0x01)));
    assert_eq!(leaf_bit(1), Some((0, 0x02)));
    assert_eq!(leaf_bit(7), Some((0, 0x80)));
    assert_eq!(leaf_bit(8), Some((1, 0x01)));
    assert_eq!(leaf_bit(511), Some((63, 0x80)));
    assert_eq!(leaf_bit(512), Some((64, 0x01)));
    assert_eq!(leaf_bit(1023), Some((127, 0x80)));
    assert_eq!(leaf_bit(LMS_LEAVES), None);
    assert_eq!(leaf_bit(u32::MAX), None);

    let mut used = [0u8; LEAF_BITMAP_LEN];
    for q in 0..LMS_LEAVES {
        let before = used;
        assert!(mark_leaf_used(&mut used, q), "leaf {q}");
        let (byte, bit) = leaf_bit(q).unwrap();
        assert_eq!(used[byte], before[byte] | bit);
        let changed = (0..LEAF_BITMAP_LEN)
            .filter(|&i| used[i] != before[i])
            .count();
        assert_eq!(changed, 1);
        // A second mark changes nothing.
        let after = used;
        assert!(!mark_leaf_used(&mut used, q), "leaf {q} twice");
        assert_eq!(used, after);
    }
    assert_eq!(used, [0xFF; LEAF_BITMAP_LEN]);
    let mut used = [0u8; LEAF_BITMAP_LEN];
    assert!(!mark_leaf_used(&mut used, LMS_LEAVES));
    assert_eq!(used, [0; LEAF_BITMAP_LEN]);
}

fn vault_bytes(mint: &Pubkey) -> Vec<u8> {
    let vault = noised_vault::state::Vault {
        version: noised_vault::state::Vault::VERSION,
        bump: 254,
        mint: *mint,
        genesis_key_id: [7; 32],
        sequence: 3,
        key_id: [8; 32],
        key_ident: [9; 16],
        key_q: 3,
        key_k: [10; 32],
        reserved: 11,
    };
    let mut data = Vec::new();
    vault.try_serialize(&mut data).unwrap();
    data
}

fn recognized(owner: &Pubkey, data: &[u8], mint: &Pubkey) -> bool {
    let address = key(0xEE);
    let (mut lamports, mut data) = (1u64, data.to_vec());
    let info = AccountInfo::new(
        &address,
        false,
        false,
        &mut lamports,
        &mut data,
        owner,
        false,
    );
    is_vault_of(&info, mint).unwrap()
}

/// The vault bytes the launchpad recognizes are the vault crate's: its
/// program id, `Vault` discriminator and version, and `mint` at 10..42.
#[test]
fn pq_vault_constants_match_the_vault_crate() {
    use noised_vault::state::Vault;
    assert_eq!(pq_vault::PROGRAM_ID, noised_vault::ID);
    assert_eq!(&pq_vault::VAULT_DISCRIMINATOR[..], Vault::DISCRIMINATOR);
    assert_eq!(pq_vault::VAULT_VERSION, Vault::VERSION);
    assert_eq!(pq_vault::VAULT_VERSION, 4);
    let mint = key(0x42);
    let data = vault_bytes(&mint);
    assert_eq!(data.len(), 8 + Vault::INIT_SPACE);
    assert_eq!(data[pq_vault::VERSION_OFFSET], Vault::VERSION);
    assert_eq!(
        &data[pq_vault::MINT_OFFSET..pq_vault::MINT_OFFSET + 32],
        mint.as_ref()
    );
}

#[test]
fn only_a_vault_of_the_mint_is_recognized() {
    let (mint, vault_program) = (key(0x42), noised_vault::ID);
    let data = vault_bytes(&mint);
    assert!(recognized(&vault_program, &data, &mint));
    assert!(
        !recognized(&vault_program, &data, &key(0x43)),
        "another mint"
    );
    assert!(
        !recognized(&vault_program, &data, &WSOL_MINT),
        "another mint"
    );
    assert!(!recognized(&crate::ID, &data, &mint), "another owner");
    assert!(
        !recognized(&anchor_lang::system_program::ID, &data, &mint),
        "a system account"
    );
    for at in 0..8 {
        let mut d = data.clone();
        d[at] ^= 1;
        assert!(
            !recognized(&vault_program, &d, &mint),
            "discriminator byte {at}"
        );
    }
    for version in [0, 1, 2, 3, 5, 255] {
        let mut d = data.clone();
        d[8] = version;
        assert!(!recognized(&vault_program, &d, &mint), "version {version}");
    }
    // The bump is not part of the check; the mint must be whole.
    let mut d = data.clone();
    d[9] = 0;
    assert!(recognized(&vault_program, &d, &mint));
    assert!(recognized(&vault_program, &data[..42], &mint));
    assert!(!recognized(&vault_program, &data[..41], &mint));
    assert!(!recognized(&vault_program, &[], &mint));

    // Payout owners: the committer itself, or a vault of the paid mint.
    let committer = key(0xEE);
    let (mut lamports, mut empty) = (1u64, vec![]);
    let system = anchor_lang::system_program::ID;
    let me = AccountInfo::new(
        &committer,
        false,
        false,
        &mut lamports,
        &mut empty,
        &system,
        false,
    );
    assert!(is_payout_owner(&me, &committer, &mint).unwrap());
    assert!(!is_payout_owner(&me, &key(0xEF), &mint).unwrap());
    let vault_key = key(0xAB);
    let (mut lamports, mut vault_data) = (1u64, data.clone());
    let vault = AccountInfo::new(
        &vault_key,
        false,
        false,
        &mut lamports,
        &mut vault_data,
        &vault_program,
        false,
    );
    assert!(is_payout_owner(&vault, &committer, &mint).unwrap());
    assert!(!is_payout_owner(&vault, &committer, &WSOL_MINT).unwrap());
}

/// The identity id the program checks (`sol_sha256`) is the crate's, on a
/// real key: `SHA256(0x21 || pk)`.
#[test]
fn identity_id_is_the_hash_of_the_public_key() {
    let pk = identity().public_key().to_bytes();
    assert_eq!(pk.len(), LMS_PUBLIC_KEY_LEN);
    let id = identity_id::<SolSha256>(&pk);
    assert_eq!(id, identity_id::<Sha2>(&pk));
    assert_eq!(id, Sha2::hashv(&[&[0x21], &pk]));
    assert_eq!(id, identity().identity_id::<Sha2>());
}

/// An attestation signed by the identity verifies through `lms_verify` with
/// the program's hasher at the leaf that signed, and only for that exact
/// message: any other launch, parameters, creator, metadata or program
/// fails, and so does any other key.
#[test]
fn attestations_verify_only_for_their_launch_and_metadata() {
    let kp = identity();
    let pk = kp.public_key().to_bytes();
    let (program, launch, creator) = (crate::ID, key(2), key(3));
    let mut params = good_params();
    params.pq_identity = identity_id::<SolSha256>(&pk);
    let mut encoded = Vec::new();
    params.serialize(&mut encoded).unwrap();
    let params_hash = solana_sha256_hasher::hash(&encoded).to_bytes();
    let signed = terms(record_hash(b"Noised", b"PHX"));
    let message = attestation_message(&program, &launch, &params_hash, &creator, &signed);
    for q in [0, 1, 511, 512, 1023] {
        let sig = kp.sign_deterministic::<Sha2>(q, &message).unwrap();
        assert_eq!(sig.len(), LMS_SIG_LEN);
        assert_eq!(lms_verify::<SolSha256>(&pk, &message, &sig), Some(q));
    }
    let q = 77;
    let sig = kp.sign_deterministic::<Sha2>(q, &message).unwrap();
    let other_terms = |edit: &dyn Fn(&mut AttestedTerms)| {
        let mut t = signed;
        edit(&mut t);
        t
    };
    let message_with =
        |t: AttestedTerms| attestation_message(&program, &launch, &params_hash, &creator, &t);
    for (what, other) in [
        (
            "another launch",
            attestation_message(&program, &key(9), &params_hash, &creator, &signed),
        ),
        (
            "other parameters",
            attestation_message(&program, &launch, &[0; 32], &creator, &signed),
        ),
        (
            "another creator",
            attestation_message(&program, &launch, &params_hash, &key(9), &signed),
        ),
        (
            "other metadata",
            message_with(other_terms(&|t| {
                t.metadata_hash = record_hash(b"Noised", b"PHY")
            })),
        ),
        (
            "another metadata document",
            message_with(other_terms(&|t| {
                t.metadata_hash = metadata_hash_v2(b"Noised", b"PHX", 0, b"", b"{}")
            })),
        ),
        (
            "other rules",
            message_with(other_terms(&|t| t.rules_hash = [0x7A; 32])),
        ),
        (
            "an earlier window",
            message_with(other_terms(&|t| t.not_before -= 1)),
        ),
        (
            "a longer window",
            message_with(other_terms(&|t| t.not_after += 1)),
        ),
        (
            "another program",
            attestation_message(&key(9), &launch, &params_hash, &creator, &signed),
        ),
    ] {
        assert_eq!(lms_verify::<SolSha256>(&pk, &other, &sig), None, "{what}");
    }
    let stranger = LmsPrivateKey {
        seed: [0x5F; 32],
        id: [0x1D; 16],
    };
    let leaf_key = stranger.leaf(q).unwrap();
    let mut forged = sig.clone();
    assert!(leaf_key.sign_deterministic::<Sha2>(&message, &mut forged[8..2184]));
    assert_eq!(lms_verify::<SolSha256>(&pk, &message, &forged), None);
}

/// Account sizes (rent) and the layouts the SDK reads: the identity's key,
/// bitmap and count; the attestation's fields with its stored signature.
#[test]
fn pq_account_layouts_are_pinned() {
    assert_eq!(8 + Identity::INIT_SPACE, 196);
    assert_eq!(8 + Attestation::INIT_SPACE, 2_708);
    assert_eq!(8 + PayoutVault::INIT_SPACE, 82);
    assert_eq!(8 + Launch::INIT_SPACE, 585);
    assert_eq!(8 + Commit::INIT_SPACE, 147);
    assert_eq!(8 + Certificate::INIT_SPACE, 519);
    assert_eq!(
        (Launch::VERSION, Commit::VERSION, Certificate::VERSION),
        (2, 2, 4)
    );
    assert_eq!(
        (
            Identity::VERSION,
            Attestation::VERSION,
            PayoutVault::VERSION,
            TokenMeta::VERSION
        ),
        (1, 3, 1, 1)
    );

    let mut used = [0u8; LEAF_BITMAP_LEN];
    used[127] = 0x80;
    let identity = Identity {
        version: 1,
        bump: 253,
        public_key: [0x33; LMS_PUBLIC_KEY_LEN],
        used,
        used_count: 0x0102,
    };
    let mut data = Vec::new();
    identity.try_serialize(&mut data).unwrap();
    assert_eq!(data.len(), 196);
    assert_eq!(&data[..8], &[58, 132, 5, 12, 176, 164, 85, 112]);
    assert_eq!(&data[8..10], &[1, 253]);
    assert_eq!(&data[10..66], &[0x33; 56]);
    assert_eq!(&data[66..194], &used);
    assert_eq!(&data[194..196], &[0x02, 0x01]);

    let signature: Vec<u8> = (0..LMS_SIG_LEN).map(|i| (i % 251) as u8).collect();
    let attestation = Attestation {
        version: 3,
        bump: 252,
        launch: key(2),
        pq_identity: [3; 32],
        leaf: 0x0304,
        metadata_hash: [5; 32],
        rules_hash: [7; 32],
        message_hash: [6; 32],
        slot: 0x0708_090A_0B0C_0D0E,
        not_before: 0x1112_1314_1516_1718,
        not_after: -0x2122_2324_2526_2728,
        signature: signature.clone(),
    };
    let mut data = Vec::new();
    attestation.try_serialize(&mut data).unwrap();
    assert_eq!(data.len(), 2_708);
    assert_eq!(&data[..8], &[152, 125, 183, 86, 36, 146, 121, 73]);
    assert_eq!(&data[8..10], &[3, 252]);
    assert_eq!(&data[10..42], &[2; 32]);
    assert_eq!(&data[42..74], &[3; 32]);
    assert_eq!(&data[74..76], &[0x04, 0x03]);
    assert_eq!(&data[76..108], &[5; 32]);
    assert_eq!(&data[108..140], &[7; 32]);
    assert_eq!(&data[140..172], &[6; 32]);
    assert_eq!(&data[172..180], &0x0708_090A_0B0C_0D0Eu64.to_le_bytes());
    assert_eq!(&data[180..188], &0x1112_1314_1516_1718i64.to_le_bytes());
    assert_eq!(&data[188..196], &(-0x2122_2324_2526_2728i64).to_le_bytes());
    assert_eq!(&data[196..200], &2_508u32.to_le_bytes());
    assert_eq!(&data[200..], &signature[..]);

    let record = PayoutVault {
        version: 1,
        bump: 251,
        launch: key(2),
        vault: key(4),
        committed: 0x0102_0304_0506_0708,
    };
    let mut data = Vec::new();
    record.try_serialize(&mut data).unwrap();
    assert_eq!(data.len(), 82);
    assert_eq!(&data[..8], &[131, 206, 160, 202, 124, 97, 122, 222]);
    assert_eq!(&data[8..10], &[1, 251]);
    assert_eq!(&data[10..42], &[2; 32]);
    assert_eq!(&data[42..74], &[4; 32]);
    assert_eq!(&data[74..82], &0x0102_0304_0506_0708u64.to_le_bytes());
}

/// Discriminators computed independently (`sha256("<namespace>:<name>")[..8]`).
#[test]
fn pq_discriminators_are_pinned() {
    assert_eq!(
        crate::instruction::AttestLaunch {
            lms_pk: [0; 56],
            lms_sig: vec![],
            metadata_hash: [0; 32],
            rules_hash: [0; 32],
            not_before: 0,
            not_after: 0,
        }
        .data()[..8],
        [181, 24, 201, 53, 246, 126, 253, 79]
    );
    assert_eq!(Identity::DISCRIMINATOR, [58, 132, 5, 12, 176, 164, 85, 112]);
    assert_eq!(
        Attestation::DISCRIMINATOR,
        [152, 125, 183, 86, 36, 146, 121, 73]
    );
    assert_eq!(
        LaunchAttested::DISCRIMINATOR,
        [173, 151, 139, 236, 170, 109, 132, 21]
    );
    assert_eq!(
        PqLeafConsumed::DISCRIMINATOR,
        [178, 187, 79, 242, 166, 50, 87, 14]
    );
    assert_eq!(
        PayoutVault::DISCRIMINATOR,
        [131, 206, 160, 202, 124, 97, 122, 222]
    );
    assert_eq!(TokenMeta::DISCRIMINATOR, [130, 87, 174, 35, 21, 44, 92, 19]);
    assert_eq!(
        MetadataPublished::DISCRIMINATOR,
        [120, 92, 42, 175, 159, 174, 24, 113]
    );
    // Instruction data: discriminator, then the borsh arguments.
    let data = crate::instruction::AttestLaunch {
        lms_pk: [0xAA; 56],
        lms_sig: vec![0xBB; 3],
        metadata_hash: [0xCC; 32],
        rules_hash: [0xDD; 32],
        not_before: 0x0102_0304_0506_0708,
        not_after: -1,
    }
    .data();
    let mut want = vec![181, 24, 201, 53, 246, 126, 253, 79];
    want.extend_from_slice(&[0xAA; 56]);
    want.extend_from_slice(&3u32.to_le_bytes());
    want.extend_from_slice(&[0xBB; 3]);
    want.extend_from_slice(&[0xCC; 32]);
    want.extend_from_slice(&[0xDD; 32]);
    want.extend_from_slice(&0x0102_0304_0506_0708i64.to_le_bytes());
    want.extend_from_slice(&[0xFF; 8]);
    assert_eq!(data, want);
    // `publish_metadata(name, symbol, flags, uri, doc)`: the record's
    // content in its hash order.
    let data = crate::instruction::PublishMetadata {
        name: "n".into(),
        symbol: "s".into(),
        flags: 2,
        uri: "https://u".into(),
        doc: "{}".into(),
    }
    .data();
    let mut want = vec![179, 191, 168, 97, 199, 25, 229, 146];
    want.extend_from_slice(&1u32.to_le_bytes());
    want.push(b'n');
    want.extend_from_slice(&1u32.to_le_bytes());
    want.push(b's');
    want.push(2);
    want.extend_from_slice(&9u32.to_le_bytes());
    want.extend_from_slice(b"https://u");
    want.extend_from_slice(&2u32.to_le_bytes());
    want.extend_from_slice(b"{}");
    assert_eq!(data, want);
    // `launch` takes no arguments: its data is its discriminator.
    assert_eq!(
        crate::instruction::Launch {}.data(),
        [153, 241, 93, 225, 22, 69, 74, 61]
    );
    // `LaunchAttested`: launch, identity, leaf (u16 LE), metadata hash,
    // rules hash, slot, window.
    let event = LaunchAttested {
        launch: key(1),
        pq_identity: [2; 32],
        leaf: 0x0304,
        metadata_hash: [5; 32],
        rules_hash: [7; 32],
        slot: 6,
        not_before: 8,
        not_after: 9,
    };
    let mut want = vec![173, 151, 139, 236, 170, 109, 132, 21];
    want.extend_from_slice(&[1; 32]);
    want.extend_from_slice(&[2; 32]);
    want.extend_from_slice(&[4, 3]);
    want.extend_from_slice(&[5; 32]);
    want.extend_from_slice(&[7; 32]);
    want.extend_from_slice(&6u64.to_le_bytes());
    want.extend_from_slice(&8i64.to_le_bytes());
    want.extend_from_slice(&9i64.to_le_bytes());
    assert_eq!(event.data(), want);
    // `MetadataPublished`: launch, record, hash, flags, uri and document
    // lengths (u16 LE).
    let event = MetadataPublished {
        launch: key(1),
        token_meta: key(2),
        metadata_hash: [3; 32],
        flags: 1,
        uri_len: 0x0405,
        doc_len: 0x0C00,
    };
    let mut want = vec![120, 92, 42, 175, 159, 174, 24, 113];
    want.extend_from_slice(&[1; 32]);
    want.extend_from_slice(&[2; 32]);
    want.extend_from_slice(&[3; 32]);
    want.extend_from_slice(&[1, 0x05, 0x04, 0x00, 0x0C]);
    assert_eq!(event.data(), want);
}

/// Clients map error numbers to messages, so they never move: PQ v2
/// appended its six errors after the existing ones, the on-chain metadata
/// its three after those, and programmable launches `InvalidRules`.
#[test]
fn error_numbers_are_stable() {
    use LaunchpadError as E;
    let pinned = [
        (E::NotUpgradeAuthority, 6000),
        (E::InvalidProtocolParams, 6001),
        (E::InvalidDecimals, 6002),
        (E::InvalidThreshold, 6003),
        (E::InvalidCurve, 6004),
        (E::InvalidBaseFee, 6005),
        (E::FeeScheduleTooLong, 6006),
        (E::InvalidDynamicFee, 6007),
        (E::FeeTooHigh, 6008),
        (E::InvalidMigrationFeeOption, 6009),
        (E::InvalidOpenDelay, 6010),
        (E::InvalidGuard, 6011),
        (E::InvalidMaxWallet, 6012),
        (E::InvalidMaxBuy, 6013),
        (E::InvalidBatchCap, 6014),
        (E::InvalidRecipients, 6015),
        (E::InvalidMetadata, 6016),
        (E::WrongCreator, 6017),
        (E::WrongLaunchState, 6018),
        (E::AccountMismatch, 6019),
        (E::UnsafeMint, 6020),
        (E::UnsafeConfig, 6021),
        (E::UnsafePolicy, 6022),
        (E::NotCommitWindow, 6023),
        (E::NotExecuteWindow, 6024),
        (E::AlreadyExecuted, 6025),
        (E::EmptyBatch, 6026),
        (E::EmptySwap, 6027),
        (E::AlreadyClaimed, 6028),
        (E::BatchPending, 6029),
        (E::CapExceeded, 6030),
        (E::ZeroAmount, 6031),
        (E::PayoutExceedsEscrow, 6032),
        (E::InvalidHookAccounts, 6033),
        (E::InvalidRecipientAccounts, 6034),
        (E::NothingToDo, 6035),
        (E::InvalidPosition, 6036),
        (E::MathOverflow, 6037),
        (E::PoolAlreadyTraded, 6038),
        (E::InvalidPqIdentity, 6039),
        (E::InvalidPqSignature, 6040),
        (E::PqLeafUsed, 6041),
        (E::AttestationMismatch, 6042),
        (E::InvalidPayoutOwner, 6043),
        (E::NotLaunchWindow, 6044),
        (E::InvalidMetadataFlags, 6045),
        (E::MetadataTooLong, 6046),
        (E::MetadataMismatch, 6047),
        (E::InvalidRules, 6048),
    ];
    for (error, number) in pinned {
        assert_eq!(u32::from(error), number, "{error:?}");
    }
}

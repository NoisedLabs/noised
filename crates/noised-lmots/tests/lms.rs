//! LMS (RFC 8554 section 5, LMS_SHA256_M32_H10 over LMOTS_SHA256_N32_W4):
//! known answers from RFC 8554 Appendix F, Test Case 2's top-level tree (the
//! only published level with these parameter sets; the H5/W8 levels are
//! checked in `src/lms.rs` with the height-generic code and refused by the
//! strict parsers), vectors from an independent Python implementation of
//! RFC 8554, every leaf of one tree, tamper tests and the syscall cost model.
//!
//! `rfc8554_appendix_f.json` holds Test Cases 1 and 2 as the appendix prints
//! them: every value of the HSS public key, the message and the HSS signature,
//! concatenated in order.

use std::cell::Cell;
use std::sync::OnceLock;

use noised_lmots::{
    identity_id, lms_verify, LmsKeyPair, LmsPrivateKey, LmsPublicKey, LmsSignature, Sha2, Sha256,
    ID_LEN, LMS_LEAVES, LMS_PUBLIC_KEY_LEN, LMS_SIG_LEN, LMS_TREE_NODES, N,
};

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn arr<const L: usize>(s: &str) -> [u8; L] {
    unhex(s).try_into().unwrap()
}

fn appendix_f() -> &'static serde_json::Value {
    static V: OnceLock<serde_json::Value> = OnceLock::new();
    V.get_or_init(|| serde_json::from_str(include_str!("rfc8554_appendix_f.json")).unwrap())
}

/// RFC 8554 Appendix F, Test Case 2, top-level tree.
struct Tc2 {
    seed: [u8; 32],
    id: [u8; ID_LEN],
    /// The LMS public key (the HSS public key without u32str(L)).
    pk: [u8; LMS_PUBLIC_KEY_LEN],
    /// What the top level signs: the second level's 56-byte public key.
    child_pk: Vec<u8>,
    /// sig[0] of the HSS signature: the 2,508-byte LMS signature at q = 3.
    sig: Vec<u8>,
}

fn tc2() -> Tc2 {
    let tc = &appendix_f()["test_case_2"];
    let hss_pk = unhex(tc["hss_public_key"].as_str().unwrap());
    let hss_sig = unhex(tc["hss_signature"].as_str().unwrap());
    assert_eq!(hss_pk[..4], 2u32.to_be_bytes(), "L = 2");
    assert_eq!(hss_sig[..4], 1u32.to_be_bytes(), "Nspk = 1");
    Tc2 {
        seed: arr(tc["top_level_seed"].as_str().unwrap()),
        id: arr(tc["top_level_i"].as_str().unwrap()),
        pk: hss_pk[4..].try_into().unwrap(),
        child_pk: hss_sig[4 + LMS_SIG_LEN..4 + LMS_SIG_LEN + 56].to_vec(),
        sig: hss_sig[4..4 + LMS_SIG_LEN].to_vec(),
    }
}

/// Test Case 2's top-level key pair, built once per test binary (a key
/// generation is about 1.14 million SHA-256 compressions).
fn tc2_key() -> &'static LmsKeyPair {
    static KEY: OnceLock<LmsKeyPair> = OnceLock::new();
    KEY.get_or_init(|| {
        let t = tc2();
        LmsPrivateKey {
            seed: t.seed,
            id: t.id,
        }
        .keygen::<Sha2>()
    })
}

fn tc2_pk() -> [u8; LMS_PUBLIC_KEY_LEN] {
    tc2_key().public_key().to_bytes()
}

/// A 173-byte message shaped like the first launch attestation message
/// (amendment A4; the launchpad's message v2, "PHX-ATTEST-V2", adds the
/// launch window, 189 bytes): "PHX-ATTEST-V1" and five 32-byte fields
/// (`tag + 1` .. `tag + 5`).
fn attestation_shaped(tag: u8) -> Vec<u8> {
    let mut m = b"PHX-ATTEST-V1".to_vec();
    for field in 1..=5u8 {
        m.extend_from_slice(&[tag.wrapping_add(field); 32]);
    }
    assert_eq!(m.len(), 173);
    m
}

// ---------------------------------------------------------------------------
// RFC 8554 Appendix F, Test Case 2 (top level): (a) keygen, (b) verify, (c) sign
// ---------------------------------------------------------------------------

#[test]
fn rfc8554_tc2_keygen_reproduces_the_published_public_key() {
    let t = tc2();
    let kp = tc2_key();
    assert_eq!(
        kp.public_key().to_bytes(),
        t.pk,
        "T[1] rebuilt from SEED and I"
    );
    assert_eq!(kp.public_key(), LmsPublicKey::from_bytes(&t.pk).unwrap());
    assert_eq!(kp.nodes().len(), LMS_TREE_NODES);
    assert_eq!(kp.nodes()[0], kp.public_key().root);
    // Leaf 3's node is the LM-OTS key that signed the RFC's message.
    let k3 = kp.private_key().leaf(3).unwrap().public_key::<Sha2>().k;
    let leaf3 = Sha2::hashv(&[&t.id, &(1024u32 + 3).to_be_bytes(), &[0x82, 0x82], &k3]);
    assert_eq!(kp.nodes()[1024 + 3 - 1], leaf3);
}

#[test]
fn rfc8554_tc2_published_signature_verifies_at_leaf_3() {
    let t = tc2();
    // The same bytes assembled from the per-field file of the LM-OTS tests:
    // u32str(q) || u32str(3) || C || y || u32str(6) || path.
    let v: serde_json::Value = serde_json::from_str(include_str!("rfc8554_tc2.json")).unwrap();
    let mut assembled = Vec::new();
    assembled.extend_from_slice(&3u32.to_be_bytes());
    assembled.extend_from_slice(&3u32.to_be_bytes());
    assembled.extend(unhex(v["c"].as_str().unwrap()));
    for y in v["y"].as_array().unwrap() {
        assembled.extend(unhex(y.as_str().unwrap()));
    }
    assembled.extend_from_slice(&6u32.to_be_bytes());
    for p in v["path"].as_array().unwrap() {
        assembled.extend(unhex(p.as_str().unwrap()));
    }
    assert_eq!(assembled, t.sig);
    assert_eq!(unhex(v["message"].as_str().unwrap()), t.child_pk);
    assert_eq!(&t.pk[24..], unhex(v["root"].as_str().unwrap()));

    assert_eq!(lms_verify::<Sha2>(&t.pk, &t.child_pk, &t.sig), Some(3));
    let parsed = LmsSignature::parse(&t.sig).unwrap();
    assert_eq!(parsed.q, 3);
    assert_eq!(parsed.ots_signature, &t.sig[8..2184]);
    assert_eq!(parsed.path, &t.sig[2188..]);
}

#[test]
fn rfc8554_tc2_signing_reproduces_the_published_signature() {
    let t = tc2();
    let c: [u8; N] = t.sig[8..40].try_into().unwrap();
    let sig = tc2_key().sign::<Sha2>(3, &t.child_pk, &c).unwrap();
    assert_eq!(
        sig, t.sig,
        "signature bytes differ from RFC 8554 Test Case 2"
    );
    let path = tc2_key().auth_path(3).unwrap();
    assert_eq!(path.concat(), &t.sig[2188..]);
}

// ---------------------------------------------------------------------------
// Vectors from an independent Python implementation of RFC 8554
// ---------------------------------------------------------------------------

#[test]
fn identity_id_known_answers() {
    let t = tc2();
    let id = identity_id::<Sha2>(&t.pk);
    assert_eq!(
        id.to_vec(),
        unhex("7846a2ebb04cd38e8bee0143e1ee67e7858bcf99e97e73be905d0385620f9171")
    );
    assert_eq!(id, Sha2::hashv(&[&[0x21], &t.pk]));
    assert_eq!(tc2_key().identity_id::<Sha2>(), id);
    // The vault's key_id domain (0x20) names the same bytes differently.
    assert_eq!(
        Sha2::hashv(&[&[0x20], &t.pk]).to_vec(),
        unhex("961487d4f02cc29c0db38bfa534d62125279f817e4a9723921a50fac7e43a914")
    );
}

/// The master seed of the vault's SDK derivation vectors: bytes 0..64.
fn master() -> [u8; 64] {
    std::array::from_fn(|i| i as u8)
}

#[test]
fn identity_derivation_known_answers() {
    // (cluster, index, SEED, I) for master = 00 01 .. 3f.
    let expected = [
        (
            0,
            0,
            "8032898d25ce056eb86a87f6a547e03a694ee92aee56288640abfedb9869bc7e",
            "2409ae9dfe50d65c98c068849a624604",
        ),
        (
            0,
            1,
            "3cc35a86e3f4303f0e6cd3eab1f4bb8ce02cd8ec3748e4c3696125bef178464b",
            "c2d04420028e867b33ba3b93bd599127",
        ),
        (
            1,
            0,
            "d0a9a8aa0f0467c7c57c9b8266321eba5c5187e7889027855c68ba018bcd24a1",
            "ed8944952bd43d0e89d15fa4109536f5",
        ),
        (
            1,
            1,
            "9f801fcdb0d4892de94b834c7164799c9b99caf03252658895d19b36d63ec03e",
            "478ee361d31089a2f09e563a549fc1fb",
        ),
        (
            2,
            0,
            "71cd6625e9f3ac5bd807ff090017b28c298c98e197f4337d158a89b74ea62c79",
            "c6553c83e1273eb1816ce832d0b700e8",
        ),
        (
            2,
            1,
            "b2a20d694163aaaed3489ec079d42b5ca91a55d2d1fe07b0cd11d6bddc90a5ed",
            "4a1c719e474b67fd4631d2859437dac7",
        ),
    ];
    for (cluster, index, seed, id) in expected {
        let sk = LmsPrivateKey::derive_identity::<Sha2>(&master(), cluster, index).unwrap();
        assert_eq!(sk.seed, arr::<32>(seed), "cluster {cluster} index {index}");
        assert_eq!(sk.id, arr::<16>(id), "cluster {cluster} index {index}");
    }
    assert!(LmsPrivateKey::derive_identity::<Sha2>(&master(), 3, 0).is_none());
    assert!(LmsPrivateKey::derive_identity::<Sha2>(&master(), u8::MAX, 0).is_none());
    assert!(LmsPrivateKey::derive_identity::<Sha2>(&[0u8; 64], 2, 0).is_none());
    let mut one = [0u8; 64];
    one[63] = 1;
    assert!(LmsPrivateKey::derive_identity::<Sha2>(&one, 2, 0).is_some());
}

#[test]
fn derived_identity_keygen_and_signatures_match_the_reference() {
    let kp = LmsPrivateKey::derive_identity::<Sha2>(&master(), 2, 0)
        .unwrap()
        .keygen::<Sha2>();
    let pk = kp.public_key().to_bytes();
    assert_eq!(
        pk.to_vec(),
        unhex("0000000600000003c6553c83e1273eb1816ce832d0b700e8ca1d0ac1e2a6cf35812572e4e84b077bc420a18d27f8badfb4b856687daae587")
    );
    assert_eq!(
        kp.identity_id::<Sha2>().to_vec(),
        unhex("bc0127aba7c34b308ec1790388faa7cf2b58cc3ce2ed3e4b8875678b69096942")
    );
    let msg = attestation_shaped(0);
    let expected = [
        (
            0,
            "6cb6a8d4ae48eaf78a9bcbe3dacf9150bedc46118767dae4509fe0ef8f8cb4dc",
            "699d3b3b95b40e970cd548013337d62004d8716a51db5b2268c0577fe504bc33",
        ),
        (
            1,
            "8da99370f25644aeed103ea24426ec74b850da2e9f3baecf2daa74ea7f9e5754",
            "b8b7648e645c4c84ff927bf3d644ec759e62e2137abd5d3c76d5b2ddb1461483",
        ),
        (
            511,
            "51229f470e21560837219007506f17ed61f5b167d4148ccb51c28fa00fbd2025",
            "439363efae0d922335dc9de8b81701ce97ec962352b8c2480e38a830d03a685c",
        ),
        (
            512,
            "141531f1f8b001f0e13e30b78ef904411234df9752586bb9f4261e217a346373",
            "acfbac081bca9f84f86f8ae1d0a3efc745e2a83b8e540fbb09b33169b2e3bee8",
        ),
        (
            1023,
            "a4bb1e6d3ee4b0eec3e99f41dee842fa4d0e0343c8f6657907a610c8522cfe08",
            "aa899bb6755383927c115bdc25a2ea9a8e842251fb73b5dee6affc6ba7623f7a",
        ),
    ];
    for (q, c, sig_hash) in expected {
        let sig = kp.sign_deterministic::<Sha2>(q, &msg).unwrap();
        assert_eq!(sig[8..40], arr::<32>(c), "C at leaf {q}");
        assert_eq!(
            Sha2::hashv(&[&sig]),
            arr::<32>(sig_hash),
            "signature at leaf {q}"
        );
        assert_eq!(lms_verify::<Sha2>(&pk, &msg, &sig), Some(q));
        // Another identity's key does not accept it, and vice versa.
        assert_eq!(lms_verify::<Sha2>(&tc2_pk(), &msg, &sig), None);
    }
    let t = tc2();
    assert_eq!(lms_verify::<Sha2>(&pk, &t.child_pk, &t.sig), None);
}

// ---------------------------------------------------------------------------
// Every leaf, the boundary leaves, the signer's refusals
// ---------------------------------------------------------------------------

#[test]
fn boundary_leaves_sign_and_verify() {
    let kp = tc2_key();
    let pk = tc2_pk();
    for q in [0, 1, 511, 512, 1023] {
        let msg = attestation_shaped(q as u8);
        let sig = kp.sign_deterministic::<Sha2>(q, &msg).unwrap();
        assert_eq!(sig.len(), LMS_SIG_LEN);
        assert_eq!(sig[..4], q.to_be_bytes());
        assert_eq!(LmsSignature::parse(&sig).unwrap().q, q);
        assert_eq!(lms_verify::<Sha2>(&pk, &msg, &sig), Some(q), "leaf {q}");
        assert_eq!(
            lms_verify::<Sha2>(&pk, &attestation_shaped(q as u8 ^ 1), &sig),
            None
        );
    }
}

#[test]
fn all_1024_leaves_sign_and_verify() {
    let kp = tc2_key();
    let pk = tc2_pk();
    for q in 0..LMS_LEAVES {
        let mut msg = attestation_shaped(7);
        msg.extend_from_slice(&q.to_le_bytes());
        let sig = kp.sign_deterministic::<Sha2>(q, &msg).unwrap();
        assert_eq!(lms_verify::<Sha2>(&pk, &msg, &sig), Some(q), "leaf {q}");
        // Leaf q's path is the Appendix D path of the stored tree.
        assert_eq!(sig[2188..], kp.auth_path(q).unwrap().concat());
    }
}

#[test]
fn the_signer_refuses_leaves_outside_the_tree() {
    let kp = tc2_key();
    let msg = attestation_shaped(1);
    for q in [LMS_LEAVES, LMS_LEAVES + 1, u32::MAX] {
        assert!(kp.sign_deterministic::<Sha2>(q, &msg).is_none());
        assert!(kp.sign::<Sha2>(q, &msg, &[7; N]).is_none());
        assert!(kp.auth_path(q).is_none());
        assert!(kp.private_key().leaf(q).is_none());
    }
    let leaf = kp.private_key().leaf(LMS_LEAVES - 1).unwrap();
    assert_eq!((leaf.id, leaf.q, leaf.seed), (tc2().id, 1023, tc2().seed));
}

#[test]
fn deterministic_signing_is_idempotent_and_message_bound() {
    let kp = tc2_key();
    let msg = attestation_shaped(2);
    let a = kp.sign_deterministic::<Sha2>(77, &msg).unwrap();
    let b = kp.sign_deterministic::<Sha2>(77, &msg).unwrap();
    assert_eq!(a, b, "re-signing the same message must reproduce the bytes");
    let c = kp.private_key().leaf(77).unwrap().randomizer::<Sha2>(&msg);
    assert_eq!(a[8..40], c, "C is the leaf's HMAC randomizer");
    assert_eq!(kp.sign::<Sha2>(77, &msg, &c).unwrap(), a);
    let other = kp
        .sign_deterministic::<Sha2>(77, &attestation_shaped(3))
        .unwrap();
    assert_ne!(a[8..40], other[8..40]);
    // Another randomizer gives another valid signature: exactly what a
    // second signing must never do (two signatures from one leaf).
    let second = kp.sign::<Sha2>(77, &msg, &[9; N]).unwrap();
    assert_ne!(second, a);
    assert_eq!(lms_verify::<Sha2>(&tc2_pk(), &msg, &second), Some(77));
}

// ---------------------------------------------------------------------------
// Tampering and malformed inputs
// ---------------------------------------------------------------------------

fn with_u32(bytes: &[u8], at: usize, value: u32) -> Vec<u8> {
    let mut out = bytes.to_vec();
    out[at..at + 4].copy_from_slice(&value.to_be_bytes());
    out
}

fn flip(bytes: &[u8], at: usize, bit: u8) -> Vec<u8> {
    let mut out = bytes.to_vec();
    out[at] ^= 1 << bit;
    out
}

fn pk_array(bytes: Vec<u8>) -> [u8; LMS_PUBLIC_KEY_LEN] {
    bytes.try_into().unwrap()
}

#[test]
fn tampered_leaf_index_is_rejected() {
    let t = tc2();
    for q in [
        0,
        1,
        2,
        4,
        7,
        1023,
        1024,
        1025,
        0x0001_0003,
        0x8000_0003,
        u32::MAX,
    ] {
        let bad = with_u32(&t.sig, 0, q);
        assert_eq!(
            lms_verify::<Sha2>(&t.pk, &t.child_pk, &bad),
            None,
            "q = {q}"
        );
        assert_eq!(LmsSignature::parse(&bad).is_some(), q < 1024, "q = {q}");
    }
    // The highest leaf's signature, renumbered past the tree.
    let msg = attestation_shaped(9);
    let sig = tc2_key().sign_deterministic::<Sha2>(1023, &msg).unwrap();
    for q in [1022, 1024, 2047, 2 * 1024 + 1023] {
        assert_eq!(
            lms_verify::<Sha2>(&tc2_pk(), &msg, &with_u32(&sig, 0, q)),
            None,
            "q = {q}"
        );
    }
}

#[test]
fn every_typecode_is_checked() {
    let t = tc2();
    assert_eq!(lms_verify::<Sha2>(&t.pk, &t.child_pk, &t.sig), Some(3));
    let others = [
        0u32,
        1,
        2,
        4,
        5,
        7,
        8,
        9,
        0x0300_0000,
        0x0600_0000,
        u32::MAX,
    ];
    for v in others {
        // Public key: LMS type (0..4) and LM-OTS type (4..8).
        if v != 6 {
            let pk = pk_array(with_u32(&t.pk, 0, v));
            assert!(LmsPublicKey::from_bytes(&pk).is_none());
            assert_eq!(
                lms_verify::<Sha2>(&pk, &t.child_pk, &t.sig),
                None,
                "pk type {v}"
            );
        }
        if v != 3 {
            let pk = pk_array(with_u32(&t.pk, 4, v));
            assert!(LmsPublicKey::from_bytes(&pk).is_none());
            assert_eq!(
                lms_verify::<Sha2>(&pk, &t.child_pk, &t.sig),
                None,
                "pk ots type {v}"
            );
            let sig = with_u32(&t.sig, 4, v);
            assert!(LmsSignature::parse(&sig).is_none());
            assert_eq!(
                lms_verify::<Sha2>(&t.pk, &t.child_pk, &sig),
                None,
                "sig ots type {v}"
            );
        }
        if v != 6 {
            let sig = with_u32(&t.sig, 2184, v);
            assert!(LmsSignature::parse(&sig).is_none());
            assert_eq!(
                lms_verify::<Sha2>(&t.pk, &t.child_pk, &sig),
                None,
                "sig lms type {v}"
            );
        }
    }
    // The H5/W8 typecodes of the other Appendix F levels, on key and signature.
    let h5_pk = pk_array(with_u32(&with_u32(&t.pk, 0, 5), 4, 4));
    let h5_sig = with_u32(&with_u32(&t.sig, 4, 4), 2184, 5);
    assert_eq!(lms_verify::<Sha2>(&h5_pk, &t.child_pk, &t.sig), None);
    assert_eq!(lms_verify::<Sha2>(&t.pk, &t.child_pk, &h5_sig), None);
    assert_eq!(lms_verify::<Sha2>(&h5_pk, &t.child_pk, &h5_sig), None);
}

#[test]
fn wrong_lengths_are_rejected() {
    let t = tc2();
    let mut long = t.sig.clone();
    long.push(0);
    let mut longer = t.sig.clone();
    longer.extend_from_slice(&[0; N]);
    for (label, sig) in [
        ("-1", &t.sig[..LMS_SIG_LEN - 1]),
        ("+1", &long[..]),
        ("+32", &longer[..]),
        ("no path", &t.sig[..2188]),
        ("one level short", &t.sig[..LMS_SIG_LEN - N]),
        ("LM-OTS only", &t.sig[8..2184]),
        ("empty", &[][..]),
    ] {
        assert!(LmsSignature::parse(sig).is_none(), "{label}");
        assert_eq!(lms_verify::<Sha2>(&t.pk, &t.child_pk, sig), None, "{label}");
    }
    let padded = [t.pk.to_vec(), vec![0; 4]].concat();
    for len in [0, 8, 55, 57, 60] {
        assert!(
            LmsPublicKey::from_bytes(&padded[..len]).is_none(),
            "pk length {len}"
        );
    }
    assert_eq!(LmsPublicKey::from_bytes(&t.pk).unwrap().to_bytes(), t.pk);
}

#[test]
fn every_part_of_signature_and_key_is_bound() {
    let t = tc2();
    let reject = |pk: &[u8; LMS_PUBLIC_KEY_LEN], msg: &[u8], sig: &[u8], what: String| {
        assert_eq!(lms_verify::<Sha2>(pk, msg, sig), None, "{what} accepted");
    };
    // C: every byte.
    for at in 8..40 {
        reject(
            &t.pk,
            &t.child_pk,
            &flip(&t.sig, at, (at % 8) as u8),
            format!("C byte {at}"),
        );
    }
    // Every y chunk (one bit each, at a different byte of the chunk).
    for i in 0..67 {
        let at = 40 + i * N + i % N;
        reject(
            &t.pk,
            &t.child_pk,
            &flip(&t.sig, at, (i % 8) as u8),
            format!("y[{i}]"),
        );
    }
    // Every path chunk.
    for i in 0..10 {
        let at = 2188 + i * N + (31 - i);
        reject(
            &t.pk,
            &t.child_pk,
            &flip(&t.sig, at, (i % 8) as u8),
            format!("path[{i}]"),
        );
    }
    // Path order: reversed, and two neighbours swapped.
    let path: Vec<&[u8]> = t.sig[2188..].chunks(N).collect();
    let reversed: Vec<u8> = t.sig[..2188]
        .iter()
        .chain(path.iter().rev().flat_map(|p| p.iter()))
        .copied()
        .collect();
    reject(&t.pk, &t.child_pk, &reversed, "reversed path".into());
    let mut swapped = t.sig.clone();
    swapped[2188..2188 + 2 * N].copy_from_slice(&[path[1], path[0]].concat());
    reject(
        &t.pk,
        &t.child_pk,
        &swapped,
        "swapped path[0], path[1]".into(),
    );
    // I and T: every byte.
    for at in 8..LMS_PUBLIC_KEY_LEN {
        let pk = pk_array(flip(&t.pk, at, (at % 8) as u8));
        let what = if at < 24 { "I" } else { "T" };
        reject(&pk, &t.child_pk, &t.sig, format!("{what} byte {at}"));
    }
    // The message.
    reject(
        &t.pk,
        &flip(&t.child_pk, 0, 0),
        &t.sig,
        "message bit".into(),
    );
    reject(&t.pk, &t.child_pk[..55], &t.sig, "short message".into());
    reject(
        &t.pk,
        &[t.child_pk.clone(), vec![0]].concat(),
        &t.sig,
        "long message".into(),
    );
    reject(&t.pk, &[], &t.sig, "empty message".into());
    // Untouched, it still verifies.
    assert_eq!(lms_verify::<Sha2>(&t.pk, &t.child_pk, &t.sig), Some(3));
}

// ---------------------------------------------------------------------------
// Compute: the sol_sha256 syscall cost of verification
// ---------------------------------------------------------------------------

thread_local! {
    /// (calls, syscall CU, chain steps) of `Metered` on this thread.
    static METER: Cell<(u64, u64, u64)> = const { Cell::new((0, 0, 0)) };
}

/// SHA-256 that also prices each call like Agave's `sol_sha256`: 85 CU plus,
/// per input slice, max(10, len / 2) (sha256_base_cost, sha256_byte_cost and
/// mem_op_base_cost of Agave 4.3). The on-chain backend passes the same
/// slices to the syscall.
struct Metered;

impl Sha256 for Metered {
    fn hashv(parts: &[&[u8]]) -> [u8; 32] {
        let cu = 85
            + parts
                .iter()
                .map(|p| (p.len() as u64 / 2).max(10))
                .sum::<u64>();
        // A chain step is one contiguous 55-byte slice (I || q || i || j || tmp).
        let step = u64::from(parts.len() == 1 && parts[0].len() == 55);
        METER.with(|m| {
            let (calls, total, steps) = m.get();
            m.set((calls + 1, total + cu, steps + step));
        });
        Sha2::hashv(parts)
    }
}

fn metered_verify(
    pk: &[u8; LMS_PUBLIC_KEY_LEN],
    msg: &[u8],
    sig: &[u8],
) -> (Option<u32>, u64, u64, u64) {
    METER.with(|m| m.set((0, 0, 0)));
    let q = lms_verify::<Metered>(pk, msg, sig);
    let (calls, cu, steps) = METER.with(|m| m.get());
    (q, calls, cu, steps)
}

/// Syscall CU of one verification over a message of `len` bytes with `steps`
/// chain steps: Q (5 slices) + steps * 112 + K (4 slices, 2,144-byte z) +
/// the leaf (4 slices) + 10 interior nodes (5 slices).
fn syscall_cu(len: u64, steps: u64) -> u64 {
    (85 + 46 + (len / 2).max(10)) + steps * 112 + (85 + 30 + 1072) + (85 + 46) + 10 * (85 + 62)
}

#[test]
fn verification_syscall_cost_model() {
    let t = tc2();
    let (q, calls, cu, steps) = metered_verify(&t.pk, &t.child_pk, &t.sig);
    assert_eq!(q, Some(3));
    assert_eq!(
        calls,
        1 + steps + 1 + 1 + 10,
        "Q, chain steps, K, leaf, 10 interior nodes"
    );
    assert_eq!(cu, syscall_cu(t.child_pk.len() as u64, steps));
    // The documented figures for a 173-byte attestation message.
    assert_eq!(syscall_cu(173, 0), 3_005);
    assert_eq!(
        syscall_cu(173, 990),
        113_885,
        "990 = 64 * 15 + 30, the most steps any digest needs"
    );

    let kp = tc2_key();
    let pk = tc2_pk();
    let mut all_steps = Vec::new();
    for q in (0..LMS_LEAVES).step_by(8) {
        let msg = attestation_shaped(q as u8);
        let sig = kp.sign_deterministic::<Sha2>(q, &msg).unwrap();
        let (got, calls, cu, steps) = metered_verify(&pk, &msg, &sig);
        assert_eq!(got, Some(q));
        assert_eq!(calls, steps + 13);
        assert_eq!(cu, syscall_cu(173, steps));
        assert!(steps <= 990);
        all_steps.push(steps);
    }
    all_steps.sort_unstable();
    let mean = all_steps.iter().sum::<u64>() as f64 / all_steps.len() as f64;
    let max = *all_steps.last().unwrap();
    println!(
        "LMS verify over 173 bytes, {} signatures: chain steps mean {mean:.0}, max {max}; \
         sol_sha256 CU mean {:.0}, max {} (worst case possible {})",
        all_steps.len(),
        syscall_cu(173, 0) as f64 + 112.0 * mean,
        syscall_cu(173, max),
        syscall_cu(173, 990),
    );
    assert!((440.0..=570.0).contains(&mean), "mean chain steps {mean}");
}

// ---------------------------------------------------------------------------
// Data files
// ---------------------------------------------------------------------------

#[test]
fn appendix_f_file_holds_both_test_cases() {
    let v = appendix_f();
    let tc1 = &v["test_case_1"];
    // Test Case 1: LMS_SHA256_M32_H5 / LMOTS_SHA256_N32_W8 at both levels.
    let pk1 = unhex(tc1["hss_public_key"].as_str().unwrap());
    assert_eq!(pk1[..12], [0, 0, 0, 2, 0, 0, 0, 5, 0, 0, 0, 4]);
    assert_eq!(
        unhex(tc1["hss_signature"].as_str().unwrap()).len(),
        4 + 1292 + 56 + 1292
    );
    let msg1 = unhex(tc1["message"].as_str().unwrap());
    assert!(msg1.starts_with(b"The powers not delegated to the United States"));
    let tc2v = &v["test_case_2"];
    assert_eq!(
        unhex(tc2v["hss_signature"].as_str().unwrap()).len(),
        4 + 2508 + 56 + 1292
    );
    let msg2 = unhex(tc2v["message"].as_str().unwrap());
    assert!(msg2.starts_with(b"The enumeration in the Constitution"));
    let t = tc2();
    assert_eq!(t.pk[..8], [0, 0, 0, 6, 0, 0, 0, 3]);
    assert_eq!(t.child_pk[..8], [0, 0, 0, 5, 0, 0, 0, 4]);
}

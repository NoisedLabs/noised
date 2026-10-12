//! LM-OTS known-answer tests against RFC 8554 Appendix F, Test Case 2 (the
//! top-level tree uses LMOTS_SHA256_N32_W4), plus tamper tests.

use noised_lmots::{
    candidate_public_key, key_id, verify, PrivateKey, PublicKey, Sha2, Sha256, ID_LEN, N, P,
    SIG_LEN,
};

const D_LEAF: [u8; 2] = [0x82, 0x82];
const D_INTR: [u8; 2] = [0x83, 0x83];

struct Tc2 {
    height: u32,
    seed: [u8; 32],
    id: [u8; ID_LEN],
    root: [u8; 32],
    q: u32,
    message: Vec<u8>,
    sig: Vec<u8>,
    path: Vec<[u8; 32]>,
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn arr<const L: usize>(s: &str) -> [u8; L] {
    unhex(s).try_into().unwrap()
}

fn tc2() -> Tc2 {
    let v: serde_json::Value = serde_json::from_str(include_str!("rfc8554_tc2.json")).unwrap();
    let mut sig = unhex(v["c"].as_str().unwrap());
    for y in v["y"].as_array().unwrap() {
        sig.extend(unhex(y.as_str().unwrap()));
    }
    Tc2 {
        height: v["lms_height"].as_u64().unwrap() as u32,
        seed: arr(v["seed"].as_str().unwrap()),
        id: arr(v["i"].as_str().unwrap()),
        root: arr(v["root"].as_str().unwrap()),
        q: v["q"].as_u64().unwrap() as u32,
        message: unhex(v["message"].as_str().unwrap()),
        sig,
        path: v["path"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| arr(p.as_str().unwrap()))
            .collect(),
    }
}

fn leaf(id: &[u8; ID_LEN], node: u32, k: &[u8; 32]) -> [u8; 32] {
    Sha2::hashv(&[id, &node.to_be_bytes(), &D_LEAF, k])
}

fn interior(id: &[u8; ID_LEN], node: u32, left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    Sha2::hashv(&[id, &node.to_be_bytes(), &D_INTR, left, right])
}

/// RFC 8554 Algorithm 6a: LMS root implied by an OTS public key and its path.
fn root_from_path(t: &Tc2, kc: &[u8; 32]) -> [u8; 32] {
    let mut node = (1u32 << t.height) + t.q;
    let mut tmp = leaf(&t.id, node, kc);
    for p in &t.path {
        tmp = if node % 2 == 1 {
            interior(&t.id, node / 2, p, &tmp)
        } else {
            interior(&t.id, node / 2, &tmp, p)
        };
        node /= 2;
    }
    tmp
}

#[test]
fn rfc8554_tc2_signature_verifies_to_published_root() {
    let t = tc2();
    assert_eq!(t.sig.len(), SIG_LEN);
    let kc = candidate_public_key::<Sha2>(&t.id, t.q, &t.message, &t.sig).unwrap();
    assert_eq!(root_from_path(&t, &kc), t.root, "LMS root mismatch");
}

#[test]
fn rfc8554_tc2_keygen_and_signing_reproduce_published_values() {
    let t = tc2();
    let sk = PrivateKey {
        id: t.id,
        q: t.q,
        seed: t.seed,
    };
    let pk = sk.public_key::<Sha2>();
    let kc = candidate_public_key::<Sha2>(&t.id, t.q, &t.message, &t.sig).unwrap();
    assert_eq!(
        pk.k, kc,
        "Appendix A key derivation disagrees with the RFC signature"
    );
    let c: [u8; 32] = t.sig[..32].try_into().unwrap();
    let mut sig = vec![0u8; SIG_LEN];
    assert!(sk.sign::<Sha2>(&t.message, &c, &mut sig));
    assert_eq!(sig, t.sig, "signing does not reproduce the RFC signature");
    assert!(verify::<Sha2>(&pk, &t.message, &sig));
}

#[test]
fn rfc8554_tc2_full_tree_root_from_seed() {
    // Rebuild all 2^10 OTS public keys from SEED (Appendix A) and the LMS
    // tree (Algorithm in section 5.3); the root must equal the published K.
    let t = tc2();
    let leaves = 1u32 << t.height;
    let mut level: Vec<[u8; 32]> = (0..leaves)
        .map(|q| {
            let pk = PrivateKey {
                id: t.id,
                q,
                seed: t.seed,
            }
            .public_key::<Sha2>();
            leaf(&t.id, leaves + q, &pk.k)
        })
        .collect();
    let mut first = leaves;
    while level.len() > 1 {
        first /= 2;
        level = level
            .chunks(2)
            .enumerate()
            .map(|(j, pair)| interior(&t.id, first + j as u32, &pair[0], &pair[1]))
            .collect();
    }
    assert_eq!(level[0], t.root);
}

fn fresh(tag: u8) -> (PrivateKey, PublicKey) {
    let seed = Sha2::hashv(&[b"phalanx-lmots-test", &[tag]]);
    let mut id = [0u8; ID_LEN];
    id.copy_from_slice(&Sha2::hashv(&[b"id", &[tag]])[..ID_LEN]);
    let sk = PrivateKey {
        id,
        q: tag as u32,
        seed,
    };
    let pk = sk.public_key::<Sha2>();
    (sk, pk)
}

fn sign(sk: &PrivateKey, msg: &[u8], c_tag: u8) -> Vec<u8> {
    let c = Sha2::hashv(&[b"c", &[c_tag]]);
    let mut sig = vec![0u8; SIG_LEN];
    assert!(sk.sign::<Sha2>(msg, &c, &mut sig));
    sig
}

#[test]
fn roundtrip_and_rejections() {
    let (sk, pk) = fresh(1);
    let msg = b"withdraw 1000 to alice";
    let sig = sign(&sk, msg, 1);
    assert!(verify::<Sha2>(&pk, msg, &sig));

    assert!(!verify::<Sha2>(&pk, b"withdraw 1000 to eve", &sig));
    let mut wrong_q = pk;
    wrong_q.q ^= 1;
    assert!(!verify::<Sha2>(&wrong_q, msg, &sig));
    let mut wrong_id = pk;
    wrong_id.id[0] ^= 1;
    assert!(!verify::<Sha2>(&wrong_id, msg, &sig));
    assert!(!verify::<Sha2>(&pk, msg, &sig[..SIG_LEN - 1]));
    let mut long = sig.clone();
    long.push(0);
    assert!(!verify::<Sha2>(&pk, msg, &long));
    assert!(!verify::<Sha2>(&pk, msg, &[]));
}

#[test]
fn every_byte_of_the_signature_is_bound() {
    let (sk, pk) = fresh(2);
    let msg = b"pay bob 5";
    let sig = sign(&sk, msg, 2);
    // Flipping a bit in C or in any chain value breaks verification.
    for pos in (0..SIG_LEN).step_by(7).chain([0, N - 1, N, SIG_LEN - 1]) {
        let mut bad = sig.clone();
        bad[pos] ^= 0x01;
        assert!(
            !verify::<Sha2>(&pk, msg, &bad),
            "tampered byte {pos} accepted"
        );
    }
}

#[test]
fn randomizer_changes_signature_not_validity() {
    let (sk, pk) = fresh(3);
    let msg = b"same message";
    let a = sign(&sk, msg, 10);
    let b = sign(&sk, msg, 11);
    assert_ne!(a, b);
    assert!(verify::<Sha2>(&pk, msg, &a) && verify::<Sha2>(&pk, msg, &b));
}

#[test]
fn key_ids_are_distinct_and_stable() {
    let (_, a) = fresh(4);
    let (_, b) = fresh(5);
    assert_eq!(key_id::<Sha2>(&a), key_id::<Sha2>(&a));
    assert_ne!(key_id::<Sha2>(&a), key_id::<Sha2>(&b));
    assert_eq!(P, 67);
}

#[test]
fn hmac_sha256_matches_rfc4231_test_case_2() {
    let mac = noised_lmots::hmac_sha256::<Sha2>(b"Jefe", &[b"what do ya ", b"want for nothing?"]);
    assert_eq!(
        mac.to_vec(),
        unhex("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843")
    );
}

/// Cross-language vector for the deterministic randomizer (the SDK checks the
/// same value): SEED = 0x11 * 32, I = 0x22 * 16, q = 7, message "phalanx".
#[test]
fn deterministic_randomizer_vector() {
    let sk = PrivateKey {
        id: [0x22; ID_LEN],
        q: 7,
        seed: [0x11; 32],
    };
    assert_eq!(
        sk.randomizer::<Sha2>(b"phalanx").to_vec(),
        unhex("efff9f338802ed72a95c53d848647c110c67a6a943e9aeecf572bd978e9d79d3")
    );
}

#[test]
fn deterministic_signing_is_idempotent_and_message_bound() {
    let (sk, pk) = fresh(6);
    let mut a = vec![0u8; SIG_LEN];
    let mut b = vec![0u8; SIG_LEN];
    assert!(sk.sign_deterministic::<Sha2>(b"pay carol 7", &mut a));
    assert!(sk.sign_deterministic::<Sha2>(b"pay carol 7", &mut b));
    // Signing the same message again reproduces the identical signature.
    assert_eq!(a, b);
    assert!(verify::<Sha2>(&pk, b"pay carol 7", &a));
    // C is the keyed randomizer, so it differs per message.
    let mut c = vec![0u8; SIG_LEN];
    assert!(sk.sign_deterministic::<Sha2>(b"pay carol 8", &mut c));
    assert_ne!(a[..N], c[..N]);
    assert_eq!(a[..N], sk.randomizer::<Sha2>(b"pay carol 7"));
}

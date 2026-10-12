//! Cross-implementation vectors for the SDK's post-quantum creator identity
//! (PQ v2): `tests/integration/vectors/lms.json`.
//!
//! Keys, signatures and randomizers come from `noised-lmots` (the crate the
//! launchpad verifies with, `LMS_SHA256_M32_H10` over
//! `LMOTS_SHA256_N32_W4`); everything else is written from the documented
//! layouts (`common::launchpad`), independently of the launchpad crate.
//! `tests/vectors_onchain.rs` then lands these exact bytes on the launchpad
//! build and compares what it writes with the accounts and events below.
//!
//! * `parameters`: sizes, typecodes, tags, seeds, account lengths and the
//!   `Launch` offsets an SDK reads, the A14 config words, the metadata
//!   record's limits (UTF-8 bytes, with examples), the launch-window bounds,
//!   the leaf probe, the A13 warning threshold, error numbers and
//!   discriminators;
//! * `derivation` (amendment A12): `path = cluster || u32le(index)`,
//!   `SEED = SHA256("phalanx/pq/identity/v1/seed" || master || path)`,
//!   `I = SHA256("phalanx/pq/identity/v1/id" || master || path)[..16]`, for
//!   clusters 0, 1, 2 and identity indexes 0, 1;
//! * `identity`: localnet identity 0, its public key
//!   `u32be(6) || u32be(3) || I || T[1]`, `identityId = SHA256(0x21 || pk)`,
//!   its `["identity", identityId]` account address, and `nodesSha256`, the
//!   SHA-256 of the 2,047 tree nodes `T[1] || .. || T[2047]` (A16: a client
//!   that caches the public tree checks it against this and against `T[1]`);
//! * `metadata` and `attestation` (A4 with the review's fixes, message v3):
//!   the on-chain metadata record (name, symbol, flags, uri, document),
//!   `metadataHash = SHA256("PHX-META-V2" || borsh(name) || borsh(symbol) ||
//!   flags || borsh(uri) || borsh(doc))`, its `["metadata", launch,
//!   metadataHash]` address, the launch window, no creator rules (`rulesHash`
//!   zero; `programmable.json` has a launch with rules), and the 221-byte
//!   message `"PHX-ATTEST-V3" || program || launch || paramsHash || creator
//!   || metadataHash || rulesHash || i64le(notBefore) || i64le(notAfter)`,
//!   its hash, the
//!   `["launch", creator, launchSeed]` and `["attestation", launch]`
//!   addresses, the unix time the vectors land at, and the leaf probe start
//!   (`metadata.json` has the record's own vectors);
//! * `signatures`: the identity's deterministic signatures of that message
//!   at leaves 0, 1, 511, 512 and 1023 (`C = HMAC-SHA256(SEED,
//!   "phalanx/pq/lmots/C" || I || u32be(q) || message)`), whole;
//! * `attestLaunch`: the instruction for leaf 511 (discriminator, borsh
//!   arguments, accounts), and `v1`, the signed transaction a client sends
//!   it in (A14: a throwaway fee payer from `payerSeed`, 300,000 CU, 2 MiB of
//!   loaded data, the fixed `recentBlockhash`), wire bytes per SPEC §3;
//! * `accounts`: the `Launch` the attestation is for (v2 layout; the fields
//!   `attest_launch` reads, the rest zero), its published `TokenMeta`
//!   record, and the `Identity` and `Attestation` accounts once that
//!   transaction landed in slot `accounts.attestation.slot`, byte for byte;
//! * `events`: `LaunchAttested` of that landing, and `PqLeafConsumed` of the
//!   leaf-0 signature landing after it;
//! * `bitmap`: byte and mask of sample leaves (least significant bit first);
//! * `leafSelection`: the next leaf from a bitmap and a probe start (first
//!   clear bit, +1 with wrap-around; `null` when exhausted);
//! * `rejections`: tampered signatures, keys and metadata, as patches of
//!   the leaf-511 signature and the public key, that the verifier refuses
//!   (`verify: null`) and the program refuses with `programError`;
//! * `burnOnly`: valid signatures that land, burn their leaf and attest
//!   nothing (metadata that can never be a record, a valid record never
//!   published, creator rules never published, a window that cannot open,
//!   another identity of the same phrase), landed in order on a fresh ledger
//!   with the vector record published, with their `PqLeafConsumed` and the
//!   empty attestation account they leave;
//! * `passkey` (A12): `entropy = HKDF-SHA256(IKM = PRF output, salt =
//!   "phalanx/pq/passkey/v1", info = "phalanx/pq/passkey/v1/bip39-entropy",
//!   L = 32)`, the 24-word phrase's entropy, plus RFC 5869 test case 1 as a
//!   self-check of the HKDF.
//!
//! An independent implementation checks every value except the addresses
//! and the transaction bytes: `python -I scripts/pq/lms_reference.py
//! attest-vectors tests/integration/vectors/lms.json`. This test fails if
//! the committed file is missing or differs from what the Rust side produces
//! now; to (re)write it after a deliberate change, run with
//! `NOISED_WRITE_SDK_VECTORS=1`.

// The vector document is one `json!` literal, deeper than the default limit.
#![recursion_limit = "256"]

mod common;

use common::{
    anchor_discriminator,
    launchpad::{
        apply_patch, attest_launch_data, attest_launch_ix, attest_tx_config,
        attestation_account_data, attestation_message, attestation_pda,
        empty_attestation_account_data, hex, identity_account_data, identity_id, identity_pda,
        launch_account_data, launch_attested_event, launch_pda, launch_window_is_valid,
        leaf_probe_start, mark_leaf, metadata_borsh, metadata_hash, metadata_is_valid,
        next_free_leaf, pq_leaf_consumed_event, rules_account, rules_hash, token_meta_account_data,
        token_meta_pda, unhex, AttestationRecord, LaunchFields, Metadata, Terms,
        ATTESTATION_ACCOUNT_LEN, ATTESTATION_MISMATCH, ATTESTATION_VERSION, ATTEST_CU_LIMIT,
        ATTEST_LOADED_ACCOUNTS_DATA_LIMIT, ATTEST_MESSAGE_LEN, ATTEST_MESSAGE_TAG, CAP_EXCEEDED,
        IDENTITY_ACCOUNT_LEN, INVALID_METADATA, INVALID_METADATA_FLAGS, INVALID_PAYOUT_OWNER,
        INVALID_PQ_IDENTITY, INVALID_PQ_SIGNATURE, INVALID_RULES, LAUNCH_ACCOUNT_LEN,
        LAUNCH_CREATOR_OFFSET, LAUNCH_PARAMS_HASH_OFFSET, LAUNCH_PQ_IDENTITY_OFFSET,
        LAUNCH_STATUS_OFFSET, LEAF_BITMAP_LEN, LEAF_PROBE_TAG, LEAF_WARN_AT_USED, MAX_DOC_LEN,
        MAX_LAUNCH_LEAD_SECS, MAX_LAUNCH_WINDOW_SECS, MAX_NAME_LEN, MAX_SYMBOL_LEN, MAX_URI_LEN,
        METADATA_HASH_TAG, METADATA_MISMATCH, METADATA_TOO_LONG, MIN_LAUNCH_WINDOW_SECS,
        NOT_LAUNCH_WINDOW, NO_RULES, PAYOUT_VAULT_ACCOUNT_LEN, PQ_LEAF_USED, RULES_HASH_TAG,
        TOKEN_META_FIXED_LEN,
    },
    sha256,
    svm::{v1_wire_per_spec, GENESIS_UNIX_TS},
    Instruction, Keypair, Pubkey, Signer, LAUNCHPAD_PROGRAM_ID, SYSTEM_PROGRAM_ID,
};
use noised_lmots::{
    hmac_sha256, lms_verify, LmsKeyPair, LmsPrivateKey, Sha2, LMS_LEAVES, LMS_PUBLIC_KEY_LEN,
    LMS_SIG_LEN,
};
use serde_json::{json, Value};
use solana_message::{v1, Hash, VersionedMessage};
use solana_transaction::versioned::VersionedTransaction;

const VECTOR_FILE: &str = "vectors/lms.json";
// protocol constants (identity and passkey tags): kept from the original name; changing them changes every derived key and the vectors
const SEED_TAG: &[u8] = b"phalanx/pq/identity/v1/seed";
const ID_TAG: &[u8] = b"phalanx/pq/identity/v1/id";
const PRF_SALT: &str = "phalanx/pq/passkey/v1/prf-salt";
const HKDF_SALT: &[u8] = b"phalanx/pq/passkey/v1";
const HKDF_INFO: &[u8] = b"phalanx/pq/passkey/v1/bip39-entropy";
const CLUSTER_LOCALNET: u8 = 2;
/// The leaves the vector identity signs the attestation message at.
const LEAVES: [u32; 5] = [0, 1, 511, 512, 1023];
/// The leaf of the attestation that lands first (`attestLaunch`).
const ATTEST_LEAF: u32 = 511;
/// The slot that attestation lands in (`accounts.attestation.slot`).
const ATTEST_SLOT: u64 = 400_000_000;
/// The unix time every vector lands at (`attestation.landsAt`).
const LANDS_AT: i64 = GENESIS_UNIX_TS;
/// The leaf whose later signature `events.pqLeafConsumed` reports.
const BURNED_LEAF: u32 = 0;
/// The vector record: no uri (flags 0), and this document.
const VECTOR_NAME: &str = "Phalanx Vector Token";
const VECTOR_SYMBOL: &str = "PHXV";
const VECTOR_DOC: &str =
    r#"{"name":"Phalanx Vector Token","symbol":"PHXV","description":"PQ v2 test vectors"}"#;

/// A deterministic 32-byte value derived from a label.
fn fixed(label: &str) -> [u8; 32] {
    sha256(&[b"phalanx-lms-vectors/", label.as_bytes()])
}

/// The master seed the crate's own known answers use: bytes 0..64.
fn master() -> [u8; 64] {
    std::array::from_fn(|i| i as u8)
}

fn path(cluster: u8, index: u32) -> [u8; 5] {
    let mut p = [cluster, 0, 0, 0, 0];
    p[1..].copy_from_slice(&index.to_le_bytes());
    p
}

/// HKDF-SHA256 (RFC 5869) from HMAC-SHA256.
fn hkdf_sha256(ikm: &[u8], salt: &[u8], info: &[u8], len: usize) -> Vec<u8> {
    let prk = hmac_sha256::<Sha2>(salt, &[ikm]);
    let mut okm = Vec::with_capacity(len + 32);
    let mut block: Vec<u8> = Vec::new();
    for counter in 1u8.. {
        if okm.len() >= len {
            break;
        }
        block = hmac_sha256::<Sha2>(&prk, &[&block, info, &[counter]]).to_vec();
        okm.extend_from_slice(&block);
    }
    okm.truncate(len);
    okm
}

fn derivation_cases() -> Value {
    let m = master();
    let mut cases = Vec::new();
    for cluster in 0..=2u8 {
        for index in 0..=1u32 {
            let p = path(cluster, index);
            let seed = sha256(&[SEED_TAG, &m, &p]);
            let id = &sha256(&[ID_TAG, &m, &p])[..16];
            let key = LmsPrivateKey::derive_identity::<Sha2>(&m, cluster, index).unwrap();
            assert_eq!((key.seed.as_slice(), key.id.as_slice()), (&seed[..], id));
            cases.push(json!({
                "cluster": cluster,
                "index": index,
                "path": hex(&p),
                "seed": hex(&seed),
                "i": hex(id),
            }));
        }
    }
    // Refused derivations: a fourth cluster byte, and the all-zero master.
    assert!(LmsPrivateKey::derive_identity::<Sha2>(&m, 3, 0).is_none());
    assert!(LmsPrivateKey::derive_identity::<Sha2>(&[0; 64], 0, 0).is_none());
    json!({
        "master": hex(&m),
        "seedTag": std::str::from_utf8(SEED_TAG).unwrap(),
        "idTag": std::str::from_utf8(ID_TAG).unwrap(),
        "maxCluster": 2,
        "cases": cases,
    })
}

/// A v1 transaction of `ixs` paid and signed by `fee_payer` with the A14
/// config words, exactly as validators parse it (SPEC §3).
fn v1_json(fee_payer: &Keypair, ixs: &[Instruction], recent_blockhash: Hash) -> Value {
    let config = attest_tx_config();
    let msg =
        v1::Message::try_compile_with_config(&fee_payer.pubkey(), ixs, recent_blockhash, config)
            .expect("compile v1 message");
    let tx = VersionedTransaction::try_new(VersionedMessage::V1(msg), &[fee_payer])
        .expect("sign v1 transaction");
    let wire = wincode::serialize(&tx).expect("serialize v1 transaction");
    assert_eq!(wire, v1_wire_per_spec(&tx), "SPEC §3 layout");
    assert!(wire.len() <= v1::MAX_TRANSACTION_SIZE);
    let message_bytes = tx.message.serialize();
    assert_eq!(&wire[..message_bytes.len()], &message_bytes[..]);
    let VersionedMessage::V1(compiled) = &tx.message else {
        unreachable!("v1 message")
    };
    json!({
        "computeUnitLimit": config.compute_unit_limit,
        "loadedAccountsDataSizeLimit": config.loaded_accounts_data_size_limit,
        "recentBlockhash": recent_blockhash.to_string(),
        "header": [
            compiled.header.num_required_signatures,
            compiled.header.num_readonly_signed_accounts,
            compiled.header.num_readonly_unsigned_accounts,
        ],
        "accountKeys": compiled.account_keys.iter().map(|k| k.to_string()).collect::<Vec<_>>(),
        "message": hex(&message_bytes),
        "wire": hex(&wire),
    })
}

/// A metadata record as JSON: the strings when they are UTF-8, and always
/// the bytes in hex (one burn-only case's name is not UTF-8).
fn metadata_json(m: Metadata) -> Value {
    let text = |b: &[u8]| std::str::from_utf8(b).map_or(Value::Null, |s| json!(s));
    json!({
        "name": text(m.name),
        "symbol": text(m.symbol),
        "flags": m.flags,
        "uri": text(m.uri),
        "doc": text(m.doc),
        "nameHex": hex(m.name),
        "symbolHex": hex(m.symbol),
        "uriHex": hex(m.uri),
        "docHex": hex(m.doc),
    })
}

fn terms_json(t: &Terms) -> Value {
    json!({
        "notBefore": t.not_before,
        "notAfter": t.not_after,
        "rulesHash": hex(&t.rules_hash),
    })
}

/// The leaf choice on sample bitmaps: the probe start of the vector message
/// on an empty bitmap; the bitmap the vector signatures leave on-chain
/// (`tests/vectors_onchain.rs` reads it back) probed from 511; a wrap past
/// leaf 1023; one free leaf left; an exhausted identity.
fn leaf_selection_cases(probe_start: u32) -> Value {
    let empty = [0u8; LEAF_BITMAP_LEN];
    let mut landed = empty;
    for q in LEAVES {
        mark_leaf(&mut landed, q);
    }
    let mut wrap = empty;
    for q in [1022, 1023, 0] {
        mark_leaf(&mut wrap, q);
    }
    let mut one_free = [0xffu8; LEAF_BITMAP_LEN];
    one_free[700 >> 3] &= !(1 << (700 & 7));
    let full = [0xffu8; LEAF_BITMAP_LEN];
    let cases = [
        (
            "no leaf used yet: the message's probe start",
            empty,
            probe_start,
            Some(probe_start),
        ),
        (
            "the five vector leaves landed (the identity account after them), probing from 511",
            landed,
            511,
            Some(513),
        ),
        (
            "the probe wraps around after leaf 1023",
            wrap,
            1022,
            Some(1),
        ),
        ("only leaf 700 is free", one_free, probe_start, Some(700)),
        (
            "every leaf used: the identity is exhausted, move to the next identity index",
            full,
            probe_start,
            None,
        ),
    ];
    Value::Array(
        cases
            .iter()
            .map(|(name, used, start, next)| {
                assert_eq!(next_free_leaf(used, *start), *next, "{name}");
                let count: u32 = used.iter().map(|b| b.count_ones()).sum();
                json!({
                    "name": name,
                    "probeStart": start,
                    "used": hex(used),
                    "usedCount": count,
                    "next": next,
                })
            })
            .collect(),
    )
}

/// One rejection case: patches of the leaf-511 signature and of the public
/// key, and the metadata the message is built from.
struct Rejection {
    name: &'static str,
    signature: Value,
    public_key: Value,
    metadata: Metadata<'static>,
}

/// Inputs the verifier must refuse, each with the error the program
/// refuses them with: none verifies, so each fails `InvalidPqSignature`
/// (the client sends the identity account of the key it sends; metadata
/// and the window are not checked before the signature, and a valid
/// signature over anything lands, see `burnOnly`).
fn rejection_cases(
    pk: &[u8; LMS_PUBLIC_KEY_LEN],
    sig: &[u8],
    metadata: Metadata<'static>,
    message_of: impl Fn(Metadata) -> Vec<u8>,
) -> Value {
    let path_at = |i: usize| 2188 + 32 * i;
    let swapped = [&sig[path_at(1)..path_at(2)], &sig[path_at(0)..path_at(1)]].concat();
    let none = json!([]);
    let set = |offset: usize, bytes: &str| json!([{"op": "set", "offset": offset, "hex": bytes}]);
    let xor = |offset: usize, bytes: &str| json!([{"op": "xor", "offset": offset, "hex": bytes}]);
    let sig_case = |name, signature| Rejection {
        name,
        signature,
        public_key: none.clone(),
        metadata,
    };
    let pk_case = |name, public_key| Rejection {
        name,
        signature: none.clone(),
        public_key,
        metadata,
    };
    let meta_case = |name, metadata| Rejection {
        name,
        signature: none.clone(),
        public_key: none.clone(),
        metadata,
    };
    let cases = [
        sig_case("q = 1024: no such leaf", set(0, "00000400")),
        sig_case("q = 512: another leaf's position", set(0, "00000200")),
        sig_case("q = 0xffffffff", set(0, "ffffffff")),
        sig_case(
            "LM-OTS typecode 4 (LMOTS_SHA256_N32_W8)",
            set(4, "00000004"),
        ),
        sig_case("LMS typecode 5 (LMS_SHA256_M32_H5)", set(2184, "00000005")),
        sig_case("C: first byte flipped", xor(8, "01")),
        sig_case("y[0]: first byte flipped", xor(40, "01")),
        sig_case("y[66]: last byte flipped", xor(2183, "80")),
        sig_case("path[0]: first byte flipped", xor(path_at(0), "01")),
        sig_case("path[9]: last byte flipped", xor(2507, "80")),
        sig_case(
            "path[0] and path[1] swapped",
            set(path_at(0), &hex(&swapped)),
        ),
        sig_case(
            "one byte short",
            json!([{"op": "truncate", "length": LMS_SIG_LEN - 1}]),
        ),
        sig_case("one byte long", json!([{"op": "append", "hex": "00"}])),
        sig_case("empty", json!([{"op": "truncate", "length": 0}])),
        meta_case(
            "another document: the signed message differs",
            Metadata {
                doc: br#"{"name":"Phalanx Vector Token","symbol":"PHXV","description":"PQ v2 test vectorz"}"#,
                ..metadata
            },
        ),
        meta_case(
            "another symbol: the signed message differs",
            Metadata {
                symbol: b"PHXW",
                ..metadata
            },
        ),
        pk_case("public key: T[1] first byte flipped", xor(24, "01")),
        pk_case("public key: I first byte flipped", xor(8, "01")),
        pk_case("public key: LMS typecode 5", set(0, "00000005")),
        pk_case("public key: LM-OTS typecode 4", set(4, "00000004")),
    ];
    Value::Array(
        cases
            .iter()
            .map(|c| {
                let bad_pk: [u8; LMS_PUBLIC_KEY_LEN] = apply_patch(pk, &c.public_key)
                    .try_into()
                    .expect("public key patches keep 56 bytes");
                let bad_sig = apply_patch(sig, &c.signature);
                let message = message_of(c.metadata);
                assert_eq!(
                    lms_verify::<Sha2>(&bad_pk, &message, &bad_sig),
                    None,
                    "{}",
                    c.name
                );
                json!({
                    "name": c.name,
                    "signaturePatch": c.signature,
                    "publicKeyPatch": c.public_key,
                    "metadata": metadata_json(c.metadata),
                    "verify": null,
                    "programError": INVALID_PQ_SIGNATURE.name,
                    "programErrorNumber": INVALID_PQ_SIGNATURE.number,
                })
            })
            .collect(),
    )
}

/// Valid signatures the program lands only to burn their leaf, in landing
/// order on a fresh ledger holding the vector launch and its published
/// record: records `publish_metadata` refuses, so that none can exist
/// (multi-byte characters counted in bytes, an empty symbol, a name that is
/// not UTF-8), a valid record that was never published, creator rules that
/// were never published (a valid rule set's hash, no `LaunchRules` at its
/// address), windows that cannot open when they land, and a signature by
/// the same phrase's identity index
/// 1 (the launch names index 0). Each takes the leaf its message probes to,
/// the first clear bit of its identity after the cases before it.
#[allow(clippy::too_many_arguments)]
fn burn_only_cases(
    kp: &LmsKeyPair,
    other: &LmsKeyPair,
    launch: &Pubkey,
    params_hash: &[u8; 32],
    creator: &Pubkey,
    metadata: Metadata<'static>,
    terms: Terms,
    attestation_bump: u8,
) -> Value {
    let euros: &'static str =
        "\u{20ac}\u{20ac}\u{20ac}\u{20ac}\u{20ac}\u{20ac}\u{20ac}\u{20ac}\u{20ac}\u{20ac}\u{20ac}";
    assert_eq!((euros.chars().count(), euros.len()), (11, 33));
    let window = |not_before: i64, not_after: i64| Terms {
        not_before,
        not_after,
        rules_hash: [0; 32],
    };
    let ms = LANDS_AT * 1_000;
    let published = metadata_hash(metadata);
    // "PXR1", version 1, no keys, one rule, one node: deny buys in the first
    // two minutes (a valid rule set; nothing publishes it here).
    let mut unpublished = b"PXR1\x01\x00\x01\x01\x00\x00\x00\x00".to_vec();
    unpublished.extend_from_slice(&0u32.to_le_bytes());
    unpublished.extend_from_slice(&120u32.to_le_bytes());
    unpublished.extend_from_slice(&[0, 1, 1, 1]);
    unpublished.extend_from_slice(&0u64.to_le_bytes());
    unpublished.extend_from_slice(&[0x10, 0]);
    unpublished.extend_from_slice(&0u64.to_le_bytes());
    let with_rules = Terms {
        rules_hash: rules_hash(&unpublished),
        ..terms
    };
    let cases: [(&str, &LmsKeyPair, Metadata<'static>, Terms); 10] = [
        (
            "a name of 11 characters and 33 UTF-8 bytes",
            kp,
            Metadata {
                name: euros.as_bytes(),
                ..metadata
            },
            terms,
        ),
        (
            "an empty symbol",
            kp,
            Metadata {
                symbol: b"",
                ..metadata
            },
            terms,
        ),
        (
            "a name that is not UTF-8",
            kp,
            Metadata {
                name: b"PH\xc0\xaf",
                ..metadata
            },
            terms,
        ),
        (
            "a valid record that was never published (another document)",
            kp,
            Metadata {
                doc: br#"{"name":"Phalanx Vector Token","symbol":"PHXV"}"#,
                ..metadata
            },
            terms,
        ),
        (
            "creator rules that were never published",
            kp,
            metadata,
            with_rules,
        ),
        (
            "a window of an hour and a second",
            kp,
            metadata,
            window(LANDS_AT, LANDS_AT + MAX_LAUNCH_WINDOW_SECS + 1),
        ),
        (
            "a window that closed a second before it landed",
            kp,
            metadata,
            window(LANDS_AT - 3_600, LANDS_AT - 1),
        ),
        (
            "a window opening a week and a second after it landed",
            kp,
            metadata,
            window(
                LANDS_AT + MAX_LAUNCH_LEAD_SECS + 1,
                LANDS_AT + MAX_LAUNCH_LEAD_SECS + 61,
            ),
        ),
        (
            "a window in milliseconds",
            kp,
            metadata,
            window(ms, ms + 3_600_000),
        ),
        (
            "the same phrase's identity index 1 (the launch names index 0)",
            other,
            metadata,
            terms,
        ),
    ];
    let mut bitmaps: std::collections::HashMap<[u8; 32], [u8; LEAF_BITMAP_LEN]> =
        Default::default();
    let out: Vec<Value> = cases
        .iter()
        .map(|(name, signer, m, t)| {
            let pk = signer.public_key().to_bytes();
            let pq_identity = identity_id(&pk);
            let hash = metadata_hash(*m);
            let message = attestation_message(launch, params_hash, creator, &hash, t);
            let used = bitmaps.entry(pq_identity).or_insert([0; LEAF_BITMAP_LEN]);
            let start = leaf_probe_start(&pk[8..24], &message);
            let q = next_free_leaf(used, start).expect("a free leaf");
            mark_leaf(used, q);
            let sig = signer.sign_deterministic::<Sha2>(q, &message).unwrap();
            assert_eq!(lms_verify::<Sha2>(&pk, &message, &sig), Some(q), "{name}");
            // Why it attests nothing: the record its hash names is not the
            // published one (no other exists), the window, or the identity.
            let attests = pq_identity == identity_id(&kp.public_key().to_bytes())
                && hash == published
                && t.rules_hash == NO_RULES
                && launch_window_is_valid(LANDS_AT, t.not_before, t.not_after);
            assert!(!attests, "{name}");
            assert!(hash == published || metadata_is_valid(*m) == name.contains("never published"));
            json!({
                "name": name,
                "q": q,
                "probeStart": start,
                "publicKey": hex(&pk),
                "identityId": hex(&pq_identity),
                "identityAccount": identity_pda(&pq_identity).0.to_string(),
                "metadata": metadata_json(*m),
                "metadataHash": hex(&hash),
                "tokenMetaAccount": token_meta_pda(launch, &hash).0.to_string(),
                "rulesAccount": rules_account(launch, &t.rules_hash).to_string(),
                "terms": terms_json(t),
                "message": hex(&message),
                "signature": hex(&sig),
                "data": hex(&attest_launch_data(&pk, &sig, &hash, t)),
                "event": hex(&pq_leaf_consumed_event(&pq_identity, q as u16, launch)),
            })
        })
        .collect();
    json!({
        "landsAt": LANDS_AT,
        "cases": out,
        "emptyAttestation": hex(&empty_attestation_account_data(attestation_bump)),
    })
}

#[test]
fn hkdf_matches_rfc_5869_test_case_1() {
    let okm = hkdf_sha256(
        &[0x0b; 22],
        &unhex("000102030405060708090a0b0c"),
        &unhex("f0f1f2f3f4f5f6f7f8f9"),
        42,
    );
    assert_eq!(
        hex(&okm),
        "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
    );
}

/// The patch format of `rejections` does what it says.
#[test]
fn rejection_patches_apply_as_documented() {
    let base: Vec<u8> = (0u8..8).collect();
    let ops = json!([
        {"op": "set", "offset": 1, "hex": "aabb"},
        {"op": "xor", "offset": 4, "hex": "ff"},
        {"op": "truncate", "length": 6},
        {"op": "append", "hex": "0102"},
    ]);
    assert_eq!(apply_patch(&base, &ops), [0, 0xaa, 0xbb, 3, 0xfb, 5, 1, 2]);
    assert_eq!(apply_patch(&base, &json!([])), base);
}

/// Name and symbol limits are UTF-8 bytes, not characters (a JavaScript
/// `length` counts UTF-16 units): what clients must check before publishing.
fn metadata_examples() -> Value {
    let euro = "\u{20ac}";
    let cases: [(&str, String, String, &str); 7] = [
        ("32 ASCII bytes", "N".repeat(32), "S".into(), ""),
        ("33 ASCII bytes", "N".repeat(33), "S".into(), ""),
        (
            "10 euro signs and 2 letters: 12 characters, 32 bytes",
            euro.repeat(10) + "NN",
            "S".into(),
            "",
        ),
        (
            "11 euro signs: 11 characters, 33 bytes",
            euro.repeat(11),
            "S".into(),
            "",
        ),
        (
            "a symbol of 4 euro signs: 4 characters, 12 bytes",
            "N".into(),
            euro.repeat(4),
            "",
        ),
        ("an empty symbol", "N".into(), String::new(), ""),
        (
            "an emoji symbol: 2 UTF-16 units, 4 bytes",
            "N".into(),
            "\u{1f680}".into(),
            "",
        ),
    ];
    Value::Array(
        cases
            .iter()
            .map(|(what, name, symbol, uri)| {
                let m = Metadata::new(name, symbol, 0, uri, "");
                json!({
                    "name": what,
                    "metadata": metadata_json(m),
                    "nameChars": name.chars().count(),
                    "nameBytes": name.len(),
                    "symbolChars": symbol.chars().count(),
                    "symbolBytes": symbol.len(),
                    "valid": metadata_is_valid(m),
                })
            })
            .collect(),
    )
}

#[test]
fn lms_vectors_match_the_committed_file() {
    let m = master();
    let key = LmsPrivateKey::derive_identity::<Sha2>(&m, CLUSTER_LOCALNET, 0).unwrap();
    let (seed, id) = (key.seed, key.id);
    let kp: LmsKeyPair = key.keygen::<Sha2>();
    let pk = kp.public_key().to_bytes();
    assert_eq!(pk.len(), LMS_PUBLIC_KEY_LEN);
    assert_eq!(&pk[..8], &[0, 0, 0, 6, 0, 0, 0, 3]);
    assert_eq!(&pk[8..24], &id);
    let pq_identity = identity_id(&pk);
    assert_eq!(pq_identity, kp.identity_id::<Sha2>());
    let nodes = kp.nodes();
    assert_eq!(nodes.len(), 2 * LMS_LEAVES as usize - 1);
    assert_eq!(nodes[0], pk[24..], "T[1] is the root");
    let nodes_sha256 = sha256(&[&nodes.concat()]);
    let other = LmsPrivateKey::derive_identity::<Sha2>(&m, CLUSTER_LOCALNET, 1)
        .unwrap()
        .keygen::<Sha2>();

    let metadata = Metadata::new(VECTOR_NAME, VECTOR_SYMBOL, 0, "", VECTOR_DOC);
    assert!(metadata_is_valid(metadata));
    let meta_borsh = metadata_borsh(metadata);
    let meta_hash = metadata_hash(metadata);
    assert_eq!(meta_hash, sha256(&[METADATA_HASH_TAG, &meta_borsh]));
    let mut strings = Vec::new();
    anchor_lang::AnchorSerialize::serialize(
        &(
            VECTOR_NAME.to_string(),
            VECTOR_SYMBOL.to_string(),
            0u8,
            String::new(),
            VECTOR_DOC.to_string(),
        ),
        &mut strings,
    )
    .unwrap();
    assert_eq!(meta_borsh, strings, "bytes encode like strings");
    let terms = Terms {
        not_before: LANDS_AT,
        not_after: LANDS_AT + MAX_LAUNCH_WINDOW_SECS,
        rules_hash: [0; 32],
    };
    assert!(launch_window_is_valid(
        LANDS_AT,
        terms.not_before,
        terms.not_after
    ));
    let launch_seed = fixed("launch-seed");
    let creator = Pubkey::new_from_array(fixed("creator"));
    let (launch, launch_bump) = launch_pda(&creator, &launch_seed);
    let params_hash = fixed("params-hash");
    let message_of = |m: Metadata| {
        attestation_message(&launch, &params_hash, &creator, &metadata_hash(m), &terms)
    };
    let message = message_of(metadata);
    assert_eq!(message.len(), ATTEST_MESSAGE_LEN);
    let message_hash = sha256(&[&message]);
    let probe_start = leaf_probe_start(&id, &message);

    let sign = |q: u32| {
        let sig = kp.sign_deterministic::<Sha2>(q, &message).unwrap();
        assert_eq!(sig.len(), LMS_SIG_LEN);
        assert_eq!(lms_verify::<Sha2>(&pk, &message, &sig), Some(q));
        sig
    };
    let signatures: Vec<Value> = LEAVES
        .iter()
        .map(|&q| {
            let sig = sign(q);
            let c = kp
                .private_key()
                .leaf(q)
                .unwrap()
                .randomizer::<Sha2>(&message);
            // C written out from RFC 2104 (one-block key).
            assert_eq!(
                c,
                hmac_sha256::<Sha2>(
                    &seed,
                    &[b"phalanx/pq/lmots/C", &id, &q.to_be_bytes(), &message]
                )
            );
            assert_eq!(&sig[..4], &q.to_be_bytes());
            assert_eq!(&sig[8..40], &c);
            json!({
                "q": q,
                "c": hex(&c),
                "signature": hex(&sig),
                "sha256": hex(&sha256(&[&sig])),
            })
        })
        .collect();

    // `attest_launch` for leaf 511 from a throwaway fee payer (any key; a
    // fixed one here), and the v1 transaction that carries it.
    let sig_attest = sign(ATTEST_LEAF);
    let payer_seed = fixed("throwaway-payer");
    let payer = Keypair::new_from_array(payer_seed);
    let attest = attest_launch_ix(&payer.pubkey(), &launch, &pk, &sig_attest, metadata, &terms);
    assert_eq!(
        attest.data,
        attest_launch_data(&pk, &sig_attest, &meta_hash, &terms)
    );
    assert_eq!(attest.data[..8], [181, 24, 201, 53, 246, 126, 253, 79]);
    let blockhash = Hash::new_from_array(fixed("blockhash"));
    let (identity_address, identity_bump) = identity_pda(&pq_identity);
    let (attestation_address, attestation_bump) = attestation_pda(&launch);
    let (token_meta_address, token_meta_bump) = token_meta_pda(&launch, &meta_hash);
    let token_meta_data = token_meta_account_data(token_meta_bump, &launch, metadata);

    // What the landing writes, from the documented layouts.
    let launch_data = launch_account_data(&LaunchFields {
        bump: launch_bump,
        live: false,
        launch_seed,
        creator,
        params_hash,
        pq_identity,
    });
    let mut used = [0u8; LEAF_BITMAP_LEN];
    mark_leaf(&mut used, ATTEST_LEAF);
    let identity_data = identity_account_data(identity_bump, &pk, &used);
    let record = AttestationRecord {
        bump: attestation_bump,
        launch,
        pq_identity,
        leaf: ATTEST_LEAF as u16,
        metadata_hash: meta_hash,
        message_hash,
        slot: ATTEST_SLOT,
        terms,
        signature: sig_attest.clone(),
    };
    let attestation_data = attestation_account_data(&record);

    let bitmap: Vec<Value> = [0u32, 7, 8, 511, 512, 700, 1023]
        .iter()
        .map(|&q| json!({"q": q, "byte": q >> 3, "mask": 1u32 << (q & 7)}))
        .collect();
    let prf_output = fixed("prf-output");
    let entropy = hkdf_sha256(&prf_output, HKDF_SALT, HKDF_INFO, 32);
    let discriminators: serde_json::Map<String, Value> = [
        (
            "attestLaunch",
            anchor_discriminator("global", "attest_launch"),
        ),
        (
            "publishMetadata",
            anchor_discriminator("global", "publish_metadata"),
        ),
        ("launch", anchor_discriminator("account", "Launch")),
        ("tokenMeta", anchor_discriminator("account", "TokenMeta")),
        ("identity", anchor_discriminator("account", "Identity")),
        (
            "attestation",
            anchor_discriminator("account", "Attestation"),
        ),
        (
            "payoutVault",
            anchor_discriminator("account", "PayoutVault"),
        ),
        (
            "launchAttested",
            anchor_discriminator("event", "LaunchAttested"),
        ),
        (
            "pqLeafConsumed",
            anchor_discriminator("event", "PqLeafConsumed"),
        ),
        (
            "metadataPublished",
            anchor_discriminator("event", "MetadataPublished"),
        ),
    ]
    .iter()
    .map(|(name, d)| (name.to_string(), json!(hex(d))))
    .collect();
    let errors: Vec<Value> = [
        INVALID_METADATA,
        CAP_EXCEEDED,
        INVALID_PQ_IDENTITY,
        INVALID_PQ_SIGNATURE,
        PQ_LEAF_USED,
        ATTESTATION_MISMATCH,
        INVALID_PAYOUT_OWNER,
        NOT_LAUNCH_WINDOW,
        INVALID_METADATA_FLAGS,
        METADATA_TOO_LONG,
        METADATA_MISMATCH,
        INVALID_RULES,
    ]
    .iter()
    .map(|e| json!({"name": e.name, "number": e.number}))
    .collect();

    let vectors = json!({
        // Provenance text pinned byte-for-byte in the committed vector file (written before the rename to Noised): kept so the file stays identical.
        "source": "tests/integration/tests/lms_vectors.rs (phalanx-lmots LMS_SHA256_M32_H10 / LMOTS_SHA256_N32_W4; PQ v2 amendments A4, A5, A12, A13, A14, A16 with the adversarial review's fixes; attestation message v3 over the on-chain metadata record, METADATA_PROGRAM.md, and the creator rules hash, PROGRAMMABLE_V1.md, zero here: see programmable.json); landed on the launchpad build by tests/integration/tests/vectors_onchain.rs; independent check: python -I scripts/pq/lms_reference.py attest-vectors tests/integration/vectors/lms.json",
        "parameters": {
            "lmsType": 6,
            "otsType": 3,
            "height": 10,
            "leaves": LMS_LEAVES,
            "publicKeyLen": LMS_PUBLIC_KEY_LEN,
            "signatureLen": LMS_SIG_LEN,
            "identityIdDomain": 0x21,
            "attestMessageTag": std::str::from_utf8(ATTEST_MESSAGE_TAG).unwrap(),
            "metadataHashTag": std::str::from_utf8(METADATA_HASH_TAG).unwrap(),
            "rulesHashTag": std::str::from_utf8(RULES_HASH_TAG).unwrap(),
            "noRulesHash": hex(&NO_RULES),
            "attestMessageLen": ATTEST_MESSAGE_LEN,
            "attestMessageLayout": "tag(13) programId(32) launch(32) paramsHash(32) creator(32) metadataHash(32) rulesHash(32) i64le notBefore(8) i64le notAfter(8)",
            "metadataHashLayout": "SHA256(metadataHashTag || u32le(len) name || u32le(len) symbol || u8 flags || u32le(len) uri || u32le(len) doc)",
            "leafProbeTag": std::str::from_utf8(LEAF_PROBE_TAG).unwrap(),
            "leafProbe": "start = u16be(SHA256(leafProbeTag || I || message)[0..2]) mod 1024, I = publicKey[8..24]; then the first leaf clear in the identity's bitmap (and absent from the client's records), +1 with wrap-around",
            "launchpad": LAUNCHPAD_PROGRAM_ID.to_string(),
            "launchSeeds": ["launch", "creator", "launchSeed"],
            "identitySeed": "identity",
            "attestationSeed": "attestation",
            "payoutVaultSeeds": ["payout-vault", "launch", "vault"],
            "tokenMetaSeeds": ["metadata", "launch", "metadataHash"],
            "identityAccountLen": IDENTITY_ACCOUNT_LEN,
            "attestationAccountLen": ATTESTATION_ACCOUNT_LEN,
            "attestationVersion": ATTESTATION_VERSION,
            "tokenMetaFixedLen": TOKEN_META_FIXED_LEN,
            "payoutVaultAccountLen": PAYOUT_VAULT_ACCOUNT_LEN,
            "launchAccountLen": LAUNCH_ACCOUNT_LEN,
            "launchOffsets": {
                "status": LAUNCH_STATUS_OFFSET,
                "creator": LAUNCH_CREATOR_OFFSET,
                "paramsHash": LAUNCH_PARAMS_HASH_OFFSET,
                "pqIdentity": LAUNCH_PQ_IDENTITY_OFFSET,
            },
            "attestationOffsets": {
                "launch": 10,
                "pqIdentity": 42,
                "leaf": 74,
                "metadataHash": 76,
                "rulesHash": 108,
                "messageHash": 140,
                "slot": 172,
                "notBefore": 180,
                "notAfter": 188,
                "signatureLen": 196,
                "signature": 200,
            },
            "attestCuLimit": ATTEST_CU_LIMIT,
            "attestLoadedAccountsDataLimit": ATTEST_LOADED_ACCOUNTS_DATA_LIMIT,
            "metadataLimits": {
                "unit": "UTF-8 bytes (not characters or UTF-16 units)",
                "maxNameLen": MAX_NAME_LEN,
                "maxSymbolLen": MAX_SYMBOL_LEN,
                "maxUriLen": MAX_URI_LEN,
                "maxDocLen": MAX_DOC_LEN,
                "nameAndSymbolNonEmpty": true,
                "utf8Required": true,
                "rules": "see metadata.json (flags, external uri, document)",
                "examples": metadata_examples(),
            },
            "launchWindow": {
                "minSecs": MIN_LAUNCH_WINDOW_SECS,
                "maxSecs": MAX_LAUNCH_WINDOW_SECS,
                "maxLeadSecs": MAX_LAUNCH_LEAD_SECS,
                "rule": "recorded only if minSecs <= notAfter - notBefore <= maxSecs, landing time <= notAfter, and notBefore <= landing time + maxLeadSecs; launch runs only when notBefore <= now <= notAfter, and anyone may run it then",
            },
            "leafWarnAtUsed": LEAF_WARN_AT_USED,
            "errors": errors,
            "discriminators": discriminators,
        },
        "derivation": derivation_cases(),
        "identity": {
            "cluster": CLUSTER_LOCALNET,
            "index": 0,
            "seed": hex(&seed),
            "i": hex(&id),
            "root": hex(&pk[24..]),
            "publicKey": hex(&pk),
            "identityId": hex(&pq_identity),
            "identityAccount": identity_address.to_string(),
            "nodesSha256": hex(&nodes_sha256),
        },
        "metadata": {
            "name": VECTOR_NAME,
            "symbol": VECTOR_SYMBOL,
            "flags": 0,
            "uri": "",
            "doc": VECTOR_DOC,
            "borsh": hex(&meta_borsh),
            "hash": hex(&meta_hash),
            "tokenMetaAccount": token_meta_address.to_string(),
        },
        "attestation": {
            "launchSeed": hex(&launch_seed),
            "launch": launch.to_string(),
            "launchBytes": hex(launch.as_ref()),
            "paramsHash": hex(&params_hash),
            "creator": creator.to_string(),
            "creatorBytes": hex(creator.as_ref()),
            "programBytes": hex(LAUNCHPAD_PROGRAM_ID.as_ref()),
            "metadataHash": hex(&meta_hash),
            "rulesHash": hex(&terms.rules_hash),
            "notBefore": terms.not_before,
            "notAfter": terms.not_after,
            "landsAt": LANDS_AT,
            "message": hex(&message),
            "messageHash": hex(&message_hash),
            "attestationAccount": attestation_address.to_string(),
            "leafProbeStart": probe_start,
        },
        "signatures": signatures,
        "attestLaunch": {
            "q": ATTEST_LEAF,
            "programId": LAUNCHPAD_PROGRAM_ID.to_string(),
            "payerSeed": hex(&payer_seed),
            "payer": payer.pubkey().to_string(),
            "accounts": [
                {"pubkey": payer.pubkey().to_string(), "isSigner": true, "isWritable": true},
                {"pubkey": launch.to_string(), "isSigner": false, "isWritable": false},
                {"pubkey": identity_address.to_string(), "isSigner": false, "isWritable": true},
                {"pubkey": attestation_address.to_string(), "isSigner": false, "isWritable": true},
                {"pubkey": token_meta_address.to_string(), "isSigner": false, "isWritable": false},
                {"pubkey": SYSTEM_PROGRAM_ID.to_string(), "isSigner": false, "isWritable": false},
                {"pubkey": LAUNCHPAD_PROGRAM_ID.to_string(), "isSigner": false, "isWritable": false},
            ],
            "data": hex(&attest.data),
            "v1": v1_json(&payer, std::slice::from_ref(&attest), blockhash),
        },
        "accounts": {
            "launch": {
                "address": launch.to_string(),
                "bump": launch_bump,
                "status": "Configured",
                "data": hex(&launch_data),
            },
            "tokenMeta": {
                "address": token_meta_address.to_string(),
                "bump": token_meta_bump,
                "data": hex(&token_meta_data),
            },
            "identity": {
                "address": identity_address.to_string(),
                "bump": identity_bump,
                "usedLeaves": [ATTEST_LEAF],
                "data": hex(&identity_data),
            },
            "attestation": {
                "address": attestation_address.to_string(),
                "bump": attestation_bump,
                "leaf": ATTEST_LEAF,
                "slot": ATTEST_SLOT,
                "data": hex(&attestation_data),
            },
        },
        "events": {
            "launchAttested": {
                "leaf": ATTEST_LEAF,
                "slot": ATTEST_SLOT,
                "data": hex(&launch_attested_event(&record)),
            },
            "pqLeafConsumed": {
                "leaf": BURNED_LEAF,
                "data": hex(&pq_leaf_consumed_event(&pq_identity, BURNED_LEAF as u16, &launch)),
            },
        },
        "bitmap": bitmap,
        "leafSelection": leaf_selection_cases(probe_start),
        "rejections": rejection_cases(&pk, &sig_attest, metadata, message_of),
        "burnOnly": burn_only_cases(
            &kp,
            &other,
            &launch,
            &params_hash,
            &creator,
            metadata,
            terms,
            attestation_bump,
        ),
        "passkey": {
            "prfSalt": PRF_SALT,
            "prfOutput": hex(&prf_output),
            "hkdfSalt": std::str::from_utf8(HKDF_SALT).unwrap(),
            "hkdfInfo": std::str::from_utf8(HKDF_INFO).unwrap(),
            "length": 32,
            "entropy": hex(&entropy),
            "rfc5869Case1": {
                "ikm": hex(&[0x0b; 22]),
                "salt": "000102030405060708090a0b0c",
                "info": "f0f1f2f3f4f5f6f7f8f9",
                "length": 42,
                "okm": "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
            },
        },
    });
    let text = serde_json::to_string_pretty(&vectors).expect("json") + "\n";
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(VECTOR_FILE);
    if std::env::var_os("NOISED_WRITE_SDK_VECTORS")
        .or_else(|| std::env::var_os("PHALANX_WRITE_SDK_VECTORS"))
        .is_some()
    {
        std::fs::create_dir_all(path.parent().expect("vector dir")).expect("create vector dir");
        std::fs::write(&path, &text).expect("write LMS vector file");
        println!("wrote {}", path.display());
    }
    let committed = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "{}: {e}; run with NOISED_WRITE_SDK_VECTORS=1 to create it",
            path.display()
        )
    });
    assert_eq!(
        committed.replace("\r\n", "\n"),
        text,
        "LMS vectors are stale; rerun with NOISED_WRITE_SDK_VECTORS=1"
    );
}

//! Cross-implementation vectors for programmable launches (PROGRAMMABLE_V1
//! §1.2 and §2, amendments A1 and A2): `tests/integration/vectors/programmable.json`.
//!
//! Everything is written from the documented layouts (`common::launchpad`),
//! independently of the launchpad and rules crates, and the second test
//! lands the vectors on the launchpad build, comparing every account and
//! event it writes byte for byte:
//!
//! * `parameters`: tags, seeds, lengths and offsets (the rules record, the
//!   `Authorization` the autopilot reads, certificate version 4, the hook
//!   policy's rules), the certificate check bits (`checks::ALL` 4,095 is
//!   what `launch` requires; `RULES_BOUND` 4,096 is informational, set in
//!   addition with rules), error numbers (launchpad and hook), the hook's
//!   log line, discriminators;
//! * `launch`: the vector launch (configured, guard 3,600 s, named by the
//!   `lms.json` identity) and its metadata record, placed with
//!   `set_account`;
//! * `rules`: two PXR1 rule sets (a typical one, written field by field,
//!   and the largest, 1,228 bytes), each with `rulesHash = SHA256(
//!   "PHX-RULES-V1" || bytes)`, its `["rules", launch, rulesHash]` address
//!   and bump, `publish_rules`'s data and accounts, the record's bytes and
//!   the `RulesPublished` payload;
//! * `attestation`: message v3 binding the typical rules (221 bytes),
//!   signed by the `lms.json` identity at the leaf its message probes to,
//!   `attest_launch`'s data and accounts (the rules record in the last
//!   slot), and the `Attestation` and `LaunchAttested` bytes once it lands;
//! * `authorizations`: for the autopilot's three kinds (activate a graph,
//!   freeze it, revoke its operator), the payload hash from its definition
//!   (the revocation, payload v3, names the activation's authorization:
//!   audit 4, A4-3), the 140-byte message, the signature at the next free
//!   leaf, the `pq_authorize` data and accounts, and the `Authorization` and
//!   `Authorized` bytes once it lands; then the identity's bitmap;
//! * `parameters.autopilotAccount`: the `Autopilot` account's offsets
//!   (audit 4 appended `activeAuth`, `activeActivateAt`, `partialSpent`).
//!
//! An independent implementation checks every value: `python -I
//! scripts/pq/lms_reference.py programmable-vectors
//! tests/integration/vectors/programmable.json`. The first test fails if the
//! committed file differs from what the Rust side produces now; to (re)write
//! it after a deliberate change, run with `NOISED_WRITE_SDK_VECTORS=1`.

// The vector document is one `json!` literal, deeper than the default limit.
#![recursion_limit = "256"]

mod common;

use std::str::FromStr;

use common::{
    anchor_discriminator,
    launchpad::{
        activation_payload, attest_launch_ix, attestation_account_data, attestation_message,
        attestation_pda, auth_pda, authorization_account_data, authorization_message,
        authorized_event, autopilot_pda, freeze_payload, hex, identity_account_data, identity_id,
        identity_pda, launch_account_data, launch_attested_event, launch_pda,
        launch_rules_account_data, leaf_probe_start, mark_leaf, metadata_hash, next_free_leaf,
        pq_authorize_ix, publish_rules_ix, revoke_payload, rules_hash, rules_pda,
        rules_published_event, token_meta_account_data, token_meta_pda, unhex, vector_identity,
        AttestationRecord, AuthorizationRecord, LaunchFields, Metadata, Terms,
        ATTESTATION_ACCOUNT_LEN, ATTEST_MESSAGE_LEN, AUTHORIZATION_ACCOUNT_LEN, AUTH_MESSAGE_LEN,
        AUTH_MESSAGE_TAG, AUTOPILOT_ACCOUNT_FIELDS, AUTOPILOT_PROGRAM_ID, GRAPH_ACTIVATE_DOMAIN,
        GRAPH_FREEZE_DOMAIN, INVALID_RULES, LAUNCH_RULES_FIXED_LEN, LEAF_BITMAP_LEN,
        OPERATOR_REVOKE_DOMAIN, RULES_HASH_TAG,
    },
    sha256,
    svm::{anchor_events, report, TxExpect, GENESIS_UNIX_TS},
    Harness, Instruction, Keypair, Pubkey, Signer, LAUNCHPAD_PROGRAM_ID,
};
use noised_lmots::{lms_verify, LmsKeyPair, Sha2, LMS_SIG_LEN};
use serde_json::{json, Value};

const VECTOR_FILE: &str = "vectors/programmable.json";
/// The unix time and slot every vector lands at.
const LANDS_AT: i64 = GENESIS_UNIX_TS;
const LANDS_SLOT: u64 = 400_000_000;
/// The vector launch's guard: rules are verified for it.
const GUARD_SECS: u32 = 3_600;
/// `Launch::guard_secs` (u32 LE) in the `Launch` v2 layout.
const LAUNCH_GUARD_SECS_OFFSET: usize = 423;
/// The hook policy's rules: the borsh length at 275, the bytes from 279.
const POLICY_RULES_OFFSET: usize = 275;
/// The `lms.json` vector record.
const VECTOR_NAME: &str = "Phalanx Vector Token";
const VECTOR_SYMBOL: &str = "PHXV";
const VECTOR_DOC: &str =
    r#"{"name":"Phalanx Vector Token","symbol":"PHXV","description":"PQ v2 test vectors"}"#;

/// A deterministic 32-byte value derived from a label.
fn fixed(label: &str) -> [u8; 32] {
    sha256(&[b"phalanx-programmable-vectors/", label.as_bytes()])
}

/// One condition node: `op | a | u64le arg`.
fn node(op: u8, a: u8, arg: u64) -> Vec<u8> {
    let mut n = vec![op, a];
    n.extend_from_slice(&arg.to_le_bytes());
    n
}

/// A PXR1 rule set from its parts, laid out as documented: header, keys,
/// rules (`from u32 | to u32 | cond_off | cond_len | effect | code | arg
/// u64`), nodes; each rule's condition right after the one before.
/// One rule: `(from, to, effect, code, arg, condition nodes)`.
type RuleSpec = (u32, u32, u8, u8, u64, Vec<Vec<u8>>);

fn pxr1(keys: &[[u8; 32]], rules: &[RuleSpec]) -> Vec<u8> {
    let n_nodes: usize = rules.iter().map(|r| r.5.len()).sum();
    let mut b = b"PXR1".to_vec();
    b.extend_from_slice(&[
        1,
        keys.len() as u8,
        rules.len() as u8,
        n_nodes as u8,
        0,
        0,
        0,
        0,
    ]);
    for k in keys {
        b.extend_from_slice(k);
    }
    let mut off = 0u8;
    for (from, to, effect, code, arg, cond) in rules {
        b.extend_from_slice(&from.to_le_bytes());
        b.extend_from_slice(&to.to_le_bytes());
        b.extend_from_slice(&[off, cond.len() as u8, *effect, *code]);
        b.extend_from_slice(&arg.to_le_bytes());
        off += cond.len() as u8;
    }
    for (.., cond) in rules {
        for n in cond {
            b.extend_from_slice(n);
        }
    }
    assert_eq!(
        b.len(),
        12 + 32 * keys.len() + 20 * rules.len() + 10 * n_nodes
    );
    b
}

const DENY: u8 = 1;
const CAP_AMOUNT: u8 = 2;
const CAP_DEST_BALANCE: u8 = 3;
const AND: u8 = 0x02;
const OR: u8 = 0x03;
const NOT: u8 = 0x04;
const IS_BUY: u8 = 0x10;
const IS_P2P: u8 = 0x11;
const DEST_OWNER_IN: u8 = 0x16;
const SRC_OWNER_IN: u8 = 0x17;
const TOP_PROGRAM_IN: u8 = 0x18;
const TX_IX_COUNT_GT: u8 = 0x19;
const BPS: u64 = 1 << 63;

/// The typical rule set: no buy in a transaction of more than 2 top-level
/// instructions in the first 2 minutes; at most 0.5% of the supply per buy
/// and 1% held per account; the team wallet (key 0) cannot buy; no wallet
/// transfer made inside the pool program (key 1) from 30 minutes on.
fn typical_rules(team: [u8; 32], pool_program: [u8; 32]) -> Vec<u8> {
    pxr1(
        &[team, pool_program],
        &[
            (
                0,
                120,
                DENY,
                1,
                0,
                vec![
                    node(IS_BUY, 0, 0),
                    node(TX_IX_COUNT_GT, 0, 2),
                    node(AND, 0, 0),
                ],
            ),
            (
                0,
                GUARD_SECS,
                CAP_AMOUNT,
                2,
                BPS | 50,
                vec![node(IS_BUY, 0, 0)],
            ),
            (
                0,
                GUARD_SECS,
                CAP_DEST_BALANCE,
                3,
                BPS | 100,
                vec![node(0x00, 0, 0)],
            ),
            (
                0,
                GUARD_SECS,
                DENY,
                4,
                0,
                vec![
                    node(DEST_OWNER_IN, 1, 0),
                    node(IS_BUY, 0, 0),
                    node(AND, 0, 0),
                ],
            ),
            (
                1_800,
                GUARD_SECS,
                DENY,
                5,
                0,
                vec![
                    node(IS_P2P, 0, 0),
                    node(TOP_PROGRAM_IN, 2, 0),
                    node(AND, 0, 0),
                ],
            ),
        ],
    )
}

/// The largest rule set: 8 keys, 16 rules, 64 nodes (1,228 bytes).
fn largest_rules() -> Vec<u8> {
    let keys: Vec<[u8; 32]> = (0..8).map(|i| fixed(&format!("largest-key-{i}"))).collect();
    let leaves = [DEST_OWNER_IN, SRC_OWNER_IN, TOP_PROGRAM_IN];
    let rules: Vec<_> = (0..16u8)
        .map(|i| {
            (
                u32::from(i) * 60,
                GUARD_SECS,
                DENY,
                i,
                0,
                vec![
                    node(TX_IX_COUNT_GT, 0, 0),
                    node(leaves[usize::from(i) % 3], 1 << (i % 8), 0),
                    node(OR, 0, 0),
                    node(NOT, 0, 0),
                ],
            )
        })
        .collect();
    let b = pxr1(&keys, &rules);
    assert_eq!(b.len(), 1_228);
    b
}

fn metas(ix: &Instruction) -> Vec<Value> {
    ix.accounts
        .iter()
        .map(|m| json!({"pubkey": m.pubkey.to_string(), "isSigner": m.is_signer, "isWritable": m.is_writable}))
        .collect()
}

/// The vector launch and everything the vectors land, in order.
struct Plan {
    launch: Pubkey,
    launch_data: Vec<u8>,
    token_meta: (Pubkey, Vec<u8>),
    rule_sets: Vec<(&'static str, Vec<u8>)>,
    attest: Instruction,
    attestation: (Pubkey, Vec<u8>, Vec<u8>),
    authorizations: Vec<(Instruction, Pubkey, Vec<u8>, Vec<u8>)>,
    identity: (Pubkey, Vec<u8>),
    json: Value,
}

fn plan() -> Plan {
    let kp: &LmsKeyPair = vector_identity();
    let pk = kp.public_key().to_bytes();
    let pq_identity = identity_id(&pk);
    let creator = Pubkey::new_from_array(fixed("creator"));
    let launch_seed = fixed("launch-seed");
    let (launch, launch_bump) = launch_pda(&creator, &launch_seed);
    let params_hash = fixed("params-hash");
    let mut launch_data = launch_account_data(&LaunchFields {
        bump: launch_bump,
        live: false,
        launch_seed,
        creator,
        params_hash,
        pq_identity,
    });
    launch_data[LAUNCH_GUARD_SECS_OFFSET..LAUNCH_GUARD_SECS_OFFSET + 4]
        .copy_from_slice(&GUARD_SECS.to_le_bytes());
    let metadata = Metadata::new(VECTOR_NAME, VECTOR_SYMBOL, 0, "", VECTOR_DOC);
    let meta_hash = metadata_hash(metadata);
    let (token_meta, token_meta_bump) = token_meta_pda(&launch, &meta_hash);
    let token_meta_data = token_meta_account_data(token_meta_bump, &launch, metadata);
    let payer = Keypair::new_from_array(fixed("throwaway-payer"));

    // Rules records.
    let team = fixed("team-wallet");
    let dbc = common::DBC_PROGRAM_ID.to_bytes();
    let rule_sets = vec![
        ("typical", typical_rules(team, dbc)),
        ("largest", largest_rules()),
    ];
    let rules_json: Vec<Value> = rule_sets
        .iter()
        .map(|(name, bytes)| {
            let hash = rules_hash(bytes);
            assert_eq!(hash, sha256(&[RULES_HASH_TAG, bytes]));
            let (address, bump) = rules_pda(&launch, &hash);
            let ix = publish_rules_ix(&payer.pubkey(), &launch, bytes);
            json!({
                "name": name,
                "bytes": hex(bytes),
                "len": bytes.len(),
                "rulesHash": hex(&hash),
                "address": address.to_string(),
                "bump": bump,
                "accountData": hex(&launch_rules_account_data(bump, &launch, bytes)),
                "publishRules": {"accounts": metas(&ix), "data": hex(&ix.data)},
                "rulesPublished": hex(&rules_published_event(&launch, bytes)),
            })
        })
        .collect();

    // The attestation binding the typical rules.
    let typical_hash = rules_hash(&rule_sets[0].1);
    let terms = Terms {
        not_before: LANDS_AT,
        not_after: LANDS_AT + 3_600,
        rules_hash: typical_hash,
    };
    let message = attestation_message(&launch, &params_hash, &creator, &meta_hash, &terms);
    assert_eq!(message.len(), ATTEST_MESSAGE_LEN);
    let mut used = [0u8; LEAF_BITMAP_LEN];
    let attest_q = next_free_leaf(&used, leaf_probe_start(&pk[8..24], &message)).unwrap();
    mark_leaf(&mut used, attest_q);
    let attest_sig = kp.sign_deterministic::<Sha2>(attest_q, &message).unwrap();
    assert_eq!(
        lms_verify::<Sha2>(&pk, &message, &attest_sig),
        Some(attest_q)
    );
    let attest = attest_launch_ix(&payer.pubkey(), &launch, &pk, &attest_sig, metadata, &terms);
    let (attestation_address, attestation_bump) = attestation_pda(&launch);
    let record = AttestationRecord {
        bump: attestation_bump,
        launch,
        pq_identity,
        leaf: attest_q as u16,
        metadata_hash: meta_hash,
        message_hash: sha256(&[&message]),
        slot: LANDS_SLOT,
        terms,
        signature: attest_sig.clone(),
    };
    let attestation_data = attestation_account_data(&record);
    assert_eq!(attestation_data.len(), ATTESTATION_ACCOUNT_LEN);
    let attested_event = launch_attested_event(&record);

    // Authorizations of the three autopilot kinds.
    let autopilot = autopilot_pda(&launch);
    let graph_hash = fixed("graph-hash");
    let operator = Pubkey::new_from_array(fixed("operator"));
    let activate_at = LANDS_AT + 600;
    let freeze_not_after = LANDS_AT + 3_600;
    let activation = activation_payload(&autopilot, &graph_hash, activate_at);
    // The revocation names the activation's authorization (payload v3).
    let active_auth = auth_pda(&launch, 1, &activation).0;
    let kinds: [(&str, u8, [u8; 32]); 3] = [
        ("GRAPH_ACTIVATE", 1, activation),
        (
            "GRAPH_FREEZE",
            2,
            freeze_payload(&autopilot, &graph_hash, freeze_not_after),
        ),
        (
            "OPERATOR_REVOKE",
            3,
            revoke_payload(&autopilot, &graph_hash, &operator, &active_auth),
        ),
    ];
    let mut authorizations = Vec::new();
    let mut auth_json = Vec::new();
    for (name, kind, payload) in kinds {
        let msg = authorization_message(&launch, &creator, kind, &payload);
        assert_eq!(msg.len(), AUTH_MESSAGE_LEN);
        let start = leaf_probe_start(&pk[8..24], &msg);
        let q = next_free_leaf(&used, start).unwrap();
        mark_leaf(&mut used, q);
        let sig = kp.sign_deterministic::<Sha2>(q, &msg).unwrap();
        assert_eq!(lms_verify::<Sha2>(&pk, &msg, &sig), Some(q));
        let ix = pq_authorize_ix(&payer.pubkey(), &launch, &pk, &sig, kind, &payload);
        let (address, bump) = auth_pda(&launch, kind, &payload);
        let a = AuthorizationRecord {
            bump,
            launch,
            pq_identity,
            kind,
            payload_hash: payload,
            message_hash: sha256(&[&msg]),
            unix_time: LANDS_AT,
            slot: LANDS_SLOT,
            leaf: q as u16,
            signature: sig.clone(),
        };
        let data = authorization_account_data(&a);
        let event = authorized_event(&a);
        auth_json.push(json!({
            "name": name,
            "kind": kind,
            "payloadHash": hex(&payload),
            "message": hex(&msg),
            "messageHash": hex(&sha256(&[&msg])),
            "probeStart": start,
            "q": q,
            "signature": hex(&sig),
            "pqAuthorize": {"accounts": metas(&ix), "data": hex(&ix.data)},
            "address": address.to_string(),
            "bump": bump,
            "accountData": hex(&data),
            "authorized": hex(&event),
        }));
        authorizations.push((ix, address, data, event));
    }
    let (identity_address, identity_bump) = identity_pda(&pq_identity);
    let identity_data = identity_account_data(identity_bump, &pk, &used);

    let discriminators: serde_json::Map<String, Value> = [
        (
            "publishRules",
            anchor_discriminator("global", "publish_rules"),
        ),
        (
            "pqAuthorize",
            anchor_discriminator("global", "pq_authorize"),
        ),
        (
            "attestLaunch",
            anchor_discriminator("global", "attest_launch"),
        ),
        (
            "launchRules",
            anchor_discriminator("account", "LaunchRules"),
        ),
        (
            "authorization",
            anchor_discriminator("account", "Authorization"),
        ),
        (
            "rulesPublished",
            anchor_discriminator("event", "RulesPublished"),
        ),
        ("authorized", anchor_discriminator("event", "Authorized")),
        (
            "launchAttested",
            anchor_discriminator("event", "LaunchAttested"),
        ),
        (
            "pqLeafConsumed",
            anchor_discriminator("event", "PqLeafConsumed"),
        ),
        ("hookPolicy", anchor_discriminator("account", "HookPolicy")),
        (
            "autopilotAccount",
            anchor_discriminator("account", "Autopilot"),
        ),
        (
            "policyCreated",
            anchor_discriminator("event", "PolicyCreated"),
        ),
    ]
    .iter()
    .map(|(name, d)| (name.to_string(), json!(hex(d))))
    .collect();

    // The `Autopilot` account's offsets, from its documented fields.
    let mut autopilot_offsets = serde_json::Map::new();
    let mut autopilot_len = 0;
    for (name, len) in AUTOPILOT_ACCOUNT_FIELDS {
        if name != "discriminator" {
            autopilot_offsets.insert(name.to_string(), json!(autopilot_len));
        }
        autopilot_len += len;
    }

    let json = json!({
        "source": "tests/integration/tests/programmable_vectors.rs (PROGRAMMABLE_V1 §1.2 PXR1 rules, §2 publish_rules, attestation message v3, pq_authorize and Authorization (amendment A1), certificate v4 (amendment A2)); landed on the launchpad build by the same file; independent check: python -I scripts/pq/lms_reference.py programmable-vectors tests/integration/vectors/programmable.json",
        "parameters": {
            "launchpad": LAUNCHPAD_PROGRAM_ID.to_string(),
            "autopilot": AUTOPILOT_PROGRAM_ID.to_string(),
            "rulesHashTag": std::str::from_utf8(RULES_HASH_TAG).unwrap(),
            "noRulesHash": hex(&[0; 32]),
            "rulesSeeds": ["rules", "launch", "rulesHash"],
            "authSeeds": ["auth", "launch", "[kind]", "payloadHash"],
            "autopilotSeeds": ["autopilot", "launch"],
            "attestMessageLen": ATTEST_MESSAGE_LEN,
            "attestMessageLayout": "PHX-ATTEST-V3(13) programId(32) launch(32) paramsHash(32) creator(32) metadataHash(32) rulesHash(32) i64le notBefore(8) i64le notAfter(8)",
            "authMessageTag": std::str::from_utf8(AUTH_MESSAGE_TAG).unwrap(),
            "authMessageLen": AUTH_MESSAGE_LEN,
            "authMessageLayout": "PHX-AUTH-V1(11) programId(32) launch(32) creator(32) u8 kind(1) payloadHash(32)",
            "payloadDomains": {
                "GRAPH_ACTIVATE": std::str::from_utf8(GRAPH_ACTIVATE_DOMAIN).unwrap(),
                "GRAPH_FREEZE": std::str::from_utf8(GRAPH_FREEZE_DOMAIN).unwrap(),
                "OPERATOR_REVOKE": std::str::from_utf8(OPERATOR_REVOKE_DOMAIN).unwrap(),
            },
            "payloadLayouts": {
                "GRAPH_ACTIVATE": "SHA256(domain || autopilot || graphHash || i64le activateAt)",
                "GRAPH_FREEZE": "SHA256(domain || autopilot || graphHash || i64le freezeNotAfter)",
                "OPERATOR_REVOKE": "SHA256(domain || autopilot || graphHash || operator || activeAuth)",
            },
            "autopilotAccount": {
                "version": 1,
                "accountLen": autopilot_len,
                "offsets": autopilot_offsets,
            },
            "launchRules": {"version": 1, "fixedLen": LAUNCH_RULES_FIXED_LEN, "offsets": {"version": 8, "bump": 9, "launch": 10, "rulesHash": 42, "bytesLen": 74, "bytes": 78}},
            "authorization": {"version": 1, "accountLen": AUTHORIZATION_ACCOUNT_LEN, "offsets": {"version": 8, "bump": 9, "launch": 10, "pqIdentity": 42, "kind": 74, "payloadHash": 75, "messageHash": 107, "unixTime": 139, "slot": 147, "leaf": 155, "signatureLen": 157, "signature": 161}},
            "certificate": {"version": 4, "accountLen": 519, "checksOffset": 187, "metadataOffset": 455, "rulesHashOffset": 487, "allChecks": 4095, "rulesBound": 4096, "withRules": 8191},
            "hookPolicy": {"version": 2, "rulesLenOffset": POLICY_RULES_OFFSET, "rulesOffset": POLICY_RULES_OFFSET + 4, "space": "279 + rules length"},
            "launchGuardSecsOffset": LAUNCH_GUARD_SECS_OFFSET,
            "errors": [
                {"program": "launchpad", "name": INVALID_RULES.name, "number": INVALID_RULES.number},
                {"program": "hook", "name": "RuleDenied", "number": 6011},
                {"program": "hook", "name": "InvalidRules", "number": 6012},
            ],
            "hookLog": "Launch rule {index} (code {code}) refused the transfer",
            "hookRuleDeniedMessage": "Launch rule: this transfer is not allowed right now",
            "signatureLen": LMS_SIG_LEN,
            "discriminators": discriminators,
        },
        "launch": {
            "address": launch.to_string(),
            "creator": creator.to_string(),
            "creatorBytes": hex(creator.as_ref()),
            "launchSeed": hex(&launch_seed),
            "paramsHash": hex(&params_hash),
            "guardSecs": GUARD_SECS,
            "pqIdentity": hex(&pq_identity),
            "publicKey": hex(&pk),
            "data": hex(&launch_data),
            "metadataHash": hex(&meta_hash),
            "tokenMeta": token_meta.to_string(),
            "tokenMetaData": hex(&token_meta_data),
            "landsAt": LANDS_AT,
            "slot": LANDS_SLOT,
            "payer": payer.pubkey().to_string(),
            "teamWallet": hex(&team),
        },
        "rules": rules_json,
        "attestation": {
            "rulesHash": hex(&typical_hash),
            "notBefore": terms.not_before,
            "notAfter": terms.not_after,
            "message": hex(&message),
            "messageHash": hex(&sha256(&[&message])),
            "q": attest_q,
            "signature": hex(&attest_sig),
            "attestLaunch": {"accounts": metas(&attest), "data": hex(&attest.data)},
            "address": attestation_address.to_string(),
            "accountData": hex(&attestation_data),
            "launchAttested": hex(&attested_event),
        },
        "authorizations": {
            "autopilot": autopilot.to_string(),
            "graphHash": hex(&graph_hash),
            "activateAt": activate_at,
            "freezeNotAfter": freeze_not_after,
            "operator": operator.to_string(),
            "activeAuth": active_auth.to_string(),
            "cases": auth_json,
        },
        "identity": {
            "address": identity_address.to_string(),
            "data": hex(&identity_data),
        },
    });
    Plan {
        launch,
        launch_data,
        token_meta: (token_meta, token_meta_data),
        rule_sets,
        attest,
        attestation: (attestation_address, attestation_data, attested_event),
        authorizations,
        identity: (identity_address, identity_data),
        json,
    }
}

#[test]
fn programmable_vectors_match_the_committed_file() {
    let text = serde_json::to_string_pretty(&plan().json).expect("json") + "\n";
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(VECTOR_FILE);
    if std::env::var_os("NOISED_WRITE_SDK_VECTORS")
        .or_else(|| std::env::var_os("PHALANX_WRITE_SDK_VECTORS"))
        .is_some()
    {
        std::fs::write(&path, &text).expect("write the programmable vector file");
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
        "programmable vectors are stale; rerun with NOISED_WRITE_SDK_VECTORS=1"
    );
}

/// The vectors on the launchpad build: both rule sets publish to the
/// vectors' record bytes and events, the attestation binding the typical
/// rules lands as stated, and so do the three authorizations; the
/// identity's bitmap holds exactly their four leaves.
#[test]
fn programmable_vectors_land_on_the_launchpad_build() {
    let p = plan();
    let (mut h, payer) = ledger(&p);
    for (i, (name, bytes)) in p.rule_sets.iter().enumerate() {
        let v = &p.json["rules"][i];
        let ix = publish_rules_ix(&payer.pubkey(), &p.launch, bytes);
        assert_eq!(hex(&ix.data), v["publishRules"]["data"].as_str().unwrap());
        let sent = h.send_v1(&[ix], &[&payer]).expect_ok(name);
        report(
            &format!("publish_rules ({name}, {} B): size / CU", bytes.len()),
            format!("{} B / {}", sent.size, sent.cu),
        );
        assert_eq!(
            anchor_events(&sent.logs, "RulesPublished"),
            vec![unhex(v["rulesPublished"].as_str().unwrap())]
        );
        let address = Pubkey::from_str(v["address"].as_str().unwrap()).unwrap();
        let account = h.account(&address).expect("the record");
        assert_eq!(account.owner, LAUNCHPAD_PROGRAM_ID);
        assert_eq!(
            hex(&account.data),
            v["accountData"].as_str().unwrap(),
            "{name}"
        );
    }
    let sent = h
        .send_v1(std::slice::from_ref(&p.attest), &[&payer])
        .expect_ok("attest with rules");
    assert_eq!(
        anchor_events(&sent.logs, "LaunchAttested"),
        vec![p.attestation.2.clone()]
    );
    assert_eq!(
        h.account(&p.attestation.0).expect("attestation").data,
        p.attestation.1
    );
    for (ix, address, data, event) in &p.authorizations {
        let sent = h
            .send_v1(std::slice::from_ref(ix), &[&payer])
            .expect_ok("pq_authorize");
        report(
            "pq_authorize: size / CU",
            format!("{} B / {}", sent.size, sent.cu),
        );
        assert_eq!(anchor_events(&sent.logs, "Authorized"), vec![event.clone()]);
        let account = h.account(address).expect("authorization");
        assert_eq!(account.owner, LAUNCHPAD_PROGRAM_ID);
        assert_eq!(&account.data, data);
    }
    assert_eq!(
        h.account(&p.identity.0).expect("identity").data,
        p.identity.1
    );
}

/// The vector ledger: the launchpad build, the vector launch and its
/// metadata record placed, the clock at the vectors' landing time and slot,
/// and a funded throwaway payer.
fn ledger(p: &Plan) -> (Harness, Keypair) {
    let mut h = Harness::builder()
        .program(LAUNCHPAD_PROGRAM_ID, "noised_launchpad")
        .build();
    h.place_launchpad_account(&p.launch, p.launch_data.clone());
    h.place_launchpad_account(&p.token_meta.0, p.token_meta.1.clone());
    h.set_time(LANDS_AT);
    h.svm.warp_to_slot(LANDS_SLOT);
    let payer = Keypair::new_from_array(fixed("throwaway-payer"));
    h.airdrop(&payer.pubkey(), 1_000_000_000);
    (h, payer)
}

/// `publish_rules` verifies the rules for the launch's guard (3,600 s), and
/// is idempotent: the same bytes again succeed without writing or emitting.
#[test]
fn publish_rules_verifies_for_the_launchs_guard_and_is_idempotent() {
    let p = plan();
    let (mut h, payer) = ledger(&p);
    let refused = [
        (
            "a window past the launch's guard",
            pxr1(
                &[],
                &[(0, GUARD_SECS + 1, DENY, 1, 0, vec![node(IS_BUY, 0, 0)])],
            ),
        ),
        ("not a rule set", b"PXR1".to_vec()),
        (
            "a cap of zero",
            pxr1(&[], &[(0, 60, CAP_AMOUNT, 1, 0, vec![node(IS_BUY, 0, 0)])]),
        ),
    ];
    for (what, bytes) in refused {
        let ix = publish_rules_ix(&payer.pubkey(), &p.launch, &bytes);
        h.send_v1(&[ix], &[&payer])
            .expect_error(INVALID_RULES, what);
    }
    let bytes = &p.rule_sets[0].1;
    let address = rules_pda(&p.launch, &rules_hash(bytes)).0;
    h.send_v1(
        &[publish_rules_ix(&payer.pubkey(), &p.launch, bytes)],
        &[&payer],
    )
    .expect_ok("publish");
    let first = h.account(&address).expect("the record");
    let again = h
        .send_v1(
            &[publish_rules_ix(&payer.pubkey(), &p.launch, bytes)],
            &[&payer],
        )
        .expect_ok("publish again");
    assert!(anchor_events(&again.logs, "RulesPublished").is_empty());
    assert_eq!(h.account(&address).expect("the record"), first);
}

/// `attest_launch` attests rules only from the record `publish_rules`
/// wrote at the address the signed hash names: an account there that is not
/// that record (another owner, discriminator, version, bump, launch or hash,
/// too short, or nothing) leaves the signature burn-only. Each landing signs
/// at the identity's next free leaf.
#[test]
fn attestations_take_only_the_published_rules_record() {
    let p = plan();
    let (mut h, payer) = ledger(&p);
    let kp = vector_identity();
    let pk = kp.public_key().to_bytes();
    let bytes = &p.rule_sets[0].1;
    let hash = rules_hash(bytes);
    let (address, bump) = rules_pda(&p.launch, &hash);
    let good = launch_rules_account_data(bump, &p.launch, bytes);
    let terms = Terms {
        not_before: LANDS_AT,
        not_after: LANDS_AT + 3_600,
        rules_hash: hash,
    };
    let creator = Pubkey::new_from_array(fixed("creator"));
    let metadata = Metadata::new(VECTOR_NAME, VECTOR_SYMBOL, 0, "", VECTOR_DOC);
    let message = attestation_message(
        &p.launch,
        &fixed("params-hash"),
        &creator,
        &metadata_hash(metadata),
        &terms,
    );
    let attestation = attestation_pda(&p.launch).0;
    let land = |h: &mut Harness| {
        let (sig, _) = h.sign_next(kp, &message);
        let ix = attest_launch_ix(&payer.pubkey(), &p.launch, &pk, &sig, metadata, &terms);
        h.send_v1(&[ix], &[&payer])
            .expect_ok("a valid signature lands")
    };
    let flip = |at: usize| {
        let mut d = good.clone();
        d[at] ^= 1;
        d
    };
    /// What is at the record's address: nothing, or data and its owner.
    type Placed = Option<(Vec<u8>, Pubkey)>;
    let cases: Vec<(&str, Placed)> = vec![
        ("nothing at the address", None),
        (
            "owned by Token-2022",
            Some((good.clone(), common::TOKEN_2022_PROGRAM_ID)),
        ),
        (
            "another discriminator",
            Some((flip(0), LAUNCHPAD_PROGRAM_ID)),
        ),
        ("version 0", Some((flip(8), LAUNCHPAD_PROGRAM_ID))),
        ("another bump", Some((flip(9), LAUNCHPAD_PROGRAM_ID))),
        ("another launch", Some((flip(10), LAUNCHPAD_PROGRAM_ID))),
        ("another hash", Some((flip(73), LAUNCHPAD_PROGRAM_ID))),
        (
            "shorter than the fixed part",
            Some((good[..77].to_vec(), LAUNCHPAD_PROGRAM_ID)),
        ),
    ];
    for (what, account) in cases {
        match account {
            None => h.remove_account(&address),
            Some((data, owner)) => h.place_account(&address, data, &owner),
        }
        let sent = land(&mut h);
        assert_eq!(
            anchor_events(&sent.logs, "PqLeafConsumed").len(),
            1,
            "{what}"
        );
        assert!(
            anchor_events(&sent.logs, "LaunchAttested").is_empty(),
            "{what}"
        );
        assert_eq!(
            h.account(&attestation).expect("attestation").data[8],
            0,
            "{what}"
        );
    }
    // The record itself (its fixed part is enough): attested.
    h.place_launchpad_account(&address, good.clone());
    let sent = land(&mut h);
    assert_eq!(anchor_events(&sent.logs, "LaunchAttested").len(), 1);
    let stored = h.account(&attestation).expect("attestation").data;
    assert_eq!((stored[8], &stored[108..140]), (3, &hash[..]));
}

/// Only the launch's identity authorizes, once per kind and payload:
/// another identity's signature (before and after the authorization exists)
/// and a second signature by the launch's identity land and only burn their
/// leaves; the launch's first signature writes the vectors' bytes.
#[test]
fn authorizations_are_written_once_by_the_launchs_identity() {
    let p = plan();
    let (mut h, payer) = ledger(&p);
    let (ix, address, data, _) = &p.authorizations[0];
    let kind = data[74];
    let payload: [u8; 32] = data[75..107].try_into().unwrap();
    let creator = Pubkey::new_from_array(fixed("creator"));
    let message = authorization_message(&p.launch, &creator, kind, &payload);
    let master: [u8; 64] = std::array::from_fn(|i| i as u8);
    let other = noised_lmots::LmsPrivateKey::derive_identity::<Sha2>(&master, 2, 1)
        .unwrap()
        .keygen::<Sha2>();
    let burns_only = |h: &mut Harness, key: &noised_lmots::LmsKeyPair, what: &str| {
        let (sig, q) = h.sign_next(key, &message);
        let pk = key.public_key().to_bytes();
        let ix = pq_authorize_ix(&payer.pubkey(), &p.launch, &pk, &sig, kind, &payload);
        let sent = h.send_v1(&[ix], &[&payer]).expect_ok(what);
        assert!(anchor_events(&sent.logs, "Authorized").is_empty(), "{what}");
        let consumed = anchor_events(&sent.logs, "PqLeafConsumed");
        assert_eq!(consumed.len(), 1, "{what}");
        assert_eq!(&consumed[0][..32], &identity_id(&pk), "{what}");
        assert_eq!(&consumed[0][32..34], &(q as u16).to_le_bytes(), "{what}");
    };
    burns_only(&mut h, &other, "another identity first");
    let version = h
        .account(address)
        .map_or(0, |a| a.data.get(8).copied().unwrap_or(0));
    assert_eq!(version, 0, "another identity writes nothing");
    h.send_v1(std::slice::from_ref(ix), &[&payer])
        .expect_ok("the authorization");
    assert_eq!(&h.account(address).expect("authorization").data, data);
    for (what, key) in [
        ("a second signature", vector_identity()),
        ("another identity", &other),
    ] {
        burns_only(&mut h, key, what);
        assert_eq!(
            &h.account(address).expect("authorization").data,
            data,
            "{what}"
        );
    }
}

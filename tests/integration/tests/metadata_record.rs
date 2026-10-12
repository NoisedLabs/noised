//! The launchpad's on-chain metadata record (METADATA_PROGRAM.md on
//! METADATA_ONCHAIN.md §4) on the program builds, against mainnet DBC and
//! Token-2022:
//!
//! * `publish_metadata` writes a record whole, at the address its content
//!   hashes to, paid by a throwaway key holding exactly its rent and fee;
//!   publishing it again (any payer) writes nothing and costs only the fee;
//!   a pre-funded address is taken over; every invalid record, and a launch
//!   that is no longer configured, is refused with its error, in the
//!   documented order of checks, leaving nothing behind.
//! * `attest_launch` attests only the published record its signed hash
//!   names: owned by the launchpad, a `TokenMeta` of version 1 for this
//!   launch and this hash, storing the bump of its address. Every other
//!   valid signature lands and burns only its leaf: an unpublished hash, a
//!   pre-funded address, a hash no record can have, and an account at the
//!   record's address that differs from the record in any one of those
//!   properties. Any account but that address (a junk record of the launch,
//!   the record of another launch, the launch account, the record's bytes
//!   elsewhere) fails the transaction and burns nothing, so whoever relays
//!   a signature cannot turn one that attests into a burn.
//! * `metadata.json`'s attestation lands byte for byte: before its record
//!   is published it only burns its leaf (the publish/attest race), after
//!   it attests; its message is the 221-byte message v3 the program rebuilds
//!   from the `lms.json` launch.
//! * `launch` (no arguments, permissionless inside the signed window) gives
//!   the mint exactly the record's name and symbol and the uri derived from
//!   it in each mode (none, inline `data:` uri, external uri) at typical and
//!   maximum sizes; the certificate (version 4) carries `METADATA_ONCHAIN`
//!   (2,048; all checks 4,095, no rules) and the record's address; any record but the one the
//!   attestation names is refused, and nothing launches outside the window.
//! * Audit 3 (F1): an attestation whose window passed while the launch was
//!   Configured is replaced, whole, by the identity's next attesting
//!   signature, and the launch opens in the new window only; one whose
//!   window has not ended, and a Live launch's, never change; a signature
//!   landing with less than a minute of its window left only burns its leaf.
//!   Every signature that lands burns its leaf.
//! * Sizes: `publish_metadata` at `MAX_DOC_LEN` with a 32-byte name and a
//!   10-byte symbol fits a v1 transaction; `attest_launch` (v1) and `launch`
//!   (legacy, with a CU limit and a CU price) have one size whatever the
//!   record.
//!
//! The launch of a `publish_metadata` / `attest_launch` test is placed with
//! `set_account` (the `lms.json` launch, as `create_launch` leaves it); the
//! `launch` and audit-3 tests run `create_launch` against mainnet DBC. Every signature
//! is a real LMS signature by the vector identity at the leaf a client
//! would pick (A13).

mod common;

use std::str::FromStr;

use base64::Engine as _;
use common::{
    anchor_discriminator,
    hook::HOOK_ID,
    launch::{
        certificate_view, label_key, launch_ix, launch_tx, mint_metadata, LaunchKeys, LaunchParams,
        CERTIFICATE_ACCOUNT_LEN, CERTIFICATE_VERSION, CHECKS_ALL, CHECK_METADATA_ONCHAIN,
        CHECK_PQ_ATTESTED, EXTENSION_METADATA_POINTER, EXTENSION_TOKEN_METADATA,
        EXTENSION_TRANSFER_HOOK, LAUNCH_ACCOUNTS, LAUNCH_BASE_MINT_OFFSET, LAUNCH_POOL_OFFSET,
        MINT_FIXED_LEN, SAFETY_POLICY_VERSION,
    },
    launchpad::{
        attest_launch_ix, attest_launch_ix_at, attest_tx_config, attestation_account_data,
        attestation_message, attestation_pda, base64_encode, empty_attestation_account_data,
        identity_id, identity_pda, launch_account_data, launch_attested_event, launch_pda,
        leaf_used, metadata_error, metadata_hash, metadata_published_event, pq_leaf_consumed_event,
        publish_metadata_ix, publish_metadata_ix_at, publish_tx_config, token_meta_account_data,
        token_meta_pda, token_uri, unhex, vector_identity, AttestationRecord, LaunchFields,
        LaunchpadError, Metadata, Terms, ACCOUNT_DISCRIMINATOR_MISMATCH, ACCOUNT_NOT_INITIALIZED,
        ACCOUNT_OWNED_BY_WRONG_PROGRAM, ATTESTATION_ACCOUNT_LEN, ATTESTATION_MISMATCH,
        CONSTRAINT_SEEDS, IDENTITY_ACCOUNT_LEN, INLINE_URI_PREFIX, INSTRUCTION_DID_NOT_DESERIALIZE,
        INVALID_METADATA, INVALID_METADATA_FLAGS, LAUNCH_CREATOR_OFFSET, LAUNCH_PARAMS_HASH_OFFSET,
        LAUNCH_STATUS_OFFSET, MAX_DOC_LEN, MAX_LAUNCH_WINDOW_SECS, MAX_NAME_LEN, MAX_SYMBOL_LEN,
        MAX_URI_LEN, METADATA_TOO_LONG, META_FLAG_EXTERNAL_URI, META_FLAG_INLINE_URI,
        MIN_LAUNCH_WINDOW_SECS, NOT_LAUNCH_WINDOW, PQ_LEAF_USED, PUBLISH_CU_LIMIT,
        TOKEN_META_FIXED_LEN, WRONG_LAUNCH_STATE,
    },
    sha256,
    svm::{anchor_events, report, Sent, TxExpect, TxResult, PACKET_DATA_SIZE},
    AccountMeta, Harness, Instruction, Keypair, Pubkey, Signer, LAMPORTS_PER_SOL,
    LAUNCHPAD_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
};
use noised_lmots::{lms_verify, Sha2};
use serde_json::Value;
use solana_message::v1;

const METADATA_VECTORS: &str = "vectors/metadata.json";
const LMS_VECTORS: &str = "vectors/lms.json";
/// Fee of a transaction with one signature and no priority fee.
const SIGNATURE_FEE: u64 = 5_000;

// ------------------------------------------------------------------ vectors

fn load(file: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(file);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{}: {e} (see tests/metadata_vectors.rs)", path.display()));
    serde_json::from_str(&text).expect("vector JSON")
}

fn address(v: &Value) -> Pubkey {
    Pubkey::from_str(v.as_str().expect("an address")).expect("base58 address")
}

fn bytes(v: &Value) -> Vec<u8> {
    unhex(v.as_str().expect("hex bytes"))
}

fn number(v: &Value) -> u64 {
    v.as_u64().expect("a number")
}

/// A metadata record's bytes (name, symbol, flags, uri, document).
#[derive(Clone, Debug, PartialEq, Eq)]
struct Record {
    name: Vec<u8>,
    symbol: Vec<u8>,
    flags: u8,
    uri: Vec<u8>,
    doc: Vec<u8>,
}

impl Record {
    fn new(name: &str, symbol: &str, flags: u8, uri: &str, doc: &str) -> Self {
        Record {
            name: name.into(),
            symbol: symbol.into(),
            flags,
            uri: uri.into(),
            doc: doc.into(),
        }
    }

    /// A vector record (`nameHex`, `symbolHex`, `flags`, `uriHex`, `docHex`).
    fn of(v: &Value) -> Self {
        Record {
            name: bytes(&v["nameHex"]),
            symbol: bytes(&v["symbolHex"]),
            flags: u8::try_from(number(&v["flags"])).expect("flags"),
            uri: bytes(&v["uriHex"]),
            doc: bytes(&v["docHex"]),
        }
    }

    fn meta(&self) -> Metadata<'_> {
        Metadata {
            name: &self.name,
            symbol: &self.symbol,
            flags: self.flags,
            uri: &self.uri,
            doc: &self.doc,
        }
    }

    fn hash(&self) -> [u8; 32] {
        metadata_hash(self.meta())
    }

    fn space(&self) -> usize {
        TOKEN_META_FIXED_LEN + self.name.len() + self.symbol.len() + self.uri.len() + self.doc.len()
    }
}

/// The `metadata.json` case whose name starts with `prefix`.
fn case<'a>(v: &'a Value, prefix: &str) -> &'a Value {
    v["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .find(|c| c["name"].as_str().expect("name").starts_with(prefix))
        .unwrap_or_else(|| panic!("no metadata.json case named {prefix}..."))
}

// ------------------------------------------------------------- the ledger

/// A ledger with the launchpad build and the `lms.json` launch (Configured,
/// named after the vector identity) placed at its address.
fn placed_launch() -> (Harness, Pubkey) {
    let lms = load(LMS_VECTORS);
    let mut h = Harness::builder()
        .program(LAUNCHPAD_PROGRAM_ID, "noised_launchpad")
        .build();
    let launch = address(&lms["accounts"]["launch"]["address"]);
    h.place_launchpad_account(&launch, bytes(&lms["accounts"]["launch"]["data"]));
    let pk = vector_identity().public_key().to_bytes();
    assert_eq!(
        hex(&identity_id(&pk)),
        lms["identity"]["identityId"].as_str().unwrap()
    );
    (h, launch)
}

/// Place a second Configured launch (another creator's) named after the
/// vector identity.
fn place_other_launch(h: &mut Harness, label: &str, live: bool) -> Pubkey {
    let creator = label_key(label);
    let launch_seed = sha256(&[b"seed/", label.as_bytes()]);
    let (launch, bump) = launch_pda(&creator, &launch_seed);
    let pk = vector_identity().public_key().to_bytes();
    let fields = LaunchFields {
        bump,
        live,
        launch_seed,
        creator,
        params_hash: sha256(&[b"params/", label.as_bytes()]),
        pq_identity: identity_id(&pk),
    };
    h.place_launchpad_account(&launch, launch_account_data(&fields));
    launch
}

/// The message the vector identity signs for `launch` (its creator and
/// `params_hash` read from the account), the hash `metadata_hash` and
/// `terms`.
fn message_for(h: &Harness, launch: &Pubkey, metadata_hash: &[u8; 32], terms: &Terms) -> Vec<u8> {
    let data = h.must(launch, "launch").data;
    let creator = Pubkey::new_from_array(
        data[LAUNCH_CREATOR_OFFSET..LAUNCH_CREATOR_OFFSET + 32]
            .try_into()
            .unwrap(),
    );
    let params_hash: [u8; 32] = data[LAUNCH_PARAMS_HASH_OFFSET..LAUNCH_PARAMS_HASH_OFFSET + 32]
        .try_into()
        .unwrap();
    attestation_message(launch, &params_hash, &creator, metadata_hash, terms)
}

/// A window that opens now and lasts an hour.
fn window_from_now(h: &Harness) -> Terms {
    Terms {
        not_before: h.now(),
        not_after: h.now() + MAX_LAUNCH_WINDOW_SECS,
        rules_hash: [0; 32],
    }
}

/// A new key holding exactly `lamports`.
fn throwaway(h: &mut Harness, lamports: u64) -> Keypair {
    let kp = Keypair::new();
    if lamports > 0 {
        h.airdrop(&kp.pubkey(), lamports);
    }
    kp
}

/// `ix` from `payer` in a v1 transaction with `config`.
fn send_v1(
    h: &mut Harness,
    payer: &Keypair,
    ix: Instruction,
    config: v1::TransactionConfig,
) -> TxResult {
    let tx = h.v1_tx_with(payer, &[ix], &[], config);
    h.submit(tx)
}

/// `publish_metadata` of `record` under `launch` from a throwaway key that
/// holds exactly the record's rent and the fee; it ends empty.
fn publish(h: &mut Harness, launch: &Pubkey, record: &Record) -> Sent {
    let rent = h.rent_exempt(record.space());
    let payer = throwaway(h, rent + SIGNATURE_FEE);
    let ix = publish_metadata_ix(&payer.pubkey(), launch, record.meta());
    let sent = send_v1(h, &payer, ix, publish_tx_config()).expect_ok("publish_metadata");
    assert_eq!(
        h.lamports(&payer.pubkey()),
        0,
        "the publishing key ends empty"
    );
    assert!(sent.cu <= u64::from(PUBLISH_CU_LIMIT));
    let (address, bump) = token_meta_pda(launch, &record.hash());
    let account = h.must(&address, "the record");
    assert_eq!(account.owner, LAUNCHPAD_PROGRAM_ID);
    assert_eq!(
        account.data,
        token_meta_account_data(bump, launch, record.meta())
    );
    assert_eq!(account.lamports, rent);
    assert_eq!(
        anchor_events(&sent.logs, "MetadataPublished"),
        vec![metadata_published_event(launch, record.meta())]
    );
    sent
}

/// `attest_launch` from the harness payer, as a client sends it (v1, A14
/// config words).
fn attest(h: &mut Harness, ix: Instruction) -> TxResult {
    let tx = h.v1_tx_with(&h.payer, &[ix], &[], attest_tx_config());
    h.submit(tx)
}

/// A signature by the vector identity over `launch`'s message for
/// `metadata_hash` and `terms`, at the next free leaf, naming `token_meta`.
fn signed_attestation(
    h: &Harness,
    launch: &Pubkey,
    metadata_hash: &[u8; 32],
    terms: &Terms,
    token_meta: &Pubkey,
) -> (Instruction, u32, Vec<u8>) {
    let key = vector_identity();
    let pk = key.public_key().to_bytes();
    let message = message_for(h, launch, metadata_hash, terms);
    let (signature, q) = h.sign_next(key, &message);
    assert_eq!(lms_verify::<Sha2>(&pk, &message, &signature), Some(q));
    let payer = h.payer.pubkey();
    let ix = attest_launch_ix_at(
        &payer,
        launch,
        &pk,
        &signature,
        metadata_hash,
        terms,
        token_meta,
    );
    (ix, q, message)
}

/// A valid signature that attests nothing: it lands, burns exactly its leaf
/// (`PqLeafConsumed`), and leaves the attestation and the account it named
/// as they were.
fn assert_burns_only(h: &mut Harness, launch: &Pubkey, ix: Instruction, q: u32, what: &str) {
    let pk: [u8; 56] = ix.data[8..64].try_into().unwrap();
    let pq_identity = identity_id(&pk);
    let identity = identity_pda(&pq_identity).0;
    let (attestation, bump) = attestation_pda(launch);
    let token_meta = ix.accounts[4].pubkey;
    let before = h.account(&attestation);
    let named = h.account(&token_meta);
    let (used, count) = h.identity_leaves(&identity);
    assert!(!leaf_used(&used, q), "{what}: leaf {q} is fresh");
    let sent = attest(h, ix).expect_ok(what);
    assert_eq!(
        anchor_events(&sent.logs, "PqLeafConsumed"),
        vec![pq_leaf_consumed_event(
            &pq_identity,
            u16::try_from(q).unwrap(),
            launch
        )],
        "{what}"
    );
    assert!(
        anchor_events(&sent.logs, "LaunchAttested").is_empty(),
        "{what}"
    );
    let (used, after) = h.identity_leaves(&identity);
    assert!(leaf_used(&used, q), "{what}: its leaf is burned");
    assert_eq!(after, count + 1, "{what}: one leaf more is used");
    let attestation_now = h.must(&attestation, "attestation");
    match before {
        Some(a) => assert_eq!(attestation_now, a, "{what}: the attestation stands"),
        None => assert_eq!(
            attestation_now.data,
            empty_attestation_account_data(bump),
            "{what}: the attestation stays empty"
        ),
    }
    assert_eq!(
        h.account(&token_meta),
        named,
        "{what}: the named account is read only"
    );
}

/// A valid signature that attests: `LaunchAttested` and the attestation as
/// documented. Sent by `payer` (the harness payer if `None`).
fn assert_attests(
    h: &mut Harness,
    launch: &Pubkey,
    ix: Instruction,
    (q, message, terms): (u32, &[u8], &Terms),
    payer: Option<&Keypair>,
) -> Sent {
    let pk: [u8; 56] = ix.data[8..64].try_into().unwrap();
    let signature = ix.data[68..68 + 2_508].to_vec();
    let metadata_hash: [u8; 32] = ix.data[68 + 2_508..68 + 2_508 + 32].try_into().unwrap();
    let sent = match payer {
        Some(payer) => send_v1(h, payer, ix, attest_tx_config()),
        None => attest(h, ix),
    }
    .expect_ok("the attesting signature");
    let (attestation, bump) = attestation_pda(launch);
    let record = AttestationRecord {
        bump,
        launch: *launch,
        pq_identity: identity_id(&pk),
        leaf: u16::try_from(q).unwrap(),
        metadata_hash,
        message_hash: sha256(&[message]),
        slot: h.clock().slot,
        terms: *terms,
        signature,
    };
    assert_eq!(
        anchor_events(&sent.logs, "LaunchAttested"),
        vec![launch_attested_event(&record)]
    );
    assert!(anchor_events(&sent.logs, "PqLeafConsumed").is_empty());
    assert_eq!(
        h.must(&attestation, "attestation").data,
        attestation_account_data(&record)
    );
    sent
}

fn hex(bytes: &[u8]) -> String {
    common::launchpad::hex(bytes)
}

// ------------------------------------------------------- publish_metadata

/// The records `publish_metadata` refuses, with the error, for every rule of
/// METADATA_PROGRAM.md A1 and the design's §4.4 (and the documented order of
/// the checks where a record breaks two rules).
fn refused_records() -> Vec<(&'static str, Record, LaunchpadError)> {
    const NAME: &str = "Phalanx Cryo Token";
    const SYMBOL: &str = "PHXCR";
    const URI: &str = "https://noised.example/t.json";
    const DOC: &str = r#"{"name":"Phalanx Cryo Token","symbol":"PHXCR"}"#;
    let r = Record::new;
    let ext = META_FLAG_EXTERNAL_URI;
    let inline = META_FLAG_INLINE_URI;
    let with_byte = |b: u8| {
        let mut rec = r(NAME, SYMBOL, ext, "", "");
        rec.uri = [b"https://noised.example/a".as_slice(), &[b], b".json"].concat();
        rec
    };
    vec![
        ("an empty name", r("", SYMBOL, 0, "", ""), INVALID_METADATA),
        (
            "a name of 33 bytes",
            r(&"N".repeat(33), SYMBOL, 0, "", ""),
            INVALID_METADATA,
        ),
        (
            "a name of 11 characters and 33 bytes",
            r(&"\u{20ac}".repeat(11), SYMBOL, 0, "", ""),
            INVALID_METADATA,
        ),
        ("an empty symbol", r(NAME, "", 0, "", ""), INVALID_METADATA),
        (
            "a symbol of 11 bytes",
            r(NAME, &"S".repeat(11), 0, "", ""),
            INVALID_METADATA,
        ),
        (
            "an unknown flag (bit 2)",
            r(NAME, SYMBOL, 4, "", ""),
            INVALID_METADATA_FLAGS,
        ),
        (
            "an unknown flag (bit 3)",
            r(NAME, SYMBOL, 8, "", DOC),
            INVALID_METADATA_FLAGS,
        ),
        (
            "an unknown flag (bit 7)",
            r(NAME, SYMBOL, 0x80, "", ""),
            INVALID_METADATA_FLAGS,
        ),
        (
            "every flag bit",
            r(NAME, SYMBOL, 0xFF, URI, DOC),
            INVALID_METADATA_FLAGS,
        ),
        (
            "both uri modes",
            r(NAME, SYMBOL, 3, URI, DOC),
            INVALID_METADATA_FLAGS,
        ),
        (
            "both uri modes, no uri",
            r(NAME, SYMBOL, 3, "", DOC),
            INVALID_METADATA_FLAGS,
        ),
        (
            "an inline uri without a document",
            r(NAME, SYMBOL, inline, "", ""),
            INVALID_METADATA_FLAGS,
        ),
        (
            "an inline uri with a uri of its own",
            r(NAME, SYMBOL, inline, URI, DOC),
            INVALID_METADATA_FLAGS,
        ),
        (
            "a uri without the external-uri flag",
            r(NAME, SYMBOL, 0, URI, ""),
            INVALID_METADATA_FLAGS,
        ),
        (
            "an http uri",
            r(NAME, SYMBOL, ext, "http://phalanx.example/t.json", ""),
            INVALID_METADATA,
        ),
        (
            "an upper-case scheme",
            r(NAME, SYMBOL, ext, "HTTPS://noised.example/t", ""),
            INVALID_METADATA,
        ),
        (
            "a scheme-relative uri",
            r(NAME, SYMBOL, ext, "//noised.example/t.json", ""),
            INVALID_METADATA,
        ),
        ("a uri with a space", with_byte(b' '), INVALID_METADATA),
        ("a uri with a tab", with_byte(b'\t'), INVALID_METADATA),
        ("a uri with a newline", with_byte(b'\n'), INVALID_METADATA),
        ("a uri with a NUL", with_byte(0), INVALID_METADATA),
        (
            "a uri with a unit separator (0x1F)",
            with_byte(0x1F),
            INVALID_METADATA,
        ),
        ("a uri with a DEL (0x7F)", with_byte(0x7F), INVALID_METADATA),
        (
            "a uri with a non-ASCII character",
            r(NAME, SYMBOL, ext, "https://phal\u{e1}nx.example/t", ""),
            INVALID_METADATA,
        ),
        (
            "nothing after https:// (8 bytes)",
            r(NAME, SYMBOL, ext, "https://", ""),
            INVALID_METADATA,
        ),
        (
            "an 8-byte uri",
            r(NAME, SYMBOL, ext, "https:/x", ""),
            INVALID_METADATA,
        ),
        (
            "an external-uri flag without a uri",
            r(NAME, SYMBOL, ext, "", DOC),
            INVALID_METADATA,
        ),
        (
            "an external uri of 201 bytes",
            r(
                NAME,
                SYMBOL,
                ext,
                &format!("https://{}", "u".repeat(193)),
                "",
            ),
            METADATA_TOO_LONG,
        ),
        (
            "a uri of 201 bytes without the flag",
            r(NAME, SYMBOL, 0, &format!("https://{}", "u".repeat(193)), ""),
            METADATA_TOO_LONG,
        ),
        (
            "a document of 3,073 bytes",
            r(NAME, SYMBOL, 0, "", &"d".repeat(MAX_DOC_LEN + 1)),
            METADATA_TOO_LONG,
        ),
        (
            "a document of 3,073 bytes, inline uri",
            r(NAME, SYMBOL, inline, "", &"d".repeat(MAX_DOC_LEN + 1)),
            METADATA_TOO_LONG,
        ),
        // Two faults: the first check in the documented order decides.
        (
            "both uri modes and a document of 3,073 bytes (flags first)",
            r(NAME, SYMBOL, 3, "", &"d".repeat(MAX_DOC_LEN + 1)),
            INVALID_METADATA_FLAGS,
        ),
        (
            "an empty name and a document of 3,073 bytes (length second)",
            r("", SYMBOL, 0, "", &"d".repeat(MAX_DOC_LEN + 1)),
            METADATA_TOO_LONG,
        ),
        (
            "an empty name and a uri without the flag (name third)",
            r("", SYMBOL, 0, URI, ""),
            INVALID_METADATA,
        ),
        (
            "an inline uri without a document and an empty symbol (symbol before the modes)",
            r(NAME, "", inline, "", ""),
            INVALID_METADATA,
        ),
    ]
}

/// The edges `publish_metadata` accepts.
fn accepted_edges() -> Vec<(&'static str, Record)> {
    let r = Record::new;
    let ext = META_FLAG_EXTERNAL_URI;
    let printable: String = (0x21u8..=0x7E).map(char::from).collect();
    vec![
        ("a 1-byte name and symbol", r("N", "S", 0, "", "")),
        (
            "a 32-byte name and a 10-byte symbol",
            r(
                &"N".repeat(MAX_NAME_LEN),
                &"S".repeat(MAX_SYMBOL_LEN),
                0,
                "",
                "",
            ),
        ),
        ("a 9-byte external uri", r("N", "S", ext, "https://x", "")),
        (
            "a 200-byte external uri",
            r(
                "N",
                "S",
                ext,
                &format!("https://{}", "u".repeat(MAX_URI_LEN - 8)),
                "",
            ),
        ),
        (
            "an external uri with every printable ASCII byte",
            r("N", "S", ext, &format!("https://{printable}"), ""),
        ),
        (
            "a document of 3,072 bytes",
            r("N", "S", 0, "", &"d".repeat(MAX_DOC_LEN)),
        ),
        (
            "an inline uri of a 1-byte document",
            r("N", "S", META_FLAG_INLINE_URI, "", "d"),
        ),
        (
            "an external uri with a document",
            r("N", "S", ext, "https://x", "d"),
        ),
    ]
}

/// Every invalid record is refused with its error and writes nothing (the
/// publishing key pays only the fee); every accepted edge publishes; a
/// launch that is live, an account that is not a launch, another address
/// for the record and a string that is not UTF-8 are refused too. The rules
/// in `common::launchpad` (what the vectors and the SDK follow) give the
/// same answer for every record.
#[test]
fn publish_metadata_refuses_every_invalid_record_and_writes_nothing() {
    let (mut h, launch) = placed_launch();
    let refused = refused_records();
    for (what, record, error) in &refused {
        assert_eq!(
            metadata_error(record.meta()),
            Some(*error),
            "{what}: the documented rules"
        );
        let address = token_meta_pda(&launch, &record.hash()).0;
        let payer = throwaway(&mut h, LAMPORTS_PER_SOL);
        let ix = publish_metadata_ix(&payer.pubkey(), &launch, record.meta());
        send_v1(&mut h, &payer, ix, publish_tx_config()).expect_error(*error, what);
        assert!(h.account(&address).is_none(), "{what}: nothing written");
        assert_eq!(
            h.lamports(&payer.pubkey()),
            LAMPORTS_PER_SOL - SIGNATURE_FEE,
            "{what}: only the fee is spent"
        );
    }
    report("publish_metadata refusals", refused.len());
    for (what, record) in accepted_edges() {
        assert_eq!(metadata_error(record.meta()), None, "{what}");
        let sent = publish(&mut h, &launch, &record);
        report(
            &format!("publish_metadata, {what}: size / CU"),
            format!("{} B / {}", sent.size, sent.cu),
        );
    }

    let record = Record::new("Phalanx Cryo Token", "PHXCR", 0, "", "");
    let payer = throwaway(&mut h, LAMPORTS_PER_SOL);
    // A launch that went live takes no record.
    let live = place_other_launch(&mut h, "live launch", true);
    let ix = publish_metadata_ix(&payer.pubkey(), &live, record.meta());
    send_v1(&mut h, &payer, ix, publish_tx_config())
        .expect_error(WRONG_LAUNCH_STATE, "a launch that is live");
    assert!(h
        .account(&token_meta_pda(&live, &record.hash()).0)
        .is_none());
    // The record's account must be the address its content hashes to.
    let other = token_meta_pda(&launch, &[7; 32]).0;
    let ix = publish_metadata_ix_at(&payer.pubkey(), &launch, record.meta(), &other);
    send_v1(&mut h, &payer, ix, publish_tx_config())
        .expect_error(CONSTRAINT_SEEDS, "the record at another address");
    // The launch must be a launch of this program.
    let edge = token_meta_pda(&launch, &Record::new("N", "S", 0, "", "").hash()).0;
    let ix = publish_metadata_ix_at(
        &payer.pubkey(),
        &edge,
        record.meta(),
        &token_meta_pda(&edge, &record.hash()).0,
    );
    send_v1(&mut h, &payer, ix, publish_tx_config())
        .expect_error(ACCOUNT_DISCRIMINATOR_MISMATCH, "a record as the launch");
    let stranger = label_key("not a launch");
    h.place_account(&stranger, vec![0; 585], &HOOK_ID);
    let ix = publish_metadata_ix(&payer.pubkey(), &stranger, record.meta());
    send_v1(&mut h, &payer, ix, publish_tx_config()).expect_error(
        ACCOUNT_OWNED_BY_WRONG_PROGRAM,
        "another program's account as the launch",
    );
    // A record that is not UTF-8 never deserializes.
    for (what, bad) in [
        (
            "a name that is not UTF-8",
            Record {
                name: vec![0xFF],
                ..record.clone()
            },
        ),
        (
            "a document that is not UTF-8",
            Record {
                doc: vec![b'{', 0xC3],
                ..record.clone()
            },
        ),
        (
            "an external uri that is not UTF-8",
            Record {
                flags: META_FLAG_EXTERNAL_URI,
                uri: [b"https://x".as_slice(), &[0x80]].concat(),
                ..record.clone()
            },
        ),
    ] {
        let ix = publish_metadata_ix(&payer.pubkey(), &launch, bad.meta());
        send_v1(&mut h, &payer, ix, publish_tx_config())
            .expect_error(INSTRUCTION_DID_NOT_DESERIALIZE, what);
        assert!(h.account(&token_meta_pda(&launch, &bad.hash()).0).is_none());
    }
    // Nothing in the launch changed.
    let lms = load(LMS_VECTORS);
    assert_eq!(
        h.must(&launch, "launch").data,
        bytes(&lms["accounts"]["launch"]["data"])
    );
}

/// The largest records fit a v1 transaction: a 3,072-byte document with a
/// 32-byte name and a 10-byte symbol, in each uri mode (the external one
/// with a 200-byte uri: the largest record, 3,405 bytes), each published by
/// a throwaway key holding exactly the rent and the fee. Publishing again,
/// by anyone, writes nothing, emits nothing and costs only the fee; another
/// record of the launch lands at its own address and leaves the first as
/// it is.
#[test]
fn the_largest_records_publish_in_one_v1_transaction_once() {
    let v = load(METADATA_VECTORS);
    let (mut h, launch) = placed_launch();
    let largest = Record::of(&case(&v, "the largest record")["record"]);
    assert_eq!(largest.space(), 3_405);
    assert_eq!(
        (
            largest.name.len(),
            largest.symbol.len(),
            largest.uri.len(),
            largest.doc.len()
        ),
        (MAX_NAME_LEN, MAX_SYMBOL_LEN, MAX_URI_LEN, MAX_DOC_LEN)
    );
    let no_uri = Record {
        flags: 0,
        uri: Vec::new(),
        ..largest.clone()
    };
    let inline = Record {
        flags: META_FLAG_INLINE_URI,
        uri: Vec::new(),
        ..largest.clone()
    };
    for (what, record) in [
        ("no uri", &no_uri),
        ("inline uri", &inline),
        ("external uri of 200 bytes", &largest),
    ] {
        let sent = publish(&mut h, &launch, record);
        report(
            &format!(
                "publish_metadata, the largest record ({what}, {} bytes): size / CU",
                record.space()
            ),
            format!("{} B / {}", sent.size, sent.cu),
        );
        assert!(
            sent.size <= v1::MAX_TRANSACTION_SIZE,
            "{what}: {} B",
            sent.size
        );
    }
    let rent = h.rent_exempt(largest.space());
    report("rent of the largest record (3,405 bytes, lamports)", rent);

    // Again, from another throwaway key: a retry or a racing relayer.
    let address = token_meta_pda(&launch, &largest.hash()).0;
    let first = h.must(&address, "the record");
    let minimum = h.rent_exempt(0);
    let payer = throwaway(&mut h, minimum + SIGNATURE_FEE);
    let ix = publish_metadata_ix(&payer.pubkey(), &launch, largest.meta());
    let again = send_v1(&mut h, &payer, ix, publish_tx_config()).expect_ok("published again");
    assert!(anchor_events(&again.logs, "MetadataPublished").is_empty());
    assert_eq!(h.must(&address, "the record"), first);
    assert_eq!(h.lamports(&payer.pubkey()), minimum, "only the fee");
    for record in [&no_uri, &inline] {
        let other = token_meta_pda(&launch, &record.hash()).0;
        assert_ne!(other, address);
        assert_eq!(h.must(&other, "another record").data.len(), record.space());
    }
}

/// Lamports sent to a record's address before it is published (anyone can;
/// at least the rent-exempt minimum of an empty account, which the runtime
/// requires of a new account) block nothing: `publish_metadata` takes the
/// address over, adding only what the rent still needs, and keeps any
/// surplus there.
#[test]
fn publish_metadata_takes_over_a_prefunded_address() {
    let v = load(METADATA_VECTORS);
    let (mut h, launch) = placed_launch();
    let typical = Record::of(&case(&v, "typical: ")["record"]);
    let other = Record::of(&case(&v, "no document and no uri")["record"]);
    let minimum = h.rent_exempt(0);
    for (record, prefund) in [(&typical, minimum), (&other, LAMPORTS_PER_SOL)] {
        let (address, bump) = token_meta_pda(&launch, &record.hash());
        let rent = h.rent_exempt(record.space());
        h.airdrop(&address, prefund);
        assert_eq!(h.must(&address, "pre-funded").owner, SYSTEM_PROGRAM_ID);
        let cost = rent.saturating_sub(prefund);
        let payer = throwaway(&mut h, minimum + cost + SIGNATURE_FEE);
        let ix = publish_metadata_ix(&payer.pubkey(), &launch, record.meta());
        let sent = send_v1(&mut h, &payer, ix, publish_tx_config())
            .expect_ok("publish_metadata over a pre-funded address");
        let account = h.must(&address, "the record");
        assert_eq!(account.owner, LAUNCHPAD_PROGRAM_ID);
        assert_eq!(
            account.data,
            token_meta_account_data(bump, &launch, record.meta())
        );
        assert_eq!(account.lamports, rent.max(prefund));
        assert_eq!(
            h.lamports(&payer.pubkey()),
            minimum,
            "the payer added {cost}"
        );
        assert_eq!(
            anchor_events(&sent.logs, "MetadataPublished"),
            vec![metadata_published_event(&launch, record.meta())]
        );
    }
}

// ---------------------------------------------------------- attest_launch

/// A valid signature by the launch's identity attests only the published
/// record its hash names; anything else at that address burns only its
/// leaf. The cases a third party can bring about (nothing published, a
/// pre-funded address, hashes no record has) and, placed with
/// `set_account`, an account that differs from the record in one property
/// `attest_launch` checks (owner, discriminator, version, launch, hash,
/// stored bump, length). Once the record is published the next signature
/// attests, and a later one only burns its leaf again. (Naming any other
/// address fails the transaction: the next test.)
#[test]
fn attest_launch_attests_only_the_published_record_its_hash_names() {
    let v = load(METADATA_VECTORS);
    let (mut h, launch) = placed_launch();
    let other_launch = place_other_launch(&mut h, "another launch", false);
    let record = Record::of(&case(&v, "typical, inline uri")["record"]);
    let junk = Record::of(&case(&v, "no document and no uri")["record"]);
    let hash = record.hash();
    let (address, bump) = token_meta_pda(&launch, &hash);
    let terms = window_from_now(&h);
    let true_bytes = token_meta_account_data(bump, &launch, record.meta());

    let burn = |h: &mut Harness, hash: &[u8; 32], named: &Pubkey, what: &str| {
        let (ix, q, _) = signed_attestation(h, &launch, hash, &terms, named);
        assert_burns_only(h, &launch, ix, q, what);
    };
    // Third parties.
    burn(&mut h, &hash, &address, "the record was never published");
    h.airdrop(&address, LAMPORTS_PER_SOL);
    burn(&mut h, &hash, &address, "its address only holds lamports");
    burn(
        &mut h,
        &[0; 32],
        &token_meta_pda(&launch, &[0; 32]).0,
        "a hash no record has (zero)",
    );
    let random = sha256(&[b"not the hash of a record"]);
    burn(
        &mut h,
        &random,
        &token_meta_pda(&launch, &random).0,
        "a hash no record has",
    );
    publish(&mut h, &launch, &junk);
    let junk_address = token_meta_pda(&launch, &junk.hash()).0;

    // One property off at the address the hash names.
    let with = |at: usize, value: &[u8]| {
        let mut d = true_bytes.clone();
        d[at..at + value.len()].copy_from_slice(value);
        d
    };
    let other_bump = (0..=u8::MAX).rev().find(|b| *b != bump).unwrap();
    let variants: Vec<(&str, Vec<u8>, Pubkey)> = vec![
        (
            "owned by the system program",
            true_bytes.clone(),
            SYSTEM_PROGRAM_ID,
        ),
        ("owned by another program", true_bytes.clone(), HOOK_ID),
        (
            "owned by Token-2022",
            true_bytes.clone(),
            TOKEN_2022_PROGRAM_ID,
        ),
        (
            "another account type's discriminator",
            with(0, &anchor_discriminator("account", "Attestation")),
            LAUNCHPAD_PROGRAM_ID,
        ),
        (
            "one discriminator bit flipped",
            with(7, &[true_bytes[7] ^ 0x80]),
            LAUNCHPAD_PROGRAM_ID,
        ),
        ("version 0", with(8, &[0]), LAUNCHPAD_PROGRAM_ID),
        ("version 2", with(8, &[2]), LAUNCHPAD_PROGRAM_ID),
        (
            "another launch stored",
            with(11, other_launch.as_ref()),
            LAUNCHPAD_PROGRAM_ID,
        ),
        (
            "another hash stored",
            with(43, &junk.hash()),
            LAUNCHPAD_PROGRAM_ID,
        ),
        (
            "a stored bump that is not the address's",
            with(9, &[other_bump]),
            LAUNCHPAD_PROGRAM_ID,
        ),
        (
            "one byte short of the fixed fields",
            true_bytes[..TOKEN_META_FIXED_LEN - 1].to_vec(),
            LAUNCHPAD_PROGRAM_ID,
        ),
        ("no data", Vec::new(), LAUNCHPAD_PROGRAM_ID),
    ];
    for (what, data, owner) in variants {
        h.place_account(&address, data, &owner);
        burn(&mut h, &hash, &address, what);
    }

    // Published: the next signature attests.
    h.remove_account(&address);
    publish(&mut h, &launch, &record);
    assert_eq!(h.must(&address, "the record").data, true_bytes);
    let (ix, q, message) = signed_attestation(&h, &launch, &hash, &terms, &address);
    let sent = assert_attests(&mut h, &launch, ix, (q, &message, &terms), None);
    report(
        "attest_launch after 16 burned leaves (typical record, inline uri): size / CU",
        format!("{} B / {}", sent.size, sent.cu),
    );
    // Attested: any later signature only burns its leaf.
    burn(
        &mut h,
        &hash,
        &address,
        "the record again, after the attestation",
    );
    burn(
        &mut h,
        &junk.hash(),
        &junk_address,
        "a junk record, after the attestation",
    );
    let pk = vector_identity().public_key().to_bytes();
    let (_, used) = h.identity_leaves(&identity_pda(&identity_id(&pk)).0);
    assert_eq!(used, 19, "every signature burned exactly one leaf");
}

/// The adversarial review of the metadata change: whoever relays a
/// signature must not choose what it does. `attest_launch`'s record account
/// is the one address the signed hash names, and any other account fails
/// the transaction (Anchor's `ConstraintSeeds` on `token_meta`) with nothing
/// burned or written: a junk record of the launch, the same record under
/// another launch, the record's exact bytes at another address, the launch
/// account, the System program, the address of another hash. So a copy of a
/// creator's pending attestation that names any of them cannot land first
/// and burn its leaf (which would leave the launch unattested and the
/// creator's own transaction failing `PqLeafUsed`, at every retry). Before
/// the record is published the copies fail too, and the signature at the
/// right address only burns its leaf; once it is published they fail, and
/// the creator's transaction, with the same signature, attests.
#[test]
fn attest_launch_refuses_any_account_but_the_one_its_hash_names() {
    let v = load(METADATA_VECTORS);
    let (mut h, launch) = placed_launch();
    let other_launch = place_other_launch(&mut h, "another launch", false);
    let record = Record::of(&case(&v, "typical, inline uri")["record"]);
    let junk = Record::of(&case(&v, "no document and no uri")["record"]);
    let hash = record.hash();
    let (address, bump) = token_meta_pda(&launch, &hash);
    let terms = window_from_now(&h);
    publish(&mut h, &launch, &junk);
    publish(&mut h, &other_launch, &record);
    let copy = label_key("a copy of the record");
    h.place_launchpad_account(&copy, token_meta_account_data(bump, &launch, record.meta()));
    let decoys = [
        (
            "a junk record of the launch",
            token_meta_pda(&launch, &junk.hash()).0,
        ),
        (
            "the same record under another launch",
            token_meta_pda(&other_launch, &hash).0,
        ),
        ("the record's bytes at another address", copy),
        ("the launch account", launch),
        ("the System program", SYSTEM_PROGRAM_ID),
        (
            "the address of another hash",
            token_meta_pda(&launch, &[0; 32]).0,
        ),
    ];
    let pk = vector_identity().public_key().to_bytes();
    let identity = identity_pda(&identity_id(&pk)).0;
    let attestation = attestation_pda(&launch).0;
    // Copies of `ix` from another payer, each naming a decoy: refused, and
    // nothing changes.
    let refused = |h: &mut Harness, ix: &Instruction, q: u32, when: &str| {
        let mallory = throwaway(h, LAMPORTS_PER_SOL);
        for (what, decoy) in decoys {
            let what = format!("{what} ({when})");
            let mut copy = ix.clone();
            copy.accounts[0] = AccountMeta::new(mallory.pubkey(), true);
            copy.accounts[4] = AccountMeta::new_readonly(decoy, false);
            let before = (
                h.account(&identity),
                h.account(&attestation),
                h.account(&decoy),
            );
            let f = send_v1(h, &mallory, copy, attest_tx_config())
                .expect_error(CONSTRAINT_SEEDS, &what);
            assert!(
                f.logs
                    .iter()
                    .any(|l| l.contains("caused by account: token_meta")),
                "{what}"
            );
            assert_eq!(
                (
                    h.account(&identity),
                    h.account(&attestation),
                    h.account(&decoy)
                ),
                before,
                "{what}: nothing written"
            );
            assert!(!leaf_used(&h.identity_leaves(&identity).0, q), "{what}");
        }
    };

    // Not published yet: the copies fail; at the right address the
    // signature lands and only burns its leaf.
    let (ix, q, _) = signed_attestation(&h, &launch, &hash, &terms, &address);
    refused(&mut h, &ix, q, "before the record");
    assert_burns_only(&mut h, &launch, ix, q, "the record was never published");

    // Published: the copies fail, then the creator's transaction with the
    // same signature attests.
    publish(&mut h, &launch, &record);
    let (ix, q, message) = signed_attestation(&h, &launch, &hash, &terms, &address);
    refused(&mut h, &ix, q, "after the record");
    let sent = assert_attests(&mut h, &launch, ix, (q, &message, &terms), None);
    report(
        "attest_launch after six refused copies (typical record, inline uri): size / CU",
        format!("{} B / {}", sent.size, sent.cu),
    );
    let (_, used) = h.identity_leaves(&identity);
    assert_eq!(used, 2, "only the two signatures that landed burned a leaf");
}

/// `metadata.json`'s attestation (the typical record, signed by the vector
/// identity at the leaf its message probes to) lands byte for byte on the
/// `lms.json` launch. Sent before its record is published (the race
/// METADATA_ONCHAIN.md §3.3 accepts), it only burns its leaf; the client
/// then publishes and signs again at the next leaf, which attests. Sent
/// after the record (published by the vectors' `publishTypical` instruction
/// from its throwaway key), it attests, and the attestation holds its
/// message hash and signature. The two vector files describe one launch and
/// one identity.
#[test]
fn the_metadata_vectors_attestation_lands_and_attests_only_after_its_record() {
    let v = load(METADATA_VECTORS);
    let lms = load(LMS_VECTORS);
    let a = &v["attestation"];
    let launch = address(&v["launch"]["address"]);
    assert_eq!(launch, address(&lms["accounts"]["launch"]["address"]));
    assert_eq!(a["publicKey"], lms["identity"]["publicKey"]);
    assert_eq!(a["paramsHash"], lms["attestation"]["paramsHash"]);
    assert_eq!(a["creatorBytes"], lms["attestation"]["creatorBytes"]);
    let pk: [u8; 56] = bytes(&a["publicKey"]).try_into().unwrap();
    assert_eq!(pk, vector_identity().public_key().to_bytes());
    let typical = case(&v, "typical: ");
    let record = Record::of(&typical["record"]);
    let hash = record.hash();
    assert_eq!(hex(&hash), a["metadataHash"].as_str().unwrap());
    let terms = Terms {
        not_before: a["notBefore"].as_i64().unwrap(),
        not_after: a["notAfter"].as_i64().unwrap(),
        rules_hash: [0; 32],
    };
    let q = u32::try_from(number(&a["q"])).unwrap();
    let signature = bytes(&a["signature"]);
    let payer =
        Keypair::new_from_array(bytes(&v["publishTypical"]["payerSeed"]).try_into().unwrap());
    assert_eq!(payer.pubkey(), address(&a["payer"]));
    let instruction = |v: &Value| Instruction {
        program_id: LAUNCHPAD_PROGRAM_ID,
        accounts: v["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| AccountMeta {
                pubkey: address(&m["pubkey"]),
                is_signer: m["isSigner"].as_bool().unwrap(),
                is_writable: m["isWritable"].as_bool().unwrap(),
            })
            .collect(),
        data: bytes(&v["data"]),
    };
    let attest_ix = instruction(a);
    let publish_ix = instruction(&v["publishTypical"]);
    // The vectors' instructions are what the documented builders produce.
    assert_eq!(
        attest_ix,
        attest_launch_ix(
            &payer.pubkey(),
            &launch,
            &pk,
            &signature,
            record.meta(),
            &terms
        )
    );
    assert_eq!(
        publish_ix,
        publish_metadata_ix(&payer.pubkey(), &launch, record.meta())
    );

    let ledger = || {
        let (mut h, placed) = placed_launch();
        assert_eq!(placed, launch);
        // The landing time: the window opens at genesis, the harness clock's start.
        assert_eq!(h.now(), terms.not_before);
        let message = message_for(&h, &launch, &hash, &terms);
        assert_eq!(hex(&message), a["message"].as_str().unwrap());
        assert_eq!(lms_verify::<Sha2>(&pk, &message, &signature), Some(q));
        let rents = h.rent_exempt(IDENTITY_ACCOUNT_LEN) + h.rent_exempt(ATTESTATION_ACCOUNT_LEN);
        h.airdrop(
            &payer.pubkey(),
            h.rent_exempt(record.space()) + rents + 2 * SIGNATURE_FEE,
        );
        (h, message)
    };

    // The race: the attestation lands first and only burns its leaf.
    let (mut h, message) = ledger();
    let sent = send_v1(&mut h, &payer, attest_ix.clone(), attest_tx_config())
        .expect_ok("the vectors' attestation before its record");
    let pq_identity = identity_id(&pk);
    assert_eq!(
        anchor_events(&sent.logs, "PqLeafConsumed"),
        vec![pq_leaf_consumed_event(
            &pq_identity,
            u16::try_from(q).unwrap(),
            &launch
        )]
    );
    let (attestation, bump) = attestation_pda(&launch);
    assert_eq!(
        h.must(&attestation, "attestation").data,
        empty_attestation_account_data(bump)
    );
    let sent =
        send_v1(&mut h, &payer, publish_ix.clone(), publish_tx_config()).expect_ok("publish");
    assert_eq!(
        anchor_events(&sent.logs, "MetadataPublished"),
        vec![bytes(&typical["metadataPublishedEvent"])]
    );
    h.airdrop(&payer.pubkey(), LAMPORTS_PER_SOL);
    send_v1(&mut h, &payer, attest_ix.clone(), attest_tx_config())
        .expect_error(PQ_LEAF_USED, "the same signature after the record");
    let (ix, next, _) =
        signed_attestation(&h, &launch, &hash, &terms, &address(&a["tokenMetaAccount"]));
    assert_ne!(next, q);
    assert_attests(&mut h, &launch, ix, (next, &message, &terms), None);

    // Published first: the vectors' attestation attests.
    let (mut h, message) = ledger();
    let sent = send_v1(&mut h, &payer, publish_ix, publish_tx_config()).expect_ok("publishTypical");
    report(
        "publish_metadata, the vectors' publishTypical: size / CU",
        format!("{} B / {}", sent.size, sent.cu),
    );
    let record_account = h.must(&address(&typical["tokenMeta"]["address"]), "the record");
    assert_eq!(
        hex(&record_account.data),
        typical["tokenMeta"]["data"].as_str().unwrap()
    );
    let sent = assert_attests(
        &mut h,
        &launch,
        attest_ix,
        (q, &message, &terms),
        Some(&payer),
    );
    report(
        "attest_launch, the vectors' attestation (typical record, first): size / CU",
        format!("{} B / {}", sent.size, sent.cu),
    );
    assert_eq!(
        h.lamports(&payer.pubkey()),
        0,
        "the record's and the attestation's rents, two fees"
    );
    let data = h.must(&attestation, "attestation").data;
    assert_eq!(hex(&data[76..108]), a["metadataHash"].as_str().unwrap());
    assert_eq!(hex(&data[108..140]), a["rulesHash"].as_str().unwrap());
    assert_eq!(hex(&data[140..172]), a["messageHash"].as_str().unwrap());
}

// ------------------------------------------------------------------ launch

/// One launch through every step a client takes: `create_launch` (the
/// creator, legacy), `publish_metadata` and `attest_launch` (throwaway keys,
/// v1), ready for `launch` inside `terms`.
struct Ready {
    h: Harness,
    creator: Keypair,
    mint: Keypair,
    k: LaunchKeys,
    record: Record,
    token_meta: Pubkey,
    leaf: u32,
    publish_size: usize,
    attest_size: usize,
}

/// Create a launch under `seed` in `h` (taken), publish `record` and attest
/// it with `terms` (`None`: a window opening now).
fn ready_in(mut h: Harness, seed: u8, record: &Record, terms: Option<Terms>) -> Ready {
    let creator = h.funded_keypair(10);
    let mint = Keypair::new();
    let k = LaunchKeys::new(&creator.pubkey(), [seed; 32], &mint.pubkey());
    let pk = vector_identity().public_key().to_bytes();
    let recipients = [
        (label_key("recipient 0"), 7_000),
        (label_key("recipient 1"), 3_000),
    ];
    let params = LaunchParams::new(&recipients, identity_id(&pk));
    h.create_launch(&creator, &k, &params);
    let launch_data = h.must(&k.launch, "launch").data;
    assert_eq!(
        launch_data[LAUNCH_PARAMS_HASH_OFFSET..LAUNCH_PARAMS_HASH_OFFSET + 32],
        sha256(&[&params.borsh()]),
        "params_hash is the hash of the documented LaunchParams bytes"
    );
    assert_eq!(launch_data[LAUNCH_STATUS_OFFSET], 0, "Configured");

    let published = publish(&mut h, &k.launch, record);
    let hash = record.hash();
    let token_meta = k.token_meta(&hash);
    let terms = terms.unwrap_or_else(|| window_from_now(&h));
    let message = message_for(&h, &k.launch, &hash, &terms);
    let (signature, q) = h.sign_next(vector_identity(), &message);
    let rents = h.rent_exempt(IDENTITY_ACCOUNT_LEN) + h.rent_exempt(ATTESTATION_ACCOUNT_LEN);
    let attester = throwaway(&mut h, rents + SIGNATURE_FEE);
    let ix = attest_launch_ix(
        &attester.pubkey(),
        &k.launch,
        &pk,
        &signature,
        record.meta(),
        &terms,
    );
    let attested = send_v1(&mut h, &attester, ix, attest_tx_config()).expect_ok("attest_launch");
    assert_eq!(anchor_events(&attested.logs, "LaunchAttested").len(), 1);
    assert_eq!(h.lamports(&attester.pubkey()), 0);
    Ready {
        h,
        creator,
        mint,
        k,
        record: record.clone(),
        token_meta,
        leaf: q,
        publish_size: published.size,
        attest_size: attested.size,
    }
}

fn ready(seed: u8, record: &Record) -> Ready {
    ready_in(Harness::with_dbc(), seed, record, None)
}

/// `launch` by `payer`, as a client sends it (legacy; CU limit and price).
fn send_launch(r: &mut Ready, payer: &Keypair, token_meta: &Pubkey) -> TxResult {
    let tx = launch_tx(&r.h, payer, &r.mint, &r.k, token_meta);
    r.h.submit(tx)
}

/// Nothing of a launch exists yet: the launch is Configured and no mint,
/// pool or certificate exists.
fn assert_not_launched(r: &Ready, what: &str) {
    assert_eq!(
        r.h.must(&r.k.launch, "launch").data[LAUNCH_STATUS_OFFSET],
        0,
        "{what}"
    );
    for key in [r.k.mint, r.k.pool, r.k.certificate, r.k.policy] {
        assert!(r.h.account(&key).is_none(), "{what}: {key} exists");
    }
}

/// What a successful `launch` must leave: the launch Live with its mint and
/// pool, a Token-2022 mint whose TokenMetadata is exactly the record's name
/// and symbol and `expected_uri` (no update authority, no additional
/// metadata, nothing after them; the mint `386 + name + symbol + uri`
/// bytes), and a version-3 certificate with every check (`METADATA_ONCHAIN`
/// included) that names the record. The record itself is unchanged.
fn assert_launched(r: &Ready, expected_uri: &[u8]) {
    let launch = r.h.must(&r.k.launch, "launch").data;
    assert_eq!(launch[LAUNCH_STATUS_OFFSET], 1, "Live");
    assert_eq!(
        launch[LAUNCH_BASE_MINT_OFFSET..LAUNCH_BASE_MINT_OFFSET + 32],
        r.k.mint.to_bytes()
    );
    assert_eq!(
        launch[LAUNCH_POOL_OFFSET..LAUNCH_POOL_OFFSET + 32],
        r.k.pool.to_bytes()
    );

    let mint = r.h.must(&r.k.mint, "mint");
    assert_eq!(mint.owner, TOKEN_2022_PROGRAM_ID);
    let rec = &r.record;
    assert_eq!(
        mint.data.len(),
        MINT_FIXED_LEN + rec.name.len() + rec.symbol.len() + expected_uri.len()
    );
    let md = mint_metadata(&mint.data).expect("the mint's TokenMetadata");
    assert_eq!(
        md.extensions,
        vec![
            EXTENSION_METADATA_POINTER,
            EXTENSION_TRANSFER_HOOK,
            EXTENSION_TOKEN_METADATA
        ],
        "DBC's extensions, the metadata last"
    );
    assert_eq!(md.update_authority, [0; 32], "no update authority");
    assert_eq!(md.mint, r.k.mint);
    assert_eq!(md.name, rec.name, "name");
    assert_eq!(md.symbol, rec.symbol, "symbol");
    assert_eq!(md.uri, expected_uri, "uri");
    assert_eq!((md.additional, md.trailing), (0, 0), "nothing else");

    let cert = r.h.must(&r.k.certificate, "certificate");
    assert_eq!(cert.owner, LAUNCHPAD_PROGRAM_ID);
    assert_eq!(cert.data.len(), CERTIFICATE_ACCOUNT_LEN);
    let c = certificate_view(&cert.data);
    let attestation = r.h.must(&r.k.attestation, "attestation").data;
    let pk = vector_identity().public_key().to_bytes();
    assert_eq!(c.version, CERTIFICATE_VERSION);
    assert_eq!(
        (c.launch, c.base_mint, c.pool),
        (r.k.launch, r.k.mint, r.k.pool)
    );
    assert_eq!(c.creator, r.creator.pubkey());
    assert_eq!(
        c.checks, CHECKS_ALL,
        "every check, METADATA_ONCHAIN included"
    );
    assert_ne!(c.checks & CHECK_METADATA_ONCHAIN, 0);
    assert_ne!(c.checks & CHECK_PQ_ATTESTED, 0);
    assert_eq!(c.policy_version, SAFETY_POLICY_VERSION);
    assert_eq!(
        c.params_hash,
        launch[LAUNCH_PARAMS_HASH_OFFSET..LAUNCH_PARAMS_HASH_OFFSET + 32]
    );
    assert_eq!(c.pq_identity, identity_id(&pk));
    assert_eq!(u32::from(c.pq_leaf), r.leaf);
    assert_eq!(c.attested_slot.to_le_bytes(), attestation[172..180]);
    assert_eq!(c.metadata, r.token_meta, "the certificate names the record");
    assert_eq!(c.rules_hash, [0; 32], "no creator rules");

    let (_, bump) = token_meta_pda(&r.k.launch, &rec.hash());
    assert_eq!(
        r.h.must(&r.token_meta, "the record").data,
        token_meta_account_data(bump, &r.k.launch, rec.meta()),
        "the record is never modified"
    );
}

/// The uri `launch` must give the mint, three ways: the vectors' value (when
/// the record is a vector case), `common::launchpad::token_uri` (base64
/// written bit by bit) and the `base64` crate; an inline uri decodes back to
/// the document.
fn expected_uri(record: &Record, vector: Option<&Value>) -> Vec<u8> {
    let uri = token_uri(record.meta());
    let crate_uri = match record.flags {
        META_FLAG_INLINE_URI => [
            INLINE_URI_PREFIX.as_bytes(),
            base64::engine::general_purpose::STANDARD
                .encode(&record.doc)
                .as_bytes(),
        ]
        .concat(),
        META_FLAG_EXTERNAL_URI => record.uri.clone(),
        _ => Vec::new(),
    };
    assert_eq!(uri, crate_uri);
    if record.flags == META_FLAG_INLINE_URI {
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&uri[INLINE_URI_PREFIX.len()..])
            .expect("standard padded base64");
        assert_eq!(decoded, record.doc);
        assert_eq!(
            base64_encode(&record.doc).len(),
            record.doc.len().div_ceil(3) * 4
        );
    }
    if let Some(case) = vector {
        assert_eq!(
            uri,
            case["tokenUri"].as_str().unwrap().as_bytes(),
            "the vectors' uri"
        );
        assert_eq!(uri.len() as u64, number(&case["tokenUriLen"]));
    }
    uri
}

/// `launch` in each uri mode at typical and maximum sizes: the record's name
/// and symbol and the derived uri (empty; the inline `data:` uri of the
/// document, up to 4,125 bytes; the external uri, up to 200) are exactly
/// what the mint holds, and the certificate carries `METADATA_ONCHAIN` and
/// the record. The launch is paid by a keeper, not the creator. Its
/// transaction (legacy, with a CU limit and price) has one size whatever the
/// record, and so has `attest_launch`'s; `publish_metadata` grows with the
/// record. Once live, the launch takes no more records.
#[test]
fn launch_gives_the_mint_the_attested_record_in_every_uri_mode() {
    let v = load(METADATA_VECTORS);
    let largest = Record::of(&case(&v, "the largest record")["record"]);
    let largest_no_uri = Record {
        flags: 0,
        uri: Vec::new(),
        ..largest.clone()
    };
    let cases: Vec<(&str, Record, Option<&Value>)> = [
        ("typical, no uri", "typical: "),
        ("typical, inline uri", "typical, inline uri"),
        ("typical, external uri", "typical, external uri"),
        (
            "multi-byte document, inline uri",
            "an inline uri of a multi-byte",
        ),
        (
            "largest document, inline uri (4,125 bytes)",
            "the largest document",
        ),
        (
            "largest record, external uri of 200 bytes",
            "the largest record",
        ),
        ("UTF-8 name of 32 bytes, no document", "a UTF-8 name"),
    ]
    .iter()
    .map(|(what, prefix)| {
        let c = case(&v, prefix);
        (*what, Record::of(&c["record"]), Some(c))
    })
    .chain(std::iter::once((
        "largest record, no uri",
        largest_no_uri,
        None,
    )))
    .collect();

    let mut sizes = Vec::new();
    for (seed, (what, record, vector)) in cases.iter().enumerate() {
        let uri = expected_uri(record, *vector);
        let mut r = ready(u8::try_from(seed).unwrap() + 1, record);
        let keeper = r.h.funded_keypair(10);
        let creator_before = r.h.lamports(&r.creator.pubkey());
        let keeper_before = r.h.lamports(&keeper.pubkey());
        let token_meta = r.token_meta;
        let sent = send_launch(&mut r, &keeper, &token_meta).expect_ok(what);
        assert_launched(&r, &uri);
        assert_eq!(
            r.h.lamports(&r.creator.pubkey()),
            creator_before,
            "{what}: the creator pays nothing"
        );
        let mint = r.h.must(&r.k.mint, "mint");
        report(
            &format!("launch, {what}: size / CU / mint bytes, rent / keeper's cost (lamports)"),
            format!(
                "{} B / {} / {} B, {} / {}",
                sent.size,
                sent.cu,
                mint.data.len(),
                mint.lamports,
                keeper_before - r.h.lamports(&keeper.pubkey())
            ),
        );
        sizes.push((*what, r.publish_size, r.attest_size, sent.size));

        // Live: no record is published under it any more.
        let payer = throwaway(&mut r.h, LAMPORTS_PER_SOL);
        let ix = publish_metadata_ix(
            &payer.pubkey(),
            &r.k.launch,
            Record::new("N", "S", 0, "", "").meta(),
        );
        send_v1(&mut r.h, &payer, ix, publish_tx_config())
            .expect_error(WRONG_LAUNCH_STATE, "publish after the launch");
    }
    for (what, publish_size, attest_size, launch_size) in &sizes {
        report(
            &format!("{what}: publish_metadata (v1) / attest_launch (v1) / launch (legacy) bytes"),
            format!("{publish_size} / {attest_size} / {launch_size}"),
        );
    }
    let launch_size = sizes[0].3;
    let attest_size = sizes[0].2;
    assert!(
        sizes.iter().all(|s| s.3 == launch_size),
        "launch has one size"
    );
    assert!(
        sizes.iter().all(|s| s.2 == attest_size),
        "attest_launch has one size"
    );
    assert!(launch_size <= PACKET_DATA_SIZE, "{launch_size} B");
    assert!(attest_size <= v1::MAX_TRANSACTION_SIZE, "{attest_size} B");
    assert!(sizes.iter().all(|s| s.1 <= v1::MAX_TRANSACTION_SIZE));
}

/// `launch` takes the metadata only from the record its attestation names
/// (`["metadata", launch, attestation.metadata_hash]` with its stored bump,
/// a version-1 `TokenMeta` of this launch and this hash): a junk record of
/// the launch, the same record under another launch, an unpublished
/// address, and (placed with `set_account` at the named address) a record
/// with another owner, discriminator, bump, version, launch or hash are all
/// refused and leave nothing launched. The named record then launches.
#[test]
fn launch_uses_only_the_record_its_attestation_names() {
    let v = load(METADATA_VECTORS);
    let record = Record::of(&case(&v, "typical, inline uri")["record"]);
    let junk = Record::of(&case(&v, "no document and no uri")["record"]);
    let mut r = ready(9, &record);
    let keeper = r.h.funded_keypair(10);
    let launch = r.k.launch;
    publish(&mut r.h, &launch, &junk);
    let other_launch = place_other_launch(&mut r.h, "another launch", false);
    publish(&mut r.h, &other_launch, &record);
    let refusals = [
        (
            "a junk record of the launch",
            r.k.token_meta(&junk.hash()),
            CONSTRAINT_SEEDS,
        ),
        (
            "the same record under another launch",
            token_meta_pda(&other_launch, &record.hash()).0,
            CONSTRAINT_SEEDS,
        ),
        (
            "an unpublished record",
            r.k.token_meta(&[3; 32]),
            ACCOUNT_NOT_INITIALIZED,
        ),
    ];
    for (what, token_meta, error) in refusals {
        send_launch(&mut r, &keeper, &token_meta).expect_error(error, what);
        assert_not_launched(&r, what);
    }

    let named = r.token_meta;
    let true_account = r.h.must(&named, "the record");
    let with = |at: usize, value: &[u8]| {
        let mut d = true_account.data.clone();
        d[at..at + value.len()].copy_from_slice(value);
        d
    };
    let bump = true_account.data[9];
    let variants: Vec<(&str, Vec<u8>, Pubkey, LaunchpadError)> = vec![
        (
            "owned by another program",
            true_account.data.clone(),
            HOOK_ID,
            ACCOUNT_OWNED_BY_WRONG_PROGRAM,
        ),
        (
            "another account type's discriminator",
            with(0, &anchor_discriminator("account", "Attestation")),
            LAUNCHPAD_PROGRAM_ID,
            ACCOUNT_DISCRIMINATOR_MISMATCH,
        ),
        (
            "a stored bump that does not derive it",
            with(9, &[bump ^ 1]),
            LAUNCHPAD_PROGRAM_ID,
            CONSTRAINT_SEEDS,
        ),
        (
            "version 2",
            with(8, &[2]),
            LAUNCHPAD_PROGRAM_ID,
            ATTESTATION_MISMATCH,
        ),
        (
            "version 0",
            with(8, &[0]),
            LAUNCHPAD_PROGRAM_ID,
            ATTESTATION_MISMATCH,
        ),
        (
            "another launch stored",
            with(11, other_launch.as_ref()),
            LAUNCHPAD_PROGRAM_ID,
            ATTESTATION_MISMATCH,
        ),
        (
            "another hash stored",
            with(43, &junk.hash()),
            LAUNCHPAD_PROGRAM_ID,
            ATTESTATION_MISMATCH,
        ),
    ];
    for (what, data, owner, error) in variants {
        r.h.place_account(&named, data, &owner);
        send_launch(&mut r, &keeper, &named).expect_error(error, what);
        assert_not_launched(&r, what);
    }
    r.h.set_account(named, true_account);
    send_launch(&mut r, &keeper, &named).expect_ok("the named record");
    let uri = expected_uri(&record, Some(case(&v, "typical, inline uri")));
    assert_launched(&r, &uri);
}

/// `launch` runs only inside the window the identity signed (inclusive) and
/// anyone may run it then: refused without an attestation, a second before
/// `not_before` and a second after `not_after`; at `not_before` a keeper
/// launches, at `not_after` the attestation's throwaway key could too. The
/// creator signs nothing and pays nothing.
#[test]
fn launch_runs_only_inside_the_signed_window_and_anyone_may_pay() {
    let v = load(METADATA_VECTORS);
    let record = Record::of(&case(&v, "typical, external uri")["record"]);
    let uri = expected_uri(&record, Some(case(&v, "typical, external uri")));

    // Opens in two minutes, for the shortest window.
    let h = Harness::with_dbc();
    let opens = h.now() + 120;
    let terms = Terms {
        not_before: opens,
        not_after: opens + MIN_LAUNCH_WINDOW_SECS,
        rules_hash: [0; 32],
    };
    // Before the attestation exists nothing launches.
    let mut r = {
        let mut h = h;
        let creator = h.funded_keypair(10);
        let mint = Keypair::new();
        let k = LaunchKeys::new(&creator.pubkey(), [21; 32], &mint.pubkey());
        let pk = vector_identity().public_key().to_bytes();
        let params = LaunchParams::new(&[(label_key("recipient 0"), 10_000)], identity_id(&pk));
        h.create_launch(&creator, &k, &params);
        publish(&mut h, &k.launch, &record);
        let keeper = h.funded_keypair(10);
        let tx = launch_tx(&h, &keeper, &mint, &k, &k.token_meta(&record.hash()));
        h.submit(tx)
            .expect_error(ACCOUNT_NOT_INITIALIZED, "launch before the attestation");
        // The same launch, attested (a second launch of this creator's seed
        // space would be the same address: reuse the ledger).
        let message = message_for(&h, &k.launch, &record.hash(), &terms);
        let (signature, q) = h.sign_next(vector_identity(), &message);
        let ix = attest_launch_ix(
            &h.payer.pubkey(),
            &k.launch,
            &pk,
            &signature,
            record.meta(),
            &terms,
        );
        attest(&mut h, ix).expect_ok("attest_launch");
        Ready {
            h,
            creator,
            mint,
            token_meta: k.token_meta(&record.hash()),
            k,
            record: record.clone(),
            leaf: q,
            publish_size: 0,
            attest_size: 0,
        }
    };
    let keeper = r.h.funded_keypair(10);
    let creator_before = r.h.lamports(&r.creator.pubkey());
    let token_meta = r.token_meta;
    r.h.set_time(terms.not_before - 1);
    send_launch(&mut r, &keeper, &token_meta).expect_error(NOT_LAUNCH_WINDOW, "a second early");
    assert_not_launched(&r, "a second early");
    r.h.set_time(terms.not_before);
    let tx = launch_tx(&r.h, &keeper, &r.mint, &r.k, &token_meta);
    assert_eq!(
        tx.signatures.len(),
        2,
        "the keeper and the mint sign; the creator does not"
    );
    r.h.submit(tx).expect_ok("at not_before, by a keeper");
    assert_launched(&r, &uri);
    assert_eq!(r.h.lamports(&r.creator.pubkey()), creator_before);

    // The window's last second: launched by the attestation's own throwaway
    // key (anyone). A second later: never.
    for (seed, late, ok) in [(22u8, 0i64, true), (23, 1, false)] {
        let h = Harness::with_dbc();
        let terms = Terms {
            not_before: h.now(),
            not_after: h.now() + MIN_LAUNCH_WINDOW_SECS,
            rules_hash: [0; 32],
        };
        let mut r = ready_in(h, seed, &record, Some(terms));
        let anyone = r.h.funded_keypair(1);
        r.h.set_time(terms.not_after + late);
        let token_meta = r.token_meta;
        let result = send_launch(&mut r, &anyone, &token_meta);
        if ok {
            result.expect_ok("at not_after, by anyone");
            assert_launched(&r, &uri);
        } else {
            result.expect_error(NOT_LAUNCH_WINDOW, "a second late");
            assert_not_launched(&r, "a second late");
        }
    }
}

/// `launch`'s accounts are the documented 23 (`metadata.json`,
/// `launchInstruction`), the metadata record then the rules record last,
/// and its data is its discriminator alone.
#[test]
fn launch_instruction_matches_the_vectors() {
    let v = load(METADATA_VECTORS);
    let li = &v["launchInstruction"];
    let k = LaunchKeys::new(&label_key("creator"), [1; 32], &label_key("mint"));
    let ix = launch_ix(&label_key("payer"), &k, &k.token_meta(&[2; 32]));
    assert_eq!(hex(&ix.data), li["data"].as_str().unwrap());
    let documented: Vec<(String, bool, bool)> = li["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| {
            (
                m["name"].as_str().unwrap().to_string(),
                m["isSigner"].as_bool().unwrap(),
                m["isWritable"].as_bool().unwrap(),
            )
        })
        .collect();
    let ours: Vec<(String, bool, bool)> = LAUNCH_ACCOUNTS
        .iter()
        .map(|(n, s, w)| (n.to_string(), *s, *w))
        .collect();
    assert_eq!(documented, ours);
    assert_eq!(ix.accounts.len(), 23);
    for (meta, (_, signer, writable)) in ix.accounts.iter().zip(LAUNCH_ACCOUNTS) {
        assert_eq!((meta.is_signer, meta.is_writable), (signer, writable));
    }
    assert_eq!(ix.accounts[20].pubkey, k.attestation);
    assert_eq!(ix.accounts[21].pubkey, k.token_meta(&[2; 32]));
    assert_eq!(ix.accounts[22].pubkey, LAUNCHPAD_PROGRAM_ID, "no rules");
    let lms_launch = address(&v["launch"]["address"]);
    assert_eq!(
        address(&li["attestationAccount"]),
        attestation_pda(&lms_launch).0
    );
    let typical = Record::of(&case(&v, "typical: ")["record"]);
    assert_eq!(
        address(&li["tokenMetaAccount"]),
        token_meta_pda(&lms_launch, &typical.hash()).0
    );
}

// ------------------------- audit 3 (F1): an attestation whose window passed

/// A launch under `seed`, created against mainnet DBC with `record`
/// published and nothing attested yet. `leaf`, `record` and `token_meta`
/// name what `launch` is expected to use; [`attests`] updates them.
fn configured(seed: u8, record: &Record) -> Ready {
    let mut h = Harness::with_dbc();
    let creator = h.funded_keypair(10);
    let mint = Keypair::new();
    let k = LaunchKeys::new(&creator.pubkey(), [seed; 32], &mint.pubkey());
    let pk = vector_identity().public_key().to_bytes();
    let params = LaunchParams::new(&[(label_key("recipient 0"), 10_000)], identity_id(&pk));
    h.create_launch(&creator, &k, &params);
    let published = publish(&mut h, &k.launch, record);
    Ready {
        h,
        creator,
        mint,
        token_meta: k.token_meta(&record.hash()),
        k,
        record: record.clone(),
        leaf: u32::MAX,
        publish_size: published.size,
        attest_size: 0,
    }
}

/// The vector identity's signature over `r`'s launch for `record` and
/// `terms`, at the next free leaf, naming the record's address.
fn sign_for(r: &Ready, record: &Record, terms: &Terms) -> (Instruction, u32, Vec<u8>) {
    let hash = record.hash();
    signed_attestation(&r.h, &r.k.launch, &hash, terms, &r.k.token_meta(&hash))
}

/// The next signature for `record` and `terms` attests (see
/// [`assert_attests`]: the whole account is what this signature writes);
/// `launch` is then expected to use it.
fn attests(r: &mut Ready, record: &Record, terms: &Terms) -> Sent {
    let (ix, q, message) = sign_for(r, record, terms);
    let launch = r.k.launch;
    let sent = assert_attests(&mut r.h, &launch, ix, (q, &message, terms), None);
    r.leaf = q;
    r.record = record.clone();
    r.token_meta = r.k.token_meta(&record.hash());
    sent
}

/// The next signature for `record` and `terms` only burns its leaf and
/// leaves the attestation byte for byte as it was (see
/// [`assert_burns_only`]).
fn burns_only(r: &mut Ready, record: &Record, terms: &Terms, what: &str) {
    let (ix, q, _) = sign_for(r, record, terms);
    let launch = r.k.launch;
    assert_burns_only(&mut r.h, &launch, ix, q, what);
}

/// `ix` landed by another fee payer: whoever holds a signature can land it.
fn relay(h: &mut Harness, ix: &Instruction) -> TxResult {
    let relayer = throwaway(h, LAMPORTS_PER_SOL);
    let mut copy = ix.clone();
    copy.accounts[0] = AccountMeta::new(relayer.pubkey(), true);
    send_v1(h, &relayer, copy, attest_tx_config())
}

/// How many leaves the vector identity has burned.
fn leaves_used(h: &Harness) -> u16 {
    let pk = vector_identity().public_key().to_bytes();
    h.identity_leaves(&identity_pda(&identity_id(&pk)).0).1
}

fn window(not_before: i64, not_after: i64) -> Terms {
    Terms {
        not_before,
        not_after,
        rules_hash: [0; 32],
    }
}

/// Audit 3 (F1), the audit's PoC: the attested window [t+10, t+70] passes
/// without `launch` (on a cluster, write-lock contention on the `Launch`
/// PDA, `launch`'s one fixed writable account, can keep every `launch` out
/// of it; here none is sent) and `launch` is refused from then on
/// (`NotLaunchWindow`). The launch used to stay Configured forever, every
/// later signature only burning its leaf. Now the attestation is free, but
/// only an attesting signature takes it: one over a record not published
/// yet, or over a window with 59 seconds left, still only burns its leaf and
/// leaves the old attestation byte for byte. The identity's next attesting
/// signature, over a new record and window, replaces it whole: the account
/// (its address, length and lamports; the payer pays only the fee) is byte
/// for byte what an attestation of that signature writes, and every field
/// of the old one that can differ does. The same signature again is
/// `PqLeafUsed`. The launch then opens in the new window only (a second
/// before it, `NotLaunchWindow`), with the new record only (the old one,
/// `ConstraintSeeds`), and the certificate carries the new leaf and slot.
#[test]
fn a_window_that_passed_unused_is_replaced_and_the_launch_opens_in_the_new_one() {
    let v = load(METADATA_VECTORS);
    let first = Record::of(&case(&v, "typical, external uri")["record"]);
    let second = Record::of(&case(&v, "typical, inline uri")["record"]);
    let mut r = configured(31, &first);
    let launch = r.k.launch;
    let keeper = r.h.funded_keypair(10);
    let t = r.h.now();
    attests(&mut r, &first, &window(t + 10, t + 70));
    let old = r.h.must(&r.k.attestation, "attestation");
    let old_record = r.token_meta;

    // The window passes unused: nobody launches any more.
    r.h.set_time(t + 71);
    send_launch(&mut r, &keeper, &old_record)
        .expect_error(NOT_LAUNCH_WINDOW, "a second after the window");
    assert_not_launched(&r, "a second after the window");

    // Free, but a signature that cannot attest still only burns its leaf.
    let now = r.h.now();
    let terms = window(now + 30, now + 90);
    burns_only(&mut r, &second, &terms, "a record not published yet");
    burns_only(
        &mut r,
        &first,
        &window(now - 1, now + 59),
        "a window with 59 seconds left",
    );
    assert_eq!(
        r.h.must(&r.k.attestation, "attestation"),
        old,
        "the window that passed stands until a signature replaces it"
    );

    // The creator publishes a new record and signs a new window: it
    // replaces the attestation, whole.
    publish(&mut r.h, &launch, &second);
    let (ix, q, message) = sign_for(&r, &second, &terms);
    let payer = r.h.payer.pubkey();
    let before = r.h.lamports(&payer);
    let sent = assert_attests(&mut r.h, &launch, ix.clone(), (q, &message, &terms), None);
    report(
        "attest_launch replacing an attestation whose window passed: size / CU",
        format!("{} B / {}", sent.size, sent.cu),
    );
    assert_eq!(
        r.h.lamports(&payer),
        before - SIGNATURE_FEE,
        "rewritten in place: the payer pays only the fee"
    );
    let new = r.h.must(&r.k.attestation, "attestation");
    assert_eq!(
        (new.owner, new.lamports, new.data.len()),
        (old.owner, old.lamports, old.data.len())
    );
    // Discriminator, version, bump, launch and identity are the launch's,
    // and the signature length is fixed. Everything else is new.
    assert_eq!(new.data[..74], old.data[..74]);
    assert_eq!(new.data[196..200], old.data[196..200]);
    // Neither signs creator rules (the rules hash stays zero).
    assert_eq!(new.data[108..140], [0; 32]);
    assert_eq!(old.data[108..140], [0; 32]);
    for (field, at) in [
        ("leaf", 74..76),
        ("metadata_hash", 76..108),
        ("message_hash", 140..172),
        ("slot", 172..180),
        ("not_before", 180..188),
        ("not_after", 188..196),
        ("signature", 200..ATTESTATION_ACCOUNT_LEN),
    ] {
        assert_ne!(new.data[at.clone()], old.data[at], "{field}");
    }
    r.leaf = q;
    r.record = second.clone();
    r.token_meta = r.k.token_meta(&second.hash());
    relay(&mut r.h, &ix).expect_error(PQ_LEAF_USED, "the replacement again");

    // The new window only, with the new record only.
    let new_record = r.token_meta;
    r.h.set_time(now + 29);
    send_launch(&mut r, &keeper, &new_record)
        .expect_error(NOT_LAUNCH_WINDOW, "a second before the new window");
    assert_not_launched(&r, "a second before the new window");
    r.h.set_time(now + 30);
    send_launch(&mut r, &keeper, &old_record).expect_error(CONSTRAINT_SEEDS, "the old record");
    assert_not_launched(&r, "the old record");
    send_launch(&mut r, &keeper, &new_record).expect_ok("a keeper, as the new window opens");
    let uri = expected_uri(&second, Some(case(&v, "typical, inline uri")));
    assert_launched(&r, &uri);
    assert_eq!(leaves_used(&r.h), 4, "each landed signature burned a leaf");
}

/// Audit 3 (F1), the late-landing variant: whoever holds the creator's
/// signature over [t+10, t+70] lands it with less than a minute of the
/// window left (59 seconds; at `not_after`, with none, in the PoC). That
/// used to record a window `launch` had no time to use, and the launch was
/// dead a second later. Now it only burns its leaf and the attestation
/// stays empty, as for a congested attestation of a window ending as it
/// lands, one with half a minute left, or an hour-long one with 59 seconds
/// left; the creator's rebroadcast of the held bytes is `PqLeafUsed`.
/// Nothing is recorded, so `launch` finds no record. With exactly a minute
/// left the window is recorded, and `launch` runs in its last second.
#[test]
fn an_attestation_landing_with_less_than_a_minute_left_only_burns_its_leaf() {
    let v = load(METADATA_VECTORS);
    let record = Record::of(&case(&v, "typical, external uri")["record"]);
    let mut r = configured(32, &record);
    let launch = r.k.launch;
    let keeper = r.h.funded_keypair(10);
    let t = r.h.now();
    let held_terms = window(t + 10, t + 70);
    let (held, q, _) = sign_for(&r, &record, &held_terms);
    r.h.set_time(t + 11);
    assert_burns_only(&mut r.h, &launch, held.clone(), q, "59 seconds left");
    relay(&mut r.h, &held).expect_error(PQ_LEAF_USED, "the creator's rebroadcast");
    r.h.set_time(t + 70);
    burns_only(&mut r, &record, &held_terms, "at not_after: no time left");
    let now = r.h.now();
    for (terms, what) in [
        (window(now - 60, now), "a window ending as it lands"),
        (
            window(now - 31, now + 29),
            "half of a minute-long window left",
        ),
        (
            window(now - 3_541, now + 59),
            "59 seconds of an hour-long window left",
        ),
    ] {
        burns_only(&mut r, &record, &terms, what);
    }
    let named = r.token_meta;
    send_launch(&mut r, &keeper, &named).expect_error(CONSTRAINT_SEEDS, "nothing attested");
    assert_not_launched(&r, "nothing attested");

    // Exactly a minute left (an hour-long window that opened 59 minutes
    // ago): recorded, and `launch` runs in its last second.
    attests(&mut r, &record, &window(now - 3_540, now + 60));
    r.h.set_time(now + 60);
    send_launch(&mut r, &keeper, &named).expect_ok("the window's last second");
    let uri = expected_uri(&record, Some(case(&v, "typical, external uri")));
    assert_launched(&r, &uri);
    assert_eq!(leaves_used(&r.h), 6, "each landed signature burned a leaf");
}

/// Audit 3 (F1): an attestation whose window has not ended is never
/// replaced: before its window opens, a second before, inside it and in its
/// last second, a new valid signature (each over a window that could be
/// recorded) only burns its leaf and the account stays byte for byte as it
/// was. From the second after its end the next attesting signature replaces
/// it, and the launch opens in the new window.
#[test]
fn an_attestation_whose_window_has_not_ended_is_never_replaced() {
    let v = load(METADATA_VECTORS);
    let record = Record::of(&case(&v, "typical, external uri")["record"]);
    let mut r = configured(33, &record);
    let keeper = r.h.funded_keypair(10);
    let t = r.h.now();
    attests(&mut r, &record, &window(t + 600, t + 660));
    for (at, terms, what) in [
        (t, window(t + 30, t + 90), "before its window opens"),
        (
            t + 599,
            window(t + 599, t + 3_599),
            "a second before it opens",
        ),
        (t + 630, window(t + 630, t + 4_200), "inside its window"),
        (t + 660, window(t + 660, t + 720), "in its last second"),
    ] {
        r.h.set_time(at);
        burns_only(&mut r, &record, &terms, what);
    }
    r.h.set_time(t + 661);
    attests(&mut r, &record, &window(t + 661, t + 721));
    let named = r.token_meta;
    send_launch(&mut r, &keeper, &named).expect_ok("a keeper, in the new window");
    let uri = expected_uri(&record, Some(case(&v, "typical, external uri")));
    assert_launched(&r, &uri);
    assert_eq!(leaves_used(&r.h), 6, "each landed signature burned a leaf");
}

/// Audit 3 (F1): a Live launch's attestation never changes, however long
/// after its window: in its last second, a second after it and a month
/// later, a new valid signature by its identity over the record it launched
/// with only burns its leaf, and the attestation and the certificate
/// (which keeps the attestation `launch` used) stay byte for byte as they
/// were.
#[test]
fn a_live_launch_keeps_its_attestation_forever() {
    let v = load(METADATA_VECTORS);
    let record = Record::of(&case(&v, "typical, external uri")["record"]);
    let mut r = ready_in(Harness::with_dbc(), 34, &record, None);
    let keeper = r.h.funded_keypair(10);
    let named = r.token_meta;
    send_launch(&mut r, &keeper, &named).expect_ok("launch");
    let uri = expected_uri(&record, Some(case(&v, "typical, external uri")));
    assert_launched(&r, &uri);
    let attestation = r.h.must(&r.k.attestation, "attestation");
    let certificate = r.h.must(&r.k.certificate, "certificate");
    let not_after = i64::from_le_bytes(attestation.data[188..196].try_into().unwrap());
    for (at, what) in [
        (not_after, "in its window's last second"),
        (not_after + 1, "a second after its window"),
        (not_after + 30 * 86_400, "a month later"),
    ] {
        r.h.set_time(at);
        let now = r.h.now();
        burns_only(&mut r, &record, &window(now + 10, now + 70), what);
        assert_eq!(
            r.h.must(&r.k.certificate, "certificate"),
            certificate,
            "{what}"
        );
    }
    assert_launched(&r, &uri);
    assert_eq!(leaves_used(&r.h), 4, "each landed signature burned a leaf");
}

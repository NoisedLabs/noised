//! Cross-implementation vectors for the launchpad's on-chain metadata
//! record (`METADATA_PROGRAM.md`): `tests/integration/vectors/metadata.json`.
//!
//! Everything is written from the documented layouts (`common::launchpad`),
//! independently of the launchpad crate; `tests/vectors_onchain.rs` publishes
//! the records on the launchpad build and compares what it writes.
//!
//! * `parameters`: tags, seeds, flags, limits, the uri prefixes, the
//!   `TokenMeta` offsets, the certificate's `metadata` field and check bit,
//!   discriminators and error numbers, and the order in which
//!   `publish_metadata` checks a record;
//! * `icon`: a real 32x32 PNG with a 16-colour palette (4-bit indexed,
//!   colour type 3; zlib with one stored block), built from the documented
//!   pattern: the typical document's icon;
//! * `cases`: records (no document; the typical document with the icon, a
//!   description and each uri mode; the largest document; a 200-byte
//!   external uri; a multi-byte UTF-8 name; the largest record; an inline
//!   uri of a multi-byte UTF-8 document, whose base64 holds `+` and `/` and
//!   ends in `==`), each with
//!   its borsh encoding, `metadataHash = SHA256("PHX-META-V2" ||
//!   borsh(name) || borsh(symbol) || flags || borsh(uri) || borsh(doc))`,
//!   its `["metadata", launch, metadataHash]` address and bump under the
//!   vector launch (the launch of `lms.json`), its account bytes and space,
//!   the uri `launch` gives the mint (`""`, the prefix
//!   `data:application/json;base64,` then base64(doc), or the external uri),
//!   `publish_metadata`'s instruction data and the `MetadataPublished` event
//!   payload;
//! * `invalid`: records `publish_metadata` refuses, with the error;
//! * `pdas`: record addresses for other launches and hashes;
//! * `attestation`: the 221-byte message v3 for the typical record (no
//!   creator rules), signed by the vector identity (`lms.json`) at the leaf
//!   the message probes to, and `attest_launch`'s data and accounts;
//! * `launch`: `launch`'s data (its discriminator: no arguments) and its 23
//!   accounts, the metadata record then the rules record last.
//!
//! An independent implementation checks every value, addresses and bumps
//! included: `python -I scripts/pq/lms_reference.py metadata-vectors
//! tests/integration/vectors/metadata.json`. This test fails if the
//! committed file is missing or differs from what the Rust side produces
//! now; to (re)write it after a deliberate change, run with
//! `NOISED_WRITE_SDK_VECTORS=1`.

// The vector document is one `json!` literal, deeper than the default limit.
#![recursion_limit = "256"]

mod common;

use common::{
    anchor_discriminator,
    launchpad::{
        attest_launch_data, attest_launch_ix, attestation_message, attestation_pda, base64_encode,
        hex, identity_id, identity_pda, launch_pda, leaf_probe_start, metadata_borsh,
        metadata_error, metadata_hash, metadata_is_valid, metadata_published_event,
        publish_metadata_data, publish_metadata_ix, token_meta_account_data, token_meta_pda,
        token_uri, Metadata, Terms, ATTEST_MESSAGE_LEN, ATTEST_MESSAGE_TAG, EXTERNAL_URI_PREFIX,
        INLINE_URI_PREFIX, INVALID_METADATA, INVALID_METADATA_FLAGS, MAX_DOC_LEN,
        MAX_LAUNCH_WINDOW_SECS, MAX_NAME_LEN, MAX_SYMBOL_LEN, MAX_URI_LEN, METADATA_HASH_TAG,
        METADATA_MISMATCH, METADATA_SEED, METADATA_TOO_LONG, META_FLAG_EXTERNAL_URI,
        META_FLAG_INLINE_URI, TOKEN_META_FIXED_LEN, TOKEN_META_VERSION,
    },
    sha256,
    svm::GENESIS_UNIX_TS,
    Keypair, Pubkey, Signer, LAUNCHPAD_PROGRAM_ID, SYSTEM_PROGRAM_ID,
};
use noised_lmots::{lms_verify, LmsPrivateKey, Sha2};
use serde_json::{json, Value};

const VECTOR_FILE: &str = "vectors/metadata.json";
const CLUSTER_LOCALNET: u8 = 2;
/// The typical record's name (18 bytes) and symbol (5 bytes).
const NAME: &str = "Phalanx Cryo Token";
const SYMBOL: &str = "PHXCR";
/// The typical document's description.
const DESCRIPTION: &str = "A fair-launched token on Phalanx. Its name, symbol, description and icon are stored on-chain and signed by its creator's post-quantum key.";
const EXTERNAL_URI: &str = "https://phalanx.example/tokens/PHXCR.json";
/// A description of multi-byte UTF-8 characters: the standard base64 of its
/// document holds both `+` and `/`, and the document (106 bytes) leaves one
/// byte for the last group (`==` padding).
const MULTIBYTE_DESCRIPTION: &str =
    "Multi-byte UTF-8: \u{e9}t\u{e9} \u{bf}\u{ff}? \u{20ac} \u{2603} \u{fffd}\u{e9}";

/// The same derivation as `lms.json` (`tests/lms_vectors.rs`): the vector
/// launch is that file's launch.
fn fixed(label: &str) -> [u8; 32] {
    sha256(&[b"phalanx-lms-vectors/", label.as_bytes()])
}

/// CRC-32 (ISO-HDLC, as PNG uses it), bit by bit.
fn crc32(parts: &[&[u8]]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for byte in parts.iter().flat_map(|p| p.iter()) {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                (crc >> 1) ^ 0xEDB8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

/// Adler-32 (zlib's trailer).
fn adler32(data: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for byte in data {
        a = (a + u32::from(*byte)) % 65_521;
        b = (b + a) % 65_521;
    }
    (b << 16) | a
}

fn chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let len = u32::try_from(data.len()).expect("chunk length");
    [
        &len.to_be_bytes()[..],
        kind,
        data,
        &crc32(&[kind, data]).to_be_bytes(),
    ]
    .concat()
}

/// The icon's palette: 16 opaque colours from a dark to a light blue,
/// `(10 + 15i, 44 + 13i, 90 + 10i)`.
fn palette() -> Vec<u8> {
    (0..16u8)
        .flat_map(|i| [10 + 15 * i, 44 + 13 * i, 90 + 10 * i])
        .collect()
}

/// The icon's pixel `(x, y)`: concentric rings, palette index `15 -
/// min(15, isqrt((2x - 31)^2 + (2y - 31)^2) / 2)`.
fn pixel(x: i64, y: i64) -> u8 {
    let d2 = (2 * x - 31).pow(2) + (2 * y - 31).pow(2);
    let root = (0..=d2).take_while(|r| r * r <= d2).last().expect("isqrt");
    15 - u8::try_from((root / 2).min(15)).expect("ring")
}

/// The 32x32 4-bit indexed PNG: signature, IHDR, PLTE, one IDAT (zlib
/// header 78 01, one stored deflate block of the 544 scanline bytes, each
/// row a filter byte 0 and 16 bytes of two pixels, high nibble first;
/// Adler-32), IEND.
fn icon() -> (Vec<u8>, Vec<u8>) {
    let mut scanlines = Vec::with_capacity(32 * 17);
    for y in 0..32 {
        scanlines.push(0);
        for x in (0..32).step_by(2) {
            scanlines.push((pixel(x, y) << 4) | pixel(x + 1, y));
        }
    }
    assert_eq!(scanlines.len(), 544);
    let len = u16::try_from(scanlines.len()).expect("stored block");
    let zlib = [
        &[0x78, 0x01, 0x01][..],
        &len.to_le_bytes(),
        &(!len).to_le_bytes(),
        &scanlines,
        &adler32(&scanlines).to_be_bytes(),
    ]
    .concat();
    let ihdr = [
        &32u32.to_be_bytes()[..],
        &32u32.to_be_bytes(),
        &[4, 3, 0, 0, 0],
    ]
    .concat();
    let png = [
        &b"\x89PNG\r\n\x1a\n"[..],
        &chunk(b"IHDR", &ihdr),
        &chunk(b"PLTE", &palette()),
        &chunk(b"IDAT", &zlib),
        &chunk(b"IEND", &[]),
    ]
    .concat();
    (png, scanlines)
}

/// A compact JSON document with the SDK's fixed key order. The values hold
/// no character JSON would escape.
fn document(name: &str, symbol: &str, description: &str, image: Option<&str>) -> String {
    for value in [name, symbol, description] {
        assert!(!value.contains(['"', '\\']) && !value.chars().any(char::is_control));
    }
    let image = image.map_or(String::new(), |i| format!(r#","image":"{i}""#));
    format!(r#"{{"name":"{name}","symbol":"{symbol}","description":"{description}"{image}}}"#)
}

/// A record as JSON: the strings, their bytes in hex, the flags.
fn record_json(m: Metadata) -> Value {
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
        "nameChars": text(m.name).as_str().map(|s| s.chars().count()),
    })
}

fn case_json(name: &str, launch: &Pubkey, m: Metadata) -> Value {
    assert!(metadata_is_valid(m), "{name}");
    let hash = metadata_hash(m);
    let (address, bump) = token_meta_pda(launch, &hash);
    let data = token_meta_account_data(bump, launch, m);
    let uri = token_uri(m);
    let uri_text = String::from_utf8(uri.clone()).expect("an ASCII uri");
    json!({
        "name": name,
        "record": record_json(m),
        "borsh": hex(&metadata_borsh(m)),
        "metadataHash": hex(&hash),
        "tokenMeta": {
            "address": address.to_string(),
            "bump": bump,
            "space": data.len(),
            "data": hex(&data),
        },
        "tokenUri": uri_text,
        "tokenUriLen": uri.len(),
        "publishData": hex(&publish_metadata_data(m)),
        "metadataPublishedEvent": hex(&metadata_published_event(launch, m)),
    })
}

#[test]
fn icon_is_a_32x32_png_with_16_colours() {
    let (png, scanlines) = icon();
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    assert_eq!(png.len(), 8 + 25 + 60 + 567 + 12);
    assert_eq!(&png[12..16], b"IHDR");
    assert_eq!(&png[16..29], &[0, 0, 0, 32, 0, 0, 0, 32, 4, 3, 0, 0, 0]);
    // The CRC is PNG's: the IEND chunk's is the well-known AE 42 60 82.
    assert_eq!(&png[png.len() - 4..], &[0xAE, 0x42, 0x60, 0x82]);
    assert_eq!(crc32(&[b"123456789"]), 0xCBF4_3926);
    assert_eq!(adler32(b"Wikipedia"), 0x11E6_0398);
    // Every palette index is used; the corners are the background.
    let mut used = [false; 16];
    for y in 0..32 {
        for x in 0..32 {
            used[usize::from(pixel(x, y))] = true;
        }
    }
    assert!(used.iter().all(|u| *u));
    assert_eq!((pixel(0, 0), pixel(15, 15), pixel(16, 16)), (0, 15, 15));
    assert_eq!(scanlines[0], 0);
}

#[test]
fn base64_and_crc_helpers_match_known_answers() {
    for (input, output) in [
        ("", ""),
        ("f", "Zg=="),
        ("fo", "Zm8="),
        ("foo", "Zm9v"),
        ("foob", "Zm9vYg=="),
        ("fooba", "Zm9vYmE="),
        ("foobar", "Zm9vYmFy"),
    ] {
        assert_eq!(base64_encode(input.as_bytes()), output);
    }
    assert_eq!(base64_encode(&[0xFB, 0xFF]), "+/8=");
}

#[test]
fn metadata_vectors_match_the_committed_file() {
    let creator = Pubkey::new_from_array(fixed("creator"));
    let launch_seed = fixed("launch-seed");
    let (launch, _) = launch_pda(&creator, &launch_seed);
    let params_hash = fixed("params-hash");

    let (png, scanlines) = icon();
    let image = format!("data:image/png;base64,{}", base64_encode(&png));
    let typical = document(NAME, SYMBOL, DESCRIPTION, Some(&image));
    // The largest document of a record: its name and symbol, a description
    // padded to 3,072 bytes in all.
    let largest_doc = |name: &str, symbol: &str| {
        let bare = document(name, symbol, "", None);
        let doc = document(name, symbol, &"x".repeat(MAX_DOC_LEN - bare.len()), None);
        assert_eq!(doc.len(), MAX_DOC_LEN);
        doc
    };
    let largest = largest_doc(NAME, SYMBOL);
    let uri_200 = format!("{EXTERNAL_URI_PREFIX}{}", "u".repeat(MAX_URI_LEN - 8));
    assert_eq!(uri_200.len(), MAX_URI_LEN);
    let euro_name = "\u{20ac}".repeat(10) + "NN";
    assert_eq!(euro_name.len(), 32);
    let largest_name = "N".repeat(MAX_NAME_LEN);
    let largest_symbol = "S".repeat(MAX_SYMBOL_LEN);
    let largest_record_doc = largest_doc(&largest_name, &largest_symbol);
    let multibyte = document(NAME, SYMBOL, MULTIBYTE_DESCRIPTION, None);
    assert_eq!(multibyte.len() % 3, 1, "one byte in the last base64 group");

    let typical_record = Metadata::new(NAME, SYMBOL, 0, "", &typical);
    let cases = [
        (
            "no document and no uri (the mint's uri is empty)",
            Metadata::new(NAME, SYMBOL, 0, "", ""),
        ),
        (
            "typical: a description and a 32x32 16-colour PNG icon, no uri",
            typical_record,
        ),
        (
            "typical, inline uri",
            Metadata::new(NAME, SYMBOL, META_FLAG_INLINE_URI, "", &typical),
        ),
        (
            "typical, external uri",
            Metadata::new(NAME, SYMBOL, META_FLAG_EXTERNAL_URI, EXTERNAL_URI, &typical),
        ),
        (
            "an external uri of 200 bytes and no document",
            Metadata::new(NAME, SYMBOL, META_FLAG_EXTERNAL_URI, &uri_200, ""),
        ),
        (
            "the largest document (3,072 bytes), inline uri (4,125 bytes)",
            Metadata::new(NAME, SYMBOL, META_FLAG_INLINE_URI, "", &largest),
        ),
        (
            "a UTF-8 name of 12 characters and 32 bytes, and a 5-byte symbol",
            Metadata::new(&euro_name, "\u{20ac}UR", 0, "", ""),
        ),
        (
            "the largest record: name 32, symbol 10, external uri 200, document 3,072 bytes",
            Metadata::new(
                &largest_name,
                &largest_symbol,
                META_FLAG_EXTERNAL_URI,
                &uri_200,
                &largest_record_doc,
            ),
        ),
        (
            "an inline uri of a multi-byte UTF-8 document (base64 with + and /, padded with ==)",
            Metadata::new(NAME, SYMBOL, META_FLAG_INLINE_URI, "", &multibyte),
        ),
    ];
    let case_values: Vec<Value> = cases
        .iter()
        .map(|(name, m)| case_json(name, &launch, *m))
        .collect();
    assert_eq!(
        token_uri(cases[5].1).len(),
        INLINE_URI_PREFIX.len() + 4 * MAX_DOC_LEN.div_ceil(3)
    );
    assert_eq!(token_meta_account_data(0, &launch, cases[7].1).len(), 3_405);
    let multibyte_uri = String::from_utf8(token_uri(cases[8].1)).expect("ASCII");
    assert!(multibyte_uri.contains('+') && multibyte_uri[INLINE_URI_PREFIX.len()..].contains('/'));
    assert!(multibyte_uri.ends_with("=="));

    // Records `publish_metadata` refuses, with the error, in its order.
    let long_doc = "d".repeat(MAX_DOC_LEN + 1);
    let long_uri = format!("{uri_200}u");
    let long_name = "\u{20ac}".repeat(11);
    let invalid = [
        (
            "both uri modes",
            Metadata::new(NAME, SYMBOL, 3, EXTERNAL_URI, &typical),
        ),
        (
            "both uri modes, no uri",
            Metadata::new(NAME, SYMBOL, 3, "", &typical),
        ),
        (
            "an unknown flag (bit 2)",
            Metadata::new(NAME, SYMBOL, 4, "", ""),
        ),
        (
            "an unknown flag (bit 7) with an inline uri",
            Metadata::new(NAME, SYMBOL, 0x81, "", &typical),
        ),
        (
            "a document of 3,073 bytes",
            Metadata::new(NAME, SYMBOL, 0, "", &long_doc),
        ),
        (
            "an external uri of 201 bytes",
            Metadata::new(NAME, SYMBOL, META_FLAG_EXTERNAL_URI, &long_uri, ""),
        ),
        ("an empty name", Metadata::new("", SYMBOL, 0, "", "")),
        (
            "a name of 11 characters and 33 bytes",
            Metadata::new(&long_name, SYMBOL, 0, "", ""),
        ),
        ("an empty symbol", Metadata::new(NAME, "", 0, "", "")),
        (
            "a symbol of 11 bytes",
            Metadata::new(NAME, "SSSSSSSSSSS", 0, "", ""),
        ),
        (
            "an http uri",
            Metadata::new(
                NAME,
                SYMBOL,
                META_FLAG_EXTERNAL_URI,
                "http://phalanx.example/t.json",
                "",
            ),
        ),
        (
            "an upper-case scheme",
            Metadata::new(
                NAME,
                SYMBOL,
                META_FLAG_EXTERNAL_URI,
                "HTTPS://phalanx.example/t.json",
                "",
            ),
        ),
        (
            "a uri with a space",
            Metadata::new(
                NAME,
                SYMBOL,
                META_FLAG_EXTERNAL_URI,
                "https://phalanx.example/a b.json",
                "",
            ),
        ),
        (
            "a uri with a non-ASCII character",
            Metadata::new(
                NAME,
                SYMBOL,
                META_FLAG_EXTERNAL_URI,
                "https://phal\u{e1}nx.example/t.json",
                "",
            ),
        ),
        (
            "nothing after https://",
            Metadata::new(NAME, SYMBOL, META_FLAG_EXTERNAL_URI, "https://", ""),
        ),
        (
            "an external-uri flag without a uri",
            Metadata::new(NAME, SYMBOL, META_FLAG_EXTERNAL_URI, "", &typical),
        ),
        (
            "a uri without the external-uri flag",
            Metadata::new(NAME, SYMBOL, 0, EXTERNAL_URI, ""),
        ),
        (
            "a uri with the inline-uri flag",
            Metadata::new(NAME, SYMBOL, META_FLAG_INLINE_URI, EXTERNAL_URI, &typical),
        ),
        (
            "an inline uri without a document",
            Metadata::new(NAME, SYMBOL, META_FLAG_INLINE_URI, "", ""),
        ),
    ];
    let invalid_values: Vec<Value> = invalid
        .iter()
        .map(|(name, m)| {
            let error = metadata_error(*m).unwrap_or_else(|| panic!("{name}: accepted"));
            json!({
                "name": name,
                "record": record_json(*m),
                "error": error.name,
                "errorNumber": error.number,
                "publishData": hex(&publish_metadata_data(*m)),
            })
        })
        .collect();
    let errors_used: std::collections::BTreeSet<&str> = invalid
        .iter()
        .map(|(_, m)| metadata_error(*m).unwrap().name)
        .collect();
    assert_eq!(errors_used.len(), 3, "every refusal error is covered");

    // Record addresses for other launches and hashes.
    let typical_hash = metadata_hash(typical_record);
    let other_creator = Pubkey::new_from_array(fixed("other-creator"));
    let pdas: Vec<Value> = [
        (
            "the vector launch, the typical record",
            launch,
            typical_hash,
        ),
        ("the vector launch, an all-zero hash", launch, [0u8; 32]),
        (
            "another seed of the vector creator, the typical record",
            launch_pda(&creator, &fixed("another-seed")).0,
            typical_hash,
        ),
        (
            "another creator under the vector seed, the typical record",
            launch_pda(&other_creator, &launch_seed).0,
            typical_hash,
        ),
    ]
    .iter()
    .map(|(name, l, h)| {
        let (address, bump) = token_meta_pda(l, h);
        json!({
            "name": name,
            "launch": l.to_string(),
            "launchBytes": hex(l.as_ref()),
            "metadataHash": hex(h),
            "address": address.to_string(),
            "bump": bump,
        })
    })
    .collect();

    // The typical record's attestation by the vector identity.
    let master: [u8; 64] = std::array::from_fn(|i| i as u8);
    let kp = LmsPrivateKey::derive_identity::<Sha2>(&master, CLUSTER_LOCALNET, 0)
        .expect("identity derivation")
        .keygen::<Sha2>();
    let pk = kp.public_key().to_bytes();
    let terms = Terms {
        not_before: GENESIS_UNIX_TS,
        not_after: GENESIS_UNIX_TS + MAX_LAUNCH_WINDOW_SECS,
        rules_hash: [0; 32],
    };
    let message = attestation_message(&launch, &params_hash, &creator, &typical_hash, &terms);
    assert_eq!(message.len(), ATTEST_MESSAGE_LEN);
    let q = leaf_probe_start(&pk[8..24], &message);
    let signature = kp.sign_deterministic::<Sha2>(q, &message).expect("sign");
    assert_eq!(lms_verify::<Sha2>(&pk, &message, &signature), Some(q));
    // The throwaway fee payer of `lms.json` (any key pays).
    let payer_seed = fixed("throwaway-payer");
    let payer = Keypair::new_from_array(payer_seed).pubkey();
    let attest = attest_launch_ix(&payer, &launch, &pk, &signature, typical_record, &terms);
    assert_eq!(
        attest.data,
        attest_launch_data(&pk, &signature, &typical_hash, &terms)
    );
    let (typical_address, _) = token_meta_pda(&launch, &typical_hash);
    let publish = publish_metadata_ix(&payer, &launch, typical_record);
    assert_eq!(publish.accounts[2].pubkey, typical_address);

    let launch_accounts: Vec<Value> = [
        ("payer", true, true),
        ("launch", false, true),
        ("launch_authority", false, false),
        ("dbc_config", false, false),
        ("base_mint", true, true),
        ("pool", false, true),
        ("base_vault", false, true),
        ("quote_vault", false, true),
        ("quote_mint", false, false),
        ("dbc_pool_authority", false, false),
        ("hook_authority", false, false),
        ("extra_account_meta_list", false, true),
        ("policy", false, true),
        ("certificate", false, true),
        ("hook_program", false, false),
        ("dbc_program", false, false),
        ("dbc_event_authority", false, false),
        ("token_2022_program", false, false),
        ("token_program", false, false),
        ("system_program", false, false),
        ("attestation", false, false),
        ("token_meta", false, false),
        ("rules", false, false),
    ]
    .iter()
    .map(|(name, signer, writable)| json!({"name": name, "isSigner": signer, "isWritable": writable}))
    .collect();
    let metas = |ix: &common::Instruction| -> Vec<Value> {
        ix.accounts
            .iter()
            .map(|m| json!({"pubkey": m.pubkey.to_string(), "isSigner": m.is_signer, "isWritable": m.is_writable}))
            .collect()
    };
    let discriminators: serde_json::Map<String, Value> = [
        (
            "publishMetadata",
            anchor_discriminator("global", "publish_metadata"),
        ),
        (
            "attestLaunch",
            anchor_discriminator("global", "attest_launch"),
        ),
        ("launch", anchor_discriminator("global", "launch")),
        ("tokenMeta", anchor_discriminator("account", "TokenMeta")),
        (
            "metadataPublished",
            anchor_discriminator("event", "MetadataPublished"),
        ),
        (
            "certificate",
            anchor_discriminator("account", "Certificate"),
        ),
    ]
    .iter()
    .map(|(name, d)| (name.to_string(), json!(hex(d))))
    .collect();
    let errors: Vec<Value> = [
        INVALID_METADATA,
        INVALID_METADATA_FLAGS,
        METADATA_TOO_LONG,
        METADATA_MISMATCH,
    ]
    .iter()
    .map(|e| json!({"name": e.name, "number": e.number}))
    .collect();

    let vectors = json!({
        "source": "tests/integration/tests/metadata_vectors.rs (METADATA_PROGRAM.md on METADATA_ONCHAIN.md §4: the TokenMeta record, publish_metadata, attestation message v3, launch without arguments); published on the launchpad build by tests/integration/tests/vectors_onchain.rs; independent check: python -I scripts/pq/lms_reference.py metadata-vectors tests/integration/vectors/metadata.json",
        "parameters": {
            "launchpad": LAUNCHPAD_PROGRAM_ID.to_string(),
            "metadataHashTag": std::str::from_utf8(METADATA_HASH_TAG).unwrap(),
            "metadataHashLayout": "SHA256(metadataHashTag || u32le(len) name || u32le(len) symbol || u8 flags || u32le(len) uri || u32le(len) doc)",
            "tokenMetaSeeds": ["metadata", "launch", "metadataHash"],
            "metadataSeed": std::str::from_utf8(METADATA_SEED).unwrap(),
            "attestMessageTag": std::str::from_utf8(ATTEST_MESSAGE_TAG).unwrap(),
            "attestMessageLen": ATTEST_MESSAGE_LEN,
            "flags": {"none": 0, "inlineUri": META_FLAG_INLINE_URI, "externalUri": META_FLAG_EXTERNAL_URI},
            "maxNameLen": MAX_NAME_LEN,
            "maxSymbolLen": MAX_SYMBOL_LEN,
            "maxUriLen": MAX_URI_LEN,
            "maxDocLen": MAX_DOC_LEN,
            "lengthUnit": "UTF-8 bytes",
            "externalUriPrefix": EXTERNAL_URI_PREFIX,
            "externalUriBytes": "every byte 0x21..=0x7E (printable ASCII)",
            "inlineUriPrefix": INLINE_URI_PREFIX,
            "maxInlineUriLen": INLINE_URI_PREFIX.len() + 4 * MAX_DOC_LEN.div_ceil(3),
            "tokenUri": "flags 0: \"\"; inlineUri: inlineUriPrefix || base64(doc) (RFC 4648, padded); externalUri: uri",
            "validation": [
                "InvalidMetadataFlags: a bit other than inlineUri and externalUri, or both",
                "MetadataTooLong: doc over maxDocLen or uri over maxUriLen bytes",
                "InvalidMetadata: name not 1..=maxNameLen or symbol not 1..=maxSymbolLen bytes; with externalUri, a uri that is not externalUriPrefix plus at least one byte, every byte printable ASCII",
                "InvalidMetadataFlags: a uri without externalUri; inlineUri without a doc",
            ],
            "tokenMetaVersion": TOKEN_META_VERSION,
            "tokenMetaFixedLen": TOKEN_META_FIXED_LEN,
            "tokenMetaOffsets": {"version": 8, "bump": 9, "flags": 10, "launch": 11, "metadataHash": 43, "name": 75},
            "certificate": {"version": 4, "accountLen": 519, "metadataOffset": 455, "rulesHashOffset": 487, "metadataOnchainCheck": 2048, "allChecks": 4095, "rulesBoundCheck": 4096, "safetyPolicyVersion": 3},
            "discriminators": discriminators,
            "errors": errors,
        },
        "icon": {
            "width": 32,
            "height": 32,
            "bitDepth": 4,
            "colourType": 3,
            "palette": hex(&palette()),
            "paletteRule": "entry i (0..16) = (10 + 15i, 44 + 13i, 90 + 10i)",
            "pixelRule": "index(x, y) = 15 - min(15, isqrt((2x - 31)^2 + (2y - 31)^2) / 2)",
            "idat": "zlib 78 01, one stored deflate block of the 544 scanline bytes (filter 0, two pixels per byte, high nibble first), Adler-32",
            "scanlinesSha256": hex(&sha256(&[&scanlines])),
            "png": hex(&png),
            "pngLen": png.len(),
            "pngSha256": hex(&sha256(&[&png])),
            "dataUri": image,
        },
        "launch": {
            "creator": creator.to_string(),
            "launchSeed": hex(&launch_seed),
            "address": launch.to_string(),
            "launchBytes": hex(launch.as_ref()),
        },
        "cases": case_values,
        "invalid": invalid_values,
        "pdas": pdas,
        "publishTypical": {
            "payerSeed": hex(&payer_seed),
            "payer": payer.to_string(),
            "accounts": metas(&publish),
            "data": hex(&publish.data),
        },
        "attestation": {
            "record": "typical: a description and a 32x32 16-colour PNG icon, no uri",
            "launch": launch.to_string(),
            "paramsHash": hex(&params_hash),
            "creatorBytes": hex(creator.as_ref()),
            "metadataHash": hex(&typical_hash),
            "rulesHash": hex(&terms.rules_hash),
            "notBefore": terms.not_before,
            "notAfter": terms.not_after,
            "message": hex(&message),
            "messageHash": hex(&sha256(&[&message])),
            "publicKey": hex(&pk),
            "identityAccount": identity_pda(&identity_id(&pk)).0.to_string(),
            "attestationAccount": attestation_pda(&launch).0.to_string(),
            "tokenMetaAccount": typical_address.to_string(),
            "q": q,
            "signature": hex(&signature),
            "payer": payer.to_string(),
            "accounts": metas(&attest),
            "data": hex(&attest.data),
        },
        "launchInstruction": {
            "data": hex(&anchor_discriminator("global", "launch")),
            "accounts": launch_accounts,
            "attestationAccount": attestation_pda(&launch).0.to_string(),
            "tokenMetaAccount": typical_address.to_string(),
            "rulesAccount": "the LaunchRules the attestation's rulesHash names, or the program id (no rules)",
        },
    });
    assert_eq!(SYSTEM_PROGRAM_ID, publish.accounts[3].pubkey);
    let text = serde_json::to_string_pretty(&vectors).expect("json") + "\n";
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(VECTOR_FILE);
    if std::env::var_os("NOISED_WRITE_SDK_VECTORS")
        .or_else(|| std::env::var_os("PHALANX_WRITE_SDK_VECTORS"))
        .is_some()
    {
        std::fs::create_dir_all(path.parent().expect("vector dir")).expect("create vector dir");
        std::fs::write(&path, &text).expect("write metadata vector file");
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
        "metadata vectors are stale; rerun with NOISED_WRITE_SDK_VECTORS=1"
    );
}

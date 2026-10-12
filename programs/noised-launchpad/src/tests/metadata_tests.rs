//! The on-chain metadata record: the rules `publish_metadata` enforces and
//! their errors, the uri `launch` derives (and its base64 encoder), the
//! `TokenMeta` layout and the recognition `attest_launch` relies on.

use anchor_lang::{prelude::*, AccountSerialize, Discriminator, InstructionData};

use super::{key, Lcg};
use crate::{
    base64::{encode_into, encoded_len},
    constants::{
        EXTERNAL_URI_PREFIX, INLINE_URI_PREFIX, MAX_DOC_LEN, MAX_INLINE_URI_LEN, MAX_NAME_LEN,
        MAX_SYMBOL_LEN, MAX_URI_LEN, METADATA_SEED, META_FLAG_EXTERNAL_URI, META_FLAG_INLINE_URI,
    },
    dbc_params::initialize_pool_data,
    dynamic_bonding_curve::{
        client::args::InitializeVirtualPoolWithToken2022TransferHook,
        types::InitializePoolParameters,
    },
    error::LaunchpadError,
    policy::{
        external_uri_is_valid, flags_are_valid, metadata_is_valid, token_uri, token_uri_len,
        validate_metadata,
    },
    pq::{is_metadata_record, metadata_hash_v2, metadata_record_address},
    state::{Certificate, TokenMeta},
};

fn base64(input: &[u8]) -> String {
    let mut out = Vec::new();
    encode_into(input, &mut out);
    String::from_utf8(out).unwrap()
}

/// An independent decoder (strict: the standard alphabet, padding only at
/// the end of the last group, no stray bits), for the round trips.
fn decode(text: &str) -> Option<Vec<u8>> {
    let value = |c: u8| match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    };
    let bytes = text.as_bytes();
    if !bytes.len().is_multiple_of(4) {
        return None;
    }
    let mut out = Vec::new();
    for (i, group) in bytes.chunks(4).enumerate() {
        let last = i + 1 == bytes.len() / 4;
        let pad = group.iter().rev().take_while(|&&c| c == b'=').count();
        if pad > 2 || (pad > 0 && !last) {
            return None;
        }
        let mut bits = 0u32;
        for &c in &group[..4 - pad] {
            bits = (bits << 6) | u32::from(value(c)?);
        }
        bits <<= 6 * pad;
        let decoded = [(bits >> 16) as u8, (bits >> 8) as u8, bits as u8];
        // Padding must not hide set bits.
        if decoded[3 - pad..].iter().any(|&b| b != 0) {
            return None;
        }
        out.extend_from_slice(&decoded[..3 - pad]);
    }
    Some(out)
}

/// RFC 4648 §10's test vectors, and groups that use `+` and `/`.
#[test]
fn base64_matches_rfc_4648_test_vectors() {
    for (input, output) in [
        ("", ""),
        ("f", "Zg=="),
        ("fo", "Zm8="),
        ("foo", "Zm9v"),
        ("foob", "Zm9vYg=="),
        ("fooba", "Zm9vYmE="),
        ("foobar", "Zm9vYmFy"),
    ] {
        assert_eq!(base64(input.as_bytes()), output, "{input:?}");
        assert_eq!(encoded_len(input.len()), output.len());
    }
    assert_eq!(base64(&[0xFB, 0xEF, 0xBE]), "++++");
    assert_eq!(base64(&[0xFF, 0xFF, 0xFF]), "////");
    assert_eq!(base64(&[0xFB, 0xFF]), "+/8=");
    assert_eq!(base64(&[0x00]), "AA==");
    assert_eq!(base64(&[0x00, 0x00, 0x00]), "AAAA");
    assert_eq!(base64(br#"{"name":"a"}"#), "eyJuYW1lIjoiYSJ9");
    // Appends to what the buffer holds.
    let mut out = b"data:".to_vec();
    encode_into(b"foo", &mut out);
    assert_eq!(out, b"data:Zm9v");
    assert_eq!(encoded_len(MAX_DOC_LEN), 4_096);
}

/// Pseudo-random inputs of every length up to past `MAX_DOC_LEN` round-trip
/// through the independent decoder, at exactly `encoded_len` characters of
/// the standard alphabet with padding only at the end; every byte value in
/// every position of a group reaches the output.
#[test]
fn base64_round_trips() {
    let mut r = Lcg(0xB64);
    let mut lengths: Vec<usize> = (0..=64)
        .chain([1_000, 1_023, 1_024, 3_070, 3_071, MAX_DOC_LEN, 3_073])
        .collect();
    lengths.extend((0..200).map(|_| r.below(3_100) as usize));
    for len in lengths {
        let input: Vec<u8> = (0..len).map(|_| r.next() as u8).collect();
        let text = base64(&input);
        assert_eq!(text.len(), encoded_len(len), "length {len}");
        let body = text.trim_end_matches('=');
        assert!(text.len() - body.len() <= 2);
        assert!(body
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'+' || c == b'/'));
        assert_eq!(decode(&text).as_deref(), Some(&input[..]), "length {len}");
    }
    for byte in 0..=255u8 {
        for at in 0..3 {
            let mut group = [0u8; 3];
            group[at] = byte;
            assert_eq!(decode(&base64(&group)).unwrap(), group);
            for len in 1..=3 {
                assert_eq!(decode(&base64(&group[..len])).unwrap(), &group[..len]);
            }
        }
    }
    // The decoder itself is strict.
    for bad in ["Zg=", "Z===", "Zg==Zg==", "Zh==", "Zm9v!A==", "Zm8==="] {
        assert_eq!(decode(bad), None, "{bad}");
    }
}

/// What `launch` writes into the mint's uri for each mode.
#[test]
fn token_uri_follows_the_signed_mode() {
    let doc = r#"{"name":"a"}"#;
    assert_eq!(token_uri(0, "", doc), "");
    assert_eq!(token_uri(0, "", ""), "");
    assert_eq!(
        token_uri(META_FLAG_INLINE_URI, "", doc),
        "data:application/json;base64,eyJuYW1lIjoiYSJ9"
    );
    assert_eq!(
        token_uri(META_FLAG_EXTERNAL_URI, "https://x.example/a.json", doc),
        "https://x.example/a.json"
    );
    assert_eq!(INLINE_URI_PREFIX, "data:application/json;base64,");
    assert_eq!(INLINE_URI_PREFIX.len(), 29);
    // The longest derived uri: 29 + 4 * 1,024 bytes.
    let max = token_uri(META_FLAG_INLINE_URI, "", &"x".repeat(MAX_DOC_LEN));
    assert_eq!((max.len(), MAX_INLINE_URI_LEN), (4_125, 4_125));
    let mut r = Lcg(7);
    for _ in 0..50 {
        let len = 1 + r.below(MAX_DOC_LEN as u64) as usize;
        let doc: String = (0..len)
            .map(|_| char::from(b' ' + r.below(95) as u8))
            .collect();
        let uri = token_uri(META_FLAG_INLINE_URI, "", &doc);
        assert_eq!(uri.len(), 29 + 4 * len.div_ceil(3));
        let payload = uri.strip_prefix(INLINE_URI_PREFIX).unwrap();
        assert_eq!(decode(payload).unwrap(), doc.as_bytes());
    }
}

/// `launch` writes the derived uri straight into DBC's instruction data:
/// that data is Anchor's encoding of the typed arguments
/// (`InitializePoolParameters { name, symbol, uri: token_uri(..) }`), and
/// the uri sits at the offset `launch` compares the mint's uri from, in
/// every mode and at the largest sizes.
#[test]
fn dbc_pool_data_carries_the_derived_uri() {
    let url = format!("https://{}", "u".repeat(MAX_URI_LEN - 8));
    let euros = "\u{20ac}".repeat(10) + "NN";
    let large = "d".repeat(MAX_DOC_LEN);
    for (name, symbol, flags, uri, doc) in [
        ("N", "S", 0u8, "", ""),
        ("Noised", "PHX", 0, "", "{}"),
        ("Noised", "PHX", META_FLAG_INLINE_URI, "", "{}"),
        ("Noised", "PHX", META_FLAG_INLINE_URI, "", "{ }"),
        (
            euros.as_str(),
            "SSSSSSSSSS",
            META_FLAG_INLINE_URI,
            "",
            large.as_str(),
        ),
        ("Noised", "PHX", META_FLAG_EXTERNAL_URI, url.as_str(), ""),
        (
            euros.as_str(),
            "S",
            META_FLAG_EXTERNAL_URI,
            url.as_str(),
            large.as_str(),
        ),
    ] {
        let (data, uri_at) = initialize_pool_data(name, symbol, flags, uri, doc);
        let derived = token_uri(flags, uri, doc);
        let typed = InitializeVirtualPoolWithToken2022TransferHook {
            params: InitializePoolParameters {
                name: name.into(),
                symbol: symbol.into(),
                uri: derived.clone(),
            },
        }
        .data();
        assert_eq!(data, typed, "flags {flags}");
        assert_eq!(&data[uri_at..], derived.as_bytes());
        assert_eq!(derived.len(), token_uri_len(flags, uri, doc));
        assert_eq!(data.capacity(), data.len(), "allocated once");
    }
    assert_eq!(
        initialize_pool_data("N", "S", META_FLAG_INLINE_URI, "", &large)
            .0
            .len(),
        8 + 4 + 1 + 4 + 1 + 4 + MAX_INLINE_URI_LEN
    );
}

/// Name and symbol bounds are UTF-8 bytes, not characters (a JavaScript
/// `length` counts UTF-16 units).
#[test]
fn metadata_limits_are_utf8_bytes() {
    assert_eq!((MAX_NAME_LEN, MAX_SYMBOL_LEN), (32, 10));
    assert!(metadata_is_valid("N", "S"));
    assert!(metadata_is_valid(&"N".repeat(32), &"S".repeat(10)));
    assert!(!metadata_is_valid(&"N".repeat(33), "S"), "33-byte name");
    assert!(!metadata_is_valid("N", &"S".repeat(11)), "11-byte symbol");
    assert!(!metadata_is_valid("", "S"), "empty name");
    assert!(!metadata_is_valid("N", ""), "empty symbol");
    let euros = "\u{20ac}".repeat(11);
    assert_eq!((euros.chars().count(), euros.len()), (11, 33));
    assert!(!metadata_is_valid(&euros, "S"));
    let symbol = "\u{20ac}".repeat(4);
    assert_eq!((symbol.chars().count(), symbol.len()), (4, 12));
    assert!(!metadata_is_valid("N", &symbol));
    let name = "\u{20ac}".repeat(10) + "NN";
    assert_eq!(name.len(), 32);
    assert!(metadata_is_valid(&name, "S"));
    assert!(metadata_is_valid("N", "\u{1f680}"), "an emoji: 4 bytes");
}

/// An external uri: `https://` and at least one more byte, at most 200
/// bytes, every byte in 0x21..=0x7E.
#[test]
fn external_uri_rules() {
    assert_eq!((EXTERNAL_URI_PREFIX, MAX_URI_LEN), ("https://", 200));
    assert!(external_uri_is_valid("https://a"));
    let max = format!("https://{}", "u".repeat(192));
    assert_eq!(max.len(), 200);
    assert!(external_uri_is_valid(&max));
    assert!(!external_uri_is_valid(&format!("{max}u")), "201 bytes");
    assert!(
        !external_uri_is_valid("https://"),
        "nothing after the scheme"
    );
    assert!(!external_uri_is_valid(""));
    for bad in [
        "http://a.example/x.json",
        "HTTPS://a.example/x.json",
        "ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy",
        "data:application/json;base64,e30=",
        " https://a.example",
        "https://a.example/x y.json",
        "https://a.example/\u{7f}",
        "https://a.example/\t",
        "https://a.example/\n",
        "https://a.example/\u{e9}",
        "https://\u{430}.example",
    ] {
        assert!(!external_uri_is_valid(bad), "{bad:?}");
    }
    // Every printable ASCII byte is accepted after the scheme, and nothing
    // else.
    for byte in 0..=127u8 {
        let uri = format!("https://a{}", char::from(byte));
        assert_eq!(
            external_uri_is_valid(&uri),
            (0x21..=0x7E).contains(&byte),
            "byte {byte:#04x}"
        );
    }
}

/// Every rule of a record and the error it fails with, in the documented
/// order (flags, lengths, name and symbol, then the uri and document against
/// the mode).
#[test]
fn metadata_rules_and_their_errors() {
    use LaunchpadError as E;
    let url = "https://noised.example/token.json";
    let doc = r#"{"name":"N","symbol":"S"}"#;
    let long_doc = "d".repeat(MAX_DOC_LEN + 1);
    let max_doc = "d".repeat(MAX_DOC_LEN);
    let long_uri = format!("https://{}", "u".repeat(193));
    // (what, name, symbol, flags, uri, doc, the error if refused)
    type Case<'a> = (&'a str, &'a str, &'a str, u8, &'a str, &'a str, Option<E>);
    let cases: [Case; 22] = [
        ("no uri, no document", "N", "S", 0, "", "", None),
        ("no uri, a document", "N", "S", 0, "", doc, None),
        (
            "no uri, the largest document",
            "N",
            "S",
            0,
            "",
            &max_doc,
            None,
        ),
        ("inline uri", "N", "S", 1, "", doc, None),
        (
            "inline uri, the largest document",
            "N",
            "S",
            1,
            "",
            &max_doc,
            None,
        ),
        ("external uri", "N", "S", 2, url, "", None),
        ("external uri and a document", "N", "S", 2, url, doc, None),
        (
            "both uri modes",
            "N",
            "S",
            3,
            url,
            doc,
            Some(E::InvalidMetadataFlags),
        ),
        (
            "unknown bit 2",
            "N",
            "S",
            4,
            "",
            "",
            Some(E::InvalidMetadataFlags),
        ),
        (
            "unknown bit 7",
            "N",
            "S",
            0x80,
            "",
            doc,
            Some(E::InvalidMetadataFlags),
        ),
        (
            "inline and bit 2",
            "N",
            "S",
            5,
            "",
            doc,
            Some(E::InvalidMetadataFlags),
        ),
        (
            "a document of 3,073 bytes",
            "N",
            "S",
            0,
            "",
            &long_doc,
            Some(E::MetadataTooLong),
        ),
        (
            "an inline 3,073 bytes",
            "N",
            "S",
            1,
            "",
            &long_doc,
            Some(E::MetadataTooLong),
        ),
        (
            "an external uri of 201 bytes",
            "N",
            "S",
            2,
            &long_uri,
            "",
            Some(E::MetadataTooLong),
        ),
        (
            "an empty name",
            "",
            "S",
            0,
            "",
            "",
            Some(E::InvalidMetadata),
        ),
        (
            "a 33-byte name",
            &"N".repeat(33),
            "S",
            0,
            "",
            "",
            Some(E::InvalidMetadata),
        ),
        (
            "an 11-byte symbol",
            "N",
            &"S".repeat(11),
            0,
            "",
            "",
            Some(E::InvalidMetadata),
        ),
        (
            "an http uri",
            "N",
            "S",
            2,
            "http://a.example",
            "",
            Some(E::InvalidMetadata),
        ),
        (
            "external without a uri",
            "N",
            "S",
            2,
            "",
            doc,
            Some(E::InvalidMetadata),
        ),
        (
            "a uri without the flag",
            "N",
            "S",
            0,
            url,
            "",
            Some(E::InvalidMetadataFlags),
        ),
        (
            "a uri with the inline flag",
            "N",
            "S",
            1,
            url,
            doc,
            Some(E::InvalidMetadataFlags),
        ),
        (
            "inline without a document",
            "N",
            "S",
            1,
            "",
            "",
            Some(E::InvalidMetadataFlags),
        ),
    ];
    for (what, name, symbol, flags, uri, doc, want) in cases {
        let got = validate_metadata(name, symbol, flags, uri, doc);
        match want {
            None => assert!(got.is_ok(), "{what}: {got:?}"),
            Some(e) => assert_eq!(got.unwrap_err(), e.into(), "{what}"),
        }
    }
    // The order: a bad flag wins over everything, then lengths, then the
    // name and symbol.
    let order: [(u8, &str, &str, &str, E); 4] = [
        (9, "", &long_uri, &long_doc, E::InvalidMetadataFlags),
        (0, "", &long_uri, &long_doc, E::MetadataTooLong),
        (2, "", "https://a", "", E::InvalidMetadata),
        (0, "", "https://a", "", E::InvalidMetadata),
    ];
    for (flags, name, uri, doc, want) in order {
        assert_eq!(
            validate_metadata(name, "S", flags, uri, doc).unwrap_err(),
            want.into(),
            "flags {flags}"
        );
    }
    for flags in 0..=255u8 {
        assert_eq!(flags_are_valid(flags), flags <= 2, "flags {flags}");
    }
}

fn record(flags: u8, name: &str, uri: &str, doc: &str) -> TokenMeta {
    let launch = key(0x4C);
    let hash = metadata_hash_v2(
        name.as_bytes(),
        b"SYM",
        flags,
        uri.as_bytes(),
        doc.as_bytes(),
    );
    let (_, bump) =
        Pubkey::find_program_address(&[METADATA_SEED, launch.as_ref(), &hash], &crate::ID);
    TokenMeta {
        version: TokenMeta::VERSION,
        bump,
        flags,
        launch,
        metadata_hash: hash,
        name: name.into(),
        symbol: "SYM".into(),
        uri: uri.into(),
        doc: doc.into(),
    }
}

fn record_bytes(r: &TokenMeta) -> Vec<u8> {
    let mut data = Vec::new();
    r.try_serialize(&mut data).unwrap();
    data
}

/// The record's layout: discriminator, version, bump, flags, launch, hash,
/// then the four borsh strings; the space is exactly its content.
#[test]
fn token_meta_layout_is_pinned() {
    assert_eq!(TokenMeta::DISCRIMINATOR, [130, 87, 174, 35, 21, 44, 92, 19]);
    assert_eq!(TokenMeta::FIXED_LEN, 91);
    let r = record(2, "Phalanx", "https://a.example/t.json", "{}");
    let data = record_bytes(&r);
    assert_eq!(data.len(), TokenMeta::space(7, 3, 24, 2));
    assert_eq!(data.len(), 91 + 7 + 3 + 24 + 2);
    assert_eq!(&data[..8], TokenMeta::DISCRIMINATOR);
    assert_eq!(data[TokenMeta::VERSION_OFFSET], 1);
    assert_eq!(data[TokenMeta::BUMP_OFFSET], r.bump);
    assert_eq!(data[TokenMeta::FLAGS_OFFSET], 2);
    assert_eq!(&data[11..43], r.launch.as_ref());
    assert_eq!(&data[43..75], &r.metadata_hash);
    assert_eq!(
        (TokenMeta::LAUNCH_OFFSET, TokenMeta::METADATA_HASH_OFFSET),
        (11, 43)
    );
    let mut want = Vec::new();
    for s in ["Phalanx", "SYM", "https://a.example/t.json", "{}"] {
        want.extend_from_slice(&(s.len() as u32).to_le_bytes());
        want.extend_from_slice(s.as_bytes());
    }
    assert_eq!(&data[75..], &want[..]);
    // The hash is the record's content after its address fields: the tag,
    // then the borsh name and symbol, the flags and the borsh uri and
    // document.
    // (borsh "Phalanx" and "SYM": 11 + 7 bytes from offset 75; test data kept from the original name: its length fixes the offsets pinned here.)
    let content = [&data[75..93], &data[10..11], &data[93..]].concat();
    assert_eq!(
        r.metadata_hash,
        solana_sha256_hasher::hashv(&[b"PHX-META-V2", &content]).to_bytes()
    );
    // Sizes: the smallest record, a typical one (an 18-byte name, a
    // 5-byte symbol, a 924-byte document) and the largest.
    assert_eq!(TokenMeta::space(1, 1, 0, 0), 93);
    assert_eq!(TokenMeta::space(18, 5, 0, 924), 1_038);
    assert_eq!(
        TokenMeta::space(MAX_NAME_LEN, MAX_SYMBOL_LEN, MAX_URI_LEN, MAX_DOC_LEN),
        3_405
    );
    // Certificate version 3 appended the record's address (487 bytes),
    // version 4 the rules hash.
    assert_eq!(8 + Certificate::INIT_SPACE, 487 + 32);
}

/// `is_metadata_record` on an account at the address the launch and hash
/// name (`attest_launch` refuses any other), given that address's bump.
fn recognized(owner: &Pubkey, data: &[u8], launch: &Pubkey, hash: &[u8; 32], bump: u8) -> bool {
    let (address, _) = metadata_record_address(launch, hash);
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
    is_metadata_record(&info, launch, hash, bump)
}

/// The record a launch and a hash name lives at `["metadata", launch,
/// metadata_hash]` with the canonical bump, which `publish_metadata` stores.
/// At that address (`attest_launch` refuses any other), `attest_launch`
/// attests only a true record: owned by the program, a `TokenMeta` of
/// version 1 storing that bump, for that launch and hash. Each condition
/// alone refuses.
#[test]
fn only_the_named_record_is_recognized() {
    let r = record(0, "Noised", "", "");
    let data = record_bytes(&r);
    let (launch, hash, program) = (r.launch, r.metadata_hash, crate::ID);
    let (address, bump) = metadata_record_address(&launch, &hash);
    assert_eq!(
        (address, bump),
        Pubkey::find_program_address(&[b"metadata", launch.as_ref(), &hash], &crate::ID)
    );
    assert_eq!(bump, r.bump, "the bump publish_metadata stores");
    assert_eq!(
        Pubkey::create_program_address(
            &[METADATA_SEED, launch.as_ref(), &hash, &[bump]],
            &crate::ID
        ),
        Ok(address)
    );
    // The address names both the launch and the hash.
    assert_ne!(metadata_record_address(&key(9), &hash).0, address);
    assert_ne!(metadata_record_address(&launch, &[0; 32]).0, address);

    assert!(recognized(&program, &data, &launch, &hash, bump));
    assert!(
        !recognized(&key(9), &data, &launch, &hash, bump),
        "another owner"
    );
    assert!(
        !recognized(
            &anchor_lang::system_program::ID,
            &data,
            &launch,
            &hash,
            bump
        ),
        "a system account"
    );
    assert!(
        !recognized(&program, &data, &key(9), &hash, bump),
        "another launch"
    );
    assert!(
        !recognized(&program, &data, &launch, &[0; 32], bump),
        "another hash"
    );
    for at in 0..8 {
        let mut d = data.clone();
        d[at] ^= 1;
        assert!(
            !recognized(&program, &d, &launch, &hash, bump),
            "discriminator {at}"
        );
    }
    for version in [0, 2, 255] {
        let mut d = data.clone();
        d[8] = version;
        assert!(
            !recognized(&program, &d, &launch, &hash, bump),
            "version {version}"
        );
    }
    // A stored bump that is not the address's bump, either way round.
    let mut d = data.clone();
    d[9] = bump.wrapping_sub(1);
    assert!(
        !recognized(&program, &d, &launch, &hash, bump),
        "another stored bump"
    );
    assert!(
        !recognized(&program, &data, &launch, &hash, bump.wrapping_sub(1)),
        "another address bump"
    );
    // The fields it reads must be the stored ones, not just the arguments.
    for at in [11, 42, 43, 74] {
        let mut d = data.clone();
        d[at] ^= 1;
        assert!(!recognized(&program, &d, &launch, &hash, bump), "byte {at}");
    }
    // Too short for a record.
    assert!(!recognized(&program, &data[..90], &launch, &hash, bump));
    assert!(!recognized(&program, &[], &launch, &hash, bump));
    // The flags and strings are not read: only `publish_metadata` writes a
    // record, after validating it, at the address of its content.
    let mut d = data.clone();
    d[10] = 0xFF;
    assert!(recognized(&program, &d, &launch, &hash, bump));
}

//! Client for the post-quantum attestation of `noised_launchpad` (PQ v2
//! §2.2, amendments A4, A5 and A13, with the adversarial review's fixes),
//! its on-chain metadata record and creator rules record (programmable
//! launches §2), and its generic authorizations (`pq_authorize`): PDAs, the
//! records (`TokenMeta`, `LaunchRules`), their hashes and publishing
//! instructions, the uri `launch` derives from the metadata, the 221-byte
//! message an identity signs (the launch, the records' hashes and the launch
//! window), `attest_launch`'s instruction, the `Launch` v2 layout (to place
//! a launch with `set_account`), the `Identity`, `Attestation` and
//! `Authorization` account layouts, the 140-byte authorization message, the
//! autopilot's payload hashes, the event payloads, the leaf bitmap and the
//! leaf probe.
//!
//! Everything here is written from the documented layouts, not imported
//! from the launchpad crate (the integration workspace does not link it), so
//! the tests check the program build and the SDK vectors against the format:
//!
//! ```text
//! message       = "PHX-ATTEST-V3" || program_id || launch || params_hash || creator || metadata_hash
//!                 || rules_hash || i64le(not_before) || i64le(not_after)                      (221 bytes)
//! metadata_hash = SHA256("PHX-META-V2" || borsh(name) || borsh(symbol) || u8 flags || borsh(uri)
//!                 || borsh(doc))
//! rules_hash    = SHA256("PHX-RULES-V1" || PXR1 bytes), or 32 zero bytes for no rules
//! LaunchRules   = disc || version (1) || bump || launch || rules_hash || borsh(bytes)    (78 + len bytes)
//!                 at ["rules", launch, rules_hash]
//! launch        = ["launch", creator, launch_seed]
//! TokenMeta     = disc || version (1) || bump || flags || launch || metadata_hash || borsh(name)
//!                 || borsh(symbol) || borsh(uri) || borsh(doc)                     (91 + lengths bytes)
//!                 at ["metadata", launch, metadata_hash]
//! Identity      = disc || version (1) || bump || public_key (56) || used (128, LSB first) || used_count u16
//!                 at ["identity", SHA256(0x21 || public_key)]: the signing key's
//! Attestation   = disc || version (3) || bump || launch || pq_identity || leaf u16 || metadata_hash
//!                 || rules_hash || message_hash || slot u64 || not_before i64 || not_after i64
//!                 || u32 len || signature (2,508)                                            (2,708 bytes)
//! auth message  = "PHX-AUTH-V1" || program_id || launch || creator || u8 kind || payload_hash (140 bytes)
//! Authorization = disc || version (1) || bump || launch || pq_identity || kind || payload_hash
//!                 || message_hash || unix_time i64 || slot u64 || leaf u16 || u32 len
//!                 || signature (2,508)                                                       (2,669 bytes)
//!                 at ["auth", launch, [kind], payload_hash]
//! ```
//!
//! Any valid signature by a key over an existing launch's message lands
//! and burns that key's leaf. It attests the launch (writes the
//! attestation) only if the attestation is free (still empty, or its window
//! ended while the launch is still Configured: then every field is
//! rewritten), the key is the identity the launch names, the record the
//! hash names exists, and so does the rules record a non-zero rules hash
//! names (`publish_rules` verified it), the metadata record (`publish_metadata` validated it: UTF-8; name 1..=32
//! and symbol 1..=10 bytes; flags 0, inline uri (1) or external uri (2); a
//! document of at most 3,072 bytes; an external uri `https://`, printable
//! ASCII, at most 200 bytes) and the window leaves `launch` a minute (60 to
//! 3,600 seconds long, opening at most 604,800 seconds ahead, and
//! `max(now, not_before) + 60 <= not_after`); otherwise it emits
//! `PqLeafConsumed` and leaves the attestation as it is (here: empty,
//! version 0, launch zero, its bump set).

use std::sync::OnceLock;

use anchor_lang::AnchorSerialize;
use noised_lmots::{LmsKeyPair, LmsPrivateKey, Sha2};
use serde_json::Value;
use solana_account::Account;
use solana_message::v1;

use super::{
    anchor_discriminator, sha256, AccountMeta, Harness, Instruction, Pubkey, LAUNCHPAD_PROGRAM_ID,
    SYSTEM_PROGRAM_ID,
};

/// The SDK's cluster byte for localnet (A12).
pub const LOCALNET: u8 = 2;
pub const LAUNCH_SEED: &[u8] = b"launch";
pub const IDENTITY_SEED: &[u8] = b"identity";
pub const ATTESTATION_SEED: &[u8] = b"attestation";
pub const PAYOUT_VAULT_SEED: &[u8] = b"payout-vault";
pub const METADATA_SEED: &[u8] = b"metadata";
pub const RULES_SEED: &[u8] = b"rules";
pub const AUTH_SEED: &[u8] = b"auth";
/// The autopilot program (it reads `Authorization` accounts by layout).
pub const AUTOPILOT_PROGRAM_ID: Pubkey =
    anchor_lang::pubkey!("D5fuqCXNP7BkU3CyNrpZUFStgdZ6XwRkpURiK9v5esbx");
pub const RULES_HASH_TAG: &[u8] = b"PHX-RULES-V1";
pub const AUTH_MESSAGE_TAG: &[u8] = b"PHX-AUTH-V1";
pub const AUTH_MESSAGE_LEN: usize = 140;
pub const AUTHORIZATION_ACCOUNT_LEN: usize = 2669;
pub const AUTHORIZATION_VERSION: u8 = 1;
pub const LAUNCH_RULES_FIXED_LEN: usize = 78;
pub const LAUNCH_RULES_VERSION: u8 = 1;
/// The autopilot's payload-hash domains (16 bytes each).
pub const GRAPH_ACTIVATE_DOMAIN: &[u8] = b"PHX-GRAPH-ACT-V1";
pub const GRAPH_FREEZE_DOMAIN: &[u8] = b"PHX-GRAPH-FRZ-V2";
pub const OPERATOR_REVOKE_DOMAIN: &[u8] = b"PHX-OP-REVOKE-V3";
/// Domain tag that starts every attestation message.
pub const ATTEST_MESSAGE_TAG: &[u8] = b"PHX-ATTEST-V3";
/// Domain tag of `metadata_hash`.
pub const METADATA_HASH_TAG: &[u8] = b"PHX-META-V2";
pub const ATTEST_MESSAGE_LEN: usize = 221;
/// The leaf probe: `u16be(SHA256(tag || I || message)[0..2]) mod 1024`,
/// then the first clear bit.
// protocol constant: kept from the original name; changing it changes every leaf choice and the vectors
pub const LEAF_PROBE_TAG: &[u8] = b"phalanx/pq/identity/leaf";
pub const LEAVES: u32 = 1024;
pub const LEAF_BITMAP_LEN: usize = LEAVES as usize / 8;
/// A13: a client warns once this many leaves of an identity are used, and
/// moves to the next identity index when all 1,024 are.
pub const LEAF_WARN_AT_USED: u32 = 1000;
/// `Launch` v2 with its discriminator; `creator`, `params_hash` and
/// `pq_identity` (what `attest_launch` reads) sit at these offsets.
pub const LAUNCH_ACCOUNT_LEN: usize = 585;
pub const LAUNCH_STATUS_OFFSET: usize = 13;
pub const LAUNCH_CREATOR_OFFSET: usize = 46;
pub const LAUNCH_PARAMS_HASH_OFFSET: usize = 448;
pub const LAUNCH_PQ_IDENTITY_OFFSET: usize = 553;
pub const LAUNCH_VERSION: u8 = 2;
/// `Identity` (8 + 1 + 1 + 56 + 128 + 2) and `Attestation` (8 + 1 + 1 +
/// 32 + 32 + 2 + 32 + 32 + 8 + 8 + 8 + 4 + 2,508) with discriminators,
/// and the `PayoutVault` record (8 + 1 + 1 + 32 + 32 + 8).
pub const IDENTITY_ACCOUNT_LEN: usize = 196;
pub const ATTESTATION_ACCOUNT_LEN: usize = 2708;
pub const ATTESTATION_VERSION: u8 = 3;
pub const PAYOUT_VAULT_ACCOUNT_LEN: usize = 82;
/// `TokenMeta` without its strings: discriminator, version, bump, flags,
/// launch, metadata hash and four u32 length prefixes.
pub const TOKEN_META_FIXED_LEN: usize = 91;
pub const TOKEN_META_VERSION: u8 = 1;
/// Name and symbol limits of a record, in UTF-8 bytes (not characters);
/// both non-empty.
pub const MAX_NAME_LEN: usize = 32;
pub const MAX_SYMBOL_LEN: usize = 10;
/// An external uri (`META_FLAG_EXTERNAL_URI`): `https://`, printable ASCII
/// (0x21..=0x7E), at most 200 bytes.
pub const MAX_URI_LEN: usize = 200;
pub const EXTERNAL_URI_PREFIX: &str = "https://";
/// A record's document: at most 3,072 bytes of UTF-8.
pub const MAX_DOC_LEN: usize = 3_072;
/// `TokenMeta::flags`: no bit (the mint's uri is empty), or exactly one.
pub const META_FLAG_INLINE_URI: u8 = 1;
pub const META_FLAG_EXTERNAL_URI: u8 = 2;
/// The inline uri: this prefix and the padded standard base64 of the
/// document.
pub const INLINE_URI_PREFIX: &str = "data:application/json;base64,";
/// The launch window an attestation may record: 60 to 3,600 seconds long,
/// not over when it lands, opening at most a week after.
pub const MIN_LAUNCH_WINDOW_SECS: i64 = 60;
pub const MAX_LAUNCH_WINDOW_SECS: i64 = 3_600;
pub const MAX_LAUNCH_LEAD_SECS: i64 = 604_800;
/// v1 config words of an attestation (A14). Unset words mean 0 in v1.
pub const ATTEST_CU_LIMIT: u32 = 300_000;
pub const ATTEST_LOADED_ACCOUNTS_DATA_LIMIT: u32 = 2 * 1024 * 1024;
/// The compute target `attest_launch` is held to (A5).
pub const ATTEST_CU_TARGET: u64 = 250_000;
/// v1 config words of a `publish_metadata` (the attestation's loaded-data
/// word; the largest record needs well under this CU limit).
pub const PUBLISH_CU_LIMIT: u32 = 100_000;

/// A `noised_launchpad` error by name and number, for
/// [`TxExpect::expect_error`](super::svm::TxExpect::expect_error). The
/// numbers are pinned by the launchpad crate's host tests.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct LaunchpadError {
    pub name: &'static str,
    pub number: u32,
}

impl std::fmt::Debug for LaunchpadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.name)
    }
}

impl From<LaunchpadError> for u32 {
    fn from(e: LaunchpadError) -> u32 {
        e.number
    }
}

pub const INVALID_METADATA: LaunchpadError = LaunchpadError {
    name: "InvalidMetadata",
    number: 6016,
};
pub const CAP_EXCEEDED: LaunchpadError = LaunchpadError {
    name: "CapExceeded",
    number: 6030,
};
pub const INVALID_PQ_IDENTITY: LaunchpadError = LaunchpadError {
    name: "InvalidPqIdentity",
    number: 6039,
};
pub const INVALID_PQ_SIGNATURE: LaunchpadError = LaunchpadError {
    name: "InvalidPqSignature",
    number: 6040,
};
pub const PQ_LEAF_USED: LaunchpadError = LaunchpadError {
    name: "PqLeafUsed",
    number: 6041,
};
pub const ATTESTATION_MISMATCH: LaunchpadError = LaunchpadError {
    name: "AttestationMismatch",
    number: 6042,
};
pub const INVALID_PAYOUT_OWNER: LaunchpadError = LaunchpadError {
    name: "InvalidPayoutOwner",
    number: 6043,
};
pub const NOT_LAUNCH_WINDOW: LaunchpadError = LaunchpadError {
    name: "NotLaunchWindow",
    number: 6044,
};
pub const INVALID_METADATA_FLAGS: LaunchpadError = LaunchpadError {
    name: "InvalidMetadataFlags",
    number: 6045,
};
pub const METADATA_TOO_LONG: LaunchpadError = LaunchpadError {
    name: "MetadataTooLong",
    number: 6046,
};
pub const METADATA_MISMATCH: LaunchpadError = LaunchpadError {
    name: "MetadataMismatch",
    number: 6047,
};
pub const INVALID_RULES: LaunchpadError = LaunchpadError {
    name: "InvalidRules",
    number: 6048,
};
pub const WRONG_LAUNCH_STATE: LaunchpadError = LaunchpadError {
    name: "WrongLaunchState",
    number: 6018,
};
/// Anchor's: an account is not at the address its seeds give.
pub const CONSTRAINT_SEEDS: LaunchpadError = LaunchpadError {
    name: "ConstraintSeeds",
    number: 2006,
};
/// Anchor's: instruction data that does not deserialize (a string that is
/// not UTF-8).
pub const INSTRUCTION_DID_NOT_DESERIALIZE: LaunchpadError = LaunchpadError {
    name: "InstructionDidNotDeserialize",
    number: 102,
};
/// Anchor's: an account of the program with another type's discriminator.
pub const ACCOUNT_DISCRIMINATOR_MISMATCH: LaunchpadError = LaunchpadError {
    name: "AccountDiscriminatorMismatch",
    number: 3002,
};
/// Anchor's: a typed account owned by another program.
pub const ACCOUNT_OWNED_BY_WRONG_PROGRAM: LaunchpadError = LaunchpadError {
    name: "AccountOwnedByWrongProgram",
    number: 3007,
};
/// Anchor's: a typed account that does not exist.
pub const ACCOUNT_NOT_INITIALIZED: LaunchpadError = LaunchpadError {
    name: "AccountNotInitialized",
    number: 3012,
};

/// The launchpad error named `name` (one of the constants above).
pub fn launchpad_error(name: &str) -> LaunchpadError {
    [
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
        WRONG_LAUNCH_STATE,
        CONSTRAINT_SEEDS,
        INSTRUCTION_DID_NOT_DESERIALIZE,
        ACCOUNT_DISCRIMINATOR_MISMATCH,
        ACCOUNT_OWNED_BY_WRONG_PROGRAM,
        ACCOUNT_NOT_INITIALIZED,
    ]
    .into_iter()
    .find(|e| e.name == name)
    .unwrap_or_else(|| panic!("unknown launchpad error {name}"))
}

/// The v1 config words a client sends `attest_launch` with (A14).
pub fn attest_tx_config() -> v1::TransactionConfig {
    v1::TransactionConfig::empty()
        .with_compute_unit_limit(ATTEST_CU_LIMIT)
        .with_loaded_accounts_data_size_limit(ATTEST_LOADED_ACCOUNTS_DATA_LIMIT)
}

/// The v1 config words a client sends `publish_metadata` with.
pub fn publish_tx_config() -> v1::TransactionConfig {
    v1::TransactionConfig::empty()
        .with_compute_unit_limit(PUBLISH_CU_LIMIT)
        .with_loaded_accounts_data_size_limit(ATTEST_LOADED_ACCOUNTS_DATA_LIMIT)
}

/// The vector identity (`lms.json`, `metadata.json`): localnet identity 0
/// of the master seed made of the bytes 0..63, generated once per test
/// binary (about 1.14 million SHA-256 compressions).
pub fn vector_identity() -> &'static LmsKeyPair {
    static KEY: OnceLock<LmsKeyPair> = OnceLock::new();
    KEY.get_or_init(|| {
        let master: [u8; 64] = std::array::from_fn(|i| i as u8);
        LmsPrivateKey::derive_identity::<Sha2>(&master, LOCALNET, 0)
            .expect("identity derivation")
            .keygen::<Sha2>()
    })
}

fn pda(seeds: &[&[u8]]) -> (Pubkey, u8) {
    Pubkey::find_program_address(seeds, &LAUNCHPAD_PROGRAM_ID)
}

/// `["launch", creator, launch_seed]`.
pub fn launch_pda(creator: &Pubkey, launch_seed: &[u8; 32]) -> (Pubkey, u8) {
    pda(&[LAUNCH_SEED, creator.as_ref(), launch_seed])
}

/// `["identity", pq_identity]`.
pub fn identity_pda(pq_identity: &[u8; 32]) -> (Pubkey, u8) {
    pda(&[IDENTITY_SEED, pq_identity])
}

/// `["attestation", launch]`.
pub fn attestation_pda(launch: &Pubkey) -> (Pubkey, u8) {
    pda(&[ATTESTATION_SEED, launch.as_ref()])
}

/// `["payout-vault", launch, vault]`.
pub fn payout_vault_pda(launch: &Pubkey, vault: &Pubkey) -> (Pubkey, u8) {
    pda(&[PAYOUT_VAULT_SEED, launch.as_ref(), vault.as_ref()])
}

/// `SHA256(0x21 || pk)`: a launch's `pq_identity`, written out from its
/// definition.
pub fn identity_id(public_key: &[u8; 56]) -> [u8; 32] {
    sha256(&[&[0x21], public_key])
}

/// A metadata record: name, symbol, flags, uri and document, as bytes (the
/// borsh encoding of strings and bytes is the same; records that are not
/// UTF-8 can be signed, never published).
#[derive(Clone, Copy, Debug)]
pub struct Metadata<'a> {
    pub name: &'a [u8],
    pub symbol: &'a [u8],
    pub flags: u8,
    pub uri: &'a [u8],
    pub doc: &'a [u8],
}

impl<'a> Metadata<'a> {
    pub fn new(name: &'a str, symbol: &'a str, flags: u8, uri: &'a str, doc: &'a str) -> Self {
        Metadata {
            name: name.as_bytes(),
            symbol: symbol.as_bytes(),
            flags,
            uri: uri.as_bytes(),
            doc: doc.as_bytes(),
        }
    }
}

/// `borsh(name) || borsh(symbol) || u8 flags || borsh(uri) || borsh(doc)`
/// (each string a u32 LE length, then its bytes): the record's content in
/// its field order, and `publish_metadata`'s arguments.
pub fn metadata_borsh(m: Metadata) -> Vec<u8> {
    let mut borsh = Vec::new();
    (
        m.name.to_vec(),
        m.symbol.to_vec(),
        m.flags,
        m.uri.to_vec(),
        m.doc.to_vec(),
    )
        .serialize(&mut borsh)
        .expect("borsh bytes");
    borsh
}

/// `SHA256("PHX-META-V2" || metadata_borsh)`.
pub fn metadata_hash(m: Metadata) -> [u8; 32] {
    sha256(&[METADATA_HASH_TAG, &metadata_borsh(m)])
}

/// An external uri: `https://` and at least one more byte, at most 200
/// bytes, every byte 0x21..=0x7E.
pub fn external_uri_is_valid(uri: &[u8]) -> bool {
    (EXTERNAL_URI_PREFIX.len() + 1..=MAX_URI_LEN).contains(&uri.len())
        && uri.starts_with(EXTERNAL_URI_PREFIX.as_bytes())
        && uri.iter().all(|b| (0x21..=0x7E).contains(b))
}

/// The error `publish_metadata` refuses a record with, `None` when it
/// accepts it; checked in the program's order: the flags, the lengths, the
/// name and symbol, then the uri and document against the mode. A record
/// that is not UTF-8 never deserializes (`None` is never returned for it).
pub fn metadata_error(m: Metadata) -> Option<LaunchpadError> {
    let utf8 = [m.name, m.symbol, m.uri, m.doc]
        .iter()
        .all(|s| std::str::from_utf8(s).is_ok());
    assert!(utf8, "a record that is not UTF-8 never reaches the checks");
    if !matches!(m.flags, 0 | META_FLAG_INLINE_URI | META_FLAG_EXTERNAL_URI) {
        return Some(INVALID_METADATA_FLAGS);
    }
    if m.doc.len() > MAX_DOC_LEN || m.uri.len() > MAX_URI_LEN {
        return Some(METADATA_TOO_LONG);
    }
    if !(1..=MAX_NAME_LEN).contains(&m.name.len())
        || !(1..=MAX_SYMBOL_LEN).contains(&m.symbol.len())
    {
        return Some(INVALID_METADATA);
    }
    if m.flags == META_FLAG_EXTERNAL_URI {
        if !external_uri_is_valid(m.uri) {
            return Some(INVALID_METADATA);
        }
    } else if !m.uri.is_empty() {
        return Some(INVALID_METADATA_FLAGS);
    }
    if m.flags == META_FLAG_INLINE_URI && m.doc.is_empty() {
        return Some(INVALID_METADATA_FLAGS);
    }
    None
}

/// Whether `publish_metadata` accepts this record: UTF-8 and no error.
pub fn metadata_is_valid(m: Metadata) -> bool {
    [m.name, m.symbol, m.uri, m.doc]
        .iter()
        .all(|s| std::str::from_utf8(s).is_ok())
        && metadata_error(m).is_none()
}

/// `["metadata", launch, metadata_hash]`.
pub fn token_meta_pda(launch: &Pubkey, metadata_hash: &[u8; 32]) -> (Pubkey, u8) {
    pda(&[METADATA_SEED, launch.as_ref(), metadata_hash])
}

/// `TokenMeta` account bytes: the discriminator, version 1, the bump, the
/// flags, the launch, the hash, then the strings.
pub fn token_meta_account_data(bump: u8, launch: &Pubkey, m: Metadata) -> Vec<u8> {
    let mut d = anchor_discriminator("account", "TokenMeta").to_vec();
    d.extend_from_slice(&[TOKEN_META_VERSION, bump, m.flags]);
    d.extend_from_slice(launch.as_ref());
    d.extend_from_slice(&metadata_hash(m));
    for s in [m.name, m.symbol, m.uri, m.doc] {
        d.extend_from_slice(&u32::try_from(s.len()).expect("u32").to_le_bytes());
        d.extend_from_slice(s);
    }
    assert_eq!(
        d.len(),
        TOKEN_META_FIXED_LEN + m.name.len() + m.symbol.len() + m.uri.len() + m.doc.len()
    );
    d
}

/// `publish_metadata(name, symbol, flags, uri, doc)` instruction data.
pub fn publish_metadata_data(m: Metadata) -> Vec<u8> {
    let mut data = anchor_discriminator("global", "publish_metadata").to_vec();
    data.extend_from_slice(&metadata_borsh(m));
    data
}

/// `publish_metadata`: payer (signer, writable), the launch, the record
/// (writable), the system program.
pub fn publish_metadata_ix(payer: &Pubkey, launch: &Pubkey, m: Metadata) -> Instruction {
    let record = token_meta_pda(launch, &metadata_hash(m)).0;
    publish_metadata_ix_at(payer, launch, m, &record)
}

/// `publish_metadata` naming `record` as the record's account (the
/// program requires `["metadata", launch, metadata_hash]`).
pub fn publish_metadata_ix_at(
    payer: &Pubkey,
    launch: &Pubkey,
    m: Metadata,
    record: &Pubkey,
) -> Instruction {
    Instruction {
        program_id: LAUNCHPAD_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(*launch, false),
            AccountMeta::new(*record, false),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
        ],
        data: publish_metadata_data(m),
    }
}

/// Standard padded base64 (RFC 4648 §4), written bit by bit.
pub fn base64_encode(input: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bits: Vec<bool> = input
        .iter()
        .flat_map(|b| (0..8).rev().map(move |i| b >> i & 1 == 1))
        .collect();
    let mut out: String = bits
        .chunks(6)
        .map(|six| {
            let v = (0..6).fold(0usize, |v, i| {
                v << 1 | usize::from(six.get(i) == Some(&true))
            });
            char::from(ALPHABET[v])
        })
        .collect();
    while !out.len().is_multiple_of(4) {
        out.push('=');
    }
    out
}

/// The uri `launch` gives the mint: `""`, the inline uri of the document, or
/// the external uri.
pub fn token_uri(m: Metadata) -> Vec<u8> {
    match m.flags {
        META_FLAG_INLINE_URI => [
            INLINE_URI_PREFIX.as_bytes(),
            base64_encode(m.doc).as_bytes(),
        ]
        .concat(),
        META_FLAG_EXTERNAL_URI => m.uri.to_vec(),
        _ => Vec::new(),
    }
}

/// What a signature attests besides the launch and its metadata record.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Terms {
    /// The launch window, unix seconds, inclusive.
    pub not_before: i64,
    pub not_after: i64,
    /// The creator rules (their hash; all zero for none).
    pub rules_hash: [u8; 32],
}

/// The rules hash of a launch without creator rules.
pub const NO_RULES: [u8; 32] = [0; 32];

/// Whether an attestation landing at `now` records this window: at least a
/// minute of it is left from the later of `now` and its opening.
pub fn launch_window_is_valid(now: i64, not_before: i64, not_after: i64) -> bool {
    let (now, start, end) = (
        i128::from(now),
        i128::from(not_before),
        i128::from(not_after),
    );
    (i128::from(MIN_LAUNCH_WINDOW_SECS)..=i128::from(MAX_LAUNCH_WINDOW_SECS))
        .contains(&(end - start))
        && start.max(now) + i128::from(MIN_LAUNCH_WINDOW_SECS) <= end
        && start <= now + i128::from(MAX_LAUNCH_LEAD_SECS)
}

/// The 221-byte message a launch's identity signs.
pub fn attestation_message(
    launch: &Pubkey,
    params_hash: &[u8; 32],
    creator: &Pubkey,
    metadata_hash: &[u8; 32],
    terms: &Terms,
) -> Vec<u8> {
    let mut m = Vec::with_capacity(ATTEST_MESSAGE_LEN);
    m.extend_from_slice(ATTEST_MESSAGE_TAG);
    m.extend_from_slice(LAUNCHPAD_PROGRAM_ID.as_ref());
    m.extend_from_slice(launch.as_ref());
    m.extend_from_slice(params_hash);
    m.extend_from_slice(creator.as_ref());
    m.extend_from_slice(metadata_hash);
    m.extend_from_slice(&terms.rules_hash);
    m.extend_from_slice(&terms.not_before.to_le_bytes());
    m.extend_from_slice(&terms.not_after.to_le_bytes());
    assert_eq!(m.len(), ATTEST_MESSAGE_LEN);
    m
}

/// `attest_launch` instruction data: the discriminator, then borsh
/// `([u8; 56], Vec<u8>, [u8; 32] metadata_hash, [u8; 32] rules_hash, i64,
/// i64)`.
pub fn attest_launch_data(
    public_key: &[u8; 56],
    signature: &[u8],
    metadata_hash: &[u8; 32],
    terms: &Terms,
) -> Vec<u8> {
    let mut data = anchor_discriminator("global", "attest_launch").to_vec();
    data.extend_from_slice(public_key);
    signature
        .to_vec()
        .serialize(&mut data)
        .expect("borsh bytes");
    data.extend_from_slice(metadata_hash);
    data.extend_from_slice(&terms.rules_hash);
    data.extend_from_slice(&terms.not_before.to_le_bytes());
    data.extend_from_slice(&terms.not_after.to_le_bytes());
    data
}

/// `attest_launch` (A5): payer (signer, writable), the launch, the signing
/// key's identity PDA and the launch's attestation PDA (writable), the
/// record the hash names (read-only), the system program, then the rules
/// record the rules hash names (read-only), or the program id for none.
pub fn attest_launch_ix(
    payer: &Pubkey,
    launch: &Pubkey,
    public_key: &[u8; 56],
    signature: &[u8],
    metadata: Metadata,
    terms: &Terms,
) -> Instruction {
    let hash = metadata_hash(metadata);
    let record = token_meta_pda(launch, &hash).0;
    attest_launch_ix_at(payer, launch, public_key, signature, &hash, terms, &record)
}

/// `attest_launch` over `metadata_hash` (any 32 bytes), naming `token_meta`
/// as the record's account (a client sends `["metadata", launch,
/// metadata_hash]`; the program attests only if it is that record).
pub fn attest_launch_ix_at(
    payer: &Pubkey,
    launch: &Pubkey,
    public_key: &[u8; 56],
    signature: &[u8],
    metadata_hash: &[u8; 32],
    terms: &Terms,
    token_meta: &Pubkey,
) -> Instruction {
    Instruction {
        program_id: LAUNCHPAD_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(*launch, false),
            AccountMeta::new(identity_pda(&identity_id(public_key)).0, false),
            AccountMeta::new(attestation_pda(launch).0, false),
            AccountMeta::new_readonly(*token_meta, false),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
            AccountMeta::new_readonly(rules_account(launch, &terms.rules_hash), false),
        ],
        data: attest_launch_data(public_key, signature, metadata_hash, terms),
    }
}

/// `SHA256("PHX-RULES-V1" || bytes)`.
pub fn rules_hash(bytes: &[u8]) -> [u8; 32] {
    sha256(&[RULES_HASH_TAG, bytes])
}

/// `["rules", launch, rules_hash]`.
pub fn rules_pda(launch: &Pubkey, rules_hash: &[u8; 32]) -> (Pubkey, u8) {
    pda(&[RULES_SEED, launch.as_ref(), rules_hash])
}

/// The rules account of `attest_launch` and `launch`: the record, or the
/// program id (Anchor's `None`) for the zero hash.
pub fn rules_account(launch: &Pubkey, rules_hash: &[u8; 32]) -> Pubkey {
    if *rules_hash == NO_RULES {
        LAUNCHPAD_PROGRAM_ID
    } else {
        rules_pda(launch, rules_hash).0
    }
}

/// `LaunchRules` account bytes, as `publish_rules` writes them.
pub fn launch_rules_account_data(bump: u8, launch: &Pubkey, bytes: &[u8]) -> Vec<u8> {
    let mut d = anchor_discriminator("account", "LaunchRules").to_vec();
    d.push(LAUNCH_RULES_VERSION);
    d.push(bump);
    d.extend_from_slice(launch.as_ref());
    d.extend_from_slice(&rules_hash(bytes));
    bytes.to_vec().serialize(&mut d).expect("borsh bytes");
    assert_eq!(d.len(), LAUNCH_RULES_FIXED_LEN + bytes.len());
    d
}

/// `publish_rules(bytes)` instruction data.
pub fn publish_rules_data(bytes: &[u8]) -> Vec<u8> {
    let mut data = anchor_discriminator("global", "publish_rules").to_vec();
    bytes.to_vec().serialize(&mut data).expect("borsh bytes");
    data
}

/// `publish_rules`: payer (signer, writable), the launch, the record at the
/// address the bytes hash to (writable), the system program.
pub fn publish_rules_ix(payer: &Pubkey, launch: &Pubkey, bytes: &[u8]) -> Instruction {
    Instruction {
        program_id: LAUNCHPAD_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(*launch, false),
            AccountMeta::new(rules_pda(launch, &rules_hash(bytes)).0, false),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
        ],
        data: publish_rules_data(bytes),
    }
}

/// Payload of `RulesPublished {launch, rules, rules_hash, len u16}`.
pub fn rules_published_event(launch: &Pubkey, bytes: &[u8]) -> Vec<u8> {
    let hash = rules_hash(bytes);
    [
        launch.as_ref(),
        rules_pda(launch, &hash).0.as_ref(),
        &hash,
        &u16::try_from(bytes.len()).expect("u16").to_le_bytes(),
    ]
    .concat()
}

/// The 140-byte message a launch's identity signs to authorize `kind` over
/// `payload_hash`.
pub fn authorization_message(
    launch: &Pubkey,
    creator: &Pubkey,
    kind: u8,
    payload_hash: &[u8; 32],
) -> Vec<u8> {
    let mut m = Vec::with_capacity(AUTH_MESSAGE_LEN);
    m.extend_from_slice(AUTH_MESSAGE_TAG);
    m.extend_from_slice(LAUNCHPAD_PROGRAM_ID.as_ref());
    m.extend_from_slice(launch.as_ref());
    m.extend_from_slice(creator.as_ref());
    m.push(kind);
    m.extend_from_slice(payload_hash);
    assert_eq!(m.len(), AUTH_MESSAGE_LEN);
    m
}

/// `["auth", launch, [kind], payload_hash]`.
pub fn auth_pda(launch: &Pubkey, kind: u8, payload_hash: &[u8; 32]) -> (Pubkey, u8) {
    pda(&[AUTH_SEED, launch.as_ref(), &[kind], payload_hash])
}

/// `pq_authorize` instruction data: the discriminator, then borsh
/// `([u8; 56], Vec<u8>, u8 kind, [u8; 32] payload_hash)`.
pub fn pq_authorize_data(
    public_key: &[u8; 56],
    signature: &[u8],
    kind: u8,
    payload_hash: &[u8; 32],
) -> Vec<u8> {
    let mut data = anchor_discriminator("global", "pq_authorize").to_vec();
    data.extend_from_slice(public_key);
    signature
        .to_vec()
        .serialize(&mut data)
        .expect("borsh bytes");
    data.push(kind);
    data.extend_from_slice(payload_hash);
    data
}

/// `pq_authorize`: payer (signer, writable), the launch, the signing key's
/// identity PDA and the authorization PDA (writable), the system program.
pub fn pq_authorize_ix(
    payer: &Pubkey,
    launch: &Pubkey,
    public_key: &[u8; 56],
    signature: &[u8],
    kind: u8,
    payload_hash: &[u8; 32],
) -> Instruction {
    Instruction {
        program_id: LAUNCHPAD_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(*launch, false),
            AccountMeta::new(identity_pda(&identity_id(public_key)).0, false),
            AccountMeta::new(auth_pda(launch, kind, payload_hash).0, false),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
        ],
        data: pq_authorize_data(public_key, signature, kind, payload_hash),
    }
}

/// An authorization as `pq_authorize` writes it.
#[derive(Clone, Debug)]
pub struct AuthorizationRecord {
    pub bump: u8,
    pub launch: Pubkey,
    pub pq_identity: [u8; 32],
    pub kind: u8,
    pub payload_hash: [u8; 32],
    pub message_hash: [u8; 32],
    pub unix_time: i64,
    pub slot: u64,
    pub leaf: u16,
    pub signature: Vec<u8>,
}

/// `Authorization` account bytes (the layout the autopilot reads).
pub fn authorization_account_data(a: &AuthorizationRecord) -> Vec<u8> {
    let mut d = anchor_discriminator("account", "Authorization").to_vec();
    d.push(AUTHORIZATION_VERSION);
    d.push(a.bump);
    d.extend_from_slice(a.launch.as_ref());
    d.extend_from_slice(&a.pq_identity);
    d.push(a.kind);
    d.extend_from_slice(&a.payload_hash);
    d.extend_from_slice(&a.message_hash);
    d.extend_from_slice(&a.unix_time.to_le_bytes());
    d.extend_from_slice(&a.slot.to_le_bytes());
    d.extend_from_slice(&a.leaf.to_le_bytes());
    a.signature
        .serialize(&mut d)
        .expect("borsh signature bytes");
    assert_eq!(d.len(), AUTHORIZATION_ACCOUNT_LEN);
    d
}

/// Payload of `Authorized {launch, authorization, pq_identity, kind,
/// payload_hash, leaf u16, unix_time i64, slot u64}`.
pub fn authorized_event(a: &AuthorizationRecord) -> Vec<u8> {
    [
        a.launch.as_ref(),
        auth_pda(&a.launch, a.kind, &a.payload_hash).0.as_ref(),
        &a.pq_identity,
        &[a.kind],
        &a.payload_hash,
        &a.leaf.to_le_bytes(),
        &a.unix_time.to_le_bytes(),
        &a.slot.to_le_bytes(),
    ]
    .concat()
}

/// `["autopilot", launch]` under the autopilot.
pub fn autopilot_pda(launch: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"autopilot", launch.as_ref()], &AUTOPILOT_PROGRAM_ID).0
}

/// `SHA256("PHX-GRAPH-ACT-V1" || autopilot || graph_hash || i64le(activate_at))`.
pub fn activation_payload(autopilot: &Pubkey, graph_hash: &[u8; 32], activate_at: i64) -> [u8; 32] {
    sha256(&[
        GRAPH_ACTIVATE_DOMAIN,
        autopilot.as_ref(),
        graph_hash,
        &activate_at.to_le_bytes(),
    ])
}

/// `SHA256("PHX-GRAPH-FRZ-V2" || autopilot || graph_hash || i64le(not_after))`
/// (review 4, R5: a freeze names the last second it may be used).
pub fn freeze_payload(autopilot: &Pubkey, graph_hash: &[u8; 32], not_after: i64) -> [u8; 32] {
    sha256(&[
        GRAPH_FREEZE_DOMAIN,
        autopilot.as_ref(),
        graph_hash,
        &not_after.to_le_bytes(),
    ])
}

/// `SHA256("PHX-OP-REVOKE-V3" || autopilot || graph_hash || operator ||
/// active_auth)` (audit 4, A4-3: `active_auth` is the `Authorization` that
/// activated the graph, `Autopilot::active_auth`).
pub fn revoke_payload(
    autopilot: &Pubkey,
    graph_hash: &[u8; 32],
    operator: &Pubkey,
    active_auth: &Pubkey,
) -> [u8; 32] {
    sha256(&[
        OPERATOR_REVOKE_DOMAIN,
        autopilot.as_ref(),
        graph_hash,
        operator.as_ref(),
        active_auth.as_ref(),
    ])
}

/// The autopilot's `Autopilot` account (borsh after the discriminator), as
/// clients read it: (field, length) in order. Audit 4 appended
/// `activeAuth`, `activeActivateAt` and `partialSpent` (16 nodes).
pub const AUTOPILOT_ACCOUNT_FIELDS: [(&str, usize); 27] = [
    ("discriminator", 8),
    ("version", 1),
    ("bump", 1),
    ("treasuryBump", 1),
    ("launch", 32),
    ("mint", 32),
    ("dammPool", 32),
    ("activeGraph", 32),
    ("pendingGraph", 32),
    ("pendingActivateAt", 8),
    ("pendingOperator", 32),
    ("activatedAt", 8),
    ("frozen", 1),
    ("operator", 32),
    ("authMarks", 3 * (8 + 32)),
    ("seq", 8),
    ("refSqrtPrice", 16),
    ("refUpdatedAt", 8),
    ("refAllowance", 8),
    ("refAllowanceAt", 8),
    ("observations", 2 * (8 + 8 + 16 + 16)),
    ("tipEpochStart", 8),
    ("tipsInEpoch", 8),
    ("nodes", 16 * (8 + 8 + 8 + 2 + 8)),
    ("activeAuth", 32),
    ("activeActivateAt", 8),
    ("partialSpent", 16 * 8),
];

/// What `attest_launch` reads of a launch, plus its address bump and status.
#[derive(Clone, Copy, Debug)]
pub struct LaunchFields {
    pub bump: u8,
    /// `Live` (1) instead of `Configured` (0).
    pub live: bool,
    pub launch_seed: [u8; 32],
    pub creator: Pubkey,
    pub params_hash: [u8; 32],
    pub pq_identity: [u8; 32],
}

/// `Launch` v2 account bytes: the fields of [`LaunchFields`] at their
/// documented offsets, every other field zero (DBC config, authorities,
/// mint, pool, treasury, recipients, timeline and batch totals, which
/// `attest_launch` never reads).
pub fn launch_account_data(f: &LaunchFields) -> Vec<u8> {
    let mut d = Vec::with_capacity(LAUNCH_ACCOUNT_LEN);
    d.extend_from_slice(&anchor_discriminator("account", "Launch"));
    d.push(LAUNCH_VERSION);
    d.push(f.bump);
    d.extend_from_slice(&[0; 3]); // authority, batch and config bumps
    assert_eq!(d.len(), LAUNCH_STATUS_OFFSET);
    d.push(u8::from(f.live));
    d.extend_from_slice(&f.launch_seed);
    assert_eq!(d.len(), LAUNCH_CREATOR_OFFSET);
    d.extend_from_slice(f.creator.as_ref());
    // dbc_config, launch_authority, batch_authority, base_mint, pool, treasury
    d.extend_from_slice(&[0; 6 * 32]);
    d.extend_from_slice(&[0; 2]); // platform_fee_bps
    d.extend_from_slice(&[0; 4 * (32 + 2)]); // recipients
                                             // recipient_count, token_decimal, migration_quote_threshold,
                                             // migration_fee_option, open_delay_secs, guard_secs, max_wallet_bps,
                                             // max_buy_bps, p2p_locked, batch_wallet_cap, batch_total_cap
    d.extend_from_slice(&[0; 1 + 1 + 8 + 1 + 4 + 4 + 2 + 2 + 1 + 8 + 8]);
    assert_eq!(d.len(), LAUNCH_PARAMS_HASH_OFFSET);
    d.extend_from_slice(&f.params_hash);
    // launch_ts, commit_end_ts, execute_end_ts, guard_end_ts,
    // total_committed, executed, quote_spent, tokens_out, tokens_claimed,
    // quote_refunded
    d.extend_from_slice(&[0; 4 * 8 + 8 + 1 + 4 * 8]);
    assert_eq!(d.len(), LAUNCH_PQ_IDENTITY_OFFSET);
    d.extend_from_slice(&f.pq_identity);
    assert_eq!(d.len(), LAUNCH_ACCOUNT_LEN);
    d
}

/// `Identity` account bytes: `used_count` is the number of bits set.
pub fn identity_account_data(
    bump: u8,
    public_key: &[u8; 56],
    used: &[u8; LEAF_BITMAP_LEN],
) -> Vec<u8> {
    let count: u32 = used.iter().map(|b| b.count_ones()).sum();
    let mut d = anchor_discriminator("account", "Identity").to_vec();
    d.push(1); // version
    d.push(bump);
    d.extend_from_slice(public_key);
    d.extend_from_slice(used);
    d.extend_from_slice(&u16::try_from(count).expect("at most 1,024").to_le_bytes());
    assert_eq!(d.len(), IDENTITY_ACCOUNT_LEN);
    d
}

/// The first attestation of a launch, as `attest_launch` writes it.
#[derive(Clone, Debug)]
pub struct AttestationRecord {
    pub bump: u8,
    pub launch: Pubkey,
    pub pq_identity: [u8; 32],
    pub leaf: u16,
    pub metadata_hash: [u8; 32],
    pub message_hash: [u8; 32],
    pub slot: u64,
    pub terms: Terms,
    pub signature: Vec<u8>,
}

/// `Attestation` account bytes.
pub fn attestation_account_data(a: &AttestationRecord) -> Vec<u8> {
    let mut d = anchor_discriminator("account", "Attestation").to_vec();
    d.push(ATTESTATION_VERSION);
    d.push(a.bump);
    d.extend_from_slice(a.launch.as_ref());
    d.extend_from_slice(&a.pq_identity);
    d.extend_from_slice(&a.leaf.to_le_bytes());
    d.extend_from_slice(&a.metadata_hash);
    d.extend_from_slice(&a.terms.rules_hash);
    d.extend_from_slice(&a.message_hash);
    d.extend_from_slice(&a.slot.to_le_bytes());
    d.extend_from_slice(&a.terms.not_before.to_le_bytes());
    d.extend_from_slice(&a.terms.not_after.to_le_bytes());
    a.signature
        .serialize(&mut d)
        .expect("borsh signature bytes");
    assert_eq!(d.len(), ATTESTATION_ACCOUNT_LEN);
    d
}

/// The bytes of an attestation account a landing created without attesting:
/// the discriminator, version 0, its bump, and zeros (an empty signature).
pub fn empty_attestation_account_data(bump: u8) -> Vec<u8> {
    let mut d = anchor_discriminator("account", "Attestation").to_vec();
    d.push(0);
    d.push(bump);
    d.resize(ATTESTATION_ACCOUNT_LEN, 0);
    d
}

/// Payload (after the discriminator) of `LaunchAttested {launch,
/// pq_identity, leaf, metadata_hash, rules_hash, slot, not_before,
/// not_after}`.
pub fn launch_attested_event(a: &AttestationRecord) -> Vec<u8> {
    [
        a.launch.as_ref(),
        &a.pq_identity,
        &a.leaf.to_le_bytes(),
        &a.metadata_hash,
        &a.terms.rules_hash,
        &a.slot.to_le_bytes(),
        &a.terms.not_before.to_le_bytes(),
        &a.terms.not_after.to_le_bytes(),
    ]
    .concat()
}

/// Payload of `MetadataPublished {launch, token_meta, metadata_hash, flags,
/// uri_len u16, doc_len u16}`.
pub fn metadata_published_event(launch: &Pubkey, m: Metadata) -> Vec<u8> {
    let hash = metadata_hash(m);
    [
        launch.as_ref(),
        token_meta_pda(launch, &hash).0.as_ref(),
        &hash,
        &[m.flags],
        &u16::try_from(m.uri.len()).expect("u16").to_le_bytes(),
        &u16::try_from(m.doc.len()).expect("u16").to_le_bytes(),
    ]
    .concat()
}

/// Payload of `PqLeafConsumed {pq_identity, leaf, launch}`.
pub fn pq_leaf_consumed_event(pq_identity: &[u8; 32], leaf: u16, launch: &Pubkey) -> Vec<u8> {
    [pq_identity.as_slice(), &leaf.to_le_bytes(), launch.as_ref()].concat()
}

/// Leaf `q`'s bit, least significant bit first: `used[q >> 3] & (1 << (q & 7))`.
pub fn leaf_used(used: &[u8; LEAF_BITMAP_LEN], q: u32) -> bool {
    used[(q >> 3) as usize] & (1 << (q & 7)) != 0
}

pub fn mark_leaf(used: &mut [u8; LEAF_BITMAP_LEN], q: u32) {
    used[(q >> 3) as usize] |= 1 << (q & 7);
}

/// The leaf probe's start for a message signed by the key whose identifier
/// is `i` (`public_key[8..24]`): `u16be(SHA256(tag || I || message)[0..2])
/// mod 1024`. One message always starts at the same leaf; different
/// messages for one launch almost never do.
pub fn leaf_probe_start(i: &[u8], message: &[u8]) -> u32 {
    let h = sha256(&[LEAF_PROBE_TAG, i, message]);
    u32::from(u16::from_be_bytes([h[0], h[1]])) % LEAVES
}

/// The choice of leaf: the first clear bit from `start`, stepping +1 with
/// wrap-around; `None` when the identity is exhausted.
pub fn next_free_leaf(used: &[u8; LEAF_BITMAP_LEN], start: u32) -> Option<u32> {
    (0..LEAVES)
        .map(|i| (start + i) % LEAVES)
        .find(|&q| !leaf_used(used, q))
}

/// Apply a vector's byte patch (`lms.json`, `rejections`) to `bytes`: a list
/// of `{"op": "set" | "xor", "offset", "hex"}`, `{"op": "truncate",
/// "length"}` and `{"op": "append", "hex"}`, in order.
pub fn apply_patch(bytes: &[u8], ops: &Value) -> Vec<u8> {
    let mut out = bytes.to_vec();
    for op in ops.as_array().expect("patch: a list of operations") {
        let hex = || unhex(op["hex"].as_str().expect("patch hex"));
        let offset = || usize::try_from(op["offset"].as_u64().expect("offset")).expect("offset");
        match op["op"].as_str().expect("patch op") {
            "set" => {
                let (at, b) = (offset(), hex());
                out[at..at + b.len()].copy_from_slice(&b);
            }
            "xor" => {
                let (at, b) = (offset(), hex());
                for (o, x) in out[at..at + b.len()].iter_mut().zip(b) {
                    *o ^= x;
                }
            }
            "truncate" => {
                out.truncate(usize::try_from(op["length"].as_u64().expect("length")).unwrap())
            }
            "append" => out.extend_from_slice(&hex()),
            other => panic!("unknown patch op {other}"),
        }
    }
    out
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn unhex(s: &str) -> Vec<u8> {
    assert!(s.len().is_multiple_of(2), "odd hex length");
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
        .collect()
}

impl Harness {
    /// Place a `Launch` v2 account at `address` (owned by the launchpad,
    /// rent-exempt), as `create_launch` would have left one.
    pub fn place_launch(&mut self, address: &Pubkey, fields: &LaunchFields) {
        let data = launch_account_data(fields);
        self.place_launchpad_account(address, data);
    }

    /// Put `data` at `address`, owned by the launchpad program.
    pub fn place_launchpad_account(&mut self, address: &Pubkey, data: Vec<u8>) {
        self.place_account(address, data, &LAUNCHPAD_PROGRAM_ID);
    }

    /// Put `data` at `address`, owned by `owner`, rent-exempt.
    pub fn place_account(&mut self, address: &Pubkey, data: Vec<u8>, owner: &Pubkey) {
        let account = Account {
            lamports: self.rent_exempt(data.len()),
            data,
            owner: *owner,
            executable: false,
            rent_epoch: 0,
        };
        self.set_account(*address, account);
    }

    /// Remove the account at `address` (no lamports, no data).
    pub fn remove_account(&mut self, address: &Pubkey) {
        self.set_account(*address, Account::default());
    }

    /// The leaf bitmap and `used_count` of the identity account at
    /// `identity` (all clear and 0 before its first signature lands).
    pub fn identity_leaves(&self, identity: &Pubkey) -> ([u8; LEAF_BITMAP_LEN], u16) {
        match self.account(identity) {
            None => ([0; LEAF_BITMAP_LEN], 0),
            Some(a) => {
                assert_eq!(a.data.len(), IDENTITY_ACCOUNT_LEN, "identity length");
                (
                    a.data[66..66 + LEAF_BITMAP_LEN].try_into().unwrap(),
                    u16::from_le_bytes([a.data[194], a.data[195]]),
                )
            }
        }
    }

    /// Sign `message` with `key` at the leaf a client picks (A13): the first
    /// leaf still clear on-chain from the message's probe start. Returns the
    /// signature and its leaf.
    pub fn sign_next(&self, key: &LmsKeyPair, message: &[u8]) -> (Vec<u8>, u32) {
        let pk = key.public_key().to_bytes();
        let (used, _) = self.identity_leaves(&identity_pda(&identity_id(&pk)).0);
        let q = next_free_leaf(&used, leaf_probe_start(&pk[8..24], message))
            .expect("the identity has a free leaf");
        let signature = key.sign_deterministic::<Sha2>(q, message).expect("sign");
        (signature, q)
    }
}

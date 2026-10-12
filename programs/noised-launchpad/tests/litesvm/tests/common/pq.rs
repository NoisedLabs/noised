//! The creator's post-quantum identity, as the SDK uses it (PQ v2,
//! amendments A5, A12-A14, and the review's fixes, with the on-chain
//! metadata record): one LMS key per test binary, the metadata record
//! (`publish_metadata`) and its hash, the creator rules record
//! (`publish_rules`) and its hash, the attestation message (version 3)
//! rebuilt here from its documented layout (configuration, the records'
//! hashes and the launch window), the leaf chosen from the message and the
//! on-chain bitmap, and `publish_metadata` / `publish_rules` then
//! `attest_launch` in v1 transactions from a throwaway fee payer; and the
//! generic authorizations (`pq_authorize`) by the same identity.

use std::sync::OnceLock;

use anchor_lang::{
    system_program, AnchorSerialize, Discriminator, InstructionData, ToAccountMetas,
};
use noised_launchpad::{
    accounts as acc,
    constants::{
        ATTESTATION_SEED, AUTH_SEED, IDENTITY_SEED, MAX_LAUNCH_WINDOW_SECS, METADATA_SEED,
        META_FLAG_EXTERNAL_URI, RULES_SEED,
    },
    instruction as ix,
    state::{Authorization, Identity, Launch, LaunchRules, TokenMeta},
};
use noised_lmots::{LmsKeyPair, LmsPrivateKey, Sha2, Sha256, LMS_LEAVES};
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_message::v1;
use solana_signer::Signer;

use super::{launch::Keys, Env, Expect, Failed, Pubkey, Sent, LAMPORTS_PER_SOL};

/// v1 config words of an attestation (A14): unset words mean 0, so both
/// limits are set.
pub const ATTEST_CU_LIMIT: u32 = 300_000;
pub const ATTEST_LOADED_ACCOUNTS_DATA_LIMIT: u32 = 2 * 1024 * 1024;
/// v1 config words of a `publish_metadata` (the same loaded-data word).
pub const PUBLISH_CU_LIMIT: u32 = 100_000;
/// What a client funds its throwaway attestation payer with: the identity
/// and attestation rents plus fees.
pub const ATTEST_PAYER_LAMPORTS: u64 = LAMPORTS_PER_SOL / 20;
/// What a client funds its throwaway publishing payer with: the record's
/// rent (at most 3,405 bytes) plus fees.
pub const PUBLISH_PAYER_LAMPORTS: u64 = LAMPORTS_PER_SOL / 20;
/// The SDK's cluster byte for localnet (A12).
pub const CLUSTER_LOCALNET: u8 = 2;
/// The attestation message: `"PHX-ATTEST-V3" || program || launch ||
/// params_hash || creator || metadata_hash || rules_hash ||
/// i64le(not_before) || i64le(not_after)`.
pub const ATTEST_MESSAGE_LEN: usize = 221;
/// The authorization message: `"PHX-AUTH-V1" || program || launch ||
/// creator || kind || payload_hash`.
pub const AUTH_MESSAGE_LEN: usize = 140;

pub fn attest_config() -> v1::TransactionConfig {
    v1::TransactionConfig::empty()
        .with_compute_unit_limit(ATTEST_CU_LIMIT)
        .with_loaded_accounts_data_size_limit(ATTEST_LOADED_ACCOUNTS_DATA_LIMIT)
}

pub fn publish_config() -> v1::TransactionConfig {
    v1::TransactionConfig::empty()
        .with_compute_unit_limit(PUBLISH_CU_LIMIT)
        .with_loaded_accounts_data_size_limit(ATTEST_LOADED_ACCOUNTS_DATA_LIMIT)
}

pub fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    Sha2::hashv(parts)
}

/// A deterministic stand-in for a PQ recovery phrase's 64-byte BIP-39 seed.
pub fn master_seed(label: &str) -> [u8; 64] {
    let mut m = [0u8; 64];
    m[..32].copy_from_slice(&sha256(&[b"phalanx-lp-test/master/0", label.as_bytes()]));
    m[32..].copy_from_slice(&sha256(&[b"phalanx-lp-test/master/1", label.as_bytes()]));
    m
}

/// Identity `index` of the test creator's phrase on localnet (A12).
pub fn identity_key(index: u32) -> LmsPrivateKey {
    LmsPrivateKey::derive_identity::<Sha2>(&master_seed("creator"), CLUSTER_LOCALNET, index)
        .expect("identity derivation")
}

/// The test creator's identity 0, generated once per test binary (a key
/// generation is about 1.14 million SHA-256 compressions).
pub fn identity() -> &'static LmsKeyPair {
    static KEY: OnceLock<LmsKeyPair> = OnceLock::new();
    KEY.get_or_init(|| identity_key(0).keygen::<Sha2>())
}

/// A second identity (the same phrase's index 1: another creator, or the
/// creator's next identity), also generated once.
pub fn other_identity() -> &'static LmsKeyPair {
    static KEY: OnceLock<LmsKeyPair> = OnceLock::new();
    KEY.get_or_init(|| identity_key(1).keygen::<Sha2>())
}

/// `u32be(6) || u32be(3) || I || T[1]`.
pub fn public_key(kp: &LmsKeyPair) -> [u8; 56] {
    kp.public_key().to_bytes()
}

/// `SHA256(0x21 || pk)`, written out from its definition.
pub fn identity_id_of(pk: &[u8; 56]) -> [u8; 32] {
    sha256(&[&[0x21], pk])
}

/// The test creator's `pq_identity`.
pub fn identity_id() -> [u8; 32] {
    identity_id_of(&public_key(identity()))
}

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &noised_launchpad::ID).0
}

/// `["identity", pq_identity]`.
pub fn identity_pda(pq_identity: &[u8; 32]) -> Pubkey {
    pda(&[IDENTITY_SEED, pq_identity])
}

/// `["attestation", launch]`.
pub fn attestation_pda(launch: &Pubkey) -> Pubkey {
    pda(&[ATTESTATION_SEED, launch.as_ref()])
}

/// A metadata record as `publish_metadata` takes it (name, symbol, flags,
/// uri, document; bytes, so that records no client could publish can be
/// signed too) and as `attest_launch` signs it (its hash).
#[derive(Clone, Copy, Debug)]
pub struct Meta<'a> {
    pub name: &'a [u8],
    pub symbol: &'a [u8],
    pub flags: u8,
    pub uri: &'a [u8],
    pub doc: &'a [u8],
}

/// `(name, symbol, uri)`: the record with that external uri
/// (`META_FLAG_EXTERNAL_URI`) and no document, or with neither when the uri
/// is empty; the mint then gets exactly that uri.
impl<'a> From<(&'a str, &'a str, &'a str)> for Meta<'a> {
    fn from((name, symbol, uri): (&'a str, &'a str, &'a str)) -> Self {
        Meta::from((name.as_bytes(), symbol.as_bytes(), uri.as_bytes()))
    }
}

impl<'a> From<(&'a [u8], &'a [u8], &'a [u8])> for Meta<'a> {
    fn from((name, symbol, uri): (&'a [u8], &'a [u8], &'a [u8])) -> Self {
        let flags = if uri.is_empty() {
            0
        } else {
            META_FLAG_EXTERNAL_URI
        };
        Meta {
            name,
            symbol,
            flags,
            uri,
            doc: b"",
        }
    }
}

/// `SHA256("PHX-META-V2" || u32le(len) || name || u32le(len) || symbol ||
/// flags || u32le(len) || uri || u32le(len) || doc)`: the record's borsh
/// encoding (the same for strings and bytes) after the tag.
pub fn metadata_hash<'a>(meta: impl Into<Meta<'a>>) -> [u8; 32] {
    let m = meta.into();
    let len = |b: &[u8]| (b.len() as u32).to_le_bytes();
    sha256(&[
        b"PHX-META-V2",
        &len(m.name),
        m.name,
        &len(m.symbol),
        m.symbol,
        &[m.flags],
        &len(m.uri),
        m.uri,
        &len(m.doc),
        m.doc,
    ])
}

/// `["metadata", launch, metadata_hash]`: where the record lives.
pub fn token_meta_pda(launch: &Pubkey, metadata_hash: &[u8; 32]) -> Pubkey {
    pda(&[METADATA_SEED, launch.as_ref(), metadata_hash])
}

/// The record of launch `k` with this content.
pub fn token_meta_of<'a>(k: &Keys, meta: impl Into<Meta<'a>>) -> Pubkey {
    token_meta_pda(&k.launch, &metadata_hash(meta))
}

/// What a signature attests besides the launch and its metadata record: the
/// launch window (unix seconds, inclusive) and the creator rules (their
/// hash, all zero for none).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Terms {
    pub not_before: i64,
    pub not_after: i64,
    pub rules_hash: [u8; 32],
}

impl Terms {
    /// What the SDK signs by default: a window that opens now and lasts as
    /// long as the program allows (an hour), and no rules.
    pub fn now(env: &Env) -> Self {
        Terms::window(env.now(), env.now() + MAX_LAUNCH_WINDOW_SECS)
    }

    /// This window, no rules.
    pub fn window(not_before: i64, not_after: i64) -> Self {
        Terms {
            not_before,
            not_after,
            rules_hash: [0; 32],
        }
    }

    /// These terms with the rules whose hash is `rules_hash`.
    pub fn with_rules(self, rules_hash: [u8; 32]) -> Self {
        Terms { rules_hash, ..self }
    }
}

/// The 221-byte attestation message, rebuilt from the documented layout.
pub fn message_for(
    launch: &Pubkey,
    params_hash: &[u8; 32],
    creator: &Pubkey,
    metadata_hash: &[u8; 32],
    terms: &Terms,
) -> Vec<u8> {
    let mut m = b"PHX-ATTEST-V3".to_vec();
    m.extend_from_slice(noised_launchpad::ID.as_ref());
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

/// The message of launch `k` for this metadata and these terms, from the
/// `Launch` account (as the program builds it).
pub fn message<'a>(env: &Env, k: &Keys, meta: impl Into<Meta<'a>>, terms: &Terms) -> Vec<u8> {
    let l: Launch = env.anchor(&k.launch);
    message_for(
        &k.launch,
        &l.params_hash,
        &l.creator,
        &metadata_hash(meta),
        terms,
    )
}

/// The identity account, if the launchpad has created it (lamports sent to
/// the address beforehand leave a system account there).
pub fn identity_account(env: &Env, pq_identity: &[u8; 32]) -> Option<Identity> {
    let address = identity_pda(pq_identity);
    env.account(&address)
        .filter(|a| a.owner == noised_launchpad::ID)
        .map(|_| env.anchor(&address))
}

/// Whether leaf `q` is marked used on-chain (LSB first).
pub fn leaf_used(identity: &Identity, q: u32) -> bool {
    identity.used[(q >> 3) as usize] & (1 << (q & 7)) != 0
}

/// The leaf probe's start for a message (the review's fix of A13):
/// `u16be(SHA256("phalanx/pq/identity/leaf" || I || message)[0..2]) mod
/// 1024`. The same message always starts at the same leaf (a retry signs
/// the same bytes again), and different messages for one launch (edited
/// metadata, another device) almost never start at the same leaf.
pub fn leaf_probe_start(kp: &LmsKeyPair, message: &[u8]) -> u32 {
    let pk = public_key(kp);
    let h = sha256(&[b"phalanx/pq/identity/leaf", &pk[8..24], message]);
    u32::from(u16::from_be_bytes([h[0], h[1]])) % LMS_LEAVES
}

/// The first leaf of `kp` clear in the on-chain bitmap, probing from the
/// message's start with wrap-around.
pub fn next_free_leaf(env: &Env, kp: &LmsKeyPair, message: &[u8]) -> u32 {
    let start = leaf_probe_start(kp, message);
    let identity = identity_account(env, &identity_id_of(&public_key(kp)));
    (0..LMS_LEAVES)
        .map(|i| (start + i) % LMS_LEAVES)
        .find(|&q| identity.as_ref().is_none_or(|id| !leaf_used(id, q)))
        .expect("identity exhausted")
}

/// `publish_metadata` of this record for launch `k`, paid by `payer`. The
/// data is built from the bytes (borsh strings and bytes encode alike), so
/// that even a record that is not UTF-8 can be sent.
pub fn publish_metadata_ix<'a>(payer: &Pubkey, k: &Keys, meta: impl Into<Meta<'a>>) -> Instruction {
    let m = meta.into();
    let mut data = ix::PublishMetadata::DISCRIMINATOR.to_vec();
    (
        m.name.to_vec(),
        m.symbol.to_vec(),
        m.flags,
        m.uri.to_vec(),
        m.doc.to_vec(),
    )
        .serialize(&mut data)
        .expect("borsh");
    Instruction {
        program_id: noised_launchpad::ID,
        accounts: acc::PublishMetadata {
            payer: *payer,
            launch: k.launch,
            token_meta: token_meta_of(k, m),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data,
    }
}

/// Publish this record for launch `k` as the SDK does: a v1 transaction
/// from a throwaway payer.
pub fn try_publish<'a>(env: &mut Env, k: &Keys, meta: impl Into<Meta<'a>>) -> Result<Sent, Failed> {
    let payer = Keypair::new();
    env.airdrop(&payer.pubkey(), PUBLISH_PAYER_LAMPORTS);
    let ix = publish_metadata_ix(&payer.pubkey(), k, meta);
    env.send_v1(&payer, &[ix], &[], publish_config())
}

/// `try_publish`, which must succeed.
pub fn publish<'a>(env: &mut Env, k: &Keys, meta: impl Into<Meta<'a>>) -> Sent {
    try_publish(env, k, meta).expect_ok("publish_metadata")
}

/// The record at `address`, if the launchpad has created it.
pub fn token_meta_account(env: &Env, address: &Pubkey) -> Option<TokenMeta> {
    env.account(address)
        .filter(|a| a.owner == noised_launchpad::ID)
        .map(|_| env.anchor(address))
}

/// `attest_launch` with explicit key, signature, metadata record and terms.
/// The identity account is the signing key's, `["identity", SHA256(0x21 ||
/// pk)]`, the record's is `["metadata", launch, metadata_hash]`, and the
/// rules record's `["rules", launch, rules_hash]` (the program id for no
/// rules), as a client derives them.
pub fn attest_launch_ix<'a>(
    payer: &Pubkey,
    k: &Keys,
    lms_pk: [u8; 56],
    lms_sig: Vec<u8>,
    meta: impl Into<Meta<'a>>,
    terms: &Terms,
) -> Instruction {
    let metadata_hash = metadata_hash(meta);
    Instruction {
        program_id: noised_launchpad::ID,
        accounts: acc::AttestLaunch {
            payer: *payer,
            launch: k.launch,
            identity: identity_pda(&identity_id_of(&lms_pk)),
            attestation: attestation_pda(&k.launch),
            token_meta: token_meta_pda(&k.launch, &metadata_hash),
            system_program: system_program::ID,
            rules: rules_of(&k.launch, &terms.rules_hash),
        }
        .to_account_metas(None),
        data: ix::AttestLaunch {
            lms_pk,
            lms_sig,
            metadata_hash,
            rules_hash: terms.rules_hash,
            not_before: terms.not_before,
            not_after: terms.not_after,
        }
        .data(),
    }
}

/// A signed attestation of launch `k` by `kp` at leaf `q`, with its terms.
#[derive(Clone)]
pub struct Signed {
    pub q: u32,
    pub pk: [u8; 56],
    pub sig: Vec<u8>,
    pub terms: Terms,
}

/// Sign launch `k`'s message for this metadata with `kp` at leaf `q`, with
/// the default terms (`Terms::now`). Deterministic randomizer: signing the
/// same message again gives the same bytes.
pub fn sign<'a>(env: &Env, kp: &LmsKeyPair, q: u32, k: &Keys, meta: impl Into<Meta<'a>>) -> Signed {
    sign_with(env, kp, q, k, meta, Terms::now(env))
}

/// `sign` with explicit terms.
pub fn sign_with<'a>(
    env: &Env,
    kp: &LmsKeyPair,
    q: u32,
    k: &Keys,
    meta: impl Into<Meta<'a>>,
    terms: Terms,
) -> Signed {
    let msg = message(env, k, meta, &terms);
    Signed {
        q,
        pk: public_key(kp),
        sig: kp.sign_deterministic::<Sha2>(q, &msg).expect("LMS sign"),
        terms,
    }
}

/// LM-OTS chain steps a verifier walks for this signature (RFC 8554
/// Algorithm 4b with w = 4: the sum of `15 - digit` over the 64 digits of
/// `Q = SHA256(I || u32(q) || 0x8181 || C || msg)` and its 3 checksum
/// digits). Verification cost grows with it; it is at most 990.
pub fn chain_steps(pk: &[u8; 56], sig: &[u8], msg: &[u8]) -> u32 {
    let (id, q, c) = (&pk[8..24], &sig[0..4], &sig[8..40]);
    let digest = sha256(&[id, q, &[0x81, 0x81], c, msg]);
    let digit = |bytes: &[u8], i: usize| u32::from(bytes[i / 2] >> (4 * (1 - i % 2)) & 0x0f);
    let message_steps: u32 = (0..64).map(|i| 15 - digit(&digest, i)).sum();
    let checksum = ((message_steps << 4) as u16).to_be_bytes();
    let checksum_steps: u32 = (0..3).map(|i| 15 - digit(&checksum, i)).sum();
    message_steps + checksum_steps
}

/// A throwaway fee payer funded for one attestation.
pub fn throwaway_payer(env: &mut Env) -> Keypair {
    let payer = Keypair::new();
    env.airdrop(&payer.pubkey(), ATTEST_PAYER_LAMPORTS);
    payer
}

/// Send a signed attestation as the SDK does: a v1 transaction from a
/// throwaway payer with the A14 config words.
pub fn send_attestation<'a>(
    env: &mut Env,
    k: &Keys,
    signed: &Signed,
    meta: impl Into<Meta<'a>>,
) -> Result<Sent, Failed> {
    let payer = throwaway_payer(env);
    let ix = attest_launch_ix(
        &payer.pubkey(),
        k,
        signed.pk,
        signed.sig.clone(),
        meta,
        &signed.terms,
    );
    env.send_v1(&payer, &[ix], &[], attest_config())
}

/// `SHA256("PHX-RULES-V1" || bytes)`, written out from its definition.
pub fn rules_hash(bytes: &[u8]) -> [u8; 32] {
    sha256(&[b"PHX-RULES-V1", bytes])
}

/// `["rules", launch, rules_hash]`: where a rules record lives.
pub fn rules_pda(launch: &Pubkey, rules_hash: &[u8; 32]) -> Pubkey {
    pda(&[RULES_SEED, launch.as_ref(), rules_hash])
}

/// The rules account `attest_launch` and `launch` take for this hash: its
/// record, or none (the program id) for the zero hash.
pub fn rules_of(launch: &Pubkey, rules_hash: &[u8; 32]) -> Option<Pubkey> {
    (*rules_hash != [0; 32]).then(|| rules_pda(launch, rules_hash))
}

/// `publish_rules` of these bytes for launch `k`, paid by `payer`.
pub fn publish_rules_ix(payer: &Pubkey, k: &Keys, bytes: &[u8]) -> Instruction {
    Instruction {
        program_id: noised_launchpad::ID,
        accounts: acc::PublishRules {
            payer: *payer,
            launch: k.launch,
            rules: rules_pda(&k.launch, &rules_hash(bytes)),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: ix::PublishRules {
            bytes: bytes.to_vec(),
        }
        .data(),
    }
}

/// Publish rules for launch `k` as the SDK does: a v1 transaction from a
/// throwaway payer.
pub fn try_publish_rules(env: &mut Env, k: &Keys, bytes: &[u8]) -> Result<Sent, Failed> {
    let payer = Keypair::new();
    env.airdrop(&payer.pubkey(), PUBLISH_PAYER_LAMPORTS);
    let ix = publish_rules_ix(&payer.pubkey(), k, bytes);
    env.send_v1(&payer, &[ix], &[], publish_config())
}

/// `try_publish_rules`, which must succeed.
pub fn publish_rules(env: &mut Env, k: &Keys, bytes: &[u8]) -> Sent {
    try_publish_rules(env, k, bytes).expect_ok("publish_rules")
}

/// The rules record at `address`, if the launchpad has created it.
pub fn rules_account(env: &Env, address: &Pubkey) -> Option<LaunchRules> {
    env.account(address)
        .filter(|a| a.owner == noised_launchpad::ID)
        .map(|_| env.anchor(address))
}

/// Attest launch `k` with these rules (published first unless they exist)
/// and the default window.
pub fn attest_rules<'a>(env: &mut Env, k: &Keys, meta: impl Into<Meta<'a>>, rules: &[u8]) -> Sent {
    let hash = rules_hash(rules);
    if rules_account(env, &rules_pda(&k.launch, &hash)).is_none() {
        publish_rules(env, k, rules);
    }
    let terms = Terms::now(env).with_rules(hash);
    attest_with(env, k, meta, terms)
}

/// The 140-byte authorization message, rebuilt from the documented layout.
pub fn authorization_message(
    launch: &Pubkey,
    creator: &Pubkey,
    kind: u8,
    payload_hash: &[u8; 32],
) -> Vec<u8> {
    let mut m = b"PHX-AUTH-V1".to_vec();
    m.extend_from_slice(noised_launchpad::ID.as_ref());
    m.extend_from_slice(launch.as_ref());
    m.extend_from_slice(creator.as_ref());
    m.push(kind);
    m.extend_from_slice(payload_hash);
    assert_eq!(m.len(), AUTH_MESSAGE_LEN);
    m
}

/// `["auth", launch, [kind], payload_hash]`.
pub fn auth_pda(launch: &Pubkey, kind: u8, payload_hash: &[u8; 32]) -> Pubkey {
    pda(&[AUTH_SEED, launch.as_ref(), &[kind], payload_hash])
}

/// `pq_authorize` with explicit key and signature, paid by `payer`.
pub fn pq_authorize_ix(
    payer: &Pubkey,
    launch: &Pubkey,
    lms_pk: [u8; 56],
    lms_sig: Vec<u8>,
    kind: u8,
    payload_hash: [u8; 32],
) -> Instruction {
    Instruction {
        program_id: noised_launchpad::ID,
        accounts: acc::PqAuthorize {
            payer: *payer,
            launch: *launch,
            identity: identity_pda(&identity_id_of(&lms_pk)),
            authorization: auth_pda(launch, kind, &payload_hash),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: ix::PqAuthorize {
            lms_pk,
            lms_sig,
            kind,
            payload_hash,
        }
        .data(),
    }
}

/// The authorization message of `launch` (its creator read from the
/// `Launch` account) for `kind` over `payload_hash`.
pub fn auth_message(env: &Env, launch: &Pubkey, kind: u8, payload_hash: &[u8; 32]) -> Vec<u8> {
    let l: Launch = env.anchor(launch);
    authorization_message(launch, &l.creator, kind, payload_hash)
}

/// Sign and land an authorization by `kp` at its next free leaf, as the SDK
/// does: a v1 transaction from a throwaway payer with the attestation's
/// config words.
pub fn try_authorize_by(
    env: &mut Env,
    kp: &LmsKeyPair,
    launch: &Pubkey,
    kind: u8,
    payload_hash: [u8; 32],
) -> Result<Sent, Failed> {
    let msg = auth_message(env, launch, kind, &payload_hash);
    let q = next_free_leaf(env, kp, &msg);
    let sig = kp.sign_deterministic::<Sha2>(q, &msg).expect("LMS sign");
    let payer = throwaway_payer(env);
    let ix = pq_authorize_ix(
        &payer.pubkey(),
        launch,
        public_key(kp),
        sig,
        kind,
        payload_hash,
    );
    env.send_v1(&payer, &[ix], &[], attest_config())
}

/// An authorization by the test creator's identity, which must land;
/// returns its address.
pub fn authorize(env: &mut Env, launch: &Pubkey, kind: u8, payload_hash: [u8; 32]) -> Pubkey {
    try_authorize_by(env, identity(), launch, kind, payload_hash).expect_ok("pq_authorize");
    auth_pda(launch, kind, &payload_hash)
}

/// The authorization at `address`, if the launchpad has created it.
pub fn authorization_account(env: &Env, address: &Pubkey) -> Option<Authorization> {
    env.account(address)
        .filter(|a| a.owner == noised_launchpad::ID)
        .map(|_| env.anchor(address))
}

/// Attest launch `k` with the test creator's identity, the default terms
/// and the leaf the message probes to, publishing the record first (as the
/// SDK does) unless it exists.
pub fn attest<'a>(env: &mut Env, k: &Keys, meta: impl Into<Meta<'a>>) -> Sent {
    let terms = Terms::now(env);
    attest_with(env, k, meta, terms)
}

/// `attest` with explicit terms.
pub fn attest_with<'a>(env: &mut Env, k: &Keys, meta: impl Into<Meta<'a>>, terms: Terms) -> Sent {
    let meta = meta.into();
    if token_meta_account(env, &token_meta_of(k, meta)).is_none() {
        publish(env, k, meta);
    }
    let msg = message(env, k, meta, &terms);
    let q = next_free_leaf(env, identity(), &msg);
    let signed = sign_with(env, identity(), q, k, meta, terms);
    send_attestation(env, k, &signed, meta).expect_ok("attest_launch")
}

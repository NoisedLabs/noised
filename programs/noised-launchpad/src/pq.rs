//! Post-quantum origin of a launch (PQ v2 §2.2): the message a creator's LMS
//! identity signs (`attest_launch`), the identity's on-chain one-time-leaf
//! bitmap, the launch window an attestation fixes, and the recognition of
//! Noised PQ vaults, which may receive the treasury's share and a
//! committer's payouts.
//!
//! The identity is an LMS key (RFC 8554 `LMS_SHA256_M32_H10` over
//! `LMOTS_SHA256_N32_W4`, `noised-lmots`): hash-based, so a quantum computer
//! that recovers every Ed25519 key still cannot sign as it. The attestation
//! message is built on-chain from the `Launch` account and the signed terms
//! alone, so a signature binds exactly what the program will launch, and
//! when:
//!
//! ```text
//! "PHX-ATTEST-V3" (13) || program_id (32) || launch (32)
//!     || launch.params_hash (32) || launch.creator (32) || metadata_hash (32)
//!     || rules_hash (32) || i64le(not_before) (8) || i64le(not_after) (8)  = 221 bytes
//! metadata_hash = SHA256("PHX-META-V2" || borsh(name) || borsh(symbol) || u8 flags
//!                        || borsh(uri) || borsh(doc))
//! rules_hash    = SHA256("PHX-RULES-V1" || PXR1 bytes), or 32 zero bytes for no rules
//! ```
//!
//! The same identity also signs generic authorizations (`pq_authorize`),
//! with the same one-time-leaf bitmap (`burn_leaf`):
//!
//! ```text
//! "PHX-AUTH-V1" (11) || program_id (32) || launch (32) || launch.creator (32)
//!     || u8 kind (1) || payload_hash (32)                                   = 140 bytes
//! ```
//!
//! `params_hash` covers every creator choice, `pq_identity` included; the DBC
//! config is a PDA of the launch derived from those parameters, and the pool
//! and mint are written once, by the single Configured-to-Live transition of
//! `launch`. The metadata is an on-chain record (`TokenMeta`) at the address
//! its `metadata_hash` names, and `launch` takes the mint's name, symbol and
//! uri from it, so the signature covers every byte any reader displays (the
//! document included, which consensus stores) and the uri mode: after an
//! elliptic-curve break nobody can launch an attested configuration under
//! other metadata. The creator rules are an on-chain record too
//! (`LaunchRules`, at the address `rules_hash` names), and `launch` installs
//! exactly them in the hook policy. The window is bound too: `launch` is
//! permissionless inside it and refused outside it, so no classical key
//! decides when a launch opens.

use anchor_lang::{prelude::*, Discriminator};
use noised_lmots::{lms_verify, LMS_PUBLIC_KEY_LEN};

use crate::{
    constants::{
        pq_vault, MAX_LAUNCH_LEAD_SECS, MAX_LAUNCH_WINDOW_SECS, METADATA_SEED,
        MIN_LAUNCH_WINDOW_SECS, RULES_SEED,
    },
    error::LaunchpadError,
    state::{Identity, LaunchRules, TokenMeta, LEAF_BITMAP_LEN},
};

/// SHA-256 through the `sol_sha256` syscall (host builds use the same API).
pub struct SolSha256;

impl noised_lmots::Sha256 for SolSha256 {
    fn hashv(parts: &[&[u8]]) -> [u8; 32] {
        solana_sha256_hasher::hashv(parts).to_bytes()
    }
}

impl noised_rules::Sha256 for SolSha256 {
    fn hashv(parts: &[&[u8]]) -> [u8; 32] {
        solana_sha256_hasher::hashv(parts).to_bytes()
    }
}

/// Domain tag that starts every attestation message (version 3: it binds
/// the creator rules; the 189-byte version 2 is retired).
pub const ATTEST_MESSAGE_TAG: &[u8; 13] = b"PHX-ATTEST-V3";
/// Domain tag of `metadata_hash_v2`.
pub const METADATA_HASH_TAG: &[u8; 11] = b"PHX-META-V2";
/// `tag || program_id || launch || params_hash || creator || metadata_hash
/// || rules_hash || not_before || not_after`.
pub const ATTEST_MESSAGE_LEN: usize = ATTEST_MESSAGE_TAG.len() + 6 * 32 + 2 * 8;
/// Domain tag of every authorization message (`pq_authorize`).
pub const AUTH_MESSAGE_TAG: &[u8; 11] = b"PHX-AUTH-V1";
/// `tag || program_id || launch || creator || kind || payload_hash`.
pub const AUTH_MESSAGE_LEN: usize = AUTH_MESSAGE_TAG.len() + 3 * 32 + 1 + 32;

const _: () = assert!(ATTEST_MESSAGE_LEN == 221);
const _: () = assert!(AUTH_MESSAGE_LEN == 140);
const _: () = assert!(LEAF_BITMAP_LEN * 8 == noised_lmots::LMS_LEAVES as usize);

/// What a signature attests besides the `Launch` account's own fields: the
/// metadata record and the creator rules `launch` will use and the window
/// `launch` may run in.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AttestedTerms {
    /// `metadata_hash_v2` of the record (which names its `TokenMeta`).
    pub metadata_hash: [u8; 32],
    /// `rules_hash` of the rules record (which names its `LaunchRules`), or
    /// `noised_rules::rules::NO_RULES_HASH` for none.
    pub rules_hash: [u8; 32],
    /// Unix seconds, inclusive.
    pub not_before: i64,
    pub not_after: i64,
}

/// `SHA256("PHX-META-V2" || u32le(len) || name || u32le(len) || symbol ||
/// flags || u32le(len) || uri || u32le(len) || doc)`: the tag, then the
/// borsh encoding of a `TokenMeta`'s content, in its field order. It is the
/// record's address seed, so one hash names exactly one content.
pub fn metadata_hash_v2(name: &[u8], symbol: &[u8], flags: u8, uri: &[u8], doc: &[u8]) -> [u8; 32] {
    let len = |s: &[u8]| (s.len() as u32).to_le_bytes();
    solana_sha256_hasher::hashv(&[
        METADATA_HASH_TAG,
        &len(name),
        name,
        &len(symbol),
        symbol,
        &[flags],
        &len(uri),
        uri,
        &len(doc),
        doc,
    ])
    .to_bytes()
}

/// The address of the metadata record `metadata_hash` names for `launch`,
/// `["metadata", launch, metadata_hash]`, and its bump (the canonical one,
/// which `publish_metadata` creates the record with and stores).
pub fn metadata_record_address(launch: &Pubkey, metadata_hash: &[u8; 32]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[METADATA_SEED, launch.as_ref(), metadata_hash], &crate::ID)
}

/// Whether `info`, the account at `metadata_record_address(launch,
/// metadata_hash)` (the caller checks the address; `bump` is its bump), is
/// the metadata record that hash names: owned by this program, a `TokenMeta`
/// of version 1 for that launch and hash, storing that bump. Only
/// `publish_metadata` writes such an account, whole and after validating it,
/// at the address its content hashes to; so the record exists, is valid and
/// is exactly the content the hash names. Reads the fixed fields in place;
/// never fails (a valid signature must always land, to burn its leaf).
pub fn is_metadata_record(
    info: &AccountInfo,
    launch: &Pubkey,
    metadata_hash: &[u8; 32],
    bump: u8,
) -> bool {
    if *info.owner != crate::ID {
        return false;
    }
    let Ok(data) = info.try_borrow_data() else {
        return false;
    };
    let launch_at = TokenMeta::LAUNCH_OFFSET;
    let hash_at = TokenMeta::METADATA_HASH_OFFSET;
    data.len() >= TokenMeta::FIXED_LEN
        && data[..8] == *TokenMeta::DISCRIMINATOR
        && data[TokenMeta::VERSION_OFFSET] == TokenMeta::VERSION
        && data[TokenMeta::BUMP_OFFSET] == bump
        && data[launch_at..launch_at + 32] == launch.to_bytes()
        && data[hash_at..hash_at + 32] == *metadata_hash
}

/// `SHA256("PHX-RULES-V1" || bytes)`: the rules record's address seed
/// (`noised_rules::rules_hash` on the `sol_sha256` syscall).
pub fn rules_hash(bytes: &[u8]) -> [u8; 32] {
    noised_rules::rules_hash::<SolSha256>(bytes)
}

/// The address of the rules record `rules_hash` names for `launch`,
/// `["rules", launch, rules_hash]`, and its bump (the canonical one, which
/// `publish_rules` creates the record with and stores).
pub fn rules_record_address(launch: &Pubkey, rules_hash: &[u8; 32]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[RULES_SEED, launch.as_ref(), rules_hash], &crate::ID)
}

/// Whether `info`, the account at `rules_record_address(launch,
/// rules_hash)` (the caller checks the address; `bump` is its bump), is the
/// rules record that hash names: owned by this program, a `LaunchRules` of
/// version 1 for that launch and hash, storing that bump. Only
/// `publish_rules` writes such an account, whole and after verifying the
/// rules for the launch's guard, at the address its content hashes to; so
/// the record exists, verifies and is exactly the content the hash names.
/// Reads the fixed fields in place; never fails (a valid signature must
/// always land, to burn its leaf).
pub fn is_rules_record(
    info: &AccountInfo,
    launch: &Pubkey,
    rules_hash: &[u8; 32],
    bump: u8,
) -> bool {
    if *info.owner != crate::ID {
        return false;
    }
    let Ok(data) = info.try_borrow_data() else {
        return false;
    };
    let launch_at = LaunchRules::LAUNCH_OFFSET;
    let hash_at = LaunchRules::RULES_HASH_OFFSET;
    data.len() >= LaunchRules::FIXED_LEN
        && data[..8] == *LaunchRules::DISCRIMINATOR
        && data[LaunchRules::VERSION_OFFSET] == LaunchRules::VERSION
        && data[LaunchRules::BUMP_OFFSET] == bump
        && data[launch_at..launch_at + 32] == launch.to_bytes()
        && data[hash_at..hash_at + 32] == *rules_hash
}

/// `parts` back to back; their lengths add up to `N`.
fn concat<const N: usize>(parts: &[&[u8]]) -> [u8; N] {
    let mut message = [0u8; N];
    let mut at = 0;
    for part in parts {
        message[at..at + part.len()].copy_from_slice(part);
        at += part.len();
    }
    message
}

/// The 221-byte message a launch's identity signs (see the module docs).
pub fn attestation_message(
    program_id: &Pubkey,
    launch: &Pubkey,
    params_hash: &[u8; 32],
    creator: &Pubkey,
    terms: &AttestedTerms,
) -> [u8; ATTEST_MESSAGE_LEN] {
    let not_before = terms.not_before.to_le_bytes();
    let not_after = terms.not_after.to_le_bytes();
    let parts: [&[u8]; 9] = [
        ATTEST_MESSAGE_TAG,
        program_id.as_ref(),
        launch.as_ref(),
        params_hash,
        creator.as_ref(),
        &terms.metadata_hash,
        &terms.rules_hash,
        &not_before,
        &not_after,
    ];
    concat(&parts)
}

/// The 140-byte message a launch's identity signs to authorize `kind` over
/// `payload_hash` (see the module docs).
pub fn authorization_message(
    program_id: &Pubkey,
    launch: &Pubkey,
    creator: &Pubkey,
    kind: u8,
    payload_hash: &[u8; 32],
) -> [u8; AUTH_MESSAGE_LEN] {
    let parts: [&[u8]; 6] = [
        AUTH_MESSAGE_TAG,
        program_id.as_ref(),
        launch.as_ref(),
        creator.as_ref(),
        &[kind],
        payload_hash,
    ];
    concat(&parts)
}

/// Verify an LMS signature by `lms_pk` over `message` and burn the one-time
/// leaf it names in `identity`, the signing key's account (`["identity",
/// SHA256(0x21 || lms_pk)]`; `bump` is its bump), set up by the first of its
/// signatures that lands. Returns the leaf. Fails only for a signature that
/// does not verify or a leaf already used; so every valid signature of an
/// unused leaf burns it, whatever it signed (`attest_launch` and
/// `pq_authorize` share one bitmap per identity).
pub fn burn_leaf(
    identity: &mut Identity,
    bump: u8,
    lms_pk: &[u8; LMS_PUBLIC_KEY_LEN],
    message: &[u8],
    lms_sig: &[u8],
) -> Result<u16> {
    if identity.version == 0 {
        identity.version = Identity::VERSION;
        identity.bump = bump;
        identity.public_key = *lms_pk;
    } else {
        // The PDA is named by the key's hash, so only a SHA-256 collision
        // could reach this with another key.
        require!(
            identity.public_key == *lms_pk,
            LaunchpadError::InvalidPqIdentity
        );
    }
    // The leaf comes from the signature only.
    let q = lms_verify::<SolSha256>(lms_pk, message, lms_sig)
        .ok_or(LaunchpadError::InvalidPqSignature)?;
    let leaf = u16::try_from(q).map_err(|_| error!(LaunchpadError::InvalidPqSignature))?;
    require!(
        mark_leaf_used(&mut identity.used, q),
        LaunchpadError::PqLeafUsed
    );
    identity.used_count = identity
        .used_count
        .checked_add(1)
        .ok_or(LaunchpadError::MathOverflow)?;
    Ok(leaf)
}

/// Whether an attestation landing at `now` may fix this launch window: it
/// lasts `MIN_LAUNCH_WINDOW_SECS..=MAX_LAUNCH_WINDOW_SECS`, opens at most
/// `MAX_LAUNCH_LEAD_SECS` from now, and leaves `launch` at least
/// `MIN_LAUNCH_WINDOW_SECS` from the later of now and its opening
/// (`max(now, not_before) + MIN_LAUNCH_WINDOW_SECS <= not_after`), so a
/// held or late landing never fixes a window with only seconds left. (In
/// i128: no input overflows.)
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

/// Whether `launch` may run at `now` in this window (inclusive).
pub fn in_launch_window(now: i64, not_before: i64, not_after: i64) -> bool {
    (not_before..=not_after).contains(&now)
}

/// Byte index and bit mask of leaf `q` in an identity's bitmap, least
/// significant bit first (`used[q >> 3] & (1 << (q & 7))`); `None` for a
/// leaf the LMS tree does not have (`q >= 1024`).
pub fn leaf_bit(q: u32) -> Option<(usize, u8)> {
    (q < noised_lmots::LMS_LEAVES).then(|| ((q >> 3) as usize, 1u8 << (q & 7)))
}

/// Mark leaf `q` used. `false` if it already was (or does not exist):
/// nothing changes then.
pub fn mark_leaf_used(used: &mut [u8; LEAF_BITMAP_LEN], q: u32) -> bool {
    match leaf_bit(q) {
        Some((byte, bit)) if used[byte] & bit == 0 => {
            used[byte] |= bit;
            true
        }
        _ => false,
    }
}

/// Whether `info` is a Noised PQ vault of `mint`: an account of the vault
/// program with the `Vault` discriminator, version 4 and that mint. Its
/// token account for `mint` is its canonical ATA, which `open_vault`
/// created, so whatever is paid to that ATA moves only with the vault's
/// hash-based signature.
pub fn is_vault_of(info: &AccountInfo, mint: &Pubkey) -> Result<bool> {
    if *info.owner != pq_vault::PROGRAM_ID {
        return Ok(false);
    }
    let data = info.try_borrow_data()?;
    let mint_end = pq_vault::MINT_OFFSET + 32;
    Ok(data.len() >= mint_end
        && data[..8] == pq_vault::VAULT_DISCRIMINATOR
        && data[pq_vault::VERSION_OFFSET] == pq_vault::VAULT_VERSION
        && data[pq_vault::MINT_OFFSET..mint_end] == mint.to_bytes())
}

/// A payout owner of a commit is the committer itself or a PQ vault of the
/// mint it receives. Anything else would let a hook-exempt batch payout go
/// to arbitrary wallets during the guard (around `p2p_locked` and, by
/// aggregation, `max_wallet`), and a vault of another mint could never
/// release what it was sent. A vault may be named by several committers, so
/// `commit` holds what they commit for it to one wallet's cap together
/// (`["payout-vault", launch, vault]`): shares cannot add up in one account.
pub fn is_payout_owner(info: &AccountInfo, committer: &Pubkey, mint: &Pubkey) -> Result<bool> {
    Ok(info.key == committer || is_vault_of(info, mint)?)
}

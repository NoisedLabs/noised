//! The launchpad accounts the autopilot reads, by layout (the autopilot does
//! not link the launchpad): `Launch` (v2), `Certificate` (v3/v4 prefix) and
//! `Authorization` (spec §2, amendment A1). Every reader checks the owner
//! (the launchpad program), the Anchor discriminator, the version and the
//! length before it reads a byte, and fails closed. `Launch` and
//! `Certificate` are read only in the versions known here (review 4, R6b:
//! `Launch` 2, `Certificate` 3 and 4), as prefixes (the offsets read are
//! pinned against the launchpad's own types in `tests/layout_tests.rs`); a
//! later version is refused until the autopilot is updated for it.
//!
//! `Authorization` is the launchpad's generic post-quantum authorization
//! (`pq_authorize`): an LMS signature by the launch's identity over
//! `"PHX-AUTH-V1" || program || launch || creator || kind || payload_hash`,
//! verified on-chain by the launchpad, which burns the signing leaf in the
//! identity's bitmap and writes the account once, at
//! `["auth", launch, [kind], payload_hash]`. Its exact layout is below
//! (`authorization`); the launchpad must write exactly these bytes:
//!
//! ```text
//! offset  size  field
//! 0       8     discriminator = sha256("account:Authorization")[..8]
//! 8       1     version = 1
//! 9       1     bump (of ["auth", launch, [kind], payload_hash])
//! 10      32    launch
//! 42      32    pq_identity (= the launch's)
//! 74      1     kind (1 GRAPH_ACTIVATE, 2 GRAPH_FREEZE, 3 OPERATOR_REVOKE)
//! 75      32    payload_hash
//! 107     32    message_hash = SHA256(the 140-byte PHX-AUTH-V1 message)
//! 139     8     unix_time (i64, when it landed)
//! 147     8     slot (u64, when it landed)
//! 155     2     leaf (u16, the LMS leaf that signed)
//! 157     4     sig_len (u32) = 2,508
//! 161     2508  signature (the LMS signature)
//! = 2,669 bytes (Anchor/borsh: `signature: Vec<u8>` of exactly 2,508 bytes)
//! ```
//!
//! Payload hashes (what the identity authorizes; `autopilot` is the
//! `["autopilot", launch]` address, integers little-endian):
//!
//! ```text
//! GRAPH_ACTIVATE  SHA256("PHX-GRAPH-ACT-V1" || autopilot || graph_hash || i64 activate_at)
//! GRAPH_FREEZE    SHA256("PHX-GRAPH-FRZ-V2" || autopilot || graph_hash || i64 not_after)
//! OPERATOR_REVOKE SHA256("PHX-OP-REVOKE-V3" || autopilot || graph_hash || operator || active_auth)
//! ```
//!
//! A freeze names the last time it may be used (`not_after`, review 4, R5):
//! a freeze authorization that is landed and then withheld cannot be used
//! at a time its signer did not choose.
//!
//! A revocation names the graph it revokes the operator of (the active one
//! when it is used) and the authorization that activated that graph
//! (`Autopilot::active_auth`; audit 4, A4-3, payload version 3): it binds
//! the current activation, so it can never be replayed against a later
//! activation that appoints the same operator again, even of the same
//! graph, and every new activation can be revoked by a new revocation.
//!
//! The launchpad must take `unix_time` and `slot` from the `Clock` sysvar
//! (never from instruction arguments: they drive the timelock and the order
//! in which authorizations may be used) and create the account at the
//! canonical bump, which it stores.

use noised_onchain::AccountView;

use crate::{constants::LAUNCHPAD_PROGRAM_ID, error::AutopilotError, ProgramError, Pubkey, Result};

/// Little-endian readers over a slice whose length the caller checked;
/// out-of-range reads fail closed instead of panicking.
pub(crate) fn bytes32(data: &[u8], at: usize) -> Result<[u8; 32]> {
    data.get(at..at + 32)
        .and_then(|s| s.try_into().ok())
        .ok_or(AutopilotError::MathOverflow)
}

pub(crate) fn read_u8(data: &[u8], at: usize) -> Result<u8> {
    data.get(at).copied().ok_or(AutopilotError::MathOverflow)
}

pub(crate) fn read_u32(data: &[u8], at: usize) -> Result<u32> {
    data.get(at..at + 4)
        .and_then(|s| s.try_into().ok())
        .map(u32::from_le_bytes)
        .ok_or(AutopilotError::MathOverflow)
}

pub(crate) fn read_u64(data: &[u8], at: usize) -> Result<u64> {
    data.get(at..at + 8)
        .and_then(|s| s.try_into().ok())
        .map(u64::from_le_bytes)
        .ok_or(AutopilotError::MathOverflow)
}

pub(crate) fn read_i64(data: &[u8], at: usize) -> Result<i64> {
    read_u64(data, at).map(|v| v as i64)
}

pub(crate) fn read_u128(data: &[u8], at: usize) -> Result<u128> {
    data.get(at..at + 16)
        .and_then(|s| s.try_into().ok())
        .map(u128::from_le_bytes)
        .ok_or(AutopilotError::MathOverflow)
}

/// `noised_launchpad::state::Launch`: version 2 is 585 bytes.
pub mod launch {
    /// `sha256("account:Launch")[..8]`.
    pub const DISCRIMINATOR: [u8; 8] = [144, 51, 51, 163, 206, 85, 213, 38];
    /// The versions read: 2 up to the launchpad's current `Launch::VERSION`
    /// (pinned in `tests/layout_tests.rs`).
    pub const MIN_VERSION: u8 = 2;
    pub const MAX_VERSION: u8 = 2;
    pub const MIN_LEN: usize = 585;
    pub const VERSION_OFFSET: usize = 8;
    pub const STATUS_OFFSET: usize = 13;
    pub const DBC_CONFIG_OFFSET: usize = 78;
    pub const BASE_MINT_OFFSET: usize = 174;
    pub const PQ_IDENTITY_OFFSET: usize = 553;
    /// `LaunchStatus::Live` (borsh enum index).
    pub const STATUS_LIVE: u8 = 1;
}

/// `noised_launchpad::state::Certificate`: the prefix up to `checks`, which
/// versions 3 and 4 share (version 4 appends `rules_hash`).
pub mod certificate {
    /// `sha256("account:Certificate")[..8]`.
    pub const DISCRIMINATOR: [u8; 8] = [202, 229, 222, 220, 116, 20, 74, 67];
    pub const MIN_VERSION: u8 = 3;
    pub const MAX_VERSION: u8 = 4;
    pub const VERSION_OFFSET: usize = 8;
    pub const LAUNCH_OFFSET: usize = 10;
    pub const BASE_MINT_OFFSET: usize = 42;
    pub const CHECKS_OFFSET: usize = 187;
    /// Bytes through `checks`.
    pub const PREFIX_LEN: usize = 191;
    /// `checks::ALL`: every safety check `launch` requires.
    pub const CHECKS_ALL: u32 = 4_095;
    /// `["certificate", base_mint]` under the launchpad.
    pub const SEED: &[u8] = b"certificate";
}

/// The launchpad's `Authorization` (spec §2 `pq_authorize`, amendment A1).
pub mod authorization {
    /// `sha256("account:Authorization")[..8]`.
    pub const DISCRIMINATOR: [u8; 8] = [3, 68, 168, 243, 195, 168, 32, 75];
    pub const VERSION: u8 = 1;
    /// `["auth", launch, [kind], payload_hash]` under the launchpad.
    pub const SEED: &[u8] = b"auth";
    pub const VERSION_OFFSET: usize = 8;
    pub const BUMP_OFFSET: usize = 9;
    pub const LAUNCH_OFFSET: usize = 10;
    pub const PQ_IDENTITY_OFFSET: usize = 42;
    pub const KIND_OFFSET: usize = 74;
    pub const PAYLOAD_HASH_OFFSET: usize = 75;
    pub const MESSAGE_HASH_OFFSET: usize = 107;
    pub const UNIX_TIME_OFFSET: usize = 139;
    pub const SLOT_OFFSET: usize = 147;
    pub const LEAF_OFFSET: usize = 155;
    pub const SIG_LEN_OFFSET: usize = 157;
    pub const SIGNATURE_OFFSET: usize = 161;
    /// `noised_lmots::LMS_SIG_LEN`.
    pub const SIG_LEN: usize = 2_508;
    pub const LEN: usize = SIGNATURE_OFFSET + SIG_LEN;

    /// What an authorization authorizes.
    pub mod kind {
        pub const GRAPH_ACTIVATE: u8 = 1;
        pub const GRAPH_FREEZE: u8 = 2;
        pub const OPERATOR_REVOKE: u8 = 3;
    }

    /// Payload-hash domains (16 bytes each).
    pub const ACTIVATE_DOMAIN: &[u8; 16] = b"PHX-GRAPH-ACT-V1";
    pub const FREEZE_DOMAIN: &[u8; 16] = b"PHX-GRAPH-FRZ-V2";
    pub const REVOKE_DOMAIN: &[u8; 16] = b"PHX-OP-REVOKE-V3";
}

/// What the autopilot uses of a `Launch`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LaunchView {
    pub live: bool,
    pub dbc_config: Pubkey,
    /// Default until the launch is live.
    pub base_mint: Pubkey,
    pub pq_identity: [u8; 32],
}

/// Decode the fields the autopilot uses from a `Launch` account's bytes.
pub fn parse_launch(owner: &Pubkey, data: &[u8]) -> Result<LaunchView, ProgramError> {
    require_keys_eq!(*owner, LAUNCHPAD_PROGRAM_ID, AutopilotError::NotALaunch);
    require!(
        data.len() >= launch::MIN_LEN && data[..8] == launch::DISCRIMINATOR,
        AutopilotError::NotALaunch
    );
    let version = read_u8(data, launch::VERSION_OFFSET)?;
    require!(
        (launch::MIN_VERSION..=launch::MAX_VERSION).contains(&version),
        AutopilotError::NotALaunch
    );
    Ok(LaunchView {
        live: read_u8(data, launch::STATUS_OFFSET)? == launch::STATUS_LIVE,
        dbc_config: Pubkey::new_from_array(bytes32(data, launch::DBC_CONFIG_OFFSET)?),
        base_mint: Pubkey::new_from_array(bytes32(data, launch::BASE_MINT_OFFSET)?),
        pq_identity: bytes32(data, launch::PQ_IDENTITY_OFFSET)?,
    })
}

pub fn read_launch(info: &AccountView) -> Result<LaunchView, ProgramError> {
    let data = info.try_borrow()?;
    parse_launch(info.owner(), &data)
}

/// Check a certificate's bytes: the launchpad's, for `launch` and `mint`,
/// with every safety check `launch` requires.
pub fn check_certificate(
    owner: &Pubkey,
    data: &[u8],
    launch_key: &Pubkey,
    mint: &Pubkey,
) -> Result<(), ProgramError> {
    require_keys_eq!(
        *owner,
        LAUNCHPAD_PROGRAM_ID,
        AutopilotError::InvalidCertificate
    );
    require!(
        data.len() >= certificate::PREFIX_LEN && data[..8] == certificate::DISCRIMINATOR,
        AutopilotError::InvalidCertificate
    );
    let version = read_u8(data, certificate::VERSION_OFFSET)?;
    require!(
        (certificate::MIN_VERSION..=certificate::MAX_VERSION).contains(&version),
        AutopilotError::InvalidCertificate
    );
    require!(
        bytes32(data, certificate::LAUNCH_OFFSET)? == launch_key.to_bytes()
            && bytes32(data, certificate::BASE_MINT_OFFSET)? == mint.to_bytes(),
        AutopilotError::InvalidCertificate
    );
    let checks = read_u32(data, certificate::CHECKS_OFFSET)?;
    require!(
        checks & certificate::CHECKS_ALL == certificate::CHECKS_ALL,
        AutopilotError::InvalidCertificate
    );
    Ok(())
}

/// A verified authorization: when it landed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AuthView {
    pub unix_time: i64,
    pub slot: u64,
}

/// Check an `Authorization` account: the launchpad's, at
/// `["auth", launch, [kind], payload_hash]`, version 1, for `launch`, of
/// `kind`, over `payload_hash`, by the launch's identity, holding a full
/// signature.
pub fn check_authorization(
    key: &Pubkey,
    owner: &Pubkey,
    data: &[u8],
    launch_key: &Pubkey,
    pq_identity: &[u8; 32],
    kind: u8,
    payload_hash: &[u8; 32],
) -> Result<AuthView, ProgramError> {
    use authorization as a;
    require_keys_eq!(
        *owner,
        LAUNCHPAD_PROGRAM_ID,
        AutopilotError::InvalidAuthorization
    );
    require!(
        data.len() == a::LEN
            && data[..8] == a::DISCRIMINATOR
            && data[a::VERSION_OFFSET] == a::VERSION,
        AutopilotError::InvalidAuthorization
    );
    let bump = read_u8(data, a::BUMP_OFFSET)?;
    let expected = noised_onchain::pda::create_program_address(
        &[
            a::SEED,
            launch_key.as_ref(),
            &[kind],
            payload_hash.as_ref(),
            &[bump],
        ],
        &LAUNCHPAD_PROGRAM_ID,
    )
    .ok_or(AutopilotError::InvalidAuthorization)?;
    require_keys_eq!(*key, expected, AutopilotError::InvalidAuthorization);
    require!(
        bytes32(data, a::LAUNCH_OFFSET)? == launch_key.to_bytes()
            && bytes32(data, a::PQ_IDENTITY_OFFSET)? == *pq_identity
            && read_u8(data, a::KIND_OFFSET)? == kind
            && bytes32(data, a::PAYLOAD_HASH_OFFSET)? == *payload_hash
            && read_u32(data, a::SIG_LEN_OFFSET)? as usize == a::SIG_LEN,
        AutopilotError::InvalidAuthorization
    );
    Ok(AuthView {
        unix_time: read_i64(data, a::UNIX_TIME_OFFSET)?,
        slot: read_u64(data, a::SLOT_OFFSET)?,
    })
}

fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    noised_onchain::hashv(parts)
}

/// `SHA256("PHX-GRAPH-ACT-V1" || autopilot || graph_hash || i64le(activate_at))`.
pub fn activation_payload(autopilot: &Pubkey, graph_hash: &[u8; 32], activate_at: i64) -> [u8; 32] {
    sha256(&[
        authorization::ACTIVATE_DOMAIN,
        autopilot.as_ref(),
        graph_hash,
        &activate_at.to_le_bytes(),
    ])
}

/// `SHA256("PHX-GRAPH-FRZ-V2" || autopilot || graph_hash || i64le(not_after))`.
pub fn freeze_payload(autopilot: &Pubkey, graph_hash: &[u8; 32], not_after: i64) -> [u8; 32] {
    sha256(&[
        authorization::FREEZE_DOMAIN,
        autopilot.as_ref(),
        graph_hash,
        &not_after.to_le_bytes(),
    ])
}

/// `SHA256("PHX-OP-REVOKE-V3" || autopilot || graph_hash || operator ||
/// active_auth)`: `active_auth` is the `Authorization` that activated the
/// graph (`Autopilot::active_auth`).
pub fn revoke_payload(
    autopilot: &Pubkey,
    graph_hash: &[u8; 32],
    operator: &Pubkey,
    active_auth: &Pubkey,
) -> [u8; 32] {
    sha256(&[
        authorization::REVOKE_DOMAIN,
        autopilot.as_ref(),
        graph_hash,
        operator.as_ref(),
        active_auth.as_ref(),
    ])
}

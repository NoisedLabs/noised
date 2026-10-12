//! Programmable launches: the creator rules record (`publish_rules`) and its
//! hash, the authorization message and account (`pq_authorize`), the leaf
//! burning `attest_launch` and `pq_authorize` share, certificate version 4,
//! and the layouts and instruction data clients and the autopilot read.

use anchor_lang::{prelude::*, AccountSerialize, Discriminator, Event, InstructionData};
use noised_lmots::{identity_id, Sha2, Sha256, LMS_PUBLIC_KEY_LEN, LMS_SIG_LEN};
use noised_rules::{op, rules::effect, Node, Rule, RulesProgram};

use super::{key, pq_tests::identity};
use crate::{
    constants::{AUTH_SEED, RULES_SEED},
    error::LaunchpadError,
    events::{Authorized, RulesPublished},
    pq::{
        authorization_message, burn_leaf, is_rules_record, rules_hash, rules_record_address,
        SolSha256, AUTH_MESSAGE_LEN, AUTH_MESSAGE_TAG,
    },
    state::{checks, Authorization, Certificate, FeeRecipient, Identity, LaunchRules},
};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &crate::ID).0
}

/// A valid rule set: deny buys in the first two minutes.
fn sample_rules() -> Vec<u8> {
    RulesProgram {
        keys: vec![],
        rules: vec![Rule {
            from_rel: 0,
            to_rel: 120,
            cond_off: 0,
            cond_len: 1,
            effect: effect::DENY,
            code: 1,
            arg: 0,
        }],
        nodes: vec![Node::new(op::rules::IS_BUY, 0, 0)],
    }
    .encode()
    .unwrap()
}

/// `SHA256("PHX-RULES-V1" || bytes)` on the syscall's API, against the
/// crate's own hash on another backend, an independent SHA-256 and known
/// answers computed with Python's hashlib.
#[test]
fn rules_hash_is_the_tag_then_the_bytes() {
    for (bytes, known) in [
        (
            b"PXR1".to_vec(),
            "02e890004a95b6ebb9e9abd49e51f697bf82c68552eefc920d4e0295ce1d542a",
        ),
        (
            vec![],
            "90b1a089830f3128eaa4214314eb0c3b5da5d21f48008f32eb4ec4293b699398",
        ),
        (
            sample_rules(),
            "046d7000bf4435929f7b675dffd36aff1f761af9adfd7e60c3f93196cb35675f",
        ),
    ] {
        let independent = Sha2::hashv(&[b"PHX-RULES-V1", &bytes]);
        assert_eq!(rules_hash(&bytes), independent);
        assert_eq!(
            rules_hash(&bytes),
            noised_rules::rules_hash::<noised_rules::Sha2>(&bytes)
        );
        assert_eq!(hex(&independent), known);
    }
    assert_eq!(
        hex(&sample_rules()),
        "505852310100010100000000000000007800000000010101000000000000000010000000000000000000"
    );
    let rules = sample_rules();
    assert_ne!(rules_hash(&rules), [0; 32]);
    let (address, bump) = rules_record_address(&key(2), &rules_hash(&rules));
    assert_eq!(
        Pubkey::create_program_address(
            &[RULES_SEED, key(2).as_ref(), &rules_hash(&rules), &[bump]],
            &crate::ID
        )
        .unwrap(),
        address
    );
    assert_eq!(RULES_SEED, b"rules");
}

/// The 140-byte authorization message: the tag, then the program, the
/// launch, its creator, the kind and the payload hash, each byte at its own
/// position.
#[test]
fn authorization_message_is_the_tag_then_the_launch_kind_and_payload() {
    assert_eq!(AUTH_MESSAGE_TAG, b"PHX-AUTH-V1");
    assert_eq!(AUTH_MESSAGE_LEN, 140);
    let m = authorization_message(&key(1), &key(2), &key(3), 0xA5, &[4; 32]);
    let mut want = b"PHX-AUTH-V1".to_vec();
    for field in [[1u8; 32], [2; 32], [3; 32]] {
        want.extend_from_slice(&field);
    }
    want.push(0xA5);
    want.extend_from_slice(&[4; 32]);
    assert_eq!(m.to_vec(), want);
    for at in 11..140 {
        let mut bytes = want.clone();
        bytes[at] ^= 0x80;
        let field = |i: usize| -> [u8; 32] { bytes[11 + 32 * i..43 + 32 * i].try_into().unwrap() };
        let payload: [u8; 32] = bytes[108..140].try_into().unwrap();
        let other = authorization_message(
            &Pubkey::new_from_array(field(0)),
            &Pubkey::new_from_array(field(1)),
            &Pubkey::new_from_array(field(2)),
            bytes[107],
            &payload,
        );
        let changed: Vec<usize> = (0..140).filter(|&i| other[i] != m[i]).collect();
        assert_eq!(changed, [at]);
    }
    // No authorization message is an attestation message (other tag and
    // length).
    assert_ne!(&m[..13], b"PHX-ATTEST-V3");
}

fn rules_record(launch: Pubkey, bytes: &[u8], bump: u8) -> Vec<u8> {
    let record = LaunchRules {
        version: 1,
        bump,
        launch,
        rules_hash: rules_hash(bytes),
        bytes: bytes.to_vec(),
    };
    let mut data = Vec::new();
    record.try_serialize(&mut data).unwrap();
    data
}

/// The rules record's layout (the offsets `attest_launch` reads in place)
/// and its exact space.
#[test]
fn rules_record_layout_is_pinned() {
    assert_eq!(
        LaunchRules::DISCRIMINATOR,
        [238, 73, 71, 29, 231, 48, 39, 141]
    );
    assert_eq!(LaunchRules::VERSION, 1);
    assert_eq!(LaunchRules::FIXED_LEN, 78);
    let bytes = sample_rules();
    let data = rules_record(key(2), &bytes, 253);
    assert_eq!(data.len(), LaunchRules::space(bytes.len()));
    assert_eq!(LaunchRules::space(1_228), 1_306);
    assert_eq!(&data[..8], LaunchRules::DISCRIMINATOR);
    assert_eq!(data[LaunchRules::VERSION_OFFSET], 1);
    assert_eq!(data[LaunchRules::BUMP_OFFSET], 253);
    assert_eq!(
        &data[LaunchRules::LAUNCH_OFFSET..LaunchRules::LAUNCH_OFFSET + 32],
        key(2).as_ref()
    );
    assert_eq!(
        &data[LaunchRules::RULES_HASH_OFFSET..LaunchRules::RULES_HASH_OFFSET + 32],
        &rules_hash(&bytes)
    );
    assert_eq!(&data[74..78], &(bytes.len() as u32).to_le_bytes());
    assert_eq!(&data[78..], &bytes[..]);
}

fn is_record(owner: &Pubkey, data: &[u8], launch: &Pubkey, hash: &[u8; 32], bump: u8) -> bool {
    let address = key(0xEE);
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
    is_rules_record(&info, launch, hash, bump)
}

/// `attest_launch` takes only the record `publish_rules` writes: this
/// program's, a `LaunchRules` of version 1, for this launch and hash, with
/// the address's bump, at least the fixed length; anything else is no
/// record (and never a failure).
#[test]
fn only_the_published_rules_record_is_recognized() {
    let bytes = sample_rules();
    let (launch, hash) = (key(2), rules_hash(&bytes));
    let data = rules_record(launch, &bytes, 254);
    assert!(is_record(&crate::ID, &data, &launch, &hash, 254));
    assert!(!is_record(&noised_hook::ID, &data, &launch, &hash, 254));
    assert!(!is_record(&crate::ID, &data, &key(3), &hash, 254));
    assert!(!is_record(&crate::ID, &data, &launch, &[9; 32], 254));
    assert!(!is_record(&crate::ID, &data, &launch, &hash, 253));
    for at in [
        0,
        7,
        LaunchRules::VERSION_OFFSET,
        LaunchRules::LAUNCH_OFFSET + 31,
        LaunchRules::RULES_HASH_OFFSET,
        LaunchRules::RULES_HASH_OFFSET + 31,
    ] {
        let mut d = data.clone();
        d[at] ^= 1;
        assert!(!is_record(&crate::ID, &d, &launch, &hash, 254), "byte {at}");
    }
    // The fixed part is enough; shorter is no record.
    assert!(is_record(
        &crate::ID,
        &data[..LaunchRules::FIXED_LEN],
        &launch,
        &hash,
        254
    ));
    assert!(!is_record(
        &crate::ID,
        &data[..LaunchRules::FIXED_LEN - 1],
        &launch,
        &hash,
        254
    ));
    assert!(!is_record(&crate::ID, &[], &launch, &hash, 254));
}

/// The `Authorization` layout, byte for byte as the autopilot reads it
/// (`noised_autopilot::launchpad::authorization`): 2,669 bytes.
#[test]
fn authorization_layout_is_the_autopilots() {
    assert_eq!(
        Authorization::DISCRIMINATOR,
        [3, 68, 168, 243, 195, 168, 32, 75]
    );
    assert_eq!(Authorization::VERSION, 1);
    assert_eq!(8 + Authorization::INIT_SPACE, 2_669);
    assert_eq!(AUTH_SEED, b"auth");
    let signature: Vec<u8> = (0..LMS_SIG_LEN).map(|i| (i % 249) as u8).collect();
    let a = Authorization {
        version: 1,
        bump: 251,
        launch: key(2),
        pq_identity: [3; 32],
        kind: 0xA7,
        payload_hash: [5; 32],
        message_hash: [6; 32],
        unix_time: -0x0102_0304_0506_0708,
        slot: 0x1112_1314_1516_1718,
        leaf: 0x0304,
        signature: signature.clone(),
    };
    let mut data = Vec::new();
    a.try_serialize(&mut data).unwrap();
    assert_eq!(data.len(), 2_669);
    assert_eq!(&data[..8], &[3, 68, 168, 243, 195, 168, 32, 75]);
    assert_eq!(data[8], 1);
    assert_eq!(data[9], 251);
    assert_eq!(&data[10..42], &[2; 32]);
    assert_eq!(&data[42..74], &[3; 32]);
    assert_eq!(data[74], 0xA7);
    assert_eq!(&data[75..107], &[5; 32]);
    assert_eq!(&data[107..139], &[6; 32]);
    assert_eq!(&data[139..147], &(-0x0102_0304_0506_0708i64).to_le_bytes());
    assert_eq!(&data[147..155], &0x1112_1314_1516_1718u64.to_le_bytes());
    assert_eq!(&data[155..157], &[0x04, 0x03]);
    assert_eq!(&data[157..161], &2_508u32.to_le_bytes());
    assert_eq!(&data[161..], &signature[..]);
}

/// Certificate version 4 appends `rules_hash` and keeps every version-3
/// offset (the autopilot reads `launch`, `base_mint` and `checks` at 10, 42
/// and 187).
#[test]
fn certificate_v4_appends_the_rules_hash() {
    let cert = Certificate {
        version: 4,
        bump: 250,
        launch: key(0x21),
        base_mint: key(0x22),
        pool: key(0x23),
        dbc_config: key(0x24),
        creator: key(0x25),
        launched_at: 1,
        token_decimal: 6,
        initial_supply: 2,
        checks: checks::ALL | checks::RULES_BOUND,
        migration_quote_threshold: 3,
        migration_fee_option: 4,
        snipe_shield_end_ts: 5,
        execute_end_ts: 6,
        guard_end_ts: 7,
        max_wallet: 8,
        max_buy: 9,
        p2p_locked: true,
        platform_fee_bps: 10,
        recipients: [FeeRecipient::default(); 4],
        params_hash: [0x26; 32],
        policy_version: 3,
        pq_identity: [0x27; 32],
        pq_leaf: 11,
        attested_slot: 12,
        metadata: key(0x28),
        rules_hash: [0x29; 32],
    };
    let mut data = Vec::new();
    cert.try_serialize(&mut data).unwrap();
    assert_eq!(data.len(), 519);
    assert_eq!(data.len(), 8 + Certificate::INIT_SPACE);
    assert_eq!(data[8], 4);
    assert_eq!(&data[10..42], key(0x21).as_ref());
    assert_eq!(&data[42..74], key(0x22).as_ref());
    assert_eq!(&data[187..191], &8_191u32.to_le_bytes());
    assert_eq!(&data[455..487], key(0x28).as_ref());
    assert_eq!(&data[487..519], &[0x29; 32]);
}

/// `burn_leaf`, the leaf accounting `attest_launch` and `pq_authorize`
/// share: the first landing sets the identity up; a valid signature of an
/// unused leaf burns exactly that leaf (whatever it signed); a used leaf, a
/// signature that does not verify and another key's account are refused
/// and change nothing.
#[test]
fn burn_leaf_burns_exactly_the_signing_leaf() {
    let kp = identity();
    let pk: [u8; LMS_PUBLIC_KEY_LEN] = kp.public_key().to_bytes();
    let mut id = Identity {
        version: 0,
        bump: 0,
        public_key: [0; LMS_PUBLIC_KEY_LEN],
        used: [0; 128],
        used_count: 0,
    };
    let attest = [7u8; 221];
    let auth = authorization_message(&crate::ID, &key(2), &key(3), 1, &[4; 32]);
    let sig = |q: u32, m: &[u8]| kp.sign_deterministic::<Sha2>(q, m).unwrap();
    assert_eq!(
        burn_leaf(&mut id, 249, &pk, &attest, &sig(5, &attest)).unwrap(),
        5
    );
    assert_eq!((id.version, id.bump, id.public_key), (1, 249, pk));
    assert_eq!((id.used[0], id.used_count), (0x20, 1));
    // An authorization by the same identity burns its own leaf in the same
    // bitmap; the bump stays the first one.
    assert_eq!(
        burn_leaf(&mut id, 7, &pk, &auth, &sig(1023, &auth)).unwrap(),
        1023
    );
    assert_eq!((id.bump, id.used[127], id.used_count), (249, 0x80, 2));
    // A used leaf, whatever it signs now.
    let before = (id.used, id.used_count);
    let err = |r: Result<u16>, e: LaunchpadError| assert_eq!(r.unwrap_err(), error!(e));
    err(
        burn_leaf(&mut id, 249, &pk, &auth, &sig(5, &auth)),
        LaunchpadError::PqLeafUsed,
    );
    // A signature over another message.
    err(
        burn_leaf(&mut id, 249, &pk, &auth, &sig(6, &attest)),
        LaunchpadError::InvalidPqSignature,
    );
    err(
        burn_leaf(&mut id, 249, &pk, &auth, &[]),
        LaunchpadError::InvalidPqSignature,
    );
    assert_eq!((id.used, id.used_count), before);
    // An account set up for another key.
    let mut other = pk;
    other[55] ^= 1;
    err(
        burn_leaf(&mut id, 249, &other, &auth, &sig(6, &auth)),
        LaunchpadError::InvalidPqIdentity,
    );
    assert_eq!((id.used, id.used_count), before);
    assert_eq!(identity_id::<SolSha256>(&pk), kp.identity_id::<Sha2>());
}

/// Instruction data, account lists, discriminators and events of
/// `publish_rules` and `pq_authorize`, pinned for the SDK and the IDL
/// (discriminators computed independently: `sha256("<namespace>:<name>")`).
#[test]
fn rules_and_authorization_interfaces_are_pinned() {
    use anchor_lang::ToAccountMetas;
    let data = crate::instruction::PublishRules {
        bytes: vec![0xAB; 3],
    }
    .data();
    let mut want = vec![213, 245, 134, 186, 168, 25, 143, 233];
    want.extend_from_slice(&3u32.to_le_bytes());
    want.extend_from_slice(&[0xAB; 3]);
    assert_eq!(data, want);
    let data = crate::instruction::PqAuthorize {
        lms_pk: [0xAA; 56],
        lms_sig: vec![0xBB; 2],
        kind: 3,
        payload_hash: [0xCC; 32],
    }
    .data();
    let mut want = vec![137, 191, 62, 214, 185, 40, 143, 247];
    want.extend_from_slice(&[0xAA; 56]);
    want.extend_from_slice(&2u32.to_le_bytes());
    want.extend_from_slice(&[0xBB; 2]);
    want.push(3);
    want.extend_from_slice(&[0xCC; 32]);
    assert_eq!(data, want);

    let flags = |m: Vec<AccountMeta>| -> Vec<(Pubkey, bool, bool)> {
        m.iter()
            .map(|m| (m.pubkey, m.is_signer, m.is_writable))
            .collect()
    };
    let system = anchor_lang::system_program::ID;
    let launch = key(2);
    let rules = pda(&[RULES_SEED, launch.as_ref(), &[9; 32]]);
    assert_eq!(
        flags(
            crate::accounts::PublishRules {
                payer: key(1),
                launch,
                rules,
                system_program: system,
            }
            .to_account_metas(None)
        ),
        [
            (key(1), true, true),
            (launch, false, false),
            (rules, false, true),
            (system, false, false),
        ]
    );
    let auth = pda(&[AUTH_SEED, launch.as_ref(), &[1], &[9; 32]]);
    assert_eq!(
        flags(
            crate::accounts::PqAuthorize {
                payer: key(1),
                launch,
                identity: key(3),
                authorization: auth,
                system_program: system,
            }
            .to_account_metas(None)
        ),
        [
            (key(1), true, true),
            (launch, false, false),
            (key(3), false, true),
            (auth, false, true),
            (system, false, false),
        ]
    );

    let event = RulesPublished {
        launch: key(1),
        rules: key(2),
        rules_hash: [3; 32],
        len: 0x04C3,
    };
    let mut want = vec![26, 16, 62, 30, 94, 109, 64, 56];
    want.extend_from_slice(&[1; 32]);
    want.extend_from_slice(&[2; 32]);
    want.extend_from_slice(&[3; 32]);
    want.extend_from_slice(&[0xC3, 0x04]);
    assert_eq!(event.data(), want);
    let event = Authorized {
        launch: key(1),
        authorization: key(2),
        pq_identity: [3; 32],
        kind: 2,
        payload_hash: [4; 32],
        leaf: 0x0102,
        unix_time: -5,
        slot: 6,
    };
    let mut want = vec![118, 46, 103, 253, 101, 118, 6, 128];
    want.extend_from_slice(&[1; 32]);
    want.extend_from_slice(&[2; 32]);
    want.extend_from_slice(&[3; 32]);
    want.push(2);
    want.extend_from_slice(&[4; 32]);
    want.extend_from_slice(&[0x02, 0x01]);
    want.extend_from_slice(&(-5i64).to_le_bytes());
    want.extend_from_slice(&6u64.to_le_bytes());
    assert_eq!(event.data(), want);
}

//! The layouts read by offset, pinned against the types that write them:
//! the launchpad's `Launch`, `Certificate` and `Authorization` (written by
//! `pq_authorize`), and the Meteora accounts as the launchpad's
//! `declare_program!` types describe them.

use anchor_lang::{__private::bytemuck, AccountSerialize, Discriminator};
use noised_launchpad::{
    cp_amm::accounts::{Config as DammConfig, Pool as DammPool},
    dynamic_bonding_curve::accounts::ConfigWithTransferHook,
    state::{Authorization, Certificate, FeeRecipient, Launch, LaunchStatus},
};
use noised_rules::Sha2;

use super::*;
use crate::{
    constants::*,
    external::{self, damm_config, damm_pool, dbc_config},
    launchpad::{self, authorization, certificate, launch},
};

fn serialize<T: AccountSerialize>(account: &T) -> Vec<u8> {
    let mut out = Vec::new();
    account.try_serialize(&mut out).unwrap();
    out
}

fn sample_launch(status: LaunchStatus) -> Launch {
    let mut recipients = [FeeRecipient::default(); 4];
    recipients[0] = FeeRecipient {
        wallet: key(0x41),
        bps: 6_000,
    };
    recipients[1] = FeeRecipient {
        wallet: key(0x42),
        bps: 4_000,
    };
    Launch {
        version: 2,
        bump: 251,
        authority_bump: 250,
        batch_bump: 249,
        config_bump: 248,
        status,
        launch_seed: [0x11; 32],
        creator: key(0x12),
        dbc_config: key(0x13),
        launch_authority: key(0x14),
        batch_authority: key(0x15),
        base_mint: key(0x16),
        pool: key(0x17),
        treasury: key(0x18),
        platform_fee_bps: 2_000,
        recipients,
        recipient_count: 2,
        token_decimal: 6,
        migration_quote_threshold: 10_000_000_000,
        migration_fee_option: 4,
        open_delay_secs: 60,
        guard_secs: 3_600,
        max_wallet_bps: 100,
        max_buy_bps: 50,
        p2p_locked: true,
        batch_wallet_cap: 7,
        batch_total_cap: 8,
        params_hash: [0x19; 32],
        launch_ts: 1_800_000_000,
        commit_end_ts: 1_800_000_060,
        execute_end_ts: 1_800_000_660,
        guard_end_ts: 1_800_003_600,
        total_committed: 9,
        executed: true,
        quote_spent: 10,
        tokens_out: 11,
        tokens_claimed: 12,
        quote_refunded: 13,
        pq_identity: [0x1A; 32],
    }
}

#[test]
fn launch_layout_matches_the_launchpad() {
    assert_eq!(Launch::DISCRIMINATOR, launch::DISCRIMINATOR);
    assert_eq!(Launch::VERSION, launch::MIN_VERSION);
    assert_eq!(Launch::VERSION, launch::MAX_VERSION);
    assert_eq!(8 + Launch::INIT_SPACE, launch::MIN_LEN);
    for (status, live) in [
        (LaunchStatus::Configured, false),
        (LaunchStatus::Live, true),
    ] {
        let bytes = serialize(&sample_launch(status));
        assert_eq!(bytes.len(), launch::MIN_LEN);
        let v = launchpad::parse_launch(&LAUNCHPAD_PROGRAM_ID, &bytes).unwrap();
        assert_eq!(v.live, live);
        assert_eq!(v.dbc_config, key(0x13));
        assert_eq!(v.base_mint, key(0x16));
        assert_eq!(v.pq_identity, [0x1A; 32]);
    }
}

#[test]
fn launch_reader_fails_closed() {
    let good = serialize(&sample_launch(LaunchStatus::Live));
    assert_err(
        launchpad::parse_launch(&crate::ID, &good),
        AutopilotError::NotALaunch,
    );
    let mut bad = good.clone();
    bad[0] ^= 1;
    assert_err(
        launchpad::parse_launch(&LAUNCHPAD_PROGRAM_ID, &bad),
        AutopilotError::NotALaunch,
    );
    for version in [0u8, 1, 3, u8::MAX] {
        let mut bad = good.clone();
        bad[launch::VERSION_OFFSET] = version;
        assert_err(
            launchpad::parse_launch(&LAUNCHPAD_PROGRAM_ID, &bad),
            AutopilotError::NotALaunch,
        );
    }
    for len in [0, 7, 8, launch::MIN_LEN - 1] {
        assert_err(
            launchpad::parse_launch(&LAUNCHPAD_PROGRAM_ID, &good[..len]),
            AutopilotError::NotALaunch,
        );
    }
}

#[test]
fn a_later_launch_version_is_refused_until_the_autopilot_knows_it() {
    // Review 4, R6b (inverting the earlier integration contract): the
    // reader is pinned to the versions it knows, like the certificate
    // reader, so a later `Launch` layout can never be misread, even one
    // that keeps the v2 prefix and appends fields.
    let mut v3 = serialize(&sample_launch(LaunchStatus::Live));
    v3[launch::VERSION_OFFSET] = 3;
    v3.extend_from_slice(&[0xEE; 40]);
    for version in [3, 4, 0x80, u8::MAX] {
        v3[launch::VERSION_OFFSET] = version;
        assert_err(
            launchpad::parse_launch(&LAUNCHPAD_PROGRAM_ID, &v3),
            AutopilotError::NotALaunch,
        );
    }
    // Version 2 with appended bytes still reads (a prefix).
    v3[launch::VERSION_OFFSET] = 2;
    let v = launchpad::parse_launch(&LAUNCHPAD_PROGRAM_ID, &v3).unwrap();
    assert!(v.live);
    assert_eq!(
        (v.dbc_config, v.base_mint, v.pq_identity),
        (key(0x13), key(0x16), [0x1A; 32])
    );
}

/// A version-4 certificate (no rules unless `checks` says so).
fn sample_certificate(checks: u32) -> Certificate {
    Certificate {
        version: 4,
        bump: 254,
        launch: key(0x21),
        base_mint: key(0x22),
        pool: key(0x23),
        dbc_config: key(0x24),
        creator: key(0x25),
        launched_at: 1_800_000_000,
        token_decimal: 6,
        initial_supply: 1_000_000_000_000_000,
        checks,
        migration_quote_threshold: 1,
        migration_fee_option: 2,
        snipe_shield_end_ts: 3,
        execute_end_ts: 4,
        guard_end_ts: 5,
        max_wallet: 6,
        max_buy: 7,
        p2p_locked: true,
        platform_fee_bps: 8,
        recipients: [FeeRecipient::default(); 4],
        params_hash: [0x26; 32],
        policy_version: 3,
        pq_identity: [0x27; 32],
        pq_leaf: 9,
        attested_slot: 10,
        metadata: key(0x28),
        rules_hash: [0; 32],
    }
}

#[test]
fn certificate_layout_matches_the_launchpad() {
    assert_eq!(Certificate::DISCRIMINATOR, certificate::DISCRIMINATOR);
    assert_eq!(Certificate::VERSION, certificate::MAX_VERSION);
    assert_eq!(
        noised_launchpad::state::checks::ALL,
        certificate::CHECKS_ALL
    );
    assert_eq!(
        certificate::SEED,
        noised_launchpad::constants::CERTIFICATE_SEED
    );
    let all = certificate::CHECKS_ALL;
    let bytes = serialize(&sample_certificate(all));
    assert!(bytes.len() >= certificate::PREFIX_LEN);
    let (l, m) = (key(0x21), key(0x22));
    launchpad::check_certificate(&LAUNCHPAD_PROGRAM_ID, &bytes, &l, &m).unwrap();
    // Version 4 appends `rules_hash` and sets RULES_BOUND (4096) with rules.
    assert_eq!(noised_launchpad::state::checks::RULES_BOUND, 4_096);
    let mut ruled = sample_certificate(all | noised_launchpad::state::checks::RULES_BOUND);
    ruled.rules_hash = [0x29; 32];
    let v4 = serialize(&ruled);
    launchpad::check_certificate(&LAUNCHPAD_PROGRAM_ID, &v4, &l, &m).unwrap();
    // A version-3 certificate is the version-4 prefix without `rules_hash`.
    let mut v3 = bytes[..bytes.len() - 32].to_vec();
    v3[certificate::VERSION_OFFSET] = 3;
    assert_eq!(v3.len(), 487);
    launchpad::check_certificate(&LAUNCHPAD_PROGRAM_ID, &v3, &l, &m).unwrap();

    let bad = AutopilotError::InvalidCertificate;
    assert_err(
        launchpad::check_certificate(&crate::ID, &bytes, &l, &m),
        bad,
    );
    assert_err(
        launchpad::check_certificate(&LAUNCHPAD_PROGRAM_ID, &bytes, &m, &m),
        bad,
    );
    assert_err(
        launchpad::check_certificate(&LAUNCHPAD_PROGRAM_ID, &bytes, &l, &l),
        bad,
    );
    for missing in [1u32, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1_024, 2_048] {
        let partial = serialize(&sample_certificate(all & !missing));
        assert_err(
            launchpad::check_certificate(&LAUNCHPAD_PROGRAM_ID, &partial, &l, &m),
            bad,
        );
    }
    for version in [0u8, 2, 5] {
        let mut b = bytes.clone();
        b[certificate::VERSION_OFFSET] = version;
        assert_err(
            launchpad::check_certificate(&LAUNCHPAD_PROGRAM_ID, &b, &l, &m),
            bad,
        );
    }
    let mut b = bytes.clone();
    b[3] ^= 0x80;
    assert_err(
        launchpad::check_certificate(&LAUNCHPAD_PROGRAM_ID, &b, &l, &m),
        bad,
    );
    assert_err(
        launchpad::check_certificate(
            &LAUNCHPAD_PROGRAM_ID,
            &bytes[..certificate::PREFIX_LEN - 1],
            &l,
            &m,
        ),
        bad,
    );
}

/// An authorization as the launchpad writes it, at its canonical address.
pub fn authorization_bytes(
    launch_key: &Pubkey,
    pq_identity: [u8; 32],
    kind: u8,
    payload_hash: [u8; 32],
    unix_time: i64,
    slot: u64,
) -> (Pubkey, Vec<u8>) {
    let (address, bump) = Pubkey::find_program_address(
        &[
            authorization::SEED,
            launch_key.as_ref(),
            &[kind],
            &payload_hash,
        ],
        &LAUNCHPAD_PROGRAM_ID,
    );
    let a = Authorization {
        version: 1,
        bump,
        launch: *launch_key,
        pq_identity,
        kind,
        payload_hash,
        message_hash: [0x5A; 32],
        unix_time,
        slot,
        leaf: 77,
        signature: vec![0xC3; authorization::SIG_LEN],
    };
    (address, serialize(&a))
}

#[test]
fn authorization_layout_is_the_launchpads() {
    assert_eq!(Authorization::DISCRIMINATOR, authorization::DISCRIMINATOR);
    assert_eq!(Authorization::VERSION, authorization::VERSION);
    assert_eq!(authorization::LEN, 2_669);
    assert_eq!(8 + Authorization::INIT_SPACE, authorization::LEN);
    assert_eq!(authorization::SEED, noised_launchpad::constants::AUTH_SEED);
    assert_eq!(authorization::SIG_LEN, noised_lmots_sig_len());
    let l = key(0x31);
    let (address, bytes) = authorization_bytes(&l, [0x32; 32], 1, [0x33; 32], -5, 99);
    assert_eq!(bytes.len(), authorization::LEN);
    // Every field at its documented offset.
    use authorization as a;
    assert_eq!(bytes[a::VERSION_OFFSET], 1);
    assert_eq!(&bytes[a::LAUNCH_OFFSET..a::LAUNCH_OFFSET + 32], l.as_ref());
    assert_eq!(bytes[a::PQ_IDENTITY_OFFSET], 0x32);
    assert_eq!(bytes[a::KIND_OFFSET], 1);
    assert_eq!(bytes[a::PAYLOAD_HASH_OFFSET], 0x33);
    assert_eq!(bytes[a::MESSAGE_HASH_OFFSET], 0x5A);
    assert_eq!(
        i64::from_le_bytes(
            bytes[a::UNIX_TIME_OFFSET..a::UNIX_TIME_OFFSET + 8]
                .try_into()
                .unwrap()
        ),
        -5
    );
    assert_eq!(
        u64::from_le_bytes(
            bytes[a::SLOT_OFFSET..a::SLOT_OFFSET + 8]
                .try_into()
                .unwrap()
        ),
        99
    );
    assert_eq!(
        u16::from_le_bytes(
            bytes[a::LEAF_OFFSET..a::LEAF_OFFSET + 2]
                .try_into()
                .unwrap()
        ),
        77
    );
    assert_eq!(
        u32::from_le_bytes(
            bytes[a::SIG_LEN_OFFSET..a::SIG_LEN_OFFSET + 4]
                .try_into()
                .unwrap()
        ),
        2_508
    );
    assert_eq!(bytes[a::SIGNATURE_OFFSET], 0xC3);
    let v = launchpad::check_authorization(
        &address,
        &LAUNCHPAD_PROGRAM_ID,
        &bytes,
        &l,
        &[0x32; 32],
        1,
        &[0x33; 32],
    )
    .unwrap();
    assert_eq!((v.unix_time, v.slot), (-5, 99));
}

/// `noised_lmots::LMS_SIG_LEN`, via the launchpad's attestation bound.
fn noised_lmots_sig_len() -> usize {
    // The launchpad's `Attestation::signature` holds exactly one LMS signature.
    let space = noised_launchpad::state::Attestation::INIT_SPACE;
    // version, bump, launch, pq_identity, leaf, metadata_hash, rules_hash,
    // message_hash, slot, not_before, not_after, then the Vec's u32 length.
    space - (1 + 1 + 32 + 32 + 2 + 32 + 32 + 32 + 8 + 8 + 8 + 4)
}

#[test]
fn authorization_reader_fails_closed() {
    let l = key(0x31);
    let id = [0x32; 32];
    let payload = [0x33; 32];
    let (address, good) = authorization_bytes(&l, id, 2, payload, 100, 5);
    let check = |key: &Pubkey,
                 owner: &Pubkey,
                 data: &[u8],
                 launch: &Pubkey,
                 id: &[u8; 32],
                 kind: u8,
                 payload: &[u8; 32]| {
        launchpad::check_authorization(key, owner, data, launch, id, kind, payload)
    };
    check(&address, &LAUNCHPAD_PROGRAM_ID, &good, &l, &id, 2, &payload).unwrap();
    let bad = AutopilotError::InvalidAuthorization;
    // Owner, address, launch, identity, kind, payload.
    assert_err(
        check(&address, &crate::ID, &good, &l, &id, 2, &payload),
        bad,
    );
    assert_err(
        check(&key(9), &LAUNCHPAD_PROGRAM_ID, &good, &l, &id, 2, &payload),
        bad,
    );
    assert_err(
        check(
            &address,
            &LAUNCHPAD_PROGRAM_ID,
            &good,
            &key(9),
            &id,
            2,
            &payload,
        ),
        bad,
    );
    assert_err(
        check(
            &address,
            &LAUNCHPAD_PROGRAM_ID,
            &good,
            &l,
            &[0x34; 32],
            2,
            &payload,
        ),
        bad,
    );
    assert_err(
        check(&address, &LAUNCHPAD_PROGRAM_ID, &good, &l, &id, 1, &payload),
        bad,
    );
    assert_err(
        check(&address, &LAUNCHPAD_PROGRAM_ID, &good, &l, &id, 3, &payload),
        bad,
    );
    assert_err(
        check(
            &address,
            &LAUNCHPAD_PROGRAM_ID,
            &good,
            &l,
            &id,
            2,
            &[0x35; 32],
        ),
        bad,
    );
    // Each stored field that must match, flipped in place (the address
    // still derives from the arguments).
    use authorization as a;
    for at in [
        0,
        a::VERSION_OFFSET,
        a::BUMP_OFFSET,
        a::LAUNCH_OFFSET + 31,
        a::PQ_IDENTITY_OFFSET,
        a::KIND_OFFSET,
        a::PAYLOAD_HASH_OFFSET + 31,
        a::SIG_LEN_OFFSET,
    ] {
        let mut b = good.clone();
        b[at] ^= 1;
        assert_err(
            check(&address, &LAUNCHPAD_PROGRAM_ID, &b, &l, &id, 2, &payload),
            bad,
        );
    }
    // Neither shorter nor longer.
    assert_err(
        check(
            &address,
            &LAUNCHPAD_PROGRAM_ID,
            &good[..a::LEN - 1],
            &l,
            &id,
            2,
            &payload,
        ),
        bad,
    );
    let mut longer = good.clone();
    longer.push(0);
    assert_err(
        check(
            &address,
            &LAUNCHPAD_PROGRAM_ID,
            &longer,
            &l,
            &id,
            2,
            &payload,
        ),
        bad,
    );
    // An authorization of the same payload for another launch is another
    // account, and its bytes name the other launch.
    let other = key(0x36);
    let (other_address, other_bytes) = authorization_bytes(&other, id, 2, payload, 100, 5);
    assert_err(
        check(
            &other_address,
            &LAUNCHPAD_PROGRAM_ID,
            &other_bytes,
            &l,
            &id,
            2,
            &payload,
        ),
        bad,
    );
}

#[test]
fn payload_hashes_follow_the_documented_messages() {
    use noised_rules::Sha256;
    let autopilot = key(0x51);
    let graph = [0x52; 32];
    let at: i64 = -1_234_567;
    let mut m = b"PHX-GRAPH-ACT-V1".to_vec();
    m.extend_from_slice(autopilot.as_ref());
    m.extend_from_slice(&graph);
    m.extend_from_slice(&at.to_le_bytes());
    assert_eq!(m.len(), 16 + 32 + 32 + 8);
    assert_eq!(
        launchpad::activation_payload(&autopilot, &graph, at),
        Sha2::hashv(&[&m])
    );
    // Review 4, R5: version 2 of the freeze payload names its `not_after`.
    let not_after: i64 = 1_800_000_123;
    let mut m = b"PHX-GRAPH-FRZ-V2".to_vec();
    m.extend_from_slice(autopilot.as_ref());
    m.extend_from_slice(&graph);
    m.extend_from_slice(&not_after.to_le_bytes());
    assert_eq!(m.len(), 16 + 32 + 32 + 8);
    assert_eq!(
        launchpad::freeze_payload(&autopilot, &graph, not_after),
        Sha2::hashv(&[&m])
    );
    // Audit 4, A4-3: version 3 of the revocation payload names the
    // authorization that activated the graph.
    let operator = key(0x53);
    let active = key(0x58);
    let mut m = b"PHX-OP-REVOKE-V3".to_vec();
    m.extend_from_slice(autopilot.as_ref());
    m.extend_from_slice(&graph);
    m.extend_from_slice(operator.as_ref());
    m.extend_from_slice(active.as_ref());
    assert_eq!(m.len(), 16 + 32 + 32 + 32 + 32);
    assert_eq!(
        launchpad::revoke_payload(&autopilot, &graph, &operator, &active),
        Sha2::hashv(&[&m])
    );
    // A revocation names its graph and its activation: it is no revocation
    // of the same operator on another graph, nor of another activation.
    assert_ne!(
        launchpad::revoke_payload(&autopilot, &graph, &operator, &active),
        launchpad::revoke_payload(&autopilot, &[0x56; 32], &operator, &active)
    );
    assert_ne!(
        launchpad::revoke_payload(&autopilot, &graph, &operator, &active),
        launchpad::revoke_payload(&autopilot, &graph, &key(0x57), &active)
    );
    assert_ne!(
        launchpad::revoke_payload(&autopilot, &graph, &operator, &active),
        launchpad::revoke_payload(&autopilot, &graph, &operator, &key(0x59))
    );
    assert_ne!(
        launchpad::revoke_payload(&autopilot, &graph, &operator, &active),
        launchpad::revoke_payload(&key(0x54), &graph, &operator, &active)
    );
    // Every input matters.
    assert_ne!(
        launchpad::activation_payload(&autopilot, &graph, at),
        launchpad::activation_payload(&autopilot, &graph, at + 1)
    );
    assert_ne!(
        launchpad::activation_payload(&autopilot, &graph, at),
        launchpad::activation_payload(&key(0x54), &graph, at)
    );
    assert_ne!(
        launchpad::freeze_payload(&autopilot, &graph, not_after),
        launchpad::freeze_payload(&autopilot, &[0x55; 32], not_after)
    );
    assert_ne!(
        launchpad::freeze_payload(&autopilot, &graph, not_after),
        launchpad::freeze_payload(&autopilot, &graph, not_after + 1)
    );
    assert_ne!(
        launchpad::freeze_payload(&autopilot, &graph, not_after),
        launchpad::freeze_payload(&key(0x54), &graph, not_after)
    );
    // The three domains differ, so no authorization of one kind is ever
    // the payload of another.
    assert_ne!(authorization::ACTIVATE_DOMAIN, authorization::FREEZE_DOMAIN);
    assert_ne!(authorization::FREEZE_DOMAIN, authorization::REVOKE_DOMAIN);
    assert_ne!(authorization::ACTIVATE_DOMAIN, authorization::REVOKE_DOMAIN);
}

fn dbc_config_bytes(quote_mint: Pubkey, migration_sqrt_price: u128) -> Vec<u8> {
    let mut cfg: ConfigWithTransferHook = bytemuck::Zeroable::zeroed();
    cfg.config.quote_mint = quote_mint;
    cfg.config.migration_sqrt_price = migration_sqrt_price;
    cfg.config.sqrt_start_price = 777;
    let mut out = ConfigWithTransferHook::DISCRIMINATOR.to_vec();
    out.extend_from_slice(bytemuck::bytes_of(&cfg));
    out
}

#[test]
fn dbc_config_layout_matches_the_idl() {
    assert_eq!(
        ConfigWithTransferHook::DISCRIMINATOR,
        dbc_config::DISCRIMINATOR
    );
    let price = (1u128 << 64) + 12_345;
    let bytes = dbc_config_bytes(WSOL_MINT, price);
    assert_eq!(bytes.len(), dbc_config::LEN);
    assert_eq!(
        external::migration_sqrt_price(&DBC_PROGRAM_ID, &bytes).unwrap(),
        price
    );
    let bad = AutopilotError::InvalidDbcConfig;
    assert_err(external::migration_sqrt_price(&crate::ID, &bytes), bad);
    assert_err(
        external::migration_sqrt_price(&DBC_PROGRAM_ID, &dbc_config_bytes(key(3), price)),
        bad,
    );
    assert_err(
        external::migration_sqrt_price(&DBC_PROGRAM_ID, &dbc_config_bytes(WSOL_MINT, 0)),
        bad,
    );
    let mut b = bytes.clone();
    b[0] ^= 1;
    assert_err(external::migration_sqrt_price(&DBC_PROGRAM_ID, &b), bad);
    assert_err(
        external::migration_sqrt_price(&DBC_PROGRAM_ID, &bytes[..dbc_config::LEN - 1]),
        bad,
    );
}

pub fn damm_pool_bytes(mint: Pubkey, token_b: Pubkey, sqrt_price: u128) -> Vec<u8> {
    let mut pool: DammPool = bytemuck::Zeroable::zeroed();
    pool.token_a_mint = mint;
    pool.token_b_mint = token_b;
    pool.token_a_vault = key(0x61);
    pool.token_b_vault = key(0x62);
    pool.sqrt_price = sqrt_price;
    pool.sqrt_min_price = 1;
    pool.sqrt_max_price = u128::MAX;
    let mut out = DammPool::DISCRIMINATOR.to_vec();
    out.extend_from_slice(bytemuck::bytes_of(&pool));
    out
}

#[test]
fn damm_pool_layout_matches_the_idl() {
    assert_eq!(DammPool::DISCRIMINATOR, damm_pool::DISCRIMINATOR);
    let mint = key(0x63);
    let price = (3u128 << 64) + 5;
    let bytes = damm_pool_bytes(mint, WSOL_MINT, price);
    assert_eq!(bytes.len(), damm_pool::LEN);
    let v = external::read_pool(&DAMM_V2_PROGRAM_ID, &bytes, &mint)
        .unwrap()
        .unwrap();
    assert_eq!(v.sqrt_price, price);
    assert_eq!((v.token_a_vault, v.token_b_vault), (key(0x61), key(0x62)));
    // Not migrated yet: an empty account (perhaps holding lamports).
    assert_eq!(
        external::read_pool(&System::id(), &[], &mint).unwrap(),
        None
    );
    let bad = AutopilotError::InvalidPool;
    assert_err(external::read_pool(&System::id(), &[0], &mint), bad);
    assert_err(external::read_pool(&crate::ID, &bytes, &mint), bad);
    // Another mint, wSOL as A, a pool of two other tokens.
    assert_err(
        external::read_pool(&DAMM_V2_PROGRAM_ID, &bytes, &key(0x64)),
        bad,
    );
    assert_err(
        external::read_pool(
            &DAMM_V2_PROGRAM_ID,
            &damm_pool_bytes(WSOL_MINT, mint, price),
            &mint,
        ),
        bad,
    );
    assert_err(
        external::read_pool(
            &DAMM_V2_PROGRAM_ID,
            &damm_pool_bytes(mint, key(0x65), price),
            &mint,
        ),
        bad,
    );
    let mut b = bytes.clone();
    b[7] ^= 1;
    assert_err(external::read_pool(&DAMM_V2_PROGRAM_ID, &b, &mint), bad);
    assert_err(
        external::read_pool(&DAMM_V2_PROGRAM_ID, &bytes[..damm_pool::LEN - 1], &mint),
        bad,
    );
}

#[test]
fn damm_swap_discriminator_matches_the_idl() {
    use anchor_lang::InstructionData;
    let data = noised_launchpad::cp_amm::client::args::Swap {
        _params: noised_launchpad::cp_amm::types::SwapParameters {
            amount_in: 0x0102_0304_0506_0708,
            minimum_amount_out: 0x1112_1314_1516_1718,
        },
    }
    .data();
    let mut ours = external::DAMM_SWAP_DISCRIMINATOR.to_vec();
    ours.extend_from_slice(&0x0102_0304_0506_0708u64.to_le_bytes());
    ours.extend_from_slice(&0x1112_1314_1516_1718u64.to_le_bytes());
    assert_eq!(data, ours);
}

#[test]
fn fixed_program_ids_match_the_launchpad() {
    use noised_launchpad::constants as lp;
    assert_eq!(LAUNCHPAD_PROGRAM_ID, noised_launchpad::ID);
    assert_eq!(DBC_PROGRAM_ID, lp::DBC_PROGRAM_ID);
    assert_eq!(DBC_POOL_AUTHORITY, lp::DBC_POOL_AUTHORITY);
    assert_eq!(DAMM_V2_PROGRAM_ID, lp::DAMM_V2_PROGRAM_ID);
    assert_eq!(DAMM_V2_POOL_AUTHORITY, lp::DAMM_V2_POOL_AUTHORITY);
    assert_eq!(DAMM_V2_EVENT_AUTHORITY, lp::DAMM_V2_EVENT_AUTHORITY);
    assert_eq!(WSOL_MINT, lp::WSOL_MINT);
    assert_eq!(
        MAINNET_MIGRATION_CONFIGS.len(),
        usize::from(lp::dbc::MAX_MIGRATION_FEE_OPTION) + 1
    );
    // DAMM v2's event authority and pool authority are its PDAs.
    assert_eq!(
        Pubkey::find_program_address(&[b"__event_authority"], &DAMM_V2_PROGRAM_ID).0,
        DAMM_V2_EVENT_AUTHORITY
    );
    assert_eq!(
        Pubkey::find_program_address(&[b"pool_authority"], &DAMM_V2_PROGRAM_ID).0,
        DAMM_V2_POOL_AUTHORITY
    );
}

pub fn damm_config_bytes(pool_creator_authority: Pubkey) -> Vec<u8> {
    let mut cfg: DammConfig = bytemuck::Zeroable::zeroed();
    cfg.pool_creator_authority = pool_creator_authority;
    cfg.index = 20_002;
    let mut out = DammConfig::DISCRIMINATOR.to_vec();
    out.extend_from_slice(bytemuck::bytes_of(&cfg));
    out
}

#[test]
fn damm_config_layout_matches_the_idl() {
    assert_eq!(DammConfig::DISCRIMINATOR, damm_config::DISCRIMINATOR);
    let bytes = damm_config_bytes(DBC_POOL_AUTHORITY);
    assert_eq!(bytes.len(), damm_config::LEN);
    assert_eq!(
        &bytes[damm_config::POOL_CREATOR_AUTHORITY_OFFSET
            ..damm_config::POOL_CREATOR_AUTHORITY_OFFSET + 32],
        DBC_POOL_AUTHORITY.as_ref()
    );
    external::check_migration_config(&DAMM_V2_PROGRAM_ID, &bytes).unwrap();
    let bad = AutopilotError::InvalidDammConfig;
    // A config anyone can create pools with, or another creator's.
    assert_err(
        external::check_migration_config(
            &DAMM_V2_PROGRAM_ID,
            &damm_config_bytes(Pubkey::default()),
        ),
        bad,
    );
    assert_err(
        external::check_migration_config(&DAMM_V2_PROGRAM_ID, &damm_config_bytes(key(0x66))),
        bad,
    );
    // Not DAMM v2's, not a config, not its size.
    assert_err(external::check_migration_config(&crate::ID, &bytes), bad);
    assert_err(
        external::check_migration_config(&DBC_PROGRAM_ID, &bytes),
        bad,
    );
    let mut b = bytes.clone();
    b[0] ^= 1;
    assert_err(
        external::check_migration_config(&DAMM_V2_PROGRAM_ID, &b),
        bad,
    );
    assert_err(
        external::check_migration_config(&DAMM_V2_PROGRAM_ID, &bytes[..damm_config::LEN - 1]),
        bad,
    );
    let mut longer = bytes.clone();
    longer.push(0);
    assert_err(
        external::check_migration_config(&DAMM_V2_PROGRAM_ID, &longer),
        bad,
    );
    // A pool account is no config.
    assert_err(
        external::check_migration_config(
            &DAMM_V2_PROGRAM_ID,
            &damm_pool_bytes(key(1), WSOL_MINT, 1),
        ),
        bad,
    );
}

/// The DAMM v2 configs DBC migrates through on mainnet today, by migration
/// fee option 0..=5 (0.25%, 0.3%, 1%, 2%, 4%, 6%). `bind_pool` accepts any
/// config with DBC's pool authority as pool creator, these included.
pub const MAINNET_MIGRATION_CONFIGS: [Pubkey; 6] = [
    pubkey!("7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd"),
    pubkey!("2nHK1kju6XjphBLbNxpM5XRGFj7p9U8vvNzyZiha1z6k"),
    pubkey!("Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp"),
    pubkey!("2c4cYd4reUYVRAB9kUUkrq55VPyy2FNQ3FDL4o12JXmq"),
    pubkey!("AkmQWebAwFvWk55wBoCr5D62C6VVDTzi84NJuD9H7cFD"),
    pubkey!("DbCRBj8McvPYHJG1ukj8RE15h2dCNUdTAESG49XpQ44u"),
];

#[test]
fn pool_address_is_dammv2s_pool_pda() {
    let mint = key(0x71);
    for config in MAINNET_MIGRATION_CONFIGS {
        let (hi, lo) = if mint > WSOL_MINT {
            (mint, WSOL_MINT)
        } else {
            (WSOL_MINT, mint)
        };
        let want = Pubkey::find_program_address(
            &[b"pool", config.as_ref(), hi.as_ref(), lo.as_ref()],
            &DAMM_V2_PROGRAM_ID,
        )
        .0;
        assert_eq!(external::pool_address(&config, &mint), want);
    }
    // Both orders of the mint pair, and the config matters.
    let low = Pubkey::new_from_array([0; 32]);
    let c = MAINNET_MIGRATION_CONFIGS[2];
    assert_ne!(
        external::pool_address(&c, &low),
        external::pool_address(&c, &key(0xFF))
    );
    let (hi, lo) = (WSOL_MINT, low);
    assert_eq!(
        external::pool_address(&c, &low),
        Pubkey::find_program_address(
            &[b"pool", c.as_ref(), hi.as_ref(), lo.as_ref()],
            &DAMM_V2_PROGRAM_ID
        )
        .0
    );
    assert_ne!(
        external::pool_address(&MAINNET_MIGRATION_CONFIGS[0], &mint),
        external::pool_address(&MAINNET_MIGRATION_CONFIGS[1], &mint)
    );
}

/// The `Autopilot` account as clients read it: audit 4 appended
/// `active_auth`, `active_activate_at` and `partial_spent` after `nodes`,
/// so every earlier field keeps its offset.
#[test]
fn autopilot_layout_appends_the_audit_4_fields() {
    use crate::state::{AuthMark, Autopilot, NodeRecord, ObsBucket, MAX_NODES};
    let mut ap = Autopilot {
        version: Autopilot::VERSION,
        bump: 0xB1,
        treasury_bump: 0xB2,
        launch: key(0x01),
        mint: key(0x02),
        damm_pool: key(0x03),
        active_graph: [0x04; 32],
        pending_graph: [0x05; 32],
        pending_activate_at: 0x0606,
        pending_operator: key(0x07),
        activated_at: 0x0808,
        frozen: true,
        operator: key(0x09),
        auth_marks: [AuthMark {
            slot: 0x0A0A,
            key: key(0x0B),
        }; 3],
        seq: 0x0C0C,
        ref_sqrt_price: 0x0D0D,
        ref_updated_at: 0x0E0E,
        ref_allowance: 0x0F0F,
        ref_allowance_at: 0x1010,
        observations: [ObsBucket::default(); 2],
        tip_epoch_start: 0x1111,
        tips_in_epoch: 0x1212,
        nodes: [NodeRecord::default(); MAX_NODES],
        active_auth: key(0x13),
        active_activate_at: -2,
        partial_spent: [0; MAX_NODES],
    };
    ap.nodes[MAX_NODES - 1].spent_in_epoch = 0x1414;
    ap.partial_spent[0] = 0x1515;
    ap.partial_spent[MAX_NODES - 1] = 0x1616;
    let bytes = serialize(&ap);
    assert_eq!(bytes.len(), 8 + Autopilot::INIT_SPACE);
    assert_eq!(bytes.len(), 1_244);
    let u64_at = |at: usize| u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap());
    // Earlier fields where they were (spot checks), `nodes` ending at 1,076.
    assert_eq!(&bytes[107..139], &[0x04; 32]);
    assert_eq!(u64_at(372), 0x0C0C);
    assert_eq!(u64_at(516), 0x1111);
    assert_eq!(u64_at(1_076 - 8), 0x1414);
    // The appended fields.
    assert_eq!(&bytes[1_076..1_108], key(0x13).as_ref());
    assert_eq!(u64_at(1_108) as i64, -2);
    assert_eq!(u64_at(1_116), 0x1515);
    assert_eq!(u64_at(1_116 + 8 * (MAX_NODES - 1)), 0x1616);
    assert_eq!(1_116 + 8 * MAX_NODES, 1_244);
}

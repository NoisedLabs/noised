use anchor_lang::prelude::*;

use super::good_params;
use crate::{
    constants::*,
    cp_amm, dbc_params, dynamic_bonding_curve,
    state::{DynamicFeeParams, LaunchParams},
};

#[test]
fn dbc_config_has_every_fixed_value() {
    let mut p = good_params();
    p.dynamic_fee = Some(DynamicFeeParams {
        bin_step: 1,
        bin_step_u128: dbc::DYNAMIC_BIN_STEP_U128,
        filter_period: 10,
        decay_period: 120,
        reduction_factor: 5_000,
        max_volatility_accumulator: 14_460_000,
        variable_fee_control: 956,
    });
    let c = dbc_params::config_parameters(&p);
    // Creator-chosen values pass through unchanged.
    assert_eq!(c.token_decimal, p.token_decimal);
    assert_eq!(c.sqrt_start_price, p.sqrt_start_price);
    assert_eq!(c.migration_quote_threshold, p.migration_quote_threshold);
    assert_eq!(c.migration_fee_option, p.migration_fee_option);
    assert_eq!(c.curve.len(), p.curve.len());
    for (a, b) in c.curve.iter().zip(p.curve.iter()) {
        assert_eq!((a.sqrt_price, a.liquidity), (b.sqrt_price, b.liquidity));
    }
    let f = &c.pool_fees.base_fee;
    assert_eq!(
        (
            f.cliff_fee_numerator,
            f.first_factor,
            f.second_factor,
            f.third_factor,
            f.base_fee_mode
        ),
        (500_000_000, 10, 1, 49_000_000, 0)
    );
    let d = c.pool_fees.dynamic_fee.as_ref().unwrap();
    assert_eq!(
        (d.variable_fee_control, d.max_volatility_accumulator),
        (956, 14_460_000)
    );
    // Fixed values (SPEC §1.2).
    assert_eq!(c.collect_fee_mode, 0);
    assert_eq!(c.migration_option, 1);
    assert_eq!(c.activation_type, 1);
    assert_eq!(c.token_type, 1);
    assert_eq!(c.token_update_authority, 1);
    assert_eq!(c.partner_permanent_locked_liquidity_percentage, 100);
    assert_eq!(
        (
            c.partner_liquidity_percentage,
            c.creator_liquidity_percentage,
            c.creator_permanent_locked_liquidity_percentage
        ),
        (0, 0, 0)
    );
    for v in [
        &c.partner_liquidity_vesting_info,
        &c.creator_liquidity_vesting_info,
    ] {
        assert_eq!(
            (
                v.vesting_percentage,
                v.bps_per_period,
                v.number_of_periods,
                v.cliff_duration_from_migration_time,
                v.frequency
            ),
            (0, 0, 0, 0, 0)
        );
    }
    assert_eq!(
        (
            c.migration_fee.fee_percentage,
            c.migration_fee.creator_fee_percentage
        ),
        (0, 0)
    );
    assert_eq!(c.creator_trading_fee_percentage, 0);
    assert!(c.token_supply.is_none());
    let l = &c.locked_vesting;
    assert_eq!(
        (
            l.amount_per_period,
            l.cliff_duration_from_migration_time,
            l.frequency,
            l.number_of_period,
            l.cliff_unlock_amount
        ),
        (0, 0, 0, 0, 0)
    );
    assert_eq!(c.pool_creation_fee, 0);
    assert!(!c.enable_first_swap_with_min_fee);
    let m = &c.migrated_pool_fee;
    assert_eq!(
        (m.collect_fee_mode, m.dynamic_fee, m.pool_fee_bps),
        (0, 0, 0)
    );
    assert_eq!(c.migrated_pool_base_fee_mode, 0);
    let s = &c.migrated_pool_market_cap_fee_scheduler_params;
    assert_eq!(
        (
            s.number_of_period,
            s.sqrt_price_step_bps,
            s.scheduler_expiration_duration,
            s.reduction_factor
        ),
        (0, 0, 0, 0)
    );
    assert_eq!(c.compounding_fee_bps, 0);
    assert_eq!(c.padding, [0, 0]);
}

/// The certificate's `params_hash` commits to this exact byte layout; the
/// SDK must serialize `LaunchParams` identically.
#[test]
fn launch_params_borsh_layout_is_stable() {
    let p = good_params();
    let mut bytes = Vec::new();
    p.serialize(&mut bytes).unwrap();
    let mut expect = vec![p.token_decimal];
    expect.extend_from_slice(&p.sqrt_start_price.to_le_bytes());
    expect.extend_from_slice(&(p.curve.len() as u32).to_le_bytes());
    for c in &p.curve {
        expect.extend_from_slice(&c.sqrt_price.to_le_bytes());
        expect.extend_from_slice(&c.liquidity.to_le_bytes());
    }
    expect.extend_from_slice(&p.migration_quote_threshold.to_le_bytes());
    expect.extend_from_slice(&p.base_fee.cliff_fee_numerator.to_le_bytes());
    expect.extend_from_slice(&p.base_fee.first_factor.to_le_bytes());
    expect.extend_from_slice(&p.base_fee.second_factor.to_le_bytes());
    expect.extend_from_slice(&p.base_fee.third_factor.to_le_bytes());
    expect.push(p.base_fee.base_fee_mode);
    expect.push(0); // dynamic_fee: None
    expect.push(p.migration_fee_option);
    expect.extend_from_slice(&p.open_delay_secs.to_le_bytes());
    expect.extend_from_slice(&p.guard_secs.to_le_bytes());
    expect.extend_from_slice(&p.max_wallet_bps.to_le_bytes());
    expect.extend_from_slice(&p.max_buy_bps.to_le_bytes());
    expect.push(u8::from(p.p2p_locked));
    expect.extend_from_slice(&p.batch_wallet_cap.to_le_bytes());
    expect.extend_from_slice(&p.batch_total_cap.to_le_bytes());
    expect.extend_from_slice(&(p.recipients.len() as u32).to_le_bytes());
    for r in &p.recipients {
        expect.extend_from_slice(r.wallet.as_ref());
        expect.extend_from_slice(&r.bps.to_le_bytes());
    }
    // PQ v2: the creator's identity, last.
    expect.extend_from_slice(&p.pq_identity);
    assert_eq!(bytes, expect);
    let back = LaunchParams::deserialize(&mut &bytes[..]).unwrap();
    assert_eq!(back, p);
}

#[test]
fn params_hash_commits_to_every_field() {
    let hash = |p: &LaunchParams| {
        let mut b = Vec::new();
        p.serialize(&mut b).unwrap();
        solana_sha256_hasher::hash(&b).to_bytes()
    };
    let base = hash(&good_params());
    assert_eq!(base, hash(&good_params()));
    let mut changed = good_params();
    changed.p2p_locked = true;
    assert_ne!(base, hash(&changed));
    let mut changed = good_params();
    changed.recipients[1].bps -= 1;
    changed.recipients[0].bps += 1;
    assert_ne!(base, hash(&changed));
    // The identity that must attest the launch is part of the hash, so an
    // attestation (which signs `params_hash`) also binds it.
    let mut changed = good_params();
    changed.pq_identity[31] ^= 1;
    assert_ne!(base, hash(&changed));
}

fn pda(seeds: &[&[u8]], program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(seeds, program).0
}

#[test]
fn hook_recognizes_execute_batch() {
    use anchor_lang::Discriminator;
    // The hook lets a buy through the snipe shield only inside this instruction.
    assert_eq!(
        crate::instruction::ExecuteBatch::DISCRIMINATOR,
        &noised_hook::EXECUTE_BATCH_DISCRIMINATOR[..]
    );
}

#[test]
fn program_ids_and_pdas_match_their_sources() {
    assert_eq!(crate::ID, noised_hook::LAUNCHPAD_PROGRAM_ID);
    assert_eq!(HOOK_AUTHORITY_SEED, noised_hook::state::HOOK_AUTHORITY_SEED);
    assert_eq!(DBC_PROGRAM_ID, noised_hook::DBC_PROGRAM_ID);
    assert_eq!(DBC_PROGRAM_ID, dynamic_bonding_curve::ID);
    assert_eq!(DAMM_V2_PROGRAM_ID, cp_amm::ID);
    assert_eq!(
        DBC_EVENT_AUTHORITY,
        pda(&[b"__event_authority"], &DBC_PROGRAM_ID)
    );
    assert_eq!(
        DBC_POOL_AUTHORITY,
        pda(&[b"pool_authority"], &DBC_PROGRAM_ID)
    );
    assert_eq!(
        DAMM_V2_EVENT_AUTHORITY,
        pda(&[b"__event_authority"], &DAMM_V2_PROGRAM_ID)
    );
    assert_eq!(
        DAMM_V2_POOL_AUTHORITY,
        pda(&[b"pool_authority"], &DAMM_V2_PROGRAM_ID)
    );
    assert_eq!(WSOL_MINT, anchor_spl::token::spl_token::native_mint::ID);
}

/// `execute_batch`'s accounts as clients pass them: the 18 accounts of
/// round 1, then the hook-authority PDA (which signs `end_snipe_shield`),
/// this launch's policy (writable: the hook ends its shield there) and the
/// hook program. The 4 hook accounts of the swap follow as remaining
/// accounts, the policy among them (read-only there, writable in the
/// transaction), and the instructions sysvar among them is the one passed
/// to `end_snipe_shield`.
#[test]
fn execute_batch_accounts_end_the_snipe_shield() {
    let k = |b: u8| Pubkey::new_from_array([b; 32]);
    let mint = k(8);
    let policy = pda(
        &[noised_hook::state::POLICY_SEED, mint.as_ref()],
        &noised_hook::ID,
    );
    let hook_authority = pda(&[HOOK_AUTHORITY_SEED], &crate::ID);
    let metas = crate::accounts::ExecuteBatch {
        payer: k(1),
        launch: k(2),
        batch_authority: k(3),
        dbc_config: k(4),
        pool: k(5),
        base_vault: k(6),
        quote_vault: k(7),
        base_mint: mint,
        quote_mint: WSOL_MINT,
        batch_quote_escrow: k(9),
        batch_base_escrow: k(10),
        dbc_pool_authority: DBC_POOL_AUTHORITY,
        dbc_program: DBC_PROGRAM_ID,
        dbc_event_authority: DBC_EVENT_AUTHORITY,
        token_program: anchor_spl::token::ID,
        token_2022_program: anchor_spl::token_2022::ID,
        associated_token_program: anchor_spl::associated_token::ID,
        system_program: anchor_lang::system_program::ID,
        hook_authority,
        policy,
        hook_program: noised_hook::ID,
    }
    .to_account_metas(None);
    assert_eq!(metas.len(), 21);
    assert_eq!(metas[17].pubkey, anchor_lang::system_program::ID);
    assert_eq!(
        flags(&metas[18..]),
        [
            (hook_authority, false, false),
            (policy, false, true),
            (noised_hook::ID, false, false)
        ]
    );
    let hook_accounts = crate::hook_accounts::expected(&mint);
    assert_eq!(hook_accounts[1], policy);
    assert_eq!(
        hook_accounts[crate::hook_accounts::INSTRUCTIONS_SYSVAR_INDEX],
        noised_hook::INSTRUCTIONS_SYSVAR_ID
    );
    // The hook instruction the launchpad signs for with that PDA.
    let cpi = noised_hook::accounts::EndSnipeShield {
        launchpad_authority: hook_authority,
        policy,
        instructions: noised_hook::INSTRUCTIONS_SYSVAR_ID,
    }
    .to_account_metas(None);
    assert_eq!(
        flags(&cpi),
        [
            (hook_authority, true, false),
            (policy, false, true),
            (noised_hook::INSTRUCTIONS_SYSVAR_ID, false, false)
        ]
    );
}

fn flags(m: &[AccountMeta]) -> Vec<(Pubkey, bool, bool)> {
    m.iter()
        .map(|m| (m.pubkey, m.is_signer, m.is_writable))
        .collect()
}

/// The account lists PQ v2 and the on-chain metadata changed, pinned for
/// the SDK and the IDL: `publish_metadata` (new: payer, launch, the record,
/// system program), `attest_launch` (the identity is the signing key's; the
/// metadata record, read-only, before the system program), `launch` (+ the
/// attestation and then the metadata record, last; any payer, first),
/// `initialize_protocol` (the treasury is an account), `commit` (+ the two
/// payout owners, then the payout vault record when the token owner is a
/// vault, last) and `claim` (the payout owners replace the owner, their ATAs
/// replace the owner's).
#[test]
fn pq_v2_account_lists_are_pinned() {
    let k = |b: u8| Pubkey::new_from_array([b; 32]);
    let launch = k(2);
    let attestation = pda(&[ATTESTATION_SEED, launch.as_ref()], &crate::ID);
    let identity = pda(&[IDENTITY_SEED, &[0x1D; 32]], &crate::ID);
    let token_meta = pda(&[METADATA_SEED, launch.as_ref(), &[0x3C; 32]], &crate::ID);
    let publish = crate::accounts::PublishMetadata {
        payer: k(1),
        launch,
        token_meta,
        system_program: anchor_lang::system_program::ID,
    }
    .to_account_metas(None);
    assert_eq!(
        flags(&publish),
        [
            (k(1), true, true),
            (launch, false, false),
            (token_meta, false, true),
            (anchor_lang::system_program::ID, false, false),
        ]
    );
    let rules = pda(&[RULES_SEED, launch.as_ref(), &[0x4D; 32]], &crate::ID);
    let attest = |rules: Option<Pubkey>| {
        crate::accounts::AttestLaunch {
            payer: k(1),
            launch,
            identity,
            attestation,
            token_meta,
            system_program: anchor_lang::system_program::ID,
            rules,
        }
        .to_account_metas(None)
    };
    // Programmable launches: the rules record (read-only) last, or the
    // program id in its place (Anchor's `None`) for no rules.
    for (record, slot) in [(Some(rules), rules), (None, crate::ID)] {
        assert_eq!(
            flags(&attest(record)),
            [
                (k(1), true, true),
                (launch, false, false),
                (identity, false, true),
                (attestation, false, true),
                (token_meta, false, false),
                (anchor_lang::system_program::ID, false, false),
                (slot, false, false),
            ]
        );
    }

    let launch_metas = crate::accounts::LaunchToken {
        payer: k(1),
        launch,
        launch_authority: k(3),
        dbc_config: k(4),
        base_mint: k(5),
        pool: k(6),
        base_vault: k(7),
        quote_vault: k(8),
        quote_mint: WSOL_MINT,
        dbc_pool_authority: DBC_POOL_AUTHORITY,
        hook_authority: k(9),
        extra_account_meta_list: k(10),
        policy: k(11),
        certificate: k(12),
        hook_program: noised_hook::ID,
        dbc_program: DBC_PROGRAM_ID,
        dbc_event_authority: DBC_EVENT_AUTHORITY,
        token_2022_program: anchor_spl::token_2022::ID,
        token_program: anchor_spl::token::ID,
        system_program: anchor_lang::system_program::ID,
        attestation,
        token_meta,
        rules: Some(rules),
    }
    .to_account_metas(None);
    assert_eq!(launch_metas.len(), 23);
    assert_eq!(flags(&launch_metas[..1]), [(k(1), true, true)]);
    assert_eq!(
        flags(&launch_metas[20..]),
        [
            (attestation, false, false),
            (token_meta, false, false),
            (rules, false, false)
        ]
    );

    let init = crate::accounts::InitializeProtocol {
        authority: k(1),
        protocol: k(2),
        treasury: k(3),
        program: crate::ID,
        program_data: k(4),
        system_program: anchor_lang::system_program::ID,
    }
    .to_account_metas(None);
    assert_eq!(flags(&init[2..3]), [(k(3), false, false)]);

    let commit = crate::accounts::CommitToBatch {
        owner: k(1),
        launch,
        commit: k(3),
        batch_authority: k(4),
        quote_mint: WSOL_MINT,
        owner_quote_account: k(5),
        batch_quote_escrow: k(6),
        token_program: anchor_spl::token::ID,
        associated_token_program: anchor_spl::associated_token::ID,
        system_program: anchor_lang::system_program::ID,
        token_owner: k(7),
        refund_owner: k(8),
        payout_vault: Some(k(9)),
    }
    .to_account_metas(None);
    assert_eq!(commit.len(), 13);
    assert_eq!(
        flags(&commit[10..]),
        [
            (k(7), false, false),
            (k(8), false, false),
            (k(9), false, true)
        ]
    );
    // Committing to the committer's own wallet: the slot holds the
    // program id (Anchor's `None`).
    let own = crate::accounts::CommitToBatch {
        owner: k(1),
        launch,
        commit: k(3),
        batch_authority: k(4),
        quote_mint: WSOL_MINT,
        owner_quote_account: k(5),
        batch_quote_escrow: k(6),
        token_program: anchor_spl::token::ID,
        associated_token_program: anchor_spl::associated_token::ID,
        system_program: anchor_lang::system_program::ID,
        token_owner: k(1),
        refund_owner: k(1),
        payout_vault: None,
    }
    .to_account_metas(None);
    assert_eq!(flags(&own[12..]), [(crate::ID, false, false)]);

    let claim = crate::accounts::Claim {
        payer: k(1),
        launch,
        commit: k(3),
        token_owner: k(4),
        refund_owner: k(5),
        batch_authority: k(6),
        base_mint: k(7),
        quote_mint: WSOL_MINT,
        batch_quote_escrow: k(8),
        batch_base_escrow: Some(k(9)),
        refund_owner_ata: Some(k(10)),
        token_owner_ata: Some(k(11)),
        token_program: anchor_spl::token::ID,
        token_2022_program: anchor_spl::token_2022::ID,
        associated_token_program: anchor_spl::associated_token::ID,
        system_program: anchor_lang::system_program::ID,
    }
    .to_account_metas(None);
    assert_eq!(claim.len(), 16);
    assert_eq!(
        flags(&claim[3..5]),
        [(k(4), false, false), (k(5), false, false)]
    );
    assert_eq!(
        flags(&claim[9..12]),
        [
            (k(9), false, true),
            (k(10), false, true),
            (k(11), false, true)
        ]
    );
}

#[test]
fn policy_bounds_fit_the_hook_bounds() {
    use noised_hook::rules::bounds;
    // The longest scheduled shield (the longest commit window plus the
    // execution window, 2,400 s) fits the hook's own one-hour bound.
    assert_eq!(MAX_OPEN_DELAY + EXECUTION_GRACE_SECS, 2_400);
    assert_eq!(bounds::MAX_SNIPE_SHIELD_SECS, 3_600);
    assert!(i64::from(MAX_OPEN_DELAY + EXECUTION_GRACE_SECS) <= bounds::MAX_SNIPE_SHIELD_SECS);
    assert!(i64::from(MIN_OPEN_DELAY + EXECUTION_GRACE_SECS) <= i64::from(MAX_GUARD_SECS));
    assert!(i64::from(MAX_GUARD_SECS) <= bounds::MAX_GUARD_SECS);
    assert_eq!(
        u64::from(MIN_MAX_WALLET_BPS) * bounds::MIN_MAX_WALLET_DIVISOR,
        BPS_DENOMINATOR
    );
    assert_eq!(bounds::MIN_MAX_BUY_DIVISOR, BPS_DENOMINATOR);
}

//! LiteSVM smoke tests: our launchpad, hook and vault SBF builds against the
//! mainnet Meteora DBC, Token-2022, SPL Token and ATA programs. How to build
//! and run: see `src/lib.rs` of this crate.

mod common;

use anchor_lang::AnchorSerialize;
use anchor_spl::token_interface::{
    spl_token_2022::{
        self,
        extension::{
            metadata_pointer::MetadataPointer, transfer_hook::TransferHook,
            BaseStateWithExtensions, ExtensionType, StateWithExtensions,
        },
        state::Mint,
    },
    spl_token_metadata_interface::state::TokenMetadata,
};
use common::{launch::*, pq, world::*, *};
use noised_hook::state::HookPolicy;
use noised_launchpad::{
    constants::*,
    dynamic_bonding_curve::accounts::ConfigWithTransferHook,
    error::LaunchpadError as E,
    state::{checks, Attestation, Certificate, Commit, Identity, Launch, LaunchStatus},
};
use solana_keypair::Keypair;
use solana_signer::Signer;

/// Hook errors (noised_hook::HookError, numbered from 6000).
const HOOK_SNIPE_SHIELD: u32 = 6000;
const HOOK_TRANSFERS_LOCKED: u32 = 6001;
const HOOK_MAX_BUY: u32 = 6002;

#[test]
fn launch_is_certified_and_the_mint_is_safe() {
    let mut w = launched();
    let (env, k) = (&w.env, w.k);
    let l: Launch = env.anchor(&k.launch);
    let cert: Certificate = env.anchor(&k.certificate);

    // Certificate.
    assert_eq!(cert.checks, checks::ALL);
    assert_ne!(cert.checks & checks::PQ_ATTESTED, 0);
    assert_eq!(
        (cert.version, cert.policy_version, SAFETY_POLICY_VERSION),
        (4, 3, 3)
    );
    // No rules: none attested, none bound.
    assert_eq!(cert.rules_hash, [0; 32]);
    assert_eq!(cert.checks & checks::RULES_BOUND, 0);
    assert_ne!(cert.checks & checks::METADATA_ONCHAIN, 0);
    // The certificate names the attested metadata record.
    assert_eq!(cert.metadata, pq::token_meta_of(&k, META));
    assert_eq!(
        (
            cert.launch,
            cert.base_mint,
            cert.pool,
            cert.dbc_config,
            cert.creator
        ),
        (k.launch, k.mint, k.pool, k.dbc_config, w.creator.pubkey())
    );
    let mut encoded = Vec::new();
    w.params.serialize(&mut encoded).unwrap();
    assert_eq!(
        cert.params_hash,
        solana_sha256_hasher::hash(&encoded).to_bytes()
    );
    assert_eq!(
        (
            cert.token_decimal,
            cert.migration_quote_threshold,
            cert.migration_fee_option
        ),
        (6, 10 * LAMPORTS_PER_SOL, 2)
    );
    assert_eq!(cert.platform_fee_bps, 2_000);
    assert_eq!(
        (cert.recipients[0].wallet, cert.recipients[0].bps),
        (w.recipients[0], 7_000)
    );
    assert_eq!(
        (cert.recipients[1].wallet, cert.recipients[1].bps),
        (w.recipients[1], 3_000)
    );
    assert_eq!(cert.recipients[2].bps + cert.recipients[3].bps, 0);

    // Post-quantum origin: the certificate names the identity the launch
    // parameters committed to and the attestation that identity signed,
    // which holds the whole LMS signature over this launch's message.
    let pq_identity = pq::identity_id();
    assert_eq!(
        (l.pq_identity, w.params.pq_identity),
        (pq_identity, pq_identity)
    );
    let attestation: Attestation = env.anchor(&k.attestation);
    assert_eq!(
        (
            attestation.version,
            attestation.launch,
            attestation.pq_identity
        ),
        (Attestation::VERSION, k.launch, pq_identity)
    );
    assert_eq!(
        (cert.pq_identity, cert.pq_leaf, cert.attested_slot),
        (pq_identity, attestation.leaf, attestation.slot)
    );
    assert_eq!(attestation.metadata_hash, pq::metadata_hash(META));
    // The signed terms: a window that opened when the attestation was
    // signed and lasts an hour; the launch happened inside it.
    let terms = pq::Terms {
        not_before: attestation.not_before,
        not_after: attestation.not_after,
        rules_hash: attestation.rules_hash,
    };
    assert_eq!(
        terms,
        pq::Terms::window(l.launch_ts, l.launch_ts + MAX_LAUNCH_WINDOW_SECS)
    );
    let message = pq::message(env, &k, META, &terms);
    assert_eq!(
        attestation.message_hash,
        solana_sha256_hasher::hash(&message).to_bytes()
    );
    assert_eq!(
        u32::from(attestation.leaf),
        pq::leaf_probe_start(pq::identity(), &message),
        "the first leaf probed for this message"
    );
    let pk = pq::public_key(pq::identity());
    assert_eq!(
        noised_lmots::lms_verify::<noised_lmots::Sha2>(&pk, &message, &attestation.signature),
        Some(u32::from(attestation.leaf)),
        "anyone re-verifies the stored signature"
    );
    let identity: Identity = env.anchor(&pq::identity_pda(&pq_identity));
    assert_eq!((identity.version, identity.public_key), (1, pk));
    assert_eq!(identity.used_count, 1);
    assert!(pq::leaf_used(&identity, u32::from(attestation.leaf)));

    // Timeline.
    assert_eq!((l.status, l.version), (LaunchStatus::Live, 2));
    assert_eq!((l.base_mint, l.pool), (k.mint, k.pool));
    assert_eq!(l.launch_ts, env.now());
    // A one-minute commit window (the shortest), then the ten-minute
    // execution window (round 2).
    assert_eq!((MIN_OPEN_DELAY, EXECUTION_GRACE_SECS), (60, 600));
    assert_eq!(l.commit_end_ts, l.launch_ts + 60);
    assert_eq!(l.execute_end_ts, l.commit_end_ts + 600);
    assert_eq!(l.guard_end_ts, l.launch_ts + 3_600);
    assert_eq!(
        (
            cert.launched_at,
            cert.snipe_shield_end_ts,
            cert.execute_end_ts,
            cert.guard_end_ts
        ),
        (
            l.launch_ts,
            l.execute_end_ts,
            l.execute_end_ts,
            l.guard_end_ts
        )
    );

    // The live mint, checked independently of the program.
    let mint_account = env.account(&k.mint).unwrap();
    assert_eq!(mint_account.owner, spl_token_2022::ID);
    let mint = StateWithExtensions::<Mint>::unpack(&mint_account.data).unwrap();
    assert!(mint.base.mint_authority.is_none() && mint.base.freeze_authority.is_none());
    assert_eq!(
        (mint.base.decimals, mint.base.supply),
        (6, cert.initial_supply)
    );
    let mut types = mint.get_extension_types().unwrap();
    types.sort_by_key(|t| *t as u16);
    let mut want = vec![
        ExtensionType::MetadataPointer,
        ExtensionType::TokenMetadata,
        ExtensionType::TransferHook,
    ];
    want.sort_by_key(|t| *t as u16);
    assert_eq!(types, want);
    let hook = mint.get_extension::<TransferHook>().unwrap();
    assert_eq!(
        Option::<Pubkey>::from(hook.program_id),
        Some(noised_hook::ID)
    );
    assert_eq!(
        Option::<Pubkey>::from(hook.authority),
        Some(DBC_POOL_AUTHORITY)
    );
    let pointer = mint.get_extension::<MetadataPointer>().unwrap();
    assert_eq!(Option::<Pubkey>::from(pointer.authority), None);
    assert_eq!(
        Option::<Pubkey>::from(pointer.metadata_address),
        Some(k.mint)
    );
    let metadata = mint.get_variable_len_extension::<TokenMetadata>().unwrap();
    assert_eq!(Option::<Pubkey>::from(metadata.update_authority), None);
    assert_eq!(
        (
            metadata.name.as_str(),
            metadata.symbol.as_str(),
            metadata.uri.as_str()
        ),
        (NAME, SYMBOL, URI)
    );

    // The hook policy.
    let policy: HookPolicy = env.anchor(&k.policy);
    assert_eq!(
        (policy.mint, policy.pool, policy.base_vault),
        (k.mint, k.pool, k.base_vault)
    );
    assert_eq!(
        (policy.snipe_shield_end_ts, policy.guard_end_ts),
        (l.execute_end_ts, l.guard_end_ts)
    );
    assert_eq!(policy.max_wallet, cert.initial_supply / 100);
    assert_eq!(policy.max_buy, cert.initial_supply / 200);
    assert_eq!(
        (cert.max_wallet, cert.max_buy),
        (policy.max_wallet, policy.max_buy)
    );
    assert!(policy.p2p_locked && cert.p2p_locked);
    assert_eq!(
        policy.exempt,
        [
            k.batch_authority,
            k.launch_authority,
            Pubkey::default(),
            Pubkey::default()
        ]
    );

    // The DBC config holds the fixed values (decoded independently).
    let cfg: ConfigWithTransferHook = env.anchor(&k.dbc_config);
    let c = &cfg.config;
    assert_eq!(cfg.transfer_hook_program, noised_hook::ID);
    assert_eq!(
        (c.quote_mint, c.fee_claimer, c.leftover_receiver),
        (WSOL_MINT, k.launch_authority, k.launch_authority)
    );
    assert_eq!(
        (
            c.partner_permanent_locked_liquidity_percentage,
            c.partner_liquidity_percentage
        ),
        (100, 0)
    );
    assert_eq!(
        (
            c.creator_liquidity_percentage,
            c.creator_permanent_locked_liquidity_percentage
        ),
        (0, 0)
    );
    assert_eq!(
        (
            c.migration_fee_percentage,
            c.creator_migration_fee_percentage,
            c.creator_trading_fee_percentage
        ),
        (0, 0, 0)
    );
    assert_eq!(
        (
            c.token_update_authority,
            c.token_type,
            c.collect_fee_mode,
            c.migration_option
        ),
        (1, 1, 0, 1)
    );
    assert_eq!(
        (
            c.fixed_token_supply_flag,
            c.pool_creation_fee,
            c.enable_first_swap_with_min_fee
        ),
        (0, 0, 0)
    );

    // A launch happens once.
    let mint2 = Keypair::new();
    let k2 = Keys::new(&k.creator, k.seed, mint2.pubkey());
    w.env
        .send(
            &[launch(&w.creator.pubkey(), &k2, NAME, SYMBOL, URI)],
            &[&w.creator, &mint2],
        )
        .fails_with(
            code(E::WrongLaunchState),
            "WrongLaunchState",
            "second launch",
        );
}

#[test]
fn fair_open_batch_end_to_end() {
    let mut w = launched();
    let k = w.k;
    let env = &mut w.env;
    let l: Launch = env.anchor(&k.launch);
    let alice = env.funded(10);
    let bob = env.funded(10);
    let carol = env.funded(10);
    for (who, sol) in [(&alice, 1u64), (&bob, 3), (&carol, 2)] {
        env.send(&wrap_sol(&who.pubkey(), sol * LAMPORTS_PER_SOL), &[who])
            .expect_ok("wrap SOL");
    }
    env.send(
        &[create_ata(
            &carol.pubkey(),
            &carol.pubkey(),
            &k.mint,
            &spl_token_2022::ID,
        )],
        &[&carol],
    )
    .expect_ok("carol base ATA");

    // Nobody, creator included, can buy from the pool during the shield.
    env.send(
        &[dbc_swap(&carol.pubkey(), &k, true, LAMPORTS_PER_SOL / 10)],
        &[&carol],
    )
    .fails_with(
        HOOK_SNIPE_SHIELD,
        "SnipeShield",
        "snipe during the commit window",
    );

    env.send(&[commit(&alice.pubkey(), &k, LAMPORTS_PER_SOL)], &[&alice])
        .expect_ok("alice commits");
    env.send(&[commit(&bob.pubkey(), &k, 2 * LAMPORTS_PER_SOL)], &[&bob])
        .expect_ok("bob commits");
    env.send(&[commit(&bob.pubkey(), &k, LAMPORTS_PER_SOL)], &[&bob])
        .expect_ok("bob commits more");
    env.send(&[commit(&bob.pubkey(), &k, 0)], &[&bob])
        .fails_with(code(E::ZeroAmount), "ZeroAmount", "zero commit");
    let c: Commit = env.anchor(&k.commit(&bob.pubkey()));
    assert_eq!(
        (c.owner, c.amount, c.claimed),
        (bob.pubkey(), 3 * LAMPORTS_PER_SOL, false)
    );

    let payer = env.payer.pubkey();
    env.send(&[claim(&payer, &k, &alice.pubkey(), false, true)], &[])
        .fails_with(
            code(E::BatchPending),
            "BatchPending",
            "claim before execution",
        );
    env.send(&[execute_batch(&payer, &k)], &[]).fails_with(
        code(E::NotExecuteWindow),
        "NotExecuteWindow",
        "execute during commits",
    );

    env.set_time(l.commit_end_ts);
    env.send(&[commit(&alice.pubkey(), &k, 1)], &[&alice])
        .fails_with(code(E::NotCommitWindow), "NotCommitWindow", "late commit");
    let executed = env
        .send(&[execute_batch(&payer, &k)], &[])
        .expect_ok("execute_batch");
    println!("execute_batch: {} CU, {} bytes", executed.cu, executed.size);
    env.send(&[execute_batch(&payer, &k)], &[]).fails_with(
        code(E::AlreadyExecuted),
        "AlreadyExecuted",
        "second execution",
    );

    let l: Launch = env.anchor(&k.launch);
    let total = 4 * LAMPORTS_PER_SOL;
    assert!(l.executed && l.total_committed == total);
    assert!(l.quote_spent > 0 && l.quote_spent <= total && l.tokens_out > 0);
    println!(
        "batch: spent {} of {} lamports for {} base units",
        l.quote_spent, total, l.tokens_out
    );
    let escrow = base_ata(&k.batch_authority, &k.mint);
    assert_eq!(env.token_amount(&escrow), l.tokens_out);

    // The batch ended the snipe shield at once (round 2): the policy's end is
    // the second the batch executed, and the certificate keeps the schedule.
    let policy: HookPolicy = env.anchor(&k.policy);
    let cert: Certificate = env.anchor(&k.certificate);
    assert_eq!(
        (policy.snipe_shield_end_ts, policy.guard_end_ts),
        (l.commit_end_ts, l.guard_end_ts)
    );
    assert_eq!(cert.snipe_shield_end_ts, l.execute_end_ts);
    let ended = events::<noised_hook::SnipeShieldEnded>(&executed.logs);
    assert_eq!(ended.len(), 1, "{}", executed.logs.join("\n"));
    let e = &ended[0];
    assert_eq!(
        (e.mint, e.pool, e.scheduled_end_ts, e.snipe_shield_end_ts),
        (k.mint, k.pool, l.execute_end_ts, l.commit_end_ts)
    );

    // Public trading opens in that same second, long before the execution
    // window ends: small buys pass, oversized buys hit max-buy.
    let sent = env
        .send(
            &[dbc_swap(&carol.pubkey(), &k, true, LAMPORTS_PER_SOL / 200)],
            &[&carol],
        )
        .expect_ok("small public buy right after the batch");
    println!(
        "public buy right after the batch: {} CU, {} bytes",
        sent.cu, sent.size
    );
    env.send(
        &[dbc_swap(&carol.pubkey(), &k, true, LAMPORTS_PER_SOL)],
        &[&carol],
    )
    .fails_with(HOOK_MAX_BUY, "MaxBuy", "oversized buy during the guard");

    // Claims are permissionless and pay pro rata (carol cranks alice's).
    let alice_wsol_before = env.token_amount(&wsol_ata(&alice.pubkey()));
    env.send(
        &[claim(&carol.pubkey(), &k, &alice.pubkey(), true, true)],
        &[&carol],
    )
    .expect_ok("claim alice");
    env.send(&[claim(&payer, &k, &bob.pubkey(), true, true)], &[])
        .expect_ok("claim bob");
    env.send(&[claim(&payer, &k, &bob.pubkey(), true, true)], &[])
        .fails_with(code(E::AlreadyClaimed), "AlreadyClaimed", "double claim");
    let unspent = total - l.quote_spent;
    let alice_tokens = env.token_amount(&base_ata(&alice.pubkey(), &k.mint));
    let bob_tokens = env.token_amount(&base_ata(&bob.pubkey(), &k.mint));
    assert_eq!(alice_tokens, (u128::from(l.tokens_out) / 4) as u64);
    assert_eq!(bob_tokens, (u128::from(l.tokens_out) * 3 / 4) as u64);
    assert_eq!(
        env.token_amount(&wsol_ata(&alice.pubkey())) - alice_wsol_before,
        unspent / 4
    );
    assert!(alice_tokens + bob_tokens <= l.tokens_out);
    assert_eq!(
        env.token_amount(&escrow),
        l.tokens_out - alice_tokens - bob_tokens
    );
    let l2: Launch = env.anchor(&k.launch);
    assert_eq!(l2.tokens_claimed, alice_tokens + bob_tokens);
    // Batch claims are exempt from max-wallet: alice holds more than the cap.
    assert!(
        alice_tokens
            > l2.max_wallet_bps as u64 * env.anchor::<Certificate>(&k.certificate).initial_supply
                / 10_000
    );

    // Sells always pass; once the scheduled end of the shield is past too,
    // nothing about public buys changes.
    env.send(
        &[dbc_swap(&alice.pubkey(), &k, false, alice_tokens / 2)],
        &[&alice],
    )
    .expect_ok("alice sells");
    env.set_time(l.execute_end_ts);
    env.send(
        &[dbc_swap(&carol.pubkey(), &k, true, LAMPORTS_PER_SOL / 200)],
        &[&carol],
    )
    .expect_ok("small public buy after the scheduled end");
    env.send(
        &[dbc_swap(&carol.pubkey(), &k, true, LAMPORTS_PER_SOL)],
        &[&carol],
    )
    .fails_with(HOOK_MAX_BUY, "MaxBuy", "oversized buy, later in the guard");
    // Wallet-to-wallet transfers are paused during the guard.
    env.send(
        &[hooked_transfer(&k, &alice.pubkey(), &carol.pubkey(), 1)],
        &[&alice],
    )
    .fails_with(
        HOOK_TRANSFERS_LOCKED,
        "TransfersLocked",
        "p2p during the guard",
    );

    // Fees: claim into the launch authority, then route by the fixed rules.
    let sent = env
        .send(&[claim_fees(&payer, &k)], &[])
        .expect_ok("claim_fees");
    println!("claim_fees: {} CU, {} bytes", sent.cu, sent.size);
    let fees = env.token_amount(&wsol_ata(&k.launch_authority));
    assert!(fees > 0);
    let sent = env
        .send(&[distribute(&payer, &k, &w.treasury, &w.recipients)], &[])
        .expect_ok("distribute");
    println!(
        "distribute: {} CU, {} bytes, {} lamports routed",
        sent.cu, sent.size, fees
    );
    let platform = fees * 2_000 / 10_000;
    let creator_share = fees - platform;
    let r0 = creator_share * 7_000 / 10_000;
    assert_eq!(env.token_amount(&wsol_ata(&w.treasury)), platform);
    assert_eq!(env.token_amount(&wsol_ata(&w.recipients[0])), r0);
    assert_eq!(
        env.token_amount(&wsol_ata(&w.recipients[1])),
        creator_share - r0
    );
    assert_eq!(env.token_amount(&wsol_ata(&k.launch_authority)), 0);
    env.send(&[distribute(&payer, &k, &w.treasury, &w.recipients)], &[])
        .fails_with(
            code(E::NothingToDo),
            "NothingToDo",
            "nothing left to distribute",
        );
}

#[test]
fn expired_batch_refunds_in_full() {
    let mut w = launched();
    let k = w.k;
    let env = &mut w.env;
    let l: Launch = env.anchor(&k.launch);
    let alice = env.funded(5);
    env.send(&wrap_sol(&alice.pubkey(), LAMPORTS_PER_SOL), &[&alice])
        .expect_ok("wrap");
    env.send(&[commit(&alice.pubkey(), &k, 700_000_001)], &[&alice])
        .expect_ok("commit");
    let before = env.token_amount(&wsol_ata(&alice.pubkey()));

    // Nobody executed in the window: the batch expired, and the shield
    // lasted its whole schedule.
    env.set_time(l.execute_end_ts);
    let payer = env.payer.pubkey();
    env.send(&[execute_batch(&payer, &k)], &[]).fails_with(
        code(E::NotExecuteWindow),
        "NotExecuteWindow",
        "execute after the window",
    );
    let policy: HookPolicy = env.anchor(&k.policy);
    assert_eq!(policy.snipe_shield_end_ts, l.execute_end_ts);
    env.send(&[claim(&payer, &k, &alice.pubkey(), false, false)], &[])
        .expect_ok("refund");
    assert_eq!(
        env.token_amount(&wsol_ata(&alice.pubkey())) - before,
        700_000_001
    );
    env.send(&[claim(&payer, &k, &alice.pubkey(), false, false)], &[])
        .fails_with(code(E::AlreadyClaimed), "AlreadyClaimed", "double refund");
    assert_eq!(env.token_amount(&wsol_ata(&k.batch_authority)), 0);
}

/// The largest metadata (32-byte name, 10-byte symbol, 200-byte external
/// uri): `launch` takes no arguments since the metadata is an on-chain
/// record, so its transaction no longer depends on the metadata; with both
/// compute-budget instructions, paid by the creator, it is a legacy
/// transaction far under the limit, and the mint holds the record's name,
/// symbol and uri.
#[test]
fn max_size_launch_fits_a_legacy_transaction() {
    let mut w = created_with(|_| {});
    let k = w.k;
    let (name, symbol, uri) = (
        "N".repeat(MAX_NAME_LEN),
        "S".repeat(MAX_SYMBOL_LEN),
        format!("https://{}", "u".repeat(MAX_URI_LEN - 8)),
    );
    assert_eq!(uri.len(), MAX_URI_LEN);
    let meta = (name.as_str(), symbol.as_str(), uri.as_str());
    let creator = w.creator.pubkey();
    let sent = pq::publish(&mut w.env, &k, meta);
    println!(
        "publish_metadata of the largest name, symbol and external uri: {} CU, {} bytes (v1 limit {V1_MAX_TRANSACTION_SIZE})",
        sent.cu, sent.size
    );
    let sent = pq::attest(&mut w.env, &k, meta);
    println!(
        "attest_launch with the largest metadata: {} CU, {} bytes (v1 limit {V1_MAX_TRANSACTION_SIZE})",
        sent.cu, sent.size
    );
    let ixs = [
        solana_compute_budget_interface::ComputeBudgetInstruction::set_compute_unit_price(1_000),
        launch(&creator, &k, &name, &symbol, &uri),
    ];
    let sent = w
        .env
        .send_with(&creator, &ixs, &[&w.creator, &w.mint], true)
        .expect_ok("max-size launch");
    println!(
        "max-size launch: {} CU, {} bytes (limit {PACKET_DATA_SIZE})",
        sent.cu, sent.size
    );
    assert!(sent.size <= PACKET_DATA_SIZE);
    let cert: Certificate = w.env.anchor(&k.certificate);
    assert_eq!(cert.checks, checks::ALL);
    let mint = w.env.account(&k.mint).unwrap();
    let state = StateWithExtensions::<Mint>::unpack(&mint.data).unwrap();
    let metadata = state.get_variable_len_extension::<TokenMetadata>().unwrap();
    assert_eq!(
        (metadata.name, metadata.symbol, metadata.uri),
        (name.clone(), symbol.clone(), uri.clone())
    );

    // Metadata over the limits: no record of it can be published, so a
    // valid signature over its hash lands (its leaf is burned) but attests
    // nothing.
    let too_long = format!("{uri}u");
    let mint2 = Keypair::new();
    let k2 = Keys::new(&creator, [9; 32], mint2.pubkey());
    w.env
        .send(
            &[create_launch(&creator, &k2, w.params.clone())],
            &[&w.creator],
        )
        .expect_ok("second launch config");
    let over = ("n", "s", too_long.as_str());
    pq::try_publish(&mut w.env, &k2, over).fails_with(
        code(E::MetadataTooLong),
        "MetadataTooLong",
        "uri over 200 bytes",
    );
    let terms = pq::Terms::now(&w.env);
    let msg = pq::message(&w.env, &k2, over, &terms);
    let q = pq::next_free_leaf(&w.env, pq::identity(), &msg);
    let signed = pq::sign_with(&w.env, pq::identity(), q, &k2, over, terms);
    pq::send_attestation(&mut w.env, &k2, &signed, over)
        .expect_ok("a signature over a uri of 201 bytes burns its leaf");
    let empty: Attestation = w.env.anchor(&k2.attestation);
    assert_eq!(empty.launch, Pubkey::default());
}

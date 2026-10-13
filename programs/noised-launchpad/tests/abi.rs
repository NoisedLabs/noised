//! The framework-free program keeps the Anchor build's ABI byte for byte.
//! These host tests check the program's own encoders, decoders, layouts and
//! interfaces against what the Anchor build ran: Anchor's serialization and
//! discriminators, the IDL (hand-maintained, unchanged), anchor-lang's error
//! table, Borsh, the IDL-generated Meteora DBC / DAMM v2 clients and
//! zero-copy types (`declare_program!`, host-only here), the hook crate's
//! client and policy type, spl-token-2022, and the Anchor build's own code
//! (copied below, verbatim but for its error plumbing) for the mint and
//! config post-conditions and the 128-bit math. Random inputs (malformed
//! ones included) must give the same result, or the same error. The shared
//! parsers and checks are tested in `crates/noised-onchain/tests`.

use std::collections::{BTreeMap, BTreeSet};

use anchor_lang::{
    error::ErrorCode, AccountDeserialize, AccountSerialize, AnchorDeserialize, AnchorSerialize,
    Discriminator, Event, InstructionData, ToAccountMetas,
};
use anchor_spl::token_interface::{
    spl_pod::optional_keys::OptionalNonZeroPubkey,
    spl_token_2022::{
        self,
        extension::{
            metadata_pointer::MetadataPointer, mint_close_authority::MintCloseAuthority,
            transfer_hook::TransferHook, BaseStateWithExtensions, BaseStateWithExtensionsMut,
            ExtensionType, StateWithExtensions, StateWithExtensionsMut,
        },
        state::Mint,
    },
    spl_token_metadata_interface::state::TokenMetadata,
};
use noised_launchpad::{
    accounts, checks,
    constants::{
        dbc as dbc_consts, BPS_DENOMINATOR, DAMM_V2_PROGRAM_ID, DBC_POOL_AUTHORITY, DBC_PROGRAM_ID,
        HOOK_AUTHORITY_SEED, WSOL_MINT,
    },
    cp_amm, dbc_params, discriminator, dynamic_bonding_curve as dbc_idl, error,
    events::*,
    external::{damm, dbc, hook},
    instruction, math, policy,
    state::{
        launch_offsets as at, Attestation, Authorization, BaseFeeParams, Certificate, Commit,
        CurvePoint, DynamicFeeParams, FeeRecipient, Identity, Launch, LaunchData, LaunchParams,
        LaunchRules, LaunchRulesRef, LaunchStatus, PayoutVault, Protocol, TokenMeta, TokenMetaRef,
    },
    Pubkey, ID,
};
use noised_onchain::{
    args::Reader,
    host::{
        fuzz::{random_mint, Rng},
        take_cpis, take_logs, HostAccount,
    },
    sys::Log,
    AccountView,
};
use solana_instruction::AccountMeta;

fn sha256_8(input: &str) -> [u8; 8] {
    noised_onchain::hashv(&[input.as_bytes()])[..8]
        .try_into()
        .unwrap()
}

fn idl() -> serde_json::Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../idls/noised_launchpad.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("read the IDL")).expect("IDL JSON")
}

fn idl_bytes(v: &serde_json::Value) -> Vec<u8> {
    v.as_array()
        .expect("byte array")
        .iter()
        .map(|b| b.as_u64().unwrap() as u8)
        .collect()
}

fn idl_named<'a>(list: &'a serde_json::Value, name: &str) -> &'a serde_json::Value {
    list.as_array()
        .unwrap()
        .iter()
        .find(|x| x["name"] == name)
        .unwrap_or_else(|| panic!("IDL entry {name}"))
}

trait RngExt {
    fn u16(&mut self) -> u16;
    fn u32(&mut self) -> u32;
    fn u128(&mut self) -> u128;
    fn i64(&mut self) -> i64;
    fn flag(&mut self) -> bool;
}

impl RngExt for Rng {
    fn u16(&mut self) -> u16 {
        self.next() as u16
    }
    fn u32(&mut self) -> u32 {
        self.next() as u32
    }
    fn u128(&mut self) -> u128 {
        (u128::from(self.next()) << 64) | u128::from(self.next())
    }
    fn i64(&mut self) -> i64 {
        self.next() as i64
    }
    fn flag(&mut self) -> bool {
        self.chance(50)
    }
}

// ------------------------------------------------------------------ ids

#[test]
fn program_and_external_ids() {
    assert_eq!(
        ID,
        anchor_lang::pubkey!("CfbRmsFpevhiXkbYK48orBDugdKznnezDiVekjAAbNgc")
    );
    assert_eq!(ID.to_string(), idl()["address"].as_str().unwrap());
    assert_eq!(noised_launchpad::id(), ID);
    assert_eq!(
        <noised_launchpad::program::NoisedLaunchpad as anchor_lang::Id>::id(),
        ID
    );
    assert_eq!(DBC_PROGRAM_ID, dbc_idl::ID);
    assert_eq!(DAMM_V2_PROGRAM_ID, cp_amm::ID);
    assert_eq!(hook::ID, noised_hook::ID);
    assert_eq!(noised_hook::LAUNCHPAD_PROGRAM_ID, ID);
    assert_eq!(noised_hook::DBC_PROGRAM_ID, DBC_PROGRAM_ID);
    assert_eq!(
        hook::INSTRUCTIONS_SYSVAR_ID,
        noised_hook::INSTRUCTIONS_SYSVAR_ID
    );
    assert_eq!(hook::POLICY_SEED, noised_hook::state::POLICY_SEED);
    assert_eq!(hook::META_LIST_SEED, noised_hook::state::META_LIST_SEED);
    assert_eq!(HOOK_AUTHORITY_SEED, noised_hook::state::HOOK_AUTHORITY_SEED);
    assert_eq!(hook::MAX_EXEMPT, noised_hook::state::MAX_EXEMPT);
    assert_eq!(
        noised_hook::EXECUTE_BATCH_DISCRIMINATOR,
        discriminator::EXECUTE_BATCH
    );
}

// ------------------------------------------------------- discriminators

#[test]
fn discriminators_are_anchors_and_the_idls() {
    let idl = idl();
    let instructions: [(&str, [u8; 8], &[u8]); 14] = [
        (
            "initialize_protocol",
            discriminator::INITIALIZE_PROTOCOL,
            instruction::InitializeProtocol::DISCRIMINATOR,
        ),
        (
            "create_launch",
            discriminator::CREATE_LAUNCH,
            instruction::CreateLaunch::DISCRIMINATOR,
        ),
        (
            "publish_metadata",
            discriminator::PUBLISH_METADATA,
            instruction::PublishMetadata::DISCRIMINATOR,
        ),
        (
            "publish_rules",
            discriminator::PUBLISH_RULES,
            instruction::PublishRules::DISCRIMINATOR,
        ),
        (
            "attest_launch",
            discriminator::ATTEST_LAUNCH,
            instruction::AttestLaunch::DISCRIMINATOR,
        ),
        (
            "pq_authorize",
            discriminator::PQ_AUTHORIZE,
            instruction::PqAuthorize::DISCRIMINATOR,
        ),
        (
            "launch",
            discriminator::LAUNCH,
            instruction::Launch::DISCRIMINATOR,
        ),
        (
            "commit",
            discriminator::COMMIT,
            instruction::Commit::DISCRIMINATOR,
        ),
        (
            "execute_batch",
            discriminator::EXECUTE_BATCH,
            instruction::ExecuteBatch::DISCRIMINATOR,
        ),
        (
            "claim",
            discriminator::CLAIM,
            instruction::Claim::DISCRIMINATOR,
        ),
        (
            "claim_fees",
            discriminator::CLAIM_FEES,
            instruction::ClaimFees::DISCRIMINATOR,
        ),
        (
            "claim_surplus",
            discriminator::CLAIM_SURPLUS,
            instruction::ClaimSurplus::DISCRIMINATOR,
        ),
        (
            "claim_lp_fees",
            discriminator::CLAIM_LP_FEES,
            instruction::ClaimLpFees::DISCRIMINATOR,
        ),
        (
            "distribute",
            discriminator::DISTRIBUTE,
            instruction::Distribute::DISCRIMINATOR,
        ),
    ];
    assert_eq!(idl["instructions"].as_array().unwrap().len(), 14);
    let mut seen = BTreeSet::new();
    for (name, disc, client) in instructions {
        assert!(seen.insert(disc), "{name}");
        assert_eq!(disc, sha256_8(&format!("global:{name}")), "{name}");
        assert_eq!(client, disc, "{name}");
        let ix = idl_named(&idl["instructions"], name);
        assert_eq!(idl_bytes(&ix["discriminator"]), disc, "{name}");
    }

    let accounts: [(&str, [u8; 8], &[u8]); 10] = [
        ("Protocol", discriminator::PROTOCOL, Protocol::DISCRIMINATOR),
        (
            "Launch",
            discriminator::LAUNCH_ACCOUNT,
            Launch::DISCRIMINATOR,
        ),
        (
            "Commit",
            discriminator::COMMIT_ACCOUNT,
            Commit::DISCRIMINATOR,
        ),
        (
            "PayoutVault",
            discriminator::PAYOUT_VAULT,
            PayoutVault::DISCRIMINATOR,
        ),
        ("Identity", discriminator::IDENTITY, Identity::DISCRIMINATOR),
        (
            "Attestation",
            discriminator::ATTESTATION,
            Attestation::DISCRIMINATOR,
        ),
        (
            "TokenMeta",
            discriminator::TOKEN_META,
            TokenMeta::DISCRIMINATOR,
        ),
        (
            "LaunchRules",
            discriminator::LAUNCH_RULES,
            LaunchRules::DISCRIMINATOR,
        ),
        (
            "Authorization",
            discriminator::AUTHORIZATION,
            Authorization::DISCRIMINATOR,
        ),
        (
            "Certificate",
            discriminator::CERTIFICATE,
            Certificate::DISCRIMINATOR,
        ),
    ];
    assert_eq!(idl["accounts"].as_array().unwrap().len(), 10);
    for (name, disc, anchor) in accounts {
        assert_eq!(disc, sha256_8(&format!("account:{name}")), "{name}");
        assert_eq!(anchor, disc, "{name}");
        let account = idl_named(&idl["accounts"], name);
        assert_eq!(idl_bytes(&account["discriminator"]), disc, "{name}");
    }

    let events: [(&str, [u8; 8], &[u8]); 14] = [
        (
            "ProtocolInitialized",
            discriminator::PROTOCOL_INITIALIZED,
            ProtocolInitialized::DISCRIMINATOR,
        ),
        (
            "LaunchCreated",
            discriminator::LAUNCH_CREATED,
            LaunchCreated::DISCRIMINATOR,
        ),
        (
            "MetadataPublished",
            discriminator::METADATA_PUBLISHED,
            MetadataPublished::DISCRIMINATOR,
        ),
        (
            "RulesPublished",
            discriminator::RULES_PUBLISHED,
            RulesPublished::DISCRIMINATOR,
        ),
        (
            "LaunchAttested",
            discriminator::LAUNCH_ATTESTED,
            LaunchAttested::DISCRIMINATOR,
        ),
        (
            "PqLeafConsumed",
            discriminator::PQ_LEAF_CONSUMED,
            PqLeafConsumed::DISCRIMINATOR,
        ),
        (
            "Authorized",
            discriminator::AUTHORIZED,
            Authorized::DISCRIMINATOR,
        ),
        ("Launched", discriminator::LAUNCHED, Launched::DISCRIMINATOR),
        (
            "Committed",
            discriminator::COMMITTED,
            Committed::DISCRIMINATOR,
        ),
        (
            "BatchExecuted",
            discriminator::BATCH_EXECUTED,
            BatchExecuted::DISCRIMINATOR,
        ),
        (
            "BatchClaimed",
            discriminator::BATCH_CLAIMED,
            BatchClaimed::DISCRIMINATOR,
        ),
        (
            "FeesClaimed",
            discriminator::FEES_CLAIMED,
            FeesClaimed::DISCRIMINATOR,
        ),
        (
            "LpFeesClaimed",
            discriminator::LP_FEES_CLAIMED,
            LpFeesClaimed::DISCRIMINATOR,
        ),
        (
            "Distributed",
            discriminator::DISTRIBUTED,
            Distributed::DISCRIMINATOR,
        ),
    ];
    assert_eq!(idl["events"].as_array().unwrap().len(), 14);
    for (name, disc, anchor) in events {
        assert_eq!(disc, sha256_8(&format!("event:{name}")), "{name}");
        assert_eq!(anchor, disc, "{name}");
        let event = idl_named(&idl["events"], name);
        assert_eq!(idl_bytes(&event["discriminator"]), disc, "{name}");
    }
    // `emit_cpi!`'s tag, which the dispatcher answers with
    // `EventInstructionStub`.
    assert_eq!(
        discriminator::EVENT_IX_TAG_LE,
        anchor_lang::event::EVENT_IX_TAG_LE
    );
}

// ------------------------------------------------------- account lists

/// The account lists the client builds are the IDL's, in order, with the
/// IDL's signer and writable flags (the program checks the same flags); an
/// absent optional account is the program id, read-only.
#[test]
fn account_lists_are_the_idls() {
    let idl = idl();
    let k = |b: u8| Pubkey::new_from_array([b; 32]);
    let some = |b: u8, on: bool| on.then(|| k(b));
    for with_optional in [true, false] {
        let lists: [(&str, Vec<AccountMeta>); 14] = [
            (
                "initialize_protocol",
                accounts::InitializeProtocol {
                    authority: k(1),
                    protocol: k(2),
                    treasury: k(3),
                    program: k(4),
                    program_data: k(5),
                    system_program: k(6),
                }
                .to_account_metas(None),
            ),
            (
                "create_launch",
                accounts::CreateLaunch {
                    creator: k(1),
                    protocol: k(2),
                    launch: k(3),
                    launch_authority: k(4),
                    dbc_config: k(5),
                    quote_mint: k(6),
                    hook_program: k(7),
                    dbc_program: k(8),
                    dbc_event_authority: k(9),
                    system_program: k(10),
                }
                .to_account_metas(None),
            ),
            (
                "publish_metadata",
                accounts::PublishMetadata {
                    payer: k(1),
                    launch: k(2),
                    token_meta: k(3),
                    system_program: k(4),
                }
                .to_account_metas(None),
            ),
            (
                "publish_rules",
                accounts::PublishRules {
                    payer: k(1),
                    launch: k(2),
                    rules: k(3),
                    system_program: k(4),
                }
                .to_account_metas(None),
            ),
            (
                "attest_launch",
                accounts::AttestLaunch {
                    payer: k(1),
                    launch: k(2),
                    identity: k(3),
                    attestation: k(4),
                    token_meta: k(5),
                    system_program: k(6),
                    rules: some(7, with_optional),
                }
                .to_account_metas(None),
            ),
            (
                "pq_authorize",
                accounts::PqAuthorize {
                    payer: k(1),
                    launch: k(2),
                    identity: k(3),
                    authorization: k(4),
                    system_program: k(5),
                }
                .to_account_metas(None),
            ),
            (
                "launch",
                accounts::LaunchToken {
                    payer: k(1),
                    launch: k(2),
                    launch_authority: k(3),
                    dbc_config: k(4),
                    base_mint: k(5),
                    pool: k(6),
                    base_vault: k(7),
                    quote_vault: k(8),
                    quote_mint: k(9),
                    dbc_pool_authority: k(10),
                    hook_authority: k(11),
                    extra_account_meta_list: k(12),
                    policy: k(13),
                    certificate: k(14),
                    hook_program: k(15),
                    dbc_program: k(16),
                    dbc_event_authority: k(17),
                    token_2022_program: k(18),
                    token_program: k(19),
                    system_program: k(20),
                    attestation: k(21),
                    token_meta: k(22),
                    rules: some(23, with_optional),
                }
                .to_account_metas(None),
            ),
            (
                "commit",
                accounts::CommitToBatch {
                    owner: k(1),
                    launch: k(2),
                    commit: k(3),
                    batch_authority: k(4),
                    quote_mint: k(5),
                    owner_quote_account: k(6),
                    batch_quote_escrow: k(7),
                    token_program: k(8),
                    associated_token_program: k(9),
                    system_program: k(10),
                    token_owner: k(11),
                    refund_owner: k(12),
                    payout_vault: some(13, with_optional),
                }
                .to_account_metas(None),
            ),
            (
                "execute_batch",
                accounts::ExecuteBatch {
                    payer: k(1),
                    launch: k(2),
                    batch_authority: k(3),
                    dbc_config: k(4),
                    pool: k(5),
                    base_vault: k(6),
                    quote_vault: k(7),
                    base_mint: k(8),
                    quote_mint: k(9),
                    batch_quote_escrow: k(10),
                    batch_base_escrow: k(11),
                    dbc_pool_authority: k(12),
                    dbc_program: k(13),
                    dbc_event_authority: k(14),
                    token_program: k(15),
                    token_2022_program: k(16),
                    associated_token_program: k(17),
                    system_program: k(18),
                    hook_authority: k(19),
                    policy: k(20),
                    hook_program: k(21),
                }
                .to_account_metas(None),
            ),
            (
                "claim",
                accounts::Claim {
                    payer: k(1),
                    launch: k(2),
                    commit: k(3),
                    token_owner: k(4),
                    refund_owner: k(5),
                    batch_authority: k(6),
                    base_mint: k(7),
                    quote_mint: k(8),
                    batch_quote_escrow: k(9),
                    batch_base_escrow: some(10, with_optional),
                    refund_owner_ata: some(11, with_optional),
                    token_owner_ata: some(12, with_optional),
                    token_program: k(13),
                    token_2022_program: k(14),
                    associated_token_program: k(15),
                    system_program: k(16),
                }
                .to_account_metas(None),
            ),
            (
                "claim_fees",
                accounts::ClaimFees {
                    payer: k(1),
                    launch: k(2),
                    launch_authority: k(3),
                    dbc_config: k(4),
                    pool: k(5),
                    base_vault: k(6),
                    quote_vault: k(7),
                    base_mint: k(8),
                    quote_mint: k(9),
                    authority_base_ata: k(10),
                    authority_quote_ata: k(11),
                    dbc_pool_authority: k(12),
                    dbc_program: k(13),
                    dbc_event_authority: k(14),
                    token_program: k(15),
                    token_2022_program: k(16),
                    associated_token_program: k(17),
                    system_program: k(18),
                }
                .to_account_metas(None),
            ),
            (
                "claim_surplus",
                accounts::ClaimSurplus {
                    payer: k(1),
                    launch: k(2),
                    launch_authority: k(3),
                    dbc_config: k(4),
                    pool: k(5),
                    quote_vault: k(6),
                    quote_mint: k(7),
                    authority_quote_ata: k(8),
                    dbc_pool_authority: k(9),
                    dbc_program: k(10),
                    dbc_event_authority: k(11),
                    token_program: k(12),
                    associated_token_program: k(13),
                    system_program: k(14),
                }
                .to_account_metas(None),
            ),
            (
                "claim_lp_fees",
                accounts::ClaimLpFees {
                    payer: k(1),
                    launch: k(2),
                    launch_authority: k(3),
                    damm_pool: k(4),
                    position: k(5),
                    position_nft_account: k(6),
                    token_a_vault: k(7),
                    token_b_vault: k(8),
                    base_mint: k(9),
                    quote_mint: k(10),
                    authority_base_ata: k(11),
                    authority_quote_ata: k(12),
                    damm_pool_authority: k(13),
                    damm_program: k(14),
                    damm_event_authority: k(15),
                    token_program: k(16),
                    token_2022_program: k(17),
                    associated_token_program: k(18),
                    system_program: k(19),
                }
                .to_account_metas(None),
            ),
            (
                "distribute",
                accounts::Distribute {
                    payer: k(1),
                    launch: k(2),
                    launch_authority: k(3),
                    treasury: k(4),
                    base_mint: k(5),
                    quote_mint: k(6),
                    authority_quote_ata: k(7),
                    authority_base_ata: k(8),
                    treasury_quote_ata: k(9),
                    token_program: k(10),
                    token_2022_program: k(11),
                    associated_token_program: k(12),
                    system_program: k(13),
                }
                .to_account_metas(None),
            ),
        ];
        for (name, metas) in lists {
            let ix = idl_named(&idl["instructions"], name);
            let expected = ix["accounts"].as_array().unwrap();
            assert_eq!(metas.len(), expected.len(), "{name}");
            for (i, (meta, account)) in metas.iter().zip(expected).enumerate() {
                let optional = account["optional"].as_bool().unwrap_or(false);
                if optional && !with_optional {
                    assert_eq!(
                        (meta.pubkey, meta.is_signer, meta.is_writable),
                        (ID, false, false),
                        "{name} {}",
                        account["name"]
                    );
                    continue;
                }
                assert_eq!(meta.pubkey, k(i as u8 + 1), "{name} #{i}");
                assert_eq!(
                    meta.is_signer,
                    account["signer"].as_bool().unwrap_or(false),
                    "{name} {}",
                    account["name"]
                );
                assert_eq!(
                    meta.is_writable,
                    account["writable"].as_bool().unwrap_or(false),
                    "{name} {}",
                    account["name"]
                );
            }
        }
    }
}

// ----------------------------------------------------- account layouts

fn random_recipients(r: &mut Rng) -> [FeeRecipient; 4] {
    [(); 4].map(|_| FeeRecipient {
        wallet: r.key(),
        bps: r.u16(),
    })
}

fn random_launch(r: &mut Rng) -> Launch {
    Launch {
        version: r.byte(),
        bump: r.byte(),
        authority_bump: r.byte(),
        batch_bump: r.byte(),
        config_bump: r.byte(),
        status: if r.flag() {
            LaunchStatus::Live
        } else {
            LaunchStatus::Configured
        },
        launch_seed: r.array(),
        creator: r.key(),
        dbc_config: r.key(),
        launch_authority: r.key(),
        batch_authority: r.key(),
        base_mint: r.key(),
        pool: r.key(),
        treasury: r.key(),
        platform_fee_bps: r.u16(),
        recipients: random_recipients(r),
        recipient_count: r.byte(),
        token_decimal: r.byte(),
        migration_quote_threshold: r.next(),
        migration_fee_option: r.byte(),
        open_delay_secs: r.u32(),
        guard_secs: r.u32(),
        max_wallet_bps: r.u16(),
        max_buy_bps: r.u16(),
        p2p_locked: r.flag(),
        batch_wallet_cap: r.next(),
        batch_total_cap: r.next(),
        params_hash: r.array(),
        launch_ts: r.i64(),
        commit_end_ts: r.i64(),
        execute_end_ts: r.i64(),
        guard_end_ts: r.i64(),
        total_committed: r.next(),
        executed: r.flag(),
        quote_spent: r.next(),
        tokens_out: r.next(),
        tokens_claimed: r.next(),
        quote_refunded: r.next(),
        pq_identity: r.array(),
    }
}

fn random_certificate(r: &mut Rng) -> Certificate {
    Certificate {
        version: r.byte(),
        bump: r.byte(),
        launch: r.key(),
        base_mint: r.key(),
        pool: r.key(),
        dbc_config: r.key(),
        creator: r.key(),
        launched_at: r.i64(),
        token_decimal: r.byte(),
        initial_supply: r.next(),
        checks: r.u32(),
        migration_quote_threshold: r.next(),
        migration_fee_option: r.byte(),
        snipe_shield_end_ts: r.i64(),
        execute_end_ts: r.i64(),
        guard_end_ts: r.i64(),
        max_wallet: r.next(),
        max_buy: r.next(),
        p2p_locked: r.flag(),
        platform_fee_bps: r.u16(),
        recipients: random_recipients(r),
        params_hash: r.array(),
        policy_version: r.u16(),
        pq_identity: r.array(),
        pq_leaf: r.u16(),
        attested_slot: r.next(),
        metadata: r.key(),
        rules_hash: r.array(),
    }
}

fn anchor_bytes<T: AccountSerialize>(account: &T) -> Vec<u8> {
    let mut out = Vec::new();
    account.try_serialize(&mut out).unwrap();
    out
}

/// Random bytes after `discriminator`, with every byte that decodes as a
/// Borsh `bool` or enum tag in `tags` often 0 or 1 (so that the decoders
/// are compared on data that decodes as well as on data that does not).
fn random_account_bytes(
    r: &mut Rng,
    discriminator: &[u8; 8],
    len: usize,
    tags: &[usize],
) -> Vec<u8> {
    let mut data = discriminator.to_vec();
    data.extend(r.bytes(len - 8));
    for &at in tags {
        if r.chance(80) {
            data[at] = r.byte() & 1;
        }
    }
    if r.chance(10) {
        data.truncate(r.below(len as u64) as usize);
    }
    if r.chance(10) {
        data.extend(r.some_bytes(9));
    }
    data
}

/// Every account type is written and read exactly as Anchor's `#[account]`
/// serialization: accounts written by either build read the same in the
/// other, and the program's decoders accept exactly what
/// `try_deserialize` accepts.
#[test]
fn account_layouts_match_anchor() {
    assert_eq!(
        Protocol::LEN,
        8 + <Protocol as anchor_lang::Space>::INIT_SPACE
    );
    assert_eq!(Launch::LEN, 8 + <Launch as anchor_lang::Space>::INIT_SPACE);
    assert_eq!(Commit::LEN, 8 + <Commit as anchor_lang::Space>::INIT_SPACE);
    assert_eq!(
        PayoutVault::LEN,
        8 + <PayoutVault as anchor_lang::Space>::INIT_SPACE
    );
    assert_eq!(
        Identity::LEN,
        8 + <Identity as anchor_lang::Space>::INIT_SPACE
    );
    assert_eq!(
        Attestation::LEN,
        8 + <Attestation as anchor_lang::Space>::INIT_SPACE
    );
    assert_eq!(
        Authorization::LEN,
        8 + <Authorization as anchor_lang::Space>::INIT_SPACE
    );
    assert_eq!(
        Certificate::LEN,
        8 + <Certificate as anchor_lang::Space>::INIT_SPACE
    );
    assert_eq!(
        (Protocol::LEN, Launch::LEN, Commit::LEN, PayoutVault::LEN),
        (44, 585, 147, 82)
    );
    assert_eq!(
        (
            Identity::LEN,
            Certificate::LEN,
            Attestation::LEN,
            Authorization::LEN
        ),
        (196, 519, 2708, 2669)
    );

    let mut r = Rng(11);
    for round in 0..3_000 {
        // Protocol.
        let protocol = Protocol {
            version: r.byte(),
            bump: r.byte(),
            treasury: r.key(),
            platform_fee_bps: r.u16(),
        };
        let mut ours = [0u8; Protocol::LEN];
        protocol.write(&mut ours);
        assert_eq!(anchor_bytes(&protocol), ours);
        assert_eq!(Protocol::read(&ours), protocol);

        // Launch, and the raw view the instructions use.
        let launch = random_launch(&mut r);
        let mut ours = [0u8; Launch::LEN];
        launch.write(&mut ours);
        assert_eq!(anchor_bytes(&launch), ours);
        assert_eq!(Launch::read(&ours), Some(launch.clone()));
        let raw = LaunchData::copy_from(&ours);
        assert!(LaunchData::decodes(&ours));
        assert_eq!(raw.0, ours);
        assert_eq!(raw.status(), launch.status as u8);
        assert_eq!(raw.key(at::CREATOR), launch.creator);
        assert_eq!(raw.key(at::DBC_CONFIG), launch.dbc_config);
        assert_eq!(raw.key(at::LAUNCH_AUTHORITY), launch.launch_authority);
        assert_eq!(raw.key(at::BATCH_AUTHORITY), launch.batch_authority);
        assert_eq!(raw.key(at::BASE_MINT), launch.base_mint);
        assert_eq!(raw.key(at::POOL), launch.pool);
        assert_eq!(raw.key(at::TREASURY), launch.treasury);
        assert_eq!(raw.array32(at::LAUNCH_SEED), launch.launch_seed);
        assert_eq!(raw.array32(at::PARAMS_HASH), launch.params_hash);
        assert_eq!(raw.array32(at::PQ_IDENTITY), launch.pq_identity);
        assert_eq!(raw.byte(at::VERSION), launch.version);
        assert_eq!(raw.byte(at::BUMP), launch.bump);
        assert_eq!(raw.byte(at::AUTHORITY_BUMP), launch.authority_bump);
        assert_eq!(raw.byte(at::BATCH_BUMP), launch.batch_bump);
        assert_eq!(raw.byte(at::CONFIG_BUMP), launch.config_bump);
        assert_eq!(raw.byte(at::RECIPIENT_COUNT), launch.recipient_count);
        assert_eq!(raw.byte(at::TOKEN_DECIMAL), launch.token_decimal);
        assert_eq!(
            raw.byte(at::MIGRATION_FEE_OPTION),
            launch.migration_fee_option
        );
        assert_eq!(raw.u16(at::PLATFORM_FEE_BPS), launch.platform_fee_bps);
        assert_eq!(raw.u16(at::MAX_WALLET_BPS), launch.max_wallet_bps);
        assert_eq!(raw.u16(at::MAX_BUY_BPS), launch.max_buy_bps);
        assert_eq!(raw.u32(at::OPEN_DELAY_SECS), launch.open_delay_secs);
        assert_eq!(raw.u32(at::GUARD_SECS), launch.guard_secs);
        assert_eq!(
            raw.u64(at::MIGRATION_QUOTE_THRESHOLD),
            launch.migration_quote_threshold
        );
        assert_eq!(raw.u64(at::BATCH_WALLET_CAP), launch.batch_wallet_cap);
        assert_eq!(raw.u64(at::BATCH_TOTAL_CAP), launch.batch_total_cap);
        assert_eq!(raw.u64(at::TOTAL_COMMITTED), launch.total_committed);
        assert_eq!(raw.u64(at::QUOTE_SPENT), launch.quote_spent);
        assert_eq!(raw.u64(at::TOKENS_OUT), launch.tokens_out);
        assert_eq!(raw.u64(at::TOKENS_CLAIMED), launch.tokens_claimed);
        assert_eq!(raw.u64(at::QUOTE_REFUNDED), launch.quote_refunded);
        assert_eq!(raw.i64(at::LAUNCH_TS), launch.launch_ts);
        assert_eq!(raw.i64(at::COMMIT_END_TS), launch.commit_end_ts);
        assert_eq!(raw.i64(at::EXECUTE_END_TS), launch.execute_end_ts);
        assert_eq!(raw.i64(at::GUARD_END_TS), launch.guard_end_ts);
        assert_eq!(raw.flag(at::P2P_LOCKED), launch.p2p_locked);
        assert_eq!(raw.flag(at::EXECUTED), launch.executed);
        assert_eq!(raw.recipients(), launch.recipients);
        // `set` writes exactly the field's bytes.
        let mut moved = raw.clone();
        let total = r.next();
        moved.set(at::TOTAL_COMMITTED, &total.to_le_bytes());
        let mut changed = launch.clone();
        changed.total_committed = total;
        assert_eq!(Launch::read(&moved.0), Some(changed));

        // Commit and PayoutVault.
        let commit = Commit {
            version: r.byte(),
            bump: r.byte(),
            launch: r.key(),
            owner: r.key(),
            amount: r.next(),
            claimed: r.flag(),
            token_owner: r.key(),
            refund_owner: r.key(),
        };
        let mut ours = [0u8; Commit::LEN];
        commit.write(&mut ours);
        assert_eq!(anchor_bytes(&commit), ours);
        assert_eq!(Commit::read(&ours), Some(commit));
        let vault = PayoutVault {
            version: r.byte(),
            bump: r.byte(),
            launch: r.key(),
            vault: r.key(),
            committed: r.next(),
        };
        let mut ours = [0u8; PayoutVault::LEN];
        vault.write(&mut ours);
        assert_eq!(anchor_bytes(&vault), ours);
        assert_eq!(PayoutVault::read(&ours), vault);

        // Identity.
        let identity = Identity {
            version: r.byte(),
            bump: r.byte(),
            public_key: r.array(),
            used: r.array(),
            used_count: r.u16(),
        };
        let mut ours = [0u8; Identity::LEN];
        identity.write(&mut ours);
        assert_eq!(anchor_bytes(&identity), ours);
        assert_eq!(Identity::read(&ours), identity);

        // Attestation and Authorization (a signature of any length).
        let sig_len = r.pick(&[0usize, 1, 100, 2_508]);
        let attestation = Attestation {
            version: r.byte(),
            bump: r.byte(),
            launch: r.key(),
            pq_identity: r.array(),
            leaf: r.u16(),
            metadata_hash: r.array(),
            rules_hash: r.array(),
            message_hash: r.array(),
            slot: r.next(),
            not_before: r.i64(),
            not_after: r.i64(),
            signature: r.bytes(sig_len),
        };
        let mut ours = vec![0u8; Attestation::LEN];
        assert!(attestation.write(&mut ours));
        let anchor = anchor_bytes(&attestation);
        assert_eq!(anchor[..], ours[..anchor.len()]);
        assert_eq!(Attestation::read(&ours), Some(attestation.clone()));
        assert!(!attestation.write(&mut vec![0u8; anchor.len() - 1]));
        assert_eq!(
            noised_launchpad::instructions::attest_launch::attestation_decodes(&ours),
            Attestation::try_deserialize(&mut &ours[..]).is_ok(),
            "round {round}"
        );
        let authorization = Authorization {
            version: r.byte(),
            bump: r.byte(),
            launch: r.key(),
            pq_identity: r.array(),
            kind: r.byte(),
            payload_hash: r.array(),
            message_hash: r.array(),
            unix_time: r.i64(),
            slot: r.next(),
            leaf: r.u16(),
            signature: r.bytes(sig_len),
        };
        let mut ours = vec![0u8; Authorization::LEN];
        assert!(authorization.write(&mut ours));
        let anchor = anchor_bytes(&authorization);
        assert_eq!(anchor[..], ours[..anchor.len()]);
        assert_eq!(Authorization::read(&ours), Some(authorization));

        // Certificate.
        let certificate = random_certificate(&mut r);
        let mut ours = [0u8; Certificate::LEN];
        certificate.write(&mut ours);
        assert_eq!(anchor_bytes(&certificate), ours);
        assert_eq!(Certificate::read(&ours), Some(certificate));

        // TokenMeta and LaunchRules, read in place.
        let meta = TokenMeta {
            version: r.byte(),
            bump: r.byte(),
            flags: r.byte(),
            launch: r.key(),
            metadata_hash: r.array(),
            name: "n".repeat(r.below(33) as usize),
            symbol: "s".repeat(r.below(11) as usize),
            uri: "https://x".repeat(r.below(3) as usize),
            doc: "{}".repeat(r.below(40) as usize),
        };
        let anchor = anchor_bytes(&meta);
        assert_eq!(
            anchor.len(),
            TokenMeta::space(
                meta.name.len(),
                meta.symbol.len(),
                meta.uri.len(),
                meta.doc.len()
            )
        );
        let view = TokenMetaRef::read(&anchor).unwrap();
        assert_eq!(
            (
                view.version,
                view.bump,
                view.flags,
                view.launch,
                view.metadata_hash
            ),
            (
                meta.version,
                meta.bump,
                meta.flags,
                meta.launch,
                meta.metadata_hash
            )
        );
        assert_eq!(
            (view.name, view.symbol, view.uri, view.doc),
            (
                &meta.name[..],
                &meta.symbol[..],
                &meta.uri[..],
                &meta.doc[..]
            )
        );
        assert_eq!(anchor[TokenMeta::VERSION_OFFSET], meta.version);
        assert_eq!(anchor[TokenMeta::BUMP_OFFSET], meta.bump);
        assert_eq!(anchor[TokenMeta::FLAGS_OFFSET], meta.flags);
        assert_eq!(
            anchor[TokenMeta::LAUNCH_OFFSET..TokenMeta::LAUNCH_OFFSET + 32],
            meta.launch.to_bytes()
        );
        assert_eq!(
            anchor[TokenMeta::METADATA_HASH_OFFSET..TokenMeta::METADATA_HASH_OFFSET + 32],
            meta.metadata_hash
        );
        let rules = LaunchRules {
            version: r.byte(),
            bump: r.byte(),
            launch: r.key(),
            rules_hash: r.array(),
            bytes: r.some_bytes(300),
        };
        let anchor = anchor_bytes(&rules);
        assert_eq!(anchor.len(), LaunchRules::space(rules.bytes.len()));
        let view = LaunchRulesRef::read(&anchor).unwrap();
        assert_eq!(
            (
                view.version,
                view.bump,
                view.launch,
                view.rules_hash,
                view.bytes
            ),
            (
                rules.version,
                rules.bump,
                rules.launch,
                rules.rules_hash,
                &rules.bytes[..]
            )
        );
        assert_eq!(anchor[LaunchRules::VERSION_OFFSET], rules.version);
        assert_eq!(anchor[LaunchRules::BUMP_OFFSET], rules.bump);
        assert_eq!(
            anchor[LaunchRules::LAUNCH_OFFSET..LaunchRules::LAUNCH_OFFSET + 32],
            rules.launch.to_bytes()
        );
        assert_eq!(
            anchor[LaunchRules::RULES_HASH_OFFSET..LaunchRules::RULES_HASH_OFFSET + 32],
            rules.rules_hash
        );
    }
}

/// The program's decoders (`Account::try_from`'s field decoding, which the
/// instructions run on existing accounts) accept exactly the data Anchor's
/// `try_deserialize` accepts, and read the same fields.
#[test]
fn account_decoders_match_anchor() {
    fn same<T: AccountDeserialize + PartialEq + std::fmt::Debug>(
        data: &[u8],
        decodes: bool,
        ours: Option<T>,
        what: &str,
    ) {
        let anchor = T::try_deserialize(&mut &data[..]).ok();
        assert_eq!(decodes, anchor.is_some(), "{what}: {data:?}");
        if decodes {
            assert_eq!(ours, anchor, "{what}");
        }
    }
    let mut r = Rng(12);
    for _ in 0..20_000 {
        let data = random_account_bytes(
            &mut r,
            &discriminator::LAUNCH_ACCOUNT,
            Launch::LEN,
            &[13, 431, 520],
        );
        let decodes = LaunchData::decodes(&data);
        let ours = data.first_chunk::<{ Launch::LEN }>().and_then(Launch::read);
        assert_eq!(decodes, ours.is_some());
        same::<Launch>(&data, decodes, ours, "Launch");

        let data = random_account_bytes(&mut r, &discriminator::COMMIT_ACCOUNT, Commit::LEN, &[82]);
        let decodes = Commit::decodes(&data);
        let ours = data.first_chunk::<{ Commit::LEN }>().and_then(Commit::read);
        same::<Commit>(&data, decodes, ours, "Commit");

        let data = random_account_bytes(&mut r, &discriminator::PROTOCOL, Protocol::LEN, &[]);
        let decodes = Protocol::decodes(&data);
        let ours = data.first_chunk::<{ Protocol::LEN }>().map(Protocol::read);
        same::<Protocol>(&data, decodes, ours, "Protocol");

        let data =
            random_account_bytes(&mut r, &discriminator::PAYOUT_VAULT, PayoutVault::LEN, &[]);
        let decodes = PayoutVault::decodes(&data);
        let ours = data
            .first_chunk::<{ PayoutVault::LEN }>()
            .map(PayoutVault::read);
        same::<PayoutVault>(&data, decodes, ours, "PayoutVault");

        let data = random_account_bytes(&mut r, &discriminator::IDENTITY, Identity::LEN, &[]);
        let decodes = Identity::decodes(&data);
        let ours = data.first_chunk::<{ Identity::LEN }>().map(Identity::read);
        same::<Identity>(&data, decodes, ours, "Identity");

        let data = random_account_bytes(
            &mut r,
            &discriminator::CERTIFICATE,
            Certificate::LEN,
            &[240],
        );
        let ours = data
            .first_chunk::<{ Certificate::LEN }>()
            .and_then(Certificate::read);
        same::<Certificate>(&data, ours.is_some(), ours, "Certificate");

        // Attestation and Authorization: the signature's length prefix,
        // often within the data.
        let mut data = random_account_bytes(&mut r, &discriminator::ATTESTATION, 260, &[]);
        if data.len() >= 200 && r.chance(70) {
            let len = r.below(data.len() as u64 - 199) as u32;
            data[196..200].copy_from_slice(&len.to_le_bytes());
        }
        let decodes = noised_launchpad::instructions::attest_launch::attestation_decodes(&data);
        same::<Attestation>(&data, decodes, Attestation::read(&data), "Attestation");
        let mut data = random_account_bytes(&mut r, &discriminator::AUTHORIZATION, 220, &[]);
        if data.len() >= 161 && r.chance(70) {
            let len = r.below(data.len() as u64 - 160) as u32;
            data[157..161].copy_from_slice(&len.to_le_bytes());
        }
        let ours = Authorization::read(&data);
        same::<Authorization>(&data, ours.is_some(), ours, "Authorization");

        // TokenMeta and LaunchRules: string and byte lengths, often within
        // the data, and strings often UTF-8.
        let mut data = discriminator::TOKEN_META.to_vec();
        data.extend(r.bytes(75));
        for _ in 0..4 {
            let len = r.below(6);
            data.extend(&(if r.chance(90) { len as u32 } else { r.u32() }).to_le_bytes());
            data.extend((0..len).map(|_| {
                if r.chance(95) {
                    b'a' + r.byte() % 26
                } else {
                    r.byte()
                }
            }));
        }
        if r.chance(10) {
            data.truncate(r.below(data.len() as u64) as usize);
        }
        let view = TokenMetaRef::read(&data);
        let anchor = TokenMeta::try_deserialize(&mut &data[..]).ok();
        assert_eq!(view.is_some(), anchor.is_some(), "TokenMeta {data:?}");
        if let (Some(v), Some(a)) = (view, anchor) {
            assert_eq!(
                (v.name, v.symbol, v.uri, v.doc, v.launch, v.flags),
                (
                    &a.name[..],
                    &a.symbol[..],
                    &a.uri[..],
                    &a.doc[..],
                    a.launch,
                    a.flags
                )
            );
        }
        let mut data = discriminator::LAUNCH_RULES.to_vec();
        data.extend(r.bytes(66));
        let len = r.below(20);
        data.extend(&(if r.chance(90) { len as u32 } else { r.u32() }).to_le_bytes());
        data.extend(r.bytes(len as usize));
        if r.chance(10) {
            data.truncate(r.below(data.len() as u64) as usize);
        }
        let view = LaunchRulesRef::read(&data);
        let anchor = LaunchRules::try_deserialize(&mut &data[..]).ok();
        assert_eq!(view.is_some(), anchor.is_some(), "LaunchRules {data:?}");
        if let (Some(v), Some(a)) = (view, anchor) {
            assert_eq!((v.bytes, v.rules_hash), (&a.bytes[..], a.rules_hash));
        }
    }
}

/// Byte size of a fixed-size IDL type; `None` for a variable one.
fn idl_size(idl: &serde_json::Value, ty: &serde_json::Value) -> Option<usize> {
    match ty.as_str() {
        Some("u8" | "i8" | "bool") => Some(1),
        Some("u16" | "i16") => Some(2),
        Some("u32" | "i32") => Some(4),
        Some("u64" | "i64") => Some(8),
        Some("u128" | "i128") => Some(16),
        Some("pubkey") => Some(32),
        Some(_) => None,
        None if ty.get("array").is_some() => {
            let n = ty["array"][1].as_u64().unwrap() as usize;
            Some(n * idl_size(idl, &ty["array"][0])?)
        }
        None if ty.get("defined").is_some() => {
            let def = idl_named(&idl["types"], ty["defined"]["name"].as_str().unwrap());
            match def["type"]["kind"].as_str().unwrap() {
                "enum" => Some(1),
                _ => def["type"]["fields"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|f| idl_size(idl, &f["type"]))
                    .sum(),
            }
        }
        None => None,
    }
}

/// The IDL's (name, offset, size) of each field of type `name`, after the
/// 8-byte discriminator, up to the first variable-size field.
fn idl_layout(idl: &serde_json::Value, name: &str) -> (Vec<(String, usize, usize)>, usize) {
    let ty = idl_named(&idl["types"], name);
    let mut at = 8;
    let mut fields = Vec::new();
    for f in ty["type"]["fields"].as_array().unwrap() {
        let Some(size) = idl_size(idl, &f["type"]) else {
            return (fields, at);
        };
        fields.push((f["name"].as_str().unwrap().to_string(), at, size));
        at += size;
    }
    (fields, at)
}

/// The hand-maintained IDL describes the layouts the program reads and
/// writes by offset: `launch_offsets` is the IDL's `Launch`, the fixed
/// accounts end where the IDL's fields end, and the variable ones have
/// their fixed part where the IDL puts it.
#[test]
fn idl_types_describe_the_layouts() {
    let idl = idl();
    let (fields, end) = idl_layout(&idl, "Launch");
    assert_eq!(end, Launch::LEN);
    let offsets: BTreeMap<&str, usize> = [
        ("version", at::VERSION),
        ("bump", at::BUMP),
        ("authority_bump", at::AUTHORITY_BUMP),
        ("batch_bump", at::BATCH_BUMP),
        ("config_bump", at::CONFIG_BUMP),
        ("status", at::STATUS),
        ("launch_seed", at::LAUNCH_SEED),
        ("creator", at::CREATOR),
        ("dbc_config", at::DBC_CONFIG),
        ("launch_authority", at::LAUNCH_AUTHORITY),
        ("batch_authority", at::BATCH_AUTHORITY),
        ("base_mint", at::BASE_MINT),
        ("pool", at::POOL),
        ("treasury", at::TREASURY),
        ("platform_fee_bps", at::PLATFORM_FEE_BPS),
        ("recipients", at::RECIPIENTS),
        ("recipient_count", at::RECIPIENT_COUNT),
        ("token_decimal", at::TOKEN_DECIMAL),
        ("migration_quote_threshold", at::MIGRATION_QUOTE_THRESHOLD),
        ("migration_fee_option", at::MIGRATION_FEE_OPTION),
        ("open_delay_secs", at::OPEN_DELAY_SECS),
        ("guard_secs", at::GUARD_SECS),
        ("max_wallet_bps", at::MAX_WALLET_BPS),
        ("max_buy_bps", at::MAX_BUY_BPS),
        ("p2p_locked", at::P2P_LOCKED),
        ("batch_wallet_cap", at::BATCH_WALLET_CAP),
        ("batch_total_cap", at::BATCH_TOTAL_CAP),
        ("params_hash", at::PARAMS_HASH),
        ("launch_ts", at::LAUNCH_TS),
        ("commit_end_ts", at::COMMIT_END_TS),
        ("execute_end_ts", at::EXECUTE_END_TS),
        ("guard_end_ts", at::GUARD_END_TS),
        ("total_committed", at::TOTAL_COMMITTED),
        ("executed", at::EXECUTED),
        ("quote_spent", at::QUOTE_SPENT),
        ("tokens_out", at::TOKENS_OUT),
        ("tokens_claimed", at::TOKENS_CLAIMED),
        ("quote_refunded", at::QUOTE_REFUNDED),
        ("pq_identity", at::PQ_IDENTITY),
    ]
    .into_iter()
    .collect();
    assert_eq!(fields.len(), offsets.len());
    for (name, offset, _) in &fields {
        assert_eq!(offsets[name.as_str()], *offset, "Launch.{name}");
    }

    for (name, len) in [
        ("Protocol", Protocol::LEN),
        ("Commit", Commit::LEN),
        ("PayoutVault", PayoutVault::LEN),
        ("Identity", Identity::LEN),
        ("Certificate", Certificate::LEN),
    ] {
        assert_eq!(idl_layout(&idl, name).1, len, "{name}");
    }
    // The certificate's fields where `launch` writes them (in order).
    let certificate: Vec<(String, usize)> = idl_layout(&idl, "Certificate")
        .0
        .into_iter()
        .map(|(name, at, _)| (name, at))
        .collect();
    let mut r = Rng(13);
    let cert = random_certificate(&mut r);
    let mut data = [0u8; Certificate::LEN];
    cert.write(&mut data);
    for (name, offset) in &certificate {
        let want: Vec<u8> = match name.as_str() {
            "version" => vec![cert.version],
            "bump" => vec![cert.bump],
            "launch" => cert.launch.to_bytes().to_vec(),
            "base_mint" => cert.base_mint.to_bytes().to_vec(),
            "pool" => cert.pool.to_bytes().to_vec(),
            "dbc_config" => cert.dbc_config.to_bytes().to_vec(),
            "creator" => cert.creator.to_bytes().to_vec(),
            "launched_at" => cert.launched_at.to_le_bytes().to_vec(),
            "token_decimal" => vec![cert.token_decimal],
            "initial_supply" => cert.initial_supply.to_le_bytes().to_vec(),
            "checks" => cert.checks.to_le_bytes().to_vec(),
            "migration_quote_threshold" => cert.migration_quote_threshold.to_le_bytes().to_vec(),
            "migration_fee_option" => vec![cert.migration_fee_option],
            "snipe_shield_end_ts" => cert.snipe_shield_end_ts.to_le_bytes().to_vec(),
            "execute_end_ts" => cert.execute_end_ts.to_le_bytes().to_vec(),
            "guard_end_ts" => cert.guard_end_ts.to_le_bytes().to_vec(),
            "max_wallet" => cert.max_wallet.to_le_bytes().to_vec(),
            "max_buy" => cert.max_buy.to_le_bytes().to_vec(),
            "p2p_locked" => vec![u8::from(cert.p2p_locked)],
            "platform_fee_bps" => cert.platform_fee_bps.to_le_bytes().to_vec(),
            "recipients" => cert
                .recipients
                .iter()
                .flat_map(|x| [&x.wallet.to_bytes()[..], &x.bps.to_le_bytes()].concat())
                .collect(),
            "params_hash" => cert.params_hash.to_vec(),
            "policy_version" => cert.policy_version.to_le_bytes().to_vec(),
            "pq_identity" => cert.pq_identity.to_vec(),
            "pq_leaf" => cert.pq_leaf.to_le_bytes().to_vec(),
            "attested_slot" => cert.attested_slot.to_le_bytes().to_vec(),
            "metadata" => cert.metadata.to_bytes().to_vec(),
            "rules_hash" => cert.rules_hash.to_vec(),
            other => panic!("Certificate.{other}"),
        };
        assert_eq!(
            &data[*offset..offset + want.len()],
            &want[..],
            "Certificate.{name}"
        );
    }

    for (name, fixed, last) in [
        ("Attestation", Attestation::FIXED_LEN - 4, "signature"),
        ("Authorization", Authorization::FIXED_LEN - 4, "signature"),
        ("TokenMeta", TokenMeta::FIXED_LEN - 16, "name"),
        ("LaunchRules", LaunchRules::FIXED_LEN - 4, "bytes"),
    ] {
        let (fields, end) = idl_layout(&idl, name);
        assert_eq!(end, fixed, "{name}");
        let ty = idl_named(&idl["types"], name);
        let next = &ty["type"]["fields"][fields.len()];
        assert_eq!(next["name"], last, "{name}");
    }
}

// ----------------------------------------------------- argument decoding

fn borsh_bytes<T: AnchorSerialize>(value: &T) -> Vec<u8> {
    let mut out = Vec::new();
    value.serialize(&mut out).unwrap();
    out
}

fn random_params(r: &mut Rng) -> LaunchParams {
    LaunchParams {
        token_decimal: r.byte(),
        sqrt_start_price: r.u128(),
        curve: (0..r.below(5))
            .map(|_| CurvePoint {
                sqrt_price: r.u128(),
                liquidity: r.u128(),
            })
            .collect(),
        migration_quote_threshold: r.next(),
        base_fee: BaseFeeParams {
            cliff_fee_numerator: r.next(),
            first_factor: r.u16(),
            second_factor: r.next(),
            third_factor: r.next(),
            base_fee_mode: r.byte(),
        },
        dynamic_fee: r.flag().then(|| DynamicFeeParams {
            bin_step: r.u16(),
            bin_step_u128: r.u128(),
            filter_period: r.u16(),
            decay_period: r.u16(),
            reduction_factor: r.u16(),
            max_volatility_accumulator: r.u32(),
            variable_fee_control: r.u32(),
        }),
        migration_fee_option: r.byte(),
        open_delay_secs: r.u32(),
        guard_secs: r.u32(),
        max_wallet_bps: r.u16(),
        max_buy_bps: r.u16(),
        p2p_locked: r.flag(),
        batch_wallet_cap: r.next(),
        batch_total_cap: r.next(),
        recipients: (0..r.below(6))
            .map(|_| FeeRecipient {
                wallet: r.key(),
                bps: r.u16(),
            })
            .collect(),
        pq_identity: r.array(),
    }
}

/// `create_launch`'s `LaunchParams` decoder reads Borsh as Anchor's
/// dispatcher did (`deserialize` of the data after `launch_seed`: trailing
/// bytes ignored, a short or malformed input fails), consumes the same
/// bytes, and those bytes are the canonical encoding of what it read (so
/// `params_hash`, the SHA-256 of the consumed bytes, is the Anchor build's
/// hash of the re-serialized parameters).
#[test]
fn launch_params_decode_like_borsh() {
    let mut r = Rng(21);
    for round in 0..30_000 {
        let params = random_params(&mut r);
        let mut data = borsh_bytes(&params);
        match r.below(7) {
            0 => data.truncate(r.below(data.len() as u64 + 1) as usize),
            1 => data.extend(r.some_bytes(40)),
            2 => {
                // A length prefix, the option tag or the bool: any value.
                let at = r.below(data.len() as u64) as usize;
                let any = r.byte();
                data[at] = r.pick(&[0, 1, 2, 0xff, any]);
            }
            3 => data = r.some_bytes(400),
            _ => {}
        }
        let mut borsh_input = &data[..];
        let borsh = LaunchParams::deserialize(&mut borsh_input).ok();
        let mut reader = Reader::new(&data);
        let ours = LaunchParams::read(&mut reader);
        assert_eq!(borsh, ours, "round {round}");
        if let Some(decoded) = ours {
            assert_eq!(reader.rest().len(), borsh_input.len(), "round {round}");
            let consumed = &data[..data.len() - reader.rest().len()];
            assert_eq!(borsh_bytes(&decoded), consumed, "round {round}");
        }
    }
    // The client's `create_launch` data is the discriminator, the seed and
    // the parameters.
    let params = random_params(&mut r);
    let seed = r.array::<32>();
    let data = instruction::CreateLaunch {
        launch_seed: seed,
        params: params.clone(),
    }
    .data();
    assert_eq!(data[..8], discriminator::CREATE_LAUNCH);
    assert_eq!(data[8..40], seed);
    assert_eq!(data[40..], borsh_bytes(&params)[..]);
}

// ---------------------------------------------------------------- events

/// What `emit` logged: one `sol_log_data` of one slice.
fn logged(emit: impl FnOnce()) -> Vec<u8> {
    let _ = take_logs();
    emit();
    match &take_logs()[..] {
        [Log::Data(slices)] if slices.len() == 1 => slices[0].clone(),
        other => panic!("not one event: {other:?}"),
    }
}

/// The events are Anchor's `emit!` payloads: discriminator, then Borsh.
#[test]
fn events_match_anchor() {
    let mut r = Rng(31);
    for _ in 0..2_000 {
        let e = ProtocolInitialized {
            treasury: r.key(),
            platform_fee_bps: r.u16(),
        };
        assert_eq!(logged(|| e.emit()), e.data());
        let e = LaunchCreated {
            launch: r.key(),
            creator: r.key(),
            dbc_config: r.key(),
            params_hash: r.array(),
            platform_fee_bps: r.u16(),
            pq_identity: r.array(),
        };
        assert_eq!(logged(|| e.emit()), e.data());
        let e = MetadataPublished {
            launch: r.key(),
            token_meta: r.key(),
            metadata_hash: r.array(),
            flags: r.byte(),
            uri_len: r.u16(),
            doc_len: r.u16(),
        };
        assert_eq!(logged(|| e.emit()), e.data());
        let e = RulesPublished {
            launch: r.key(),
            rules: r.key(),
            rules_hash: r.array(),
            len: r.u16(),
        };
        assert_eq!(logged(|| e.emit()), e.data());
        let e = LaunchAttested {
            launch: r.key(),
            pq_identity: r.array(),
            leaf: r.u16(),
            metadata_hash: r.array(),
            rules_hash: r.array(),
            slot: r.next(),
            not_before: r.i64(),
            not_after: r.i64(),
        };
        assert_eq!(logged(|| e.emit()), e.data());
        let e = PqLeafConsumed {
            pq_identity: r.array(),
            leaf: r.u16(),
            launch: r.key(),
        };
        assert_eq!(logged(|| e.emit()), e.data());
        let e = Authorized {
            launch: r.key(),
            authorization: r.key(),
            pq_identity: r.array(),
            kind: r.byte(),
            payload_hash: r.array(),
            leaf: r.u16(),
            unix_time: r.i64(),
            slot: r.next(),
        };
        assert_eq!(logged(|| e.emit()), e.data());
        let e = Launched {
            launch: r.key(),
            base_mint: r.key(),
            pool: r.key(),
            certificate: r.key(),
            initial_supply: r.next(),
            launch_ts: r.i64(),
            commit_end_ts: r.i64(),
            execute_end_ts: r.i64(),
            guard_end_ts: r.i64(),
            pq_identity: r.array(),
            pq_leaf: r.u16(),
        };
        assert_eq!(logged(|| e.emit()), e.data());
        let e = Committed {
            launch: r.key(),
            owner: r.key(),
            amount: r.next(),
            owner_total: r.next(),
            total_committed: r.next(),
            token_owner: r.key(),
            refund_owner: r.key(),
        };
        assert_eq!(logged(|| e.emit()), e.data());
        let e = BatchExecuted {
            launch: r.key(),
            total_committed: r.next(),
            quote_spent: r.next(),
            tokens_out: r.next(),
        };
        assert_eq!(logged(|| e.emit()), e.data());
        let e = BatchClaimed {
            launch: r.key(),
            owner: r.key(),
            tokens: r.next(),
            refund: r.next(),
            expired: r.flag(),
            token_owner: r.key(),
            refund_owner: r.key(),
        };
        assert_eq!(logged(|| e.emit()), e.data());
        let e = FeesClaimed {
            launch: r.key(),
            quote_amount: r.next(),
            surplus: r.flag(),
        };
        assert_eq!(logged(|| e.emit()), e.data());
        let e = LpFeesClaimed {
            launch: r.key(),
            position: r.key(),
            base_amount: r.next(),
            quote_amount: r.next(),
        };
        assert_eq!(logged(|| e.emit()), e.data());
        let e = Distributed {
            launch: r.key(),
            platform_amount: r.next(),
            recipients_amount: r.next(),
            base_burned: r.next(),
        };
        assert_eq!(logged(|| e.emit()), e.data());
    }
}

// --------------------------------------------------------------- errors

/// The program's numbers, names and messages are the IDL's
/// (`LaunchpadError`, from 6000) and anchor-lang 1.2.1's (framework
/// errors), and no other number is logged.
#[test]
fn error_table_matches_anchor_and_the_idl() {
    use error::LaunchpadError;
    let idl_errors = idl()["errors"].as_array().unwrap().clone();
    assert_eq!(idl_errors.len(), 49);
    for (i, e) in idl_errors.iter().enumerate() {
        let code = e["code"].as_u64().unwrap() as u32;
        assert_eq!(code, 6000 + i as u32);
        assert_eq!(
            error::name_and_message(code),
            (e["name"].as_str().unwrap(), e["msg"].as_str().unwrap()),
            "{code}"
        );
    }
    for (e, n) in [
        (LaunchpadError::MathOverflow, None),
        (LaunchpadError::AccountMismatch, None),
        (LaunchpadError::UnsafeMint, None),
        (LaunchpadError::InvalidHookAccounts, None),
    ] {
        let _: Option<u32> = n;
        let code = u32::from(e);
        assert_eq!(code, e.code());
        assert_eq!(error::name_and_message(code).0, e.name());
        assert_eq!(error::name_and_message(code).1, e.message());
    }

    let framework = [
        ErrorCode::InstructionFallbackNotFound,
        ErrorCode::InstructionDidNotDeserialize,
        ErrorCode::EventInstructionStub,
        ErrorCode::ConstraintMut,
        ErrorCode::ConstraintOwner,
        ErrorCode::ConstraintRentExempt,
        ErrorCode::ConstraintSeeds,
        ErrorCode::ConstraintExecutable,
        ErrorCode::ConstraintAssociated,
        ErrorCode::ConstraintTokenMint,
        ErrorCode::ConstraintTokenOwner,
        ErrorCode::ConstraintSpace,
        ErrorCode::ConstraintTokenTokenProgram,
        ErrorCode::ConstraintAssociatedTokenTokenProgram,
        ErrorCode::ConstraintDuplicateMutableAccount,
        ErrorCode::AccountDiscriminatorNotFound,
        ErrorCode::AccountDiscriminatorMismatch,
        ErrorCode::AccountDidNotDeserialize,
        ErrorCode::AccountDidNotSerialize,
        ErrorCode::AccountNotEnoughKeys,
        ErrorCode::AccountOwnedByWrongProgram,
        ErrorCode::InvalidProgramId,
        ErrorCode::InvalidProgramExecutable,
        ErrorCode::AccountNotSigner,
        ErrorCode::AccountNotInitialized,
        ErrorCode::AccountNotProgramData,
        ErrorCode::AccountNotAssociatedTokenAccount,
        ErrorCode::DeclaredProgramIdMismatch,
        ErrorCode::TryingToInitPayerAsProgramAccount,
    ];
    let mut codes = BTreeSet::new();
    for e in framework {
        let code = u32::from(e);
        assert!(codes.insert(code));
        assert_eq!(
            error::name_and_message(code),
            (e.name().as_str(), e.to_string().as_str()),
            "{e:?}"
        );
    }
    codes.extend(
        idl_errors
            .iter()
            .map(|e| e["code"].as_u64().unwrap() as u32),
    );
    let table: BTreeSet<u32> = error::numbers().collect();
    assert_eq!(table, codes);
    for code in error::numbers() {
        assert_eq!(error::describe(code)[1], code.to_string().as_bytes());
    }
}

// ------------------------------------------------------ DBC and DAMM v2

/// Host accounts for the CPI builders: `keys[i]` with random flags.
struct Views {
    _accounts: Vec<HostAccount>,
    views: Vec<AccountView>,
}

impl Views {
    fn new(r: &mut Rng, n: usize) -> Self {
        let accounts: Vec<HostAccount> = (0..n)
            .map(|_| HostAccount::new(r.key(), r.key(), 1, &[], r.flag(), r.flag(), false))
            .collect();
        let views = accounts.iter().map(|a| a.view()).collect();
        Self {
            _accounts: accounts,
            views,
        }
    }

    fn key(&self, i: usize) -> Pubkey {
        *self.views[i].address()
    }
}

/// The one CPI the closure made: program, `(address, signer, writable)` of
/// each account, data.
fn cpi(call: impl FnOnce()) -> (Pubkey, Vec<(Pubkey, bool, bool)>, Vec<u8>) {
    let _ = take_cpis();
    call();
    let mut cpis = take_cpis();
    assert_eq!(cpis.len(), 1);
    let c = cpis.remove(0);
    (c.program_id, c.accounts, c.data)
}

fn metas(list: Vec<AccountMeta>) -> Vec<(Pubkey, bool, bool)> {
    list.into_iter()
        .map(|m| (m.pubkey, m.is_signer, m.is_writable))
        .collect()
}

/// The hand-written DBC and DAMM v2 CPIs are what the IDL-generated
/// clients the Anchor build invoked with send: program, accounts in order
/// with their flags (an absent optional account is the callee's id,
/// read-only; remaining accounts follow with their own flags), and data.
#[test]
fn dbc_and_damm_cpis_match_the_idl_clients() {
    use cp_amm::client as damm_client;
    use dbc_idl::{
        client::{accounts as dbc_accounts, args as dbc_args},
        types::{AccountsType, RemainingAccountsSlice, SwapParameters2, TransferHookAccountsInfo},
    };
    let mut r = Rng(41);
    for _ in 0..200 {
        let v = Views::new(&mut r, 20);
        let k = |i: usize| v.key(i);

        // create_config_with_transfer_hook (the data: below).
        let data = r.some_bytes(50);
        let (program, accounts, sent) = cpi(|| {
            dbc::create_config_with_transfer_hook(
                &v.views[0],
                &v.views[1],
                &v.views[2],
                &v.views[3],
                &v.views[4],
                &v.views[5],
                &v.views[6],
                &v.views[7],
                &v.views[8],
                &data,
                &[],
            )
            .unwrap()
        });
        assert_eq!(program, DBC_PROGRAM_ID);
        assert_eq!(sent, data);
        assert_eq!(
            accounts,
            metas(
                dbc_accounts::CreateConfigWithTransferHook {
                    config: k(0),
                    fee_claimer: k(1),
                    leftover_receiver: k(2),
                    quote_mint: k(3),
                    transfer_hook_program: k(4),
                    payer: k(5),
                    system_program: k(6),
                    event_authority: k(7),
                    program: k(8),
                }
                .to_account_metas(None)
            )
        );

        // initialize_virtual_pool_with_token2022_transfer_hook.
        let data = r.some_bytes(50);
        let (program, accounts, sent) = cpi(|| {
            dbc::initialize_virtual_pool_with_token2022_transfer_hook(
                &dbc::InitializePool {
                    config: &v.views[0],
                    pool_authority: &v.views[1],
                    creator: &v.views[2],
                    base_mint: &v.views[3],
                    quote_mint: &v.views[4],
                    pool: &v.views[5],
                    base_vault: &v.views[6],
                    quote_vault: &v.views[7],
                    transfer_hook_program: &v.views[8],
                    payer: &v.views[9],
                    token_quote_program: &v.views[10],
                    token_program: &v.views[11],
                    system_program: &v.views[12],
                    event_authority: &v.views[13],
                    program: &v.views[14],
                },
                &data,
                &[],
            )
            .unwrap()
        });
        assert_eq!((program, sent), (DBC_PROGRAM_ID, data));
        assert_eq!(
            accounts,
            metas(
                dbc_accounts::InitializeVirtualPoolWithToken2022TransferHook {
                    config: k(0),
                    pool_authority: k(1),
                    creator: k(2),
                    base_mint: k(3),
                    quote_mint: k(4),
                    pool: k(5),
                    base_vault: k(6),
                    quote_vault: k(7),
                    transfer_hook_program: k(8),
                    payer: k(9),
                    token_quote_program: k(10),
                    token_program: k(11),
                    system_program: k(12),
                    event_authority: k(13),
                    program: k(14),
                }
                .to_account_metas(None)
            )
        );

        // swap2_with_transfer_hook, with the hook's accounts remaining. The
        // program account is DBC's (the handlers check its address).
        let program_account = HostAccount::new(DBC_PROGRAM_ID, r.key(), 1, &[], false, false, true);
        let program_view = program_account.view();
        let hook_count = r.below(5) as usize;
        let hook_accounts: Vec<AccountView> = v.views[15..15 + hook_count].to_vec();
        let (amount_0, amount_1, mode) = (r.next(), r.next(), r.byte());
        let (program, accounts, sent) = cpi(|| {
            dbc::swap2_with_transfer_hook(
                &dbc::Swap2 {
                    pool_authority: &v.views[0],
                    config: &v.views[1],
                    pool: &v.views[2],
                    input_token_account: &v.views[3],
                    output_token_account: &v.views[4],
                    base_vault: &v.views[5],
                    quote_vault: &v.views[6],
                    base_mint: &v.views[7],
                    quote_mint: &v.views[8],
                    payer: &v.views[9],
                    token_base_program: &v.views[10],
                    token_quote_program: &v.views[11],
                    event_authority: &v.views[12],
                    program: &program_view,
                },
                amount_0,
                amount_1,
                mode,
                &hook_accounts,
                &[],
            )
            .unwrap()
        });
        assert_eq!(program, DBC_PROGRAM_ID);
        let mut want = metas(
            dbc_accounts::Swap2WithTransferHook {
                pool_authority: k(0),
                config: k(1),
                pool: k(2),
                input_token_account: k(3),
                output_token_account: k(4),
                base_vault: k(5),
                quote_vault: k(6),
                base_mint: k(7),
                quote_mint: k(8),
                payer: k(9),
                token_base_program: k(10),
                token_quote_program: k(11),
                referral_token_account: None,
                event_authority: k(12),
                program: DBC_PROGRAM_ID,
            }
            .to_account_metas(None),
        );
        want.extend(
            hook_accounts
                .iter()
                .map(|a| (*a.address(), a.is_signer(), a.is_writable())),
        );
        assert_eq!(accounts, want);
        assert_eq!(
            sent,
            dbc_args::Swap2WithTransferHook {
                params: SwapParameters2 {
                    amount_0,
                    amount_1,
                    swap_mode: mode,
                },
                transfer_hook_accounts_info: TransferHookAccountsInfo {
                    slices: vec![RemainingAccountsSlice {
                        accounts_type: AccountsType::TransferHookBase,
                        length: hook_count as u8,
                    }],
                },
            }
            .data()
        );

        // claim_trading_fee2.
        let (max_a, max_b) = (r.next(), r.next());
        let (program, accounts, sent) = cpi(|| {
            dbc::claim_trading_fee2(
                &dbc::ClaimTradingFee2 {
                    pool_authority: &v.views[0],
                    config: &v.views[1],
                    pool: &v.views[2],
                    token_a_account: &v.views[3],
                    token_b_account: &v.views[4],
                    base_vault: &v.views[5],
                    quote_vault: &v.views[6],
                    base_mint: &v.views[7],
                    quote_mint: &v.views[8],
                    fee_claimer: &v.views[9],
                    token_base_program: &v.views[10],
                    token_quote_program: &v.views[11],
                    event_authority: &v.views[12],
                    program: &v.views[13],
                },
                max_a,
                max_b,
                &[],
            )
            .unwrap()
        });
        assert_eq!(program, DBC_PROGRAM_ID);
        assert_eq!(
            accounts,
            metas(
                dbc_accounts::ClaimTradingFee2 {
                    pool_authority: k(0),
                    config: k(1),
                    pool: k(2),
                    token_a_account: k(3),
                    token_b_account: k(4),
                    base_vault: k(5),
                    quote_vault: k(6),
                    base_mint: k(7),
                    quote_mint: k(8),
                    fee_claimer: k(9),
                    token_base_program: k(10),
                    token_quote_program: k(11),
                    event_authority: k(12),
                    program: k(13),
                }
                .to_account_metas(None)
            )
        );
        assert_eq!(
            sent,
            dbc_args::ClaimTradingFee2 {
                max_amount_a: max_a,
                max_amount_b: max_b,
                transfer_hook_accounts_info: TransferHookAccountsInfo { slices: vec![] },
            }
            .data()
        );

        // partner_withdraw_surplus and creator_withdraw_surplus.
        let surplus = dbc::WithdrawSurplus {
            pool_authority: &v.views[0],
            config: &v.views[1],
            virtual_pool: &v.views[2],
            token_quote_account: &v.views[3],
            quote_vault: &v.views[4],
            quote_mint: &v.views[5],
            claimer: &v.views[6],
            token_quote_program: &v.views[7],
            event_authority: &v.views[8],
            program: &v.views[9],
        };
        let (program, accounts, sent) =
            cpi(|| dbc::withdraw_surplus(&surplus, &dbc::PARTNER_WITHDRAW_SURPLUS, &[]).unwrap());
        assert_eq!(program, DBC_PROGRAM_ID);
        assert_eq!(sent, dbc_args::PartnerWithdrawSurplus {}.data());
        assert_eq!(
            accounts,
            metas(
                dbc_accounts::PartnerWithdrawSurplus {
                    pool_authority: k(0),
                    config: k(1),
                    virtual_pool: k(2),
                    token_quote_account: k(3),
                    quote_vault: k(4),
                    quote_mint: k(5),
                    fee_claimer: k(6),
                    token_quote_program: k(7),
                    event_authority: k(8),
                    program: k(9),
                }
                .to_account_metas(None)
            )
        );
        let (_, accounts, sent) =
            cpi(|| dbc::withdraw_surplus(&surplus, &dbc::CREATOR_WITHDRAW_SURPLUS, &[]).unwrap());
        assert_eq!(sent, dbc_args::CreatorWithdrawSurplus {}.data());
        assert_eq!(
            accounts,
            metas(
                dbc_accounts::CreatorWithdrawSurplus {
                    pool_authority: k(0),
                    config: k(1),
                    virtual_pool: k(2),
                    token_quote_account: k(3),
                    quote_vault: k(4),
                    quote_mint: k(5),
                    creator: k(6),
                    token_quote_program: k(7),
                    event_authority: k(8),
                    program: k(9),
                }
                .to_account_metas(None)
            )
        );

        // DAMM v2 claim_position_fee.
        let (program, accounts, sent) = cpi(|| {
            damm::claim_position_fee(
                &damm::ClaimPositionFee {
                    pool_authority: &v.views[0],
                    pool: &v.views[1],
                    position: &v.views[2],
                    token_a_account: &v.views[3],
                    token_b_account: &v.views[4],
                    token_a_vault: &v.views[5],
                    token_b_vault: &v.views[6],
                    token_a_mint: &v.views[7],
                    token_b_mint: &v.views[8],
                    position_nft_account: &v.views[9],
                    signer: &v.views[10],
                    token_a_program: &v.views[11],
                    token_b_program: &v.views[12],
                    event_authority: &v.views[13],
                    program: &v.views[14],
                },
                &[],
            )
            .unwrap()
        });
        assert_eq!(program, DAMM_V2_PROGRAM_ID);
        assert_eq!(sent, damm_client::args::ClaimPositionFee {}.data());
        assert_eq!(
            accounts,
            metas(
                damm_client::accounts::ClaimPositionFee {
                    pool_authority: k(0),
                    pool: k(1),
                    position: k(2),
                    token_a_account: k(3),
                    token_b_account: k(4),
                    token_a_vault: k(5),
                    token_b_vault: k(6),
                    token_a_mint: k(7),
                    token_b_mint: k(8),
                    position_nft_account: k(9),
                    signer: k(10),
                    token_a_program: k(11),
                    token_b_program: k(12),
                    event_authority: k(13),
                    program: k(14),
                }
                .to_account_metas(None)
            )
        );
    }
    assert_eq!(
        dbc::ACCOUNTS_TYPE_TRANSFER_HOOK_BASE,
        AccountsType::TransferHookBase as u8
    );
}

/// The DBC instruction data the launchpad builds: `create_config`'s is
/// the IDL client's encoding of the Anchor build's `ConfigParameters`
/// (`dbc_params::config_parameters`, the code the Anchor build ran), and
/// the pool's is the client's encoding of `InitializePoolParameters` with
/// the derived uri.
#[test]
fn dbc_instruction_data_matches_the_idl_client() {
    use dbc_idl::{client::args as dbc_args, types::InitializePoolParameters};
    let mut r = Rng(42);
    for _ in 0..5_000 {
        let mut params = random_params(&mut r);
        params
            .curve
            .truncate(noised_launchpad::constants::MAX_CURVE_POINTS);
        assert_eq!(
            dbc::create_config_data(&params),
            dbc_args::CreateConfigWithTransferHook {
                config_parameters: dbc_params::config_parameters(&params),
            }
            .data()
        );
    }
    for _ in 0..2_000 {
        let name = "N".repeat(r.below(33) as usize);
        let symbol = "S".repeat(r.below(11) as usize);
        let any = r.byte();
        let flags = r.pick(&[0u8, 1, 2, 3, any]);
        let uri = format!("https://{}", "u".repeat(r.below(50) as usize));
        let doc = format!("{{\"a\":\"{}\"}}", "d".repeat(r.below(200) as usize));
        let (data, uri_at) = dbc_params::initialize_pool_data(&name, &symbol, flags, &uri, &doc);
        let token_uri = policy::token_uri(flags, &uri, &doc);
        assert_eq!(
            data,
            dbc_args::InitializeVirtualPoolWithToken2022TransferHook {
                params: InitializePoolParameters {
                    name: name.clone(),
                    symbol: symbol.clone(),
                    uri: token_uri.clone(),
                },
            }
            .data()
        );
        assert_eq!(&data[uri_at..], token_uri.as_bytes());
    }
}

/// The offsets the launchpad reads DBC's and DAMM v2's accounts at are the
/// IDL's zero-copy layouts (`declare_program!`'s bytemuck types), and their
/// sizes and discriminators are the types'.
#[test]
fn dbc_and_damm_layouts_match_the_idl_types() {
    use cp_amm::accounts::{Pool as DammPool, Position as DammPosition};
    use dbc::{config as c, pool as p};
    use dbc_idl::accounts::{ConfigWithTransferHook, TransferHookPool};
    fn key(data: &[u8], at: usize) -> Pubkey {
        Pubkey::new_from_array(data[at..at + 32].try_into().unwrap())
    }
    fn u64_at(data: &[u8], at: usize) -> u64 {
        u64::from_le_bytes(data[at..at + 8].try_into().unwrap())
    }
    assert_eq!(c::LEN, 8 + std::mem::size_of::<ConfigWithTransferHook>());
    assert_eq!(c::DISCRIMINATOR, ConfigWithTransferHook::DISCRIMINATOR);
    assert_eq!(p::LEN, 8 + std::mem::size_of::<TransferHookPool>());
    assert_eq!(p::DISCRIMINATOR, TransferHookPool::DISCRIMINATOR);
    assert_eq!(damm::pool::LEN, 8 + std::mem::size_of::<DammPool>());
    assert_eq!(damm::pool::DISCRIMINATOR, DammPool::DISCRIMINATOR);
    assert_eq!(damm::position::LEN, 8 + std::mem::size_of::<DammPosition>());
    assert_eq!(damm::position::DISCRIMINATOR, DammPosition::DISCRIMINATOR);
    let mut r = Rng(43);
    for _ in 0..500 {
        let data = r.bytes(c::LEN);
        let cfg: ConfigWithTransferHook = bytemuck::pod_read_unaligned(&data[8..]);
        let cc = &cfg.config;
        assert_eq!(
            key(&data, c::TRANSFER_HOOK_PROGRAM),
            cfg.transfer_hook_program
        );
        assert_eq!(key(&data, c::QUOTE_MINT), cc.quote_mint);
        assert_eq!(key(&data, c::FEE_CLAIMER), cc.fee_claimer);
        assert_eq!(key(&data, c::LEFTOVER_RECEIVER), cc.leftover_receiver);
        assert_eq!(
            data[c::PARTNER_LIQUIDITY_VESTING_IS_INITIALIZED],
            cc.partner_liquidity_vesting_info.is_initialized
        );
        assert_eq!(
            data[c::CREATOR_LIQUIDITY_VESTING_IS_INITIALIZED],
            cc.creator_liquidity_vesting_info.is_initialized
        );
        for (at, value) in [
            (c::COLLECT_FEE_MODE, cc.collect_fee_mode),
            (c::MIGRATION_OPTION, cc.migration_option),
            (c::ACTIVATION_TYPE, cc.activation_type),
            (c::TOKEN_DECIMAL, cc.token_decimal),
            (c::TOKEN_TYPE, cc.token_type),
            (
                c::PARTNER_PERMANENT_LOCKED_LIQUIDITY_PERCENTAGE,
                cc.partner_permanent_locked_liquidity_percentage,
            ),
            (
                c::PARTNER_LIQUIDITY_PERCENTAGE,
                cc.partner_liquidity_percentage,
            ),
            (
                c::CREATOR_PERMANENT_LOCKED_LIQUIDITY_PERCENTAGE,
                cc.creator_permanent_locked_liquidity_percentage,
            ),
            (
                c::CREATOR_LIQUIDITY_PERCENTAGE,
                cc.creator_liquidity_percentage,
            ),
            (c::MIGRATION_FEE_OPTION, cc.migration_fee_option),
            (c::FIXED_TOKEN_SUPPLY_FLAG, cc.fixed_token_supply_flag),
            (
                c::CREATOR_TRADING_FEE_PERCENTAGE,
                cc.creator_trading_fee_percentage,
            ),
            (c::TOKEN_UPDATE_AUTHORITY, cc.token_update_authority),
            (c::MIGRATION_FEE_PERCENTAGE, cc.migration_fee_percentage),
            (
                c::CREATOR_MIGRATION_FEE_PERCENTAGE,
                cc.creator_migration_fee_percentage,
            ),
            (
                c::ENABLE_FIRST_SWAP_WITH_MIN_FEE,
                cc.enable_first_swap_with_min_fee,
            ),
        ] {
            assert_eq!(data[at], value, "config byte {at}");
        }
        assert_eq!(
            u64_at(&data, c::MIGRATION_QUOTE_THRESHOLD),
            cc.migration_quote_threshold
        );
        assert_eq!(u64_at(&data, c::POOL_CREATION_FEE), cc.pool_creation_fee);
        let v = &cc.locked_vesting_config;
        assert_eq!(
            c::LOCKED_VESTING.map(|at| u64_at(&data, at)),
            [
                v.amount_per_period,
                v.cliff_duration_from_migration_time,
                v.frequency,
                v.number_of_period,
                v.cliff_unlock_amount,
            ]
        );

        let data = r.bytes(p::LEN);
        let pool: TransferHookPool = bytemuck::pod_read_unaligned(&data[8..]);
        let ps = &pool.pool_state;
        assert_eq!(key(&data, p::CONFIG), ps.config);
        assert_eq!(key(&data, p::CREATOR), ps.creator);
        assert_eq!(key(&data, p::BASE_MINT), ps.base_mint);
        assert_eq!(key(&data, p::BASE_VAULT), ps.base_vault);
        assert_eq!(key(&data, p::QUOTE_VAULT), ps.quote_vault);
        assert_eq!(
            data[p::IS_PARTNER_WITHDRAW_SURPLUS],
            ps.is_partner_withdraw_surplus
        );
        assert_eq!(
            data[p::IS_CREATOR_WITHDRAW_SURPLUS],
            ps.is_creator_withdraw_surplus
        );
        assert_eq!(data[p::HAS_SWAP], ps.has_swap);

        let data = r.bytes(damm::pool::LEN);
        let pool: DammPool = bytemuck::pod_read_unaligned(&data[8..]);
        assert_eq!(key(&data, damm::pool::TOKEN_A_MINT), pool.token_a_mint);
        assert_eq!(key(&data, damm::pool::TOKEN_B_MINT), pool.token_b_mint);
        let data = r.bytes(damm::position::LEN);
        let position: DammPosition = bytemuck::pod_read_unaligned(&data[8..]);
        assert_eq!(key(&data, damm::position::POOL), position.pool);
        assert_eq!(key(&data, damm::position::NFT_MINT), position.nft_mint);
    }
}

// ----------------------------------------------------------------- hook

/// The hand-written Launch Guard interface is the hook crate's: its
/// instructions' discriminators, accounts and arguments (its Anchor
/// client), and `Policy::read` decodes exactly what
/// `HookPolicy::try_deserialize` decodes.
#[test]
fn hook_interface_matches_the_hook_crate() {
    use noised_hook::{accounts as hook_accounts, instruction as hook_ix, state::HookPolicy};
    assert_eq!(
        hook::INITIALIZE_EXTRA_ACCOUNT_META_LIST,
        hook_ix::InitializeExtraAccountMetaList::DISCRIMINATOR
    );
    assert_eq!(hook::CREATE_POLICY, hook_ix::CreatePolicy::DISCRIMINATOR);
    assert_eq!(
        hook::END_SNIPE_SHIELD,
        hook_ix::EndSnipeShield::DISCRIMINATOR
    );
    assert_eq!(hook::HOOK_POLICY_DISCRIMINATOR, HookPolicy::DISCRIMINATOR);

    let mut r = Rng(51);
    for _ in 0..300 {
        let v = Views::new(&mut r, 6);
        let k = |i: usize| v.key(i);
        let (program, accounts, sent) = cpi(|| {
            hook::initialize_extra_account_meta_list(
                &v.views[0],
                &v.views[1],
                &v.views[2],
                &v.views[3],
            )
            .unwrap()
        });
        assert_eq!(program, noised_hook::ID);
        assert_eq!(sent, hook_ix::InitializeExtraAccountMetaList {}.data());
        assert_eq!(
            accounts,
            metas(
                hook_accounts::InitializeExtraAccountMetaList {
                    payer: k(0),
                    extra_account_meta_list: k(1),
                    mint: k(2),
                    system_program: k(3),
                }
                .to_account_metas(None)
            )
        );

        let params = hook::PolicyParams {
            pool: r.key(),
            snipe_shield_secs: r.u32(),
            guard_secs: r.u32(),
            max_wallet: r.next(),
            max_buy: r.next(),
            p2p_locked: r.flag(),
            exempt: [r.key(), r.key(), r.key(), r.key()],
            rules: &r.some_bytes(200),
        };
        let data = params.data();
        assert_eq!(
            data,
            hook_ix::CreatePolicy {
                params: noised_hook::state::PolicyParams {
                    pool: params.pool,
                    snipe_shield_secs: params.snipe_shield_secs,
                    guard_secs: params.guard_secs,
                    max_wallet: params.max_wallet,
                    max_buy: params.max_buy,
                    p2p_locked: params.p2p_locked,
                    exempt: params.exempt,
                    rules: params.rules.to_vec(),
                },
            }
            .data()
        );
        let (program, accounts, sent) = cpi(|| {
            hook::create_policy(
                &v.views[0],
                &v.views[1],
                &v.views[2],
                &v.views[3],
                &v.views[4],
                &v.views[5],
                &data,
                &[],
            )
            .unwrap()
        });
        assert_eq!((program, sent), (noised_hook::ID, data.clone()));
        assert_eq!(
            accounts,
            metas(
                hook_accounts::CreatePolicy {
                    payer: k(0),
                    launchpad_authority: k(1),
                    mint: k(2),
                    pool: k(3),
                    policy: k(4),
                    system_program: k(5),
                }
                .to_account_metas(None)
            )
        );

        let (program, accounts, sent) =
            cpi(|| hook::end_snipe_shield(&v.views[0], &v.views[1], &v.views[2], &[]).unwrap());
        assert_eq!(program, noised_hook::ID);
        assert_eq!(sent, hook_ix::EndSnipeShield {}.data());
        assert_eq!(
            accounts,
            metas(
                hook_accounts::EndSnipeShield {
                    launchpad_authority: k(0),
                    policy: k(1),
                    instructions: k(2),
                }
                .to_account_metas(None)
            )
        );
    }

    // Policy::read against HookPolicy::try_deserialize.
    for round in 0..20_000 {
        let policy = HookPolicy {
            version: r.byte(),
            bump: r.byte(),
            mint: r.key(),
            pool: r.key(),
            base_vault: r.key(),
            launch_ts: r.i64(),
            snipe_shield_end_ts: r.i64(),
            guard_end_ts: r.i64(),
            max_wallet: r.next(),
            max_buy: r.next(),
            p2p_locked: r.flag(),
            exempt: [r.key(), r.key(), r.key(), r.key()],
            rules: r.some_bytes(100),
        };
        let mut data = anchor_bytes(&policy);
        match r.below(6) {
            0 => data.truncate(r.below(data.len() as u64 + 1) as usize),
            1 => data.extend(r.some_bytes(20)),
            2 => {
                let at = r.below(data.len() as u64) as usize;
                data[at] = r.byte();
            }
            3 => data[..8].copy_from_slice(&r.array::<8>()),
            _ => {}
        }
        let anchor = HookPolicy::try_deserialize(&mut &data[..]);
        let ours = hook::Policy::read(&data);
        match (&anchor, &ours) {
            (Ok(a), Ok(o)) => {
                assert_eq!(
                    (o.version, o.bump, o.mint, o.pool, o.base_vault),
                    (a.version, a.bump, a.mint, a.pool, a.base_vault),
                    "round {round}"
                );
                assert_eq!(
                    (o.launch_ts, o.snipe_shield_end_ts, o.guard_end_ts),
                    (a.launch_ts, a.snipe_shield_end_ts, a.guard_end_ts)
                );
                assert_eq!(
                    (o.max_wallet, o.max_buy, o.p2p_locked, o.exempt, o.rules),
                    (
                        a.max_wallet,
                        a.max_buy,
                        a.p2p_locked,
                        a.exempt,
                        &a.rules[..]
                    )
                );
            }
            (Err(anchor_lang::error::Error::AnchorError(a)), Err(o)) => {
                let code = match o {
                    hook::PolicyError::DiscriminatorNotFound => {
                        ErrorCode::AccountDiscriminatorNotFound
                    }
                    hook::PolicyError::DiscriminatorMismatch => {
                        ErrorCode::AccountDiscriminatorMismatch
                    }
                    hook::PolicyError::DidNotDeserialize => ErrorCode::AccountDidNotDeserialize,
                };
                assert_eq!(a.error_code_number, u32::from(code), "round {round}");
            }
            other => panic!("round {round}: {other:?}"),
        }
    }
}

// ------------------------------------------- post-conditions (`launch`)

/// The Anchor build's `inspect_config` (anchor/checks.rs), verbatim but
/// for its error plumbing: the flags, or `UnsafeConfig`.
fn anchor_inspect_config(
    cfg: &dbc_idl::accounts::ConfigWithTransferHook,
    expected: &checks::ExpectedConfig,
) -> Option<u32> {
    use noised_launchpad::state::checks as flags_;
    let c = &cfg.config;
    let zero_vesting = c.locked_vesting_config.amount_per_period == 0
        && c.locked_vesting_config.cliff_duration_from_migration_time == 0
        && c.locked_vesting_config.frequency == 0
        && c.locked_vesting_config.number_of_period == 0
        && c.locked_vesting_config.cliff_unlock_amount == 0;
    if !(cfg.transfer_hook_program == *expected.hook_program
        && c.fee_claimer == *expected.launch_authority
        && c.leftover_receiver == *expected.launch_authority
        && c.token_type == dbc_consts::TOKEN_TYPE_TOKEN_2022
        && c.token_update_authority == dbc_consts::TOKEN_UPDATE_AUTHORITY_IMMUTABLE
        && c.migration_option == dbc_consts::MIGRATION_OPTION_DAMM_V2
        && c.collect_fee_mode == dbc_consts::COLLECT_FEE_MODE_QUOTE
        && c.activation_type == dbc_consts::ACTIVATION_TYPE_TIMESTAMP
        && c.creator_trading_fee_percentage == 0
        && c.fixed_token_supply_flag == 0
        && c.pool_creation_fee == 0
        && c.enable_first_swap_with_min_fee == 0
        && c.token_decimal == expected.token_decimal
        && c.migration_quote_threshold == expected.migration_quote_threshold
        && c.migration_fee_option == expected.migration_fee_option)
    {
        return None;
    }
    let mut flags = 0u32;
    if !(c.partner_permanent_locked_liquidity_percentage == 100
        && c.partner_liquidity_percentage == 0
        && c.creator_liquidity_percentage == 0
        && c.creator_permanent_locked_liquidity_percentage == 0
        && c.partner_liquidity_vesting_info.is_initialized == 0
        && c.creator_liquidity_vesting_info.is_initialized == 0)
    {
        return None;
    }
    flags |= flags_::LP_PERMANENTLY_LOCKED;
    if !(c.migration_fee_percentage == 0 && c.creator_migration_fee_percentage == 0) {
        return None;
    }
    flags |= flags_::NO_MIGRATION_FEE;
    if !zero_vesting {
        return None;
    }
    flags |= flags_::NO_CREATOR_ALLOCATION;
    if c.quote_mint != WSOL_MINT {
        return None;
    }
    flags |= flags_::QUOTE_IS_WSOL;
    Some(flags)
}

fn anchor_error_code(e: &anchor_lang::error::Error) -> u32 {
    match e {
        anchor_lang::error::Error::AnchorError(a) => a.error_code_number,
        anchor_lang::error::Error::ProgramError(p) => {
            panic!("unexpected program error {p:?}")
        }
    }
}

/// `launch`'s DBC config check reads the same fields at its offsets as the
/// Anchor build read through the zero-copy type, and decides the same:
/// a launch-made config with random fields changed.
#[test]
fn config_check_matches_the_anchor_build() {
    use dbc::config as c;
    let mut r = Rng(61);
    let authority = r.key();
    let hook_program = noised_hook::ID;
    let expected = checks::ExpectedConfig {
        launch_authority: &authority,
        hook_program: &hook_program,
        token_decimal: 6,
        migration_quote_threshold: 85_000_000_000,
        migration_fee_option: 2,
    };
    let mut good = [0u8; c::LEN];
    good[..8].copy_from_slice(&c::DISCRIMINATOR);
    good[c::TRANSFER_HOOK_PROGRAM..c::TRANSFER_HOOK_PROGRAM + 32]
        .copy_from_slice(hook_program.as_ref());
    good[c::QUOTE_MINT..c::QUOTE_MINT + 32].copy_from_slice(WSOL_MINT.as_ref());
    good[c::FEE_CLAIMER..c::FEE_CLAIMER + 32].copy_from_slice(authority.as_ref());
    good[c::LEFTOVER_RECEIVER..c::LEFTOVER_RECEIVER + 32].copy_from_slice(authority.as_ref());
    good[c::TOKEN_TYPE] = dbc_consts::TOKEN_TYPE_TOKEN_2022;
    good[c::TOKEN_UPDATE_AUTHORITY] = dbc_consts::TOKEN_UPDATE_AUTHORITY_IMMUTABLE;
    good[c::MIGRATION_OPTION] = dbc_consts::MIGRATION_OPTION_DAMM_V2;
    good[c::COLLECT_FEE_MODE] = dbc_consts::COLLECT_FEE_MODE_QUOTE;
    good[c::ACTIVATION_TYPE] = dbc_consts::ACTIVATION_TYPE_TIMESTAMP;
    good[c::TOKEN_DECIMAL] = 6;
    good[c::MIGRATION_QUOTE_THRESHOLD..c::MIGRATION_QUOTE_THRESHOLD + 8]
        .copy_from_slice(&85_000_000_000u64.to_le_bytes());
    good[c::MIGRATION_FEE_OPTION] = 2;
    good[c::PARTNER_PERMANENT_LOCKED_LIQUIDITY_PERCENTAGE] = 100;
    let mut passed = 0;
    for round in 0..50_000 {
        let mut data = good;
        for _ in 0..r.below(3) {
            let at = 8 + r.below(c::LEN as u64 - 8) as usize;
            let any = r.byte();
            data[at] = r.pick(&[0, 1, 2, 100, any]);
        }
        let cfg: dbc_idl::accounts::ConfigWithTransferHook =
            bytemuck::pod_read_unaligned(&data[8..]);
        let anchor = anchor_inspect_config(&cfg, &expected);
        let ours = checks::inspect_config_data(&data, &expected);
        match (anchor, ours) {
            (Some(a), Ok(o)) => {
                assert_eq!(a, o, "round {round}");
                passed += 1;
            }
            (None, Err(e)) => assert_eq!(
                anchor_error_code(&e),
                u32::from(error::LaunchpadError::UnsafeConfig),
                "round {round}"
            ),
            (a, o) => panic!("round {round}: {a:?} {o:?}"),
        }
    }
    assert!(passed > 1_000);
}

/// The Anchor build's `inspect_mint` (anchor/checks.rs), verbatim but for
/// its error plumbing: `(supply, flags)`, or `UnsafeMint`.
fn anchor_inspect_mint(
    mint_key: &Pubkey,
    owner: &Pubkey,
    data: &[u8],
    expected_decimals: u8,
    hook_program: &Pubkey,
    hook_authority: &Pubkey,
) -> Option<(u64, u32)> {
    use noised_launchpad::state::checks as flags_;
    if *owner != spl_token_2022::ID {
        return None;
    }
    let state = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(data).ok()?;
    let base = state.base;
    if !(base.is_initialized && base.decimals == expected_decimals && base.supply > 0) {
        return None;
    }
    let mut flags = 0u32;
    if base.mint_authority.is_some() {
        return None;
    }
    flags |= flags_::MINT_AUTHORITY_NONE;
    if base.freeze_authority.is_some() {
        return None;
    }
    flags |= flags_::FREEZE_AUTHORITY_NONE;
    let types = state.get_extension_types().ok()?;
    if !(types.len() == 3
        && types.contains(&ExtensionType::MetadataPointer)
        && types.contains(&ExtensionType::TokenMetadata)
        && types.contains(&ExtensionType::TransferHook))
    {
        return None;
    }
    flags |= flags_::EXTENSION_SET_EXACT;
    let hook = state.get_extension::<TransferHook>().ok()?;
    if !(Option::<Pubkey>::from(hook.program_id) == Some(*hook_program)
        && Option::<Pubkey>::from(hook.authority) == Some(*hook_authority))
    {
        return None;
    }
    flags |= flags_::HOOK_IS_NOISED;
    let pointer = state.get_extension::<MetadataPointer>().ok()?;
    if !(Option::<Pubkey>::from(pointer.authority).is_none()
        && Option::<Pubkey>::from(pointer.metadata_address) == Some(*mint_key))
    {
        return None;
    }
    flags |= flags_::METADATA_POINTER_AUTHORITY_NONE;
    let metadata = state.get_extension_bytes::<TokenMetadata>().ok()?;
    if metadata.len() < 64 {
        return None;
    }
    if !(metadata[..32].iter().all(|b| *b == 0) && metadata[32..64] == mint_key.to_bytes()) {
        return None;
    }
    flags |= flags_::METADATA_UPDATE_AUTHORITY_NONE;
    Some((base.supply, flags))
}

/// A mint as DBC leaves it for a launch (with `close` an extra
/// MintCloseAuthority extension).
fn launched_mint(mint: &Pubkey, close: bool) -> Vec<u8> {
    let opt = |k: Option<Pubkey>| OptionalNonZeroPubkey::try_from(k).unwrap();
    let mut fixed = vec![ExtensionType::MetadataPointer, ExtensionType::TransferHook];
    if close {
        fixed.push(ExtensionType::MintCloseAuthority);
    }
    let metadata = TokenMetadata {
        update_authority: opt(None),
        mint: *mint,
        name: "Noised".into(),
        symbol: "PHX".into(),
        uri: "https://example.org/phx.json".into(),
        additional_metadata: vec![],
    };
    let len = ExtensionType::try_calculate_account_len::<Mint>(&fixed).unwrap()
        + metadata.tlv_size_of().unwrap();
    let mut data = vec![0u8; len];
    let mut state = StateWithExtensionsMut::<Mint>::unpack_uninitialized(&mut data).unwrap();
    let e = state.init_extension::<MetadataPointer>(true).unwrap();
    e.authority = opt(None);
    e.metadata_address = opt(Some(*mint));
    let e = state.init_extension::<TransferHook>(true).unwrap();
    e.authority = opt(Some(DBC_POOL_AUTHORITY));
    e.program_id = opt(Some(noised_hook::ID));
    if close {
        let e = state.init_extension::<MintCloseAuthority>(true).unwrap();
        e.close_authority = opt(None);
    }
    state.base = Mint {
        mint_authority: anchor_lang::solana_program::program_option::COption::None,
        supply: 1_000_000_000_000_000,
        decimals: 6,
        is_initialized: true,
        freeze_authority: anchor_lang::solana_program::program_option::COption::None,
    };
    state.pack_base();
    state.init_account_type().unwrap();
    state.init_variable_len_extension(&metadata, false).unwrap();
    data
}

/// `launch`'s mint check decides as the Anchor build's (spl-token-2022
/// parsing) did: a launched mint with random bytes changed, random mints
/// (valid and malformed), another owner, other decimals.
#[test]
fn mint_check_matches_the_anchor_build() {
    let mut r = Rng(71);
    let mint = r.key();
    let good = launched_mint(&mint, false);
    let closable = launched_mint(&mint, true);
    let mut passed = 0;
    for round in 0..60_000 {
        let mut data = match r.below(10) {
            0 => random_mint(&mut r),
            1 => closable.clone(),
            _ => good.clone(),
        };
        for _ in 0..r.below(3) {
            if data.is_empty() {
                break;
            }
            let at = r.below(data.len() as u64) as usize;
            let any = r.byte();
            data[at] = r.pick(&[0, 1, 2, any]);
        }
        if r.chance(3) && !data.is_empty() {
            data.truncate(r.below(data.len() as u64) as usize);
        }
        let owner = if r.chance(97) {
            spl_token_2022::ID
        } else {
            let any = r.key();
            r.pick(&[anchor_spl::token::ID, any])
        };
        let decimals = if r.chance(95) { 6 } else { r.byte() };
        let anchor = anchor_inspect_mint(
            &mint,
            &owner,
            &data,
            decimals,
            &noised_hook::ID,
            &DBC_POOL_AUTHORITY,
        );
        let ours = checks::inspect_mint(
            &mint,
            &owner,
            &data,
            decimals,
            &noised_hook::ID,
            &DBC_POOL_AUTHORITY,
        );
        match (anchor, ours) {
            (Some((supply, flags)), Ok(facts)) => {
                assert_eq!(
                    (facts.supply, facts.checks),
                    (supply, flags),
                    "round {round}"
                );
                passed += 1;
            }
            (None, Err(e)) => assert_eq!(
                anchor_error_code(&e),
                u32::from(error::LaunchpadError::UnsafeMint),
                "round {round}"
            ),
            (a, o) => panic!("round {round}: {a:?} {o:?}"),
        }
    }
    assert!(passed > 10_000);
}

// ------------------------------------------------------------------ math

/// The 128-bit divisions the program computes without the general
/// division routine give exactly the Anchor build's results.
#[test]
fn wide_division_matches_the_anchor_build() {
    let mut r = Rng(81);
    for _ in 0..200_000 {
        let n = match r.below(4) {
            0 => r.u128(),
            1 => u128::from(r.next()),
            2 => u128::MAX - u128::from(r.below(1_000)),
            _ => u128::from(r.next()) * u128::from(r.next()),
        };
        let d = match r.below(4) {
            0 => r.next().max(1),
            1 => r.below(20) + 1,
            2 => u64::MAX - r.below(1_000),
            _ => 10_000,
        };
        assert_eq!(math::div_wide(n, d), n / u128::from(d), "{n} / {d}");

        // pro_rata, cap_from_bps, exponential_fee and
        // max_variable_fee_numerator as anchor/{math,policy}.rs wrote them.
        let (amount, part, total) = (r.next(), r.next(), r.next());
        let part = if r.flag() { part % total.max(1) } else { part };
        let anchor = if total == 0 || part > total {
            None
        } else {
            u64::try_from(u128::from(amount) * u128::from(part) / u128::from(total)).ok()
        };
        assert_eq!(math::pro_rata(amount, part, total), anchor);

        let (supply, bps) = (r.next(), r.u16());
        let anchor = if bps == 0 {
            Some(0)
        } else {
            let cap = u128::from(supply) * u128::from(bps) / u128::from(BPS_DENOMINATOR);
            u64::try_from(cap).ok().filter(|c| *c > 0)
        };
        assert_eq!(policy::cap_from_bps(supply, bps), anchor);

        let (cliff, reduction, periods) = (r.next(), r.below(12_000), r.u16() % 600);
        assert_eq!(
            policy::exponential_fee(cliff, reduction, periods),
            anchor_exponential_fee(cliff, reduction, periods),
            "{cliff} {reduction} {periods}"
        );

        let d = DynamicFeeParams {
            bin_step: r.u16(),
            bin_step_u128: 0,
            filter_period: 0,
            decay_period: 0,
            reduction_factor: 0,
            max_volatility_accumulator: r.u32() >> r.below(32),
            variable_fee_control: r.u32() >> r.below(32),
        };
        let anchor = (|| {
            let scaled =
                u128::from(d.max_volatility_accumulator).checked_mul(u128::from(d.bin_step))?;
            let fee = scaled
                .checked_mul(scaled)?
                .checked_mul(u128::from(d.variable_fee_control))?
                .checked_add(dbc_consts::VARIABLE_FEE_SCALE - 1)?
                / dbc_consts::VARIABLE_FEE_SCALE;
            u64::try_from(fee).ok()
        })();
        assert_eq!(policy::max_variable_fee_numerator(&d), anchor);
    }
}

fn anchor_exponential_fee(cliff: u64, reduction: u64, periods: u16) -> Option<u64> {
    const ONE: u128 = 1 << 64;
    let step = (u128::from(reduction) << 64) / u128::from(BPS_DENOMINATOR);
    let base = ONE.checked_sub(step)?;
    let mut result = ONE;
    let mut square = base;
    let mut exponent = periods;
    while exponent > 0 {
        if exponent & 1 == 1 {
            result = result.checked_mul(square)? >> 64;
        }
        exponent >>= 1;
        if exponent > 0 {
            square = square.checked_mul(square)? >> 64;
        }
    }
    if periods > 0 && result == 0 {
        return None;
    }
    u64::try_from(result.checked_mul(u128::from(cliff))? >> 64).ok()
}

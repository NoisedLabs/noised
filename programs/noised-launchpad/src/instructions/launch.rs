//! `launch()`.

use noised_onchain::{
    ids::{SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID},
    sysvar::{Clock, Rent},
    AccountView, ProgramError, ProgramResult, Seed, Signer,
};
use noised_rules::rules::NO_RULES_HASH;

use crate::{
    checks::{self, ExpectedConfig},
    constants::*,
    dbc_params, discriminator,
    error::{
        anchor::{
            ACCOUNT_DID_NOT_DESERIALIZE, ACCOUNT_DISCRIMINATOR_MISMATCH,
            ACCOUNT_DISCRIMINATOR_NOT_FOUND,
        },
        fail, fail_keys, raise, raise_error, LaunchpadError,
    },
    events::Launched,
    external::{
        dbc,
        hook::{self, Policy, PolicyError, PolicyParams, MAX_EXEMPT},
    },
    instructions::attest_launch::attestation_decodes,
    policy, pq,
    processor::{
        check_account, check_address_mismatch, check_program_address, check_seeds,
        check_seeds_with_bump, check_status, check_writable, init, launch_has_one, log_instruction,
        math_overflow, require, write_back_launch, write_back_parts, Accounts, BASE_MINT,
        BASE_VAULT, DBC_CONFIG, DBC_EVENT_AUTHORITY_FIELD, DBC_POOL_AUTHORITY_FIELD, DBC_PROGRAM,
        HOOK_AUTHORITY, HOOK_PROGRAM, LAUNCH, LAUNCH_AUTHORITY, PAYER, POOL, QUOTE_MINT,
        QUOTE_VAULT, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM,
    },
    state::{
        checks as flags, launch_offsets as at, Certificate, LaunchRulesRef, LaunchStatus,
        TokenMeta, TokenMetaRef,
    },
    Pubkey,
};

const EXTRA_ACCOUNT_META_LIST: &str = "extra_account_meta_list";
const POLICY: &str = "policy";
const CERTIFICATE: &str = "certificate";
const ATTESTATION: &str = "attestation";
const TOKEN_META: &str = "token_meta";
const RULES: &str = "rules";

fn token_meta_decodes(data: &[u8]) -> bool {
    TokenMetaRef::read(data).is_some()
}

fn rules_decodes(data: &[u8]) -> bool {
    LaunchRulesRef::read(data).is_some()
}

/// `L` bytes of `data` at `at` (zero when short; the account decoded).
fn field<const L: usize>(data: &[u8], at: usize) -> [u8; L] {
    data.get(at..)
        .and_then(|rest| rest.first_chunk::<L>())
        .copied()
        .unwrap_or([0; L])
}

/// Launch the pool, install the Launch Guard policy and certify the result.
/// Atomic: if any post-condition fails, nothing of the launch exists.
///
/// Only an attested launch goes live: its identity must have signed this
/// launch's configuration, its metadata record and its creator rules
/// (`attest_launch`), and it goes live only inside the window the identity
/// signed. The hook policy holds exactly the attested rules record's bytes
/// (none for the zero rules hash). Inside the window, anyone
/// may launch (the payer only pays rent and picks the fresh mint keypair):
/// no Ed25519 key, which a quantum computer could forge, decides what
/// launches or when. There are no arguments: the mint's name and symbol are
/// the attested record's, and its uri is derived from the record
/// (`policy::write_token_uri`); the mint is checked to hold exactly those.
///
/// Accounts: payer (signer, writable), launch (writable), launch_authority,
/// dbc_config, base_mint (signer, writable), pool, base_vault, quote_vault
/// (writable), quote_mint, dbc_pool_authority, hook_authority,
/// extra_account_meta_list, policy (writable), certificate (writable, PDA
/// `["certificate", base_mint]`, created), hook_program, dbc_program,
/// dbc_event_authority, token_2022_program, token_program, system_program,
/// attestation, token_meta, rules (or the program id for none).
pub fn process(mut accounts: Accounts) -> ProgramResult {
    log_instruction("Instruction: Launch");
    let payer = accounts.signer(PAYER)?;
    let (launch, mut launch_state) = accounts.launch()?;
    let launch_authority = accounts.unchecked(LAUNCH_AUTHORITY)?;
    let dbc_config = accounts.unchecked(DBC_CONFIG)?;
    let base_mint = accounts.signer(BASE_MINT)?;
    let pool = accounts.unchecked(POOL)?;
    let base_vault = accounts.unchecked(BASE_VAULT)?;
    let quote_vault = accounts.unchecked(QUOTE_VAULT)?;
    let (quote_mint, _) = accounts.mint(QUOTE_MINT)?;
    let dbc_pool_authority = accounts.unchecked(DBC_POOL_AUTHORITY_FIELD)?;
    let hook_authority = accounts.unchecked(HOOK_AUTHORITY)?;
    let extra_account_meta_list = accounts.unchecked(EXTRA_ACCOUNT_META_LIST)?;
    let policy_account = accounts.unchecked(POLICY)?;
    let certificate = accounts.init()?;
    let hook_program = accounts.unchecked(HOOK_PROGRAM)?;
    let dbc_program = accounts.unchecked(DBC_PROGRAM)?;
    let dbc_event_authority = accounts.unchecked(DBC_EVENT_AUTHORITY_FIELD)?;
    let token_2022_program = accounts.program(&TOKEN_2022_PROGRAM_ID, TOKEN_2022_PROGRAM)?;
    let token_program = accounts.program(&TOKEN_PROGRAM_ID, TOKEN_PROGRAM)?;
    let system_program = accounts.program(&SYSTEM_PROGRAM_ID, SYSTEM_PROGRAM)?;
    let attestation = accounts.account(
        &discriminator::ATTESTATION,
        attestation_decodes,
        ATTESTATION,
    )?;
    let token_meta =
        accounts.account(&discriminator::TOKEN_META, token_meta_decodes, TOKEN_META)?;
    let rules = accounts.optional(Some(RULES))?;
    if let Some(rules) = rules {
        check_account(
            rules,
            &discriminator::LAUNCH_RULES,
            rules_decodes,
            Some(RULES),
        )?;
    }
    // The attestation's fields (`Attestation`'s layout).
    let att: [u8; 196] = field(&attestation.try_borrow()?, 0);
    let att_bump = att[9];
    let att_launch: [u8; 32] = field(&att, 10);
    let att_pq_identity: [u8; 32] = field(&att, 42);
    let att_leaf = u16::from_le_bytes(field(&att, 74));
    let att_metadata_hash: [u8; 32] = field(&att, 76);
    let att_rules_hash: [u8; 32] = field(&att, 108);
    let att_slot = u64::from_le_bytes(field(&att, 172));
    let att_not_before = i64::from_le_bytes(field(&att, 180));
    let att_not_after = i64::from_le_bytes(field(&att, 188));

    // [A] certificate: init, payer = payer, space = 8 +
    // Certificate::INIT_SPACE, seeds = [CERTIFICATE_SEED, base_mint], bump;
    // then mut and rent exemption.
    let rent = Rent::get()?;
    let mint_key = *base_mint.address();
    let certificate_bump = check_seeds(
        certificate,
        &[CERTIFICATE_SEED, mint_key.as_ref()],
        CERTIFICATE,
    )?;
    let certificate_bump_seed = [certificate_bump];
    init(
        payer,
        certificate,
        Certificate::LEN,
        &rent,
        &[
            Seed::from(CERTIFICATE_SEED),
            Seed::from(mint_key.as_ref()),
            Seed::from(&certificate_bump_seed),
        ],
        CERTIFICATE,
    )?;

    // [A] duplicate mutable accounts: launch only (certificate is a plain
    // init). payer: mut. launch: mut, has_one = dbc_config @
    // AccountMismatch, has_one = launch_authority @ AccountMismatch,
    // constraint = status == Configured @ WrongLaunchState. base_mint, pool,
    // base_vault, quote_vault: mut. quote_mint: address = WSOL_MINT @
    // AccountMismatch. dbc_pool_authority: address = DBC_POOL_AUTHORITY @
    // AccountMismatch. hook_authority: seeds = [HOOK_AUTHORITY_SEED], bump.
    // extra_account_meta_list, policy: mut. hook_program, dbc_program:
    // address @ AccountMismatch, executable. dbc_event_authority: address @
    // AccountMismatch. attestation: seeds = [ATTESTATION_SEED, launch], bump
    // = attestation.bump. token_meta: seeds = [METADATA_SEED, launch,
    // attestation.metadata_hash], bump = token_meta.bump. rules (if any):
    // seeds = [RULES_SEED, launch, attestation.rules_hash], bump = rules.bump.
    check_writable(payer, PAYER)?;
    check_writable(launch, LAUNCH)?;
    launch_has_one(&launch_state, at::DBC_CONFIG, dbc_config)?;
    launch_has_one(&launch_state, at::LAUNCH_AUTHORITY, launch_authority)?;
    check_status(&launch_state, LaunchStatus::Configured)?;
    check_writable(base_mint, BASE_MINT)?;
    check_writable(pool, POOL)?;
    check_writable(base_vault, BASE_VAULT)?;
    check_writable(quote_vault, QUOTE_VAULT)?;
    check_address_mismatch(quote_mint, &WSOL_MINT, QUOTE_MINT)?;
    check_address_mismatch(
        dbc_pool_authority,
        &DBC_POOL_AUTHORITY,
        DBC_POOL_AUTHORITY_FIELD,
    )?;
    let hook_bump = check_seeds(hook_authority, &[HOOK_AUTHORITY_SEED], HOOK_AUTHORITY)?;
    check_writable(extra_account_meta_list, EXTRA_ACCOUNT_META_LIST)?;
    check_writable(policy_account, POLICY)?;
    check_program_address(hook_program, &hook::ID, HOOK_PROGRAM)?;
    check_program_address(dbc_program, &DBC_PROGRAM_ID, DBC_PROGRAM)?;
    check_address_mismatch(
        dbc_event_authority,
        &DBC_EVENT_AUTHORITY,
        DBC_EVENT_AUTHORITY_FIELD,
    )?;
    let launch_key = *launch.address();
    check_seeds_with_bump(
        attestation,
        &[ATTESTATION_SEED, launch_key.as_ref(), &[att_bump]],
        ATTESTATION,
    )?;
    let token_meta_bump = token_meta
        .try_borrow()?
        .get(TokenMeta::BUMP_OFFSET)
        .copied()
        .unwrap_or(0);
    check_seeds_with_bump(
        token_meta,
        &[
            METADATA_SEED,
            launch_key.as_ref(),
            &att_metadata_hash,
            &[token_meta_bump],
        ],
        TOKEN_META,
    )?;
    if let Some(rules) = rules {
        let rules_bump = rules.try_borrow()?.get(9).copied().unwrap_or(0);
        check_seeds_with_bump(
            rules,
            &[
                RULES_SEED,
                launch_key.as_ref(),
                &att_rules_hash,
                &[rules_bump],
            ],
            RULES,
        )?;
    }

    // Handler.
    let now = Clock::get()?.unix_timestamp;
    let (data, uri_at, name_len, symbol_len) = {
        let token_meta_data = token_meta.try_borrow()?;
        let tm = TokenMetaRef::read(&token_meta_data).ok_or(ProgramError::InvalidAccountData)?;
        // The record's address already follows from the attestation's hash
        // (account seeds); its fields are checked here too.
        require(
            att_launch == launch_key.to_bytes()
                && att_pq_identity == launch_state.array32(at::PQ_IDENTITY)
                && tm.version == TokenMeta::VERSION
                && tm.launch == launch_key
                && tm.metadata_hash == att_metadata_hash,
            LaunchpadError::AttestationMismatch,
        )?;
        // 1. (below) The mint's name and symbol are the record's, and its uri
        //    is derived from the record straight into the instruction's data
        //    (`InitializePoolParameters { name, symbol, uri }`).
        let (data, uri_at) =
            dbc_params::initialize_pool_data(tm.name, tm.symbol, tm.flags, tm.uri, tm.doc);
        (data, uri_at, tm.name.len(), tm.symbol.len())
    };
    // The rules record the attestation names (its address follows from
    // the attested hash: account seeds), and none for the zero hash.
    require(
        rules.is_some() == (att_rules_hash != NO_RULES_HASH),
        LaunchpadError::AttestationMismatch,
    )?;
    // Its bytes are the attested ones (review 4, R6a): hashed here
    // again, so the binding does not rest on `publish_rules` being the
    // only writer of a record.
    let mut rules_bytes = alloc::vec::Vec::new();
    if let Some(rules) = rules {
        let rules_data = rules.try_borrow()?;
        let record = LaunchRulesRef::read(&rules_data).ok_or(ProgramError::InvalidAccountData)?;
        require(
            pq::rules_hash(record.bytes) == att_rules_hash,
            LaunchpadError::AttestationMismatch,
        )?;
        rules_bytes.extend_from_slice(record.bytes);
    }
    require(
        pq::in_launch_window(now, att_not_before, att_not_after),
        LaunchpadError::NotLaunchWindow,
    )?;
    let pool_key = *pool.address();
    let metadata_key = *token_meta.address();
    let launch_authority_key = launch_state.key(at::LAUNCH_AUTHORITY);
    let batch_authority = launch_state.key(at::BATCH_AUTHORITY);

    // 1. DBC pool: the launch authority PDA signs as pool creator.
    let authority_bump = [launch_state.byte(at::AUTHORITY_BUMP)];
    dbc::initialize_virtual_pool_with_token2022_transfer_hook(
        &dbc::InitializePool {
            config: dbc_config,
            pool_authority: dbc_pool_authority,
            creator: launch_authority,
            base_mint,
            quote_mint,
            pool,
            base_vault,
            quote_vault,
            transfer_hook_program: hook_program,
            payer,
            token_quote_program: token_program,
            token_program: token_2022_program,
            system_program,
            event_authority: dbc_event_authority,
            program: dbc_program,
        },
        &data,
        &[Signer::from(&[
            Seed::from(AUTHORITY_SEED),
            Seed::from(launch_key.as_ref()),
            Seed::from(&authority_bump),
        ])],
    )?;

    // 2. Post-conditions on the mint (its metadata included), the DBC
    //    config and the pool.
    let token_decimal = launch_state.byte(at::TOKEN_DECIMAL);
    let (mint_facts, metadata_flag) = {
        let mint_data = base_mint.try_borrow()?;
        let facts = checks::inspect_mint(
            &mint_key,
            base_mint.owner(),
            &mint_data,
            token_decimal,
            &hook::ID,
            &DBC_POOL_AUTHORITY,
        )
        .map_err(raise_error)?;
        // The record's name and symbol (sent to DBC: in `data` after the
        // discriminator and their lengths), and the uri sent to DBC.
        let name = data.get(12..12 + name_len).unwrap_or_default();
        let symbol = data
            .get(16 + name_len..16 + name_len + symbol_len)
            .unwrap_or_default();
        let metadata_flag = checks::verify_token_metadata_bytes(
            &mint_data,
            name,
            symbol,
            data.get(uri_at..).unwrap_or_default(),
        )
        .map_err(raise_error)?;
        (facts, metadata_flag)
    };
    let config_flags = checks::verify_dbc_config(
        dbc_config,
        &ExpectedConfig {
            launch_authority: &launch_authority_key,
            hook_program: &hook::ID,
            token_decimal,
            migration_quote_threshold: launch_state.u64(at::MIGRATION_QUOTE_THRESHOLD),
            migration_fee_option: launch_state.byte(at::MIGRATION_FEE_OPTION),
        },
    )?;
    checks::inspect_pool(
        &checks::read_dbc_pool(pool)?,
        dbc_config.address(),
        &launch_authority_key,
        &mint_key,
        base_vault.address(),
        quote_vault.address(),
    )?;
    // PQ_ATTESTED: the attestation was checked above, before any CPI.
    let checks_all = mint_facts.checks | metadata_flag | config_flags | flags::PQ_ATTESTED;
    require(checks_all == flags::ALL, LaunchpadError::UnsafeMint)?;
    let supply = mint_facts.supply;

    // 3. Launch Guard: meta list (permissionless) and the policy, which only
    //    the hook-authority PDA can sign for.
    hook::initialize_extra_account_meta_list(
        payer,
        extra_account_meta_list,
        base_mint,
        system_program,
    )?;
    let max_wallet = policy::cap_from_bps(supply, launch_state.u16(at::MAX_WALLET_BPS))
        .ok_or_else(|| raise(LaunchpadError::InvalidMaxWallet))?;
    let max_buy = policy::cap_from_bps(supply, launch_state.u16(at::MAX_BUY_BPS))
        .ok_or_else(|| raise(LaunchpadError::InvalidMaxBuy))?;
    let open_delay_secs = launch_state.u32(at::OPEN_DELAY_SECS);
    let guard_secs = launch_state.u32(at::GUARD_SECS);
    let p2p_locked = launch_state.flag(at::P2P_LOCKED);
    let shield_secs = open_delay_secs
        .checked_add(EXECUTION_GRACE_SECS)
        .ok_or_else(math_overflow)?;
    let mut exempt = [Pubkey::default(); MAX_EXEMPT];
    exempt[0] = batch_authority;
    exempt[1] = launch_authority_key;
    let hook_bump_seed = [hook_bump];
    hook::create_policy(
        payer,
        hook_authority,
        base_mint,
        pool,
        policy_account,
        system_program,
        &PolicyParams {
            pool: pool_key,
            snipe_shield_secs: shield_secs,
            guard_secs,
            max_wallet,
            max_buy,
            p2p_locked,
            exempt,
            rules: &rules_bytes,
        }
        .data(),
        &[Signer::from(&[
            Seed::from(HOOK_AUTHORITY_SEED),
            Seed::from(&hook_bump_seed),
        ])],
    )?;

    // 4. The written policy must be exactly what was asked for; it holds
    //    the creator rules (`RULES_BOUND`) if any.
    let commit_end_ts = now
        .checked_add(i64::from(open_delay_secs))
        .ok_or_else(math_overflow)?;
    let execute_end_ts = commit_end_ts
        .checked_add(i64::from(EXECUTION_GRACE_SECS))
        .ok_or_else(math_overflow)?;
    let guard_end_ts = now
        .checked_add(i64::from(guard_secs))
        .ok_or_else(math_overflow)?;
    let rules_bound = verify_policy(
        policy_account,
        &Expected {
            mint: &mint_key,
            pool: &pool_key,
            base_vault: base_vault.address(),
            launch_ts: now,
            execute_end_ts,
            guard_end_ts,
            max_wallet,
            max_buy,
            p2p_locked,
            exempt: &exempt,
            rules: &rules_bytes,
        },
    )?;

    // 5. Launch state, then the certificate (`Certificate`'s fields in
    //    order; the launch's own fields among them are not changed here).
    launch_state.set(at::BASE_MINT, mint_key.as_ref());
    launch_state.set(at::POOL, pool_key.as_ref());
    launch_state.set(at::LAUNCH_TS, &now.to_le_bytes());
    launch_state.set(at::COMMIT_END_TS, &commit_end_ts.to_le_bytes());
    launch_state.set(at::EXECUTE_END_TS, &execute_end_ts.to_le_bytes());
    launch_state.set(at::GUARD_END_TS, &guard_end_ts.to_le_bytes());
    launch_state.set(at::STATUS, &[LaunchStatus::Live as u8]);

    Launched::log(
        &launch_key,
        &mint_key,
        &pool_key,
        certificate.address(),
        supply,
        now,
        commit_end_ts,
        execute_end_ts,
        guard_end_ts,
        &att_pq_identity,
        att_leaf,
    );

    // Exit: launch, then certificate.
    write_back_launch(launch, &launch_state)?;
    let stored = |from: usize, len: usize| launch_state.0.get(from..from + len).unwrap_or_default();
    write_back_parts(
        certificate,
        CERTIFICATE,
        &[
            &discriminator::CERTIFICATE,
            &[Certificate::VERSION, certificate_bump],
            launch_key.as_ref(),
            mint_key.as_ref(),
            pool_key.as_ref(),
            stored(at::DBC_CONFIG, 32),
            stored(at::CREATOR, 32),
            &now.to_le_bytes(),
            &[token_decimal],
            &supply.to_le_bytes(),
            &(checks_all | rules_bound).to_le_bytes(),
            stored(at::MIGRATION_QUOTE_THRESHOLD, 8),
            stored(at::MIGRATION_FEE_OPTION, 1),
            // snipe_shield_end_ts, execute_end_ts.
            &execute_end_ts.to_le_bytes(),
            &execute_end_ts.to_le_bytes(),
            &guard_end_ts.to_le_bytes(),
            &max_wallet.to_le_bytes(),
            &max_buy.to_le_bytes(),
            stored(at::P2P_LOCKED, 1),
            stored(at::PLATFORM_FEE_BPS, 2),
            stored(at::RECIPIENTS, at::RECIPIENT_COUNT - at::RECIPIENTS),
            stored(at::PARAMS_HASH, 32),
            &SAFETY_POLICY_VERSION.to_le_bytes(),
            &att_pq_identity,
            &att_leaf.to_le_bytes(),
            &att_slot.to_le_bytes(),
            metadata_key.as_ref(),
            &att_rules_hash,
        ],
    )
}

/// What the written policy must hold.
struct Expected<'a> {
    mint: &'a Pubkey,
    pool: &'a Pubkey,
    base_vault: &'a Pubkey,
    launch_ts: i64,
    execute_end_ts: i64,
    guard_end_ts: i64,
    max_wallet: u64,
    max_buy: u64,
    p2p_locked: bool,
    exempt: &'a [Pubkey; MAX_EXEMPT],
    rules: &'a [u8],
}

/// The written policy is exactly the one asked for: owned by the hook
/// (`UnsafePolicy`, with both keys), a `HookPolicy` (Anchor's decoding
/// errors), with these fields (`UnsafePolicy`). Returns `RULES_BOUND` when
/// it holds creator rules.
#[inline(never)]
fn verify_policy(policy: &AccountView, want: &Expected) -> Result<u32, ProgramError> {
    if policy.owner() != &hook::ID {
        return Err(fail_keys(
            LaunchpadError::UnsafePolicy.code(),
            None,
            policy.owner(),
            &hook::ID,
        ));
    }
    let data = policy.try_borrow()?;
    let written = Policy::read(&data).map_err(|e| match e {
        PolicyError::DiscriminatorNotFound => fail(ACCOUNT_DISCRIMINATOR_NOT_FOUND, None),
        // Anchor's `#[account]` names the type here.
        PolicyError::DiscriminatorMismatch => {
            fail(ACCOUNT_DISCRIMINATOR_MISMATCH, Some("HookPolicy"))
        }
        PolicyError::DidNotDeserialize => fail(ACCOUNT_DID_NOT_DESERIALIZE, None),
    })?;
    require(
        written.mint == *want.mint
            && written.pool == *want.pool
            && written.base_vault == *want.base_vault
            && written.launch_ts == want.launch_ts
            && written.snipe_shield_end_ts == want.execute_end_ts
            && written.guard_end_ts == want.guard_end_ts
            && written.max_wallet == want.max_wallet
            && written.max_buy == want.max_buy
            && written.p2p_locked == want.p2p_locked
            && written.exempt == *want.exempt
            && written.rules == want.rules,
        LaunchpadError::UnsafePolicy,
    )?;
    Ok(if written.rules.is_empty() {
        0
    } else {
        flags::RULES_BOUND
    })
}

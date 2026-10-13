use anchor_lang::{
    prelude::*,
    solana_program::{instruction::Instruction, program::invoke_signed},
};
use anchor_spl::{token::Token, token_2022::Token2022, token_interface::Mint};
use noised_hook::state::{HookPolicy, PolicyParams, MAX_EXEMPT};
use noised_rules::rules::NO_RULES_HASH;

use crate::{
    checks::{self, ExpectedConfig},
    constants::*,
    dbc_params, dynamic_bonding_curve,
    error::LaunchpadError,
    events::Launched,
    policy, pq,
    state::{
        checks as flags, Attestation, Certificate, Launch, LaunchRules, LaunchStatus, TokenMeta,
    },
};

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
pub fn handle_launch(ctx: Context<LaunchToken>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let launch_key = ctx.accounts.launch.key();
    let (pq_identity, pq_leaf, attested_slot) = {
        let attestation = &ctx.accounts.attestation;
        let token_meta = &ctx.accounts.token_meta;
        // The record's address already follows from the attestation's hash
        // (account seeds); its fields are checked here too.
        require!(
            attestation.launch == launch_key
                && attestation.pq_identity == ctx.accounts.launch.pq_identity
                && token_meta.version == TokenMeta::VERSION
                && token_meta.launch == launch_key
                && token_meta.metadata_hash == attestation.metadata_hash,
            LaunchpadError::AttestationMismatch
        );
        // The rules record the attestation names (its address follows from
        // the attested hash: account seeds), and none for the zero hash.
        require!(
            ctx.accounts.rules.is_some() == (attestation.rules_hash != NO_RULES_HASH),
            LaunchpadError::AttestationMismatch
        );
        // Its bytes are the attested ones (review 4, R6a): hashed here
        // again, so the binding does not rest on `publish_rules` being the
        // only writer of a record.
        require!(
            ctx.accounts
                .rules
                .as_ref()
                .is_none_or(|r| pq::rules_hash(&r.bytes) == attestation.rules_hash),
            LaunchpadError::AttestationMismatch
        );
        require!(
            pq::in_launch_window(now, attestation.not_before, attestation.not_after),
            LaunchpadError::NotLaunchWindow
        );
        (attestation.pq_identity, attestation.leaf, attestation.slot)
    };
    let mint_key = ctx.accounts.base_mint.key();
    let pool_key = ctx.accounts.pool.key();
    let metadata_key = ctx.accounts.token_meta.key();
    let launch_authority = ctx.accounts.launch.launch_authority;
    let batch_authority = ctx.accounts.launch.batch_authority;

    // 1. DBC pool: the launch authority PDA signs as pool creator. The
    //    mint's name and symbol are the record's, and its uri is derived
    //    from the record straight into the instruction's data
    //    (`InitializePoolParameters { name, symbol, uri }`).
    let authority_bump = [ctx.accounts.launch.authority_bump];
    let authority_seeds: &[&[u8]] = &[AUTHORITY_SEED, launch_key.as_ref(), &authority_bump];
    let a = &ctx.accounts;
    let tm = &a.token_meta;
    let (data, uri_at) =
        dbc_params::initialize_pool_data(&tm.name, &tm.symbol, tm.flags, &tm.uri, &tm.doc);
    let pool_accounts =
        dynamic_bonding_curve::cpi::accounts::InitializeVirtualPoolWithToken2022TransferHook {
            config: a.dbc_config.to_account_info(),
            pool_authority: a.dbc_pool_authority.to_account_info(),
            creator: a.launch_authority.to_account_info(),
            base_mint: a.base_mint.to_account_info(),
            quote_mint: a.quote_mint.to_account_info(),
            pool: a.pool.to_account_info(),
            base_vault: a.base_vault.to_account_info(),
            quote_vault: a.quote_vault.to_account_info(),
            transfer_hook_program: a.hook_program.to_account_info(),
            payer: a.payer.to_account_info(),
            token_quote_program: a.token_program.to_account_info(),
            token_program: a.token_2022_program.to_account_info(),
            system_program: a.system_program.to_account_info(),
            event_authority: a.dbc_event_authority.to_account_info(),
            program: a.dbc_program.to_account_info(),
        };
    let pool_ix = Instruction {
        program_id: DBC_PROGRAM_ID,
        accounts: pool_accounts.to_account_metas(None),
        data,
    };
    invoke_signed(
        &pool_ix,
        &pool_accounts.to_account_infos(),
        &[authority_seeds],
    )?;

    // 2. Post-conditions on the mint (its metadata included), the DBC
    //    config and the pool.
    let token_decimal = ctx.accounts.launch.token_decimal;
    let (mint_facts, metadata_flag) = {
        let info = ctx.accounts.base_mint.to_account_info();
        let data = info.try_borrow_data()?;
        let facts = checks::inspect_mint(
            &mint_key,
            info.owner,
            &data,
            token_decimal,
            &noised_hook::ID,
            &DBC_POOL_AUTHORITY,
        )?;
        // The record's name and symbol, and the uri sent to DBC.
        let tm = &ctx.accounts.token_meta;
        let metadata_flag = checks::verify_token_metadata(
            &data,
            &tm.name,
            &tm.symbol,
            pool_ix.data.get(uri_at..).unwrap_or_default(),
        )?;
        (facts, metadata_flag)
    };
    let config_flags = checks::verify_dbc_config(
        &ctx.accounts.dbc_config,
        &ExpectedConfig {
            launch_authority: &launch_authority,
            hook_program: &noised_hook::ID,
            token_decimal,
            migration_quote_threshold: ctx.accounts.launch.migration_quote_threshold,
            migration_fee_option: ctx.accounts.launch.migration_fee_option,
        },
    )?;
    {
        let pool = checks::read_dbc_pool(&ctx.accounts.pool.to_account_info())?;
        checks::inspect_pool(
            &pool,
            &ctx.accounts.dbc_config.key(),
            &launch_authority,
            &mint_key,
            &ctx.accounts.base_vault.key(),
            &ctx.accounts.quote_vault.key(),
        )?;
    }
    // PQ_ATTESTED: the attestation was checked above, before any CPI.
    let checks_all = mint_facts.checks | metadata_flag | config_flags | flags::PQ_ATTESTED;
    require!(checks_all == flags::ALL, LaunchpadError::UnsafeMint);
    let supply = mint_facts.supply;

    // 3. Launch Guard: meta list (permissionless) and the policy, which only
    //    the hook-authority PDA can sign for.
    let a = &ctx.accounts;
    noised_hook::cpi::initialize_extra_account_meta_list(CpiContext::new(
        noised_hook::ID,
        noised_hook::cpi::accounts::InitializeExtraAccountMetaList {
            payer: a.payer.to_account_info(),
            extra_account_meta_list: a.extra_account_meta_list.to_account_info(),
            mint: a.base_mint.to_account_info(),
            system_program: a.system_program.to_account_info(),
        },
    ))?;
    let launch = &ctx.accounts.launch;
    let max_wallet = policy::cap_from_bps(supply, launch.max_wallet_bps)
        .ok_or(LaunchpadError::InvalidMaxWallet)?;
    let max_buy =
        policy::cap_from_bps(supply, launch.max_buy_bps).ok_or(LaunchpadError::InvalidMaxBuy)?;
    let shield_secs = launch
        .open_delay_secs
        .checked_add(EXECUTION_GRACE_SECS)
        .ok_or(LaunchpadError::MathOverflow)?;
    let mut exempt = [Pubkey::default(); MAX_EXEMPT];
    exempt[0] = batch_authority;
    exempt[1] = launch_authority;
    let rules: &[u8] = ctx.accounts.rules.as_ref().map_or(&[], |r| &r.bytes);
    let policy_params = PolicyParams {
        pool: pool_key,
        snipe_shield_secs: shield_secs,
        guard_secs: launch.guard_secs,
        max_wallet,
        max_buy,
        p2p_locked: launch.p2p_locked,
        exempt,
        rules: rules.to_vec(),
    };
    let hook_bump = [ctx.bumps.hook_authority];
    let hook_seeds: &[&[u8]] = &[HOOK_AUTHORITY_SEED, &hook_bump];
    noised_hook::cpi::create_policy(
        CpiContext::new_with_signer(
            noised_hook::ID,
            noised_hook::cpi::accounts::CreatePolicy {
                payer: a.payer.to_account_info(),
                launchpad_authority: a.hook_authority.to_account_info(),
                mint: a.base_mint.to_account_info(),
                pool: a.pool.to_account_info(),
                policy: a.policy.to_account_info(),
                system_program: a.system_program.to_account_info(),
            },
            &[hook_seeds],
        ),
        policy_params,
    )?;

    // 4. The written policy must be exactly what was asked for; it holds
    //    the creator rules (`RULES_BOUND`) if any.
    let commit_end_ts = now
        .checked_add(i64::from(launch.open_delay_secs))
        .ok_or(LaunchpadError::MathOverflow)?;
    let execute_end_ts = commit_end_ts
        .checked_add(i64::from(EXECUTION_GRACE_SECS))
        .ok_or(LaunchpadError::MathOverflow)?;
    let guard_end_ts = now
        .checked_add(i64::from(launch.guard_secs))
        .ok_or(LaunchpadError::MathOverflow)?;
    let mut rules_bound = 0;
    {
        let info = ctx.accounts.policy.to_account_info();
        require_keys_eq!(*info.owner, noised_hook::ID, LaunchpadError::UnsafePolicy);
        let data = info.try_borrow_data()?;
        let written = HookPolicy::try_deserialize(&mut &data[..])?;
        require!(
            written.mint == mint_key
                && written.pool == pool_key
                && written.base_vault == ctx.accounts.base_vault.key()
                && written.launch_ts == now
                && written.snipe_shield_end_ts == execute_end_ts
                && written.guard_end_ts == guard_end_ts
                && written.max_wallet == max_wallet
                && written.max_buy == max_buy
                && written.p2p_locked == launch.p2p_locked
                && written.exempt == exempt
                && written.rules == rules,
            LaunchpadError::UnsafePolicy
        );
        if !written.rules.is_empty() {
            rules_bound = flags::RULES_BOUND;
        }
    }

    // 5. Certificate and launch state.
    let rules_hash = ctx.accounts.attestation.rules_hash;
    let certificate_key = ctx.accounts.certificate.key();
    let cert = &mut ctx.accounts.certificate;
    let launch = &ctx.accounts.launch;
    cert.version = Certificate::VERSION;
    cert.bump = ctx.bumps.certificate;
    cert.launch = launch_key;
    cert.base_mint = mint_key;
    cert.pool = pool_key;
    cert.dbc_config = launch.dbc_config;
    cert.creator = launch.creator;
    cert.launched_at = now;
    cert.token_decimal = token_decimal;
    cert.initial_supply = supply;
    cert.checks = checks_all | rules_bound;
    cert.migration_quote_threshold = launch.migration_quote_threshold;
    cert.migration_fee_option = launch.migration_fee_option;
    cert.snipe_shield_end_ts = execute_end_ts;
    cert.execute_end_ts = execute_end_ts;
    cert.guard_end_ts = guard_end_ts;
    cert.max_wallet = max_wallet;
    cert.max_buy = max_buy;
    cert.p2p_locked = launch.p2p_locked;
    cert.platform_fee_bps = launch.platform_fee_bps;
    cert.recipients = launch.recipients;
    cert.params_hash = launch.params_hash;
    cert.policy_version = SAFETY_POLICY_VERSION;
    cert.pq_identity = pq_identity;
    cert.pq_leaf = pq_leaf;
    cert.attested_slot = attested_slot;
    cert.metadata = metadata_key;
    cert.rules_hash = rules_hash;

    let launch = &mut ctx.accounts.launch;
    launch.base_mint = mint_key;
    launch.pool = pool_key;
    launch.launch_ts = now;
    launch.commit_end_ts = commit_end_ts;
    launch.execute_end_ts = execute_end_ts;
    launch.guard_end_ts = guard_end_ts;
    launch.status = LaunchStatus::Live;

    emit!(Launched {
        launch: launch_key,
        base_mint: mint_key,
        pool: pool_key,
        certificate: certificate_key,
        initial_supply: supply,
        launch_ts: now,
        commit_end_ts,
        execute_end_ts,
        guard_end_ts,
        pq_identity,
        pq_leaf,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct LaunchToken<'info> {
    /// Anyone, inside the attested window: pays the rent of the pool, mint,
    /// policy and certificate.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        has_one = dbc_config @ LaunchpadError::AccountMismatch,
        has_one = launch_authority @ LaunchpadError::AccountMismatch,
        constraint = launch.status == LaunchStatus::Configured @ LaunchpadError::WrongLaunchState,
    )]
    pub launch: Box<Account<'info, Launch>>,

    /// CHECK: PDA bound to `launch`; signs as DBC pool creator.
    pub launch_authority: UncheckedAccount<'info>,

    /// CHECK: the DBC config created by `create_launch` (bound by `has_one`);
    /// owner, type and every fixed value are re-checked after the pool CPI.
    pub dbc_config: UncheckedAccount<'info>,

    /// Fresh mint keypair (the payer's choice); DBC creates the mint.
    #[account(mut)]
    pub base_mint: Signer<'info>,

    /// CHECK: created by DBC, which enforces its PDA address; re-read after.
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,

    /// CHECK: created by DBC at its PDA address.
    #[account(mut)]
    pub base_vault: UncheckedAccount<'info>,

    /// CHECK: created by DBC at its PDA address.
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,

    #[account(address = WSOL_MINT @ LaunchpadError::AccountMismatch)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: DBC pool authority.
    #[account(address = DBC_POOL_AUTHORITY @ LaunchpadError::AccountMismatch)]
    pub dbc_pool_authority: UncheckedAccount<'info>,

    /// CHECK: the only signer `noised_hook::create_policy` accepts.
    #[account(seeds = [HOOK_AUTHORITY_SEED], bump)]
    pub hook_authority: UncheckedAccount<'info>,

    /// CHECK: created by the hook at its PDA address.
    #[account(mut)]
    pub extra_account_meta_list: UncheckedAccount<'info>,

    /// CHECK: created by the hook at its PDA address; re-read after.
    #[account(mut)]
    pub policy: UncheckedAccount<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + Certificate::INIT_SPACE,
        seeds = [CERTIFICATE_SEED, base_mint.key().as_ref()],
        bump,
    )]
    pub certificate: Box<Account<'info, Certificate>>,

    /// CHECK: the Noised Launch Guard hook program.
    #[account(address = noised_hook::ID @ LaunchpadError::AccountMismatch, executable)]
    pub hook_program: UncheckedAccount<'info>,

    /// CHECK: Meteora DBC.
    #[account(address = DBC_PROGRAM_ID @ LaunchpadError::AccountMismatch, executable)]
    pub dbc_program: UncheckedAccount<'info>,

    /// CHECK: DBC event authority PDA.
    #[account(address = DBC_EVENT_AUTHORITY @ LaunchpadError::AccountMismatch)]
    pub dbc_event_authority: UncheckedAccount<'info>,

    pub token_2022_program: Program<'info, Token2022>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,

    /// This launch's post-quantum attestation (`attest_launch`); its fields
    /// are checked against the launch, the metadata record and the clock in
    /// the handler.
    #[account(
        seeds = [ATTESTATION_SEED, launch.key().as_ref()],
        bump = attestation.bump,
    )]
    pub attestation: Box<Account<'info, Attestation>>,

    /// The metadata record the attestation names (`publish_metadata`): the
    /// mint's name, symbol and uri come from it.
    #[account(
        seeds = [METADATA_SEED, launch.key().as_ref(), attestation.metadata_hash.as_ref()],
        bump = token_meta.bump,
    )]
    pub token_meta: Box<Account<'info, TokenMeta>>,

    /// The rules record the attestation names (`publish_rules`), whose bytes
    /// the hook policy gets; none (the program id) when the attested rules
    /// hash is zero.
    #[account(
        seeds = [RULES_SEED, launch.key().as_ref(), attestation.rules_hash.as_ref()],
        bump = rules.bump,
    )]
    pub rules: Option<Box<Account<'info, LaunchRules>>>,
}

//! `create_launch(launch_seed, params)`.

use noised_onchain::{
    args::Reader, pda::find_program_address, sysvar::Rent, ProgramResult, Seed, Signer,
};

use crate::{
    constants::*,
    discriminator,
    error::{fail_keys, raise_error, LaunchpadError},
    events::LaunchCreated,
    external::{dbc, hook},
    policy,
    processor::{
        check_address_mismatch, check_program_address, check_seeds, check_seeds_with_bump,
        check_writable, did_not_deserialize, init, log_instruction, write_back_launch, Accounts,
        DBC_CONFIG, DBC_EVENT_AUTHORITY_FIELD, DBC_PROGRAM, HOOK_PROGRAM, LAUNCH, LAUNCH_AUTHORITY,
        QUOTE_MINT, SYSTEM_PROGRAM,
    },
    state::{launch_offsets as at, Launch, LaunchData, LaunchParams, LaunchStatus, Protocol},
};

const CREATOR: &str = "creator";
const PROTOCOL: &str = "protocol";

/// Validate the creator's parameters against the safety policy and create the
/// launch's DBC transfer-hook config with every other field fixed. The
/// launch names its creator's post-quantum identity (`params.pq_identity`,
/// covered by `params_hash`); it can go live only once that identity has
/// attested it (`attest_launch`), inside the window it signed. Its address
/// is `["launch", creator, launch_seed]`.
///
/// Accounts: creator (signer, writable), protocol, launch (writable, PDA
/// `["launch", creator, launch_seed]`, created), launch_authority (PDA
/// `["authority", launch]`), dbc_config (writable, PDA `["dbc-config",
/// launch]`), quote_mint (wSOL), hook_program, dbc_program,
/// dbc_event_authority, system_program.
pub fn process(mut accounts: Accounts, args: &[u8]) -> ProgramResult {
    log_instruction("Instruction: CreateLaunch");
    // (launch_seed: [u8; 32], params: LaunchParams); `params_hash` is the
    // SHA-256 of the params' Borsh bytes, which decoding then encoding
    // reproduces exactly (Borsh is canonical for these types).
    let (Some(launch_seed), Some(params_args)) = (args.first_chunk::<32>(), args.get(32..)) else {
        return Err(did_not_deserialize());
    };
    let mut reader = Reader::new(params_args);
    let Some(params) = LaunchParams::read(&mut reader) else {
        return Err(did_not_deserialize());
    };
    let params_len = params_args.len().wrapping_sub(reader.rest().len());
    let params_bytes = params_args.get(..params_len).unwrap_or_default();

    let creator = accounts.signer(CREATOR)?;
    let protocol = accounts.account(&discriminator::PROTOCOL, Protocol::decodes, PROTOCOL)?;
    let protocol_state = Protocol::load(protocol)?;
    let launch = accounts.init()?;
    let launch_authority = accounts.unchecked(LAUNCH_AUTHORITY)?;
    let dbc_config = accounts.unchecked(DBC_CONFIG)?;
    let (quote_mint, _) = accounts.mint(QUOTE_MINT)?;
    let hook_program = accounts.unchecked(HOOK_PROGRAM)?;
    let dbc_program = accounts.unchecked(DBC_PROGRAM)?;
    let dbc_event_authority = accounts.unchecked(DBC_EVENT_AUTHORITY_FIELD)?;
    let system_program =
        accounts.program(&noised_onchain::ids::SYSTEM_PROGRAM_ID, SYSTEM_PROGRAM)?;

    // [A] launch: init, payer = creator, space = 8 + Launch::INIT_SPACE,
    // seeds = [LAUNCH_SEED, creator, launch_seed], bump; then mut and rent
    // exemption.
    let rent = Rent::get()?;
    let creator_key = *creator.address();
    let launch_bump = check_seeds(
        launch,
        &[LAUNCH_SEED, creator_key.as_ref(), launch_seed],
        LAUNCH,
    )?;
    let launch_bump_seed = [launch_bump];
    init(
        creator,
        launch,
        Launch::LEN,
        &rent,
        &[
            Seed::from(LAUNCH_SEED),
            Seed::from(creator_key.as_ref()),
            Seed::from(launch_seed),
            Seed::from(&launch_bump_seed),
        ],
        LAUNCH,
    )?;

    // [A] creator: mut. protocol: seeds = [PROTOCOL_SEED], bump =
    // protocol.bump. launch_authority: seeds = [AUTHORITY_SEED, launch],
    // bump. dbc_config: seeds = [DBC_CONFIG_SEED, launch], bump; mut.
    // quote_mint: address = WSOL_MINT @ AccountMismatch. hook_program,
    // dbc_program: address = .. @ AccountMismatch, executable.
    // dbc_event_authority: address = .. @ AccountMismatch.
    check_writable(creator, CREATOR)?;
    check_seeds_with_bump(protocol, &[PROTOCOL_SEED, &[protocol_state.bump]], PROTOCOL)?;
    let launch_key = *launch.address();
    let authority_bump = check_seeds(
        launch_authority,
        &[AUTHORITY_SEED, launch_key.as_ref()],
        LAUNCH_AUTHORITY,
    )?;
    let config_bump = check_seeds(
        dbc_config,
        &[DBC_CONFIG_SEED, launch_key.as_ref()],
        DBC_CONFIG,
    )?;
    check_writable(dbc_config, DBC_CONFIG)?;
    check_address_mismatch(quote_mint, &WSOL_MINT, QUOTE_MINT)?;
    check_program_address(hook_program, &hook::ID, HOOK_PROGRAM)?;
    check_program_address(dbc_program, &DBC_PROGRAM_ID, DBC_PROGRAM)?;
    check_address_mismatch(
        dbc_event_authority,
        &DBC_EVENT_AUTHORITY,
        DBC_EVENT_AUTHORITY_FIELD,
    )?;

    // Handler.
    let launch_authority_key = *launch_authority.address();
    let (batch_authority, batch_bump) =
        find_program_address(&[BATCH_SEED, launch_key.as_ref()], &crate::ID);
    let validated =
        policy::validate(&params, &[launch_authority_key, batch_authority]).map_err(raise_error)?;
    let params_hash = noised_onchain::hashv(&[params_bytes]);

    let config_bump_seed = [config_bump];
    dbc::create_config_with_transfer_hook(
        dbc_config,
        launch_authority,
        launch_authority,
        quote_mint,
        hook_program,
        creator,
        system_program,
        dbc_event_authority,
        dbc_program,
        &dbc::create_config_data(&params),
        &[Signer::from(&[
            Seed::from(DBC_CONFIG_SEED),
            Seed::from(launch_key.as_ref()),
            Seed::from(&config_bump_seed),
        ])],
    )?;
    if dbc_config.owner() != &DBC_PROGRAM_ID {
        return Err(fail_keys(
            LaunchpadError::UnsafeConfig.code(),
            None,
            dbc_config.owner(),
            &DBC_PROGRAM_ID,
        ));
    }

    // The launch, every field (the timeline, batch totals, base mint and
    // pool stay zero until `launch`).
    let mut state = LaunchData([0u8; Launch::LEN]);
    state.set(0, &discriminator::LAUNCH_ACCOUNT);
    state.set(
        at::VERSION,
        &[
            Launch::VERSION,
            launch_bump,
            authority_bump,
            batch_bump,
            config_bump,
            LaunchStatus::Configured as u8,
        ],
    );
    state.set(at::LAUNCH_SEED, launch_seed);
    state.set(at::CREATOR, creator_key.as_ref());
    state.set(at::DBC_CONFIG, dbc_config.address().as_ref());
    state.set(at::LAUNCH_AUTHORITY, launch_authority_key.as_ref());
    state.set(at::BATCH_AUTHORITY, batch_authority.as_ref());
    state.set(at::TREASURY, protocol_state.treasury.as_ref());
    state.set(
        at::PLATFORM_FEE_BPS,
        &protocol_state.platform_fee_bps.to_le_bytes(),
    );
    for (i, r) in validated.recipients.iter().enumerate() {
        let slot = at::RECIPIENTS + i * crate::state::FeeRecipient::LEN;
        state.set(slot, r.wallet.as_ref());
        state.set(slot + 32, &r.bps.to_le_bytes());
    }
    state.set(
        at::RECIPIENT_COUNT,
        &[validated.recipient_count, params.token_decimal],
    );
    state.set(
        at::MIGRATION_QUOTE_THRESHOLD,
        &params.migration_quote_threshold.to_le_bytes(),
    );
    state.set(at::MIGRATION_FEE_OPTION, &[params.migration_fee_option]);
    state.set(at::OPEN_DELAY_SECS, &params.open_delay_secs.to_le_bytes());
    state.set(at::GUARD_SECS, &params.guard_secs.to_le_bytes());
    state.set(at::MAX_WALLET_BPS, &params.max_wallet_bps.to_le_bytes());
    state.set(at::MAX_BUY_BPS, &params.max_buy_bps.to_le_bytes());
    state.set(at::P2P_LOCKED, &[u8::from(params.p2p_locked)]);
    state.set(at::BATCH_WALLET_CAP, &params.batch_wallet_cap.to_le_bytes());
    state.set(
        at::BATCH_TOTAL_CAP,
        &validated.batch_total_cap.to_le_bytes(),
    );
    state.set(at::PARAMS_HASH, &params_hash);
    state.set(at::PQ_IDENTITY, &params.pq_identity);

    LaunchCreated::log(
        &launch_key,
        &creator_key,
        dbc_config.address(),
        &params_hash,
        protocol_state.platform_fee_bps,
        &params.pq_identity,
    );

    // Exit.
    write_back_launch(launch, &state)
}

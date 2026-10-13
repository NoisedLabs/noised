//! `initialize_protocol(platform_fee_bps)`.

use noised_onchain::{
    accounts::is_missing, ids::BPF_LOADER_UPGRADEABLE_ID, owned_by, same, sysvar::Rent,
    AccountView, ProgramError, ProgramResult, Seed,
};

use crate::{
    constants::{MAX_PLATFORM_FEE_BPS, PROTOCOL_SEED, WSOL_MINT},
    error::{anchor::*, fail, fail_keys, raise_error, LaunchpadError},
    events::ProtocolInitialized,
    pq,
    processor::{
        check_seeds, check_writable, did_not_deserialize, init, log_instruction, require,
        require_named, write_back, Accounts, SYSTEM_PROGRAM,
    },
    state::Protocol,
    Pubkey,
};

const AUTHORITY: &str = "authority";
const PROTOCOL: &str = "protocol";
const TREASURY: &str = "treasury";
const PROGRAM: &str = "program";
const PROGRAM_DATA: &str = "program_data";

/// One-time init, gated on the program's upgrade authority so it cannot be
/// front-run. There is no instruction that changes `Protocol` afterwards.
///
/// The treasury must be an existing Noised PQ vault of wSOL: `distribute`
/// pays the platform share to its canonical wSOL ATA, the vault's own token
/// account, which only the vault's hash-based signature can move.
///
/// Accounts: authority (signer, writable), protocol (writable, PDA
/// `["protocol"]`, created), treasury, program (this program), program_data
/// (its program data account), system_program.
pub fn process(mut accounts: Accounts, args: &[u8]) -> ProgramResult {
    log_instruction("Instruction: InitializeProtocol");
    let Some(fee) = args.first_chunk::<2>() else {
        return Err(did_not_deserialize());
    };
    let platform_fee_bps = u16::from_le_bytes(*fee);

    let authority = accounts.signer(AUTHORITY)?;
    let protocol = accounts.init()?;
    let treasury = accounts.unchecked(TREASURY)?;
    let program = accounts.program(&crate::ID, PROGRAM)?;
    let program_data = accounts.unchecked(PROGRAM_DATA)?;
    let upgrade_authority = program_data_authority(program_data)?;
    accounts.program(&noised_onchain::ids::SYSTEM_PROGRAM_ID, SYSTEM_PROGRAM)?;

    // [A] protocol: init, payer = authority, space = 8 + Protocol::INIT_SPACE,
    // seeds = [PROTOCOL_SEED], bump; then mut and rent exemption.
    let rent = Rent::get()?;
    let bump = check_seeds(protocol, &[PROTOCOL_SEED], PROTOCOL)?;
    let bump_seed = [bump];
    init(
        authority,
        protocol,
        Protocol::LEN,
        &rent,
        &[Seed::from(PROTOCOL_SEED), Seed::from(&bump_seed)],
        PROTOCOL,
    )?;

    // [A] authority: mut. program: constraint = program.programdata_address()?
    // == Some(program_data.key()) @ NotUpgradeAuthority. program_data:
    // constraint = program_data.upgrade_authority_address ==
    // Some(authority.key()) @ NotUpgradeAuthority.
    check_writable(authority, AUTHORITY)?;
    require_named(
        programdata_address(program)?.is_some_and(|address| same(&address, program_data.address())),
        LaunchpadError::NotUpgradeAuthority,
        PROGRAM,
    )?;
    require_named(
        upgrade_authority.is_some_and(|key| same(&key, authority.address())),
        LaunchpadError::NotUpgradeAuthority,
        PROGRAM_DATA,
    )?;

    // Handler.
    let treasury_key = *treasury.address();
    require(
        platform_fee_bps <= MAX_PLATFORM_FEE_BPS
            && pq::is_vault_of(treasury, &WSOL_MINT).map_err(raise_error)?,
        LaunchpadError::InvalidProtocolParams,
    )?;
    let state = Protocol {
        version: Protocol::VERSION,
        bump,
        treasury: treasury_key,
        platform_fee_bps,
    };
    ProtocolInitialized::log(&treasury_key, platform_fee_bps);

    // Exit.
    let mut data = [0u8; Protocol::LEN];
    state.write(&mut data);
    write_back(protocol, PROTOCOL, &data)
}

/// `UpgradeableLoaderState` (bincode), as far as these checks need it.
enum LoaderState {
    Other,
    Program {
        programdata_address: Pubkey,
    },
    ProgramData {
        upgrade_authority_address: Option<Pubkey>,
    },
}

/// bincode's `UpgradeableLoaderState` from the start of `data` (trailing
/// bytes allowed); `None` when it does not decode.
fn loader_state(data: &[u8]) -> Option<LoaderState> {
    let (tag, rest) = data.split_first_chunk::<4>()?;
    let option_key = |data: &[u8]| -> Option<Option<Pubkey>> {
        match data.split_first()? {
            (0, _) => Some(None),
            (1, key) => Some(Some(Pubkey::new_from_array(*key.first_chunk::<32>()?))),
            _ => None,
        }
    };
    match u32::from_le_bytes(*tag) {
        // Uninitialized.
        0 => Some(LoaderState::Other),
        // Buffer { authority_address: Option<Pubkey> }.
        1 => option_key(rest).map(|_| LoaderState::Other),
        // Program { programdata_address: Pubkey }.
        2 => Some(LoaderState::Program {
            programdata_address: Pubkey::new_from_array(*rest.first_chunk::<32>()?),
        }),
        // ProgramData { slot: u64, upgrade_authority_address: Option<Pubkey> }.
        3 => option_key(rest.get(8..)?).map(|upgrade_authority_address| LoaderState::ProgramData {
            upgrade_authority_address,
        }),
        _ => None,
    }
}

/// [A] `Account<'info, ProgramData>`: exists (`AccountNotInitialized`),
/// owned by the upgradeable loader (`AccountOwnedByWrongProgram`, with both
/// keys), its state decodes (`InvalidAccountData`, a program error) and is
/// `ProgramData` (`AccountNotProgramData`). Returns its upgrade authority.
#[inline(never)]
fn program_data_authority(account: &AccountView) -> Result<Option<Pubkey>, ProgramError> {
    if is_missing(account) {
        return Err(fail(ACCOUNT_NOT_INITIALIZED, Some(PROGRAM_DATA)));
    }
    if !owned_by(account, &BPF_LOADER_UPGRADEABLE_ID) {
        return Err(fail_keys(
            ACCOUNT_OWNED_BY_WRONG_PROGRAM,
            Some(PROGRAM_DATA),
            account.owner(),
            &BPF_LOADER_UPGRADEABLE_ID,
        ));
    }
    let data = account.try_borrow()?;
    match loader_state(&data) {
        None => Err(ProgramError::InvalidAccountData),
        Some(LoaderState::ProgramData {
            upgrade_authority_address,
        }) => Ok(upgrade_authority_address),
        Some(_) => Err(fail(ACCOUNT_NOT_PROGRAM_DATA, Some(PROGRAM_DATA))),
    }
}

/// `Program::programdata_address()`: the program's data account when the
/// upgradeable loader owns it (its state must decode, `InvalidAccountData`
/// otherwise), else `None`. The program account of an upgradeable program is
/// always its `Program` state (Anchor: `unreachable!` otherwise; here
/// `InvalidAccountData`).
fn programdata_address(program: &AccountView) -> Result<Option<Pubkey>, ProgramError> {
    if !owned_by(program, &BPF_LOADER_UPGRADEABLE_ID) {
        return Ok(None);
    }
    let data = program.try_borrow()?;
    match loader_state(&data) {
        Some(LoaderState::Program {
            programdata_address,
        }) => Ok(Some(programdata_address)),
        _ => Err(ProgramError::InvalidAccountData),
    }
}

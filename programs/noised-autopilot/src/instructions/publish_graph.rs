use noised_onchain::{
    accounts::{check_mut, check_rent_exempt, is_missing, read_program_account},
    args::Reader,
    cpi::create_account_or_fund_allocate_assign,
    error::anchor::{
        ACCOUNT_DID_NOT_DESERIALIZE, ACCOUNT_DID_NOT_SERIALIZE, ACCOUNT_NOT_INITIALIZED,
        ACCOUNT_OWNED_BY_WRONG_PROGRAM, CONSTRAINT_OWNER, CONSTRAINT_RENT_EXEMPT, CONSTRAINT_SPACE,
        INSTRUCTION_DID_NOT_DESERIALIZE,
    },
    ids::SYSTEM_PROGRAM_ID,
    owned_by,
    pda::check_seeds,
    sys,
    sysvar::Rent,
};
use noised_rules::graph::{graph_hash, Graph};
use pinocchio::{
    cpi::{Seed, Signer},
    AccountView, ProgramResult,
};

use crate::processor::*;
use crate::{
    constants::*,
    error::{fail, fail_keys, fail_values, AutopilotError},
    events::GraphPublished,
    launchpad,
    state::GraphRecord,
    ProgramError, Pubkey, SolSha256, ID,
};

/// `publish_graph(bytes: Vec<u8>)` arguments (Borsh; trailing bytes
/// ignored), borrowed: `None` is `InstructionDidNotDeserialize`.
pub fn parse_args(data: &[u8]) -> Option<&[u8]> {
    Reader::new(data).bytes()
}

/// `SHA256("PHX-GRAPH-V1" || bytes)`.
pub fn hash_of(bytes: &[u8]) -> [u8; 32] {
    graph_hash::<SolSha256>(bytes)
}

/// Permissionless: write a PXG1 graph whole, after `Graph::verify`, at
/// `["graph", launch, graph_hash]`. The address is the content, so the
/// instruction is idempotent (a record already there holds exactly these
/// bytes) and nobody can put other bytes at an address an identity signed.
/// Publishing does nothing else: a graph runs only once the launch's
/// identity authorizes it (`activate`).
///
/// Arguments: `bytes: Vec<u8>`. Accounts (`PublishGraph`): payer (signer,
/// writable; pays the record's rent), launch (a launchpad `Launch`), graph
/// (writable, PDA `["graph", launch, hash_of(bytes)]`, created if needed),
/// system_program.
pub fn publish_graph(mut accounts: Accounts, data: &[u8]) -> ProgramResult {
    log_instruction("Instruction: PublishGraph");
    // [A] the arguments (`bytes: Vec<u8>`; `#[instruction(bytes: Vec<u8>)]`
    // decodes the same prefix again, with the same result).
    let Some(bytes) = parse_args(data) else {
        return Err(fail(INSTRUCTION_DID_NOT_DESERIALIZE, None));
    };

    let payer = accounts.signer(PAYER)?;
    let launch = accounts.unchecked(LAUNCH)?;
    let graph = accounts.next(None)?;
    accounts.program(&SYSTEM_PROGRAM_ID, SYSTEM_PROGRAM)?;

    // [A] graph: init_if_needed, payer = payer, space =
    // GraphRecord::space(bytes.len()), seeds = [GRAPH_SEED, launch.key(),
    // &hash_of(&bytes)], bump; then mut and rent exemption. A record already
    // there is loaded (its space, owner and rent checked) and kept.
    let rent = Rent::get()?;
    let hash = hash_of(bytes);
    let bump = check_seeds::<P>(
        graph,
        &[GRAPH_SEED, launch.address().as_ref(), &hash],
        &ID,
        GRAPH,
    )?;
    let bump_seed = [bump];
    let existing = init_graph(
        payer,
        graph,
        GraphRecord::space(bytes.len()),
        &rent,
        &[Signer::from(&[
            Seed::from(GRAPH_SEED),
            Seed::from(launch.address().as_ref()),
            Seed::from(&hash),
            Seed::from(&bump_seed),
        ])],
    )?;
    check_rent_exempt::<P>(graph, &rent, GRAPH)?;

    // [A] duplicate mutable accounts: graph is the only candidate. Then
    // payer: mut.
    check_mut::<P>(payer, PAYER)?;

    // Handler.
    launchpad::read_launch(launch)?;
    if let Err(e) = Graph::verify(bytes) {
        // msg!("PXG1: {}", e.name())
        log_pxg1_error(e.name());
        return err!(AutopilotError::InvalidGraph);
    }
    if let Some(record) = existing.filter(|r| r.version != 0) {
        // Exit: the record as it was.
        return write_record(graph, &record);
    }
    // `Graph::verify` bounds the length to 2,044 bytes.
    let len = bytes.len() as u16;
    let record_launch = *launch.address();
    GraphPublished {
        launch: record_launch,
        graph: *graph.address(),
        graph_hash: hash,
        len,
    }
    .emit();

    // Exit: the new record.
    write_fields(
        graph,
        GraphRecord::VERSION,
        bump,
        &record_launch,
        &hash,
        bytes,
    )
}

/// [A] `init_if_needed, payer = payer, space = space` of the graph record,
/// as `noised_onchain::accounts::init_if_needed_program_account` runs it: an
/// account still owned by the system program is created
/// (`create_account_or_fund_allocate_assign`, the PDA signing) and checked
/// as `Account::try_from_unchecked` does (errors name no account: 3012,
/// 3007 with keys, 3003); any other is loaded as `Account::try_from` does
/// (no account named) and must have exactly `space` bytes
/// (`ConstraintSpace`, with both values), be owned by the program
/// (`ConstraintOwner`, with both keys) and hold the rent-exempt minimum
/// (`ConstraintRentExempt`), each caused by `graph`. Then `mut`. Here so
/// that `ConstraintSpace`'s values are logged by `error::fail_values`.
fn init_graph(
    payer: &AccountView,
    graph: &AccountView,
    space: usize,
    rent: &Rent,
    signers: &[Signer],
) -> Result<Option<GraphRecord>, ProgramError> {
    let existing = if owned_by(graph, &SYSTEM_PROGRAM_ID) {
        create_account_or_fund_allocate_assign::<P>(payer, graph, space, &ID, rent, signers)?;
        if is_missing(graph) {
            return Err(fail(ACCOUNT_NOT_INITIALIZED, None));
        }
        if !owned_by(graph, &ID) {
            return Err(fail_keys(
                ACCOUNT_OWNED_BY_WRONG_PROGRAM,
                None,
                graph.owner(),
                &ID,
            ));
        }
        if graph.data_len() < space {
            return Err(fail(ACCOUNT_DID_NOT_DESERIALIZE, None));
        }
        None
    } else {
        let fields = read_program_account::<P, GraphRecord>(graph, None)?;
        if graph.data_len() != space {
            return Err(fail_values(
                CONSTRAINT_SPACE,
                Some(GRAPH),
                space as u64,
                graph.data_len() as u64,
            ));
        }
        if !owned_by(graph, &ID) {
            return Err(fail_keys(CONSTRAINT_OWNER, Some(GRAPH), graph.owner(), &ID));
        }
        if graph.lamports() < rent.minimum_balance(space) {
            return Err(fail(CONSTRAINT_RENT_EXEMPT, Some(GRAPH)));
        }
        Some(fields)
    };
    check_mut::<P>(graph, GRAPH)?;
    Ok(existing)
}

/// `msg!("PXG1: {}", name)`.
fn log_pxg1_error(name: &str) {
    let mut line = [0u8; 64];
    let mut len = 0;
    for byte in b"PXG1: ".iter().chain(name.as_bytes()) {
        if let Some(slot) = line.get_mut(len) {
            *slot = *byte;
            len += 1;
        }
    }
    sys::log_bytes(line.get(..len).unwrap_or(&[]));
}

/// [A] exit of `graph`: an existing record, serialized back as it was read.
fn write_record(graph: &AccountView, record: &GraphRecord) -> ProgramResult {
    write_fields(
        graph,
        record.version,
        record.bump,
        &record.launch,
        &record.graph_hash,
        &record.bytes,
    )
}

/// [A] exit of `graph`: the record serialized into its account
/// (`AccountDidNotSerialize` if it does not fit), unless the account was
/// closed (never).
fn write_fields(
    graph: &AccountView,
    version: u8,
    bump: u8,
    launch: &Pubkey,
    graph_hash: &[u8; 32],
    bytes: &[u8],
) -> ProgramResult {
    if owned_by(graph, &SYSTEM_PROGRAM_ID) && graph.is_data_empty() {
        return Ok(());
    }
    let mut handle = *graph;
    let mut data = handle.try_borrow_mut()?;
    if !GraphRecord::encode(&mut data, version, bump, launch, graph_hash, bytes) {
        return Err(fail(ACCOUNT_DID_NOT_SERIALIZE, Some(GRAPH)));
    }
    Ok(())
}

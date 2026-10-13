//! `publish_metadata(name, symbol, flags, uri, doc)`.

use noised_onchain::{args::Reader, sysvar::Rent, ProgramResult, Seed};

use crate::{
    constants::*,
    discriminator,
    error::raise_error,
    events::MetadataPublished,
    policy, pq,
    processor::{
        check_seeds, check_status, check_writable, did_not_deserialize, init_if_needed,
        log_instruction, write_back_parts, Accounts, PAYER, SYSTEM_PROGRAM,
    },
    state::{LaunchStatus, TokenMeta, TokenMetaRef},
};

const TOKEN_META: &str = "token_meta";

/// Whether an existing record decodes as a `TokenMeta` (Anchor's
/// `Account::try_from`).
fn decodes(data: &[u8]) -> bool {
    TokenMetaRef::read(data).is_some()
}

/// Permissionless: write a launch's metadata record (name, symbol, uri mode,
/// external uri and document) whole, at `["metadata", launch,
/// metadata_hash_v2(name, symbol, flags, uri, doc)]`. A client publishes it
/// (from the throwaway key that then sends `attest_launch`) and waits for
/// confirmation before it sends the attestation, which attests only a
/// record that exists.
///
/// The address is the content, so the instruction is idempotent: a record
/// already there holds exactly these bytes, and a retry or a racing relayer
/// succeeds without writing. An address pre-funded by anyone is taken over.
/// Records are never modified or closed. Anyone may publish any record under
/// a launch while it is configured; only the one its identity signs is ever
/// used.
///
/// Accounts: payer (signer, writable), launch, token_meta (writable, the
/// record's PDA, created if needed), system_program.
pub fn process(mut accounts: Accounts, args: &[u8]) -> ProgramResult {
    log_instruction("Instruction: PublishMetadata");
    let mut r = Reader::new(args);
    let decoded = (|| Some((r.str()?, r.str()?, r.u8()?, r.str()?, r.str()?)))();
    let Some((name, symbol, flags, uri, doc)) = decoded else {
        return Err(did_not_deserialize());
    };

    let payer = accounts.signer(PAYER)?;
    let (launch, launch_state) = accounts.launch()?;
    let token_meta = accounts.init()?;
    accounts.program(&noised_onchain::ids::SYSTEM_PROGRAM_ID, SYSTEM_PROGRAM)?;

    // [A] token_meta: init_if_needed, payer = payer, space =
    // TokenMeta::space(..), seeds = [METADATA_SEED, launch, metadata_hash_v2(
    // name, symbol, flags, uri, doc)], bump; then mut and rent exemption.
    let rent = Rent::get()?;
    let metadata_hash = pq::metadata_hash_v2(
        name.as_bytes(),
        symbol.as_bytes(),
        flags,
        uri.as_bytes(),
        doc.as_bytes(),
    );
    let launch_key = *launch.address();
    let bump = check_seeds(
        token_meta,
        &[METADATA_SEED, launch_key.as_ref(), &metadata_hash],
        TOKEN_META,
    )?;
    let bump_seed = [bump];
    let existed = init_if_needed(
        payer,
        token_meta,
        TokenMeta::space(name.len(), symbol.len(), uri.len(), doc.len()),
        &rent,
        &[
            Seed::from(METADATA_SEED),
            Seed::from(launch_key.as_ref()),
            Seed::from(&metadata_hash),
            Seed::from(&bump_seed),
        ],
        TOKEN_META,
        &discriminator::TOKEN_META,
        decodes,
    )?;

    // [A] payer: mut. launch: constraint = launch.status == Configured @
    // WrongLaunchState.
    check_writable(payer, PAYER)?;
    check_status(&launch_state, LaunchStatus::Configured)?;

    // Handler.
    policy::validate_metadata(name, symbol, flags, uri, doc).map_err(raise_error)?;
    if existed && token_meta.try_borrow()?.get(TokenMeta::VERSION_OFFSET) != Some(&0) {
        // Published already: the address is the hash of these bytes (and
        // writing the record back would not change a byte).
        return Ok(());
    }
    // Lengths within the policy's bounds (3,072 and 200).
    let (uri_len, doc_len) = (uri.len() as u16, doc.len() as u16);
    MetadataPublished::log(
        &launch_key,
        token_meta.address(),
        &metadata_hash,
        flags,
        uri_len,
        doc_len,
    );

    // Exit: the record, whole: discriminator, version, bump, flags, launch,
    // metadata hash, then the four strings in Borsh.
    let len = |s: &str| (s.len() as u32).to_le_bytes();
    write_back_parts(
        token_meta,
        TOKEN_META,
        &[
            &discriminator::TOKEN_META,
            &[TokenMeta::VERSION, bump, flags],
            launch_key.as_ref(),
            &metadata_hash,
            &len(name),
            name.as_bytes(),
            &len(symbol),
            symbol.as_bytes(),
            &len(uri),
            uri.as_bytes(),
            &len(doc),
            doc.as_bytes(),
        ],
    )
}

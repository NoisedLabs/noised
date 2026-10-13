//! `pq_authorize(lms_pk, lms_sig, kind, payload_hash)`.

use noised_lmots::{identity_id, LMS_PUBLIC_KEY_LEN};
use noised_onchain::{
    accounts::check_distinct,
    args::Reader,
    sysvar::{Clock, Rent},
    ProgramResult, Seed,
};

use crate::{
    constants::*,
    discriminator,
    error::raise_error,
    events::{Authorized, PqLeafConsumed},
    pq::{self, SolSha256},
    processor::{
        check_seeds, check_writable, did_not_deserialize, init_if_needed, log_instruction,
        write_back, write_back_parts, Accounts, IDENTITY, P, PAYER, SYSTEM_PROGRAM,
    },
    state::{launch_offsets as at, Authorization, Identity},
};

const AUTHORIZATION: &str = "authorization";

/// Whether an existing account decodes as an `Authorization` (its
/// signature's length prefix within the data).
fn decodes(data: &[u8]) -> bool {
    match data.get(157..161).and_then(|len| len.first_chunk::<4>()) {
        Some(len) => data.len() - Authorization::FIXED_LEN >= u32::from_le_bytes(*len) as usize,
        None => false,
    }
}

/// Permissionless: land an LMS signature by a post-quantum identity over a
/// launch's 140-byte authorization message (`pq::authorization_message`:
/// program, launch, creator, `kind`, `payload_hash`) and burn the one-time
/// leaf that signed it, in the same bitmap as its attestations
/// (`pq::burn_leaf`): any valid signature of an unused leaf lands.
///
/// It authorizes, writing `["auth", launch, [kind], payload_hash]` whole
/// (signature and message hash included, the time and slot from the clock),
/// only if its identity is the one the launch names, its `kind` is one the
/// autopilot reads (`AUTHORIZATION_KINDS`, 1 to 3) and nothing was written
/// there yet; every other valid signature (another identity, another kind,
/// a second signature of the same authorization) only burns its leaf. The
/// launchpad gives `payload_hash` no meaning: consumers (the autopilot)
/// read the account by layout and check what the payload stands for.
///
/// Every account but the fee payer is fixed by the signed data (the launch
/// by the message, the identity by the key, the authorization by the launch,
/// the kind and the payload), so whoever relays a signature can land it or
/// not, but cannot choose what it does.
///
/// Accounts: payer (signer, writable), launch, identity (writable, PDA
/// `["identity", SHA256(0x21 || lms_pk)]`, created if needed),
/// authorization (writable, PDA `["auth", launch, [kind], payload_hash]`,
/// created if needed), system_program.
pub fn process(mut accounts: Accounts, args: &[u8]) -> ProgramResult {
    log_instruction("Instruction: PqAuthorize");
    let mut r = Reader::new(args);
    let decoded = (|| {
        Some((
            r.array::<LMS_PUBLIC_KEY_LEN>()?,
            r.bytes()?,
            r.u8()?,
            *r.array::<32>()?,
        ))
    })();
    let Some((lms_pk, lms_sig, kind, payload_hash)) = decoded else {
        return Err(did_not_deserialize());
    };

    let payer = accounts.signer(PAYER)?;
    let (launch, launch_state) = accounts.launch()?;
    let identity = accounts.init()?;
    let authorization = accounts.init()?;
    accounts.program(&noised_onchain::ids::SYSTEM_PROGRAM_ID, SYSTEM_PROGRAM)?;

    // [A] identity: init_if_needed, payer = payer, space = 8 +
    // Identity::INIT_SPACE, seeds = [IDENTITY_SEED, identity_id(lms_pk)],
    // bump; authorization: init_if_needed, payer = payer, space = 8 +
    // Authorization::INIT_SPACE, seeds = [AUTH_SEED, launch, [kind],
    // payload_hash], bump; each then mut and rent exemption.
    let rent = Rent::get()?;
    let pq_identity = identity_id::<SolSha256>(lms_pk);
    let identity_bump = check_seeds(identity, &[IDENTITY_SEED, &pq_identity], IDENTITY)?;
    let identity_bump_seed = [identity_bump];
    init_if_needed(
        payer,
        identity,
        Identity::LEN,
        &rent,
        &[
            Seed::from(IDENTITY_SEED),
            Seed::from(&pq_identity),
            Seed::from(&identity_bump_seed),
        ],
        IDENTITY,
        &discriminator::IDENTITY,
        Identity::decodes,
    )?;
    let launch_key = *launch.address();
    let kind_seed = [kind];
    let authorization_bump = check_seeds(
        authorization,
        &[AUTH_SEED, launch_key.as_ref(), &kind_seed, &payload_hash],
        AUTHORIZATION,
    )?;
    let authorization_bump_seed = [authorization_bump];
    init_if_needed(
        payer,
        authorization,
        Authorization::LEN,
        &rent,
        &[
            Seed::from(AUTH_SEED),
            Seed::from(launch_key.as_ref()),
            Seed::from(&kind_seed),
            Seed::from(&payload_hash),
            Seed::from(&authorization_bump_seed),
        ],
        AUTHORIZATION,
        &discriminator::AUTHORIZATION,
        decodes,
    )?;

    // [A] duplicate mutable accounts: identity, authorization. payer: mut.
    check_distinct::<P>(&[(identity, IDENTITY), (authorization, AUTHORIZATION)])?;
    check_writable(payer, PAYER)?;

    // Handler.
    let message = pq::authorization_message(
        &crate::ID,
        &launch_key,
        &launch_state.key(at::CREATOR),
        kind,
        &payload_hash,
    );
    let mut identity_state = Identity::load(identity)?;
    let leaf = pq::burn_leaf(
        &mut identity_state,
        identity_bump,
        lms_pk,
        &message,
        lms_sig,
    )
    .map_err(raise_error)?;

    let now = Clock::get()?;
    // An authorization created now is all zero.
    let version = authorization.try_borrow()?.get(8).copied().unwrap_or(0);
    let authorizes = version == 0
        && pq_identity == launch_state.array32(at::PQ_IDENTITY)
        && AUTHORIZATION_KINDS.contains(&kind);
    if authorizes {
        Authorized::log(
            &launch_key,
            authorization.address(),
            &pq_identity,
            kind,
            &payload_hash,
            leaf,
            now.unix_timestamp,
            now.slot,
        );
    } else {
        PqLeafConsumed::log(&pq_identity, leaf, &launch_key);
    }

    // Exit: identity, then the authorization (written whole by the first
    // authorizing signature; otherwise as it was, all zero if created now).
    let mut identity_data = [0u8; Identity::LEN];
    identity_state.write(&mut identity_data);
    write_back(identity, IDENTITY, &identity_data)?;
    if authorizes {
        let message_hash = noised_onchain::hashv(&[&message]);
        write_back_parts(
            authorization,
            AUTHORIZATION,
            &[
                &discriminator::AUTHORIZATION,
                &[Authorization::VERSION, authorization_bump],
                launch_key.as_ref(),
                &pq_identity,
                &[kind],
                &payload_hash,
                &message_hash,
                &now.unix_timestamp.to_le_bytes(),
                &now.slot.to_le_bytes(),
                &leaf.to_le_bytes(),
                &(lms_sig.len() as u32).to_le_bytes(),
                lms_sig,
            ],
        )
    } else {
        write_back(authorization, AUTHORIZATION, &discriminator::AUTHORIZATION)
    }
}

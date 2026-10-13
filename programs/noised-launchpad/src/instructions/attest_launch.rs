//! `attest_launch(lms_pk, lms_sig, metadata_hash, rules_hash, not_before,
//! not_after)`.

use noised_lmots::{identity_id, LMS_PUBLIC_KEY_LEN};
use noised_onchain::{
    accounts::check_distinct,
    args::Reader,
    sysvar::{Clock, Rent},
    AccountView, ProgramResult, Seed,
};
use noised_rules::rules::NO_RULES_HASH;

use crate::{
    constants::*,
    discriminator,
    error::{anchor::CONSTRAINT_SEEDS, fail_keys, raise_error},
    events::{LaunchAttested, PqLeafConsumed},
    pq::{self, AttestedTerms, SolSha256},
    processor::{
        check_seeds, check_writable, did_not_deserialize, init_if_needed, log_instruction,
        write_back, write_back_parts, Accounts, IDENTITY, P, PAYER, SYSTEM_PROGRAM,
    },
    state::{launch_offsets as at, Attestation, Identity, LaunchStatus},
    Pubkey,
};

const ATTESTATION: &str = "attestation";
const TOKEN_META: &str = "token_meta";
const RULES: &str = "rules";

/// Whether an existing account decodes as an `Attestation` (its signature's
/// length prefix within the data).
pub fn attestation_decodes(data: &[u8]) -> bool {
    match data.get(196..200).and_then(|len| len.first_chunk::<4>()) {
        Some(len) => data.len() - Attestation::FIXED_LEN >= u32::from_le_bytes(*len) as usize,
        None => false,
    }
}

/// The record account is the one address the signed data names, else
/// Anchor's `ConstraintSeeds`, naming the account and both keys.
fn require_record(name: &'static str, given: &Pubkey, want: &Pubkey) -> ProgramResult {
    if given != want {
        return Err(fail_keys(CONSTRAINT_SEEDS, Some(name), given, want));
    }
    Ok(())
}

/// Permissionless: land an LMS signature by a post-quantum identity over a
/// launch's 221-byte message (`pq::attestation_message`: program, launch,
/// `params_hash`, creator, and the signed terms: the hashes of the metadata
/// record and of the creator rules `launch` will use, and the launch
/// window), and burn the one-time leaf that signed it.
///
/// The signature authorizes, not the fee payer: a client sends it from a
/// throwaway key in a v1 transaction, and anyone may relay it. Leaves are
/// one-time: two signatures from one leaf allow forgeries, so whatever an
/// identity has revealed must be landable to burn its leaf. A valid
/// signature over an existing launch's message at an unused leaf therefore
/// always executes with the accounts its message names, whatever it signed,
/// whatever the launch's status and whatever a third party did to those
/// accounts. The leaf burned is the signing identity's own (its account is
/// named by the key it sends).
///
/// Every account but the fee payer is fixed by the signed data (the launch
/// by the message, the identity by the key, the attestation by the launch,
/// the metadata record by the launch and the signed hash, the rules record
/// likewise, or none for the zero rules hash), and any other account fails
/// the transaction: whoever relays a signature can land it or not, but
/// cannot choose what it does.
///
/// A signature that attests the launch is written to `["attestation",
/// launch]`; `launch` requires it. It attests only if its identity is the
/// one the launch names, the metadata record its hash names exists
/// (`pq::is_metadata_record`: `publish_metadata` validated it), so does the
/// rules record its rules hash names unless that is zero
/// (`pq::is_rules_record`: `publish_rules` verified it), its window
/// leaves `launch` at least a minute when it lands
/// (`pq::launch_window_is_valid`), and the attestation is free: never
/// written, or written for a window that has passed while the launch is
/// still Configured (`launch` can never use it again). A replacement
/// rewrites every field, so nothing of the window that passed survives; an
/// attestation whose window has not ended, or of a Live launch, never
/// changes. Any other valid signature (another device, a retry, a client's
/// mistake, a record not published yet) only burns its leaf, and leaves the
/// attestation as it is. So no landing, however late or held back, fixes a
/// launch that cannot open: until it is Live, its identity can sign a new
/// window with any of its unused leaves.
///
/// Accounts: payer (signer, writable), launch, identity (writable, PDA
/// `["identity", SHA256(0x21 || lms_pk)]`, created if needed), attestation
/// (writable, PDA `["attestation", launch]`, created if needed), token_meta
/// (the record the signed metadata hash names), system_program, rules (the
/// record the signed rules hash names, or the program id for none).
pub fn process(mut accounts: Accounts, args: &[u8]) -> ProgramResult {
    log_instruction("Instruction: AttestLaunch");
    let mut r = Reader::new(args);
    let decoded = (|| {
        Some((
            r.array::<LMS_PUBLIC_KEY_LEN>()?,
            r.bytes()?,
            *r.array::<32>()?,
            *r.array::<32>()?,
            r.i64()?,
            r.i64()?,
        ))
    })();
    let Some((lms_pk, lms_sig, metadata_hash, rules_hash, not_before, not_after)) = decoded else {
        return Err(did_not_deserialize());
    };

    let payer = accounts.signer(PAYER)?;
    let (launch, launch_state) = accounts.launch()?;
    let identity = accounts.init()?;
    let attestation = accounts.init()?;
    let token_meta = accounts.unchecked(TOKEN_META)?;
    accounts.program(&noised_onchain::ids::SYSTEM_PROGRAM_ID, SYSTEM_PROGRAM)?;
    let rules = accounts.optional(Some(RULES))?;

    // [A] identity: init_if_needed, payer = payer, space = 8 +
    // Identity::INIT_SPACE, seeds = [IDENTITY_SEED, identity_id(lms_pk)],
    // bump; attestation: init_if_needed, payer = payer, space = 8 +
    // Attestation::INIT_SPACE, seeds = [ATTESTATION_SEED, launch], bump; each
    // then mut and rent exemption.
    let rent = Rent::get()?;
    // The signing identity; its account is `["identity", pq_identity]`.
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
    let attestation_bump = check_seeds(
        attestation,
        &[ATTESTATION_SEED, launch_key.as_ref()],
        ATTESTATION,
    )?;
    let attestation_bump_seed = [attestation_bump];
    init_if_needed(
        payer,
        attestation,
        Attestation::LEN,
        &rent,
        &[
            Seed::from(ATTESTATION_SEED),
            Seed::from(launch_key.as_ref()),
            Seed::from(&attestation_bump_seed),
        ],
        ATTESTATION,
        &discriminator::ATTESTATION,
        attestation_decodes,
    )?;

    // [A] duplicate mutable accounts: identity, attestation. payer: mut.
    check_distinct::<P>(&[(identity, IDENTITY), (attestation, ATTESTATION)])?;
    check_writable(payer, PAYER)?;

    // Handler.
    // The record account is the one address the signed hash names. Were it
    // free, whoever lands a signature could name another account and turn a
    // signature that attests into one that only burns its leaf, again at
    // every retry. Whatever is (or is not) at that address, the signature
    // still lands.
    let (record, record_bump) = pq::metadata_record_address(&launch_key, &metadata_hash);
    require_record(TOKEN_META, token_meta.address(), &record)?;
    // The rules record likewise: the one address the signed rules hash
    // names, or none (the program id in its place) for the zero hash.
    let rules_record =
        (rules_hash != NO_RULES_HASH).then(|| pq::rules_record_address(&launch_key, &rules_hash));
    let rules_key = rules.map_or(crate::ID, |r: &AccountView| *r.address());
    let rules_want = rules_record.map_or(crate::ID, |(address, _)| address);
    require_record(RULES, &rules_key, &rules_want)?;

    let terms = AttestedTerms {
        metadata_hash,
        rules_hash,
        not_before,
        not_after,
    };
    let message = pq::attestation_message(
        &crate::ID,
        &launch_key,
        &launch_state.array32(at::PARAMS_HASH),
        &launch_state.key(at::CREATOR),
        &terms,
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

    // The leaf is spent. Does this signature also attest the launch?
    let now = Clock::get()?;
    // Free: never attested, or attested for a window that ended while the
    // launch stayed Configured (`launch` runs only inside the stored window).
    // An attestation created now is all zero.
    let (stored_version, stored_launch, stored_not_after) = {
        let data = attestation.try_borrow()?;
        let fixed = data.first_chunk::<{ Attestation::FIXED_LEN }>();
        match fixed {
            Some(d) => (
                d[8],
                Pubkey::new_from_array(*d[10..].first_chunk::<32>().unwrap_or(&[0; 32])),
                i64::from_le_bytes(*d[188..].first_chunk::<8>().unwrap_or(&[0; 8])),
            ),
            None => (0, Pubkey::default(), 0),
        }
    };
    let slot_free = stored_launch == Pubkey::default()
        || (launch_state.status() == LaunchStatus::Configured as u8
            && now.unix_timestamp > stored_not_after);
    let attests = slot_free
        && pq_identity == launch_state.array32(at::PQ_IDENTITY)
        && pq::launch_window_is_valid(now.unix_timestamp, not_before, not_after)
        && pq::is_metadata_record(token_meta, &launch_key, &metadata_hash, record_bump)
        // No rules (the zero hash, with no account: checked above), or the
        // record the hash names.
        && match (rules, rules_record) {
            (Some(info), Some((_, bump))) => {
                pq::is_rules_record(info, &launch_key, &rules_hash, bump)
            }
            _ => true,
        };
    if attests {
        LaunchAttested::log(
            &launch_key,
            &pq_identity,
            leaf,
            &metadata_hash,
            &rules_hash,
            now.slot,
            not_before,
            not_after,
        );
    } else {
        // Attested and not replaceable (its window has not ended, or the
        // launch is Live), or a signature `launch` could not use (another
        // identity, no such metadata or rules record, a window without a
        // minute left): the attestation stays as it is and the leaf is
        // burned.
        PqLeafConsumed::log(&pq_identity, leaf, &launch_key);
    }

    // Exit: identity, then attestation.
    let mut identity_data = [0u8; Identity::LEN];
    identity_state.write(&mut identity_data);
    write_back(identity, IDENTITY, &identity_data)?;
    if attests {
        // Every field (the bump too): a replacement keeps nothing of the
        // attestation it replaces (the signature always has the same length).
        let message_hash = noised_onchain::hashv(&[&message]);
        write_back_parts(
            attestation,
            ATTESTATION,
            &[
                &discriminator::ATTESTATION,
                &[Attestation::VERSION, attestation_bump],
                launch_key.as_ref(),
                &pq_identity,
                &leaf.to_le_bytes(),
                &metadata_hash,
                &rules_hash,
                &message_hash,
                &now.slot.to_le_bytes(),
                &not_before.to_le_bytes(),
                &not_after.to_le_bytes(),
                &(lms_sig.len() as u32).to_le_bytes(),
                lms_sig,
            ],
        )
    } else {
        // The attestation as it was (all zero if created now), with the
        // address's bump, whatever lands first (`launch` checks the address
        // with it, so an empty attestation is refused as a mismatch).
        let mut head = [0u8; 10];
        head[..8].copy_from_slice(&discriminator::ATTESTATION);
        head[8] = stored_version;
        head[9] = attestation_bump;
        write_back(attestation, ATTESTATION, &head)
    }
}

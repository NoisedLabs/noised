use anchor_lang::prelude::*;
use noised_lmots::{identity_id, LMS_PUBLIC_KEY_LEN};
use noised_rules::rules::NO_RULES_HASH;

use crate::{
    constants::*,
    events::{LaunchAttested, PqLeafConsumed},
    pq::{self, AttestedTerms, SolSha256},
    state::{Attestation, Identity, Launch, LaunchStatus},
};

/// The error a record account other than the one the signed data names
/// gets: Anchor's `ConstraintSeeds`, naming the account and both keys.
fn wrong_record(name: &str, given: Pubkey, want: Pubkey) -> anchor_lang::error::Error {
    anchor_lang::error::Error::from(anchor_lang::error::ErrorCode::ConstraintSeeds)
        .with_account_name(name)
        .with_pubkeys((given, want))
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
pub fn handle_attest_launch(
    ctx: Context<AttestLaunch>,
    lms_pk: [u8; LMS_PUBLIC_KEY_LEN],
    lms_sig: Vec<u8>,
    metadata_hash: [u8; 32],
    rules_hash: [u8; 32],
    not_before: i64,
    not_after: i64,
) -> Result<()> {
    let launch = &ctx.accounts.launch;
    let launch_key = launch.key();
    // The record account is the one address the signed hash names. Were it
    // free, whoever lands a signature could name another account and turn a
    // signature that attests into one that only burns its leaf, again at
    // every retry. Whatever is (or is not) at that address, the signature
    // still lands.
    let (record, record_bump) = pq::metadata_record_address(&launch_key, &metadata_hash);
    let token_meta_key = ctx.accounts.token_meta.key();
    if token_meta_key != record {
        return Err(wrong_record("token_meta", token_meta_key, record));
    }
    // The rules record likewise: the one address the signed rules hash
    // names, or none (the program id in its place) for the zero hash.
    let rules_record =
        (rules_hash != NO_RULES_HASH).then(|| pq::rules_record_address(&launch_key, &rules_hash));
    let rules = ctx.accounts.rules.as_ref();
    let rules_key = rules.map_or(crate::ID, |r| r.key());
    let rules_want = rules_record.map_or(crate::ID, |(address, _)| address);
    if rules_key != rules_want {
        return Err(wrong_record("rules", rules_key, rules_want));
    }
    // The signing identity; its account is `["identity", pq_identity]`.
    let pq_identity = identity_id::<SolSha256>(&lms_pk);

    let terms = AttestedTerms {
        metadata_hash,
        rules_hash,
        not_before,
        not_after,
    };
    let message = pq::attestation_message(
        &crate::ID,
        &launch_key,
        &launch.params_hash,
        &launch.creator,
        &terms,
    );
    let leaf = pq::burn_leaf(
        &mut ctx.accounts.identity,
        ctx.bumps.identity,
        &lms_pk,
        &message,
        &lms_sig,
    )?;

    // The leaf is spent. Does this signature also attest the launch?
    let now = Clock::get()?;
    let attestation = &mut ctx.accounts.attestation;
    // The address's bump, whatever lands first (`launch` checks the address
    // with it, so an empty attestation is refused as a mismatch).
    attestation.bump = ctx.bumps.attestation;
    // Free: never attested, or attested for a window that ended while the
    // launch stayed Configured (`launch` runs only inside the stored window).
    let slot_free = attestation.launch == Pubkey::default()
        || (launch.status == LaunchStatus::Configured
            && now.unix_timestamp > attestation.not_after);
    let attests = slot_free
        && pq_identity == launch.pq_identity
        && pq::launch_window_is_valid(now.unix_timestamp, not_before, not_after)
        && pq::is_metadata_record(
            &ctx.accounts.token_meta,
            &launch_key,
            &metadata_hash,
            record_bump,
        )
        // No rules (the zero hash, with no account: checked above), or the
        // record the hash names.
        && match (rules, rules_record) {
            (Some(info), Some((_, bump))) => {
                pq::is_rules_record(info, &launch_key, &rules_hash, bump)
            }
            _ => true,
        };
    if attests {
        // Every field (the bump above): a replacement keeps nothing of the
        // attestation it replaces (the signature always has the same length).
        attestation.version = Attestation::VERSION;
        attestation.launch = launch_key;
        attestation.pq_identity = pq_identity;
        attestation.leaf = leaf;
        attestation.metadata_hash = metadata_hash;
        attestation.rules_hash = rules_hash;
        attestation.message_hash = solana_sha256_hasher::hash(&message).to_bytes();
        attestation.slot = now.slot;
        attestation.not_before = not_before;
        attestation.not_after = not_after;
        attestation.signature = lms_sig;
        emit!(LaunchAttested {
            launch: launch_key,
            pq_identity,
            leaf,
            metadata_hash,
            rules_hash,
            slot: now.slot,
            not_before,
            not_after,
        });
    } else {
        // Attested and not replaceable (its window has not ended, or the
        // launch is Live), or a signature `launch` could not use (another
        // identity, no such metadata or rules record, a window without a
        // minute left): the attestation stays as it is and the leaf is
        // burned.
        emit!(PqLeafConsumed {
            pq_identity,
            leaf,
            launch: launch_key,
        });
    }
    Ok(())
}

#[derive(Accounts)]
#[instruction(lms_pk: [u8; LMS_PUBLIC_KEY_LEN])]
pub struct AttestLaunch<'info> {
    /// Anyone (in practice a throwaway key): pays the fee and, the first
    /// time, the rent of the identity and attestation accounts.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Any launch, in any status: a signature over its message stays
    /// landable forever.
    pub launch: Box<Account<'info, Launch>>,

    /// The signing identity, `["identity", SHA256(0x21 || lms_pk)]`: created
    /// by the first of its signatures that lands (an account pre-funded by
    /// anyone is taken over).
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + Identity::INIT_SPACE,
        seeds = &[IDENTITY_SEED, &identity_id::<SolSha256>(&lms_pk)],
        bump,
    )]
    pub identity: Box<Account<'info, Identity>>,

    /// Written by an attesting signature: the first, or one replacing an
    /// attestation whose window ended while the launch was Configured.
    /// Never changes once the launch is Live.
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + Attestation::INIT_SPACE,
        seeds = [ATTESTATION_SEED, launch.key().as_ref()],
        bump,
    )]
    pub attestation: Box<Account<'info, Attestation>>,

    /// CHECK: the metadata record the signed hash names, `["metadata",
    /// launch, metadata_hash]`: the handler refuses any other address
    /// (`ConstraintSeeds`). Its content is unchecked, so that a valid
    /// signature lands whatever is (or is not) at this address; the handler
    /// attests only if it is that record (`pq::is_metadata_record`).
    pub token_meta: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,

    /// CHECK: the rules record the signed rules hash names, `["rules",
    /// launch, rules_hash]`, or none (the program id) for the zero hash: the
    /// handler refuses anything else (`ConstraintSeeds`). Its content is
    /// unchecked, as for `token_meta`; the handler attests only if it is
    /// that record (`pq::is_rules_record`).
    pub rules: Option<UncheckedAccount<'info>>,
}

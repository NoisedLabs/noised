use anchor_lang::prelude::*;
use noised_lmots::{identity_id, LMS_PUBLIC_KEY_LEN};

use crate::{
    constants::*,
    events::{Authorized, PqLeafConsumed},
    pq::{self, SolSha256},
    state::{Authorization, Identity, Launch},
};

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
pub fn handle_pq_authorize(
    ctx: Context<PqAuthorize>,
    lms_pk: [u8; LMS_PUBLIC_KEY_LEN],
    lms_sig: Vec<u8>,
    kind: u8,
    payload_hash: [u8; 32],
) -> Result<()> {
    let launch = &ctx.accounts.launch;
    let launch_key = launch.key();
    let pq_identity = identity_id::<SolSha256>(&lms_pk);
    let message = pq::authorization_message(
        &crate::ID,
        &launch_key,
        &launch.creator,
        kind,
        &payload_hash,
    );
    let leaf = pq::burn_leaf(
        &mut ctx.accounts.identity,
        ctx.bumps.identity,
        &lms_pk,
        &message,
        &lms_sig,
    )?;

    let now = Clock::get()?;
    let authorization_key = ctx.accounts.authorization.key();
    let auth = &mut ctx.accounts.authorization;
    if auth.version == 0 && pq_identity == launch.pq_identity && AUTHORIZATION_KINDS.contains(&kind)
    {
        auth.version = Authorization::VERSION;
        auth.bump = ctx.bumps.authorization;
        auth.launch = launch_key;
        auth.pq_identity = pq_identity;
        auth.kind = kind;
        auth.payload_hash = payload_hash;
        auth.message_hash = solana_sha256_hasher::hash(&message).to_bytes();
        auth.unix_time = now.unix_timestamp;
        auth.slot = now.slot;
        auth.leaf = leaf;
        auth.signature = lms_sig;
        emit!(Authorized {
            launch: launch_key,
            authorization: authorization_key,
            pq_identity,
            kind,
            payload_hash,
            leaf,
            unix_time: now.unix_timestamp,
            slot: now.slot,
        });
    } else {
        emit!(PqLeafConsumed {
            pq_identity,
            leaf,
            launch: launch_key,
        });
    }
    Ok(())
}

#[derive(Accounts)]
#[instruction(lms_pk: [u8; LMS_PUBLIC_KEY_LEN], lms_sig: Vec<u8>, kind: u8, payload_hash: [u8; 32])]
pub struct PqAuthorize<'info> {
    /// Anyone (in practice a throwaway key): pays the fee and, the first
    /// time, the rent of the identity and authorization accounts.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Any launch, in any status: a signature over its message stays
    /// landable forever.
    pub launch: Box<Account<'info, Launch>>,

    /// The signing identity, `["identity", SHA256(0x21 || lms_pk)]`, shared
    /// with `attest_launch`: created by the first of its signatures that
    /// lands (an account pre-funded by anyone is taken over).
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + Identity::INIT_SPACE,
        seeds = &[IDENTITY_SEED, &identity_id::<SolSha256>(&lms_pk)],
        bump,
    )]
    pub identity: Box<Account<'info, Identity>>,

    /// Written whole by the first authorizing signature; never changes.
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + Authorization::INIT_SPACE,
        seeds = [AUTH_SEED, launch.key().as_ref(), &[kind], payload_hash.as_ref()],
        bump,
    )]
    pub authorization: Box<Account<'info, Authorization>>,

    pub system_program: Program<'info, System>,
}

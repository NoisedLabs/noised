//! Noised launchpad: token launches on Meteora's Dynamic Bonding Curve, each
//! one signed by its creator's post-quantum identity, that no key (the
//! creator's included) can rug.
//!
//! * `create_launch` validates the creator's parameters against a fixed
//!   safety policy and creates the DBC transfer-hook config itself, so every
//!   field that could hide a rug (mint/freeze authority, LP, vesting,
//!   migration fees, metadata authority) is fixed by the program. The
//!   parameters name the creator's post-quantum identity (`pq_identity`).
//! * The token's metadata (name, symbol, uri mode and a document with its
//!   description and icon) is an on-chain record, `publish_metadata`, at the
//!   address its content hashes to: no link to hosting it depends on.
//! * The creator may add launch rules (PXR1: time tiers, anti-bot, caps,
//!   wallet and program lists) for the Launch Guard period, also an on-chain
//!   record at the address its content hashes to (`publish_rules`). The
//!   hook evaluates them after every built-in allow and denial: they can
//!   only refuse, never a sell, a claim, the batch or anything after the
//!   guard.
//! * `attest_launch` verifies, on-chain, a hash-based LMS signature (RFC 8554)
//!   by that identity over the launch's configuration, metadata record,
//!   rules record and launch window, and burns the one-time leaf that signed it (any valid
//!   signature lands, to burn its leaf). `launch` refuses to run without that
//!   attestation or outside its window, and inside the window anyone may run
//!   it: a quantum computer that forges the creator's Ed25519 signature still
//!   cannot launch anything the identity did not sign, nor choose when.
//! * Every DBC role (pool creator, partner/fee claimer, leftover receiver, LP
//!   owner) is a PDA of this program. No private key controls a launch.
//! * `launch` creates the pool and mint from the attested record, installs
//!   the Launch Guard hook policy (with the attested rules) and only then
//!   writes a certificate whose flags come from re-reading the live mint (its
//!   metadata included), DBC config, pool and policy, and the attestation.
//! * `pq_authorize` lands generic authorizations by the same identity (the
//!   same leaf bitmap), kept in full on-chain: the autopilot's graph
//!   changes need them.
//! * A fair-open batch replaces the race at the open: commits are pooled and
//!   bought in one swap, then paid out pro rata to payout owners fixed at the
//!   first commit (the committer or its PQ vaults; what a vault receives is
//!   held to one wallet's cap). Once the batch has bought, `execute_batch`
//!   ends the hook's snipe shield, so trading opens at once.
//! * Fees route by immutable rules (platform share to a PQ vault treasury,
//!   then the creator's recipients); LP fees paid in the launched token are
//!   burned.
//!
//! There is no admin, no pause and no instruction that changes a launch's
//! fee recipients, hook policy or DBC config after creation. The one change
//! to a hook policy is `execute_batch` ending its snipe shield early, at the
//! batch; the hook only ever lets that end move earlier.

use anchor_lang::prelude::*;

pub mod base64;
pub mod checks;
pub mod constants;
pub mod dbc_params;
pub mod error;
pub mod events;
pub mod hook_accounts;
pub mod instructions;
pub mod math;
pub mod policy;
pub mod pq;
pub mod state;
pub mod token_util;

#[cfg(test)]
mod tests;

use instructions::*;
use state::LaunchParams;

declare_id!("CfbRmsFpevhiXkbYK48orBDugdKznnezDiVekjAAbNgc");

declare_program!(dynamic_bonding_curve);
declare_program!(cp_amm);

#[program]
pub mod noised_launchpad {
    use super::*;

    /// One-time: set the treasury (a wSOL PQ vault) and platform fee share.
    /// Upgrade authority only.
    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        platform_fee_bps: u16,
    ) -> Result<()> {
        instructions::initialize_protocol::handle_initialize_protocol(ctx, platform_fee_bps)
    }

    /// Validate `params` and create the launch's DBC transfer-hook config.
    pub fn create_launch(
        ctx: Context<CreateLaunch>,
        launch_seed: [u8; 32],
        params: LaunchParams,
    ) -> Result<()> {
        instructions::create_launch::handle_create_launch(ctx, launch_seed, params)
    }

    /// Write a launch's metadata record whole, at the address its content
    /// hashes to (permissionless, idempotent, while the launch is
    /// configured).
    pub fn publish_metadata(
        ctx: Context<PublishMetadata>,
        name: String,
        symbol: String,
        flags: u8,
        uri: String,
        doc: String,
    ) -> Result<()> {
        instructions::publish_metadata::handle_publish_metadata(ctx, name, symbol, flags, uri, doc)
    }

    /// Write a launch's creator rules (PXR1) whole, at the address their
    /// bytes hash to, once they verify for its guard (permissionless,
    /// idempotent, while the launch is configured).
    pub fn publish_rules(ctx: Context<PublishRules>, bytes: Vec<u8>) -> Result<()> {
        instructions::publish_rules::handle_publish_rules(ctx, bytes)
    }

    /// Land an LMS signature by a post-quantum identity over a launch's
    /// configuration, metadata record (`metadata_hash`), creator rules
    /// (`rules_hash`, zero for none) and launch window, burning its leaf;
    /// the first by the launch's identity that `launch` can use attests it,
    /// and so does a later one once the attested window has ended while the
    /// launch is still Configured (permissionless; the signature
    /// authorizes).
    pub fn attest_launch(
        ctx: Context<AttestLaunch>,
        lms_pk: [u8; 56],
        lms_sig: Vec<u8>,
        metadata_hash: [u8; 32],
        rules_hash: [u8; 32],
        not_before: i64,
        not_after: i64,
    ) -> Result<()> {
        instructions::attest_launch::handle_attest_launch(
            ctx,
            lms_pk,
            lms_sig,
            metadata_hash,
            rules_hash,
            not_before,
            not_after,
        )
    }

    /// Land an LMS signature by a post-quantum identity authorizing `kind`
    /// over `payload_hash` for a launch, burning its leaf; the first by the
    /// launch's identity writes the `Authorization` (permissionless; the
    /// signature authorizes).
    pub fn pq_authorize(
        ctx: Context<PqAuthorize>,
        lms_pk: [u8; 56],
        lms_sig: Vec<u8>,
        kind: u8,
        payload_hash: [u8; 32],
    ) -> Result<()> {
        instructions::pq_authorize::handle_pq_authorize(ctx, lms_pk, lms_sig, kind, payload_hash)
    }

    /// Create the pool and mint from the attested metadata record, install
    /// the hook policy with the attested rules, write the certificate
    /// (permissionless, inside the attested launch window).
    pub fn launch(ctx: Context<LaunchToken>) -> Result<()> {
        instructions::launch::handle_launch(ctx)
    }

    /// Commit wSOL to the fair-open batch.
    pub fn commit(ctx: Context<CommitToBatch>, amount: u64) -> Result<()> {
        instructions::commit::handle_commit(ctx, amount)
    }

    /// Execute the batch buy (permissionless, once, in the execution window).
    pub fn execute_batch<'info>(ctx: Context<'info, ExecuteBatch<'info>>) -> Result<()> {
        instructions::execute_batch::handle_execute_batch(ctx)
    }

    /// Pay out one commit (permissionless; funds go only to the commit's
    /// recorded payout owners).
    pub fn claim<'info>(ctx: Context<'info, Claim<'info>>, owner: Pubkey) -> Result<()> {
        instructions::claim::handle_claim(ctx, owner)
    }

    /// Claim DBC partner trading fees into the launch authority (permissionless).
    pub fn claim_fees(ctx: Context<ClaimFees>) -> Result<()> {
        instructions::claim_fees::handle_claim_fees(ctx)
    }

    /// Withdraw DBC partner and creator surplus after the curve completes (permissionless).
    pub fn claim_surplus(ctx: Context<ClaimSurplus>) -> Result<()> {
        instructions::claim_fees::handle_claim_surplus(ctx)
    }

    /// Claim DAMM v2 LP position fees after migration (permissionless).
    pub fn claim_lp_fees(ctx: Context<ClaimLpFees>) -> Result<()> {
        instructions::claim_lp_fees::handle_claim_lp_fees(ctx)
    }

    /// Route collected wSOL fees and burn collected base tokens (permissionless).
    pub fn distribute<'info>(ctx: Context<'info, Distribute<'info>>) -> Result<()> {
        instructions::distribute::handle_distribute(ctx)
    }
}

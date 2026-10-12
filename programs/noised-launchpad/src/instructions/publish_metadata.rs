use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::LaunchpadError,
    events::MetadataPublished,
    policy, pq,
    state::{Launch, LaunchStatus, TokenMeta},
};

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
pub fn handle_publish_metadata(
    ctx: Context<PublishMetadata>,
    name: String,
    symbol: String,
    flags: u8,
    uri: String,
    doc: String,
) -> Result<()> {
    policy::validate_metadata(&name, &symbol, flags, &uri, &doc)?;
    let launch_key = ctx.accounts.launch.key();
    let token_meta_key = ctx.accounts.token_meta.key();
    let token_meta = &mut ctx.accounts.token_meta;
    if token_meta.version != 0 {
        // Published already: the address is the hash of these bytes.
        return Ok(());
    }
    let metadata_hash = pq::metadata_hash_v2(
        name.as_bytes(),
        symbol.as_bytes(),
        flags,
        uri.as_bytes(),
        doc.as_bytes(),
    );
    // Lengths within the policy's bounds (3,072 and 200).
    let (uri_len, doc_len) = (uri.len() as u16, doc.len() as u16);
    token_meta.version = TokenMeta::VERSION;
    token_meta.bump = ctx.bumps.token_meta;
    token_meta.flags = flags;
    token_meta.launch = launch_key;
    token_meta.metadata_hash = metadata_hash;
    token_meta.name = name;
    token_meta.symbol = symbol;
    token_meta.uri = uri;
    token_meta.doc = doc;
    emit!(MetadataPublished {
        launch: launch_key,
        token_meta: token_meta_key,
        metadata_hash,
        flags,
        uri_len,
        doc_len,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(name: String, symbol: String, flags: u8, uri: String, doc: String)]
pub struct PublishMetadata<'info> {
    /// Anyone (in practice the throwaway key of the attestation): pays the
    /// fee and the record's rent.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// The launch the record is for; records are published before it goes
    /// live.
    #[account(
        constraint = launch.status == LaunchStatus::Configured @ LaunchpadError::WrongLaunchState,
    )]
    pub launch: Box<Account<'info, Launch>>,

    /// The record, at the address its content hashes to: created whole here
    /// (an account pre-funded by anyone is taken over), or already there
    /// with exactly this content.
    #[account(
        init_if_needed,
        payer = payer,
        space = TokenMeta::space(name.len(), symbol.len(), uri.len(), doc.len()),
        seeds = [
            METADATA_SEED,
            launch.key().as_ref(),
            &pq::metadata_hash_v2(
                name.as_bytes(),
                symbol.as_bytes(),
                flags,
                uri.as_bytes(),
                doc.as_bytes(),
            ),
        ],
        bump,
    )]
    pub token_meta: Box<Account<'info, TokenMeta>>,

    pub system_program: Program<'info, System>,
}

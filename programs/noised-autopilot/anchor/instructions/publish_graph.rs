use anchor_lang::prelude::*;
use noised_rules::graph::{graph_hash, Graph};

use crate::{
    constants::*, error::AutopilotError, events::GraphPublished, launchpad, state::GraphRecord,
    SolSha256,
};

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
pub fn handle_publish_graph(ctx: Context<PublishGraph>, bytes: Vec<u8>) -> Result<()> {
    launchpad::read_launch(&ctx.accounts.launch)?;
    if let Err(e) = Graph::verify(&bytes) {
        msg!("PXG1: {}", e.name());
        return err!(AutopilotError::InvalidGraph);
    }
    let record_key = ctx.accounts.graph.key();
    let record = &mut ctx.accounts.graph;
    if record.version != 0 {
        return Ok(());
    }
    let hash = hash_of(&bytes);
    // `Graph::verify` bounds the length to 2,044 bytes.
    let len = bytes.len() as u16;
    record.version = GraphRecord::VERSION;
    record.bump = ctx.bumps.graph;
    record.launch = ctx.accounts.launch.key();
    record.graph_hash = hash;
    record.bytes = bytes;
    emit!(GraphPublished {
        launch: record.launch,
        graph: record_key,
        graph_hash: hash,
        len,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(bytes: Vec<u8>)]
pub struct PublishGraph<'info> {
    /// Anyone: pays the record's rent.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: a launchpad `Launch`, read by layout.
    pub launch: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = payer,
        space = GraphRecord::space(bytes.len()),
        seeds = [GRAPH_SEED, launch.key().as_ref(), &hash_of(&bytes)],
        bump,
    )]
    pub graph: Box<Account<'info, GraphRecord>>,

    pub system_program: Program<'info, System>,
}

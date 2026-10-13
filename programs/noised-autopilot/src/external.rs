//! Meteora accounts read by layout: a launch's DBC hook config (its migration
//! price, read once at `init_autopilot`), the DAMM v2 config DBC migrated it
//! through (`bind_pool`) and its DAMM v2 pool (the pool price, the vaults a
//! buyback swaps through). Offsets are pinned against the IDL types the
//! launchpad generates (`tests`).

use crate::{
    constants::{
        DAMM_V2_POOL_SEED, DAMM_V2_PROGRAM_ID, DBC_POOL_AUTHORITY, DBC_PROGRAM_ID, WSOL_MINT,
    },
    error::AutopilotError,
    launchpad::{bytes32, read_u128},
    ProgramError, Pubkey, Result,
};

/// DBC `ConfigWithTransferHook` (zero-copy, 1,128 bytes): the config the
/// launchpad creates for every launch, a `PoolConfig` followed by the hook
/// program.
pub mod dbc_config {
    pub const DISCRIMINATOR: [u8; 8] = [40, 220, 194, 251, 41, 199, 123, 253];
    pub const LEN: usize = 1_128;
    pub const QUOTE_MINT_OFFSET: usize = 8;
    pub const MIGRATION_SQRT_PRICE_OFFSET: usize = 280;
}

/// DAMM v2 `Config` (zero-copy, 328 bytes): a pool configuration Meteora's
/// admin creates; only its `pool_creator_authority` (when set) can create a
/// pool with it.
pub mod damm_config {
    pub const DISCRIMINATOR: [u8; 8] = [155, 12, 170, 224, 30, 250, 204, 130];
    pub const LEN: usize = 328;
    pub const POOL_CREATOR_AUTHORITY_OFFSET: usize = 40;
}

/// DAMM v2 `Pool` (zero-copy, 1,112 bytes).
pub mod damm_pool {
    pub const DISCRIMINATOR: [u8; 8] = [241, 154, 109, 4, 17, 177, 109, 188];
    pub const LEN: usize = 1_112;
    pub const TOKEN_A_MINT_OFFSET: usize = 168;
    pub const TOKEN_B_MINT_OFFSET: usize = 200;
    pub const TOKEN_A_VAULT_OFFSET: usize = 232;
    pub const TOKEN_B_VAULT_OFFSET: usize = 264;
    pub const SQRT_PRICE_OFFSET: usize = 456;
}

/// DAMM v2 `swap` (exact in): `sha256("global:swap")[..8]`, then
/// `SwapParameters { amount_in: u64, minimum_amount_out: u64 }`.
pub const DAMM_SWAP_DISCRIMINATOR: [u8; 8] = [248, 198, 158, 145, 225, 117, 135, 200];

/// The migration sqrt price (Q64.64) of a launch's DBC config: the price DBC
/// opens the DAMM v2 pool at. Fixed at `create_launch`, so nobody can move
/// it; it seeds the reference price.
pub fn migration_sqrt_price(owner: &Pubkey, data: &[u8]) -> Result<u128, ProgramError> {
    require_keys_eq!(*owner, DBC_PROGRAM_ID, AutopilotError::InvalidDbcConfig);
    require!(
        data.len() == dbc_config::LEN && data[..8] == dbc_config::DISCRIMINATOR,
        AutopilotError::InvalidDbcConfig
    );
    require!(
        bytes32(data, dbc_config::QUOTE_MINT_OFFSET)? == WSOL_MINT.to_bytes(),
        AutopilotError::InvalidDbcConfig
    );
    let price = read_u128(data, dbc_config::MIGRATION_SQRT_PRICE_OFFSET)?;
    require!(price > 0, AutopilotError::InvalidDbcConfig);
    Ok(price)
}

/// Check that a DAMM v2 config is one DBC migrates through: owned by DAMM
/// v2, a `Config`, whose pool creator authority is DBC's pool authority. DBC
/// signs as that authority only when it migrates a curve, so a pool of such
/// a config holding `(mint, wSOL)` is the pool DBC created for the curve of
/// `mint`: the launch's, whose LP is locked.
pub fn check_migration_config(owner: &Pubkey, data: &[u8]) -> Result<(), ProgramError> {
    require_keys_eq!(
        *owner,
        DAMM_V2_PROGRAM_ID,
        AutopilotError::InvalidDammConfig
    );
    require!(
        data.len() == damm_config::LEN && data[..8] == damm_config::DISCRIMINATOR,
        AutopilotError::InvalidDammConfig
    );
    require!(
        bytes32(data, damm_config::POOL_CREATOR_AUTHORITY_OFFSET)? == DBC_POOL_AUTHORITY.to_bytes(),
        AutopilotError::InvalidDammConfig
    );
    Ok(())
}

/// The address of the DAMM v2 pool of `(mint, wSOL)` under `config`:
/// `["pool", config, max(mint, wSOL), min(mint, wSOL)]`.
pub fn pool_address(config: &Pubkey, mint: &Pubkey) -> Pubkey {
    let (hi, lo) = if *mint > WSOL_MINT {
        (*mint, WSOL_MINT)
    } else {
        (WSOL_MINT, *mint)
    };
    noised_onchain::pda::find_program_address(
        &[DAMM_V2_POOL_SEED, config.as_ref(), hi.as_ref(), lo.as_ref()],
        &DAMM_V2_PROGRAM_ID,
    )
    .0
}

/// The pool's state, once it exists.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PoolView {
    pub sqrt_price: u128,
    pub token_a_vault: Pubkey,
    pub token_b_vault: Pubkey,
}

/// `None` while the pool does not exist (the launch has not graduated);
/// otherwise the pool, which must trade exactly (mint, wSOL) as (A, B).
/// Its error is not logged until it leaves the instruction: `run` drops it
/// for actions that do not trade (Anchor logged an error only then too).
pub fn read_pool(owner: &Pubkey, data: &[u8], mint: &Pubkey) -> Result<Option<PoolView>> {
    if *owner != DAMM_V2_PROGRAM_ID {
        // Only DAMM v2 can create an account at the pool's address; until
        // migration it is empty (at most someone's lamports).
        require!(data.is_empty(), AutopilotError::InvalidPool);
        return Ok(None);
    }
    require!(
        data.len() == damm_pool::LEN && data[..8] == damm_pool::DISCRIMINATOR,
        AutopilotError::InvalidPool
    );
    require!(
        bytes32(data, damm_pool::TOKEN_A_MINT_OFFSET)? == mint.to_bytes()
            && bytes32(data, damm_pool::TOKEN_B_MINT_OFFSET)? == WSOL_MINT.to_bytes(),
        AutopilotError::InvalidPool
    );
    Ok(Some(PoolView {
        sqrt_price: read_u128(data, damm_pool::SQRT_PRICE_OFFSET)?,
        token_a_vault: Pubkey::new_from_array(bytes32(data, damm_pool::TOKEN_A_VAULT_OFFSET)?),
        token_b_vault: Pubkey::new_from_array(bytes32(data, damm_pool::TOKEN_B_VAULT_OFFSET)?),
    }))
}

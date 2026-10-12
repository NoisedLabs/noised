//! Post-conditions verified in `launch` against live account state. The
//! certificate's flags are set only from these checks, never from intent.

use anchor_lang::{prelude::*, ZeroCopy};
use anchor_spl::token_interface::{
    spl_token_2022::{
        self,
        extension::{
            metadata_pointer::MetadataPointer, transfer_hook::TransferHook,
            BaseStateWithExtensions, ExtensionType, StateWithExtensions,
        },
    },
    spl_token_metadata_interface::state::TokenMetadata,
};

use crate::{
    constants::{dbc, WSOL_MINT},
    cp_amm::accounts::{Pool as DammPool, Position as DammPosition},
    dynamic_bonding_curve::accounts::{ConfigWithTransferHook, TransferHookPool},
    error::LaunchpadError,
    state::checks,
};

/// Facts about a mint that passed every check.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MintFacts {
    pub supply: u64,
    pub checks: u32,
}

/// SPEC §1.4 `launch` post-conditions on the freshly created base mint, plus
/// two stricter ones: the decimals match the launch and the transfer-hook
/// authority is DBC's pool authority (the only key that can change the hook,
/// and DBC uses it only to revoke the hook when the curve completes).
pub fn inspect_mint(
    mint_key: &Pubkey,
    owner: &Pubkey,
    data: &[u8],
    expected_decimals: u8,
    hook_program: &Pubkey,
    hook_authority: &Pubkey,
) -> Result<MintFacts> {
    require_keys_eq!(*owner, spl_token_2022::ID, LaunchpadError::UnsafeMint);
    let state = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(data)
        .map_err(|_| error!(LaunchpadError::UnsafeMint))?;
    let base = state.base;
    require!(
        base.is_initialized && base.decimals == expected_decimals && base.supply > 0,
        LaunchpadError::UnsafeMint
    );
    let mut flags = 0u32;

    require!(base.mint_authority.is_none(), LaunchpadError::UnsafeMint);
    flags |= checks::MINT_AUTHORITY_NONE;
    require!(base.freeze_authority.is_none(), LaunchpadError::UnsafeMint);
    flags |= checks::FREEZE_AUTHORITY_NONE;

    let types = state
        .get_extension_types()
        .map_err(|_| error!(LaunchpadError::UnsafeMint))?;
    require!(
        types.len() == 3
            && types.contains(&ExtensionType::MetadataPointer)
            && types.contains(&ExtensionType::TokenMetadata)
            && types.contains(&ExtensionType::TransferHook),
        LaunchpadError::UnsafeMint
    );
    flags |= checks::EXTENSION_SET_EXACT;

    let hook = state
        .get_extension::<TransferHook>()
        .map_err(|_| error!(LaunchpadError::UnsafeMint))?;
    require!(
        Option::<Pubkey>::from(hook.program_id) == Some(*hook_program)
            && Option::<Pubkey>::from(hook.authority) == Some(*hook_authority),
        LaunchpadError::UnsafeMint
    );
    flags |= checks::HOOK_IS_NOISED;

    let pointer = state
        .get_extension::<MetadataPointer>()
        .map_err(|_| error!(LaunchpadError::UnsafeMint))?;
    require!(
        Option::<Pubkey>::from(pointer.authority).is_none()
            && Option::<Pubkey>::from(pointer.metadata_address) == Some(*mint_key),
        LaunchpadError::UnsafeMint
    );
    flags |= checks::METADATA_POINTER_AUTHORITY_NONE;

    // TokenMetadata starts with `update_authority` (32 bytes, zero = None)
    // followed by `mint`; reading them avoids decoding the strings.
    let metadata = state
        .get_extension_bytes::<TokenMetadata>()
        .map_err(|_| error!(LaunchpadError::UnsafeMint))?;
    require!(metadata.len() >= 64, LaunchpadError::UnsafeMint);
    require!(
        metadata[..32].iter().all(|b| *b == 0) && metadata[32..64] == mint_key.to_bytes(),
        LaunchpadError::UnsafeMint
    );
    flags |= checks::METADATA_UPDATE_AUTHORITY_NONE;

    Ok(MintFacts {
        supply: base.supply,
        checks: flags,
    })
}

/// Whether a TokenMetadata TLV value holds exactly this name, symbol and uri
/// after its update authority and mint (which `inspect_mint` checks), and no
/// additional metadata: the rest of the value is `borsh(name) ||
/// borsh(symbol) || borsh(uri) || u32le(0)`, byte for byte, to its end.
/// Read in place, so the strings are not copied again.
pub fn token_metadata_matches(value: &[u8], name: &[u8], symbol: &[u8], uri: &[u8]) -> bool {
    let Some(rest) = value.get(64..) else {
        return false;
    };
    let Some((name_at, rest)) = borsh_string(rest) else {
        return false;
    };
    let Some((symbol_at, rest)) = borsh_string(rest) else {
        return false;
    };
    let Some((uri_at, rest)) = borsh_string(rest) else {
        return false;
    };
    name_at == name && symbol_at == symbol && uri_at == uri && rest == [0u8; 4]
}

/// The borsh string (u32 LE length, then the bytes) at the start of `bytes`,
/// and what follows it; `None` if `bytes` is shorter.
fn borsh_string(bytes: &[u8]) -> Option<(&[u8], &[u8])> {
    let (len, tail) = bytes.split_first_chunk::<4>()?;
    let len = usize::try_from(u32::from_le_bytes(*len)).ok()?;
    (len <= tail.len()).then(|| tail.split_at(len))
}

/// `launch`'s metadata post-condition: the mint's TokenMetadata, re-read
/// after the pool CPI, holds exactly the attested record's name and symbol
/// and the uri `launch` derived from it (the bytes it sent DBC), and nothing
/// else (`token_metadata_matches`). Returns `checks::METADATA_ONCHAIN`.
pub fn verify_token_metadata(data: &[u8], name: &str, symbol: &str, uri: &[u8]) -> Result<u32> {
    let state = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(data)
        .map_err(|_| error!(LaunchpadError::MetadataMismatch))?;
    let value = state
        .get_extension_bytes::<TokenMetadata>()
        .map_err(|_| error!(LaunchpadError::MetadataMismatch))?;
    require!(
        token_metadata_matches(value, name.as_bytes(), symbol.as_bytes(), uri),
        LaunchpadError::MetadataMismatch
    );
    Ok(checks::METADATA_ONCHAIN)
}

/// What the DBC config of a launch must contain.
pub struct ExpectedConfig<'a> {
    pub launch_authority: &'a Pubkey,
    pub hook_program: &'a Pubkey,
    pub token_decimal: u8,
    pub migration_quote_threshold: u64,
    pub migration_fee_option: u8,
}

/// Re-read the DBC config created in `create_launch` and confirm every fixed
/// value of SPEC §1.2. Returns the config-derived certificate flags.
pub fn inspect_config(cfg: &ConfigWithTransferHook, expected: &ExpectedConfig) -> Result<u32> {
    let c = &cfg.config;
    let zero_vesting = c.locked_vesting_config.amount_per_period == 0
        && c.locked_vesting_config.cliff_duration_from_migration_time == 0
        && c.locked_vesting_config.frequency == 0
        && c.locked_vesting_config.number_of_period == 0
        && c.locked_vesting_config.cliff_unlock_amount == 0;
    require!(
        cfg.transfer_hook_program == *expected.hook_program
            && c.fee_claimer == *expected.launch_authority
            && c.leftover_receiver == *expected.launch_authority
            && c.token_type == dbc::TOKEN_TYPE_TOKEN_2022
            && c.token_update_authority == dbc::TOKEN_UPDATE_AUTHORITY_IMMUTABLE
            && c.migration_option == dbc::MIGRATION_OPTION_DAMM_V2
            && c.collect_fee_mode == dbc::COLLECT_FEE_MODE_QUOTE
            && c.activation_type == dbc::ACTIVATION_TYPE_TIMESTAMP
            && c.creator_trading_fee_percentage == 0
            && c.fixed_token_supply_flag == 0
            && c.pool_creation_fee == 0
            && c.enable_first_swap_with_min_fee == 0
            && c.token_decimal == expected.token_decimal
            && c.migration_quote_threshold == expected.migration_quote_threshold
            && c.migration_fee_option == expected.migration_fee_option,
        LaunchpadError::UnsafeConfig
    );
    let mut flags = 0u32;
    require!(
        c.partner_permanent_locked_liquidity_percentage == 100
            && c.partner_liquidity_percentage == 0
            && c.creator_liquidity_percentage == 0
            && c.creator_permanent_locked_liquidity_percentage == 0
            && c.partner_liquidity_vesting_info.is_initialized == 0
            && c.creator_liquidity_vesting_info.is_initialized == 0,
        LaunchpadError::UnsafeConfig
    );
    flags |= checks::LP_PERMANENTLY_LOCKED;
    require!(
        c.migration_fee_percentage == 0 && c.creator_migration_fee_percentage == 0,
        LaunchpadError::UnsafeConfig
    );
    flags |= checks::NO_MIGRATION_FEE;
    require!(zero_vesting, LaunchpadError::UnsafeConfig);
    flags |= checks::NO_CREATOR_ALLOCATION;
    require_keys_eq!(c.quote_mint, WSOL_MINT, LaunchpadError::UnsafeConfig);
    flags |= checks::QUOTE_IS_WSOL;
    Ok(flags)
}

/// Copy a zero-copy account owned by another program out of its data after
/// checking owner, discriminator and size (unaligned read: no layout assumptions).
pub fn read_pod_account<T: ZeroCopy + Owner>(info: &AccountInfo) -> Result<T> {
    require_keys_eq!(*info.owner, T::owner(), LaunchpadError::AccountMismatch);
    let data = info.try_borrow_data()?;
    let disc = T::DISCRIMINATOR;
    let end = disc.len() + std::mem::size_of::<T>();
    require!(
        data.len() >= end && &data[..disc.len()] == disc,
        LaunchpadError::AccountMismatch
    );
    anchor_lang::__private::bytemuck::try_pod_read_unaligned(&data[disc.len()..end])
        .map_err(|_| error!(LaunchpadError::AccountMismatch))
}

pub fn read_dbc_pool(info: &AccountInfo) -> Result<TransferHookPool> {
    read_pod_account::<TransferHookPool>(info)
}

/// Whether the DBC pool has executed any swap yet (`has_swap`, set by every
/// DBC swap). Kept out of line so the pool copy lives in its own stack frame.
#[inline(never)]
pub fn dbc_pool_has_swapped(info: &AccountInfo) -> Result<bool> {
    Ok(read_dbc_pool(info)?.pool_state.has_swap != 0)
}

/// Read the DBC config account and run `inspect_config` on it. Kept out of
/// line so the 1 KiB copy lives in its own stack frame.
#[inline(never)]
pub fn verify_dbc_config(info: &AccountInfo, expected: &ExpectedConfig) -> Result<u32> {
    let config = read_pod_account::<ConfigWithTransferHook>(info)?;
    inspect_config(&config, expected)
}

/// An LP claim is only made for a DAMM v2 position in a pool of exactly
/// (base mint, wSOL) whose NFT is the one being presented.
#[inline(never)]
pub fn verify_lp_position(
    pool: &AccountInfo,
    position: &AccountInfo,
    nft_mint: &Pubkey,
    base_mint: &Pubkey,
) -> Result<()> {
    let p = read_pod_account::<DammPool>(pool)?;
    require!(
        p.token_a_mint == *base_mint && p.token_b_mint == WSOL_MINT,
        LaunchpadError::InvalidPosition
    );
    let pos = read_pod_account::<DammPosition>(position)?;
    require!(
        pos.pool == *pool.key && pos.nft_mint == *nft_mint,
        LaunchpadError::InvalidPosition
    );
    Ok(())
}

/// The DBC pool must belong to this launch's config and mint, with the
/// launch authority as its creator.
pub fn inspect_pool(
    pool: &TransferHookPool,
    config: &Pubkey,
    creator: &Pubkey,
    base_mint: &Pubkey,
    base_vault: &Pubkey,
    quote_vault: &Pubkey,
) -> Result<()> {
    let p = &pool.pool_state;
    require!(
        p.config == *config
            && p.creator == *creator
            && p.base_mint == *base_mint
            && p.base_vault == *base_vault
            && p.quote_vault == *quote_vault,
        LaunchpadError::UnsafeConfig
    );
    Ok(())
}

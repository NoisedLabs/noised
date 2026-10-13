//! Post-conditions verified in `launch` against live account state. The
//! certificate's flags are set only from these checks, never from intent.
//!
//! Token-2022 parsing is `noised_onchain::token` (written from, and tested
//! against, spl-token-2022-interface 2.1.0, which the Anchor build used
//! through anchor-spl); the DBC and DAMM v2 accounts are read at the fixed
//! offsets of their zero-copy layouts (`external`, tested against the
//! IDL-generated types).

use noised_onchain::{
    token::{
        get_extension, get_extension_bytes, optional_key, unpack_mint, ExtensionTypes,
        EXT_METADATA_POINTER, EXT_TOKEN_METADATA, EXT_TRANSFER_HOOK, METADATA_POINTER_LEN,
        TOKEN_2022_PROGRAM_ID, TRANSFER_HOOK_LEN,
    },
    AccountView, ProgramError,
};

use crate::{
    constants::{dbc, WSOL_MINT},
    error::{fail_keys, raise, require, LaunchpadError, Result},
    external::{damm, dbc as dbc_layout},
    state::checks,
    Pubkey,
};

/// `LaunchpadError` `e` with the two compared keys (`require_keys_eq!`).
#[cfg(target_os = "solana")]
fn keys_error(e: LaunchpadError, left: &Pubkey, right: &Pubkey) -> crate::error::Error {
    fail_keys(e.code(), None, left, right)
}

/// `LaunchpadError` `e` with the two compared keys (`require_keys_eq!`).
#[cfg(not(target_os = "solana"))]
fn keys_error(e: LaunchpadError, left: &Pubkey, right: &Pubkey) -> crate::error::Error {
    anchor_lang::error::Error::from(e).with_pubkeys((*left, *right))
}

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
    if *owner != TOKEN_2022_PROGRAM_ID {
        return Err(keys_error(
            LaunchpadError::UnsafeMint,
            owner,
            &TOKEN_2022_PROGRAM_ID,
        ));
    }
    let state = unpack_mint(data).map_err(|_| LaunchpadError::UnsafeMint)?;
    let supply = state.supply();
    require!(
        state.decimals() == expected_decimals && supply > 0,
        LaunchpadError::UnsafeMint
    );
    let mut flags = 0u32;

    require!(state.mint_authority().is_none(), LaunchpadError::UnsafeMint);
    flags |= checks::MINT_AUTHORITY_NONE;
    require!(
        state.freeze_authority().is_none(),
        LaunchpadError::UnsafeMint
    );
    flags |= checks::FREEZE_AUTHORITY_NONE;

    // `get_extension_types`: every entry parses; exactly these three types.
    let tlv = state.tlv;
    let mut types = ExtensionTypes::new(tlv);
    let (mut count, mut seen) = (0usize, [false; 3]);
    while let Some(extension_type) = types.next_type().map_err(|_| LaunchpadError::UnsafeMint)? {
        count += 1;
        match extension_type {
            EXT_METADATA_POINTER => seen[0] = true,
            EXT_TOKEN_METADATA => seen[1] = true,
            EXT_TRANSFER_HOOK => seen[2] = true,
            _ => {}
        }
    }
    require!(count == 3 && seen == [true; 3], LaunchpadError::UnsafeMint);
    flags |= checks::EXTENSION_SET_EXACT;

    // TransferHook: authority (32) | program_id (32).
    let hook = get_extension(tlv, EXT_TRANSFER_HOOK, TRANSFER_HOOK_LEN)
        .map_err(|_| LaunchpadError::UnsafeMint)?;
    require!(
        optional_key(hook, 32).as_ref() == Some(hook_program)
            && optional_key(hook, 0).as_ref() == Some(hook_authority),
        LaunchpadError::UnsafeMint
    );
    flags |= checks::HOOK_IS_NOISED;

    // MetadataPointer: authority (32) | metadata_address (32).
    let pointer = get_extension(tlv, EXT_METADATA_POINTER, METADATA_POINTER_LEN)
        .map_err(|_| LaunchpadError::UnsafeMint)?;
    require!(
        optional_key(pointer, 0).is_none() && optional_key(pointer, 32).as_ref() == Some(mint_key),
        LaunchpadError::UnsafeMint
    );
    flags |= checks::METADATA_POINTER_AUTHORITY_NONE;

    // TokenMetadata starts with `update_authority` (32 bytes, zero = None)
    // followed by `mint`; reading them avoids decoding the strings.
    let metadata =
        get_extension_bytes(tlv, EXT_TOKEN_METADATA).map_err(|_| LaunchpadError::UnsafeMint)?;
    require!(metadata.len() >= 64, LaunchpadError::UnsafeMint);
    require!(
        metadata[..32].iter().all(|b| *b == 0) && metadata[32..64] == mint_key.to_bytes(),
        LaunchpadError::UnsafeMint
    );
    flags |= checks::METADATA_UPDATE_AUTHORITY_NONE;

    Ok(MintFacts {
        supply,
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
    verify_token_metadata_bytes(data, name.as_bytes(), symbol.as_bytes(), uri)
}

/// [`verify_token_metadata`] of byte strings.
pub fn verify_token_metadata_bytes(
    data: &[u8],
    name: &[u8],
    symbol: &[u8],
    uri: &[u8],
) -> Result<u32> {
    let state = unpack_mint(data).map_err(|_| LaunchpadError::MetadataMismatch)?;
    let value = get_extension_bytes(state.tlv, EXT_TOKEN_METADATA)
        .map_err(|_| LaunchpadError::MetadataMismatch)?;
    require!(
        token_metadata_matches(value, name, symbol, uri),
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
/// value of SPEC §1.2 (off-chain: the IDL-generated type, laid out as the
/// account stores it). Returns the config-derived certificate flags.
#[cfg(not(target_os = "solana"))]
pub fn inspect_config(
    cfg: &crate::dynamic_bonding_curve::accounts::ConfigWithTransferHook,
    expected: &ExpectedConfig,
) -> Result<u32> {
    let mut data = [0u8; dbc_layout::config::LEN];
    data[8..].copy_from_slice(bytemuck::bytes_of(cfg));
    inspect_config_data(&data, expected)
}

/// [`inspect_config`] on the config account's data (discriminator
/// included, at least `dbc::config::LEN` bytes).
pub fn inspect_config_data(
    c: &[u8; dbc_layout::config::LEN],
    expected: &ExpectedConfig,
) -> Result<u32> {
    use dbc_layout::config::*;
    let byte = |at: usize| c[at];
    let key = |at: usize| Pubkey::new_from_array(field(c, at));
    let u64_at = |at: usize| u64::from_le_bytes(field(c, at));
    let zero_vesting = LOCKED_VESTING.iter().all(|at| u64_at(*at) == 0);
    require!(
        key(TRANSFER_HOOK_PROGRAM) == *expected.hook_program
            && key(FEE_CLAIMER) == *expected.launch_authority
            && key(LEFTOVER_RECEIVER) == *expected.launch_authority
            && byte(TOKEN_TYPE) == dbc::TOKEN_TYPE_TOKEN_2022
            && byte(TOKEN_UPDATE_AUTHORITY) == dbc::TOKEN_UPDATE_AUTHORITY_IMMUTABLE
            && byte(MIGRATION_OPTION) == dbc::MIGRATION_OPTION_DAMM_V2
            && byte(COLLECT_FEE_MODE) == dbc::COLLECT_FEE_MODE_QUOTE
            && byte(ACTIVATION_TYPE) == dbc::ACTIVATION_TYPE_TIMESTAMP
            && byte(CREATOR_TRADING_FEE_PERCENTAGE) == 0
            && byte(FIXED_TOKEN_SUPPLY_FLAG) == 0
            && u64_at(POOL_CREATION_FEE) == 0
            && byte(ENABLE_FIRST_SWAP_WITH_MIN_FEE) == 0
            && byte(TOKEN_DECIMAL) == expected.token_decimal
            && u64_at(MIGRATION_QUOTE_THRESHOLD) == expected.migration_quote_threshold
            && byte(MIGRATION_FEE_OPTION) == expected.migration_fee_option,
        LaunchpadError::UnsafeConfig
    );
    let mut flags = 0u32;
    require!(
        byte(PARTNER_PERMANENT_LOCKED_LIQUIDITY_PERCENTAGE) == 100
            && byte(PARTNER_LIQUIDITY_PERCENTAGE) == 0
            && byte(CREATOR_LIQUIDITY_PERCENTAGE) == 0
            && byte(CREATOR_PERMANENT_LOCKED_LIQUIDITY_PERCENTAGE) == 0
            && byte(PARTNER_LIQUIDITY_VESTING_IS_INITIALIZED) == 0
            && byte(CREATOR_LIQUIDITY_VESTING_IS_INITIALIZED) == 0,
        LaunchpadError::UnsafeConfig
    );
    flags |= checks::LP_PERMANENTLY_LOCKED;
    require!(
        byte(MIGRATION_FEE_PERCENTAGE) == 0 && byte(CREATOR_MIGRATION_FEE_PERCENTAGE) == 0,
        LaunchpadError::UnsafeConfig
    );
    flags |= checks::NO_MIGRATION_FEE;
    require!(zero_vesting, LaunchpadError::UnsafeConfig);
    flags |= checks::NO_CREATOR_ALLOCATION;
    let quote_mint = key(QUOTE_MINT);
    if quote_mint != WSOL_MINT {
        return Err(keys_error(
            LaunchpadError::UnsafeConfig,
            &quote_mint,
            &WSOL_MINT,
        ));
    }
    flags |= checks::QUOTE_IS_WSOL;
    Ok(flags)
}

/// `L` bytes of `data` at `at`.
#[inline(always)]
fn field<const L: usize>(data: &[u8], at: usize) -> [u8; L] {
    let mut out = [0u8; L];
    out.copy_from_slice(&data[at..at + L]);
    out
}

/// The first `out.len()` bytes of a zero-copy account owned by `owner` that
/// starts with `discriminator` (`read_pod_account`), into `out` (the
/// caller's buffer, so one copy is made): another owner, a shorter account
/// or another discriminator is `AccountMismatch` (the owner with both keys).
#[inline(never)]
fn read_pod(
    info: &AccountView,
    owner: &Pubkey,
    discriminator: &[u8; 8],
    out: &mut [u8],
) -> core::result::Result<(), ProgramError> {
    if info.owner() != owner {
        return Err(fail_keys(
            LaunchpadError::AccountMismatch.code(),
            None,
            info.owner(),
            owner,
        ));
    }
    let data = info.try_borrow()?;
    match data.get(..out.len()) {
        Some(bytes) if bytes.first_chunk::<8>() == Some(discriminator) => {
            out.copy_from_slice(bytes);
            Ok(())
        }
        _ => Err(raise(LaunchpadError::AccountMismatch)),
    }
}

/// The DBC pool account (`TransferHookPool`), checked as `read_pod_account`
/// checks it.
pub fn read_dbc_pool(
    info: &AccountView,
) -> core::result::Result<[u8; dbc_layout::pool::LEN], ProgramError> {
    let mut pool = [0u8; dbc_layout::pool::LEN];
    read_pod(
        info,
        &crate::constants::DBC_PROGRAM_ID,
        &dbc_layout::pool::DISCRIMINATOR,
        &mut pool,
    )?;
    Ok(pool)
}

/// Whether the DBC pool has executed any swap yet (`has_swap`, set by every
/// DBC swap).
#[inline(never)]
pub fn dbc_pool_has_swapped(info: &AccountView) -> core::result::Result<bool, ProgramError> {
    Ok(read_dbc_pool(info)?[dbc_layout::pool::HAS_SWAP] != 0)
}

/// The surplus flags of the DBC pool: (partner withdrew, creator withdrew).
#[inline(never)]
pub fn dbc_pool_surplus_withdrawn(
    info: &AccountView,
) -> core::result::Result<(bool, bool), ProgramError> {
    let pool = read_dbc_pool(info)?;
    Ok((
        pool[dbc_layout::pool::IS_PARTNER_WITHDRAW_SURPLUS] != 0,
        pool[dbc_layout::pool::IS_CREATOR_WITHDRAW_SURPLUS] != 0,
    ))
}

/// Read the DBC config account and run `inspect_config` on it (the 1,128
/// bytes in this function's frame, once).
#[inline(never)]
pub fn verify_dbc_config(
    info: &AccountView,
    expected: &ExpectedConfig,
) -> core::result::Result<u32, ProgramError> {
    let mut config = [0u8; dbc_layout::config::LEN];
    read_pod(
        info,
        &crate::constants::DBC_PROGRAM_ID,
        &dbc_layout::config::DISCRIMINATOR,
        &mut config,
    )?;
    inspect_config_data(&config, expected).map_err(crate::error::raise_error)
}

/// An LP claim is only made for a DAMM v2 position in a pool of exactly
/// (base mint, wSOL) whose NFT is the one being presented.
#[inline(never)]
pub fn verify_lp_position(
    pool: &AccountView,
    position: &AccountView,
    nft_mint: &Pubkey,
    base_mint: &Pubkey,
) -> core::result::Result<(), ProgramError> {
    let mut p = [0u8; damm::pool::LEN];
    read_pod(
        pool,
        &crate::constants::DAMM_V2_PROGRAM_ID,
        &damm::pool::DISCRIMINATOR,
        &mut p,
    )?;
    if field::<32>(&p, damm::pool::TOKEN_A_MINT) != base_mint.to_bytes()
        || field::<32>(&p, damm::pool::TOKEN_B_MINT) != WSOL_MINT.to_bytes()
    {
        return Err(raise(LaunchpadError::InvalidPosition));
    }
    let mut pos = [0u8; damm::position::LEN];
    read_pod(
        position,
        &crate::constants::DAMM_V2_PROGRAM_ID,
        &damm::position::DISCRIMINATOR,
        &mut pos,
    )?;
    if field::<32>(&pos, damm::position::POOL) != pool.address().to_bytes()
        || field::<32>(&pos, damm::position::NFT_MINT) != nft_mint.to_bytes()
    {
        return Err(raise(LaunchpadError::InvalidPosition));
    }
    Ok(())
}

/// The DBC pool must belong to this launch's config and mint, with the
/// launch authority as its creator.
pub fn inspect_pool(
    pool: &[u8; dbc_layout::pool::LEN],
    config: &Pubkey,
    creator: &Pubkey,
    base_mint: &Pubkey,
    base_vault: &Pubkey,
    quote_vault: &Pubkey,
) -> core::result::Result<(), ProgramError> {
    use dbc_layout::pool::*;
    let is = |at: usize, key: &Pubkey| field::<32>(pool, at) == key.to_bytes();
    if !(is(CONFIG, config)
        && is(CREATOR, creator)
        && is(BASE_MINT, base_mint)
        && is(BASE_VAULT, base_vault)
        && is(QUOTE_VAULT, quote_vault))
    {
        return Err(raise(LaunchpadError::UnsafeConfig));
    }
    Ok(())
}

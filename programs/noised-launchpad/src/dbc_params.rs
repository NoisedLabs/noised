//! The DBC instruction data a launch sends: the full `ConfigParameters`
//! (creator-chosen fields from a validated `LaunchParams`, every other field
//! fixed, SPEC §1.2: `external::dbc::create_config_data`) and the pool's
//! name, symbol and uri.

use alloc::vec::Vec;

use crate::{external::dbc::INITIALIZE_VIRTUAL_POOL_WITH_TOKEN2022_TRANSFER_HOOK, policy};

/// The data of DBC's `initialize_virtual_pool_with_token2022_transfer_hook`
/// for a metadata record, and the offset of the uri in it: the
/// discriminator, then `InitializePoolParameters { name, symbol, uri }` in
/// borsh, with the uri `launch` derives (`policy::write_token_uri`) written
/// straight into the data. `launch` sends it and then compares the mint's
/// uri with those bytes, so the uri (up to 4,125 bytes) is on the heap once.
/// Equal to Anchor's encoding of the typed arguments (pinned in tests).
pub fn initialize_pool_data(
    name: &str,
    symbol: &str,
    flags: u8,
    uri: &str,
    doc: &str,
) -> (Vec<u8>, usize) {
    let discriminator = &INITIALIZE_VIRTUAL_POOL_WITH_TOKEN2022_TRANSFER_HOOK;
    let uri_len = policy::token_uri_len(flags, uri, doc);
    let mut data =
        Vec::with_capacity(discriminator.len() + 12 + name.len() + symbol.len() + uri_len);
    data.extend_from_slice(discriminator);
    // String lengths are bounded by the record's policy (at most 4,125).
    for (bytes, len) in [
        (name.as_bytes(), name.len()),
        (symbol.as_bytes(), symbol.len()),
    ] {
        data.extend_from_slice(&(len as u32).to_le_bytes());
        data.extend_from_slice(bytes);
    }
    data.extend_from_slice(&(uri_len as u32).to_le_bytes());
    let uri_at = data.len();
    policy::write_token_uri(flags, uri, doc, &mut data);
    (data, uri_at)
}

/// The DBC config as the IDL types describe it (host only; the program
/// sends `external::dbc::create_config_data`, its Borsh encoding, which the
/// ABI tests compare with this). Must only be called with parameters that
/// passed `policy::validate`.
#[cfg(not(target_os = "solana"))]
pub fn config_parameters(
    params: &crate::state::LaunchParams,
) -> crate::dynamic_bonding_curve::types::ConfigParameters {
    use crate::{
        constants::dbc,
        dynamic_bonding_curve::types::{
            BaseFeeParameters, ConfigParameters, DynamicFeeParameters,
            LiquidityDistributionParameters, LiquidityVestingInfoParams, LockedVestingParams,
            MigratedPoolFee, MigratedPoolMarketCapFeeSchedulerParams, MigrationFee,
            PoolFeeParameters,
        },
    };
    let no_vesting = LiquidityVestingInfoParams {
        vesting_percentage: 0,
        bps_per_period: 0,
        number_of_periods: 0,
        cliff_duration_from_migration_time: 0,
        frequency: 0,
    };
    ConfigParameters {
        pool_fees: PoolFeeParameters {
            base_fee: BaseFeeParameters {
                cliff_fee_numerator: params.base_fee.cliff_fee_numerator,
                first_factor: params.base_fee.first_factor,
                second_factor: params.base_fee.second_factor,
                third_factor: params.base_fee.third_factor,
                base_fee_mode: params.base_fee.base_fee_mode,
            },
            dynamic_fee: params.dynamic_fee.map(|d| DynamicFeeParameters {
                bin_step: d.bin_step,
                bin_step_u128: d.bin_step_u128,
                filter_period: d.filter_period,
                decay_period: d.decay_period,
                reduction_factor: d.reduction_factor,
                max_volatility_accumulator: d.max_volatility_accumulator,
                variable_fee_control: d.variable_fee_control,
            }),
        },
        collect_fee_mode: dbc::COLLECT_FEE_MODE_QUOTE,
        migration_option: dbc::MIGRATION_OPTION_DAMM_V2,
        activation_type: dbc::ACTIVATION_TYPE_TIMESTAMP,
        token_type: dbc::TOKEN_TYPE_TOKEN_2022,
        token_decimal: params.token_decimal,
        partner_liquidity_percentage: 0,
        partner_permanent_locked_liquidity_percentage: 100,
        creator_liquidity_percentage: 0,
        creator_permanent_locked_liquidity_percentage: 0,
        migration_quote_threshold: params.migration_quote_threshold,
        sqrt_start_price: params.sqrt_start_price,
        locked_vesting: LockedVestingParams {
            amount_per_period: 0,
            cliff_duration_from_migration_time: 0,
            frequency: 0,
            number_of_period: 0,
            cliff_unlock_amount: 0,
        },
        migration_fee_option: params.migration_fee_option,
        token_supply: None,
        creator_trading_fee_percentage: 0,
        token_update_authority: dbc::TOKEN_UPDATE_AUTHORITY_IMMUTABLE,
        migration_fee: MigrationFee {
            fee_percentage: 0,
            creator_fee_percentage: 0,
        },
        // Fixed migration fee options require every migrated-pool fee field to
        // be zero (DBC: `MigratedPoolFeeValidator::is_none`).
        migrated_pool_fee: MigratedPoolFee {
            collect_fee_mode: 0,
            dynamic_fee: 0,
            pool_fee_bps: 0,
        },
        pool_creation_fee: 0,
        partner_liquidity_vesting_info: no_vesting,
        creator_liquidity_vesting_info: no_vesting,
        migrated_pool_base_fee_mode: 0,
        migrated_pool_market_cap_fee_scheduler_params: MigratedPoolMarketCapFeeSchedulerParams {
            number_of_period: 0,
            sqrt_price_step_bps: 0,
            scheduler_expiration_duration: 0,
            reduction_factor: 0,
        },
        enable_first_swap_with_min_fee: false,
        compounding_fee_bps: 0,
        padding: [0; 2],
        curve: params
            .curve
            .iter()
            .map(|p| LiquidityDistributionParameters {
                sqrt_price: p.sqrt_price,
                liquidity: p.liquidity,
            })
            .collect(),
    }
}

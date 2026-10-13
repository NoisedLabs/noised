//! The safety policy (SPEC §1.2): pure validation of `LaunchParams`.
//!
//! Every bound DBC 0.2.1 checks in `ConfigParameters::validate` and in its fee
//! scheduler / dynamic fee validation is mirrored here, so parameters that pass
//! this module are never rejected by the DBC CPI for those reasons. Rules that
//! depend on curve math (migration price reachable, base amounts non-zero) are
//! left to DBC: a failure there aborts `create_launch` atomically.

use alloc::{string::String, vec::Vec};

use crate::{
    constants::{dbc, *},
    error::{require, LaunchpadError, Result},
    math::div_wide,
    state::{BaseFeeParams, CurvePoint, DynamicFeeParams, FeeRecipient, LaunchParams},
    Pubkey,
};

/// Values derived while validating.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Validated {
    pub batch_total_cap: u64,
    pub recipients: [FeeRecipient; MAX_RECIPIENTS],
    pub recipient_count: u8,
    /// Base fee once the schedule has ended (what the batch pays).
    pub floor_fee_numerator: u64,
    /// Largest possible dynamic fee on top of the floor.
    pub max_dynamic_fee_numerator: u64,
}

/// Validate everything a creator chose. `forbidden` lists addresses that may
/// not receive fees (the launch's own PDAs).
pub fn validate(params: &LaunchParams, forbidden: &[Pubkey]) -> Result<Validated> {
    require!(
        (MIN_TOKEN_DECIMALS..=MAX_TOKEN_DECIMALS).contains(&params.token_decimal),
        LaunchpadError::InvalidDecimals
    );
    require!(
        (MIN_THRESHOLD..=MAX_THRESHOLD).contains(&params.migration_quote_threshold),
        LaunchpadError::InvalidThreshold
    );
    validate_curve(params.sqrt_start_price, &params.curve)?;
    require!(
        params.migration_fee_option <= dbc::MAX_MIGRATION_FEE_OPTION,
        LaunchpadError::InvalidMigrationFeeOption
    );
    require!(
        (MIN_OPEN_DELAY..=MAX_OPEN_DELAY).contains(&params.open_delay_secs),
        LaunchpadError::InvalidOpenDelay
    );
    let shield = params
        .open_delay_secs
        .checked_add(EXECUTION_GRACE_SECS)
        .ok_or(LaunchpadError::MathOverflow)?;
    require!(
        (shield..=MAX_GUARD_SECS).contains(&params.guard_secs),
        LaunchpadError::InvalidGuard
    );
    require!(
        params.max_wallet_bps == 0
            || (MIN_MAX_WALLET_BPS..=BPS_DENOMINATOR as u16).contains(&params.max_wallet_bps),
        LaunchpadError::InvalidMaxWallet
    );
    require!(
        params.max_buy_bps <= BPS_DENOMINATOR as u16,
        LaunchpadError::InvalidMaxBuy
    );
    let batch_total_cap = validate_batch_caps(
        params.migration_quote_threshold,
        params.batch_total_cap,
        params.batch_wallet_cap,
    )?;

    let floor_fee_numerator = validate_base_fee(&params.base_fee, params.open_delay_secs)?;
    let max_dynamic_fee_numerator = match &params.dynamic_fee {
        Some(d) => validate_dynamic_fee(d)?,
        None => 0,
    };
    require!(
        within_fee_ceiling(floor_fee_numerator, max_dynamic_fee_numerator),
        LaunchpadError::FeeTooHigh
    );

    let (recipients, recipient_count) = validate_recipients(&params.recipients, forbidden)?;
    // Every launch names the post-quantum identity that must attest it
    // before `launch` (an all-zero name has no key behind it).
    require!(
        params.pq_identity != [0u8; 32],
        LaunchpadError::InvalidPqIdentity
    );
    Ok(Validated {
        batch_total_cap,
        recipients,
        recipient_count,
        floor_fee_numerator,
        max_dynamic_fee_numerator,
    })
}

/// The fair-open batch caps. `batch_total_cap` is 0 (the threshold) or from
/// `threshold / 10` up to the threshold; `batch_wallet_cap` is 0 (no cap) or
/// at least the resolved total cap / 200 (integer divisions). Below these
/// floors a creator could neuter the fair open while every other check
/// passes: a dust batch, or a per-wallet cap so small that no realistic
/// number of wallets fills it (each `Commit` costs rent that is never
/// returned). Returns the resolved total cap.
pub fn validate_batch_caps(threshold: u64, total_cap: u64, wallet_cap: u64) -> Result<u64> {
    require!(
        total_cap == 0
            || (threshold / MIN_BATCH_TOTAL_CAP_DIVISOR..=threshold).contains(&total_cap),
        LaunchpadError::InvalidBatchCap
    );
    let resolved = if total_cap == 0 { threshold } else { total_cap };
    require!(
        wallet_cap == 0 || wallet_cap >= resolved / MIN_BATCH_WALLET_CAP_DIVISOR,
        LaunchpadError::InvalidBatchCap
    );
    Ok(resolved)
}

/// Mirror of DBC's start-price and curve-shape rules.
pub fn validate_curve(sqrt_start_price: u128, curve: &[CurvePoint]) -> Result<()> {
    require!(
        (dbc::MIN_SQRT_PRICE..dbc::MAX_SQRT_PRICE).contains(&sqrt_start_price),
        LaunchpadError::InvalidCurve
    );
    require!(
        !curve.is_empty() && curve.len() <= MAX_CURVE_POINTS,
        LaunchpadError::InvalidCurve
    );
    let mut previous = sqrt_start_price;
    for point in curve {
        require!(
            point.sqrt_price > previous
                && point.sqrt_price <= dbc::MAX_SQRT_PRICE
                && point.liquidity > 0,
            LaunchpadError::InvalidCurve
        );
        previous = point.sqrt_price;
    }
    Ok(())
}

/// Validate a fee-scheduler base fee exactly as DBC does and require the
/// schedule to be over before the batch executes. Returns the floor fee.
pub fn validate_base_fee(fee: &BaseFeeParams, open_delay_secs: u32) -> Result<u64> {
    require!(
        fee.base_fee_mode == dbc::BASE_FEE_MODE_LINEAR
            || fee.base_fee_mode == dbc::BASE_FEE_MODE_EXPONENTIAL,
        LaunchpadError::InvalidBaseFee
    );
    let periods = fee.first_factor;
    let frequency = fee.second_factor;
    let reduction = fee.third_factor;
    // DBC: a schedule is either fully configured or fully off.
    let any_set = periods != 0 || frequency != 0 || reduction != 0;
    let all_set = periods != 0 && frequency != 0 && reduction != 0;
    require!(!any_set || all_set, LaunchpadError::InvalidBaseFee);
    if fee.base_fee_mode == dbc::BASE_FEE_MODE_EXPONENTIAL {
        // DBC computes (1 - reduction / 10_000)^n; reduction >= 10_000 fails there.
        require!(reduction < BPS_DENOMINATOR, LaunchpadError::InvalidBaseFee);
    }
    let floor = min_base_fee_numerator(fee).ok_or(LaunchpadError::InvalidBaseFee)?;
    require!(
        fee.cliff_fee_numerator <= dbc::MAX_FEE_NUMERATOR && floor >= dbc::MIN_FEE_NUMERATOR,
        LaunchpadError::InvalidBaseFee
    );
    let duration = fee_schedule_duration(fee).ok_or(LaunchpadError::MathOverflow)?;
    require!(
        duration <= u128::from(open_delay_secs),
        LaunchpadError::FeeScheduleTooLong
    );
    Ok(floor)
}

/// Seconds from pool activation until the scheduler reaches its floor:
/// `number_of_period * period_frequency` (activation type is timestamp).
/// After that many seconds DBC's period index is >= number_of_period, so the
/// fee no longer changes.
pub fn fee_schedule_duration(fee: &BaseFeeParams) -> Option<u128> {
    u128::from(fee.first_factor).checked_mul(u128::from(fee.second_factor))
}

/// The scheduler's fee after its last period, computed exactly like DBC.
/// `None` where DBC would fail with an arithmetic error.
pub fn min_base_fee_numerator(fee: &BaseFeeParams) -> Option<u64> {
    let periods = u64::from(fee.first_factor);
    match fee.base_fee_mode {
        dbc::BASE_FEE_MODE_LINEAR => fee
            .cliff_fee_numerator
            .checked_sub(fee.third_factor.checked_mul(periods)?),
        dbc::BASE_FEE_MODE_EXPONENTIAL => {
            exponential_fee(fee.cliff_fee_numerator, fee.third_factor, fee.first_factor)
        }
        _ => None,
    }
}

/// `cliff * (1 - reduction / 10_000)^periods` in Q64.64 fixed point, with the
/// same floor-rounded square-and-multiply sequence DBC uses (bits processed
/// from least significant), so the result is bit-identical.
pub fn exponential_fee(cliff: u64, reduction: u64, periods: u16) -> Option<u64> {
    const ONE: u128 = 1 << 64;
    let step = div_wide(u128::from(reduction) << 64, BPS_DENOMINATOR);
    let base = ONE.checked_sub(step)?;
    let mut result = ONE;
    let mut square = base;
    let mut exponent = periods;
    while exponent > 0 {
        if exponent & 1 == 1 {
            result = result.checked_mul(square)? >> 64;
        }
        exponent >>= 1;
        if exponent > 0 {
            square = square.checked_mul(square)? >> 64;
        }
    }
    // DBC treats a power that underflows to zero as an arithmetic error.
    if periods > 0 && result == 0 {
        return None;
    }
    u64::try_from(result.checked_mul(u128::from(cliff))? >> 64).ok()
}

/// Mirror of DBC's dynamic-fee validation. Returns the largest variable fee
/// numerator the parameters can ever produce.
pub fn validate_dynamic_fee(d: &DynamicFeeParams) -> Result<u64> {
    require!(
        d.bin_step == dbc::DYNAMIC_BIN_STEP
            && d.bin_step_u128 == dbc::DYNAMIC_BIN_STEP_U128
            && d.filter_period < d.decay_period
            && u64::from(d.reduction_factor) <= BPS_DENOMINATOR
            && d.variable_fee_control <= dbc::U24_MAX
            && d.max_volatility_accumulator <= dbc::U24_MAX,
        LaunchpadError::InvalidDynamicFee
    );
    Ok(max_variable_fee_numerator(d).ok_or(LaunchpadError::InvalidDynamicFee)?)
}

/// DBC's variable fee at the volatility cap:
/// `ceil((max_volatility_accumulator * bin_step)^2 * variable_fee_control / 1e11)`.
pub fn max_variable_fee_numerator(d: &DynamicFeeParams) -> Option<u64> {
    let scaled = u128::from(d.max_volatility_accumulator).checked_mul(u128::from(d.bin_step))?;
    let fee = div_wide(
        scaled
            .checked_mul(scaled)?
            .checked_mul(u128::from(d.variable_fee_control))?
            .checked_add(dbc::VARIABLE_FEE_SCALE - 1)?,
        dbc::VARIABLE_FEE_SCALE as u64,
    );
    u64::try_from(fee).ok()
}

/// `floor + dynamic <= MAX_TRADING_FEE_BPS`, compared in numerator units.
pub fn within_fee_ceiling(floor_fee_numerator: u64, max_dynamic_fee_numerator: u64) -> bool {
    let ceiling = u128::from(MAX_TRADING_FEE_BPS) * u128::from(dbc::FEE_DENOMINATOR)
        / u128::from(BPS_DENOMINATOR);
    u128::from(floor_fee_numerator) + u128::from(max_dynamic_fee_numerator) <= ceiling
}

pub fn validate_recipients(
    recipients: &[FeeRecipient],
    forbidden: &[Pubkey],
) -> Result<([FeeRecipient; MAX_RECIPIENTS], u8)> {
    require!(
        !recipients.is_empty() && recipients.len() <= MAX_RECIPIENTS,
        LaunchpadError::InvalidRecipients
    );
    let mut out = [FeeRecipient::default(); MAX_RECIPIENTS];
    let mut total: u64 = 0;
    for (i, (r, slot)) in recipients.iter().zip(out.iter_mut()).enumerate() {
        require!(
            r.wallet != Pubkey::default()
                && r.bps > 0
                && !forbidden.contains(&r.wallet)
                && !recipients.iter().take(i).any(|p| p.wallet == r.wallet),
            LaunchpadError::InvalidRecipients
        );
        total += u64::from(r.bps);
        *slot = *r;
    }
    require!(total == BPS_DENOMINATOR, LaunchpadError::InvalidRecipients);
    Ok((out, recipients.len() as u8))
}

/// Name and symbol limits for the Token-2022 metadata, in UTF-8 bytes, not
/// characters: name 1..=32, symbol 1..=10 (UTF-8 itself is guaranteed by
/// `String`).
pub fn metadata_is_valid(name: &str, symbol: &str) -> bool {
    (1..=MAX_NAME_LEN).contains(&name.len()) && (1..=MAX_SYMBOL_LEN).contains(&symbol.len())
}

/// The flags a record may carry: no uri mode, or exactly one of them.
pub fn flags_are_valid(flags: u8) -> bool {
    matches!(flags, 0 | META_FLAG_INLINE_URI | META_FLAG_EXTERNAL_URI)
}

/// An external uri: `https://` and at least one more byte, at most 200
/// bytes, every byte printable ASCII (0x21..=0x7E: no space, control or
/// non-ASCII byte that a reader could display differently).
pub fn external_uri_is_valid(uri: &str) -> bool {
    let bytes = uri.as_bytes();
    (EXTERNAL_URI_PREFIX.len() + 1..=MAX_URI_LEN).contains(&bytes.len())
        && bytes.starts_with(EXTERNAL_URI_PREFIX.as_bytes())
        && bytes.iter().all(|b| (0x21..=0x7E).contains(b))
}

/// Every rule a `TokenMeta` record meets (`publish_metadata`), checked in
/// this order:
/// * `InvalidMetadataFlags`: a bit other than the two uri modes, or both;
/// * `MetadataTooLong`: a document over 3,072 bytes or a uri over 200;
/// * `InvalidMetadata`: a name outside 1..=32 bytes or a symbol outside
///   1..=10, or (`META_FLAG_EXTERNAL_URI`) a uri `external_uri_is_valid`
///   refuses;
/// * `InvalidMetadataFlags`: a uri without `META_FLAG_EXTERNAL_URI`, or
///   `META_FLAG_INLINE_URI` without a document.
///
/// The document may be empty or not in either other mode; the program never
/// parses it.
pub fn validate_metadata(name: &str, symbol: &str, flags: u8, uri: &str, doc: &str) -> Result<()> {
    require!(flags_are_valid(flags), LaunchpadError::InvalidMetadataFlags);
    require!(
        doc.len() <= MAX_DOC_LEN && uri.len() <= MAX_URI_LEN,
        LaunchpadError::MetadataTooLong
    );
    require!(
        metadata_is_valid(name, symbol),
        LaunchpadError::InvalidMetadata
    );
    if flags == META_FLAG_EXTERNAL_URI {
        require!(external_uri_is_valid(uri), LaunchpadError::InvalidMetadata);
    } else {
        require!(uri.is_empty(), LaunchpadError::InvalidMetadataFlags);
    }
    require!(
        flags != META_FLAG_INLINE_URI || !doc.is_empty(),
        LaunchpadError::InvalidMetadataFlags
    );
    Ok(())
}

/// Length of the uri `launch` gives the mint for a record (`token_uri`).
pub fn token_uri_len(flags: u8, uri: &str, doc: &str) -> usize {
    if flags & META_FLAG_INLINE_URI != 0 {
        INLINE_URI_PREFIX.len() + crate::base64::encoded_len(doc.len())
    } else if flags & META_FLAG_EXTERNAL_URI != 0 {
        uri.len()
    } else {
        0
    }
}

/// Append the uri `launch` gives the mint for a record to `out`
/// (`token_uri_len` bytes): nothing without a uri mode,
/// `"data:application/json;base64," + base64(doc)` with
/// `META_FLAG_INLINE_URI`, the record's own uri with
/// `META_FLAG_EXTERNAL_URI`. `launch` writes it straight into DBC's
/// instruction data (`dbc_params::initialize_pool_data`).
pub fn write_token_uri(flags: u8, uri: &str, doc: &str, out: &mut Vec<u8>) {
    if flags & META_FLAG_INLINE_URI != 0 {
        out.extend_from_slice(INLINE_URI_PREFIX.as_bytes());
        crate::base64::encode_into(doc.as_bytes(), out);
    } else if flags & META_FLAG_EXTERNAL_URI != 0 {
        out.extend_from_slice(uri.as_bytes());
    }
}

/// `write_token_uri` as a string (what clients compare the mint's uri with).
pub fn token_uri(flags: u8, uri: &str, doc: &str) -> String {
    let mut out = Vec::with_capacity(token_uri_len(flags, uri, doc));
    write_token_uri(flags, uri, doc, &mut out);
    // Base64 is ASCII and `uri` a string: this never fails.
    String::from_utf8(out).unwrap_or_default()
}

/// `supply * bps / 10_000`, rounded down, for the hook caps. A non-zero bps
/// that rounds to zero would silently disable the cap, so it is rejected.
pub fn cap_from_bps(supply: u64, bps: u16) -> Option<u64> {
    if bps == 0 {
        return Some(0);
    }
    let cap = div_wide(u128::from(supply) * u128::from(bps), BPS_DENOMINATOR);
    u64::try_from(cap).ok().filter(|c| *c > 0)
}

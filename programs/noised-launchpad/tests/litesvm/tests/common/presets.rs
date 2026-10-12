//! The SDK's launch presets (`sdk/src/launch/presets.ts`, curves from
//! `sdk/src/launch/curve.ts`), ported with the same exact integer math so
//! the tests send what the SDK sends.

use noised_launchpad::{
    constants::{dbc, BPS_DENOMINATOR, LAMPORTS_PER_SOL},
    state::{BaseFeeParams, CurvePoint, DynamicFeeParams, FeeRecipient, LaunchParams},
};

use super::Pubkey;

/// The human inputs of one preset (`PresetShape` in the SDK).
#[derive(Clone, Copy, Debug)]
pub struct Preset {
    pub name: &'static str,
    /// SOL per whole token at the start of the curve and at graduation.
    pub start_price: &'static str,
    pub graduation_price: &'static str,
    pub threshold_sol: u64,
    pub fee_bps: u64,
    pub migration_fee_option: u8,
    pub open_delay_secs: u32,
    pub guard_secs: u32,
    pub max_wallet_bps: u16,
    pub max_buy_bps: u16,
    pub p2p_locked: bool,
    pub batch_wallet_cap_sol: u64,
}

/// `PRESETS` of `sdk/src/launch/presets.ts`.
pub const PRESETS: [Preset; 3] = [
    Preset {
        name: "fair",
        start_price: "0.00000003",
        graduation_price: "0.0000004",
        threshold_sol: 85,
        fee_bps: 100,
        migration_fee_option: 2,
        open_delay_secs: 300,
        guard_secs: 6 * 3_600,
        max_wallet_bps: 100,
        max_buy_bps: 50,
        p2p_locked: false,
        batch_wallet_cap_sol: 5,
    },
    Preset {
        name: "community",
        start_price: "0.00000005",
        graduation_price: "0.0000006",
        threshold_sol: 250,
        fee_bps: 100,
        migration_fee_option: 1,
        open_delay_secs: 1_800,
        guard_secs: 24 * 3_600,
        max_wallet_bps: 200,
        max_buy_bps: 100,
        p2p_locked: true,
        batch_wallet_cap_sol: 2,
    },
    Preset {
        name: "turbo",
        start_price: "0.00000002",
        graduation_price: "0.0000003",
        threshold_sol: 40,
        fee_bps: 150,
        migration_fee_option: 3,
        open_delay_secs: 60,
        guard_secs: 3_600,
        max_wallet_bps: 300,
        max_buy_bps: 0,
        p2p_locked: false,
        batch_wallet_cap_sol: 0,
    },
];

const TOKEN_DECIMAL: u8 = 6;
const QUOTE_DECIMALS: u32 = 9;

/// `floor(a * 2^128 / b)` for `a < b <= u64::MAX`, by long division in base
/// 2^64 (the product does not fit a u128).
fn shl128_div(a: u128, b: u128) -> u128 {
    assert!(a < b && b <= u128::from(u64::MAX), "{a} / {b}");
    let (q1, r1) = ((a << 64) / b, (a << 64) % b);
    (q1 << 64) | ((r1 << 64) / b)
}

/// Exact rational of a plain decimal string ("0.00000003" = 3 / 10^8).
fn parse_decimal(s: &str) -> (u128, u128) {
    let (whole, frac) = s.split_once('.').unwrap_or((s, ""));
    let digits = format!("{whole}{frac}");
    (
        digits.parse().expect("decimal"),
        10u128.pow(frac.len() as u32),
    )
}

/// `sqrtPriceFromPrice`: Q64.64 sqrt of lamports per base unit, rounded down.
pub fn sqrt_price(price: &str, token_decimal: u8) -> u128 {
    let (num, den) = parse_decimal(price);
    let lamports_num = num * 10u128.pow(QUOTE_DECIMALS);
    let lamports_den = den * 10u128.pow(u32::from(token_decimal));
    shl128_div(lamports_num, lamports_den).isqrt()
}

/// `designCurve`: constant liquidity from the start to the graduation price,
/// sized to hold the threshold there, then the same liquidity up to 1.5x the
/// graduation sqrt price.
pub fn design_curve(p: &Preset) -> (u128, Vec<CurvePoint>) {
    let s0 = sqrt_price(p.start_price, TOKEN_DECIMAL);
    let s1 = sqrt_price(p.graduation_price, TOKEN_DECIMAL);
    assert!(s0 >= dbc::MIN_SQRT_PRICE && s1 > s0);
    let s2 = s1 + s1 / 2;
    let threshold = u128::from(p.threshold_sol * LAMPORTS_PER_SOL);
    let liquidity = shl128_div(threshold, s1 - s0);
    (
        s0,
        vec![
            CurvePoint {
                sqrt_price: s1,
                liquidity,
            },
            CurvePoint {
                sqrt_price: s2,
                liquidity,
            },
        ],
    )
}

/// `dynamicFeeFor(baseFeeNumerator)`: DBC's default periods, a maximum
/// variable fee of 20% of the base fee.
pub fn dynamic_fee_for(base_fee_numerator: u64) -> DynamicFeeParams {
    let max_volatility_accumulator: u32 = 14_460_000;
    let squared = u128::from(max_volatility_accumulator).pow(2);
    let target = u128::from(base_fee_numerator) * 20 / 100;
    DynamicFeeParams {
        bin_step: dbc::DYNAMIC_BIN_STEP,
        bin_step_u128: dbc::DYNAMIC_BIN_STEP_U128,
        filter_period: 10,
        decay_period: 120,
        reduction_factor: 5_000,
        max_volatility_accumulator,
        variable_fee_control: u32::try_from(target * dbc::VARIABLE_FEE_SCALE / squared).unwrap(),
    }
}

/// The preset's `LaunchParams` (the SDK's `preset(...).params`) with these
/// fee recipients.
pub fn preset_params(p: &Preset, recipients: &[(Pubkey, u16)]) -> LaunchParams {
    let (sqrt_start_price, curve) = design_curve(p);
    let cliff_fee_numerator = p.fee_bps * dbc::FEE_DENOMINATOR / BPS_DENOMINATOR;
    LaunchParams {
        token_decimal: TOKEN_DECIMAL,
        sqrt_start_price,
        curve,
        migration_quote_threshold: p.threshold_sol * LAMPORTS_PER_SOL,
        // Flat fee: no schedule.
        base_fee: BaseFeeParams {
            cliff_fee_numerator,
            first_factor: 0,
            second_factor: 0,
            third_factor: 0,
            base_fee_mode: dbc::BASE_FEE_MODE_LINEAR,
        },
        dynamic_fee: Some(dynamic_fee_for(cliff_fee_numerator)),
        migration_fee_option: p.migration_fee_option,
        open_delay_secs: p.open_delay_secs,
        guard_secs: p.guard_secs,
        max_wallet_bps: p.max_wallet_bps,
        max_buy_bps: p.max_buy_bps,
        p2p_locked: p.p2p_locked,
        batch_wallet_cap: p.batch_wallet_cap_sol * LAMPORTS_PER_SOL,
        batch_total_cap: 0,
        recipients: recipients
            .iter()
            .map(|&(wallet, bps)| FeeRecipient { wallet, bps })
            .collect(),
        pq_identity: super::pq::identity_id(),
    }
}

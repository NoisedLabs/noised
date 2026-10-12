use super::Lcg;
use crate::{
    constants::{dbc, EXECUTION_GRACE_SECS},
    policy::{
        exponential_fee, fee_schedule_duration, max_variable_fee_numerator, min_base_fee_numerator,
    },
    state::{BaseFeeParams, DynamicFeeParams},
};

fn fee(mode: u8, cliff: u64, periods: u16, frequency: u64, reduction: u64) -> BaseFeeParams {
    BaseFeeParams {
        cliff_fee_numerator: cliff,
        first_factor: periods,
        second_factor: frequency,
        third_factor: reduction,
        base_fee_mode: mode,
    }
}

#[test]
fn schedule_duration_is_periods_times_frequency() {
    assert_eq!(fee_schedule_duration(&fee(0, 1, 0, 0, 0)), Some(0));
    assert_eq!(fee_schedule_duration(&fee(0, 1, 10, 3, 1)), Some(30));
    assert_eq!(fee_schedule_duration(&fee(1, 1, 600, 3, 1)), Some(1_800));
    assert_eq!(
        fee_schedule_duration(&fee(0, 1, u16::MAX, u64::MAX, 1)),
        Some(u128::from(u16::MAX) * u128::from(u64::MAX)),
        "never overflows"
    );
}

/// The fee DBC charges at time `t` after activation, from its documented
/// rule: period = min(t / frequency, periods).
fn fee_at(f: &BaseFeeParams, t: u64) -> u64 {
    let period = t
        .checked_div(f.second_factor)
        .map_or(0, |p| p.min(u64::from(f.first_factor)));
    let at = BaseFeeParams {
        first_factor: period as u16,
        ..*f
    };
    min_base_fee_numerator(&at).unwrap()
}

#[test]
fn batch_at_end_of_open_delay_pays_the_floor() {
    let mut r = Lcg(5);
    for _ in 0..20_000 {
        let periods = 1 + r.below(100) as u16;
        let frequency = 1 + r.below(30);
        let open_delay = u64::from(periods) * frequency + r.below(5);
        let f = fee(0, 900_000_000, periods, frequency, 1_000_000);
        let floor = min_base_fee_numerator(&f).unwrap();
        // The batch executes no earlier than open_delay after activation,
        // anywhere in the execution window.
        for extra in [0, 1, u64::from(EXECUTION_GRACE_SECS) - 1] {
            assert_eq!(fee_at(&f, open_delay + extra), floor);
        }
        // One second before the schedule ends the fee is still above the floor.
        let end = u64::from(periods) * frequency;
        assert!(fee_at(&f, end - 1) > floor);
    }
}

#[test]
fn linear_floor() {
    assert_eq!(
        min_base_fee_numerator(&fee(0, 500_000_000, 10, 1, 49_000_000)),
        Some(10_000_000)
    );
    assert_eq!(
        min_base_fee_numerator(&fee(0, 500_000_000, 0, 0, 0)),
        Some(500_000_000)
    );
    assert_eq!(
        min_base_fee_numerator(&fee(0, 500_000_000, 10, 1, 50_000_001)),
        None
    );
    assert_eq!(
        min_base_fee_numerator(&fee(0, 1, u16::MAX, 1, u64::MAX)),
        None
    );
    assert_eq!(min_base_fee_numerator(&fee(2, 1, 0, 0, 0)), None);
}

#[test]
fn exponential_exact_values() {
    // No schedule: the cliff fee.
    assert_eq!(exponential_fee(123_456_789, 0, 0), Some(123_456_789));
    assert_eq!(exponential_fee(123_456_789, 5_000, 0), Some(123_456_789));
    // Halving is exact in binary fixed point.
    assert_eq!(exponential_fee(1_000_000_000, 5_000, 1), Some(500_000_000));
    assert_eq!(exponential_fee(1_000_000_000, 5_000, 2), Some(250_000_000));
    assert_eq!(exponential_fee(1_000_000_000, 5_000, 3), Some(125_000_000));
    assert_eq!(exponential_fee(1_000_000_000, 7_500, 2), Some(62_500_000));
    // Full reduction collapses to zero, which DBC treats as an error.
    assert_eq!(exponential_fee(1_000_000_000, 10_000, 1), None);
    assert_eq!(exponential_fee(1_000_000_000, 10_001, 1), None);
    // Underflow of the power to zero is an error too.
    assert_eq!(exponential_fee(990_000_000, 9_999, u16::MAX), None);
}

#[test]
fn exponential_matches_real_math_and_is_monotone() {
    let mut r = Lcg(77);
    for _ in 0..5_000 {
        let cliff = 2_500_000 + r.below(dbc::MAX_FEE_NUMERATOR - 2_500_000);
        let reduction = 1 + r.below(9_998);
        let periods = r.below(400) as u16;
        let Some(got) = exponential_fee(cliff, reduction, periods) else {
            continue;
        };
        let real = cliff as f64 * (1.0 - reduction as f64 / 10_000.0).powi(i32::from(periods));
        // Q64.64 floors lose < 1 unit per step; the fee is far coarser.
        assert!(
            (got as f64 - real).abs() <= 1.0 + real * 1e-9,
            "{cliff} {reduction} {periods}: {got} vs {real}"
        );
        if periods > 0 {
            let previous = exponential_fee(cliff, reduction, periods - 1).unwrap();
            assert!(got <= previous);
        }
    }
}

#[test]
fn exponential_floor_used_by_validation() {
    let f = fee(1, 500_000_000, 10, 1, 3_000);
    let floor = min_base_fee_numerator(&f).unwrap();
    let real = 500_000_000.0 * 0.7f64.powi(10);
    assert!((floor as f64 - real).abs() <= 1.0);
}

#[test]
fn variable_fee_at_volatility_cap() {
    let d = |va: u32, vfc: u32| DynamicFeeParams {
        bin_step: 1,
        bin_step_u128: dbc::DYNAMIC_BIN_STEP_U128,
        filter_period: 10,
        decay_period: 120,
        reduction_factor: 5_000,
        max_volatility_accumulator: va,
        variable_fee_control: vfc,
    };
    assert_eq!(max_variable_fee_numerator(&d(0, dbc::U24_MAX)), Some(0));
    assert_eq!(
        max_variable_fee_numerator(&d(1, 1)),
        Some(1),
        "DBC rounds up"
    );
    assert_eq!(max_variable_fee_numerator(&d(100_000, 10)), Some(1));
    assert_eq!(max_variable_fee_numerator(&d(1_000_000, 100)), Some(1_000));
    assert_eq!(
        max_variable_fee_numerator(&d(14_460_000, 956)),
        Some(1_998_916)
    );
    let max = max_variable_fee_numerator(&d(dbc::U24_MAX, dbc::U24_MAX)).unwrap();
    let exact = u128::from(dbc::U24_MAX).pow(3).div_ceil(100_000_000_000);
    assert_eq!(u128::from(max), exact);
}

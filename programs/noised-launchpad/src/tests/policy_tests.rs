use anchor_lang::prelude::*;

use super::{good_params, key};
use crate::{
    constants::{dbc, *},
    error::LaunchpadError,
    policy::{cap_from_bps, validate, validate_batch_caps, validate_metadata},
    state::{CurvePoint, DynamicFeeParams, FeeRecipient, LaunchParams},
};

const FORBIDDEN: [Pubkey; 2] = [
    Pubkey::new_from_array([0xA1; 32]),
    Pubkey::new_from_array([0xB2; 32]),
];

/// The error code a rejection carries, as `LaunchpadError as u32`.
fn check(p: &LaunchParams) -> std::result::Result<(), u32> {
    validate(p, &FORBIDDEN).map(|_| ()).map_err(code)
}

fn code(e: anchor_lang::error::Error) -> u32 {
    match e {
        anchor_lang::error::Error::AnchorError(a) => {
            a.error_code_number - anchor_lang::error::ERROR_CODE_OFFSET
        }
        other => panic!("unexpected error {other:?}"),
    }
}

fn with(f: impl FnOnce(&mut LaunchParams)) -> LaunchParams {
    let mut p = good_params();
    f(&mut p);
    p
}

fn accepts(f: impl FnOnce(&mut LaunchParams)) {
    let p = with(f);
    assert_eq!(check(&p), Ok(()), "{p:?}");
}

fn rejects(err: LaunchpadError, f: impl FnOnce(&mut LaunchParams)) {
    let p = with(f);
    let want = err as u32;
    assert_eq!(check(&p), Err(want), "{p:?}");
}

fn dynamic() -> DynamicFeeParams {
    DynamicFeeParams {
        bin_step: 1,
        bin_step_u128: dbc::DYNAMIC_BIN_STEP_U128,
        filter_period: 10,
        decay_period: 120,
        reduction_factor: 5_000,
        max_volatility_accumulator: 14_460_000,
        // ceil(14_460_000^2 * 956 / 1e11) = 1_998_916: ~0.2% on top of the floor.
        variable_fee_control: 956,
    }
}

#[test]
fn baseline_is_accepted_and_resolves_caps() {
    let v = validate(&good_params(), &FORBIDDEN).unwrap();
    assert_eq!(v.batch_total_cap, 85 * LAMPORTS_PER_SOL);
    assert_eq!(v.recipient_count, 2);
    assert_eq!(
        v.recipients[1],
        FeeRecipient {
            wallet: key(8),
            bps: 3_000
        }
    );
    assert_eq!(v.recipients[2], FeeRecipient::default());
    assert_eq!(v.floor_fee_numerator, 10_000_000);
    assert_eq!(v.max_dynamic_fee_numerator, 0);
}

#[test]
fn decimals_bounds() {
    rejects(LaunchpadError::InvalidDecimals, |p| p.token_decimal = 5);
    accepts(|p| p.token_decimal = 6);
    accepts(|p| p.token_decimal = 9);
    rejects(LaunchpadError::InvalidDecimals, |p| p.token_decimal = 10);
}

#[test]
fn threshold_bounds() {
    rejects(LaunchpadError::InvalidThreshold, |p| {
        p.migration_quote_threshold = MIN_THRESHOLD - 1
    });
    accepts(|p| p.migration_quote_threshold = MIN_THRESHOLD);
    accepts(|p| p.migration_quote_threshold = MAX_THRESHOLD);
    rejects(LaunchpadError::InvalidThreshold, |p| {
        p.migration_quote_threshold = MAX_THRESHOLD + 1
    });
    rejects(LaunchpadError::InvalidThreshold, |p| {
        p.migration_quote_threshold = 0
    });
}

#[test]
fn curve_bounds() {
    let point = |s: u128| CurvePoint {
        sqrt_price: s,
        liquidity: 1,
    };
    let max = crate::constants::MAX_CURVE_POINTS as u128;
    assert_eq!(max, 8);
    rejects(LaunchpadError::InvalidCurve, |p| p.curve.clear());
    accepts(|p| p.curve = (1..=max).map(|i| point((1u128 << 61) * i)).collect());
    rejects(LaunchpadError::InvalidCurve, |p| {
        p.curve = (1..=max + 1).map(|i| point((1u128 << 61) * i)).collect()
    });
    rejects(LaunchpadError::InvalidCurve, |p| {
        p.curve[0].sqrt_price = p.sqrt_start_price
    });
    accepts(|p| p.curve[0].sqrt_price = p.sqrt_start_price + 1);
    rejects(LaunchpadError::InvalidCurve, |p| {
        p.curve[1].sqrt_price = p.curve[0].sqrt_price
    });
    rejects(LaunchpadError::InvalidCurve, |p| {
        p.curve[1].sqrt_price = p.curve[0].sqrt_price - 1
    });
    rejects(LaunchpadError::InvalidCurve, |p| p.curve[0].liquidity = 0);
    rejects(LaunchpadError::InvalidCurve, |p| p.curve[1].liquidity = 0);
    accepts(|p| p.curve[1].sqrt_price = dbc::MAX_SQRT_PRICE);
    rejects(LaunchpadError::InvalidCurve, |p| {
        p.curve[1].sqrt_price = dbc::MAX_SQRT_PRICE + 1
    });
    rejects(LaunchpadError::InvalidCurve, |p| {
        p.sqrt_start_price = dbc::MIN_SQRT_PRICE - 1
    });
    accepts(|p| {
        p.sqrt_start_price = dbc::MIN_SQRT_PRICE;
        p.curve[0].sqrt_price = dbc::MIN_SQRT_PRICE + 1;
    });
    rejects(LaunchpadError::InvalidCurve, |p| {
        p.sqrt_start_price = dbc::MAX_SQRT_PRICE;
        p.curve = vec![point(dbc::MAX_SQRT_PRICE)];
    });
}

#[test]
fn migration_fee_option_bounds() {
    for option in 0..=5 {
        accepts(|p| p.migration_fee_option = option);
    }
    rejects(LaunchpadError::InvalidMigrationFeeOption, |p| {
        p.migration_fee_option = 6
    });
    rejects(LaunchpadError::InvalidMigrationFeeOption, |p| {
        p.migration_fee_option = 255
    });
}

#[test]
fn open_delay_bounds() {
    // Windows of seconds are refused (round 2: monopolizing the `Launch`
    // account's per-block write budget costs in proportion to the window).
    assert_eq!((MIN_OPEN_DELAY, EXECUTION_GRACE_SECS), (60, 600));
    for short in [0, 1, 10, 30, 59] {
        rejects(LaunchpadError::InvalidOpenDelay, |p| {
            p.open_delay_secs = short
        });
    }
    rejects(LaunchpadError::InvalidOpenDelay, |p| {
        p.open_delay_secs = MIN_OPEN_DELAY - 1
    });
    accepts(|p| {
        p.open_delay_secs = MIN_OPEN_DELAY;
        p.base_fee.first_factor = 10;
    });
    accepts(|p| p.open_delay_secs = MAX_OPEN_DELAY);
    rejects(LaunchpadError::InvalidOpenDelay, |p| {
        p.open_delay_secs = MAX_OPEN_DELAY + 1
    });
}

#[test]
fn guard_bounds() {
    // The shortest guard covers the commit window and the ten-minute
    // execution window: 60 + 600 seconds.
    rejects(LaunchpadError::InvalidGuard, |p| p.guard_secs = 659);
    accepts(|p| p.guard_secs = 660);
    rejects(LaunchpadError::InvalidGuard, |p| {
        p.guard_secs = p.open_delay_secs + EXECUTION_GRACE_SECS - 1
    });
    accepts(|p| p.guard_secs = p.open_delay_secs + EXECUTION_GRACE_SECS);
    accepts(|p| {
        p.open_delay_secs = MAX_OPEN_DELAY;
        p.guard_secs = MAX_OPEN_DELAY + EXECUTION_GRACE_SECS;
    });
    rejects(LaunchpadError::InvalidGuard, |p| {
        p.open_delay_secs = MAX_OPEN_DELAY;
        p.guard_secs = MAX_OPEN_DELAY + EXECUTION_GRACE_SECS - 1;
    });
    accepts(|p| p.guard_secs = MAX_GUARD_SECS);
    rejects(LaunchpadError::InvalidGuard, |p| {
        p.guard_secs = MAX_GUARD_SECS + 1
    });
    rejects(LaunchpadError::InvalidGuard, |p| p.guard_secs = 0);
}

#[test]
fn max_wallet_bounds() {
    accepts(|p| p.max_wallet_bps = 0);
    rejects(LaunchpadError::InvalidMaxWallet, |p| p.max_wallet_bps = 1);
    rejects(LaunchpadError::InvalidMaxWallet, |p| {
        p.max_wallet_bps = MIN_MAX_WALLET_BPS - 1
    });
    accepts(|p| p.max_wallet_bps = MIN_MAX_WALLET_BPS);
    accepts(|p| p.max_wallet_bps = 10_000);
    rejects(LaunchpadError::InvalidMaxWallet, |p| {
        p.max_wallet_bps = 10_001
    });
}

#[test]
fn max_buy_bounds() {
    accepts(|p| p.max_buy_bps = 0);
    accepts(|p| p.max_buy_bps = 1);
    accepts(|p| p.max_buy_bps = 10_000);
    rejects(LaunchpadError::InvalidMaxBuy, |p| p.max_buy_bps = 10_001);
}

#[test]
fn batch_cap_bounds() {
    let threshold = 85 * LAMPORTS_PER_SOL;
    assert_eq!(good_params().migration_quote_threshold, threshold);
    // Total cap: 0 (the threshold) or 10%..=100% of the threshold.
    accepts(|p| p.batch_total_cap = 0);
    accepts(|p| p.batch_total_cap = threshold);
    rejects(LaunchpadError::InvalidBatchCap, |p| {
        p.batch_total_cap = threshold + 1
    });
    accepts(|p| p.batch_total_cap = threshold - 1);
    accepts(|p| p.batch_total_cap = threshold / 10);
    accepts(|p| p.batch_total_cap = threshold / 10 + 1);
    rejects(LaunchpadError::InvalidBatchCap, |p| {
        p.batch_total_cap = threshold / 10 - 1
    });
    rejects(LaunchpadError::InvalidBatchCap, |p| p.batch_total_cap = 1);
    rejects(LaunchpadError::InvalidBatchCap, |p| {
        p.batch_total_cap = u64::MAX
    });
    let v = validate(&with(|p| p.batch_total_cap = threshold / 10), &FORBIDDEN).unwrap();
    assert_eq!(v.batch_total_cap, 8_500_000_000);
    let v = validate(&with(|p| p.batch_total_cap = 0), &FORBIDDEN).unwrap();
    assert_eq!(v.batch_total_cap, threshold);
    // Wallet cap: 0 (none) or at least 1/200 of the resolved total cap.
    accepts(|p| p.batch_wallet_cap = 0);
    accepts(|p| p.batch_wallet_cap = threshold / 200);
    accepts(|p| p.batch_wallet_cap = threshold / 200 + 1);
    rejects(LaunchpadError::InvalidBatchCap, |p| {
        p.batch_wallet_cap = threshold / 200 - 1
    });
    rejects(LaunchpadError::InvalidBatchCap, |p| p.batch_wallet_cap = 1);
    accepts(|p| p.batch_wallet_cap = u64::MAX);
    // Measured against the resolved total cap, not the threshold.
    accepts(|p| {
        p.batch_total_cap = threshold / 10;
        p.batch_wallet_cap = threshold / 2_000;
    });
    accepts(|p| {
        p.batch_total_cap = threshold / 10;
        p.batch_wallet_cap = threshold / 2_000 + 1;
    });
    rejects(LaunchpadError::InvalidBatchCap, |p| {
        p.batch_total_cap = threshold / 10;
        p.batch_wallet_cap = threshold / 2_000 - 1;
    });
    // A wallet cap above the total cap is allowed: it never binds.
    accepts(|p| {
        p.batch_total_cap = threshold / 10;
        p.batch_wallet_cap = threshold;
    });
    // Integer division: on a threshold that is not a multiple of 10 or 200
    // the floors round down.
    let odd = MIN_THRESHOLD + 1_999;
    assert_eq!(validate_batch_caps(odd, odd / 10, 0).unwrap(), odd / 10);
    assert!(validate_batch_caps(odd, odd / 10 - 1, 0).is_err());
    assert_eq!(validate_batch_caps(odd, 0, odd / 200).unwrap(), odd);
    assert!(validate_batch_caps(odd, 0, odd / 200 - 1).is_err());
}

/// The batch-cap floors against an independent statement of them, in u128
/// and without division: a non-zero total cap `c` needs `10c + 9 >=
/// threshold` (that is `c >= floor(threshold / 10)`) and `c <= threshold`;
/// a non-zero wallet cap `w` needs `200w + 199 >= resolved total cap`.
#[test]
fn batch_cap_floors_match_their_definition() {
    fn near(r: &mut super::Lcg, x: u64) -> u64 {
        x.saturating_sub(2) + r.below(5)
    }
    let mut r = super::Lcg(31);
    for _ in 0..200_000 {
        let threshold = MIN_THRESHOLD + r.below(MAX_THRESHOLD - MIN_THRESHOLD + 1);
        let total = match r.below(5) {
            0 => 0,
            1 => near(&mut r, threshold / 10),
            2 => near(&mut r, threshold),
            3 => r.below(threshold + 2),
            _ => r.next(),
        };
        let resolved = if total == 0 { threshold } else { total };
        let wallet = match r.below(4) {
            0 => 0,
            1 => near(&mut r, resolved / 200),
            2 => r.below(resolved.saturating_add(1)),
            _ => r.next(),
        };
        let (c, t, w) = (u128::from(threshold), u128::from(total), u128::from(wallet));
        let total_ok = total == 0 || (10 * t + 9 >= c && t <= c);
        let wallet_ok = wallet == 0 || 200 * w + 199 >= u128::from(resolved);
        let want = if total_ok && wallet_ok {
            Ok(())
        } else {
            Err(LaunchpadError::InvalidBatchCap as u32)
        };
        let got = validate_batch_caps(threshold, total, wallet).map_err(code);
        let case = format!("threshold {threshold}, total {total}, wallet {wallet}");
        assert_eq!(got.map(|_| ()), want, "{case}");
        if want.is_ok() {
            assert_eq!(
                validate_batch_caps(threshold, total, wallet).unwrap(),
                resolved
            );
        }
        // The whole policy decides the same, with the same error.
        let p = with(|p| {
            p.migration_quote_threshold = threshold;
            p.batch_total_cap = total;
            p.batch_wallet_cap = wallet;
        });
        assert_eq!(check(&p), want, "{case}");
    }
}

/// The SDK's presets still pass: commit windows of 60 s to 30 min, guards
/// covering the window plus the execution grace, and per-wallet caps of at
/// least 1/200 of the batch (community: 2 SOL of a 250 SOL batch).
#[test]
fn sdk_presets_pass_the_new_floors() {
    for (name, threshold_sol, open_delay, guard, wallet_sol) in [
        ("fair", 85, 300, 6 * 3_600, 5),
        ("community", 250, 1_800, 24 * 3_600, 2),
        ("turbo", 40, 60, 3_600, 0),
    ] {
        let p = with(|p| {
            p.migration_quote_threshold = threshold_sol * LAMPORTS_PER_SOL;
            p.open_delay_secs = open_delay;
            p.guard_secs = guard;
            p.batch_wallet_cap = wallet_sol * LAMPORTS_PER_SOL;
            p.batch_total_cap = 0;
        });
        assert_eq!(check(&p), Ok(()), "{name}");
    }
}

/// Every launch names a post-quantum identity: an all-zero `pq_identity`
/// (no key hashes to it) is refused, any other value is accepted (the
/// attestation proves the key behind it). The check runs after every other
/// rule, so a launch with other faults reports those first.
#[test]
fn pq_identity_must_be_named() {
    rejects(LaunchpadError::InvalidPqIdentity, |p| {
        p.pq_identity = [0; 32]
    });
    for i in 0..32 {
        accepts(|p| {
            p.pq_identity = [0; 32];
            p.pq_identity[i] = 1;
        });
    }
    accepts(|p| p.pq_identity = [0xFF; 32]);
    rejects(LaunchpadError::InvalidDecimals, |p| {
        p.pq_identity = [0; 32];
        p.token_decimal = 5;
    });
    rejects(LaunchpadError::InvalidRecipients, |p| {
        p.pq_identity = [0; 32];
        p.recipients.clear();
    });
}

#[test]
fn base_fee_mode_and_shape() {
    rejects(LaunchpadError::InvalidBaseFee, |p| {
        p.base_fee.base_fee_mode = 2
    });
    rejects(LaunchpadError::InvalidBaseFee, |p| {
        p.base_fee.base_fee_mode = 3
    });
    // Partially configured schedules are rejected (DBC InvalidFeeScheduler).
    rejects(LaunchpadError::InvalidBaseFee, |p| {
        p.base_fee.second_factor = 0
    });
    rejects(LaunchpadError::InvalidBaseFee, |p| {
        p.base_fee.first_factor = 0
    });
    rejects(LaunchpadError::InvalidBaseFee, |p| {
        p.base_fee.third_factor = 0
    });
    // Flat fee: no schedule at all.
    accepts(|p| {
        p.base_fee.cliff_fee_numerator = 10_000_000;
        p.base_fee.first_factor = 0;
        p.base_fee.second_factor = 0;
        p.base_fee.third_factor = 0;
    });
}

#[test]
fn base_fee_numerator_bounds() {
    // Floor exactly at DBC's 0.25% minimum.
    accepts(|p| p.base_fee.third_factor = (500_000_000 - dbc::MIN_FEE_NUMERATOR) / 10);
    rejects(LaunchpadError::InvalidBaseFee, |p| {
        p.base_fee.cliff_fee_numerator = dbc::MIN_FEE_NUMERATOR - 1;
        p.base_fee.first_factor = 0;
        p.base_fee.second_factor = 0;
        p.base_fee.third_factor = 0;
    });
    // Linear schedule that underflows below zero.
    rejects(LaunchpadError::InvalidBaseFee, |p| {
        p.base_fee.third_factor = 50_000_001
    });
    // Floor one below the minimum.
    rejects(LaunchpadError::InvalidBaseFee, |p| {
        p.base_fee.cliff_fee_numerator = 500_000_000;
        p.base_fee.third_factor = (500_000_000 - dbc::MIN_FEE_NUMERATOR) / 10 + 1;
    });
    // Cliff at and above DBC's 99% maximum.
    accepts(|p| {
        p.base_fee.cliff_fee_numerator = dbc::MAX_FEE_NUMERATOR;
        p.base_fee.third_factor = (dbc::MAX_FEE_NUMERATOR - 10_000_000) / 10;
    });
    rejects(LaunchpadError::InvalidBaseFee, |p| {
        p.base_fee.cliff_fee_numerator = dbc::MAX_FEE_NUMERATOR + 1;
        p.base_fee.third_factor = (dbc::MAX_FEE_NUMERATOR + 1 - 10_000_000) / 10;
    });
}

#[test]
fn exponential_base_fee() {
    // 50% decaying by 30% per period for 10 periods: ~1.41% floor.
    accepts(|p| {
        p.base_fee.base_fee_mode = 1;
        p.base_fee.third_factor = 3_000;
    });
    rejects(LaunchpadError::InvalidBaseFee, |p| {
        p.base_fee.base_fee_mode = 1;
        p.base_fee.third_factor = 10_000;
    });
    rejects(LaunchpadError::InvalidBaseFee, |p| {
        p.base_fee.base_fee_mode = 1;
        p.base_fee.third_factor = 10_001;
    });
    // Decays below 0.25%.
    rejects(LaunchpadError::InvalidBaseFee, |p| {
        p.base_fee.base_fee_mode = 1;
        p.base_fee.third_factor = 6_000;
    });
}

#[test]
fn fee_schedule_must_end_before_the_batch() {
    assert_eq!(good_params().open_delay_secs, 60);
    accepts(|p| {
        p.base_fee.first_factor = 10;
        p.base_fee.second_factor = 6;
    });
    rejects(LaunchpadError::FeeScheduleTooLong, |p| {
        p.base_fee.first_factor = 10;
        p.base_fee.second_factor = 7;
    });
    rejects(LaunchpadError::FeeScheduleTooLong, |p| {
        p.base_fee.first_factor = 1;
        p.base_fee.second_factor = u64::MAX;
        p.base_fee.third_factor = 1;
    });
    accepts(|p| {
        p.open_delay_secs = MAX_OPEN_DELAY;
        p.guard_secs = MAX_GUARD_SECS;
        p.base_fee.first_factor = 600;
        p.base_fee.second_factor = 3;
        p.base_fee.third_factor = 800_000;
    });
}

#[test]
fn fee_ceiling_applies_to_floor_plus_dynamic() {
    let flat = |p: &mut LaunchParams, numerator: u64| {
        p.base_fee.cliff_fee_numerator = numerator;
        p.base_fee.first_factor = 0;
        p.base_fee.second_factor = 0;
        p.base_fee.third_factor = 0;
    };
    accepts(|p| flat(p, 100_000_000));
    rejects(LaunchpadError::FeeTooHigh, |p| flat(p, 100_000_001));
    // 99% cliff decaying to 1%: the honeypot-free shape the batch exists for.
    accepts(|p| {
        p.base_fee.cliff_fee_numerator = 990_000_000;
        p.base_fee.third_factor = 98_000_000;
    });
    accepts(|p| {
        flat(p, 10_000_000);
        p.dynamic_fee = Some(dynamic());
    });
    rejects(LaunchpadError::FeeTooHigh, |p| {
        flat(p, 99_000_000);
        p.dynamic_fee = Some(dynamic());
    });
    rejects(LaunchpadError::FeeTooHigh, |p| {
        p.dynamic_fee = Some(DynamicFeeParams {
            variable_fee_control: dbc::U24_MAX,
            ..dynamic()
        });
    });
}

#[test]
fn dynamic_fee_mirrors_dbc() {
    let v = validate(&with(|p| p.dynamic_fee = Some(dynamic())), &FORBIDDEN).unwrap();
    assert_eq!(v.max_dynamic_fee_numerator, 1_998_916);
    let bad = |f: fn(&mut DynamicFeeParams)| {
        rejects(LaunchpadError::InvalidDynamicFee, move |p| {
            let mut d = dynamic();
            f(&mut d);
            p.dynamic_fee = Some(d);
        })
    };
    bad(|d| d.bin_step = 2);
    bad(|d| d.bin_step_u128 += 1);
    bad(|d| d.filter_period = d.decay_period);
    bad(|d| d.reduction_factor = 10_001);
    bad(|d| d.variable_fee_control = dbc::U24_MAX + 1);
    bad(|d| d.max_volatility_accumulator = dbc::U24_MAX + 1);
    accepts(|p| {
        p.dynamic_fee = Some(DynamicFeeParams {
            reduction_factor: 10_000,
            filter_period: 0,
            decay_period: 1,
            ..dynamic()
        })
    });
}

#[test]
fn recipients_bounds() {
    let r = |b: u8, bps: u16| FeeRecipient {
        wallet: key(b),
        bps,
    };
    rejects(LaunchpadError::InvalidRecipients, |p| p.recipients.clear());
    accepts(|p| p.recipients = vec![r(1, 10_000)]);
    accepts(|p| p.recipients = vec![r(1, 2_500), r(2, 2_500), r(3, 2_500), r(4, 2_500)]);
    rejects(LaunchpadError::InvalidRecipients, |p| {
        p.recipients = vec![
            r(1, 2_000),
            r(2, 2_000),
            r(3, 2_000),
            r(4, 2_000),
            r(5, 2_000),
        ]
    });
    rejects(LaunchpadError::InvalidRecipients, |p| {
        p.recipients = vec![r(1, 9_999)]
    });
    rejects(LaunchpadError::InvalidRecipients, |p| {
        p.recipients = vec![r(1, 10_001)]
    });
    rejects(LaunchpadError::InvalidRecipients, |p| {
        p.recipients = vec![r(1, 5_000), r(1, 5_000)]
    });
    rejects(LaunchpadError::InvalidRecipients, |p| {
        p.recipients = vec![r(0, 10_000)]
    });
    rejects(LaunchpadError::InvalidRecipients, |p| {
        p.recipients = vec![r(1, 10_000), r(2, 0)]
    });
    rejects(LaunchpadError::InvalidRecipients, |p| {
        p.recipients = vec![r(0xA1, 10_000)]
    });
    rejects(LaunchpadError::InvalidRecipients, |p| {
        p.recipients = vec![r(1, 5_000), r(0xB2, 5_000)]
    });
    rejects(LaunchpadError::InvalidRecipients, |p| {
        p.recipients = vec![r(1, u16::MAX), r(2, 10_000)]
    });
}

/// Name and symbol bounds of a metadata record (the uri and document rules
/// are in `metadata_tests`).
#[test]
fn metadata_bounds() {
    let n32 = "n".repeat(32);
    let s10 = "s".repeat(10);
    let u200 = format!("https://{}", "u".repeat(192));
    assert!(validate_metadata(&n32, &s10, 2, &u200, "").is_ok());
    assert!(validate_metadata("a", "b", 0, "", "").is_ok());
    assert!(validate_metadata("", "b", 0, "", "").is_err());
    assert!(validate_metadata("a", "", 0, "", "").is_err());
    assert!(validate_metadata(&"n".repeat(33), "b", 0, "", "").is_err());
    assert!(validate_metadata("a", &"s".repeat(11), 0, "", "").is_err());
    assert!(validate_metadata("a", "b", 2, &format!("{u200}u"), "").is_err());
}

#[test]
fn hook_caps_from_bps() {
    assert_eq!(cap_from_bps(1_000_000, 0), Some(0));
    assert_eq!(cap_from_bps(1_000_000, 10), Some(1_000));
    assert_eq!(cap_from_bps(1_000_000, 10_000), Some(1_000_000));
    assert_eq!(
        cap_from_bps(999, 10),
        None,
        "a non-zero cap must never round to 'off'"
    );
    assert_eq!(cap_from_bps(u64::MAX, 10_000), Some(u64::MAX));
    // The hook's own floors: max_wallet >= supply / 1000, max_buy >= supply / 10_000.
    let mut r = super::Lcg(3);
    for _ in 0..10_000 {
        let supply = r.next() | 1_000_000;
        let w = cap_from_bps(supply, MIN_MAX_WALLET_BPS).unwrap();
        assert!(w >= supply / 1_000);
        let b = cap_from_bps(supply, 1).unwrap();
        assert!(b >= supply / 10_000);
    }
}

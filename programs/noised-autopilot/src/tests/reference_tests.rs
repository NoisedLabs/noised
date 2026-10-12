//! The reference price and the observation window (`reference.rs`; review
//! finding F1): each rule at its edges, then properties over random
//! histories in which an attacker adds any observations it likes.

use super::*;
use crate::{
    constants::*,
    reference::{self, PriceState, Seen},
    state::ObsBucket,
};

const T0: i64 = 1_800_000_000 - 1_800_000_000 % OBS_BUCKET_SECS; // a bucket start
const R: u128 = 1u128 << 70;

fn empty() -> [ObsBucket; 2] {
    [ObsBucket::default(); 2]
}

#[test]
fn observations_keep_the_lowest_and_highest_per_bucket() {
    let mut o = empty();
    reference::observe(&mut o, T0 + 10, 500);
    let b0 = reference::bucket_of(T0);
    assert_eq!(
        o[0],
        ObsBucket {
            index: b0,
            first_at: T0 + 10,
            min: 500,
            max: 500
        }
    );
    assert!(o[1].is_empty());
    // The same bucket only widens; its first observation's time stays.
    reference::observe(&mut o, T0 + 20, 700);
    reference::observe(&mut o, T0 + 30, 400);
    reference::observe(&mut o, T0 + 899, 600);
    assert_eq!((o[0].min, o[0].max, o[0].first_at), (400, 700, T0 + 10));
    // A zero price is no observation.
    reference::observe(&mut o, T0 + 40, 0);
    assert_eq!((o[0].min, o[0].max), (400, 700));
    // The next bucket: the current one becomes the previous.
    reference::observe(&mut o, T0 + 900, 800);
    assert_eq!(o[1].index, b0);
    assert_eq!((o[1].min, o[1].max), (400, 700));
    assert_eq!(
        o[0],
        ObsBucket {
            index: b0 + 1,
            first_at: T0 + 900,
            min: 800,
            max: 800
        }
    );
    // A gap of a bucket or more forgets the old ones.
    reference::observe(&mut o, T0 + 2_700, 900);
    assert_eq!(o[0].index, b0 + 3);
    assert!(o[1].is_empty());
    // A clock that steps back records into the current bucket.
    reference::observe(&mut o, T0 + 100, 50);
    assert_eq!((o[0].index, o[0].min, o[0].max), (b0 + 3, 50, 900));
    // Buckets before 1970 too.
    let mut o = empty();
    reference::observe(&mut o, -1, 5);
    assert_eq!(o[0].index, -1);
}

#[test]
fn the_window_needs_a_minute_of_observations() {
    let mut o = empty();
    reference::observe(&mut o, T0 + 100, 500);
    // Alone, in the transaction that made it: nothing to go by.
    assert_eq!(reference::seen(&o, T0 + 100), None);
    assert_eq!(reference::seen(&o, T0 + 100 + OBS_MIN_SPAN_SECS - 1), None);
    let s = Seen { min: 500, max: 500 };
    assert_eq!(reference::seen(&o, T0 + 100 + OBS_MIN_SPAN_SECS), Some(s));
    // A later observation widens the window but does not restart the span.
    reference::observe(&mut o, T0 + 170, 300);
    assert_eq!(
        reference::seen(&o, T0 + 170),
        Some(Seen { min: 300, max: 500 })
    );
    // Into the next bucket the previous one still counts; one more and it
    // does not.
    assert_eq!(
        reference::seen(&o, T0 + 1_799),
        Some(Seen { min: 300, max: 500 })
    );
    assert_eq!(reference::seen(&o, T0 + 1_800), None);
    // Both buckets: their extremes, the span from the earlier one.
    reference::observe(&mut o, T0 + 950, 900);
    assert_eq!(
        reference::seen(&o, T0 + 950),
        Some(Seen { min: 300, max: 900 })
    );
    // The extremes of either bucket: the previous one's highest, the
    // current one's lowest.
    let mut o = empty();
    reference::observe(&mut o, T0 + 100, 700);
    reference::observe(&mut o, T0 + 950, 600);
    reference::observe(&mut o, T0 + 960, 650);
    assert_eq!(
        reference::seen(&o, T0 + 960),
        Some(Seen { min: 600, max: 700 })
    );
    // A previous bucket observed only at its end and a current one only at
    // its start: they span less than a minute.
    let mut o = empty();
    reference::observe(&mut o, T0 + 899, 500);
    reference::observe(&mut o, T0 + 900, 600);
    assert_eq!(reference::seen(&o, T0 + 900), None);
    assert_eq!(
        reference::seen(&o, T0 + 959),
        Some(Seen { min: 500, max: 600 })
    );
    assert_eq!(reference::seen(&empty(), T0), None);
}

#[test]
fn the_buyback_bound_is_the_lower_of_reference_and_observations() {
    let s = |min, max| Some(Seen { min, max });
    assert_eq!(reference::buyback_cap(R, None), None);
    assert_eq!(reference::buyback_cap(R, s(R / 2, R * 2)), Some(R / 2));
    assert_eq!(reference::buyback_cap(R, s(R * 2, R * 3)), Some(R));
    assert_eq!(reference::buyback_cap(R, s(R, R)), Some(R));
}

fn state(reference: u128, allowance: u64, at: i64) -> PriceState {
    PriceState {
        reference,
        updated_at: 0,
        allowance,
        allowance_at: at,
        observations: empty(),
    }
}

#[test]
fn the_reference_rises_from_an_allowance_only_rises_spend() {
    let up = |r: u128| r + r * u128::from(REF_ALLOWANCE_MAX) / REF_ALLOWANCE_SCALE;
    // A fresh autopilot has one hour's worth.
    let mut p = state(R, 0, 0);
    let all_above = Some(Seen {
        min: R * 2,
        max: R * 3,
    });
    assert!(reference::follow(&mut p, all_above, T0));
    assert_eq!(p.reference, up(R));
    assert_eq!(p.reference, R * 10_243 / 10_000);
    assert_eq!((p.updated_at, p.allowance_at), (T0, T0));
    assert!(p.allowance <= 1, "spent: {}", p.allowance);
    // Nothing more this second; the allowance refills at 243 sqrt-bps an
    // hour, by the second, however often anyone calls.
    let moved = p.reference;
    assert!(!reference::follow(&mut p, all_above, T0));
    assert_eq!(p.reference, moved);
    for t in 1..=60 {
        reference::follow(&mut p, None, T0 + t);
    }
    assert_eq!(p.allowance, p.allowance.min(REF_ALLOWANCE_MAX));
    let a = p.allowance;
    assert!((60 * REF_UP_SQRT_BPS_PER_HOUR..=60 * REF_UP_SQRT_BPS_PER_HOUR + 1).contains(&a));
    // A move toward observations that do not all agree spends nothing.
    let straddle = Some(Seen {
        min: moved - 1,
        max: moved * 2,
    });
    assert!(!reference::follow(&mut p, straddle, T0 + 60));
    assert_eq!((p.reference, p.allowance), (moved, a));
    // A rise within the allowance goes all the way and spends its cost.
    let target = moved + moved / 100_000; // 0.1 sqrt-bps
    assert!(reference::follow(
        &mut p,
        Some(Seen {
            min: target,
            max: target * 2
        }),
        T0 + 60
    ));
    assert_eq!(p.reference, target);
    assert_eq!(p.allowance, a - 360);
    // The allowance is capped at one hour's worth.
    reference::follow(&mut p, None, T0 + 100 * 3_600);
    assert_eq!(p.allowance, REF_ALLOWANCE_MAX);
    // And never accrues backwards.
    let mut q = state(R, 5, T0);
    reference::follow(&mut q, None, T0 - 10);
    assert_eq!((q.allowance, q.allowance_at), (5, T0));
}

#[test]
fn the_reference_falls_at_once_when_every_observation_is_below() {
    let mut p = state(R, 0, T0);
    assert!(reference::follow(
        &mut p,
        Some(Seen {
            min: R / 10,
            max: R / 3
        }),
        T0
    ));
    assert_eq!(p.reference, R / 3);
    assert_eq!(p.allowance, 0, "a fall spends no allowance");
    // Not while one observation is at or above it.
    assert!(!reference::follow(
        &mut p,
        Some(Seen {
            min: R / 10,
            max: R / 3
        }),
        T0 + 1
    ));
    assert!(!reference::follow(&mut p, None, T0 + 2));
}

#[test]
fn the_reference_never_overflows_or_moves_from_zero() {
    let mut p = state(u128::MAX, REF_ALLOWANCE_MAX, T0);
    assert!(!reference::follow(
        &mut p,
        Some(Seen {
            min: u128::MAX,
            max: u128::MAX
        }),
        T0
    ));
    let mut p = state(0, REF_ALLOWANCE_MAX, T0);
    assert!(!reference::follow(
        &mut p,
        Some(Seen { min: 5, max: 9 }),
        T0
    ));
    // The largest DAMM v2 price rises normally.
    let top = (1u128 << 96) - 1;
    let mut p = state(top, REF_ALLOWANCE_MAX, T0);
    assert!(reference::follow(
        &mut p,
        Some(Seen {
            min: u128::MAX,
            max: u128::MAX
        }),
        T0
    ));
    assert_eq!(p.reference, top + top * 243 / 10_000);
    // Times at the ends of i64.
    let mut p = state(R, 0, i64::MIN);
    reference::follow(&mut p, None, i64::MAX);
    assert_eq!(p.allowance, REF_ALLOWANCE_MAX);
}

/// An observation log of the model: (time, sqrt price).
fn window_min(log: &[(i64, u128)], now: i64) -> Option<u128> {
    let b = reference::bucket_of(now);
    log.iter()
        .filter(|(t, _)| reference::bucket_of(*t) >= b - 1)
        .map(|(_, s)| *s)
        .min()
}

#[test]
fn observations_nobody_can_outvote() {
    // Random histories: honest observations of a market price that moves,
    // and an attacker who adds as many observations as it likes, at any
    // price, any time (every one atomic, so free). After every step:
    //
    // 1. the bound a buyback would use is at most the lowest price anyone
    //    observed in the current and previous bucket, and at most the
    //    reference: an attacker's observations can never lift it above an
    //    honest one;
    // 2. no observation is usable in the second it was made, unless older
    //    ones in the window make it so;
    // 3. the reference rises at most by what the allowance allows (243
    //    sqrt-bps per hour, one hour banked), and only when every
    //    observation of the window is above it; it falls only when every
    //    one is below it, and never below the highest of them.
    let mut rng = Lcg(0xF1);
    let mut rises = 0;
    let mut falls = 0;
    for _history in 0..200 {
        let mut p = state(R, 0, 0);
        let mut log: Vec<(i64, u128)> = Vec::new();
        let mut now = T0 + rng.below(900) as i64;
        let mut market = R;
        for _ in 0..300 {
            now += [0, 1, 30, 59, 60, 300, 900, 3_600][rng.below(8) as usize];
            if rng.below(4) == 0 {
                // The market moves (up to 20% of price).
                let f = 9_000 + rng.below(2_000) as u128;
                market = (market * f / 10_000).clamp(1u128 << 50, 1u128 << 90);
            }
            let spot = if rng.below(3) == 0 {
                market
            } else {
                // The attacker, at any price.
                market * (1 + rng.below(4) as u128) / (1 + rng.below(2) as u128)
            };
            let before = p;
            reference::observe(&mut p.observations, now, spot);
            log.push((now, spot));
            // The lowest price of the window, however recent (audit 4, A4-4).
            assert_eq!(
                reference::lowest(&p.observations, now),
                window_min(&log, now)
            );
            let seen = reference::seen(&p.observations, now);
            // 1.
            if let Some(cap) = reference::buyback_cap(p.reference, seen) {
                assert!(cap <= p.reference);
                assert!(cap <= window_min(&log, now).unwrap());
            }
            // 2.
            let in_window: Vec<i64> = log
                .iter()
                .filter(|(t, _)| reference::bucket_of(*t) >= reference::bucket_of(now) - 1)
                .map(|(t, _)| *t)
                .collect();
            let span_ok = in_window
                .iter()
                .min()
                .is_some_and(|t| now - t >= OBS_MIN_SPAN_SECS);
            // The model keeps every bucket since the last gap; the program
            // keeps two, and agrees on the window.
            assert_eq!(seen.is_some(), span_ok, "window at {now}");
            if let Some(s) = seen {
                assert_eq!(s.min, window_min(&log, now).unwrap());
                let b = reference::bucket_of(now);
                let window_max = log
                    .iter()
                    .filter(|(t, _)| reference::bucket_of(*t) >= b - 1)
                    .map(|(_, s)| *s)
                    .max()
                    .unwrap();
                assert_eq!(s.max, window_max);
            }
            // 3.
            let mut q = before;
            q.observations = p.observations;
            let allowance_before = {
                let mut a = q;
                reference::follow(&mut a, None, now);
                a.allowance
            };
            let moved = reference::follow(&mut q, seen, now);
            if q.reference > before.reference {
                rises += 1;
                let s = seen.unwrap();
                assert!(s.min > before.reference);
                assert!(q.reference <= s.min);
                let r = before.reference;
                assert!(q.reference <= r + r * u128::from(allowance_before) / REF_ALLOWANCE_SCALE);
                let cost = (q.reference - r) * REF_ALLOWANCE_SCALE / r;
                assert!(u128::from(allowance_before - q.allowance) >= cost);
            } else if q.reference < before.reference {
                falls += 1;
                let s = seen.unwrap();
                assert!(s.max < before.reference);
                assert_eq!(q.reference, s.max);
            } else {
                assert!(!moved);
            }
            p = q;
        }
    }
    assert!(rises > 100 && falls > 100, "rises {rises}, falls {falls}");
}

#[test]
fn a_walk_is_at_most_five_percent_an_hour() {
    // The attacker makes every observation, always pumped far above the
    // reference, as often as it likes: the reference still rises at most
    // e^0.0243 < 1.0246 (sqrt) per hour, plus the one hour banked, however
    // finely it splits the rise.
    let mut p = state(R, 0, 0);
    let mut now = T0;
    for _ in 0..(24 * 60) {
        now += 60;
        reference::observe(&mut p.observations, now, p.reference * 10);
        let seen = reference::seen(&p.observations, now);
        reference::follow(&mut p, seen, now);
    }
    let hours = 24.0;
    let max = (R as f64) * 1.0246f64.powf(hours + 1.0);
    assert!((p.reference as f64) <= max, "{} > {max}", p.reference);
    let exact = (R as f64) * (0.0243f64 * (hours + 1.0)).exp();
    assert!((p.reference as f64) <= exact, "{} > {exact}", p.reference);
    // It did walk: the bound is not slack by much (rounding only).
    assert!((p.reference as f64) >= (R as f64) * (0.0243f64 * (hours - 1.0)).exp());
    // One honest observation stops it and caps every buyback at the market.
    let walked = p.reference;
    now += 60;
    reference::observe(&mut p.observations, now, R);
    let seen = reference::seen(&p.observations, now);
    assert!(!reference::follow(&mut p, seen, now));
    assert_eq!(p.reference, walked);
    assert_eq!(reference::buyback_cap(p.reference, seen), Some(R));
}

#[test]
fn a_single_transaction_moves_nothing() {
    // Review F1b: one atomic [pump, observe, dump] per hour, nothing else:
    // each observation is alone in its window when made, so the reference
    // never moves and no buyback can be priced from it.
    let mut p = state(R, 0, 0);
    let mut now = T0;
    for _ in 0..24 {
        now += 3_600;
        reference::observe(&mut p.observations, now, R * 2);
        let seen = reference::seen(&p.observations, now);
        assert_eq!(seen, None);
        assert!(!reference::follow(&mut p, seen, now));
        assert_eq!(reference::buyback_cap(p.reference, seen), None);
    }
    assert_eq!(p.reference, R);
}

/// Audit 4, A4-4: the lowest price of the window (current and previous
/// bucket), with no minimum span: a burn's value only ever goes down with it.
#[test]
fn the_lowest_price_of_the_window_needs_no_span() {
    let mut o = empty();
    assert_eq!(reference::lowest(&o, T0), None);
    // An empty bucket is no observation, wherever the clock is.
    assert_eq!(reference::lowest(&o, 0), None);
    assert_eq!(reference::lowest(&o, -1), None);
    reference::observe(&mut o, T0 + 10, 500);
    // At once, though `seen` needs a minute.
    assert_eq!(reference::lowest(&o, T0 + 10), Some(500));
    assert_eq!(reference::seen(&o, T0 + 10), None);
    reference::observe(&mut o, T0 + 900, 800);
    assert_eq!(reference::lowest(&o, T0 + 900), Some(500));
    reference::observe(&mut o, T0 + 901, 300);
    assert_eq!(reference::lowest(&o, T0 + 901), Some(300));
    // The previous bucket leaves the window, then the current one.
    let mut o = empty();
    reference::observe(&mut o, T0 + 10, 500);
    reference::observe(&mut o, T0 + 900, 800);
    assert_eq!(reference::lowest(&o, T0 + 1_799), Some(500));
    assert_eq!(reference::lowest(&o, T0 + 1_800), Some(800));
    assert_eq!(reference::lowest(&o, T0 + 2_699), Some(800));
    assert_eq!(reference::lowest(&o, T0 + 2_700), None);
}

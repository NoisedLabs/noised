//! The reference price and the observations of the pool price it follows
//! (spec §4 "Buyback MEV bound"), as pure functions of the stored state.
//!
//! A pool price can be moved for the length of one transaction (or one
//! bundle) for the cost of the pool's fees, but not held away from the
//! market for a minute without others trading against it. Nothing here
//! therefore trusts a price seen in one transaction alone:
//!
//! * Observations: `update_price` (anyone, any time, free) and every run
//!   record the pool's price. Per bucket of `OBS_BUCKET_SECS` only the
//!   lowest and the highest price observed are kept, so extra observations
//!   can never hide another one: the window holds the lowest price anyone
//!   saw ([`observe`]).
//! * The window is the current and the previous bucket (the last 15 to 30
//!   minutes), usable only once its observations span `OBS_MIN_SPAN_SECS`
//!   ([`seen`]).
//! * A buyback is priced from the lower of the reference and the lowest
//!   price observed in the window ([`buyback_cap`]): after the market
//!   falls, one observation by anyone bounds every buyback from a minute
//!   later, and a stale reference alone never prices one.
//! * The reference (what price conditions read) moves only to the edge of
//!   the window: up toward its lowest price when every observation in it is
//!   above the reference, by at most 5% per hour from an allowance that only
//!   rises spend; down to its highest price when every observation is below
//!   it, at once ([`follow`]).
//!
//! Residual: an attacker who is the only one to observe the pool for a whole
//! window can (a) after a market fall nobody observed, price a buyback at
//! the lowest price of the last 15 to 30 minutes, and (b) walk the reference
//! up by at most 5% an hour by keeping every observation pumped, each pump
//! paying the pool's fees both ways. One honest observation per window
//! (every keeper run is one; `update_price` is free) closes both. Against
//! the price it is bounded by, a sandwich gains at most about
//! `premium * amount` (`price.rs`).
//!
//! The same rule that lets one honest observation protect the treasury lets
//! one dumped observation hold buybacks back: a party that dumps the pool in
//! an observation every 15 minutes (paying the pool's fees both ways each
//! time) keeps the bound low, so buybacks wait. That is liveness only: the
//! treasury keeps its SOL, and nothing leaves it at a worse price.

use crate::{
    constants::{
        OBS_BUCKET_SECS, OBS_MIN_SPAN_SECS, REF_ALLOWANCE_MAX, REF_ALLOWANCE_SCALE,
        REF_UP_SQRT_BPS_PER_HOUR,
    },
    state::ObsBucket,
};

/// The reference price and the observations, as stored in `Autopilot`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PriceState {
    /// The reference sqrt price (Q64.64).
    pub reference: u128,
    /// When it last moved.
    pub updated_at: i64,
    /// The rise allowance in sqrt-bps-seconds, and when it last accrued.
    pub allowance: u64,
    pub allowance_at: i64,
    /// The current bucket, then the previous one.
    pub observations: [ObsBucket; 2],
}

/// The lowest and highest sqrt price observed in the window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Seen {
    pub min: u128,
    pub max: u128,
}

/// The observation bucket of a unix time.
pub fn bucket_of(now: i64) -> i64 {
    now.div_euclid(OBS_BUCKET_SECS)
}

/// Record an observation of the pool's sqrt price `spot` at `now` (a zero
/// price is no observation). The current bucket only widens; a new bucket
/// keeps the current one as the previous if they are adjacent. A clock
/// that steps back records into the current bucket.
pub fn observe(observations: &mut [ObsBucket; 2], now: i64, spot: u128) {
    if spot == 0 {
        return;
    }
    let index = bucket_of(now);
    let [current, previous] = observations;
    if !current.is_empty() && index <= current.index {
        current.min = current.min.min(spot);
        current.max = current.max.max(spot);
        return;
    }
    *previous = if !current.is_empty() && current.index.checked_add(1) == Some(index) {
        *current
    } else {
        ObsBucket::default()
    };
    *current = ObsBucket {
        index,
        first_at: now,
        min: spot,
        max: spot,
    };
}

/// The lowest and highest price observed in the current and the previous
/// bucket at `now`, if those observations span at least
/// `OBS_MIN_SPAN_SECS` (the earliest of them is at least that old).
pub fn seen(observations: &[ObsBucket; 2], now: i64) -> Option<Seen> {
    let oldest_counted = bucket_of(now).saturating_sub(1);
    let mut window: Option<(Seen, i64)> = None;
    for b in observations {
        if b.is_empty() || b.index < oldest_counted {
            continue;
        }
        window = Some(match window {
            None => (
                Seen {
                    min: b.min,
                    max: b.max,
                },
                b.first_at,
            ),
            Some((s, first)) => (
                Seen {
                    min: s.min.min(b.min),
                    max: s.max.max(b.max),
                },
                first.min(b.first_at),
            ),
        });
    }
    let (s, first) = window?;
    (now.saturating_sub(first) >= OBS_MIN_SPAN_SECS).then_some(s)
}

/// The sqrt price a buyback is bounded by: the lower of the reference and
/// the lowest price observed in the window; `None` without a usable window.
pub fn buyback_cap(reference: u128, seen: Option<Seen>) -> Option<u128> {
    seen.map(|s| reference.min(s.min))
}

/// The lowest price observed in the current and the previous bucket at
/// `now`, however recent (a burn's value, audit 4, A4-4: a lower price only
/// ever lowers a tip, so no observation needs to be a minute old); `None`
/// without one.
pub fn lowest(observations: &[ObsBucket; 2], now: i64) -> Option<u128> {
    let oldest_counted = bucket_of(now).saturating_sub(1);
    observations
        .iter()
        .filter(|b| !b.is_empty() && b.index >= oldest_counted)
        .map(|b| b.min)
        .min()
}

/// Accrue the rise allowance up to `now`: `REF_UP_SQRT_BPS_PER_HOUR` per
/// hour, exactly per second, capped at one hour's worth.
fn accrue(p: &mut PriceState, now: i64) {
    if now <= p.allowance_at {
        return;
    }
    let elapsed = u64::try_from(i128::from(now) - i128::from(p.allowance_at)).unwrap_or(u64::MAX);
    p.allowance = p
        .allowance
        .saturating_add(elapsed.saturating_mul(REF_UP_SQRT_BPS_PER_HOUR))
        .min(REF_ALLOWANCE_MAX);
    p.allowance_at = now;
}

/// Accrue the allowance, then move the reference to the nearest edge of
/// what the window saw: up toward its lowest price if every observation is
/// above the reference (at most what the allowance allows, which the rise
/// spends), down to its highest price if every observation is below it.
/// Returns whether it moved.
pub fn follow(p: &mut PriceState, seen: Option<Seen>, now: i64) -> bool {
    accrue(p, now);
    let Some(s) = seen else {
        return false;
    };
    let r = p.reference;
    let target = if s.min > r {
        // `r * allowance` fits for any DAMM v2 price (< 2^96); beyond, no rise.
        let Some(step) = r.checked_mul(u128::from(p.allowance)) else {
            return false;
        };
        let new = s.min.min(r.saturating_add(step / REF_ALLOWANCE_SCALE));
        if new <= r {
            return false;
        }
        // What the rise spends, rounded up (at most the allowance, give or
        // take that rounding).
        let Some(cost) = (new - r).checked_mul(REF_ALLOWANCE_SCALE) else {
            return false;
        };
        let cost = u64::try_from(cost.div_ceil(r)).unwrap_or(u64::MAX);
        p.allowance = p.allowance.saturating_sub(cost);
        new
    } else if s.max < r {
        s.max
    } else {
        return false;
    };
    p.reference = target;
    p.updated_at = now;
    true
}

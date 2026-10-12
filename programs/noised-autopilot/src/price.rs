//! Buyback price bounds (spec §4 "Buyback MEV bound"), exact integer math on
//! Q64.64 sqrt prices.
//!
//! DAMM v2 prices are `sqrt_price = sqrt(B per A) * 2^64` with A the token
//! and B wSOL, both in raw units, and `sqrt_price < 2^96`. The price itself
//! in Q64.64 is `floor(sqrt_price^2 / 2^64)` ([`price_q64`]). A buyback of
//! `amount_in` lamports at price `p` buys `amount_in * 2^64 / p` raw token
//! units before fees.
//!
//! * [`within_premium`]: the pool price is at most `premium_bps` above the
//!   price a buyback is bounded by (`reference::buyback_cap`).
//! * [`min_out`]: the least the swap must return, priced at that bound plus
//!   the premium. A sandwich around a buyback therefore gains at most about
//!   `premium * amount_in` against that bound.
//! * [`token_value`]: tokens in lamports at a price (tips of burns).
//!
//! Rounding always favours the treasury: prices round down (so `min_out`
//! rounds up through the division by the price, and only its final
//! divisions round it down, by at most 2 raw units in total).

use crate::constants::BPS_DENOMINATOR;

/// `a * b` as a 256-bit `(high, low)` pair.
pub fn mul_wide(a: u128, b: u128) -> (u128, u128) {
    const MASK: u128 = u64::MAX as u128;
    let (a1, a0) = (a >> 64, a & MASK);
    let (b1, b0) = (b >> 64, b & MASK);
    let p00 = a0 * b0;
    let p01 = a0 * b1;
    let p10 = a1 * b0;
    let p11 = a1 * b1;
    // Middle column: at most 3 * (2^64 - 1) < 2^66, no overflow in u128.
    let mid = (p00 >> 64) + (p01 & MASK) + (p10 & MASK);
    let low = (p00 & MASK) | (mid << 64);
    let high = p11 + (p01 >> 64) + (p10 >> 64) + (mid >> 64);
    (high, low)
}

/// `floor(sqrt_price^2 / 2^64)`: the Q64.64 price, `None` if it does not fit
/// in 128 bits (`sqrt_price >= 2^96`, above DAMM v2's range).
pub fn price_q64(sqrt_price: u128) -> Option<u128> {
    let (high, low) = mul_wide(sqrt_price, sqrt_price);
    if high >> 64 != 0 {
        return None;
    }
    Some((high << 64) | (low >> 64))
}

/// Whether the pool price is at most `premium_bps` above the reference:
/// `spot * 10_000 <= reference * (10_000 + premium_bps)`, prices in Q64.64.
/// `false` when either price is out of range.
pub fn within_premium(spot_sqrt: u128, ref_sqrt: u128, premium_bps: u64) -> bool {
    let (Some(spot), Some(reference)) = (price_q64(spot_sqrt), price_q64(ref_sqrt)) else {
        return false;
    };
    let lhs = mul_wide(spot, u128::from(BPS_DENOMINATOR));
    let rhs = mul_wide(
        reference,
        u128::from(BPS_DENOMINATOR) + u128::from(premium_bps),
    );
    lhs <= rhs
}

/// The least a buyback of `amount_in` lamports may return:
/// `floor(floor(amount_in * 2^64 / reference) * 10_000 / (10_000 + premium_bps))`.
/// `None` when the reference price rounds to zero or the bound does not fit
/// in a token amount (no swap could satisfy it).
pub fn min_out(amount_in: u64, ref_sqrt: u128, premium_bps: u64) -> Option<u64> {
    let reference = price_q64(ref_sqrt)?;
    if reference == 0 {
        return None;
    }
    let at_reference = (u128::from(amount_in) << 64) / reference;
    let at_reference = u64::try_from(at_reference).ok()?;
    let bound = u128::from(at_reference) * u128::from(BPS_DENOMINATOR)
        / (u128::from(BPS_DENOMINATOR) + u128::from(premium_bps));
    u64::try_from(bound).ok()
}

/// The value in lamports of `amount` raw tokens at the sqrt price
/// `sqrt_price`: `floor(amount * price_q64 / 2^64)`, saturating; 0 when the
/// price is out of range (what a tip is a share of, `logic::take_tip`).
pub fn token_value(amount: u64, sqrt_price: u128) -> u64 {
    let Some(price) = price_q64(sqrt_price) else {
        return 0;
    };
    // amount < 2^64 and price < 2^128: the product is below 2^192, so
    // `high < 2^64` and the shifted value fits in 128 bits.
    let (high, low) = mul_wide(u128::from(amount), price);
    u64::try_from((high << 64) | (low >> 64)).unwrap_or(u64::MAX)
}

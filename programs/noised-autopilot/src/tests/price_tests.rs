//! The buyback price bounds against an exact 256-bit reference.

use super::*;
use crate::price;

/// A 256-bit unsigned integer, four little-endian u64 limbs: the test's
/// own arithmetic, independent of `price::mul_wide`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct U256([u64; 4]);

impl U256 {
    const ZERO: U256 = U256([0; 4]);

    fn from(x: u128) -> Self {
        U256([x as u64, (x >> 64) as u64, 0, 0])
    }

    fn mul(self, other: U256) -> U256 {
        let mut out = [0u64; 8];
        for i in 0..4 {
            let mut carry = 0u128;
            for j in 0..4 {
                let cur =
                    u128::from(out[i + j]) + u128::from(self.0[i]) * u128::from(other.0[j]) + carry;
                out[i + j] = cur as u64;
                carry = cur >> 64;
            }
            out[i + 4] = carry as u64;
        }
        assert!(out[4..].iter().all(|l| *l == 0), "U256 overflow");
        U256([out[0], out[1], out[2], out[3]])
    }

    fn shl(self, n: u32) -> U256 {
        let mut x = self;
        for _ in 0..n {
            assert!(x.0[3] >> 63 == 0, "U256 shl overflow");
            x.0[3] = (x.0[3] << 1) | (x.0[2] >> 63);
            x.0[2] = (x.0[2] << 1) | (x.0[1] >> 63);
            x.0[1] = (x.0[1] << 1) | (x.0[0] >> 63);
            x.0[0] <<= 1;
        }
        x
    }

    fn bit(self, i: usize) -> bool {
        (self.0[i / 64] >> (i % 64)) & 1 == 1
    }

    fn lt(self, other: U256) -> bool {
        for i in (0..4).rev() {
            if self.0[i] != other.0[i] {
                return self.0[i] < other.0[i];
            }
        }
        false
    }

    fn sub(self, other: U256) -> U256 {
        let mut out = [0u64; 4];
        let mut borrow = 0u64;
        for (i, o) in out.iter_mut().enumerate() {
            let (d, b1) = self.0[i].overflowing_sub(other.0[i]);
            let (d, b2) = d.overflowing_sub(borrow);
            *o = d;
            borrow = u64::from(b1 || b2);
        }
        assert_eq!(borrow, 0, "U256 underflow");
        U256(out)
    }

    /// Floor division, bit by bit.
    fn div(self, d: U256) -> U256 {
        assert!(d != U256::ZERO);
        let mut q = U256::ZERO;
        let mut r = U256::ZERO;
        for i in (0..256).rev() {
            r = r.shl(1);
            if self.bit(i) {
                r.0[0] |= 1;
            }
            if !r.lt(d) {
                r = r.sub(d);
                q.0[i / 64] |= 1 << (i % 64);
            }
        }
        q
    }

    fn to_u128(self) -> Option<u128> {
        (self.0[2] == 0 && self.0[3] == 0)
            .then(|| u128::from(self.0[0]) | (u128::from(self.0[1]) << 64))
    }
}

#[test]
fn mul_wide_is_the_full_product() {
    let mut rng = Lcg(1);
    let edges = [
        0,
        1,
        2,
        u64::MAX as u128,
        1u128 << 64,
        u128::MAX - 1,
        u128::MAX,
    ];
    let mut pairs: Vec<(u128, u128)> = edges
        .iter()
        .flat_map(|a| edges.iter().map(move |b| (*a, *b)))
        .collect();
    for _ in 0..20_000 {
        pairs.push((rng.bits128(128), rng.bits128(128)));
    }
    for (a, b) in pairs {
        let (high, low) = price::mul_wide(a, b);
        let want = U256::from(a).mul(U256::from(b));
        assert_eq!(
            [
                low as u64,
                (low >> 64) as u64,
                high as u64,
                (high >> 64) as u64
            ],
            want.0,
            "{a} * {b}"
        );
    }
}

#[test]
fn price_q64_floors_the_square() {
    let mut rng = Lcg(2);
    for _ in 0..20_000 {
        let s = rng.bits128(97);
        let want = U256::from(s)
            .mul(U256::from(s))
            .div(U256::from(1u128 << 64).mul(U256::from(1)));
        assert_eq!(price::price_q64(s), want.to_u128(), "sqrt {s}");
    }
    // In range up to (but excluding) 2^96; DAMM v2's max sqrt price is below.
    assert_eq!(price::price_q64(1u128 << 64), Some(1u128 << 64));
    assert_eq!(
        price::price_q64((1u128 << 96) - 1).map(|p| p >> 127),
        Some(1)
    );
    assert_eq!(price::price_q64(1u128 << 96), None);
    assert_eq!(price::price_q64(u128::MAX), None);
    assert!(price::price_q64(79_226_673_521_066_979_257_578_248_091).is_some());
    assert_eq!(price::price_q64(0), Some(0));
    // Below 2^32 the price rounds to zero.
    assert_eq!(price::price_q64((1u128 << 32) - 1), Some(0));
    assert_eq!(price::price_q64(1u128 << 32), Some(1));
}

/// Exact: spot^2 * 10_000 <= ref^2 * (10_000 + premium)?
fn within_exact(spot: u128, reference: u128, premium: u64) -> bool {
    let lhs = U256::from(spot)
        .mul(U256::from(spot))
        .mul(U256::from(10_000));
    let rhs = U256::from(reference)
        .mul(U256::from(reference))
        .mul(U256::from(10_000 + u128::from(premium)));
    !rhs.lt(lhs)
}

#[test]
fn within_premium_is_exact_away_from_rounding() {
    let mut rng = Lcg(3);
    let mut checked = 0;
    for _ in 0..50_000 {
        // Sqrt prices up to 2^80 (prices up to 2^32) and any premium.
        let reference = rng.bits128(80).max(1u128 << 40);
        let premium = rng.below(2_001);
        let spot = match rng.below(3) {
            0 => rng.bits128(80),
            // Near the boundary: within +-0.1% of sqrt(1 + premium).
            _ => {
                let f = 1.0 + premium as f64 / 10_000.0;
                let s = reference as f64 * f.sqrt() * (0.999 + rng.below(2_001) as f64 * 1e-6);
                s as u128
            }
        };
        let ours = price::within_premium(spot, reference, premium);
        let exact = within_exact(spot, reference, premium);
        if ours != exact {
            // Only the two floors of `price_q64` may flip the answer, and
            // only within one Q64.64 unit of each price.
            let ps = price::price_q64(spot).unwrap();
            let pr = price::price_q64(reference).unwrap();
            let gap = (ps as i128 * 10_000) - (pr as i128 * (10_000 + premium as i128));
            assert!(
                gap.abs() <= 10_000 + 2_000,
                "spot {spot} ref {reference} prem {premium}"
            );
        } else {
            checked += 1;
        }
    }
    assert!(checked > 49_000);
    // Edges: equal prices are within any premium; the exact boundary.
    let r = 1u128 << 70;
    assert!(price::within_premium(r, r, 0));
    assert!(!price::within_premium(r + (1 << 10), r, 0));
    assert!(price::within_premium(r - 1, r, 0));
    // sqrt(1.0404) = 1.02: a 2% sqrt move is 4.04% of price.
    let up = r / 100 * 102;
    assert!(price::within_premium(up, r, 404));
    assert!(!price::within_premium(up, r, 403));
    // Out of range: never within.
    assert!(!price::within_premium(1u128 << 96, r, 2_000));
    assert!(!price::within_premium(r, 1u128 << 96, 2_000));
}

/// Exact: floor(amount * 2^128 * 10_000 / (ref^2 * (10_000 + premium))).
fn min_out_exact(amount: u64, reference: u128, premium: u64) -> U256 {
    let num = U256::from(u128::from(amount))
        .shl(128)
        .mul(U256::from(10_000));
    let den = U256::from(reference)
        .mul(U256::from(reference))
        .mul(U256::from(10_000 + u128::from(premium)));
    num.div(den)
}

#[test]
fn min_out_never_undercuts_the_exact_bound() {
    let mut rng = Lcg(4);
    for i in 0..30_000 {
        let amount = if i % 7 == 0 {
            u64::MAX
        } else {
            rng.bits128(64) as u64
        };
        let reference = rng.bits128(96).max(1u128 << 32);
        let premium = rng.below(2_001);
        let exact = min_out_exact(amount, reference, premium);
        match price::min_out(amount, reference, premium) {
            Some(m) => {
                let exact = exact.to_u128().expect("fits when ours does");
                // Never more lenient than the exact bound (beyond 2 units of
                // the two final floors) ...
                assert!(
                    u128::from(m) + 2 >= exact,
                    "amount {amount} ref {reference} p {premium}: {m} < {exact}"
                );
                // ... and stricter only by the price's rounding, negligible
                // once the price is at least 2^40 (Q64.64).
                if price::price_q64(reference).unwrap() >= 1u128 << 40 {
                    assert!(u128::from(m) <= exact + exact / (1u128 << 39) + 2);
                }
            }
            None => {
                // Only when the reference price rounds to zero or the bound
                // exceeds any token amount.
                // (A coarse price, below 2^8 in Q64.64, rounds the bound
                // up by up to 2x.)
                let p = price::price_q64(reference);
                assert!(
                    p.is_none_or(|p| p < 256)
                        || exact.to_u128().is_none_or(|e| e > u128::from(u64::MAX) / 2),
                    "amount {amount} ref {reference}"
                );
            }
        }
    }
}

#[test]
fn min_out_edges_and_monotonicity() {
    let one = 1u128 << 64; // price 1 lamport per raw unit
    assert_eq!(price::min_out(1_000_000, one, 0), Some(1_000_000));
    assert_eq!(price::min_out(1_000_000, one, 2_000), Some(833_333));
    assert_eq!(price::min_out(1_000_000, one, 1), Some(999_900));
    // Price 4 (sqrt 2): a quarter.
    assert_eq!(price::min_out(1_000_000, 2 * one, 0), Some(250_000));
    assert_eq!(price::min_out(0, one, 0), Some(0));
    // A reference price rounding to zero cannot bound anything.
    assert_eq!(price::min_out(1, (1u128 << 32) - 1, 0), None);
    // A bound above u64::MAX: no swap can meet it.
    assert_eq!(price::min_out(u64::MAX, 1u128 << 32, 0), None);
    assert_eq!(price::min_out(5, 1u128 << 96, 0), None);
    let mut rng = Lcg(5);
    for _ in 0..10_000 {
        let a = rng.bits128(60) as u64;
        let r = rng.bits128(90).max(1u128 << 64);
        let p = rng.below(2_000);
        let m = price::min_out(a, r, p).unwrap();
        assert!(price::min_out(a, r, p + 1).unwrap() <= m);
        assert!(price::min_out(a + 1, r, p).unwrap() >= m);
        assert!(price::min_out(a, r + (r >> 20), p).unwrap() <= m);
    }
}

#[test]
fn token_value_is_the_floor_of_amount_times_price() {
    // Exact against the 256-bit reference: floor(amount * floor(s^2 / 2^64) / 2^64).
    let mut rng = Lcg(6);
    for _ in 0..20_000 {
        let s = rng.bits128(96);
        let amount = rng.bits128(64) as u64;
        let p = price::price_q64(s).unwrap();
        let exact = U256::from(u128::from(amount))
            .mul(U256::from(p))
            .div(U256::from(1u128 << 64));
        let want = exact
            .to_u128()
            .map_or(u64::MAX, |v| u64::try_from(v).unwrap_or(u64::MAX));
        assert_eq!(
            price::token_value(amount, s),
            want,
            "amount {amount} sqrt {s}"
        );
    }
    // One raw token at a price below one lamport is worth nothing; at one
    // lamport per token (sqrt 2^64), its amount.
    assert_eq!(price::token_value(1, 1u128 << 60), 0);
    assert_eq!(price::token_value(12_345, 1u128 << 64), 12_345);
    // Saturates instead of wrapping; out of range prices are worth nothing.
    assert_eq!(price::token_value(u64::MAX, (1u128 << 96) - 1), u64::MAX);
    assert_eq!(price::token_value(u64::MAX, u128::MAX), 0);
    assert_eq!(price::token_value(0, 1u128 << 90), 0);
}

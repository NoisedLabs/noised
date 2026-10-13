//! Euclidean division of an `i64` by a positive constant, computed with
//! unsigned division only. The SBF backend lowers signed division to the
//! `__divdi3` / `__moddi3` routines (about 2.4 KB of the binary); these give
//! exactly `i64::div_euclid` / `i64::rem_euclid` for every `a` and every
//! `b > 0` (`tests/abi.rs` checks them against the standard library at the
//! edges and on random inputs), and fall back to them otherwise.

/// `a.div_euclid(b)`.
#[inline(always)]
pub const fn div_euclid(a: i64, b: i64) -> i64 {
    if b <= 0 {
        return a.div_euclid(b);
    }
    let b = b as u64;
    if a >= 0 {
        (a as u64 / b) as i64
    } else {
        // floor(a / b) = -(floor((-a - 1) / b)) - 1 for a < 0; `-(a + 1)`
        // is at most i64::MAX.
        -(((-(a + 1)) as u64 / b) as i64) - 1
    }
}

/// `a.rem_euclid(b)`.
#[inline(always)]
pub const fn rem_euclid(a: i64, b: i64) -> i64 {
    if b <= 0 {
        return a.rem_euclid(b);
    }
    let b = b as u64;
    if a >= 0 {
        (a as u64 % b) as i64
    } else {
        // a = q * b + r with 0 <= r < b: r = b - 1 - ((-a - 1) mod b).
        (b - 1 - (-(a + 1)) as u64 % b) as i64
    }
}

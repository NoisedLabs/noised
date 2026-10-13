//! The rent and clock sysvars (`Rent::get()`, `Clock::get()`), read with
//! `sol_get_sysvar`.

use pinocchio::error::ProgramError;
/// `SysvarC1ock11111111111111111111111111111111`.
pub use pinocchio::sysvars::clock::CLOCK_ID;
/// `Sysvar1nstructions1111111111111111111111111`.
pub use pinocchio::sysvars::instructions::INSTRUCTIONS_ID;
/// `SysvarRent111111111111111111111111111111111`.
pub use pinocchio::sysvars::rent::RENT_ID;

use crate::sys;

/// The rent sysvar's `lamports_per_byte_year` and `exemption_threshold`
/// (an `f64`, kept as its bits).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rent {
    lamports_per_byte_year: u64,
    exemption_threshold: u64,
}

/// Bytes every account is charged for besides its data.
pub const ACCOUNT_STORAGE_OVERHEAD: u64 = 128;
/// `2.0f64.to_bits()`: the threshold before SIMD-0194.
const THRESHOLD_TWO: u64 = 0x4000_0000_0000_0000;
/// `1.0f64.to_bits()`: the threshold after SIMD-0194.
const THRESHOLD_ONE: u64 = 0x3ff0_0000_0000_0000;
/// Every `u64` up to 2^53 converts to `f64` exactly.
const F64_EXACT: u64 = 1 << 53;

impl Rent {
    /// A rent of `lamports_per_byte_year` and `exemption_threshold`.
    #[inline]
    pub fn new(lamports_per_byte_year: u64, exemption_threshold: f64) -> Self {
        Self {
            lamports_per_byte_year,
            exemption_threshold: exemption_threshold.to_bits(),
        }
    }

    /// `Rent::get()` (solana-sysvar 3.1): any syscall failure is
    /// `UnsupportedSysvar`.
    #[inline]
    pub fn get() -> Result<Self, ProgramError> {
        let mut raw = [0u8; 16];
        sys::get_sysvar(&RENT_ID, 0, &mut raw)?;
        let mut word = [0u8; 8];
        word.copy_from_slice(&raw[..8]);
        let lamports_per_byte_year = u64::from_le_bytes(word);
        word.copy_from_slice(&raw[8..]);
        Ok(Self {
            lamports_per_byte_year,
            exemption_threshold: u64::from_le_bytes(word),
        })
    }

    /// solana-rent 3.1 `Rent::minimum_balance`, which Anchor 1.2.1 builds
    /// link: `(((128 + data_len) * lamports_per_byte_year) as f64 *
    /// exemption_threshold) as u64`. Thresholds 2.0 and 1.0 (before and
    /// after SIMD-0194) are computed in integers, which give the same result
    /// while the product converts to `f64` exactly; any other value takes the
    /// same float path.
    #[inline(never)]
    pub fn minimum_balance(&self, data_len: usize) -> u64 {
        let base = (ACCOUNT_STORAGE_OVERHEAD + data_len as u64) * self.lamports_per_byte_year;
        if base <= F64_EXACT {
            if self.exemption_threshold == THRESHOLD_TWO {
                return base * 2;
            }
            if self.exemption_threshold == THRESHOLD_ONE {
                return base;
            }
        }
        (base as f64 * f64::from_bits(self.exemption_threshold)) as u64
    }

    /// `Rent::is_exempt`.
    #[inline]
    pub fn is_exempt(&self, lamports: u64, data_len: usize) -> bool {
        lamports >= self.minimum_balance(data_len)
    }
}

/// The clock sysvar.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Clock {
    pub slot: u64,
    pub epoch_start_timestamp: i64,
    pub epoch: u64,
    pub leader_schedule_epoch: u64,
    pub unix_timestamp: i64,
}

impl Clock {
    /// Size of the sysvar's data.
    pub const LEN: usize = 40;

    /// `Clock::get()`: any syscall failure is `UnsupportedSysvar`.
    #[inline]
    pub fn get() -> Result<Self, ProgramError> {
        let mut raw = [0u8; Self::LEN];
        sys::get_sysvar(&CLOCK_ID, 0, &mut raw)?;
        Ok(Self::from_bytes(&raw))
    }

    /// Decodes the sysvar's data (bincode: five little-endian 64-bit words).
    #[inline]
    pub fn from_bytes(raw: &[u8; Self::LEN]) -> Self {
        let word = |i: usize| {
            let mut w = [0u8; 8];
            w.copy_from_slice(&raw[i * 8..i * 8 + 8]);
            w
        };
        Self {
            slot: u64::from_le_bytes(word(0)),
            epoch_start_timestamp: i64::from_le_bytes(word(1)),
            epoch: u64::from_le_bytes(word(2)),
            leader_schedule_epoch: u64::from_le_bytes(word(3)),
            unix_timestamp: i64::from_le_bytes(word(4)),
        }
    }
}

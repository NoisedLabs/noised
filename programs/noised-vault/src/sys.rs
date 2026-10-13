//! Syscall wrappers: logs, the rent sysvar and cross-program invocation.
//! Off-chain (host builds of the crate) they do nothing; the processor only
//! runs on-chain.

use alloc::vec::Vec;

use pinocchio::{
    cpi::{invoke_signed_unchecked, CpiAccount, Signer},
    error::ProgramError,
    instruction::{InstructionAccount, InstructionView},
    AccountView, Address,
};

/// `sol_log_` of a static or assembled line.
pub fn log_bytes(message: &[u8]) {
    #[cfg(target_os = "solana")]
    unsafe {
        pinocchio::syscalls::sol_log_(message.as_ptr(), message.len() as u64)
    };
    #[cfg(not(target_os = "solana"))]
    core::hint::black_box(message);
}

pub fn log(message: &str) {
    log_bytes(message.as_bytes())
}

/// `sol_log_pubkey`: the runtime prints the key in base58.
pub fn log_pubkey(key: &Address) {
    #[cfg(target_os = "solana")]
    unsafe {
        pinocchio::syscalls::sol_log_pubkey(key.as_ref().as_ptr())
    };
    #[cfg(not(target_os = "solana"))]
    core::hint::black_box(key);
}

/// `sol_log_data` of one slice: Anchor's `emit!` (`Program data: <base64>`).
pub fn log_data(data: &[u8]) {
    let slices: [&[u8]; 1] = [data];
    #[cfg(target_os = "solana")]
    unsafe {
        pinocchio::syscalls::sol_log_data(slices.as_ptr() as *const u8, slices.len() as u64)
    };
    #[cfg(not(target_os = "solana"))]
    core::hint::black_box(slices);
}

/// The rent sysvar's `lamports_per_byte_year` and `exemption_threshold`
/// (an `f64`, kept as its bits).
pub struct Rent {
    lamports_per_byte_year: u64,
    exemption_threshold: u64,
}

const ACCOUNT_STORAGE_OVERHEAD: u64 = 128;
/// `2.0f64.to_bits()`: the threshold before SIMD-0194.
const THRESHOLD_TWO: u64 = 0x4000_0000_0000_0000;
/// `1.0f64.to_bits()`: the threshold after SIMD-0194.
const THRESHOLD_ONE: u64 = 0x3ff0_0000_0000_0000;
/// Every `u64` up to 2^53 converts to `f64` exactly.
const F64_EXACT: u64 = 1 << 53;

impl Rent {
    /// A rent of `lamports_per_byte_year` and `exemption_threshold`.
    pub fn new(lamports_per_byte_year: u64, exemption_threshold: f64) -> Self {
        Self {
            lamports_per_byte_year,
            exemption_threshold: exemption_threshold.to_bits(),
        }
    }

    /// `Rent::get()` (solana-sysvar 3.1): any syscall failure is
    /// `UnsupportedSysvar`.
    pub fn get() -> Result<Self, ProgramError> {
        #[cfg(target_os = "solana")]
        {
            let mut raw = [0u8; 16];
            let result = unsafe {
                pinocchio::syscalls::sol_get_sysvar(
                    pinocchio::sysvars::rent::RENT_ID.as_ref().as_ptr(),
                    raw.as_mut_ptr(),
                    0,
                    raw.len() as u64,
                )
            };
            if result != 0 {
                return Err(ProgramError::UnsupportedSysvar);
            }
            let mut word = [0u8; 8];
            word.copy_from_slice(&raw[..8]);
            let lamports_per_byte_year = u64::from_le_bytes(word);
            word.copy_from_slice(&raw[8..]);
            Ok(Self {
                lamports_per_byte_year,
                exemption_threshold: u64::from_le_bytes(word),
            })
        }
        #[cfg(not(target_os = "solana"))]
        Err(ProgramError::UnsupportedSysvar)
    }

    /// solana-rent 3.1 `Rent::minimum_balance`, which the Anchor build
    /// linked: `(((128 + data_len) * lamports_per_byte_year) as f64 *
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

    pub fn is_exempt(&self, lamports: u64, data_len: usize) -> bool {
        lamports >= self.minimum_balance(data_len)
    }
}

/// A cross-program invocation the way `solana_program::program::invoke_signed`
/// makes it: `metas` are the instruction's accounts, `infos` any accounts
/// the caller holds; the runtime finds each instruction account among
/// `infos` by address (and fails with `MissingAccount` if one is not there).
/// The caller holds no borrow of any account's data across the call.
pub fn invoke(
    program_id: &Address,
    metas: &[InstructionAccount],
    data: &[u8],
    infos: &[&AccountView],
    signers: &[Signer],
) -> Result<(), ProgramError> {
    let accounts: Vec<CpiAccount> = infos.iter().map(|info| CpiAccount::from(*info)).collect();
    let instruction = InstructionView {
        program_id,
        data,
        accounts: metas,
    };
    // SAFETY: every `CpiAccount` points at a runtime account of this
    // instruction, and no reference into account data or lamports is alive
    // while the callee runs (callers drop every borrow before invoking).
    unsafe { invoke_signed_unchecked(&instruction, &accounts, signers) };
    Ok(())
}

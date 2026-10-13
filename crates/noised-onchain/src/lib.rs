//! Building blocks for Solana programs written on `pinocchio` alone that
//! keep the ABI of an Anchor 1.2.1 build byte for byte: the same
//! instruction and account discriminators, account checks in Anchor's
//! order with Anchor's error numbers and log lines, Borsh arguments and
//! events, PDAs, and SPL Token / Token-2022 handling written from (and
//! tested against) the SPL crates Anchor used.
//!
//! A program implements [`Program`] (its id and its packed
//! [`error::ErrorTable`]) on a marker type and passes that type to the
//! generic helpers, which therefore compile to the program's own constants:
//! nothing is looked up at run time and a binary carries only the helpers it
//! calls. `PORTING.md` maps every Anchor attribute and constraint to a
//! helper and its error, in Anchor's evaluation order.
//!
//! * [`error`]: framework error numbers, the program's own error enum
//!   ([`custom_errors!`]), the packed table ([`error_table!`]) and Anchor's
//!   log lines ([`error::fail`], [`error::fail_keys`]).
//! * [`accounts`]: the account list (`try_accounts`) and every account
//!   constraint, `init`, exit (write back) and `close`.
//! * [`args`]: instruction dispatch and Borsh argument decoding.
//! * [`pda`], [`sysvar`], [`cpi`], [`event`].
//! * [`token`]: SPL Token / Token-2022 accounts, extensions, associated
//!   token accounts, token CPIs, transfer-hook account resolution.
//! * [`sys`]: every `unsafe` block of the crate (syscalls, CPI, the
//!   entrypoint's account list), with its safety argument.
//! * `host` (off-chain only): helpers for clients and tests.
//!
//! Off-chain (`not(target_os = "solana")`) the syscalls do nothing (logs are
//! captured for tests, see [`sys::take_logs`]); programs only run on-chain.

#![deny(unsafe_code)]

extern crate alloc;

pub mod accounts;
pub mod args;
pub mod cpi;
pub mod error;
pub mod event;
#[cfg(not(target_os = "solana"))]
pub mod host;
pub mod pda;
pub mod sys;
pub mod sysvar;
pub mod token;

pub use error::ErrorTable;
pub use pinocchio::{
    self, account::Ref, cpi::Seed, cpi::Signer, error::ProgramError, AccountView, Address,
    ProgramResult,
};

/// A program: its id (`declare_id!`) and the error numbers it logs.
/// Implemented on a marker type (Anchor's `#[program]` module type, e.g.
/// `program::NoisedVault`); the helpers take it as a type parameter.
pub trait Program {
    /// The program id.
    const ID: Address;
    /// Every error number the program can log, with Anchor's names and
    /// messages, packed at compile time ([`error_table!`]).
    const ERRORS: ErrorTable;
}

/// Address equality, out of line: a 32-byte compare is a dozen
/// instructions every time it is inlined.
#[inline(never)]
pub fn same(a: &Address, b: &Address) -> bool {
    a == b
}

/// Whether `account` is owned by `owner`.
#[inline(never)]
pub fn owned_by(account: &AccountView, owner: &Address) -> bool {
    same(account.owner(), owner)
}

/// SHA-256 of the concatenated `parts` (the `sol_sha256` syscall on-chain,
/// the `sha2` crate off-chain).
#[inline]
pub fn hashv(parts: &[&[u8]]) -> [u8; 32] {
    solana_sha256_hasher::hashv(parts).to_bytes()
}

/// Well-known program ids.
pub mod ids {
    use crate::Address;

    /// System program (`11111111111111111111111111111111`).
    pub const SYSTEM_PROGRAM_ID: Address = Address::new_from_array([0; 32]);
    /// SPL Token (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`).
    pub const TOKEN_PROGRAM_ID: Address = Address::new_from_array([
        6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133,
        237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
    ]);
    /// Token-2022 (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`).
    pub const TOKEN_2022_PROGRAM_ID: Address = Address::new_from_array([
        6, 221, 246, 225, 238, 117, 143, 222, 24, 66, 93, 188, 228, 108, 205, 218, 182, 26, 252,
        77, 131, 185, 13, 39, 254, 189, 249, 40, 216, 161, 139, 252,
    ]);
    /// Associated Token Account program
    /// (`ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`).
    pub const ASSOCIATED_TOKEN_PROGRAM_ID: Address = Address::new_from_array([
        140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19, 153,
        218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89,
    ]);
    /// SPL Memo v2 (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`). Token-2022
    /// accepts it (or v1) as the instruction right before a transfer into an
    /// account that requires memos.
    pub const MEMO_PROGRAM_ID: Address = Address::new_from_array([
        5, 74, 83, 90, 153, 41, 33, 6, 77, 36, 232, 113, 96, 218, 56, 124, 124, 53, 181, 221, 188,
        146, 187, 129, 228, 31, 168, 64, 65, 5, 68, 141,
    ]);
    /// BPF upgradeable loader (`BPFLoaderUpgradeab1e11111111111111111111111`).
    pub const BPF_LOADER_UPGRADEABLE_ID: Address = Address::new_from_array([
        2, 168, 246, 145, 78, 136, 161, 176, 226, 16, 21, 62, 247, 99, 174, 43, 0, 194, 185, 61,
        22, 193, 36, 210, 192, 83, 122, 16, 4, 128, 0, 0,
    ]);
}

/// The usual imports of a program.
pub mod prelude {
    pub use crate::{
        accounts::{self, Accounts, ProgramAccount},
        args::{self, Reader},
        cpi, error,
        error::{anchor::*, fail, fail_keys, raise},
        event,
        ids::*,
        owned_by, pda, same, sys,
        sysvar::{self, Rent},
        token, AccountView, Address, ErrorTable, Program, ProgramError, ProgramResult, Seed,
        Signer,
    };
}

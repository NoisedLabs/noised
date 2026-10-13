//! Error numbers. The program's own errors are [`HookError`] (6000 + the
//! variant index, as Anchor numbered them); the framework errors are the
//! numbers of anchor-lang 1.2.1's `ErrorCode` that the Anchor build returned
//! for the same conditions ([`anchor`]). [`ERRORS`] packs every number the
//! program can log, with its name and message.
//!
//! Each such error is logged as Anchor logged it, built from static strings
//! (no formatting machinery in the binary, see `noised_onchain::error`):
//! `AnchorError caused by account: <field>. Error Code: <Name>. Error
//! Number: <n>. Error Message: <msg>.` (or `AnchorError occurred. ...`),
//! followed by `Left:` / `Right:` and the two pubkeys where Anchor logged
//! the compared keys. Errors of other programs and the runtime's own
//! (`ProgramError`) are returned unchanged and not logged.

pub use noised_onchain::error::{anchor, ERROR_CODE_OFFSET};
use noised_onchain::{error as onchain, ErrorTable};
use pinocchio::error::ProgramError;

use crate::{program::NoisedHook, Pubkey};

noised_onchain::custom_errors! {
    /// The program's errors. Clients map the numbers to messages, so they
    /// never move: new variants are only ever appended.
    pub enum HookError {
        /// 6000: Launch guard: buying opens when the snipe-shield countdown ends.
        SnipeShield = "Launch guard: buying opens when the snipe-shield countdown ends",
        /// 6001: Launch guard: wallet-to-wallet transfers are paused until the guard ends.
        TransfersLocked = "Launch guard: wallet-to-wallet transfers are paused until the guard ends",
        /// 6002: Launch guard: transfer is larger than the max-buy cap.
        MaxBuy = "Launch guard: transfer is larger than the max-buy cap",
        /// 6003: Launch guard: receiving account would exceed the max-wallet cap.
        MaxWallet = "Launch guard: receiving account would exceed the max-wallet cap",
        /// 6004: Mint's transfer hook is not this program.
        WrongHookProgram = "Mint's transfer hook is not this program",
        /// 6005: Policy belongs to a different mint.
        PolicyMismatch = "Policy belongs to a different mint",
        /// 6006: Policy is outside the hook's hard bounds.
        InvalidPolicy = "Policy is outside the hook's hard bounds",
        /// 6007: Pool is not a Meteora DBC account.
        InvalidPool = "Pool is not a Meteora DBC account",
        /// 6008: Malformed token account.
        MalformedTokenAccount = "Malformed token account",
        /// 6009: Only the launchpad's execute_batch can end the snipe shield.
        NotInBatch = "Only the launchpad's execute_batch can end the snipe shield",
        /// 6010: Launch guard: the receiving token account must have an
        /// immutable owner while the guard is on.
        MutableOwner = "Launch guard: the receiving token account must have an immutable owner while the guard is on",
        /// 6011: Launch rule: this transfer is not allowed right now.
        RuleDenied = "Launch rule: this transfer is not allowed right now",
        /// 6012: Launch rules do not verify (PXR1) for this guard.
        InvalidRules = "Launch rules do not verify (PXR1) for this guard",
    }
}

/// Every error number this program logs: the anchor-lang 1.2.1 `ErrorCode`
/// numbers the Anchor build returned, then [`HookError`].
pub const ERRORS: ErrorTable = {
    use anchor::*;
    noised_onchain::error_table![
        INSTRUCTION_FALLBACK_NOT_FOUND,
        INSTRUCTION_DID_NOT_DESERIALIZE,
        EVENT_INSTRUCTION_STUB,
        CONSTRAINT_MUT,
        CONSTRAINT_RENT_EXEMPT,
        CONSTRAINT_SEEDS,
        CONSTRAINT_ADDRESS,
        ACCOUNT_DISCRIMINATOR_NOT_FOUND,
        ACCOUNT_DISCRIMINATOR_MISMATCH,
        ACCOUNT_DID_NOT_DESERIALIZE,
        ACCOUNT_DID_NOT_SERIALIZE,
        ACCOUNT_NOT_ENOUGH_KEYS,
        ACCOUNT_OWNED_BY_WRONG_PROGRAM,
        INVALID_PROGRAM_ID,
        INVALID_PROGRAM_EXECUTABLE,
        ACCOUNT_NOT_SIGNER,
        ACCOUNT_NOT_INITIALIZED,
        DECLARED_PROGRAM_ID_MISMATCH,
        TRYING_TO_INIT_PAYER_AS_PROGRAM_ACCOUNT;
        HookError::ERRORS
    ]
};

/// Name, decimal number and message of error `code` (empty for a number
/// this program never returns).
pub fn describe(code: u32) -> [&'static [u8]; 3] {
    ERRORS.describe(code)
}

/// Every error number this program can log.
pub fn numbers() -> impl Iterator<Item = u32> {
    ERRORS.numbers()
}

/// Name and message of error `code` (host only).
#[cfg(not(target_os = "solana"))]
pub fn name_and_message(code: u32) -> (&'static str, &'static str) {
    ERRORS.name_and_message(code)
}

/// Logs Anchor's line for error `code` raised on the account field
/// `account` (or with no account) and returns the error.
#[inline(always)]
pub fn fail(code: u32, account: Option<&'static str>) -> ProgramError {
    onchain::fail::<NoisedHook>(code, account)
}

/// [`fail`], then the two compared pubkeys as Anchor logs them.
#[inline(always)]
pub fn fail_keys(
    code: u32,
    account: Option<&'static str>,
    left: &Pubkey,
    right: &Pubkey,
) -> ProgramError {
    onchain::fail_keys::<NoisedHook>(code, account, left, right)
}

/// [`fail`] with no account for a [`HookError`] the handler raises
/// (`err!`, `require!`, `error!`): `AnchorError occurred. ...`.
#[inline(always)]
pub fn hook(e: HookError) -> ProgramError {
    onchain::raise::<NoisedHook>(e.code())
}

#[cfg(test)]
mod tests {
    use super::HookError;

    /// Clients map error numbers to messages, so they never move: round 2
    /// appended `NotInBatch` after the existing variants, audit 3
    /// `MutableOwner`, programmable launches `RuleDenied` and `InvalidRules`.
    #[test]
    fn error_numbers_are_stable() {
        let pinned = [
            (HookError::SnipeShield, 6000),
            (HookError::TransfersLocked, 6001),
            (HookError::MaxBuy, 6002),
            (HookError::MaxWallet, 6003),
            (HookError::WrongHookProgram, 6004),
            (HookError::PolicyMismatch, 6005),
            (HookError::InvalidPolicy, 6006),
            (HookError::InvalidPool, 6007),
            (HookError::MalformedTokenAccount, 6008),
            (HookError::NotInBatch, 6009),
            (HookError::MutableOwner, 6010),
            (HookError::RuleDenied, 6011),
            (HookError::InvalidRules, 6012),
        ];
        for (error, number) in pinned {
            assert_eq!(u32::from(error), number, "{error:?}");
        }
    }
}

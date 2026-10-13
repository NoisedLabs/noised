//! Error numbers. The program's own errors are [`ShieldError`] (6000 + the
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

use crate::{program::NoisedShield, Pubkey};

noised_onchain::custom_errors! {
    /// The program's errors. Clients map the numbers to messages, so they
    /// never move: new variants are only ever appended.
    pub enum ShieldError {
        /// 6000: Base mint has a Token-2022 extension the shield does not accept.
        UnsupportedExtension = "Base mint has a Token-2022 extension the shield does not accept",
        /// 6001: Base mint's Token-2022 data could not be parsed.
        MalformedBaseMint = "Base mint's Token-2022 data could not be parsed",
        /// 6002: Amount must be greater than zero.
        ZeroAmount = "Amount must be greater than zero",
        /// 6003: The escrow received no tokens (the transfer fee took everything).
        NothingReceived = "The escrow received no tokens (the transfer fee took everything)",
        /// 6004: zToken supply exceeds the escrow balance.
        Undercollateralized = "zToken supply exceeds the escrow balance",
        /// 6005: Minted or burned zTokens do not match the escrow balance change.
        AccountingMismatch = "Minted or burned zTokens do not match the escrow balance change",
        /// 6006: zToken mint address is already in use.
        ZMintInUse = "zToken mint address is already in use",
        /// 6007: zToken mint failed its post-creation checks.
        ZMintMisconfigured = "zToken mint failed its post-creation checks",
        /// 6008: Source and destination token accounts must differ.
        SameAccount = "Source and destination token accounts must differ",
        /// 6009: Arithmetic overflow.
        MathOverflow = "Arithmetic overflow",
    }
}

/// Every error number this program logs: the anchor-lang 1.2.1 `ErrorCode`
/// numbers the Anchor build returned, then [`ShieldError`].
pub const ERRORS: ErrorTable = {
    use anchor::*;
    noised_onchain::error_table![
        INSTRUCTION_FALLBACK_NOT_FOUND,
        INSTRUCTION_DID_NOT_DESERIALIZE,
        EVENT_INSTRUCTION_STUB,
        CONSTRAINT_MUT,
        CONSTRAINT_HAS_ONE,
        CONSTRAINT_RENT_EXEMPT,
        CONSTRAINT_SEEDS,
        CONSTRAINT_TOKEN_MINT,
        CONSTRAINT_TOKEN_OWNER,
        CONSTRAINT_TOKEN_TOKEN_PROGRAM,
        CONSTRAINT_MINT_TOKEN_PROGRAM,
        CONSTRAINT_ASSOCIATED_TOKEN_TOKEN_PROGRAM,
        CONSTRAINT_DUPLICATE_MUTABLE_ACCOUNT,
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
        ACCOUNT_NOT_ASSOCIATED_TOKEN_ACCOUNT,
        DECLARED_PROGRAM_ID_MISMATCH,
        TRYING_TO_INIT_PAYER_AS_PROGRAM_ACCOUNT;
        ShieldError::ERRORS
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
    onchain::fail::<NoisedShield>(code, account)
}

/// [`fail`], then the two compared pubkeys as Anchor logs them.
#[inline(always)]
pub fn fail_keys(
    code: u32,
    account: Option<&'static str>,
    left: &Pubkey,
    right: &Pubkey,
) -> ProgramError {
    onchain::fail_keys::<NoisedShield>(code, account, left, right)
}

/// A [`ShieldError`] the program raises itself (`err!`, `require!`,
/// `.ok_or(..)?`): `AnchorError occurred. ...`.
#[inline(always)]
pub fn shield(e: ShieldError) -> ProgramError {
    onchain::raise::<NoisedShield>(e.code())
}

#[cfg(test)]
mod tests {
    use super::ShieldError;

    /// Clients map error numbers to messages, so they never move.
    #[test]
    fn error_numbers_are_stable() {
        let pinned = [
            (ShieldError::UnsupportedExtension, 6000),
            (ShieldError::MalformedBaseMint, 6001),
            (ShieldError::ZeroAmount, 6002),
            (ShieldError::NothingReceived, 6003),
            (ShieldError::Undercollateralized, 6004),
            (ShieldError::AccountingMismatch, 6005),
            (ShieldError::ZMintInUse, 6006),
            (ShieldError::ZMintMisconfigured, 6007),
            (ShieldError::SameAccount, 6008),
            (ShieldError::MathOverflow, 6009),
        ];
        for (error, number) in pinned {
            assert_eq!(u32::from(error), number, "{error:?}");
        }
    }
}

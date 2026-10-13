//! Error numbers. The program's own errors are [`VaultError`] (6000 + the
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

use crate::{program::NoisedVault, Pubkey};

noised_onchain::custom_errors! {
    /// The program's errors. Clients map the numbers to messages, so they
    /// never move: new variants are only ever appended.
    pub enum VaultError {
        /// 6000: Key id does not match the LM-OTS public key.
        KeyIdMismatch = "Key id does not match the LM-OTS public key",
        /// 6001: Invalid post-quantum signature.
        InvalidSignature = "Invalid post-quantum signature",
        /// 6002: The next key must differ from the current key.
        InvalidNextKey = "The next key must differ from the current key",
        /// 6003: Mint cannot be held in a vault.
        UnsupportedMint = "Mint cannot be held in a vault",
        /// 6004: Destination is not the recipient's associated token account for this mint.
        InvalidDestination = "Destination is not the recipient's associated token account for this mint",
        /// 6005: Arithmetic overflow.
        MathOverflow = "Arithmetic overflow",
        /// 6006: Key index q must be 0 for a new vault and the vault's sequence + 1 for the next key.
        InvalidKeyIndex = "Key index q must be 0 for a new vault and the vault's sequence + 1 for the next key",
    }
}

/// Every error number this program logs: the anchor-lang 1.2.1 `ErrorCode`
/// numbers the Anchor build returned, then [`VaultError`].
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
        CONSTRAINT_ASSOCIATED,
        CONSTRAINT_CLOSE,
        CONSTRAINT_ADDRESS,
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
        VaultError::ERRORS
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
    onchain::fail::<NoisedVault>(code, account)
}

/// [`fail`], then the two compared pubkeys as Anchor logs them.
#[inline(always)]
pub fn fail_keys(
    code: u32,
    account: Option<&'static str>,
    left: &Pubkey,
    right: &Pubkey,
) -> ProgramError {
    onchain::fail_keys::<NoisedVault>(code, account, left, right)
}

/// [`fail`] for a [`VaultError`].
#[inline(always)]
pub fn vault(e: VaultError) -> ProgramError {
    onchain::raise::<NoisedVault>(e.code())
}

#[cfg(test)]
mod tests {
    use super::VaultError;

    /// Clients map error numbers to messages, so they never move: round 2
    /// appended `InvalidKeyIndex` after the existing variants.
    #[test]
    fn error_numbers_are_stable() {
        let pinned = [
            (VaultError::KeyIdMismatch, 6000),
            (VaultError::InvalidSignature, 6001),
            (VaultError::InvalidNextKey, 6002),
            (VaultError::UnsupportedMint, 6003),
            (VaultError::InvalidDestination, 6004),
            (VaultError::MathOverflow, 6005),
            (VaultError::InvalidKeyIndex, 6006),
        ];
        for (error, number) in pinned {
            assert_eq!(u32::from(error), number, "{error:?}");
        }
    }
}

//! Error numbers. The program's own errors are [`LaunchpadError`] (6000 +
//! the variant index, as Anchor numbered them); the framework errors are
//! the numbers of anchor-lang 1.2.1's `ErrorCode` that the Anchor build
//! returned for the same conditions ([`anchor`]). [`ERRORS`] packs every
//! number the program can log, with its name and message.
//!
//! Each such error is logged as Anchor logged it, built from static strings
//! (no formatting machinery in the binary, see `noised_onchain::error`):
//! `AnchorError caused by account: <field>. Error Code: <Name>. Error
//! Number: <n>. Error Message: <msg>.` (or `AnchorError occurred. ...`),
//! followed by `Left:` / `Right:` and the two pubkeys where Anchor logged
//! the compared keys. Errors of other programs and the runtime's own
//! (`ProgramError`) are returned unchanged and not logged.
//!
//! The pure checks (`policy`, `pq`, `checks`) return [`Result`]: on-chain
//! the program error, a [`LaunchpadError`] being logged once where it is
//! raised; off-chain Anchor's `Error`, the host API the unit tests were
//! written against (`anchor_lang::Result`, compared by number).

pub use noised_onchain::error::{anchor, ERROR_CODE_OFFSET};
use noised_onchain::{error as onchain, ErrorTable};
use pinocchio::error::ProgramError;

use crate::{program::NoisedLaunchpad, Pubkey};

/// The program's error enum, as Anchor's `#[error_code]` declared it: a
/// `u32` enum numbered from 6000 in declaration order, with each variant's
/// message (`noised_onchain::custom_errors!`, with Anchor's `name() ->
/// String` off-chain, which Anchor's `error!(e)` calls).
macro_rules! launchpad_errors {
    (
        $(#[$meta:meta])*
        $vis:vis enum $name:ident {
            $( $(#[$vmeta:meta])* $variant:ident = $message:literal ),* $(,)?
        }
    ) => {
        $(#[$meta])*
        #[repr(u32)]
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        $vis enum $name {
            $( $(#[$vmeta])* $variant ),*
        }

        impl $name {
            /// The number of the first variant.
            pub const OFFSET: u32 = ERROR_CODE_OFFSET;

            /// Number, name and message of every variant, in order.
            pub const ERRORS: &'static [noised_onchain::error::ErrorEntry] = &[
                $( ($name::$variant as u32 + ERROR_CODE_OFFSET, stringify!($variant), $message) ),*
            ];

            /// The error number (6000 + the variant index).
            #[inline]
            pub const fn code(self) -> u32 {
                self as u32 + Self::OFFSET
            }
        }

        impl ::core::convert::From<$name> for u32 {
            #[inline]
            fn from(e: $name) -> u32 {
                e.code()
            }
        }

        #[cfg(not(target_os = "solana"))]
        impl $name {
            /// The variant name, as in the IDL (Anchor's `name()`).
            pub fn name(&self) -> String {
                Self::ERRORS[*self as usize].1.to_string()
            }

            /// The message, as in the IDL.
            pub fn message(&self) -> &'static str {
                Self::ERRORS[*self as usize].2
            }
        }

        #[cfg(not(target_os = "solana"))]
        impl ::core::fmt::Display for $name {
            fn fmt(&self, f: &mut ::core::fmt::Formatter<'_>) -> ::core::fmt::Result {
                f.write_str(self.message())
            }
        }
    };
}

launchpad_errors! {
    /// The program's errors. Clients map the numbers to messages, so they
    /// never move: new variants are only ever appended.
    pub enum LaunchpadError {
        /// 6000
        NotUpgradeAuthority = "Signer is not the program's upgrade authority",
        /// 6001
        InvalidProtocolParams = "Platform fee is above the maximum or the treasury is not a wSOL PQ vault",
        /// 6002
        InvalidDecimals = "Token decimals must be 6..=9",
        /// 6003
        InvalidThreshold = "Migration threshold must be 1..=100_000 SOL",
        /// 6004
        InvalidCurve = "Start price or curve is outside DBC's rules (1..=8 increasing points, liquidity > 0)",
        /// 6005
        InvalidBaseFee = "Base fee must be a linear or exponential scheduler within DBC's bounds",
        /// 6006
        FeeScheduleTooLong = "Fee schedule must end before the batch executes (duration <= open delay)",
        /// 6007
        InvalidDynamicFee = "Dynamic fee parameters are outside DBC's bounds",
        /// 6008
        FeeTooHigh = "Fee after the schedule (base + max dynamic) exceeds the safety ceiling",
        /// 6009
        InvalidMigrationFeeOption = "Migration fee option must be 0..=5 (fixed DAMM v2 fee tiers)",
        /// 6010
        InvalidOpenDelay = "Open delay must be 60..=1800 seconds",
        /// 6011
        InvalidGuard = "Guard must cover the open delay plus the execution window and last at most 72h",
        /// 6012
        InvalidMaxWallet = "Max wallet must be 0 (off) or 10..=10_000 bps",
        /// 6013
        InvalidMaxBuy = "Max buy must be 0 (off) or 1..=10_000 bps",
        /// 6014
        InvalidBatchCap = "Batch caps: total 0 or 10%..=100% of the threshold; per wallet 0 or at least 1/200 of the total",
        /// 6015
        InvalidRecipients = "Recipients: 1..=4 distinct, non-default wallets with bps > 0 summing to 10_000",
        /// 6016
        InvalidMetadata = "Name (1..=32 bytes) or symbol (1..=10) is out of bounds, or the external uri is not https:// in printable ASCII",
        /// 6017
        WrongCreator = "Only the launch creator can do this",
        /// 6018
        WrongLaunchState = "Launch is not in the required state",
        /// 6019
        AccountMismatch = "Account does not match the launch",
        /// 6020
        UnsafeMint = "Freshly created mint failed a safety post-condition",
        /// 6021
        UnsafeConfig = "DBC config or pool does not hold the expected safe values",
        /// 6022
        UnsafePolicy = "Hook policy does not hold the expected values",
        /// 6023
        NotCommitWindow = "Commits are only accepted during the commit window",
        /// 6024
        NotExecuteWindow = "The batch can only execute during the execution window",
        /// 6025
        AlreadyExecuted = "The batch has already executed",
        /// 6026
        EmptyBatch = "Nothing was committed to the batch",
        /// 6027
        EmptySwap = "Batch swap returned no tokens",
        /// 6028
        AlreadyClaimed = "Commit has already been claimed",
        /// 6029
        BatchPending = "The batch has not executed or expired yet",
        /// 6030
        CapExceeded = "Commit or batch cap exceeded",
        /// 6031
        ZeroAmount = "Amount must be greater than zero",
        /// 6032
        PayoutExceedsEscrow = "Payout would exceed what the escrow holds for this launch",
        /// 6033
        InvalidHookAccounts = "Transfer-hook accounts are missing or wrong",
        /// 6034
        InvalidRecipientAccounts = "Recipient accounts are missing or wrong",
        /// 6035
        NothingToDo = "Nothing to claim or distribute",
        /// 6036
        InvalidPosition = "Position is not a launch-authority LP position of this launch's DAMM v2 pool",
        /// 6037
        MathOverflow = "Arithmetic overflow",
        /// 6038
        PoolAlreadyTraded = "The pool was traded before the batch; the batch can only refund",
        /// 6039
        InvalidPqIdentity = "Post-quantum identity is missing or does not match the launch",
        /// 6040
        InvalidPqSignature = "LMS signature is malformed or does not verify over the launch's attestation message",
        /// 6041
        PqLeafUsed = "This one-time leaf of the post-quantum identity has already signed",
        /// 6042
        AttestationMismatch = "Attestation does not match the launch, its identity or its metadata",
        /// 6043
        InvalidPayoutOwner = "Payout owner must be the committer or a PQ vault of the paid mint (one commit per vault), and never changes",
        /// 6044
        NotLaunchWindow = "The launch can only go live inside the window its attestation signed",
        /// 6045
        InvalidMetadataFlags = "Metadata flags: an unknown bit or both uri modes, a uri without the external-uri flag, or an inline uri without a document",
        /// 6046
        MetadataTooLong = "Metadata document is over 3,072 bytes or the uri is over 200",
        /// 6047
        MetadataMismatch = "The mint's metadata does not equal the attested on-chain record",
        /// 6048
        InvalidRules = "Launch rules do not verify (PXR1) for this launch's guard",
    }
}

/// Every error number this program logs: the anchor-lang 1.2.1 `ErrorCode`
/// numbers the Anchor build returned, then [`LaunchpadError`].
pub const ERRORS: ErrorTable = {
    use anchor::*;
    noised_onchain::error_table![
        INSTRUCTION_FALLBACK_NOT_FOUND,
        INSTRUCTION_DID_NOT_DESERIALIZE,
        EVENT_INSTRUCTION_STUB,
        CONSTRAINT_MUT,
        CONSTRAINT_OWNER,
        CONSTRAINT_RENT_EXEMPT,
        CONSTRAINT_SEEDS,
        CONSTRAINT_EXECUTABLE,
        CONSTRAINT_ASSOCIATED,
        CONSTRAINT_TOKEN_MINT,
        CONSTRAINT_TOKEN_OWNER,
        CONSTRAINT_SPACE,
        CONSTRAINT_TOKEN_TOKEN_PROGRAM,
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
        ACCOUNT_NOT_PROGRAM_DATA,
        ACCOUNT_NOT_ASSOCIATED_TOKEN_ACCOUNT,
        DECLARED_PROGRAM_ID_MISMATCH,
        TRYING_TO_INIT_PAYER_AS_PROGRAM_ACCOUNT;
        LaunchpadError::ERRORS
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

/// The error of the pure checks: on-chain the program error itself (a
/// [`LaunchpadError`] becomes one when it is raised, logged once, as
/// `AnchorError occurred. ...`).
#[cfg(target_os = "solana")]
pub type Error = ProgramError;

/// Raising a [`LaunchpadError`] in a pure check (on-chain): logged once,
/// where it is raised, as Anchor logged it at the end of the instruction.
#[cfg(target_os = "solana")]
impl From<LaunchpadError> for ProgramError {
    #[inline(always)]
    fn from(e: LaunchpadError) -> Self {
        raise(e)
    }
}

/// The error of the pure checks: off-chain Anchor's, as the Anchor build's
/// helpers returned it (the unit tests' API).
#[cfg(not(target_os = "solana"))]
pub type Error = anchor_lang::error::Error;

/// What the pure checks return.
pub type Result<T> = core::result::Result<T, Error>;

/// `require!(condition, LaunchpadError::X)` in the pure checks: returns the
/// error (raised once, see [`Error`]) when the condition is false.
macro_rules! require {
    ($condition:expr, $error:expr $(,)?) => {
        if !($condition) {
            return Err($crate::error::Error::from($error));
        }
    };
}
pub(crate) use require;

/// A [`LaunchpadError`] as Anchor's `error!(e)` builds it (host only):
/// compared by number with the Anchor build's.
#[cfg(not(target_os = "solana"))]
impl From<LaunchpadError> for anchor_lang::error::Error {
    fn from(e: LaunchpadError) -> Self {
        anchor_lang::error::Error::from(anchor_lang::error::AnchorError {
            error_name: e.name(),
            error_code_number: e.code(),
            error_msg: e.message().to_string(),
            error_origin: None,
            compared_values: None,
        })
    }
}

/// An error of the pure checks, returned by the instruction (on-chain it
/// was logged when it was raised).
#[cfg(target_os = "solana")]
#[inline(always)]
pub fn raise_error(e: Error) -> ProgramError {
    e
}

/// An error of the pure checks, raised by the instruction (host builds of
/// the processor: an Anchor error carries the number, a program error is
/// returned as it is).
#[cfg(not(target_os = "solana"))]
pub fn raise_error(e: Error) -> ProgramError {
    match e {
        anchor_lang::error::Error::AnchorError(a) => {
            onchain::raise::<NoisedLaunchpad>(a.error_code_number)
        }
        anchor_lang::error::Error::ProgramError(p) => p.program_error,
    }
}

/// Logs Anchor's line for error `code` raised on the account field
/// `account` (or with no account) and returns the error.
#[inline(always)]
pub fn fail(code: u32, account: Option<&'static str>) -> ProgramError {
    onchain::fail::<NoisedLaunchpad>(code, account)
}

/// [`fail`], then the two compared pubkeys as Anchor logs them.
#[inline(always)]
pub fn fail_keys(
    code: u32,
    account: Option<&'static str>,
    left: &Pubkey,
    right: &Pubkey,
) -> ProgramError {
    onchain::fail_keys::<NoisedLaunchpad>(code, account, left, right)
}

/// `err!(e)` / `require!(.., e)`: `AnchorError occurred. ...`.
#[inline(always)]
pub fn raise(e: LaunchpadError) -> ProgramError {
    onchain::raise::<NoisedLaunchpad>(e.code())
}

#[cfg(test)]
mod table_tests {
    use super::{LaunchpadError, ERRORS};

    /// Every variant is in the table with its name and message, at 6000 +
    /// its index.
    #[test]
    fn every_variant_is_in_the_table() {
        for (i, (code, name, message)) in LaunchpadError::ERRORS.iter().enumerate() {
            assert_eq!(*code, 6000 + i as u32);
            assert_eq!(ERRORS.name_and_message(*code), (*name, *message), "{name}");
        }
        assert_eq!(LaunchpadError::ERRORS.len(), 49);
    }
}

//! Error numbers. The program's own errors are [`AutopilotError`] (6000 +
//! the variant index, as Anchor numbered them); the framework errors are the
//! numbers of anchor-lang 1.2.1's `ErrorCode` that the Anchor build returned
//! for the same conditions ([`anchor`]). [`ERRORS`] packs every number the
//! program can log, with its name and message.
//!
//! Each such error is logged as Anchor logged it, built from static strings
//! (no formatting machinery in the binary, see `noised_onchain::error`):
//! `AnchorError caused by account: <field>. Error Code: <Name>. Error
//! Number: <n>. Error Message: <msg>.` (or `AnchorError occurred. ...`),
//! followed by `Left:` / `Right:` and the two pubkeys where Anchor logged
//! the compared keys (`require_keys_eq!`, `address = .. @ E`, ...). Errors
//! of other programs and the runtime's own (`ProgramError`, e.g. a token
//! account that does not unpack) are returned unchanged and not logged.
//!
//! Anchor logs an error once, when it leaves the instruction. Here the pure
//! decisions (`logic`, the layout readers) return an [`AutopilotError`],
//! which is logged when `?` turns it into the instruction's `ProgramError`
//! ([`From`] below): the same single line, at the same point, and nothing
//! for an error that is dropped (a pool a burn cannot read, `run`).

pub use noised_onchain::error::{anchor, ERROR_CODE_OFFSET};
use noised_onchain::{error as onchain, ErrorTable};
use pinocchio::error::ProgramError;

use crate::{program::NoisedAutopilot, Pubkey};

noised_onchain::custom_errors! {
    /// The program's errors. Clients map the numbers to messages, so they
    /// never move: new variants are only ever appended.
    pub enum AutopilotError {
        /// 6000
        NotALaunch = "Account is not a Noised launchpad launch",
        /// 6001
        LaunchNotLive = "The launch is not live yet",
        /// 6002
        InvalidCertificate = "Certificate is not the launchpad's for this launch and mint, or lacks a safety check",
        /// 6003
        InvalidDbcConfig = "DBC config is not the launch's (wSOL quote, migration price)",
        /// 6004
        MintAlreadyBound = "The autopilot's mint is already bound",
        /// 6005
        MintNotBound = "The autopilot's mint is not bound yet (bind_mint once the launch is live)",
        /// 6006
        InvalidGraph = "Graph bytes do not verify as PXG1",
        /// 6007
        GraphMismatch = "Graph record is not the one this autopilot names",
        /// 6008
        InvalidAuthorization = "Authorization is not the launch identity's authorization of this action",
        /// 6009
        StaleAuthorization = "Authorization landed before one already used",
        /// 6010
        Frozen = "The graph is frozen forever",
        /// 6011
        NoActiveGraph = "No graph is active",
        /// 6012
        NoPendingUpdate = "No graph update is pending",
        /// 6013
        ActivationInPast = "A first graph must activate now or later",
        /// 6014
        TimelockTooShort = "A graph update must take effect at least 72 hours after it is queued",
        /// 6015
        UpdateNotDue = "The pending graph update is not due yet",
        /// 6016
        PendingUpdateDue = "A graph update is due: apply it first",
        /// 6017
        NoOperator = "There is no operator",
        /// 6018
        NoSuchNode = "No such node in the active graph",
        /// 6019
        NodeNotDue = "The node is not due",
        /// 6020
        NotGraduated = "The token has not graduated to its DAMM v2 pool",
        /// 6021
        MaxRunsReached = "The node ran as often as allowed this epoch",
        /// 6022
        BudgetSpent = "The node spent its budget for this epoch",
        /// 6023
        ConditionFalse = "The node's condition does not hold",
        /// 6024
        WrongOperator = "Only the graph's operator can run this node",
        /// 6025
        AmountNotAllowed = "Only operator-gated nodes and buybacks take an amount",
        /// 6026
        InvalidAmount = "The amount must be above zero and within the node's cap and the treasury",
        /// 6027
        NothingToDo = "The treasury holds nothing this node could move",
        /// 6028
        PremiumExceeded = "The pool price is above the reference price plus the node's premium",
        /// 6029
        PriceOutOfRange = "The reference price is out of range for this swap",
        /// 6030
        SwapShortfall = "The swap did not take exactly the amount in or returned less than the minimum",
        /// 6031
        InvalidPool = "Pool is not the launch's DAMM v2 pool",
        /// 6032
        InvalidDammAccounts = "DAMM v2 accounts are missing or wrong",
        /// 6033
        InvalidRecipientAccounts = "Recipient accounts are missing or wrong",
        /// 6034
        PriceNotObserved = "Observe the pool price first (update_price), then run at least a minute later",
        /// 6035
        MathOverflow = "Arithmetic overflow",
        /// 6036
        UnexpectedAccounts = "This action takes no remaining accounts",
        /// 6037
        AmountTooSmall = "A keeper's buyback must move at least 1% of the pool's SOL (or the node's whole amount)",
        /// 6038
        InvalidDammConfig = "DAMM v2 config is not one DBC migrates through",
        /// 6039
        PoolAlreadyBound = "The autopilot's pool is already bound",
        /// 6040
        FreezeExpired = "The freeze authorization is past its not_after",
        /// 6041
        RemainderTooSmall = "A keeper's partial buyback must leave at least 1% of the pool's SOL of the node's amount (or move all of it)",
        /// 6042
        NoRecipientAccount = "No recipient of a share has a wSOL account to receive it",
    }
}

/// Every error number this program logs: the anchor-lang 1.2.1 `ErrorCode`
/// numbers the Anchor build returned, then [`AutopilotError`].
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
        CONSTRAINT_ASSOCIATED,
        CONSTRAINT_TOKEN_MINT,
        CONSTRAINT_TOKEN_OWNER,
        CONSTRAINT_SPACE,
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
        AutopilotError::ERRORS
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
    onchain::fail::<NoisedAutopilot>(code, account)
}

/// [`fail`], then the two compared pubkeys as Anchor logs them.
#[inline(always)]
pub fn fail_keys(
    code: u32,
    account: Option<&'static str>,
    left: &Pubkey,
    right: &Pubkey,
) -> ProgramError {
    onchain::fail_keys::<NoisedAutopilot>(code, account, left, right)
}

/// [`fail`], then the two compared numbers as Anchor logs them
/// (`with_values`: `Left: <left>`, `Right: <right>`): the lines of
/// `noised_onchain::error::fail_values`, written without any code path that
/// can panic (a panic's formatted message would link `core::fmt`).
#[cold]
#[inline(never)]
pub fn fail_values(
    code: u32,
    account: Option<&'static str>,
    left: u64,
    right: u64,
) -> ProgramError {
    let e = fail(code, account);
    log_value(b"Left: ", left);
    log_value(b"Right: ", right);
    e
}

/// Logs `<label><n>`, `n` in decimal.
fn log_value(label: &[u8], mut n: u64) {
    // The digits, right to left, at the end of `digits` (u64::MAX has 20).
    let mut digits = [0u8; 20];
    let mut start = digits.len();
    while let Some(at) = start.checked_sub(1) {
        start = at;
        if let Some(digit) = digits.get_mut(at) {
            *digit = b'0' + (n % 10) as u8;
        }
        n /= 10;
        if n == 0 {
            break;
        }
    }
    let mut line = [0u8; 32];
    let mut len = 0;
    for byte in label.iter().chain(digits.get(start..).unwrap_or(&[])) {
        if let Some(slot) = line.get_mut(len) {
            *slot = *byte;
            len += 1;
        }
    }
    noised_onchain::sys::log_bytes(line.get(..len).unwrap_or(&[]));
}

/// `require_keys_eq!(left, right, e)` failed: `e` with both keys, no
/// account (Anchor's `error!(e).with_pubkeys((left, right))`).
#[inline(always)]
pub fn keys(e: AutopilotError, left: &Pubkey, right: &Pubkey) -> ProgramError {
    fail_keys(e.code(), None, left, right)
}

/// An [`AutopilotError`] raised by the program (`err!`, `require!`,
/// `.ok_or(e)?`), logged as Anchor logs it when it leaves the instruction:
/// `AnchorError occurred. Error Code: ...` (Anchor: `AnchorError thrown in
/// <file>:<line>. ...`, the source location of a file that no longer
/// exists).
impl From<AutopilotError> for ProgramError {
    #[inline(always)]
    fn from(e: AutopilotError) -> Self {
        onchain::raise::<NoisedAutopilot>(e.code())
    }
}

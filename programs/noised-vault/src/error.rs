//! Error numbers. The program's own errors are [`VaultError`] (6000 + the
//! variant index, as Anchor numbered them); the framework errors are the
//! numbers of anchor-lang 1.2.1's `ErrorCode` that the Anchor build returned
//! for the same conditions ([`anchor`]).
//!
//! Each such error is logged as Anchor logged it, built from static strings
//! (no formatting machinery in the binary):
//! `AnchorError caused by account: <field>. Error Code: <Name>. Error
//! Number: <n>. Error Message: <msg>.` (or `AnchorError occurred. ...`),
//! followed by `Left:` / `Right:` and the two pubkeys where Anchor logged
//! the compared keys. Errors of other programs and the runtime's own
//! (`ProgramError`) are returned unchanged and not logged.

use pinocchio::error::ProgramError;

use crate::{sys, Pubkey};

/// Anchor's `ERROR_CODE_OFFSET`: `VaultError` numbers start here.
pub const ERROR_CODE_OFFSET: u32 = 6000;

/// The program's errors. Clients map the numbers to messages, so they never
/// move: new variants are only ever appended.
#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VaultError {
    /// 6000: Key id does not match the LM-OTS public key.
    KeyIdMismatch,
    /// 6001: Invalid post-quantum signature.
    InvalidSignature,
    /// 6002: The next key must differ from the current key.
    InvalidNextKey,
    /// 6003: Mint cannot be held in a vault.
    UnsupportedMint,
    /// 6004: Destination is not the recipient's associated token account for this mint.
    InvalidDestination,
    /// 6005: Arithmetic overflow.
    MathOverflow,
    /// 6006: Key index q must be 0 for a new vault and the vault's sequence + 1 for the next key.
    InvalidKeyIndex,
}

impl From<VaultError> for u32 {
    fn from(e: VaultError) -> u32 {
        e as u32 + ERROR_CODE_OFFSET
    }
}

#[cfg(not(target_os = "solana"))]
impl VaultError {
    /// The variant name, as in the IDL.
    pub fn name(&self) -> &'static str {
        name_and_message(u32::from(*self)).0
    }

    /// The message, as in the IDL.
    pub fn message(&self) -> &'static str {
        name_and_message(u32::from(*self)).1
    }
}

#[cfg(not(target_os = "solana"))]
impl core::fmt::Display for VaultError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(self.message())
    }
}

/// The anchor-lang 1.2.1 `ErrorCode` numbers this program returns.
pub mod anchor {
    pub const INSTRUCTION_FALLBACK_NOT_FOUND: u32 = 101;
    pub const INSTRUCTION_DID_NOT_DESERIALIZE: u32 = 102;
    pub const EVENT_INSTRUCTION_STUB: u32 = 1500;
    pub const CONSTRAINT_MUT: u32 = 2000;
    pub const CONSTRAINT_HAS_ONE: u32 = 2001;
    pub const CONSTRAINT_RENT_EXEMPT: u32 = 2005;
    pub const CONSTRAINT_SEEDS: u32 = 2006;
    pub const CONSTRAINT_ASSOCIATED: u32 = 2009;
    pub const CONSTRAINT_CLOSE: u32 = 2011;
    pub const CONSTRAINT_ADDRESS: u32 = 2012;
    pub const CONSTRAINT_TOKEN_MINT: u32 = 2014;
    pub const CONSTRAINT_TOKEN_OWNER: u32 = 2015;
    pub const CONSTRAINT_TOKEN_TOKEN_PROGRAM: u32 = 2021;
    pub const CONSTRAINT_MINT_TOKEN_PROGRAM: u32 = 2022;
    pub const CONSTRAINT_ASSOCIATED_TOKEN_TOKEN_PROGRAM: u32 = 2023;
    pub const CONSTRAINT_DUPLICATE_MUTABLE_ACCOUNT: u32 = 2040;
    pub const ACCOUNT_DISCRIMINATOR_NOT_FOUND: u32 = 3001;
    pub const ACCOUNT_DISCRIMINATOR_MISMATCH: u32 = 3002;
    pub const ACCOUNT_DID_NOT_DESERIALIZE: u32 = 3003;
    pub const ACCOUNT_DID_NOT_SERIALIZE: u32 = 3004;
    pub const ACCOUNT_NOT_ENOUGH_KEYS: u32 = 3005;
    pub const ACCOUNT_OWNED_BY_WRONG_PROGRAM: u32 = 3007;
    pub const INVALID_PROGRAM_ID: u32 = 3008;
    pub const INVALID_PROGRAM_EXECUTABLE: u32 = 3009;
    pub const ACCOUNT_NOT_SIGNER: u32 = 3010;
    pub const ACCOUNT_NOT_INITIALIZED: u32 = 3012;
    pub const ACCOUNT_NOT_ASSOCIATED_TOKEN_ACCOUNT: u32 = 3014;
    pub const DECLARED_PROGRAM_ID_MISMATCH: u32 = 4100;
    pub const TRYING_TO_INIT_PAYER_AS_PROGRAM_ACCOUNT: u32 = 4101;
}

/// Name and message of every error number this program returns
/// (anchor-lang 1.2.1's `ErrorCode` texts, and the IDL's for `VaultError`).
/// Compile time only: the program carries it packed ([`PACKED`]).
const ERRORS: [(u32, &str, &str); 36] = {
    use anchor::*;
    [
        (
            INSTRUCTION_FALLBACK_NOT_FOUND,
            "InstructionFallbackNotFound",
            "Fallback functions are not supported",
        ),
        (
            INSTRUCTION_DID_NOT_DESERIALIZE,
            "InstructionDidNotDeserialize",
            "The program could not deserialize the given instruction",
        ),
        (
            EVENT_INSTRUCTION_STUB,
            "EventInstructionStub",
            "The program was compiled without `event-cpi` feature",
        ),
        (
            CONSTRAINT_MUT,
            "ConstraintMut",
            "A mut constraint was violated",
        ),
        (
            CONSTRAINT_HAS_ONE,
            "ConstraintHasOne",
            "A has one constraint was violated",
        ),
        (
            CONSTRAINT_RENT_EXEMPT,
            "ConstraintRentExempt",
            "A rent exemption constraint was violated",
        ),
        (
            CONSTRAINT_SEEDS,
            "ConstraintSeeds",
            "A seeds constraint was violated",
        ),
        (
            CONSTRAINT_ASSOCIATED,
            "ConstraintAssociated",
            "An associated constraint was violated",
        ),
        (
            CONSTRAINT_CLOSE,
            "ConstraintClose",
            "A close constraint was violated",
        ),
        (
            CONSTRAINT_ADDRESS,
            "ConstraintAddress",
            "An address constraint was violated",
        ),
        (
            CONSTRAINT_TOKEN_MINT,
            "ConstraintTokenMint",
            "A token mint constraint was violated",
        ),
        (
            CONSTRAINT_TOKEN_OWNER,
            "ConstraintTokenOwner",
            "A token owner constraint was violated",
        ),
        (
            CONSTRAINT_TOKEN_TOKEN_PROGRAM,
            "ConstraintTokenTokenProgram",
            "A token account token program constraint was violated",
        ),
        (
            CONSTRAINT_MINT_TOKEN_PROGRAM,
            "ConstraintMintTokenProgram",
            "A mint token program constraint was violated",
        ),
        (
            CONSTRAINT_ASSOCIATED_TOKEN_TOKEN_PROGRAM,
            "ConstraintAssociatedTokenTokenProgram",
            "An associated token account token program constraint was violated",
        ),
        (
            CONSTRAINT_DUPLICATE_MUTABLE_ACCOUNT,
            "ConstraintDuplicateMutableAccount",
            "A duplicate mutable account constraint was violated",
        ),
        (
            ACCOUNT_DISCRIMINATOR_NOT_FOUND,
            "AccountDiscriminatorNotFound",
            "No discriminator was found on the account",
        ),
        (
            ACCOUNT_DISCRIMINATOR_MISMATCH,
            "AccountDiscriminatorMismatch",
            "Account discriminator did not match what was expected",
        ),
        (
            ACCOUNT_DID_NOT_DESERIALIZE,
            "AccountDidNotDeserialize",
            "Failed to deserialize the account",
        ),
        (
            ACCOUNT_DID_NOT_SERIALIZE,
            "AccountDidNotSerialize",
            "Failed to serialize the account",
        ),
        (
            ACCOUNT_NOT_ENOUGH_KEYS,
            "AccountNotEnoughKeys",
            "Not enough account keys given to the instruction",
        ),
        (
            ACCOUNT_OWNED_BY_WRONG_PROGRAM,
            "AccountOwnedByWrongProgram",
            "The given account is owned by a different program than expected",
        ),
        (
            INVALID_PROGRAM_ID,
            "InvalidProgramId",
            "Program ID was not as expected",
        ),
        (
            INVALID_PROGRAM_EXECUTABLE,
            "InvalidProgramExecutable",
            "Program account is not executable",
        ),
        (
            ACCOUNT_NOT_SIGNER,
            "AccountNotSigner",
            "The given account did not sign",
        ),
        (
            ACCOUNT_NOT_INITIALIZED,
            "AccountNotInitialized",
            "The program expected this account to be already initialized",
        ),
        (
            ACCOUNT_NOT_ASSOCIATED_TOKEN_ACCOUNT,
            "AccountNotAssociatedTokenAccount",
            "The given account is not the associated token account",
        ),
        (
            DECLARED_PROGRAM_ID_MISMATCH,
            "DeclaredProgramIdMismatch",
            "The declared program id does not match the actual program id",
        ),
        (
            TRYING_TO_INIT_PAYER_AS_PROGRAM_ACCOUNT,
            "TryingToInitPayerAsProgramAccount",
            "You cannot/should not initialize the payer account as a program account",
        ),
        (
            6000,
            "KeyIdMismatch",
            "Key id does not match the LM-OTS public key",
        ),
        (6001, "InvalidSignature", "Invalid post-quantum signature"),
        (
            6002,
            "InvalidNextKey",
            "The next key must differ from the current key",
        ),
        (6003, "UnsupportedMint", "Mint cannot be held in a vault"),
        (
            6004,
            "InvalidDestination",
            "Destination is not the recipient's associated token account for this mint",
        ),
        (6005, "MathOverflow", "Arithmetic overflow"),
        (
            6006,
            "InvalidKeyIndex",
            "Key index q must be 0 for a new vault and the vault's sequence + 1 for the next key",
        ),
    ]
};

/// The decimal digits of `n`.
const fn digits(n: u32) -> usize {
    let mut count = 1;
    let mut rest = n / 10;
    while rest > 0 {
        count += 1;
        rest /= 10;
    }
    count
}

const fn text_len() -> usize {
    let mut len = 0;
    let mut i = 0;
    while i < ERRORS.len() {
        len += ERRORS[i].1.len() + digits(ERRORS[i].0) + ERRORS[i].2.len();
        i += 1;
    }
    len
}

const TEXT_LEN: usize = text_len();

const fn put(text: &mut [u8; TEXT_LEN], mut at: usize, bytes: &[u8]) -> usize {
    let mut i = 0;
    while i < bytes.len() {
        text[at] = bytes[i];
        at += 1;
        i += 1;
    }
    at
}

const fn put_number(text: &mut [u8; TEXT_LEN], at: usize, n: u32) -> usize {
    let end = at + digits(n);
    let mut i = end;
    let mut rest = n;
    while i > at {
        i -= 1;
        text[i] = b'0' + (rest % 10) as u8;
        rest /= 10;
    }
    end
}

/// [`ERRORS`] packed at compile time: every entry's name, decimal number and
/// message back to back, and per entry `[number, name start, number start,
/// message start]` (a message ends where the next name starts).
const fn pack() -> ([u8; TEXT_LEN], [[u16; 4]; ERRORS.len()]) {
    let mut text = [0u8; TEXT_LEN];
    let mut index = [[0u16; 4]; ERRORS.len()];
    let mut at = 0;
    let mut i = 0;
    while i < ERRORS.len() {
        let (code, name, message) = ERRORS[i];
        assert!(code <= u16::MAX as u32 && TEXT_LEN <= u16::MAX as usize);
        index[i][0] = code as u16;
        index[i][1] = at as u16;
        at = put(&mut text, at, name.as_bytes());
        index[i][2] = at as u16;
        at = put_number(&mut text, at, code);
        index[i][3] = at as u16;
        at = put(&mut text, at, message.as_bytes());
        i += 1;
    }
    (text, index)
}

static PACKED: ([u8; TEXT_LEN], [[u16; 4]; ERRORS.len()]) = pack();

/// Name, decimal number and message of error `code` (empty for a number
/// this program never returns).
pub fn describe(code: u32) -> [&'static [u8]; 3] {
    let (text, index) = &PACKED;
    // A plain loop over the index (`black_box` keeps it from being unrolled).
    let index = core::hint::black_box(&index[..]);
    let Some(i) = index.iter().position(|entry| u32::from(entry[0]) == code) else {
        return [b"", b"", b""];
    };
    let [_, name, number, message] = index.get(i).copied().unwrap_or_default();
    let end = index
        .get(i + 1)
        .map_or(TEXT_LEN, |next| usize::from(next[1]));
    let piece = |from: u16, to: usize| text.get(usize::from(from)..to).unwrap_or(&[]);
    [
        piece(name, usize::from(number)),
        piece(number, usize::from(message)),
        piece(message, end),
    ]
}

/// Every error number this program can log.
pub fn numbers() -> impl Iterator<Item = u32> {
    PACKED.1.iter().map(|entry| u32::from(entry[0]))
}

/// Name and message of error `code` (host only).
#[cfg(not(target_os = "solana"))]
pub fn name_and_message(code: u32) -> (&'static str, &'static str) {
    let [name, _, message] = describe(code);
    (
        core::str::from_utf8(name).expect("ASCII"),
        core::str::from_utf8(message).expect("ASCII"),
    )
}
/// Logs Anchor's line for error `code` raised on the account field
/// `account` (or with no account) and returns the error.
#[cold]
#[inline(never)]
pub fn fail(code: u32, account: Option<&'static str>) -> ProgramError {
    let [name, number, message] = describe(code);
    let (origin, field) = match account {
        Some(account) => ("caused by account: ", account),
        None => ("occurred", ""),
    };
    let pieces: [&[u8]; 10] = [
        b"AnchorError ",
        origin.as_bytes(),
        field.as_bytes(),
        b". Error Code: ",
        name,
        b". Error Number: ",
        number,
        b". Error Message: ",
        message,
        b".",
    ];
    let mut line = [0u8; 256];
    let mut len = 0usize;
    for piece in core::hint::black_box(&pieces[..]) {
        for byte in *piece {
            if let Some(slot) = line.get_mut(len) {
                *slot = *byte;
                len += 1;
            }
        }
    }
    sys::log_bytes(line.get(..len).unwrap_or(&[]));
    ProgramError::Custom(code)
}
/// [`fail`], then the two compared pubkeys as Anchor logs them.
#[cold]
#[inline(never)]
pub fn fail_keys(
    code: u32,
    account: Option<&'static str>,
    left: &Pubkey,
    right: &Pubkey,
) -> ProgramError {
    let e = fail(code, account);
    sys::log("Left:");
    sys::log_pubkey(left);
    sys::log("Right:");
    sys::log_pubkey(right);
    e
}

/// [`fail`] for a [`VaultError`].
#[cold]
#[inline(never)]
pub fn vault(e: VaultError) -> ProgramError {
    fail(u32::from(e), None)
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

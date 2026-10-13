//! Error numbers and Anchor's error log lines.
//!
//! The framework errors are anchor-lang 1.2.1's `ErrorCode` numbers
//! ([`anchor`]); a program's own errors are an enum declared with
//! [`custom_errors!`](crate::custom_errors) (6000 + the variant index, as
//! `#[error_code]` numbers them). Each program packs the numbers it can
//! return, with their names and messages, into one [`ErrorTable`] at
//! compile time ([`error_table!`](crate::error_table)); a binary carries
//! only that table, never the whole of Anchor's.
//!
//! An error is logged as Anchor logs an `AnchorError`, built from static
//! strings (no formatting machinery in the binary):
//! `AnchorError caused by account: <field>. Error Code: <Name>. Error
//! Number: <n>. Error Message: <msg>.` (or `AnchorError occurred. ...`),
//! followed by `Left:` / `Right:` and the two pubkeys ([`fail_keys`]) or
//! values ([`fail_values`]) where Anchor logged the compared pair.
//!
//! Not reproduced (log text only; the error numbers are exact): Anchor
//! logs errors raised by `require!` / `err!` / `error!` as `AnchorError
//! thrown in <file>:<line>. ...`, and `ProgramError`s (other programs', the
//! runtime's, SPL parsing errors) as `ProgramError occurred. ...`. Here the
//! former log `AnchorError occurred. ...` ([`raise`]) and the latter are
//! returned unchanged and not logged.

use pinocchio::error::ProgramError;

use crate::{sys, Address, Program};

/// Anchor's `ERROR_CODE_OFFSET`: a program's own error numbers start here.
pub const ERROR_CODE_OFFSET: u32 = 6000;

/// An error: number, name (`ErrorCode::name`) and message (`#[msg]`).
pub type ErrorEntry = (u32, &'static str, &'static str);

/// The numbers of anchor-lang 1.2.1's `ErrorCode` (all of them).
pub mod anchor {
    /// `InstructionMissing`: Instruction discriminator not provided.
    pub const INSTRUCTION_MISSING: u32 = 100;
    /// `InstructionFallbackNotFound`: Fallback functions are not supported.
    pub const INSTRUCTION_FALLBACK_NOT_FOUND: u32 = 101;
    /// `InstructionDidNotDeserialize`: The program could not deserialize the given instruction.
    pub const INSTRUCTION_DID_NOT_DESERIALIZE: u32 = 102;
    /// `InstructionDidNotSerialize`: The program could not serialize the given instruction.
    pub const INSTRUCTION_DID_NOT_SERIALIZE: u32 = 103;
    /// `IdlInstructionStub`: The program was compiled without idl instructions.
    pub const IDL_INSTRUCTION_STUB: u32 = 1000;
    /// `IdlInstructionInvalidProgram`: Invalid program given to the IDL instruction.
    pub const IDL_INSTRUCTION_INVALID_PROGRAM: u32 = 1001;
    /// `IdlAccountNotEmpty`: IDL account must be empty in order to resize, try closing first.
    pub const IDL_ACCOUNT_NOT_EMPTY: u32 = 1002;
    /// `EventInstructionStub`: The program was compiled without `event-cpi` feature.
    pub const EVENT_INSTRUCTION_STUB: u32 = 1500;
    /// `ConstraintMut`: A mut constraint was violated.
    pub const CONSTRAINT_MUT: u32 = 2000;
    /// `ConstraintHasOne`: A has one constraint was violated.
    pub const CONSTRAINT_HAS_ONE: u32 = 2001;
    /// `ConstraintSigner`: A signer constraint was violated.
    pub const CONSTRAINT_SIGNER: u32 = 2002;
    /// `ConstraintRaw`: A raw constraint was violated.
    pub const CONSTRAINT_RAW: u32 = 2003;
    /// `ConstraintOwner`: An owner constraint was violated.
    pub const CONSTRAINT_OWNER: u32 = 2004;
    /// `ConstraintRentExempt`: A rent exemption constraint was violated.
    pub const CONSTRAINT_RENT_EXEMPT: u32 = 2005;
    /// `ConstraintSeeds`: A seeds constraint was violated.
    pub const CONSTRAINT_SEEDS: u32 = 2006;
    /// `ConstraintExecutable`: An executable constraint was violated.
    pub const CONSTRAINT_EXECUTABLE: u32 = 2007;
    /// `ConstraintState`: Deprecated Error, feel free to replace with something else.
    pub const CONSTRAINT_STATE: u32 = 2008;
    /// `ConstraintAssociated`: An associated constraint was violated.
    pub const CONSTRAINT_ASSOCIATED: u32 = 2009;
    /// `ConstraintAssociatedInit`: An associated init constraint was violated.
    pub const CONSTRAINT_ASSOCIATED_INIT: u32 = 2010;
    /// `ConstraintClose`: A close constraint was violated.
    pub const CONSTRAINT_CLOSE: u32 = 2011;
    /// `ConstraintAddress`: An address constraint was violated.
    pub const CONSTRAINT_ADDRESS: u32 = 2012;
    /// `ConstraintZero`: Expected zero account discriminant.
    pub const CONSTRAINT_ZERO: u32 = 2013;
    /// `ConstraintTokenMint`: A token mint constraint was violated.
    pub const CONSTRAINT_TOKEN_MINT: u32 = 2014;
    /// `ConstraintTokenOwner`: A token owner constraint was violated.
    pub const CONSTRAINT_TOKEN_OWNER: u32 = 2015;
    /// `ConstraintMintMintAuthority`: A mint mint authority constraint was violated.
    pub const CONSTRAINT_MINT_MINT_AUTHORITY: u32 = 2016;
    /// `ConstraintMintFreezeAuthority`: A mint freeze authority constraint was violated.
    pub const CONSTRAINT_MINT_FREEZE_AUTHORITY: u32 = 2017;
    /// `ConstraintMintDecimals`: A mint decimals constraint was violated.
    pub const CONSTRAINT_MINT_DECIMALS: u32 = 2018;
    /// `ConstraintSpace`: A space constraint was violated.
    pub const CONSTRAINT_SPACE: u32 = 2019;
    /// `ConstraintAccountIsNone`: A required account for the constraint is None.
    pub const CONSTRAINT_ACCOUNT_IS_NONE: u32 = 2020;
    /// `ConstraintTokenTokenProgram`: A token account token program constraint was violated.
    pub const CONSTRAINT_TOKEN_TOKEN_PROGRAM: u32 = 2021;
    /// `ConstraintMintTokenProgram`: A mint token program constraint was violated.
    pub const CONSTRAINT_MINT_TOKEN_PROGRAM: u32 = 2022;
    /// `ConstraintAssociatedTokenTokenProgram`: An associated token account token program constraint was violated.
    pub const CONSTRAINT_ASSOCIATED_TOKEN_TOKEN_PROGRAM: u32 = 2023;
    /// `ConstraintMintGroupPointerExtension`: A group pointer extension constraint was violated.
    pub const CONSTRAINT_MINT_GROUP_POINTER_EXTENSION: u32 = 2024;
    /// `ConstraintMintGroupPointerExtensionAuthority`: A group pointer extension authority constraint was violated.
    pub const CONSTRAINT_MINT_GROUP_POINTER_EXTENSION_AUTHORITY: u32 = 2025;
    /// `ConstraintMintGroupPointerExtensionGroupAddress`: A group pointer extension group address constraint was violated.
    pub const CONSTRAINT_MINT_GROUP_POINTER_EXTENSION_GROUP_ADDRESS: u32 = 2026;
    /// `ConstraintMintGroupMemberPointerExtension`: A group member pointer extension constraint was violated.
    pub const CONSTRAINT_MINT_GROUP_MEMBER_POINTER_EXTENSION: u32 = 2027;
    /// `ConstraintMintGroupMemberPointerExtensionAuthority`: A group member pointer extension authority constraint was violated.
    pub const CONSTRAINT_MINT_GROUP_MEMBER_POINTER_EXTENSION_AUTHORITY: u32 = 2028;
    /// `ConstraintMintGroupMemberPointerExtensionMemberAddress`: A group member pointer extension group address constraint was violated.
    pub const CONSTRAINT_MINT_GROUP_MEMBER_POINTER_EXTENSION_MEMBER_ADDRESS: u32 = 2029;
    /// `ConstraintMintMetadataPointerExtension`: A metadata pointer extension constraint was violated.
    pub const CONSTRAINT_MINT_METADATA_POINTER_EXTENSION: u32 = 2030;
    /// `ConstraintMintMetadataPointerExtensionAuthority`: A metadata pointer extension authority constraint was violated.
    pub const CONSTRAINT_MINT_METADATA_POINTER_EXTENSION_AUTHORITY: u32 = 2031;
    /// `ConstraintMintMetadataPointerExtensionMetadataAddress`: A metadata pointer extension metadata address constraint was violated.
    pub const CONSTRAINT_MINT_METADATA_POINTER_EXTENSION_METADATA_ADDRESS: u32 = 2032;
    /// `ConstraintMintCloseAuthorityExtension`: A close authority constraint was violated.
    pub const CONSTRAINT_MINT_CLOSE_AUTHORITY_EXTENSION: u32 = 2033;
    /// `ConstraintMintCloseAuthorityExtensionAuthority`: A close authority extension authority constraint was violated.
    pub const CONSTRAINT_MINT_CLOSE_AUTHORITY_EXTENSION_AUTHORITY: u32 = 2034;
    /// `ConstraintMintPermanentDelegateExtension`: A permanent delegate extension constraint was violated.
    pub const CONSTRAINT_MINT_PERMANENT_DELEGATE_EXTENSION: u32 = 2035;
    /// `ConstraintMintPermanentDelegateExtensionDelegate`: A permanent delegate extension delegate constraint was violated.
    pub const CONSTRAINT_MINT_PERMANENT_DELEGATE_EXTENSION_DELEGATE: u32 = 2036;
    /// `ConstraintMintTransferHookExtension`: A transfer hook extension constraint was violated.
    pub const CONSTRAINT_MINT_TRANSFER_HOOK_EXTENSION: u32 = 2037;
    /// `ConstraintMintTransferHookExtensionAuthority`: A transfer hook extension authority constraint was violated.
    pub const CONSTRAINT_MINT_TRANSFER_HOOK_EXTENSION_AUTHORITY: u32 = 2038;
    /// `ConstraintMintTransferHookExtensionProgramId`: A transfer hook extension transfer hook program id constraint was violated.
    pub const CONSTRAINT_MINT_TRANSFER_HOOK_EXTENSION_PROGRAM_ID: u32 = 2039;
    /// `ConstraintDuplicateMutableAccount`: A duplicate mutable account constraint was violated.
    pub const CONSTRAINT_DUPLICATE_MUTABLE_ACCOUNT: u32 = 2040;
    /// `AccountAlreadyMigrated`: Account is already migrated.
    pub const ACCOUNT_ALREADY_MIGRATED: u32 = 2041;
    /// `AccountNotMigrated`: Account must be migrated before exiting.
    pub const ACCOUNT_NOT_MIGRATED: u32 = 2042;
    /// `ConstraintMintPausableExtension`: A pausable extension constraint was violated.
    pub const CONSTRAINT_MINT_PAUSABLE_EXTENSION: u32 = 2043;
    /// `ConstraintMintPausableAuthority`: A pausable extension authority constraint was violated.
    pub const CONSTRAINT_MINT_PAUSABLE_AUTHORITY: u32 = 2044;
    /// `RequireViolated`: A require expression was violated.
    pub const REQUIRE_VIOLATED: u32 = 2500;
    /// `RequireEqViolated`: A require_eq expression was violated.
    pub const REQUIRE_EQ_VIOLATED: u32 = 2501;
    /// `RequireKeysEqViolated`: A require_keys_eq expression was violated.
    pub const REQUIRE_KEYS_EQ_VIOLATED: u32 = 2502;
    /// `RequireNeqViolated`: A require_neq expression was violated.
    pub const REQUIRE_NEQ_VIOLATED: u32 = 2503;
    /// `RequireKeysNeqViolated`: A require_keys_neq expression was violated.
    pub const REQUIRE_KEYS_NEQ_VIOLATED: u32 = 2504;
    /// `RequireGtViolated`: A require_gt expression was violated.
    pub const REQUIRE_GT_VIOLATED: u32 = 2505;
    /// `RequireGteViolated`: A require_gte expression was violated.
    pub const REQUIRE_GTE_VIOLATED: u32 = 2506;
    /// `AccountDiscriminatorAlreadySet`: The account discriminator was already set on this account.
    pub const ACCOUNT_DISCRIMINATOR_ALREADY_SET: u32 = 3000;
    /// `AccountDiscriminatorNotFound`: No discriminator was found on the account.
    pub const ACCOUNT_DISCRIMINATOR_NOT_FOUND: u32 = 3001;
    /// `AccountDiscriminatorMismatch`: Account discriminator did not match what was expected.
    pub const ACCOUNT_DISCRIMINATOR_MISMATCH: u32 = 3002;
    /// `AccountDidNotDeserialize`: Failed to deserialize the account.
    pub const ACCOUNT_DID_NOT_DESERIALIZE: u32 = 3003;
    /// `AccountDidNotSerialize`: Failed to serialize the account.
    pub const ACCOUNT_DID_NOT_SERIALIZE: u32 = 3004;
    /// `AccountNotEnoughKeys`: Not enough account keys given to the instruction.
    pub const ACCOUNT_NOT_ENOUGH_KEYS: u32 = 3005;
    /// `AccountNotMutable`: The given account is not mutable.
    pub const ACCOUNT_NOT_MUTABLE: u32 = 3006;
    /// `AccountOwnedByWrongProgram`: The given account is owned by a different program than expected.
    pub const ACCOUNT_OWNED_BY_WRONG_PROGRAM: u32 = 3007;
    /// `InvalidProgramId`: Program ID was not as expected.
    pub const INVALID_PROGRAM_ID: u32 = 3008;
    /// `InvalidProgramExecutable`: Program account is not executable.
    pub const INVALID_PROGRAM_EXECUTABLE: u32 = 3009;
    /// `AccountNotSigner`: The given account did not sign.
    pub const ACCOUNT_NOT_SIGNER: u32 = 3010;
    /// `AccountNotSystemOwned`: The given account is not owned by the system program.
    pub const ACCOUNT_NOT_SYSTEM_OWNED: u32 = 3011;
    /// `AccountNotInitialized`: The program expected this account to be already initialized.
    pub const ACCOUNT_NOT_INITIALIZED: u32 = 3012;
    /// `AccountNotProgramData`: The given account is not a program data account.
    pub const ACCOUNT_NOT_PROGRAM_DATA: u32 = 3013;
    /// `AccountNotAssociatedTokenAccount`: The given account is not the associated token account.
    pub const ACCOUNT_NOT_ASSOCIATED_TOKEN_ACCOUNT: u32 = 3014;
    /// `AccountSysvarMismatch`: The given public key does not match the required sysvar.
    pub const ACCOUNT_SYSVAR_MISMATCH: u32 = 3015;
    /// `AccountReallocExceedsLimit`: The account reallocation exceeds the MAX_PERMITTED_DATA_INCREASE limit.
    pub const ACCOUNT_REALLOC_EXCEEDS_LIMIT: u32 = 3016;
    /// `AccountDuplicateReallocs`: The account was duplicated for more than one reallocation.
    pub const ACCOUNT_DUPLICATE_REALLOCS: u32 = 3017;
    /// `DeclaredProgramIdMismatch`: The declared program id does not match the actual program id.
    pub const DECLARED_PROGRAM_ID_MISMATCH: u32 = 4100;
    /// `TryingToInitPayerAsProgramAccount`: You cannot/should not initialize the payer account as a program account.
    pub const TRYING_TO_INIT_PAYER_AS_PROGRAM_ACCOUNT: u32 = 4101;
    /// `InvalidNumericConversion`: Error during numeric conversion.
    pub const INVALID_NUMERIC_CONVERSION: u32 = 4102;
    /// `Deprecated`: The API being used is deprecated and should no longer be used.
    pub const DEPRECATED: u32 = 5000;
}

/// Name and message of every anchor-lang 1.2.1 `ErrorCode`, in number
/// order. Compile time only: [`error_table!`](crate::error_table) copies the
/// entries a program selects into its [`ErrorTable`].
pub const ANCHOR_ERRORS: [ErrorEntry; 82] = {
    use anchor::*;
    [
        (
            INSTRUCTION_MISSING,
            "InstructionMissing",
            "Instruction discriminator not provided",
        ),
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
            INSTRUCTION_DID_NOT_SERIALIZE,
            "InstructionDidNotSerialize",
            "The program could not serialize the given instruction",
        ),
        (
            IDL_INSTRUCTION_STUB,
            "IdlInstructionStub",
            "The program was compiled without idl instructions",
        ),
        (
            IDL_INSTRUCTION_INVALID_PROGRAM,
            "IdlInstructionInvalidProgram",
            "Invalid program given to the IDL instruction",
        ),
        (
            IDL_ACCOUNT_NOT_EMPTY,
            "IdlAccountNotEmpty",
            "IDL account must be empty in order to resize, try closing first",
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
            CONSTRAINT_SIGNER,
            "ConstraintSigner",
            "A signer constraint was violated",
        ),
        (
            CONSTRAINT_RAW,
            "ConstraintRaw",
            "A raw constraint was violated",
        ),
        (
            CONSTRAINT_OWNER,
            "ConstraintOwner",
            "An owner constraint was violated",
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
            CONSTRAINT_EXECUTABLE,
            "ConstraintExecutable",
            "An executable constraint was violated",
        ),
        (
            CONSTRAINT_STATE,
            "ConstraintState",
            "Deprecated Error, feel free to replace with something else",
        ),
        (
            CONSTRAINT_ASSOCIATED,
            "ConstraintAssociated",
            "An associated constraint was violated",
        ),
        (
            CONSTRAINT_ASSOCIATED_INIT,
            "ConstraintAssociatedInit",
            "An associated init constraint was violated",
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
            CONSTRAINT_ZERO,
            "ConstraintZero",
            "Expected zero account discriminant",
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
            CONSTRAINT_MINT_MINT_AUTHORITY,
            "ConstraintMintMintAuthority",
            "A mint mint authority constraint was violated",
        ),
        (
            CONSTRAINT_MINT_FREEZE_AUTHORITY,
            "ConstraintMintFreezeAuthority",
            "A mint freeze authority constraint was violated",
        ),
        (
            CONSTRAINT_MINT_DECIMALS,
            "ConstraintMintDecimals",
            "A mint decimals constraint was violated",
        ),
        (
            CONSTRAINT_SPACE,
            "ConstraintSpace",
            "A space constraint was violated",
        ),
        (
            CONSTRAINT_ACCOUNT_IS_NONE,
            "ConstraintAccountIsNone",
            "A required account for the constraint is None",
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
            CONSTRAINT_MINT_GROUP_POINTER_EXTENSION,
            "ConstraintMintGroupPointerExtension",
            "A group pointer extension constraint was violated",
        ),
        (
            CONSTRAINT_MINT_GROUP_POINTER_EXTENSION_AUTHORITY,
            "ConstraintMintGroupPointerExtensionAuthority",
            "A group pointer extension authority constraint was violated",
        ),
        (
            CONSTRAINT_MINT_GROUP_POINTER_EXTENSION_GROUP_ADDRESS,
            "ConstraintMintGroupPointerExtensionGroupAddress",
            "A group pointer extension group address constraint was violated",
        ),
        (
            CONSTRAINT_MINT_GROUP_MEMBER_POINTER_EXTENSION,
            "ConstraintMintGroupMemberPointerExtension",
            "A group member pointer extension constraint was violated",
        ),
        (
            CONSTRAINT_MINT_GROUP_MEMBER_POINTER_EXTENSION_AUTHORITY,
            "ConstraintMintGroupMemberPointerExtensionAuthority",
            "A group member pointer extension authority constraint was violated",
        ),
        (
            CONSTRAINT_MINT_GROUP_MEMBER_POINTER_EXTENSION_MEMBER_ADDRESS,
            "ConstraintMintGroupMemberPointerExtensionMemberAddress",
            "A group member pointer extension group address constraint was violated",
        ),
        (
            CONSTRAINT_MINT_METADATA_POINTER_EXTENSION,
            "ConstraintMintMetadataPointerExtension",
            "A metadata pointer extension constraint was violated",
        ),
        (
            CONSTRAINT_MINT_METADATA_POINTER_EXTENSION_AUTHORITY,
            "ConstraintMintMetadataPointerExtensionAuthority",
            "A metadata pointer extension authority constraint was violated",
        ),
        (
            CONSTRAINT_MINT_METADATA_POINTER_EXTENSION_METADATA_ADDRESS,
            "ConstraintMintMetadataPointerExtensionMetadataAddress",
            "A metadata pointer extension metadata address constraint was violated",
        ),
        (
            CONSTRAINT_MINT_CLOSE_AUTHORITY_EXTENSION,
            "ConstraintMintCloseAuthorityExtension",
            "A close authority constraint was violated",
        ),
        (
            CONSTRAINT_MINT_CLOSE_AUTHORITY_EXTENSION_AUTHORITY,
            "ConstraintMintCloseAuthorityExtensionAuthority",
            "A close authority extension authority constraint was violated",
        ),
        (
            CONSTRAINT_MINT_PERMANENT_DELEGATE_EXTENSION,
            "ConstraintMintPermanentDelegateExtension",
            "A permanent delegate extension constraint was violated",
        ),
        (
            CONSTRAINT_MINT_PERMANENT_DELEGATE_EXTENSION_DELEGATE,
            "ConstraintMintPermanentDelegateExtensionDelegate",
            "A permanent delegate extension delegate constraint was violated",
        ),
        (
            CONSTRAINT_MINT_TRANSFER_HOOK_EXTENSION,
            "ConstraintMintTransferHookExtension",
            "A transfer hook extension constraint was violated",
        ),
        (
            CONSTRAINT_MINT_TRANSFER_HOOK_EXTENSION_AUTHORITY,
            "ConstraintMintTransferHookExtensionAuthority",
            "A transfer hook extension authority constraint was violated",
        ),
        (
            CONSTRAINT_MINT_TRANSFER_HOOK_EXTENSION_PROGRAM_ID,
            "ConstraintMintTransferHookExtensionProgramId",
            "A transfer hook extension transfer hook program id constraint was violated",
        ),
        (
            CONSTRAINT_DUPLICATE_MUTABLE_ACCOUNT,
            "ConstraintDuplicateMutableAccount",
            "A duplicate mutable account constraint was violated",
        ),
        (
            ACCOUNT_ALREADY_MIGRATED,
            "AccountAlreadyMigrated",
            "Account is already migrated",
        ),
        (
            ACCOUNT_NOT_MIGRATED,
            "AccountNotMigrated",
            "Account must be migrated before exiting",
        ),
        (
            CONSTRAINT_MINT_PAUSABLE_EXTENSION,
            "ConstraintMintPausableExtension",
            "A pausable extension constraint was violated",
        ),
        (
            CONSTRAINT_MINT_PAUSABLE_AUTHORITY,
            "ConstraintMintPausableAuthority",
            "A pausable extension authority constraint was violated",
        ),
        (
            REQUIRE_VIOLATED,
            "RequireViolated",
            "A require expression was violated",
        ),
        (
            REQUIRE_EQ_VIOLATED,
            "RequireEqViolated",
            "A require_eq expression was violated",
        ),
        (
            REQUIRE_KEYS_EQ_VIOLATED,
            "RequireKeysEqViolated",
            "A require_keys_eq expression was violated",
        ),
        (
            REQUIRE_NEQ_VIOLATED,
            "RequireNeqViolated",
            "A require_neq expression was violated",
        ),
        (
            REQUIRE_KEYS_NEQ_VIOLATED,
            "RequireKeysNeqViolated",
            "A require_keys_neq expression was violated",
        ),
        (
            REQUIRE_GT_VIOLATED,
            "RequireGtViolated",
            "A require_gt expression was violated",
        ),
        (
            REQUIRE_GTE_VIOLATED,
            "RequireGteViolated",
            "A require_gte expression was violated",
        ),
        (
            ACCOUNT_DISCRIMINATOR_ALREADY_SET,
            "AccountDiscriminatorAlreadySet",
            "The account discriminator was already set on this account",
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
            ACCOUNT_NOT_MUTABLE,
            "AccountNotMutable",
            "The given account is not mutable",
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
            ACCOUNT_NOT_SYSTEM_OWNED,
            "AccountNotSystemOwned",
            "The given account is not owned by the system program",
        ),
        (
            ACCOUNT_NOT_INITIALIZED,
            "AccountNotInitialized",
            "The program expected this account to be already initialized",
        ),
        (
            ACCOUNT_NOT_PROGRAM_DATA,
            "AccountNotProgramData",
            "The given account is not a program data account",
        ),
        (
            ACCOUNT_NOT_ASSOCIATED_TOKEN_ACCOUNT,
            "AccountNotAssociatedTokenAccount",
            "The given account is not the associated token account",
        ),
        (
            ACCOUNT_SYSVAR_MISMATCH,
            "AccountSysvarMismatch",
            "The given public key does not match the required sysvar",
        ),
        (
            ACCOUNT_REALLOC_EXCEEDS_LIMIT,
            "AccountReallocExceedsLimit",
            "The account reallocation exceeds the MAX_PERMITTED_DATA_INCREASE limit",
        ),
        (
            ACCOUNT_DUPLICATE_REALLOCS,
            "AccountDuplicateReallocs",
            "The account was duplicated for more than one reallocation",
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
            INVALID_NUMERIC_CONVERSION,
            "InvalidNumericConversion",
            "Error during numeric conversion",
        ),
        (
            DEPRECATED,
            "Deprecated",
            "The API being used is deprecated and should no longer be used",
        ),
    ]
};

/// The error numbers a program logs with their names and messages, packed
/// at compile time ([`error_table!`](crate::error_table)): every entry's
/// name, decimal number and message back to back in `text`, and per entry
/// `[number, name start, number start, message start]` in `index` (a
/// message ends where the next name starts).
#[derive(Clone, Copy, Debug)]
pub struct ErrorTable {
    text: &'static [u8],
    index: &'static [[u16; 4]],
}

impl ErrorTable {
    #[doc(hidden)]
    #[inline]
    pub const fn new(text: &'static [u8], index: &'static [[u16; 4]]) -> Self {
        Self { text, index }
    }

    /// Name, decimal number and message of error `code` (all empty for a
    /// number the table does not hold).
    #[inline]
    pub fn describe(&self, code: u32) -> [&'static [u8]; 3] {
        let (text, index) = (self.text, self.index);
        // A plain loop over the index (`black_box` keeps it from being unrolled).
        let index = core::hint::black_box(index);
        let Some(i) = index.iter().position(|entry| u32::from(entry[0]) == code) else {
            return [b"", b"", b""];
        };
        let [_, name, number, message] = index.get(i).copied().unwrap_or_default();
        let end = index
            .get(i + 1)
            .map_or(text.len(), |next| usize::from(next[1]));
        let piece = |from: u16, to: usize| text.get(usize::from(from)..to).unwrap_or(&[]);
        [
            piece(name, usize::from(number)),
            piece(number, usize::from(message)),
            piece(message, end),
        ]
    }

    /// Every error number of the table.
    #[inline]
    pub fn numbers(&self) -> impl Iterator<Item = u32> + '_ {
        self.index.iter().map(|entry| u32::from(entry[0]))
    }

    /// Name and message of error `code` (host only; empty when absent).
    #[cfg(not(target_os = "solana"))]
    #[inline]
    pub fn name_and_message(&self, code: u32) -> (&'static str, &'static str) {
        let [name, _, message] = self.describe(code);
        (
            core::str::from_utf8(name).expect("ASCII"),
            core::str::from_utf8(message).expect("ASCII"),
        )
    }
}

/// The anchor-lang 1.2.1 entry of framework error `code`; a compile error
/// (in const evaluation) for a number Anchor does not define.
#[inline]
pub const fn anchor_entry(code: u32) -> ErrorEntry {
    let mut i = 0;
    while i < ANCHOR_ERRORS.len() {
        if ANCHOR_ERRORS[i].0 == code {
            return ANCHOR_ERRORS[i];
        }
        i += 1;
    }
    panic!("not an anchor-lang 1.2.1 ErrorCode number")
}

#[doc(hidden)]
pub const fn entries<const N: usize>(framework: &[u32], custom: &[ErrorEntry]) -> [ErrorEntry; N] {
    assert!(framework.len() + custom.len() == N);
    let mut out: [ErrorEntry; N] = [(0, "", ""); N];
    let mut i = 0;
    while i < framework.len() {
        out[i] = anchor_entry(framework[i]);
        i += 1;
    }
    let mut j = 0;
    while j < custom.len() {
        out[i + j] = custom[j];
        j += 1;
    }
    // Each number once.
    let mut a = 0;
    while a < N {
        let mut b = a + 1;
        while b < N {
            assert!(out[a].0 != out[b].0, "an error number is listed twice");
            b += 1;
        }
        a += 1;
    }
    out
}

/// The decimal digits of `n`.
#[inline]
const fn digits(n: u32) -> usize {
    let mut count = 1;
    let mut rest = n / 10;
    while rest > 0 {
        count += 1;
        rest /= 10;
    }
    count
}

#[doc(hidden)]
#[inline]
pub const fn text_len(entries: &[ErrorEntry]) -> usize {
    let mut len = 0;
    let mut i = 0;
    while i < entries.len() {
        len += entries[i].1.len() + digits(entries[i].0) + entries[i].2.len();
        i += 1;
    }
    len
}

const fn put<const T: usize>(text: &mut [u8; T], mut at: usize, bytes: &[u8]) -> usize {
    let mut i = 0;
    while i < bytes.len() {
        text[at] = bytes[i];
        at += 1;
        i += 1;
    }
    at
}

const fn put_number<const T: usize>(text: &mut [u8; T], at: usize, n: u32) -> usize {
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

#[doc(hidden)]
pub const fn pack<const T: usize, const N: usize>(
    entries: &[ErrorEntry; N],
) -> ([u8; T], [[u16; 4]; N]) {
    let mut text = [0u8; T];
    let mut index = [[0u16; 4]; N];
    let mut at = 0;
    let mut i = 0;
    while i < N {
        let (code, name, message) = entries[i];
        assert!(code <= u16::MAX as u32 && T <= u16::MAX as usize);
        index[i][0] = code as u16;
        index[i][1] = at as u16;
        at = put(&mut text, at, name.as_bytes());
        index[i][2] = at as u16;
        at = put_number(&mut text, at, code);
        index[i][3] = at as u16;
        at = put(&mut text, at, message.as_bytes());
        i += 1;
    }
    assert!(at == T);
    (text, index)
}

/// The [`ErrorTable`] of a program: the framework errors it can return, by
/// number (their anchor-lang 1.2.1 names and messages are looked up at
/// compile time), then, after a `;`, its own errors (the `ERRORS` of a
/// [`custom_errors!`](crate::custom_errors) enum):
///
/// ```ignore
/// impl Program for NoisedVault {
///     const ID: Address = ID;
///     const ERRORS: ErrorTable = noised_onchain::error_table![
///         anchor::INSTRUCTION_FALLBACK_NOT_FOUND, anchor::CONSTRAINT_SEEDS;
///         VaultError::ERRORS
///     ];
/// }
/// ```
///
/// List every number the program can log (the helpers it calls document
/// theirs): a number missing from the table is logged with an empty name,
/// number and message. A number listed twice, or not defined by
/// anchor-lang, fails to compile.
#[macro_export]
macro_rules! error_table {
    ($($framework:expr),* $(,)? ; $custom:expr $(,)?) => {{
        const FRAMEWORK: &[u32] = &[$($framework),*];
        const CUSTOM: &[$crate::error::ErrorEntry] = $custom;
        const N: usize = FRAMEWORK.len() + CUSTOM.len();
        const ENTRIES: [$crate::error::ErrorEntry; N] = $crate::error::entries(FRAMEWORK, CUSTOM);
        const TEXT_LEN: usize = $crate::error::text_len(&ENTRIES);
        const PACKED: ([u8; TEXT_LEN], [[u16; 4]; N]) = $crate::error::pack(&ENTRIES);
        $crate::error::ErrorTable::new(&PACKED.0, &PACKED.1)
    }};
    ($($framework:expr),* $(,)?) => {
        $crate::error_table!($($framework),* ; &[])
    };
}

/// A program's own errors, as `#[error_code]` declares them: a `u32` enum
/// numbered from 6000 (or `offset = N;`) in declaration order, with each
/// variant's message. Clients map the numbers to messages, so variants are
/// only ever appended.
///
/// ```ignore
/// noised_onchain::custom_errors! {
///     /// The vault's errors.
///     pub enum VaultError {
///         /// 6000
///         KeyIdMismatch = "Key id does not match the LM-OTS public key",
///         /// 6001
///         InvalidSignature = "Invalid post-quantum signature",
///     }
/// }
/// ```
///
/// Generates the enum (`Clone, Copy, Debug, PartialEq, Eq`), `code()`,
/// `From<E> for u32`, `ERRORS` (the entries for
/// [`error_table!`](crate::error_table)) and, off-chain only, `name()`,
/// `message()` and `Display` (the message).
#[macro_export]
macro_rules! custom_errors {
    (
        $(#[$meta:meta])*
        $vis:vis enum $name:ident {
            $( $(#[$vmeta:meta])* $variant:ident = $message:literal ),* $(,)?
        }
    ) => {
        $crate::custom_errors! {
            offset = 6000;
            $(#[$meta])*
            $vis enum $name { $( $(#[$vmeta])* $variant = $message ),* }
        }
    };
    (
        offset = $offset:expr;
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
            pub const OFFSET: u32 = $offset;

            /// Number, name and message of every variant, in order.
            pub const ERRORS: &'static [$crate::error::ErrorEntry] = &[
                $( ($name::$variant as u32 + $offset, stringify!($variant), $message) ),*
            ];

            /// The error number (`OFFSET` + the variant index).
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
            /// The variant name, as in the IDL.
            #[inline]
            pub fn name(&self) -> &'static str {
                Self::ERRORS[*self as usize].1
            }

            /// The message, as in the IDL.
            #[inline]
            pub fn message(&self) -> &'static str {
                Self::ERRORS[*self as usize].2
            }
        }

        #[cfg(not(target_os = "solana"))]
        impl ::core::fmt::Display for $name {
            #[inline]
            fn fmt(&self, f: &mut ::core::fmt::Formatter<'_>) -> ::core::fmt::Result {
                f.write_str(self.message())
            }
        }
    };
}

/// Logs Anchor's line for error `code` (from `P`'s table) raised on the
/// account field `account` (`AnchorError caused by account: ...`), or with
/// no account (`AnchorError occurred. ...`), and returns the error.
#[cold]
#[inline(never)]
pub fn fail<P: Program>(code: u32, account: Option<&'static str>) -> ProgramError {
    let [name, number, message] = P::ERRORS.describe(code);
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

/// [`fail`], then the two compared pubkeys as Anchor logs them
/// (`with_pubkeys`: `Left:`, the left key, `Right:`, the right key).
#[cold]
#[inline(never)]
pub fn fail_keys<P: Program>(
    code: u32,
    account: Option<&'static str>,
    left: &Address,
    right: &Address,
) -> ProgramError {
    let e = fail::<P>(code, account);
    sys::log("Left:");
    sys::log_pubkey(left);
    sys::log("Right:");
    sys::log_pubkey(right);
    e
}

/// Logs `"<label><n>"`, `n` in decimal (Anchor's `msg!("Left: {}", n)`).
/// Written without an index that could panic (a bounds-check panic would
/// link `core::fmt`): the labels are at most 7 bytes and a `u64` has at most
/// 20 digits, so everything fits in the 32 bytes anyway. Out of line: one
/// copy for both lines.
#[cold]
#[inline(never)]
fn log_decimal(label: &[u8], n: u64) {
    // The digits, right to left, at the end of `digits`. (`black_box`: a
    // trip count the optimizer cannot see, so the loop is not unrolled 20
    // times in the programs built at opt-level 3.)
    let mut digits = [0u8; 20];
    let mut start = core::hint::black_box(digits.len());
    let mut rest = n;
    while let Some(at) = start.checked_sub(1) {
        start = at;
        if let Some(digit) = digits.get_mut(at) {
            *digit = b'0' + (rest % 10) as u8;
        }
        rest /= 10;
        if rest == 0 {
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
    sys::log_bytes(line.get(..len).unwrap_or(&[]));
}

/// [`fail`], then the two compared numbers as Anchor logs them
/// (`with_values`: `Left: <left>`, `Right: <right>`), e.g. a bump that is
/// not the canonical one (`ConstraintSeeds`), `ConstraintSpace`,
/// `ConstraintMintDecimals`.
#[cold]
#[inline(never)]
pub fn fail_values<P: Program>(
    code: u32,
    account: Option<&'static str>,
    left: u64,
    right: u64,
) -> ProgramError {
    let e = fail::<P>(code, account);
    log_decimal(b"Left: ", left);
    log_decimal(b"Right: ", right);
    e
}

/// [`fail`] with no account: an error the program raises itself (`err!`,
/// `require!`, `.ok_or(MyError::X)?`): `AnchorError occurred. ...`.
#[cold]
#[inline(never)]
pub fn raise<P: Program>(code: u32) -> ProgramError {
    fail::<P>(code, None)
}

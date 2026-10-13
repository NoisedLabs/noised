//! SPL Token / Token-2022, as an Anchor 1.2.1 build handles them through
//! anchor-spl and spl-token-2022-interface 2.1.0, with the same result (or
//! the same error) for every input:
//!
//! * [`unpack_mint`], [`unpack_token_account`]:
//!   `StateWithExtensions::<Mint | Account>::unpack` (SPL Token accounts are
//!   the same layout without extensions); [`ExtensionTypes`],
//!   [`for_each_extension_type`], [`get_extension`]: `get_extension_types`
//!   and `get_extension`.
//! * [`load_mint`], [`load_token_account`]: `InterfaceAccount::try_from`.
//! * The `token::` / `mint::` / `associated_token::` constraints, with their
//!   Anchor errors, and `init_if_needed` of an associated token account.
//! * Associated token addresses and the ATA program's `create` /
//!   `create_idempotent`.
//! * Token CPIs (`transfer_checked` with the transfer-hook accounts,
//!   `mint_to_checked`, `burn_checked`, `initialize_mint2`, extension
//!   initializers), memo CPI and the memo-required check.
//! * [`hook`]: the transfer-hook extra accounts of a `transfer_checked` CPI.

pub mod hook;

use alloc::vec::Vec;

use pinocchio::{
    cpi::Signer, error::ProgramError, instruction::InstructionAccount, AccountView, Address,
    ProgramResult,
};

pub use crate::ids::{
    ASSOCIATED_TOKEN_PROGRAM_ID, MEMO_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
};
use crate::{
    accounts::{check_mut, check_rent_exempt, is_missing},
    cpi::{invoke, writable_signer},
    error::{anchor::*, fail, fail_keys},
    owned_by, pda, same,
    sysvar::Rent,
    Program,
};

pub const MINT_LEN: usize = 82;
pub const ACCOUNT_LEN: usize = 165;
pub const MULTISIG_LEN: usize = 355;

/// `AccountType` (the byte after `Account::LEN` when extensions exist).
pub const ACCOUNT_TYPE_MINT: u8 = 1;
pub const ACCOUNT_TYPE_ACCOUNT: u8 = 2;

/// `ExtensionType` values of spl-token-2022-interface 2.1.0: 0
/// (`Uninitialized`) to 27 (`PausableAccount`). Any other value fails to
/// parse.
pub const EXTENSION_TYPE_MAX: u16 = 27;
pub const EXT_TRANSFER_FEE_CONFIG: u16 = 1;
pub const EXT_TRANSFER_FEE_AMOUNT: u16 = 2;
pub const EXT_MINT_CLOSE_AUTHORITY: u16 = 3;
pub const EXT_CONFIDENTIAL_TRANSFER_MINT: u16 = 4;
pub const EXT_CONFIDENTIAL_TRANSFER_ACCOUNT: u16 = 5;
pub const EXT_DEFAULT_ACCOUNT_STATE: u16 = 6;
pub const EXT_IMMUTABLE_OWNER: u16 = 7;
pub const EXT_MEMO_TRANSFER: u16 = 8;
pub const EXT_NON_TRANSFERABLE: u16 = 9;
pub const EXT_INTEREST_BEARING_CONFIG: u16 = 10;
pub const EXT_CPI_GUARD: u16 = 11;
pub const EXT_PERMANENT_DELEGATE: u16 = 12;
pub const EXT_NON_TRANSFERABLE_ACCOUNT: u16 = 13;
pub const EXT_TRANSFER_HOOK: u16 = 14;
pub const EXT_TRANSFER_HOOK_ACCOUNT: u16 = 15;
pub const EXT_CONFIDENTIAL_TRANSFER_FEE_CONFIG: u16 = 16;
pub const EXT_CONFIDENTIAL_TRANSFER_FEE_AMOUNT: u16 = 17;
pub const EXT_METADATA_POINTER: u16 = 18;
pub const EXT_TOKEN_METADATA: u16 = 19;
pub const EXT_GROUP_POINTER: u16 = 20;
pub const EXT_TOKEN_GROUP: u16 = 21;
pub const EXT_GROUP_MEMBER_POINTER: u16 = 22;
pub const EXT_TOKEN_GROUP_MEMBER: u16 = 23;
pub const EXT_CONFIDENTIAL_MINT_BURN: u16 = 24;
pub const EXT_SCALED_UI_AMOUNT: u16 = 25;
pub const EXT_PAUSABLE: u16 = 26;
pub const EXT_PAUSABLE_ACCOUNT: u16 = 27;

/// Sizes of fixed-size extensions (their `Pod` types).
pub const TRANSFER_FEE_CONFIG_LEN: usize = 108;
pub const MINT_CLOSE_AUTHORITY_LEN: usize = 32;
pub const DEFAULT_ACCOUNT_STATE_LEN: usize = 1;
pub const MEMO_TRANSFER_LEN: usize = 1;
pub const PERMANENT_DELEGATE_LEN: usize = 32;
pub const TRANSFER_HOOK_LEN: usize = 64;
pub const TRANSFER_HOOK_ACCOUNT_LEN: usize = 1;
pub const METADATA_POINTER_LEN: usize = 64;
pub const GROUP_POINTER_LEN: usize = 64;
pub const GROUP_MEMBER_POINTER_LEN: usize = 64;
pub const PAUSABLE_LEN: usize = 33;

/// `TokenError::ExtensionNotFound`.
pub const EXTENSION_NOT_FOUND: u32 = 48;

#[inline]
fn invalid() -> ProgramError {
    ProgramError::InvalidAccountData
}

/// `N` bytes of `data` at `at`, if there are that many.
fn bytes_at<const N: usize>(data: &[u8], at: usize) -> Option<&[u8; N]> {
    data.get(at..)?.first_chunk::<N>()
}

/// The little-endian `u16` at `at`, if there.
#[inline]
fn u16_at(data: &[u8], at: usize) -> Option<u16> {
    bytes_at::<2>(data, at).map(|b| u16::from_le_bytes(*b))
}

/// `unpack_coption_key` / `unpack_coption_u64`: the 4-byte tag at `at` is
/// `[0,0,0,0]` (None) or `[1,0,0,0]` (Some).
fn check_coption(data: &[u8], at: usize) -> Result<(), ProgramError> {
    match bytes_at::<4>(data, at) {
        Some([0, 0, 0, 0] | [1, 0, 0, 0]) => Ok(()),
        _ => Err(invalid()),
    }
}

/// A checked `COption<Pubkey>` at `at` (tag, then the key).
#[inline]
fn coption_key(data: &[u8], at: usize) -> Option<Address> {
    match bytes_at::<36>(data, at) {
        Some(field) if field[0] == 1 => {
            let key = field.last_chunk::<32>()?;
            Some(Address::new_from_array(*key))
        }
        _ => None,
    }
}

/// `check_min_len_and_not_multisig`.
#[inline]
fn check_len(data: &[u8], minimum: usize) -> Result<(), ProgramError> {
    if data.len() == MULTISIG_LEN || data.len() < minimum {
        Err(invalid())
    } else {
        Ok(())
    }
}

/// `unpack_tlv_data`: the TLV area after the base state. Empty when there
/// is nothing after the base; otherwise zero padding up to `Account::LEN`,
/// then the `AccountType` byte, which must be `expected`.
#[inline]
fn unpack_tlv_data(data: &[u8], base_len: usize, expected: u8) -> Result<&[u8], ProgramError> {
    let rest = data.get(base_len..).unwrap_or(&[]);
    if rest.is_empty() {
        return Ok(&[]);
    }
    let (padding, rest) = rest
        .split_at_checked(ACCOUNT_LEN - base_len)
        .ok_or_else(invalid)?;
    match rest.split_first() {
        Some((&account_type, tlv))
            if padding.iter().all(|b| *b == 0) && account_type == expected =>
        {
            Ok(tlv)
        }
        _ => Err(invalid()),
    }
}

/// A mint that unpacked (`StateWithExtensions::<Mint>::unpack`): its base
/// fields, read on demand, and its extension data.
#[derive(Clone, Copy, Debug)]
pub struct Mint<'a> {
    base: &'a [u8; MINT_LEN],
    /// The extension (TLV) data; empty for SPL Token mints.
    pub tlv: &'a [u8],
}

impl Mint<'_> {
    /// `mint_authority` (a `COption<Pubkey>`).
    #[inline]
    pub fn mint_authority(&self) -> Option<Address> {
        coption_key(self.base, 0)
    }

    #[inline]
    pub fn supply(&self) -> u64 {
        u64::from_le_bytes(*bytes_at::<8>(self.base, 36).unwrap_or(&[0; 8]))
    }

    #[inline]
    pub fn decimals(&self) -> u8 {
        self.base[44]
    }

    /// `freeze_authority` (a `COption<Pubkey>`).
    #[inline]
    pub fn freeze_authority(&self) -> Option<Address> {
        coption_key(self.base, 46)
    }
}

/// `StateWithExtensions::<Mint>::unpack`.
#[inline(never)]
pub fn unpack_mint(data: &[u8]) -> Result<Mint<'_>, ProgramError> {
    check_len(data, MINT_LEN)?;
    let base = data.first_chunk::<MINT_LEN>().ok_or_else(invalid)?;
    // mint_authority (36) | supply (8) | decimals (1) | is_initialized (1)
    // | freeze_authority (36)
    check_coption(data, 0)?;
    let is_initialized = match base[45] {
        0 => false,
        1 => true,
        _ => return Err(invalid()),
    };
    check_coption(data, 46)?;
    if !is_initialized {
        return Err(ProgramError::UninitializedAccount);
    }
    let tlv = unpack_tlv_data(data, MINT_LEN, ACCOUNT_TYPE_MINT)?;
    Ok(Mint { base, tlv })
}

/// `AccountState` of a token account.
pub const ACCOUNT_STATE_INITIALIZED: u8 = 1;
pub const ACCOUNT_STATE_FROZEN: u8 = 2;

/// A token account that unpacked (`StateWithExtensions::<Account>::unpack`):
/// its base fields, read on demand, and its extension data.
#[derive(Clone, Copy, Debug)]
pub struct TokenAccountState<'a> {
    base: &'a [u8; ACCOUNT_LEN],
    /// The extension (TLV) data; empty for SPL Token accounts.
    pub tlv: &'a [u8],
}

impl TokenAccountState<'_> {
    #[inline]
    pub fn mint(&self) -> Address {
        Address::new_from_array(*bytes_at::<32>(self.base, 0).unwrap_or(&[0; 32]))
    }

    #[inline]
    pub fn owner(&self) -> Address {
        Address::new_from_array(*bytes_at::<32>(self.base, 32).unwrap_or(&[0; 32]))
    }

    #[inline]
    pub fn amount(&self) -> u64 {
        u64::from_le_bytes(*bytes_at::<8>(self.base, 64).unwrap_or(&[0; 8]))
    }

    /// `delegate` (a `COption<Pubkey>`).
    #[inline]
    pub fn delegate(&self) -> Option<Address> {
        coption_key(self.base, 72)
    }

    /// `AccountState`: 1 initialized, 2 frozen.
    #[inline]
    pub fn state(&self) -> u8 {
        self.base[108]
    }

    #[inline]
    pub fn is_frozen(&self) -> bool {
        self.state() == ACCOUNT_STATE_FROZEN
    }

    /// `is_native` (a `COption<u64>`: the rent-exempt reserve of a native
    /// account).
    #[inline]
    pub fn is_native(&self) -> Option<u64> {
        let field = bytes_at::<12>(self.base, 109)?;
        (field[0] == 1).then(|| {
            let mut v = [0u8; 8];
            v.copy_from_slice(&field[4..]);
            u64::from_le_bytes(v)
        })
    }

    #[inline]
    pub fn delegated_amount(&self) -> u64 {
        u64::from_le_bytes(*bytes_at::<8>(self.base, 121).unwrap_or(&[0; 8]))
    }

    /// `close_authority` (a `COption<Pubkey>`).
    #[inline]
    pub fn close_authority(&self) -> Option<Address> {
        coption_key(self.base, 129)
    }
}

/// `StateWithExtensions::<Account>::unpack`.
#[inline(never)]
pub fn unpack_token_account(data: &[u8]) -> Result<TokenAccountState<'_>, ProgramError> {
    check_len(data, ACCOUNT_LEN)?;
    let base = data.first_chunk::<ACCOUNT_LEN>().ok_or_else(invalid)?;
    // mint (32) | owner (32) | amount (8) | delegate (36) | state (1)
    // | is_native (12) | delegated_amount (8) | close_authority (36)
    check_coption(data, 72)?;
    let state = base[108];
    if state > 2 {
        return Err(invalid());
    }
    check_coption(data, 109)?;
    check_coption(data, 129)?;
    if state == 0 {
        return Err(ProgramError::UninitializedAccount);
    }
    let tlv = unpack_tlv_data(data, ACCOUNT_LEN, ACCOUNT_TYPE_ACCOUNT)?;
    Ok(TokenAccountState { base, tlv })
}

/// The token account fields most handlers read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TokenAccount {
    pub mint: Address,
    pub owner: Address,
    pub amount: u64,
}

impl TokenAccount {
    /// Mint, owner and amount of an unpacked account.
    #[inline]
    pub fn from_state(state: &TokenAccountState) -> Self {
        Self {
            mint: state.mint(),
            owner: state.owner(),
            amount: state.amount(),
        }
    }
}

/// `get_tlv_data_info`, as `get_extension_types` runs it: the TLV entries'
/// types, up to the first `Uninitialized` type (or the end); an unknown type
/// or a malformed entry fails.
pub struct ExtensionTypes<'a> {
    tlv: &'a [u8],
    start: usize,
}

impl<'a> ExtensionTypes<'a> {
    #[inline]
    pub fn new(tlv: &'a [u8]) -> Self {
        Self { tlv, start: 0 }
    }

    /// The next type, `None` at the end.
    #[inline(never)]
    pub fn next_type(&mut self) -> Result<Option<u16>, ProgramError> {
        let (tlv, start) = (self.tlv, self.start);
        if start >= tlv.len() {
            return Ok(None);
        }
        // Not enough bytes for another type: the end.
        let Some(extension_type) = u16_at(tlv, start) else {
            return Ok(None);
        };
        if extension_type > EXTENSION_TYPE_MAX {
            return Err(invalid());
        }
        if extension_type == 0 {
            return Ok(None);
        }
        let length = u16_at(tlv, start.saturating_add(2)).ok_or_else(invalid)?;
        let end = start.saturating_add(4).saturating_add(usize::from(length));
        if end > tlv.len() {
            return Err(invalid());
        }
        self.start = end;
        Ok(Some(extension_type))
    }
}

/// `get_extension_types()` then each type in order: every entry parses
/// before `each` sees the first type.
#[inline]
pub fn for_each_extension_type(
    tlv: &[u8],
    mut each: impl FnMut(u16) -> Result<(), ProgramError>,
) -> Result<(), ProgramError> {
    let mut types = ExtensionTypes::new(tlv);
    while types.next_type()?.is_some() {}
    let mut types = ExtensionTypes::new(tlv);
    while let Some(extension_type) = types.next_type()? {
        each(extension_type)?;
    }
    Ok(())
}

/// Mint extension types (`ExtensionType::get_account_type() == Mint`), as
/// bits.
const MINT_EXTENSIONS: u32 = 1 << EXT_TRANSFER_FEE_CONFIG
    | 1 << EXT_MINT_CLOSE_AUTHORITY
    | 1 << EXT_CONFIDENTIAL_TRANSFER_MINT
    | 1 << EXT_DEFAULT_ACCOUNT_STATE
    | 1 << EXT_NON_TRANSFERABLE
    | 1 << EXT_INTEREST_BEARING_CONFIG
    | 1 << EXT_PERMANENT_DELEGATE
    | 1 << EXT_TRANSFER_HOOK
    | 1 << EXT_CONFIDENTIAL_TRANSFER_FEE_CONFIG
    | 1 << EXT_METADATA_POINTER
    | 1 << EXT_TOKEN_METADATA
    | 1 << EXT_GROUP_POINTER
    | 1 << EXT_TOKEN_GROUP
    | 1 << EXT_GROUP_MEMBER_POINTER
    | 1 << EXT_TOKEN_GROUP_MEMBER
    | 1 << EXT_CONFIDENTIAL_MINT_BURN
    | 1 << EXT_SCALED_UI_AMOUNT
    | 1 << EXT_PAUSABLE;
/// Account extension types (`get_account_type() == Account`), as bits.
const ACCOUNT_EXTENSIONS: u32 = 1 << EXT_TRANSFER_FEE_AMOUNT
    | 1 << EXT_CONFIDENTIAL_TRANSFER_ACCOUNT
    | 1 << EXT_IMMUTABLE_OWNER
    | 1 << EXT_MEMO_TRANSFER
    | 1 << EXT_CPI_GUARD
    | 1 << EXT_NON_TRANSFERABLE_ACCOUNT
    | 1 << EXT_TRANSFER_HOOK_ACCOUNT
    | 1 << EXT_CONFIDENTIAL_TRANSFER_FEE_AMOUNT
    | 1 << EXT_PAUSABLE_ACCOUNT;

/// `ExtensionType::get_account_type`: the base state an extension type
/// belongs to, [`ACCOUNT_TYPE_MINT`] or [`ACCOUNT_TYPE_ACCOUNT`]; 0
/// (`AccountType::Uninitialized`) for `Uninitialized` and for a type
/// spl-token-2022-interface 2.1.0 does not know.
pub const fn extension_account_type(extension_type: u16) -> u8 {
    if extension_type > EXTENSION_TYPE_MAX {
        return 0;
    }
    let bit = 1u32 << extension_type;
    if MINT_EXTENSIONS & bit != 0 {
        ACCOUNT_TYPE_MINT
    } else if ACCOUNT_EXTENSIONS & bit != 0 {
        ACCOUNT_TYPE_ACCOUNT
    } else {
        0
    }
}

/// `get_extension_bytes::<S, V>`: the value of the first entry of type
/// `extension_type`, whatever its length (variable-length extensions such
/// as `TokenMetadata`), in the TLV data `tlv` of a base state of type
/// `base` ([`ACCOUNT_TYPE_MINT`] or [`ACCOUNT_TYPE_ACCOUNT`]).
///
/// As SPL: an extension type of the other base (or no base) is
/// `InvalidAccountData` before anything is read
/// (spl-token-2022-interface 2.1.0 `extension/mod.rs:334-337`); then the
/// walk ([`extension_value`]). With constant arguments the base check
/// folds away at compile time.
#[inline(always)]
pub fn get_extension_bytes(
    tlv: &[u8],
    base: u8,
    extension_type: u16,
) -> Result<&[u8], ProgramError> {
    if extension_account_type(extension_type) != base {
        return Err(invalid());
    }
    extension_bytes(tlv, extension_type)
}

/// [`get_extension_bytes`]'s walk, out of line.
#[inline(never)]
fn extension_bytes(tlv: &[u8], extension_type: u16) -> Result<&[u8], ProgramError> {
    extension_value(tlv, extension_type)
}

/// `get_extension::<V>()` of a base state of type `base` for an extension
/// of type `extension_type` and `Pod` size `len`: the base-type check of
/// [`get_extension_bytes`], then the value of the first entry of that type,
/// which must be exactly `len` bytes (`InvalidArgument` otherwise).
#[inline(always)]
pub fn get_extension(
    tlv: &[u8],
    base: u8,
    extension_type: u16,
    len: usize,
) -> Result<&[u8], ProgramError> {
    if extension_account_type(extension_type) != base {
        return Err(invalid());
    }
    extension_sized(tlv, extension_type, len)
}

/// [`get_extension`]'s walk and size check, out of line.
#[inline(never)]
fn extension_sized(tlv: &[u8], extension_type: u16, len: usize) -> Result<&[u8], ProgramError> {
    let value = extension_value(tlv, extension_type)?;
    // `pod_from_bytes`: the value must be exactly the type's size.
    if value.len() != len {
        return Err(ProgramError::InvalidArgument);
    }
    Ok(value)
}

/// The TLV walk of `get_extension` / `get_extension_bytes`
/// (`get_extension_indices`): entry by entry, the first of type
/// `extension_type`; `ExtensionNotFound` at an `Uninitialized` entry,
/// `InvalidAccountData` at a truncated entry or the end.
///
/// Like spl-token-2022-interface 2.1.0's `get_extension_indices` (which
/// compares the raw `u16`), it walks past entries of any other type,
/// including types that version does not know: only [`ExtensionTypes`]
/// (`get_extension_types`) rejects those. So a lookup keeps working if a
/// future Token-2022 adds an extension type, which matters for immutable
/// programs; every decision that accepts or refuses a mint by its
/// extensions (the vault's mint policy, the shield's allowlist and zToken
/// check, the launchpad's mint check) runs the strict [`ExtensionTypes`]
/// pass over the whole TLV first.
#[inline(always)]
fn extension_value(tlv: &[u8], extension_type: u16) -> Result<&[u8], ProgramError> {
    let mut start = 0usize;
    while start < tlv.len() {
        let (Some(found), Some(length)) =
            (u16_at(tlv, start), u16_at(tlv, start.saturating_add(2)))
        else {
            return Err(invalid());
        };
        let value_start = start.saturating_add(4);
        let value_end = value_start.saturating_add(usize::from(length));
        if found == extension_type {
            return tlv.get(value_start..value_end).ok_or_else(invalid);
        }
        if found == 0 {
            return Err(ProgramError::Custom(EXTENSION_NOT_FOUND));
        }
        start = value_end;
    }
    Err(invalid())
}

/// An `OptionalNonZeroPubkey` at `at`: `None` when all zero (or absent).
#[inline]
pub fn optional_key(data: &[u8], at: usize) -> Option<Address> {
    let key = bytes_at::<32>(data, at)?;
    if *key == [0u8; 32] {
        None
    } else {
        Some(Address::new_from_array(*key))
    }
}

/// `transfer_hook::get_program_id`: the hook program of a Token-2022 mint
/// (`tlv`: the mint's TLV data), `None` if it has none (or its extension
/// does not parse).
#[inline]
pub fn hook_program_id(tlv: &[u8]) -> Option<Address> {
    let hook = get_extension(tlv, ACCOUNT_TYPE_MINT, EXT_TRANSFER_HOOK, TRANSFER_HOOK_LEN).ok()?;
    // authority (32) | program_id (32)
    optional_key(hook, 32)
}

/// Whether a Token-2022 account (`tlv`: its TLV data) requires a memo
/// before incoming transfers (`MemoTransfer.require_incoming_transfer_memos`,
/// false if absent).
#[inline]
pub fn requires_memo(tlv: &[u8]) -> bool {
    get_extension(
        tlv,
        ACCOUNT_TYPE_ACCOUNT,
        EXT_MEMO_TRANSFER,
        MEMO_TRANSFER_LEN,
    )
    .is_ok_and(|memo| memo.first().is_some_and(|b| *b != 0))
}

// ---------------------------------------------------- InterfaceAccount<T>

/// `InterfaceAccount::try_from`'s owner checks: an account that does not
/// exist is `AccountNotInitialized`; one not owned by a token program is
/// `AccountOwnedByWrongProgram` (no keys).
pub fn check_token_owner<P: Program>(
    account: &AccountView,
    name: Option<&'static str>,
) -> ProgramResult {
    if is_missing(account) {
        return Err(fail::<P>(ACCOUNT_NOT_INITIALIZED, name));
    }
    if !owned_by(account, &TOKEN_PROGRAM_ID) && !owned_by(account, &TOKEN_2022_PROGRAM_ID) {
        return Err(fail::<P>(ACCOUNT_OWNED_BY_WRONG_PROGRAM, name));
    }
    Ok(())
}

/// `InterfaceAccount<Mint>::try_from`: owner checks, then
/// `StateWithExtensions::<Mint>::unpack` (its errors as they are); `read`
/// takes what the caller needs while the data is borrowed.
pub fn load_mint<P: Program, T>(
    account: &AccountView,
    name: Option<&'static str>,
    read: impl FnOnce(&Mint) -> T,
) -> Result<T, ProgramError> {
    check_token_owner::<P>(account, name)?;
    let data = account.try_borrow()?;
    Ok(read(&unpack_mint(&data)?))
}

/// `InterfaceAccount<TokenAccount>::try_from`: owner checks, then
/// `StateWithExtensions::<Account>::unpack` (its errors as they are); `read`
/// takes what the caller needs while the data is borrowed.
pub fn load_token_account_with<P: Program, T>(
    account: &AccountView,
    name: Option<&'static str>,
    read: impl FnOnce(&TokenAccountState) -> T,
) -> Result<T, ProgramError> {
    check_token_owner::<P>(account, name)?;
    let data = account.try_borrow()?;
    Ok(read(&unpack_token_account(&data)?))
}

/// [`load_token_account_with`] of mint, owner and amount.
#[inline(never)]
pub fn load_token_account<P: Program>(
    account: &AccountView,
    name: Option<&'static str>,
) -> Result<TokenAccount, ProgramError> {
    load_token_account_with::<P, _>(account, name, TokenAccount::from_state)
}

// ------------------------------------------------------------ constraints

/// [A] `mint::token_program = token_program` (and `token::token_program`'s
/// mint side): `ConstraintMintTokenProgram`, naming no account.
pub fn check_mint_token_program<P: Program>(
    mint: &AccountView,
    token_program: &AccountView,
) -> ProgramResult {
    if !owned_by(mint, token_program.address()) {
        return Err(fail::<P>(CONSTRAINT_MINT_TOKEN_PROGRAM, None));
    }
    Ok(())
}

/// [A] `token::authority = authority`: `ConstraintTokenOwner`, with the
/// account's owner field and the authority.
pub fn check_token_authority<P: Program>(
    state: &TokenAccount,
    authority: &Address,
    name: &'static str,
) -> ProgramResult {
    if !same(&state.owner, authority) {
        return Err(fail_keys::<P>(
            CONSTRAINT_TOKEN_OWNER,
            Some(name),
            &state.owner,
            authority,
        ));
    }
    Ok(())
}

/// [A] `token::mint = mint`: `ConstraintTokenMint`, with the account's mint
/// field and the mint.
pub fn check_token_mint<P: Program>(
    state: &TokenAccount,
    mint: &Address,
    name: &'static str,
) -> ProgramResult {
    if !same(&state.mint, mint) {
        return Err(fail_keys::<P>(
            CONSTRAINT_TOKEN_MINT,
            Some(name),
            &state.mint,
            mint,
        ));
    }
    Ok(())
}

/// [A] `token::token_program = token_program`:
/// `ConstraintTokenTokenProgram`, with the account's owner and the token
/// program.
pub fn check_token_token_program<P: Program>(
    account: &AccountView,
    token_program: &AccountView,
    name: &'static str,
) -> ProgramResult {
    if !owned_by(account, token_program.address()) {
        return Err(fail_keys::<P>(
            CONSTRAINT_TOKEN_TOKEN_PROGRAM,
            Some(name),
            account.owner(),
            token_program.address(),
        ));
    }
    Ok(())
}

/// The canonical associated token account of `wallet` for `mint` under
/// `token_program` (`get_associated_token_address_with_program_id`).
#[inline(never)]
pub fn associated_token_address(
    wallet: &Address,
    mint: &Address,
    token_program: &Address,
) -> Address {
    pda::find_program_address(
        &[wallet.as_ref(), token_program.as_ref(), mint.as_ref()],
        &ASSOCIATED_TOKEN_PROGRAM_ID,
    )
    .0
}

/// [A] `associated_token::mint = mint, associated_token::authority =
/// authority, associated_token::token_program = token_program` on an
/// existing account (no `init`): owned by `token_program`
/// (`ConstraintAssociatedTokenTokenProgram`, no account named, no keys),
/// owned by `authority` (`ConstraintTokenOwner`, with both keys), at the
/// canonical address (`ConstraintAssociated`, with both keys). The mint
/// field is not compared (Anchor does not either: only the ATA program can
/// create an account at the address of this mint).
pub fn check_associated_token_account<P: Program>(
    account: &AccountView,
    state: &TokenAccount,
    authority: &AccountView,
    mint: &AccountView,
    token_program: &AccountView,
    name: &'static str,
) -> ProgramResult {
    if !owned_by(account, token_program.address()) {
        return Err(fail::<P>(CONSTRAINT_ASSOCIATED_TOKEN_TOKEN_PROGRAM, None));
    }
    if !same(&state.owner, authority.address()) {
        return Err(fail_keys::<P>(
            CONSTRAINT_TOKEN_OWNER,
            Some(name),
            &state.owner,
            authority.address(),
        ));
    }
    let ata =
        associated_token_address(authority.address(), mint.address(), token_program.address());
    if !same(account.address(), &ata) {
        return Err(fail_keys::<P>(
            CONSTRAINT_ASSOCIATED,
            Some(name),
            account.address(),
            &ata,
        ));
    }
    Ok(())
}

/// The ATA program's `Create` (`idempotent = false`, instruction 0) or
/// `CreateIdempotent` (1) of the associated token account `ata` (its
/// address) for `wallet` and `mint`, paid by `payer`. The instruction names
/// the address; the runtime finds the account among `infos` by address
/// (`MissingAccount` when it is not there): pass the account the caller
/// holds at that address.
#[allow(clippy::too_many_arguments)]
#[inline]
pub fn create_associated_token_account(
    idempotent: bool,
    payer: &AccountView,
    ata: &Address,
    ata_account: &AccountView,
    wallet: &AccountView,
    mint: &AccountView,
    system_program: &AccountView,
    token_program: &AccountView,
) -> ProgramResult {
    invoke(
        &ASSOCIATED_TOKEN_PROGRAM_ID,
        &[
            writable_signer(payer),
            InstructionAccount::writable(ata),
            InstructionAccount::readonly(wallet.address()),
            InstructionAccount::readonly(mint.address()),
            InstructionAccount::readonly(&SYSTEM_PROGRAM_ID),
            InstructionAccount::readonly(token_program.address()),
        ],
        &[u8::from(idempotent)],
        &[
            payer,
            ata_account,
            wallet,
            mint,
            system_program,
            token_program,
        ],
        &[],
    )
}

/// The accounts of an associated token account `init` / `init_if_needed`.
pub struct AssociatedToken<'a> {
    pub payer: &'a AccountView,
    /// The field being initialized.
    pub account: &'a AccountView,
    /// `associated_token::authority`.
    pub authority: &'a AccountView,
    /// `associated_token::mint`.
    pub mint: &'a AccountView,
    pub token_program: &'a AccountView,
    pub system_program: &'a AccountView,
}

/// [A] `init` / `init_if_needed` of `associated_token::mint = mint,
/// associated_token::authority = authority,
/// associated_token::token_program = token_program`: an account still
/// owned by the system program (any account for plain `init`) is created
/// with the ATA program's `Create` (which derives the address and fails for
/// any other); then `InterfaceAccount::try_from_unchecked` (owner checks
/// caused by `name`, as anchor-syn's `with_account_name` wraps them, then
/// unpack, its errors unchanged). For `init_if_needed` the account
/// must then hold `mint` (`ConstraintTokenMint`), be owned by `authority`
/// (`ConstraintTokenOwner`), by `token_program`
/// (`ConstraintAssociatedTokenTokenProgram`), each with both keys, and sit
/// at the canonical address (`AccountNotAssociatedTokenAccount`), each
/// caused by `name`. Then `mut` and rent exemption (`ConstraintMut`,
/// `ConstraintRentExempt`). Returns the account's mint, owner and amount.
#[inline]
pub fn init_associated_token_account<P: Program, const IF_NEEDED: bool>(
    a: &AssociatedToken,
    rent: &Rent,
    name: &'static str,
) -> Result<TokenAccount, ProgramError> {
    let ata = associated_token_address(
        a.authority.address(),
        a.mint.address(),
        a.token_program.address(),
    );
    if !IF_NEEDED || owned_by(a.account, &SYSTEM_PROGRAM_ID) {
        create_associated_token_account(
            false,
            a.payer,
            &ata,
            a.account,
            a.authority,
            a.mint,
            a.system_program,
            a.token_program,
        )?;
    }
    // InterfaceAccount::try_from_unchecked (the owner is read after the CPI),
    // `with_account_name(field)`.
    let state = load_token_account::<P>(a.account, Some(name))?;
    if IF_NEEDED {
        if !same(&state.mint, a.mint.address()) {
            return Err(fail_keys::<P>(
                CONSTRAINT_TOKEN_MINT,
                Some(name),
                &state.mint,
                a.mint.address(),
            ));
        }
        if !same(&state.owner, a.authority.address()) {
            return Err(fail_keys::<P>(
                CONSTRAINT_TOKEN_OWNER,
                Some(name),
                &state.owner,
                a.authority.address(),
            ));
        }
        if !owned_by(a.account, a.token_program.address()) {
            return Err(fail_keys::<P>(
                CONSTRAINT_ASSOCIATED_TOKEN_TOKEN_PROGRAM,
                Some(name),
                a.account.owner(),
                a.token_program.address(),
            ));
        }
        if !same(a.account.address(), &ata) {
            return Err(fail::<P>(ACCOUNT_NOT_ASSOCIATED_TOKEN_ACCOUNT, Some(name)));
        }
    }
    check_mut::<P>(a.account, name)?;
    check_rent_exempt::<P>(a.account, rent, name)?;
    Ok(state)
}

// -------------------------------------------------------------------- CPIs

/// `TokenInstruction::TransferChecked { amount, decimals }`.
#[inline]
pub fn transfer_checked_data(amount: u64, decimals: u8) -> [u8; 10] {
    let mut data = [0u8; 10];
    data[0] = 12;
    data[1..9].copy_from_slice(&amount.to_le_bytes());
    data[9] = decimals;
    data
}

/// `TokenInstruction::MintToChecked { amount, decimals }`.
#[inline]
pub fn mint_to_checked_data(amount: u64, decimals: u8) -> [u8; 10] {
    let mut data = transfer_checked_data(amount, decimals);
    data[0] = 14;
    data
}

/// `TokenInstruction::BurnChecked { amount, decimals }`.
#[inline]
pub fn burn_checked_data(amount: u64, decimals: u8) -> [u8; 10] {
    let mut data = transfer_checked_data(amount, decimals);
    data[0] = 15;
    data
}

/// `TokenInstruction::InitializeMint2 { decimals, mint_authority,
/// freeze_authority }` (67 bytes with a freeze authority, 35 without).
#[inline]
pub fn initialize_mint2_data(
    decimals: u8,
    mint_authority: &Address,
    freeze_authority: Option<&Address>,
) -> ([u8; 67], usize) {
    let mut data = [0u8; 67];
    data[0] = 20;
    data[1] = decimals;
    data[2..34].copy_from_slice(mint_authority.as_ref());
    match freeze_authority {
        Some(key) => {
            data[34] = 1;
            data[35..67].copy_from_slice(key.as_ref());
            (data, 67)
        }
        None => (data, 35),
    }
}

/// An `OptionalNonZeroPubkey` (all zero for `None`).
#[inline]
fn optional_bytes(key: Option<&Address>) -> [u8; 32] {
    key.map_or([0; 32], |k| *k.as_array())
}

/// `TransferHookInstruction::Initialize { authority, program_id }`
/// (Token-2022 instruction 36, sub-instruction 0).
#[inline]
pub fn transfer_hook_initialize_data(
    authority: Option<&Address>,
    program_id: Option<&Address>,
) -> [u8; 66] {
    let mut data = [0u8; 66];
    data[0] = 36;
    data[2..34].copy_from_slice(&optional_bytes(authority));
    data[34..66].copy_from_slice(&optional_bytes(program_id));
    data
}

/// `MetadataPointerInstruction::Initialize { authority, metadata_address }`
/// (Token-2022 instruction 39, sub-instruction 0).
#[inline]
pub fn metadata_pointer_initialize_data(
    authority: Option<&Address>,
    metadata_address: Option<&Address>,
) -> [u8; 66] {
    let mut data = transfer_hook_initialize_data(authority, metadata_address);
    data[0] = 39;
    data
}

/// `transfer_checked` (signed by `signers` when `authority` is a PDA) of
/// `amount` from `source` to `destination`. When `mint` is a Token-2022
/// mint with a transfer-hook program, the hook's accounts are resolved from
/// `extra` (`hook::add_extra_accounts_for_execute_cpi`, its errors as they
/// are) and appended, as `spl_token_2022::onchain::invoke_transfer_checked`
/// does. The caller holds no borrow of any account's data.
#[allow(clippy::too_many_arguments)]
#[inline]
pub fn transfer_checked(
    token_program: &AccountView,
    source: &AccountView,
    mint: &AccountView,
    destination: &AccountView,
    authority: &AccountView,
    amount: u64,
    decimals: u8,
    signers: &[Signer],
    extra: &[AccountView],
) -> ProgramResult {
    let data = transfer_checked_data(amount, decimals);
    let mut entries: Vec<hook::Entry<AccountView>> = Vec::with_capacity(16);
    entries.push(hook::Entry::new(source, false, true));
    entries.push(hook::Entry::new(mint, false, false));
    entries.push(hook::Entry::new(destination, false, true));
    entries.push(hook::Entry::new(authority, true, false));

    let hook_program = if owned_by(mint, &TOKEN_2022_PROGRAM_ID) {
        let data = mint.try_borrow()?;
        hook_program_id(unpack_mint(&data)?.tlv)
    } else {
        None
    };
    if let Some(hook_program) = hook_program {
        hook::add_extra_accounts_for_execute_cpi(
            &mut entries,
            &hook_program,
            source,
            mint,
            destination,
            authority,
            amount,
            extra,
        )?;
    }
    let metas: Vec<InstructionAccount> = entries
        .iter()
        .map(|e| InstructionAccount::new(e.account.address(), e.is_writable, e.is_signer))
        .collect();
    let infos: Vec<&AccountView> = entries.iter().map(|e| e.account).collect();
    invoke(token_program.address(), &metas, &data, &infos, signers)
}

/// `mint_to_checked` of `amount` to `destination`, signed by `authority`
/// (a PDA through `signers`).
#[allow(clippy::too_many_arguments)]
#[inline]
pub fn mint_to_checked(
    token_program: &AccountView,
    mint: &AccountView,
    destination: &AccountView,
    authority: &AccountView,
    amount: u64,
    decimals: u8,
    signers: &[Signer],
) -> ProgramResult {
    invoke(
        token_program.address(),
        &[
            InstructionAccount::writable(mint.address()),
            InstructionAccount::writable(destination.address()),
            InstructionAccount::readonly_signer(authority.address()),
        ],
        &mint_to_checked_data(amount, decimals),
        &[mint, destination, authority],
        signers,
    )
}

/// `burn_checked` of `amount` from `account`, signed by `authority` (a PDA
/// through `signers`).
#[allow(clippy::too_many_arguments)]
#[inline]
pub fn burn_checked(
    token_program: &AccountView,
    account: &AccountView,
    mint: &AccountView,
    authority: &AccountView,
    amount: u64,
    decimals: u8,
    signers: &[Signer],
) -> ProgramResult {
    invoke(
        token_program.address(),
        &[
            InstructionAccount::writable(account.address()),
            InstructionAccount::writable(mint.address()),
            InstructionAccount::readonly_signer(authority.address()),
        ],
        &burn_checked_data(amount, decimals),
        &[account, mint, authority],
        signers,
    )
}

/// `initialize_mint2` of `mint` (already allocated and owned by
/// `token_program`).
#[inline]
pub fn initialize_mint2(
    token_program: &AccountView,
    mint: &AccountView,
    decimals: u8,
    mint_authority: &Address,
    freeze_authority: Option<&Address>,
) -> ProgramResult {
    let (data, len) = initialize_mint2_data(decimals, mint_authority, freeze_authority);
    invoke(
        token_program.address(),
        &[InstructionAccount::writable(mint.address())],
        data.get(..len).unwrap_or(&data),
        &[mint],
        &[],
    )
}

/// A Token-2022 mint-extension initializer whose only account is the
/// (writable) mint: `transfer_hook_initialize_data`,
/// `metadata_pointer_initialize_data`, ... Run before `initialize_mint2`.
#[inline]
pub fn initialize_mint_extension(
    token_program: &AccountView,
    mint: &AccountView,
    data: &[u8],
) -> ProgramResult {
    invoke(
        token_program.address(),
        &[InstructionAccount::writable(mint.address())],
        data,
        &[mint],
        &[],
    )
}

/// An SPL Memo of `memo`, signed by no one. Token-2022 accepts it as the
/// instruction right before a transfer into an account that requires memos
/// ([`destination_requires_memo`]).
#[inline]
pub fn memo(memo_program: &AccountView, memo: &[u8]) -> ProgramResult {
    invoke(&MEMO_PROGRAM_ID, &[], memo, &[memo_program], &[])
}

/// Whether `account` is a Token-2022 account that requires a memo before
/// incoming transfers (its unpack errors as they are).
#[inline]
pub fn destination_requires_memo(account: &AccountView) -> Result<bool, ProgramError> {
    if !owned_by(account, &TOKEN_2022_PROGRAM_ID) {
        return Ok(false);
    }
    let data = account.try_borrow()?;
    let state = unpack_token_account(&data)?;
    Ok(requires_memo(state.tlv))
}

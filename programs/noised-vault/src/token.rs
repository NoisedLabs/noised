//! SPL Token / Token-2022 account parsing, written from (and tested
//! against) spl-token-2022-interface 2.1.0, which the Anchor build used
//! through anchor-spl: `StateWithExtensions::unpack`, `get_extension_types`
//! and `get_extension`, with the same error for every malformed input.

use pinocchio::error::ProgramError;

use crate::Pubkey;

/// SPL Token (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`).
pub const TOKEN_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133, 237,
    95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
]);
/// Token-2022 (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`).
pub const TOKEN_2022_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    6, 221, 246, 225, 238, 117, 143, 222, 24, 66, 93, 188, 228, 108, 205, 218, 182, 26, 252, 77,
    131, 185, 13, 39, 254, 189, 249, 40, 216, 161, 139, 252,
]);
/// Associated Token Account program (`ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`).
pub const ASSOCIATED_TOKEN_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19, 153, 218,
    255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89,
]);
/// System program (`11111111111111111111111111111111`).
pub const SYSTEM_PROGRAM_ID: Pubkey = Pubkey::new_from_array([0; 32]);
/// SPL Memo v2 (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`). Token-2022
/// accepts it (or v1) as the instruction right before a transfer into an
/// account that requires memos.
pub const MEMO_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    5, 74, 83, 90, 153, 41, 33, 6, 77, 36, 232, 113, 96, 218, 56, 124, 124, 53, 181, 221, 188, 146,
    187, 129, 228, 31, 168, 64, 65, 5, 68, 141,
]);
/// The memo the vault writes before paying an account that requires memos.
pub const PAYOUT_MEMO: &[u8] = b"noised-vault payout";

pub const MINT_LEN: usize = 82;
pub const ACCOUNT_LEN: usize = 165;
pub const MULTISIG_LEN: usize = 355;

/// `AccountType` (the byte after `Account::LEN` when extensions exist).
const ACCOUNT_TYPE_MINT: u8 = 1;
const ACCOUNT_TYPE_ACCOUNT: u8 = 2;

/// `ExtensionType` values of spl-token-2022-interface 2.1.0: 0
/// (`Uninitialized`) to 27 (`PausableAccount`). Any other value fails to
/// parse.
pub const EXTENSION_TYPE_MAX: u16 = 27;
pub const EXT_TRANSFER_FEE_CONFIG: u16 = 1;
pub const EXT_MINT_CLOSE_AUTHORITY: u16 = 3;
pub const EXT_MEMO_TRANSFER: u16 = 8;
pub const EXT_NON_TRANSFERABLE: u16 = 9;
pub const EXT_PERMANENT_DELEGATE: u16 = 12;
pub const EXT_TRANSFER_HOOK: u16 = 14;

/// Sizes of the extensions read here (their `Pod` types).
pub const MINT_CLOSE_AUTHORITY_LEN: usize = 32;
pub const TRANSFER_FEE_CONFIG_LEN: usize = 108;
pub const TRANSFER_HOOK_LEN: usize = 64;
pub const MEMO_TRANSFER_LEN: usize = 1;

/// `TokenError::ExtensionNotFound`.
pub const EXTENSION_NOT_FOUND: u32 = 48;

/// The fields of a mint the vault uses, and its extension data.
pub struct MintState<'a> {
    pub decimals: u8,
    pub tlv: &'a [u8],
}

/// The fields of a token account the vault uses, and its extension data.
pub struct TokenAccountState<'a> {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub tlv: &'a [u8],
}

fn invalid() -> ProgramError {
    ProgramError::InvalidAccountData
}

/// `N` bytes of `data` at `at`, if there are that many.
fn bytes_at<const N: usize>(data: &[u8], at: usize) -> Option<&[u8; N]> {
    data.get(at..)?.first_chunk::<N>()
}

/// The little-endian `u16` at `at`, if there.
fn u16_at(data: &[u8], at: usize) -> Option<u16> {
    bytes_at::<2>(data, at).map(|b| u16::from_le_bytes(*b))
}

fn pubkey_at(data: &[u8], at: usize) -> Result<Pubkey, ProgramError> {
    bytes_at::<32>(data, at)
        .map(|key| Pubkey::new_from_array(*key))
        .ok_or_else(invalid)
}

/// `unpack_coption_key` / `unpack_coption_u64`: the 4-byte tag at `at` is
/// `[0,0,0,0]` (None) or `[1,0,0,0]` (Some).
fn check_coption(data: &[u8], at: usize) -> Result<(), ProgramError> {
    match bytes_at::<4>(data, at) {
        Some([0, 0, 0, 0] | [1, 0, 0, 0]) => Ok(()),
        _ => Err(invalid()),
    }
}

/// `check_min_len_and_not_multisig`.
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

/// `StateWithExtensions::<Mint>::unpack`.
pub fn unpack_mint(data: &[u8]) -> Result<MintState<'_>, ProgramError> {
    check_len(data, MINT_LEN)?;
    // mint_authority (36) | supply (8) | decimals (1) | is_initialized (1)
    // | freeze_authority (36)
    check_coption(data, 0)?;
    let decimals = *data.get(44).ok_or_else(invalid)?;
    let is_initialized = match data.get(45) {
        Some(0) => false,
        Some(1) => true,
        _ => return Err(invalid()),
    };
    check_coption(data, 46)?;
    if !is_initialized {
        return Err(ProgramError::UninitializedAccount);
    }
    let tlv = unpack_tlv_data(data, MINT_LEN, ACCOUNT_TYPE_MINT)?;
    Ok(MintState { decimals, tlv })
}

/// `StateWithExtensions::<Account>::unpack`.
pub fn unpack_token_account(data: &[u8]) -> Result<TokenAccountState<'_>, ProgramError> {
    check_len(data, ACCOUNT_LEN)?;
    // mint (32) | owner (32) | amount (8) | delegate (36) | state (1)
    // | is_native (12) | delegated_amount (8) | close_authority (36)
    let mint = pubkey_at(data, 0)?;
    let owner = pubkey_at(data, 32)?;
    let amount = u64::from_le_bytes(*bytes_at::<8>(data, 64).ok_or_else(invalid)?);
    check_coption(data, 72)?;
    let state = *data.get(108).ok_or_else(invalid)?;
    if state > 2 {
        return Err(invalid());
    }
    check_coption(data, 109)?;
    check_coption(data, 129)?;
    if state == 0 {
        return Err(ProgramError::UninitializedAccount);
    }
    let tlv = unpack_tlv_data(data, ACCOUNT_LEN, ACCOUNT_TYPE_ACCOUNT)?;
    Ok(TokenAccountState {
        mint,
        owner,
        amount,
        tlv,
    })
}

/// `get_tlv_data_info`, as `get_extension_types` runs it: the TLV entries'
/// types, up to the first `Uninitialized` type (or the end); an unknown type
/// or a malformed entry fails.
pub struct ExtensionTypes<'a> {
    tlv: &'a [u8],
    start: usize,
}

impl<'a> ExtensionTypes<'a> {
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
/// `get_extension::<V>()` for an extension of type `extension_type` and
/// `Pod` size `len`: the value of the first entry of that type.
#[inline(never)]
pub fn get_extension(tlv: &[u8], extension_type: u16, len: usize) -> Result<&[u8], ProgramError> {
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
            let value = tlv.get(value_start..value_end).ok_or_else(invalid)?;
            // `pod_from_bytes`: the value must be exactly the type's size.
            if value.len() != len {
                return Err(ProgramError::InvalidArgument);
            }
            return Ok(value);
        }
        if found == 0 {
            return Err(ProgramError::Custom(EXTENSION_NOT_FOUND));
        }
        start = value_end;
    }
    Err(invalid())
}

/// An `OptionalNonZeroPubkey` at `at`: `None` when all zero.
pub fn optional_key(data: &[u8], at: usize) -> Option<Pubkey> {
    let key = bytes_at::<32>(data, at)?;
    if *key == [0u8; 32] {
        None
    } else {
        Some(Pubkey::new_from_array(*key))
    }
}
/// Why `open_vault` refuses a mint, if it does.
///
/// * NonTransferable: tokens could never leave the vault.
/// * PermanentDelegate: an Ed25519 key can move tokens out of any account.
/// * MintCloseAuthority with an authority: at zero supply the mint can be
///   closed and re-created at the same address with a permanent delegate,
///   which would then drain the vault. An absent or None authority can never
///   be added later, so checking once at `open_vault` is complete.
/// * TransferFeeConfig with a live fee or withdraw authority: a stolen
///   authority key could raise the fee to 100% and collect the withheld
///   tokens on the next payout. A fixed fee is accepted: it applies only to
///   the amount paid out, like any transfer.
///
/// Each would leave an Ed25519 path to the deposit, which a quantum attacker
/// could use, so the post-quantum guarantee would be false. Freeze, pause and
/// transfer hooks can delay a payout but cannot take funds, and they never
/// block `withdraw` itself; clients warn about them. Unknown extension types
/// fail to parse and are rejected too.
///
/// `Ok(true)`: supported; `Ok(false)`: `UnsupportedMint`; `Err`: the mint's
/// extension data does not parse (the error the Anchor build returned).
/// `tlv` is a Token-2022 mint's extension data (SPL Token mints have none).
pub fn mint_is_supported(tlv: &[u8]) -> Result<bool, ProgramError> {
    let mut supported = true;
    for_each_extension_type(tlv, |extension_type| {
        if !supported {
            return Ok(());
        }
        match extension_type {
            EXT_NON_TRANSFERABLE | EXT_PERMANENT_DELEGATE => supported = false,
            EXT_MINT_CLOSE_AUTHORITY => {
                let config =
                    get_extension(tlv, EXT_MINT_CLOSE_AUTHORITY, MINT_CLOSE_AUTHORITY_LEN)?;
                supported = optional_key(config, 0).is_none();
            }
            EXT_TRANSFER_FEE_CONFIG => {
                let config = get_extension(tlv, EXT_TRANSFER_FEE_CONFIG, TRANSFER_FEE_CONFIG_LEN)?;
                // transfer_fee_config_authority (32) | withdraw_withheld_authority (32) | ...
                supported = optional_key(config, 0).is_none() && optional_key(config, 32).is_none();
            }
            _ => {}
        }
        Ok(())
    })?;
    Ok(supported)
}

/// `transfer_hook::get_program_id`: the hook program of a Token-2022 mint,
/// `None` if it has none (or its extension does not parse).
pub fn hook_program_id(tlv: &[u8]) -> Option<Pubkey> {
    let hook = get_extension(tlv, EXT_TRANSFER_HOOK, TRANSFER_HOOK_LEN).ok()?;
    // authority (32) | program_id (32)
    optional_key(hook, 32)
}

/// Whether a Token-2022 account requires a memo before incoming transfers
/// (`MemoTransfer.require_incoming_transfer_memos`, false if absent).
pub fn requires_memo(tlv: &[u8]) -> bool {
    get_extension(tlv, EXT_MEMO_TRANSFER, MEMO_TRANSFER_LEN)
        .is_ok_and(|memo| memo.first().is_some_and(|b| *b != 0))
}

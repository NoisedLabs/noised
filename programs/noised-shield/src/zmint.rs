//! The zToken mint: Token-2022 with confidential balances and immutable
//! embedded metadata, at a PDA so its address is a pure function of the base
//! mint.
//!
//! Token-2022 sequence (each step is required by the next):
//! 1. allocate the PDA with exactly the fixed extension space
//!    (ConfidentialTransferMint + MetadataPointer): `InitializeMint` rejects
//!    any other length. Lamports already cover the final size, because
//!    `InitializeTokenMetadata` reallocs the account without topping it up.
//! 2. `ConfidentialTransferMint::InitializeMint` {authority None, auto-approve,
//!    auditor None} and `MetadataPointer::Initialize` {authority None,
//!    address = itself}: mint extensions must precede `InitializeMint`.
//! 3. `InitializeMint2`: mint authority = shield authority, freeze None.
//! 4. `TokenMetadata::Initialize` signed by the mint authority (update
//!    authority = shield authority, the only signer we have), then
//!    `UpdateAuthority(None)`: Token-2022 cannot initialize metadata with no
//!    update authority, so it is revoked in the same instruction.
//! 5. Re-read the account and require every property above (`verify`).
//!
//! The instruction data is built here byte for byte as the SPL builders
//! (`confidential_transfer::instruction::initialize_mint`,
//! `spl_token_metadata_interface::instruction::{initialize,
//! update_authority}`) build it; `tests/abi.rs` compares them.

use noised_onchain::{
    args::Reader,
    cpi, owned_by, same,
    sysvar::Rent,
    token::{
        get_extension, get_extension_bytes, initialize_mint2_data, initialize_mint_extension,
        metadata_pointer_initialize_data, optional_key, unpack_mint, ExtensionTypes,
        ACCOUNT_TYPE_MINT, EXT_CONFIDENTIAL_TRANSFER_MINT, EXT_METADATA_POINTER,
        EXT_TOKEN_METADATA, METADATA_POINTER_LEN,
    },
};
use pinocchio::{
    cpi::Signer, error::ProgramError, instruction::InstructionAccount, AccountView, ProgramResult,
};

use crate::{
    error::{fail_keys, shield, ShieldError},
    metadata::{ZMetadata, MAX_NAME_LEN, MAX_SYMBOL_LEN, MAX_URI_LEN},
    token::{SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID},
    Buf, Pubkey,
};

/// Extensions initialized before `InitializeMint`, in order
/// (`ExtensionType` numbers: ConfidentialTransferMint, MetadataPointer).
pub const FIXED_EXTENSIONS: [u16; 2] = [EXT_CONFIDENTIAL_TRANSFER_MINT, EXT_METADATA_POINTER];
/// The zToken's complete extension list, in on-chain order
/// (ConfidentialTransferMint, MetadataPointer, TokenMetadata).
pub const Z_MINT_EXTENSIONS: [u16; 3] = [
    EXT_CONFIDENTIAL_TRANSFER_MINT,
    EXT_METADATA_POINTER,
    EXT_TOKEN_METADATA,
];

/// `ConfidentialTransferMint`: authority (32) | auto_approve_new_accounts
/// (1) | auditor_elgamal_pubkey (32).
pub const CONFIDENTIAL_TRANSFER_MINT_LEN: usize = 65;

/// `ExtensionType::try_calculate_account_len::<Mint>(&FIXED_EXTENSIONS)`:
/// 165-byte base, the account type byte, then each extension's 4-byte TLV
/// header and value (not the multisig length, so never padded).
pub const FIXED_LEN: usize =
    165 + 1 + (4 + CONFIDENTIAL_TRANSFER_MINT_LEN) + (4 + METADATA_POINTER_LEN);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ZMintSize {
    /// Length `InitializeMint` requires.
    pub fixed: usize,
    /// Length after `InitializeTokenMetadata` appends the metadata TLV entry.
    pub total: usize,
}

/// Token-2022 extension entry header: u16 type + u16 length. (Not
/// `TokenMetadata::tlv_size_of`, which sizes a standalone spl-type-length-value
/// account with an 8-byte discriminator and u32 length.)
const EXTENSION_HEADER_LEN: usize = 4;

/// Borsh length of the zToken's `TokenMetadata`: update authority, mint,
/// name, symbol, uri (each with a `u32` length), empty additional metadata
/// (a `u32` count).
pub fn token_metadata_len(meta: &ZMetadata) -> usize {
    32 + 32
        + 4
        + meta.name.as_bytes().len()
        + 4
        + meta.symbol.as_bytes().len()
        + 4
        + meta.uri.as_bytes().len()
        + 4
}

/// Account sizes for a zToken mint carrying `meta`. Token-2022 pads a mint
/// whose length would equal a multisig's (355 bytes); `total` is always
/// larger than that (the metadata entry alone is >= 84 bytes on top of a
/// 303-byte fixed part).
pub fn z_mint_size(meta: &ZMetadata) -> ZMintSize {
    ZMintSize {
        fixed: FIXED_LEN,
        total: FIXED_LEN + EXTENSION_HEADER_LEN + token_metadata_len(meta),
    }
}

/// `ConfidentialTransferInstruction::InitializeMint { authority: None,
/// auto_approve_new_accounts: true, auditor_elgamal_pubkey: None }`
/// (Token-2022 instruction 27, sub-instruction 0).
pub fn confidential_transfer_initialize_mint_data() -> [u8; 2 + CONFIDENTIAL_TRANSFER_MINT_LEN] {
    let mut data = [0u8; 2 + CONFIDENTIAL_TRANSFER_MINT_LEN];
    data[0] = 27;
    // authority None (32 zero bytes), then auto-approve, then auditor None.
    data[2 + 32] = 1;
    data
}

/// `spl_discriminator` of `spl_token_metadata_interface:initialize_account`.
pub const TOKEN_METADATA_INITIALIZE: [u8; 8] = [210, 225, 30, 162, 88, 184, 77, 141];
/// `spl_discriminator` of `spl_token_metadata_interface:update_the_authority`.
pub const TOKEN_METADATA_UPDATE_AUTHORITY: [u8; 8] = [215, 228, 166, 228, 84, 100, 86, 123];

/// Longest `Initialize` instruction data (the metadata limits).
pub const TOKEN_METADATA_INITIALIZE_MAX_LEN: usize =
    8 + 4 + MAX_NAME_LEN + 4 + MAX_SYMBOL_LEN + 4 + MAX_URI_LEN;

/// `TokenMetadataInstruction::Initialize { name, symbol, uri }`.
pub fn token_metadata_initialize_data(meta: &ZMetadata) -> Buf<TOKEN_METADATA_INITIALIZE_MAX_LEN> {
    let (name, symbol, uri) = (
        meta.name.as_bytes(),
        meta.symbol.as_bytes(),
        meta.uri.as_bytes(),
    );
    let lengths = [name.len(), symbol.len(), uri.len()].map(|n| (n as u32).to_le_bytes());
    let mut data = Buf::new();
    data.put_all(&[
        &TOKEN_METADATA_INITIALIZE,
        &lengths[0],
        name,
        &lengths[1],
        symbol,
        &lengths[2],
        uri,
    ]);
    data
}

/// `TokenMetadataInstruction::UpdateAuthority { new_authority: None }`.
pub fn token_metadata_revoke_authority_data() -> [u8; 40] {
    let mut data = [0u8; 40];
    data[..8].copy_from_slice(&TOKEN_METADATA_UPDATE_AUTHORITY);
    data
}

pub struct ZMintAccounts<'a> {
    pub payer: &'a AccountView,
    pub z_mint: &'a AccountView,
    pub shield_authority: &'a AccountView,
    /// Token-2022 (the account checked as `Program<Token2022>`).
    pub token_2022_program: &'a AccountView,
}

/// Create and fully initialize the zToken mint (steps 1-4 above). The
/// zToken PDA signs with `z_mint_signer`, the shield authority with
/// `authority_signer`.
pub fn create(
    accounts: &ZMintAccounts,
    decimals: u8,
    meta: &ZMetadata,
    z_mint_signer: &[Signer],
    authority_signer: &[Signer],
) -> ProgramResult {
    let token_program = accounts.token_2022_program;
    let z_mint = accounts.z_mint.address();
    let authority = accounts.shield_authority.address();
    let size = z_mint_size(meta);
    let lamports = Rent::get()?.minimum_balance(size.total);
    create_pda_account(accounts, lamports, size.fixed, z_mint_signer)?;

    mint_only(
        token_program,
        accounts.z_mint,
        &confidential_transfer_initialize_mint_data(),
    )?;
    mint_only(
        token_program,
        accounts.z_mint,
        &metadata_pointer_initialize_data(None, Some(z_mint)),
    )?;
    // initialize_mint2(token_program, z_mint, decimals, authority, None)
    let (data, len) = initialize_mint2_data(decimals, authority, None);
    mint_only(
        token_program,
        accounts.z_mint,
        data.get(..len).unwrap_or(&data),
    )?;

    let with_authority = [accounts.z_mint, accounts.shield_authority];
    // initialize(metadata = z_mint, update_authority = authority, mint =
    // z_mint, mint_authority = authority (signer), name, symbol, uri).
    cpi::invoke(
        token_program.address(),
        &[
            InstructionAccount::writable(z_mint),
            InstructionAccount::readonly(authority),
            InstructionAccount::readonly(z_mint),
            InstructionAccount::readonly_signer(authority),
        ],
        token_metadata_initialize_data(meta).as_slice(),
        &with_authority,
        authority_signer,
    )?;
    // update_authority(metadata = z_mint, current = authority (signer), None).
    cpi::invoke(
        token_program.address(),
        &[
            InstructionAccount::writable(z_mint),
            InstructionAccount::readonly_signer(authority),
        ],
        &token_metadata_revoke_authority_data(),
        &with_authority,
        authority_signer,
    )
}

/// A Token-2022 instruction whose only account is the (writable) mint,
/// signed by no one (`initialize_mint_extension`, `initialize_mint2`).
#[inline(never)]
fn mint_only(token_program: &AccountView, mint: &AccountView, data: &[u8]) -> ProgramResult {
    initialize_mint_extension(token_program, mint, data)
}

/// Allocate `space` bytes at the PDA and assign it to Token-2022. Works even
/// if someone sent lamports to the address first: a plain `create_account`
/// would fail and let anyone block a shield for any mint forever.
fn create_pda_account(
    accounts: &ZMintAccounts,
    lamports: u64,
    space: usize,
    signers: &[Signer],
) -> ProgramResult {
    let target = accounts.z_mint;
    // require_keys_eq!(*target.owner, system_program::ID, ZMintInUse)
    if !owned_by(target, &SYSTEM_PROGRAM_ID) {
        return Err(fail_keys(
            ShieldError::ZMintInUse.code(),
            None,
            target.owner(),
            &SYSTEM_PROGRAM_ID,
        ));
    }
    if !target.is_data_empty() {
        return Err(shield(ShieldError::ZMintInUse));
    }
    let space = space as u64;
    let current = target.lamports();
    if current == 0 {
        return cpi::create_account(
            accounts.payer,
            target,
            lamports,
            space,
            &TOKEN_2022_PROGRAM_ID,
            signers,
        );
    }
    let shortfall = lamports.saturating_sub(current);
    if shortfall > 0 {
        cpi::transfer(accounts.payer, target, shortfall, &[])?;
    }
    cpi::allocate(target, space, signers)?;
    cpi::assign(target, &TOKEN_2022_PROGRAM_ID, signers)
}

#[inline(always)]
fn misconfigured() -> ProgramError {
    shield(ShieldError::ZMintMisconfigured)
}

/// The fields of a `TokenMetadata` value (Borsh, as
/// `get_variable_len_extension::<TokenMetadata>` decodes it: trailing bytes
/// ignored, any other failure `BorshIoError`).
struct TokenMetadataFields<'a> {
    update_authority: &'a [u8; 32],
    mint: &'a [u8; 32],
    name: &'a [u8],
    symbol: &'a [u8],
    uri: &'a [u8],
    additional_metadata: u32,
}

fn decode_token_metadata(value: &[u8]) -> Option<TokenMetadataFields<'_>> {
    let mut r = Reader::new(value);
    let update_authority = r.array::<32>()?;
    let mint = r.array::<32>()?;
    // name, symbol, uri.
    let mut strings: [&[u8]; 3] = [&[]; 3];
    for string in strings.iter_mut() {
        *string = r.str()?.as_bytes();
    }
    // additional_metadata: Vec<(String, String)>.
    let additional_metadata = r.u32()?;
    for _ in 0..u64::from(additional_metadata) * 2 {
        r.str()?;
    }
    let [name, symbol, uri] = strings;
    Some(TokenMetadataFields {
        update_authority,
        mint,
        name,
        symbol,
        uri,
        additional_metadata,
    })
}

/// Require the exact promised zToken configuration on the live account:
/// owner Token-2022; extensions exactly [`Z_MINT_EXTENSIONS`]; confidential
/// transfers with no authority, auto-approval and no auditor; metadata
/// pointer to itself with no authority; immutable metadata equal to `meta`;
/// mint authority = shield authority; no freeze authority; zero supply.
///
/// As in the Anchor build, the parse errors of the extension list and of
/// each extension (`?` there) are returned as they are; every property that
/// does not hold is `ZMintMisconfigured`.
pub fn verify(
    z_mint: &AccountView,
    authority: &Pubkey,
    decimals: u8,
    meta: &ZMetadata,
) -> ProgramResult {
    if !owned_by(z_mint, &TOKEN_2022_PROGRAM_ID) {
        return Err(fail_keys(
            ShieldError::ZMintMisconfigured.code(),
            None,
            z_mint.owner(),
            &TOKEN_2022_PROGRAM_ID,
        ));
    }
    let data = z_mint.try_borrow()?;
    let state = unpack_mint(&data).map_err(|_| misconfigured())?;
    let base_ok = state.mint_authority().is_some_and(|a| same(&a, authority))
        && state.freeze_authority().is_none()
        && state.decimals() == decimals
        && state.supply() == 0;
    if !base_ok {
        return Err(misconfigured());
    }

    // get_extension_types()? == Z_MINT_EXTENSIONS
    let mut types = ExtensionTypes::new(state.tlv);
    while types.next_type()?.is_some() {}
    let mut types = ExtensionTypes::new(state.tlv);
    for expected in Z_MINT_EXTENSIONS {
        if types.next_type()? != Some(expected) {
            return Err(misconfigured());
        }
    }
    if types.next_type()?.is_some() {
        return Err(misconfigured());
    }

    let ct = get_extension(
        state.tlv,
        ACCOUNT_TYPE_MINT,
        EXT_CONFIDENTIAL_TRANSFER_MINT,
        CONFIDENTIAL_TRANSFER_MINT_LEN,
    )?;
    // All-zero encodes "no auditor".
    let ct_ok = optional_key(ct, 0).is_none()
        && ct.get(32).is_some_and(|auto_approve| *auto_approve != 0)
        && ct
            .get(33..)
            .is_some_and(|auditor| auditor.iter().all(|b| *b == 0));
    if !ct_ok {
        return Err(misconfigured());
    }

    let pointer = get_extension(
        state.tlv,
        ACCOUNT_TYPE_MINT,
        EXT_METADATA_POINTER,
        METADATA_POINTER_LEN,
    )?;
    let pointer_ok = optional_key(pointer, 0).is_none()
        && optional_key(pointer, 32).is_some_and(|address| same(&address, z_mint.address()));
    if !pointer_ok {
        return Err(misconfigured());
    }

    let value = get_extension_bytes(state.tlv, ACCOUNT_TYPE_MINT, EXT_TOKEN_METADATA)?;
    let tm = decode_token_metadata(value).ok_or(ProgramError::BorshIoError)?;
    let tm_ok = *tm.update_authority == [0u8; 32]
        && tm.mint == z_mint.address().as_array()
        && tm.name == meta.name.as_bytes()
        && tm.symbol == meta.symbol.as_bytes()
        && tm.uri == meta.uri.as_bytes()
        && tm.additional_metadata == 0;
    if !tm_ok {
        return Err(misconfigured());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metadata::{Text, MAX_NAME_LEN, MAX_SYMBOL_LEN, MAX_URI_LEN};

    fn meta(name: usize, symbol: usize, uri: usize) -> ZMetadata {
        ZMetadata {
            name: Text::try_new(&"n".repeat(name)).unwrap(),
            symbol: Text::try_new(&"s".repeat(symbol)).unwrap(),
            uri: Text::try_new(&"u".repeat(uri)).unwrap(),
        }
    }

    #[test]
    fn sizes_match_the_token_2022_layout() {
        // 165 base + 1 account type + (4 + 65) confidential mint + (4 + 64) pointer.
        let s = z_mint_size(&meta(0, 0, 0));
        assert_eq!(s.fixed, 303);
        // + 4 TLV header + 32 authority + 32 mint + 4 * 4 length prefixes.
        assert_eq!(s.total, 303 + 4 + 80);
        let s = z_mint_size(&meta(10, 2, 0));
        assert_eq!(s.total, 303 + 4 + 80 + 12);
        let max = meta(MAX_NAME_LEN, MAX_SYMBOL_LEN, MAX_URI_LEN);
        let s = z_mint_size(&max);
        assert_eq!(s.total, 303 + 4 + 80 + 32 + 10 + 200);
    }

    #[test]
    fn never_collides_with_the_multisig_length() {
        // The smallest derived metadata ("Shielded X" / "zX" / "") is already
        // well past 355 bytes, so Token-2022's multisig padding never applies.
        let s = z_mint_size(&meta(10, 2, 0));
        assert!(s.fixed != 355 && s.total > 355);
    }
}

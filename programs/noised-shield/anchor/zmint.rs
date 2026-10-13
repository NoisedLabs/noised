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

use anchor_lang::{
    prelude::*,
    solana_program::{
        program::{invoke, invoke_signed},
        program_option::COption,
    },
    system_program,
};
use anchor_spl::token_2022::spl_token_2022::{
    self,
    extension::{
        confidential_transfer::{self, ConfidentialTransferMint},
        metadata_pointer::{self, MetadataPointer},
        BaseStateWithExtensions, ExtensionType, StateWithExtensions,
    },
    state::Mint,
};
use anchor_spl::token_2022_extensions::{
    spl_pod::optional_keys::OptionalNonZeroPubkey,
    spl_token_metadata_interface::{self, state::TokenMetadata},
};

use crate::{error::ShieldError, metadata::ZMetadata};

/// Extensions initialized before `InitializeMint`, in order.
pub const FIXED_EXTENSIONS: [ExtensionType; 2] = [
    ExtensionType::ConfidentialTransferMint,
    ExtensionType::MetadataPointer,
];
/// The zToken's complete extension list, in on-chain order.
pub const Z_MINT_EXTENSIONS: [ExtensionType; 3] = [
    ExtensionType::ConfidentialTransferMint,
    ExtensionType::MetadataPointer,
    ExtensionType::TokenMetadata,
];

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

/// Account sizes for a zToken mint carrying `metadata`. Token-2022 pads a
/// mint whose length would equal a multisig's (355 bytes); `total` is
/// always larger than that (the metadata entry alone is >= 84 bytes on top
/// of a 303-byte fixed part).
pub fn z_mint_size(metadata: &TokenMetadata) -> Result<ZMintSize> {
    let fixed = ExtensionType::try_calculate_account_len::<Mint>(&FIXED_EXTENSIONS)?;
    let value_len = borsh::object_length(metadata).map_err(|_| ShieldError::MathOverflow)?;
    let total = fixed
        .checked_add(EXTENSION_HEADER_LEN)
        .and_then(|n| n.checked_add(value_len))
        .ok_or(ShieldError::MathOverflow)?;
    Ok(ZMintSize { fixed, total })
}

/// The `TokenMetadata` the zToken is initialized with (update authority is
/// revoked right after).
pub fn initial_metadata(
    z_mint: &Pubkey,
    authority: &Pubkey,
    meta: &ZMetadata,
) -> Result<TokenMetadata> {
    Ok(TokenMetadata {
        update_authority: OptionalNonZeroPubkey::try_from(Some(*authority))?,
        mint: *z_mint,
        name: meta.name.clone(),
        symbol: meta.symbol.clone(),
        uri: meta.uri.clone(),
        additional_metadata: Vec::new(),
    })
}

pub struct ZMintAccounts<'a, 'info> {
    pub payer: &'a AccountInfo<'info>,
    pub z_mint: &'a AccountInfo<'info>,
    pub shield_authority: &'a AccountInfo<'info>,
    pub system_program: &'a AccountInfo<'info>,
}

/// Create and fully initialize the zToken mint (steps 1-4 above).
pub fn create(
    accounts: &ZMintAccounts,
    decimals: u8,
    meta: &ZMetadata,
    z_mint_seeds: &[&[u8]],
    authority_seeds: &[&[u8]],
) -> Result<()> {
    let token_program = &spl_token_2022::ID;
    let z_mint = accounts.z_mint.key();
    let authority = accounts.shield_authority.key();
    let size = z_mint_size(&initial_metadata(&z_mint, &authority, meta)?)?;
    let lamports = Rent::get()?.minimum_balance(size.total);
    create_pda_account(accounts, lamports, size.fixed, token_program, z_mint_seeds)?;

    let mint_only = [accounts.z_mint.clone()];
    let auto_approve = true;
    invoke(
        &confidential_transfer::instruction::initialize_mint(
            token_program,
            &z_mint,
            None,
            auto_approve,
            None,
        )?,
        &mint_only,
    )?;
    invoke(
        &metadata_pointer::instruction::initialize(token_program, &z_mint, None, Some(z_mint))?,
        &mint_only,
    )?;
    invoke(
        &spl_token_2022::instruction::initialize_mint2(
            token_program,
            &z_mint,
            &authority,
            None,
            decimals,
        )?,
        &mint_only,
    )?;

    let with_authority = [accounts.z_mint.clone(), accounts.shield_authority.clone()];
    invoke_signed(
        &spl_token_metadata_interface::instruction::initialize(
            token_program,
            &z_mint,
            &authority,
            &z_mint,
            &authority,
            meta.name.clone(),
            meta.symbol.clone(),
            meta.uri.clone(),
        ),
        &with_authority,
        &[authority_seeds],
    )?;
    invoke_signed(
        &spl_token_metadata_interface::instruction::update_authority(
            token_program,
            &z_mint,
            &authority,
            OptionalNonZeroPubkey::default(),
        ),
        &with_authority,
        &[authority_seeds],
    )?;
    Ok(())
}

/// Allocate `space` bytes at the PDA and assign it to `owner`. Works even if
/// someone sent lamports to the address first: a plain `create_account`
/// would fail and let anyone block a shield for any mint forever.
fn create_pda_account(
    accounts: &ZMintAccounts,
    lamports: u64,
    space: usize,
    owner: &Pubkey,
    seeds: &[&[u8]],
) -> Result<()> {
    let target = accounts.z_mint;
    require_keys_eq!(*target.owner, system_program::ID, ShieldError::ZMintInUse);
    require!(target.data_is_empty(), ShieldError::ZMintInUse);
    let space = u64::try_from(space).map_err(|_| ShieldError::MathOverflow)?;
    let signer: &[&[&[u8]]] = &[seeds];
    let current = target.lamports();
    if current == 0 {
        return system_program::create_account(
            CpiContext::new_with_signer(
                system_program::ID,
                system_program::CreateAccount {
                    from: accounts.payer.clone(),
                    to: target.clone(),
                },
                signer,
            ),
            lamports,
            space,
            owner,
        );
    }
    let shortfall = lamports.saturating_sub(current);
    if shortfall > 0 {
        system_program::transfer(
            CpiContext::new(
                system_program::ID,
                system_program::Transfer {
                    from: accounts.payer.clone(),
                    to: target.clone(),
                },
            ),
            shortfall,
        )?;
    }
    system_program::allocate(
        CpiContext::new_with_signer(
            system_program::ID,
            system_program::Allocate {
                account_to_allocate: target.clone(),
            },
            signer,
        ),
        space,
    )?;
    system_program::assign(
        CpiContext::new_with_signer(
            system_program::ID,
            system_program::Assign {
                account_to_assign: target.clone(),
            },
            signer,
        ),
        owner,
    )
}

/// Require the exact promised zToken configuration on the live account:
/// owner Token-2022; extensions exactly [`Z_MINT_EXTENSIONS`]; confidential
/// transfers with no authority, auto-approval and no auditor; metadata
/// pointer to itself with no authority; immutable metadata equal to `meta`;
/// mint authority = shield authority; no freeze authority; zero supply.
pub fn verify(
    z_mint: &AccountInfo,
    authority: &Pubkey,
    decimals: u8,
    meta: &ZMetadata,
) -> Result<()> {
    require_keys_eq!(
        *z_mint.owner,
        spl_token_2022::ID,
        ShieldError::ZMintMisconfigured
    );
    let data = z_mint.try_borrow_data()?;
    let state = StateWithExtensions::<Mint>::unpack(&data)
        .map_err(|_| error!(ShieldError::ZMintMisconfigured))?;
    let base = &state.base;
    require!(
        base.is_initialized
            && base.mint_authority == COption::Some(*authority)
            && base.freeze_authority == COption::None
            && base.decimals == decimals
            && base.supply == 0,
        ShieldError::ZMintMisconfigured
    );
    require!(
        state.get_extension_types()? == Z_MINT_EXTENSIONS,
        ShieldError::ZMintMisconfigured
    );
    let ct = state.get_extension::<ConfidentialTransferMint>()?;
    require!(
        Option::<Pubkey>::from(ct.authority).is_none()
            && bool::from(ct.auto_approve_new_accounts)
            // All-zero encodes "no auditor".
            && ct.auditor_elgamal_pubkey == Default::default(),
        ShieldError::ZMintMisconfigured
    );
    let pointer = state.get_extension::<MetadataPointer>()?;
    require!(
        Option::<Pubkey>::from(pointer.authority).is_none()
            && Option::<Pubkey>::from(pointer.metadata_address) == Some(z_mint.key()),
        ShieldError::ZMintMisconfigured
    );
    let tm = state.get_variable_len_extension::<TokenMetadata>()?;
    require!(
        Option::<Pubkey>::from(tm.update_authority).is_none()
            && tm.mint == z_mint.key()
            && tm.name == meta.name
            && tm.symbol == meta.symbol
            && tm.uri == meta.uri
            && tm.additional_metadata.is_empty(),
        ShieldError::ZMintMisconfigured
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metadata::{MAX_NAME_LEN, MAX_SYMBOL_LEN, MAX_URI_LEN};

    fn meta(name: usize, symbol: usize, uri: usize) -> ZMetadata {
        ZMetadata {
            name: "n".repeat(name),
            symbol: "s".repeat(symbol),
            uri: "u".repeat(uri),
        }
    }

    #[test]
    fn sizes_match_the_token_2022_layout() {
        let (mint, auth) = (Pubkey::new_unique(), Pubkey::new_unique());
        // 165 base + 1 account type + (4 + 65) confidential mint + (4 + 64) pointer.
        let s = z_mint_size(&initial_metadata(&mint, &auth, &meta(0, 0, 0)).unwrap()).unwrap();
        assert_eq!(s.fixed, 303);
        // + 4 TLV header + 32 authority + 32 mint + 4 * 4 length prefixes.
        assert_eq!(s.total, 303 + 4 + 80);
        let s = z_mint_size(&initial_metadata(&mint, &auth, &meta(10, 2, 0)).unwrap()).unwrap();
        assert_eq!(s.total, 303 + 4 + 80 + 12);
        let max = meta(MAX_NAME_LEN, MAX_SYMBOL_LEN, MAX_URI_LEN);
        let s = z_mint_size(&initial_metadata(&mint, &auth, &max).unwrap()).unwrap();
        assert_eq!(s.total, 303 + 4 + 80 + 32 + 10 + 200);
    }

    #[test]
    fn never_collides_with_the_multisig_length() {
        // The smallest derived metadata ("Shielded X" / "zX" / "") is already
        // well past 355 bytes, so Token-2022's multisig padding never applies.
        let (mint, auth) = (Pubkey::new_unique(), Pubkey::new_unique());
        let s = z_mint_size(&initial_metadata(&mint, &auth, &meta(10, 2, 0)).unwrap()).unwrap();
        assert!(s.fixed != 355 && s.total > 355);
    }
}

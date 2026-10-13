//! Which base mints can be shielded, decided from the raw mint data.
//!
//! Pure functions over account bytes, so the whole policy is exercised by
//! host unit tests.

use anchor_lang::prelude::Pubkey;
use anchor_spl::token_2022::spl_token_2022::{
    extension::{
        metadata_pointer::MetadataPointer, BaseStateWithExtensions, ExtensionType,
        StateWithExtensions,
    },
    state::Mint,
};
use anchor_spl::token_2022_extensions::spl_token_metadata_interface::state::TokenMetadata;

use crate::metadata::{derive, read_base_metadata, ZMetadata};

/// The only Token-2022 mint extensions a base mint may have. None of them can
/// move tokens out of the escrow, block every transfer at once, change what a
/// unit is worth, or make the mint disappear:
///
/// * `MetadataPointer`, `TokenMetadata`: descriptive only.
/// * `TransferHook`: Noised launch tokens carry the Launch Guard hook
///   (revoked by Meteora DBC at graduation). A hook can refuse transfers but
///   cannot take tokens.
/// * `TransferFeeConfig`: fees are measured, not trusted: `wrap` mints only
///   what the escrow actually received, and `unwrap` charges the unwrapper.
///
/// Everything else is refused, including extensions that can drain or freeze
/// the escrow (`PermanentDelegate`, `Pausable`, `DefaultAccountState`), make
/// it unredeemable (`NonTransferable`, `MintCloseAuthority`), break balance
/// accounting (`ConfidentialTransferMint`, `ConfidentialMintBurn`) or rescale
/// amounts (`InterestBearingConfig`, `ScaledUiAmount`). Extension types this
/// program does not know (e.g. `PermissionedBurn` and anything newer) fail
/// to parse and are refused too: the check fails closed.
pub const ALLOWED_BASE_EXTENSIONS: [ExtensionType; 4] = [
    ExtensionType::MetadataPointer,
    ExtensionType::TokenMetadata,
    ExtensionType::TransferHook,
    ExtensionType::TransferFeeConfig,
];

/// Why a base mint is refused.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Rejection {
    /// The account is not a valid initialized Token-2022 mint.
    Malformed,
    /// An extension outside the allowlist.
    Unsupported(ExtensionType),
    /// Extension data this program cannot parse (an unknown, newer type).
    Unknown,
}

/// The first extension outside [`ALLOWED_BASE_EXTENSIONS`], if any.
pub fn first_unsupported(extensions: &[ExtensionType]) -> Option<ExtensionType> {
    extensions
        .iter()
        .copied()
        .find(|e| !ALLOWED_BASE_EXTENSIONS.contains(e))
}

/// Check a Token-2022 base mint against the allowlist and derive the zToken
/// metadata from its embedded metadata, which is used only when canonical:
/// the mint's metadata pointer must point at the mint itself.
pub fn inspect_token_2022_mint(data: &[u8], mint: &Pubkey) -> Result<ZMetadata, Rejection> {
    let state = StateWithExtensions::<Mint>::unpack(data).map_err(|_| Rejection::Malformed)?;
    let extensions = state
        .get_extension_types()
        .map_err(|_| Rejection::Unknown)?;
    if let Some(ext) = first_unsupported(&extensions) {
        return Err(Rejection::Unsupported(ext));
    }
    let points_to_self = state
        .get_extension::<MetadataPointer>()
        .ok()
        .and_then(|p| Option::<Pubkey>::from(p.metadata_address))
        == Some(*mint);
    let embedded = if points_to_self {
        state.get_extension_bytes::<TokenMetadata>().ok()
    } else {
        None
    };
    Ok(derive(
        embedded.and_then(|value| read_base_metadata(value, mint)),
        mint,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_spl::token_2022::spl_token_2022::extension::{
        metadata_pointer::MetadataPointer as Mp, mint_close_authority::MintCloseAuthority,
        non_transferable::NonTransferable, pausable::PausableConfig,
        permanent_delegate::PermanentDelegate, transfer_hook::TransferHook,
        BaseStateWithExtensionsMut, ExtensionType as E, StateWithExtensionsMut,
    };
    use anchor_spl::token_2022_extensions::spl_pod::optional_keys::OptionalNonZeroPubkey;

    const ALL_KNOWN: [E; 28] = [
        E::Uninitialized,
        E::TransferFeeConfig,
        E::TransferFeeAmount,
        E::MintCloseAuthority,
        E::ConfidentialTransferMint,
        E::ConfidentialTransferAccount,
        E::DefaultAccountState,
        E::ImmutableOwner,
        E::MemoTransfer,
        E::NonTransferable,
        E::InterestBearingConfig,
        E::CpiGuard,
        E::PermanentDelegate,
        E::NonTransferableAccount,
        E::TransferHook,
        E::TransferHookAccount,
        E::ConfidentialTransferFeeConfig,
        E::ConfidentialTransferFeeAmount,
        E::MetadataPointer,
        E::TokenMetadata,
        E::GroupPointer,
        E::TokenGroup,
        E::GroupMemberPointer,
        E::TokenGroupMember,
        E::ConfidentialMintBurn,
        E::ScaledUiAmount,
        E::Pausable,
        E::PausableAccount,
    ];

    #[test]
    fn allowlist_is_exactly_the_spec() {
        let allowed: Vec<E> = ALL_KNOWN
            .iter()
            .copied()
            .filter(|e| first_unsupported(&[*e]).is_none())
            .collect();
        assert_eq!(
            allowed,
            vec![
                E::TransferFeeConfig,
                E::TransferHook,
                E::MetadataPointer,
                E::TokenMetadata
            ]
        );
    }

    #[test]
    fn every_dangerous_extension_is_refused() {
        for e in [
            E::PermanentDelegate,
            E::Pausable,
            E::DefaultAccountState,
            E::NonTransferable,
            E::ConfidentialTransferMint,
            E::ConfidentialMintBurn,
            E::MintCloseAuthority,
            E::ScaledUiAmount,
            E::InterestBearingConfig,
            E::GroupPointer,
            E::TokenGroup,
        ] {
            assert_eq!(
                first_unsupported(&[E::MetadataPointer, e]),
                Some(e),
                "{e:?}"
            );
        }
        assert_eq!(first_unsupported(&[]), None);
        assert_eq!(
            first_unsupported(&ALLOWED_BASE_EXTENSIONS),
            None,
            "the full allowlist together is accepted"
        );
    }

    /// Build raw Token-2022 mint bytes with the given fixed-size extensions.
    fn mint_bytes(exts: &[E]) -> Vec<u8> {
        let len = E::try_calculate_account_len::<Mint>(exts).unwrap();
        let mut data = vec![0u8; len];
        let mut state = StateWithExtensionsMut::<Mint>::unpack_uninitialized(&mut data).unwrap();
        for e in exts {
            let ok = match e {
                E::MetadataPointer => state.init_extension::<Mp>(true).is_ok(),
                E::TransferHook => state.init_extension::<TransferHook>(true).is_ok(),
                E::PermanentDelegate => state.init_extension::<PermanentDelegate>(true).is_ok(),
                E::NonTransferable => state.init_extension::<NonTransferable>(true).is_ok(),
                E::MintCloseAuthority => state.init_extension::<MintCloseAuthority>(true).is_ok(),
                E::Pausable => state.init_extension::<PausableConfig>(true).is_ok(),
                other => panic!("test helper cannot init {other:?}"),
            };
            assert!(ok, "init {e:?}");
        }
        state.base.is_initialized = true;
        state.base.decimals = 6;
        state.pack_base();
        state.init_account_type().unwrap();
        data
    }

    #[test]
    fn plain_token_2022_mint_is_accepted_with_generic_metadata() {
        let mint = Pubkey::new_unique();
        for exts in [
            &[][..],
            &[E::TransferHook][..],
            &[E::MetadataPointer, E::TransferHook][..],
        ] {
            let got = inspect_token_2022_mint(&mint_bytes(exts), &mint);
            assert_eq!(got, Ok(derive(None, &mint)), "{exts:?}");
        }
    }

    #[test]
    fn refused_extensions_are_reported() {
        let mint = Pubkey::new_unique();
        for e in [
            E::PermanentDelegate,
            E::NonTransferable,
            E::MintCloseAuthority,
            E::Pausable,
        ] {
            let data = mint_bytes(&[E::TransferHook, e]);
            assert_eq!(
                inspect_token_2022_mint(&data, &mint),
                Err(Rejection::Unsupported(e))
            );
        }
    }

    #[test]
    fn unknown_extension_types_fail_closed() {
        let mint = Pubkey::new_unique();
        let mut data = mint_bytes(&[E::TransferHook]);
        // Retag the TransferHook entry as type 28 (PermissionedBurn in
        // Token-2022 v11, unknown to this interface version) and as a type
        // number no Token-2022 version defines.
        let tlv = 166; // BASE_ACCOUNT_LENGTH + account type byte
        assert_eq!(
            u16::from_le_bytes([data[tlv], data[tlv + 1]]),
            u16::from(E::TransferHook)
        );
        for unknown in [28u16, 999] {
            data[tlv..tlv + 2].copy_from_slice(&unknown.to_le_bytes());
            assert_eq!(
                inspect_token_2022_mint(&data, &mint),
                Err(Rejection::Unknown)
            );
        }
    }

    #[test]
    fn malformed_data_is_refused() {
        let mint = Pubkey::new_unique();
        assert_eq!(
            inspect_token_2022_mint(&[0u8; 10], &mint),
            Err(Rejection::Malformed)
        );
        // Uninitialized mint.
        let mut data = mint_bytes(&[]);
        data[45] = 0; // is_initialized
        assert_eq!(
            inspect_token_2022_mint(&data, &mint),
            Err(Rejection::Malformed)
        );
    }

    #[test]
    fn metadata_is_used_only_when_the_pointer_targets_the_mint() {
        use anchor_spl::token_2022_extensions::spl_token_metadata_interface::state::TokenMetadata;
        let mint = Pubkey::new_unique();
        let build = |pointer: Option<Pubkey>| {
            let meta = TokenMetadata {
                update_authority: OptionalNonZeroPubkey::default(),
                mint,
                name: "Launch".into(),
                symbol: "LCH".into(),
                uri: "https://x.example/m.json".into(),
                additional_metadata: vec![],
            };
            let fixed = E::try_calculate_account_len::<Mint>(&[E::MetadataPointer]).unwrap();
            let mut data = vec![0u8; fixed + meta.tlv_size_of().unwrap()];
            let mut state =
                StateWithExtensionsMut::<Mint>::unpack_uninitialized(&mut data).unwrap();
            let mp = state.init_extension::<Mp>(true).unwrap();
            mp.metadata_address = OptionalNonZeroPubkey::try_from(pointer).unwrap();
            state.base.is_initialized = true;
            state.pack_base();
            state.init_account_type().unwrap();
            state.init_variable_len_extension(&meta, false).unwrap();
            data
        };
        let got = inspect_token_2022_mint(&build(Some(mint)), &mint).unwrap();
        assert_eq!(
            (got.name.as_str(), got.symbol.as_str(), got.uri.as_str()),
            ("Shielded Launch", "zLCH", "https://x.example/m.json")
        );
        let generic = Ok(derive(None, &mint));
        assert_eq!(
            inspect_token_2022_mint(&build(Some(Pubkey::new_unique())), &mint),
            generic
        );
        assert_eq!(inspect_token_2022_mint(&build(None), &mint), generic);
    }
}

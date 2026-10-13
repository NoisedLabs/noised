//! The vault's mint policy. Token-2022 parsing is `noised_onchain::token`
//! (written from, and tested against, spl-token-2022-interface 2.1.0,
//! which the Anchor build used through anchor-spl).

use noised_onchain::token::{
    for_each_extension_type, get_extension, optional_key, EXT_MINT_CLOSE_AUTHORITY,
    EXT_NON_TRANSFERABLE, EXT_PERMANENT_DELEGATE, EXT_TRANSFER_FEE_CONFIG,
    MINT_CLOSE_AUTHORITY_LEN, TRANSFER_FEE_CONFIG_LEN,
};
pub use noised_onchain::token::{
    ASSOCIATED_TOKEN_PROGRAM_ID, MEMO_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
};
use pinocchio::error::ProgramError;

/// The memo the vault writes before paying an account that requires memos.
pub const PAYOUT_MEMO: &[u8] = b"noised-vault payout";

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

use anchor_lang::{
    prelude::*,
    solana_program::{
        instruction::Instruction,
        program::{invoke, invoke_signed},
    },
};
use anchor_spl::{
    associated_token::{self, get_associated_token_address_with_program_id},
    token_2022::spl_token_2022::{
        self,
        extension::{
            memo_transfer::MemoTransfer, mint_close_authority::MintCloseAuthority,
            transfer_fee::TransferFeeConfig, transfer_hook, BaseStateWithExtensions, ExtensionType,
            StateWithExtensions,
        },
    },
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::error::VaultError;

/// SPL Memo v2. Token-2022 accepts it (or v1) as the instruction right
/// before a transfer into an account that requires memos.
pub const MEMO_PROGRAM_ID: Pubkey = pubkey!("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const PAYOUT_MEMO: &[u8] = b"noised-vault payout";

/// Reject mints a vault cannot protect.
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
pub fn require_supported_mint(mint: &InterfaceAccount<Mint>) -> Result<()> {
    let info = mint.to_account_info();
    if *info.owner != spl_token_2022::ID {
        return Ok(());
    }
    let data = info.try_borrow_data()?;
    let state = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&data)?;
    for extension in state.get_extension_types()? {
        match extension {
            ExtensionType::NonTransferable | ExtensionType::PermanentDelegate => {
                return err!(VaultError::UnsupportedMint)
            }
            ExtensionType::MintCloseAuthority => {
                let config = state.get_extension::<MintCloseAuthority>()?;
                require!(
                    Option::<Pubkey>::from(config.close_authority).is_none(),
                    VaultError::UnsupportedMint
                );
            }
            ExtensionType::TransferFeeConfig => {
                let config = state.get_extension::<TransferFeeConfig>()?;
                require!(
                    Option::<Pubkey>::from(config.transfer_fee_config_authority).is_none()
                        && Option::<Pubkey>::from(config.withdraw_withheld_authority).is_none(),
                    VaultError::UnsupportedMint
                );
            }
            _ => {}
        }
    }
    Ok(())
}

fn hook_program_id(mint: &InterfaceAccount<Mint>) -> Result<Option<Pubkey>> {
    let info = mint.to_account_info();
    if *info.owner != spl_token_2022::ID {
        return Ok(None);
    }
    let data = info.try_borrow_data()?;
    let state = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&data)?;
    Ok(transfer_hook::get_program_id(&state))
}

/// Require `ata` to be the canonical associated token account of `wallet`
/// for `mint` and create it if it does not exist. The token-account owner
/// field is deliberately not compared: only the ATA program can create an
/// account at this address, and only the wallet itself can reassign it, so
/// a reassigned ATA is where the wallet chose its funds to go.
pub fn ensure_canonical_ata<'info>(
    payer: &AccountInfo<'info>,
    wallet: &AccountInfo<'info>,
    ata: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
) -> Result<()> {
    let expected =
        get_associated_token_address_with_program_id(wallet.key, mint.key, token_program.key);
    require_keys_eq!(*ata.key, expected, VaultError::InvalidDestination);
    if ata.data_is_empty() {
        associated_token::create_idempotent(CpiContext::new(
            associated_token::ID,
            associated_token::Create {
                payer: payer.clone(),
                associated_token: ata.clone(),
                authority: wallet.clone(),
                mint: mint.clone(),
                system_program: system_program.clone(),
                token_program: token_program.clone(),
            },
        ))?;
    }
    require_keys_eq!(
        *ata.owner,
        *token_program.key,
        VaultError::InvalidDestination
    );
    let data = ata.try_borrow_data()?;
    let account = StateWithExtensions::<spl_token_2022::state::Account>::unpack(&data)
        .map_err(|_| error!(VaultError::InvalidDestination))?;
    require_keys_eq!(account.base.mint, *mint.key, VaultError::InvalidDestination);
    Ok(())
}

/// Whether a Token-2022 account requires a memo before incoming transfers.
pub fn requires_memo(account: &AccountInfo) -> Result<bool> {
    if *account.owner != spl_token_2022::ID {
        return Ok(false);
    }
    let data = account.try_borrow_data()?;
    let state = StateWithExtensions::<spl_token_2022::state::Account>::unpack(&data)?;
    Ok(state
        .get_extension::<MemoTransfer>()
        .map(|m| bool::from(m.require_incoming_transfer_memos))
        .unwrap_or(false))
}

/// A memo CPI, to be issued immediately before a transfer into an account
/// that requires memos (Token-2022 checks the previous sibling instruction).
pub fn memo<'info>(memo_program: &AccountInfo<'info>) -> Result<()> {
    let ix = Instruction {
        program_id: MEMO_PROGRAM_ID,
        accounts: vec![],
        data: PAYOUT_MEMO.to_vec(),
    };
    invoke(&ix, std::slice::from_ref(memo_program))?;
    Ok(())
}

/// `transfer_checked` signed by a vault PDA, resolving transfer-hook accounts
/// from `extra` when the mint has an active hook.
#[allow(clippy::too_many_arguments)]
pub fn transfer_signed<'info>(
    token_program: &Interface<'info, TokenInterface>,
    mint: &InterfaceAccount<'info, Mint>,
    from: &InterfaceAccount<'info, TokenAccount>,
    to: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    amount: u64,
    seeds: &[&[u8]],
    extra: &'info [AccountInfo<'info>],
) -> Result<()> {
    let mut ix = spl_token_2022::instruction::transfer_checked(
        token_program.key,
        &from.key(),
        &mint.key(),
        to.key,
        authority.key,
        &[],
        amount,
        mint.decimals,
    )?;
    let mut infos = vec![
        from.to_account_info(),
        mint.to_account_info(),
        to.clone(),
        authority.clone(),
    ];
    if let Some(hook_program_id) = hook_program_id(mint)? {
        spl_transfer_hook_interface::onchain::add_extra_accounts_for_execute_cpi(
            &mut ix,
            &mut infos,
            &hook_program_id,
            from.to_account_info(),
            mint.to_account_info(),
            to,
            authority,
            amount,
            extra,
        )?;
    }
    invoke_signed(&ix, &infos, &[seeds])?;
    Ok(())
}

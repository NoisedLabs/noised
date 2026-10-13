// The Anchor 1.2.1 source of `noised_vault` (the build deployed on devnet),
// kept verbatim as the reference the framework-free program in `../src`
// implements: the same ABI, and every account check of these
// `#[derive(Accounts)]` structs in the same order (the `[A]` comments of
// `../src/processor.rs`). Not compiled. The app's developer docs
// (`app/scripts/gen-docs-reference.mjs`) read the vault's instruction and
// account reference from it.
//! Noised PQ Vault: token vaults that only a post-quantum signature can open.
//!
//! A vault is a PDA that owns one associated token account for one mint and
//! holds one LM-OTS public key (RFC 8554, parameter set LMOTS_SHA256_N32_W4,
//! see `noised-lmots`). The only way to move tokens out is a signature by
//! that key over the exact withdrawal: vault, mint, sequence number,
//! recipient wallet, maximum amount and the next key. No Ed25519 key,
//! including the fee payer's, has any authority, so a quantum computer that
//! can forge Ed25519 signatures still cannot move funds. Mints that would let
//! an Ed25519 key take tokens anyway are refused at `open_vault`.
//!
//! LM-OTS keys are one-time, so every withdrawal rotates the key in place:
//! the vault address, its token account (the deposit address) and the
//! remaining balance never move. Only the key and the sequence change. Each
//! key is bound to its position by its LM-OTS index (`q = 0` opens the
//! vault, the key at sequence `s` has `q = s`), so no key can ever control a
//! vault twice. A vault therefore supports up to `u32::MAX` withdrawals.
//!
//! A revealed signature must always stay executable, or its owner would be
//! tempted to sign a second message with the same one-time key. So
//! `withdraw` touches nothing a third party controls: it verifies the
//! signature, rotates the key and reserves the amount in a `Payout` account.
//! Delivery is a separate step: `release` (anyone, to the recipient's
//! canonical associated token account) or `release_to` (signed by the
//! recipient, to any token account of the mint). A recipient can delay only
//! its own payout, never the withdrawal or the rest of the vault. Whether a
//! signature executes depends only on what was signed: a signer that names
//! the current key, or a key of another position, as the next key gets a
//! signature that never executes, so clients always name the key of
//! position `sequence + 1` and refuse to sign at sequence `u32::MAX`.
//!
//! Anyone can relay a signed withdrawal; a relayer cannot change anything
//! because everything is signed. A withdrawal carries a 2176-byte
//! signature, so clients send it in a v1 (4 KiB) transaction.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{Mint, TokenAccount, TokenInterface},
};

pub mod error;
pub mod message;
pub mod state;
pub mod token;

use error::VaultError;
use message::withdraw_message;
use state::{
    key_id, next_key_index, Payout, SolSha256, Vault, VaultKey, GENESIS_KEY_INDEX, PAYOUT_SEED,
    VAULT_SEED,
};
use token::MEMO_PROGRAM_ID;

declare_id!("7BQ6FQomidBkd5z7fQfwr9Zt87oahMvMV5dFnw6Dz7nb");

#[program]
pub mod noised_vault {
    use super::*;

    /// Create a vault for `mint` controlled by the LM-OTS public key `key`.
    ///
    /// The address commits to this first key, so nobody can open a vault at
    /// someone else's address with a different key. The first key has LM-OTS
    /// index `q = 0`: every key of a vault is bound to its position.
    pub fn open_vault(ctx: Context<OpenVault>, key_id_arg: [u8; 32], key: VaultKey) -> Result<()> {
        require!(key.q == GENESIS_KEY_INDEX, VaultError::InvalidKeyIndex);
        token::require_supported_mint(&ctx.accounts.mint)?;
        let vault = &mut ctx.accounts.vault;
        vault.init(ctx.bumps.vault, ctx.accounts.mint.key(), key_id_arg, &key);
        emit!(VaultOpened {
            vault: vault.key(),
            mint: vault.mint,
            key_id: key_id_arg,
        });
        Ok(())
    }

    /// Spend the current key: reserve up to `max_amount` for
    /// `destination_owner` and hand the vault to the next key, whose LM-OTS
    /// index must be the vault's `sequence + 1`.
    ///
    /// Reads no account the recipient or any other third party controls, so
    /// a valid signature that names the key of the next position always
    /// executes.
    pub fn withdraw(ctx: Context<Withdraw>, args: WithdrawArgs) -> Result<()> {
        let vault_key = ctx.accounts.vault.key();
        let mint_key = ctx.accounts.mint.key();
        let balance = ctx.accounts.vault_token_account.amount;
        let vault = &mut ctx.accounts.vault;

        require!(
            key_id(&args.next_key.public_key()) == args.next_key_id,
            VaultError::KeyIdMismatch
        );
        require!(args.next_key_id != vault.key_id, VaultError::InvalidNextKey);

        // Verify the post-quantum signature over the exact withdrawal.
        let sequence = vault.sequence;
        let msg = withdraw_message(
            &crate::ID,
            &vault_key,
            &mint_key,
            sequence,
            &args.destination_owner,
            args.max_amount,
            &args.next_key_id,
        );
        require!(
            noised_lmots::verify::<SolSha256>(&vault.public_key(), &msg, &args.signature),
            VaultError::InvalidSignature
        );
        // The next key's index must be its position, `sequence + 1`, so no
        // key that ever controlled this vault (each had a smaller index) can
        // be installed again. The signed `next_key_id` commits to the index,
        // so only a signer that named a key of another position sees this.
        require!(
            next_key_index(sequence) == Some(args.next_key.q),
            VaultError::InvalidKeyIndex
        );

        // Pay only from what earlier payouts have not set aside. Paying the
        // vault itself would move nothing, so it reserves nothing.
        let available = balance.saturating_sub(vault.reserved);
        let amount = if args.destination_owner == vault_key {
            0
        } else {
            args.max_amount.min(available)
        };
        vault.reserved = vault
            .reserved
            .checked_add(amount)
            .ok_or(VaultError::MathOverflow)?;
        vault.sequence = sequence.checked_add(1).ok_or(VaultError::MathOverflow)?;
        vault.set_key(args.next_key_id, &args.next_key);

        let payout = &mut ctx.accounts.payout;
        payout.version = Payout::VERSION;
        payout.bump = ctx.bumps.payout;
        payout.vault = vault_key;
        payout.sequence = sequence;
        payout.destination_owner = args.destination_owner;
        payout.amount = amount;
        payout.rent_payer = ctx.accounts.payer.key();

        emit!(VaultWithdrawn {
            vault: vault_key,
            mint: mint_key,
            sequence,
            destination_owner: args.destination_owner,
            amount,
            payout: payout.key(),
            next_key_id: args.next_key_id,
        });
        Ok(())
    }

    /// Deliver a payout to the recipient's canonical associated token
    /// account, creating it if needed. Permissionless.
    pub fn release<'info>(ctx: Context<'info, Release<'info>>) -> Result<()> {
        let a = &ctx.accounts;
        if a.payout.amount > 0 {
            token::ensure_canonical_ata(
                &a.payer.to_account_info(),
                &a.destination_owner.to_account_info(),
                &a.destination.to_account_info(),
                &a.mint.to_account_info(),
                &a.token_program.to_account_info(),
                &a.system_program.to_account_info(),
            )?;
        }
        let destination = a.destination.to_account_info();
        deliver(
            &mut ctx.accounts.vault,
            &ctx.accounts.payout,
            &ctx.accounts.mint,
            &ctx.accounts.vault_token_account,
            destination,
            &ctx.accounts.memo_program,
            &ctx.accounts.token_program,
            ctx.remaining_accounts,
        )
    }

    /// Deliver a payout to any token account of the mint, chosen and signed
    /// for by the recipient wallet. For recipients whose canonical account
    /// cannot receive (for example confidential-only accounts).
    pub fn release_to<'info>(ctx: Context<'info, ReleaseTo<'info>>) -> Result<()> {
        let destination = ctx.accounts.destination.to_account_info();
        deliver(
            &mut ctx.accounts.vault,
            &ctx.accounts.payout,
            &ctx.accounts.mint,
            &ctx.accounts.vault_token_account,
            destination,
            &ctx.accounts.memo_program,
            &ctx.accounts.token_program,
            ctx.remaining_accounts,
        )
    }
}

/// Move a payout's tokens out of the vault and release the reservation. The
/// payout account itself is closed by the `close` constraint.
#[allow(clippy::too_many_arguments)]
fn deliver<'info>(
    vault: &mut Account<'info, Vault>,
    payout: &Account<'info, Payout>,
    mint: &InterfaceAccount<'info, Mint>,
    vault_token_account: &InterfaceAccount<'info, TokenAccount>,
    destination: AccountInfo<'info>,
    memo_program: &UncheckedAccount<'info>,
    token_program: &Interface<'info, TokenInterface>,
    extra: &'info [AccountInfo<'info>],
) -> Result<()> {
    let amount = payout.amount;
    vault.reserved = vault
        .reserved
        .checked_sub(amount)
        .ok_or(VaultError::MathOverflow)?;
    if amount > 0 {
        if token::requires_memo(&destination)? {
            token::memo(&memo_program.to_account_info())?;
        }
        let mint_key = mint.key();
        let bump = [vault.bump];
        let genesis = vault.genesis_key_id;
        let seeds: &[&[u8]] = &[VAULT_SEED, mint_key.as_ref(), &genesis, &bump];
        token::transfer_signed(
            token_program,
            mint,
            vault_token_account,
            destination.clone(),
            vault.to_account_info(),
            amount,
            seeds,
            extra,
        )?;
    }
    emit!(PayoutReleased {
        vault: vault.key(),
        payout: payout.key(),
        sequence: payout.sequence,
        destination_owner: payout.destination_owner,
        destination: destination.key(),
        amount,
    });
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct WithdrawArgs {
    /// LM-OTS signature `C || y[0..67]` (2176 bytes).
    pub signature: Vec<u8>,
    /// The recipient wallet (never a token account).
    pub destination_owner: Pubkey,
    /// Upper bound on the payout; `min(max_amount, unreserved balance)` is reserved.
    pub max_amount: u64,
    /// key_id of the key that controls the vault after this withdrawal.
    pub next_key_id: [u8; 32],
    /// The next key; its index `q` must be the vault's `sequence + 1`.
    pub next_key: VaultKey,
}

#[derive(Accounts)]
#[instruction(key_id_arg: [u8; 32], key: VaultKey)]
pub struct OpenVault<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init,
        payer = payer,
        space = 8 + Vault::INIT_SPACE,
        seeds = [VAULT_SEED, mint.key().as_ref(), key_id_arg.as_ref()],
        bump,
        constraint = key_id(&key.public_key()) == key_id_arg @ VaultError::KeyIdMismatch,
    )]
    pub vault: Box<Account<'info, Vault>>,

    // init_if_needed: anyone can pre-create an ATA, which must not block opening.
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub vault_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    /// Pays the payout account's rent (refunded on release). Has no
    /// authority over the vault.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        seeds = [VAULT_SEED, mint.key().as_ref(), vault.genesis_key_id.as_ref()],
        bump = vault.bump,
        has_one = mint,
    )]
    pub vault: Box<Account<'info, Vault>>,

    /// Read only: the balance a withdrawal can reserve from.
    #[account(
        associated_token::mint = mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub vault_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    // Only this program can create an account at this address, and each
    // sequence number is used once, so the address can never be squatted.
    #[account(
        init,
        payer = payer,
        space = 8 + Payout::INIT_SPACE,
        seeds = [PAYOUT_SEED, vault.key().as_ref(), &vault.sequence.to_le_bytes()],
        bump,
    )]
    pub payout: Box<Account<'info, Payout>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Release<'info> {
    /// Anyone; pays for the recipient's associated token account if missing.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        seeds = [VAULT_SEED, mint.key().as_ref(), vault.genesis_key_id.as_ref()],
        bump = vault.bump,
        has_one = mint,
    )]
    pub vault: Box<Account<'info, Vault>>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub vault_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        close = rent_payer,
        seeds = [PAYOUT_SEED, vault.key().as_ref(), &payout.sequence.to_le_bytes()],
        bump = payout.bump,
        has_one = vault,
        has_one = rent_payer,
        has_one = destination_owner,
    )]
    pub payout: Box<Account<'info, Payout>>,

    /// CHECK: receives the payout account's rent; bound by `has_one`.
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,

    /// CHECK: the wallet the signed message names; bound by `has_one`.
    pub destination_owner: UncheckedAccount<'info>,

    /// CHECK: the canonical associated token account of `destination_owner`;
    /// checked (and created if missing) in the handler. Ignored when the
    /// payout is zero.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,

    /// CHECK: SPL Memo, called before the transfer when the destination
    /// requires memos.
    #[account(address = MEMO_PROGRAM_ID)]
    pub memo_program: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReleaseTo<'info> {
    /// The recipient wallet named in the signed message.
    pub destination_owner: Signer<'info>,

    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        seeds = [VAULT_SEED, mint.key().as_ref(), vault.genesis_key_id.as_ref()],
        bump = vault.bump,
        has_one = mint,
    )]
    pub vault: Box<Account<'info, Vault>>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub vault_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        close = rent_payer,
        seeds = [PAYOUT_SEED, vault.key().as_ref(), &payout.sequence.to_le_bytes()],
        bump = payout.bump,
        has_one = vault,
        has_one = rent_payer,
        has_one = destination_owner,
    )]
    pub payout: Box<Account<'info, Payout>>,

    /// CHECK: receives the payout account's rent; bound by `has_one`.
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,

    /// Any token account of the mint; the recipient chose it by signing.
    #[account(
        mut,
        token::mint = mint,
        token::token_program = token_program,
    )]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: SPL Memo, called before the transfer when the destination
    /// requires memos.
    #[account(address = MEMO_PROGRAM_ID)]
    pub memo_program: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[event]
pub struct VaultOpened {
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub key_id: [u8; 32],
}

#[event]
pub struct VaultWithdrawn {
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub sequence: u64,
    pub destination_owner: Pubkey,
    pub amount: u64,
    pub payout: Pubkey,
    pub next_key_id: [u8; 32],
}

#[event]
pub struct PayoutReleased {
    pub vault: Pubkey,
    pub payout: Pubkey,
    pub sequence: u64,
    pub destination_owner: Pubkey,
    pub destination: Pubkey,
    pub amount: u64,
}

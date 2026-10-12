//! Noised Shield: opt-in confidential balances for any supported token.
//!
//! `wrap` locks base tokens in an escrow and mints the same number of
//! "zTokens": a Token-2022 mint with Confidential Balances
//! (`ConfidentialTransferMint`), on which holders can hide balances and
//! transfer amounts with plain Token-2022 instructions. `unwrap` burns
//! zTokens and releases the same number of base tokens. AMMs cannot trade
//! confidential mints, so privacy is a separate, reversible layer next to the
//! tradeable token.
//!
//! Nobody controls a shield: creation is permissionless and once per base
//! mint, the zToken has no freeze authority, no confidential-transfer
//! authority, no auditor and immutable metadata, and its mint authority is a
//! PDA that only `wrap` uses, minting exactly what the escrow measurably
//! received. Every instruction ends by requiring the escrow to hold at least
//! the zToken supply (see [`token::require_backed`]).
//!
//! What it does not do: it hides amounts, not who transacts with whom;
//! ElGamal/Ristretto encryption is not post-quantum (recorded ciphertexts
//! could be decrypted by a future quantum computer); Token-2022 is
//! upgradeable by a multisig and the ZK ElGamal proof program has a
//! feature-gate kill switch (used in 2025). A base mint's own authorities
//! keep their powers (freeze, transfer-fee changes, transfer-hook upgrades).

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::{spl_token_2022, Token2022},
    token_interface::{self, BurnChecked, Mint, MintToChecked, TokenAccount, TokenInterface},
};

pub mod error;
pub mod metadata;
pub mod policy;
pub mod state;
pub mod token;
pub mod zmint;

use error::ShieldError;
use policy::Rejection;
use state::{Shield, SHIELD_AUTHORITY_SEED, SHIELD_SEED, Z_MINT_SEED};

declare_id!("BUMHJyoS6JCz4pZDfryzXbFDorXb9nmGkj3ziR71z8E9");

#[program]
pub mod noised_shield {
    use super::*;

    /// Create the shield, zToken mint and escrow for `base_mint`.
    /// Permissionless; fails if a shield for this base mint already exists.
    pub fn create_shield(ctx: Context<CreateShield>) -> Result<()> {
        let accounts = &mut *ctx.accounts;
        let base_mint = accounts.base_mint.key();

        // SPL Token mints have no extensions and no embedded metadata.
        let meta = {
            let info = accounts.base_mint.to_account_info();
            if *info.owner == spl_token_2022::ID {
                let data = info.try_borrow_data()?;
                policy::inspect_token_2022_mint(&data, &base_mint).map_err(reject)?
            } else {
                metadata::derive(None, &base_mint)
            }
        };

        let decimals = accounts.base_mint.decimals;
        let authority_bump = [ctx.bumps.shield_authority];
        let authority_seeds: &[&[u8]] =
            &[SHIELD_AUTHORITY_SEED, base_mint.as_ref(), &authority_bump];
        let z_mint_bump = [ctx.bumps.z_mint];
        let z_mint_seeds: &[&[u8]] = &[Z_MINT_SEED, base_mint.as_ref(), &z_mint_bump];
        let z_accounts = zmint::ZMintAccounts {
            payer: accounts.payer.as_ref(),
            z_mint: accounts.z_mint.as_ref(),
            shield_authority: accounts.shield_authority.as_ref(),
            system_program: accounts.system_program.as_ref(),
        };
        zmint::create(&z_accounts, decimals, &meta, z_mint_seeds, authority_seeds)?;
        zmint::verify(
            accounts.z_mint.as_ref(),
            &accounts.shield_authority.key(),
            decimals,
            &meta,
        )?;

        // `verify` proved the supply is 0. A pre-existing escrow (anyone can
        // create an ATA) may already hold donated tokens: allowed surplus.
        accounts.escrow.reload()?;
        token::require_backed(accounts.escrow.amount, 0)?;

        let shield = &mut accounts.shield;
        shield.version = Shield::VERSION;
        shield.bump = ctx.bumps.shield;
        shield.authority_bump = ctx.bumps.shield_authority;
        shield.z_mint_bump = ctx.bumps.z_mint;
        shield.decimals = decimals;
        shield.base_mint = base_mint;
        shield.base_token_program = accounts.base_token_program.key();
        shield.z_mint = accounts.z_mint.key();
        shield.escrow = accounts.escrow.key();
        shield.created_at = Clock::get()?.unix_timestamp;

        emit!(ShieldCreated {
            shield: shield.key(),
            base_mint,
            base_token_program: shield.base_token_program,
            z_mint: shield.z_mint,
            escrow: shield.escrow,
            decimals,
            name: meta.name,
            symbol: meta.symbol,
            uri: meta.uri,
            payer: accounts.payer.key(),
        });
        Ok(())
    }

    /// Lock `amount` base tokens in the escrow and mint zTokens equal to what
    /// the escrow actually received (less than `amount` under a transfer
    /// fee). Transfer-hook accounts of the base mint go in remaining accounts.
    pub fn wrap<'info>(ctx: Context<'info, Wrap<'info>>, amount: u64) -> Result<()> {
        require!(amount > 0, ShieldError::ZeroAmount);
        let accounts = &mut *ctx.accounts;
        let escrow_before = accounts.escrow.amount;
        let supply_before = accounts.z_mint.supply;

        token::transfer_checked(
            accounts.base_token_program.as_ref(),
            &accounts.base_mint,
            accounts.user_base.to_account_info(),
            accounts.escrow.to_account_info(),
            accounts.user.to_account_info(),
            amount,
            &[],
            ctx.remaining_accounts,
        )?;
        accounts.escrow.reload()?;
        let received = accounts
            .escrow
            .amount
            .checked_sub(escrow_before)
            .ok_or(ShieldError::AccountingMismatch)?;
        require!(received > 0, ShieldError::NothingReceived);

        let base_mint = accounts.base_mint.key();
        let bump = [accounts.shield.authority_bump];
        let seeds: &[&[u8]] = &[SHIELD_AUTHORITY_SEED, base_mint.as_ref(), &bump];
        token_interface::mint_to_checked(
            CpiContext::new_with_signer(
                spl_token_2022::ID,
                MintToChecked {
                    mint: accounts.z_mint.to_account_info(),
                    to: accounts.user_z.to_account_info(),
                    authority: accounts.shield_authority.to_account_info(),
                },
                &[seeds],
            ),
            received,
            accounts.z_mint.decimals,
        )?;
        accounts.z_mint.reload()?;
        let minted = accounts
            .z_mint
            .supply
            .checked_sub(supply_before)
            .ok_or(ShieldError::AccountingMismatch)?;
        require!(minted == received, ShieldError::AccountingMismatch);
        token::require_backed(accounts.escrow.amount, accounts.z_mint.supply)?;

        emit!(Wrapped {
            shield: accounts.shield.key(),
            base_mint,
            user: accounts.user.key(),
            amount,
            minted,
            z_supply: accounts.z_mint.supply,
            escrow_balance: accounts.escrow.amount,
        });
        Ok(())
    }

    /// Burn `amount` zTokens from the user's (public) zToken balance and
    /// release `amount` base tokens from the escrow. A base-mint transfer fee
    /// is charged to the unwrapper. Transfer-hook accounts of the base mint
    /// go in remaining accounts.
    pub fn unwrap<'info>(ctx: Context<'info, Unwrap<'info>>, amount: u64) -> Result<()> {
        require!(amount > 0, ShieldError::ZeroAmount);
        let accounts = &mut *ctx.accounts;
        let escrow_before = accounts.escrow.amount;
        let supply_before = accounts.z_mint.supply;

        token_interface::burn_checked(
            CpiContext::new(
                spl_token_2022::ID,
                BurnChecked {
                    mint: accounts.z_mint.to_account_info(),
                    from: accounts.user_z.to_account_info(),
                    authority: accounts.user.to_account_info(),
                },
            ),
            amount,
            accounts.z_mint.decimals,
        )?;

        let base_mint = accounts.base_mint.key();
        let bump = [accounts.shield.authority_bump];
        let seeds: &[&[u8]] = &[SHIELD_AUTHORITY_SEED, base_mint.as_ref(), &bump];
        token::transfer_checked(
            accounts.base_token_program.as_ref(),
            &accounts.base_mint,
            accounts.escrow.to_account_info(),
            accounts.user_base.to_account_info(),
            accounts.shield_authority.to_account_info(),
            amount,
            &[seeds],
            ctx.remaining_accounts,
        )?;

        accounts.escrow.reload()?;
        accounts.z_mint.reload()?;
        let burned = supply_before
            .checked_sub(accounts.z_mint.supply)
            .ok_or(ShieldError::AccountingMismatch)?;
        let released = escrow_before
            .checked_sub(accounts.escrow.amount)
            .ok_or(ShieldError::AccountingMismatch)?;
        require!(
            burned == amount && released == amount,
            ShieldError::AccountingMismatch
        );
        token::require_backed(accounts.escrow.amount, accounts.z_mint.supply)?;

        emit!(Unwrapped {
            shield: accounts.shield.key(),
            base_mint,
            user: accounts.user.key(),
            amount,
            z_supply: accounts.z_mint.supply,
            escrow_balance: accounts.escrow.amount,
        });
        Ok(())
    }
}

fn reject(r: Rejection) -> Error {
    match r {
        Rejection::Malformed => error!(ShieldError::MalformedBaseMint),
        Rejection::Unsupported(ext) => {
            msg!("Base mint extension not accepted: {:?}", ext);
            error!(ShieldError::UnsupportedExtension)
        }
        Rejection::Unknown => {
            msg!("Base mint has an extension type this program does not know");
            error!(ShieldError::UnsupportedExtension)
        }
    }
}

#[derive(Accounts)]
pub struct CreateShield<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mint::token_program = base_token_program)]
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init,
        payer = payer,
        space = 8 + Shield::INIT_SPACE,
        seeds = [SHIELD_SEED, base_mint.key().as_ref()],
        bump,
    )]
    pub shield: Box<Account<'info, Shield>>,

    /// CHECK: data-less PDA; signs as zToken mint authority and escrow owner.
    #[account(seeds = [SHIELD_AUTHORITY_SEED, base_mint.key().as_ref()], bump)]
    pub shield_authority: UncheckedAccount<'info>,

    /// CHECK: PDA, created and initialized as the zToken mint in the handler
    /// and verified afterwards (`zmint::verify`).
    #[account(mut, seeds = [Z_MINT_SEED, base_mint.key().as_ref()], bump)]
    pub z_mint: UncheckedAccount<'info>,

    // init_if_needed: anyone can create this ATA first, which must not block
    // the shield. Anchor still checks mint, owner and token program.
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = base_mint,
        associated_token::authority = shield_authority,
        associated_token::token_program = base_token_program,
    )]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    pub base_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Wrap<'info> {
    /// Owner (or delegate) of `user_base`.
    pub user: Signer<'info>,

    #[account(
        seeds = [SHIELD_SEED, base_mint.key().as_ref()],
        bump = shield.bump,
        has_one = base_mint,
        has_one = base_token_program,
        has_one = z_mint,
        has_one = escrow,
    )]
    pub shield: Box<Account<'info, Shield>>,

    /// CHECK: PDA signer for the zToken mint.
    #[account(
        seeds = [SHIELD_AUTHORITY_SEED, base_mint.key().as_ref()],
        bump = shield.authority_bump,
    )]
    pub shield_authority: UncheckedAccount<'info>,

    #[account(mint::token_program = base_token_program)]
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut, mint::token_program = token_2022_program)]
    pub z_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        token::mint = base_mint,
        token::authority = shield_authority,
        token::token_program = base_token_program,
    )]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Base tokens come from here.
    #[account(
        mut,
        token::mint = base_mint,
        token::token_program = base_token_program,
        constraint = user_base.key() != escrow.key() @ ShieldError::SameAccount,
    )]
    pub user_base: Box<InterfaceAccount<'info, TokenAccount>>,

    /// zTokens go here (any zToken account).
    #[account(mut, token::mint = z_mint, token::token_program = token_2022_program)]
    pub user_z: Box<InterfaceAccount<'info, TokenAccount>>,

    pub base_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
pub struct Unwrap<'info> {
    /// Owner (or delegate) of `user_z`.
    pub user: Signer<'info>,

    #[account(
        seeds = [SHIELD_SEED, base_mint.key().as_ref()],
        bump = shield.bump,
        has_one = base_mint,
        has_one = base_token_program,
        has_one = z_mint,
        has_one = escrow,
    )]
    pub shield: Box<Account<'info, Shield>>,

    /// CHECK: PDA signer for the escrow.
    #[account(
        seeds = [SHIELD_AUTHORITY_SEED, base_mint.key().as_ref()],
        bump = shield.authority_bump,
    )]
    pub shield_authority: UncheckedAccount<'info>,

    #[account(mint::token_program = base_token_program)]
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut, mint::token_program = token_2022_program)]
    pub z_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        token::mint = base_mint,
        token::authority = shield_authority,
        token::token_program = base_token_program,
    )]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Base tokens go here (any base token account).
    #[account(
        mut,
        token::mint = base_mint,
        token::token_program = base_token_program,
        constraint = user_base.key() != escrow.key() @ ShieldError::SameAccount,
    )]
    pub user_base: Box<InterfaceAccount<'info, TokenAccount>>,

    /// zTokens are burned from here.
    #[account(mut, token::mint = z_mint, token::token_program = token_2022_program)]
    pub user_z: Box<InterfaceAccount<'info, TokenAccount>>,

    pub base_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
}

#[event]
pub struct ShieldCreated {
    pub shield: Pubkey,
    pub base_mint: Pubkey,
    pub base_token_program: Pubkey,
    pub z_mint: Pubkey,
    pub escrow: Pubkey,
    pub decimals: u8,
    pub name: String,
    pub symbol: String,
    pub uri: String,
    pub payer: Pubkey,
}

#[event]
pub struct Wrapped {
    pub shield: Pubkey,
    pub base_mint: Pubkey,
    pub user: Pubkey,
    /// Base tokens sent by the user.
    pub amount: u64,
    /// zTokens minted: what the escrow received.
    pub minted: u64,
    pub z_supply: u64,
    pub escrow_balance: u64,
}

#[event]
pub struct Unwrapped {
    pub shield: Pubkey,
    pub base_mint: Pubkey,
    pub user: Pubkey,
    /// zTokens burned and base tokens released (before any base transfer fee).
    pub amount: u64,
    pub z_supply: u64,
    pub escrow_balance: u64,
}

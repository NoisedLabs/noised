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
//!
//! # No framework
//!
//! The program is written on `pinocchio` and `noised-onchain` (the shared
//! Anchor-compatible building blocks: account checks, errors, Token-2022
//! parsing, CPIs); no Anchor code is linked into it. Its ABI is the one the
//! Anchor 1.2.1 build had, byte for byte: the same instruction
//! discriminators (`sha256("global:<name>")[..8]`), account order and
//! signer/writable flags, Borsh argument layouts, account discriminator
//! (`sha256("account:Shield")[..8]`) and field layout, PDA seeds, events
//! (`sha256("event:<Name>")[..8]` + Borsh, through `sol_log_data`) and error
//! numbers, the framework's included (`ConstraintSeeds` 2006, ...).
//! [`processor`] lists, per instruction, every account constraint the
//! Anchor build enforced and checks them in the Anchor order. The Anchor
//! source it implements is kept, not compiled, in `anchor/`; the
//! hand-maintained `idls/noised_shield.json` describes the ABI.
//!
//! Off-chain (`not(target_os = "solana")`), the crate keeps the Anchor
//! client API its users have: [`accounts`], [`instruction`], the Anchor
//! account traits on [`state::Shield`] and the Anchor events. That code is
//! host-only and never part of the program binary.

extern crate alloc;

#[cfg(not(target_os = "solana"))]
use anchor_lang::{AnchorDeserialize, AnchorSerialize, Discriminator};

#[cfg(not(target_os = "solana"))]
mod client;
pub mod error;
pub mod metadata;
pub mod policy;
pub mod processor;
pub mod state;
pub mod token;
pub mod zmint;

#[cfg(not(target_os = "solana"))]
pub use client::{accounts, instruction};

#[cfg(not(feature = "no-entrypoint"))]
noised_onchain::entrypoint!(crate::processor::process_instruction);

/// An account address (`solana_address::Address`, which Anchor's `Pubkey`
/// also is).
pub type Pubkey = pinocchio::Address;

/// `BUMHJyoS6JCz4pZDfryzXbFDorXb9nmGkj3ziR71z8E9`.
pub const ID: Pubkey = Pubkey::new_from_array([
    155, 150, 123, 175, 50, 212, 99, 79, 207, 208, 232, 168, 91, 92, 179, 112, 147, 13, 32, 207,
    105, 103, 133, 61, 1, 154, 76, 132, 6, 12, 85, 30,
]);

/// The program id.
pub const fn id() -> Pubkey {
    ID
}

/// Whether `id` is the program id.
pub fn check_id(id: &Pubkey) -> bool {
    *id == ID
}

/// The program type (`Id` off-chain, as `#[program]` generated it), and the
/// [`noised_onchain::Program`] the account checks and errors are generic
/// over.
pub mod program {
    /// The shield program.
    #[derive(Clone)]
    pub struct NoisedShield;

    impl noised_onchain::Program for NoisedShield {
        const ID: crate::Pubkey = crate::ID;
        const ERRORS: noised_onchain::ErrorTable = crate::error::ERRORS;
    }

    #[cfg(not(target_os = "solana"))]
    impl anchor_lang::Id for NoisedShield {
        fn id() -> crate::Pubkey {
            crate::ID
        }
    }
}

/// Instruction discriminators: `sha256("global:<snake_case name>")[..8]`.
pub mod discriminator {
    pub const CREATE_SHIELD: [u8; 8] = [47, 38, 125, 62, 228, 1, 164, 116];
    pub const WRAP: [u8; 8] = [178, 40, 10, 189, 228, 129, 186, 140];
    pub const UNWRAP: [u8; 8] = [126, 175, 198, 14, 212, 69, 50, 44];
    /// `sha256("account:Shield")[..8]`.
    pub const SHIELD: [u8; 8] = [122, 210, 171, 132, 124, 235, 186, 248];
    /// `sha256("event:ShieldCreated")[..8]`.
    pub const SHIELD_CREATED: [u8; 8] = [233, 222, 75, 70, 102, 75, 65, 67];
    /// `sha256("event:Wrapped")[..8]`.
    pub const WRAPPED: [u8; 8] = [11, 127, 145, 31, 206, 134, 73, 130];
    /// `sha256("event:Unwrapped")[..8]`.
    pub const UNWRAPPED: [u8; 8] = [25, 86, 93, 80, 145, 113, 86, 93];
    /// Anchor's `EVENT_IX_TAG` (`0x1d9acb512ea545e4`, little-endian): the
    /// event-CPI instruction tag, which this program (like the Anchor build,
    /// compiled without `event-cpi`) refuses with `EventInstructionStub`.
    pub const EVENT_IX_TAG_LE: [u8; 8] = noised_onchain::event::EVENT_IX_TAG_LE;
}

/// Emitted by `create_shield`.
#[cfg_attr(not(target_os = "solana"), anchor_lang::event)]
#[derive(Debug, PartialEq, Eq)]
pub struct ShieldCreated {
    pub shield: Pubkey,
    pub base_mint: Pubkey,
    pub base_token_program: Pubkey,
    pub z_mint: Pubkey,
    pub escrow: Pubkey,
    pub decimals: u8,
    pub name: alloc::string::String,
    pub symbol: alloc::string::String,
    pub uri: alloc::string::String,
    pub payer: Pubkey,
}

/// Emitted by `wrap`.
#[cfg_attr(not(target_os = "solana"), anchor_lang::event)]
#[derive(Debug, PartialEq, Eq)]
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

/// Emitted by `unwrap`.
#[cfg_attr(not(target_os = "solana"), anchor_lang::event)]
#[derive(Debug, PartialEq, Eq)]
pub struct Unwrapped {
    pub shield: Pubkey,
    pub base_mint: Pubkey,
    pub user: Pubkey,
    /// zTokens burned and base tokens released (before any base transfer fee).
    pub amount: u64,
    pub z_supply: u64,
    pub escrow_balance: u64,
}

/// Bytes written into a fixed buffer (instruction data and event payloads
/// whose length depends on the metadata strings).
#[derive(Clone, Copy)]
pub struct Buf<const N: usize> {
    data: [u8; N],
    len: usize,
}

impl<const N: usize> Default for Buf<N> {
    fn default() -> Self {
        Self::new()
    }
}

/// [`Buf::put_all`], once for every `N`: the new length.
#[inline(never)]
fn put_into(data: &mut [u8], mut len: usize, parts: &[&[u8]]) -> usize {
    for part in parts {
        if let Some(dst) = data.get_mut(len..len + part.len()) {
            dst.copy_from_slice(part);
            len += part.len();
        }
    }
    len
}

impl<const N: usize> Buf<N> {
    pub const fn new() -> Self {
        Self {
            data: [0; N],
            len: 0,
        }
    }

    /// Appends `bytes` (callers size `N` for the longest content; anything
    /// that would not fit is dropped, which the tests rule out).
    pub fn put(&mut self, bytes: &[u8]) -> &mut Self {
        self.put_all(&[bytes])
    }

    /// Appends each of `parts`, as [`Buf::put`].
    pub fn put_all(&mut self, parts: &[&[u8]]) -> &mut Self {
        self.len = put_into(&mut self.data, self.len, parts);
        self
    }

    pub fn as_slice(&self) -> &[u8] {
        self.data.get(..self.len).unwrap_or(&[])
    }
}

/// The `sol_log_data` payloads of the events: discriminator, then the fields
/// in Borsh (pubkeys raw, integers little-endian, strings with a `u32`
/// length).
pub mod event_data {
    use super::{discriminator, Buf, Pubkey, ShieldCreated, Unwrapped, Wrapped};
    use crate::metadata::{MAX_NAME_LEN, MAX_SYMBOL_LEN, MAX_URI_LEN};

    /// `ShieldCreated` with the longest name, symbol and uri.
    pub const SHIELD_CREATED_MAX_LEN: usize =
        8 + 32 * 5 + 1 + 4 + MAX_NAME_LEN + 4 + MAX_SYMBOL_LEN + 4 + MAX_URI_LEN + 32;
    pub const WRAPPED_LEN: usize = 8 + 32 * 3 + 8 * 4;
    pub const UNWRAPPED_LEN: usize = 8 + 32 * 3 + 8 * 3;

    /// `ShieldCreated { shield, base_mint, base_token_program, z_mint,
    /// escrow, decimals, name, symbol, uri, payer }`.
    #[allow(clippy::too_many_arguments)]
    pub fn shield_created(
        shield: &Pubkey,
        base_mint: &Pubkey,
        base_token_program: &Pubkey,
        z_mint: &Pubkey,
        escrow: &Pubkey,
        decimals: u8,
        name: &[u8],
        symbol: &[u8],
        uri: &[u8],
        payer: &Pubkey,
    ) -> Buf<SHIELD_CREATED_MAX_LEN> {
        let lengths = [name.len(), symbol.len(), uri.len()].map(|n| (n as u32).to_le_bytes());
        let mut d = Buf::new();
        d.put_all(&[
            &discriminator::SHIELD_CREATED,
            shield.as_ref(),
            base_mint.as_ref(),
            base_token_program.as_ref(),
            z_mint.as_ref(),
            escrow.as_ref(),
            &[decimals],
            &lengths[0],
            name,
            &lengths[1],
            symbol,
            &lengths[2],
            uri,
            payer.as_ref(),
        ]);
        d
    }

    /// `Wrapped` / `Unwrapped`: the discriminator, shield, base_mint and
    /// user, then `values` (the `u64` fields in order).
    #[inline(never)]
    pub fn exchange(
        discriminator: &[u8; 8],
        shield: &Pubkey,
        base_mint: &Pubkey,
        user: &Pubkey,
        values: &[u64],
    ) -> Buf<WRAPPED_LEN> {
        let mut d = Buf::new();
        d.put_all(&[
            discriminator,
            shield.as_ref(),
            base_mint.as_ref(),
            user.as_ref(),
        ]);
        for value in values {
            d.put(&value.to_le_bytes());
        }
        d
    }

    /// `Wrapped { shield, base_mint, user, amount, minted, z_supply,
    /// escrow_balance }`.
    #[allow(clippy::too_many_arguments)]
    pub fn wrapped(
        shield: &Pubkey,
        base_mint: &Pubkey,
        user: &Pubkey,
        amount: u64,
        minted: u64,
        z_supply: u64,
        escrow_balance: u64,
    ) -> Buf<WRAPPED_LEN> {
        exchange(
            &discriminator::WRAPPED,
            shield,
            base_mint,
            user,
            &[amount, minted, z_supply, escrow_balance],
        )
    }

    /// `Unwrapped { shield, base_mint, user, amount, z_supply,
    /// escrow_balance }`.
    pub fn unwrapped(
        shield: &Pubkey,
        base_mint: &Pubkey,
        user: &Pubkey,
        amount: u64,
        z_supply: u64,
        escrow_balance: u64,
    ) -> Buf<WRAPPED_LEN> {
        exchange(
            &discriminator::UNWRAPPED,
            shield,
            base_mint,
            user,
            &[amount, z_supply, escrow_balance],
        )
    }

    impl ShieldCreated {
        /// The `sol_log_data` payload (Anchor's `Event::data`).
        pub fn log_data(&self) -> alloc::vec::Vec<u8> {
            shield_created(
                &self.shield,
                &self.base_mint,
                &self.base_token_program,
                &self.z_mint,
                &self.escrow,
                self.decimals,
                self.name.as_bytes(),
                self.symbol.as_bytes(),
                self.uri.as_bytes(),
                &self.payer,
            )
            .as_slice()
            .to_vec()
        }
    }

    impl Wrapped {
        /// The `sol_log_data` payload (Anchor's `Event::data`).
        pub fn log_data(&self) -> Buf<WRAPPED_LEN> {
            wrapped(
                &self.shield,
                &self.base_mint,
                &self.user,
                self.amount,
                self.minted,
                self.z_supply,
                self.escrow_balance,
            )
        }
    }

    impl Unwrapped {
        /// The `sol_log_data` payload (Anchor's `Event::data`).
        pub fn log_data(&self) -> Buf<WRAPPED_LEN> {
            unwrapped(
                &self.shield,
                &self.base_mint,
                &self.user,
                self.amount,
                self.z_supply,
                self.escrow_balance,
            )
        }
    }
}

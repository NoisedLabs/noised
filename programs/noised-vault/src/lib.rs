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
//!
//! # No framework
//!
//! The program is written on `pinocchio` alone (entrypoint, account views,
//! CPI, syscalls); no Anchor code is linked into it. Its ABI is the one the
//! Anchor 1.2.1 build had, byte for byte: the same instruction
//! discriminators (`sha256("global:<name>")[..8]`), account order and
//! signer/writable flags, Borsh argument layouts, account discriminators
//! (`sha256("account:<Name>")[..8]`) and field layouts, PDA seeds, events
//! (`sha256("event:<Name>")[..8]` + Borsh, through `sol_log_data`) and error
//! numbers, the framework's included (`ConstraintSeeds` 2006, ...).
//! [`processor`] lists, per instruction, every account constraint the
//! Anchor build enforced and checks them in the Anchor order. The
//! hand-maintained `idls/noised_vault.json` describes the ABI.
//!
//! Off-chain (`not(target_os = "solana")`), the crate keeps the Anchor
//! client API its users have: [`accounts`], [`instruction`], and the Anchor
//! account traits on [`state::Vault`] and [`state::Payout`]. That code is
//! host-only and never part of the program binary.

extern crate alloc;

#[cfg(not(target_os = "solana"))]
use anchor_lang::{AnchorDeserialize, AnchorSerialize, Discriminator};

#[cfg(not(target_os = "solana"))]
mod client;
#[cfg(not(feature = "no-entrypoint"))]
mod entrypoint;
pub mod error;
#[doc(hidden)]
pub mod hook;
pub mod message;
pub mod processor;
pub mod state;
#[doc(hidden)]
pub mod sys;
#[doc(hidden)]
pub mod token;

#[cfg(not(target_os = "solana"))]
pub use client::{accounts, instruction, program};

/// An account address (`solana_address::Address`, which Anchor's `Pubkey`
/// also is).
pub type Pubkey = pinocchio::Address;

/// `7BQ6FQomidBkd5z7fQfwr9Zt87oahMvMV5dFnw6Dz7nb`.
pub const ID: Pubkey = Pubkey::new_from_array([
    91, 208, 9, 196, 48, 57, 200, 36, 155, 174, 112, 27, 169, 36, 26, 59, 189, 19, 20, 129, 48, 61,
    18, 50, 64, 23, 160, 254, 107, 106, 132, 244,
]);

/// The program id.
pub const fn id() -> Pubkey {
    ID
}

/// Whether `id` is the program id.
pub fn check_id(id: &Pubkey) -> bool {
    *id == ID
}

/// Address equality, out of line: a 32-byte compare is a dozen
/// instructions every time it is inlined.
#[inline(never)]
pub(crate) fn same(a: &Pubkey, b: &Pubkey) -> bool {
    a == b
}

/// Instruction discriminators: `sha256("global:<snake_case name>")[..8]`.
pub mod discriminator {
    pub const OPEN_VAULT: [u8; 8] = [181, 248, 228, 67, 6, 175, 37, 167];
    pub const WITHDRAW: [u8; 8] = [183, 18, 70, 156, 148, 109, 161, 34];
    pub const RELEASE: [u8; 8] = [253, 249, 15, 206, 28, 127, 193, 241];
    pub const RELEASE_TO: [u8; 8] = [89, 11, 150, 168, 140, 201, 56, 132];
    /// `sha256("account:Vault")[..8]`.
    pub const VAULT: [u8; 8] = [211, 8, 232, 43, 2, 152, 117, 119];
    /// `sha256("account:Payout")[..8]`.
    pub const PAYOUT: [u8; 8] = [69, 45, 245, 131, 218, 101, 158, 228];
    /// `sha256("event:VaultOpened")[..8]`.
    pub const VAULT_OPENED: [u8; 8] = [198, 250, 195, 25, 26, 107, 197, 16];
    /// `sha256("event:VaultWithdrawn")[..8]`.
    pub const VAULT_WITHDRAWN: [u8; 8] = [238, 9, 219, 172, 188, 77, 72, 104];
    /// `sha256("event:PayoutReleased")[..8]`.
    pub const PAYOUT_RELEASED: [u8; 8] = [245, 195, 37, 2, 200, 70, 126, 210];
    /// Anchor's `EVENT_IX_TAG` (`0x1d9acb512ea545e4`, little-endian): the
    /// event-CPI instruction tag, which this program (like the Anchor build,
    /// compiled without `event-cpi`) refuses with `EventInstructionStub`.
    pub const EVENT_IX_TAG_LE: [u8; 8] = [228, 69, 165, 46, 81, 203, 154, 29];
}

/// `withdraw`'s argument (Borsh, after the discriminator).
#[cfg_attr(not(target_os = "solana"), derive(AnchorSerialize, AnchorDeserialize))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WithdrawArgs {
    /// LM-OTS signature `C || y[0..67]` (2176 bytes).
    pub signature: alloc::vec::Vec<u8>,
    /// The recipient wallet (never a token account).
    pub destination_owner: Pubkey,
    /// Upper bound on the payout; `min(max_amount, unreserved balance)` is reserved.
    pub max_amount: u64,
    /// key_id of the key that controls the vault after this withdrawal.
    pub next_key_id: [u8; 32],
    /// The next key; its index `q` must be the vault's `sequence + 1`.
    pub next_key: state::VaultKey,
}

/// Emitted by `open_vault`.
#[cfg_attr(not(target_os = "solana"), anchor_lang::event)]
#[derive(Debug, PartialEq, Eq)]
pub struct VaultOpened {
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub key_id: [u8; 32],
}

/// Emitted by `withdraw`.
#[cfg_attr(not(target_os = "solana"), anchor_lang::event)]
#[derive(Debug, PartialEq, Eq)]
pub struct VaultWithdrawn {
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub sequence: u64,
    pub destination_owner: Pubkey,
    pub amount: u64,
    pub payout: Pubkey,
    pub next_key_id: [u8; 32],
}

/// Emitted by `release` and `release_to`.
#[cfg_attr(not(target_os = "solana"), anchor_lang::event)]
#[derive(Debug, PartialEq, Eq)]
pub struct PayoutReleased {
    pub vault: Pubkey,
    pub payout: Pubkey,
    pub sequence: u64,
    pub destination_owner: Pubkey,
    pub destination: Pubkey,
    pub amount: u64,
}

/// The `sol_log_data` payloads of the events: discriminator, then the fields
/// in Borsh (pubkeys and byte arrays raw, integers little-endian).
pub mod event_data {
    use super::{discriminator, PayoutReleased, Pubkey, VaultOpened, VaultWithdrawn};

    pub const VAULT_OPENED_LEN: usize = 8 + 32 + 32 + 32;
    pub const VAULT_WITHDRAWN_LEN: usize = 8 + 32 + 32 + 8 + 32 + 8 + 32 + 32;
    pub const PAYOUT_RELEASED_LEN: usize = 8 + 32 + 32 + 8 + 32 + 32 + 8;

    /// `VaultOpened { vault, mint, key_id }`.
    pub fn vault_opened(
        vault: &Pubkey,
        mint: &Pubkey,
        key_id: &[u8; 32],
    ) -> [u8; VAULT_OPENED_LEN] {
        let mut d = [0u8; VAULT_OPENED_LEN];
        d[..8].copy_from_slice(&discriminator::VAULT_OPENED);
        d[8..40].copy_from_slice(vault.as_ref());
        d[40..72].copy_from_slice(mint.as_ref());
        d[72..104].copy_from_slice(key_id);
        d
    }

    /// `VaultWithdrawn { vault, mint, sequence, destination_owner, amount,
    /// payout, next_key_id }`.
    pub fn vault_withdrawn(
        vault: &Pubkey,
        mint: &Pubkey,
        sequence: u64,
        destination_owner: &Pubkey,
        amount: u64,
        payout: &Pubkey,
        next_key_id: &[u8; 32],
    ) -> [u8; VAULT_WITHDRAWN_LEN] {
        let mut d = [0u8; VAULT_WITHDRAWN_LEN];
        d[..8].copy_from_slice(&discriminator::VAULT_WITHDRAWN);
        d[8..40].copy_from_slice(vault.as_ref());
        d[40..72].copy_from_slice(mint.as_ref());
        d[72..80].copy_from_slice(&sequence.to_le_bytes());
        d[80..112].copy_from_slice(destination_owner.as_ref());
        d[112..120].copy_from_slice(&amount.to_le_bytes());
        d[120..152].copy_from_slice(payout.as_ref());
        d[152..184].copy_from_slice(next_key_id);
        d
    }

    /// `PayoutReleased { vault, payout, sequence, destination_owner,
    /// destination, amount }`.
    pub fn payout_released(
        vault: &Pubkey,
        payout: &Pubkey,
        sequence: u64,
        destination_owner: &Pubkey,
        destination: &Pubkey,
        amount: u64,
    ) -> [u8; PAYOUT_RELEASED_LEN] {
        let mut d = [0u8; PAYOUT_RELEASED_LEN];
        d[..8].copy_from_slice(&discriminator::PAYOUT_RELEASED);
        d[8..40].copy_from_slice(vault.as_ref());
        d[40..72].copy_from_slice(payout.as_ref());
        d[72..80].copy_from_slice(&sequence.to_le_bytes());
        d[80..112].copy_from_slice(destination_owner.as_ref());
        d[112..144].copy_from_slice(destination.as_ref());
        d[144..152].copy_from_slice(&amount.to_le_bytes());
        d
    }

    impl VaultOpened {
        /// The `sol_log_data` payload (Anchor's `Event::data`).
        pub fn log_data(&self) -> [u8; VAULT_OPENED_LEN] {
            vault_opened(&self.vault, &self.mint, &self.key_id)
        }
    }

    impl VaultWithdrawn {
        /// The `sol_log_data` payload (Anchor's `Event::data`).
        pub fn log_data(&self) -> [u8; VAULT_WITHDRAWN_LEN] {
            vault_withdrawn(
                &self.vault,
                &self.mint,
                self.sequence,
                &self.destination_owner,
                self.amount,
                &self.payout,
                &self.next_key_id,
            )
        }
    }

    impl PayoutReleased {
        /// The `sol_log_data` payload (Anchor's `Event::data`).
        pub fn log_data(&self) -> [u8; PAYOUT_RELEASED_LEN] {
            payout_released(
                &self.vault,
                &self.payout,
                self.sequence,
                &self.destination_owner,
                &self.destination,
                self.amount,
            )
        }
    }
}

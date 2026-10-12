//! Shared LiteSVM harness for the Noised integration tests.
//!
//! Every test binary (`tests/*.rs`) declares `mod common;` and builds its
//! scenarios from these pieces:
//!
//! * [`paths`]: finds our `cargo-build-sbf` outputs and the mainnet fixtures,
//!   and refuses to run against a `.so` older than its sources.
//! * [`svm`]: [`svm::Harness`], a LiteSVM instance with mainnet features,
//!   the mainnet Token-2022 / SPL Token / ATA programs, our programs, a
//!   realistic clock, transaction sending with a compute budget, CU and
//!   wire-size reporting, error assertions and address lookup tables.
//! * [`token`]: SPL Token and Token-2022 mints (optionally with a transfer
//!   hook or other extensions), ATAs and plain token accounts, balances, the
//!   account changes a holder or freeze authority can make, and
//!   `transfer_checked` with transfer-hook extra accounts resolved exactly
//!   like an off-chain client does.
//! * [`hook`] and [`vault`]: thin clients for `noised_hook` and
//!   `noised_vault` (PDAs, instruction builders, state readers, policy
//!   injection, post-quantum key derivation and signing).
//! * [`launchpad`]: the post-quantum attestation of `noised_launchpad`
//!   (PQ v2): PDAs, the attestation message, `attest_launch`, and the
//!   `Launch`, `Identity` and `Attestation` layouts, written from the
//!   documented formats.
//! * [`launch`]: the launch end to end against mainnet DBC: the `Protocol`
//!   account, `LaunchParams` and `create_launch`, every address of a launch,
//!   `launch` (no arguments, 22 accounts), the `Certificate` (version 3) and
//!   the mint's Token-2022 `TokenMetadata`, written from the documented
//!   layouts.
//! * [`relay`]: a native stand-in program that makes one CPI from a
//!   top-level instruction with a chosen program id and data prefix (what
//!   the hook reads from the instructions sysvar), optionally signed for
//!   PDAs of that program id (the runtime derives them from the seeds, as
//!   for `invoke_signed`): how the launchpad's `hook-authority` signs here.
//!
//! Extending for end-to-end launch tests: [`svm::Harness::with_dbc`] loads
//! mainnet DBC, the wSOL mint and the `Protocol` account; load DAMM v2 with
//! [`svm::HarnessBuilder::fixture_program`], clone mainnet accounts with
//! [`svm::HarnessBuilder::fixture_account`], and extend [`launch`] following
//! the same pattern.
#![allow(dead_code)] // each test binary uses a different subset

pub mod hook;
pub mod launch;
pub mod launchpad;
pub mod paths;
pub mod relay;
pub mod svm;
pub mod token;
pub mod vault;

pub use anchor_lang::prelude::Pubkey;
pub use solana_instruction::{AccountMeta, Instruction};
pub use solana_keypair::Keypair;
pub use solana_signer::Signer;
pub use svm::Harness;

/// Meteora Dynamic Bonding Curve (DBC 0.2.1).
pub const DBC_PROGRAM_ID: Pubkey = noised_hook::DBC_PROGRAM_ID;
/// DBC's pool authority: owner of every pool's base and quote vaults, and
/// the signer of the vault side of each swap (SPEC; fixed address in the DBC IDL).
pub const DBC_POOL_AUTHORITY: Pubkey =
    anchor_lang::pubkey!("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
/// Meteora DAMM v2 (cp_amm).
pub const DAMM_V2_PROGRAM_ID: Pubkey =
    anchor_lang::pubkey!("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
/// Noised launchpad (the only program whose PDA may create hook policies).
pub const LAUNCHPAD_PROGRAM_ID: Pubkey = noised_hook::LAUNCHPAD_PROGRAM_ID;
pub const TOKEN_PROGRAM_ID: Pubkey = anchor_spl::token::ID;
pub const TOKEN_2022_PROGRAM_ID: Pubkey = anchor_spl::token_2022::ID;
pub const ATA_PROGRAM_ID: Pubkey = anchor_spl::associated_token::ID;
pub const SYSTEM_PROGRAM_ID: Pubkey = anchor_lang::system_program::ID;
pub const LAMPORTS_PER_SOL: u64 = 1_000_000_000;

/// SHA-256 (the same backend the LM-OTS signer uses).
pub fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    use noised_lmots::Sha256;
    noised_lmots::Sha2::hashv(parts)
}

/// Anchor discriminator, computed independently of the program crates:
/// `sha256("<namespace>:<name>")[..8]`.
pub fn anchor_discriminator(namespace: &str, name: &str) -> [u8; 8] {
    let h = sha256(&[namespace.as_bytes(), b":", name.as_bytes()]);
    let mut d = [0u8; 8];
    d.copy_from_slice(&h[..8]);
    d
}

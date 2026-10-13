//! Noised launchpad: token launches on Meteora's Dynamic Bonding Curve, each
//! one signed by its creator's post-quantum identity, that no key (the
//! creator's included) can rug.
//!
//! * `create_launch` validates the creator's parameters against a fixed
//!   safety policy and creates the DBC transfer-hook config itself, so every
//!   field that could hide a rug (mint/freeze authority, LP, vesting,
//!   migration fees, metadata authority) is fixed by the program. The
//!   parameters name the creator's post-quantum identity (`pq_identity`).
//! * The token's metadata (name, symbol, uri mode and a document with its
//!   description and icon) is an on-chain record, `publish_metadata`, at the
//!   address its content hashes to: no link to hosting it depends on.
//! * The creator may add launch rules (PXR1: time tiers, anti-bot, caps,
//!   wallet and program lists) for the Launch Guard period, also an on-chain
//!   record at the address its content hashes to (`publish_rules`). The
//!   hook evaluates them after every built-in allow and denial: they can
//!   only refuse, never a sell, a claim, the batch or anything after the
//!   guard.
//! * `attest_launch` verifies, on-chain, a hash-based LMS signature (RFC 8554)
//!   by that identity over the launch's configuration, metadata record,
//!   rules record and launch window, and burns the one-time leaf that signed it (any valid
//!   signature lands, to burn its leaf). `launch` refuses to run without that
//!   attestation or outside its window, and inside the window anyone may run
//!   it: a quantum computer that forges the creator's Ed25519 signature still
//!   cannot launch anything the identity did not sign, nor choose when.
//! * Every DBC role (pool creator, partner/fee claimer, leftover receiver, LP
//!   owner) is a PDA of this program. No private key controls a launch.
//! * `launch` creates the pool and mint from the attested record, installs
//!   the Launch Guard hook policy (with the attested rules) and only then
//!   writes a certificate whose flags come from re-reading the live mint (its
//!   metadata included), DBC config, pool and policy, and the attestation.
//! * `pq_authorize` lands generic authorizations by the same identity (the
//!   same leaf bitmap), kept in full on-chain: the autopilot's graph
//!   changes need them.
//! * A fair-open batch replaces the race at the open: commits are pooled and
//!   bought in one swap, then paid out pro rata to payout owners fixed at the
//!   first commit (the committer or its PQ vaults; what a vault receives is
//!   held to one wallet's cap). Once the batch has bought, `execute_batch`
//!   ends the hook's snipe shield, so trading opens at once.
//! * Fees route by immutable rules (platform share to a PQ vault treasury,
//!   then the creator's recipients); LP fees paid in the launched token are
//!   burned.
//!
//! There is no admin, no pause and no instruction that changes a launch's
//! fee recipients, hook policy or DBC config after creation. The one change
//! to a hook policy is `execute_batch` ending its snipe shield early, at the
//! batch; the hook only ever lets that end move earlier.
//!
//! # No framework
//!
//! The program is written on `pinocchio` and `noised-onchain` (the shared
//! Anchor-compatible building blocks: account checks, errors, Token-2022
//! parsing, CPIs); no Anchor code is linked into it. Its ABI is the one the
//! Anchor 1.2.1 build had, byte for byte: the same instruction
//! discriminators (`sha256("global:<name>")[..8]`), account order and
//! signer/writable flags, Borsh argument layouts, account discriminators
//! (`sha256("account:<Name>")[..8]`) and field layouts, PDA seeds, events
//! (`sha256("event:<Name>")[..8]` + Borsh, through `sol_log_data`) and error
//! numbers, the framework's included (`ConstraintSeeds` 2006, ...).
//! [`instructions`] lists, per instruction, every account constraint the
//! Anchor build enforced and checks them in the Anchor order ([`processor`]
//! dispatches). The Meteora DBC / DAMM v2 and Launch Guard interfaces it
//! uses are written by hand ([`external`]): only the instructions it
//! invokes and the account fields it reads. The hand-maintained
//! `idls/noised_launchpad.json` describes the ABI; the Anchor source the
//! program implements is kept, verbatim, in `programs/noised-launchpad/anchor`.
//!
//! Off-chain (`not(target_os = "solana")`), the crate keeps the Anchor
//! client API its users have: [`accounts`], [`instruction`], the Anchor
//! account and event traits on the [`state`] and [`events`] types, the
//! pure checks' `anchor_lang::Result` API, and the DBC / DAMM v2 client
//! types (`dynamic_bonding_curve`, `cp_amm`, from `declare_program!`). That
//! code is host-only and never part of the program binary.

extern crate alloc;
// `declare_program!` (host only) refers to the crate as `super::anchor_lang`.
#[cfg(not(target_os = "solana"))]
extern crate anchor_lang;

pub mod base64;
pub mod checks;
#[cfg(not(target_os = "solana"))]
mod client;
pub mod constants;
pub mod dbc_params;
pub mod error;
pub mod events;
pub mod external;
pub mod hook_accounts;
pub mod instructions;
pub mod math;
pub mod policy;
pub mod pq;
pub mod processor;
mod pubkey;
pub mod state;
pub mod token_util;

#[cfg(test)]
mod tests;

#[cfg(not(target_os = "solana"))]
pub use client::{accounts, instruction};

#[cfg(not(feature = "no-entrypoint"))]
noised_onchain::entrypoint!(crate::processor::process_instruction);

/// An account address (`solana_address::Address`, which Anchor's `Pubkey`
/// also is).
pub type Pubkey = pinocchio::Address;

/// `CfbRmsFpevhiXkbYK48orBDugdKznnezDiVekjAAbNgc`.
pub const ID: Pubkey = pubkey::pubkey!("CfbRmsFpevhiXkbYK48orBDugdKznnezDiVekjAAbNgc");

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
    /// The launchpad program.
    #[derive(Clone)]
    pub struct NoisedLaunchpad;

    impl noised_onchain::Program for NoisedLaunchpad {
        const ID: crate::Pubkey = crate::ID;
        const ERRORS: noised_onchain::ErrorTable = crate::error::ERRORS;
    }

    #[cfg(not(target_os = "solana"))]
    impl anchor_lang::Id for NoisedLaunchpad {
        fn id() -> crate::Pubkey {
            crate::ID
        }
    }
}

/// Discriminators: instructions `sha256("global:<snake_case name>")[..8]`,
/// accounts `sha256("account:<Name>")[..8]`, events
/// `sha256("event:<Name>")[..8]`.
pub mod discriminator {
    pub const INITIALIZE_PROTOCOL: [u8; 8] = [188, 233, 252, 106, 134, 146, 202, 91];
    pub const CREATE_LAUNCH: [u8; 8] = [239, 223, 255, 134, 39, 121, 127, 62];
    pub const PUBLISH_METADATA: [u8; 8] = [179, 191, 168, 97, 199, 25, 229, 146];
    pub const PUBLISH_RULES: [u8; 8] = [213, 245, 134, 186, 168, 25, 143, 233];
    pub const ATTEST_LAUNCH: [u8; 8] = [181, 24, 201, 53, 246, 126, 253, 79];
    pub const PQ_AUTHORIZE: [u8; 8] = [137, 191, 62, 214, 185, 40, 143, 247];
    pub const LAUNCH: [u8; 8] = [153, 241, 93, 225, 22, 69, 74, 61];
    pub const COMMIT: [u8; 8] = [223, 140, 142, 165, 229, 208, 156, 74];
    pub const EXECUTE_BATCH: [u8; 8] = [112, 159, 211, 51, 238, 70, 212, 60];
    pub const CLAIM: [u8; 8] = [62, 198, 214, 193, 213, 159, 108, 210];
    pub const CLAIM_FEES: [u8; 8] = [82, 251, 233, 156, 12, 52, 184, 202];
    pub const CLAIM_SURPLUS: [u8; 8] = [195, 35, 205, 205, 177, 146, 141, 62];
    pub const CLAIM_LP_FEES: [u8; 8] = [72, 86, 212, 142, 60, 38, 74, 75];
    pub const DISTRIBUTE: [u8; 8] = [191, 44, 223, 207, 164, 236, 126, 61];

    pub const PROTOCOL: [u8; 8] = [45, 39, 101, 43, 115, 72, 131, 40];
    pub const LAUNCH_ACCOUNT: [u8; 8] = [144, 51, 51, 163, 206, 85, 213, 38];
    pub const COMMIT_ACCOUNT: [u8; 8] = [222, 158, 102, 118, 51, 65, 166, 130];
    pub const PAYOUT_VAULT: [u8; 8] = [131, 206, 160, 202, 124, 97, 122, 222];
    pub const IDENTITY: [u8; 8] = [58, 132, 5, 12, 176, 164, 85, 112];
    pub const ATTESTATION: [u8; 8] = [152, 125, 183, 86, 36, 146, 121, 73];
    pub const TOKEN_META: [u8; 8] = [130, 87, 174, 35, 21, 44, 92, 19];
    pub const LAUNCH_RULES: [u8; 8] = [238, 73, 71, 29, 231, 48, 39, 141];
    pub const AUTHORIZATION: [u8; 8] = [3, 68, 168, 243, 195, 168, 32, 75];
    pub const CERTIFICATE: [u8; 8] = [202, 229, 222, 220, 116, 20, 74, 67];

    pub const PROTOCOL_INITIALIZED: [u8; 8] = [173, 122, 168, 254, 9, 118, 76, 132];
    pub const LAUNCH_CREATED: [u8; 8] = [59, 38, 190, 230, 33, 34, 89, 20];
    pub const METADATA_PUBLISHED: [u8; 8] = [120, 92, 42, 175, 159, 174, 24, 113];
    pub const RULES_PUBLISHED: [u8; 8] = [26, 16, 62, 30, 94, 109, 64, 56];
    pub const LAUNCH_ATTESTED: [u8; 8] = [173, 151, 139, 236, 170, 109, 132, 21];
    pub const PQ_LEAF_CONSUMED: [u8; 8] = [178, 187, 79, 242, 166, 50, 87, 14];
    pub const AUTHORIZED: [u8; 8] = [118, 46, 103, 253, 101, 118, 6, 128];
    pub const LAUNCHED: [u8; 8] = [209, 127, 29, 152, 129, 212, 189, 183];
    pub const COMMITTED: [u8; 8] = [70, 158, 162, 86, 29, 111, 143, 226];
    pub const BATCH_EXECUTED: [u8; 8] = [77, 214, 111, 72, 17, 48, 85, 77];
    pub const BATCH_CLAIMED: [u8; 8] = [60, 42, 120, 40, 81, 126, 128, 160];
    pub const FEES_CLAIMED: [u8; 8] = [22, 104, 110, 222, 38, 157, 14, 62];
    pub const LP_FEES_CLAIMED: [u8; 8] = [106, 76, 240, 18, 233, 91, 163, 215];
    pub const DISTRIBUTED: [u8; 8] = [10, 212, 24, 78, 35, 202, 182, 134];

    /// Anchor's `EVENT_IX_TAG` (`0x1d9acb512ea545e4`, little-endian): the
    /// event-CPI instruction tag, which this program (like the Anchor build,
    /// compiled without `event-cpi`) refuses with `EventInstructionStub`.
    pub const EVENT_IX_TAG_LE: [u8; 8] = noised_onchain::event::EVENT_IX_TAG_LE;
}

// The Meteora DBC and DAMM v2 client types (host only): the test suites use
// them, and the hand-written interfaces in `external` are tested against
// them. The IDLs are in `idls/`.
#[cfg(not(target_os = "solana"))]
anchor_lang::declare_program!(dynamic_bonding_curve);
#[cfg(not(target_os = "solana"))]
anchor_lang::declare_program!(cp_amm);

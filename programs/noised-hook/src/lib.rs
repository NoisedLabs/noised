//! Noised Launch Guard: the Token-2022 transfer hook for Noised launches on
//! Meteora's Dynamic Bonding Curve (DBC).
//!
//! DBC keeps a transfer hook active only while the bonding curve runs and
//! revokes it (program and authority set to None) in the swap that completes
//! the curve, before liquidity moves to DAMM v2. This hook uses that window
//! for anti-snipe and anti-whale rules and is built so it can never become a
//! honeypot:
//!
//! * selling into the pool's base vault is always allowed, decided from
//!   account keys alone before any account data is read (a transfer out of
//!   the base vault is a buy, never a sell);
//! * every rule has a hard expiry (at most 72 hours after launch);
//! * rules are stateless, so there is no state to corrupt or exhaust;
//! * the extra accounts are the mint-derived policy PDA and the instructions
//!   sysvar, which Meteora's SDKs resolve correctly (they resolve hook
//!   accounts with default keys);
//! * until the snipe shield ends, the only buy that passes is the batch buy:
//!   a buy inside the launchpad's `execute_batch`, read from the instructions
//!   sysvar. Exempt owners and zero amounts do not change that (a buy that
//!   pays out nothing still moves the pool's price);
//! * while the guard is on, tokens go (other than to the pool) only into
//!   token accounts whose owner can never change: ones with Token-2022's
//!   ImmutableOwner extension (every associated token account has it) or
//!   owned by an exempt launchpad PDA. Reassigning an account's owner moves
//!   its tokens with no transfer, so no hook would see it;
//! * mints without a Noised policy (pools created on our config outside the
//!   launchpad) are not restricted at all;
//! * policies are written once, only by the launchpad. The one later change
//!   is `end_snipe_shield`: once the batch has bought, the launchpad's
//!   `execute_batch` ends the shield at that moment. It can only move the end
//!   earlier, never later, and nothing else in a policy ever changes;
//! * a policy may hold the creator's launch rules (PXR1, the
//!   `noised-rules` crate), verified when the policy is written and
//!   checked after every built-in allow and denial: they can only refuse,
//!   and they never see a sell, the batch buy, a claim, anything after the
//!   guard, or a transfer made by the Noised vault or shield as the
//!   top-level instruction (holders' exits, `rules::creator_rules`);
//! * sells and everything after the guard are decided from the policy's
//!   fixed head (`state::PolicyHead`), before the rest of it is decoded.
//!
//! # No framework
//!
//! The program is written on `pinocchio` and `noised-onchain` (the shared
//! Anchor-compatible building blocks: account checks, errors, CPIs); no
//! Anchor code is linked into it. Its ABI is the one the Anchor 1.2.1 build
//! had, byte for byte: the same instruction discriminators
//! (`sha256("global:<name>")[..8]`, and the transfer-hook interface's
//! `Execute` discriminator for `execute`), account order and signer/writable
//! flags, Borsh argument layouts, account discriminator
//! (`sha256("account:HookPolicy")[..8]`) and layout, the ExtraAccountMetaList
//! contents, PDA seeds, events (`sha256("event:<Name>")[..8]` + Borsh,
//! through `sol_log_data`) and error numbers, the framework's included
//! (`ConstraintSeeds` 2006, ...). [`processor`] lists, per instruction,
//! every account constraint the Anchor build enforced and checks them in
//! the Anchor order. The Anchor source is kept verbatim in `anchor/` as the
//! reference; the hand-maintained `idls/noised_hook.json` describes the ABI.
//!
//! Off-chain (`not(target_os = "solana")`), the crate keeps the Anchor
//! client API its users have: [`accounts`], [`instruction`], the Anchor
//! account traits on [`state::HookPolicy`] and the events. With the `cpi`
//! feature (Anchor programs that call the hook) it also has Anchor's `cpi`
//! module. That code is never part of the hook's own binary.

extern crate alloc;

#[cfg(any(not(target_os = "solana"), feature = "cpi"))]
use anchor_lang::{AnchorDeserialize, AnchorSerialize, Discriminator};

#[cfg(any(not(target_os = "solana"), feature = "cpi"))]
mod client;
#[cfg(feature = "cpi")]
pub mod cpi;
pub mod error;
pub mod processor;
pub mod rules;
pub mod state;

#[cfg(any(not(target_os = "solana"), feature = "cpi"))]
pub use client::{accounts, instruction};
pub use error::HookError;

#[cfg(not(feature = "no-entrypoint"))]
noised_onchain::entrypoint!(crate::processor::process_instruction);

/// An account address (`solana_address::Address`, which Anchor's `Pubkey`
/// also is).
pub type Pubkey = pinocchio::Address;

/// `cHHLLsEH4eHmqZBT4X5XqzutmkFw3daWSySPtV4csia`.
pub const ID: Pubkey = Pubkey::new_from_array([
    9, 9, 188, 237, 60, 53, 28, 80, 252, 82, 24, 100, 168, 121, 233, 35, 171, 76, 152, 34, 230,
    196, 184, 204, 118, 58, 96, 75, 6, 208, 253, 91,
]);

/// The program id.
pub const fn id() -> Pubkey {
    ID
}

/// Whether `id` is the program id.
pub fn check_id(id: &Pubkey) -> bool {
    *id == ID
}

/// The only program allowed to write policies (create them, and end their
/// snipe shield) through its `hook-authority` PDA
/// (`CfbRmsFpevhiXkbYK48orBDugdKznnezDiVekjAAbNgc`).
pub const LAUNCHPAD_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    173, 83, 141, 198, 211, 176, 14, 30, 72, 5, 249, 126, 188, 79, 223, 227, 193, 45, 8, 110, 106,
    70, 227, 237, 185, 115, 202, 93, 52, 127, 105, 109,
]);
/// Meteora Dynamic Bonding Curve
/// (`dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`).
pub const DBC_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    9, 96, 12, 165, 36, 247, 177, 183, 214, 204, 177, 195, 151, 58, 160, 51, 13, 25, 3, 218, 96,
    28, 201, 181, 222, 227, 198, 98, 180, 202, 209, 73,
]);
/// Anchor discriminator of the launchpad's `execute_batch`
/// (`sha256("global:execute_batch")[..8]`; the launchpad tests check it).
pub const EXECUTE_BATCH_DISCRIMINATOR: [u8; 8] = [112, 159, 211, 51, 238, 70, 212, 60];
/// The Noised PQ vault (`noised_vault`'s id,
/// `7BQ6FQomidBkd5z7fQfwr9Zt87oahMvMV5dFnw6Dz7nb`, pinned in the
/// integration tests) and the Noised shield (`noised_shield`'s,
/// `BUMHJyoS6JCz4pZDfryzXbFDorXb9nmGkj3ziR71z8E9`, pinned in the shield's
/// tests): a transfer whose top-level instruction is one of them is a
/// holder's exit, which creator rules never refuse
/// (`rules::creator_rules`).
pub const VAULT_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    91, 208, 9, 196, 48, 57, 200, 36, 155, 174, 112, 27, 169, 36, 26, 59, 189, 19, 20, 129, 48, 61,
    18, 50, 64, 23, 160, 254, 107, 106, 132, 244,
]);
pub const SHIELD_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    155, 150, 123, 175, 50, 212, 99, 79, 207, 208, 232, 168, 91, 92, 179, 112, 147, 13, 32, 207,
    105, 103, 133, 61, 1, 154, 76, 132, 6, 12, 85, 30,
]);
/// The instructions sysvar (`Sysvar1nstructions1111111111111111111111111`),
/// the second extra account of every transfer.
pub const INSTRUCTIONS_SYSVAR_ID: Pubkey = noised_onchain::sysvar::INSTRUCTIONS_ID;
/// The launchpad's `hook-authority` PDA:
/// `find_program_address(&[HOOK_AUTHORITY_SEED], &LAUNCHPAD_PROGRAM_ID).0`
/// (`seeds = [HOOK_AUTHORITY_SEED], bump, seeds::program =
/// LAUNCHPAD_PROGRAM_ID`, which the Anchor build derived on every call; the
/// seeds and the program are constants, so is the address, pinned by a
/// test): `HXXwgdDQUFk9PF7XUHZDaxqorJ4RKhVvsL1KMabFUKBp`.
pub const LAUNCHPAD_HOOK_AUTHORITY: Pubkey = Pubkey::new_from_array([
    245, 141, 102, 249, 128, 30, 90, 133, 8, 182, 97, 153, 1, 120, 167, 173, 71, 10, 129, 94, 236,
    204, 73, 177, 17, 72, 90, 105, 217, 171, 69, 147,
]);

/// The program type (`Id` off-chain, as `#[program]` generated it), and the
/// [`noised_onchain::Program`] the account checks and errors are generic
/// over.
pub mod program {
    /// The Launch Guard program.
    #[derive(Clone)]
    pub struct NoisedHook;

    impl noised_onchain::Program for NoisedHook {
        const ID: crate::Pubkey = crate::ID;
        const ERRORS: noised_onchain::ErrorTable = crate::error::ERRORS;
    }

    #[cfg(any(not(target_os = "solana"), feature = "cpi"))]
    impl anchor_lang::Id for NoisedHook {
        fn id() -> crate::Pubkey {
            crate::ID
        }
    }
}

/// Discriminators: instructions `sha256("global:<snake_case name>")[..8]`
/// (`execute`: the transfer-hook interface's `Execute`), the account
/// `sha256("account:HookPolicy")[..8]`, events `sha256("event:<Name>")[..8]`.
pub mod discriminator {
    pub const INITIALIZE_EXTRA_ACCOUNT_META_LIST: [u8; 8] = [92, 197, 174, 197, 41, 124, 19, 3];
    pub const CREATE_POLICY: [u8; 8] = [27, 81, 33, 27, 196, 103, 246, 53];
    pub const END_SNIPE_SHIELD: [u8; 8] = [219, 182, 248, 52, 26, 6, 73, 161];
    /// `spl_transfer_hook_interface::instruction::ExecuteInstruction`'s
    /// `SPL_DISCRIMINATOR` (`sha256("spl-transfer-hook-interface:execute")
    /// [..8]`), the instruction's custom discriminator in the Anchor build
    /// (`#[instruction(discriminator = ...)]`).
    pub const EXECUTE: [u8; 8] = noised_onchain::token::hook::EXECUTE_DISCRIMINATOR;
    /// `sha256("account:HookPolicy")[..8]`.
    pub const HOOK_POLICY: [u8; 8] = [103, 114, 246, 85, 15, 22, 190, 195];
    /// `sha256("event:PolicyCreated")[..8]`.
    pub const POLICY_CREATED: [u8; 8] = [59, 189, 65, 121, 86, 157, 108, 10];
    /// `sha256("event:SnipeShieldEnded")[..8]`.
    pub const SNIPE_SHIELD_ENDED: [u8; 8] = [207, 137, 254, 18, 206, 221, 221, 195];
    /// Anchor's `EVENT_IX_TAG` (`0x1d9acb512ea545e4`, little-endian): the
    /// event-CPI instruction tag, which this program (like the Anchor build,
    /// compiled without `event-cpi`) refuses with `EventInstructionStub`.
    pub const EVENT_IX_TAG_LE: [u8; 8] = noised_onchain::event::EVENT_IX_TAG_LE;
}

/// Emitted by `create_policy`.
#[cfg_attr(any(not(target_os = "solana"), feature = "cpi"), anchor_lang::event)]
#[derive(Debug, PartialEq, Eq)]
pub struct PolicyCreated {
    pub mint: Pubkey,
    pub pool: Pubkey,
    pub snipe_shield_end_ts: i64,
    pub guard_end_ts: i64,
    pub max_wallet: u64,
    pub max_buy: u64,
    pub p2p_locked: bool,
    /// Bytes of the creator's rules (0: none).
    pub rules_len: u16,
}

/// `execute_batch` ended the snipe shield (`end_snipe_shield`).
#[cfg_attr(any(not(target_os = "solana"), feature = "cpi"), anchor_lang::event)]
#[derive(Debug, PartialEq, Eq)]
pub struct SnipeShieldEnded {
    pub mint: Pubkey,
    pub pool: Pubkey,
    /// The end the policy held before the call: from `execute_batch`, the
    /// scheduled end written by `create_policy` (the end of the launchpad's
    /// execution window), which the launch certificate keeps.
    pub scheduled_end_ts: i64,
    /// The end from now on: `min(scheduled_end_ts, now)`. Buys pass from
    /// then on, under the guard rules until the unchanged `guard_end_ts`.
    pub snipe_shield_end_ts: i64,
}

/// The `sol_log_data` payloads of the events: discriminator, then the fields
/// in Borsh (pubkeys raw, integers little-endian, `bool` one byte).
pub mod event_data {
    use super::{discriminator, PolicyCreated, Pubkey, SnipeShieldEnded};

    pub const POLICY_CREATED_LEN: usize = 8 + 32 + 32 + 8 + 8 + 8 + 8 + 1 + 2;
    pub const SNIPE_SHIELD_ENDED_LEN: usize = 8 + 32 + 32 + 8 + 8;

    /// `PolicyCreated { mint, pool, snipe_shield_end_ts, guard_end_ts,
    /// max_wallet, max_buy, p2p_locked, rules_len }`.
    #[allow(clippy::too_many_arguments)]
    pub fn policy_created(
        mint: &Pubkey,
        pool: &Pubkey,
        snipe_shield_end_ts: i64,
        guard_end_ts: i64,
        max_wallet: u64,
        max_buy: u64,
        p2p_locked: bool,
        rules_len: u16,
    ) -> [u8; POLICY_CREATED_LEN] {
        let mut d = [0u8; POLICY_CREATED_LEN];
        d[..8].copy_from_slice(&discriminator::POLICY_CREATED);
        d[8..40].copy_from_slice(mint.as_ref());
        d[40..72].copy_from_slice(pool.as_ref());
        d[72..80].copy_from_slice(&snipe_shield_end_ts.to_le_bytes());
        d[80..88].copy_from_slice(&guard_end_ts.to_le_bytes());
        d[88..96].copy_from_slice(&max_wallet.to_le_bytes());
        d[96..104].copy_from_slice(&max_buy.to_le_bytes());
        d[104] = u8::from(p2p_locked);
        d[105..107].copy_from_slice(&rules_len.to_le_bytes());
        d
    }

    /// `SnipeShieldEnded { mint, pool, scheduled_end_ts, snipe_shield_end_ts }`.
    pub fn snipe_shield_ended(
        mint: &Pubkey,
        pool: &Pubkey,
        scheduled_end_ts: i64,
        snipe_shield_end_ts: i64,
    ) -> [u8; SNIPE_SHIELD_ENDED_LEN] {
        let mut d = [0u8; SNIPE_SHIELD_ENDED_LEN];
        d[..8].copy_from_slice(&discriminator::SNIPE_SHIELD_ENDED);
        d[8..40].copy_from_slice(mint.as_ref());
        d[40..72].copy_from_slice(pool.as_ref());
        d[72..80].copy_from_slice(&scheduled_end_ts.to_le_bytes());
        d[80..88].copy_from_slice(&snipe_shield_end_ts.to_le_bytes());
        d
    }

    impl PolicyCreated {
        /// The `sol_log_data` payload (Anchor's `Event::data`).
        pub fn log_data(&self) -> [u8; POLICY_CREATED_LEN] {
            policy_created(
                &self.mint,
                &self.pool,
                self.snipe_shield_end_ts,
                self.guard_end_ts,
                self.max_wallet,
                self.max_buy,
                self.p2p_locked,
                self.rules_len,
            )
        }
    }

    impl SnipeShieldEnded {
        /// The `sol_log_data` payload (Anchor's `Event::data`).
        pub fn log_data(&self) -> [u8; SNIPE_SHIELD_ENDED_LEN] {
            snipe_shield_ended(
                &self.mint,
                &self.pool,
                self.scheduled_end_ts,
                self.snipe_shield_end_ts,
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use anchor_lang::{
        solana_program::instruction::AccountMeta, Event, InstructionData, ToAccountMetas,
    };

    use super::*;

    fn key(b: u8) -> Pubkey {
        Pubkey::new_from_array([b; 32])
    }

    /// The launchpad's CPI (and the SDK/IDL) depend on these bytes: the
    /// discriminator `sha256("global:end_snipe_shield")[..8]` (computed
    /// independently) with no arguments, and the account order and flags.
    #[test]
    fn end_snipe_shield_interface_is_pinned() {
        assert_eq!(
            instruction::EndSnipeShield.data(),
            [219, 182, 248, 52, 26, 6, 73, 161]
        );
        let (authority, policy) = (key(1), key(2));
        let metas = accounts::EndSnipeShield {
            launchpad_authority: authority,
            policy,
            instructions: INSTRUCTIONS_SYSVAR_ID,
        }
        .to_account_metas(None);
        assert_eq!(
            metas,
            vec![
                AccountMeta::new_readonly(authority, true),
                AccountMeta::new(policy, false),
                AccountMeta::new_readonly(INSTRUCTIONS_SYSVAR_ID, false),
            ]
        );
        assert_eq!(
            INSTRUCTIONS_SYSVAR_ID,
            anchor_lang::prelude::pubkey!("Sysvar1nstructions1111111111111111111111111")
        );
    }

    /// `SnipeShieldEnded`: `sha256("event:SnipeShieldEnded")[..8]` (computed
    /// independently), then mint, pool, scheduled end and new end (i64 LE).
    #[test]
    fn snipe_shield_ended_layout_is_pinned() {
        let event = SnipeShieldEnded {
            mint: key(3),
            pool: key(4),
            scheduled_end_ts: 0x0102_0304_0506_0708,
            snipe_shield_end_ts: -2,
        };
        let mut want = vec![207, 137, 254, 18, 206, 221, 221, 195];
        want.extend_from_slice(&[3; 32]);
        want.extend_from_slice(&[4; 32]);
        want.extend_from_slice(&0x0102_0304_0506_0708i64.to_le_bytes());
        want.extend_from_slice(&(-2i64).to_le_bytes());
        assert_eq!(event.data(), want);
        assert_eq!(event.log_data().to_vec(), want);
    }

    /// The ids are the Anchor build's `declare_id!` / `pubkey!` constants,
    /// and the launchpad's hook authority is its `["hook-authority"]` PDA.
    #[test]
    fn ids_are_the_anchor_builds() {
        use anchor_lang::prelude::pubkey;
        assert_eq!(ID, pubkey!("cHHLLsEH4eHmqZBT4X5XqzutmkFw3daWSySPtV4csia"));
        assert_eq!(
            LAUNCHPAD_PROGRAM_ID,
            pubkey!("CfbRmsFpevhiXkbYK48orBDugdKznnezDiVekjAAbNgc")
        );
        assert_eq!(
            DBC_PROGRAM_ID,
            pubkey!("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN")
        );
        assert_eq!(
            VAULT_PROGRAM_ID,
            pubkey!("7BQ6FQomidBkd5z7fQfwr9Zt87oahMvMV5dFnw6Dz7nb")
        );
        assert_eq!(
            SHIELD_PROGRAM_ID,
            pubkey!("BUMHJyoS6JCz4pZDfryzXbFDorXb9nmGkj3ziR71z8E9")
        );
        assert_eq!(
            LAUNCHPAD_HOOK_AUTHORITY,
            Pubkey::find_program_address(&[state::HOOK_AUTHORITY_SEED], &LAUNCHPAD_PROGRAM_ID).0
        );
        assert_eq!(<program::NoisedHook as anchor_lang::Id>::id(), ID);
        assert!(check_id(&id()));
    }
}

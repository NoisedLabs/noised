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

use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::spl_token_2022::{
        self,
        extension::{transfer_hook, StateWithExtensions},
    },
    token_interface::Mint,
};
use spl_discriminator::SplDiscriminate;
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList,
};
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

/// The instructions sysvar, the second extra account of every transfer.
pub use solana_instructions_sysvar::ID as INSTRUCTIONS_SYSVAR_ID;
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};

pub mod rules;
pub mod state;

use noised_rules::RuleSet;
use rules::{bounds, Refusal, Step, TransferView};
use state::{
    HookPolicy, PolicyHead, PolicyParams, DBC_TOKEN_VAULT_SEED, HOOK_AUTHORITY_SEED,
    META_LIST_SEED, POLICY_SEED,
};

declare_id!("cHHLLsEH4eHmqZBT4X5XqzutmkFw3daWSySPtV4csia");

/// The only program allowed to write policies (create them, and end their
/// snipe shield) through its `hook-authority` PDA.
pub const LAUNCHPAD_PROGRAM_ID: Pubkey = pubkey!("CfbRmsFpevhiXkbYK48orBDugdKznnezDiVekjAAbNgc");
/// Meteora Dynamic Bonding Curve.
pub const DBC_PROGRAM_ID: Pubkey = pubkey!("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
/// Anchor discriminator of the launchpad's `execute_batch`
/// (`sha256("global:execute_batch")[..8]`; the launchpad tests check it).
pub const EXECUTE_BATCH_DISCRIMINATOR: [u8; 8] = [112, 159, 211, 51, 238, 70, 212, 60];
/// The Noised PQ vault (`noised_vault`'s `declare_id!`, pinned in the
/// integration tests) and the Noised shield (`noised_shield`'s, pinned in
/// the shield's tests): a transfer whose top-level instruction is one of
/// them is a holder's exit, which creator rules never refuse
/// (`rules::creator_rules`).
pub const VAULT_PROGRAM_ID: Pubkey = pubkey!("7BQ6FQomidBkd5z7fQfwr9Zt87oahMvMV5dFnw6Dz7nb");
pub const SHIELD_PROGRAM_ID: Pubkey = pubkey!("BUMHJyoS6JCz4pZDfryzXbFDorXb9nmGkj3ziR71z8E9");

#[program]
pub mod noised_hook {
    use super::*;

    /// Create the mint's ExtraAccountMetaList. Permissionless and
    /// deterministic: the list always holds exactly the policy PDA and the
    /// instructions sysvar.
    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
    ) -> Result<()> {
        require_our_hook(&ctx.accounts.mint)?;
        let metas = canonical_metas()?;
        let mut data = ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?;
        ExtraAccountMetaList::init::<ExecuteInstruction>(&mut data, &metas)?;
        Ok(())
    }

    /// Write the launch policy for a mint. Only the launchpad can sign. The
    /// creator's rules, if any, must verify for this guard (`InvalidRules`).
    pub fn create_policy(ctx: Context<CreatePolicy>, params: PolicyParams) -> Result<()> {
        require_our_hook(&ctx.accounts.mint)?;

        let mint_key = ctx.accounts.mint.key();
        let (base_vault, _) = Pubkey::find_program_address(
            &[
                DBC_TOKEN_VAULT_SEED,
                mint_key.as_ref(),
                params.pool.as_ref(),
            ],
            &DBC_PROGRAM_ID,
        );
        require_keys_eq!(ctx.accounts.pool.key(), params.pool, HookError::InvalidPool);

        let supply = ctx.accounts.mint.supply;
        let guard = params.guard_secs as i64;
        let shield = params.snipe_shield_secs as i64;
        require!(
            guard <= bounds::MAX_GUARD_SECS
                && shield <= bounds::MAX_SNIPE_SHIELD_SECS
                && shield <= guard
                && (params.max_wallet == 0
                    || params.max_wallet >= supply / bounds::MIN_MAX_WALLET_DIVISOR)
                && (params.max_buy == 0 || params.max_buy >= supply / bounds::MIN_MAX_BUY_DIVISOR),
            HookError::InvalidPolicy
        );
        require!(
            params.rules.is_empty() || RuleSet::verify(&params.rules, params.guard_secs).is_ok(),
            HookError::InvalidRules
        );

        let now = Clock::get()?.unix_timestamp;
        let policy = &mut ctx.accounts.policy;
        policy.version = HookPolicy::VERSION;
        policy.bump = ctx.bumps.policy;
        policy.mint = mint_key;
        policy.pool = params.pool;
        policy.base_vault = base_vault;
        policy.launch_ts = now;
        policy.snipe_shield_end_ts = now + shield;
        policy.guard_end_ts = now + guard;
        policy.max_wallet = params.max_wallet;
        policy.max_buy = params.max_buy;
        policy.p2p_locked = params.p2p_locked;
        policy.exempt = params.exempt;
        policy.rules = params.rules;

        emit!(PolicyCreated {
            mint: mint_key,
            pool: params.pool,
            snipe_shield_end_ts: policy.snipe_shield_end_ts,
            guard_end_ts: policy.guard_end_ts,
            max_wallet: params.max_wallet,
            max_buy: params.max_buy,
            p2p_locked: params.p2p_locked,
            rules_len: policy.rules.len() as u16,
        });
        Ok(())
    }

    /// End the snipe shield now. Only the launchpad can sign, and it does so
    /// only in `execute_batch`, after the batch bought for the launch's own
    /// policy: from then on the shield has nothing left to protect, so public
    /// trading opens at once instead of at the end of the execution window.
    ///
    /// The only effect is `snipe_shield_end_ts = min(snipe_shield_end_ts,
    /// now)` (`rules::shield_end_after_batch`): the end never moves later,
    /// and every other field, the guard rules and their end included, stays
    /// as written. Defense in depth: the top-level instruction must be the
    /// launchpad's `execute_batch` (`NotInBatch`). The mint is not read and
    /// its hook need not be active: when the batch completes the curve, DBC
    /// revokes the hook inside that same swap, and `execute_batch` must
    /// still succeed.
    pub fn end_snipe_shield(ctx: Context<EndSnipeShield>) -> Result<()> {
        require!(
            inside_execute_batch(&ctx.accounts.instructions)?,
            HookError::NotInBatch
        );
        let now = Clock::get()?.unix_timestamp;
        let policy = &mut ctx.accounts.policy;
        let scheduled_end_ts = policy.snipe_shield_end_ts;
        policy.snipe_shield_end_ts = rules::shield_end_after_batch(scheduled_end_ts, now);
        emit!(SnipeShieldEnded {
            mint: policy.mint,
            pool: policy.pool,
            scheduled_end_ts,
            snipe_shield_end_ts: policy.snipe_shield_end_ts,
        });
        Ok(())
    }

    /// Token-2022 `Execute`: decide one transfer, as `rules::evaluate`
    /// does. Sells and everything after the guard are decided from the
    /// policy's head (`PolicyHead`) before the policy is decoded. Then the
    /// built-in checks (`rules::built_ins`) read the source's owner, and the
    /// destination's owner, balance and extensions (`has_immutable_owner`),
    /// from their own account data; only a transfer they leave to the
    /// creator rules, under a policy that has some, also reads the mint's
    /// supply and the transaction's top-level instructions (`top_level`).
    #[instruction(discriminator = ExecuteInstruction::SPL_DISCRIMINATOR_SLICE)]
    pub fn execute(ctx: Context<Execute>, amount: u64) -> Result<()> {
        let policy_info = &ctx.accounts.policy;
        // No Noised policy for this mint: nothing to enforce.
        if policy_info.owner != &crate::ID || policy_info.data_is_empty() {
            return Ok(());
        }
        let data = policy_info.try_borrow_data()?;
        let head = PolicyHead::read(&data)?;
        require_keys_eq!(
            head.mint,
            ctx.accounts.mint.key(),
            HookError::PolicyMismatch
        );

        let source = ctx.accounts.source.key();
        let destination = ctx.accounts.destination.key();
        let is_buy = source == head.base_vault;
        // Sells, and zero transfers that are not buys, are decided from keys alone.
        if !is_buy && (destination == head.base_vault || amount == 0) {
            return Ok(());
        }
        let now = Clock::get()?.unix_timestamp;
        if now >= head.guard_end_ts {
            return Ok(());
        }
        let policy = HookPolicy::try_deserialize(&mut &data[..])?;
        drop(data);

        let in_batch = is_buy
            && now < policy.snipe_shield_end_ts
            && inside_execute_batch(&ctx.accounts.instructions)?;
        let (destination_owner, destination_balance) = owner_and_amount(&ctx.accounts.destination)?;
        let destination_immutable_owner =
            has_immutable_owner(&ctx.accounts.destination.try_borrow_data()?);
        let (source_owner, _) = owner_and_amount(&ctx.accounts.source)?;
        let mut view = TransferView {
            now,
            amount,
            source,
            source_owner,
            destination,
            destination_owner,
            destination_balance,
            destination_immutable_owner,
            in_batch,
            supply: 0,
            top_program: Pubkey::default(),
            tx_ix_count: 0,
        };
        let decision = match rules::built_ins(&policy, &view) {
            Ok(Step::CreatorRules) if !policy.rules.is_empty() => {
                // Read only here: sells, claims, the batch buy and exempt
                // owners never pay for it.
                (view.top_program, view.tx_ix_count) = top_level(&ctx.accounts.instructions)?;
                view.supply = mint_supply(&ctx.accounts.mint)?;
                rules::creator_rules(&policy, &view)
            }
            Ok(_) => Ok(()),
            Err(refusal) => Err(refusal),
        };
        decision.map_err(|r| match r {
            Refusal::SnipeShield => error!(HookError::SnipeShield),
            Refusal::TransfersLocked => error!(HookError::TransfersLocked),
            Refusal::MaxBuy => error!(HookError::MaxBuy),
            Refusal::MaxWallet => error!(HookError::MaxWallet),
            Refusal::MutableOwner => error!(HookError::MutableOwner),
            Refusal::Rule(v) => {
                msg!(
                    "Launch rule {} (code {}) refused the transfer",
                    v.rule,
                    v.code
                );
                error!(HookError::RuleDenied)
            }
        })
    }
}

/// The extra accounts Token-2022 passes to `execute`: the policy PDA derived
/// from the mint (account index 1) and the instructions sysvar.
fn canonical_metas() -> Result<[ExtraAccountMeta; 2]> {
    Ok([
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: POLICY_SEED.to_vec(),
                },
                Seed::AccountKey { index: 1 },
            ],
            false,
            false,
        )?,
        ExtraAccountMeta::new_with_pubkey(&INSTRUCTIONS_SYSVAR_ID, false, false)?,
    ])
}

/// Whether the transaction's currently executing top-level instruction is
/// the launchpad's `execute_batch`. That instruction makes exactly one DBC
/// swap, the launch's batch buy, so a buy inside it is the batch buy; it is
/// also the only launchpad instruction that ends a snipe shield. Other
/// programs cannot appear as that top-level instruction, and CPIs never do.
/// The sysvar's address is checked here (`load_*_checked`).
fn inside_execute_batch(instructions: &AccountInfo) -> Result<bool> {
    let index = load_current_index_checked(instructions)?;
    let ix = load_instruction_at_checked(usize::from(index), instructions)?;
    Ok(ix.program_id == LAUNCHPAD_PROGRAM_ID
        && ix.data.get(..8) == Some(&EXECUTE_BATCH_DISCRIMINATOR[..]))
}

/// The program of the transaction's currently executing top-level
/// instruction, and the number of top-level instructions (the sysvar's
/// leading `u16`). The sysvar's address is checked (`load_*_checked`).
fn top_level(instructions: &AccountInfo) -> Result<(Pubkey, u16)> {
    let index = load_current_index_checked(instructions)?;
    let ix = load_instruction_at_checked(usize::from(index), instructions)?;
    let data = instructions.try_borrow_data()?;
    let count = data
        .first_chunk::<2>()
        .ok_or(ProgramError::InvalidAccountData)?;
    Ok((ix.program_id, u16::from_le_bytes(*count)))
}

/// The supply of a mint in the base layout shared by SPL Token and
/// Token-2022 (`mint_authority` 0..36, `supply` 36..44); Token-2022 has
/// checked that this account is the transfer's mint.
fn mint_supply(mint: &AccountInfo) -> Result<u64> {
    let data = mint.try_borrow_data()?;
    let supply = data
        .get(36..44)
        .and_then(|s| s.try_into().ok())
        .ok_or(ProgramError::InvalidAccountData)?;
    Ok(u64::from_le_bytes(supply))
}

/// The mint must be Token-2022 with this program as its transfer hook.
fn require_our_hook(mint: &InterfaceAccount<Mint>) -> Result<()> {
    let info = mint.to_account_info();
    require_keys_eq!(*info.owner, spl_token_2022::ID, HookError::WrongHookProgram);
    let data = info.try_borrow_data()?;
    let state = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&data)?;
    require!(
        transfer_hook::get_program_id(&state) == Some(crate::ID),
        HookError::WrongHookProgram
    );
    Ok(())
}

/// Owner and amount from the base token-account layout shared by SPL Token
/// and Token-2022 (mint 0..32, owner 32..64, amount 64..72).
fn owner_and_amount(account: &AccountInfo) -> Result<(Pubkey, u64)> {
    let data = account.try_borrow_data()?;
    require!(data.len() >= 72, HookError::MalformedTokenAccount);
    let mut owner = [0u8; 32];
    owner.copy_from_slice(&data[32..64]);
    let mut amount = [0u8; 8];
    amount.copy_from_slice(&data[64..72]);
    Ok((Pubkey::new_from_array(owner), u64::from_le_bytes(amount)))
}

/// Token-2022's token-account layout past the base shared with SPL Token:
/// the 165-byte base account, then (with extensions) the account-type byte
/// and the TLV entries, each `u16le type || u16le length || value`.
const TOKEN_ACCOUNT_LEN: usize = 165;
/// `AccountType::Account`.
const ACCOUNT_TYPE_ACCOUNT: u8 = 2;
/// `ExtensionType::Uninitialized`: nothing is written after such an entry.
const EXTENSION_UNINITIALIZED: u16 = 0;
/// `ExtensionType::ImmutableOwner` (an entry with no value).
const EXTENSION_IMMUTABLE_OWNER: u16 = 7;

/// Whether token-account `data` has Token-2022's ImmutableOwner extension:
/// then Token-2022 refuses every `SetAuthority(AccountOwner)` on it. Reads
/// it as Token-2022 does (`get_extension`): the first ImmutableOwner entry
/// of the TLV entries, before any Uninitialized one, with an empty value.
/// Total: data that is short, not an account with extensions or cut inside
/// an entry has no such extension; nothing panics.
fn has_immutable_owner(data: &[u8]) -> bool {
    if data.get(TOKEN_ACCOUNT_LEN) != Some(&ACCOUNT_TYPE_ACCOUNT) {
        return false;
    }
    let mut at = TOKEN_ACCOUNT_LEN + 1;
    while let Some(&[t0, t1, l0, l1]) = data.get(at..at + 4) {
        match u16::from_le_bytes([t0, t1]) {
            EXTENSION_IMMUTABLE_OWNER => return l0 == 0 && l1 == 0,
            EXTENSION_UNINITIALIZED => return false,
            _ => at += 4 + usize::from(u16::from_le_bytes([l0, l1])),
        }
    }
    false
}

#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: created here with the canonical TLV contents.
    #[account(
        init,
        payer = payer,
        space = ExtraAccountMetaList::size_of(2)?,
        seeds = [META_LIST_SEED, mint.key().as_ref()],
        bump,
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(params: PolicyParams)]
pub struct CreatePolicy<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// The launchpad's PDA; only the launchpad program can produce this signature.
    #[account(seeds = [HOOK_AUTHORITY_SEED], bump, seeds::program = LAUNCHPAD_PROGRAM_ID)]
    pub launchpad_authority: Signer<'info>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: must be a Meteora DBC account; its base vault PDA is derived from it.
    #[account(owner = DBC_PROGRAM_ID @ HookError::InvalidPool)]
    pub pool: UncheckedAccount<'info>,

    #[account(
        init,
        payer = payer,
        space = HookPolicy::space(params.rules.len()),
        seeds = [POLICY_SEED, mint.key().as_ref()],
        bump,
    )]
    pub policy: Box<Account<'info, HookPolicy>>,

    pub system_program: Program<'info, System>,
}

/// The launchpad's CPI from `execute_batch`, in this account order:
/// `[launchpad_authority (signer), policy (writable), instructions]`.
#[derive(Accounts)]
pub struct EndSnipeShield<'info> {
    /// The launchpad's PDA; only the launchpad program can produce this
    /// signature (it does so only in `execute_batch`, after the batch buy).
    #[account(seeds = [HOOK_AUTHORITY_SEED], bump, seeds::program = LAUNCHPAD_PROGRAM_ID)]
    pub launchpad_authority: Signer<'info>,

    /// A Launch Guard policy PDA (`["policy", mint]`); the launchpad passes
    /// its own launch's. Only `snipe_shield_end_ts` changes.
    #[account(
        mut,
        seeds = [POLICY_SEED, policy.mint.as_ref()],
        bump = policy.bump,
    )]
    pub policy: Box<Account<'info, HookPolicy>>,

    /// CHECK: the instructions sysvar (address checked); its current
    /// top-level instruction must be the launchpad's `execute_batch`.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
}

/// Account order fixed by the transfer-hook interface.
#[derive(Accounts)]
pub struct Execute<'info> {
    /// CHECK: source token account, validated by Token-2022.
    pub source: UncheckedAccount<'info>,
    /// CHECK: mint, validated by Token-2022.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: destination token account, validated by Token-2022.
    pub destination: UncheckedAccount<'info>,
    /// CHECK: source owner or delegate (never a signer here).
    pub authority: UncheckedAccount<'info>,
    /// CHECK: this mint's ExtraAccountMetaList.
    pub extra_account_meta_list: UncheckedAccount<'info>,
    /// CHECK: policy PDA resolved by Token-2022 from the meta list; may be empty.
    pub policy: UncheckedAccount<'info>,
    /// CHECK: instructions sysvar from the meta list; its address is checked
    /// when it is read (buys during the snipe shield, and transfers that
    /// reach creator rules).
    pub instructions: UncheckedAccount<'info>,
}

#[event]
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
#[event]
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

#[error_code]
pub enum HookError {
    #[msg("Launch guard: buying opens when the snipe-shield countdown ends")]
    SnipeShield,
    #[msg("Launch guard: wallet-to-wallet transfers are paused until the guard ends")]
    TransfersLocked,
    #[msg("Launch guard: transfer is larger than the max-buy cap")]
    MaxBuy,
    #[msg("Launch guard: receiving account would exceed the max-wallet cap")]
    MaxWallet,
    #[msg("Mint's transfer hook is not this program")]
    WrongHookProgram,
    #[msg("Policy belongs to a different mint")]
    PolicyMismatch,
    #[msg("Policy is outside the hook's hard bounds")]
    InvalidPolicy,
    #[msg("Pool is not a Meteora DBC account")]
    InvalidPool,
    #[msg("Malformed token account")]
    MalformedTokenAccount,
    #[msg("Only the launchpad's execute_batch can end the snipe shield")]
    NotInBatch,
    #[msg("Launch guard: the receiving token account must have an immutable owner while the guard is on")]
    MutableOwner,
    #[msg("Launch rule: this transfer is not allowed right now")]
    RuleDenied,
    #[msg("Launch rules do not verify (PXR1) for this guard")]
    InvalidRules,
}

#[cfg(test)]
mod tests {
    use anchor_lang::{
        solana_program::instruction::{AccountMeta, BorrowedInstruction},
        Event, InstructionData, ToAccountMetas,
    };
    use solana_instructions_sysvar::{construct_instructions_data, store_current_index_checked};

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
            pubkey!("Sysvar1nstructions1111111111111111111111111")
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
    }

    /// Clients map error numbers to messages, so they never move: round 2
    /// appended `NotInBatch` after the existing variants, audit 3
    /// `MutableOwner`, programmable launches `RuleDenied` and `InvalidRules`.
    #[test]
    fn error_numbers_are_stable() {
        let pinned = [
            (HookError::SnipeShield, 6000),
            (HookError::TransfersLocked, 6001),
            (HookError::MaxBuy, 6002),
            (HookError::MaxWallet, 6003),
            (HookError::WrongHookProgram, 6004),
            (HookError::PolicyMismatch, 6005),
            (HookError::InvalidPolicy, 6006),
            (HookError::InvalidPool, 6007),
            (HookError::MalformedTokenAccount, 6008),
            (HookError::NotInBatch, 6009),
            (HookError::MutableOwner, 6010),
            (HookError::RuleDenied, 6011),
            (HookError::InvalidRules, 6012),
        ];
        for (error, number) in pinned {
            assert_eq!(u32::from(error), number, "{error:?}");
        }
    }

    /// Instructions-sysvar data for top-level instructions `(program, data)`
    /// with `current` executing, as the runtime writes it.
    fn sysvar_data(top_level: &[(Pubkey, &[u8])], current: u16) -> Vec<u8> {
        let ixs: Vec<BorrowedInstruction> = top_level
            .iter()
            .map(|(program_id, data)| BorrowedInstruction {
                program_id,
                accounts: vec![],
                data,
            })
            .collect();
        let mut data = construct_instructions_data(&ixs);
        store_current_index_checked(&mut data, current).unwrap();
        data
    }

    fn in_batch(address: &Pubkey, mut data: Vec<u8>) -> Result<bool> {
        let (mut lamports, owner) = (1, Pubkey::default());
        let info = AccountInfo::new(
            address,
            false,
            false,
            &mut lamports,
            &mut data,
            &owner,
            false,
        );
        inside_execute_batch(&info)
    }

    /// The `NotInBatch` decision of `end_snipe_shield` (and the batch-buy
    /// decision of `execute`): only the currently executing top-level
    /// instruction counts, and it must be the launchpad's program with data
    /// starting with `execute_batch`'s discriminator.
    #[test]
    fn only_the_launchpads_execute_batch_is_the_batch() {
        let batch: &[u8] = &EXECUTE_BATCH_DISCRIMINATOR;
        let sysvar = INSTRUCTIONS_SYSVAR_ID;
        let lp = LAUNCHPAD_PROGRAM_ID;
        let check = |ixs: &[(Pubkey, &[u8])], current: u16| {
            in_batch(&sysvar, sysvar_data(ixs, current)).unwrap()
        };
        assert!(check(&[(lp, batch)], 0));
        assert!(check(&[(lp, &[batch, &[9, 9]].concat())], 0), "with args");
        assert!(check(&[(key(7), b"other"), (lp, batch)], 1));
        assert!(
            !check(&[(key(7), b"other"), (lp, batch)], 0),
            "another ix runs"
        );
        assert!(
            !check(&[(lp, batch), (key(7), b"other")], 1),
            "another ix runs"
        );
        // `sha256("global:launch")[..8]`: the launchpad's `launch`.
        let launch = [153, 241, 93, 225, 22, 69, 74, 61];
        assert!(!check(&[(lp, &launch)], 0), "another launchpad instruction");
        assert!(
            !check(&[(key(7), batch)], 0),
            "execute_batch's bytes, another program"
        );
        assert!(
            !check(&[(lp, &batch[..7])], 0),
            "data shorter than a discriminator"
        );
        assert!(!check(&[(lp, &[])], 0), "no data");
        let mut flipped = EXECUTE_BATCH_DISCRIMINATOR;
        flipped[7] ^= 1;
        assert!(!check(&[(lp, &flipped)], 0), "one bit off");
        // Only the real sysvar is read.
        let forged = sysvar_data(&[(lp, batch)], 0);
        assert!(in_batch(&key(8), forged).is_err());
    }

    use anchor_spl::token_2022::spl_token_2022::{
        extension::{
            cpi_guard::CpiGuard, immutable_owner::ImmutableOwner, memo_transfer::MemoTransfer,
            non_transferable::NonTransferableAccount, pausable::PausableAccount,
            transfer_fee::TransferFeeAmount, transfer_hook::TransferHookAccount, AccountType,
            BaseStateWithExtensions, BaseStateWithExtensionsMut, ExtensionType,
            StateWithExtensions, StateWithExtensionsMut,
        },
        state::{Account as TokenAccount, AccountState},
    };

    /// Token-2022's reading of `data`: `None` if it does not unpack as a
    /// token account, else whether it has ImmutableOwner.
    fn token_2022_reads(data: &[u8]) -> Option<bool> {
        let state = StateWithExtensions::<TokenAccount>::unpack(data).ok()?;
        Some(state.get_extension::<ImmutableOwner>().is_ok())
    }

    /// An initialized token account built by Token-2022's own code, with
    /// `extensions` initialized in that order (so in that TLV order).
    fn token_account(extensions: &[ExtensionType]) -> Vec<u8> {
        let len = ExtensionType::try_calculate_account_len::<TokenAccount>(extensions).unwrap();
        let mut data = vec![0u8; len];
        let mut state =
            StateWithExtensionsMut::<TokenAccount>::unpack_uninitialized(&mut data).unwrap();
        for e in extensions {
            let initialized = match e {
                ExtensionType::ImmutableOwner => {
                    state.init_extension::<ImmutableOwner>(true).map(drop)
                }
                ExtensionType::TransferHookAccount => {
                    state.init_extension::<TransferHookAccount>(true).map(drop)
                }
                ExtensionType::MemoTransfer => state.init_extension::<MemoTransfer>(true).map(drop),
                ExtensionType::CpiGuard => state.init_extension::<CpiGuard>(true).map(drop),
                ExtensionType::TransferFeeAmount => {
                    state.init_extension::<TransferFeeAmount>(true).map(drop)
                }
                ExtensionType::NonTransferableAccount => state
                    .init_extension::<NonTransferableAccount>(true)
                    .map(drop),
                ExtensionType::PausableAccount => {
                    state.init_extension::<PausableAccount>(true).map(drop)
                }
                other => panic!("not an account extension here: {other:?}"),
            };
            initialized.unwrap();
        }
        state.base = TokenAccount {
            mint: key(1),
            owner: key(2),
            amount: 5,
            state: AccountState::Initialized,
            ..TokenAccount::default()
        };
        state.pack_base();
        state.init_account_type().unwrap();
        data
    }

    /// The layout constants are Token-2022's.
    #[test]
    fn token_account_layout_constants_are_token_2022s() {
        assert_eq!(
            ExtensionType::try_calculate_account_len::<TokenAccount>(&[]).unwrap(),
            TOKEN_ACCOUNT_LEN
        );
        assert_eq!(AccountType::Account as u8, ACCOUNT_TYPE_ACCOUNT);
        assert_eq!(
            u16::from(ExtensionType::Uninitialized),
            EXTENSION_UNINITIALIZED
        );
        assert_eq!(
            u16::from(ExtensionType::ImmutableOwner),
            EXTENSION_IMMUTABLE_OWNER
        );
        // An associated token account of a hooked mint, as the ATA program
        // creates it (ImmutableOwner, then InitializeAccount3 adds
        // TransferHookAccount), and a plain InitializeAccount3 account.
        let ata = token_account(&[
            ExtensionType::ImmutableOwner,
            ExtensionType::TransferHookAccount,
        ]);
        assert_eq!(&ata[165..170], &[2, 7, 0, 0, 0]);
        assert!(has_immutable_owner(&ata));
        let plain = token_account(&[ExtensionType::TransferHookAccount]);
        assert_eq!(&plain[165..170], &[2, 15, 0, 1, 0]);
        assert!(!has_immutable_owner(&plain));
        assert!(!has_immutable_owner(&token_account(&[])));
    }

    /// Whatever extensions a token account has and in whatever order,
    /// `has_immutable_owner` reads it as Token-2022 does, also with
    /// uninitialized space after the entries (a reallocated account), and
    /// on every truncation of it never panics and never disagrees with
    /// Token-2022 where Token-2022 unpacks it.
    #[test]
    fn immutable_owner_is_read_as_token_2022_reads_it() {
        let all = [
            ExtensionType::ImmutableOwner,
            ExtensionType::TransferHookAccount,
            ExtensionType::MemoTransfer,
            ExtensionType::CpiGuard,
            ExtensionType::TransferFeeAmount,
            ExtensionType::NonTransferableAccount,
            ExtensionType::PausableAccount,
        ];
        // Every ordered selection of up to four of them.
        let mut lists: Vec<Vec<ExtensionType>> = vec![vec![]];
        let mut frontier = lists.clone();
        for _ in 0..4 {
            let mut next = Vec::new();
            for list in &frontier {
                for e in all.iter().filter(|e| !list.contains(e)) {
                    let mut l = list.clone();
                    l.push(*e);
                    next.push(l);
                }
            }
            lists.extend(next.iter().cloned());
            frontier = next;
        }
        assert_eq!(lists.len(), 1 + 7 + 42 + 210 + 840);
        let mut checked = 0;
        for list in &lists {
            let data = token_account(list);
            let has = list.contains(&ExtensionType::ImmutableOwner);
            assert_eq!(token_2022_reads(&data), Some(has), "{list:?}");
            assert_eq!(has_immutable_owner(&data), has, "{list:?}");
            let mut padded = data.clone();
            padded.extend_from_slice(&[0; 9]);
            if let Some(reads) = token_2022_reads(&padded) {
                assert_eq!(has_immutable_owner(&padded), reads, "{list:?} padded");
            }
            for n in 0..data.len() {
                let cut = &data[..n];
                let ours = has_immutable_owner(cut);
                if let Some(reads) = token_2022_reads(cut) {
                    assert_eq!(ours, reads, "{list:?} cut at {n}");
                    checked += 1;
                }
            }
        }
        assert!(checked > 0);
    }

    /// Malformed data: no account type, another account type, an entry cut
    /// short, a length past the end, an entry after an Uninitialized one.
    /// None of it has ImmutableOwner, and random data never panics (and
    /// agrees with Token-2022 wherever Token-2022 unpacks it).
    #[test]
    fn malformed_token_accounts_have_no_immutable_owner() {
        let base = token_account(&[]);
        let with = |tail: &[u8]| [&base[..], tail].concat();
        assert!(!has_immutable_owner(&[]));
        assert!(!has_immutable_owner(&base[..72]));
        assert!(!has_immutable_owner(&base));
        assert!(!has_immutable_owner(&with(&[2])), "no entry");
        assert!(!has_immutable_owner(&with(&[2, 7])), "a type, no length");
        assert!(!has_immutable_owner(&with(&[2, 7, 0, 0])), "length cut");
        assert!(has_immutable_owner(&with(&[2, 7, 0, 0, 0])), "the entry");
        assert!(!has_immutable_owner(&with(&[1, 7, 0, 0, 0])), "a mint");
        assert!(!has_immutable_owner(&with(&[0, 7, 0, 0, 0])), "no type");
        assert!(
            !has_immutable_owner(&with(&[2, 0, 0, 0, 0, 7, 0, 0, 0])),
            "after an Uninitialized entry"
        );
        assert!(
            !has_immutable_owner(&with(&[2, 15, 0, 0xff, 0xff, 7, 0, 0, 0])),
            "a length past the end"
        );
        assert!(
            has_immutable_owner(&with(&[2, 15, 0, 1, 0, 0, 7, 0, 0, 0])),
            "after another entry"
        );
        assert!(
            !has_immutable_owner(&with(&[2, 7, 0, 1, 0, 0])),
            "with a value"
        );
        assert!(
            !has_immutable_owner(&with(&[2, 7, 0, 1, 0, 0, 7, 0, 0, 0])),
            "a second entry after one with a value"
        );
        assert!(
            !has_immutable_owner(&with(&[2, 15, 0, 1, 0, 0, 8, 0, 0, 0])),
            "only other entries"
        );
        let mut r = 0x1234_5678_9abc_def0u64;
        let mut next = || {
            r = r
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            r >> 33
        };
        let mut agreed = 0;
        for _ in 0..100_000 {
            let len = 150 + (next() % 120) as usize;
            let mut data: Vec<u8> = (0..len).map(|_| next() as u8).collect();
            if len > 165 && next() % 4 != 0 {
                data[..165].copy_from_slice(&base);
                data[165] = 2;
                // Small types and lengths, so entries chain.
                for b in data[166..].iter_mut() {
                    if next() % 3 != 0 {
                        *b %= 18;
                    }
                }
            }
            let ours = has_immutable_owner(&data);
            if let Some(reads) = token_2022_reads(&data) {
                assert_eq!(ours, reads, "{data:?}");
                agreed += 1;
            }
        }
        assert!(agreed > 1_000, "{agreed}");
    }
}

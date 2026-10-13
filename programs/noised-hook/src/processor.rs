//! The program. Each instruction runs exactly what the Anchor 1.2.1 build
//! generated for it (`anchor/lib.rs`), in the same order, so every input
//! fails (or succeeds) the same way:
//!
//! 1. `Instruction: <Name>` is logged, then the arguments are decoded
//!    (Borsh; trailing bytes ignored): `InstructionDidNotDeserialize`.
//! 2. The accounts are taken in order and checked by type (`Signer`,
//!    `Account<HookPolicy>`, `InterfaceAccount<Mint>`, `Program<System>`);
//!    a missing account is `AccountNotEnoughKeys`.
//! 3. The `init` accounts are created and checked (seeds, then the
//!    creation, `mut` and rent exemption).
//! 4. Every other field's constraints, field by field, each in Anchor's
//!    order: seeds, mut, owner, address. (No instruction has two writable
//!    `Account` / `InterfaceAccount` fields, so there is no duplicate check.)
//! 5. The handler.
//! 6. Exit: the policy is written back (after the handler).
//!
//! The comments `[A]` name the Anchor constraint each check implements.

use noised_onchain::{
    accounts::{
        check_address, check_keys, check_mut, check_rent_exempt, init_program_account,
        load_program_account, write_back,
    },
    args,
    cpi::create_account_or_fund_allocate_assign,
    ids::{SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID},
    owned_by,
    pda::{check_seeds, check_seeds_with_bump, find_program_address},
    same, sys,
    sysvar::{Clock, Rent},
    token::{hook::EXTRA_ACCOUNT_META_LEN, hook_program_id},
    Ref,
};
use noised_rules::RuleSet;
use pinocchio::{
    cpi::{Seed, Signer},
    error::ProgramError,
    AccountView, Address, ProgramResult,
};

use crate::{
    discriminator,
    error::{anchor::*, fail, fail_keys, hook, HookError},
    event_data,
    program::NoisedHook,
    rules::{self, bounds, Refusal, Step, TransferView},
    state::{
        layout, write_policy, HookPolicy, NewPolicy, PolicyHead, PolicyKeys, PolicyParamsRef,
        PolicyView, DBC_TOKEN_VAULT_SEED, META_LIST_SEED, POLICY_SEED,
    },
    Pubkey, DBC_PROGRAM_ID, EXECUTE_BATCH_DISCRIMINATOR, ID, INSTRUCTIONS_SYSVAR_ID,
    LAUNCHPAD_HOOK_AUTHORITY, LAUNCHPAD_PROGRAM_ID,
};

/// The program the shared checks log and compare with.
type P = NoisedHook;

/// The instruction's accounts, taken in order (`try_accounts`).
type Accounts<'a> = noised_onchain::accounts::Accounts<'a, P>;

// Account field names, as Anchor names them in errors.
const PAYER: &str = "payer";
const EXTRA_ACCOUNT_META_LIST: &str = "extra_account_meta_list";
const MINT: &str = "mint";
const SYSTEM_PROGRAM: &str = "system_program";
const LAUNCHPAD_AUTHORITY: &str = "launchpad_authority";
const POOL: &str = "pool";
const POLICY: &str = "policy";
const INSTRUCTIONS: &str = "instructions";
const SOURCE: &str = "source";
const DESTINATION: &str = "destination";
const AUTHORITY: &str = "authority";

/// The program entrypoint's instruction processor.
pub fn process_instruction(
    program_id: &Address,
    accounts: &mut [AccountView],
    data: &[u8],
) -> ProgramResult {
    // [A] try_entry: the declared id; dispatch: the 8-byte discriminator
    // prefix (each instruction's is distinct, so the order of the tests does
    // not matter: `execute`, the one every transfer runs, comes first); the
    // event-CPI tag is a stub without `event-cpi`; anything else has no
    // fallback.
    let (tag, args) = args::instruction::<P>(program_id, data)?;
    let accounts = Accounts::new(accounts);
    match *tag {
        discriminator::EXECUTE => execute(accounts, args),
        discriminator::INITIALIZE_EXTRA_ACCOUNT_META_LIST => {
            initialize_extra_account_meta_list(accounts)
        }
        discriminator::CREATE_POLICY => create_policy(accounts, args),
        discriminator::END_SNIPE_SHIELD => end_snipe_shield(accounts),
        _ => Err(args::unknown::<P>(tag)),
    }
}

/// `msg!("Instruction: <Name>")`, unless built with `no-log-ix-name`.
#[inline(always)]
fn log_instruction(_name: &str) {
    #[cfg(not(feature = "no-log-ix-name"))]
    sys::log(_name);
}

// ------------------------------------------------------------- constraints

/// [A] `launchpad_authority: Signer` with `seeds = [HOOK_AUTHORITY_SEED],
/// bump, seeds::program = LAUNCHPAD_PROGRAM_ID` (`find_program_address`,
/// whose result is the constant [`LAUNCHPAD_HOOK_AUTHORITY`]):
/// `ConstraintSeeds` with the given and the derived keys.
fn check_launchpad_authority(authority: &AccountView) -> ProgramResult {
    check_keys::<P>(
        authority.address(),
        &LAUNCHPAD_HOOK_AUTHORITY,
        CONSTRAINT_SEEDS,
        LAUNCHPAD_AUTHORITY,
    )
}

/// `require_our_hook`: the mint must be Token-2022
/// (`require_keys_eq!(owner, spl_token_2022::ID, WrongHookProgram)`, with
/// both keys) with this program as its transfer hook
/// (`transfer_hook::get_program_id(&state) == Some(crate::ID)`).
fn require_our_hook(mint: &AccountView, hook_program: Option<Pubkey>) -> ProgramResult {
    if !owned_by(mint, &TOKEN_2022_PROGRAM_ID) {
        return Err(fail_keys(
            HookError::WrongHookProgram.code(),
            None,
            mint.owner(),
            &TOKEN_2022_PROGRAM_ID,
        ));
    }
    if hook_program != Some(ID) {
        return Err(hook(HookError::WrongHookProgram));
    }
    Ok(())
}

// ----------------------------------------- initialize_extra_account_meta_list

/// The meta list's contents: `ExtraAccountMetaList::init::<ExecuteInstruction>`
/// of the Anchor build's `canonical_metas()`, which depend on nothing (the
/// policy PDA's seeds name the mint by its account index). A TLV entry: the
/// `Execute` discriminator, the `u32` length of the value, then the value: a
/// `PodSlice` (`u32` count, then the 35-byte `ExtraAccountMeta`s):
///
/// 1. the policy PDA `["policy", mint]` of this program: discriminator 1
///    (a PDA of the hook program), the packed seeds `Seed::Literal { bytes:
///    b"policy" }` (`[1, 6, b"policy"]`) and `Seed::AccountKey { index: 1 }`
///    (`[3, 1]`), zero-padded to 32 bytes, read-only, not a signer;
/// 2. the instructions sysvar: discriminator 0 (a fixed address), its
///    address, read-only, not a signer.
pub const META_LIST_DATA: [u8; META_LIST_LEN] = {
    let mut d = [0u8; META_LIST_LEN];
    let disc = discriminator::EXECUTE;
    let mut i = 0;
    while i < 8 {
        d[i] = disc[i];
        i += 1;
    }
    // Value length: the count and two entries.
    let value_len = (4 + 2 * EXTRA_ACCOUNT_META_LEN) as u32;
    let len = value_len.to_le_bytes();
    d[8] = len[0];
    d[9] = len[1];
    d[10] = len[2];
    d[11] = len[3];
    // `PodSlice` count.
    d[12] = 2;
    // Entry 1 (from 16): the policy PDA.
    d[16] = 1;
    let seeds: [u8; 10] = [1, 6, b'p', b'o', b'l', b'i', b'c', b'y', 3, 1];
    let mut i = 0;
    while i < seeds.len() {
        d[17 + i] = seeds[i];
        i += 1;
    }
    // d[49] (is_signer) and d[50] (is_writable) stay 0.
    // Entry 2 (from 51): the instructions sysvar.
    d[51] = 0;
    let sysvar = INSTRUCTIONS_SYSVAR_ID.to_bytes();
    let mut i = 0;
    while i < 32 {
        d[52 + i] = sysvar[i];
        i += 1;
    }
    // d[84] (is_signer) and d[85] (is_writable) stay 0.
    d
};

/// `ExtraAccountMetaList::size_of(2)`: TLV header (8 + 4), the count (4) and
/// two entries.
pub const META_LIST_LEN: usize = 8 + 4 + 4 + 2 * EXTRA_ACCOUNT_META_LEN;

/// Create the mint's ExtraAccountMetaList. Permissionless and
/// deterministic: the list always holds exactly the policy PDA and the
/// instructions sysvar.
///
/// Accounts: payer (signer, writable), extra_account_meta_list (writable,
/// PDA `[META_LIST_SEED, mint]`, created), mint, system_program.
fn initialize_extra_account_meta_list(mut accounts: Accounts) -> ProgramResult {
    log_instruction("Instruction: InitializeExtraAccountMetaList");
    let payer = accounts.signer(PAYER)?;
    let meta_list = accounts.next(None)?;
    let (mint, hook_program) = accounts.mint_with(MINT, |m| hook_program_id(m.tlv))?;
    accounts.program(&SYSTEM_PROGRAM_ID, SYSTEM_PROGRAM)?;

    // [A] extra_account_meta_list: init, payer = payer, space =
    // ExtraAccountMetaList::size_of(2)?, seeds = [META_LIST_SEED, mint],
    // bump (an `UncheckedAccount`: nothing is decoded after the creation);
    // then mut and rent exemption.
    let rent = Rent::get()?;
    let bump = check_seeds::<P>(
        meta_list,
        &[META_LIST_SEED, mint.address().as_ref()],
        &ID,
        EXTRA_ACCOUNT_META_LIST,
    )?;
    let bump_seed = [bump];
    create_account_or_fund_allocate_assign::<P>(
        payer,
        meta_list,
        META_LIST_LEN,
        &ID,
        &rent,
        &[Signer::from(&[
            Seed::from(META_LIST_SEED),
            Seed::from(mint.address().as_ref()),
            Seed::from(&bump_seed),
        ])],
    )?;
    check_mut::<P>(meta_list, EXTRA_ACCOUNT_META_LIST)?;
    check_rent_exempt::<P>(meta_list, &rent, EXTRA_ACCOUNT_META_LIST)?;
    // [A] payer: mut.
    check_mut::<P>(payer, PAYER)?;

    // Handler.
    require_our_hook(mint, hook_program)?;
    // `ExtraAccountMetaList::init` into the new (zeroed) account of exactly
    // this size.
    let mut list = *meta_list;
    let mut data = list.try_borrow_mut()?;
    let Some(entry) = data.get_mut(..META_LIST_LEN) else {
        return Err(ProgramError::InvalidAccountData);
    };
    entry.copy_from_slice(&META_LIST_DATA);
    Ok(())
}

// ----------------------------------------------------------- create_policy

/// Write the launch policy for a mint. Only the launchpad can sign. The
/// creator's rules, if any, must verify for this guard (`InvalidRules`).
///
/// Accounts: payer (signer, writable), launchpad_authority (signer, the
/// launchpad's `hook-authority` PDA), mint, pool (owned by DBC), policy
/// (writable, PDA `[POLICY_SEED, mint]`, created), system_program.
fn create_policy(mut accounts: Accounts, args: &[u8]) -> ProgramResult {
    log_instruction("Instruction: CreatePolicy");
    let Some(params) = PolicyParamsRef::parse(args) else {
        return Err(fail(INSTRUCTION_DID_NOT_DESERIALIZE, None));
    };

    // [A] `#[instruction(params: PolicyParams)]` decodes the same prefix
    // again in `try_accounts`: it decoded above.
    let payer = accounts.signer(PAYER)?;
    let launchpad_authority = accounts.signer(LAUNCHPAD_AUTHORITY)?;
    let (mint, (supply, hook_program)) =
        accounts.mint_with(MINT, |m| (m.supply(), hook_program_id(m.tlv)))?;
    let pool = accounts.unchecked(POOL)?;
    let policy = accounts.next(None)?;
    accounts.program(&SYSTEM_PROGRAM_ID, SYSTEM_PROGRAM)?;

    // [A] policy: init, payer = payer, space =
    // HookPolicy::space(params.rules.len()), seeds = [POLICY_SEED, mint],
    // bump; then mut and rent exemption.
    let rent = Rent::get()?;
    let bump = check_seeds::<P>(policy, &[POLICY_SEED, mint.address().as_ref()], &ID, POLICY)?;
    let bump_seed = [bump];
    let space = HookPolicy::space(params.rules.len());
    init_program_account::<P>(
        payer,
        policy,
        space,
        &rent,
        &[Signer::from(&[
            Seed::from(POLICY_SEED),
            Seed::from(mint.address().as_ref()),
            Seed::from(&bump_seed),
        ])],
        POLICY,
    )?;
    check_rent_exempt::<P>(policy, &rent, POLICY)?;

    // [A] payer: mut; launchpad_authority: seeds (the launchpad's PDA);
    // pool: owner = DBC_PROGRAM_ID @ InvalidPool (named, with the owner and
    // DBC's id).
    check_mut::<P>(payer, PAYER)?;
    check_launchpad_authority(launchpad_authority)?;
    check_keys::<P>(
        pool.owner(),
        &DBC_PROGRAM_ID,
        HookError::InvalidPool.code(),
        POOL,
    )?;

    // Handler.
    require_our_hook(mint, hook_program)?;
    let mint_key = mint.address();
    let (base_vault, _) = find_program_address(
        &[
            DBC_TOKEN_VAULT_SEED,
            mint_key.as_ref(),
            params.pool.as_ref(),
        ],
        &DBC_PROGRAM_ID,
    );
    if !same(pool.address(), &params.pool) {
        return Err(fail_keys(
            HookError::InvalidPool.code(),
            None,
            pool.address(),
            &params.pool,
        ));
    }

    let guard = params.guard_secs as i64;
    let shield = params.snipe_shield_secs as i64;
    if !(guard <= bounds::MAX_GUARD_SECS
        && shield <= bounds::MAX_SNIPE_SHIELD_SECS
        && shield <= guard
        && (params.max_wallet == 0 || params.max_wallet >= supply / bounds::MIN_MAX_WALLET_DIVISOR)
        && (params.max_buy == 0 || params.max_buy >= supply / bounds::MIN_MAX_BUY_DIVISOR))
    {
        return Err(hook(HookError::InvalidPolicy));
    }
    if !(params.rules.is_empty() || RuleSet::verify(params.rules, params.guard_secs).is_ok()) {
        return Err(hook(HookError::InvalidRules));
    }

    let now = Clock::get()?.unix_timestamp;
    let snipe_shield_end_ts = now
        .checked_add(shield)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    let guard_end_ts = now
        .checked_add(guard)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    sys::log_data(&event_data::policy_created(
        mint_key,
        &params.pool,
        snipe_shield_end_ts,
        guard_end_ts,
        params.max_wallet,
        params.max_buy,
        params.p2p_locked,
        params.rules.len() as u16,
    ));

    // Exit: the policy, as `HookPolicy::try_serialize` writes it.
    let mut account = *policy;
    let mut data = account.try_borrow_mut()?;
    write_policy(
        &mut data,
        &NewPolicy {
            bump,
            mint: mint_key,
            pool: &params.pool,
            base_vault: &base_vault,
            launch_ts: now,
            snipe_shield_end_ts,
            guard_end_ts,
            max_wallet: params.max_wallet,
            max_buy: params.max_buy,
            p2p_locked: params.p2p_locked,
            exempt: &params.exempt,
            rules: params.rules,
        },
    )
    .ok_or_else(|| fail(ACCOUNT_DID_NOT_SERIALIZE, Some(POLICY)))
}

// -------------------------------------------------------- end_snipe_shield

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
///
/// Accounts (the launchpad's CPI from `execute_batch`):
/// `[launchpad_authority (signer), policy (writable), instructions]`.
fn end_snipe_shield(mut accounts: Accounts) -> ProgramResult {
    log_instruction("Instruction: EndSnipeShield");
    let launchpad_authority = accounts.signer(LAUNCHPAD_AUTHORITY)?;
    // [A] policy: Box<Account<'info, HookPolicy>>: owned by this program,
    // HookPolicy's discriminator, every field decodes.
    let policy = accounts.next(Some(POLICY))?;
    let state = {
        let data = load_program_account::<P>(policy, &discriminator::HOOK_POLICY, Some(POLICY))?;
        PolicyKeys::read(&data).ok_or_else(|| fail(ACCOUNT_DID_NOT_DESERIALIZE, Some(POLICY)))?
    };
    let instructions = accounts.unchecked(INSTRUCTIONS)?;

    // [A] launchpad_authority: seeds (the launchpad's PDA). policy: seeds =
    // [POLICY_SEED, policy.mint], bump = policy.bump
    // (`create_program_address`), mut. instructions: address =
    // INSTRUCTIONS_SYSVAR_ID.
    check_launchpad_authority(launchpad_authority)?;
    check_seeds_with_bump::<P>(
        policy,
        &[POLICY_SEED, state.mint.as_ref(), &[state.bump]],
        &ID,
        POLICY,
    )?;
    check_mut::<P>(policy, POLICY)?;
    check_address::<P>(instructions, &INSTRUCTIONS_SYSVAR_ID, INSTRUCTIONS)?;

    // Handler.
    if !inside_execute_batch(instructions)? {
        return Err(hook(HookError::NotInBatch));
    }
    let now = Clock::get()?.unix_timestamp;
    let scheduled_end_ts = state.snipe_shield_end_ts;
    let snipe_shield_end_ts = rules::shield_end_after_batch(scheduled_end_ts, now);
    sys::log_data(&event_data::snipe_shield_ended(
        &state.mint,
        &state.pool,
        scheduled_end_ts,
        snipe_shield_end_ts,
    ));

    // Exit: the policy written back. Every other byte is what was read (a
    // Borsh decode and re-encode is the identity on what decoded), so only
    // `snipe_shield_end_ts` changes.
    write_back::<P, { layout::SNIPE_SHIELD_END_TS + 8 }>(policy, POLICY, |data| {
        data[layout::SNIPE_SHIELD_END_TS..].copy_from_slice(&snipe_shield_end_ts.to_le_bytes())
    })
}

// ----------------------------------------------------------------- execute

/// Token-2022 `Execute`: decide one transfer, as `rules::evaluate`
/// does. Sells and everything after the guard are decided from the
/// policy's head (`PolicyHead`) before the policy is decoded. Then the
/// built-in checks (`rules::built_ins`) read the source's owner, and the
/// destination's owner, balance and extensions (`has_immutable_owner`),
/// from their own account data; only a transfer they leave to the
/// creator rules, under a policy that has some, also reads the mint's
/// supply and the transaction's top-level instructions (`top_level`).
///
/// Accounts (the order the transfer-hook interface fixes, all unchecked):
/// source, mint, destination, authority, extra_account_meta_list, policy
/// (resolved by Token-2022 from the meta list; may be empty), instructions
/// (its address is checked when it is read: buys during the snipe shield,
/// and transfers that reach creator rules).
fn execute(mut accounts: Accounts, args: &[u8]) -> ProgramResult {
    log_instruction("Instruction: Execute");
    let Some(amount) = args.first_chunk::<8>() else {
        return Err(fail(INSTRUCTION_DID_NOT_DESERIALIZE, None));
    };
    let amount = u64::from_le_bytes(*amount);
    let source = accounts.unchecked(SOURCE)?;
    let mint = accounts.unchecked(MINT)?;
    let destination = accounts.unchecked(DESTINATION)?;
    accounts.unchecked(AUTHORITY)?;
    accounts.unchecked(EXTRA_ACCOUNT_META_LIST)?;
    let policy_info = accounts.unchecked(POLICY)?;
    let instructions = accounts.unchecked(INSTRUCTIONS)?;

    // Handler.
    // No Noised policy for this mint: nothing to enforce.
    if !owned_by(policy_info, &ID) || policy_info.is_data_empty() {
        return Ok(());
    }
    let data = policy_info.try_borrow()?;
    let head = PolicyHead::read(&data)?;
    if !same(&head.mint, mint.address()) {
        return Err(fail_keys(
            HookError::PolicyMismatch.code(),
            None,
            &head.mint,
            mint.address(),
        ));
    }

    let source_key = source.address();
    let destination_key = destination.address();
    let is_buy = same(source_key, &head.base_vault);
    // Sells, and zero transfers that are not buys, are decided from keys alone.
    if !is_buy && (same(destination_key, &head.base_vault) || amount == 0) {
        return Ok(());
    }
    let now = Clock::get()?.unix_timestamp;
    if now >= head.guard_end_ts {
        return Ok(());
    }
    let policy = PolicyView::read(&data).ok_or_else(|| fail(ACCOUNT_DID_NOT_DESERIALIZE, None))?;

    let in_batch =
        is_buy && now < policy.snipe_shield_end_ts && inside_execute_batch(instructions)?;
    let (destination_owner, destination_balance, destination_immutable_owner) = {
        let dest = destination.try_borrow()?;
        let (owner, balance) = owner_and_amount(&dest)?;
        (owner, balance, has_immutable_owner(&dest))
    };
    let (source_owner, _) = owner_and_amount(&source.try_borrow()?)?;
    let mut view = TransferView {
        now,
        amount,
        source: *source_key,
        source_owner,
        destination: *destination_key,
        destination_owner,
        destination_balance,
        destination_immutable_owner,
        in_batch,
        supply: 0,
        top_program: Pubkey::default(),
        tx_ix_count: 0,
    };
    let decision = match rules::built_ins(policy, &view) {
        Ok(Step::CreatorRules) if !policy.rules.is_empty() => {
            // Read only here: sells, claims, the batch buy and exempt
            // owners never pay for it.
            (view.top_program, view.tx_ix_count) = top_level(instructions)?;
            view.supply = mint_supply(&mint.try_borrow()?)?;
            rules::creator_rules(policy, &view)
        }
        Ok(_) => Ok(()),
        Err(refusal) => Err(refusal),
    };
    decision.map_err(refused)
}

/// The error of a refusal (`error!(HookError::..)`); a creator rule's is
/// logged first as `Launch rule <index> (code <code>) refused the transfer`.
#[cold]
#[inline(never)]
fn refused(refusal: Refusal) -> ProgramError {
    match refusal {
        Refusal::SnipeShield => hook(HookError::SnipeShield),
        Refusal::TransfersLocked => hook(HookError::TransfersLocked),
        Refusal::MaxBuy => hook(HookError::MaxBuy),
        Refusal::MaxWallet => hook(HookError::MaxWallet),
        Refusal::MutableOwner => hook(HookError::MutableOwner),
        Refusal::Rule(v) => {
            log_rule_refusal(v.rule, v.code);
            hook(HookError::RuleDenied)
        }
    }
}

/// `msg!("Launch rule {} (code {}) refused the transfer", rule, code)`,
/// from static pieces and the two numbers in decimal.
fn log_rule_refusal(rule: u8, code: u8) {
    let mut line = Line {
        bytes: [0; 64],
        len: 0,
    };
    line.push(b"Launch rule ");
    line.push_decimal(rule);
    line.push(b" (code ");
    line.push_decimal(code);
    line.push(b") refused the transfer");
    sys::log_bytes(line.bytes.get(..line.len).unwrap_or(&[]));
}

/// A log line assembled from pieces (at most 64 bytes; the rule line has
/// 47 at most).
struct Line {
    bytes: [u8; 64],
    len: usize,
}

impl Line {
    #[inline(never)]
    fn push(&mut self, piece: &[u8]) {
        for byte in piece {
            if let Some(slot) = self.bytes.get_mut(self.len) {
                *slot = *byte;
                self.len += 1;
            }
        }
    }

    /// `n` in decimal (`{}`).
    fn push_decimal(&mut self, n: u8) {
        let digits = [b'0' + n / 100, b'0' + n / 10 % 10, b'0' + n % 10];
        let skip = match n {
            100.. => 0,
            10.. => 1,
            _ => 2,
        };
        self.push(digits.get(skip..).unwrap_or(&[]));
    }
}

// ------------------------------------------------- the instructions sysvar

/// The instructions sysvar's data: `account` must be the sysvar
/// (`load_*_checked`: `UnsupportedSysvar`).
fn sysvar_data(account: &AccountView) -> Result<Ref<'_, [u8]>, ProgramError> {
    if !same(account.address(), &INSTRUCTIONS_SYSVAR_ID) {
        return Err(ProgramError::UnsupportedSysvar);
    }
    account.try_borrow()
}

/// `load_current_index`: the index of the currently executing top-level
/// instruction, the sysvar's trailing `u16` (the runtime always writes it;
/// shorter data, which the runtime never writes, is `InvalidArgument`
/// where solana-instructions-sysvar would panic).
fn current_index(data: &[u8]) -> Result<u16, ProgramError> {
    data.last_chunk::<2>()
        .map(|index| u16::from_le_bytes(*index))
        .ok_or(ProgramError::InvalidArgument)
}

/// `load_instruction_at_checked(index)`'s decoding
/// (`deserialize_instruction`): the program id and the data of top-level
/// instruction `index`. The sysvar holds the instruction count, a `u16`
/// offset per instruction, and at each offset the account count, 33 bytes
/// per account (flags, key), the program id, the data length and the data.
/// An index past the count, and any read past the end (every read of the
/// decoding fails with `SanitizeError::IndexOutOfBounds`), are
/// `InvalidArgument`.
fn instruction_at(data: &[u8], index: u16) -> Result<(&[u8; 32], &[u8]), ProgramError> {
    let u16_at = |at: usize| -> Option<usize> {
        data.get(at..)?
            .first_chunk::<2>()
            .map(|b| usize::from(u16::from_le_bytes(*b)))
    };
    let decode = || -> Option<(&[u8; 32], &[u8])> {
        let count = u16_at(0)?;
        let index = usize::from(index);
        if index >= count {
            return None;
        }
        let start = u16_at(2 + 2 * index)?;
        let accounts = u16_at(start)?;
        let program_at = start + 2 + 33 * accounts;
        let program_id = data.get(program_at..)?.first_chunk::<32>()?;
        let len = u16_at(program_at + 32)?;
        let ix_data = data.get(program_at + 34..)?.get(..len)?;
        Some((program_id, ix_data))
    };
    decode().ok_or(ProgramError::InvalidArgument)
}

/// Whether the transaction's currently executing top-level instruction is
/// the launchpad's `execute_batch`. That instruction makes exactly one DBC
/// swap, the launch's batch buy, so a buy inside it is the batch buy; it is
/// also the only launchpad instruction that ends a snipe shield. Other
/// programs cannot appear as that top-level instruction, and CPIs never do.
/// The sysvar's address is checked here (`load_*_checked`).
pub fn inside_execute_batch(instructions: &AccountView) -> Result<bool, ProgramError> {
    let data = sysvar_data(instructions)?;
    let index = current_index(&data)?;
    let (program_id, ix_data) = instruction_at(&data, index)?;
    Ok(*program_id == LAUNCHPAD_PROGRAM_ID.to_bytes()
        && ix_data.get(..8) == Some(&EXECUTE_BATCH_DISCRIMINATOR[..]))
}

/// The program of the transaction's currently executing top-level
/// instruction, and the number of top-level instructions (the sysvar's
/// leading `u16`). The sysvar's address is checked (`load_*_checked`).
pub fn top_level(instructions: &AccountView) -> Result<(Pubkey, u16), ProgramError> {
    let data = sysvar_data(instructions)?;
    let index = current_index(&data)?;
    let (program_id, _) = instruction_at(&data, index)?;
    let count = data
        .first_chunk::<2>()
        .ok_or(ProgramError::InvalidAccountData)?;
    Ok((
        Pubkey::new_from_array(*program_id),
        u16::from_le_bytes(*count),
    ))
}

// --------------------------------------------------------- token accounts

/// The supply of a mint in the base layout shared by SPL Token and
/// Token-2022 (`mint_authority` 0..36, `supply` 36..44); Token-2022 has
/// checked that this account is the transfer's mint.
pub fn mint_supply(data: &[u8]) -> Result<u64, ProgramError> {
    let supply = data
        .get(36..44)
        .and_then(|s| s.first_chunk::<8>())
        .ok_or(ProgramError::InvalidAccountData)?;
    Ok(u64::from_le_bytes(*supply))
}

/// Owner and amount from the base token-account layout shared by SPL Token
/// and Token-2022 (mint 0..32, owner 32..64, amount 64..72):
/// `MalformedTokenAccount` for fewer than 72 bytes.
pub fn owner_and_amount(data: &[u8]) -> Result<(Pubkey, u64), ProgramError> {
    let Some(base) = data.first_chunk::<72>() else {
        return Err(hook(HookError::MalformedTokenAccount));
    };
    let mut owner = [0u8; 32];
    owner.copy_from_slice(&base[32..64]);
    let mut amount = [0u8; 8];
    amount.copy_from_slice(&base[64..72]);
    Ok((Pubkey::new_from_array(owner), u64::from_le_bytes(amount)))
}

/// Token-2022's token-account layout past the base shared with SPL Token:
/// the 165-byte base account, then (with extensions) the account-type byte
/// and the TLV entries, each `u16le type || u16le length || value`.
pub const TOKEN_ACCOUNT_LEN: usize = 165;
/// `AccountType::Account`.
pub const ACCOUNT_TYPE_ACCOUNT: u8 = 2;
/// `ExtensionType::Uninitialized`: nothing is written after such an entry.
pub const EXTENSION_UNINITIALIZED: u16 = 0;
/// `ExtensionType::ImmutableOwner` (an entry with no value).
pub const EXTENSION_IMMUTABLE_OWNER: u16 = 7;

/// Whether token-account `data` has Token-2022's ImmutableOwner extension:
/// then Token-2022 refuses every `SetAuthority(AccountOwner)` on it. Reads
/// it as Token-2022 does (`get_extension`): the first ImmutableOwner entry
/// of the TLV entries, before any Uninitialized one, with an empty value.
/// Total: data that is short, not an account with extensions or cut inside
/// an entry has no such extension; nothing panics.
pub fn has_immutable_owner(data: &[u8]) -> bool {
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

#[cfg(test)]
mod tests {
    use anchor_lang::solana_program::instruction::BorrowedInstruction;
    use noised_onchain::host::{fuzz::Rng, HostAccount};
    use solana_instructions_sysvar::{
        construct_instructions_data, load_current_index_checked, load_instruction_at_checked,
        store_current_index_checked,
    };

    use super::*;

    fn key(b: u8) -> Pubkey {
        Pubkey::new_from_array([b; 32])
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

    /// An account at `address` holding `data`, as the runtime lays it out.
    fn account(address: &Pubkey, data: &[u8]) -> HostAccount {
        HostAccount::new(*address, Pubkey::default(), 1, data, false, false, false)
    }

    fn in_batch(address: &Pubkey, data: Vec<u8>) -> Result<bool, ProgramError> {
        inside_execute_batch(&account(address, &data).view())
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

    /// The Anchor build's `inside_execute_batch` and `top_level`, over
    /// solana-instructions-sysvar 3.0.1 (`load_*_checked`).
    fn anchor_reads(
        address: &Pubkey,
        data: &[u8],
    ) -> (
        Result<bool, ProgramError>,
        Result<(Pubkey, u16), ProgramError>,
    ) {
        use anchor_lang::solana_program::account_info::AccountInfo;
        let mut owned = data.to_vec();
        let (mut lamports, owner) = (1, Pubkey::default());
        let info = AccountInfo::new(
            address,
            false,
            false,
            &mut lamports,
            &mut owned,
            &owner,
            false,
        );
        let current = || -> Result<_, ProgramError> {
            let index = load_current_index_checked(&info)?;
            load_instruction_at_checked(usize::from(index), &info)
        };
        let batch = current().map(|ix| {
            ix.program_id == LAUNCHPAD_PROGRAM_ID
                && ix.data.get(..8) == Some(&EXECUTE_BATCH_DISCRIMINATOR[..])
        });
        let top = current().and_then(|ix| {
            let count = info
                .try_borrow_data()?
                .first_chunk::<2>()
                .copied()
                .ok_or(ProgramError::InvalidAccountData)?;
            Ok((ix.program_id, u16::from_le_bytes(count)))
        });
        (batch, top)
    }

    /// Whatever the sysvar holds (valid data with accounts and any current
    /// index, then truncated, extended or corrupted), the program reads the
    /// current top-level instruction exactly as solana-instructions-sysvar
    /// does: the same decision, the same program id and count, the same
    /// error. (Data shorter than the trailing index, which the runtime never
    /// writes, makes that crate panic: skipped.)
    #[test]
    fn the_sysvar_is_read_as_solana_instructions_sysvar_reads_it() {
        use anchor_lang::solana_program::instruction::AccountMeta;
        let mut r = Rng(3);
        let lp = LAUNCHPAD_PROGRAM_ID;
        let (mut batches, mut errors) = (0, 0);
        for round in 0..20_000 {
            let n = 1 + r.below(4) as usize;
            let programs: Vec<Pubkey> = (0..n)
                .map(|_| if r.chance(50) { lp } else { r.key() })
                .collect();
            let datas: Vec<Vec<u8>> = (0..n)
                .map(|_| {
                    let mut d = if r.chance(50) {
                        EXECUTE_BATCH_DISCRIMINATOR.to_vec()
                    } else {
                        Vec::new()
                    };
                    d.extend(r.some_bytes(12));
                    if r.chance(10) {
                        d.truncate(r.below(9) as usize);
                    }
                    d
                })
                .collect();
            let metas: Vec<Vec<AccountMeta>> = (0..n)
                .map(|_| {
                    (0..r.below(4))
                        .map(|_| AccountMeta {
                            pubkey: r.key(),
                            is_signer: r.chance(50),
                            is_writable: r.chance(50),
                        })
                        .collect()
                })
                .collect();
            let ixs: Vec<BorrowedInstruction> = (0..n)
                .map(|i| BorrowedInstruction {
                    program_id: &programs[i],
                    accounts: metas[i]
                        .iter()
                        .map(
                            |m| anchor_lang::solana_program::instruction::BorrowedAccountMeta {
                                pubkey: &m.pubkey,
                                is_signer: m.is_signer,
                                is_writable: m.is_writable,
                            },
                        )
                        .collect(),
                    data: &datas[i],
                })
                .collect();
            let mut data = construct_instructions_data(&ixs);
            let current = if r.chance(90) {
                r.below(n as u64) as u16
            } else {
                r.next() as u16
            };
            store_current_index_checked(&mut data, current).unwrap();
            match r.below(6) {
                0 => {
                    let keep = 2 + r.below(data.len() as u64 - 1) as usize;
                    let tail = data[data.len() - 2..].to_vec();
                    data.truncate(keep - 2);
                    data.extend(tail);
                }
                1 => {
                    let at = r.below(data.len() as u64) as usize;
                    data[at] = r.byte();
                }
                2 => data.splice(..0, r.some_bytes(3)).for_each(drop),
                _ => {}
            }
            let address = if r.chance(95) {
                INSTRUCTIONS_SYSVAR_ID
            } else {
                r.key()
            };
            let (batch, top) = anchor_reads(&address, &data);
            let host = account(&address, &data);
            assert_eq!(inside_execute_batch(&host.view()), batch, "round {round}");
            assert_eq!(top_level(&host.view()), top, "round {round}");
            batches += usize::from(batch == Ok(true));
            errors += usize::from(batch.is_err());
        }
        assert!(batches > 1_000 && errors > 1_000, "{batches} {errors}");
    }

    /// The meta list's bytes are `ExtraAccountMetaList::init::<ExecuteInstruction>`
    /// of the Anchor build's `canonical_metas()` into an account of
    /// `ExtraAccountMetaList::size_of(2)` bytes.
    #[test]
    fn the_meta_list_is_spl_tlv_account_resolutions() {
        use spl_tlv_account_resolution::{
            account::ExtraAccountMeta, seeds::Seed as MetaSeed, state::ExtraAccountMetaList,
        };
        use spl_transfer_hook_interface::instruction::ExecuteInstruction;
        let metas = [
            ExtraAccountMeta::new_with_seeds(
                &[
                    MetaSeed::Literal {
                        bytes: POLICY_SEED.to_vec(),
                    },
                    MetaSeed::AccountKey { index: 1 },
                ],
                false,
                false,
            )
            .unwrap(),
            ExtraAccountMeta::new_with_pubkey(&INSTRUCTIONS_SYSVAR_ID, false, false).unwrap(),
        ];
        let size = ExtraAccountMetaList::size_of(2).unwrap();
        assert_eq!(size, META_LIST_LEN);
        let mut want = vec![0u8; size];
        ExtraAccountMetaList::init::<ExecuteInstruction>(&mut want, &metas).unwrap();
        assert_eq!(META_LIST_DATA.to_vec(), want);
    }

    /// `msg!("Launch rule {} (code {}) refused the transfer", rule, code)`
    /// for every pair.
    #[test]
    fn the_rule_refusal_line_is_the_anchor_builds() {
        let _ = noised_onchain::sys::take_logs();
        for rule in 0..=u8::MAX {
            for code in [0u8, 7, 9, 10, 42, 63, 99, 100, 254, 255] {
                log_rule_refusal(rule, code);
                assert_eq!(
                    noised_onchain::host::take_log_lines(),
                    vec![format!(
                        "Program log: Launch rule {rule} (code {code}) refused the transfer"
                    )]
                );
            }
        }
    }

    /// Dispatch as Anchor's `entry` / `dispatch` and the handlers' prologue:
    /// the declared id, the discriminators (the transfer-hook interface's
    /// `InitializeExtraAccountMetaList` is not one of them: no fallback),
    /// the event-CPI stub, `Instruction: <Name>`, then the arguments, then
    /// the accounts (a missing one named after its field).
    #[test]
    fn dispatch_and_prologue_are_anchors() {
        use noised_onchain::host::take_log_lines;
        let custom = ProgramError::Custom;
        let run = |program: &Pubkey, data: &[u8]| {
            let _ = take_log_lines();
            let result = process_instruction(program, &mut [], data);
            (result, take_log_lines())
        };
        let line = |text: &str| format!("Program log: {text}");

        let (r, logs) = run(&key(1), &discriminator::EXECUTE);
        assert_eq!(r, Err(custom(4100)));
        assert!(logs[0].contains("Error Code: DeclaredProgramIdMismatch. Error Number: 4100."));
        for short in [&[][..], &[1, 2, 3], &discriminator::EXECUTE[..7]] {
            assert_eq!(run(&ID, short).0, Err(custom(101)));
        }
        let spl_init = [43, 34, 13, 49, 167, 88, 235, 235];
        let (r, logs) = run(&ID, &spl_init);
        assert_eq!(r, Err(custom(101)));
        assert!(logs[0].contains("Error Code: InstructionFallbackNotFound. Error Number: 101."));
        assert_eq!(
            run(&ID, &discriminator::EVENT_IX_TAG_LE).0,
            Err(custom(1500))
        );

        // execute(amount: u64): 7 bytes do not decode.
        let (r, logs) = run(&ID, &[&discriminator::EXECUTE[..], &[0; 7]].concat());
        assert_eq!(r, Err(custom(102)));
        assert_eq!(logs[0], line("Instruction: Execute"));
        assert!(logs[1].starts_with(
            "Program log: AnchorError occurred. Error Code: InstructionDidNotDeserialize."
        ));
        // Eight bytes decode; the first account is missing.
        let (r, logs) = run(&ID, &[&discriminator::EXECUTE[..], &[0; 8]].concat());
        assert_eq!(r, Err(custom(3005)));
        assert!(logs[1].starts_with(
            "Program log: AnchorError caused by account: source. Error Code: AccountNotEnoughKeys."
        ));
        for (disc, name) in [
            (
                discriminator::INITIALIZE_EXTRA_ACCOUNT_META_LIST,
                "InitializeExtraAccountMetaList",
            ),
            (discriminator::END_SNIPE_SHIELD, "EndSnipeShield"),
        ] {
            let (r, logs) = run(&ID, &disc);
            assert_eq!(r, Err(custom(3005)), "{name}");
            assert_eq!(logs[0], line(&format!("Instruction: {name}")));
        }
        // create_policy decodes its argument before any account.
        let (r, logs) = run(&ID, &discriminator::CREATE_POLICY);
        assert_eq!(r, Err(custom(102)));
        assert_eq!(logs[0], line("Instruction: CreatePolicy"));
    }

    /// `owner_and_amount` and `mint_supply` read the base layouts, with the
    /// Anchor build's errors.
    #[test]
    fn base_layouts_and_their_errors() {
        let mut data = vec![0u8; 165];
        data[32..64].copy_from_slice(&[7; 32]);
        data[64..72].copy_from_slice(&123u64.to_le_bytes());
        assert_eq!(owner_and_amount(&data), Ok((key(7), 123)));
        assert_eq!(owner_and_amount(&data[..72]), Ok((key(7), 123)));
        assert_eq!(
            owner_and_amount(&data[..71]),
            Err(ProgramError::Custom(
                HookError::MalformedTokenAccount.code()
            ))
        );
        let mut mint = vec![0u8; 82];
        mint[36..44].copy_from_slice(&u64::MAX.to_le_bytes());
        assert_eq!(mint_supply(&mint), Ok(u64::MAX));
        assert_eq!(mint_supply(&mint[..44]), Ok(u64::MAX));
        assert_eq!(
            mint_supply(&mint[..43]),
            Err(ProgramError::InvalidAccountData)
        );
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

//! The program. Each instruction (`crate::instructions::*`) runs exactly
//! what the Anchor 1.2.1 build generated for it, in the same order, so every
//! input fails (or succeeds) the same way:
//!
//! 1. `Instruction: <Name>` is logged, then the arguments are decoded
//!    (Borsh; trailing bytes ignored): `InstructionDidNotDeserialize`.
//! 2. The accounts are taken in order and checked by type (`Signer`,
//!    `Account<T>`, `InterfaceAccount<T>`, `Program<T>`, `Option<T>`); a
//!    missing account is `AccountNotEnoughKeys`.
//! 3. The `init` / `init_if_needed` accounts are created (or loaded) and
//!    checked, in field order.
//! 4. The writable `Account` / `InterfaceAccount` fields must be distinct
//!    (`ConstraintDuplicateMutableAccount`).
//! 5. Every other field's constraints, field by field, each in Anchor's
//!    order: seeds, associated token, mut, has_one, raw, executable,
//!    address, token.
//! 6. The handler.
//! 7. Exit: the writable program accounts are written back, in field order,
//!    after every CPI of the handler.
//!
//! The comments `[A]` name the Anchor constraint each check implements.
//! The helpers here are out of line on purpose: each instruction calls them
//! many times, and one copy keeps the program small.

use noised_onchain::{
    accounts::{check_keys, check_mut, check_rent_exempt, is_missing, load_program_account},
    args,
    cpi::create_account_or_fund_allocate_assign,
    ids::SYSTEM_PROGRAM_ID,
    owned_by, pda, sys,
    sysvar::Rent,
    token::TokenAccount,
    AccountView, Address, ProgramError, ProgramResult, Seed, Signer,
};

use crate::{
    discriminator,
    error::{anchor::*, fail, fail_keys, raise, LaunchpadError},
    instructions,
    program::NoisedLaunchpad,
    state::{Launch, LaunchData, LaunchStatus},
    Pubkey,
};

/// The program the shared checks log and compare with.
pub type P = NoisedLaunchpad;

/// The program entrypoint's instruction processor.
pub fn process_instruction(
    program_id: &Address,
    accounts: &mut [AccountView],
    data: &[u8],
) -> ProgramResult {
    // [A] try_entry: the declared id; dispatch: the 8-byte discriminator
    // prefix; the event-CPI tag is a stub without `event-cpi`; anything else
    // has no fallback.
    let (tag, args) = args::instruction::<P>(program_id, data)?;
    let accounts = Accounts::new(accounts);
    // The discriminator as one little-endian word: one comparison each.
    const fn word(discriminator: [u8; 8]) -> u64 {
        u64::from_le_bytes(discriminator)
    }
    const INITIALIZE_PROTOCOL: u64 = word(discriminator::INITIALIZE_PROTOCOL);
    const CREATE_LAUNCH: u64 = word(discriminator::CREATE_LAUNCH);
    const PUBLISH_METADATA: u64 = word(discriminator::PUBLISH_METADATA);
    const PUBLISH_RULES: u64 = word(discriminator::PUBLISH_RULES);
    const ATTEST_LAUNCH: u64 = word(discriminator::ATTEST_LAUNCH);
    const PQ_AUTHORIZE: u64 = word(discriminator::PQ_AUTHORIZE);
    const LAUNCH: u64 = word(discriminator::LAUNCH);
    const COMMIT: u64 = word(discriminator::COMMIT);
    const EXECUTE_BATCH: u64 = word(discriminator::EXECUTE_BATCH);
    const CLAIM: u64 = word(discriminator::CLAIM);
    const CLAIM_FEES: u64 = word(discriminator::CLAIM_FEES);
    const CLAIM_SURPLUS: u64 = word(discriminator::CLAIM_SURPLUS);
    const CLAIM_LP_FEES: u64 = word(discriminator::CLAIM_LP_FEES);
    const DISTRIBUTE: u64 = word(discriminator::DISTRIBUTE);
    match u64::from_le_bytes(*tag) {
        INITIALIZE_PROTOCOL => instructions::initialize_protocol::process(accounts, args),
        CREATE_LAUNCH => instructions::create_launch::process(accounts, args),
        PUBLISH_METADATA => instructions::publish_metadata::process(accounts, args),
        PUBLISH_RULES => instructions::publish_rules::process(accounts, args),
        ATTEST_LAUNCH => instructions::attest_launch::process(accounts, args),
        PQ_AUTHORIZE => instructions::pq_authorize::process(accounts, args),
        LAUNCH => instructions::launch::process(accounts),
        COMMIT => instructions::commit::process(accounts, args),
        EXECUTE_BATCH => instructions::execute_batch::process(accounts),
        CLAIM => instructions::claim::process(accounts, args),
        CLAIM_FEES => instructions::claim_fees::process_claim_fees(accounts),
        CLAIM_SURPLUS => instructions::claim_fees::process_claim_surplus(accounts),
        CLAIM_LP_FEES => instructions::claim_lp_fees::process(accounts),
        DISTRIBUTE => instructions::distribute::process(accounts),
        _ => Err(args::unknown::<P>(tag)),
    }
}

/// `msg!("Instruction: <Name>")`, unless built with `no-log-ix-name`.
#[inline(always)]
pub fn log_instruction(_name: &str) {
    #[cfg(not(feature = "no-log-ix-name"))]
    sys::log(_name);
}

/// The arguments do not decode: `InstructionDidNotDeserialize`, logged
/// with no account.
#[cold]
#[inline(never)]
pub fn did_not_deserialize() -> ProgramError {
    fail(INSTRUCTION_DID_NOT_DESERIALIZE, None)
}

// --------------------------------------------------------- the account list

/// The instruction's accounts, taken in order (`try_accounts`): each field
/// checked by its type (`noised_onchain::accounts::Accounts`, out of line).
pub struct Accounts<'a> {
    inner: noised_onchain::accounts::Accounts<'a, P>,
}

impl<'a> Accounts<'a> {
    #[inline(always)]
    pub fn new(accounts: &'a [AccountView]) -> Self {
        Self {
            inner: noised_onchain::accounts::Accounts::new(accounts),
        }
    }

    /// The accounts not taken (`ctx.remaining_accounts`).
    #[inline(always)]
    pub fn remaining(&self) -> &'a [AccountView] {
        self.inner.remaining()
    }

    /// `Signer<'info>`.
    #[inline(never)]
    pub fn signer(&mut self, name: &'static str) -> Result<&'a AccountView, ProgramError> {
        self.inner.signer(name)
    }

    /// `UncheckedAccount<'info>`.
    #[inline(never)]
    pub fn unchecked(&mut self, name: &'static str) -> Result<&'a AccountView, ProgramError> {
        self.inner.unchecked(name)
    }

    /// An `init` / `init_if_needed` field: taken raw (a missing account
    /// names no field).
    #[inline(never)]
    pub fn init(&mut self) -> Result<&'a AccountView, ProgramError> {
        self.inner.next(None)
    }

    /// `Option<T>`: the program id in its place is `None` (`name` is `None`
    /// for an `init_if_needed` field).
    #[inline(never)]
    pub fn optional(
        &mut self,
        name: Option<&'static str>,
    ) -> Result<Option<&'a AccountView>, ProgramError> {
        self.inner.optional(name)
    }

    /// `Program<'info, T>`.
    #[inline(never)]
    pub fn program(
        &mut self,
        id: &Pubkey,
        name: &'static str,
    ) -> Result<&'a AccountView, ProgramError> {
        self.inner.program(id, name)
    }

    /// `InterfaceAccount<'info, Mint>`: its decimals.
    #[inline(never)]
    pub fn mint(&mut self, name: &'static str) -> Result<(&'a AccountView, u8), ProgramError> {
        self.inner.mint(name)
    }

    /// `InterfaceAccount<'info, TokenAccount>`: its mint, owner and amount.
    #[inline(never)]
    pub fn token_account(
        &mut self,
        name: &'static str,
    ) -> Result<(&'a AccountView, TokenAccount), ProgramError> {
        self.inner.token_account(name)
    }

    /// `Account<'info, T>` of the type with this discriminator whose fields
    /// `decodes` (else `AccountDidNotDeserialize`): checked as
    /// `Account::try_from` checks it. The caller reads the fields.
    #[inline(never)]
    pub fn account(
        &mut self,
        discriminator: &[u8; 8],
        decodes: fn(&[u8]) -> bool,
        name: &'static str,
    ) -> Result<&'a AccountView, ProgramError> {
        let account = self.inner.next(Some(name))?;
        check_account(account, discriminator, decodes, Some(name))?;
        Ok(account)
    }

    /// `Account<'info, Launch>`: the account and its bytes.
    #[inline(never)]
    pub fn launch(&mut self) -> Result<(&'a AccountView, LaunchData), ProgramError> {
        let account = self.account(&discriminator::LAUNCH_ACCOUNT, LaunchData::decodes, LAUNCH)?;
        let data = account.try_borrow()?;
        Ok((account, LaunchData::copy_from(&data)))
    }
}

/// `Account::try_from` on an existing account (errors named `name`): it
/// exists, the program owns it, it starts with `discriminator` and its fields
/// decode (`AccountDidNotDeserialize`).
#[inline(never)]
pub fn check_account(
    account: &AccountView,
    discriminator: &[u8; 8],
    decodes: fn(&[u8]) -> bool,
    name: Option<&'static str>,
) -> ProgramResult {
    let data = load_program_account::<P>(account, discriminator, name)?;
    if !decodes(&data) {
        return Err(fail(ACCOUNT_DID_NOT_DESERIALIZE, name));
    }
    Ok(())
}

// ------------------------------------------------------------- constraints

/// [A] `constraint = cond @ e` on the field `name`: `e`, named.
#[inline(never)]
pub fn require_named(ok: bool, e: LaunchpadError, name: &'static str) -> ProgramResult {
    if !ok {
        return Err(fail(e.code(), Some(name)));
    }
    Ok(())
}

/// [A] `has_one = target @ e` or `address = expected @ e`: `e` caused by
/// `name`, with both keys (the field's value, then the target's).
#[inline(never)]
pub fn require_keys_named(
    left: &Pubkey,
    right: &Pubkey,
    e: LaunchpadError,
    name: &'static str,
) -> ProgramResult {
    check_keys::<P>(left, right, e.code(), name)
}

/// [A] `address = expected @ AccountMismatch`.
#[inline(never)]
pub fn check_address_mismatch(
    account: &AccountView,
    expected: &Pubkey,
    name: &'static str,
) -> ProgramResult {
    require_keys_named(
        account.address(),
        expected,
        LaunchpadError::AccountMismatch,
        name,
    )
}

/// [A] `address = program @ AccountMismatch, executable`: executable first
/// (`ConstraintExecutable`), then the address.
#[inline(never)]
pub fn check_program_address(
    account: &AccountView,
    program: &Pubkey,
    name: &'static str,
) -> ProgramResult {
    if !account.executable() {
        return Err(fail(CONSTRAINT_EXECUTABLE, Some(name)));
    }
    check_address_mismatch(account, program, name)
}

/// [A] `constraint = launch.status == status @ WrongLaunchState`.
#[inline(never)]
pub fn check_status(launch: &LaunchData, status: LaunchStatus) -> ProgramResult {
    require_named(
        launch.status() == status as u8,
        LaunchpadError::WrongLaunchState,
        LAUNCH,
    )
}

/// [A] `has_one = <field> @ AccountMismatch` on `launch`: the launch's
/// field at offset `at`, then the account's key.
#[inline(never)]
pub fn launch_has_one(launch: &LaunchData, at: usize, account: &AccountView) -> ProgramResult {
    require_keys_named(
        &launch.key(at),
        account.address(),
        LaunchpadError::AccountMismatch,
        LAUNCH,
    )
}

/// [A] `seeds = [...], bump` (`find_program_address`): `ConstraintSeeds`
/// with the given and derived keys. Returns the bump.
#[inline(never)]
pub fn check_seeds(
    account: &AccountView,
    seeds: &[&[u8]],
    name: &'static str,
) -> Result<u8, ProgramError> {
    pda::check_seeds::<P>(account, seeds, &crate::ID, name)
}

/// [A] `seeds = [...], bump = <stored>` (`create_program_address`): invalid
/// seeds are `ConstraintSeeds` (no keys), another address `ConstraintSeeds`
/// with both keys.
#[inline(never)]
pub fn check_seeds_with_bump(
    account: &AccountView,
    seeds_with_bump: &[&[u8]],
    name: &'static str,
) -> ProgramResult {
    pda::check_seeds_with_bump::<P>(account, seeds_with_bump, &crate::ID, name)
}

/// [A] `mut`.
#[inline(never)]
pub fn check_writable(account: &AccountView, name: &'static str) -> ProgramResult {
    check_mut::<P>(account, name)
}

/// Logs `"<label><n>"`, `n` in decimal (`label` at most 12 bytes).
#[inline(never)]
fn log_number(label: &[u8], n: u64) {
    // The digits from the end of `line` backwards (at most 20), then the
    // label just before them.
    let mut line = [0u8; 32];
    let mut at = line.len();
    let mut rest = n;
    loop {
        at = at.wrapping_sub(1);
        if let Some(slot) = line.get_mut(at) {
            *slot = b'0' + (rest % 10) as u8;
        }
        rest /= 10;
        if rest == 0 {
            break;
        }
    }
    let start = at.saturating_sub(label.len());
    if let Some(slot) = line.get_mut(start..at) {
        for (out, byte) in slot.iter_mut().zip(label) {
            *out = *byte;
        }
    }
    sys::log_bytes(line.get(start..).unwrap_or(&[]));
}

/// Anchor's error `code` on the field `name`, then the two compared numbers
/// (`with_values`: `Left: <left>`, `Right: <right>`), as
/// `noised_onchain::error::fail_values` logs them.
#[cold]
#[inline(never)]
fn fail_values(code: u32, name: &'static str, left: u64, right: u64) -> ProgramError {
    let e = fail(code, Some(name));
    log_number(b"Left: ", left);
    log_number(b"Right: ", right);
    e
}

/// [A] `init_if_needed, payer, space, seeds = [...], bump` of a program
/// account with this discriminator whose fields `decodes` (the seeds were
/// checked; `signer_seeds` end with the bump), as
/// `noised_onchain::accounts::init_if_needed_program_account` and the
/// field's `mut` and rent exemption: an account still owned by the system
/// program is created (`create_account_or_fund_allocate_assign`, then
/// `Account::try_from_unchecked`); any other is loaded as `Account::try_from`
/// (its errors name the field, as Anchor's `with_account_name` does) and
/// must have exactly `space` bytes
/// (`ConstraintSpace`), be owned by the program (`ConstraintOwner`) and hold
/// the rent-exempt minimum for `space` (`ConstraintRentExempt`). Then `mut`
/// and rent exemption. Returns whether the account existed (anyone may have
/// created it first: never assume it is new).
#[allow(clippy::too_many_arguments)]
#[inline(never)]
pub fn init_if_needed(
    payer: &AccountView,
    account: &AccountView,
    space: usize,
    rent: &Rent,
    signer_seeds: &[Seed],
    name: &'static str,
    discriminator: &[u8; 8],
    decodes: fn(&[u8]) -> bool,
) -> Result<bool, ProgramError> {
    if owned_by(account, &SYSTEM_PROGRAM_ID) {
        init(payer, account, space, rent, signer_seeds, name)?;
        return Ok(false);
    }
    check_account(account, discriminator, decodes, Some(name))?;
    if account.data_len() != space {
        return Err(fail_values(
            CONSTRAINT_SPACE,
            name,
            space as u64,
            account.data_len() as u64,
        ));
    }
    if !owned_by(account, &crate::ID) {
        return Err(fail_keys(
            CONSTRAINT_OWNER,
            Some(name),
            account.owner(),
            &crate::ID,
        ));
    }
    if account.lamports() < rent.minimum_balance(space) {
        return Err(fail(CONSTRAINT_RENT_EXEMPT, Some(name)));
    }
    check_mut::<P>(account, name)?;
    check_rent_exempt::<P>(account, rent, name)?;
    Ok(true)
}

/// `Account::try_from_unchecked` on an account just created (its errors
/// name the field, as Anchor's `init` names them): it exists, the program
/// owns it, and it holds at least `space` bytes (its all-zero fields
/// decode).
#[inline(never)]
pub fn check_created(account: &AccountView, space: usize, name: &'static str) -> ProgramResult {
    if is_missing(account) {
        return Err(fail(ACCOUNT_NOT_INITIALIZED, Some(name)));
    }
    if !owned_by(account, &crate::ID) {
        return Err(fail_keys(
            ACCOUNT_OWNED_BY_WRONG_PROGRAM,
            Some(name),
            account.owner(),
            &crate::ID,
        ));
    }
    if account.data_len() < space {
        return Err(fail(ACCOUNT_DID_NOT_DESERIALIZE, Some(name)));
    }
    Ok(())
}

/// [A] `init, payer, space, seeds = [...], bump` of a program account (the
/// seeds were checked; `signer_seeds` end with the bump):
/// `create_account_or_fund_allocate_assign`, `Account::try_from_unchecked`,
/// then `mut` and rent exemption.
#[inline(never)]
pub fn init(
    payer: &AccountView,
    account: &AccountView,
    space: usize,
    rent: &Rent,
    signer_seeds: &[Seed],
    name: &'static str,
) -> ProgramResult {
    create_account_or_fund_allocate_assign::<P>(
        payer,
        account,
        space,
        &crate::ID,
        rent,
        &[Signer::from(signer_seeds)],
    )?;
    check_created(account, space, name)?;
    check_mut::<P>(account, name)?;
    check_rent_exempt::<P>(account, rent, name)
}

/// [A] exit of a writable program account: `bytes` (its discriminator and
/// fields, or a prefix of them that changed) written at the start of its
/// data (`AccountDidNotSerialize` when they do not fit), unless the account
/// was closed (owned by the system program, no data).
#[inline(always)]
pub fn write_back(account: &AccountView, name: &'static str, bytes: &[u8]) -> ProgramResult {
    write_back_parts(account, name, &[bytes])
}

/// [`write_back`] of `parts` back to back.
#[inline(never)]
pub fn write_back_parts(
    account: &AccountView,
    name: &'static str,
    parts: &[&[u8]],
) -> ProgramResult {
    if owned_by(account, &SYSTEM_PROGRAM_ID) && account.is_data_empty() {
        return Ok(());
    }
    let len = parts.iter().map(|part| part.len()).sum();
    let mut handle = *account;
    let mut data = handle.try_borrow_mut()?;
    match data.get_mut(..len) {
        Some(out) => {
            fill(out, parts);
            Ok(())
        }
        None => Err(fail(ACCOUNT_DID_NOT_SERIALIZE, Some(name))),
    }
}

/// `parts` back to back into `out` (exactly their total length).
fn fill(out: &mut [u8], parts: &[&[u8]]) {
    let mut at = 0;
    for part in parts {
        let end = at + part.len();
        if let Some(slot) = out.get_mut(at..end) {
            slot.copy_from_slice(part);
        }
        at = end;
    }
}

/// [A] exit of the launch account: its bytes.
#[inline(always)]
pub fn write_back_launch(account: &AccountView, launch: &LaunchData) -> ProgramResult {
    write_back(account, LAUNCH, &launch.0)
}

/// `parts` back to back, in one allocation.
#[inline(never)]
pub fn concat(parts: &[&[u8]]) -> alloc::vec::Vec<u8> {
    let mut out = alloc::vec![0u8; parts.iter().map(|part| part.len()).sum()];
    fill(&mut out, parts);
    out
}

/// `checked_add` / `checked_sub` overflow: `MathOverflow`.
#[cold]
#[inline(never)]
pub fn math_overflow() -> ProgramError {
    raise(LaunchpadError::MathOverflow)
}

/// `require!(cond, e)` in a handler: `e`, no account.
#[inline(never)]
pub fn require(ok: bool, e: LaunchpadError) -> ProgramResult {
    if !ok {
        return Err(raise(e));
    }
    Ok(())
}

/// The `Launch` account size, for `init`.
pub const LAUNCH_LEN: usize = Launch::LEN;

// Account field names shared by several instructions, as Anchor names them.
pub const LAUNCH: &str = "launch";
pub const PAYER: &str = "payer";
pub const SYSTEM_PROGRAM: &str = "system_program";
pub const TOKEN_PROGRAM: &str = "token_program";
pub const TOKEN_2022_PROGRAM: &str = "token_2022_program";
pub const ASSOCIATED_TOKEN_PROGRAM: &str = "associated_token_program";
pub const QUOTE_MINT: &str = "quote_mint";
pub const BASE_MINT: &str = "base_mint";
pub const DBC_POOL_AUTHORITY_FIELD: &str = "dbc_pool_authority";
pub const DBC_PROGRAM: &str = "dbc_program";
pub const DBC_EVENT_AUTHORITY_FIELD: &str = "dbc_event_authority";
pub const DBC_CONFIG: &str = "dbc_config";
pub const LAUNCH_AUTHORITY: &str = "launch_authority";
pub const BATCH_AUTHORITY: &str = "batch_authority";
pub const POOL: &str = "pool";
pub const BASE_VAULT: &str = "base_vault";
pub const QUOTE_VAULT: &str = "quote_vault";
pub const HOOK_PROGRAM: &str = "hook_program";
pub const HOOK_AUTHORITY: &str = "hook_authority";
pub const IDENTITY: &str = "identity";

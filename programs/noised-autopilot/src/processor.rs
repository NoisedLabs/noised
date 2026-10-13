//! The program. Each instruction ([`crate::instructions`]) runs exactly what
//! the Anchor 1.2.1 build generated for it, in the same order, so every
//! input fails (or succeeds) the same way:
//!
//! 1. `Instruction: <Name>` is logged, then the arguments are decoded
//!    (Borsh; trailing bytes ignored): `InstructionDidNotDeserialize`.
//! 2. The accounts are taken in order and checked by type (`Signer`,
//!    `Option<Signer>`, `Account<T>`, `InterfaceAccount<T>`, `Program<T>`);
//!    a missing account is `AccountNotEnoughKeys`.
//! 3. The `init` / `init_if_needed` accounts are created and checked.
//! 4. The writable `Account` / `InterfaceAccount` fields must be distinct
//!    (`ConstraintDuplicateMutableAccount`).
//! 5. Every other field's constraints, field by field, each in Anchor's
//!    order: seeds, associated token, mut, raw (with the program's error),
//!    address, token, mint.
//! 6. The handler.
//! 7. Exit: the `Autopilot` (and `publish_graph`'s record) is written back,
//!    after every CPI of the handler.
//!
//! The comments `[A]` name the Anchor constraint each check implements
//! (the Anchor source is kept verbatim in `anchor/`).

use noised_onchain::{
    accounts::{check_mut, write_back},
    args, owned_by,
    pda::check_seeds_with_bump,
    sys,
};
use pinocchio::{cpi::Seed, AccountView, Address, ProgramResult};

use crate::{
    constants::{AUTOPILOT_SEED, GRAPH_SEED, TREASURY_SEED},
    discriminator,
    error::{anchor::ACCOUNT_OWNED_BY_WRONG_PROGRAM, fail},
    instructions,
    program::NoisedAutopilot,
    state::Autopilot,
    ProgramError, ID,
};

/// The program the shared checks log and compare with.
pub(crate) type P = NoisedAutopilot;

/// The instruction's accounts, taken in order (`try_accounts`).
pub(crate) type Accounts<'a> = noised_onchain::accounts::Accounts<'a, P>;

// Account field names, as Anchor names them in errors.
pub(crate) const PAYER: &str = "payer";
pub(crate) const LAUNCH: &str = "launch";
pub(crate) const DBC_CONFIG: &str = "dbc_config";
pub(crate) const AUTOPILOT: &str = "autopilot";
pub(crate) const TREASURY: &str = "treasury";
pub(crate) const WSOL_MINT_FIELD: &str = "wsol_mint";
pub(crate) const TREASURY_WSOL: &str = "treasury_wsol";
pub(crate) const TOKEN_PROGRAM: &str = "token_program";
pub(crate) const ASSOCIATED_TOKEN_PROGRAM: &str = "associated_token_program";
pub(crate) const SYSTEM_PROGRAM: &str = "system_program";
pub(crate) const CERTIFICATE: &str = "certificate";
pub(crate) const MINT: &str = "mint";
pub(crate) const TREASURY_TOKEN: &str = "treasury_token";
pub(crate) const TOKEN_2022_PROGRAM: &str = "token_2022_program";
pub(crate) const DAMM_CONFIG: &str = "damm_config";
pub(crate) const DAMM_POOL: &str = "damm_pool";
pub(crate) const GRAPH: &str = "graph";
pub(crate) const AUTHORIZATION: &str = "authorization";
pub(crate) const CALLER: &str = "caller";
pub(crate) const OPERATOR: &str = "operator";
pub(crate) const TIP_ACCOUNT: &str = "tip_account";

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
    // The discriminators as integers: one load, then plain compares.
    const fn word(discriminator: [u8; 8]) -> u64 {
        u64::from_le_bytes(discriminator)
    }
    const INIT_AUTOPILOT: u64 = word(discriminator::INIT_AUTOPILOT);
    const BIND_MINT: u64 = word(discriminator::BIND_MINT);
    const BIND_POOL: u64 = word(discriminator::BIND_POOL);
    const PUBLISH_GRAPH: u64 = word(discriminator::PUBLISH_GRAPH);
    const ACTIVATE: u64 = word(discriminator::ACTIVATE);
    const APPLY_PENDING: u64 = word(discriminator::APPLY_PENDING);
    const FREEZE: u64 = word(discriminator::FREEZE);
    const REVOKE_OPERATOR: u64 = word(discriminator::REVOKE_OPERATOR);
    const RUN: u64 = word(discriminator::RUN);
    const UPDATE_PRICE: u64 = word(discriminator::UPDATE_PRICE);
    match u64::from_le_bytes(*tag) {
        INIT_AUTOPILOT => instructions::init_autopilot::init_autopilot(accounts),
        BIND_MINT => instructions::bind_mint::bind_mint(accounts),
        BIND_POOL => instructions::bind_pool::bind_pool(accounts),
        PUBLISH_GRAPH => instructions::publish_graph::publish_graph(accounts, args),
        ACTIVATE => instructions::governance::activate(accounts, args),
        APPLY_PENDING => instructions::governance::apply_pending(accounts),
        FREEZE => instructions::governance::freeze(accounts, args),
        REVOKE_OPERATOR => instructions::governance::revoke_operator(accounts),
        RUN => instructions::run::run(accounts, args),
        UPDATE_PRICE => instructions::update_price::update_price(accounts),
        _ => Err(args::unknown::<P>(tag)),
    }
}

/// `msg!("Instruction: <Name>")`, unless built with `no-log-ix-name`.
#[inline(always)]
pub(crate) fn log_instruction(_name: &str) {
    #[cfg(not(feature = "no-log-ix-name"))]
    sys::log(_name);
}

/// `Clock::get()?.unix_timestamp`.
#[inline(never)]
pub(crate) fn now() -> Result<i64, ProgramError> {
    Ok(noised_onchain::sysvar::Clock::get()?.unix_timestamp)
}

// ------------------------------------------------------------- constraints

/// [A] `seeds = [AUTOPILOT_SEED, <launch>], bump = autopilot.bump`
/// (`create_program_address`), then `mut`: the autopilot fields of every
/// instruction but `init_autopilot`. `launch` is the `launch` account's key
/// or the stored `autopilot.launch`, as each instruction names it.
#[inline(never)]
pub(crate) fn check_autopilot(
    autopilot: &AccountView,
    state: &Autopilot,
    launch: &Address,
) -> ProgramResult {
    check_seeds_with_bump::<P>(
        autopilot,
        &[AUTOPILOT_SEED, launch.as_ref(), &[state.bump]],
        &ID,
        AUTOPILOT,
    )?;
    check_mut::<P>(autopilot, AUTOPILOT)
}

/// [A] `seeds = [GRAPH_SEED, <launch>, <graph hash>], bump = graph.bump`
/// (`create_program_address`).
#[inline(never)]
pub(crate) fn check_graph(
    graph: &AccountView,
    launch: &Address,
    hash: &[u8; 32],
    bump: u8,
) -> ProgramResult {
    check_seeds_with_bump::<P>(
        graph,
        &[GRAPH_SEED, launch.as_ref(), hash, &[bump]],
        &ID,
        GRAPH,
    )
}

/// [A] `seeds = [TREASURY_SEED, <launch>], bump = autopilot.treasury_bump`
/// (`create_program_address`).
#[inline(never)]
pub(crate) fn check_treasury(treasury: &AccountView, launch: &Address, bump: u8) -> ProgramResult {
    check_seeds_with_bump::<P>(
        treasury,
        &[TREASURY_SEED, launch.as_ref(), &[bump]],
        &ID,
        TREASURY,
    )
}

/// [A] the raw constraint `cond @ e` on the autopilot field: `e` caused by
/// `autopilot`.
#[inline(always)]
pub(crate) fn check_autopilot_constraint(
    ok: bool,
    e: crate::error::AutopilotError,
) -> ProgramResult {
    if !ok {
        return Err(fail(e.code(), Some(AUTOPILOT)));
    }
    Ok(())
}

// --------------------------------------------------------------------- exit

/// [A] exit: the `Autopilot` serialized back into its account
/// (`AccountDidNotSerialize` if shorter; skipped once closed, which never
/// happens).
#[inline(never)]
pub(crate) fn write_autopilot(autopilot: &AccountView, state: &Autopilot) -> ProgramResult {
    write_back::<P, { Autopilot::LEN }>(autopilot, AUTOPILOT, |data| state.write(data))
}

// ------------------------------------------------------------------ signing

/// The treasury authority's signer seeds `[TREASURY_SEED, launch, [bump]]`.
pub(crate) struct TreasurySeeds<'a> {
    launch: &'a Address,
    bump: [u8; 1],
}

impl<'a> TreasurySeeds<'a> {
    #[inline(always)]
    pub(crate) fn new(launch: &'a Address, bump: u8) -> Self {
        Self {
            launch,
            bump: [bump],
        }
    }

    /// The seeds, for a `Signer`.
    #[inline(always)]
    pub(crate) fn seeds(&self) -> [Seed<'_>; 3] {
        [
            Seed::from(TREASURY_SEED),
            Seed::from(self.launch.as_ref()),
            Seed::from(&self.bump),
        ]
    }
}

// ------------------------------------------------------------ token reads

/// The amount of a token account, read again after a CPI changed it
/// (`StateWithExtensions::<Account>::unpack`, its errors as they are).
#[inline(never)]
pub(crate) fn token_amount(account: &AccountView) -> Result<u64, ProgramError> {
    let data = account.try_borrow()?;
    Ok(noised_onchain::token::unpack_token_account(&data)?.amount())
}

/// `InterfaceAccount<TokenAccount>::reload`: owned by a token program
/// (`AccountOwnedByWrongProgram`, naming no account), then unpacked again.
#[inline(never)]
pub(crate) fn reload_amount(account: &AccountView) -> Result<u64, ProgramError> {
    use noised_onchain::ids::{TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID};
    if !owned_by(account, &TOKEN_PROGRAM_ID) && !owned_by(account, &TOKEN_2022_PROGRAM_ID) {
        return Err(fail(ACCOUNT_OWNED_BY_WRONG_PROGRAM, None));
    }
    token_amount(account)
}

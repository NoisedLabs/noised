//! The program. Each instruction runs exactly what the Anchor 1.2.1 build
//! generated for it (the source is kept in `anchor/`), in the same order, so
//! every input fails (or succeeds) the same way:
//!
//! 1. `Instruction: <Name>` is logged, then the arguments are decoded
//!    (Borsh; trailing bytes ignored): `InstructionDidNotDeserialize`.
//! 2. The accounts are taken in order and checked by type (`Signer`,
//!    `Account<Shield>`, `InterfaceAccount<Mint | TokenAccount>`,
//!    `Interface<TokenInterface>`, `Program<T>`); a missing account is
//!    `AccountNotEnoughKeys`.
//! 3. The `init` / `init_if_needed` accounts are created and checked.
//! 4. The writable `Account` / `InterfaceAccount` fields must be distinct
//!    (`ConstraintDuplicateMutableAccount`).
//! 5. Every other field's constraints, field by field, each in Anchor's
//!    order: seeds, mut, has_one, raw, token, mint.
//! 6. The handler.
//! 7. Exit: the new `Shield` is written (after every CPI of the handler).
//!
//! The comments `[A]` name the Anchor constraint each check implements.

use noised_onchain::{
    accounts::{
        check_constraint, check_distinct, check_has_one, check_mut, check_rent_exempt,
        init_program_account, write_back,
    },
    args, owned_by,
    pda::{check_seeds, check_seeds_with_bump},
    same, sys,
    sysvar::{Clock, Rent},
    token::{
        burn_checked, check_mint_token_program, check_token_authority, check_token_mint,
        check_token_token_program, init_associated_token_account, mint_to_checked,
        transfer_checked, AssociatedToken, Mint, TokenAccount,
    },
};
use pinocchio::{
    cpi::{Seed, Signer},
    error::ProgramError,
    AccountView, Address, ProgramResult,
};

use crate::{
    discriminator,
    error::{shield as shield_error, ShieldError},
    event_data,
    metadata::{derive, ZMetadata},
    policy::{extension_name, inspect_token_2022_mint, Rejection},
    program::NoisedShield,
    state::{Shield, SHIELD_AUTHORITY_SEED, SHIELD_SEED, Z_MINT_SEED},
    token::{
        reload_amount, reload_supply, require_backed, ASSOCIATED_TOKEN_PROGRAM_ID,
        SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
    },
    zmint::{self, ZMintAccounts},
    Buf, ID,
};

/// The program the shared checks log and compare with.
type P = NoisedShield;

/// The instruction's accounts, taken in order (`try_accounts`).
type Accounts<'a> = noised_onchain::accounts::Accounts<'a, P>;

// Account field names, as Anchor names them in errors.
const PAYER: &str = "payer";
const USER: &str = "user";
const BASE_MINT: &str = "base_mint";
const SHIELD: &str = "shield";
const SHIELD_AUTHORITY: &str = "shield_authority";
const Z_MINT: &str = "z_mint";
const ESCROW: &str = "escrow";
const USER_BASE: &str = "user_base";
const USER_Z: &str = "user_z";
const BASE_TOKEN_PROGRAM: &str = "base_token_program";
const TOKEN_2022_PROGRAM: &str = "token_2022_program";
const ASSOCIATED_TOKEN_PROGRAM: &str = "associated_token_program";
const SYSTEM_PROGRAM: &str = "system_program";

/// The program entrypoint's instruction processor.
pub fn process_instruction(
    program_id: &Address,
    accounts: &mut [AccountView],
    data: &[u8],
) -> ProgramResult {
    // [A] try_entry: the declared id; dispatch: the 8-byte discriminator
    // prefix; the event-CPI tag is a stub without `event-cpi`; anything else
    // has no fallback.
    const CREATE_SHIELD: u64 = u64::from_le_bytes(discriminator::CREATE_SHIELD);
    const WRAP: u64 = u64::from_le_bytes(discriminator::WRAP);
    const UNWRAP: u64 = u64::from_le_bytes(discriminator::UNWRAP);
    let (tag, args) = args::instruction::<P>(program_id, data)?;
    let accounts = Accounts::new(accounts);
    // The discriminator as one word: three compares, not 24.
    match u64::from_le_bytes(*tag) {
        CREATE_SHIELD => create_shield(accounts),
        WRAP => exchange(accounts, args, Direction::Wrap),
        UNWRAP => exchange(accounts, args, Direction::Unwrap),
        _ => Err(args::unknown::<P>(tag)),
    }
}

/// `msg!("Instruction: <Name>")`, unless built with `no-log-ix-name`.
fn log_instruction(_name: &str) {
    #[cfg(not(feature = "no-log-ix-name"))]
    sys::log(_name);
}

// ------------------------------------------------------------ create_shield

/// Create the shield, zToken mint and escrow for `base_mint`.
/// Permissionless; fails if a shield for this base mint already exists.
///
/// Accounts: payer (signer, writable), base_mint, shield (writable, PDA
/// `[SHIELD_SEED, base_mint]`, created), shield_authority (PDA
/// `[SHIELD_AUTHORITY_SEED, base_mint]`), z_mint (writable, PDA
/// `[Z_MINT_SEED, base_mint]`, created in the handler), escrow (writable,
/// ATA(shield_authority, base_mint, base_token_program), created if
/// missing), base_token_program, token_2022_program,
/// associated_token_program, system_program.
#[inline(never)]
fn create_shield(mut accounts: Accounts) -> ProgramResult {
    log_instruction("Instruction: CreateShield");
    // No arguments: `instruction::CreateShield` decodes from any data.

    let payer = accounts.signer(PAYER)?;
    let (base_mint, (decimals, _)) = accounts.mint_with(BASE_MINT, decimals_and_supply)?;
    let shield = accounts.next(None)?;
    let shield_authority = accounts.unchecked(SHIELD_AUTHORITY)?;
    let z_mint = accounts.unchecked(Z_MINT)?;
    let escrow = accounts.next(None)?;
    let base_token_program = accounts.token_program(BASE_TOKEN_PROGRAM)?;
    let token_2022_program = program(&mut accounts, &TOKEN_2022_PROGRAM_ID, TOKEN_2022_PROGRAM)?;
    program(
        &mut accounts,
        &ASSOCIATED_TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM,
    )?;
    let system_program = program(&mut accounts, &SYSTEM_PROGRAM_ID, SYSTEM_PROGRAM)?;
    let base_mint_key = base_mint.address().as_ref();

    // [A] shield: init, payer = payer, space = 8 + Shield::INIT_SPACE,
    // seeds = [SHIELD_SEED, base_mint], bump; then mut and rent exemption.
    let rent = Rent::get()?;
    let bump = check_pda(shield, SHIELD_SEED, base_mint, SHIELD)?;
    let bump_seed = [bump];
    init_program_account::<P>(
        payer,
        shield,
        Shield::LEN,
        &rent,
        &[Signer::from(&[
            Seed::from(SHIELD_SEED),
            Seed::from(base_mint_key),
            Seed::from(&bump_seed),
        ])],
        SHIELD,
    )?;
    check_rent_exempt::<P>(shield, &rent, SHIELD)?;

    // [A] escrow: init_if_needed, payer = payer, associated_token::mint =
    // base_mint, associated_token::authority = shield_authority,
    // associated_token::token_program = base_token_program; then mut and
    // rent exemption. Anyone can create this ATA first, which must not
    // block the shield.
    init_associated_token_account::<P, true>(
        &AssociatedToken {
            payer,
            account: escrow,
            authority: shield_authority,
            mint: base_mint,
            token_program: base_token_program,
            system_program,
        },
        &rent,
        ESCROW,
    )?;

    // [A] duplicate mutable accounts: escrow is the only candidate (shield
    // is a plain init). Then payer: mut; base_mint: mint::token_program =
    // base_token_program; shield_authority: seeds = [SHIELD_AUTHORITY_SEED,
    // base_mint], bump; z_mint: seeds = [Z_MINT_SEED, base_mint], bump, mut.
    check_mut::<P>(payer, PAYER)?;
    check_mint_token_program::<P>(base_mint, base_token_program)?;
    let authority_bump = check_pda(
        shield_authority,
        SHIELD_AUTHORITY_SEED,
        base_mint,
        SHIELD_AUTHORITY,
    )?;
    let z_mint_bump = check_pda(z_mint, Z_MINT_SEED, base_mint, Z_MINT)?;
    check_mut::<P>(z_mint, Z_MINT)?;

    // Handler. SPL Token mints have no extensions and no embedded metadata.
    let meta = base_mint_metadata(base_mint)?;
    let authority_bump_seed = [authority_bump];
    let authority_seeds = [
        Seed::from(SHIELD_AUTHORITY_SEED),
        Seed::from(base_mint_key),
        Seed::from(&authority_bump_seed),
    ];
    let z_mint_bump_seed = [z_mint_bump];
    let z_mint_seeds = [
        Seed::from(Z_MINT_SEED),
        Seed::from(base_mint_key),
        Seed::from(&z_mint_bump_seed),
    ];
    zmint::create(
        &ZMintAccounts {
            payer,
            z_mint,
            shield_authority,
            token_2022_program,
        },
        decimals,
        &meta,
        &[Signer::from(&z_mint_seeds)],
        &[Signer::from(&authority_seeds)],
    )?;
    zmint::verify(z_mint, shield_authority.address(), decimals, &meta)?;

    // `verify` proved the supply is 0. A pre-existing escrow (anyone can
    // create an ATA) may already hold donated tokens: allowed surplus.
    require_backed(reload_amount(escrow)?, 0)?;

    let state = Shield {
        version: Shield::VERSION,
        bump,
        authority_bump,
        z_mint_bump,
        decimals,
        base_mint: *base_mint.address(),
        base_token_program: *base_token_program.address(),
        z_mint: *z_mint.address(),
        escrow: *escrow.address(),
        created_at: Clock::get()?.unix_timestamp,
    };
    sys::log_data(
        event_data::shield_created(
            shield.address(),
            &state.base_mint,
            &state.base_token_program,
            &state.z_mint,
            &state.escrow,
            decimals,
            meta.name.as_bytes(),
            meta.symbol.as_bytes(),
            meta.uri.as_bytes(),
            payer.address(),
        )
        .as_slice(),
    );

    // Exit: the new shield is written.
    write_back::<P, { Shield::LEN }>(shield, SHIELD, |data| state.write(data))
}

/// The zToken metadata: from a Token-2022 base mint's own (canonical)
/// metadata after the extension allowlist; generic for SPL Token mints.
fn base_mint_metadata(base_mint: &AccountView) -> Result<ZMetadata, ProgramError> {
    if !owned_by(base_mint, &TOKEN_2022_PROGRAM_ID) {
        return Ok(derive(None, base_mint.address()));
    }
    let data = base_mint.try_borrow()?;
    inspect_token_2022_mint(&data, base_mint.address()).map_err(reject)
}

/// The error (and log line) of a refused base mint.
#[cold]
#[inline(never)]
fn reject(r: Rejection) -> ProgramError {
    match r {
        Rejection::Malformed => shield_error(ShieldError::MalformedBaseMint),
        Rejection::Unsupported(extension_type) => {
            // msg!("Base mint extension not accepted: {:?}", ext)
            let mut line = Buf::<64>::new();
            line.put_all(&[
                b"Base mint extension not accepted: ",
                extension_name(extension_type),
            ]);
            sys::log_bytes(line.as_slice());
            shield_error(ShieldError::UnsupportedExtension)
        }
        Rejection::Unknown => {
            sys::log("Base mint has an extension type this program does not know");
            shield_error(ShieldError::UnsupportedExtension)
        }
    }
}

// --------------------------------------------------- shared account checks

/// What the handlers read from an `InterfaceAccount<Mint>`. One function
/// for every mint field, so `Accounts::mint_with` exists once in the
/// program.
fn decimals_and_supply(mint: &Mint) -> (u8, u64) {
    (mint.decimals(), mint.supply())
}

/// [A] `Program<T>`, out of line (one copy for every such field).
#[inline(never)]
fn program<'a>(
    accounts: &mut Accounts<'a>,
    id: &Address,
    name: &'static str,
) -> Result<&'a AccountView, ProgramError> {
    accounts.program(id, name)
}

/// [A] `seeds = [seed, base_mint], bump`: `find_program_address`
/// (`ConstraintSeeds`, with both keys); the canonical bump.
#[inline(never)]
fn check_pda(
    account: &AccountView,
    seed: &[u8],
    base_mint: &AccountView,
    name: &'static str,
) -> Result<u8, ProgramError> {
    check_seeds::<P>(account, &[seed, base_mint.address().as_ref()], &ID, name)
}

/// [A] `seeds = [seed, base_mint], bump = bump`: `create_program_address`
/// (`ConstraintSeeds`: invalid seeds without keys, another address with
/// both).
#[inline(never)]
fn check_pda_with_bump(
    account: &AccountView,
    seed: &[u8],
    base_mint: &AccountView,
    bump: u8,
    name: &'static str,
) -> ProgramResult {
    check_seeds_with_bump::<P>(
        account,
        &[seed, base_mint.address().as_ref(), &[bump]],
        &ID,
        name,
    )
}

/// [A] `token::mint = mint, token::token_program = token_program`, in that
/// order (`ConstraintTokenMint`, `ConstraintTokenTokenProgram`, both with
/// keys).
#[inline(never)]
fn check_token_mint_and_program(
    account: &AccountView,
    state: &TokenAccount,
    mint: &AccountView,
    token_program: &AccountView,
    name: &'static str,
) -> ProgramResult {
    check_token_mint::<P>(state, mint.address(), name)?;
    check_token_token_program::<P>(account, token_program, name)
}

// ------------------------------------------------------------ wrap, unwrap

/// The accounts of `wrap` and `unwrap` (the same list, the same
/// constraints), with what the handlers read from them at load time.
struct Exchange<'a> {
    user: &'a AccountView,
    shield: &'a AccountView,
    authority_bump: u8,
    shield_authority: &'a AccountView,
    base_mint: &'a AccountView,
    base_decimals: u8,
    z_mint: &'a AccountView,
    z_decimals: u8,
    z_supply: u64,
    escrow: &'a AccountView,
    escrow_amount: u64,
    user_base: &'a AccountView,
    user_z: &'a AccountView,
    base_token_program: &'a AccountView,
    token_2022_program: &'a AccountView,
    remaining: &'a [AccountView],
}

/// [A] `try_accounts` of `Wrap` / `Unwrap`: user (Signer), shield
/// (`Account<Shield>`), shield_authority, base_mint, z_mint
/// (`InterfaceAccount<Mint>`), escrow, user_base, user_z
/// (`InterfaceAccount<TokenAccount>`), base_token_program
/// (`Interface<TokenInterface>`), token_2022_program (`Program<Token2022>`),
/// then:
///
/// * duplicate mutable accounts: z_mint, escrow, user_base, user_z;
/// * shield: `seeds = [SHIELD_SEED, base_mint], bump = shield.bump`,
///   `has_one` = base_mint, base_token_program, z_mint, escrow;
/// * shield_authority: `seeds = [SHIELD_AUTHORITY_SEED, base_mint], bump =
///   shield.authority_bump`;
/// * base_mint: `mint::token_program = base_token_program`;
/// * z_mint: `mut`, `mint::token_program = token_2022_program`;
/// * escrow: `mut`, `token::authority = shield_authority`, `token::mint =
///   base_mint`, `token::token_program = base_token_program`;
/// * user_base: `mut`, `constraint = user_base != escrow @ SameAccount`,
///   `token::mint = base_mint`, `token::token_program = base_token_program`;
/// * user_z: `mut`, `token::mint = z_mint`, `token::token_program =
///   token_2022_program`.
#[inline(never)]
fn load_exchange<'a>(mut accounts: Accounts<'a>) -> Result<Exchange<'a>, ProgramError> {
    let user = accounts.signer(USER)?;
    let (shield, state) = accounts.account::<Shield>(SHIELD)?;
    let shield_authority = accounts.unchecked(SHIELD_AUTHORITY)?;
    let (base_mint, (base_decimals, _)) = accounts.mint_with(BASE_MINT, decimals_and_supply)?;
    let (z_mint, (z_decimals, z_supply)) = accounts.mint_with(Z_MINT, decimals_and_supply)?;
    let (escrow, escrow_state) = accounts.token_account(ESCROW)?;
    let (user_base, user_base_state) = accounts.token_account(USER_BASE)?;
    let (user_z, user_z_state) = accounts.token_account(USER_Z)?;
    let base_token_program = accounts.token_program(BASE_TOKEN_PROGRAM)?;
    let token_2022_program = program(&mut accounts, &TOKEN_2022_PROGRAM_ID, TOKEN_2022_PROGRAM)?;

    check_distinct::<P>(&[
        (z_mint, Z_MINT),
        (escrow, ESCROW),
        (user_base, USER_BASE),
        (user_z, USER_Z),
    ])?;
    check_pda_with_bump(shield, SHIELD_SEED, base_mint, state.bump, SHIELD)?;
    check_has_one::<P>(&state.base_mint, base_mint, SHIELD)?;
    check_has_one::<P>(&state.base_token_program, base_token_program, SHIELD)?;
    check_has_one::<P>(&state.z_mint, z_mint, SHIELD)?;
    check_has_one::<P>(&state.escrow, escrow, SHIELD)?;
    check_pda_with_bump(
        shield_authority,
        SHIELD_AUTHORITY_SEED,
        base_mint,
        state.authority_bump,
        SHIELD_AUTHORITY,
    )?;
    check_mint_token_program::<P>(base_mint, base_token_program)?;
    check_mut::<P>(z_mint, Z_MINT)?;
    check_mint_token_program::<P>(z_mint, token_2022_program)?;
    // escrow: mut, token::authority, token::mint, token::token_program.
    check_mut::<P>(escrow, ESCROW)?;
    check_token_authority::<P>(&escrow_state, shield_authority.address(), ESCROW)?;
    check_token_mint_and_program(escrow, &escrow_state, base_mint, base_token_program, ESCROW)?;
    // user_base: mut, the raw constraint, token::mint, token::token_program.
    check_mut::<P>(user_base, USER_BASE)?;
    check_constraint::<P>(
        !same(user_base.address(), escrow.address()),
        ShieldError::SameAccount.code(),
        USER_BASE,
    )?;
    check_token_mint_and_program(
        user_base,
        &user_base_state,
        base_mint,
        base_token_program,
        USER_BASE,
    )?;
    // user_z: mut, token::mint, token::token_program.
    check_mut::<P>(user_z, USER_Z)?;
    check_token_mint_and_program(user_z, &user_z_state, z_mint, token_2022_program, USER_Z)?;

    Ok(Exchange {
        user,
        shield,
        authority_bump: state.authority_bump,
        shield_authority,
        base_mint,
        base_decimals,
        z_mint,
        z_decimals,
        z_supply,
        escrow,
        escrow_amount: escrow_state.amount,
        user_base,
        user_z,
        base_token_program,
        token_2022_program,
        remaining: accounts.remaining(),
    })
}

/// `wrap(amount: u64)` / `unwrap(amount: u64)`: the amount (Borsh; trailing
/// bytes ignored), else `InstructionDidNotDeserialize`.
pub fn parse_amount(args: &[u8]) -> Result<u64, ProgramError> {
    args::decode::<P, _>(args, |r| r.u64())
}

/// Which of the two instructions on the shared accounts.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Direction {
    Wrap,
    Unwrap,
}

/// `wrap` and `unwrap`, which take the same accounts with the same
/// constraints ([`load_exchange`]); each direction runs exactly its Anchor
/// handler.
///
/// `wrap(amount)`: lock `amount` base tokens in the escrow and mint zTokens
/// equal to what the escrow actually received (less than `amount` under a
/// transfer fee). `unwrap(amount)`: burn `amount` zTokens from the user's
/// (public) zToken balance and release `amount` base tokens from the
/// escrow; a base-mint transfer fee is charged to the unwrapper.
/// Transfer-hook accounts of the base mint go in remaining accounts.
///
/// Accounts: user (signer; owner or delegate of `user_base` for `wrap`, of
/// `user_z` for `unwrap`), shield, shield_authority, base_mint, z_mint
/// (writable), escrow (writable), user_base (writable; any base token
/// account), user_z (writable; any zToken account), base_token_program,
/// token_2022_program; then the base mint's transfer-hook accounts.
#[inline(never)]
fn exchange(accounts: Accounts, args: &[u8], direction: Direction) -> ProgramResult {
    let wrap = direction == Direction::Wrap;
    log_instruction(if wrap {
        "Instruction: Wrap"
    } else {
        "Instruction: Unwrap"
    });
    let amount = parse_amount(args)?;
    let x = load_exchange(accounts)?;

    // Handler.
    if amount == 0 {
        return Err(shield_error(ShieldError::ZeroAmount));
    }
    let escrow_before = x.escrow_amount;
    let supply_before = x.z_supply;
    // The shield authority signs as the zToken's mint authority (wrap) and
    // as the escrow's owner (unwrap): [SHIELD_AUTHORITY_SEED, base_mint,
    // shield.authority_bump].
    let bump = [x.authority_bump];
    let seeds = [
        Seed::from(SHIELD_AUTHORITY_SEED),
        Seed::from(x.base_mint.address().as_ref()),
        Seed::from(&bump),
    ];
    let authority = [Signer::from(&seeds)];

    let mismatch = || shield_error(ShieldError::AccountingMismatch);
    let event = if wrap {
        transfer_checked(
            x.base_token_program,
            x.user_base,
            x.base_mint,
            x.escrow,
            x.user,
            amount,
            x.base_decimals,
            &[],
            x.remaining,
        )?;
        let escrow_balance = reload_amount(x.escrow)?;
        let received = escrow_balance
            .checked_sub(escrow_before)
            .ok_or_else(mismatch)?;
        if received == 0 {
            return Err(shield_error(ShieldError::NothingReceived));
        }
        mint_to_checked(
            x.token_2022_program,
            x.z_mint,
            x.user_z,
            x.shield_authority,
            received,
            x.z_decimals,
            &authority,
        )?;
        let z_supply = reload_supply(x.z_mint)?;
        let minted = z_supply.checked_sub(supply_before).ok_or_else(mismatch)?;
        if minted != received {
            return Err(mismatch());
        }
        require_backed(escrow_balance, z_supply)?;
        event_data::wrapped(
            x.shield.address(),
            x.base_mint.address(),
            x.user.address(),
            amount,
            minted,
            z_supply,
            escrow_balance,
        )
    } else {
        burn_checked(
            x.token_2022_program,
            x.user_z,
            x.z_mint,
            x.user,
            amount,
            x.z_decimals,
            &[],
        )?;
        transfer_checked(
            x.base_token_program,
            x.escrow,
            x.base_mint,
            x.user_base,
            x.shield_authority,
            amount,
            x.base_decimals,
            &authority,
            x.remaining,
        )?;
        let escrow_balance = reload_amount(x.escrow)?;
        let z_supply = reload_supply(x.z_mint)?;
        let burned = supply_before.checked_sub(z_supply).ok_or_else(mismatch)?;
        let released = escrow_before
            .checked_sub(escrow_balance)
            .ok_or_else(mismatch)?;
        if burned != amount || released != amount {
            return Err(mismatch());
        }
        require_backed(escrow_balance, z_supply)?;
        event_data::unwrapped(
            x.shield.address(),
            x.base_mint.address(),
            x.user.address(),
            amount,
            z_supply,
            escrow_balance,
        )
    };
    sys::log_data(event.as_slice());
    Ok(())
}

//! The instruction's accounts and Anchor's account constraints.
//!
//! Anchor's generated `try_accounts` runs, in this order (`PORTING.md` has
//! the full mapping):
//!
//! 1. Each field in declaration order, checked by its type ([`Accounts`]):
//!    a missing account is `AccountNotEnoughKeys` (3005).
//! 2. The `init` / `init_if_needed` fields, in order
//!    ([`init_program_account`], [`init_if_needed_program_account`],
//!    `token::init_associated_token_account`).
//! 3. The writable `Account` / `InterfaceAccount` fields must be distinct
//!    ([`check_distinct`], 2040).
//! 4. Every other field's constraints, field by field, each in the order
//!    seeds, associated token, mut, signer, has_one, raw, owner, rent exempt,
//!    executable, close, address, token, mint.
//!
//! Then the handler, then exit: the writable program accounts are written
//! back in field order ([`write_back`]) and `close` fields closed
//! ([`close`]).

use core::marker::PhantomData;

use pinocchio::{
    account::Ref, cpi::Signer, error::ProgramError, AccountView, Address, ProgramResult,
};

use crate::{
    cpi::create_account_or_fund_allocate_assign,
    error::{anchor::*, fail, fail_keys, fail_values},
    ids::{SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID},
    owned_by, same,
    sysvar::Rent,
    token::{self, Mint, TokenAccount, TokenAccountState},
    Program,
};

/// A program account type (Anchor's `#[account]`): the 8-byte
/// discriminator, then the fields in Borsh.
pub trait ProgramAccount: Sized {
    /// `sha256("account:<Name>")[..8]`.
    const ACCOUNT_DISCRIMINATOR: [u8; 8];

    /// The fields, decoded from the account data (discriminator included,
    /// already checked). `None` when the data does not decode
    /// (`AccountDidNotDeserialize`), e.g. is too short; bytes after the
    /// fields are ignored, as Borsh deserialization from a slice ignores
    /// them.
    fn try_read(data: &[u8]) -> Option<Self>;
}

/// The instruction's accounts, taken in order (`try_accounts`). `P` is the
/// program: its id and the error table the checks log with.
pub struct Accounts<'a, P> {
    rest: &'a [AccountView],
    program: PhantomData<P>,
}

impl<'a, P: Program> Accounts<'a, P> {
    #[inline]
    pub fn new(accounts: &'a [AccountView]) -> Self {
        Self {
            rest: accounts,
            program: PhantomData,
        }
    }

    /// The accounts not taken yet (`ctx.remaining_accounts`).
    #[inline]
    pub fn remaining(&self) -> &'a [AccountView] {
        self.rest
    }

    /// The next account, or `AccountNotEnoughKeys` named after the field
    /// (`None` for `init` / `zero` fields, whose missing account Anchor
    /// does not name).
    #[inline]
    pub fn next(&mut self, name: Option<&'static str>) -> Result<&'a AccountView, ProgramError> {
        match self.rest.split_first() {
            Some((first, rest)) => {
                self.rest = rest;
                Ok(first)
            }
            None => Err(fail::<P>(ACCOUNT_NOT_ENOUGH_KEYS, name)),
        }
    }

    /// `Option<T>` fields: the program id in the account's place means
    /// `None`. A missing account is still `AccountNotEnoughKeys`.
    #[inline]
    pub fn optional(
        &mut self,
        name: Option<&'static str>,
    ) -> Result<Option<&'a AccountView>, ProgramError> {
        let account = self.next(name)?;
        Ok((!same(account.address(), &P::ID)).then_some(account))
    }

    /// `UncheckedAccount<'info>` / `AccountInfo<'info>`.
    #[inline]
    pub fn unchecked(&mut self, name: &'static str) -> Result<&'a AccountView, ProgramError> {
        self.next(Some(name))
    }

    /// `Signer<'info>`: `AccountNotSigner`.
    #[inline]
    pub fn signer(&mut self, name: &'static str) -> Result<&'a AccountView, ProgramError> {
        let account = self.next(Some(name))?;
        if !account.is_signer() {
            return Err(fail::<P>(ACCOUNT_NOT_SIGNER, Some(name)));
        }
        Ok(account)
    }

    /// `SystemAccount<'info>`: owned by the system program
    /// (`AccountNotSystemOwned`).
    #[inline]
    pub fn system_account(&mut self, name: &'static str) -> Result<&'a AccountView, ProgramError> {
        let account = self.next(Some(name))?;
        if !owned_by(account, &SYSTEM_PROGRAM_ID) {
            return Err(fail::<P>(ACCOUNT_NOT_SYSTEM_OWNED, Some(name)));
        }
        Ok(account)
    }

    /// `Program<'info, T>`: exactly `id` (`InvalidProgramId`, with the given
    /// and the expected keys), executable (`InvalidProgramExecutable`).
    #[inline]
    pub fn program(
        &mut self,
        id: &Address,
        name: &'static str,
    ) -> Result<&'a AccountView, ProgramError> {
        let account = self.next(Some(name))?;
        if !same(account.address(), id) {
            return Err(fail_keys::<P>(
                INVALID_PROGRAM_ID,
                Some(name),
                account.address(),
                id,
            ));
        }
        if !account.executable() {
            return Err(fail::<P>(INVALID_PROGRAM_EXECUTABLE, Some(name)));
        }
        Ok(account)
    }

    /// `Interface<'info, TokenInterface>`: SPL Token or Token-2022
    /// (`InvalidProgramId`, no keys), executable (`InvalidProgramExecutable`).
    #[inline]
    pub fn token_program(&mut self, name: &'static str) -> Result<&'a AccountView, ProgramError> {
        let account = self.next(Some(name))?;
        let key = account.address();
        if !same(key, &TOKEN_PROGRAM_ID) && !same(key, &TOKEN_2022_PROGRAM_ID) {
            return Err(fail::<P>(INVALID_PROGRAM_ID, Some(name)));
        }
        if !account.executable() {
            return Err(fail::<P>(INVALID_PROGRAM_EXECUTABLE, Some(name)));
        }
        Ok(account)
    }

    /// `InterfaceAccount<'info, Mint>`: its decimals.
    #[inline]
    pub fn mint(&mut self, name: &'static str) -> Result<(&'a AccountView, u8), ProgramError> {
        self.mint_with(name, |mint| mint.decimals())
    }

    /// `InterfaceAccount<'info, Mint>`: what `read` takes from the mint
    /// (the data borrow ends before this returns).
    pub fn mint_with<T>(
        &mut self,
        name: &'static str,
        read: impl FnOnce(&Mint) -> T,
    ) -> Result<(&'a AccountView, T), ProgramError> {
        let account = self.next(Some(name))?;
        Ok((
            account,
            token::load_mint::<P, T>(account, Some(name), read)?,
        ))
    }

    /// `InterfaceAccount<'info, TokenAccount>`: its mint, owner and amount.
    #[inline]
    pub fn token_account(
        &mut self,
        name: &'static str,
    ) -> Result<(&'a AccountView, TokenAccount), ProgramError> {
        let account = self.next(Some(name))?;
        Ok((
            account,
            token::load_token_account::<P>(account, Some(name))?,
        ))
    }

    /// `InterfaceAccount<'info, TokenAccount>`: what `read` takes from it.
    pub fn token_account_with<T>(
        &mut self,
        name: &'static str,
        read: impl FnOnce(&TokenAccountState) -> T,
    ) -> Result<(&'a AccountView, T), ProgramError> {
        let account = self.next(Some(name))?;
        Ok((
            account,
            token::load_token_account_with::<P, T>(account, Some(name), read)?,
        ))
    }

    /// `Account<'info, T>`: [`load_program_account`], then the fields
    /// (`AccountDidNotDeserialize`).
    pub fn account<T: ProgramAccount>(
        &mut self,
        name: &'static str,
    ) -> Result<(&'a AccountView, T), ProgramError> {
        let account = self.next(Some(name))?;
        Ok((account, read_program_account::<P, T>(account, Some(name))?))
    }
}

/// The account does not exist: owned by the system program, no lamports
/// (Anchor's `AccountNotInitialized` test).
#[inline]
pub fn is_missing(account: &AccountView) -> bool {
    owned_by(account, &SYSTEM_PROGRAM_ID) && account.lamports() == 0
}

/// `Account<T>::try_from` and `T::try_deserialize` up to the fields: the
/// account exists (`AccountNotInitialized`), the program owns it
/// (`AccountOwnedByWrongProgram`, with the owner and the program id), it
/// starts with `discriminator` (`AccountDiscriminatorNotFound` when shorter
/// than 8 bytes, else `AccountDiscriminatorMismatch`). The caller decodes
/// the fields from the returned data. `name` is the field (Anchor names it
/// everywhere, `init_if_needed` included); `None` for an account read
/// outside the account list.
#[inline(never)]
pub fn load_program_account<'a, P: Program>(
    account: &'a AccountView,
    discriminator: &[u8; 8],
    name: Option<&'static str>,
) -> Result<Ref<'a, [u8]>, ProgramError> {
    if is_missing(account) {
        return Err(fail::<P>(ACCOUNT_NOT_INITIALIZED, name));
    }
    if !owned_by(account, &P::ID) {
        return Err(fail_keys::<P>(
            ACCOUNT_OWNED_BY_WRONG_PROGRAM,
            name,
            account.owner(),
            &P::ID,
        ));
    }
    let data = account.try_borrow()?;
    let Some(given) = data.first_chunk::<8>() else {
        return Err(fail::<P>(ACCOUNT_DISCRIMINATOR_NOT_FOUND, name));
    };
    if given != discriminator {
        return Err(fail::<P>(ACCOUNT_DISCRIMINATOR_MISMATCH, name));
    }
    Ok(data)
}

/// `Account<'info, T>::try_from`: [`load_program_account`], then
/// `T::try_read` (`AccountDidNotDeserialize`).
pub fn read_program_account<P: Program, T: ProgramAccount>(
    account: &AccountView,
    name: Option<&'static str>,
) -> Result<T, ProgramError> {
    let data = load_program_account::<P>(account, &T::ACCOUNT_DISCRIMINATOR, name)?;
    T::try_read(&data).ok_or_else(|| fail::<P>(ACCOUNT_DID_NOT_DESERIALIZE, name))
}

// ------------------------------------------------------------- constraints

/// [A] `mut`: `ConstraintMut`.
pub fn check_mut<P: Program>(account: &AccountView, name: &'static str) -> ProgramResult {
    if !account.is_writable() {
        return Err(fail::<P>(CONSTRAINT_MUT, Some(name)));
    }
    Ok(())
}

/// [A] `signer` (the constraint, not the `Signer` type): `ConstraintSigner`.
pub fn check_signer<P: Program>(account: &AccountView, name: &'static str) -> ProgramResult {
    if !account.is_signer() {
        return Err(fail::<P>(CONSTRAINT_SIGNER, Some(name)));
    }
    Ok(())
}

/// [A] `has_one = target`: the field `key` of account `name` is `target`'s
/// address (`ConstraintHasOne`, with both keys). With `@ MyError`, use
/// [`check_keys`] with that code.
pub fn check_has_one<P: Program>(
    key: &Address,
    target: &AccountView,
    name: &'static str,
) -> ProgramResult {
    check_keys::<P>(key, target.address(), CONSTRAINT_HAS_ONE, name)
}

/// [A] a constraint that compares two keys (`has_one`, `address`, `owner`,
/// or one with a custom error `@ code`): `code` caused by `name`, with both
/// keys, when they differ.
pub fn check_keys<P: Program>(
    left: &Address,
    right: &Address,
    code: u32,
    name: &'static str,
) -> ProgramResult {
    if !same(left, right) {
        return Err(fail_keys::<P>(code, Some(name), left, right));
    }
    Ok(())
}

/// [A] `address = expected`: `ConstraintAddress`, with both keys.
pub fn check_address<P: Program>(
    account: &AccountView,
    expected: &Address,
    name: &'static str,
) -> ProgramResult {
    check_keys::<P>(account.address(), expected, CONSTRAINT_ADDRESS, name)
}

/// [A] `owner = expected`: `ConstraintOwner`, with both keys.
pub fn check_owner<P: Program>(
    account: &AccountView,
    expected: &Address,
    name: &'static str,
) -> ProgramResult {
    check_keys::<P>(account.owner(), expected, CONSTRAINT_OWNER, name)
}

/// [A] `executable`: `ConstraintExecutable`.
pub fn check_executable<P: Program>(account: &AccountView, name: &'static str) -> ProgramResult {
    if !account.executable() {
        return Err(fail::<P>(CONSTRAINT_EXECUTABLE, Some(name)));
    }
    Ok(())
}

/// [A] `constraint = ok` (`ConstraintRaw`), or `constraint = ok @ code`:
/// `code` caused by `name` when `ok` is false.
pub fn check_constraint<P: Program>(ok: bool, code: u32, name: &'static str) -> ProgramResult {
    if !ok {
        return Err(fail::<P>(code, Some(name)));
    }
    Ok(())
}

/// [A] `rent_exempt = enforce` (implied by `init`): `ConstraintRentExempt`.
pub fn check_rent_exempt<P: Program>(
    account: &AccountView,
    rent: &Rent,
    name: &'static str,
) -> ProgramResult {
    if !rent.is_exempt(account.lamports(), account.data_len()) {
        return Err(fail::<P>(CONSTRAINT_RENT_EXEMPT, Some(name)));
    }
    Ok(())
}

/// [A] `close = target`: the account cannot be closed to itself
/// (`ConstraintClose`). The closing itself is [`close`], at exit.
pub fn check_close<P: Program>(
    account: &AccountView,
    target: &AccountView,
    name: &'static str,
) -> ProgramResult {
    if same(account.address(), target.address()) {
        return Err(fail::<P>(CONSTRAINT_CLOSE, Some(name)));
    }
    Ok(())
}

/// [A] the writable `Account` / `InterfaceAccount` fields without `dup`
/// (and not plain `init`) are distinct accounts
/// (`ConstraintDuplicateMutableAccount`, naming the later field), in field
/// order.
pub fn check_distinct<P: Program>(fields: &[(&AccountView, &'static str)]) -> ProgramResult {
    for (i, (account, name)) in fields.iter().enumerate() {
        let earlier = fields.get(..i).unwrap_or(&[]);
        if earlier
            .iter()
            .any(|(other, _)| same(other.address(), account.address()))
        {
            return Err(fail::<P>(CONSTRAINT_DUPLICATE_MUTABLE_ACCOUNT, Some(name)));
        }
    }
    Ok(())
}

// ------------------------------------------------------- init, exit, close

/// The checks of `Account::try_from_unchecked` on a just created account,
/// each caused by `name` (anchor-syn wraps the call in
/// `with_account_name(field)`): it exists, the program owns it (with both
/// keys), and it holds at least `space` bytes (the fields decode).
fn check_created<P: Program>(account: &AccountView, space: usize, name: &'static str) -> ProgramResult {
    if is_missing(account) {
        return Err(fail::<P>(ACCOUNT_NOT_INITIALIZED, Some(name)));
    }
    if !owned_by(account, &P::ID) {
        return Err(fail_keys::<P>(
            ACCOUNT_OWNED_BY_WRONG_PROGRAM,
            Some(name),
            account.owner(),
            &P::ID,
        ));
    }
    if account.data_len() < space {
        return Err(fail::<P>(ACCOUNT_DID_NOT_DESERIALIZE, Some(name)));
    }
    Ok(())
}

/// [A] `init, payer = payer, space = space` of a program account (the
/// caller checked `seeds` first: [`crate::pda::check_seeds`]):
/// [`create_account_or_fund_allocate_assign`] owned by the program (the
/// PDA signs with `signers`), the checks of `Account::try_from_unchecked`
/// (errors caused by `name`), then `mut` (`ConstraintMut`). The caller then
/// runs the field's other constraints (raw, rent exemption: init implies
/// `rent_exempt = enforce`) and, at exit, writes the account
/// ([`write_back`]).
#[inline(never)]
pub fn init_program_account<P: Program>(
    payer: &AccountView,
    account: &AccountView,
    space: usize,
    rent: &Rent,
    signers: &[Signer],
    name: &'static str,
) -> ProgramResult {
    create_account_or_fund_allocate_assign::<P>(payer, account, space, &P::ID, rent, signers)?;
    check_created::<P>(account, space, name)?;
    check_mut::<P>(account, name)
}

/// [A] `init_if_needed, payer = payer, space = space` of a program account:
/// an account still owned by the system program is created as by
/// [`init_program_account`] (`Ok(None)`); any other is loaded as
/// `Account::try_from` does (its errors caused by `name`, as anchor-syn's
/// `with_account_name` wraps them) and must then have exactly `space` bytes
/// (`ConstraintSpace`, with both values), be owned by the program
/// (`ConstraintOwner`, with both keys) and hold the rent-exempt minimum for
/// `space` (`ConstraintRentExempt`), each caused by `name`
/// (`Ok(Some(fields))`). Then `mut`. The caller must not assume the account
/// is new: anyone may have created it first.
#[inline(never)]
pub fn init_if_needed_program_account<P: Program, T: ProgramAccount>(
    payer: &AccountView,
    account: &AccountView,
    space: usize,
    rent: &Rent,
    signers: &[Signer],
    name: &'static str,
) -> Result<Option<T>, ProgramError> {
    let existing = if owned_by(account, &SYSTEM_PROGRAM_ID) {
        create_account_or_fund_allocate_assign::<P>(payer, account, space, &P::ID, rent, signers)?;
        check_created::<P>(account, space, name)?;
        None
    } else {
        let fields = read_program_account::<P, T>(account, Some(name))?;
        if account.data_len() != space {
            return Err(fail_values::<P>(
                CONSTRAINT_SPACE,
                Some(name),
                space as u64,
                account.data_len() as u64,
            ));
        }
        if !owned_by(account, &P::ID) {
            return Err(fail_keys::<P>(
                CONSTRAINT_OWNER,
                Some(name),
                account.owner(),
                &P::ID,
            ));
        }
        if account.lamports() < rent.minimum_balance(space) {
            return Err(fail::<P>(CONSTRAINT_RENT_EXEMPT, Some(name)));
        }
        Some(fields)
    };
    check_mut::<P>(account, name)?;
    Ok(existing)
}

/// [A] exit of a writable program account: its first `LEN` bytes written
/// by `write` (discriminator and fields), unless it was closed (owned by
/// the system program, no data). Data shorter than `LEN` is
/// `AccountDidNotSerialize`. Exit runs after every CPI of the handler, in
/// field order.
pub fn write_back<P: Program, const LEN: usize>(
    account: &AccountView,
    name: &'static str,
    write: impl FnOnce(&mut [u8; LEN]),
) -> ProgramResult {
    if owned_by(account, &SYSTEM_PROGRAM_ID) && account.is_data_empty() {
        return Ok(());
    }
    let mut handle = *account;
    let mut data = handle.try_borrow_mut()?;
    match data.first_chunk_mut::<LEN>() {
        Some(fields) => {
            write(fields);
            Ok(())
        }
        None => Err(fail::<P>(ACCOUNT_DID_NOT_SERIALIZE, Some(name))),
    }
}

/// [A] exit of `close = destination`: the lamports go to `destination`
/// (`ArithmeticOverflow` if its balance would overflow, as anchor-lang
/// 1.2.1's `common::close` returns through `add_lamports`), the account goes
/// back to the system program with no data.
#[inline]
pub fn close(account: &AccountView, destination: &AccountView) -> ProgramResult {
    let mut destination = *destination;
    let credited = destination
        .lamports()
        .checked_add(account.lamports())
        .ok_or(ProgramError::ArithmeticOverflow)?;
    destination.set_lamports(credited);
    // Owner (the system program), lamports and data length all zero.
    let mut account = *account;
    account.close()
}

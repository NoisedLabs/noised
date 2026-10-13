//! The program. Each instruction runs exactly what the Anchor 1.2.1 build
//! generated for it, in the same order, so every input fails (or succeeds)
//! the same way:
//!
//! 1. `Instruction: <Name>` is logged, then the arguments are decoded
//!    (Borsh; trailing bytes ignored): `InstructionDidNotDeserialize`.
//! 2. The accounts are taken in order and checked by type (`Signer`,
//!    `Account<T>`, `InterfaceAccount<T>`, `Interface<TokenInterface>`,
//!    `Program<T>`); a missing account is `AccountNotEnoughKeys`.
//! 3. The `init` / `init_if_needed` accounts are created and checked.
//! 4. The writable `Account` / `InterfaceAccount` fields must be distinct
//!    (`ConstraintDuplicateMutableAccount`).
//! 5. Every other field's constraints, field by field, each in Anchor's
//!    order: seeds, associated token, mut, has_one, raw, rent, close,
//!    address, token, mint.
//! 6. The handler.
//! 7. Exit: the program accounts are written back (after every CPI of the
//!    handler) and the payout account is closed.
//!
//! The comments `[A]` name the Anchor constraint each check implements.

use alloc::vec::Vec;

use pinocchio::{
    cpi::{Seed, Signer},
    error::ProgramError,
    instruction::InstructionAccount,
    AccountView, Address, ProgramResult,
};

use crate::{
    discriminator,
    error::{anchor::*, fail, fail_keys, vault as vault_error, VaultError},
    event_data,
    hook::{self, Entry, HookAccount},
    message::withdraw_message,
    same,
    state::{
        key_id, next_key_index, Payout, SolSha256, Vault, VaultKey, GENESIS_KEY_INDEX, PAYOUT_SEED,
        VAULT_SEED,
    },
    sys::{self, Rent},
    token::{
        hook_program_id, mint_is_supported, requires_memo, unpack_mint, unpack_token_account,
        ASSOCIATED_TOKEN_PROGRAM_ID, MEMO_PROGRAM_ID, PAYOUT_MEMO, SYSTEM_PROGRAM_ID,
        TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
    },
    Pubkey, ID,
};

// Account field names, as Anchor names them in errors.
const PAYER: &str = "payer";
const MINT: &str = "mint";
const VAULT: &str = "vault";
const VAULT_TOKEN_ACCOUNT: &str = "vault_token_account";
const PAYOUT: &str = "payout";
const RENT_PAYER: &str = "rent_payer";
const DESTINATION_OWNER: &str = "destination_owner";
const DESTINATION: &str = "destination";
const MEMO_PROGRAM: &str = "memo_program";
const TOKEN_PROGRAM: &str = "token_program";
const ASSOCIATED_TOKEN_PROGRAM: &str = "associated_token_program";
const SYSTEM_PROGRAM: &str = "system_program";

/// The program entrypoint's instruction processor.
pub fn process_instruction(
    program_id: &Address,
    accounts: &mut [AccountView],
    data: &[u8],
) -> ProgramResult {
    // [A] try_entry: the declared id.
    if !same(program_id, &ID) {
        return Err(fail(DECLARED_PROGRAM_ID_MISMATCH, None));
    }
    // [A] dispatch: the 8-byte discriminator prefix; the event-CPI tag is a
    // stub without `event-cpi`; anything else has no fallback.
    let Some((tag, args)) = data.split_first_chunk::<8>() else {
        return Err(fail(INSTRUCTION_FALLBACK_NOT_FOUND, None));
    };
    let accounts = Accounts { rest: accounts };
    match *tag {
        discriminator::OPEN_VAULT => open_vault(accounts, args),
        discriminator::WITHDRAW => withdraw(accounts, args),
        discriminator::RELEASE => release(accounts),
        discriminator::RELEASE_TO => release_to(accounts),
        discriminator::EVENT_IX_TAG_LE => Err(fail(EVENT_INSTRUCTION_STUB, None)),
        _ => Err(fail(INSTRUCTION_FALLBACK_NOT_FOUND, None)),
    }
}

/// `msg!("Instruction: <Name>")`, unless built with `no-log-ix-name`.
fn log_instruction(_name: &str) {
    #[cfg(not(feature = "no-log-ix-name"))]
    sys::log(_name);
}

#[inline(never)]
fn owned_by(account: &AccountView, owner: &Pubkey) -> bool {
    same(account.owner(), owner)
}

/// The account does not exist: owned by the system program, no lamports
/// (Anchor's `AccountNotInitialized` test).
fn is_missing(account: &AccountView) -> bool {
    owned_by(account, &SYSTEM_PROGRAM_ID) && account.lamports() == 0
}

// ---------------------------------------------------------------- accounts

/// The instruction's accounts, taken in order (`try_accounts`).
struct Accounts<'a> {
    rest: &'a [AccountView],
}

impl<'a> Accounts<'a> {
    /// The next account, or `AccountNotEnoughKeys` (named after the field,
    /// except for `init` fields, whose missing account Anchor does not name).
    fn next(&mut self, name: Option<&'static str>) -> Result<&'a AccountView, ProgramError> {
        match self.rest.split_first() {
            Some((first, rest)) => {
                self.rest = rest;
                Ok(first)
            }
            None => Err(fail(ACCOUNT_NOT_ENOUGH_KEYS, name)),
        }
    }

    /// `UncheckedAccount<'info>`.
    fn unchecked(&mut self, name: &'static str) -> Result<&'a AccountView, ProgramError> {
        self.next(Some(name))
    }

    /// `Signer<'info>`: `AccountNotSigner`.
    fn signer(&mut self, name: &'static str) -> Result<&'a AccountView, ProgramError> {
        let account = self.next(Some(name))?;
        if !account.is_signer() {
            return Err(fail(ACCOUNT_NOT_SIGNER, Some(name)));
        }
        Ok(account)
    }

    /// `InterfaceAccount<'info, Mint>`: its decimals.
    fn mint(&mut self, name: &'static str) -> Result<(&'a AccountView, u8), ProgramError> {
        let account = self.next(Some(name))?;
        check_token_owner(account, Some(name))?;
        let data = account.try_borrow()?;
        let decimals = unpack_mint(&data)?.decimals;
        Ok((account, decimals))
    }

    /// `InterfaceAccount<'info, TokenAccount>`.
    fn token_account(
        &mut self,
        name: &'static str,
    ) -> Result<(&'a AccountView, TokenAccount), ProgramError> {
        let account = self.next(Some(name))?;
        Ok((account, load_token_account(account, Some(name))?))
    }

    /// `Account<'info, Vault>`.
    fn vault(&mut self, name: &'static str) -> Result<(&'a AccountView, Vault), ProgramError> {
        let account = self.next(Some(name))?;
        let data = load_program_account(account, &discriminator::VAULT, name)?;
        let fields = data
            .first_chunk::<{ Vault::LEN }>()
            .ok_or_else(|| fail(ACCOUNT_DID_NOT_DESERIALIZE, Some(name)))?;
        Ok((account, Vault::read(fields)))
    }

    /// `Account<'info, Payout>`.
    fn payout(&mut self, name: &'static str) -> Result<(&'a AccountView, Payout), ProgramError> {
        let account = self.next(Some(name))?;
        let data = load_program_account(account, &discriminator::PAYOUT, name)?;
        let fields = data
            .first_chunk::<{ Payout::LEN }>()
            .ok_or_else(|| fail(ACCOUNT_DID_NOT_DESERIALIZE, Some(name)))?;
        Ok((account, Payout::read(fields)))
    }

    /// `Interface<'info, TokenInterface>`: SPL Token or Token-2022 only.
    fn token_program(&mut self, name: &'static str) -> Result<&'a AccountView, ProgramError> {
        let account = self.next(Some(name))?;
        let key = account.address();
        if !same(key, &TOKEN_PROGRAM_ID) && !same(key, &TOKEN_2022_PROGRAM_ID) {
            return Err(fail(INVALID_PROGRAM_ID, Some(name)));
        }
        if !account.executable() {
            return Err(fail(INVALID_PROGRAM_EXECUTABLE, Some(name)));
        }
        Ok(account)
    }

    /// `Program<'info, T>`: exactly `id`, executable.
    fn program(
        &mut self,
        id: &Pubkey,
        name: &'static str,
    ) -> Result<&'a AccountView, ProgramError> {
        let account = self.next(Some(name))?;
        if !same(account.address(), id) {
            return Err(fail_keys(
                INVALID_PROGRAM_ID,
                Some(name),
                account.address(),
                id,
            ));
        }
        if !account.executable() {
            return Err(fail(INVALID_PROGRAM_EXECUTABLE, Some(name)));
        }
        Ok(account)
    }
}

/// The token account fields the vault reads.
struct TokenAccount {
    mint: Pubkey,
    owner: Pubkey,
    amount: u64,
}

/// `InterfaceAccount::try_from`'s owner checks: an account that does not
/// exist is `AccountNotInitialized`; one not owned by a token program is
/// `AccountOwnedByWrongProgram`.
fn check_token_owner(account: &AccountView, name: Option<&'static str>) -> ProgramResult {
    if is_missing(account) {
        return Err(fail(ACCOUNT_NOT_INITIALIZED, name));
    }
    if !owned_by(account, &TOKEN_PROGRAM_ID) && !owned_by(account, &TOKEN_2022_PROGRAM_ID) {
        return Err(fail(ACCOUNT_OWNED_BY_WRONG_PROGRAM, name));
    }
    Ok(())
}

/// `InterfaceAccount<TokenAccount>::try_from`: owner checks, then
/// `StateWithExtensions::<Account>::unpack` (its errors as they are).
#[inline(never)]
fn load_token_account(
    account: &AccountView,
    name: Option<&'static str>,
) -> Result<TokenAccount, ProgramError> {
    check_token_owner(account, name)?;
    let data = account.try_borrow()?;
    let state = unpack_token_account(&data)?;
    Ok(TokenAccount {
        mint: state.mint,
        owner: state.owner,
        amount: state.amount,
    })
}

/// `Account<T>::try_from` and `T::try_deserialize` up to the fields: the
/// account exists, this program owns it, it starts with the type's
/// discriminator. The caller reads the fields (`AccountDidNotDeserialize`
/// when the data is too short for them; longer is fine).
#[inline(never)]
fn load_program_account<'a>(
    account: &'a AccountView,
    disc: &[u8; 8],
    name: &'static str,
) -> Result<pinocchio::account::Ref<'a, [u8]>, ProgramError> {
    if is_missing(account) {
        return Err(fail(ACCOUNT_NOT_INITIALIZED, Some(name)));
    }
    if !owned_by(account, &ID) {
        return Err(fail_keys(
            ACCOUNT_OWNED_BY_WRONG_PROGRAM,
            Some(name),
            account.owner(),
            &ID,
        ));
    }
    let data = account.try_borrow()?;
    let Some(given) = data.first_chunk::<8>() else {
        return Err(fail(ACCOUNT_DISCRIMINATOR_NOT_FOUND, Some(name)));
    };
    if given != disc {
        return Err(fail(ACCOUNT_DISCRIMINATOR_MISMATCH, Some(name)));
    }
    Ok(data)
}

// ------------------------------------------------------------- constraints

/// [A] `mut`: `ConstraintMut`.
fn check_mut(account: &AccountView, name: &'static str) -> ProgramResult {
    if !account.is_writable() {
        return Err(fail(CONSTRAINT_MUT, Some(name)));
    }
    Ok(())
}

/// [A] `mint::token_program = token_program`: `ConstraintMintTokenProgram`
/// (Anchor names no account).
fn check_mint_token_program(mint: &AccountView, token_program: &AccountView) -> ProgramResult {
    if !owned_by(mint, token_program.address()) {
        return Err(fail(CONSTRAINT_MINT_TOKEN_PROGRAM, None));
    }
    Ok(())
}

/// [A] `seeds = [VAULT_SEED, mint, vault.genesis_key_id], bump = vault.bump`
/// (`create_program_address`), `mut`, `has_one = mint`.
fn check_vault(vault: &AccountView, state: &Vault, mint: &AccountView) -> ProgramResult {
    let pda = Pubkey::create_program_address(
        &[
            VAULT_SEED,
            mint.address().as_ref(),
            &state.genesis_key_id,
            &[state.bump],
        ],
        &ID,
    )
    .map_err(|_| fail(CONSTRAINT_SEEDS, Some(VAULT)))?;
    if !same(vault.address(), &pda) {
        return Err(fail_keys(
            CONSTRAINT_SEEDS,
            Some(VAULT),
            vault.address(),
            &pda,
        ));
    }
    check_mut(vault, VAULT)?;
    check_has_one(&state.mint, mint, VAULT)
}

/// [A] `has_one`: the field `key` of account `name` is `target`'s address.
fn check_has_one(key: &Pubkey, target: &AccountView, name: &'static str) -> ProgramResult {
    if !same(key, target.address()) {
        return Err(fail_keys(
            CONSTRAINT_HAS_ONE,
            Some(name),
            key,
            target.address(),
        ));
    }
    Ok(())
}

/// The canonical associated token account of `wallet` for `mint` under
/// `token_program`.
#[inline(never)]
fn associated_token_address(wallet: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    hook::find_program_address(
        &[wallet.as_ref(), token_program.as_ref(), mint.as_ref()],
        &ASSOCIATED_TOKEN_PROGRAM_ID,
    )
    .0
}

/// [A] `associated_token::mint = mint, associated_token::authority = vault,
/// associated_token::token_program = token_program` on an existing account:
/// owned by `token_program` (`ConstraintAssociatedTokenTokenProgram`, no
/// account named), owned by the vault (`ConstraintTokenOwner`), at the
/// canonical address (`ConstraintAssociated`). The mint is not compared:
/// only the ATA program can create an account at the address of this mint.
fn check_vault_token_account(
    account: &AccountView,
    state: &TokenAccount,
    vault: &AccountView,
    mint: &AccountView,
    token_program: &AccountView,
) -> ProgramResult {
    if !owned_by(account, token_program.address()) {
        return Err(fail(CONSTRAINT_ASSOCIATED_TOKEN_TOKEN_PROGRAM, None));
    }
    if !same(&state.owner, vault.address()) {
        return Err(fail_keys(
            CONSTRAINT_TOKEN_OWNER,
            Some(VAULT_TOKEN_ACCOUNT),
            &state.owner,
            vault.address(),
        ));
    }
    let ata = associated_token_address(vault.address(), mint.address(), token_program.address());
    if !same(account.address(), &ata) {
        return Err(fail_keys(
            CONSTRAINT_ASSOCIATED,
            Some(VAULT_TOKEN_ACCOUNT),
            account.address(),
            &ata,
        ));
    }
    Ok(())
}

/// [A] the payout of `release` / `release_to`: `seeds = [PAYOUT_SEED,
/// vault, payout.sequence], bump = payout.bump`, `mut`, `has_one = vault`,
/// `has_one = rent_payer`, `has_one = destination_owner`, `close =
/// rent_payer` (`ConstraintClose` when the payout is its own rent payer).
fn check_payout(
    payout: &AccountView,
    state: &Payout,
    vault: &AccountView,
    rent_payer: &AccountView,
    destination_owner: &AccountView,
) -> ProgramResult {
    let pda = Pubkey::create_program_address(
        &[
            PAYOUT_SEED,
            vault.address().as_ref(),
            &state.sequence.to_le_bytes(),
            &[state.bump],
        ],
        &ID,
    )
    .map_err(|_| fail(CONSTRAINT_SEEDS, Some(PAYOUT)))?;
    if !same(payout.address(), &pda) {
        return Err(fail_keys(
            CONSTRAINT_SEEDS,
            Some(PAYOUT),
            payout.address(),
            &pda,
        ));
    }
    check_mut(payout, PAYOUT)?;
    check_has_one(&state.vault, vault, PAYOUT)?;
    check_has_one(&state.rent_payer, rent_payer, PAYOUT)?;
    check_has_one(&state.destination_owner, destination_owner, PAYOUT)?;
    if same(payout.address(), rent_payer.address()) {
        return Err(fail(CONSTRAINT_CLOSE, Some(PAYOUT)));
    }
    Ok(())
}

/// [A] the writable `Account` / `InterfaceAccount` fields are distinct
/// accounts; a repeat names the later field.
fn check_distinct(fields: &[(&AccountView, &'static str)]) -> ProgramResult {
    for (i, (account, name)) in fields.iter().enumerate() {
        let earlier = fields.get(..i).unwrap_or(&[]);
        if earlier
            .iter()
            .any(|(other, _)| same(other.address(), account.address()))
        {
            return Err(fail(CONSTRAINT_DUPLICATE_MUTABLE_ACCOUNT, Some(name)));
        }
    }
    Ok(())
}

/// [A] `address = MEMO_PROGRAM_ID`: `ConstraintAddress`.
fn check_memo_program(memo_program: &AccountView) -> ProgramResult {
    if !same(memo_program.address(), &MEMO_PROGRAM_ID) {
        return Err(fail_keys(
            CONSTRAINT_ADDRESS,
            Some(MEMO_PROGRAM),
            memo_program.address(),
            &MEMO_PROGRAM_ID,
        ));
    }
    Ok(())
}

/// [A] `rent_exempt = enforce` (implied by `init`): `ConstraintRentExempt`.
fn check_rent_exempt(account: &AccountView, rent: &Rent, name: &'static str) -> ProgramResult {
    if !rent.is_exempt(account.lamports(), account.data_len()) {
        return Err(fail(CONSTRAINT_RENT_EXEMPT, Some(name)));
    }
    Ok(())
}

// ------------------------------------------------------- init, exit, close

fn writable_signer(account: &AccountView) -> InstructionAccount<'_> {
    InstructionAccount::writable_signer(account.address())
}

/// [A] `init` of a program account (`create_account_or_fund_allocate_assign`):
/// a PDA without lamports is created by `create_account`; one that already
/// holds lamports (anyone can send lamports to a known address) is topped
/// up to the rent-exempt minimum by the payer, then allocated and assigned.
/// The PDA signs with `seeds`. Then the checks of `Account::try_from_unchecked`
/// (errors raised there name no account), `mut` and rent exemption.
#[inline(never)]
fn init_program_account(
    payer: &AccountView,
    account: &AccountView,
    space: usize,
    rent: &Rent,
    seeds: &[Seed],
    name: &'static str,
) -> ProgramResult {
    let signers = [Signer::from(seeds)];
    let current = account.lamports();
    let space_le = (space as u64).to_le_bytes();
    if current == 0 {
        // SystemInstruction::CreateAccount { lamports, space, owner }
        let mut data = [0u8; 52];
        data[4..12].copy_from_slice(&rent.minimum_balance(space).to_le_bytes());
        data[12..20].copy_from_slice(&space_le);
        data[20..52].copy_from_slice(ID.as_ref());
        sys::invoke(
            &SYSTEM_PROGRAM_ID,
            &[writable_signer(payer), writable_signer(account)],
            &data,
            &[payer, account],
            &signers,
        )?;
    } else {
        // [A] require_keys_neq!(payer, account, TryingToInitPayerAsProgramAccount)
        if same(payer.address(), account.address()) {
            return Err(fail_keys(
                TRYING_TO_INIT_PAYER_AS_PROGRAM_ACCOUNT,
                None,
                payer.address(),
                account.address(),
            ));
        }
        let required = rent.minimum_balance(space).max(1).saturating_sub(current);
        if required > 0 {
            // SystemInstruction::Transfer { lamports }
            let mut data = [0u8; 12];
            data[0] = 2;
            data[4..12].copy_from_slice(&required.to_le_bytes());
            sys::invoke(
                &SYSTEM_PROGRAM_ID,
                &[
                    writable_signer(payer),
                    InstructionAccount::writable(account.address()),
                ],
                &data,
                &[payer, account],
                &[],
            )?;
        }
        // SystemInstruction::Allocate { space }
        let mut data = [0u8; 12];
        data[0] = 8;
        data[4..12].copy_from_slice(&space_le);
        sys::invoke(
            &SYSTEM_PROGRAM_ID,
            &[writable_signer(account)],
            &data,
            &[account],
            &signers,
        )?;
        // SystemInstruction::Assign { owner }
        let mut data = [0u8; 36];
        data[0] = 1;
        data[4..36].copy_from_slice(ID.as_ref());
        sys::invoke(
            &SYSTEM_PROGRAM_ID,
            &[writable_signer(account)],
            &data,
            &[account],
            &signers,
        )?;
    }
    // Account::try_from_unchecked: no discriminator yet.
    if is_missing(account) {
        return Err(fail(ACCOUNT_NOT_INITIALIZED, None));
    }
    if !owned_by(account, &ID) {
        return Err(fail_keys(
            ACCOUNT_OWNED_BY_WRONG_PROGRAM,
            None,
            account.owner(),
            &ID,
        ));
    }
    if account.data_len() < space {
        return Err(fail(ACCOUNT_DID_NOT_DESERIALIZE, None));
    }
    check_mut(account, name)
}

/// [A] exit of a program account: its data written back unless it was
/// closed (owned by the system program, no data).
fn write_back<const LEN: usize>(
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
        None => Err(fail(ACCOUNT_DID_NOT_SERIALIZE, Some(name))),
    }
}

/// [A] exit of `close = rent_payer`: the lamports go to `destination`, the
/// account goes back to the system program with no data.
fn close(account: &AccountView, destination: &AccountView) -> ProgramResult {
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

// -------------------------------------------------------------- open_vault

/// Create a vault for `mint` controlled by the LM-OTS public key `key`.
///
/// The address commits to this first key, so nobody can open a vault at
/// someone else's address with a different key. The first key has LM-OTS
/// index `q = 0`: every key of a vault is bound to its position.
///
/// Accounts: payer (signer, writable), mint, vault (writable, PDA
/// `[VAULT_SEED, mint, key_id_arg]`, created), vault_token_account
/// (writable, the vault's ATA, created if missing), token_program,
/// associated_token_program, system_program.
fn open_vault(mut accounts: Accounts, args: &[u8]) -> ProgramResult {
    log_instruction("Instruction: OpenVault");
    let Some((key_id_arg, key)) = parse_open_vault(args) else {
        return Err(fail(INSTRUCTION_DID_NOT_DESERIALIZE, None));
    };

    let payer = accounts.signer(PAYER)?;
    let (mint, _) = accounts.mint(MINT)?;
    let vault = accounts.next(None)?;
    let vault_token_account = accounts.next(None)?;
    let token_program = accounts.token_program(TOKEN_PROGRAM)?;
    accounts.program(&ASSOCIATED_TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM)?;
    let system_program = accounts.program(&SYSTEM_PROGRAM_ID, SYSTEM_PROGRAM)?;

    // [A] vault: init, payer = payer, space = 8 + Vault::INIT_SPACE,
    // seeds = [VAULT_SEED, mint, key_id_arg], bump; then mut, the raw
    // constraint (KeyIdMismatch) and rent exemption.
    let rent = Rent::get()?;
    let (pda, bump) =
        hook::find_program_address(&[VAULT_SEED, mint.address().as_ref(), &key_id_arg], &ID);
    if !same(vault.address(), &pda) {
        return Err(fail_keys(
            CONSTRAINT_SEEDS,
            Some(VAULT),
            vault.address(),
            &pda,
        ));
    }
    let bump_seed = [bump];
    init_program_account(
        payer,
        vault,
        Vault::LEN,
        &rent,
        &[
            Seed::from(VAULT_SEED),
            Seed::from(mint.address().as_ref()),
            Seed::from(&key_id_arg),
            Seed::from(&bump_seed),
        ],
        VAULT,
    )?;
    // [A] constraint = key_id(&key.public_key()) == key_id_arg @ KeyIdMismatch
    if key_id(&key.public_key()) != key_id_arg {
        return Err(fail(u32::from(VaultError::KeyIdMismatch), Some(VAULT)));
    }
    check_rent_exempt(vault, &rent, VAULT)?;

    // [A] vault_token_account: init_if_needed, associated_token::mint =
    // mint, associated_token::authority = vault,
    // associated_token::token_program = token_program. Anyone can create
    // the ATA first, which must not block opening.
    let ata = associated_token_address(vault.address(), mint.address(), token_program.address());
    if owned_by(vault_token_account, &SYSTEM_PROGRAM_ID) {
        // spl_associated_token_account::instruction::create_associated_token_account:
        // the instruction names the derived address; the runtime finds it
        // among the accounts passed (MissingAccount otherwise).
        sys::invoke(
            &ASSOCIATED_TOKEN_PROGRAM_ID,
            &[
                writable_signer(payer),
                InstructionAccount::writable(&ata),
                InstructionAccount::readonly(vault.address()),
                InstructionAccount::readonly(mint.address()),
                InstructionAccount::readonly(&SYSTEM_PROGRAM_ID),
                InstructionAccount::readonly(token_program.address()),
            ],
            &[0],
            &[
                payer,
                vault_token_account,
                vault,
                mint,
                system_program,
                token_program,
            ],
            &[],
        )?;
    }
    // InterfaceAccount::try_from_unchecked (the owner is read after the CPI).
    let state = load_token_account(vault_token_account, None)?;
    if !same(&state.mint, mint.address()) {
        return Err(fail_keys(
            CONSTRAINT_TOKEN_MINT,
            Some(VAULT_TOKEN_ACCOUNT),
            &state.mint,
            mint.address(),
        ));
    }
    if !same(&state.owner, vault.address()) {
        return Err(fail_keys(
            CONSTRAINT_TOKEN_OWNER,
            Some(VAULT_TOKEN_ACCOUNT),
            &state.owner,
            vault.address(),
        ));
    }
    if !owned_by(vault_token_account, token_program.address()) {
        return Err(fail_keys(
            CONSTRAINT_ASSOCIATED_TOKEN_TOKEN_PROGRAM,
            Some(VAULT_TOKEN_ACCOUNT),
            vault_token_account.owner(),
            token_program.address(),
        ));
    }
    if !same(vault_token_account.address(), &ata) {
        return Err(fail(
            ACCOUNT_NOT_ASSOCIATED_TOKEN_ACCOUNT,
            Some(VAULT_TOKEN_ACCOUNT),
        ));
    }
    check_mut(vault_token_account, VAULT_TOKEN_ACCOUNT)?;
    check_rent_exempt(vault_token_account, &rent, VAULT_TOKEN_ACCOUNT)?;

    // [A] duplicate mutable accounts: vault_token_account is the only
    // candidate (vault is a plain init). Then payer: mut; mint:
    // mint::token_program.
    check_mut(payer, PAYER)?;
    check_mint_token_program(mint, token_program)?;

    // Handler.
    if key.q != GENESIS_KEY_INDEX {
        return Err(vault_error(VaultError::InvalidKeyIndex));
    }
    require_supported_mint(mint)?;
    let mut state = Vault {
        version: 0,
        bump: 0,
        mint: Pubkey::new_from_array([0; 32]),
        genesis_key_id: [0; 32],
        sequence: 0,
        key_id: [0; 32],
        key_ident: [0; 16],
        key_q: 0,
        key_k: [0; 32],
        reserved: 0,
    };
    state.init(bump, *mint.address(), key_id_arg, &key);
    sys::log_data(&event_data::vault_opened(
        vault.address(),
        mint.address(),
        &key_id_arg,
    ));

    // Exit.
    write_back::<{ Vault::LEN }>(vault, VAULT, |data| state.write(data))
}

/// `open_vault(key_id_arg: [u8; 32], key: VaultKey)` arguments (Borsh;
/// trailing bytes ignored).
pub fn parse_open_vault(args: &[u8]) -> Option<([u8; 32], VaultKey)> {
    let (key_id_arg, rest) = args.split_first_chunk::<32>()?;
    Some((*key_id_arg, VaultKey::read(rest.first_chunk()?)))
}

/// Reject mints a vault cannot protect (see [`mint_is_supported`]). SPL
/// Token mints have no extensions.
fn require_supported_mint(mint: &AccountView) -> ProgramResult {
    if !owned_by(mint, &TOKEN_2022_PROGRAM_ID) {
        return Ok(());
    }
    let data = mint.try_borrow()?;
    let state = unpack_mint(&data)?;
    if !mint_is_supported(state.tlv)? {
        return Err(vault_error(VaultError::UnsupportedMint));
    }
    Ok(())
}

// ---------------------------------------------------------------- withdraw

/// `WithdrawArgs` read in place from the instruction data (Borsh; trailing
/// bytes ignored).
pub struct WithdrawArgsRef<'a> {
    pub signature: &'a [u8],
    pub destination_owner: Pubkey,
    pub max_amount: u64,
    pub next_key_id: [u8; 32],
    pub next_key: VaultKey,
}

impl<'a> WithdrawArgsRef<'a> {
    pub fn parse(data: &'a [u8]) -> Option<Self> {
        let (len, rest) = data.split_first_chunk::<4>()?;
        let (signature, rest) = rest.split_at_checked(u32::from_le_bytes(*len) as usize)?;
        let (destination_owner, rest) = rest.split_first_chunk::<32>()?;
        let (max_amount, rest) = rest.split_first_chunk::<8>()?;
        let (next_key_id, rest) = rest.split_first_chunk::<32>()?;
        Some(Self {
            signature,
            destination_owner: Pubkey::new_from_array(*destination_owner),
            max_amount: u64::from_le_bytes(*max_amount),
            next_key_id: *next_key_id,
            next_key: VaultKey::read(rest.first_chunk()?),
        })
    }
}

/// Spend the current key: reserve up to `max_amount` for
/// `destination_owner` and hand the vault to the next key, whose LM-OTS
/// index must be the vault's `sequence + 1`.
///
/// Reads no account the recipient or any other third party controls, so a
/// valid signature that names the key of the next position always executes.
///
/// Accounts: payer (signer, writable; pays the payout's rent, refunded on
/// release, and has no authority over the vault), mint, vault (writable),
/// vault_token_account (the balance a withdrawal can reserve from), payout
/// (writable, PDA `[PAYOUT_SEED, vault, sequence]`, created), token_program,
/// system_program.
fn withdraw(mut accounts: Accounts, data: &[u8]) -> ProgramResult {
    log_instruction("Instruction: Withdraw");
    let Some(args) = WithdrawArgsRef::parse(data) else {
        return Err(fail(INSTRUCTION_DID_NOT_DESERIALIZE, None));
    };

    let payer = accounts.signer(PAYER)?;
    let (mint, _) = accounts.mint(MINT)?;
    let (vault, mut state) = accounts.vault(VAULT)?;
    let (vault_token_account, vault_tokens) = accounts.token_account(VAULT_TOKEN_ACCOUNT)?;
    let payout = accounts.next(None)?;
    let token_program = accounts.token_program(TOKEN_PROGRAM)?;
    accounts.program(&SYSTEM_PROGRAM_ID, SYSTEM_PROGRAM)?;

    // [A] payout: init, payer = payer, space = 8 + Payout::INIT_SPACE,
    // seeds = [PAYOUT_SEED, vault, vault.sequence], bump. Only this program
    // can create an account at this address, and each sequence number is
    // used once, so the address can never be squatted.
    let rent = Rent::get()?;
    let sequence = state.sequence;
    let sequence_le = sequence.to_le_bytes();
    let (pda, payout_bump) =
        hook::find_program_address(&[PAYOUT_SEED, vault.address().as_ref(), &sequence_le], &ID);
    if !same(payout.address(), &pda) {
        return Err(fail_keys(
            CONSTRAINT_SEEDS,
            Some(PAYOUT),
            payout.address(),
            &pda,
        ));
    }
    let bump_seed = [payout_bump];
    init_program_account(
        payer,
        payout,
        Payout::LEN,
        &rent,
        &[
            Seed::from(PAYOUT_SEED),
            Seed::from(vault.address().as_ref()),
            Seed::from(&sequence_le),
            Seed::from(&bump_seed),
        ],
        PAYOUT,
    )?;
    check_rent_exempt(payout, &rent, PAYOUT)?;

    // [A] duplicate mutable accounts: vault is the only candidate. Then
    // payer: mut; mint: mint::token_program; vault: seeds, mut, has_one =
    // mint; vault_token_account: associated_token (read only).
    check_mut(payer, PAYER)?;
    check_mint_token_program(mint, token_program)?;
    check_vault(vault, &state, mint)?;
    check_vault_token_account(
        vault_token_account,
        &vault_tokens,
        vault,
        mint,
        token_program,
    )?;

    // Handler.
    if key_id(&args.next_key.public_key()) != args.next_key_id {
        return Err(vault_error(VaultError::KeyIdMismatch));
    }
    if args.next_key_id == state.key_id {
        return Err(vault_error(VaultError::InvalidNextKey));
    }
    // Verify the post-quantum signature over the exact withdrawal.
    let msg = withdraw_message(
        &ID,
        vault.address(),
        mint.address(),
        sequence,
        &args.destination_owner,
        args.max_amount,
        &args.next_key_id,
    );
    if !noised_lmots::verify::<SolSha256>(&state.public_key(), &msg, args.signature) {
        return Err(vault_error(VaultError::InvalidSignature));
    }
    // The next key's index must be its position, `sequence + 1`, so no key
    // that ever controlled this vault (each had a smaller index) can be
    // installed again. The signed `next_key_id` commits to the index, so
    // only a signer that named a key of another position sees this.
    if next_key_index(sequence) != Some(args.next_key.q) {
        return Err(vault_error(VaultError::InvalidKeyIndex));
    }
    // Pay only from what earlier payouts have not set aside. Paying the
    // vault itself would move nothing, so it reserves nothing.
    let available = vault_tokens.amount.saturating_sub(state.reserved);
    let amount = if same(&args.destination_owner, vault.address()) {
        0
    } else {
        args.max_amount.min(available)
    };
    state.reserved = state
        .reserved
        .checked_add(amount)
        .ok_or_else(|| vault_error(VaultError::MathOverflow))?;
    state.sequence = sequence
        .checked_add(1)
        .ok_or_else(|| vault_error(VaultError::MathOverflow))?;
    state.set_key(args.next_key_id, &args.next_key);
    sys::log_data(&event_data::vault_withdrawn(
        vault.address(),
        mint.address(),
        sequence,
        &args.destination_owner,
        amount,
        payout.address(),
        &args.next_key_id,
    ));

    // Exit: vault, then payout.
    write_back::<{ Vault::LEN }>(vault, VAULT, |data| state.write(data))?;
    write_back::<{ Payout::LEN }>(payout, PAYOUT, |data| {
        Payout {
            version: Payout::VERSION,
            bump: payout_bump,
            vault: *vault.address(),
            sequence,
            destination_owner: args.destination_owner,
            amount,
            rent_payer: *payer.address(),
        }
        .write(data)
    })
}

// ----------------------------------------------------------------- release

/// Deliver a payout to the recipient's canonical associated token account,
/// creating it if needed. Permissionless.
///
/// Accounts: payer (signer, writable; pays for the recipient's ATA if
/// missing), mint, vault (writable), vault_token_account (writable),
/// payout (writable, closed), rent_payer (writable; receives the payout's
/// rent), destination_owner (the wallet the signed message names),
/// destination (writable; the canonical ATA of destination_owner, checked
/// and created if missing, ignored when the payout is zero), memo_program
/// (SPL Memo), token_program, associated_token_program, system_program;
/// then the mint's transfer-hook accounts, if any.
fn release(mut accounts: Accounts) -> ProgramResult {
    log_instruction("Instruction: Release");
    let payer = accounts.signer(PAYER)?;
    let (mint, decimals) = accounts.mint(MINT)?;
    let (vault, mut state) = accounts.vault(VAULT)?;
    let (vault_token_account, vault_tokens) = accounts.token_account(VAULT_TOKEN_ACCOUNT)?;
    let (payout, receipt) = accounts.payout(PAYOUT)?;
    let rent_payer = accounts.unchecked(RENT_PAYER)?;
    let destination_owner = accounts.unchecked(DESTINATION_OWNER)?;
    let destination = accounts.unchecked(DESTINATION)?;
    let memo_program = accounts.unchecked(MEMO_PROGRAM)?;
    let token_program = accounts.token_program(TOKEN_PROGRAM)?;
    accounts.program(&ASSOCIATED_TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM)?;
    let system_program = accounts.program(&SYSTEM_PROGRAM_ID, SYSTEM_PROGRAM)?;

    check_distinct(&[
        (vault, VAULT),
        (vault_token_account, VAULT_TOKEN_ACCOUNT),
        (payout, PAYOUT),
    ])?;
    check_mut(payer, PAYER)?;
    check_release_accounts(&Release {
        mint,
        vault,
        state: &state,
        vault_token_account,
        vault_tokens: &vault_tokens,
        payout,
        receipt: &receipt,
        rent_payer,
        destination_owner,
        token_program,
    })?;
    check_mut(destination, DESTINATION)?;
    check_memo_program(memo_program)?;

    // Handler.
    if receipt.amount > 0 {
        ensure_canonical_ata(
            payer,
            destination_owner,
            destination,
            mint,
            token_program,
            system_program,
        )?;
    }
    deliver(Delivery {
        vault,
        state: &mut state,
        payout,
        receipt: &receipt,
        mint,
        decimals,
        vault_token_account,
        destination,
        memo_program,
        token_program,
        rent_payer,
        extra: accounts.rest,
    })
}

/// The accounts `release` and `release_to` check alike.
struct Release<'a> {
    mint: &'a AccountView,
    vault: &'a AccountView,
    state: &'a Vault,
    vault_token_account: &'a AccountView,
    vault_tokens: &'a TokenAccount,
    payout: &'a AccountView,
    receipt: &'a Payout,
    rent_payer: &'a AccountView,
    destination_owner: &'a AccountView,
    token_program: &'a AccountView,
}

/// [A] mint: `mint::token_program`; vault: seeds, mut, `has_one = mint`;
/// vault_token_account: associated_token, mut; payout: seeds, mut,
/// has_one (vault, rent_payer, destination_owner), close; rent_payer: mut.
#[inline(never)]
fn check_release_accounts(r: &Release) -> ProgramResult {
    check_mint_token_program(r.mint, r.token_program)?;
    check_vault(r.vault, r.state, r.mint)?;
    check_vault_token_account(
        r.vault_token_account,
        r.vault_tokens,
        r.vault,
        r.mint,
        r.token_program,
    )?;
    check_mut(r.vault_token_account, VAULT_TOKEN_ACCOUNT)?;
    check_payout(
        r.payout,
        r.receipt,
        r.vault,
        r.rent_payer,
        r.destination_owner,
    )?;
    check_mut(r.rent_payer, RENT_PAYER)
}

/// Require `ata` to be the canonical associated token account of `wallet`
/// for `mint` and create it if it does not exist. The token-account owner
/// field is deliberately not compared: only the ATA program can create an
/// account at this address, and only the wallet itself can reassign it, so
/// a reassigned ATA is where the wallet chose its funds to go.
fn ensure_canonical_ata(
    payer: &AccountView,
    wallet: &AccountView,
    ata: &AccountView,
    mint: &AccountView,
    token_program: &AccountView,
    system_program: &AccountView,
) -> ProgramResult {
    let invalid_destination = u32::from(VaultError::InvalidDestination);
    let expected =
        associated_token_address(wallet.address(), mint.address(), token_program.address());
    if !same(ata.address(), &expected) {
        return Err(fail_keys(
            invalid_destination,
            None,
            ata.address(),
            &expected,
        ));
    }
    if ata.is_data_empty() {
        // create_associated_token_account_idempotent
        sys::invoke(
            &ASSOCIATED_TOKEN_PROGRAM_ID,
            &[
                writable_signer(payer),
                InstructionAccount::writable(&expected),
                InstructionAccount::readonly(wallet.address()),
                InstructionAccount::readonly(mint.address()),
                InstructionAccount::readonly(&SYSTEM_PROGRAM_ID),
                InstructionAccount::readonly(token_program.address()),
            ],
            &[1],
            &[payer, ata, wallet, mint, system_program, token_program],
            &[],
        )?;
    }
    if !owned_by(ata, token_program.address()) {
        return Err(fail_keys(
            invalid_destination,
            None,
            ata.owner(),
            token_program.address(),
        ));
    }
    let data = ata.try_borrow()?;
    let account = unpack_token_account(&data).map_err(|_| fail(invalid_destination, None))?;
    if !same(&account.mint, mint.address()) {
        return Err(fail_keys(
            invalid_destination,
            None,
            &account.mint,
            mint.address(),
        ));
    }
    Ok(())
}

// -------------------------------------------------------------- release_to

/// Deliver a payout to any token account of the mint, chosen and signed for
/// by the recipient wallet. For recipients whose canonical account cannot
/// receive (for example confidential-only accounts).
///
/// Accounts: destination_owner (signer; the recipient wallet named in the
/// signed message), mint, vault (writable), vault_token_account (writable),
/// payout (writable, closed), rent_payer (writable), destination (writable;
/// any token account of the mint), memo_program, token_program; then the
/// mint's transfer-hook accounts, if any.
fn release_to(mut accounts: Accounts) -> ProgramResult {
    log_instruction("Instruction: ReleaseTo");
    let destination_owner = accounts.signer(DESTINATION_OWNER)?;
    let (mint, decimals) = accounts.mint(MINT)?;
    let (vault, mut state) = accounts.vault(VAULT)?;
    let (vault_token_account, vault_tokens) = accounts.token_account(VAULT_TOKEN_ACCOUNT)?;
    let (payout, receipt) = accounts.payout(PAYOUT)?;
    let rent_payer = accounts.unchecked(RENT_PAYER)?;
    let (destination, destination_tokens) = accounts.token_account(DESTINATION)?;
    let memo_program = accounts.unchecked(MEMO_PROGRAM)?;
    let token_program = accounts.token_program(TOKEN_PROGRAM)?;

    check_distinct(&[
        (vault, VAULT),
        (vault_token_account, VAULT_TOKEN_ACCOUNT),
        (payout, PAYOUT),
        (destination, DESTINATION),
    ])?;
    check_release_accounts(&Release {
        mint,
        vault,
        state: &state,
        vault_token_account,
        vault_tokens: &vault_tokens,
        payout,
        receipt: &receipt,
        rent_payer,
        destination_owner,
        token_program,
    })?;
    // [A] destination: mut, token::mint = mint, token::token_program =
    // token_program.
    check_mut(destination, DESTINATION)?;
    if !same(&destination_tokens.mint, mint.address()) {
        return Err(fail_keys(
            CONSTRAINT_TOKEN_MINT,
            Some(DESTINATION),
            &destination_tokens.mint,
            mint.address(),
        ));
    }
    if !owned_by(destination, token_program.address()) {
        return Err(fail_keys(
            CONSTRAINT_TOKEN_TOKEN_PROGRAM,
            Some(DESTINATION),
            destination.owner(),
            token_program.address(),
        ));
    }
    check_memo_program(memo_program)?;

    // Handler.
    deliver(Delivery {
        vault,
        state: &mut state,
        payout,
        receipt: &receipt,
        mint,
        decimals,
        vault_token_account,
        destination,
        memo_program,
        token_program,
        rent_payer,
        extra: accounts.rest,
    })
}

// ----------------------------------------------------------------- deliver

struct Delivery<'a, 'b> {
    vault: &'a AccountView,
    state: &'b mut Vault,
    payout: &'a AccountView,
    receipt: &'b Payout,
    mint: &'a AccountView,
    decimals: u8,
    vault_token_account: &'a AccountView,
    destination: &'a AccountView,
    memo_program: &'a AccountView,
    token_program: &'a AccountView,
    rent_payer: &'a AccountView,
    extra: &'a [AccountView],
}

/// The rest of `release` / `release_to`: move the payout's tokens out of
/// the vault and release the reservation, then (exit) write the vault back
/// and close the payout to its rent payer.
#[inline(never)]
fn deliver(d: Delivery) -> ProgramResult {
    let amount = d.receipt.amount;
    d.state.reserved = d
        .state
        .reserved
        .checked_sub(amount)
        .ok_or_else(|| vault_error(VaultError::MathOverflow))?;
    if amount > 0 {
        if destination_requires_memo(d.destination)? {
            // A memo CPI right before the transfer (Token-2022 checks the
            // previous sibling instruction).
            sys::invoke(&MEMO_PROGRAM_ID, &[], PAYOUT_MEMO, &[d.memo_program], &[])?;
        }
        transfer_signed(&d, amount)?;
    }
    sys::log_data(&event_data::payout_released(
        d.vault.address(),
        d.payout.address(),
        d.receipt.sequence,
        &d.receipt.destination_owner,
        d.destination.address(),
        amount,
    ));

    // Exit: the vault, then the payout closes to its rent payer.
    write_back::<{ Vault::LEN }>(d.vault, VAULT, |data| d.state.write(data))?;
    close(d.payout, d.rent_payer)
}

/// Whether a Token-2022 account requires a memo before incoming transfers.
fn destination_requires_memo(account: &AccountView) -> Result<bool, ProgramError> {
    if !owned_by(account, &TOKEN_2022_PROGRAM_ID) {
        return Ok(false);
    }
    let data = account.try_borrow()?;
    let state = unpack_token_account(&data)?;
    Ok(requires_memo(state.tlv))
}

impl HookAccount for AccountView {
    fn key(&self) -> &Pubkey {
        self.address()
    }

    fn data(&self) -> &[u8] {
        // SAFETY: no account data is mutably borrowed (or written by a CPI)
        // while the transfer's accounts are resolved.
        unsafe { self.borrow_unchecked() }
    }
}

/// `transfer_checked` of `amount` from the vault's token account, signed by
/// the vault PDA (`[VAULT_SEED, mint, genesis_key_id, bump]`), with the
/// transfer-hook accounts resolved from the remaining accounts when the
/// mint has an active hook.
fn transfer_signed(d: &Delivery, amount: u64) -> ProgramResult {
    // TokenInstruction::TransferChecked { amount, decimals }
    let mut data = [0u8; 10];
    data[0] = 12;
    data[1..9].copy_from_slice(&amount.to_le_bytes());
    data[9] = d.decimals;

    let (source, mint, destination, authority) =
        (d.vault_token_account, d.mint, d.destination, d.vault);
    let mut entries: Vec<Entry<AccountView>> = Vec::with_capacity(16);
    entries.push(Entry::new(source, false, true));
    entries.push(Entry::new(mint, false, false));
    entries.push(Entry::new(destination, false, true));
    entries.push(Entry::new(authority, true, false));

    let hook_program = if owned_by(mint, &TOKEN_2022_PROGRAM_ID) {
        let data = mint.try_borrow()?;
        hook_program_id(unpack_mint(&data)?.tlv)
    } else {
        None
    };
    if let Some(hook_program) = hook_program {
        hook::add_extra_accounts_for_execute_cpi(
            &mut entries,
            &hook_program,
            source,
            mint,
            destination,
            authority,
            amount,
            d.extra,
        )?;
    }
    let metas: Vec<InstructionAccount> = entries
        .iter()
        .map(|e| InstructionAccount::new(e.account.address(), e.is_writable, e.is_signer))
        .collect();
    let infos: Vec<&AccountView> = entries.iter().map(|e| e.account).collect();

    let bump = [d.state.bump];
    let seeds = [
        Seed::from(VAULT_SEED),
        Seed::from(mint.address().as_ref()),
        Seed::from(&d.state.genesis_key_id),
        Seed::from(&bump),
    ];
    sys::invoke(
        d.token_program.address(),
        &metas,
        &data,
        &infos,
        &[Signer::from(&seeds)],
    )
}

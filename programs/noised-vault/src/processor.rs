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

use noised_onchain::{
    accounts::{
        check_address, check_close, check_distinct, check_has_one, check_mut, check_rent_exempt,
        close, init_program_account, write_back,
    },
    args, owned_by,
    pda::{check_seeds, check_seeds_with_bump},
    same, sys,
    sysvar::Rent,
    token::{
        associated_token_address, check_associated_token_account, check_mint_token_program,
        check_token_token_program, create_associated_token_account, destination_requires_memo,
        init_associated_token_account, memo, transfer_checked, unpack_mint, unpack_token_account,
        AssociatedToken, TokenAccount,
    },
};
use pinocchio::{
    cpi::{Seed, Signer},
    AccountView, Address, ProgramResult,
};

use crate::{
    discriminator,
    error::{anchor::*, fail, fail_keys, vault as vault_error, VaultError},
    event_data,
    message::withdraw_message,
    program::NoisedVault,
    state::{
        key_id, next_key_index, Payout, SolSha256, Vault, VaultKey, GENESIS_KEY_INDEX, PAYOUT_SEED,
        VAULT_SEED,
    },
    token::{
        mint_is_supported, ASSOCIATED_TOKEN_PROGRAM_ID, MEMO_PROGRAM_ID, PAYOUT_MEMO,
        SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
    },
    Pubkey, ID,
};

/// The program the shared checks log and compare with.
type P = NoisedVault;

/// The instruction's accounts, taken in order (`try_accounts`).
type Accounts<'a> = noised_onchain::accounts::Accounts<'a, P>;

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
    // [A] try_entry: the declared id; dispatch: the 8-byte discriminator
    // prefix; the event-CPI tag is a stub without `event-cpi`; anything else
    // has no fallback.
    let (tag, args) = args::instruction::<P>(program_id, data)?;
    let accounts = Accounts::new(accounts);
    match *tag {
        discriminator::OPEN_VAULT => open_vault(accounts, args),
        discriminator::WITHDRAW => withdraw(accounts, args),
        discriminator::RELEASE => release(accounts),
        discriminator::RELEASE_TO => release_to(accounts),
        _ => Err(args::unknown::<P>(tag)),
    }
}

/// `msg!("Instruction: <Name>")`, unless built with `no-log-ix-name`.
fn log_instruction(_name: &str) {
    #[cfg(not(feature = "no-log-ix-name"))]
    sys::log(_name);
}

// ------------------------------------------------------------- constraints

/// [A] `seeds = [VAULT_SEED, mint, vault.genesis_key_id], bump = vault.bump`
/// (`create_program_address`), `mut`, `has_one = mint`.
fn check_vault(vault: &AccountView, state: &Vault, mint: &AccountView) -> ProgramResult {
    check_seeds_with_bump::<P>(
        vault,
        &[
            VAULT_SEED,
            mint.address().as_ref(),
            &state.genesis_key_id,
            &[state.bump],
        ],
        &ID,
        VAULT,
    )?;
    check_mut::<P>(vault, VAULT)?;
    check_has_one::<P>(&state.mint, mint, VAULT)
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
    check_associated_token_account::<P>(
        account,
        state,
        vault,
        mint,
        token_program,
        VAULT_TOKEN_ACCOUNT,
    )
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
    check_seeds_with_bump::<P>(
        payout,
        &[
            PAYOUT_SEED,
            vault.address().as_ref(),
            &state.sequence.to_le_bytes(),
            &[state.bump],
        ],
        &ID,
        PAYOUT,
    )?;
    check_mut::<P>(payout, PAYOUT)?;
    check_has_one::<P>(&state.vault, vault, PAYOUT)?;
    check_has_one::<P>(&state.rent_payer, rent_payer, PAYOUT)?;
    check_has_one::<P>(&state.destination_owner, destination_owner, PAYOUT)?;
    check_close::<P>(payout, rent_payer, PAYOUT)
}

/// [A] `address = MEMO_PROGRAM_ID`: `ConstraintAddress`.
fn check_memo_program(memo_program: &AccountView) -> ProgramResult {
    check_address::<P>(memo_program, &MEMO_PROGRAM_ID, MEMO_PROGRAM)
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
    let bump = check_seeds::<P>(
        vault,
        &[VAULT_SEED, mint.address().as_ref(), &key_id_arg],
        &ID,
        VAULT,
    )?;
    let bump_seed = [bump];
    init_program_account::<P>(
        payer,
        vault,
        Vault::LEN,
        &rent,
        &[Signer::from(&[
            Seed::from(VAULT_SEED),
            Seed::from(mint.address().as_ref()),
            Seed::from(&key_id_arg),
            Seed::from(&bump_seed),
        ])],
        VAULT,
    )?;
    // [A] constraint = key_id(&key.public_key()) == key_id_arg @ KeyIdMismatch
    if key_id(&key.public_key()) != key_id_arg {
        return Err(fail(u32::from(VaultError::KeyIdMismatch), Some(VAULT)));
    }
    check_rent_exempt::<P>(vault, &rent, VAULT)?;

    // [A] vault_token_account: init_if_needed, associated_token::mint =
    // mint, associated_token::authority = vault,
    // associated_token::token_program = token_program, then mut and rent
    // exemption. Anyone can create the ATA first, which must not block
    // opening.
    init_associated_token_account::<P, true>(
        &AssociatedToken {
            payer,
            account: vault_token_account,
            authority: vault,
            mint,
            token_program,
            system_program,
        },
        &rent,
        VAULT_TOKEN_ACCOUNT,
    )?;

    // [A] duplicate mutable accounts: vault_token_account is the only
    // candidate (vault is a plain init). Then payer: mut; mint:
    // mint::token_program.
    check_mut::<P>(payer, PAYER)?;
    check_mint_token_program::<P>(mint, token_program)?;

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
    write_back::<P, { Vault::LEN }>(vault, VAULT, |data| state.write(data))
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
    let (vault, mut state) = accounts.account::<Vault>(VAULT)?;
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
    let payout_bump = check_seeds::<P>(
        payout,
        &[PAYOUT_SEED, vault.address().as_ref(), &sequence_le],
        &ID,
        PAYOUT,
    )?;
    let bump_seed = [payout_bump];
    init_program_account::<P>(
        payer,
        payout,
        Payout::LEN,
        &rent,
        &[Signer::from(&[
            Seed::from(PAYOUT_SEED),
            Seed::from(vault.address().as_ref()),
            Seed::from(&sequence_le),
            Seed::from(&bump_seed),
        ])],
        PAYOUT,
    )?;
    check_rent_exempt::<P>(payout, &rent, PAYOUT)?;

    // [A] duplicate mutable accounts: vault is the only candidate. Then
    // payer: mut; mint: mint::token_program; vault: seeds, mut, has_one =
    // mint; vault_token_account: associated_token (read only).
    check_mut::<P>(payer, PAYER)?;
    check_mint_token_program::<P>(mint, token_program)?;
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
    write_back::<P, { Vault::LEN }>(vault, VAULT, |data| state.write(data))?;
    write_back::<P, { Payout::LEN }>(payout, PAYOUT, |data| {
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
    let (vault, mut state) = accounts.account::<Vault>(VAULT)?;
    let (vault_token_account, vault_tokens) = accounts.token_account(VAULT_TOKEN_ACCOUNT)?;
    let (payout, receipt) = accounts.account::<Payout>(PAYOUT)?;
    let rent_payer = accounts.unchecked(RENT_PAYER)?;
    let destination_owner = accounts.unchecked(DESTINATION_OWNER)?;
    let destination = accounts.unchecked(DESTINATION)?;
    let memo_program = accounts.unchecked(MEMO_PROGRAM)?;
    let token_program = accounts.token_program(TOKEN_PROGRAM)?;
    accounts.program(&ASSOCIATED_TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM)?;
    let system_program = accounts.program(&SYSTEM_PROGRAM_ID, SYSTEM_PROGRAM)?;

    check_distinct::<P>(&[
        (vault, VAULT),
        (vault_token_account, VAULT_TOKEN_ACCOUNT),
        (payout, PAYOUT),
    ])?;
    check_mut::<P>(payer, PAYER)?;
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
    check_mut::<P>(destination, DESTINATION)?;
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
        extra: accounts.remaining(),
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
    check_mint_token_program::<P>(r.mint, r.token_program)?;
    check_vault(r.vault, r.state, r.mint)?;
    check_vault_token_account(
        r.vault_token_account,
        r.vault_tokens,
        r.vault,
        r.mint,
        r.token_program,
    )?;
    check_mut::<P>(r.vault_token_account, VAULT_TOKEN_ACCOUNT)?;
    check_payout(
        r.payout,
        r.receipt,
        r.vault,
        r.rent_payer,
        r.destination_owner,
    )?;
    check_mut::<P>(r.rent_payer, RENT_PAYER)
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
        create_associated_token_account(
            true,
            payer,
            &expected,
            ata,
            wallet,
            mint,
            system_program,
            token_program,
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
    let account_mint = account.mint();
    if !same(&account_mint, mint.address()) {
        return Err(fail_keys(
            invalid_destination,
            None,
            &account_mint,
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
    let (vault, mut state) = accounts.account::<Vault>(VAULT)?;
    let (vault_token_account, vault_tokens) = accounts.token_account(VAULT_TOKEN_ACCOUNT)?;
    let (payout, receipt) = accounts.account::<Payout>(PAYOUT)?;
    let rent_payer = accounts.unchecked(RENT_PAYER)?;
    let (destination, destination_tokens) = accounts.token_account(DESTINATION)?;
    let memo_program = accounts.unchecked(MEMO_PROGRAM)?;
    let token_program = accounts.token_program(TOKEN_PROGRAM)?;

    check_distinct::<P>(&[
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
    check_mut::<P>(destination, DESTINATION)?;
    if !same(&destination_tokens.mint, mint.address()) {
        return Err(fail_keys(
            CONSTRAINT_TOKEN_MINT,
            Some(DESTINATION),
            &destination_tokens.mint,
            mint.address(),
        ));
    }
    check_token_token_program::<P>(destination, token_program, DESTINATION)?;
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
        extra: accounts.remaining(),
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
            memo(d.memo_program, PAYOUT_MEMO)?;
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
    write_back::<P, { Vault::LEN }>(d.vault, VAULT, |data| d.state.write(data))?;
    close(d.payout, d.rent_payer)
}

/// `transfer_checked` of `amount` from the vault's token account, signed by
/// the vault PDA (`[VAULT_SEED, mint, genesis_key_id, bump]`), with the
/// transfer-hook accounts resolved from the remaining accounts when the
/// mint has an active hook.
fn transfer_signed(d: &Delivery, amount: u64) -> ProgramResult {
    let bump = [d.state.bump];
    let seeds = [
        Seed::from(VAULT_SEED),
        Seed::from(d.mint.address().as_ref()),
        Seed::from(&d.state.genesis_key_id),
        Seed::from(&bump),
    ];
    transfer_checked(
        d.token_program,
        d.vault_token_account,
        d.mint,
        d.destination,
        d.vault,
        amount,
        d.decimals,
        &[Signer::from(&seeds)],
        d.extra,
    )
}

//! SPL Token / Token-2022 handling against the SPL crates an Anchor 1.2.1
//! build runs (through anchor-spl): account parsing and extensions
//! (spl-token-2022-interface 2.1.0), transfer-hook account resolution
//! (spl-transfer-hook-interface 2.1.0, spl-tlv-account-resolution 0.11.1,
//! spl-type-length-value 0.9.1, spl-pod 0.7.4), and the instructions of
//! every CPI helper (spl-token-2022 / ATA / system instruction builders).
//! Random inputs, malformed ones included, must give the same result or the
//! same error.

use std::panic::{catch_unwind, AssertUnwindSafe};

use anchor_lang::solana_program::system_instruction;
use anchor_spl::{
    associated_token::spl_associated_token_account as ata_interface,
    token_2022::spl_token_2022::{
        self,
        error::TokenError,
        extension::{
            memo_transfer::MemoTransfer, metadata_pointer,
            mint_close_authority::MintCloseAuthority, transfer_fee::TransferFeeConfig,
            transfer_hook, BaseStateWithExtensions, StateWithExtensions,
        },
    },
};
use noised_onchain::{
    cpi,
    host::{
        fuzz::{random_mint, random_token_account, Rng},
        take_cpis, Cpi, HostAccount,
    },
    ids::*,
    token::{self, hook},
    Address,
};
use solana_account_info::AccountInfo;
use solana_instruction::{AccountMeta, Instruction};
use solana_program_error::ProgramError;
use spl_tlv_account_resolution::account::ExtraAccountMeta;
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

fn sha256_8(input: &str) -> [u8; 8] {
    noised_onchain::hashv(&[input.as_bytes()])[..8]
        .try_into()
        .unwrap()
}

// ---------------------------------------------------------------- ids

#[test]
fn well_known_ids() {
    assert_eq!(TOKEN_PROGRAM_ID, anchor_spl::token::ID);
    assert_eq!(TOKEN_2022_PROGRAM_ID, anchor_spl::token_2022::ID);
    assert_eq!(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        anchor_spl::associated_token::ID
    );
    assert_eq!(SYSTEM_PROGRAM_ID, anchor_lang::system_program::ID);
    assert_eq!(
        MEMO_PROGRAM_ID,
        anchor_lang::pubkey!("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr")
    );
    assert_eq!(
        BPF_LOADER_UPGRADEABLE_ID,
        anchor_lang::solana_program::bpf_loader_upgradeable::ID
    );
    assert_eq!(
        hook::EXECUTE_DISCRIMINATOR,
        sha256_8("spl-transfer-hook-interface:execute")
    );
    assert_eq!(
        &hook::EXECUTE_DISCRIMINATOR[..],
        <ExecuteInstruction as spl_discriminator::SplDiscriminate>::SPL_DISCRIMINATOR_SLICE
    );
}

/// The other programs' error numbers that come back as they are.
#[test]
fn spl_error_numbers() {
    use spl_tlv_account_resolution::error::AccountResolutionError as R;
    assert_eq!(
        token::EXTENSION_NOT_FOUND,
        TokenError::ExtensionNotFound as u32
    );
    assert_eq!(
        hook::HOOK_INCORRECT_ACCOUNT,
        spl_transfer_hook_interface::error::TransferHookError::IncorrectAccount as u32
    );
    for (ours, theirs) in [
        (hook::RESOLUTION_INCORRECT_ACCOUNT, R::IncorrectAccount),
        (
            hook::RESOLUTION_INVALID_BYTES_FOR_SEED,
            R::InvalidBytesForSeed,
        ),
        (
            hook::RESOLUTION_INSTRUCTION_DATA_TOO_SMALL,
            R::InstructionDataTooSmall,
        ),
        (hook::RESOLUTION_ACCOUNT_NOT_FOUND, R::AccountNotFound),
        (
            hook::RESOLUTION_ACCOUNT_DATA_TOO_SMALL,
            R::AccountDataTooSmall,
        ),
    ] {
        assert_eq!(ours, theirs as u32);
    }
    assert_eq!(
        ProgramError::Custom(hook::TLV_TYPE_NOT_FOUND),
        spl_type_length_value::error::TlvError::TypeNotFound.into()
    );
    assert_eq!(
        ProgramError::Custom(hook::POD_BUFFER_TOO_SMALL),
        spl_pod::error::PodSliceError::BufferTooSmall.into()
    );
}

/// The extension numbers and sizes are spl-token-2022-interface's.
#[test]
fn extension_types_and_sizes() {
    use spl_token_2022::extension::{
        default_account_state::DefaultAccountState, pausable::PausableConfig,
        permanent_delegate::PermanentDelegate, ExtensionType as E,
    };
    let types = [
        (token::EXT_TRANSFER_FEE_CONFIG, E::TransferFeeConfig),
        (token::EXT_TRANSFER_FEE_AMOUNT, E::TransferFeeAmount),
        (token::EXT_MINT_CLOSE_AUTHORITY, E::MintCloseAuthority),
        (
            token::EXT_CONFIDENTIAL_TRANSFER_MINT,
            E::ConfidentialTransferMint,
        ),
        (
            token::EXT_CONFIDENTIAL_TRANSFER_ACCOUNT,
            E::ConfidentialTransferAccount,
        ),
        (token::EXT_DEFAULT_ACCOUNT_STATE, E::DefaultAccountState),
        (token::EXT_IMMUTABLE_OWNER, E::ImmutableOwner),
        (token::EXT_MEMO_TRANSFER, E::MemoTransfer),
        (token::EXT_NON_TRANSFERABLE, E::NonTransferable),
        (token::EXT_INTEREST_BEARING_CONFIG, E::InterestBearingConfig),
        (token::EXT_CPI_GUARD, E::CpiGuard),
        (token::EXT_PERMANENT_DELEGATE, E::PermanentDelegate),
        (
            token::EXT_NON_TRANSFERABLE_ACCOUNT,
            E::NonTransferableAccount,
        ),
        (token::EXT_TRANSFER_HOOK, E::TransferHook),
        (token::EXT_TRANSFER_HOOK_ACCOUNT, E::TransferHookAccount),
        (
            token::EXT_CONFIDENTIAL_TRANSFER_FEE_CONFIG,
            E::ConfidentialTransferFeeConfig,
        ),
        (
            token::EXT_CONFIDENTIAL_TRANSFER_FEE_AMOUNT,
            E::ConfidentialTransferFeeAmount,
        ),
        (token::EXT_METADATA_POINTER, E::MetadataPointer),
        (token::EXT_TOKEN_METADATA, E::TokenMetadata),
        (token::EXT_GROUP_POINTER, E::GroupPointer),
        (token::EXT_TOKEN_GROUP, E::TokenGroup),
        (token::EXT_GROUP_MEMBER_POINTER, E::GroupMemberPointer),
        (token::EXT_TOKEN_GROUP_MEMBER, E::TokenGroupMember),
        (token::EXT_CONFIDENTIAL_MINT_BURN, E::ConfidentialMintBurn),
        (token::EXT_SCALED_UI_AMOUNT, E::ScaledUiAmount),
        (token::EXT_PAUSABLE, E::Pausable),
        (token::EXT_PAUSABLE_ACCOUNT, E::PausableAccount),
    ];
    for (ours, theirs) in types {
        assert_eq!(ours, u16::from(theirs), "{theirs:?}");
    }
    assert_eq!(types.len(), usize::from(token::EXTENSION_TYPE_MAX));
    assert!(E::try_from(&(token::EXTENSION_TYPE_MAX + 1).to_le_bytes()[..]).is_err());
    let sizes = [
        (
            token::TRANSFER_FEE_CONFIG_LEN,
            size_of::<TransferFeeConfig>(),
        ),
        (
            token::MINT_CLOSE_AUTHORITY_LEN,
            size_of::<MintCloseAuthority>(),
        ),
        (
            token::DEFAULT_ACCOUNT_STATE_LEN,
            size_of::<DefaultAccountState>(),
        ),
        (token::MEMO_TRANSFER_LEN, size_of::<MemoTransfer>()),
        (
            token::PERMANENT_DELEGATE_LEN,
            size_of::<PermanentDelegate>(),
        ),
        (
            token::TRANSFER_HOOK_LEN,
            size_of::<transfer_hook::TransferHook>(),
        ),
        (
            token::TRANSFER_HOOK_ACCOUNT_LEN,
            size_of::<transfer_hook::TransferHookAccount>(),
        ),
        (
            token::METADATA_POINTER_LEN,
            size_of::<metadata_pointer::MetadataPointer>(),
        ),
        (token::PAUSABLE_LEN, size_of::<PausableConfig>()),
    ];
    for (ours, theirs) in sizes {
        assert_eq!(ours, theirs);
    }
}

// ------------------------------------------------------- token accounts

fn coption_key<T: Into<Option<anchor_lang::prelude::Pubkey>>>(v: T) -> Option<Address> {
    v.into()
}

/// Mint and token account parsing, every base field, the extension types,
/// fixed-size extensions, the hook program and the memo requirement are
/// spl-token-2022-interface's, error for error.
#[test]
fn token_parsing_matches_spl_token_2022() {
    let mut r = Rng(5);
    let (mut mints_ok, mut accounts_ok, mut hooks, mut memos) = (0, 0, 0, 0);
    for round in 0..200_000 {
        let data = random_mint(&mut r);
        let theirs = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&data);
        let ours = token::unpack_mint(&data);
        match (&theirs, &ours) {
            (Ok(t), Ok(o)) => {
                mints_ok += 1;
                assert_eq!(t.base.decimals, o.decimals(), "round {round}");
                assert_eq!(t.base.supply, o.supply(), "round {round}");
                assert_eq!(
                    coption_key(t.base.mint_authority),
                    o.mint_authority(),
                    "round {round}"
                );
                assert_eq!(
                    coption_key(t.base.freeze_authority),
                    o.freeze_authority(),
                    "round {round}"
                );
                // Extension types: all parse, or the same error.
                let mut types = Vec::new();
                let walked = token::for_each_extension_type(o.tlv, |ty| {
                    types.push(ty);
                    Ok(())
                });
                match t.get_extension_types() {
                    Ok(expected) => {
                        assert_eq!(walked, Ok(()), "round {round}");
                        let expected: Vec<u16> = expected.into_iter().map(u16::from).collect();
                        assert_eq!(types, expected, "round {round}");
                    }
                    Err(e) => assert_eq!(walked, Err(e), "round {round}"),
                }
                let hook = token::hook_program_id(o.tlv);
                assert_eq!(hook, transfer_hook::get_program_id(t), "round {round}");
                hooks += usize::from(hook.is_some());
                for (ty, len) in [
                    (
                        token::EXT_MINT_CLOSE_AUTHORITY,
                        token::MINT_CLOSE_AUTHORITY_LEN,
                    ),
                    (
                        token::EXT_TRANSFER_FEE_CONFIG,
                        token::TRANSFER_FEE_CONFIG_LEN,
                    ),
                    (token::EXT_TRANSFER_HOOK, token::TRANSFER_HOOK_LEN),
                    (token::EXT_METADATA_POINTER, token::METADATA_POINTER_LEN),
                ] {
                    let theirs = match ty {
                        token::EXT_MINT_CLOSE_AUTHORITY => t
                            .get_extension::<MintCloseAuthority>()
                            .map(bytemuck::bytes_of),
                        token::EXT_TRANSFER_FEE_CONFIG => t
                            .get_extension::<TransferFeeConfig>()
                            .map(bytemuck::bytes_of),
                        token::EXT_METADATA_POINTER => t
                            .get_extension::<metadata_pointer::MetadataPointer>()
                            .map(bytemuck::bytes_of),
                        _ => t
                            .get_extension::<transfer_hook::TransferHook>()
                            .map(bytemuck::bytes_of),
                    };
                    assert_eq!(
                        token::get_extension(o.tlv, ty, len),
                        theirs,
                        "round {round}"
                    );
                }
                // Variable-length: TokenMetadata's raw bytes.
                assert_eq!(
                    token::get_extension_bytes(o.tlv, token::EXT_TOKEN_METADATA),
                    t.get_extension_bytes::<
                        anchor_spl::compat::spl_token_metadata_interface::state::TokenMetadata,
                    >(),
                    "round {round}"
                );
            }
            (Err(t), Err(o)) => assert_eq!(t, o, "round {round}"),
            _ => panic!("round {round}: {:?} vs {:?}", theirs.is_ok(), ours.is_ok()),
        }

        let data = random_token_account(&mut r);
        let theirs = StateWithExtensions::<spl_token_2022::state::Account>::unpack(&data);
        let ours = token::unpack_token_account(&data);
        match (&theirs, &ours) {
            (Ok(t), Ok(o)) => {
                accounts_ok += 1;
                let b = &t.base;
                assert_eq!(
                    (b.mint, b.owner, b.amount, b.delegated_amount),
                    (o.mint(), o.owner(), o.amount(), o.delegated_amount()),
                    "round {round}"
                );
                assert_eq!(coption_key(b.delegate), o.delegate(), "round {round}");
                assert_eq!(
                    coption_key(b.close_authority),
                    o.close_authority(),
                    "round {round}"
                );
                assert_eq!(Option::<u64>::from(b.is_native), o.is_native());
                assert_eq!(b.state as u8, o.state(), "round {round}");
                assert_eq!(b.is_frozen(), o.is_frozen(), "round {round}");
                let snapshot = token::TokenAccount::from_state(o);
                assert_eq!(
                    (snapshot.mint, snapshot.owner, snapshot.amount),
                    (b.mint, b.owner, b.amount)
                );
                let memo = token::requires_memo(o.tlv);
                assert_eq!(
                    memo,
                    t.get_extension::<MemoTransfer>()
                        .map(|m| bool::from(m.require_incoming_transfer_memos))
                        .unwrap_or(false),
                    "round {round}"
                );
                memos += usize::from(memo);
                assert_eq!(
                    token::get_extension(o.tlv, token::EXT_MEMO_TRANSFER, token::MEMO_TRANSFER_LEN),
                    t.get_extension::<MemoTransfer>().map(bytemuck::bytes_of),
                    "round {round}"
                );
            }
            (Err(t), Err(o)) => assert_eq!(t, o, "round {round}"),
            _ => panic!("round {round}: {:?} vs {:?}", theirs.is_ok(), ours.is_ok()),
        }
    }
    // The random inputs reach every outcome.
    assert!(
        mints_ok > 10_000 && accounts_ok > 10_000,
        "{mints_ok} {accounts_ok}"
    );
    assert!(hooks > 100 && memos > 100, "{hooks} {memos}");
}

// ------------------------------------------------------ transfer hooks

/// A host account for the resolver. `borrowed`: its data is mutably
/// borrowed while the resolution runs (the SPL side holds a `RefMut`).
struct TestAccount {
    key: Address,
    data: Vec<u8>,
    is_signer: bool,
    is_writable: bool,
    borrowed: bool,
}

impl hook::HookAccount for TestAccount {
    fn key(&self) -> &Address {
        &self.key
    }
    fn check_borrow(&self) -> Result<(), ProgramError> {
        if self.borrowed {
            Err(ProgramError::AccountBorrowFailed)
        } else {
            Ok(())
        }
    }
    unsafe fn data(&self) -> &[u8] {
        &self.data
    }
}

/// A random seed config (sometimes malformed) packed into 32 bytes.
fn random_address_config(r: &mut Rng, accounts: usize) -> [u8; 32] {
    let mut config = [0u8; 32];
    if r.chance(10) {
        return r.array();
    }
    let mut i = 0;
    for _ in 0..r.below(5) {
        let seed: Vec<u8> = match r.below(9) {
            0 | 1 => {
                let len = r.below(12) as usize;
                let mut s = vec![1, len as u8];
                s.extend(r.bytes(len));
                s
            }
            2 | 3 => vec![2, r.below(18) as u8, r.below(10) as u8],
            4 | 5 => vec![3, r.below(accounts as u64 + 2) as u8],
            6 | 7 => vec![
                4,
                r.below(accounts as u64 + 2) as u8,
                r.below(40) as u8,
                r.pick(&[0, 8, 32, 33]),
            ],
            _ => vec![r.below(7) as u8, r.byte(), r.byte()],
        };
        if i + seed.len() > 32 {
            break;
        }
        config[i..i + seed.len()].copy_from_slice(&seed);
        i += seed.len();
    }
    config
}

fn random_extra_meta(r: &mut Rng, accounts: usize, known: &[Address]) -> [u8; 35] {
    let mut meta = [0u8; 35];
    let discriminator = match r.below(12) {
        0..=3 => 0,
        4..=7 => 1,
        8 => 2,
        9 => 128 + r.below(accounts as u64 + 1) as u8,
        10 => r.pick(&[3, 5, 127, 255]),
        _ => 129,
    };
    meta[0] = discriminator;
    let config = match discriminator {
        0 => {
            if r.chance(70) && !known.is_empty() {
                known[r.below(known.len() as u64) as usize].to_bytes()
            } else {
                r.array()
            }
        }
        2 => {
            let mut c = [0u8; 32];
            match r.below(4) {
                0 => c[..2].copy_from_slice(&[1, r.below(20) as u8]),
                1 => c[..3].copy_from_slice(&[
                    2,
                    r.below(accounts as u64 + 2) as u8,
                    r.below(40) as u8,
                ]),
                2 => c[0] = r.pick(&[0, 3, 9]),
                _ => c = r.array(),
            }
            c
        }
        _ => random_address_config(r, accounts),
    };
    meta[1..33].copy_from_slice(&config);
    meta[33] = r.pick(&[0, 1, 1, 2]);
    meta[34] = r.pick(&[0, 1, 1, 7]);
    meta
}

/// The validation account data: TLV entries around the Execute entry, its
/// list of metas (sometimes malformed).
fn validation_data(r: &mut Rng, metas: &[[u8; 35]]) -> Vec<u8> {
    let mut list = Vec::new();
    let count = if r.chance(5) {
        metas.len() as u32 + r.below(3) as u32
    } else {
        metas.len() as u32
    };
    list.extend_from_slice(&count.to_le_bytes());
    for m in metas {
        list.extend_from_slice(m);
    }
    if r.chance(3) {
        list.push(0);
    }
    if r.chance(2) {
        list.truncate(r.below(4) as usize);
    }
    let mut data = Vec::new();
    if r.chance(15) {
        // An entry of another type first.
        data.extend_from_slice(&r.array::<8>());
        let len = r.below(10) as u32;
        data.extend_from_slice(&len.to_le_bytes());
        data.extend(r.bytes(len as usize));
    }
    let mut tag = hook::EXECUTE_DISCRIMINATOR;
    if r.chance(3) {
        tag = [0; 8];
    } else if r.chance(2) {
        tag[0] ^= 1;
    }
    data.extend_from_slice(&tag);
    let mut len = list.len() as u32;
    if r.chance(3) {
        len += r.below(5) as u32;
    }
    data.extend_from_slice(&len.to_le_bytes());
    data.extend(list);
    match r.below(10) {
        0 => data.extend(vec![0; r.below(9) as usize]),
        1 => data.extend(r.some_bytes(9)),
        _ => {}
    }
    data
}

/// What a resolution run gives: the accounts with their flags, an error,
/// or a panic (no viable PDA, or invalid seeds).
#[derive(Debug, PartialEq)]
enum Outcome {
    Accounts(Vec<(Address, bool, bool)>),
    Error(ProgramError),
    Panic,
}

fn run_spl(
    program_id: &Address,
    base: &[TestAccount; 4],
    extra: &[TestAccount],
    amount: u64,
) -> Outcome {
    let owner = Address::new_from_array([9; 32]);
    let mut lamports: Vec<u64> = vec![0; 4 + extra.len()];
    let mut datas: Vec<Vec<u8>> = base.iter().chain(extra).map(|a| a.data.clone()).collect();
    let all: Vec<&TestAccount> = base.iter().chain(extra).collect();
    let mut infos = Vec::new();
    for ((account, lamports), data) in all.iter().zip(lamports.iter_mut()).zip(datas.iter_mut()) {
        infos.push(AccountInfo::new(
            &account.key,
            account.is_signer,
            account.is_writable,
            lamports,
            data,
            &owner,
            false,
        ));
    }
    // The accounts marked `borrowed` stay mutably borrowed during the call.
    let held: Vec<_> = infos
        .iter()
        .zip(&all)
        .filter(|(_, account)| account.borrowed)
        .map(|(info, _)| info.try_borrow_mut_data().unwrap())
        .collect();
    let (base_infos, extra_infos) = infos.split_at(4);
    let mut cpi = Instruction::new_with_bytes(
        TOKEN_2022_PROGRAM_ID,
        &[],
        vec![
            AccountMeta::new(base[0].key, false),
            AccountMeta::new_readonly(base[1].key, false),
            AccountMeta::new(base[2].key, false),
            AccountMeta::new_readonly(base[3].key, true),
        ],
    );
    let mut cpi_infos = base_infos.to_vec();
    let result = catch_unwind(AssertUnwindSafe(|| {
        spl_transfer_hook_interface::onchain::add_extra_accounts_for_execute_cpi(
            &mut cpi,
            &mut cpi_infos,
            program_id,
            base_infos[0].clone(),
            base_infos[1].clone(),
            base_infos[2].clone(),
            base_infos[3].clone(),
            amount,
            extra_infos,
        )
    }));
    drop(held);
    match result {
        Err(_) => Outcome::Panic,
        Ok(Err(e)) => Outcome::Error(e),
        Ok(Ok(())) => {
            assert_eq!(cpi.accounts.len(), cpi_infos.len());
            for (meta, info) in cpi.accounts.iter().zip(&cpi_infos) {
                assert_eq!(meta.pubkey, *info.key);
            }
            Outcome::Accounts(
                cpi.accounts
                    .iter()
                    .map(|m| (m.pubkey, m.is_signer, m.is_writable))
                    .collect(),
            )
        }
    }
}

fn run_ours(
    program_id: &Address,
    base: &[TestAccount; 4],
    extra: &[TestAccount],
    amount: u64,
) -> Outcome {
    let mut entries: Vec<hook::Entry<TestAccount>> = vec![
        hook::Entry::new(&base[0], false, true),
        hook::Entry::new(&base[1], false, false),
        hook::Entry::new(&base[2], false, true),
        hook::Entry::new(&base[3], true, false),
    ];
    let result = catch_unwind(AssertUnwindSafe(|| {
        hook::add_extra_accounts_for_execute_cpi(
            &mut entries,
            program_id,
            &base[0],
            &base[1],
            &base[2],
            &base[3],
            amount,
            extra,
        )
    }));
    match result {
        Err(_) => Outcome::Panic,
        Ok(Err(e)) => Outcome::Error(e),
        Ok(Ok(())) => Outcome::Accounts(
            entries
                .iter()
                .map(|e| (e.account.key, e.is_signer, e.is_writable))
                .collect(),
        ),
    }
}

/// The transfer-hook accounts added to a `transfer_checked` CPI are exactly
/// spl-transfer-hook-interface's (`add_extra_accounts_for_execute_cpi` with
/// spl-tlv-account-resolution 0.11.1): the same accounts, order and flags,
/// or the same error, for random validation data, seed configs and account
/// sets, and with one account now and then mutably borrowed during the call
/// (`AccountBorrowFailed` exactly where the SPL code borrows it).
#[test]
fn hook_accounts_match_spl_transfer_hook_interface() {
    let quiet = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let mut r = Rng(6);
    let mut tally = std::collections::BTreeMap::<&str, usize>::new();
    for round in 0..20_000 {
        let program_id = r.key();
        let account = |r: &mut Rng, signer: bool, writable: bool| TestAccount {
            key: r.key(),
            data: r.some_bytes(80),
            is_signer: signer,
            is_writable: writable,
            borrowed: false,
        };
        let mut base = [
            account(&mut r, false, true),
            account(&mut r, false, false),
            account(&mut r, false, true),
            account(&mut r, true, false),
        ];
        let amount = r.next();
        let validation_key = hook::extra_account_metas_address(&base[1].key, &program_id);
        let known: Vec<Address> = base
            .iter()
            .map(|a| a.key)
            .chain([program_id, validation_key])
            .collect();
        let metas: Vec<[u8; 35]> = (0..r.below(6))
            .map(|i| random_extra_meta(&mut r, 5 + i as usize, &known))
            .collect();

        let mut extra = Vec::new();
        if r.chance(92) {
            extra.push(TestAccount {
                key: program_id,
                data: vec![],
                is_signer: false,
                is_writable: false,
                borrowed: false,
            });
        }
        if r.chance(92) {
            extra.push(TestAccount {
                key: validation_key,
                data: validation_data(&mut r, &metas),
                is_signer: false,
                is_writable: r.chance(50),
                borrowed: false,
            });
        }
        // Accounts the metas resolve to (usually present), found by running
        // the SPL resolver step by step.
        let mut seen: Vec<(Address, Vec<u8>)> = base
            .iter()
            .map(|a| (a.key, a.data.clone()))
            .chain(
                extra
                    .iter()
                    .filter(|a| a.key == validation_key)
                    .map(|a| (a.key, a.data.clone())),
            )
            .collect();
        let mut execute_data = hook::EXECUTE_DISCRIMINATOR.to_vec();
        execute_data.extend_from_slice(&amount.to_le_bytes());
        for meta in &metas {
            let meta: &ExtraAccountMeta = bytemuck::from_bytes(meta);
            let resolved = catch_unwind(AssertUnwindSafe(|| {
                meta.resolve(&execute_data, &program_id, |i| {
                    seen.get(i).map(|(k, d)| (k, Some(d.as_slice())))
                })
            }));
            let Ok(Ok(resolved)) = resolved else { break };
            let data = r.some_bytes(60);
            if r.chance(90) && !extra.iter().any(|a| a.key == resolved.pubkey) {
                extra.push(TestAccount {
                    key: resolved.pubkey,
                    data: data.clone(),
                    is_signer: r.chance(30),
                    is_writable: r.chance(50),
                    borrowed: false,
                });
            }
            let data = extra
                .iter()
                .chain(base.iter())
                .find(|a| a.key == resolved.pubkey)
                .map(|a| a.data.clone())
                .unwrap_or(data);
            seen.push((resolved.pubkey, data));
        }
        for _ in 0..r.below(3) {
            let (signer, writable) = (r.chance(20), r.chance(50));
            extra.push(account(&mut r, signer, writable));
        }
        if r.chance(20) {
            // A base account among the extras too.
            let i = r.below(4) as usize;
            extra.push(TestAccount {
                key: base[i].key,
                data: base[i].data.clone(),
                is_signer: base[i].is_signer,
                is_writable: base[i].is_writable,
                borrowed: false,
            });
        }
        // Shuffle.
        for i in (1..extra.len()).rev() {
            let j = r.below(i as u64 + 1) as usize;
            extra.swap(i, j);
        }
        // Now and then one account is mutably borrowed during the call
        // (review L-2): both resolvers fail with AccountBorrowFailed if and
        // where they borrow it. A separate generator keeps the other cases
        // as they were.
        let mut b = Rng(0xB0B0_0000 ^ round as u64);
        if b.chance(10) {
            let i = b.below(4 + extra.len() as u64) as usize;
            match i.checked_sub(4) {
                Some(j) => extra[j].borrowed = true,
                None => base[i].borrowed = true,
            }
        }

        let theirs = run_spl(&program_id, &base, &extra, amount);
        let ours = run_ours(&program_id, &base, &extra, amount);
        assert_eq!(ours, theirs, "round {round}");
        let label = match &theirs {
            Outcome::Error(ProgramError::AccountBorrowFailed) => "borrowed",
            Outcome::Accounts(a) if a.len() > 6 => "resolved extra accounts",
            Outcome::Accounts(_) => "program only / no extras",
            Outcome::Error(_) => "error",
            Outcome::Panic => "panic",
        };
        *tally.entry(label).or_default() += 1;
    }
    std::panic::set_hook(quiet);
    println!("{tally:?}");
    for label in [
        "resolved extra accounts",
        "program only / no extras",
        "error",
        "borrowed",
    ] {
        assert!(tally.get(label).copied().unwrap_or(0) > 100, "{tally:?}");
    }
}

/// The validation account's TLV area and list, alone: the Execute entry is
/// spl-type-length-value's `get_first_bytes` (after `unpack`), the list
/// spl-pod's `ListView` unpack.
#[test]
fn validation_tlv_matches_spl_type_length_value() {
    use spl_type_length_value::state::{TlvState, TlvStateBorrowed};
    let mut r = Rng(7);
    let known = [Address::new_from_array([1; 32])];
    for round in 0..100_000 {
        let metas: Vec<[u8; 35]> = (0..r.below(4))
            .map(|_| random_extra_meta(&mut r, 5, &known))
            .collect();
        let data = if r.chance(20) {
            r.some_bytes(80)
        } else {
            validation_data(&mut r, &metas)
        };
        let theirs = TlvStateBorrowed::unpack(&data).and_then(|s| {
            s.get_first_bytes::<ExecuteInstruction>()
                .map(<[u8]>::to_vec)
        });
        let ours = hook::execute_entry(&data).map(<[u8]>::to_vec);
        assert_eq!(ours, theirs, "round {round}");
        if let Ok(value) = ours {
            let theirs = spl_pod::list::ListView::<ExtraAccountMeta>::unpack(&value)
                .map(|l| bytemuck::cast_slice::<ExtraAccountMeta, u8>(&l).to_vec());
            assert_eq!(
                hook::extra_account_metas(&value).map(<[u8]>::to_vec),
                theirs,
                "round {round}"
            );
        }
    }
}

/// Review L-2, on runtime-layout accounts: the resolution checks the borrow
/// state of every account it reads (the validation account, then the
/// accounts so far before each meta), so a live `RefMut` of one fails with
/// `AccountBorrowFailed`, as the SPL resolver's `try_borrow_data` does; a
/// shared `Ref` does not.
#[test]
fn hook_resolution_checks_the_borrow_state_of_account_views() {
    let program_id = Address::new_from_array([7; 32]);
    let base: Vec<HostAccount> = (1u8..=4)
        .map(|i| host(Address::new_from_array([i; 32]), TOKEN_2022_PROGRAM_ID, &[i; 8]))
        .collect();
    let mint = Address::new_from_array([2; 32]);
    let validation_key = hook::extra_account_metas_address(&mint, &program_id);
    // One extra account: a PDA of the hook seeded with the source's first
    // 8 bytes (an AccountData seed: account 0, offset 0, length 8).
    let mut meta = [0u8; 35];
    meta[0] = 1;
    meta[1..5].copy_from_slice(&[4, 0, 0, 8]);
    let mut list = 1u32.to_le_bytes().to_vec();
    list.extend_from_slice(&meta);
    let mut validation = hook::EXECUTE_DISCRIMINATOR.to_vec();
    validation.extend_from_slice(&(list.len() as u32).to_le_bytes());
    validation.extend_from_slice(&list);
    let (pda, _) = Address::find_program_address(&[&[1u8; 8]], &program_id);
    let other = Address::new_from_array([9; 32]);
    let extra_hosts = [
        host(program_id, other, &[]),
        host(validation_key, program_id, &validation),
        host(pda, other, &[]),
    ];
    let v: Vec<_> = base.iter().map(HostAccount::view).collect();
    let extra: Vec<_> = extra_hosts.iter().map(HostAccount::view).collect();
    let resolve = || {
        let mut entries: Vec<hook::Entry<noised_onchain::AccountView>> = Vec::new();
        hook::add_extra_accounts_for_execute_cpi(
            &mut entries,
            &program_id,
            &v[0],
            &v[1],
            &v[2],
            &v[3],
            5,
            &extra,
        )
        .map(|()| {
            entries
                .iter()
                .map(|e| *e.account.address())
                .collect::<Vec<_>>()
        })
    };
    assert_eq!(resolve(), Ok(vec![pda, validation_key, program_id]));

    // The validation account mutably borrowed.
    let mut writer = extra_hosts[1].view();
    let held = writer.try_borrow_mut().unwrap();
    assert_eq!(resolve(), Err(ProgramError::AccountBorrowFailed));
    drop(held);
    // The source (read for the seed) mutably borrowed.
    let mut writer = base[0].view();
    let held = writer.try_borrow_mut().unwrap();
    assert_eq!(resolve(), Err(ProgramError::AccountBorrowFailed));
    drop(held);
    // A shared borrow is fine.
    let shared = v[0].try_borrow().unwrap();
    assert_eq!(resolve(), Ok(vec![pda, validation_key, program_id]));
    drop(shared);
}

// -------------------------------------------------------------- CPIs

fn host(address: Address, owner: Address, data: &[u8]) -> HostAccount {
    HostAccount::new(address, owner, 1, data, false, true, false)
}

/// The recorded CPI is `ix`: program, accounts with their flags, data.
fn assert_cpi(cpi: &Cpi, ix: &Instruction) {
    assert_eq!(cpi.program_id, ix.program_id);
    let metas: Vec<(Address, bool, bool)> = ix
        .accounts
        .iter()
        .map(|m| (m.pubkey, m.is_signer, m.is_writable))
        .collect();
    assert_eq!(cpi.accounts, metas);
    assert_eq!(cpi.data, ix.data);
}

/// Every CPI helper makes the instruction the SPL / system instruction
/// builders (which anchor-spl and anchor-lang call) make.
#[test]
fn cpi_instructions_match_the_spl_builders() {
    let mut r = Rng(11);
    for _ in 0..200 {
        let (a, b, c, d) = (r.key(), r.key(), r.key(), r.key());
        let (amount, decimals) = (r.next(), r.byte());
        let token_program = r.pick(&[TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]);
        let tp = host(token_program, Address::default(), &[]);
        let (ha, hb, hc, hd) = (
            host(a, SYSTEM_PROGRAM_ID, &[]),
            host(b, SYSTEM_PROGRAM_ID, &[]),
            host(c, SYSTEM_PROGRAM_ID, &[]),
            host(d, SYSTEM_PROGRAM_ID, &[]),
        );
        let (va, vb, vc, vd) = (ha.view(), hb.view(), hc.view(), hd.view());
        let _ = take_cpis();

        // token: transfer_checked (an SPL Token mint: no hook), mint_to_checked,
        // burn_checked, initialize_mint2, extension initializers.
        token::transfer_checked(&tp.view(), &va, &vb, &vc, &vd, amount, decimals, &[], &[])
            .unwrap();
        token::mint_to_checked(&tp.view(), &va, &vb, &vc, amount, decimals, &[]).unwrap();
        token::burn_checked(&tp.view(), &va, &vb, &vc, amount, decimals, &[]).unwrap();
        let freeze = r.chance(50).then_some(d);
        token::initialize_mint2(&tp.view(), &va, decimals, &b, freeze.as_ref()).unwrap();
        let (x, y) = (r.chance(50).then_some(b), r.chance(50).then_some(c));
        token::initialize_mint_extension(
            &tp.view(),
            &va,
            &token::transfer_hook_initialize_data(x.as_ref(), y.as_ref()),
        )
        .unwrap();
        token::initialize_mint_extension(
            &tp.view(),
            &va,
            &token::metadata_pointer_initialize_data(x.as_ref(), y.as_ref()),
        )
        .unwrap();
        let cpis = take_cpis();
        let t22 = spl_token_2022::instruction::transfer_checked(
            &token_program,
            &a,
            &b,
            &c,
            &d,
            &[],
            amount,
            decimals,
        )
        .unwrap();
        assert_cpi(&cpis[0], &t22);
        let mint_to = spl_token_2022::instruction::mint_to_checked(
            &token_program,
            &a,
            &b,
            &c,
            &[],
            amount,
            decimals,
        )
        .unwrap();
        assert_cpi(&cpis[1], &mint_to);
        let burn = spl_token_2022::instruction::burn_checked(
            &token_program,
            &a,
            &b,
            &c,
            &[],
            amount,
            decimals,
        )
        .unwrap();
        assert_cpi(&cpis[2], &burn);
        let init = spl_token_2022::instruction::initialize_mint2(
            &token_program,
            &a,
            &b,
            freeze.as_ref(),
            decimals,
        )
        .unwrap();
        assert_cpi(&cpis[3], &init);
        // Extension instructions exist for Token-2022 only.
        let hook_init =
            transfer_hook::instruction::initialize(&TOKEN_2022_PROGRAM_ID, &a, x, y).unwrap();
        assert_eq!(cpis[4].data, hook_init.data);
        let pointer_init =
            metadata_pointer::instruction::initialize(&TOKEN_2022_PROGRAM_ID, &a, x, y).unwrap();
        assert_eq!(cpis[5].data, pointer_init.data);
        assert_eq!(cpis[5].accounts, vec![(a, false, true)]);

        // ATA create / create_idempotent: the instruction names the derived
        // address.
        let ata = token::associated_token_address(&b, &c, &token_program);
        assert_eq!(
            ata,
            anchor_spl::associated_token::get_associated_token_address_with_program_id(
                &b,
                &c,
                &token_program
            )
        );
        let sys = host(SYSTEM_PROGRAM_ID, Address::default(), &[]);
        for idempotent in [false, true] {
            token::create_associated_token_account(
                idempotent,
                &va,
                &ata,
                &vd,
                &vb,
                &vc,
                &sys.view(),
                &tp.view(),
            )
            .unwrap();
            let ix = if idempotent {
                ata_interface::instruction::create_associated_token_account_idempotent(
                    &a,
                    &b,
                    &c,
                    &token_program,
                )
            } else {
                ata_interface::instruction::create_associated_token_account(
                    &a,
                    &b,
                    &c,
                    &token_program,
                )
            };
            assert_cpi(&take_cpis()[0], &ix);
        }

        // memo
        let memo_bytes = r.some_bytes(40);
        let memo_program = host(MEMO_PROGRAM_ID, Address::default(), &[]);
        token::memo(&memo_program.view(), &memo_bytes).unwrap();
        let cpi = &take_cpis()[0];
        assert_eq!(
            (cpi.program_id, &cpi.accounts, &cpi.data),
            (MEMO_PROGRAM_ID, &vec![], &memo_bytes)
        );

        // system: create_account, transfer, allocate, assign.
        let (lamports, space) = (r.next(), r.below(10_240));
        cpi::create_account(&va, &vb, lamports, space, &c, &[]).unwrap();
        cpi::transfer(&va, &vb, lamports, &[]).unwrap();
        cpi::allocate(&va, space, &[]).unwrap();
        cpi::assign(&va, &c, &[]).unwrap();
        let cpis = take_cpis();
        assert_cpi(
            &cpis[0],
            &system_instruction::create_account(&a, &b, lamports, space, &c),
        );
        assert_cpi(&cpis[1], &system_instruction::transfer(&a, &b, lamports));
        assert_cpi(&cpis[2], &system_instruction::allocate(&a, space));
        assert_cpi(&cpis[3], &system_instruction::assign(&a, &c));
    }
}

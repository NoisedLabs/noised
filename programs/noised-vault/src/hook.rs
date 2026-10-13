//! The transfer-hook accounts of a `transfer_checked` CPI, resolved the way
//! the Anchor build did with spl-transfer-hook-interface 2.1.0
//! (`onchain::add_extra_accounts_for_execute_cpi`) and
//! spl-tlv-account-resolution 0.11.1 (`ExtraAccountMetaList::
//! add_to_cpi_instruction`, `ExtraAccountMeta::resolve`), with the same
//! accounts, flags, order and errors. Written over [`HookAccount`] so the
//! host tests can run it against the SPL crates.

use alloc::vec::Vec;

use pinocchio::error::ProgramError;

use crate::Pubkey;

/// `sha256("spl-transfer-hook-interface:execute")[..8]`.
pub const EXECUTE_DISCRIMINATOR: [u8; 8] = [105, 37, 101, 197, 75, 251, 102, 26];
/// Seed of the validation (extra account metas) PDA of a mint.
pub const EXTRA_ACCOUNT_METAS_SEED: &[u8] = b"extra-account-metas";

/// `TransferHookError::IncorrectAccount`.
pub const HOOK_INCORRECT_ACCOUNT: u32 = 2_110_272_652;
/// `AccountResolutionError` numbers.
pub const RESOLUTION_INCORRECT_ACCOUNT: u32 = 2_724_315_840;
pub const RESOLUTION_INVALID_BYTES_FOR_SEED: u32 = 2_724_315_849;
pub const RESOLUTION_INSTRUCTION_DATA_TOO_SMALL: u32 = 2_724_315_851;
pub const RESOLUTION_ACCOUNT_NOT_FOUND: u32 = 2_724_315_852;
pub const RESOLUTION_ACCOUNT_DATA_TOO_SMALL: u32 = 2_724_315_855;
/// `TlvError::TypeNotFound`.
pub const TLV_TYPE_NOT_FOUND: u32 = 1_202_666_432;
/// `PodSliceError::BufferTooSmall`.
pub const POD_BUFFER_TOO_SMALL: u32 = 1;

/// Size of one `ExtraAccountMeta`: discriminator, 32-byte address config,
/// `is_signer`, `is_writable`.
pub const EXTRA_ACCOUNT_META_LEN: usize = 35;

/// An account the resolution can see: its address and its data.
pub trait HookAccount {
    fn key(&self) -> &Pubkey;
    /// The account's data (Anchor's `try_borrow_data`; no account is
    /// mutably borrowed while the vault resolves hook accounts).
    fn data(&self) -> &[u8];
}

/// An instruction account: address, signer, writable.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Meta {
    pub pubkey: Pubkey,
    pub is_signer: bool,
    pub is_writable: bool,
}

/// An account of the CPI being built, with its signer and writable flags
/// (its address is the account's: every account is looked up by address).
pub struct Entry<'a, A> {
    pub account: &'a A,
    pub is_signer: bool,
    pub is_writable: bool,
}

impl<'a, A> Entry<'a, A> {
    pub fn new(account: &'a A, is_signer: bool, is_writable: bool) -> Self {
        Self {
            account,
            is_signer,
            is_writable,
        }
    }
}

/// The account of `accounts` at `key`, if any (the first one).
#[inline(never)]
fn find<'a, A: HookAccount>(accounts: &'a [A], key: &Pubkey) -> Option<&'a A> {
    accounts.iter().find(|a| crate::same(a.key(), key))
}

fn custom(code: u32) -> ProgramError {
    ProgramError::Custom(code)
}

fn invalid() -> ProgramError {
    ProgramError::InvalidAccountData
}

/// PDA derivation, `Pubkey::find_program_address` (a syscall on-chain;
/// panics, as the Anchor build's did, when no bump works or the seeds are
/// invalid).
pub fn find_program_address(seeds: &[&[u8]], program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(seeds, program_id)
}

/// The validation account of `mint` for the hook `program_id`.
pub fn extra_account_metas_address(mint: &Pubkey, program_id: &Pubkey) -> Pubkey {
    find_program_address(&[EXTRA_ACCOUNT_METAS_SEED, mint.as_ref()], program_id).0
}

/// The little-endian `u32` at `at`, if there.
fn u32_at(data: &[u8], at: usize) -> Option<u32> {
    let bytes = data.get(at..)?.first_chunk::<4>()?;
    Some(u32::from_le_bytes(*bytes))
}

/// spl-type-length-value 0.9 `TlvStateBorrowed::unpack` (every entry must
/// parse) and `get_first_bytes::<ExecuteInstruction>()`: the value of the
/// first `Execute` entry. Entries: 8-byte discriminator, `u32` length, value.
pub fn execute_entry(data: &[u8]) -> Result<&[u8], ProgramError> {
    // check_data (get_discriminators_and_end_index)
    let mut start = 0usize;
    while let Some(rest) = data.get(start..).filter(|rest| !rest.is_empty()) {
        let Some(discriminator) = rest.first_chunk::<8>() else {
            // Fewer than 8 bytes left: zero padding only.
            if rest.iter().all(|b| *b == 0) {
                break;
            }
            return Err(invalid());
        };
        if discriminator.iter().all(|b| *b == 0) {
            break;
        }
        let length = u32_at(rest, 8).ok_or_else(invalid)?;
        let end = start.saturating_add(12).saturating_add(length as usize);
        if end > data.len() {
            return Err(invalid());
        }
        start = end;
    }
    // get_indices(EXECUTE, repetition 0) and get_bytes
    let mut start = 0usize;
    while let Some(rest) = data.get(start..).filter(|rest| !rest.is_empty()) {
        let (Some(discriminator), Some(length)) = (rest.first_chunk::<8>(), u32_at(rest, 8)) else {
            return Err(invalid());
        };
        let value_start = start.saturating_add(12);
        let value_end = value_start.saturating_add(length as usize);
        if *discriminator == EXECUTE_DISCRIMINATOR {
            return data.get(value_start..value_end).ok_or_else(invalid);
        }
        if discriminator.iter().all(|b| *b == 0) {
            return Err(custom(TLV_TYPE_NOT_FOUND));
        }
        start = value_end;
    }
    Err(invalid())
}

/// spl-pod 0.7 `ListView::<ExtraAccountMeta, PodU32>::unpack`: a `u32`
/// count, then the metas. Returns the metas in use.
pub fn extra_account_metas(value: &[u8]) -> Result<&[u8], ProgramError> {
    let Some((count, metas)) = value.split_first_chunk::<4>() else {
        return Err(custom(POD_BUFFER_TOO_SMALL));
    };
    if metas.len() % EXTRA_ACCOUNT_META_LEN != 0 {
        return Err(ProgramError::InvalidArgument);
    }
    let used = (u32::from_le_bytes(*count) as usize).saturating_mul(EXTRA_ACCOUNT_META_LEN);
    metas
        .get(..used)
        .ok_or_else(|| custom(POD_BUFFER_TOO_SMALL))
}

/// The address of the account at `index` of the CPI being built
/// (`AccountNotFound`).
fn key_at<'a, A: HookAccount>(accounts: &[&'a A], index: u8) -> Result<&'a Pubkey, ProgramError> {
    accounts
        .get(index as usize)
        .map(|a| a.key())
        .ok_or_else(|| custom(RESOLUTION_ACCOUNT_NOT_FOUND))
}

/// `length` bytes at `data_index` of the data of the account at
/// `account_index` (`AccountNotFound`, `AccountDataTooSmall`).
fn data_at<'a, A: HookAccount>(
    accounts: &[&'a A],
    account_index: u8,
    data_index: u8,
    length: usize,
) -> Result<&'a [u8], ProgramError> {
    let account = accounts
        .get(account_index as usize)
        .ok_or_else(|| custom(RESOLUTION_ACCOUNT_NOT_FOUND))?;
    let start = data_index as usize;
    account
        .data()
        .get(start..start + length)
        .ok_or_else(|| custom(RESOLUTION_ACCOUNT_DATA_TOO_SMALL))
}

/// One seed of an address config, unpacked (`Seed::unpack`).
#[derive(Clone, Copy)]
enum Seed {
    /// `Literal`: the bytes at `start..start + len` of the config.
    Literal {
        start: u8,
        len: u8,
    },
    InstructionData {
        index: u8,
        length: u8,
    },
    AccountKey {
        index: u8,
    },
    AccountData {
        account_index: u8,
        data_index: u8,
        length: u8,
    },
}

/// `Seed::unpack_address_config`: the seeds packed into an address config,
/// up to the first `Uninitialized` one. At most 16 fit (2 bytes each at
/// least).
fn unpack_seeds(config: &[u8; 32]) -> Result<([Option<Seed>; 16], usize), ProgramError> {
    let mut seeds = [None; 16];
    let mut count = 0usize;
    let mut i = 0usize;
    while let Some((&kind, args)) = config.get(i..).and_then(|rest| rest.split_first()) {
        let bad = || custom(RESOLUTION_INVALID_BYTES_FOR_SEED);
        let (seed, size) = match kind {
            0 => break,
            1 => {
                let (&len, bytes) = args.split_first().ok_or_else(bad)?;
                if bytes.len() < len as usize {
                    return Err(bad());
                }
                let start = i as u8 + 2;
                (Seed::Literal { start, len }, 2 + len as usize)
            }
            2 => match args {
                [index, length, ..] => (
                    Seed::InstructionData {
                        index: *index,
                        length: *length,
                    },
                    3,
                ),
                _ => return Err(bad()),
            },
            3 => match args {
                [index, ..] => (Seed::AccountKey { index: *index }, 2),
                _ => return Err(bad()),
            },
            4 => match args {
                [account_index, data_index, length, ..] => (
                    Seed::AccountData {
                        account_index: *account_index,
                        data_index: *data_index,
                        length: *length,
                    },
                    4,
                ),
                _ => return Err(bad()),
            },
            _ => return Err(invalid()),
        };
        if let Some(slot) = seeds.get_mut(count) {
            *slot = Some(seed);
            count += 1;
        }
        i += size;
    }
    Ok((seeds, count))
}

/// `resolve_pda`: the seeds of an address config, resolved in order, hashed
/// into a PDA of `program_id`.
fn resolve_pda<A: HookAccount>(
    config: &[u8; 32],
    instruction_data: &[u8],
    program_id: &Pubkey,
    accounts: &[&A],
) -> Result<Pubkey, ProgramError> {
    let (parsed, count) = unpack_seeds(config)?;
    let mut seeds: [&[u8]; 16] = [&[]; 16];
    for (slot, seed) in seeds.iter_mut().zip(parsed.iter().flatten()) {
        *slot = match *seed {
            Seed::Literal { start, len } => {
                let start = start as usize;
                config.get(start..start + len as usize).unwrap_or(&[])
            }
            Seed::InstructionData { index, length } => {
                let start = index as usize;
                instruction_data
                    .get(start..start + length as usize)
                    .ok_or_else(|| custom(RESOLUTION_INSTRUCTION_DATA_TOO_SMALL))?
            }
            Seed::AccountKey { index } => key_at(accounts, index)?.as_ref(),
            Seed::AccountData {
                account_index,
                data_index,
                length,
            } => data_at(accounts, account_index, data_index, length as usize)?,
        };
    }
    Ok(find_program_address(seeds.get(..count).unwrap_or(&[]), program_id).0)
}

/// `ExtraAccountMeta::resolve`.
pub fn resolve<A: HookAccount>(
    meta: &[u8; EXTRA_ACCOUNT_META_LEN],
    instruction_data: &[u8],
    program_id: &Pubkey,
    accounts: &[&A],
) -> Result<Meta, ProgramError> {
    let (&discriminator, rest) = meta.split_first().ok_or_else(invalid)?;
    let (config, flags) = rest.split_first_chunk::<32>().ok_or_else(invalid)?;
    let is_signer = flags.first().is_some_and(|b| *b != 0);
    let is_writable = flags.get(1).is_some_and(|b| *b != 0);
    let pubkey = match discriminator {
        0 => Pubkey::new_from_array(*config),
        1 => resolve_pda(config, instruction_data, program_id, accounts)?,
        x if x >= 128 => {
            let program = *key_at(accounts, x - 128)?;
            resolve_pda(config, instruction_data, &program, accounts)?
        }
        2 => {
            // PubkeyData: Uninitialized (0), InstructionData { index } (1),
            // AccountData { account_index, data_index } (2).
            let key = match config {
                [1, index, ..] => {
                    let start = *index as usize;
                    instruction_data
                        .get(start..start + 32)
                        .ok_or_else(|| custom(RESOLUTION_INSTRUCTION_DATA_TOO_SMALL))?
                }
                [2, account_index, data_index, ..] => {
                    data_at(accounts, *account_index, *data_index, 32)?
                }
                _ => return Err(invalid()),
            };
            Pubkey::new_from_array(*key.first_chunk::<32>().ok_or_else(invalid)?)
        }
        _ => return Err(invalid()),
    };
    Ok(Meta {
        pubkey,
        is_signer,
        is_writable,
    })
}

/// `de_escalate_account_meta`: never a signer, and read-only if the
/// instruction already has the account, read-only only.
fn de_escalate<A: HookAccount>(meta: &mut Meta, entries: &[Entry<A>]) {
    let mut seen = false;
    let mut any_writable = false;
    for entry in entries
        .iter()
        .filter(|e| crate::same(e.account.key(), &meta.pubkey))
    {
        seen = true;
        any_writable |= entry.is_writable;
    }
    if seen && !any_writable {
        meta.is_writable = false;
    }
    meta.is_signer = false;
}

/// `add_extra_accounts_for_execute_cpi`: appends to the `transfer_checked`
/// accounts (`entries`) the hook's extra accounts resolved from the mint's
/// validation account (when `extra` holds it), the validation account, and
/// the hook program, which `extra` must hold.
#[allow(clippy::too_many_arguments)]
pub fn add_extra_accounts_for_execute_cpi<'a, A: HookAccount>(
    entries: &mut Vec<Entry<'a, A>>,
    program_id: &Pubkey,
    source: &'a A,
    mint: &'a A,
    destination: &'a A,
    authority: &'a A,
    amount: u64,
    extra: &'a [A],
) -> Result<(), ProgramError> {
    let validate_state = extra_account_metas_address(mint.key(), program_id);
    let program_info = find(extra, program_id).ok_or_else(|| custom(HOOK_INCORRECT_ACCOUNT))?;

    if let Some(validate_info) = find(extra, &validate_state) {
        // spl_transfer_hook_interface::instruction::execute: the Execute
        // discriminator and the amount; source, mint, destination and
        // authority read-only, then the validation account.
        let mut data = [0u8; 16];
        data[..8].copy_from_slice(&EXECUTE_DISCRIMINATOR);
        data[8..].copy_from_slice(&amount.to_le_bytes());
        let base = [source, mint, destination, authority, validate_info];
        let mut execute: Vec<Entry<'a, A>> = Vec::with_capacity(16);
        execute.extend(base.iter().map(|a| Entry::new(*a, false, false)));
        let mut accounts: Vec<&'a A> = base.to_vec();

        let list = extra_account_metas(execute_entry(validate_info.data())?)?;
        for meta in list.as_chunks::<EXTRA_ACCOUNT_META_LEN>().0 {
            let mut resolved = resolve(meta, &data, program_id, &accounts)?;
            de_escalate(&mut resolved, &execute);
            let info = find(extra, &resolved.pubkey)
                .ok_or_else(|| custom(RESOLUTION_INCORRECT_ACCOUNT))?;
            execute.push(Entry::new(info, resolved.is_signer, resolved.is_writable));
            accounts.push(info);
        }

        // Only the resolved accounts, then the validation account.
        entries.extend(execute.into_iter().skip(base.len()));
        entries.push(Entry::new(validate_info, false, false));
    }

    entries.push(Entry::new(program_info, false, false));
    Ok(())
}

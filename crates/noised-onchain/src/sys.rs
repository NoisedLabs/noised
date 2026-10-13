//! Every `unsafe` block of the crate, each with its safety argument: the
//! syscalls (logs, sysvars), the cross-program invocation, the entrypoint's
//! account list and the unchecked data borrow of the transfer-hook
//! resolution (whose callers, in `token::hook`, are the crate's only other
//! `unsafe` code: they call it after a borrow check).
//!
//! Off-chain (host builds) the syscalls do nothing: programs only run
//! on-chain. Host builds record the log lines and the invocations instead
//! ([`take_logs`], [`take_cpis`]) so tests can check them.
#![allow(unsafe_code)]

use alloc::vec::Vec;
use core::mem::MaybeUninit;

use pinocchio::{
    cpi::{invoke_signed_unchecked, CpiAccount, Signer},
    entrypoint::{InstructionContext, MaybeAccount},
    error::ProgramError,
    instruction::{InstructionAccount, InstructionView},
    AccountView, Address, ProgramResult, MAX_TX_ACCOUNTS,
};

/// `sol_log_` of a static or assembled line (`msg!`).
#[inline]
pub fn log_bytes(message: &[u8]) {
    // SAFETY: the pointer and length describe `message`, which outlives the
    // call; the runtime only reads it.
    #[cfg(target_os = "solana")]
    unsafe {
        pinocchio::syscalls::sol_log_(message.as_ptr(), message.len() as u64)
    };
    #[cfg(not(target_os = "solana"))]
    host::record(host::Log::Message(
        alloc::string::String::from_utf8_lossy(message).into_owned(),
    ));
}

/// `sol_log_` of a string.
#[inline]
pub fn log(message: &str) {
    log_bytes(message.as_bytes())
}

/// `sol_log_pubkey`: the runtime prints the key in base58.
#[inline]
pub fn log_pubkey(key: &Address) {
    // SAFETY: `key` points at 32 readable bytes for the duration of the call.
    #[cfg(target_os = "solana")]
    unsafe {
        pinocchio::syscalls::sol_log_pubkey(key.as_ref().as_ptr())
    };
    #[cfg(not(target_os = "solana"))]
    host::record(host::Log::Pubkey(*key));
}

/// `sol_log_data` of `slices` (`Program data: <base64> <base64> ...`).
#[inline]
pub fn log_data_slices(slices: &[&[u8]]) {
    // SAFETY: `&[u8]` has the (pointer, length) layout of the runtime's
    // `SolBytes`, so `slices` is an array of `slices.len()` such pairs, all
    // alive and only read during the call.
    #[cfg(target_os = "solana")]
    unsafe {
        pinocchio::syscalls::sol_log_data(slices.as_ptr() as *const u8, slices.len() as u64)
    };
    #[cfg(not(target_os = "solana"))]
    host::record(host::Log::Data(slices.iter().map(|s| s.to_vec()).collect()));
}

/// `sol_log_data` of one slice: Anchor's `emit!` (`Program data: <base64>`).
#[inline]
pub fn log_data(data: &[u8]) {
    log_data_slices(&[data])
}

/// `sol_get_sysvar`: `buffer.len()` bytes of sysvar `id` from `offset`.
/// Any failure is `UnsupportedSysvar`, as solana-sysvar 3.1's `get()`
/// reports it.
#[inline]
pub fn get_sysvar(id: &Address, offset: u64, buffer: &mut [u8]) -> Result<(), ProgramError> {
    // SAFETY: `id` points at 32 readable bytes and `buffer` at
    // `buffer.len()` writable ones, both alive during the call.
    #[cfg(target_os = "solana")]
    let result = unsafe {
        pinocchio::syscalls::sol_get_sysvar(
            id.as_ref().as_ptr(),
            buffer.as_mut_ptr(),
            offset,
            buffer.len() as u64,
        )
    };
    #[cfg(not(target_os = "solana"))]
    let result = host::sysvar(id, offset, buffer);
    if result != 0 {
        return Err(ProgramError::UnsupportedSysvar);
    }
    Ok(())
}

/// A cross-program invocation the way `solana_program::program::invoke_signed`
/// (solana-cpi 3.1) makes it: `metas` are the instruction's accounts, `infos`
/// any accounts the caller holds; the runtime finds each instruction account
/// among `infos` by address (and fails with `MissingAccount` if one is not
/// there). A failing callee aborts the whole transaction.
///
/// Before invoking, the borrow state of every instruction account is
/// checked as solana-cpi checks it: the first account of `infos` at a
/// writable meta's address must not be borrowed at all, one at a read-only
/// meta's address not mutably (`AccountBorrowFailed` otherwise, and no
/// CPI). So a `Ref` / `RefMut` of an account's data that is still alive
/// fails the call instead of letting the callee write data the caller is
/// reading. (A plain slice taken from a dropped `Ref` is not tracked:
/// read what you need into locals before invoking.)
#[inline(always)]
pub fn invoke(
    program_id: &Address,
    metas: &[InstructionAccount],
    data: &[u8],
    infos: &[&AccountView],
    signers: &[Signer],
) -> ProgramResult {
    invoke_signed(program_id, metas, data, infos, signers)
}

/// [`invoke`], out of line: one copy of the borrow checks and of the CPI
/// for every call site.
#[inline(never)]
fn invoke_signed(
    program_id: &Address,
    metas: &[InstructionAccount],
    data: &[u8],
    infos: &[&AccountView],
    signers: &[Signer],
) -> ProgramResult {
    check_borrows(metas, infos)?;
    let accounts: Vec<CpiAccount> = infos.iter().map(|info| CpiAccount::from(*info)).collect();
    let instruction = InstructionView {
        program_id,
        data,
        accounts: metas,
    };
    #[cfg(not(target_os = "solana"))]
    host::record_cpi(program_id, metas, data, signers.len());
    // SAFETY: every `CpiAccount` points at a runtime account of this
    // instruction. No `Ref` or `RefMut` of the data of an instruction
    // account the callee may write (a writable meta) is alive, and no
    // `RefMut` of any other one (`check_borrows`, just above); every helper
    // of this crate drops its borrows before invoking.
    unsafe { invoke_signed_unchecked(&instruction, &accounts, signers) };
    Ok(())
}

/// solana-cpi 3.1 `invoke_signed`'s check (pinocchio's checked `invoke`
/// does the writable half): for each instruction account, the first
/// account of `infos` at its address (none: the runtime reports it) can be
/// borrowed mutably if the meta is writable (`check_borrow_mut`), shared
/// otherwise (`check_borrow`); `AccountBorrowFailed` if not. Duplicate
/// views of an account share its borrow state, so the first one is enough.
#[inline]
fn check_borrows(metas: &[InstructionAccount], infos: &[&AccountView]) -> ProgramResult {
    for meta in metas {
        if let Some(info) = infos
            .iter()
            .find(|info| crate::same(info.address(), meta.address))
        {
            if meta.is_writable {
                info.check_borrow_mut()?;
            } else {
                info.check_borrow()?;
            }
        }
    }
    Ok(())
}

/// The data of `account`, without taking a borrow (the transfer-hook
/// resolution's `HookAccount::data`, which checks the borrow state first as
/// spl-tlv-account-resolution's `try_borrow_data` does).
///
/// # Safety
///
/// The data must not be mutably borrowed (`check_borrow` passed), and no
/// `RefMut` of it may be taken, nor a CPI made, while the returned slice is
/// alive.
#[inline]
pub(crate) unsafe fn data_unchecked(account: &AccountView) -> &[u8] {
    // SAFETY: the caller's contract: nothing writes the data while the
    // returned slice lives.
    unsafe { account.borrow_unchecked() }
}

/// The program entrypoint (pinocchio's `lazy_program_entrypoint`): every
/// account of the instruction in order, as pinocchio's `program_entrypoint!`
/// presents them (a duplicate is a copy of the view of its first
/// occurrence; accounts past the 255th are skipped), then `process` with the
/// program id and the instruction data. See [`crate::entrypoint!`].
#[inline(always)]
pub fn run(
    mut context: InstructionContext,
    process: impl FnOnce(&Address, &mut [AccountView], &[u8]) -> ProgramResult,
) -> ProgramResult {
    const UNINIT: MaybeUninit<AccountView> = MaybeUninit::uninit();
    let mut accounts = [UNINIT; MAX_TX_ACCOUNTS];
    let mut count = 0usize;
    while context.remaining() > 0 {
        let view = match context.next_account()? {
            MaybeAccount::Account(view) => view,
            MaybeAccount::Duplicated(index) => {
                let index = usize::from(index);
                if index >= count {
                    return Err(ProgramError::InvalidArgument);
                }
                // SAFETY: the first `count` slots are initialized and
                // `index < count`.
                unsafe { accounts.get_unchecked(index).assume_init_read() }
            }
        };
        if let Some(slot) = accounts.get_mut(count) {
            slot.write(view);
            count += 1;
        }
    }
    // SAFETY: every account was read, so the instruction data and the
    // program id follow in the input.
    let (data, program_id) = unsafe {
        (
            context.instruction_data_unchecked(),
            context.program_id_unchecked(),
        )
    };
    // SAFETY: the first `count` slots are initialized (`count` never
    // exceeds `MAX_TX_ACCOUNTS`) and `AccountView` has no drop glue.
    let accounts = unsafe {
        core::slice::from_raw_parts_mut(accounts.as_mut_ptr() as *mut AccountView, count)
    };
    process(program_id, accounts, data)
}

/// Declares the program entrypoint (pinocchio's lazy entrypoint, bump
/// allocator and panic handler) calling `process(program_id, accounts,
/// data)`. Put it behind the program's `no-entrypoint` feature:
///
/// ```ignore
/// #[cfg(not(feature = "no-entrypoint"))]
/// noised_onchain::entrypoint!(crate::processor::process_instruction);
/// ```
///
/// The program crate links Solana's `std` (it is not `no_std`): with
/// platform-tools v1.57 a `no_std` program that uses `alloc` fails to link.
#[macro_export]
macro_rules! entrypoint {
    ($process:path) => {
        $crate::pinocchio::lazy_program_entrypoint!(__noised_onchain_entry);
        $crate::pinocchio::default_allocator!();
        $crate::pinocchio::default_panic_handler!();

        #[inline]
        fn __noised_onchain_entry(
            context: $crate::pinocchio::entrypoint::InstructionContext,
        ) -> $crate::pinocchio::ProgramResult {
            $crate::sys::run(context, $process)
        }
    };
}

#[cfg(not(target_os = "solana"))]
pub use host::{set_sysvar, take_cpis, take_logs, Cpi, HostAccount, Log};

/// Host builds: what the syscalls would have done, recorded per thread,
/// and accounts laid out as the runtime lays them out.
#[cfg(not(target_os = "solana"))]
mod host {
    use alloc::{boxed::Box, string::String, vec::Vec};
    use core::{cell::RefCell, mem::size_of, ptr::NonNull};

    use pinocchio::{
        account::RuntimeAccount, instruction::InstructionAccount, AccountView, Address,
    };

    /// Room after an account's data (the runtime's
    /// `MAX_PERMITTED_DATA_INCREASE`), so the layout matches the input's.
    const DATA_ROOM: usize = 10 * 1024;

    /// An account laid out as in a program's input (a `RuntimeAccount`
    /// header, then the data and room to grow), for host tests of code that
    /// takes `AccountView`s. The views it hands out stay valid while it
    /// lives; like the runtime's, several views of one account share it.
    pub struct HostAccount {
        words: NonNull<[u64]>,
    }

    impl HostAccount {
        /// An account at `address` owned by `owner`.
        pub fn new(
            address: Address,
            owner: Address,
            lamports: u64,
            data: &[u8],
            is_signer: bool,
            is_writable: bool,
            executable: bool,
        ) -> Self {
            let header = size_of::<RuntimeAccount>();
            let words = (header + data.len() + DATA_ROOM).div_ceil(8);
            let buffer: Box<[u64]> = alloc::vec![0u64; words].into_boxed_slice();
            let words = NonNull::from(Box::leak(buffer));
            let raw = words.as_ptr() as *mut u8;
            let account = RuntimeAccount {
                borrow_state: pinocchio::account::NOT_BORROWED,
                is_signer: u8::from(is_signer),
                is_writable: u8::from(is_writable),
                executable: u8::from(executable),
                padding: (data.len() as u32).to_le_bytes(),
                address,
                owner,
                lamports,
                data_len: data.len() as u64,
            };
            // SAFETY: the buffer holds `header + data.len()` bytes or more,
            // is 8-byte aligned (`u64` words, as `RuntimeAccount` needs) and
            // is owned by `self` alone; the header and the data do not
            // overlap.
            unsafe {
                (raw as *mut RuntimeAccount).write(account);
                core::ptr::copy_nonoverlapping(data.as_ptr(), raw.add(header), data.len());
            }
            Self { words }
        }

        /// A view of the account.
        pub fn view(&self) -> AccountView {
            // SAFETY: the buffer starts with a `RuntimeAccount` followed by
            // `data_len` bytes of data (and room to grow), and lives as long
            // as `self`; the pointer was not derived from a shared reference,
            // so writes through views are allowed.
            unsafe { AccountView::new_unchecked(self.words.as_ptr() as *mut RuntimeAccount) }
        }

        /// The account's data, as views left it.
        pub fn data(&self) -> Vec<u8> {
            let view = self.view();
            let data = view.try_borrow().expect("not mutably borrowed");
            data.to_vec()
        }
    }

    impl Drop for HostAccount {
        fn drop(&mut self) {
            // SAFETY: `words` came from `Box::leak` in `new` and is freed
            // once, here.
            drop(unsafe { Box::from_raw(self.words.as_ptr()) });
        }
    }

    /// A log line of the program.
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub enum Log {
        /// `sol_log_` (`Program log: <message>`).
        Message(String),
        /// `sol_log_pubkey` (`Program log: <base58>`).
        Pubkey(Address),
        /// `sol_log_data` (`Program data: <base64> ...`).
        Data(Vec<Vec<u8>>),
    }

    /// A cross-program invocation of the program.
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct Cpi {
        pub program_id: Address,
        /// `(address, is_signer, is_writable)` of each instruction account.
        pub accounts: Vec<(Address, bool, bool)>,
        pub data: Vec<u8>,
        /// How many PDA signers the call carried.
        pub signers: usize,
    }

    std::thread_local! {
        static LOGS: RefCell<Vec<Log>> = const { RefCell::new(Vec::new()) };
        static CPIS: RefCell<Vec<Cpi>> = const { RefCell::new(Vec::new()) };
        static SYSVARS: RefCell<Vec<(Address, Vec<u8>)>> = const { RefCell::new(Vec::new()) };
    }

    pub(super) fn record(log: Log) {
        LOGS.with(|logs| logs.borrow_mut().push(log));
    }

    pub(super) fn record_cpi(
        program_id: &Address,
        metas: &[InstructionAccount],
        data: &[u8],
        signers: usize,
    ) {
        let cpi = Cpi {
            program_id: *program_id,
            accounts: metas
                .iter()
                .map(|m| (*m.address, m.is_signer, m.is_writable))
                .collect(),
            data: data.to_vec(),
            signers,
        };
        CPIS.with(|cpis| cpis.borrow_mut().push(cpi));
    }

    pub(super) fn sysvar(id: &Address, offset: u64, buffer: &mut [u8]) -> u64 {
        SYSVARS.with(|sysvars| {
            let sysvars = sysvars.borrow();
            let Some((_, data)) = sysvars.iter().find(|(key, _)| key == id) else {
                return 2;
            };
            let start = offset as usize;
            match data.get(start..start + buffer.len()) {
                Some(bytes) => {
                    buffer.copy_from_slice(bytes);
                    0
                }
                None => 1,
            }
        })
    }

    /// The log lines recorded on this thread since the last call.
    pub fn take_logs() -> Vec<Log> {
        LOGS.with(|logs| core::mem::take(&mut *logs.borrow_mut()))
    }

    /// The invocations recorded on this thread since the last call.
    pub fn take_cpis() -> Vec<Cpi> {
        CPIS.with(|cpis| core::mem::take(&mut *cpis.borrow_mut()))
    }

    /// Sets the bytes `sol_get_sysvar` reads for sysvar `id` on this thread.
    pub fn set_sysvar(id: &Address, data: &[u8]) {
        SYSVARS.with(|sysvars| {
            let mut sysvars = sysvars.borrow_mut();
            sysvars.retain(|(key, _)| key != id);
            sysvars.push((*id, data.to_vec()));
        });
    }
}

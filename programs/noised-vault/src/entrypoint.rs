//! The program entrypoint (pinocchio): the runtime's input is read in place
//! (`lazy_program_entrypoint`), a bump allocator serves the heap (the
//! LM-OTS verifier and the CPI account lists allocate), and a panic reports
//! its location to the runtime and aborts.
//!
//! The crate links Solana's `std` rather than being `no_std`: with
//! platform-tools v1.57, a `no_std` program that uses `alloc` fails to link
//! (its sysroot `liballoc` lacks the default allocation-error handler the
//! compiler references). `std` adds a few hundred bytes (panic and
//! out-of-memory paths) and no formatting code.

use core::mem::MaybeUninit;

use pinocchio::{
    entrypoint::{InstructionContext, MaybeAccount},
    error::ProgramError,
    AccountView, ProgramResult, MAX_TX_ACCOUNTS,
};

use crate::processor::process_instruction;

pinocchio::lazy_program_entrypoint!(entry);
pinocchio::default_allocator!();
pinocchio::default_panic_handler!();

/// Every account of the instruction in order, as pinocchio's
/// `program_entrypoint!` presents them (a duplicate is a copy of the view of
/// its first occurrence; accounts past the 255th are skipped), then the
/// processor with the program id and the instruction data.
fn entry(mut context: InstructionContext) -> ProgramResult {
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
                // SAFETY: the first `count` slots are initialized.
                unsafe { accounts.get_unchecked(index).assume_init_read() }
            }
        };
        if let Some(slot) = accounts.get_mut(count) {
            slot.write(view);
            count += 1;
        }
    }
    // SAFETY: every account was read, so the instruction data and the
    // program id follow; the first `count` slots are initialized.
    let (data, program_id) = unsafe {
        (
            context.instruction_data_unchecked(),
            context.program_id_unchecked(),
        )
    };
    let accounts = unsafe {
        core::slice::from_raw_parts_mut(accounts.as_mut_ptr() as *mut AccountView, count)
    };
    process_instruction(program_id, accounts, data)
}

//! `Relay`: a native stand-in for a top-level program that makes one CPI,
//! optionally signed for that program's PDAs.
//!
//! The Launch Guard accepts a buy during the snipe shield only inside the
//! launchpad's `execute_batch`. It reads that from the instructions sysvar:
//! the *top-level* instruction being executed must have the launchpad's
//! program id and data starting with `execute_batch`'s discriminator. The
//! real `execute_batch` needs a whole launch (DBC pool, commits; the
//! launchpad suite runs it end to end). To test the hook's decision on its
//! own, `Relay` is registered as a LiteSVM builtin at any program id, the
//! launchpad's or an impostor's, and moves tokens from inside that
//! top-level instruction.
//!
//! The hook's `create_policy` and `end_snipe_shield` take only the
//! launchpad's `["hook-authority"]` PDA as signer, and only the launchpad
//! program can produce that signature (`invoke_signed`). A relay registered
//! at the launchpad's program id produces it the same way: it hands the
//! PDA's seeds to the runtime (`native_invoke_signed`), which derives the
//! address from them and from the relay's own program id, as it does for an
//! SBF program's `invoke_signed`. So a relay signs only for PDAs of the
//! program id it is registered at, and every signature the transaction
//! carries is still verified.
//!
//! Instruction: accounts `[inner program, inner accounts..]`, data
//! `tag (8 bytes) || n (1) || n × signer || inner data`, where a signer is
//! `account (1, index into the inner accounts) || m (1) || m × (len (1) ||
//! seed)`. The relay CPIs `inner program` with `inner data` and the inner
//! accounts, with the signer and writable flags they have in the relay
//! instruction plus the signer flag on each signer account, and passes each
//! signer's seeds (bump included) to the runtime. A signer flag that the
//! transaction did not sign and the seeds do not derive fails
//! `PrivilegeEscalation`. With no accounts the relay makes no CPI and reads
//! nothing past the tag. Like every builtin it charges compute units (150,
//! the system program's cost), which the runtime requires of builtins.

use solana_instruction::error::InstructionError;
use solana_program_runtime::{
    declare_process_instruction, solana_sbpf::program::BuiltinFunctionDefinition,
};

use super::{AccountMeta, Harness, Instruction, Pubkey};

/// The next `n` bytes of `rest`; `InvalidInstructionData` if it is shorter.
fn take<'a>(rest: &mut &'a [u8], n: usize) -> Result<&'a [u8], InstructionError> {
    if rest.len() < n {
        return Err(InstructionError::InvalidInstructionData);
    }
    let (head, tail) = rest.split_at(n);
    *rest = tail;
    Ok(head)
}

declare_process_instruction!(Relay, 150, |invoke_context| {
    let (inner, signer_seeds) = {
        let context = invoke_context
            .transaction_context
            .get_current_instruction_context()?;
        let count = context.get_number_of_instruction_accounts();
        if count == 0 {
            return Ok(());
        }
        let mut rest = context
            .get_instruction_data()
            .get(8..)
            .ok_or(InstructionError::InvalidInstructionData)?;
        let signers = usize::from(take(&mut rest, 1)?[0]);
        let mut signer_accounts = Vec::with_capacity(signers);
        let mut signer_seeds: Vec<Vec<Vec<u8>>> = Vec::with_capacity(signers);
        for _ in 0..signers {
            signer_accounts.push(usize::from(take(&mut rest, 1)?[0]));
            let seeds = usize::from(take(&mut rest, 1)?[0]);
            let mut set = Vec::with_capacity(seeds);
            for _ in 0..seeds {
                let len = usize::from(take(&mut rest, 1)?[0]);
                set.push(take(&mut rest, len)?.to_vec());
            }
            signer_seeds.push(set);
        }
        let data = rest.to_vec();
        let program_id = *context.get_key_of_instruction_account(0)?;
        let mut accounts = Vec::with_capacity(usize::from(count));
        for i in 1..count {
            accounts.push(AccountMeta {
                pubkey: *context.get_key_of_instruction_account(i)?,
                is_signer: context.is_instruction_account_signer(i)?,
                is_writable: context.is_instruction_account_writable(i)?,
            });
        }
        for i in signer_accounts {
            accounts
                .get_mut(i)
                .ok_or(InstructionError::InvalidInstructionData)?
                .is_signer = true;
        }
        let inner = Instruction {
            program_id,
            accounts,
            data,
        };
        (inner, signer_seeds)
    };
    let seeds: Vec<Vec<&[u8]>> = signer_seeds
        .iter()
        .map(|set| set.iter().map(Vec::as_slice).collect())
        .collect();
    let seeds: Vec<&[&[u8]]> = seeds.iter().map(Vec::as_slice).collect();
    invoke_context.native_invoke_signed(inner, &seeds)
});

/// A relay instruction for the program registered at `relay_id`: tagged
/// `tag`, it makes the CPI `inner` and passes on only the signatures the
/// transaction carries.
pub fn relay_ix(relay_id: &Pubkey, tag: [u8; 8], inner: &Instruction) -> Instruction {
    relay_signed_ix(relay_id, tag, inner, &[])
}

/// [`relay_ix`] whose CPI the relay also signs, as the program at
/// `relay_id`, for PDAs: each `(index, seeds)` names an account of `inner`
/// by its index and the seeds (bump included) it is derived from. Those
/// accounts go unsigned into the transaction (nobody holds a key for a PDA)
/// and are signers in the CPI only if the runtime derives them from `seeds`
/// and `relay_id`.
pub fn relay_signed_ix(
    relay_id: &Pubkey,
    tag: [u8; 8],
    inner: &Instruction,
    signers: &[(usize, &[&[u8]])],
) -> Instruction {
    let byte = |n: usize, what: &str| {
        u8::try_from(n).unwrap_or_else(|_| panic!("relay: {what} {n} over 255"))
    };
    let mut accounts = vec![AccountMeta::new_readonly(inner.program_id, false)];
    accounts.extend(
        inner
            .accounts
            .iter()
            .enumerate()
            .map(|(i, meta)| AccountMeta {
                is_signer: meta.is_signer && !signers.iter().any(|(signer, _)| *signer == i),
                ..meta.clone()
            }),
    );
    let mut data = tag.to_vec();
    data.push(byte(signers.len(), "signer count"));
    for (index, seeds) in signers {
        assert!(
            *index < inner.accounts.len(),
            "relay: no inner account {index}"
        );
        data.push(byte(*index, "account index"));
        data.push(byte(seeds.len(), "seed count"));
        for seed in *seeds {
            data.push(byte(seed.len(), "seed length"));
            data.extend_from_slice(seed);
        }
    }
    data.extend_from_slice(&inner.data);
    Instruction {
        program_id: *relay_id,
        accounts,
        data,
    }
}

/// A relay instruction that makes no CPI (only its tag is seen).
pub fn relay_noop_ix(relay_id: &Pubkey, tag: [u8; 8]) -> Instruction {
    Instruction {
        program_id: *relay_id,
        accounts: vec![],
        data: tag.to_vec(),
    }
}

impl Harness {
    /// Register [`Relay`] as the program at `program_id`.
    pub fn add_relay(&mut self, program_id: Pubkey) {
        self.svm.add_builtin(program_id, Relay::register);
    }
}

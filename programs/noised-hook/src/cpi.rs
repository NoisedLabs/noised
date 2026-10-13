//! Anchor's CPI client for the hook (`cpi` feature), as `#[program]`
//! generated it: one function per instruction taking an Anchor
//! `CpiContext` of [`accounts`] (`AccountInfo`s), invoking the hook with
//! the instruction's discriminator, Borsh arguments and the accounts'
//! metas. For Anchor programs that call the hook (the launchpad); it is
//! compiled into *their* binary, never into the hook's.

use anchor_lang::{
    context::CpiContext,
    solana_program::{instruction::Instruction, program::invoke_signed},
    InstructionData, ToAccountInfos, ToAccountMetas,
};

use crate::{instruction, state::PolicyParams};

/// `invoke_signed` of the hook instruction with `data` and the context's
/// accounts (`to_account_metas(None)`, remaining accounts included).
fn call<'info, T: ToAccountMetas + ToAccountInfos<'info>>(
    ctx: CpiContext<'_, '_, '_, 'info, T>,
    data: Vec<u8>,
) -> anchor_lang::Result<()> {
    let ix = Instruction {
        program_id: ctx.program_id,
        accounts: ctx.to_account_metas(None),
        data,
    };
    let infos = ctx.to_account_infos();
    invoke_signed(&ix, &infos, ctx.signer_seeds).map_err(Into::into)
}

pub fn initialize_extra_account_meta_list<'a, 'b, 'c, 'info>(
    ctx: CpiContext<'a, 'b, 'c, 'info, accounts::InitializeExtraAccountMetaList<'info>>,
) -> anchor_lang::Result<()> {
    call(ctx, instruction::InitializeExtraAccountMetaList.data())
}

pub fn create_policy<'a, 'b, 'c, 'info>(
    ctx: CpiContext<'a, 'b, 'c, 'info, accounts::CreatePolicy<'info>>,
    params: PolicyParams,
) -> anchor_lang::Result<()> {
    call(ctx, instruction::CreatePolicy { params }.data())
}

pub fn end_snipe_shield<'a, 'b, 'c, 'info>(
    ctx: CpiContext<'a, 'b, 'c, 'info, accounts::EndSnipeShield<'info>>,
) -> anchor_lang::Result<()> {
    call(ctx, instruction::EndSnipeShield.data())
}

pub fn execute<'a, 'b, 'c, 'info>(
    ctx: CpiContext<'a, 'b, 'c, 'info, accounts::Execute<'info>>,
    amount: u64,
) -> anchor_lang::Result<()> {
    call(ctx, instruction::Execute { amount }.data())
}

/// The accounts of each instruction as `AccountInfo`s, with the flags of
/// the program's account lists (`Signer` → signer, `mut` / `init` →
/// writable).
pub mod accounts {
    use anchor_lang::{
        solana_program::{account_info::AccountInfo, instruction::AccountMeta},
        Key, ToAccountInfos, ToAccountMetas,
    };

    fn writable(info: &AccountInfo, is_signer: bool) -> AccountMeta {
        AccountMeta::new(info.key(), is_signer)
    }

    fn readonly(info: &AccountInfo, is_signer: bool) -> AccountMeta {
        AccountMeta::new_readonly(info.key(), is_signer)
    }

    /// Generated CPI struct of the accounts for `InitializeExtraAccountMetaList`.
    #[derive(Debug, Clone)]
    pub struct InitializeExtraAccountMetaList<'info> {
        pub payer: AccountInfo<'info>,
        pub extra_account_meta_list: AccountInfo<'info>,
        pub mint: AccountInfo<'info>,
        pub system_program: AccountInfo<'info>,
    }

    impl ToAccountMetas for InitializeExtraAccountMetaList<'_> {
        fn to_account_metas(&self, is_signer: Option<bool>) -> Vec<AccountMeta> {
            vec![
                writable(&self.payer, is_signer.unwrap_or(true)),
                writable(&self.extra_account_meta_list, false),
                readonly(&self.mint, false),
                readonly(&self.system_program, false),
            ]
        }
    }

    impl<'info> ToAccountInfos<'info> for InitializeExtraAccountMetaList<'info> {
        fn to_account_infos(&self) -> Vec<AccountInfo<'info>> {
            vec![
                self.payer.clone(),
                self.extra_account_meta_list.clone(),
                self.mint.clone(),
                self.system_program.clone(),
            ]
        }
    }

    /// Generated CPI struct of the accounts for `CreatePolicy`.
    #[derive(Debug, Clone)]
    pub struct CreatePolicy<'info> {
        pub payer: AccountInfo<'info>,
        /// The launchpad's PDA; only the launchpad program can produce this signature.
        pub launchpad_authority: AccountInfo<'info>,
        pub mint: AccountInfo<'info>,
        pub pool: AccountInfo<'info>,
        pub policy: AccountInfo<'info>,
        pub system_program: AccountInfo<'info>,
    }

    impl ToAccountMetas for CreatePolicy<'_> {
        fn to_account_metas(&self, is_signer: Option<bool>) -> Vec<AccountMeta> {
            vec![
                writable(&self.payer, is_signer.unwrap_or(true)),
                readonly(&self.launchpad_authority, is_signer.unwrap_or(true)),
                readonly(&self.mint, false),
                readonly(&self.pool, false),
                writable(&self.policy, false),
                readonly(&self.system_program, false),
            ]
        }
    }

    impl<'info> ToAccountInfos<'info> for CreatePolicy<'info> {
        fn to_account_infos(&self) -> Vec<AccountInfo<'info>> {
            vec![
                self.payer.clone(),
                self.launchpad_authority.clone(),
                self.mint.clone(),
                self.pool.clone(),
                self.policy.clone(),
                self.system_program.clone(),
            ]
        }
    }

    /// Generated CPI struct of the accounts for `EndSnipeShield`.
    #[derive(Debug, Clone)]
    pub struct EndSnipeShield<'info> {
        /// The launchpad's PDA; only the launchpad program can produce this
        /// signature (it does so only in `execute_batch`, after the batch buy).
        pub launchpad_authority: AccountInfo<'info>,
        /// A Launch Guard policy PDA (`["policy", mint]`).
        pub policy: AccountInfo<'info>,
        /// The instructions sysvar.
        pub instructions: AccountInfo<'info>,
    }

    impl ToAccountMetas for EndSnipeShield<'_> {
        fn to_account_metas(&self, is_signer: Option<bool>) -> Vec<AccountMeta> {
            vec![
                readonly(&self.launchpad_authority, is_signer.unwrap_or(true)),
                writable(&self.policy, false),
                readonly(&self.instructions, false),
            ]
        }
    }

    impl<'info> ToAccountInfos<'info> for EndSnipeShield<'info> {
        fn to_account_infos(&self) -> Vec<AccountInfo<'info>> {
            vec![
                self.launchpad_authority.clone(),
                self.policy.clone(),
                self.instructions.clone(),
            ]
        }
    }

    /// Generated CPI struct of the accounts for `Execute`.
    #[derive(Debug, Clone)]
    pub struct Execute<'info> {
        pub source: AccountInfo<'info>,
        pub mint: AccountInfo<'info>,
        pub destination: AccountInfo<'info>,
        pub authority: AccountInfo<'info>,
        pub extra_account_meta_list: AccountInfo<'info>,
        pub policy: AccountInfo<'info>,
        pub instructions: AccountInfo<'info>,
    }

    impl ToAccountMetas for Execute<'_> {
        fn to_account_metas(&self, _is_signer: Option<bool>) -> Vec<AccountMeta> {
            vec![
                readonly(&self.source, false),
                readonly(&self.mint, false),
                readonly(&self.destination, false),
                readonly(&self.authority, false),
                readonly(&self.extra_account_meta_list, false),
                readonly(&self.policy, false),
                readonly(&self.instructions, false),
            ]
        }
    }

    impl<'info> ToAccountInfos<'info> for Execute<'info> {
        fn to_account_infos(&self) -> Vec<AccountInfo<'info>> {
            vec![
                self.source.clone(),
                self.mint.clone(),
                self.destination.clone(),
                self.authority.clone(),
                self.extra_account_meta_list.clone(),
                self.policy.clone(),
                self.instructions.clone(),
            ]
        }
    }
}

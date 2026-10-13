//! Client API, as the Anchor build generated it: `accounts` (account lists
//! with Anchor's `ToAccountMetas`) and `instruction` (argument structs with
//! Anchor's `InstructionData`); `program::NoisedHook` is in the crate root.
//! Host only (and for Anchor programs with the `cpi` feature); never
//! compiled into the hook's binary.

/// The accounts of each instruction, in order, with their signer and
/// writable flags (`ToAccountMetas`).
pub mod accounts {
    use anchor_lang::{solana_program::instruction::AccountMeta, ToAccountMetas};

    use crate::Pubkey;

    fn writable(pubkey: Pubkey, is_signer: bool) -> AccountMeta {
        AccountMeta::new(pubkey, is_signer)
    }

    fn readonly(pubkey: Pubkey, is_signer: bool) -> AccountMeta {
        AccountMeta::new_readonly(pubkey, is_signer)
    }

    /// `initialize_extra_account_meta_list`.
    pub struct InitializeExtraAccountMetaList {
        pub payer: Pubkey,
        pub extra_account_meta_list: Pubkey,
        pub mint: Pubkey,
        pub system_program: Pubkey,
    }

    impl ToAccountMetas for InitializeExtraAccountMetaList {
        fn to_account_metas(&self, is_signer: Option<bool>) -> Vec<AccountMeta> {
            vec![
                writable(self.payer, is_signer.unwrap_or(true)),
                writable(self.extra_account_meta_list, false),
                readonly(self.mint, false),
                readonly(self.system_program, false),
            ]
        }
    }

    /// `create_policy`.
    pub struct CreatePolicy {
        pub payer: Pubkey,
        /// The launchpad's PDA; only the launchpad program can produce this signature.
        pub launchpad_authority: Pubkey,
        pub mint: Pubkey,
        pub pool: Pubkey,
        pub policy: Pubkey,
        pub system_program: Pubkey,
    }

    impl ToAccountMetas for CreatePolicy {
        fn to_account_metas(&self, is_signer: Option<bool>) -> Vec<AccountMeta> {
            vec![
                writable(self.payer, is_signer.unwrap_or(true)),
                readonly(self.launchpad_authority, is_signer.unwrap_or(true)),
                readonly(self.mint, false),
                readonly(self.pool, false),
                writable(self.policy, false),
                readonly(self.system_program, false),
            ]
        }
    }

    /// `end_snipe_shield`: the launchpad's CPI from `execute_batch`, in this
    /// account order: `[launchpad_authority (signer), policy (writable),
    /// instructions]`.
    pub struct EndSnipeShield {
        /// The launchpad's PDA; only the launchpad program can produce this
        /// signature (it does so only in `execute_batch`, after the batch buy).
        pub launchpad_authority: Pubkey,
        /// A Launch Guard policy PDA (`["policy", mint]`).
        pub policy: Pubkey,
        /// The instructions sysvar.
        pub instructions: Pubkey,
    }

    impl ToAccountMetas for EndSnipeShield {
        fn to_account_metas(&self, is_signer: Option<bool>) -> Vec<AccountMeta> {
            vec![
                readonly(self.launchpad_authority, is_signer.unwrap_or(true)),
                writable(self.policy, false),
                readonly(self.instructions, false),
            ]
        }
    }

    /// `execute`: the account order the transfer-hook interface fixes.
    pub struct Execute {
        pub source: Pubkey,
        pub mint: Pubkey,
        pub destination: Pubkey,
        pub authority: Pubkey,
        pub extra_account_meta_list: Pubkey,
        pub policy: Pubkey,
        pub instructions: Pubkey,
    }

    impl ToAccountMetas for Execute {
        fn to_account_metas(&self, _is_signer: Option<bool>) -> Vec<AccountMeta> {
            vec![
                readonly(self.source, false),
                readonly(self.mint, false),
                readonly(self.destination, false),
                readonly(self.authority, false),
                readonly(self.extra_account_meta_list, false),
                readonly(self.policy, false),
                readonly(self.instructions, false),
            ]
        }
    }
}

/// Instruction data: discriminator, then the arguments in Borsh
/// (`InstructionData::data`).
pub mod instruction {
    use anchor_lang::{AnchorDeserialize, AnchorSerialize, Discriminator, InstructionData};

    use crate::{discriminator, state::PolicyParams};

    /// `initialize_extra_account_meta_list()`.
    #[derive(AnchorSerialize, AnchorDeserialize)]
    pub struct InitializeExtraAccountMetaList;

    /// `create_policy(params)`.
    #[derive(AnchorSerialize, AnchorDeserialize)]
    pub struct CreatePolicy {
        pub params: PolicyParams,
    }

    /// `end_snipe_shield()`.
    #[derive(AnchorSerialize, AnchorDeserialize)]
    pub struct EndSnipeShield;

    /// `execute(amount)`, under the transfer-hook interface's `Execute`
    /// discriminator.
    #[derive(AnchorSerialize, AnchorDeserialize)]
    pub struct Execute {
        pub amount: u64,
    }

    impl Discriminator for InitializeExtraAccountMetaList {
        const DISCRIMINATOR: &'static [u8] = &discriminator::INITIALIZE_EXTRA_ACCOUNT_META_LIST;
    }
    impl Discriminator for CreatePolicy {
        const DISCRIMINATOR: &'static [u8] = &discriminator::CREATE_POLICY;
    }
    impl Discriminator for EndSnipeShield {
        const DISCRIMINATOR: &'static [u8] = &discriminator::END_SNIPE_SHIELD;
    }
    impl Discriminator for Execute {
        const DISCRIMINATOR: &'static [u8] = &discriminator::EXECUTE;
    }
    impl InstructionData for InitializeExtraAccountMetaList {}
    impl InstructionData for CreatePolicy {}
    impl InstructionData for EndSnipeShield {}
    impl InstructionData for Execute {}
}

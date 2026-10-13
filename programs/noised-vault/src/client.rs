//! Host-only client API, as the Anchor build generated it: `accounts`
//! (account lists with Anchor's `ToAccountMetas`) and `instruction`
//! (argument structs with Anchor's `InstructionData`); `program::NoisedVault`
//! is in the crate root. Never compiled into the program binary.

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

    /// `open_vault`.
    pub struct OpenVault {
        pub payer: Pubkey,
        pub mint: Pubkey,
        pub vault: Pubkey,
        pub vault_token_account: Pubkey,
        pub token_program: Pubkey,
        pub associated_token_program: Pubkey,
        pub system_program: Pubkey,
    }

    impl ToAccountMetas for OpenVault {
        fn to_account_metas(&self, is_signer: Option<bool>) -> Vec<AccountMeta> {
            vec![
                writable(self.payer, is_signer.unwrap_or(true)),
                readonly(self.mint, false),
                writable(self.vault, false),
                writable(self.vault_token_account, false),
                readonly(self.token_program, false),
                readonly(self.associated_token_program, false),
                readonly(self.system_program, false),
            ]
        }
    }

    /// `withdraw`.
    pub struct Withdraw {
        pub payer: Pubkey,
        pub mint: Pubkey,
        pub vault: Pubkey,
        pub vault_token_account: Pubkey,
        pub payout: Pubkey,
        pub token_program: Pubkey,
        pub system_program: Pubkey,
    }

    impl ToAccountMetas for Withdraw {
        fn to_account_metas(&self, is_signer: Option<bool>) -> Vec<AccountMeta> {
            vec![
                writable(self.payer, is_signer.unwrap_or(true)),
                readonly(self.mint, false),
                writable(self.vault, false),
                readonly(self.vault_token_account, false),
                writable(self.payout, false),
                readonly(self.token_program, false),
                readonly(self.system_program, false),
            ]
        }
    }

    /// `release`; the mint's transfer-hook accounts follow these.
    pub struct Release {
        pub payer: Pubkey,
        pub mint: Pubkey,
        pub vault: Pubkey,
        pub vault_token_account: Pubkey,
        pub payout: Pubkey,
        pub rent_payer: Pubkey,
        pub destination_owner: Pubkey,
        pub destination: Pubkey,
        pub memo_program: Pubkey,
        pub token_program: Pubkey,
        pub associated_token_program: Pubkey,
        pub system_program: Pubkey,
    }

    impl ToAccountMetas for Release {
        fn to_account_metas(&self, is_signer: Option<bool>) -> Vec<AccountMeta> {
            vec![
                writable(self.payer, is_signer.unwrap_or(true)),
                readonly(self.mint, false),
                writable(self.vault, false),
                writable(self.vault_token_account, false),
                writable(self.payout, false),
                writable(self.rent_payer, false),
                readonly(self.destination_owner, false),
                writable(self.destination, false),
                readonly(self.memo_program, false),
                readonly(self.token_program, false),
                readonly(self.associated_token_program, false),
                readonly(self.system_program, false),
            ]
        }
    }

    /// `release_to`; the mint's transfer-hook accounts follow these.
    pub struct ReleaseTo {
        pub destination_owner: Pubkey,
        pub mint: Pubkey,
        pub vault: Pubkey,
        pub vault_token_account: Pubkey,
        pub payout: Pubkey,
        pub rent_payer: Pubkey,
        pub destination: Pubkey,
        pub memo_program: Pubkey,
        pub token_program: Pubkey,
    }

    impl ToAccountMetas for ReleaseTo {
        fn to_account_metas(&self, is_signer: Option<bool>) -> Vec<AccountMeta> {
            vec![
                readonly(self.destination_owner, is_signer.unwrap_or(true)),
                readonly(self.mint, false),
                writable(self.vault, false),
                writable(self.vault_token_account, false),
                writable(self.payout, false),
                writable(self.rent_payer, false),
                writable(self.destination, false),
                readonly(self.memo_program, false),
                readonly(self.token_program, false),
            ]
        }
    }
}

/// Instruction data: discriminator, then the arguments in Borsh
/// (`InstructionData::data`).
pub mod instruction {
    use anchor_lang::{AnchorDeserialize, AnchorSerialize, Discriminator, InstructionData};

    use crate::{discriminator, state::VaultKey, WithdrawArgs};

    /// `open_vault(key_id_arg, key)`.
    #[derive(AnchorSerialize, AnchorDeserialize)]
    pub struct OpenVault {
        pub key_id_arg: [u8; 32],
        pub key: VaultKey,
    }

    /// `withdraw(args)`.
    #[derive(AnchorSerialize, AnchorDeserialize)]
    pub struct Withdraw {
        pub args: WithdrawArgs,
    }

    /// `release()`.
    #[derive(AnchorSerialize, AnchorDeserialize)]
    pub struct Release;

    /// `release_to()`.
    #[derive(AnchorSerialize, AnchorDeserialize)]
    pub struct ReleaseTo;

    impl Discriminator for OpenVault {
        const DISCRIMINATOR: &'static [u8] = &discriminator::OPEN_VAULT;
    }
    impl Discriminator for Withdraw {
        const DISCRIMINATOR: &'static [u8] = &discriminator::WITHDRAW;
    }
    impl Discriminator for Release {
        const DISCRIMINATOR: &'static [u8] = &discriminator::RELEASE;
    }
    impl Discriminator for ReleaseTo {
        const DISCRIMINATOR: &'static [u8] = &discriminator::RELEASE_TO;
    }
    impl InstructionData for OpenVault {}
    impl InstructionData for Withdraw {}
    impl InstructionData for Release {}
    impl InstructionData for ReleaseTo {}
}

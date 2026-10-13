//! Host-only client API, as the Anchor build generated it: `accounts`
//! (account lists with Anchor's `ToAccountMetas`) and `instruction`
//! (argument structs with Anchor's `InstructionData`); `program::NoisedShield`
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

    /// `create_shield`.
    #[derive(anchor_lang::AnchorSerialize, Debug, Default, Copy, Clone)]
    pub struct CreateShield {
        pub payer: Pubkey,
        pub base_mint: Pubkey,
        pub shield: Pubkey,
        pub shield_authority: Pubkey,
        pub z_mint: Pubkey,
        pub escrow: Pubkey,
        pub base_token_program: Pubkey,
        pub token_2022_program: Pubkey,
        pub associated_token_program: Pubkey,
        pub system_program: Pubkey,
    }

    impl ToAccountMetas for CreateShield {
        fn to_account_metas(&self, is_signer: Option<bool>) -> Vec<AccountMeta> {
            vec![
                writable(self.payer, is_signer.unwrap_or(true)),
                readonly(self.base_mint, false),
                writable(self.shield, false),
                readonly(self.shield_authority, false),
                writable(self.z_mint, false),
                writable(self.escrow, false),
                readonly(self.base_token_program, false),
                readonly(self.token_2022_program, false),
                readonly(self.associated_token_program, false),
                readonly(self.system_program, false),
            ]
        }
    }

    /// `wrap`; the base mint's transfer-hook accounts follow these.
    #[derive(anchor_lang::AnchorSerialize, Debug, Default, Copy, Clone)]
    pub struct Wrap {
        pub user: Pubkey,
        pub shield: Pubkey,
        pub shield_authority: Pubkey,
        pub base_mint: Pubkey,
        pub z_mint: Pubkey,
        pub escrow: Pubkey,
        pub user_base: Pubkey,
        pub user_z: Pubkey,
        pub base_token_program: Pubkey,
        pub token_2022_program: Pubkey,
    }

    /// The account list of `wrap` and `unwrap` (the same fields and flags).
    #[allow(clippy::too_many_arguments)]
    fn exchange_metas(
        is_signer: Option<bool>,
        user: Pubkey,
        shield: Pubkey,
        shield_authority: Pubkey,
        base_mint: Pubkey,
        z_mint: Pubkey,
        escrow: Pubkey,
        user_base: Pubkey,
        user_z: Pubkey,
        base_token_program: Pubkey,
        token_2022_program: Pubkey,
    ) -> Vec<AccountMeta> {
        vec![
            readonly(user, is_signer.unwrap_or(true)),
            readonly(shield, false),
            readonly(shield_authority, false),
            readonly(base_mint, false),
            writable(z_mint, false),
            writable(escrow, false),
            writable(user_base, false),
            writable(user_z, false),
            readonly(base_token_program, false),
            readonly(token_2022_program, false),
        ]
    }

    impl ToAccountMetas for Wrap {
        fn to_account_metas(&self, is_signer: Option<bool>) -> Vec<AccountMeta> {
            exchange_metas(
                is_signer,
                self.user,
                self.shield,
                self.shield_authority,
                self.base_mint,
                self.z_mint,
                self.escrow,
                self.user_base,
                self.user_z,
                self.base_token_program,
                self.token_2022_program,
            )
        }
    }

    /// `unwrap`; the base mint's transfer-hook accounts follow these.
    #[derive(anchor_lang::AnchorSerialize, Debug, Default, Copy, Clone)]
    pub struct Unwrap {
        pub user: Pubkey,
        pub shield: Pubkey,
        pub shield_authority: Pubkey,
        pub base_mint: Pubkey,
        pub z_mint: Pubkey,
        pub escrow: Pubkey,
        pub user_base: Pubkey,
        pub user_z: Pubkey,
        pub base_token_program: Pubkey,
        pub token_2022_program: Pubkey,
    }

    impl ToAccountMetas for Unwrap {
        fn to_account_metas(&self, is_signer: Option<bool>) -> Vec<AccountMeta> {
            exchange_metas(
                is_signer,
                self.user,
                self.shield,
                self.shield_authority,
                self.base_mint,
                self.z_mint,
                self.escrow,
                self.user_base,
                self.user_z,
                self.base_token_program,
                self.token_2022_program,
            )
        }
    }
}

/// Instruction data: discriminator, then the arguments in Borsh
/// (`InstructionData::data`).
pub mod instruction {
    use anchor_lang::{AnchorDeserialize, AnchorSerialize, Discriminator, InstructionData};

    use crate::discriminator;

    /// `create_shield()`.
    #[derive(AnchorSerialize, AnchorDeserialize)]
    pub struct CreateShield;

    /// `wrap(amount)`.
    #[derive(AnchorSerialize, AnchorDeserialize)]
    pub struct Wrap {
        pub amount: u64,
    }

    /// `unwrap(amount)`.
    #[derive(AnchorSerialize, AnchorDeserialize)]
    pub struct Unwrap {
        pub amount: u64,
    }

    impl Discriminator for CreateShield {
        const DISCRIMINATOR: &'static [u8] = &discriminator::CREATE_SHIELD;
    }
    impl Discriminator for Wrap {
        const DISCRIMINATOR: &'static [u8] = &discriminator::WRAP;
    }
    impl Discriminator for Unwrap {
        const DISCRIMINATOR: &'static [u8] = &discriminator::UNWRAP;
    }
    impl InstructionData for CreateShield {}
    impl InstructionData for Wrap {}
    impl InstructionData for Unwrap {}
}

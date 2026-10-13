//! Host-only client API, as the Anchor build generated it: `accounts`
//! (account lists with Anchor's `ToAccountMetas`) and `instruction`
//! (argument structs with Anchor's `InstructionData`);
//! `program::NoisedAutopilot` is in the crate root. Never compiled into the
//! program binary.

/// The accounts of each instruction, in order, with their signer and
/// writable flags (`ToAccountMetas`). `Option` fields stand for the program
/// id when `None`, as Anchor encodes them.
pub mod accounts {
    use anchor_lang::{solana_program::instruction::AccountMeta, AnchorSerialize, ToAccountMetas};

    use crate::Pubkey;

    fn writable(pubkey: Pubkey, is_signer: bool) -> AccountMeta {
        AccountMeta::new(pubkey, is_signer)
    }

    fn readonly(pubkey: Pubkey, is_signer: bool) -> AccountMeta {
        AccountMeta::new_readonly(pubkey, is_signer)
    }

    /// An `Option` field: the account, or the program id (read-only, not a
    /// signer) for `None`.
    fn optional(
        pubkey: Option<Pubkey>,
        meta: fn(Pubkey, bool) -> AccountMeta,
        is_signer: bool,
    ) -> AccountMeta {
        match pubkey {
            Some(pubkey) => meta(pubkey, is_signer),
            None => readonly(crate::ID, false),
        }
    }

    /// `init_autopilot`.
    #[derive(AnchorSerialize, Debug, Default, Copy, Clone)]
    pub struct InitAutopilot {
        pub payer: Pubkey,
        pub launch: Pubkey,
        pub dbc_config: Pubkey,
        pub autopilot: Pubkey,
        pub treasury: Pubkey,
        pub wsol_mint: Pubkey,
        pub treasury_wsol: Pubkey,
        pub token_program: Pubkey,
        pub associated_token_program: Pubkey,
        pub system_program: Pubkey,
    }

    impl ToAccountMetas for InitAutopilot {
        fn to_account_metas(&self, is_signer: Option<bool>) -> Vec<AccountMeta> {
            vec![
                writable(self.payer, is_signer.unwrap_or(true)),
                readonly(self.launch, false),
                readonly(self.dbc_config, false),
                writable(self.autopilot, false),
                readonly(self.treasury, false),
                readonly(self.wsol_mint, false),
                writable(self.treasury_wsol, false),
                readonly(self.token_program, false),
                readonly(self.associated_token_program, false),
                readonly(self.system_program, false),
            ]
        }
    }

    /// `bind_mint`.
    #[derive(AnchorSerialize, Debug, Default, Copy, Clone)]
    pub struct BindMint {
        pub payer: Pubkey,
        pub autopilot: Pubkey,
        pub launch: Pubkey,
        pub certificate: Pubkey,
        pub mint: Pubkey,
        pub treasury: Pubkey,
        pub treasury_token: Pubkey,
        pub token_2022_program: Pubkey,
        pub associated_token_program: Pubkey,
        pub system_program: Pubkey,
    }

    impl ToAccountMetas for BindMint {
        fn to_account_metas(&self, is_signer: Option<bool>) -> Vec<AccountMeta> {
            vec![
                writable(self.payer, is_signer.unwrap_or(true)),
                writable(self.autopilot, false),
                readonly(self.launch, false),
                readonly(self.certificate, false),
                readonly(self.mint, false),
                readonly(self.treasury, false),
                writable(self.treasury_token, false),
                readonly(self.token_2022_program, false),
                readonly(self.associated_token_program, false),
                readonly(self.system_program, false),
            ]
        }
    }

    /// `bind_pool`.
    #[derive(AnchorSerialize, Debug, Default, Copy, Clone)]
    pub struct BindPool {
        pub autopilot: Pubkey,
        pub damm_config: Pubkey,
        pub damm_pool: Pubkey,
    }

    impl ToAccountMetas for BindPool {
        fn to_account_metas(&self, _is_signer: Option<bool>) -> Vec<AccountMeta> {
            vec![
                writable(self.autopilot, false),
                readonly(self.damm_config, false),
                readonly(self.damm_pool, false),
            ]
        }
    }

    /// `publish_graph`.
    #[derive(AnchorSerialize, Debug, Default, Copy, Clone)]
    pub struct PublishGraph {
        pub payer: Pubkey,
        pub launch: Pubkey,
        pub graph: Pubkey,
        pub system_program: Pubkey,
    }

    impl ToAccountMetas for PublishGraph {
        fn to_account_metas(&self, is_signer: Option<bool>) -> Vec<AccountMeta> {
            vec![
                writable(self.payer, is_signer.unwrap_or(true)),
                readonly(self.launch, false),
                writable(self.graph, false),
                readonly(self.system_program, false),
            ]
        }
    }

    /// `activate`.
    #[derive(AnchorSerialize, Debug, Default, Copy, Clone)]
    pub struct Activate {
        pub autopilot: Pubkey,
        pub launch: Pubkey,
        pub graph: Pubkey,
        pub authorization: Pubkey,
    }

    impl ToAccountMetas for Activate {
        fn to_account_metas(&self, _is_signer: Option<bool>) -> Vec<AccountMeta> {
            vec![
                writable(self.autopilot, false),
                readonly(self.launch, false),
                readonly(self.graph, false),
                readonly(self.authorization, false),
            ]
        }
    }

    /// `apply_pending`.
    #[derive(AnchorSerialize, Debug, Default, Copy, Clone)]
    pub struct ApplyPending {
        pub autopilot: Pubkey,
        pub graph: Pubkey,
    }

    impl ToAccountMetas for ApplyPending {
        fn to_account_metas(&self, _is_signer: Option<bool>) -> Vec<AccountMeta> {
            vec![writable(self.autopilot, false), readonly(self.graph, false)]
        }
    }

    /// `freeze` and `revoke_operator`.
    #[derive(AnchorSerialize, Debug, Default, Copy, Clone)]
    pub struct Govern {
        pub autopilot: Pubkey,
        pub launch: Pubkey,
        pub authorization: Pubkey,
    }

    impl ToAccountMetas for Govern {
        fn to_account_metas(&self, _is_signer: Option<bool>) -> Vec<AccountMeta> {
            vec![
                writable(self.autopilot, false),
                readonly(self.launch, false),
                readonly(self.authorization, false),
            ]
        }
    }

    /// `run`; the action's accounts follow these.
    #[derive(AnchorSerialize, Debug, Default, Copy, Clone)]
    pub struct Run {
        pub caller: Pubkey,
        pub operator: Option<Pubkey>,
        pub autopilot: Pubkey,
        pub graph: Pubkey,
        pub treasury: Pubkey,
        pub treasury_wsol: Pubkey,
        pub treasury_token: Pubkey,
        pub mint: Pubkey,
        pub wsol_mint: Pubkey,
        pub damm_pool: Option<Pubkey>,
        pub tip_account: Pubkey,
        pub token_program: Pubkey,
        pub token_2022_program: Pubkey,
    }

    impl ToAccountMetas for Run {
        fn to_account_metas(&self, is_signer: Option<bool>) -> Vec<AccountMeta> {
            vec![
                readonly(self.caller, is_signer.unwrap_or(true)),
                optional(self.operator, readonly, is_signer.unwrap_or(true)),
                writable(self.autopilot, false),
                readonly(self.graph, false),
                readonly(self.treasury, false),
                writable(self.treasury_wsol, false),
                writable(self.treasury_token, false),
                writable(self.mint, false),
                readonly(self.wsol_mint, false),
                optional(self.damm_pool, readonly, false),
                writable(self.tip_account, false),
                readonly(self.token_program, false),
                readonly(self.token_2022_program, false),
            ]
        }
    }

    /// `update_price`.
    #[derive(AnchorSerialize, Debug, Default, Copy, Clone)]
    pub struct UpdatePrice {
        pub autopilot: Pubkey,
        pub damm_pool: Pubkey,
    }

    impl ToAccountMetas for UpdatePrice {
        fn to_account_metas(&self, _is_signer: Option<bool>) -> Vec<AccountMeta> {
            vec![
                writable(self.autopilot, false),
                readonly(self.damm_pool, false),
            ]
        }
    }
}

/// Instruction data: discriminator, then the arguments in Borsh
/// (`InstructionData::data`).
pub mod instruction {
    use anchor_lang::{AnchorDeserialize, AnchorSerialize, Discriminator, InstructionData, Owner};

    use crate::{discriminator, Pubkey};

    /// `init_autopilot()`.
    #[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
    pub struct InitAutopilot;

    /// `bind_mint()`.
    #[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
    pub struct BindMint;

    /// `bind_pool()`.
    #[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
    pub struct BindPool;

    /// `publish_graph(bytes)`.
    #[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
    pub struct PublishGraph {
        pub bytes: Vec<u8>,
    }

    /// `activate(activate_at)`.
    #[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
    pub struct Activate {
        pub activate_at: i64,
    }

    /// `apply_pending()`.
    #[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
    pub struct ApplyPending;

    /// `freeze(not_after)`.
    #[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
    pub struct Freeze {
        pub not_after: i64,
    }

    /// `revoke_operator()`.
    #[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
    pub struct RevokeOperator;

    /// `run(node, amount)`.
    #[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
    pub struct Run {
        pub node: u8,
        pub amount: Option<u64>,
    }

    /// `update_price()`.
    #[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
    pub struct UpdatePrice;

    macro_rules! instruction_data {
        ($($name:ident = $discriminator:ident),* $(,)?) => {
            $(
                impl Discriminator for $name {
                    const DISCRIMINATOR: &'static [u8] = &discriminator::$discriminator;
                }
                impl InstructionData for $name {}
                impl Owner for $name {
                    fn owner() -> Pubkey {
                        crate::ID
                    }
                }
            )*
        };
    }

    instruction_data! {
        InitAutopilot = INIT_AUTOPILOT,
        BindMint = BIND_MINT,
        BindPool = BIND_POOL,
        PublishGraph = PUBLISH_GRAPH,
        Activate = ACTIVATE,
        ApplyPending = APPLY_PENDING,
        Freeze = FREEZE,
        RevokeOperator = REVOKE_OPERATOR,
        Run = RUN,
        UpdatePrice = UPDATE_PRICE,
    }
}

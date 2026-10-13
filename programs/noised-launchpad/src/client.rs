//! Host-only client API, as the Anchor build generated it: `accounts`
//! (account lists with Anchor's `ToAccountMetas`) and `instruction`
//! (argument structs with Anchor's `InstructionData`); `program::NoisedLaunchpad`
//! is in the crate root. Never compiled into the program binary.

/// The accounts of each instruction, in order, with their signer and
/// writable flags (`ToAccountMetas`). An absent optional account is the
/// program id, read-only (Anchor's `None`).
pub mod accounts {
    use anchor_lang::{solana_program::instruction::AccountMeta, ToAccountMetas};

    use crate::Pubkey;

    fn meta(pubkey: Pubkey, is_signer: bool, is_writable: bool) -> AccountMeta {
        if is_writable {
            AccountMeta::new(pubkey, is_signer)
        } else {
            AccountMeta::new_readonly(pubkey, is_signer)
        }
    }

    /// An optional account: the program id (read-only) when absent.
    fn optional(pubkey: Option<Pubkey>, is_writable: bool) -> AccountMeta {
        match pubkey {
            Some(pubkey) => meta(pubkey, false, is_writable),
            None => AccountMeta::new_readonly(crate::ID, false),
        }
    }

    /// `initialize_protocol`.
    pub struct InitializeProtocol {
        pub authority: Pubkey,
        pub protocol: Pubkey,
        pub treasury: Pubkey,
        pub program: Pubkey,
        pub program_data: Pubkey,
        pub system_program: Pubkey,
    }

    impl ToAccountMetas for InitializeProtocol {
        fn to_account_metas(&self, is_signer: Option<bool>) -> Vec<AccountMeta> {
            vec![
                meta(self.authority, is_signer.unwrap_or(true), true),
                meta(self.protocol, false, true),
                meta(self.treasury, false, false),
                meta(self.program, false, false),
                meta(self.program_data, false, false),
                meta(self.system_program, false, false),
            ]
        }
    }

    /// `create_launch`.
    pub struct CreateLaunch {
        pub creator: Pubkey,
        pub protocol: Pubkey,
        pub launch: Pubkey,
        pub launch_authority: Pubkey,
        pub dbc_config: Pubkey,
        pub quote_mint: Pubkey,
        pub hook_program: Pubkey,
        pub dbc_program: Pubkey,
        pub dbc_event_authority: Pubkey,
        pub system_program: Pubkey,
    }

    impl ToAccountMetas for CreateLaunch {
        fn to_account_metas(&self, is_signer: Option<bool>) -> Vec<AccountMeta> {
            vec![
                meta(self.creator, is_signer.unwrap_or(true), true),
                meta(self.protocol, false, false),
                meta(self.launch, false, true),
                meta(self.launch_authority, false, false),
                meta(self.dbc_config, false, true),
                meta(self.quote_mint, false, false),
                meta(self.hook_program, false, false),
                meta(self.dbc_program, false, false),
                meta(self.dbc_event_authority, false, false),
                meta(self.system_program, false, false),
            ]
        }
    }

    /// `publish_metadata`.
    pub struct PublishMetadata {
        pub payer: Pubkey,
        pub launch: Pubkey,
        pub token_meta: Pubkey,
        pub system_program: Pubkey,
    }

    impl ToAccountMetas for PublishMetadata {
        fn to_account_metas(&self, is_signer: Option<bool>) -> Vec<AccountMeta> {
            vec![
                meta(self.payer, is_signer.unwrap_or(true), true),
                meta(self.launch, false, false),
                meta(self.token_meta, false, true),
                meta(self.system_program, false, false),
            ]
        }
    }

    /// `publish_rules`.
    pub struct PublishRules {
        pub payer: Pubkey,
        pub launch: Pubkey,
        pub rules: Pubkey,
        pub system_program: Pubkey,
    }

    impl ToAccountMetas for PublishRules {
        fn to_account_metas(&self, is_signer: Option<bool>) -> Vec<AccountMeta> {
            vec![
                meta(self.payer, is_signer.unwrap_or(true), true),
                meta(self.launch, false, false),
                meta(self.rules, false, true),
                meta(self.system_program, false, false),
            ]
        }
    }

    /// `attest_launch`.
    pub struct AttestLaunch {
        pub payer: Pubkey,
        pub launch: Pubkey,
        pub identity: Pubkey,
        pub attestation: Pubkey,
        pub token_meta: Pubkey,
        pub system_program: Pubkey,
        pub rules: Option<Pubkey>,
    }

    impl ToAccountMetas for AttestLaunch {
        fn to_account_metas(&self, is_signer: Option<bool>) -> Vec<AccountMeta> {
            vec![
                meta(self.payer, is_signer.unwrap_or(true), true),
                meta(self.launch, false, false),
                meta(self.identity, false, true),
                meta(self.attestation, false, true),
                meta(self.token_meta, false, false),
                meta(self.system_program, false, false),
                optional(self.rules, false),
            ]
        }
    }

    /// `pq_authorize`.
    pub struct PqAuthorize {
        pub payer: Pubkey,
        pub launch: Pubkey,
        pub identity: Pubkey,
        pub authorization: Pubkey,
        pub system_program: Pubkey,
    }

    impl ToAccountMetas for PqAuthorize {
        fn to_account_metas(&self, is_signer: Option<bool>) -> Vec<AccountMeta> {
            vec![
                meta(self.payer, is_signer.unwrap_or(true), true),
                meta(self.launch, false, false),
                meta(self.identity, false, true),
                meta(self.authorization, false, true),
                meta(self.system_program, false, false),
            ]
        }
    }

    /// `launch`.
    pub struct LaunchToken {
        pub payer: Pubkey,
        pub launch: Pubkey,
        pub launch_authority: Pubkey,
        pub dbc_config: Pubkey,
        pub base_mint: Pubkey,
        pub pool: Pubkey,
        pub base_vault: Pubkey,
        pub quote_vault: Pubkey,
        pub quote_mint: Pubkey,
        pub dbc_pool_authority: Pubkey,
        pub hook_authority: Pubkey,
        pub extra_account_meta_list: Pubkey,
        pub policy: Pubkey,
        pub certificate: Pubkey,
        pub hook_program: Pubkey,
        pub dbc_program: Pubkey,
        pub dbc_event_authority: Pubkey,
        pub token_2022_program: Pubkey,
        pub token_program: Pubkey,
        pub system_program: Pubkey,
        pub attestation: Pubkey,
        pub token_meta: Pubkey,
        pub rules: Option<Pubkey>,
    }

    impl ToAccountMetas for LaunchToken {
        fn to_account_metas(&self, is_signer: Option<bool>) -> Vec<AccountMeta> {
            vec![
                meta(self.payer, is_signer.unwrap_or(true), true),
                meta(self.launch, false, true),
                meta(self.launch_authority, false, false),
                meta(self.dbc_config, false, false),
                meta(self.base_mint, is_signer.unwrap_or(true), true),
                meta(self.pool, false, true),
                meta(self.base_vault, false, true),
                meta(self.quote_vault, false, true),
                meta(self.quote_mint, false, false),
                meta(self.dbc_pool_authority, false, false),
                meta(self.hook_authority, false, false),
                meta(self.extra_account_meta_list, false, true),
                meta(self.policy, false, true),
                meta(self.certificate, false, true),
                meta(self.hook_program, false, false),
                meta(self.dbc_program, false, false),
                meta(self.dbc_event_authority, false, false),
                meta(self.token_2022_program, false, false),
                meta(self.token_program, false, false),
                meta(self.system_program, false, false),
                meta(self.attestation, false, false),
                meta(self.token_meta, false, false),
                optional(self.rules, false),
            ]
        }
    }

    /// `commit`.
    pub struct CommitToBatch {
        pub owner: Pubkey,
        pub launch: Pubkey,
        pub commit: Pubkey,
        pub batch_authority: Pubkey,
        pub quote_mint: Pubkey,
        pub owner_quote_account: Pubkey,
        pub batch_quote_escrow: Pubkey,
        pub token_program: Pubkey,
        pub associated_token_program: Pubkey,
        pub system_program: Pubkey,
        pub token_owner: Pubkey,
        pub refund_owner: Pubkey,
        pub payout_vault: Option<Pubkey>,
    }

    impl ToAccountMetas for CommitToBatch {
        fn to_account_metas(&self, is_signer: Option<bool>) -> Vec<AccountMeta> {
            vec![
                meta(self.owner, is_signer.unwrap_or(true), true),
                meta(self.launch, false, true),
                meta(self.commit, false, true),
                meta(self.batch_authority, false, false),
                meta(self.quote_mint, false, false),
                meta(self.owner_quote_account, false, true),
                meta(self.batch_quote_escrow, false, true),
                meta(self.token_program, false, false),
                meta(self.associated_token_program, false, false),
                meta(self.system_program, false, false),
                meta(self.token_owner, false, false),
                meta(self.refund_owner, false, false),
                optional(self.payout_vault, true),
            ]
        }
    }

    /// `execute_batch`.
    pub struct ExecuteBatch {
        pub payer: Pubkey,
        pub launch: Pubkey,
        pub batch_authority: Pubkey,
        pub dbc_config: Pubkey,
        pub pool: Pubkey,
        pub base_vault: Pubkey,
        pub quote_vault: Pubkey,
        pub base_mint: Pubkey,
        pub quote_mint: Pubkey,
        pub batch_quote_escrow: Pubkey,
        pub batch_base_escrow: Pubkey,
        pub dbc_pool_authority: Pubkey,
        pub dbc_program: Pubkey,
        pub dbc_event_authority: Pubkey,
        pub token_program: Pubkey,
        pub token_2022_program: Pubkey,
        pub associated_token_program: Pubkey,
        pub system_program: Pubkey,
        pub hook_authority: Pubkey,
        pub policy: Pubkey,
        pub hook_program: Pubkey,
    }

    impl ToAccountMetas for ExecuteBatch {
        fn to_account_metas(&self, is_signer: Option<bool>) -> Vec<AccountMeta> {
            vec![
                meta(self.payer, is_signer.unwrap_or(true), true),
                meta(self.launch, false, true),
                meta(self.batch_authority, false, false),
                meta(self.dbc_config, false, false),
                meta(self.pool, false, true),
                meta(self.base_vault, false, true),
                meta(self.quote_vault, false, true),
                meta(self.base_mint, false, true),
                meta(self.quote_mint, false, false),
                meta(self.batch_quote_escrow, false, true),
                meta(self.batch_base_escrow, false, true),
                meta(self.dbc_pool_authority, false, false),
                meta(self.dbc_program, false, false),
                meta(self.dbc_event_authority, false, false),
                meta(self.token_program, false, false),
                meta(self.token_2022_program, false, false),
                meta(self.associated_token_program, false, false),
                meta(self.system_program, false, false),
                meta(self.hook_authority, false, false),
                meta(self.policy, false, true),
                meta(self.hook_program, false, false),
            ]
        }
    }

    /// `claim`.
    pub struct Claim {
        pub payer: Pubkey,
        pub launch: Pubkey,
        pub commit: Pubkey,
        pub token_owner: Pubkey,
        pub refund_owner: Pubkey,
        pub batch_authority: Pubkey,
        pub base_mint: Pubkey,
        pub quote_mint: Pubkey,
        pub batch_quote_escrow: Pubkey,
        pub batch_base_escrow: Option<Pubkey>,
        pub refund_owner_ata: Option<Pubkey>,
        pub token_owner_ata: Option<Pubkey>,
        pub token_program: Pubkey,
        pub token_2022_program: Pubkey,
        pub associated_token_program: Pubkey,
        pub system_program: Pubkey,
    }

    impl ToAccountMetas for Claim {
        fn to_account_metas(&self, is_signer: Option<bool>) -> Vec<AccountMeta> {
            vec![
                meta(self.payer, is_signer.unwrap_or(true), true),
                meta(self.launch, false, true),
                meta(self.commit, false, true),
                meta(self.token_owner, false, false),
                meta(self.refund_owner, false, false),
                meta(self.batch_authority, false, false),
                meta(self.base_mint, false, false),
                meta(self.quote_mint, false, false),
                meta(self.batch_quote_escrow, false, true),
                optional(self.batch_base_escrow, true),
                optional(self.refund_owner_ata, true),
                optional(self.token_owner_ata, true),
                meta(self.token_program, false, false),
                meta(self.token_2022_program, false, false),
                meta(self.associated_token_program, false, false),
                meta(self.system_program, false, false),
            ]
        }
    }

    /// `claim_fees`.
    pub struct ClaimFees {
        pub payer: Pubkey,
        pub launch: Pubkey,
        pub launch_authority: Pubkey,
        pub dbc_config: Pubkey,
        pub pool: Pubkey,
        pub base_vault: Pubkey,
        pub quote_vault: Pubkey,
        pub base_mint: Pubkey,
        pub quote_mint: Pubkey,
        pub authority_base_ata: Pubkey,
        pub authority_quote_ata: Pubkey,
        pub dbc_pool_authority: Pubkey,
        pub dbc_program: Pubkey,
        pub dbc_event_authority: Pubkey,
        pub token_program: Pubkey,
        pub token_2022_program: Pubkey,
        pub associated_token_program: Pubkey,
        pub system_program: Pubkey,
    }

    impl ToAccountMetas for ClaimFees {
        fn to_account_metas(&self, is_signer: Option<bool>) -> Vec<AccountMeta> {
            vec![
                meta(self.payer, is_signer.unwrap_or(true), true),
                meta(self.launch, false, false),
                meta(self.launch_authority, false, false),
                meta(self.dbc_config, false, false),
                meta(self.pool, false, true),
                meta(self.base_vault, false, true),
                meta(self.quote_vault, false, true),
                meta(self.base_mint, false, false),
                meta(self.quote_mint, false, false),
                meta(self.authority_base_ata, false, true),
                meta(self.authority_quote_ata, false, true),
                meta(self.dbc_pool_authority, false, false),
                meta(self.dbc_program, false, false),
                meta(self.dbc_event_authority, false, false),
                meta(self.token_program, false, false),
                meta(self.token_2022_program, false, false),
                meta(self.associated_token_program, false, false),
                meta(self.system_program, false, false),
            ]
        }
    }

    /// `claim_surplus`.
    pub struct ClaimSurplus {
        pub payer: Pubkey,
        pub launch: Pubkey,
        pub launch_authority: Pubkey,
        pub dbc_config: Pubkey,
        pub pool: Pubkey,
        pub quote_vault: Pubkey,
        pub quote_mint: Pubkey,
        pub authority_quote_ata: Pubkey,
        pub dbc_pool_authority: Pubkey,
        pub dbc_program: Pubkey,
        pub dbc_event_authority: Pubkey,
        pub token_program: Pubkey,
        pub associated_token_program: Pubkey,
        pub system_program: Pubkey,
    }

    impl ToAccountMetas for ClaimSurplus {
        fn to_account_metas(&self, is_signer: Option<bool>) -> Vec<AccountMeta> {
            vec![
                meta(self.payer, is_signer.unwrap_or(true), true),
                meta(self.launch, false, false),
                meta(self.launch_authority, false, false),
                meta(self.dbc_config, false, false),
                meta(self.pool, false, true),
                meta(self.quote_vault, false, true),
                meta(self.quote_mint, false, false),
                meta(self.authority_quote_ata, false, true),
                meta(self.dbc_pool_authority, false, false),
                meta(self.dbc_program, false, false),
                meta(self.dbc_event_authority, false, false),
                meta(self.token_program, false, false),
                meta(self.associated_token_program, false, false),
                meta(self.system_program, false, false),
            ]
        }
    }

    /// `claim_lp_fees`.
    pub struct ClaimLpFees {
        pub payer: Pubkey,
        pub launch: Pubkey,
        pub launch_authority: Pubkey,
        pub damm_pool: Pubkey,
        pub position: Pubkey,
        pub position_nft_account: Pubkey,
        pub token_a_vault: Pubkey,
        pub token_b_vault: Pubkey,
        pub base_mint: Pubkey,
        pub quote_mint: Pubkey,
        pub authority_base_ata: Pubkey,
        pub authority_quote_ata: Pubkey,
        pub damm_pool_authority: Pubkey,
        pub damm_program: Pubkey,
        pub damm_event_authority: Pubkey,
        pub token_program: Pubkey,
        pub token_2022_program: Pubkey,
        pub associated_token_program: Pubkey,
        pub system_program: Pubkey,
    }

    impl ToAccountMetas for ClaimLpFees {
        fn to_account_metas(&self, is_signer: Option<bool>) -> Vec<AccountMeta> {
            vec![
                meta(self.payer, is_signer.unwrap_or(true), true),
                meta(self.launch, false, false),
                meta(self.launch_authority, false, false),
                meta(self.damm_pool, false, false),
                meta(self.position, false, true),
                meta(self.position_nft_account, false, false),
                meta(self.token_a_vault, false, true),
                meta(self.token_b_vault, false, true),
                meta(self.base_mint, false, false),
                meta(self.quote_mint, false, false),
                meta(self.authority_base_ata, false, true),
                meta(self.authority_quote_ata, false, true),
                meta(self.damm_pool_authority, false, false),
                meta(self.damm_program, false, false),
                meta(self.damm_event_authority, false, false),
                meta(self.token_program, false, false),
                meta(self.token_2022_program, false, false),
                meta(self.associated_token_program, false, false),
                meta(self.system_program, false, false),
            ]
        }
    }

    /// `distribute`.
    pub struct Distribute {
        pub payer: Pubkey,
        pub launch: Pubkey,
        pub launch_authority: Pubkey,
        pub treasury: Pubkey,
        pub base_mint: Pubkey,
        pub quote_mint: Pubkey,
        pub authority_quote_ata: Pubkey,
        pub authority_base_ata: Pubkey,
        pub treasury_quote_ata: Pubkey,
        pub token_program: Pubkey,
        pub token_2022_program: Pubkey,
        pub associated_token_program: Pubkey,
        pub system_program: Pubkey,
    }

    impl ToAccountMetas for Distribute {
        fn to_account_metas(&self, is_signer: Option<bool>) -> Vec<AccountMeta> {
            vec![
                meta(self.payer, is_signer.unwrap_or(true), true),
                meta(self.launch, false, false),
                meta(self.launch_authority, false, false),
                meta(self.treasury, false, false),
                meta(self.base_mint, false, true),
                meta(self.quote_mint, false, false),
                meta(self.authority_quote_ata, false, true),
                meta(self.authority_base_ata, false, true),
                meta(self.treasury_quote_ata, false, true),
                meta(self.token_program, false, false),
                meta(self.token_2022_program, false, false),
                meta(self.associated_token_program, false, false),
                meta(self.system_program, false, false),
            ]
        }
    }
}

/// Instruction data: discriminator, then the arguments in Borsh
/// (`InstructionData::data`).
pub mod instruction {
    use anchor_lang::{AnchorDeserialize, AnchorSerialize, Discriminator, InstructionData};

    use crate::{discriminator, Pubkey};

    /// `initialize_protocol(platform_fee_bps)`.
    #[derive(AnchorSerialize, AnchorDeserialize)]
    pub struct InitializeProtocol {
        pub platform_fee_bps: u16,
    }

    impl Discriminator for InitializeProtocol {
        const DISCRIMINATOR: &'static [u8] = &discriminator::INITIALIZE_PROTOCOL;
    }

    impl InstructionData for InitializeProtocol {}

    /// `create_launch(launch_seed, params)`.
    #[derive(AnchorSerialize, AnchorDeserialize)]
    pub struct CreateLaunch {
        pub launch_seed: [u8; 32],
        pub params: crate::state::LaunchParams,
    }

    impl Discriminator for CreateLaunch {
        const DISCRIMINATOR: &'static [u8] = &discriminator::CREATE_LAUNCH;
    }

    impl InstructionData for CreateLaunch {}

    /// `publish_metadata(name, symbol, flags, uri, doc)`.
    #[derive(AnchorSerialize, AnchorDeserialize)]
    pub struct PublishMetadata {
        pub name: String,
        pub symbol: String,
        pub flags: u8,
        pub uri: String,
        pub doc: String,
    }

    impl Discriminator for PublishMetadata {
        const DISCRIMINATOR: &'static [u8] = &discriminator::PUBLISH_METADATA;
    }

    impl InstructionData for PublishMetadata {}

    /// `publish_rules(bytes)`.
    #[derive(AnchorSerialize, AnchorDeserialize)]
    pub struct PublishRules {
        pub bytes: Vec<u8>,
    }

    impl Discriminator for PublishRules {
        const DISCRIMINATOR: &'static [u8] = &discriminator::PUBLISH_RULES;
    }

    impl InstructionData for PublishRules {}

    /// `attest_launch(lms_pk, lms_sig, metadata_hash, rules_hash, not_before, not_after)`.
    #[derive(AnchorSerialize, AnchorDeserialize)]
    pub struct AttestLaunch {
        pub lms_pk: [u8; 56],
        pub lms_sig: Vec<u8>,
        pub metadata_hash: [u8; 32],
        pub rules_hash: [u8; 32],
        pub not_before: i64,
        pub not_after: i64,
    }

    impl Discriminator for AttestLaunch {
        const DISCRIMINATOR: &'static [u8] = &discriminator::ATTEST_LAUNCH;
    }

    impl InstructionData for AttestLaunch {}

    /// `pq_authorize(lms_pk, lms_sig, kind, payload_hash)`.
    #[derive(AnchorSerialize, AnchorDeserialize)]
    pub struct PqAuthorize {
        pub lms_pk: [u8; 56],
        pub lms_sig: Vec<u8>,
        pub kind: u8,
        pub payload_hash: [u8; 32],
    }

    impl Discriminator for PqAuthorize {
        const DISCRIMINATOR: &'static [u8] = &discriminator::PQ_AUTHORIZE;
    }

    impl InstructionData for PqAuthorize {}

    /// `launch()`.
    #[derive(AnchorSerialize, AnchorDeserialize)]
    pub struct Launch;

    impl Discriminator for Launch {
        const DISCRIMINATOR: &'static [u8] = &discriminator::LAUNCH;
    }

    impl InstructionData for Launch {}

    /// `commit(amount)`.
    #[derive(AnchorSerialize, AnchorDeserialize)]
    pub struct Commit {
        pub amount: u64,
    }

    impl Discriminator for Commit {
        const DISCRIMINATOR: &'static [u8] = &discriminator::COMMIT;
    }

    impl InstructionData for Commit {}

    /// `execute_batch()`.
    #[derive(AnchorSerialize, AnchorDeserialize)]
    pub struct ExecuteBatch;

    impl Discriminator for ExecuteBatch {
        const DISCRIMINATOR: &'static [u8] = &discriminator::EXECUTE_BATCH;
    }

    impl InstructionData for ExecuteBatch {}

    /// `claim(owner)`.
    #[derive(AnchorSerialize, AnchorDeserialize)]
    pub struct Claim {
        pub owner: Pubkey,
    }

    impl Discriminator for Claim {
        const DISCRIMINATOR: &'static [u8] = &discriminator::CLAIM;
    }

    impl InstructionData for Claim {}

    /// `claim_fees()`.
    #[derive(AnchorSerialize, AnchorDeserialize)]
    pub struct ClaimFees;

    impl Discriminator for ClaimFees {
        const DISCRIMINATOR: &'static [u8] = &discriminator::CLAIM_FEES;
    }

    impl InstructionData for ClaimFees {}

    /// `claim_surplus()`.
    #[derive(AnchorSerialize, AnchorDeserialize)]
    pub struct ClaimSurplus;

    impl Discriminator for ClaimSurplus {
        const DISCRIMINATOR: &'static [u8] = &discriminator::CLAIM_SURPLUS;
    }

    impl InstructionData for ClaimSurplus {}

    /// `claim_lp_fees()`.
    #[derive(AnchorSerialize, AnchorDeserialize)]
    pub struct ClaimLpFees;

    impl Discriminator for ClaimLpFees {
        const DISCRIMINATOR: &'static [u8] = &discriminator::CLAIM_LP_FEES;
    }

    impl InstructionData for ClaimLpFees {}

    /// `distribute()`.
    #[derive(AnchorSerialize, AnchorDeserialize)]
    pub struct Distribute;

    impl Discriminator for Distribute {
        const DISCRIMINATOR: &'static [u8] = &discriminator::DISTRIBUTE;
    }

    impl InstructionData for Distribute {}
}

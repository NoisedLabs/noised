//! The other programs' interfaces, by hand: only the instructions the
//! launchpad invokes (discriminator, accounts with their signer and writable
//! flags as the IDL-generated CPI builders send them, Borsh arguments) and
//! only the account fields it reads (fixed offsets of their layouts). The
//! Anchor build generated the whole DBC and DAMM v2 interfaces
//! (`declare_program!`) and linked the hook crate for its CPI client; the
//! ABI tests check these against the IDL-generated types and the hook crate.
//!
//! * [`dbc`]: Meteora Dynamic Bonding Curve 0.2.1 (`idls/dynamic_bonding_curve.json`).
//! * [`damm`]: Meteora DAMM v2 (`idls/cp_amm.json`).
//! * [`hook`]: the Noised Launch Guard (`idls/noised_hook.json`).

use alloc::vec::Vec;

use noised_onchain::{
    cpi::invoke, pinocchio::instruction::InstructionAccount, AccountView, ProgramResult, Signer,
};

use crate::Pubkey;

/// One account of a CPI: the account, then whether the instruction marks it
/// writable and signer.
pub type CpiMeta<'a> = (&'a AccountView, bool, bool);

/// Read-only, not a signer.
#[inline(always)]
pub fn ro(account: &AccountView) -> CpiMeta<'_> {
    (account, false, false)
}

/// Writable, not a signer.
#[inline(always)]
pub fn rw(account: &AccountView) -> CpiMeta<'_> {
    (account, true, false)
}

/// Read-only signer.
#[inline(always)]
pub fn ro_signer(account: &AccountView) -> CpiMeta<'_> {
    (account, false, true)
}

/// Writable signer.
#[inline(always)]
pub fn rw_signer(account: &AccountView) -> CpiMeta<'_> {
    (account, true, true)
}

/// Invokes `program_id` with `accounts` (in order, with their flags; each
/// one is also passed as an account info) and `data`, signed by `signers`.
#[inline(never)]
pub fn invoke_with(
    program_id: &Pubkey,
    accounts: &[CpiMeta],
    data: &[u8],
    signers: &[Signer],
) -> ProgramResult {
    let metas: Vec<InstructionAccount> = accounts
        .iter()
        .map(|(account, writable, signer)| {
            InstructionAccount::new(account.address(), *writable, *signer)
        })
        .collect();
    let infos: Vec<&AccountView> = accounts.iter().map(|(account, _, _)| *account).collect();
    invoke(program_id, &metas, data, &infos, signers)
}

/// Meteora Dynamic Bonding Curve 0.2.1.
pub mod dbc {
    use alloc::vec::Vec;

    use noised_onchain::{AccountView, ProgramResult, Signer};

    use super::{invoke_with, ro, ro_signer, rw, rw_signer, CpiMeta};
    use crate::{
        constants::{dbc, DBC_PROGRAM_ID, MAX_CURVE_POINTS},
        processor::concat,
        state::LaunchParams,
    };

    /// `create_config_with_transfer_hook`.
    pub const CREATE_CONFIG_WITH_TRANSFER_HOOK: [u8; 8] = [216, 37, 1, 57, 88, 226, 25, 41];
    /// `initialize_virtual_pool_with_token2022_transfer_hook`.
    pub const INITIALIZE_VIRTUAL_POOL_WITH_TOKEN2022_TRANSFER_HOOK: [u8; 8] =
        [182, 13, 233, 177, 42, 145, 135, 2];
    /// `swap2_with_transfer_hook`.
    pub const SWAP2_WITH_TRANSFER_HOOK: [u8; 8] = [183, 93, 153, 40, 24, 230, 194, 151];
    /// `claim_trading_fee2`.
    pub const CLAIM_TRADING_FEE2: [u8; 8] = [84, 191, 71, 50, 9, 162, 55, 193];
    /// `partner_withdraw_surplus`.
    pub const PARTNER_WITHDRAW_SURPLUS: [u8; 8] = [168, 173, 72, 100, 201, 98, 38, 92];
    /// `creator_withdraw_surplus`.
    pub const CREATOR_WITHDRAW_SURPLUS: [u8; 8] = [165, 3, 137, 7, 28, 134, 76, 80];
    /// `AccountsType::TransferHookBase` (a `RemainingAccountsSlice` kind).
    pub const ACCOUNTS_TYPE_TRANSFER_HOOK_BASE: u8 = 0;

    /// `ConfigWithTransferHook` (zero-copy): byte offsets, the 8-byte
    /// discriminator included, of the fields `launch` checks.
    pub mod config {
        pub const DISCRIMINATOR: [u8; 8] = [40, 220, 194, 251, 41, 199, 123, 253];
        /// Discriminator and `size_of::<ConfigWithTransferHook>()`.
        pub const LEN: usize = 8 + 1_120;
        pub const QUOTE_MINT: usize = 8;
        pub const FEE_CLAIMER: usize = 40;
        pub const LEFTOVER_RECEIVER: usize = 72;
        pub const PARTNER_LIQUIDITY_VESTING_IS_INITIALIZED: usize = 184;
        pub const CREATOR_LIQUIDITY_VESTING_IS_INITIALIZED: usize = 200;
        pub const COLLECT_FEE_MODE: usize = 232;
        pub const MIGRATION_OPTION: usize = 233;
        pub const ACTIVATION_TYPE: usize = 234;
        pub const TOKEN_DECIMAL: usize = 235;
        pub const TOKEN_TYPE: usize = 237;
        pub const PARTNER_PERMANENT_LOCKED_LIQUIDITY_PERCENTAGE: usize = 239;
        pub const PARTNER_LIQUIDITY_PERCENTAGE: usize = 240;
        pub const CREATOR_PERMANENT_LOCKED_LIQUIDITY_PERCENTAGE: usize = 241;
        pub const CREATOR_LIQUIDITY_PERCENTAGE: usize = 242;
        pub const MIGRATION_FEE_OPTION: usize = 243;
        pub const FIXED_TOKEN_SUPPLY_FLAG: usize = 244;
        pub const CREATOR_TRADING_FEE_PERCENTAGE: usize = 245;
        pub const TOKEN_UPDATE_AUTHORITY: usize = 246;
        pub const MIGRATION_FEE_PERCENTAGE: usize = 247;
        pub const CREATOR_MIGRATION_FEE_PERCENTAGE: usize = 248;
        /// u64.
        pub const MIGRATION_QUOTE_THRESHOLD: usize = 264;
        /// `locked_vesting_config`: amount_per_period,
        /// cliff_duration_from_migration_time, frequency, number_of_period,
        /// cliff_unlock_amount (u64 each).
        pub const LOCKED_VESTING: [usize; 5] = [296, 304, 312, 320, 328];
        pub const ENABLE_FIRST_SWAP_WITH_MIN_FEE: usize = 365;
        /// u64.
        pub const POOL_CREATION_FEE: usize = 368;
        pub const TRANSFER_HOOK_PROGRAM: usize = 1_048;
    }

    /// `TransferHookPool` (zero-copy, `pool_state`): byte offsets, the
    /// discriminator included.
    pub mod pool {
        pub const DISCRIMINATOR: [u8; 8] = [237, 219, 184, 23, 42, 189, 169, 35];
        /// Discriminator and `size_of::<TransferHookPool>()`.
        pub const LEN: usize = 8 + 416;
        pub const CONFIG: usize = 72;
        pub const CREATOR: usize = 104;
        pub const BASE_MINT: usize = 136;
        pub const BASE_VAULT: usize = 168;
        pub const QUOTE_VAULT: usize = 200;
        pub const IS_PARTNER_WITHDRAW_SURPLUS: usize = 306;
        pub const IS_CREATOR_WITHDRAW_SURPLUS: usize = 310;
        pub const HAS_SWAP: usize = 370;
    }

    /// `create_config_with_transfer_hook(config_parameters)`'s data: the
    /// launch's `ConfigParameters` (SPEC §1.2: the creator-chosen fields
    /// from validated `LaunchParams`, every other field fixed), in Borsh.
    /// Must only be called with parameters that passed `policy::validate`.
    pub fn create_config_data(params: &LaunchParams) -> Vec<u8> {
        // pool_fees.dynamic_fee: the option tag, then the parameters.
        let mut dynamic = [0u8; 1 + 32];
        let dynamic_len = match &params.dynamic_fee {
            None => 1,
            Some(d) => {
                dynamic[0] = 1;
                dynamic[1..3].copy_from_slice(&d.bin_step.to_le_bytes());
                dynamic[3..19].copy_from_slice(&d.bin_step_u128.to_le_bytes());
                dynamic[19..21].copy_from_slice(&d.filter_period.to_le_bytes());
                dynamic[21..23].copy_from_slice(&d.decay_period.to_le_bytes());
                dynamic[23..25].copy_from_slice(&d.reduction_factor.to_le_bytes());
                dynamic[25..29].copy_from_slice(&d.max_volatility_accumulator.to_le_bytes());
                dynamic[29..33].copy_from_slice(&d.variable_fee_control.to_le_bytes());
                33
            }
        };
        // curve: the length, then each point (at most MAX_CURVE_POINTS:
        // validated).
        let mut curve = [0u8; 4 + 32 * MAX_CURVE_POINTS];
        let mut count = 0u32;
        for (point, slot) in params.curve.iter().zip(curve[4..].as_chunks_mut::<32>().0) {
            slot[..16].copy_from_slice(&point.sqrt_price.to_le_bytes());
            slot[16..].copy_from_slice(&point.liquidity.to_le_bytes());
            count += 1;
        }
        curve[..4].copy_from_slice(&count.to_le_bytes());
        let fee = &params.base_fee;
        concat(&[
            &CREATE_CONFIG_WITH_TRANSFER_HOOK,
            // pool_fees.base_fee.
            &fee.cliff_fee_numerator.to_le_bytes(),
            &fee.first_factor.to_le_bytes(),
            &fee.second_factor.to_le_bytes(),
            &fee.third_factor.to_le_bytes(),
            &[fee.base_fee_mode],
            dynamic.get(..dynamic_len).unwrap_or_default(),
            // collect_fee_mode, migration_option, activation_type,
            // token_type, token_decimal, partner_liquidity_percentage,
            // partner_permanent_locked_liquidity_percentage,
            // creator_liquidity_percentage,
            // creator_permanent_locked_liquidity_percentage.
            &[
                dbc::COLLECT_FEE_MODE_QUOTE,
                dbc::MIGRATION_OPTION_DAMM_V2,
                dbc::ACTIVATION_TYPE_TIMESTAMP,
                dbc::TOKEN_TYPE_TOKEN_2022,
                params.token_decimal,
                0,
                100,
                0,
                0,
            ],
            &params.migration_quote_threshold.to_le_bytes(),
            &params.sqrt_start_price.to_le_bytes(),
            // locked_vesting: five zero u64.
            &[0; 40],
            &[params.migration_fee_option],
            // token_supply: None; creator_trading_fee_percentage: 0;
            // token_update_authority.
            &[0, 0, dbc::TOKEN_UPDATE_AUTHORITY_IMMUTABLE],
            // migration_fee (2 x u8), migrated_pool_fee (u8, u8, u16),
            // pool_creation_fee (u64), partner and creator liquidity vesting
            // info (13 bytes each), migrated_pool_base_fee_mode (u8),
            // migrated_pool_market_cap_fee_scheduler_params (16 bytes),
            // enable_first_swap_with_min_fee (false), compounding_fee_bps
            // (u16), padding ([u8; 2]): all zero. Fixed migration fee
            // options require every migrated-pool fee field to be zero (DBC:
            // `MigratedPoolFeeValidator::is_none`).
            &[0; 2 + 4 + 8 + 13 + 13 + 1 + 16 + 1 + 2 + 2],
            curve.get(..4 + 32 * count as usize).unwrap_or_default(),
        ])
    }

    /// `create_config_with_transfer_hook`, the config PDA signing:
    /// config (writable, signer), fee_claimer, leftover_receiver,
    /// quote_mint, transfer_hook_program, payer (writable, signer),
    /// system_program, event_authority, program.
    #[allow(clippy::too_many_arguments)]
    pub fn create_config_with_transfer_hook(
        config: &AccountView,
        fee_claimer: &AccountView,
        leftover_receiver: &AccountView,
        quote_mint: &AccountView,
        transfer_hook_program: &AccountView,
        payer: &AccountView,
        system_program: &AccountView,
        event_authority: &AccountView,
        program: &AccountView,
        data: &[u8],
        signers: &[Signer],
    ) -> ProgramResult {
        invoke_with(
            &DBC_PROGRAM_ID,
            &[
                rw_signer(config),
                ro(fee_claimer),
                ro(leftover_receiver),
                ro(quote_mint),
                ro(transfer_hook_program),
                rw_signer(payer),
                ro(system_program),
                ro(event_authority),
                ro(program),
            ],
            data,
            signers,
        )
    }

    /// The accounts of `initialize_virtual_pool_with_token2022_transfer_hook`.
    pub struct InitializePool<'a> {
        pub config: &'a AccountView,
        pub pool_authority: &'a AccountView,
        pub creator: &'a AccountView,
        pub base_mint: &'a AccountView,
        pub quote_mint: &'a AccountView,
        pub pool: &'a AccountView,
        pub base_vault: &'a AccountView,
        pub quote_vault: &'a AccountView,
        pub transfer_hook_program: &'a AccountView,
        pub payer: &'a AccountView,
        pub token_quote_program: &'a AccountView,
        pub token_program: &'a AccountView,
        pub system_program: &'a AccountView,
        pub event_authority: &'a AccountView,
        pub program: &'a AccountView,
    }

    /// `initialize_virtual_pool_with_token2022_transfer_hook(params)`, the
    /// creator PDA signing; `data` is the instruction data
    /// (`dbc_params::initialize_pool_data`).
    pub fn initialize_virtual_pool_with_token2022_transfer_hook(
        a: &InitializePool,
        data: &[u8],
        signers: &[Signer],
    ) -> ProgramResult {
        invoke_with(
            &DBC_PROGRAM_ID,
            &[
                ro(a.config),
                ro(a.pool_authority),
                ro_signer(a.creator),
                rw_signer(a.base_mint),
                ro(a.quote_mint),
                rw(a.pool),
                rw(a.base_vault),
                rw(a.quote_vault),
                ro(a.transfer_hook_program),
                rw_signer(a.payer),
                ro(a.token_quote_program),
                ro(a.token_program),
                ro(a.system_program),
                ro(a.event_authority),
                ro(a.program),
            ],
            data,
            signers,
        )
    }

    /// The accounts of `swap2_with_transfer_hook` (no referral account).
    pub struct Swap2<'a> {
        pub pool_authority: &'a AccountView,
        pub config: &'a AccountView,
        pub pool: &'a AccountView,
        pub input_token_account: &'a AccountView,
        pub output_token_account: &'a AccountView,
        pub base_vault: &'a AccountView,
        pub quote_vault: &'a AccountView,
        pub base_mint: &'a AccountView,
        pub quote_mint: &'a AccountView,
        pub payer: &'a AccountView,
        pub token_base_program: &'a AccountView,
        pub token_quote_program: &'a AccountView,
        pub event_authority: &'a AccountView,
        pub program: &'a AccountView,
    }

    /// `swap2_with_transfer_hook(SwapParameters2 { amount_0, amount_1,
    /// swap_mode }, TransferHookAccountsInfo { slices: [(TransferHookBase,
    /// hook_accounts.len())] })`, the payer PDA signing. The absent referral
    /// account is the DBC program id (read-only), as Anchor's client sends an
    /// absent optional account; `hook_accounts` follow with their own flags
    /// (`CpiContext::with_remaining_accounts`).
    pub fn swap2_with_transfer_hook(
        a: &Swap2,
        amount_0: u64,
        amount_1: u64,
        swap_mode: u8,
        hook_accounts: &[AccountView],
        signers: &[Signer],
    ) -> ProgramResult {
        let mut accounts: Vec<CpiMeta> = Vec::with_capacity(15 + hook_accounts.len());
        accounts.extend_from_slice(&[
            ro(a.pool_authority),
            ro(a.config),
            rw(a.pool),
            rw(a.input_token_account),
            rw(a.output_token_account),
            rw(a.base_vault),
            rw(a.quote_vault),
            rw(a.base_mint),
            ro(a.quote_mint),
            ro_signer(a.payer),
            ro(a.token_base_program),
            ro(a.token_quote_program),
            // referral_token_account: None.
            ro(a.program),
            ro(a.event_authority),
            ro(a.program),
        ]);
        accounts.extend(
            hook_accounts
                .iter()
                .map(|account| (account, account.is_writable(), account.is_signer())),
        );
        let mut data = [0u8; 8 + 17 + 4 + 2];
        data[..8].copy_from_slice(&SWAP2_WITH_TRANSFER_HOOK);
        data[8..16].copy_from_slice(&amount_0.to_le_bytes());
        data[16..24].copy_from_slice(&amount_1.to_le_bytes());
        data[24] = swap_mode;
        // slices: one (TransferHookBase, length).
        data[25..29].copy_from_slice(&1u32.to_le_bytes());
        data[29] = ACCOUNTS_TYPE_TRANSFER_HOOK_BASE;
        data[30] = hook_accounts.len() as u8;
        invoke_with(&DBC_PROGRAM_ID, &accounts, &data, signers)
    }

    /// The accounts of `claim_trading_fee2`.
    pub struct ClaimTradingFee2<'a> {
        pub pool_authority: &'a AccountView,
        pub config: &'a AccountView,
        pub pool: &'a AccountView,
        pub token_a_account: &'a AccountView,
        pub token_b_account: &'a AccountView,
        pub base_vault: &'a AccountView,
        pub quote_vault: &'a AccountView,
        pub base_mint: &'a AccountView,
        pub quote_mint: &'a AccountView,
        pub fee_claimer: &'a AccountView,
        pub token_base_program: &'a AccountView,
        pub token_quote_program: &'a AccountView,
        pub event_authority: &'a AccountView,
        pub program: &'a AccountView,
    }

    /// `claim_trading_fee2(max_amount_a, max_amount_b,
    /// TransferHookAccountsInfo { slices: [] })`, the fee claimer PDA
    /// signing.
    pub fn claim_trading_fee2(
        a: &ClaimTradingFee2,
        max_amount_a: u64,
        max_amount_b: u64,
        signers: &[Signer],
    ) -> ProgramResult {
        let mut data = [0u8; 8 + 8 + 8 + 4];
        data[..8].copy_from_slice(&CLAIM_TRADING_FEE2);
        data[8..16].copy_from_slice(&max_amount_a.to_le_bytes());
        data[16..24].copy_from_slice(&max_amount_b.to_le_bytes());
        invoke_with(
            &DBC_PROGRAM_ID,
            &[
                ro(a.pool_authority),
                ro(a.config),
                rw(a.pool),
                rw(a.token_a_account),
                rw(a.token_b_account),
                rw(a.base_vault),
                rw(a.quote_vault),
                ro(a.base_mint),
                ro(a.quote_mint),
                ro_signer(a.fee_claimer),
                ro(a.token_base_program),
                ro(a.token_quote_program),
                ro(a.event_authority),
                ro(a.program),
            ],
            &data,
            signers,
        )
    }

    /// The accounts of `partner_withdraw_surplus` and
    /// `creator_withdraw_surplus` (`claimer` is the fee claimer or the
    /// creator).
    pub struct WithdrawSurplus<'a> {
        pub pool_authority: &'a AccountView,
        pub config: &'a AccountView,
        pub virtual_pool: &'a AccountView,
        pub token_quote_account: &'a AccountView,
        pub quote_vault: &'a AccountView,
        pub quote_mint: &'a AccountView,
        pub claimer: &'a AccountView,
        pub token_quote_program: &'a AccountView,
        pub event_authority: &'a AccountView,
        pub program: &'a AccountView,
    }

    /// `partner_withdraw_surplus` (`discriminator` =
    /// [`PARTNER_WITHDRAW_SURPLUS`]) or `creator_withdraw_surplus`
    /// ([`CREATOR_WITHDRAW_SURPLUS`]): no arguments, the claimer PDA signing.
    pub fn withdraw_surplus(
        a: &WithdrawSurplus,
        discriminator: &[u8; 8],
        signers: &[Signer],
    ) -> ProgramResult {
        invoke_with(
            &DBC_PROGRAM_ID,
            &[
                ro(a.pool_authority),
                ro(a.config),
                rw(a.virtual_pool),
                rw(a.token_quote_account),
                rw(a.quote_vault),
                ro(a.quote_mint),
                ro_signer(a.claimer),
                ro(a.token_quote_program),
                ro(a.event_authority),
                ro(a.program),
            ],
            discriminator,
            signers,
        )
    }
}

/// Meteora DAMM v2 (`cp_amm`).
pub mod damm {
    use noised_onchain::{AccountView, ProgramResult, Signer};

    use super::{invoke_with, ro, ro_signer, rw};
    use crate::constants::DAMM_V2_PROGRAM_ID;

    /// `claim_position_fee`.
    pub const CLAIM_POSITION_FEE: [u8; 8] = [180, 38, 154, 17, 133, 33, 162, 211];

    /// `Pool` (zero-copy): byte offsets, the discriminator included.
    pub mod pool {
        pub const DISCRIMINATOR: [u8; 8] = [241, 154, 109, 4, 17, 177, 109, 188];
        /// Discriminator and `size_of::<Pool>()`.
        pub const LEN: usize = 8 + 1_104;
        pub const TOKEN_A_MINT: usize = 168;
        pub const TOKEN_B_MINT: usize = 200;
    }

    /// `Position` (zero-copy): byte offsets, the discriminator included.
    pub mod position {
        pub const DISCRIMINATOR: [u8; 8] = [170, 188, 143, 228, 122, 64, 247, 208];
        /// Discriminator and `size_of::<Position>()`.
        pub const LEN: usize = 8 + 400;
        pub const POOL: usize = 8;
        pub const NFT_MINT: usize = 40;
    }

    /// The accounts of `claim_position_fee`.
    pub struct ClaimPositionFee<'a> {
        pub pool_authority: &'a AccountView,
        pub pool: &'a AccountView,
        pub position: &'a AccountView,
        pub token_a_account: &'a AccountView,
        pub token_b_account: &'a AccountView,
        pub token_a_vault: &'a AccountView,
        pub token_b_vault: &'a AccountView,
        pub token_a_mint: &'a AccountView,
        pub token_b_mint: &'a AccountView,
        pub position_nft_account: &'a AccountView,
        pub signer: &'a AccountView,
        pub token_a_program: &'a AccountView,
        pub token_b_program: &'a AccountView,
        pub event_authority: &'a AccountView,
        pub program: &'a AccountView,
    }

    /// `claim_position_fee()`, the position owner PDA signing.
    pub fn claim_position_fee(a: &ClaimPositionFee, signers: &[Signer]) -> ProgramResult {
        invoke_with(
            &DAMM_V2_PROGRAM_ID,
            &[
                ro(a.pool_authority),
                ro(a.pool),
                rw(a.position),
                rw(a.token_a_account),
                rw(a.token_b_account),
                rw(a.token_a_vault),
                rw(a.token_b_vault),
                ro(a.token_a_mint),
                ro(a.token_b_mint),
                ro(a.position_nft_account),
                ro_signer(a.signer),
                ro(a.token_a_program),
                ro(a.token_b_program),
                ro(a.event_authority),
                ro(a.program),
            ],
            &CLAIM_POSITION_FEE,
            signers,
        )
    }
}

/// The Noised Launch Guard (`noised_hook`): its id, seeds, the three
/// instructions the launchpad signs for, and the policy it writes.
pub mod hook {
    use alloc::vec::Vec;

    use noised_onchain::{args::Reader, AccountView, ProgramResult, Signer};

    use super::{invoke_with, ro, ro_signer, rw, rw_signer};
    use crate::{pubkey::pubkey, Pubkey};

    /// `cHHLLsEH4eHmqZBT4X5XqzutmkFw3daWSySPtV4csia` (the hook's
    /// `declare_id!`).
    pub const ID: Pubkey = pubkey!("cHHLLsEH4eHmqZBT4X5XqzutmkFw3daWSySPtV4csia");
    /// `Sysvar1nstructions1111111111111111111111111`.
    pub const INSTRUCTIONS_SYSVAR_ID: Pubkey = noised_onchain::sysvar::INSTRUCTIONS_ID;
    /// `["policy", mint]`: a mint's Launch Guard policy.
    pub const POLICY_SEED: &[u8] = b"policy";
    /// `["extra-account-metas", mint]`: a mint's ExtraAccountMetaList.
    pub const META_LIST_SEED: &[u8] = b"extra-account-metas";
    /// The hook's `MAX_EXEMPT`.
    pub const MAX_EXEMPT: usize = 4;

    /// `initialize_extra_account_meta_list`.
    pub const INITIALIZE_EXTRA_ACCOUNT_META_LIST: [u8; 8] = [92, 197, 174, 197, 41, 124, 19, 3];
    /// `create_policy`.
    pub const CREATE_POLICY: [u8; 8] = [27, 81, 33, 27, 196, 103, 246, 53];
    /// `end_snipe_shield`.
    pub const END_SNIPE_SHIELD: [u8; 8] = [219, 182, 248, 52, 26, 6, 73, 161];
    /// `sha256("account:HookPolicy")[..8]`.
    pub const HOOK_POLICY_DISCRIMINATOR: [u8; 8] = [103, 114, 246, 85, 15, 22, 190, 195];

    /// `initialize_extra_account_meta_list()`: payer (writable, signer),
    /// extra_account_meta_list (writable), mint, system_program.
    pub fn initialize_extra_account_meta_list(
        payer: &AccountView,
        extra_account_meta_list: &AccountView,
        mint: &AccountView,
        system_program: &AccountView,
    ) -> ProgramResult {
        invoke_with(
            &ID,
            &[
                rw_signer(payer),
                rw(extra_account_meta_list),
                ro(mint),
                ro(system_program),
            ],
            &INITIALIZE_EXTRA_ACCOUNT_META_LIST,
            &[],
        )
    }

    /// `PolicyParams`.
    pub struct PolicyParams<'a> {
        pub pool: Pubkey,
        pub snipe_shield_secs: u32,
        pub guard_secs: u32,
        pub max_wallet: u64,
        pub max_buy: u64,
        pub p2p_locked: bool,
        pub exempt: [Pubkey; MAX_EXEMPT],
        /// PXR1 bytes (empty for none).
        pub rules: &'a [u8],
    }

    impl PolicyParams<'_> {
        /// `create_policy(params)`'s data: discriminator, then the
        /// parameters in Borsh.
        pub fn data(&self) -> Vec<u8> {
            crate::processor::concat(&[
                &CREATE_POLICY,
                self.pool.as_ref(),
                &self.snipe_shield_secs.to_le_bytes(),
                &self.guard_secs.to_le_bytes(),
                &self.max_wallet.to_le_bytes(),
                &self.max_buy.to_le_bytes(),
                &[u8::from(self.p2p_locked)],
                self.exempt[0].as_ref(),
                self.exempt[1].as_ref(),
                self.exempt[2].as_ref(),
                self.exempt[3].as_ref(),
                &(self.rules.len() as u32).to_le_bytes(),
                self.rules,
            ])
        }
    }

    /// `create_policy(params)`, the launchpad's hook-authority PDA signing:
    /// payer (writable, signer), launchpad_authority (signer), mint, pool,
    /// policy (writable), system_program.
    #[allow(clippy::too_many_arguments)]
    pub fn create_policy(
        payer: &AccountView,
        launchpad_authority: &AccountView,
        mint: &AccountView,
        pool: &AccountView,
        policy: &AccountView,
        system_program: &AccountView,
        data: &[u8],
        signers: &[Signer],
    ) -> ProgramResult {
        invoke_with(
            &ID,
            &[
                rw_signer(payer),
                ro_signer(launchpad_authority),
                ro(mint),
                ro(pool),
                rw(policy),
                ro(system_program),
            ],
            data,
            signers,
        )
    }

    /// `end_snipe_shield()`, the launchpad's hook-authority PDA signing:
    /// launchpad_authority (signer), policy (writable), instructions.
    pub fn end_snipe_shield(
        launchpad_authority: &AccountView,
        policy: &AccountView,
        instructions: &AccountView,
        signers: &[Signer],
    ) -> ProgramResult {
        invoke_with(
            &ID,
            &[ro_signer(launchpad_authority), rw(policy), ro(instructions)],
            &END_SNIPE_SHIELD,
            signers,
        )
    }

    /// A `HookPolicy`, decoded as the Anchor build's `try_deserialize` did.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct Policy<'a> {
        pub version: u8,
        pub bump: u8,
        pub mint: Pubkey,
        pub pool: Pubkey,
        pub base_vault: Pubkey,
        pub launch_ts: i64,
        pub snipe_shield_end_ts: i64,
        pub guard_end_ts: i64,
        pub max_wallet: u64,
        pub max_buy: u64,
        pub p2p_locked: bool,
        pub exempt: [Pubkey; MAX_EXEMPT],
        pub rules: &'a [u8],
    }

    /// Why a policy does not decode: Anchor's `AccountDiscriminatorNotFound`
    /// (shorter than 8 bytes), `AccountDiscriminatorMismatch` or
    /// `AccountDidNotDeserialize` (the fields).
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum PolicyError {
        DiscriminatorNotFound,
        DiscriminatorMismatch,
        DidNotDeserialize,
    }

    impl<'a> Policy<'a> {
        /// `HookPolicy::try_deserialize`: the discriminator, then the fields
        /// in Borsh (trailing bytes ignored).
        pub fn read(data: &'a [u8]) -> Result<Self, PolicyError> {
            let Some((discriminator, fields)) = data.split_first_chunk::<8>() else {
                return Err(PolicyError::DiscriminatorNotFound);
            };
            if *discriminator != HOOK_POLICY_DISCRIMINATOR {
                return Err(PolicyError::DiscriminatorMismatch);
            }
            Self::fields(&mut Reader::new(fields)).ok_or(PolicyError::DidNotDeserialize)
        }

        fn fields(r: &mut Reader<'a>) -> Option<Self> {
            Some(Self {
                version: r.u8()?,
                bump: r.u8()?,
                mint: r.address()?,
                pool: r.address()?,
                base_vault: r.address()?,
                launch_ts: r.i64()?,
                snipe_shield_end_ts: r.i64()?,
                guard_end_ts: r.i64()?,
                max_wallet: r.u64()?,
                max_buy: r.u64()?,
                p2p_locked: r.bool()?,
                exempt: [r.address()?, r.address()?, r.address()?, r.address()?],
                rules: r.bytes()?,
            })
        }
    }
}

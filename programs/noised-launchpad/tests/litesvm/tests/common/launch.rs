//! PDAs, parameters and instruction builders for the launchpad and for
//! direct DBC trades, written the way an off-chain client would.

use anchor_lang::{system_program, InstructionData, ToAccountMetas};
use anchor_spl::{
    associated_token::get_associated_token_address_with_program_id as ata,
    token_interface::spl_token_2022,
};
use noised_launchpad::{
    accounts as acc,
    constants::*,
    dynamic_bonding_curve::client::{accounts as dbc_acc, args as dbc_args},
    dynamic_bonding_curve::types::{
        AccountsType, RemainingAccountsSlice, SwapParameters2, TransferHookAccountsInfo,
    },
    instruction as ix,
    state::{BaseFeeParams, CurvePoint, DynamicFeeParams, FeeRecipient, LaunchParams},
};
use solana_instruction::{AccountMeta, Instruction};

use super::{Pubkey, ATA_PROGRAM_ID, LAMPORTS_PER_SOL, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID};

fn pda(seeds: &[&[u8]], program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(seeds, program).0
}

pub fn protocol() -> Pubkey {
    pda(&[PROTOCOL_SEED], &noised_launchpad::ID)
}

/// Every address of one launch.
#[derive(Clone, Copy, Debug)]
pub struct Keys {
    /// Who signs `create_launch`: part of the launch's address.
    pub creator: Pubkey,
    pub seed: [u8; 32],
    pub launch: Pubkey,
    pub launch_authority: Pubkey,
    pub batch_authority: Pubkey,
    pub dbc_config: Pubkey,
    pub mint: Pubkey,
    pub pool: Pubkey,
    pub base_vault: Pubkey,
    pub quote_vault: Pubkey,
    pub meta_list: Pubkey,
    pub policy: Pubkey,
    pub certificate: Pubkey,
    /// `["attestation", launch]`.
    pub attestation: Pubkey,
}

impl Keys {
    /// The launch `creator` creates under `seed` (`["launch", creator,
    /// seed]`), launched with the mint `mint`.
    pub fn new(creator: &Pubkey, seed: [u8; 32], mint: Pubkey) -> Self {
        let program = noised_launchpad::ID;
        let launch = pda(&[LAUNCH_SEED, creator.as_ref(), &seed], &program);
        let dbc_config = pda(&[DBC_CONFIG_SEED, launch.as_ref()], &program);
        let (hi, lo) = if mint > WSOL_MINT {
            (mint, WSOL_MINT)
        } else {
            (WSOL_MINT, mint)
        };
        let pool = pda(
            &[b"pool", dbc_config.as_ref(), hi.as_ref(), lo.as_ref()],
            &DBC_PROGRAM_ID,
        );
        Keys {
            creator: *creator,
            seed,
            launch,
            launch_authority: pda(&[AUTHORITY_SEED, launch.as_ref()], &program),
            batch_authority: pda(&[BATCH_SEED, launch.as_ref()], &program),
            dbc_config,
            mint,
            pool,
            base_vault: pda(
                &[b"token_vault", mint.as_ref(), pool.as_ref()],
                &DBC_PROGRAM_ID,
            ),
            quote_vault: pda(
                &[b"token_vault", WSOL_MINT.as_ref(), pool.as_ref()],
                &DBC_PROGRAM_ID,
            ),
            meta_list: pda(&[b"extra-account-metas", mint.as_ref()], &noised_hook::ID),
            policy: pda(&[b"policy", mint.as_ref()], &noised_hook::ID),
            certificate: pda(&[CERTIFICATE_SEED, mint.as_ref()], &program),
            attestation: pda(&[ATTESTATION_SEED, launch.as_ref()], &program),
        }
    }

    pub fn commit(&self, owner: &Pubkey) -> Pubkey {
        pda(
            &[COMMIT_SEED, self.launch.as_ref(), owner.as_ref()],
            &noised_launchpad::ID,
        )
    }

    /// `["payout-vault", launch, vault]`: what the commits naming `vault`
    /// as their token owner committed together.
    pub fn payout_vault(&self, vault: &Pubkey) -> Pubkey {
        pda(
            &[PAYOUT_VAULT_SEED, self.launch.as_ref(), vault.as_ref()],
            &noised_launchpad::ID,
        )
    }

    /// The accounts a transfer of the base mint needs while the hook is
    /// active, in the launchpad's canonical order: meta list, policy,
    /// instructions sysvar (the snipe shield reads it), hook program.
    pub fn hook_metas(&self) -> Vec<AccountMeta> {
        vec![
            AccountMeta::new_readonly(self.meta_list, false),
            AccountMeta::new_readonly(self.policy, false),
            AccountMeta::new_readonly(noised_hook::INSTRUCTIONS_SYSVAR_ID, false),
            AccountMeta::new_readonly(noised_hook::ID, false),
        ]
    }
}

pub fn wsol_ata(owner: &Pubkey) -> Pubkey {
    ata(owner, &WSOL_MINT, &TOKEN_PROGRAM_ID)
}

pub fn base_ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    ata(owner, mint, &TOKEN_2022_PROGRAM_ID)
}

fn q64(sqrt_price: f64) -> u128 {
    (sqrt_price * 2f64.powi(64)) as u128
}

/// A realistic launch: 6 decimals, opens at 1e-8 SOL per token, migrates at
/// 10 SOL raised (25x the opening price), 1% fee after a 10 s schedule,
/// 60 s commit window (the shortest), 1 h guard, named after the test
/// creator's post-quantum identity.
pub fn params(recipients: &[(Pubkey, u16)]) -> LaunchParams {
    let start = q64(1e-5f64.sqrt());
    let threshold = 10 * LAMPORTS_PER_SOL;
    // L = quote * 2^128 / (sqrt_migration - sqrt_start), migration at 5x sqrt price.
    let liquidity = (threshold as f64 * 2f64.powi(128) / (4.0 * start as f64)) as u128;
    LaunchParams {
        token_decimal: 6,
        sqrt_start_price: start,
        curve: vec![CurvePoint {
            sqrt_price: start * 10,
            liquidity,
        }],
        migration_quote_threshold: threshold,
        base_fee: BaseFeeParams {
            cliff_fee_numerator: 500_000_000,
            first_factor: 10,
            second_factor: 1,
            third_factor: 49_000_000,
            base_fee_mode: 0,
        },
        dynamic_fee: None,
        migration_fee_option: 2,
        open_delay_secs: MIN_OPEN_DELAY,
        guard_secs: 3_600,
        max_wallet_bps: 100,
        max_buy_bps: 50,
        p2p_locked: true,
        batch_wallet_cap: 0,
        batch_total_cap: 0,
        recipients: recipients
            .iter()
            .map(|(wallet, bps)| FeeRecipient {
                wallet: *wallet,
                bps: *bps,
            })
            .collect(),
        pq_identity: super::pq::identity_id(),
    }
}

/// The largest dynamic fee the policy accepts on top of the 1% floor of
/// `params()` (about 8.9%), reached with a ~0.4% sqrt-price move: the
/// creator's configuration in the round-1 auditors' PoC.
pub fn max_dynamic_fee() -> DynamicFeeParams {
    DynamicFeeParams {
        bin_step: dbc::DYNAMIC_BIN_STEP,
        bin_step_u128: dbc::DYNAMIC_BIN_STEP_U128,
        filter_period: 10,
        decay_period: 120,
        reduction_factor: 5_000,
        max_volatility_accumulator: 728_000,
        variable_fee_control: 16_777_215,
    }
}

/// `treasury` must be an opened PQ vault of wSOL.
pub fn initialize_protocol(
    authority: &Pubkey,
    treasury: Pubkey,
    platform_fee_bps: u16,
) -> Instruction {
    Instruction {
        program_id: noised_launchpad::ID,
        accounts: acc::InitializeProtocol {
            authority: *authority,
            protocol: protocol(),
            treasury,
            program: noised_launchpad::ID,
            program_data: super::Env::programdata(&noised_launchpad::ID),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: ix::InitializeProtocol { platform_fee_bps }.data(),
    }
}

pub fn create_launch(creator: &Pubkey, k: &Keys, params: LaunchParams) -> Instruction {
    Instruction {
        program_id: noised_launchpad::ID,
        accounts: acc::CreateLaunch {
            creator: *creator,
            protocol: protocol(),
            launch: k.launch,
            launch_authority: k.launch_authority,
            dbc_config: k.dbc_config,
            quote_mint: WSOL_MINT,
            hook_program: noised_hook::ID,
            dbc_program: DBC_PROGRAM_ID,
            dbc_event_authority: DBC_EVENT_AUTHORITY,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: ix::CreateLaunch {
            launch_seed: k.seed,
            params,
        }
        .data(),
    }
}

/// `launch`, paid by `payer` (anyone, inside the attested window), with the
/// metadata record of `(name, symbol, uri)` (see `pq::Meta`): the one a
/// client attested.
pub fn launch(payer: &Pubkey, k: &Keys, name: &str, symbol: &str, uri: &str) -> Instruction {
    launch_with_record(payer, k, super::pq::token_meta_of(k, (name, symbol, uri)))
}

/// `launch` naming `token_meta` as the metadata record (the program takes
/// the mint's metadata from it; it must be the one the attestation names),
/// without rules.
pub fn launch_with_record(payer: &Pubkey, k: &Keys, token_meta: Pubkey) -> Instruction {
    launch_with_accounts(payer, k, token_meta, None)
}

/// `launch` with the metadata record of `(name, symbol, uri)` and the rules
/// record of `rules_hash` (none for the zero hash): what a client reads from
/// the attestation.
pub fn launch_with_rules(
    payer: &Pubkey,
    k: &Keys,
    (name, symbol, uri): (&str, &str, &str),
    rules_hash: &[u8; 32],
) -> Instruction {
    launch_with_accounts(
        payer,
        k,
        super::pq::token_meta_of(k, (name, symbol, uri)),
        super::pq::rules_of(&k.launch, rules_hash),
    )
}

/// `launch` naming these records (`rules`: `None` passes the program id).
pub fn launch_with_accounts(
    payer: &Pubkey,
    k: &Keys,
    token_meta: Pubkey,
    rules: Option<Pubkey>,
) -> Instruction {
    Instruction {
        program_id: noised_launchpad::ID,
        accounts: acc::LaunchToken {
            payer: *payer,
            launch: k.launch,
            launch_authority: k.launch_authority,
            dbc_config: k.dbc_config,
            base_mint: k.mint,
            pool: k.pool,
            base_vault: k.base_vault,
            quote_vault: k.quote_vault,
            quote_mint: WSOL_MINT,
            dbc_pool_authority: DBC_POOL_AUTHORITY,
            hook_authority: hook_authority(),
            extra_account_meta_list: k.meta_list,
            policy: k.policy,
            certificate: k.certificate,
            hook_program: noised_hook::ID,
            dbc_program: DBC_PROGRAM_ID,
            dbc_event_authority: DBC_EVENT_AUTHORITY,
            token_2022_program: TOKEN_2022_PROGRAM_ID,
            token_program: TOKEN_PROGRAM_ID,
            system_program: system_program::ID,
            attestation: k.attestation,
            token_meta,
            rules,
        }
        .to_account_metas(None),
        data: ix::Launch {}.data(),
    }
}

/// The launchpad's `["hook-authority"]` PDA: the only signer the hook's
/// `create_policy` and `end_snipe_shield` accept.
pub fn hook_authority() -> Pubkey {
    pda(&[HOOK_AUTHORITY_SEED], &noised_launchpad::ID)
}

/// A commit whose payouts go to the committer itself.
pub fn commit(owner: &Pubkey, k: &Keys, amount: u64) -> Instruction {
    commit_to(owner, k, amount, owner, owner)
}

/// A commit naming its payout owners: `token_owner` receives the tokens,
/// `refund_owner` the wSOL refund (the committer, or PQ vaults). A vault as
/// token owner comes with its `["payout-vault", launch, vault]` account.
pub fn commit_to(
    owner: &Pubkey,
    k: &Keys,
    amount: u64,
    token_owner: &Pubkey,
    refund_owner: &Pubkey,
) -> Instruction {
    Instruction {
        program_id: noised_launchpad::ID,
        accounts: acc::CommitToBatch {
            owner: *owner,
            launch: k.launch,
            commit: k.commit(owner),
            batch_authority: k.batch_authority,
            quote_mint: WSOL_MINT,
            owner_quote_account: wsol_ata(owner),
            batch_quote_escrow: wsol_ata(&k.batch_authority),
            token_program: TOKEN_PROGRAM_ID,
            associated_token_program: ATA_PROGRAM_ID,
            system_program: system_program::ID,
            token_owner: *token_owner,
            refund_owner: *refund_owner,
            payout_vault: (token_owner != owner).then(|| k.payout_vault(token_owner)),
        }
        .to_account_metas(None),
        data: ix::Commit { amount }.data(),
    }
}

pub fn execute_batch(payer: &Pubkey, k: &Keys) -> Instruction {
    execute_batch_with(payer, k, |_| {})
}

/// `execute_batch` with its named accounts adjusted by `tweak` (the four
/// hook accounts of the swap follow them unchanged).
pub fn execute_batch_with(
    payer: &Pubkey,
    k: &Keys,
    tweak: impl FnOnce(&mut acc::ExecuteBatch),
) -> Instruction {
    let mut named = acc::ExecuteBatch {
        payer: *payer,
        launch: k.launch,
        batch_authority: k.batch_authority,
        dbc_config: k.dbc_config,
        pool: k.pool,
        base_vault: k.base_vault,
        quote_vault: k.quote_vault,
        base_mint: k.mint,
        quote_mint: WSOL_MINT,
        batch_quote_escrow: wsol_ata(&k.batch_authority),
        batch_base_escrow: base_ata(&k.batch_authority, &k.mint),
        dbc_pool_authority: DBC_POOL_AUTHORITY,
        dbc_program: DBC_PROGRAM_ID,
        dbc_event_authority: DBC_EVENT_AUTHORITY,
        token_program: TOKEN_PROGRAM_ID,
        token_2022_program: TOKEN_2022_PROGRAM_ID,
        associated_token_program: ATA_PROGRAM_ID,
        system_program: system_program::ID,
        // Once the batch has bought it ends the snipe shield
        // (`noised_hook::end_snipe_shield`, signed by the hook authority);
        // the policy is writable in the transaction.
        hook_authority: hook_authority(),
        policy: k.policy,
        hook_program: noised_hook::ID,
    };
    tweak(&mut named);
    let mut accounts = named.to_account_metas(None);
    accounts.extend(k.hook_metas());
    Instruction {
        program_id: noised_launchpad::ID,
        accounts,
        data: ix::ExecuteBatch {}.data(),
    }
}

/// The hook's `end_snipe_shield` called directly (not through
/// `execute_batch`), with `authority` in the launchpad-authority slot,
/// marked as a signer only if `signs`.
pub fn end_snipe_shield(authority: &Pubkey, signs: bool, policy: &Pubkey) -> Instruction {
    let mut accounts = noised_hook::accounts::EndSnipeShield {
        launchpad_authority: *authority,
        policy: *policy,
        instructions: noised_hook::INSTRUCTIONS_SYSVAR_ID,
    }
    .to_account_metas(None);
    accounts[0].is_signer = signs;
    Instruction {
        program_id: noised_hook::ID,
        accounts,
        data: noised_hook::instruction::EndSnipeShield {}.data(),
    }
}

/// `claim` of a commit whose payouts go to the committer itself.
/// `executed`: pass the base accounts and hook accounts (tokens are paid).
pub fn claim(
    payer: &Pubkey,
    k: &Keys,
    owner: &Pubkey,
    executed: bool,
    hook_active: bool,
) -> Instruction {
    claim_for(payer, k, owner, (owner, owner), executed, hook_active)
}

/// `claim` of `owner`'s commit paying its recorded payout owners
/// `(token_owner, refund_owner)` at their canonical ATAs.
pub fn claim_for(
    payer: &Pubkey,
    k: &Keys,
    owner: &Pubkey,
    (token_owner, refund_owner): (&Pubkey, &Pubkey),
    executed: bool,
    hook_active: bool,
) -> Instruction {
    let base = executed.then(|| base_ata(token_owner, &k.mint));
    claim_slots(
        payer,
        k,
        owner,
        (token_owner, refund_owner),
        Some(wsol_ata(refund_owner)),
        base,
        base.map(|_| base_ata(&k.batch_authority, &k.mint)),
        executed && hook_active,
    )
}

/// `claim` of a commit paying the committer, with explicit destinations:
/// `quote` and `base` go in the refund-owner wSOL / token-owner base-token
/// ATA slots (`None` omits the slot; the base escrow is passed with
/// `base`). Hook accounts are added when `base` is paid while the hook is
/// active.
pub fn claim_into(
    payer: &Pubkey,
    k: &Keys,
    owner: &Pubkey,
    quote: Option<Pubkey>,
    base: Option<Pubkey>,
    hook_active: bool,
) -> Instruction {
    let escrow = base.map(|_| base_ata(&k.batch_authority, &k.mint));
    claim_slots(
        payer,
        k,
        owner,
        (owner, owner),
        quote,
        base,
        escrow,
        base.is_some() && hook_active,
    )
}

/// `claim` with every slot chosen independently: the payout owners
/// `(token_owner, refund_owner)`, the refund owner's wSOL ATA (`quote`), the
/// token owner's base-token ATA (`base`) and the batch base escrow
/// (`escrow`); `None` omits a slot. `hook` appends the hook accounts.
#[allow(clippy::too_many_arguments)]
pub fn claim_slots(
    payer: &Pubkey,
    k: &Keys,
    owner: &Pubkey,
    (token_owner, refund_owner): (&Pubkey, &Pubkey),
    quote: Option<Pubkey>,
    base: Option<Pubkey>,
    escrow: Option<Pubkey>,
    hook: bool,
) -> Instruction {
    let mut accounts = acc::Claim {
        payer: *payer,
        launch: k.launch,
        commit: k.commit(owner),
        token_owner: *token_owner,
        refund_owner: *refund_owner,
        batch_authority: k.batch_authority,
        base_mint: k.mint,
        quote_mint: WSOL_MINT,
        batch_quote_escrow: wsol_ata(&k.batch_authority),
        batch_base_escrow: escrow,
        refund_owner_ata: quote,
        token_owner_ata: base,
        token_program: TOKEN_PROGRAM_ID,
        token_2022_program: TOKEN_2022_PROGRAM_ID,
        associated_token_program: ATA_PROGRAM_ID,
        system_program: system_program::ID,
    }
    .to_account_metas(None);
    if hook {
        accounts.extend(k.hook_metas());
    }
    Instruction {
        program_id: noised_launchpad::ID,
        accounts,
        data: ix::Claim { owner: *owner }.data(),
    }
}

pub fn claim_fees(payer: &Pubkey, k: &Keys) -> Instruction {
    Instruction {
        program_id: noised_launchpad::ID,
        accounts: acc::ClaimFees {
            payer: *payer,
            launch: k.launch,
            launch_authority: k.launch_authority,
            dbc_config: k.dbc_config,
            pool: k.pool,
            base_vault: k.base_vault,
            quote_vault: k.quote_vault,
            base_mint: k.mint,
            quote_mint: WSOL_MINT,
            authority_base_ata: base_ata(&k.launch_authority, &k.mint),
            authority_quote_ata: wsol_ata(&k.launch_authority),
            dbc_pool_authority: DBC_POOL_AUTHORITY,
            dbc_program: DBC_PROGRAM_ID,
            dbc_event_authority: DBC_EVENT_AUTHORITY,
            token_program: TOKEN_PROGRAM_ID,
            token_2022_program: TOKEN_2022_PROGRAM_ID,
            associated_token_program: ATA_PROGRAM_ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: ix::ClaimFees {}.data(),
    }
}

pub fn distribute(
    payer: &Pubkey,
    k: &Keys,
    treasury: &Pubkey,
    recipients: &[Pubkey],
) -> Instruction {
    let mut accounts = acc::Distribute {
        payer: *payer,
        launch: k.launch,
        launch_authority: k.launch_authority,
        treasury: *treasury,
        base_mint: k.mint,
        quote_mint: WSOL_MINT,
        authority_quote_ata: wsol_ata(&k.launch_authority),
        authority_base_ata: base_ata(&k.launch_authority, &k.mint),
        treasury_quote_ata: wsol_ata(treasury),
        token_program: TOKEN_PROGRAM_ID,
        token_2022_program: TOKEN_2022_PROGRAM_ID,
        associated_token_program: ATA_PROGRAM_ID,
        system_program: system_program::ID,
    }
    .to_account_metas(None);
    for r in recipients {
        accounts.push(AccountMeta::new_readonly(*r, false));
        accounts.push(AccountMeta::new(wsol_ata(r), false));
    }
    Instruction {
        program_id: noised_launchpad::ID,
        accounts,
        data: ix::Distribute {}.data(),
    }
}

/// A direct DBC exact-in trade by `trader` (buy: wSOL -> base, sell: base ->
/// wSOL), with the hook accounts a client resolves for the base mint.
pub fn dbc_swap(trader: &Pubkey, k: &Keys, buy: bool, amount_in: u64) -> Instruction {
    dbc_swap_mode(trader, k, buy, amount_in, 0, true)
}

/// `swap_mode`: 0 exact-in, 1 partial fill. `hook`: pass the hook accounts
/// (DBC refuses them once the hook is revoked).
pub fn dbc_swap_mode(
    trader: &Pubkey,
    k: &Keys,
    buy: bool,
    amount_in: u64,
    swap_mode: u8,
    hook: bool,
) -> Instruction {
    let (input, output) = if buy {
        (wsol_ata(trader), base_ata(trader, &k.mint))
    } else {
        (base_ata(trader, &k.mint), wsol_ata(trader))
    };
    dbc_swap_accounts(trader, k, input, output, amount_in, swap_mode, hook)
}

/// A direct DBC exact-in buy paid from `trader`'s wSOL ATA whose tokens go
/// to any base-token account `output` (not necessarily the trader's).
pub fn dbc_buy_into(trader: &Pubkey, k: &Keys, output: Pubkey, amount_in: u64) -> Instruction {
    dbc_swap_accounts(trader, k, wsol_ata(trader), output, amount_in, 0, true)
}

/// A direct DBC exact-out buy (`swap_mode` 2) by `trader` of exactly
/// `tokens` into its base-token ATA, paying at most `max_in` wSOL.
pub fn dbc_buy_exact_out(trader: &Pubkey, k: &Keys, tokens: u64, max_in: u64) -> Instruction {
    let mut ix = dbc_swap_accounts(
        trader,
        k,
        wsol_ata(trader),
        base_ata(trader, &k.mint),
        tokens,
        2,
        true,
    );
    let mut data = ix.data[..8].to_vec();
    data.extend_from_slice(&tokens.to_le_bytes());
    data.extend_from_slice(&max_in.to_le_bytes());
    data.extend_from_slice(&ix.data[24..]);
    ix.data = data;
    ix
}

fn dbc_swap_accounts(
    trader: &Pubkey,
    k: &Keys,
    input: Pubkey,
    output: Pubkey,
    amount_in: u64,
    swap_mode: u8,
    hook: bool,
) -> Instruction {
    let mut accounts = dbc_acc::Swap2WithTransferHook {
        pool_authority: DBC_POOL_AUTHORITY,
        config: k.dbc_config,
        pool: k.pool,
        input_token_account: input,
        output_token_account: output,
        base_vault: k.base_vault,
        quote_vault: k.quote_vault,
        base_mint: k.mint,
        quote_mint: WSOL_MINT,
        payer: *trader,
        token_base_program: TOKEN_2022_PROGRAM_ID,
        token_quote_program: TOKEN_PROGRAM_ID,
        referral_token_account: None,
        event_authority: DBC_EVENT_AUTHORITY,
        program: DBC_PROGRAM_ID,
    }
    .to_account_metas(None);
    let slices = if hook {
        let hook_metas = k.hook_metas();
        let length = hook_metas.len() as u8;
        accounts.extend(hook_metas);
        vec![RemainingAccountsSlice {
            accounts_type: AccountsType::TransferHookBase,
            length,
        }]
    } else {
        vec![]
    };
    Instruction {
        program_id: DBC_PROGRAM_ID,
        accounts,
        data: dbc_args::Swap2WithTransferHook {
            params: SwapParameters2 {
                amount_0: amount_in,
                amount_1: 0,
                swap_mode,
            },
            transfer_hook_accounts_info: TransferHookAccountsInfo { slices },
        }
        .data(),
    }
}

/// Token-2022 `transfer_checked` of the base token from `from`'s ATA to
/// `to`'s (signed by `from`), with the hook accounts a wallet would add
/// (spl-transfer-hook-interface's offchain order: the resolved extra metas,
/// then the hook program, then the meta list).
pub fn hooked_transfer(k: &Keys, from: &Pubkey, to: &Pubkey, amount: u64) -> Instruction {
    let mut ix = spl_token_2022::instruction::transfer_checked(
        &TOKEN_2022_PROGRAM_ID,
        &base_ata(from, &k.mint),
        &k.mint,
        &base_ata(to, &k.mint),
        from,
        &[],
        amount,
        6,
    )
    .unwrap();
    ix.accounts.push(AccountMeta::new_readonly(k.policy, false));
    ix.accounts.push(AccountMeta::new_readonly(
        noised_hook::INSTRUCTIONS_SYSVAR_ID,
        false,
    ));
    ix.accounts
        .push(AccountMeta::new_readonly(noised_hook::ID, false));
    ix.accounts
        .push(AccountMeta::new_readonly(k.meta_list, false));
    Instruction {
        program_id: ix.program_id,
        accounts: ix.accounts,
        data: ix.data,
    }
}

/// Create `owner`'s ATA (idempotent).
pub fn create_ata(
    payer: &Pubkey,
    owner: &Pubkey,
    mint: &Pubkey,
    token_program: &Pubkey,
) -> Instruction {
    let ix = anchor_spl::associated_token::spl_associated_token_account::instruction::create_associated_token_account_idempotent(
        payer, owner, mint, token_program,
    );
    Instruction {
        program_id: ix.program_id,
        accounts: ix.accounts,
        data: ix.data,
    }
}

/// Wrap `lamports` into `owner`'s wSOL ATA (create, transfer, sync).
pub fn wrap_sol(owner: &Pubkey, lamports: u64) -> Vec<Instruction> {
    let ata = wsol_ata(owner);
    let mut transfer_data = vec![2, 0, 0, 0];
    transfer_data.extend_from_slice(&lamports.to_le_bytes());
    vec![
        create_ata(owner, owner, &WSOL_MINT, &TOKEN_PROGRAM_ID),
        Instruction {
            program_id: system_program::ID,
            accounts: vec![AccountMeta::new(*owner, true), AccountMeta::new(ata, false)],
            data: transfer_data,
        },
        Instruction {
            program_id: TOKEN_PROGRAM_ID,
            accounts: vec![AccountMeta::new(ata, false)],
            // SPL Token SyncNative.
            data: vec![17],
        },
    ]
}

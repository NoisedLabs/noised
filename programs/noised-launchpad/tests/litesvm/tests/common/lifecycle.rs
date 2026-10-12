//! Builders for the post-curve part of a launch: surplus, DBC migration to
//! DAMM v2, DAMM v2 trades and LP fee claims.

use anchor_lang::{system_program, InstructionData, ToAccountMetas};
use noised_launchpad::{
    accounts as acc,
    constants::*,
    cp_amm::{
        client::{accounts as amm_acc, args as amm_args},
        types::SwapParameters,
    },
    dynamic_bonding_curve::client::{accounts as dbc_acc, args as dbc_args},
    instruction as ix,
};
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;

use super::{
    fixture,
    launch::{base_ata, wsol_ata, Keys},
    Env, Expect, Pubkey, Sent, ATA_PROGRAM_ID, LAMPORTS_PER_SOL, TOKEN_2022_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
};

/// Mainnet DAMM v2 config DBC migrates `migration_fee_option` 2 (1%) pools with.
pub const DAMM_CONFIG_FEE_OPTION_2: &str = "Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp";

fn pda(seeds: &[&[u8]], program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(seeds, program).0
}

pub fn claim_surplus(payer: &Pubkey, k: &Keys) -> Instruction {
    Instruction {
        program_id: noised_launchpad::ID,
        accounts: acc::ClaimSurplus {
            payer: *payer,
            launch: k.launch,
            launch_authority: k.launch_authority,
            dbc_config: k.dbc_config,
            pool: k.pool,
            quote_vault: k.quote_vault,
            quote_mint: WSOL_MINT,
            authority_quote_ata: wsol_ata(&k.launch_authority),
            dbc_pool_authority: DBC_POOL_AUTHORITY,
            dbc_program: DBC_PROGRAM_ID,
            dbc_event_authority: DBC_EVENT_AUTHORITY,
            token_program: TOKEN_PROGRAM_ID,
            associated_token_program: ATA_PROGRAM_ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: ix::ClaimSurplus {}.data(),
    }
}

/// The DAMM v2 pool DBC creates at migration with `config`.
#[derive(Clone, Copy, Debug)]
pub struct Damm {
    pub config: Pubkey,
    pub pool: Pubkey,
    pub token_a_vault: Pubkey,
    pub token_b_vault: Pubkey,
}

impl Damm {
    pub fn new(k: &Keys, config: Pubkey) -> Self {
        let (hi, lo) = if k.mint > WSOL_MINT {
            (k.mint, WSOL_MINT)
        } else {
            (WSOL_MINT, k.mint)
        };
        let pool = pda(
            &[b"pool", config.as_ref(), hi.as_ref(), lo.as_ref()],
            &DAMM_V2_PROGRAM_ID,
        );
        Damm {
            config,
            pool,
            token_a_vault: pda(
                &[b"token_vault", k.mint.as_ref(), pool.as_ref()],
                &DAMM_V2_PROGRAM_ID,
            ),
            token_b_vault: pda(
                &[b"token_vault", WSOL_MINT.as_ref(), pool.as_ref()],
                &DAMM_V2_PROGRAM_ID,
            ),
        }
    }

    pub fn position(nft_mint: &Pubkey) -> Pubkey {
        pda(&[b"position", nft_mint.as_ref()], &DAMM_V2_PROGRAM_ID)
    }

    pub fn nft_account(nft_mint: &Pubkey) -> Pubkey {
        pda(
            &[b"position_nft_account", nft_mint.as_ref()],
            &DAMM_V2_PROGRAM_ID,
        )
    }
}

/// DBC `migration_damm_v2` (permissionless), offering both position slots.
pub fn migrate(
    payer: &Pubkey,
    k: &Keys,
    d: &Damm,
    first_nft: &Pubkey,
    second_nft: &Pubkey,
) -> Instruction {
    let mut accounts = dbc_acc::MigrationDammV2 {
        virtual_pool: k.pool,
        migration_metadata: DBC_PROGRAM_ID,
        config: k.dbc_config,
        pool_authority: DBC_POOL_AUTHORITY,
        pool: d.pool,
        first_position_nft_mint: *first_nft,
        first_position_nft_account: Damm::nft_account(first_nft),
        first_position: Damm::position(first_nft),
        second_position_nft_mint: Some(*second_nft),
        second_position_nft_account: Some(Damm::nft_account(second_nft)),
        second_position: Some(Damm::position(second_nft)),
        damm_pool_authority: DAMM_V2_POOL_AUTHORITY,
        amm_program: DAMM_V2_PROGRAM_ID,
        base_mint: k.mint,
        quote_mint: WSOL_MINT,
        token_a_vault: d.token_a_vault,
        token_b_vault: d.token_b_vault,
        base_vault: k.base_vault,
        quote_vault: k.quote_vault,
        payer: *payer,
        token_base_program: TOKEN_2022_PROGRAM_ID,
        token_quote_program: TOKEN_PROGRAM_ID,
        token_2022_program: TOKEN_2022_PROGRAM_ID,
        damm_event_authority: DAMM_V2_EVENT_AUTHORITY,
        system_program: system_program::ID,
    }
    .to_account_metas(None);
    accounts.push(AccountMeta::new_readonly(d.config, false));
    Instruction {
        program_id: DBC_PROGRAM_ID,
        accounts,
        data: dbc_args::MigrationDammV2 {}.data(),
    }
}

/// Migrate a completed curve to DAMM v2, as anyone can: fund DBC's pool
/// authority (DBC lends rent from it during migration, "flash rent"; on
/// mainnet that PDA holds the float, here it starts empty), load mainnet's
/// DAMM v2 config for fee option 2 and send `migration_damm_v2` offering both
/// position slots. Returns the DAMM v2 pool, the two position NFT mints and
/// the migration transaction.
pub fn migrate_to_damm_v2(env: &mut Env, k: &Keys) -> (Damm, [Pubkey; 2], Sent) {
    env.airdrop(&DBC_POOL_AUTHORITY, 2 * LAMPORTS_PER_SOL);
    let config = env.load_account_json(&fixture(&format!(
        "accounts/{DAMM_CONFIG_FEE_OPTION_2}.json"
    )));
    let d = Damm::new(k, config);
    let (nft1, nft2) = (Keypair::new(), Keypair::new());
    let payer = env.payer.pubkey();
    let sent = env
        .send_large(
            &[migrate(&payer, k, &d, &nft1.pubkey(), &nft2.pubkey())],
            &[&nft1, &nft2],
        )
        .expect_ok("migration_damm_v2");
    (d, [nft1.pubkey(), nft2.pubkey()], sent)
}

/// A DAMM v2 exact-in trade by `trader` (sell: base -> wSOL).
pub fn damm_swap(trader: &Pubkey, k: &Keys, d: &Damm, sell: bool, amount_in: u64) -> Instruction {
    let (input, output) = if sell {
        (base_ata(trader, &k.mint), wsol_ata(trader))
    } else {
        (wsol_ata(trader), base_ata(trader, &k.mint))
    };
    damm_swap_accounts(trader, k, d, input, output, amount_in)
}

/// A DAMM v2 exact-in buy paid from `trader`'s wSOL ATA whose tokens go to
/// any base-token account `output` (not necessarily the trader's).
pub fn damm_buy_into(
    trader: &Pubkey,
    k: &Keys,
    d: &Damm,
    output: Pubkey,
    amount_in: u64,
) -> Instruction {
    damm_swap_accounts(trader, k, d, wsol_ata(trader), output, amount_in)
}

fn damm_swap_accounts(
    trader: &Pubkey,
    k: &Keys,
    d: &Damm,
    input: Pubkey,
    output: Pubkey,
    amount_in: u64,
) -> Instruction {
    Instruction {
        program_id: DAMM_V2_PROGRAM_ID,
        accounts: amm_acc::Swap {
            pool_authority: DAMM_V2_POOL_AUTHORITY,
            pool: d.pool,
            input_token_account: input,
            output_token_account: output,
            token_a_vault: d.token_a_vault,
            token_b_vault: d.token_b_vault,
            token_a_mint: k.mint,
            token_b_mint: WSOL_MINT,
            payer: *trader,
            token_a_program: TOKEN_2022_PROGRAM_ID,
            token_b_program: TOKEN_PROGRAM_ID,
            referral_token_account: None,
            event_authority: DAMM_V2_EVENT_AUTHORITY,
            program: DAMM_V2_PROGRAM_ID,
        }
        .to_account_metas(None),
        data: amm_args::Swap {
            _params: SwapParameters {
                amount_in,
                minimum_amount_out: 0,
            },
        }
        .data(),
    }
}

pub fn claim_lp_fees(payer: &Pubkey, k: &Keys, d: &Damm, nft_mint: &Pubkey) -> Instruction {
    Instruction {
        program_id: noised_launchpad::ID,
        accounts: acc::ClaimLpFees {
            payer: *payer,
            launch: k.launch,
            launch_authority: k.launch_authority,
            damm_pool: d.pool,
            position: Damm::position(nft_mint),
            position_nft_account: Damm::nft_account(nft_mint),
            token_a_vault: d.token_a_vault,
            token_b_vault: d.token_b_vault,
            base_mint: k.mint,
            quote_mint: WSOL_MINT,
            authority_base_ata: base_ata(&k.launch_authority, &k.mint),
            authority_quote_ata: wsol_ata(&k.launch_authority),
            damm_pool_authority: DAMM_V2_POOL_AUTHORITY,
            damm_program: DAMM_V2_PROGRAM_ID,
            damm_event_authority: DAMM_V2_EVENT_AUTHORITY,
            token_program: TOKEN_PROGRAM_ID,
            token_2022_program: TOKEN_2022_PROGRAM_ID,
            associated_token_program: ATA_PROGRAM_ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: ix::ClaimLpFees {}.data(),
    }
}

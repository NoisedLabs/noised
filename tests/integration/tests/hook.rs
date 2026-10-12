//! Launch Guard transfer hook (`noised_hook`) under the mainnet Token-2022.
//!
//! Most policies are written straight into their PDA (Anchor discriminator +
//! borsh) because only the launchpad's PDA can sign `create_policy`. The
//! pool's base vault is then an ATA of a stand-in "pool authority" keypair:
//! the hook only compares account keys with `policy.base_vault`. One test
//! goes through `create_policy` itself and guards DBC's real base-vault
//! address.
//!
//! During the snipe shield the only buy that passes is the one made inside
//! the launchpad's top-level `execute_batch` instruction, which the hook
//! reads from the instructions sysvar, whatever its amount (zero included).
//! Those tests move the tokens from inside a top-level instruction of
//! `common::relay` (a native stand-in registered at the launchpad's program
//! id or at an impostor's). One test calls the hook's `execute` directly,
//! for the input Token-2022 never sends it: a transfer from the base vault
//! into itself.
//!
//! The PDA signatures only the launchpad (`hook-authority`, for
//! `create_policy` and `end_snipe_shield`) or DBC (its pool authority) can
//! produce come from relays registered at those program ids, which sign
//! with the PDA's seeds: the runtime derives the PDA from the seeds and the
//! relay's program id, as for `invoke_signed`, and every signature in the
//! transaction is verified. Keypairs sign wherever a real signer can.

mod common;

use anchor_lang::{error::ErrorCode as AnchorError, prelude::AccountMeta, Space};
use anchor_spl::token_2022::spl_token_2022::{
    error::TokenError,
    extension::{transfer_hook::TransferHook, BaseStateWithExtensionsMut, StateWithExtensionsMut},
    state::Mint,
};
use common::{
    anchor_discriminator,
    hook::{
        as_hook_authority_cpi, create_policy_ix, dbc_base_vault, end_snipe_shield_ix, execute_ix,
        expected_meta_list_data, hook_authority, hook_authority_of, init_meta_list_ix,
        meta_list_pda, policy_pda, PolicySpec, HOOK_ID, INSTRUCTIONS_SYSVAR_ID,
    },
    relay::{relay_ix, relay_noop_ix, relay_signed_ix},
    svm::{anchor_events, invocations_cu, program_cu, report, Sent, TxExpect, TxResult},
    Harness, Instruction, Keypair, Pubkey, Signer, DBC_POOL_AUTHORITY, DBC_PROGRAM_ID,
    LAUNCHPAD_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
};
use noised_hook::{
    state::{HookPolicy, PolicyParams, HOOK_AUTHORITY_SEED},
    HookError, EXECUTE_BATCH_DISCRIMINATOR,
};
use solana_account::Account;
use solana_instruction::error::InstructionError;
use spl_tlv_account_resolution::{error::AccountResolutionError, seeds::Seed};
use spl_transfer_hook_interface::instruction::TransferHookInstruction;

const DECIMALS: u8 = 6;
/// 1B tokens with 6 decimals, all in the pool's base vault at launch.
const SUPPLY: u64 = 1_000_000_000_000_000;
const MAX_WALLET: u64 = SUPPLY / 100; // 1%
const MAX_BUY: u64 = SUPPLY / 200; // 0.5%
/// The shortest commit window the launchpad allows (`MIN_OPEN_DELAY`).
const COMMIT_SECS: i64 = 60;
/// The shortest snipe shield the launchpad writes: the commit window plus
/// the execution window (`EXECUTION_GRACE_SECS`, 600 s). The batch usually
/// executes long before that end, and `end_snipe_shield` then ends the
/// shield at once.
const SHIELD_SECS: i64 = COMMIT_SECS + 600;
const GUARD_SECS: i64 = 3_600;

/// A launched hooked mint: policy in place, supply in the base vault.
struct Launch {
    h: Harness,
    mint: Pubkey,
    launch_ts: i64,
    /// Owner of the base vault (the DBC pool authority in production).
    pool_authority: Keypair,
    base_vault: Pubkey,
    /// Exempt owners (the launchpad's batch and launch authorities in production).
    batch: Keypair,
    batch_ata: Pubkey,
    launch_authority_ata: Pubkey,
    alice: Keypair,
    alice_ata: Pubkey,
    bob_ata: Pubkey,
}

impl Launch {
    fn new(p2p_locked: bool) -> Self {
        let mut h = Harness::new();
        let mint = h.create_mint(TOKEN_2022_PROGRAM_ID, DECIMALS, Some(HOOK_ID));
        h.init_meta_list(&mint);
        let pool_authority = h.funded_keypair(1);
        let base_vault = h.create_ata(&pool_authority.pubkey(), &mint);
        h.mint_to(&mint, &base_vault, SUPPLY);
        let batch = h.funded_keypair(1);
        let batch_ata = h.create_ata(&batch.pubkey(), &mint);
        let launch_authority = Keypair::new();
        let launch_authority_ata = h.create_ata(&launch_authority.pubkey(), &mint);
        let alice = h.funded_keypair(1);
        let alice_ata = h.create_ata(&alice.pubkey(), &mint);
        let bob = h.funded_keypair(1);
        let bob_ata = h.create_ata(&bob.pubkey(), &mint);
        let launch_ts = h.now();
        h.inject_policy(
            &PolicySpec {
                mint,
                pool: Pubkey::new_unique(),
                base_vault,
                launch_ts,
                shield_secs: SHIELD_SECS,
                guard_secs: GUARD_SECS,
                max_wallet: MAX_WALLET,
                max_buy: MAX_BUY,
                p2p_locked,
                exempt: vec![batch.pubkey(), launch_authority.pubkey()],
                rules: vec![],
            }
            .to_policy(),
        );
        Self {
            h,
            mint,
            launch_ts,
            pool_authority,
            base_vault,
            batch,
            batch_ata,
            launch_authority_ata,
            alice,
            alice_ata,
            bob_ata,
        }
    }

    fn at(&mut self, secs_after_launch: i64) {
        self.h.set_time(self.launch_ts + secs_after_launch);
    }

    /// Transfer out of the base vault: a buy.
    fn buy(&mut self, to: &Pubkey, amount: u64) -> TxResult {
        let (mint, from) = (self.mint, self.base_vault);
        self.h
            .transfer(&mint, &from, to, &self.pool_authority, amount)
    }

    /// Transfer into the base vault: a sell.
    fn sell(&mut self, owner: &Keypair, from: &Pubkey, amount: u64) -> TxResult {
        let (mint, to) = (self.mint, self.base_vault);
        self.h.transfer(&mint, from, &to, owner, amount)
    }

    fn send(&mut self, owner: &Keypair, from: &Pubkey, to: &Pubkey, amount: u64) -> TxResult {
        let mint = self.mint;
        self.h.transfer(&mint, from, to, owner, amount)
    }

    /// Fund a wallet without running the hook (only possible in tests:
    /// launched mints have no mint authority).
    fn fund(&mut self, to: &Pubkey, amount: u64) {
        let mint = self.mint;
        self.h.mint_to(&mint, to, amount);
    }

    fn bal(&self, account: &Pubkey) -> u64 {
        self.h.balance(account)
    }
}

#[test]
fn meta_list_init_is_permissionless_and_deterministic() {
    let mut h = Harness::new();
    let mint = h.create_mint(TOKEN_2022_PROGRAM_ID, DECIMALS, Some(HOOK_ID));

    // A stranger with no relation to the mint initializes it.
    let stranger = h.funded_keypair(1);
    let ix = init_meta_list_ix(&stranger.pubkey(), &mint);
    h.send(&[ix], &[&stranger])
        .expect_ok("stranger initializes the meta list");

    let list = meta_list_pda(&mint);
    assert_eq!(
        list,
        spl_transfer_hook_interface::get_extra_account_metas_address(&mint, &HOOK_ID)
    );
    let account = h.account(&list).expect("meta list exists");
    assert_eq!(account.owner, HOOK_ID);
    assert_eq!(account.lamports, h.rent_exempt(account.data.len()));
    assert_eq!(
        account.data,
        expected_meta_list_data(),
        "exactly two entries: PDA [\"policy\", mint], then the instructions sysvar"
    );
    let execute = TransferHookInstruction::Execute { amount: 0 }.pack();
    assert_eq!(
        account.data[..8],
        execute[..8],
        "TLV type is the Execute discriminator"
    );
    assert_eq!(
        account.data[16], 1,
        "first entry is a PDA of the hook program"
    );
    let config: [u8; 32] = account.data[17..49].try_into().unwrap();
    assert_eq!(
        Seed::unpack_address_config(&config).unwrap(),
        vec![
            Seed::Literal {
                bytes: b"policy".to_vec()
            },
            Seed::AccountKey { index: 1 }
        ]
    );
    assert_eq!(account.data[51], 0, "second entry is a fixed address");
    assert_eq!(
        account.data[52..84],
        noised_hook::INSTRUCTIONS_SYSVAR_ID.to_bytes()
    );
    assert_eq!(INSTRUCTIONS_SYSVAR_ID, noised_hook::INSTRUCTIONS_SYSVAR_ID);
    // What a client resolves from it: the mint's policy PDA and the
    // instructions sysvar, both read-only.
    let (alice, bob) = (Pubkey::new_unique(), Pubkey::new_unique());
    let extra = h.hook_extra_metas(&mint, &alice, &bob, &alice, 1);
    assert_eq!(
        extra,
        vec![
            AccountMeta::new_readonly(policy_pda(&mint).0, false),
            AccountMeta::new_readonly(INSTRUCTIONS_SYSVAR_ID, false),
            AccountMeta::new_readonly(HOOK_ID, false),
            AccountMeta::new_readonly(list, false),
        ]
    );

    // Written once: nobody (not even the mint authority) can re-initialize it.
    let payer = h.payer.pubkey();
    let f = h
        .send(&[init_meta_list_ix(&payer, &mint)], &[])
        .expect_custom(0u32, "re-initialize");
    assert!(f.logs_contain("already in use"));
    assert_eq!(h.account(&list).unwrap().data, expected_meta_list_data());

    // Deterministic: another mint and payer get the same contents.
    let other = h.create_mint(TOKEN_2022_PROGRAM_ID, 9, Some(HOOK_ID));
    let payer2 = h.funded_keypair(1);
    h.send(&[init_meta_list_ix(&payer2.pubkey(), &other)], &[&payer2])
        .expect_ok("second mint");
    assert_eq!(
        h.account(&meta_list_pda(&other)).unwrap().data,
        expected_meta_list_data()
    );

    // Only for mints whose transfer hook is this program.
    let no_hook = h.create_mint(TOKEN_2022_PROGRAM_ID, DECIMALS, None);
    let foreign_hook = h.create_mint(TOKEN_2022_PROGRAM_ID, DECIMALS, Some(Pubkey::new_unique()));
    let classic = h.create_mint(TOKEN_PROGRAM_ID, DECIMALS, None);
    for (what, m) in [
        ("no hook", no_hook),
        ("foreign hook", foreign_hook),
        ("SPL Token mint", classic),
    ] {
        h.send(&[init_meta_list_ix(&payer, &m)], &[])
            .expect_error(HookError::WrongHookProgram, what);
        assert!(h.account(&meta_list_pda(&m)).is_none(), "{what}");
    }
}

#[test]
fn create_policy_only_accepts_the_launchpad_pda() {
    let mut h = Harness::new();
    let mint = h.create_mint(TOKEN_2022_PROGRAM_ID, DECIMALS, Some(HOOK_ID));
    h.init_meta_list(&mint);
    let holder = h.create_ata(&Pubkey::new_unique(), &mint);
    h.mint_to(&mint, &holder, SUPPLY);
    // A DBC-owned pool account, so only the signer check can fail.
    let pool = Pubkey::new_unique();
    h.set_account(
        pool,
        Account {
            lamports: h.rent_exempt(8),
            data: vec![0; 8],
            owner: DBC_PROGRAM_ID,
            executable: false,
            rent_epoch: 0,
        },
    );
    let params = || PolicyParams {
        pool,
        snipe_shield_secs: u32::try_from(SHIELD_SECS).expect("shield secs"),
        guard_secs: 3_600,
        max_wallet: MAX_WALLET,
        max_buy: MAX_BUY,
        p2p_locked: true,
        exempt: [Pubkey::default(); 4],
        rules: vec![],
    };
    let payer = h.payer.pubkey();
    let stranger = h.funded_keypair(1);
    let (lookalike, _) = hook_authority_of(&HOOK_ID);

    let ix = create_policy_ix(&payer, &payer, true, &mint, &pool, params());
    h.send(&[ix], &[])
        .expect_error(AnchorError::ConstraintSeeds, "mint authority signs");
    let ix = create_policy_ix(&payer, &stranger.pubkey(), true, &mint, &pool, params());
    h.send(&[ix], &[&stranger])
        .expect_error(AnchorError::ConstraintSeeds, "random signer");
    // The genuine PDA address cannot sign outside the launchpad program.
    let ix = create_policy_ix(&payer, &hook_authority(), false, &mint, &pool, params());
    h.send(&[ix], &[]).expect_error(
        AnchorError::AccountNotSigner,
        "launchpad PDA without signature",
    );
    let ix = create_policy_ix(&payer, &lookalike, false, &mint, &pool, params());
    h.send(&[ix], &[]).expect_error(
        AnchorError::AccountNotSigner,
        "same seeds under the hook program",
    );
    // Another program signs only for its own `["hook-authority"]` PDA (a
    // relay at its id), which is not the launchpad's, and cannot sign for
    // the launchpad's: the runtime refuses that CPI.
    let impostor = Pubkey::new_unique();
    h.add_relay(impostor);
    let launch = anchor_discriminator("global", "launch");
    let ix = create_policy_ix(
        &payer,
        &hook_authority_of(&impostor).0,
        true,
        &mint,
        &pool,
        params(),
    );
    h.send(&[as_hook_authority_cpi(&impostor, launch, &ix, 1)], &[])
        .expect_error(
            AnchorError::ConstraintSeeds,
            "another program's hook-authority PDA",
        );
    let ix = create_policy_ix(&payer, &hook_authority(), true, &mint, &pool, params());
    h.send(&[as_hook_authority_cpi(&impostor, launch, &ix, 1)], &[])
        .expect_instruction_error(
            InstructionError::PrivilegeEscalation,
            "another program claims the launchpad PDA",
        );
    assert_ne!(hook_authority(), lookalike);
    assert_eq!(
        hook_authority(),
        Pubkey::find_program_address(&[b"hook-authority"], &LAUNCHPAD_PROGRAM_ID).0
    );
    assert!(
        h.account(&policy_pda(&mint).0).is_none(),
        "no policy was written"
    );
}

/// The launchpad's CPI as the hook sees it: `create_policy` signed by the
/// launchpad's `["hook-authority"]` PDA, from a relay at the launchpad's
/// program id that signs with the PDA's seeds (the launchpad's real `launch`
/// belongs to the launchpad suite). The policy then guards DBC's real base
/// vault, for which a relay at DBC's program id signs as DBC's pool
/// authority, as DBC's swap does.
#[test]
fn create_policy_signed_by_the_launchpad_pda_writes_a_bounded_policy() {
    let mut h = Harness::new();
    h.add_relay(LAUNCHPAD_PROGRAM_ID);
    let mint = h.create_mint(TOKEN_2022_PROGRAM_ID, DECIMALS, Some(HOOK_ID));
    h.init_meta_list(&mint);
    let holder = h.create_ata(&Pubkey::new_unique(), &mint);
    h.mint_to(&mint, &holder, SUPPLY);
    let pool = dbc_pool_account(&mut h);
    let (batch, launch_authority) = (Pubkey::new_unique(), Pubkey::new_unique());
    let params = |shield: i64, guard: u32, max_wallet: u64, max_buy: u64| PolicyParams {
        pool,
        snipe_shield_secs: u32::try_from(shield).expect("shield secs"),
        guard_secs: guard,
        max_wallet,
        max_buy,
        p2p_locked: true,
        exempt: [
            batch,
            launch_authority,
            Pubkey::default(),
            Pubkey::default(),
        ],
        rules: vec![],
    };
    let payer = h.payer.pubkey();
    let launch = anchor_discriminator("global", "launch");
    let create = |h: &mut Harness, mint: &Pubkey, pool_account: &Pubkey, p: PolicyParams| {
        let ix = create_policy_ix(&payer, &hook_authority(), true, mint, pool_account, p);
        h.send(
            &[as_hook_authority_cpi(&LAUNCHPAD_PROGRAM_ID, launch, &ix, 1)],
            &[],
        )
    };

    // The hook re-checks its own hard bounds behind the launchpad's.
    let (min_wallet, min_buy) = (SUPPLY / 1_000, SUPPLY / 10_000);
    for (what, p) in [
        (
            "guard over 72 hours",
            params(SHIELD_SECS, 72 * 3_600 + 1, min_wallet, min_buy),
        ),
        (
            "shield over one hour",
            params(3_601, 7_200, min_wallet, min_buy),
        ),
        (
            "shield outlasting the guard",
            params(100, 99, min_wallet, min_buy),
        ),
        (
            "max_wallet under 0.1% of supply",
            params(SHIELD_SECS, 3_600, min_wallet - 1, min_buy),
        ),
        (
            "max_buy under 0.01% of supply",
            params(SHIELD_SECS, 3_600, min_wallet, min_buy - 1),
        ),
    ] {
        create(&mut h, &mint, &pool, p).expect_error(HookError::InvalidPolicy, what);
    }
    // The pool must be a DBC account, and the one the params name.
    let not_dbc = Pubkey::new_unique();
    h.airdrop(&not_dbc, 1_000_000);
    let mut p = params(SHIELD_SECS, 3_600, min_wallet, min_buy);
    p.pool = not_dbc;
    create(&mut h, &mint, &not_dbc, p)
        .expect_error(HookError::InvalidPool, "pool not owned by DBC");
    let other_pool = dbc_pool_account(&mut h);
    create(
        &mut h,
        &mint,
        &other_pool,
        params(SHIELD_SECS, 3_600, min_wallet, min_buy),
    )
    .expect_error(
        HookError::InvalidPool,
        "pool account differs from the params",
    );
    // Only for mints whose transfer hook is this program.
    let unhooked = h.create_mint(TOKEN_2022_PROGRAM_ID, DECIMALS, None);
    create(&mut h, &unhooked, &pool, params(SHIELD_SECS, 3_600, 0, 0))
        .expect_error(HookError::WrongHookProgram, "mint without the Launch Guard");
    assert!(h.policy(&mint).is_none());

    // Anyone can send lamports to the policy PDA first; the launch still works.
    let (policy_key, bump) = policy_pda(&mint);
    let fund = solana_system_interface::instruction::transfer(&payer, &policy_key, 1_000_000);
    h.send(&[fund], &[]).expect_ok("pre-fund the policy PDA");

    // Exactly at the hook's bounds is accepted. The stored policy is byte for
    // byte what the injected policies of the other tests stand for.
    let now = h.now();
    let sent = create(
        &mut h,
        &mint,
        &pool,
        params(SHIELD_SECS, 3_600, min_wallet, min_buy),
    )
    .expect_ok("launchpad PDA");
    assert!(
        sent.logs.contains(&format!("Program {HOOK_ID} invoke [2]")),
        "a CPI from the launchpad's id"
    );
    let base_vault = dbc_base_vault(&mint, &pool);
    let expected = PolicySpec {
        mint,
        pool,
        base_vault,
        launch_ts: now,
        shield_secs: SHIELD_SECS,
        guard_secs: 3_600,
        max_wallet: min_wallet,
        max_buy: min_buy,
        p2p_locked: true,
        exempt: vec![batch, launch_authority],
        rules: vec![],
    }
    .to_policy();
    assert_eq!(expected.bump, bump);
    let mut expected_bytes = Vec::new();
    anchor_lang::AccountSerialize::try_serialize(&expected, &mut expected_bytes).unwrap();
    let stored = h.account(&policy_key).expect("policy account");
    assert_eq!(
        (stored.owner, &stored.data),
        (HOOK_ID, &expected_bytes),
        "stored policy"
    );

    // Written once: not even the launchpad can replace it.
    let f = create(&mut h, &mint, &pool, params(10, 20, 0, 0)).expect_custom(0u32, "second policy");
    assert!(f.logs_contain("already in use"), "{:#?}", f.logs);
    assert_eq!(h.account(&policy_key).unwrap().data, stored.data);

    // The policy guards DBC's real base vault: a token account at the DBC
    // PDA owned by DBC's pool authority, itself the PDA `["pool_authority"]`
    // of DBC. Only DBC can create that account, so it is placed; a relay at
    // DBC's id signs for the pool authority, as DBC's swap does.
    h.add_relay(DBC_PROGRAM_ID);
    let (pool_authority, pool_authority_bump) =
        Pubkey::find_program_address(&[b"pool_authority"], &DBC_PROGRAM_ID);
    assert_eq!(pool_authority, DBC_POOL_AUTHORITY);
    let template = h.create_ata(&DBC_POOL_AUTHORITY, &mint);
    let vault_account = h.account(&template).expect("template token account");
    h.set_account(base_vault, vault_account);
    h.mint_to(&mint, &base_vault, SUPPLY);
    let alice = h.create_ata(&Pubkey::new_unique(), &mint);
    let swap = anchor_discriminator("global", "swap");
    let buy = |h: &mut Harness, amount: u64| {
        let ix = h.transfer_ix(&mint, &base_vault, &alice, &DBC_POOL_AUTHORITY, amount);
        let bump = [pool_authority_bump];
        let seeds: &[&[u8]] = &[b"pool_authority", &bump];
        h.send(
            &[relay_signed_ix(&DBC_PROGRAM_ID, swap, &ix, &[(3, seeds)])],
            &[],
        )
    };
    buy(&mut h, 1).expect_error(HookError::SnipeShield, "buy during the shield");
    h.set_time(now + SHIELD_SECS);
    buy(&mut h, min_buy + 1).expect_error(HookError::MaxBuy, "buy over max_buy");
    buy(&mut h, min_buy).expect_ok("buy after the shield");
    assert_eq!(h.balance(&alice), min_buy);
}

/// An account owned by Meteora DBC, standing in for a pool.
fn dbc_pool_account(h: &mut Harness) -> Pubkey {
    let pool = Pubkey::new_unique();
    let account = Account {
        lamports: h.rent_exempt(8),
        data: vec![0; 8],
        owner: DBC_PROGRAM_ID,
        executable: false,
        rent_epoch: 0,
    };
    h.set_account(pool, account);
    pool
}

/// Byte offset of `snipe_shield_end_ts` in a `HookPolicy` account:
/// discriminator, version, bump, mint, pool, base vault, `launch_ts`.
const SHIELD_END_OFFSET: usize = 8 + 1 + 1 + 32 * 3 + 8;

/// `end_snipe_shield` on `policy` as `execute_batch` sends it: a CPI from
/// the launchpad's program id, inside a top-level instruction that carries
/// `execute_batch`'s discriminator, signed by the launchpad's
/// `["hook-authority"]` PDA (a relay registered there signs with the PDA's
/// seeds, see `common::relay`).
fn end_shield_ix(policy: &Pubkey) -> Instruction {
    let ix = end_snipe_shield_ix(&hook_authority(), true, policy);
    as_hook_authority_cpi(&LAUNCHPAD_PROGRAM_ID, EXECUTE_BATCH_DISCRIMINATOR, &ix, 0)
}

/// The borsh payload of `SnipeShieldEnded {mint, pool, scheduled_end_ts,
/// snipe_shield_end_ts}`, written from the documented layout.
fn shield_ended(
    mint: &Pubkey,
    pool: &Pubkey,
    scheduled_end_ts: i64,
    snipe_shield_end_ts: i64,
) -> Vec<u8> {
    [
        mint.as_ref(),
        pool.as_ref(),
        &scheduled_end_ts.to_le_bytes(),
        &snipe_shield_end_ts.to_le_bytes(),
    ]
    .concat()
}

/// Round 2: `end_snipe_shield` lets the launchpad open trading as soon as
/// the batch has bought, so the long execution window that protects the
/// batch from write-lock contention never delays trading. Only the
/// launchpad's `["hook-authority"]` PDA can sign it, which only the
/// launchpad program can do (in `execute_batch`, after the batch buy; the
/// launchpad suite drives that path). Keypairs sign where a real signer
/// can; program signatures come from relays at the launchpad's id or at an
/// impostor's, signing with their own seeds.
#[test]
fn end_snipe_shield_only_accepts_the_launchpad_pda() {
    let mut l = Launch::new(true);
    let impostor = Pubkey::new_unique();
    l.h.add_relay(LAUNCHPAD_PROGRAM_ID);
    l.h.add_relay(impostor);
    let (mint, alice) = (l.mint, l.alice_ata);
    let payer = l.h.payer.pubkey();
    let policy = policy_pda(&mint).0;
    let before = l.h.account(&policy).expect("policy").data;
    let stranger = l.h.funded_keypair(1);
    let (lookalike, _) = hook_authority_of(&HOOK_ID);
    l.at(COMMIT_SECS + 10);

    let ix = end_snipe_shield_ix(&payer, true, &policy);
    l.h.send(&[ix], &[])
        .expect_error(AnchorError::ConstraintSeeds, "the fee payer signs");
    let ix = end_snipe_shield_ix(&stranger.pubkey(), true, &policy);
    l.h.send(&[ix], &[&stranger])
        .expect_error(AnchorError::ConstraintSeeds, "a stranger signs");
    // Nobody holds a key for a PDA: a transaction can only pass it unsigned.
    let ix = end_snipe_shield_ix(&hook_authority(), false, &policy);
    l.h.send(&[ix], &[])
        .expect_error(AnchorError::AccountNotSigner, "the launchpad PDA, unsigned");
    let ix = end_snipe_shield_ix(&lookalike, false, &policy);
    l.h.send(&[ix], &[]).expect_error(
        AnchorError::AccountNotSigner,
        "the same seeds under the hook program",
    );
    // Another program signs only for its own `["hook-authority"]` PDA, which
    // is not the launchpad's, and cannot sign for the launchpad's: the
    // runtime refuses that CPI before the hook runs.
    let ix = end_snipe_shield_ix(&hook_authority_of(&impostor).0, true, &policy);
    l.h.send(
        &[as_hook_authority_cpi(
            &impostor,
            EXECUTE_BATCH_DISCRIMINATOR,
            &ix,
            0,
        )],
        &[],
    )
    .expect_error(
        AnchorError::ConstraintSeeds,
        "another program's hook-authority PDA",
    );
    let ix = end_snipe_shield_ix(&hook_authority(), true, &policy);
    let f =
        l.h.send(
            &[as_hook_authority_cpi(
                &impostor,
                EXECUTE_BATCH_DISCRIMINATOR,
                &ix,
                0,
            )],
            &[],
        )
        .expect_instruction_error(
            InstructionError::PrivilegeEscalation,
            "another program claims the launchpad PDA",
        );
    assert!(
        f.logs_contain(&format!(
            "{}'s signer privilege escalated",
            hook_authority()
        )),
        "{:#?}",
        f.logs
    );
    assert!(
        !f.logs_contain(&format!("Program {HOOK_ID} invoke")),
        "the hook never ran"
    );
    // No other PDA of the launchpad stands in for `hook-authority`.
    let (other_pda, other_bump) =
        Pubkey::find_program_address(&[HOOK_AUTHORITY_SEED, mint.as_ref()], &LAUNCHPAD_PROGRAM_ID);
    let other_bump = [other_bump];
    let other_seeds: &[&[u8]] = &[HOOK_AUTHORITY_SEED, mint.as_ref(), &other_bump];
    let ix = end_snipe_shield_ix(&other_pda, true, &policy);
    l.h.send(
        &[relay_signed_ix(
            &LAUNCHPAD_PROGRAM_ID,
            EXECUTE_BATCH_DISCRIMINATOR,
            &ix,
            &[(0, other_seeds)],
        )],
        &[],
    )
    .expect_error(AnchorError::ConstraintSeeds, "another PDA of the launchpad");
    assert_eq!(
        l.h.account(&policy).unwrap().data,
        before,
        "the policy is unchanged"
    );
    l.buy(&alice, 1)
        .expect_error(HookError::SnipeShield, "the shield still holds");

    // The launchpad's signature, inside `execute_batch`, ends the shield.
    let sent =
        l.h.send(&[end_shield_ix(&policy)], &[])
            .expect_ok("signed by the launchpad's hook-authority PDA");
    assert!(
        sent.logs.contains(&format!("Program {HOOK_ID} invoke [2]")),
        "a CPI from the launchpad's id"
    );
    l.buy(&alice, 1).expect_ok("the shield has ended");
}

/// Signed by the launchpad's PDA inside `execute_batch`, `end_snipe_shield`
/// still takes only a real policy PDA of the hook, writable, and the real
/// instructions sysvar: not another account of the hook program, not a copy
/// of the policy owned by another program or placed off its PDA, not a
/// policy whose stored bump does not derive its address, not the policy
/// read-only, and not another account in the sysvar's place. Every refusal
/// leaves the policy as it was.
#[test]
fn end_snipe_shield_takes_only_a_policy_pda_and_the_sysvar() {
    let mut l = Launch::new(true);
    l.h.add_relay(LAUNCHPAD_PROGRAM_ID);
    let (mint, alice) = (l.mint, l.alice_ata);
    let policy = policy_pda(&mint).0;
    let original = l.h.account(&policy).expect("policy");
    l.at(COMMIT_SECS + 10);
    let signed = |h: &mut Harness, ix: Instruction| {
        h.send(
            &[as_hook_authority_cpi(
                &LAUNCHPAD_PROGRAM_ID,
                EXECUTE_BATCH_DISCRIMINATOR,
                &ix,
                0,
            )],
            &[],
        )
    };
    let end = |policy: &Pubkey| end_snipe_shield_ix(&hook_authority(), true, policy);

    signed(&mut l.h, end(&meta_list_pda(&mint)))
        .expect_error(AnchorError::AccountDiscriminatorMismatch, "the meta list");
    let foreign = Pubkey::new_unique();
    let mut copy = original.clone();
    copy.owner = Pubkey::new_unique();
    l.h.set_account(foreign, copy);
    signed(&mut l.h, end(&foreign)).expect_error(
        AnchorError::AccountOwnedByWrongProgram,
        "a policy copy of another owner",
    );
    // Byte for byte the policy, owned by the hook, at an address that is not
    // `["policy", mint]` (only the hook could create one; defense in depth).
    let elsewhere = Pubkey::new_unique();
    l.h.set_account(elsewhere, original.clone());
    signed(&mut l.h, end(&elsewhere)).expect_error(
        AnchorError::ConstraintSeeds,
        "a hook-owned policy off its PDA",
    );
    let mut wrong_bump: HookPolicy = l.h.policy(&mint).unwrap();
    wrong_bump.bump = wrong_bump.bump.wrapping_sub(1);
    l.h.inject_policy(&wrong_bump);
    signed(&mut l.h, end(&policy)).expect_error(
        AnchorError::ConstraintSeeds,
        "a stored bump that does not derive the PDA",
    );
    l.h.set_account(policy, original.clone());
    let mut read_only = end(&policy);
    read_only.accounts[1].is_writable = false;
    signed(&mut l.h, read_only).expect_error(AnchorError::ConstraintMut, "the policy, read-only");
    let mut fake_sysvar = end(&policy);
    fake_sysvar.accounts[2].pubkey = Pubkey::new_unique();
    signed(&mut l.h, fake_sysvar).expect_error(
        AnchorError::ConstraintAddress,
        "another account as the sysvar",
    );
    let mut no_sysvar = end(&policy);
    no_sysvar.accounts.pop();
    signed(&mut l.h, no_sysvar).expect_error(AnchorError::AccountNotEnoughKeys, "no sysvar");
    assert_eq!(
        l.h.account(&policy).unwrap().data,
        original.data,
        "the policy is unchanged"
    );
    l.buy(&alice, 1)
        .expect_error(HookError::SnipeShield, "the shield still holds");

    signed(&mut l.h, end(&policy)).expect_ok("the policy PDA and the sysvar");
    l.buy(&alice, 1).expect_ok("the shield has ended");
}

/// Defense in depth: even with the launchpad's signature, `end_snipe_shield`
/// runs only while the transaction's current top-level instruction is the
/// launchpad's `execute_batch` (`NotInBatch`): not from another launchpad
/// instruction, not when another program's top-level instruction carrying
/// `execute_batch`'s discriminator reaches the launchpad through a CPI, and
/// not next to an `execute_batch` that is another top-level instruction.
#[test]
fn end_snipe_shield_runs_only_inside_execute_batch() {
    let mut l = Launch::new(true);
    let impostor = Pubkey::new_unique();
    l.h.add_relay(LAUNCHPAD_PROGRAM_ID);
    l.h.add_relay(impostor);
    let (mint, alice) = (l.mint, l.alice_ata);
    let policy = policy_pda(&mint).0;
    let before = l.h.account(&policy).unwrap().data;
    l.at(COMMIT_SECS + 10);
    let ix = end_snipe_shield_ix(&hook_authority(), true, &policy);
    let signed_in = |tag: [u8; 8]| as_hook_authority_cpi(&LAUNCHPAD_PROGRAM_ID, tag, &ix, 0);
    let execute_batch = EXECUTE_BATCH_DISCRIMINATOR;
    assert_eq!(
        execute_batch,
        anchor_discriminator("global", "execute_batch")
    );

    let refused = [
        (
            "from the launchpad's launch",
            vec![signed_in(anchor_discriminator("global", "launch"))],
        ),
        (
            "from the launchpad's commit",
            vec![signed_in(anchor_discriminator("global", "commit"))],
        ),
        (
            "another program's look-alike reaching the launchpad through a CPI",
            vec![relay_ix(
                &impostor,
                execute_batch,
                &signed_in(execute_batch),
            )],
        ),
        (
            "next to a top-level execute_batch",
            vec![
                relay_noop_ix(&LAUNCHPAD_PROGRAM_ID, execute_batch),
                signed_in(anchor_discriminator("global", "claim")),
            ],
        ),
    ];
    for (what, ixs) in refused {
        let f =
            l.h.send(&ixs, &[])
                .expect_error(HookError::NotInBatch, what);
        assert!(
            f.logs_contain(&format!("Program {HOOK_ID} invoke")),
            "{what}: the hook ran and refused"
        );
    }
    assert_eq!(
        l.h.account(&policy).unwrap().data,
        before,
        "the policy is unchanged"
    );
    l.buy(&alice, 1)
        .expect_error(HookError::SnipeShield, "the shield still holds");

    l.h.send(&[signed_in(execute_batch)], &[])
        .expect_ok("inside execute_batch");
    assert_eq!(
        l.h.policy(&mint).unwrap().snipe_shield_end_ts,
        l.launch_ts + COMMIT_SECS + 10
    );
    l.buy(&alice, 1).expect_ok("the shield has ended");
}

/// `end_snipe_shield` moves the shield's end to the moment of the call when
/// that is earlier, and changes nothing else: only the 8 bytes of
/// `snipe_shield_end_ts` change, and `SnipeShieldEnded` reports the end
/// before and after the call. Later calls, and calls at or after the
/// scheduled end (also after the guard), leave the policy byte for byte as
/// it was and report an unchanged end: the end never moves later.
#[test]
fn end_snipe_shield_only_moves_the_end_earlier() {
    let mut l = Launch::new(true);
    l.h.add_relay(LAUNCHPAD_PROGRAM_ID);
    let mint = l.mint;
    let policy = policy_pda(&mint).0;
    let scheduled: HookPolicy = l.h.policy(&mint).expect("policy");
    let end = l.launch_ts + SHIELD_SECS;
    assert_eq!(scheduled.snipe_shield_end_ts, end);
    let before = l.h.account(&policy).unwrap().data;

    // The batch executes 10 s after the commit window closed, ten minutes
    // before the scheduled end (the end of the execution window).
    l.at(COMMIT_SECS + 10);
    let batch_at = l.launch_ts + COMMIT_SECS + 10;
    let sent =
        l.h.send(&[end_shield_ix(&policy)], &[])
            .expect_ok("end_snipe_shield");
    let cu = invocations_cu(&sent.logs, &HOOK_ID);
    assert_eq!(cu.len(), 1);
    report(
        "Launch Guard end_snipe_shield CU (CPI signed by the launchpad PDA)",
        cu[0],
    );
    let after = l.h.account(&policy).unwrap().data;
    let changed: Vec<usize> = (0..before.len())
        .filter(|&i| before[i] != after[i])
        .collect();
    assert!(
        !changed.is_empty()
            && changed
                .iter()
                .all(|i| (SHIELD_END_OFFSET..SHIELD_END_OFFSET + 8).contains(i)),
        "only snipe_shield_end_ts may change: {changed:?}"
    );
    assert_eq!(
        after[SHIELD_END_OFFSET..SHIELD_END_OFFSET + 8],
        batch_at.to_le_bytes()
    );
    let ended: HookPolicy = l.h.policy(&mint).unwrap();
    assert_eq!(
        (ended.snipe_shield_end_ts, ended.guard_end_ts),
        (batch_at, scheduled.guard_end_ts)
    );
    assert_eq!(
        anchor_events(&sent.logs, "SnipeShieldEnded"),
        vec![shield_ended(&mint, &scheduled.pool, end, batch_at)]
    );

    // Later calls (the clock never goes back) leave it where it is.
    for t in [
        COMMIT_SECS + 11,
        SHIELD_SECS - 1,
        SHIELD_SECS,
        GUARD_SECS + 1,
    ] {
        l.at(t);
        let sent =
            l.h.send(&[end_shield_ix(&policy)], &[])
                .expect_ok("a later call");
        let unchanged = shield_ended(&mint, &scheduled.pool, batch_at, batch_at);
        assert_eq!(
            anchor_events(&sent.logs, "SnipeShieldEnded"),
            vec![unchanged],
            "at +{t}s"
        );
        assert_eq!(l.h.account(&policy).unwrap().data, after, "at +{t}s");
    }

    // A call at or after the scheduled end changes nothing either; one in its
    // last second ends the shield one second early.
    let mut late = Launch::new(false);
    late.h.add_relay(LAUNCHPAD_PROGRAM_ID);
    let late_mint = late.mint;
    let late_policy = policy_pda(&late_mint).0;
    let late_pool = late.h.policy(&late_mint).unwrap().pool;
    let late_end = late.launch_ts + SHIELD_SECS;
    let untouched = late.h.account(&late_policy).unwrap().data;
    for t in [SHIELD_SECS, SHIELD_SECS + 1, GUARD_SECS, GUARD_SECS + 1] {
        late.at(t);
        let sent = late
            .h
            .send(&[end_shield_ix(&late_policy)], &[])
            .expect_ok("at or after the scheduled end");
        let unchanged = shield_ended(&late_mint, &late_pool, late_end, late_end);
        assert_eq!(
            anchor_events(&sent.logs, "SnipeShieldEnded"),
            vec![unchanged],
            "at +{t}s"
        );
        assert_eq!(
            late.h.account(&late_policy).unwrap().data,
            untouched,
            "at +{t}s"
        );
    }
    let mut last = Launch::new(false);
    last.h.add_relay(LAUNCHPAD_PROGRAM_ID);
    let last_mint = last.mint;
    let last_policy = policy_pda(&last_mint).0;
    let last_pool = last.h.policy(&last_mint).unwrap().pool;
    let last_end = last.launch_ts + SHIELD_SECS;
    last.at(SHIELD_SECS - 1);
    let sent = last
        .h
        .send(&[end_shield_ix(&last_policy)], &[])
        .expect_ok("in the last second of the shield");
    assert_eq!(
        last.h.policy(&last_mint).unwrap().snipe_shield_end_ts,
        last_end - 1
    );
    let moved = shield_ended(&last_mint, &last_pool, last_end, last_end - 1);
    assert_eq!(anchor_events(&sent.logs, "SnipeShieldEnded"), vec![moved]);
}

/// Once `end_snipe_shield` has run (the last step of `execute_batch`), buys
/// pass at once, from the next instruction of the same transaction on,
/// under the guard rules (max-buy, max-wallet, the p2p lock) until the
/// unchanged guard end; sells pass as always. A buy placed before it is
/// still refused, together with its whole transaction.
#[test]
fn buys_pass_right_after_the_batch_ends_the_shield() {
    let mut l = Launch::new(true);
    l.h.add_relay(LAUNCHPAD_PROGRAM_ID);
    let (mint, base_vault, batch_ata, alice_ata, bob_ata) =
        (l.mint, l.base_vault, l.batch_ata, l.alice_ata, l.bob_ata);
    let (pool, alice) = (l.pool_authority.insecure_clone(), l.alice.insecure_clone());
    let policy = policy_pda(&mint).0;
    let before = l.h.account(&policy).unwrap().data;
    l.at(COMMIT_SECS + 10);
    let batch_at = l.h.now();

    // The batch buy inside `execute_batch`, then the end of the shield.
    let to_batch =
        l.h.transfer_ix(&mint, &base_vault, &batch_ata, &pool.pubkey(), 2 * MAX_BUY);
    let batch_buy = relay_ix(
        &LAUNCHPAD_PROGRAM_ID,
        EXECUTE_BATCH_DISCRIMINATOR,
        &to_batch,
    );
    let public_buy =
        l.h.transfer_ix(&mint, &base_vault, &alice_ata, &pool.pubkey(), 5);
    l.h.send_v1(
        &[
            batch_buy.clone(),
            public_buy.clone(),
            end_shield_ix(&policy),
        ],
        &[&pool],
    )
    .expect_error(
        HookError::SnipeShield,
        "a public buy before end_snipe_shield",
    );
    assert_eq!((l.bal(&batch_ata), l.bal(&alice_ata)), (0, 0));
    assert_eq!(
        l.h.account(&policy).unwrap().data,
        before,
        "the whole transaction reverted"
    );
    let sent =
        l.h.send_v1(&[batch_buy, end_shield_ix(&policy), public_buy], &[&pool])
            .expect_ok("the batch buy, the end of the shield, then a public buy");
    assert_eq!(
        invocations_cu(&sent.logs, &HOOK_ID).len(),
        3,
        "execute, end_snipe_shield, execute"
    );
    assert_eq!((l.bal(&batch_ata), l.bal(&alice_ata)), (2 * MAX_BUY, 5));
    assert_eq!(l.h.policy(&mint).unwrap().snipe_shield_end_ts, batch_at);

    // In the same second, in the next transactions, under the guard rules.
    l.buy(&alice_ata, 5)
        .expect_ok("a public buy in the second the batch executed");
    l.buy(&alice_ata, 0).expect_ok("a zero-amount buy");
    l.buy(&bob_ata, MAX_BUY + 1)
        .expect_error(HookError::MaxBuy, "max-buy still applies");
    l.buy(&bob_ata, MAX_BUY)
        .expect_ok("a buy of exactly max-buy");
    l.fund(&bob_ata, MAX_WALLET - MAX_BUY);
    l.buy(&bob_ata, 1)
        .expect_error(HookError::MaxWallet, "max-wallet still applies");
    l.send(&alice, &alice_ata, &bob_ata, 1)
        .expect_error(HookError::TransfersLocked, "the p2p lock still applies");
    l.sell(&alice, &alice_ata, 5).expect_ok("sells pass");
    // Exempt owners skip the caps again, as after a scheduled end.
    l.buy(&batch_ata, 3 * MAX_WALLET)
        .expect_ok("an exempt owner, over the caps");
    // The guard still ends when it was scheduled to.
    l.at(GUARD_SECS - 1);
    l.send(&alice, &alice_ata, &bob_ata, 1)
        .expect_error(HookError::TransfersLocked, "the last second of the guard");
    l.at(GUARD_SECS);
    l.send(&alice, &alice_ata, &bob_ata, 5)
        .expect_ok("p2p at the guard end");
    l.buy(&bob_ata, 3 * MAX_WALLET)
        .expect_ok("a whale buy at the guard end");
    assert_eq!(
        (l.bal(&alice_ata), l.bal(&bob_ata)),
        (0, MAX_WALLET + 5 + 3 * MAX_WALLET)
    );
}

/// `end_snipe_shield` takes no mint and does not need the hook to be
/// active. When the batch buy completes the curve, DBC revokes the mint's
/// transfer hook inside that same swap (program id set to None), and
/// `execute_batch` must still end the shield and succeed. The revocation is
/// placed here by rewriting the mint's TransferHook extension as DBC's
/// update leaves it.
#[test]
fn end_snipe_shield_works_after_dbc_revoked_the_hook() {
    let mut l = Launch::new(true);
    l.h.add_relay(LAUNCHPAD_PROGRAM_ID);
    let (mint, alice_ata, bob_ata) = (l.mint, l.alice_ata, l.bob_ata);
    let alice = l.alice.insecure_clone();
    let policy = policy_pda(&mint).0;
    l.fund(&alice_ata, 1_000);
    l.at(COMMIT_SECS + 10);
    let mut account = l.h.account(&mint).expect("mint");
    {
        let mut state =
            StateWithExtensionsMut::<Mint>::unpack(&mut account.data).expect("mint state");
        let hook = state
            .get_extension_mut::<TransferHook>()
            .expect("transfer hook extension");
        hook.program_id = Default::default();
    }
    l.h.set_account(mint, account);
    assert_eq!(l.h.hook_program_of(&mint), None);
    // Token-2022 no longer calls the hook: transfers are unrestricted.
    let sent = l
        .send(&alice, &alice_ata, &bob_ata, 10)
        .expect_ok("p2p with the hook revoked");
    assert!(
        invocations_cu(&sent.logs, &HOOK_ID).is_empty(),
        "the hook did not run"
    );

    let sent =
        l.h.send(&[end_shield_ix(&policy)], &[])
            .expect_ok("end_snipe_shield with the hook revoked");
    let batch_at = l.launch_ts + COMMIT_SECS + 10;
    assert_eq!(l.h.policy(&mint).unwrap().snipe_shield_end_ts, batch_at);
    let pool = l.h.policy(&mint).unwrap().pool;
    let event = shield_ended(&mint, &pool, l.launch_ts + SHIELD_SECS, batch_at);
    assert_eq!(anchor_events(&sent.logs, "SnipeShieldEnded"), vec![event]);
    // Its accounts are the signer, the policy and the sysvar: no mint.
    let ix = end_snipe_shield_ix(&hook_authority(), true, &policy);
    let keys: Vec<Pubkey> = ix.accounts.iter().map(|m| m.pubkey).collect();
    assert_eq!(keys, vec![hook_authority(), policy, INSTRUCTIONS_SYSVAR_ID]);
}

/// Audit finding L2: anyone can open a token account owned by an exempt
/// PDA (the batch or launch authority), and the shield used to let a buy
/// into one through. One cheap buy before the batch then moved the price and
/// maxed DBC's dynamic fee for the batch swap. Exemptions no longer open the
/// shield: until it ends, a buy (a transfer out of the base vault) passes
/// only inside `execute_batch` (see the batch test), whoever receives it and
/// whatever its amount (zero included, see the zero-amount test).
#[test]
fn buys_are_blocked_during_the_snipe_shield_even_into_exempt_accounts() {
    let mut l = Launch::new(true);
    let (mint, alice, batch, launch_auth) =
        (l.mint, l.alice_ata, l.batch_ata, l.launch_authority_ata);

    for t in [0, 1, SHIELD_SECS - 1] {
        l.at(t);
        l.buy(&alice, 1)
            .expect_error(HookError::SnipeShield, &format!("buy at +{t}s"));
    }
    // Into accounts of the exempt batch and launch authorities: the batch
    // authority's ATA, and an account someone else opened for it.
    let opened_by_anyone = l.h.create_token_account(&l.batch.pubkey(), &mint);
    for (what, to) in [
        ("into the batch authority's ATA", batch),
        (
            "into an account anyone opened for the batch authority",
            opened_by_anyone,
        ),
        ("into the launch authority's ATA", launch_auth),
    ] {
        l.buy(&to, 1).expect_error(HookError::SnipeShield, what);
        l.buy(&to, 0)
            .expect_error(HookError::SnipeShield, &format!("zero-amount buy {what}"));
    }
    assert_eq!(
        (l.bal(&batch), l.bal(&opened_by_anyone), l.bal(&launch_auth)),
        (0, 0, 0)
    );
    // Exempt sources can pay out (batch claims) during the shield: not a buy.
    let batch_owner = l.batch.insecure_clone();
    l.fund(&batch, 5_000);
    l.send(&batch_owner, &batch, &alice, 1_000)
        .expect_ok("batch claim to alice");
    assert_eq!(l.bal(&alice), 1_000);

    l.at(SHIELD_SECS);
    l.buy(&alice, 5).expect_ok("first public buy at shield end");
    assert_eq!(l.bal(&alice), 1_005);
    // After the shield the exemption applies again: no caps for exempt owners.
    l.buy(&opened_by_anyone, 3 * MAX_WALLET)
        .expect_ok("exempt owner after the shield");

    // The shield only stops buys: with the p2p lock off, wallets transact.
    let mut u = Launch::new(false);
    let (alice_ata, bob_ata) = (u.alice_ata, u.bob_ata);
    let alice = u.alice.insecure_clone();
    u.fund(&alice_ata, 100);
    u.at(0);
    u.send(&alice, &alice_ata, &bob_ata, 10)
        .expect_ok("p2p during the shield, lock off");
    u.buy(&alice_ata, 1)
        .expect_error(HookError::SnipeShield, "buy during the shield, lock off");
}

/// Residual of audit finding L2 (review): DBC 0.2.1 executes exact-in buys
/// whose output rounds to zero base units, and such a buy still moves the
/// pool's price and volatility accumulator. On a curve whose first segment
/// holds dust liquidity, a 2-lamport buy before the batch saturated the
/// dynamic fee the batch then paid, and the hook let it through because it
/// passed every zero-amount transfer first. Token-2022 calls the hook for a
/// zero-amount transfer like for any other. Until the shield ends the hook
/// now refuses every buy outside `execute_batch`, zero included; zero-amount
/// transfers that are not buys still pass, and after the shield a zero buy
/// passes again (no cap applies to it).
#[test]
fn zero_amount_buys_wait_for_the_snipe_shield() {
    let mut l = Launch::new(true);
    let impostor = Pubkey::new_unique();
    l.h.add_relay(LAUNCHPAD_PROGRAM_ID);
    l.h.add_relay(impostor);
    let (mint, base_vault, alice_ata, bob_ata, batch_ata) =
        (l.mint, l.base_vault, l.alice_ata, l.bob_ata, l.batch_ata);
    let (pool, alice, batch) = (
        l.pool_authority.insecure_clone(),
        l.alice.insecure_clone(),
        l.batch.insecure_clone(),
    );
    l.fund(&alice_ata, 1_000);
    l.fund(&batch_ata, 1_000);

    for t in [0, SHIELD_SECS - 1] {
        l.at(t);
        for (what, to) in [
            ("into a wallet", alice_ata),
            ("into the exempt batch authority's ATA", batch_ata),
        ] {
            let f = l.buy(&to, 0).expect_error(
                HookError::SnipeShield,
                &format!("zero-amount buy {what} at +{t}s"),
            );
            assert!(
                f.logs_contain(&format!("Program {HOOK_ID} invoke [2]")),
                "Token-2022 asked the hook"
            );
        }
    }
    // Zero-amount transfers that are not buys pass during the shield, with
    // the p2p lock on. Each one did run the hook.
    for (what, sent) in [
        ("wallet to wallet", l.send(&alice, &alice_ata, &bob_ata, 0)),
        ("a zero-amount sell", l.sell(&alice, &alice_ata, 0)),
        (
            "out of the exempt batch authority's ATA",
            l.send(&batch, &batch_ata, &alice_ata, 0),
        ),
    ] {
        let sent = sent.expect_ok(what);
        assert_eq!(
            invocations_cu(&sent.logs, &HOOK_ID).len(),
            1,
            "{what}: the hook ran"
        );
    }
    // Inside execute_batch the zero-amount buy passes; from a look-alike it does not.
    let zero_buy =
        l.h.transfer_ix(&mint, &base_vault, &batch_ata, &pool.pubkey(), 0);
    l.h.send_v1(
        &[relay_ix(&impostor, EXECUTE_BATCH_DISCRIMINATOR, &zero_buy)],
        &[&pool],
    )
    .expect_error(
        HookError::SnipeShield,
        "a zero-amount buy in execute_batch's look-alike",
    );
    l.h.send_v1(
        &[relay_ix(
            &LAUNCHPAD_PROGRAM_ID,
            EXECUTE_BATCH_DISCRIMINATOR,
            &zero_buy,
        )],
        &[&pool],
    )
    .expect_ok("a zero-amount buy inside execute_batch");

    // From the end of the shield a zero-amount buy passes, even into a
    // wallet already over max_wallet, where any real buy is capped.
    l.at(SHIELD_SECS);
    l.fund(&alice_ata, MAX_WALLET);
    l.buy(&alice_ata, 0)
        .expect_ok("zero-amount buy at the end of the shield");
    l.buy(&alice_ata, 1)
        .expect_error(HookError::MaxWallet, "one unit into the same wallet");
    assert_eq!(
        (
            l.bal(&alice_ata),
            l.bal(&bob_ata),
            l.bal(&batch_ata),
            l.bal(&base_vault)
        ),
        (MAX_WALLET + 1_000, 0, 1_000, SUPPLY)
    );
}

/// A transfer out of the base vault is a buy, never a sell, even when its
/// destination is the base vault itself (review of L2: a buy whose output
/// account is the pool's base vault looked like a sell to the hook).
///
/// Token-2022 never shows the hook that transfer: it returns from a
/// self-transfer (source == destination) after the authority check, before
/// moving funds and before calling the hook. So through Token-2022 the base
/// vault "paying itself" is a no-op the hook never sees. What stops a DBC
/// buy into the base vault is DBC itself, which refuses the base vault as
/// the output account (duplicate mutable account; a review probe against
/// the mainnet DBC dump, for the launchpad suite to pin), and a pool that
/// has traded before the batch can no longer run `execute_batch`. The
/// hook's own decision for that input is checked by calling `execute`
/// directly.
#[test]
fn a_transfer_out_of_the_base_vault_is_never_a_sell() {
    let mut l = Launch::new(true);
    let (mint, base_vault, alice_ata) = (l.mint, l.base_vault, l.alice_ata);
    let (pool, alice) = (l.pool_authority.pubkey(), l.alice.pubkey());
    l.fund(&alice_ata, 1_000);
    l.at(1);

    // Through Token-2022: a no-op, and the hook does not run.
    let sent = l
        .buy(&base_vault, 5)
        .expect_ok("Token-2022 self-transfer of the base vault");
    assert!(
        !sent
            .logs
            .iter()
            .any(|log| log.contains(&HOOK_ID.to_string())),
        "{:#?}",
        sent.logs
    );
    assert_eq!(l.bal(&base_vault), SUPPLY);

    let execute = |l: &mut Launch, from: &Pubkey, to: &Pubkey, authority: &Pubkey, amount: u64| {
        l.h.send(&[execute_ix(&mint, from, to, authority, amount)], &[])
    };
    // The direct call decides like Token-2022's calls: a buy waits, a sell passes.
    execute(&mut l, &base_vault, &alice_ata, &pool, 5)
        .expect_error(HookError::SnipeShield, "a buy");
    execute(&mut l, &alice_ata, &base_vault, &alice, 5).expect_ok("a sell");
    // Out of the base vault into the base vault: a buy, whatever the amount.
    for amount in [5, 0] {
        execute(&mut l, &base_vault, &base_vault, &pool, amount).expect_error(
            HookError::SnipeShield,
            &format!("base vault into itself, amount {amount}, in the shield"),
        );
    }
    // Still a buy after the shield: the caps apply, and the base vault holds
    // the supply, far over max_wallet.
    l.at(SHIELD_SECS);
    execute(&mut l, &base_vault, &base_vault, &pool, 5)
        .expect_error(HookError::MaxWallet, "after the shield");
    execute(&mut l, &base_vault, &base_vault, &pool, 0).expect_ok("a zero amount after the shield");
    l.at(GUARD_SECS);
    execute(&mut l, &base_vault, &base_vault, &pool, 5).expect_ok("after the guard");
}

#[test]
fn max_buy_and_max_wallet_apply_during_the_guard() {
    let mut l = Launch::new(true);
    let (alice, batch) = (l.alice_ata, l.batch_ata);
    l.at(SHIELD_SECS);

    l.buy(&alice, MAX_BUY + 1)
        .expect_error(HookError::MaxBuy, "buy over max_buy");
    l.buy(&alice, MAX_BUY).expect_ok("buy exactly max_buy");
    l.buy(&alice, MAX_BUY)
        .expect_ok("second buy reaches max_wallet exactly");
    assert_eq!(l.bal(&alice), MAX_WALLET);
    l.buy(&alice, 1)
        .expect_error(HookError::MaxWallet, "one unit over max_wallet");
    // Caps never apply to exempt owners (after the shield).
    l.buy(&batch, 3 * MAX_WALLET)
        .expect_ok("exempt destination ignores caps");

    l.at(GUARD_SECS - 1);
    let bob = l.bob_ata;
    l.buy(&bob, MAX_BUY + 1)
        .expect_error(HookError::MaxBuy, "last second of the guard");
    assert_eq!(l.bal(&alice), MAX_WALLET);
}

#[test]
fn wallet_to_wallet_transfers_follow_the_p2p_lock() {
    let mut l = Launch::new(true);
    let (alice_ata, bob_ata, batch_ata, la_ata) =
        (l.alice_ata, l.bob_ata, l.batch_ata, l.launch_authority_ata);
    let (alice, batch) = (l.alice.insecure_clone(), l.batch.insecure_clone());
    l.fund(&alice_ata, 1_000);
    l.fund(&batch_ata, 1_000);
    l.at(SHIELD_SECS);
    l.send(&alice, &alice_ata, &bob_ata, 10)
        .expect_error(HookError::TransfersLocked, "p2p during guard");
    l.send(&alice, &alice_ata, &la_ata, 10)
        .expect_ok("to an exempt owner");
    l.send(&batch, &batch_ata, &bob_ata, 10)
        .expect_ok("from an exempt owner");
    l.send(&alice, &alice_ata, &bob_ata, 0)
        .expect_ok("zero-amount transfer");
    assert_eq!((l.bal(&alice_ata), l.bal(&bob_ata)), (990, 10));

    // Without the lock, wallet transfers pass but stay under the caps.
    let mut u = Launch::new(false);
    let (alice_ata, bob_ata) = (u.alice_ata, u.bob_ata);
    let alice = u.alice.insecure_clone();
    u.fund(&alice_ata, 2 * MAX_WALLET);
    u.at(SHIELD_SECS);
    u.send(&alice, &alice_ata, &bob_ata, 10)
        .expect_ok("p2p when not locked");
    u.send(&alice, &alice_ata, &bob_ata, MAX_BUY + 1)
        .expect_error(HookError::MaxBuy, "p2p over max_buy");
    u.send(&alice, &alice_ata, &bob_ata, MAX_BUY)
        .expect_ok("p2p at max_buy");
    u.send(&alice, &alice_ata, &bob_ata, MAX_BUY)
        .expect_error(HookError::MaxWallet, "receiver over max_wallet");
}

#[test]
fn sells_into_the_base_vault_are_never_blocked() {
    let mut l = Launch::new(true);
    let alice_ata = l.alice_ata;
    let alice = l.alice.insecure_clone();
    l.fund(&alice_ata, 4 * MAX_WALLET);
    // During the shield, over every cap, into a vault far above max_wallet.
    l.at(0);
    l.sell(&alice, &alice_ata, 2 * MAX_WALLET)
        .expect_ok("sell during the shield");
    l.at(SHIELD_SECS + 1);
    l.sell(&alice, &alice_ata, MAX_WALLET + 1)
        .expect_ok("sell during the guard over the caps");
    l.at(GUARD_SECS + 1);
    let rest = l.bal(&alice_ata);
    l.sell(&alice, &alice_ata, rest)
        .expect_ok("sell after the guard");
    assert_eq!(l.bal(&alice_ata), 0);
    assert_eq!(l.bal(&l.base_vault), SUPPLY + 4 * MAX_WALLET);
}

#[test]
fn everything_is_allowed_once_the_guard_ends() {
    let mut l = Launch::new(true);
    let (alice_ata, bob_ata) = (l.alice_ata, l.bob_ata);
    let alice = l.alice.insecure_clone();
    l.fund(&alice_ata, 1_000);
    l.at(GUARD_SECS - 1);
    l.send(&alice, &alice_ata, &bob_ata, 1)
        .expect_error(HookError::TransfersLocked, "one second before");
    l.buy(&bob_ata, MAX_BUY + 1)
        .expect_error(HookError::MaxBuy, "one second before");

    l.at(GUARD_SECS);
    l.send(&alice, &alice_ata, &bob_ata, 1_000)
        .expect_ok("p2p at guard end");
    l.buy(&bob_ata, 3 * MAX_WALLET)
        .expect_ok("whale buy at guard end");
    assert_eq!(l.bal(&bob_ata), 1_000 + 3 * MAX_WALLET);
}

/// Audit 3 (F2): Token-2022 `SetAuthority(AccountOwner)` hands a token
/// account, with its tokens, to another owner without a transfer, so the
/// hook never sees it: buyers could fill accounts and hand them to one
/// wallet past the p2p lock and max_wallet. While the guard is on, the hook
/// now refuses every transfer that is not a sell into an account without
/// Token-2022's ImmutableOwner extension (`MutableOwner`), unless an exempt
/// owner holds it: buys, batch claims and wallet transfers alike, ahead of
/// the lock and the caps. ATAs (always ImmutableOwner) and other accounts
/// with the extension receive as before, and Token-2022 refuses to hand
/// them to another owner; the snipe shield, zero amounts, sells and
/// everything after the guard are unchanged.
#[test]
fn receiving_accounts_need_an_immutable_owner_during_the_guard() {
    let mut l = Launch::new(true);
    let (mint, alice_ata, batch_ata) = (l.mint, l.alice_ata, l.batch_ata);
    let (alice, batch) = (l.alice.insecure_clone(), l.batch.insecure_clone());
    let a = alice.pubkey();
    let plain = l.h.create_token_account(&a, &mint);
    let fixed = l.h.create_immutable_owner_token_account(&a, &mint);
    let for_batch = l.h.create_token_account(&batch.pubkey(), &mint);
    for (what, account, immutable) in [
        ("alice's ATA", alice_ata, true),
        ("the batch authority's ATA", batch_ata, true),
        ("a plain account", plain, false),
        ("a plain account with ImmutableOwner", fixed, true),
        ("a plain account of the batch authority", for_batch, false),
    ] {
        assert_eq!(l.h.has_immutable_owner(&account), immutable, "{what}");
    }

    // The snipe shield still decides buys first; batch claims (out of an
    // exempt owner) need an ImmutableOwner account like everything else.
    l.at(0);
    l.buy(&plain, 1)
        .expect_error(HookError::SnipeShield, "buy into a plain account, shield");
    l.fund(&batch_ata, 10_000);
    l.send(&batch, &batch_ata, &plain, 1_000)
        .expect_error(HookError::MutableOwner, "claim into a plain account");
    l.send(&batch, &batch_ata, &fixed, 1_000)
        .expect_ok("claim into a plain account with ImmutableOwner");
    l.send(&batch, &batch_ata, &alice_ata, 1_000)
        .expect_ok("claim into an ATA");

    l.at(SHIELD_SECS);
    l.buy(&plain, 1)
        .expect_error(HookError::MutableOwner, "buy into a plain account");
    l.buy(&plain, MAX_BUY + 1)
        .expect_error(HookError::MutableOwner, "checked before max_buy");
    l.buy(&plain, 0).expect_ok("a zero-amount buy");
    l.buy(&fixed, MAX_BUY)
        .expect_ok("buy into a plain account with ImmutableOwner");
    l.buy(&for_batch, 3 * MAX_WALLET)
        .expect_ok("an exempt owner's plain account");
    l.send(&alice, &alice_ata, &plain, 10)
        .expect_error(HookError::MutableOwner, "checked before the p2p lock");
    l.send(&alice, &alice_ata, &fixed, 10)
        .expect_error(HookError::TransfersLocked, "p2p, locked");
    // What the rule closes (the audit's PoC): a token account a buy or a
    // claim reached during the guard keeps its owner field, Token-2022
    // refuses to reassign it; only an account without the extension could
    // be reassigned, and no transfer reaches one. (Control of the owner
    // itself, such as a PQ vault's key or a multisig, is out of its scope.)
    let other_wallet = Pubkey::new_unique();
    for (what, account) in [
        ("alice's ATA", alice_ata),
        ("a plain account with ImmutableOwner", fixed),
    ] {
        l.h.try_reassign_owner(&account, &alice, &other_wallet)
            .expect_custom(TokenError::ImmutableOwner as u32, what);
    }
    // Sells never depend on it (only test setup can fund a plain account
    // during the guard: no transfer can).
    l.fund(&plain, 5_000);
    l.sell(&alice, &plain, 5_000)
        .expect_ok("sell from a plain account during the guard");
    l.at(GUARD_SECS - 1);
    l.buy(&plain, 1)
        .expect_error(HookError::MutableOwner, "last second of the guard");
    l.at(GUARD_SECS);
    l.buy(&plain, 3 * MAX_WALLET)
        .expect_ok("buy into a plain account at the guard's end");
    l.send(&alice, &alice_ata, &plain, 10)
        .expect_ok("p2p into a plain account at the guard's end");
    assert_eq!(l.bal(&plain), 3 * MAX_WALLET + 10);
    assert_eq!(l.bal(&fixed), 1_000 + MAX_BUY);

    // Without the lock, wallet transfers into plain accounts are refused
    // the same way, and into ATAs they pass.
    let mut u = Launch::new(false);
    let (ua, ub) = (u.alice_ata, u.bob_ata);
    let ualice = u.alice.insecure_clone();
    let uplain = u.h.create_token_account(&ualice.pubkey(), &u.mint);
    u.fund(&ua, 1_000);
    u.at(SHIELD_SECS);
    u.send(&ualice, &ua, &uplain, 10).expect_error(
        HookError::MutableOwner,
        "p2p into a plain account, lock off",
    );
    u.send(&ualice, &ua, &ub, 10)
        .expect_ok("p2p into an ATA, lock off");
}

/// During the snipe shield the only buy that passes is the batch buy: a
/// transfer out of the base vault inside the launchpad's top-level
/// `execute_batch` instruction. The hook reads that instruction from the
/// instructions sysvar, so a top-level instruction that only looks like
/// it (`execute_batch`'s discriminator from another program id), another
/// launchpad instruction, a separate buy next to `execute_batch`, and an
/// `execute_batch` reached through a CPI are all refused.
#[test]
fn only_a_buy_inside_execute_batch_passes_the_snipe_shield() {
    let mut l = Launch::new(true);
    let impostor = Pubkey::new_unique();
    l.h.add_relay(LAUNCHPAD_PROGRAM_ID);
    l.h.add_relay(impostor);
    let (mint, base_vault, batch_ata, alice_ata) = (l.mint, l.base_vault, l.batch_ata, l.alice_ata);
    let pool = l.pool_authority.insecure_clone();
    let buy =
        l.h.transfer_ix(&mint, &base_vault, &batch_ata, &pool.pubkey(), 2 * MAX_BUY);
    let execute_batch = EXECUTE_BATCH_DISCRIMINATOR;
    assert_eq!(
        execute_batch,
        anchor_discriminator("global", "execute_batch")
    );
    l.at(1);

    let commit = anchor_discriminator("global", "commit");
    let nested = relay_ix(&LAUNCHPAD_PROGRAM_ID, execute_batch, &buy);
    let refused = [
        (
            "execute_batch's discriminator from another program",
            vec![relay_ix(&impostor, execute_batch, &buy)],
        ),
        (
            "another launchpad instruction",
            vec![relay_ix(&LAUNCHPAD_PROGRAM_ID, commit, &buy)],
        ),
        (
            "a plain buy next to execute_batch",
            vec![
                relay_noop_ix(&LAUNCHPAD_PROGRAM_ID, execute_batch),
                buy.clone(),
            ],
        ),
        (
            "execute_batch reached through a CPI",
            vec![relay_ix(&impostor, execute_batch, &nested)],
        ),
    ];
    for (what, ixs) in refused {
        l.h.send_v1(&ixs, &[&pool])
            .expect_error(HookError::SnipeShield, what);
    }
    assert_eq!(l.bal(&batch_ata), 0);

    // The batch buy itself, here in the last second of the shield.
    l.at(SHIELD_SECS - 1);
    l.h.send_v1(
        &[relay_ix(&LAUNCHPAD_PROGRAM_ID, execute_batch, &buy)],
        &[&pool],
    )
    .expect_ok("the buy inside execute_batch");
    assert_eq!(l.bal(&batch_ata), 2 * MAX_BUY);
    // Inside execute_batch the other rules still apply to a non-exempt recipient.
    let to_alice =
        l.h.transfer_ix(&mint, &base_vault, &alice_ata, &pool.pubkey(), MAX_BUY + 1);
    l.h.send_v1(
        &[relay_ix(&LAUNCHPAD_PROGRAM_ID, execute_batch, &to_alice)],
        &[&pool],
    )
    .expect_error(
        HookError::MaxBuy,
        "batch context, non-exempt recipient over max_buy",
    );
    assert_eq!(l.bal(&alice_ata), 0);
}

#[test]
fn mints_without_a_policy_are_unrestricted() {
    let mut h = Harness::new();
    let mint = h.create_mint(TOKEN_2022_PROGRAM_ID, DECIMALS, Some(HOOK_ID));
    h.init_meta_list(&mint);
    let (alice, bob) = (h.funded_keypair(1), Keypair::new());
    let alice_ata = h.create_ata(&alice.pubkey(), &mint);
    let bob_ata = h.create_ata(&bob.pubkey(), &mint);
    h.mint_to(&mint, &alice_ata, SUPPLY);
    h.transfer(&mint, &alice_ata, &bob_ata, &alice, SUPPLY / 2)
        .expect_ok("no policy: anything goes");

    // Lamports sent to the empty policy PDA (anyone can) do not change that.
    let pda = policy_pda(&mint).0;
    let fund = solana_system_interface::instruction::transfer(&h.payer.pubkey(), &pda, 1_000_000);
    h.send(&[fund], &[]).expect_ok("fund the policy PDA");
    assert_eq!(
        h.account(&pda).unwrap().owner,
        anchor_lang::system_program::ID
    );
    h.transfer(&mint, &alice_ata, &bob_ata, &alice, SUPPLY / 2)
        .expect_ok("still unrestricted");
    assert_eq!(h.balance(&bob_ata), SUPPLY);
}

#[test]
fn hooked_transfers_fail_closed_without_their_accounts() {
    let mut l = Launch::new(true);
    l.at(GUARD_SECS); // the rules allow everything now: only accounts can fail
    let (mint, alice_ata, bob_ata) = (l.mint, l.alice_ata, l.bob_ata);
    let alice = l.alice.insecure_clone();
    l.fund(&alice_ata, 1_000);
    let full =
        l.h.transfer_ix(&mint, &alice_ata, &bob_ata, &alice.pubkey(), 10);
    assert_eq!(full.accounts.len(), 4 + 4);
    let [policy, sysvar, program, list] = [4, 5, 6, 7].map(|i| full.accounts[i].clone());
    assert_eq!(sysvar.pubkey, INSTRUCTIONS_SYSVAR_ID);
    let with = |extra: Vec<AccountMeta>| {
        let mut ix = full.clone();
        ix.accounts.truncate(4);
        ix.accounts.extend(extra);
        ix
    };
    let other_policy = AccountMeta::new_readonly(policy_pda(&Pubkey::new_unique()).0, false);
    // Token-2022 cannot even find the hook program.
    l.h.send(&[with(vec![])], &[&alice])
        .expect_instruction_error(InstructionError::MissingAccount, "no extra accounts");
    // Without the meta list Token-2022 calls the hook with only the four
    // transfer accounts, and the hook refuses to run without its policy.
    for (what, extra) in [
        ("hook program only", vec![program.clone()]),
        (
            "policy, sysvar and program, no meta list",
            vec![policy.clone(), sysvar.clone(), program.clone()],
        ),
    ] {
        l.h.send(&[with(extra)], &[&alice])
            .expect_error(AnchorError::AccountNotEnoughKeys, what);
    }
    // With the meta list, Token-2022 itself insists on the derived policy PDA
    // and the instructions sysvar (no stand-in for either).
    let impostor_sysvar = AccountMeta::new_readonly(Pubkey::new_unique(), false);
    for (what, extra) in [
        (
            "program and meta list only",
            vec![program.clone(), list.clone()],
        ),
        (
            "no policy",
            vec![sysvar.clone(), program.clone(), list.clone()],
        ),
        (
            "no instructions sysvar",
            vec![policy.clone(), program.clone(), list.clone()],
        ),
        (
            "another account as the sysvar",
            vec![
                policy.clone(),
                impostor_sysvar,
                program.clone(),
                list.clone(),
            ],
        ),
        (
            "another mint's policy",
            vec![other_policy, sysvar.clone(), program.clone(), list.clone()],
        ),
    ] {
        l.h.send(&[with(extra)], &[&alice])
            .expect_custom(AccountResolutionError::IncorrectAccount as u32, what);
    }
    assert_eq!((l.bal(&alice_ata), l.bal(&bob_ata)), (1_000, 0));

    // A corrupt or foreign policy account also refuses instead of allowing.
    let original = l.h.policy(&mint).expect("policy");
    let mut garbage = vec![0u8; 8 + HookPolicy::INIT_SPACE];
    garbage[8] = 1;
    l.h.inject_raw_policy(&mint, garbage);
    l.h.send(std::slice::from_ref(&full), &[&alice])
        .expect_error(AnchorError::AccountDiscriminatorMismatch, "corrupt policy");
    let mut foreign = original.clone();
    foreign.mint = Pubkey::new_unique();
    let mut data = Vec::new();
    anchor_lang::AccountSerialize::try_serialize(&foreign, &mut data).unwrap();
    l.h.inject_raw_policy(&mint, data);
    l.h.send(std::slice::from_ref(&full), &[&alice])
        .expect_error(HookError::PolicyMismatch, "policy of another mint");
    assert_eq!(l.bal(&bob_ata), 0);

    // Restored, the very same instruction goes through.
    l.h.inject_policy(&original);
    l.h.send(&[full], &[&alice])
        .expect_ok("all accounts present");
    assert_eq!(l.bal(&bob_ata), 10);
}

#[test]
fn compute_cost_of_a_hooked_transfer() {
    // Baselines: wallet-to-wallet transfer_checked without a hook.
    let mut h = Harness::new();
    let owner = h.funded_keypair(1);
    let mut baseline = |label: &str, token_program: Pubkey| -> u64 {
        let mint = h.create_mint(token_program, DECIMALS, None);
        let from = h.create_ata(&owner.pubkey(), &mint);
        let to = h.create_ata(&Pubkey::new_unique(), &mint);
        h.mint_to(&mint, &from, 1_000);
        let sent = h.transfer(&mint, &from, &to, &owner, 10).expect_ok(label);
        let cu = program_cu(&sent.logs, &token_program);
        report(&format!("transfer_checked CU, {label}"), cu);
        cu
    };
    let spl = baseline("SPL Token (p-token)", TOKEN_PROGRAM_ID);
    let plain = baseline("Token-2022, no hook", TOKEN_2022_PROGRAM_ID);

    // Every hooked case on one mint: Token-2022 derives the meta list and the
    // policy PDA on-chain, and each bump step of those searches costs ~1.5k
    // CU, so costs are only comparable for the same mint (bumps reported).
    let mut l = Launch::new(false);
    let (mint, alice_ata, bob_ata) = (l.mint, l.alice_ata, l.bob_ata);
    let alice = l.alice.insecure_clone();
    let (pda, bump) = policy_pda(&mint);
    let list_bump =
        Pubkey::find_program_address(&[b"extra-account-metas", mint.as_ref()], &HOOK_ID).1;
    report(
        "meta list / policy PDA bumps of the measured mint",
        format!("{list_bump} / {bump}"),
    );
    l.fund(&alice_ata, 1_000_000);
    let hooked = |l: &mut Launch, label: &str, sell: bool| -> u64 {
        let sent = if sell {
            l.sell(&alice, &alice_ata, 10)
        } else {
            l.send(&alice, &alice_ata, &bob_ata, 10)
        }
        .expect_ok(label);
        let total = program_cu(&sent.logs, &TOKEN_2022_PROGRAM_ID);
        let hook = invocations_cu(&sent.logs, &HOOK_ID);
        assert_eq!(hook.len(), 1, "{label}: the hook runs exactly once");
        report(
            &format!("transfer_checked CU, Launch Guard, {label}"),
            format!("{total} (hook execute {})", hook[0]),
        );
        total
    };
    // The batch buy during the shield: the only case that reads the sysvar.
    l.h.add_relay(LAUNCHPAD_PROGRAM_ID);
    let (base_vault, batch_ata, pool) =
        (l.base_vault, l.batch_ata, l.pool_authority.insecure_clone());
    let buy =
        l.h.transfer_ix(&mint, &base_vault, &batch_ata, &pool.pubkey(), 10);
    let sent =
        l.h.send_v1(
            &[relay_ix(
                &LAUNCHPAD_PROGRAM_ID,
                EXECUTE_BATCH_DISCRIMINATOR,
                &buy,
            )],
            &[&pool],
        )
        .expect_ok("batch buy");
    let hook = invocations_cu(&sent.logs, &HOOK_ID);
    assert_eq!(hook.len(), 1);
    report(
        "Launch Guard execute CU, batch buy during the shield (reads the instructions sysvar)",
        hook[0],
    );
    l.at(SHIELD_SECS);
    let all_rules = hooked(&mut l, "mid-guard, every rule evaluated", false);
    let sell = hooked(&mut l, "sell fast path", true);
    l.at(GUARD_SECS);
    let after = hooked(&mut l, "after the guard", false);
    let policy = l.h.account(&pda).expect("policy");
    l.h.set_account(pda, Account::default());
    let no_policy = hooked(&mut l, "mint without a policy", false);
    l.h.set_account(pda, policy);
    report(
        "Launch Guard overhead CU over plain Token-2022 (every rule)",
        all_rules - plain,
    );

    assert!(spl > 0 && plain > spl);
    assert!(no_policy > plain && sell > plain && after > plain);
    // Regression guard: the whole hooked transfer stays cheap.
    assert!(all_rules < 40_000, "hooked transfer costs {all_rules} CU");
}

// ------------------------------------------- creator rules (PXR1, §1.2)

/// One condition node: `op | a | u64le arg`.
fn rule_node(op: u8, a: u8, arg: u64) -> Vec<u8> {
    let mut n = vec![op, a];
    n.extend_from_slice(&arg.to_le_bytes());
    n
}

/// A PXR1 rule set written from the documented layout: header, keys, rules
/// `(from, to, effect, code, arg, condition)` with their conditions back to
/// back, then the nodes.
/// One rule: `(from, to, effect, code, arg, condition nodes)`.
type RuleSpec = (u32, u32, u8, u8, u64, Vec<Vec<u8>>);

fn pxr1(keys: &[Pubkey], rules: &[RuleSpec]) -> Vec<u8> {
    let n_nodes: usize = rules.iter().map(|r| r.5.len()).sum();
    let mut b = b"PXR1".to_vec();
    b.extend_from_slice(&[
        1,
        keys.len() as u8,
        rules.len() as u8,
        n_nodes as u8,
        0,
        0,
        0,
        0,
    ]);
    for k in keys {
        b.extend_from_slice(k.as_ref());
    }
    let mut off = 0u8;
    for (from, to, effect, code, arg, cond) in rules {
        b.extend_from_slice(&from.to_le_bytes());
        b.extend_from_slice(&to.to_le_bytes());
        b.extend_from_slice(&[off, cond.len() as u8, *effect, *code]);
        b.extend_from_slice(&arg.to_le_bytes());
        off += cond.len() as u8;
    }
    for (.., cond) in rules {
        for n in cond {
            b.extend_from_slice(n);
        }
    }
    b
}

const RULE_DENY: u8 = 1;
const RULE_CAP_AMOUNT: u8 = 2;
const RULE_AND: u8 = 0x02;
const RULE_IS_BUY: u8 = 0x10;
const RULE_IS_P2P: u8 = 0x11;
const RULE_TOP_PROGRAM_IN: u8 = 0x18;
const RULE_TX_IX_COUNT_GT: u8 = 0x19;
const RULE_BPS: u64 = 1 << 63;

/// `create_policy` verifies the creator's rules for the policy's own guard
/// (`InvalidRules`) and stores them as given, the account sized to them.
#[test]
fn create_policy_verifies_and_stores_the_creator_rules() {
    let mut h = Harness::new();
    h.add_relay(LAUNCHPAD_PROGRAM_ID);
    let mint = h.create_mint(TOKEN_2022_PROGRAM_ID, DECIMALS, Some(HOOK_ID));
    h.init_meta_list(&mint);
    let holder = h.create_ata(&Pubkey::new_unique(), &mint);
    h.mint_to(&mint, &holder, SUPPLY);
    let pool = dbc_pool_account(&mut h);
    let params = |rules: Vec<u8>, guard: u32| PolicyParams {
        pool,
        snipe_shield_secs: u32::try_from(SHIELD_SECS).expect("shield secs"),
        guard_secs: guard,
        max_wallet: 0,
        max_buy: 0,
        p2p_locked: false,
        exempt: [Pubkey::default(); 4],
        rules,
    };
    let payer = h.payer.pubkey();
    let launch = anchor_discriminator("global", "launch");
    let create = |h: &mut Harness, p: PolicyParams| {
        let ix = create_policy_ix(&payer, &hook_authority(), true, &mint, &pool, p);
        h.send(
            &[as_hook_authority_cpi(&LAUNCHPAD_PROGRAM_ID, launch, &ix, 1)],
            &[],
        )
    };
    let deny_buys_until = |to: u32| {
        pxr1(
            &[],
            &[(0, to, RULE_DENY, 9, 0, vec![rule_node(RULE_IS_BUY, 0, 0)])],
        )
    };
    for (what, p) in [
        ("not a rule set", params(b"PXR1".to_vec(), 3_600)),
        (
            "a window past the guard",
            params(deny_buys_until(3_601), 3_600),
        ),
        (
            "a window past a shorter guard",
            params(deny_buys_until(1_000), 999),
        ),
        ("a DENY with a cap", {
            let mut b = deny_buys_until(600);
            b[24..32].copy_from_slice(&1u64.to_le_bytes());
            params(b, 3_600)
        }),
    ] {
        create(&mut h, p).expect_error(HookError::InvalidRules, what);
    }
    assert!(h.policy(&mint).is_none());
    let rules = deny_buys_until(3_600);
    let sent = create(&mut h, params(rules.clone(), 3_600)).expect_ok("valid rules");
    let policy = h.policy(&mint).expect("policy");
    assert_eq!(policy.rules, rules);
    assert_eq!(policy.version, 2);
    let account = h.account(&policy_pda(&mint).0).expect("policy account");
    assert_eq!(account.data.len(), 279 + rules.len(), "sized to the rules");
    assert_eq!(&account.data[275..279], &(rules.len() as u32).to_le_bytes());
    assert_eq!(&account.data[279..], &rules[..]);
    let event = anchor_events(&sent.logs, "PolicyCreated");
    assert_eq!(event.len(), 1);
    assert_eq!(
        event[0][event[0].len() - 2..],
        (rules.len() as u16).to_le_bytes(),
        "PolicyCreated ends with the rules' length"
    );
}

/// Rules read the transaction's current top-level instruction (a transfer
/// made inside another program is that program's), the number of top-level
/// instructions, and the mint's current supply (caps in basis points).
#[test]
fn creator_rules_read_the_top_level_program_the_instruction_count_and_the_supply() {
    let mut l = Launch::new(false);
    let wrapper = Pubkey::new_unique();
    let other = Pubkey::new_unique();
    l.h.add_relay(wrapper);
    l.h.add_relay(other);
    let mut policy = l.h.policy(&l.mint).expect("policy");
    policy.rules = pxr1(
        &[wrapper],
        &[
            // No wallet transfer made inside `wrapper`.
            (
                0,
                3_600,
                RULE_DENY,
                7,
                0,
                vec![
                    rule_node(RULE_IS_P2P, 0, 0),
                    rule_node(RULE_TOP_PROGRAM_IN, 1, 0),
                    rule_node(RULE_AND, 0, 0),
                ],
            ),
            // No wallet transfer in a transaction of more than 2 top-level
            // instructions (`send` adds a compute-budget instruction).
            (
                0,
                3_600,
                RULE_DENY,
                8,
                0,
                vec![
                    rule_node(RULE_IS_P2P, 0, 0),
                    rule_node(RULE_TX_IX_COUNT_GT, 0, 2),
                    rule_node(RULE_AND, 0, 0),
                ],
            ),
            // At most 0.01% of the supply per transfer.
            (
                0,
                3_600,
                RULE_CAP_AMOUNT,
                9,
                RULE_BPS | 1,
                vec![rule_node(0x00, 0, 0)],
            ),
        ],
    );
    l.h.inject_policy(&policy);
    let (mint, alice_ata, bob_ata) = (l.mint, l.alice_ata, l.bob_ata);
    let alice = l.alice.insecure_clone();
    l.fund(&alice_ata, 1_000_000_000_000);
    l.at(SHIELD_SECS);
    let rule = |r: TxResult, index: u8, code: u8, what: &str| {
        let f = r.expect_error(HookError::RuleDenied, what);
        let line = format!("Launch rule {index} (code {code}) refused the transfer");
        assert!(
            f.logs.iter().any(|l| l.contains(&line)),
            "{what}: no `{line}`"
        );
    };
    let transfer =
        l.h.transfer_ix(&mint, &alice_ata, &bob_ata, &alice.pubkey(), 10);
    l.send(&alice, &alice_ata, &bob_ata, 10)
        .expect_ok("a direct transfer");
    let tag = anchor_discriminator("global", "any");
    rule(
        l.h.send(&[relay_ix(&wrapper, tag, &transfer)], &[&alice]),
        0,
        7,
        "a transfer inside the wrapper",
    );
    l.h.send(&[relay_ix(&other, tag, &transfer)], &[&alice])
        .expect_ok("a transfer inside another program");
    rule(
        l.h.send(&[relay_noop_ix(&other, tag), transfer.clone()], &[&alice]),
        1,
        8,
        "a transfer in 3 top-level instructions",
    );
    // A buy made inside the wrapper is no wallet transfer.
    let pool = l.pool_authority.insecure_clone();
    let (base_vault, bob) = (l.base_vault, l.bob_ata);
    let buy =
        l.h.transfer_ix(&mint, &base_vault, &bob, &pool.pubkey(), 10);
    l.h.send(&[relay_ix(&wrapper, tag, &buy)], &[&pool])
        .expect_ok("a buy inside the wrapper");
    // The cap follows the current supply: 0.01% of it.
    let supply = SUPPLY + 1_000_000_000_000;
    let cap = supply / 10_000;
    rule(
        l.send(&alice, &alice_ata, &bob_ata, cap + 1),
        2,
        9,
        "over 0.01% of the supply",
    );
    l.send(&alice, &alice_ata, &bob_ata, cap)
        .expect_ok("0.01% of the supply");
    l.fund(&alice_ata, 10_000 * 10_000);
    l.send(&alice, &alice_ata, &bob_ata, cap + 10_000)
        .expect_ok("0.01% of the grown supply");
    assert_eq!(l.bal(&bob_ata), 10 + 10 + 10 + cap + cap + 10_000);
}

// ------------------------------------------------ review 4 (P1c): R3, Rb

/// Review 4, R3 (honeypot-freedom): `execute` decides sells and everything
/// after the guard from the policy's head (discriminator, then `mint`,
/// `base_vault` and `guard_end_ts` at fixed offsets) before it decodes the
/// rest, so no layout of the rest can block them. A version-1 policy (275
/// bytes, no `rules` length; the reviewer's R4-4 found every transfer of
/// such a mint failing after an in-place upgrade, sells included), a policy
/// whose `rules` length runs past its end, and an account that is only the
/// head: sells pass during the guard, and everything passes once it ends;
/// what needs the rest of the policy (buys and wallet transfers during the
/// guard) fails closed (`AccountDidNotDeserialize`). A head of another mint
/// is still refused, sells included (`PolicyMismatch`).
#[test]
fn sells_and_the_guard_end_never_decode_the_whole_policy() {
    let mut l = Launch::new(true);
    let (mint, alice_ata, bob_ata) = (l.mint, l.alice_ata, l.bob_ata);
    let alice = l.alice.insecure_clone();
    l.fund(&alice_ata, 1_000_000);
    let policy = l.h.policy(&mint).expect("policy");
    let mut v2 = Vec::new();
    anchor_lang::AccountSerialize::try_serialize(&policy, &mut v2).unwrap();
    assert_eq!(v2.len(), 279);
    let mut past_its_end = v2.clone();
    past_its_end[275..279].copy_from_slice(&1_000u32.to_le_bytes());
    past_its_end.extend_from_slice(&[7; 10]);
    let layouts: [(&str, Vec<u8>); 3] = [
        ("a version-1 policy (275 bytes)", v2[..275].to_vec()),
        ("rules running past the account", past_its_end),
        ("only the head (130 bytes)", v2[..130].to_vec()),
    ];
    l.at(SHIELD_SECS);
    for (what, data) in &layouts {
        l.h.inject_raw_policy(&mint, data.clone());
        l.sell(&alice, &alice_ata, 10)
            .expect_ok(&format!("{what}: a sell during the guard"));
        l.send(&alice, &alice_ata, &bob_ata, 10).expect_error(
            AnchorError::AccountDidNotDeserialize,
            &format!("{what}: a wallet transfer during the guard"),
        );
        l.buy(&bob_ata, 10).expect_error(
            AnchorError::AccountDidNotDeserialize,
            &format!("{what}: a buy during the guard"),
        );
    }
    // Shorter than the head, or another mint's head: refused, sells too.
    l.h.inject_raw_policy(&mint, v2[..129].to_vec());
    l.sell(&alice, &alice_ata, 10)
        .expect_error(AnchorError::AccountDidNotDeserialize, "129 bytes");
    let mut foreign = v2.clone();
    foreign[10..42].copy_from_slice(Pubkey::new_unique().as_ref());
    l.h.inject_raw_policy(&mint, foreign);
    l.sell(&alice, &alice_ata, 10)
        .expect_error(HookError::PolicyMismatch, "another mint's head");
    l.h.inject_policy(&policy);
    l.sell(&alice, &alice_ata, 10)
        .expect_ok("the policy restored");
    l.at(GUARD_SECS);
    for (what, data) in &layouts {
        l.h.inject_raw_policy(&mint, data.clone());
        l.send(&alice, &alice_ata, &bob_ata, 10)
            .expect_ok(&format!("{what}: a wallet transfer after the guard"));
        l.buy(&bob_ata, 10)
            .expect_ok(&format!("{what}: a buy after the guard"));
        l.sell(&alice, &alice_ata, 10)
            .expect_ok(&format!("{what}: a sell after the guard"));
    }
    assert_eq!(l.bal(&bob_ata), 3 * 20);
}

/// Review 4, Rb: the supply and the top-level instructions are read only
/// for a transfer that reaches the creator rules, so a policy with rules
/// costs a claim, the batch buy, a buy into an exempt owner and a sell no
/// more than one without (beyond decoding the longer policy), while a buy
/// and a wallet transfer under rules pay for what the rules read. The hook's
/// own compute per case, on one mint (same PDA bumps), with and without
/// rules, is reported.
#[test]
fn creator_rules_cost_only_the_transfers_they_decide() {
    let mut l = Launch::new(false);
    l.h.add_relay(LAUNCHPAD_PROGRAM_ID);
    let (mint, alice_ata, bob_ata, batch_ata) = (l.mint, l.alice_ata, l.bob_ata, l.batch_ata);
    let (alice, batch, pool) = (
        l.alice.insecure_clone(),
        l.batch.insecure_clone(),
        l.pool_authority.insecure_clone(),
    );
    l.fund(&alice_ata, 1_000_000);
    l.fund(&batch_ata, 1_000_000);
    let bare = l.h.policy(&mint).expect("policy");
    // No wallet transfer in a transaction of more than 9 top-level
    // instructions, and at most 1% of the supply per transfer.
    let ruled = HookPolicy {
        rules: pxr1(
            &[],
            &[
                (
                    0,
                    3_600,
                    RULE_DENY,
                    7,
                    0,
                    vec![
                        rule_node(RULE_IS_P2P, 0, 0),
                        rule_node(RULE_TX_IX_COUNT_GT, 0, 9),
                        rule_node(RULE_AND, 0, 0),
                    ],
                ),
                (
                    0,
                    3_600,
                    RULE_CAP_AMOUNT,
                    8,
                    RULE_BPS | 100,
                    vec![rule_node(0x00, 0, 0)],
                ),
            ],
        ),
        ..bare.clone()
    };
    let hook_cu = |sent: Sent| -> u64 {
        let hook = invocations_cu(&sent.logs, &HOOK_ID);
        assert_eq!(hook.len(), 1, "the hook runs exactly once");
        hook[0]
    };
    let cases = [
        "batch buy (shield, exempt escrow)",
        "buy",
        "wallet transfer",
        "claim (exempt source)",
        "buy into an exempt owner",
        "sell",
    ];
    let exempt_ata = l.launch_authority_ata;
    let base_vault = l.base_vault;
    let mut cu = [[0u64; 2]; 6];
    l.at(1);
    for (column, policy) in [&bare, &ruled].into_iter().enumerate() {
        l.h.inject_policy(policy);
        let buy =
            l.h.transfer_ix(&mint, &base_vault, &batch_ata, &pool.pubkey(), 10);
        cu[0][column] = hook_cu(
            l.h.send_v1(
                &[relay_ix(
                    &LAUNCHPAD_PROGRAM_ID,
                    EXECUTE_BATCH_DISCRIMINATOR,
                    &buy,
                )],
                &[&pool],
            )
            .expect_ok(cases[0]),
        );
    }
    l.at(SHIELD_SECS);
    for (column, policy) in [&bare, &ruled].into_iter().enumerate() {
        l.h.inject_policy(policy);
        cu[1][column] = hook_cu(l.buy(&bob_ata, 10).expect_ok(cases[1]));
        cu[2][column] = hook_cu(l.send(&alice, &alice_ata, &bob_ata, 10).expect_ok(cases[2]));
        cu[3][column] = hook_cu(
            l.send(&batch, &batch_ata, &alice_ata, 10)
                .expect_ok(cases[3]),
        );
        cu[4][column] = hook_cu(l.buy(&exempt_ata, 10).expect_ok(cases[4]));
        cu[5][column] = hook_cu(l.sell(&alice, &alice_ata, 10).expect_ok(cases[5]));
    }
    for (case, [without, with]) in cases.iter().zip(cu) {
        report(
            &format!("Launch Guard execute CU, {case}"),
            format!("{without} without rules, {with} with rules"),
        );
    }
    // Decoding the 66 more bytes of the ruled policy costs a little; reading
    // the instructions sysvar and the supply would cost far more.
    for i in [0, 3, 4] {
        assert!(
            cu[i][1] <= cu[i][0] + 150,
            "{}: {} with rules, {} without",
            cases[i],
            cu[i][1],
            cu[i][0]
        );
    }
    assert_eq!(cu[5][1], cu[5][0], "a sell never decodes the policy");
    // Without rules nothing reads them: a buy or a wallet transfer costs
    // about what a claim does.
    for i in [1, 2] {
        assert!(
            cu[i][0] <= cu[3][0] + 150,
            "{} without rules: {} (a claim: {})",
            cases[i],
            cu[i][0],
            cu[3][0]
        );
    }
    for i in [1, 2] {
        assert!(cu[i][1] > cu[i][0] + 150, "{}: the rules read", cases[i]);
    }
}

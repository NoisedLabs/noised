//! Which base mints can be shielded, and how transfer fees and transfer
//! hooks (the Noised Launch Guard) behave through wrap/unwrap.

mod common;

use anchor_lang::{
    prelude::Pubkey, solana_program::system_instruction, AccountSerialize, Discriminator,
};
use anchor_spl::token_2022::spl_token_2022::{
    extension::{
        immutable_owner::ImmutableOwner, BaseStateWithExtensions, ExtensionType,
        StateWithExtensions,
    },
    instruction as t22_ix,
    state::Account as TokenAccountState,
};
use common::*;
use noised_hook::{state::HookPolicy, HookError};
use noised_shield::{error::ShieldError, Wrapped};
use solana_signer::Signer;

fn metadata(name: &str, symbol: &str) -> Ext {
    Ext::Metadata {
        name: name.into(),
        symbol: symbol.into(),
        uri: format!("https://noised.example/{symbol}.json"),
    }
}

#[test]
fn refuses_every_base_mint_extension_outside_the_allowlist() {
    let mut env = Env::new();
    let payer = env.payer.pubkey();
    let refused = [
        Ext::PermanentDelegate,
        Ext::NonTransferable,
        Ext::Pausable,
        Ext::DefaultAccountState,
        Ext::MintCloseAuthority,
        Ext::InterestBearing,
        Ext::ScaledUiAmount,
        Ext::GroupPointer,
        Ext::ConfidentialTransferMint,
        Ext::PermissionedBurn,
    ];
    for ext in refused {
        // Also next to allowed extensions: one bad extension is enough.
        for exts in [vec![ext.clone()], vec![metadata("Bad", "BAD"), ext.clone()]] {
            let base = env.create_t22_mint(6, &exts);
            let s = ShieldKeys::new(base, T22);
            let result = env.send(&[create_shield_ix(&payer, &s)], &[]);
            assert_error(result, ShieldError::UnsupportedExtension);
            assert!(
                env.data(&s.shield).is_empty(),
                "{exts:?}: shield must not exist"
            );
            assert!(
                env.data(&s.z_mint).is_empty(),
                "{exts:?}: zToken must not exist"
            );
        }
    }
}

#[test]
fn a_ztoken_cannot_be_shielded_again() {
    let mut env = Env::new();
    let payer = env.payer.pubkey();
    let base = env.create_spl_mint(6);
    let s = ShieldKeys::new(base, SPL);
    env.ok(&[create_shield_ix(&payer, &s)], &[]);
    let zz = ShieldKeys::new(s.z_mint, T22);
    let result = env.send(&[create_shield_ix(&payer, &zz)], &[]);
    assert_error(result, ShieldError::UnsupportedExtension);
}

#[test]
fn accepts_metadata_transfer_fee_and_transfer_hook_together() {
    let mut env = Env::new().with_hook();
    let base = env.create_t22_mint(
        6,
        &[
            metadata("Everything Allowed", "ALL"),
            Ext::TransferFee {
                bps: 50,
                max: u64::MAX,
            },
            Ext::Hook(noised_hook::ID),
        ],
    );
    let s = ShieldKeys::new(base, T22);
    let payer = env.payer.pubkey();
    env.ok(&[create_shield_ix(&payer, &s)], &[]);
    let uri = "https://noised.example/ALL.json";
    assert_z_mint(&env, &s, 6, "Shielded Everything Allowed", "zALL", uri);
}

#[test]
fn transfer_fees_are_measured_not_trusted() {
    let mut env = Env::new();
    let base = env.create_t22_mint(
        6,
        &[Ext::TransferFee {
            bps: 100,
            max: u64::MAX,
        }],
    );
    let s = ShieldKeys::new(base, T22);
    let payer = env.payer.pubkey();
    env.ok(&[create_shield_ix(&payer, &s)], &[]);
    let (alice, alice_base, alice_z) = env.funded_user(&s, 20_000);
    let a = alice.pubkey();

    // 1% fee: the escrow receives 9_900 of 10_000, so 9_900 zTokens.
    let tx = env
        .send(
            &[wrap_ix(&a, &s, &alice_base, &alice_z, 10_000, &[])],
            &[&alice],
        )
        .unwrap();
    let ev: Wrapped = event(&tx.logs).expect("Wrapped event");
    assert_eq!((ev.amount, ev.minted), (10_000, 9_900));
    assert_eq!(env.balance(&alice_z), 9_900);
    assert_eq!(assert_exactly_backed(&env, &s), 9_900);

    // Unwrapping pays the fee too: 9_900 released, 9_801 arrive.
    let before = env.balance(&alice_base);
    env.ok(
        &[unwrap_ix(&a, &s, &alice_base, &alice_z, 9_900, &[])],
        &[&alice],
    );
    assert_eq!(env.balance(&alice_base) - before, 9_801);
    assert_eq!(assert_exactly_backed(&env, &s), 0);

    // A wrap the fee swallows entirely mints nothing and is refused.
    assert_error(
        env.send(&[wrap_ix(&a, &s, &alice_base, &alice_z, 1, &[])], &[&alice]),
        ShieldError::NothingReceived,
    );
}

/// Install a Launch Guard policy for `mint` directly into the test ledger
/// (on-chain only the launchpad can create one): wallet-to-wallet transfers
/// locked until `guard_end_ts`.
fn lock_p2p_until(env: &mut Env, mint: &Pubkey, guard_end_ts: i64) {
    install_policy(env, mint, guard_end_ts, true);
}

/// `lock_p2p_until`, with the lock on or off.
fn install_policy(env: &mut Env, mint: &Pubkey, guard_end_ts: i64, p2p_locked: bool) {
    install_policy_with(env, mint, guard_end_ts, p2p_locked, vec![]);
}

/// `install_policy` with these creator rules (PXR1 bytes).
fn install_policy_with(
    env: &mut Env,
    mint: &Pubkey,
    guard_end_ts: i64,
    p2p_locked: bool,
    rules: Vec<u8>,
) {
    let (policy_key, bump) =
        Pubkey::find_program_address(&[b"policy", mint.as_ref()], &noised_hook::ID);
    let now = env.svm.get_sysvar::<solana_clock::Clock>().unix_timestamp;
    let policy = HookPolicy {
        version: HookPolicy::VERSION,
        bump,
        mint: *mint,
        pool: Pubkey::new_unique(),
        base_vault: Pubkey::new_unique(),
        launch_ts: now,
        snipe_shield_end_ts: now,
        guard_end_ts,
        max_wallet: 0,
        max_buy: 0,
        p2p_locked,
        exempt: [Pubkey::default(); 4],
        rules,
    };
    let mut data = Vec::new();
    policy.try_serialize(&mut data).unwrap();
    let account = solana_account::Account {
        lamports: env.svm.minimum_balance_for_rent_exemption(data.len()),
        data,
        owner: noised_hook::ID,
        executable: false,
        rent_epoch: 0,
    };
    env.svm.set_account(policy_key, account).unwrap();
}

/// `TransferHookError::IncorrectAccount` (spl-transfer-hook-interface): the
/// hook program is not among the accounts passed for the transfer.
const MISSING_HOOK_PROGRAM: u32 = 2_110_272_652;
/// `AccountResolutionError::IncorrectAccount` (spl-tlv-account-resolution):
/// an extra account of the hook's meta list is not among them.
const MISSING_EXTRA_ACCOUNT: u32 = 2_724_315_840;

/// The Launch Guard meta list: one Execute TLV entry (8-byte discriminator,
/// 4-byte length) holding a pod slice (4-byte count) of 35-byte metas
/// (discriminator, 32-byte address config, is_signer, is_writable).
/// Returns the metas.
fn hook_metas(env: &Env, mint: &Pubkey) -> Vec<[u8; 35]> {
    let data = env.data(&hook_meta_list(mint));
    assert!(
        data.len() >= 16,
        "meta list too short: {} bytes",
        data.len()
    );
    // The entry is keyed by the hook's Execute discriminator.
    assert_eq!(&data[..8], noised_hook::instruction::Execute::DISCRIMINATOR);
    let count = u32::from_le_bytes(data[12..16].try_into().unwrap()) as usize;
    assert_eq!(
        u32::from_le_bytes(data[8..12].try_into().unwrap()) as usize,
        4 + 35 * count
    );
    assert_eq!(data.len(), 16 + 35 * count, "meta list size");
    data[16..].as_chunks::<35>().0.to_vec()
}

#[test]
fn launch_guard_hook_accounts_are_forwarded_and_enforced() {
    let mut env = Env::new().with_hook();
    let exts = [
        metadata("Guarded Launch", "GRD"),
        Ext::Hook(noised_hook::ID),
    ];
    let base = env.create_t22_mint(6, &exts);
    env.init_hook_meta_list(&base);
    // Two extra accounts, both read-only and not signers: the policy PDA
    // (discriminator 1: seeds of the hook program, literal "policy" then the
    // key of account 1, the mint) and the instructions sysvar
    // (discriminator 0: a fixed address).
    let metas = hook_metas(&env, &base);
    assert_eq!(metas.len(), 2);
    let mut policy_seeds = [0u8; 32];
    policy_seeds[..10].copy_from_slice(&[1, 6, b'p', b'o', b'l', b'i', b'c', b'y', 3, 1]);
    assert_eq!(
        (metas[0][0], metas[0][1..33].to_vec()),
        (1, policy_seeds.to_vec())
    );
    let sysvar = noised_hook::INSTRUCTIONS_SYSVAR_ID;
    assert_eq!(
        sysvar.to_string(),
        "Sysvar1nstructions1111111111111111111111111"
    );
    assert_eq!(
        (metas[1][0], metas[1][1..33].to_vec()),
        (0, sysvar.to_bytes().to_vec())
    );
    assert!(
        metas.iter().all(|m| m[33..] == [0, 0]),
        "signer/writable flags set"
    );
    let s = ShieldKeys::new(base, T22);
    let payer = env.payer.pubkey();
    env.ok(&[create_shield_ix(&payer, &s)], &[]);
    let (alice, alice_base, alice_z) = env.funded_user(&s, 5_000);
    let a = alice.pubkey();
    let extras = hook_extras(&base);

    // Without the hook's accounts Token-2022 cannot run the hook, and every
    // extra account of the list is required (here: the instructions sysvar).
    let result = env.send(
        &[wrap_ix(&a, &s, &alice_base, &alice_z, 1_000, &[])],
        &[&alice],
    );
    assert_error(result, MISSING_HOOK_PROGRAM);
    let no_sysvar: Vec<_> = extras
        .iter()
        .filter(|m| m.pubkey != noised_hook::INSTRUCTIONS_SYSVAR_ID)
        .cloned()
        .collect();
    assert_eq!(no_sysvar.len(), extras.len() - 1);
    let ix = wrap_ix(&a, &s, &alice_base, &alice_z, 1_000, &no_sysvar);
    assert_error(env.send(&[ix], &[&alice]), MISSING_EXTRA_ACCOUNT);
    let cu = env.ok(
        &[wrap_ix(&a, &s, &alice_base, &alice_z, 1_000, &extras)],
        &[&alice],
    );
    eprintln!("wrap (Token-2022 + Launch Guard hook): {cu} CU");
    let cu = env.ok(
        &[unwrap_ix(&a, &s, &alice_base, &alice_z, 400, &extras)],
        &[&alice],
    );
    eprintln!("unwrap (Token-2022 + Launch Guard hook): {cu} CU");
    assert_eq!(assert_exactly_backed(&env, &s), 600);

    // While the guard locks wallet-to-wallet transfers, the hook refuses both
    // directions (the shield is just another wallet to it).
    let now = env.svm.get_sysvar::<solana_clock::Clock>().unix_timestamp;
    lock_p2p_until(&mut env, &base, now + 3_600);
    for ix in [
        wrap_ix(&a, &s, &alice_base, &alice_z, 10, &extras),
        unwrap_ix(&a, &s, &alice_base, &alice_z, 10, &extras),
    ] {
        let result = env.send(&[ix], &[&alice]);
        let logs = match &result {
            Err(f) => f.meta.logs.join("\n"),
            Ok(_) => String::new(),
        };
        assert_error(result, HookError::TransfersLocked);
        assert!(
            logs.contains("TransfersLocked"),
            "refusal must come from the hook:\n{logs}"
        );
    }
    assert_eq!(assert_exactly_backed(&env, &s), 600);

    // After the guard everything flows again.
    let mut clock = env.svm.get_sysvar::<solana_clock::Clock>();
    clock.unix_timestamp = now + 3_601;
    env.svm.set_sysvar(&clock);
    env.ok(
        &[wrap_ix(&a, &s, &alice_base, &alice_z, 10, &extras)],
        &[&alice],
    );
    env.ok(
        &[unwrap_ix(&a, &s, &alice_base, &alice_z, 610, &extras)],
        &[&alice],
    );
    assert_eq!(assert_exactly_backed(&env, &s), 0);
    assert_eq!(env.balance(&alice_base), 5_000);
}

/// A Token-2022 account of the hooked `mint` at a fresh address (not an
/// ATA), owned by `owner`, without ImmutableOwner: its owner can be
/// reassigned (`SetAuthority(AccountOwner)`).
fn plain_token_account(env: &mut Env, mint: &Pubkey, owner: &Pubkey) -> Pubkey {
    let account = solana_keypair::Keypair::new();
    let space = ExtensionType::try_calculate_account_len::<TokenAccountState>(&[
        ExtensionType::TransferHookAccount,
    ])
    .unwrap();
    let payer = env.payer.pubkey();
    let create = system_instruction::create_account(
        &payer,
        &account.pubkey(),
        env.svm.minimum_balance_for_rent_exemption(space),
        space as u64,
        &T22,
    );
    let init = t22_ix::initialize_account3(&T22, &account.pubkey(), mint, owner).unwrap();
    env.ok(&[create, init], &[&account]);
    account.pubkey()
}

/// Compute units the Launch Guard hook used in a transaction (the sum of
/// its `consumed` log lines).
fn hook_cu(logs: &[String]) -> u64 {
    let prefix = format!("Program {} consumed ", noised_hook::ID);
    logs.iter()
        .filter_map(|l| {
            l.strip_prefix(&prefix)?
                .split(' ')
                .next()?
                .parse::<u64>()
                .ok()
        })
        .sum()
}

/// Whether token `account` has Token-2022's ImmutableOwner extension.
fn has_immutable_owner(env: &Env, account: &Pubkey) -> bool {
    StateWithExtensions::<TokenAccountState>::unpack(&env.data(account))
        .unwrap()
        .get_extension::<ImmutableOwner>()
        .is_ok()
}

/// Audit 3 (F2): while the guard is on, the hook lets tokens go, other than
/// to the pool, only into token accounts whose owner can never change. The
/// shield's escrow is its authority's ATA, which has Token-2022's
/// ImmutableOwner extension (as every ATA), so without the p2p lock wraps
/// pass, out of any account (the rule reads the receiving account only);
/// unwraps pass into the holder's ATA and are refused (`MutableOwner`) into
/// an account without ImmutableOwner through the guard's last second, then
/// pass. With the lock on, wraps and unwraps are wallet transfers the lock
/// refuses (`launch_guard_hook_accounts_are_forwarded_and_enforced`), and an
/// unwrap into such an account meets the immutable-owner rule first.
#[test]
fn launch_guard_unwraps_only_into_accounts_whose_owner_cannot_change() {
    let mut env = Env::new().with_hook();
    let exts = [
        metadata("Guarded Launch", "GRD"),
        Ext::Hook(noised_hook::ID),
    ];
    let base = env.create_t22_mint(6, &exts);
    env.init_hook_meta_list(&base);
    let s = ShieldKeys::new(base, T22);
    let payer = env.payer.pubkey();
    env.ok(&[create_shield_ix(&payer, &s)], &[]);
    let (alice, alice_base, alice_z) = env.funded_user(&s, 5_000);
    let a = alice.pubkey();
    let plain = plain_token_account(&mut env, &base, &a);
    // Minting never calls the hook: test setup.
    env.mint_to(&base, &T22, &plain, 300);
    for (what, account, immutable) in [
        ("the shield's escrow", s.escrow, true),
        ("alice's ATA", alice_base, true),
        ("alice's plain account", plain, false),
    ] {
        assert_eq!(has_immutable_owner(&env, &account), immutable, "{what}");
    }
    let extras = hook_extras(&base);
    let now = env.svm.get_sysvar::<solana_clock::Clock>().unix_timestamp;
    install_policy(&mut env, &base, now + 3_600, false);
    for (what, ix) in [
        (
            "wrap",
            wrap_ix(&a, &s, &alice_base, &alice_z, 1_000, &extras),
        ),
        (
            "unwrap",
            unwrap_ix(&a, &s, &alice_base, &alice_z, 400, &extras),
        ),
    ] {
        let Ok(sent) = env.send(&[ix], &[&alice]) else {
            panic!("{what} during the guard");
        };
        eprintln!(
            "{what} during the guard (every rule evaluated): {} CU, {} in the hook",
            sent.compute_units_consumed,
            hook_cu(&sent.logs)
        );
    }
    env.ok(
        &[wrap_ix(&a, &s, &plain, &alice_z, 300, &extras)],
        &[&alice],
    );
    assert_eq!(env.balance(&plain), 0);
    let result = env.send(
        &[unwrap_ix(&a, &s, &plain, &alice_z, 10, &extras)],
        &[&alice],
    );
    assert_error(result, HookError::MutableOwner);
    assert_eq!(assert_exactly_backed(&env, &s), 900);

    // With the lock on, the immutable-owner rule decides first.
    install_policy(&mut env, &base, now + 3_600, true);
    for (into, refusal) in [
        (plain, HookError::MutableOwner),
        (alice_base, HookError::TransfersLocked),
    ] {
        let result = env.send(
            &[unwrap_ix(&a, &s, &into, &alice_z, 10, &extras)],
            &[&alice],
        );
        assert_error(result, refusal);
    }
    install_policy(&mut env, &base, now + 3_600, false);

    // The guard's last second; from its end, into any account.
    let mut clock = env.svm.get_sysvar::<solana_clock::Clock>();
    clock.unix_timestamp = now + 3_599;
    env.svm.set_sysvar(&clock);
    let result = env.send(
        &[unwrap_ix(&a, &s, &plain, &alice_z, 10, &extras)],
        &[&alice],
    );
    assert_error(result, HookError::MutableOwner);
    clock.unix_timestamp = now + 3_600;
    env.svm.set_sysvar(&clock);
    env.ok(
        &[unwrap_ix(&a, &s, &plain, &alice_z, 900, &extras)],
        &[&alice],
    );
    assert_eq!(assert_exactly_backed(&env, &s), 0);
    assert_eq!(env.balance(&plain), 900);
}

/// PXR1 bytes, written from the documented layout, of one rule (code 7)
/// that refuses every transfer reaching it (`TRUE`, op 0) for the first
/// hour after the launch.
fn deny_everything() -> Vec<u8> {
    let mut b = b"PXR1".to_vec();
    b.extend_from_slice(&[1, 0, 1, 1, 0, 0, 0, 0]);
    b.extend_from_slice(&0u32.to_le_bytes());
    b.extend_from_slice(&3_600u32.to_le_bytes());
    b.extend_from_slice(&[0, 1, 1, 7]);
    b.extend_from_slice(&0u64.to_le_bytes());
    b.extend_from_slice(&[0, 0]);
    b.extend_from_slice(&0u64.to_le_bytes());
    b
}

/// Review 4, R1: creator rules never hold a holder's privacy exit. Under a
/// rule that refuses every transfer reaching it (p2p lock off), a wallet
/// transfer is refused (`RuleDenied`), while wraps and unwraps (the shield
/// is the top-level instruction) pass during the guard. Only the rules step
/// is skipped: with the lock on, the lock still refuses both
/// (`TransfersLocked`). The hook's shield id is the shield crate's.
#[test]
fn creator_rules_never_hold_a_wrap_or_an_unwrap() {
    assert_eq!(noised_hook::SHIELD_PROGRAM_ID, noised_shield::ID);
    let mut env = Env::new().with_hook();
    let exts = [
        metadata("Guarded Launch", "GRD"),
        Ext::Hook(noised_hook::ID),
    ];
    let base = env.create_t22_mint(6, &exts);
    env.init_hook_meta_list(&base);
    let s = ShieldKeys::new(base, T22);
    let payer = env.payer.pubkey();
    env.ok(&[create_shield_ix(&payer, &s)], &[]);
    let (alice, alice_base, alice_z) = env.funded_user(&s, 5_000);
    let a = alice.pubkey();
    let bob = env.user();
    let bob_base = env.create_ata(&bob.pubkey(), &base, &T22);
    let extras = hook_extras(&base);
    let now = env.svm.get_sysvar::<solana_clock::Clock>().unix_timestamp;
    install_policy_with(&mut env, &base, now + 3_600, false, deny_everything());
    let mut send =
        t22_ix::transfer_checked(&T22, &alice_base, &base, &bob_base, &a, &[], 10, 6).unwrap();
    send.accounts.extend_from_slice(&extras);
    assert_error(env.send(&[send], &[&alice]), HookError::RuleDenied);
    env.ok(
        &[wrap_ix(&a, &s, &alice_base, &alice_z, 1_000, &extras)],
        &[&alice],
    );
    env.ok(
        &[unwrap_ix(&a, &s, &alice_base, &alice_z, 400, &extras)],
        &[&alice],
    );
    assert_eq!(assert_exactly_backed(&env, &s), 600);
    install_policy_with(&mut env, &base, now + 3_600, true, deny_everything());
    for ix in [
        wrap_ix(&a, &s, &alice_base, &alice_z, 10, &extras),
        unwrap_ix(&a, &s, &alice_base, &alice_z, 10, &extras),
    ] {
        assert_error(env.send(&[ix], &[&alice]), HookError::TransfersLocked);
    }
    assert_eq!(assert_exactly_backed(&env, &s), 600);
    assert_eq!(env.balance(&bob_base), 0);
}

//! Audit round 4, launch lens (no exploitable issue; two info items),
//! against our SBF builds and the mainnet DBC and Token-2022 programs:
//!
//! * L-i1: a buy that would complete the curve during the snipe shield is
//!   refused by the shield. This pins DBC's order inside the completing
//!   swap: the output transfer (which runs the hook) comes before DBC
//!   revokes the hook. Were it the other way round, the completing buy
//!   would pass the shield unchecked.
//! * L-i2: `commit` refuses once the batch executed (defense in depth: the
//!   batch executes only after the commit window, so no commit can follow
//!   it today).
//!
//! How to build and run: see `src/lib.rs`.

mod common;

use anchor_lang::AccountSerialize;
use anchor_spl::token_interface::spl_token_2022::{
    extension::{transfer_hook::TransferHook, BaseStateWithExtensions, StateWithExtensions},
    state::Mint,
};
use common::{launch::*, world::*, *};
use noised_hook::HookError;
use noised_launchpad::{
    dynamic_bonding_curve::accounts::TransferHookPool, error::LaunchpadError as E, state::Launch,
};
use solana_signer::Signer;

/// The transfer-hook program the mint names (none once DBC revoked it).
fn hook_program(env: &Env, mint: &Pubkey) -> Option<Pubkey> {
    let account = env.account(mint).expect("mint");
    let state = StateWithExtensions::<Mint>::unpack(&account.data).unwrap();
    state
        .get_extension::<TransferHook>()
        .unwrap()
        .program_id
        .into()
}

/// L-i1. A launch without buy or wallet caps (so one buyer can complete the
/// curve) and no batch: the snipe shield holds until the execution window
/// ends. A buy large enough to complete the curve, in the shield's last
/// second, is refused with `SnipeShield`, and changes nothing; the same buy
/// a second later completes the curve, and DBC revokes the hook in it.
#[test]
fn l_i1_a_buy_completing_the_curve_during_the_shield_is_refused() {
    let mut w = launched_with(|p| {
        p.max_buy_bps = 0;
        p.max_wallet_bps = 0;
        p.p2p_locked = false;
    });
    let k = w.k;
    let env = &mut w.env;
    let l: Launch = env.anchor(&k.launch);
    let threshold = l.migration_quote_threshold;
    let buyer = committer(env, 25 * LAMPORTS_PER_SOL);
    let b = buyer.pubkey();
    env.send(
        &[create_ata(&b, &b, &k.mint, &TOKEN_2022_PROGRAM_ID)],
        &[&buyer],
    )
    .expect_ok("buyer's base ATA");
    let buy = dbc_swap_mode(&b, &k, true, 20 * LAMPORTS_PER_SOL, 1, true);

    // A second after the shield: the buy completes the curve, and DBC
    // revokes the hook inside it.
    let snapshot = env.svm.clone();
    env.set_time(l.execute_end_ts);
    env.send(std::slice::from_ref(&buy), &[&buyer])
        .expect_ok("the buy after the shield");
    let s = env.anchor::<TransferHookPool>(&k.pool).pool_state;
    assert!(s.quote_reserve >= threshold && s.finish_curve_timestamp > 0);
    assert_eq!(hook_program(env, &k.mint), None);
    env.svm = snapshot;

    // In the shield's last second: refused by the shield, though DBC would
    // revoke the hook in this very swap.
    env.set_time(l.execute_end_ts - 1);
    let pool_before = env.account(&k.pool).unwrap().data;
    env.send(&[buy], &[&buyer]).fails_with(
        hook_code(HookError::SnipeShield),
        "SnipeShield",
        "a buy completing the curve during the shield",
    );
    assert_eq!(env.account(&k.pool).unwrap().data, pool_before);
    assert_eq!(hook_program(env, &k.mint), Some(noised_hook::ID));
    assert_eq!(env.token_amount(&base_ata(&b, &k.mint)), 0);
}

/// L-i2. A commit in the commit window of a launch whose batch executed is
/// refused with `AlreadyExecuted`, and changes nothing. The batch can only
/// execute after the window, so the launch is marked executed in the
/// ledger; the same commit on the unmarked launch goes through.
#[test]
fn l_i2_no_commit_after_the_batch() {
    let mut w = launched();
    let k = w.k;
    let env = &mut w.env;
    let alice = committer(env, 2 * LAMPORTS_PER_SOL);
    let a = alice.pubkey();
    env.send(&[commit(&a, &k, LAMPORTS_PER_SOL)], &[&alice])
        .expect_ok("a commit in the window");
    let l: Launch = env.anchor(&k.launch);
    assert!(!l.executed && env.now() < l.commit_end_ts);
    // The same commit goes through on the launch as it is.
    {
        let snapshot = env.svm.clone();
        env.send(&[commit(&a, &k, LAMPORTS_PER_SOL)], &[&alice])
            .expect_ok("a second commit");
        env.svm = snapshot;
    }
    let mut marked = l.clone();
    marked.executed = true;
    let mut account = env.account(&k.launch).unwrap();
    let mut data = Vec::new();
    marked.try_serialize(&mut data).unwrap();
    assert_eq!(data.len(), account.data.len());
    account.data = data;
    env.svm.set_account(k.launch, account).unwrap();
    let before = (
        env.account(&k.launch).unwrap().data,
        env.account(&k.commit(&a)).unwrap().data,
        env.token_amount(&wsol_ata(&a)),
    );
    env.send(&[commit(&a, &k, LAMPORTS_PER_SOL)], &[&alice])
        .fails_with(
            code(E::AlreadyExecuted),
            "AlreadyExecuted",
            "a commit after the batch",
        );
    let fresh = committer(env, LAMPORTS_PER_SOL);
    env.send(&[commit(&fresh.pubkey(), &k, LAMPORTS_PER_SOL)], &[&fresh])
        .fails_with(
            code(E::AlreadyExecuted),
            "AlreadyExecuted",
            "a first commit after the batch",
        );
    let after = (
        env.account(&k.launch).unwrap().data,
        env.account(&k.commit(&a)).unwrap().data,
        env.token_amount(&wsol_ata(&a)),
    );
    assert_eq!(before, after);
}

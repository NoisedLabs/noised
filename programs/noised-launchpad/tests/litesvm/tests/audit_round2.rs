//! Regression tests for the launchpad findings of the second audit, replayed
//! against the mainnet DBC, Token-2022, SPL Token and ATA programs:
//!
//! * write-lock contention: anyone with a little SOL can fill the per-block
//!   write budget of the shared `Launch` account, or of the accounts
//!   `execute_batch` locks, and keep zero-priority transactions out. A 10 s
//!   commit window or a 30 s execution window was cheap to block (into a
//!   creator-only batch, or into an expiry). Commit windows now last at
//!   least a minute and the execution window ten minutes; so that the long
//!   window never delays trading, `execute_batch` ends the snipe shield as
//!   soon as the batch has bought (`noised_hook::end_snipe_shield`);
//! * batch caps that neuter the fair open while every check stays green: a
//!   non-zero total cap is now at least 10% of the threshold, a non-zero
//!   wallet cap at least 1/200 of the (resolved) total cap.
//!
//! Each test's doc comment says what it shows. How to build and run: see
//! `src/lib.rs`.

mod common;

use anchor_spl::token_interface::spl_token_2022::{
    extension::{transfer_hook::TransferHook, BaseStateWithExtensions, StateWithExtensions},
    state::Mint,
};
use common::{launch::*, pq, presets::*, world::*, *};
use noised_hook::{
    rules::bounds::MAX_SNIPE_SHIELD_SECS, state::HookPolicy, HookError, SnipeShieldEnded,
};
use noised_launchpad::{
    constants::*,
    dynamic_bonding_curve::accounts::TransferHookPool,
    error::LaunchpadError as E,
    state::{Certificate, CurvePoint, Launch, LaunchParams},
};
use solana_clock::Clock;
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_keypair::Keypair;
use solana_signer::Signer;

/// Byte offset of `snipe_shield_end_ts` in the hook's policy account:
/// discriminator, version, bump, mint, pool, base vault, `launch_ts`.
const SHIELD_END_OFFSET: usize = 8 + 1 + 1 + 32 * 3 + 8;

/// Anchor's `ConstraintMut`, `ConstraintSeeds` and `AccountNotSigner` error
/// numbers.
const CONSTRAINT_MUT: u32 = 2_000;
const CONSTRAINT_SEEDS: u32 = 2_006;
const ACCOUNT_NOT_SIGNER: u32 = 3_010;

/// A public buy well under every launch's max-buy cap.
const SMALL_BUY: u64 = LAMPORTS_PER_SOL / 200;

fn shield() -> u32 {
    hook_code(HookError::SnipeShield)
}

/// Two 2 SOL commits, from two new wallets.
fn commit_two(env: &mut Env, k: &Keys) {
    for _ in 0..2 {
        let who = committer(env, 2 * LAMPORTS_PER_SOL);
        env.send(&[commit(&who.pubkey(), k, 2 * LAMPORTS_PER_SOL)], &[&who])
            .expect_ok("commit");
    }
}

/// The policy account's bytes.
fn policy_data(env: &Env, k: &Keys) -> Vec<u8> {
    env.account(&k.policy).expect("policy").data
}

/// Only `snipe_shield_end_ts` differs between two copies of a policy.
#[track_caller]
fn assert_only_the_shield_end_changed(before: &[u8], after: &[u8]) {
    let changed: Vec<usize> = (0..after.len())
        .filter(|&i| after[i] != before[i])
        .collect();
    assert!(
        !changed.is_empty()
            && changed
                .iter()
                .all(|i| (SHIELD_END_OFFSET..SHIELD_END_OFFSET + 8).contains(i)),
        "changed bytes {changed:?}"
    );
}

/// The one `SnipeShieldEnded` event of a transaction.
#[track_caller]
fn shield_ended(sent: &Sent) -> SnipeShieldEnded {
    let mut ended = events::<SnipeShieldEnded>(&sent.logs);
    assert_eq!(ended.len(), 1, "{}", sent.logs.join("\n"));
    ended.remove(0)
}

/// The refusal names `account` as its cause (Anchor's account constraints).
#[track_caller]
fn caused_by(f: &Failed, account: &str) {
    let cause = format!("AnchorError caused by account: {account}.");
    assert!(
        f.logs.iter().any(|l| l.contains(&cause)),
        "not refused for `{account}`\n{}",
        f.logs.join("\n")
    );
}

/// What an `execute_batch` instruction spent, by invocation (from the logs).
fn execute_batch_cu(what: &str, sent: &Sent) {
    let tree = top_level(&sent.logs, &noised_launchpad::ID);
    let cu = |program: &Pubkey, depth: usize| -> u64 {
        tree.iter()
            .filter(|i| i.program == *program && i.depth == depth)
            .filter_map(|i| i.consumed)
            .sum()
    };
    let total = cu(&noised_launchpad::ID, 1);
    let (swap, check) = (cu(&DBC_PROGRAM_ID, 2), cu(&noised_hook::ID, 4));
    let (end, ata) = (cu(&noised_hook::ID, 2), cu(&ATA_PROGRAM_ID, 2));
    println!(
        "{what}: {} CU in the transaction, {total} in execute_batch: DBC swap {swap} \
         (of which the hook's check of the batch buy {check}), end_snipe_shield CPI {end}, \
         base escrow ATA {ata}, the launchpad itself {}; {} bytes",
        sent.cu,
        total - swap - end - ata,
        sent.size
    );
}

/// Round 2 (write-lock contention on the batch's accounts). The execution
/// window is now ten minutes, so blocking the batch into an expiry costs
/// ten minutes of contention; so that the window never delays trading,
/// `execute_batch` ends the snipe shield as soon as the batch has bought.
/// All in one slot: a buy before the batch is refused, alone or ahead of
/// the batch in its transaction (which then fails as a whole); the batch
/// executes, as the pool's first swap at the opening price; a buy right
/// behind it in its transaction passes, and so does a buy in the next
/// transaction. The shield's end moved to the batch's second, after the
/// swap; nothing else in the policy changed, the certificate keeps the
/// schedule, and the guard rules still hold.
#[test]
fn r2_the_batch_ends_the_snipe_shield_in_its_own_slot() {
    let mut w = launched();
    let k = w.k;
    let env = &mut w.env;
    let l: Launch = env.anchor(&k.launch);
    commit_two(env, &k);
    let mallory = buyer(env, &k);
    let alice = buyer(env, &k);
    let (m, a) = (mallory.pubkey(), alice.pubkey());

    let batch_at = l.commit_end_ts + 5;
    env.set_time(batch_at);
    let slot = env.svm.get_sysvar::<Clock>().slot;
    let policy_before = policy_data(env, &k);

    // Before the batch the shield holds.
    env.send(&[dbc_swap(&m, &k, true, SMALL_BUY)], &[&mallory])
        .fails_with(shield(), "SnipeShield", "a buy before the batch");
    let ixs = [dbc_swap(&m, &k, true, SMALL_BUY), execute_batch(&m, &k)];
    env.send_with(&m, &ixs, &[&mallory], true).fails_with(
        shield(),
        "SnipeShield",
        "a buy ahead of the batch in its transaction",
    );
    assert!(!env.anchor::<Launch>(&k.launch).executed);
    assert_eq!(policy_data(env, &k), policy_before);

    // The batch, then a buy right behind it in the same legacy transaction ...
    let ixs = [execute_batch(&m, &k), dbc_swap(&m, &k, true, SMALL_BUY)];
    let sent = env
        .send_with(&m, &ixs, &[&mallory], true)
        .expect_ok("execute_batch, then a buy in its transaction");
    println!("execute_batch + a buy: {} CU, {} bytes", sent.cu, sent.size);
    assert!(env.token_amount(&base_ata(&m, &k.mint)) > 0);
    // ... and a buy in the next transaction, still in the same slot.
    env.send(&[dbc_swap(&a, &k, true, SMALL_BUY)], &[&alice])
        .expect_ok("a buy in the next transaction");
    assert!(env.token_amount(&base_ata(&a, &k.mint)) > 0);
    let clock = env.svm.get_sysvar::<Clock>();
    assert_eq!((clock.slot, clock.unix_timestamp), (slot, batch_at));

    // The batch was the pool's first swap and bought at the opening price:
    // the same tokens as the same batch at the start of the window.
    let l: Launch = env.anchor(&k.launch);
    assert!(l.executed);
    assert_eq!(l.tokens_out, batch_tokens_out(|_| {}));
    // It ended the shield after its swap, at its own second.
    let cpis: Vec<Pubkey> = top_level(&sent.logs, &noised_launchpad::ID)
        .iter()
        .filter(|i| i.depth == 2)
        .map(|i| i.program)
        .collect();
    let swap = cpis.iter().position(|p| *p == DBC_PROGRAM_ID);
    let end = cpis.iter().position(|p| *p == noised_hook::ID);
    assert!(
        swap.is_some() && end > swap,
        "CPIs of execute_batch: {cpis:?}"
    );
    let policy: HookPolicy = env.anchor(&k.policy);
    assert_eq!(
        (policy.snipe_shield_end_ts, policy.guard_end_ts),
        (batch_at, l.guard_end_ts)
    );
    assert_only_the_shield_end_changed(&policy_before, &policy_data(env, &k));
    let cert: Certificate = env.anchor(&k.certificate);
    assert_eq!(
        (cert.snipe_shield_end_ts, cert.execute_end_ts),
        (l.execute_end_ts, l.execute_end_ts)
    );
    let e = shield_ended(&sent);
    assert_eq!(
        (e.mint, e.pool, e.scheduled_end_ts, e.snipe_shield_end_ts),
        (k.mint, k.pool, l.execute_end_ts, batch_at)
    );

    // The guard rules still hold after the early end.
    env.send(&wrap_sol(&m, LAMPORTS_PER_SOL), &[&mallory])
        .expect_ok("mallory wraps more SOL");
    env.send(&[dbc_swap(&m, &k, true, LAMPORTS_PER_SOL)], &[&mallory])
        .fails_with(
            hook_code(HookError::MaxBuy),
            "MaxBuy",
            "an oversized buy after the batch",
        );
    env.send(&[hooked_transfer(&k, &m, &a, 1)], &[&mallory])
        .fails_with(
            hook_code(HookError::TransfersLocked),
            "TransfersLocked",
            "wallet to wallet after the batch",
        );
}

/// Round 2, without a batch. If nobody executes the batch in its window,
/// the shield lasts its whole schedule: every buy is refused up to the
/// window's last second, public trading opens exactly at `execute_end_ts`,
/// and from then on the batch can never execute: every commit is refunded
/// in full and nobody gets tokens. A batch that never ran never touched the
/// policy.
#[test]
fn r2_without_the_batch_the_shield_ends_on_schedule() {
    let mut w = launched();
    let k = w.k;
    let env = &mut w.env;
    let payer = env.payer.pubkey();
    let l: Launch = env.anchor(&k.launch);
    let policy_at_launch = policy_data(env, &k);
    let amounts = [LAMPORTS_PER_SOL, 700_000_001];
    let committers: Vec<Keypair> = amounts.iter().map(|&a| committer(env, a)).collect();
    for (who, amount) in committers.iter().zip(amounts) {
        env.send(&[commit(&who.pubkey(), &k, amount)], &[who])
            .expect_ok("commit");
    }
    let mallory = buyer(env, &k);
    let m = mallory.pubkey();

    for at in [l.commit_end_ts, l.commit_end_ts + 300, l.execute_end_ts - 1] {
        env.set_time(at);
        env.send(&[dbc_swap(&m, &k, true, SMALL_BUY)], &[&mallory])
            .fails_with(shield(), "SnipeShield", "a buy in the execution window");
    }

    // The scheduled end: the batch has expired and trading opens.
    env.set_time(l.execute_end_ts);
    env.send(&[execute_batch(&payer, &k)], &[]).fails_with(
        code(E::NotExecuteWindow),
        "NotExecuteWindow",
        "execute at the end of its window",
    );
    env.send(&[dbc_swap(&m, &k, true, SMALL_BUY)], &[&mallory])
        .expect_ok("a buy at the scheduled end of the shield");
    assert!(env.token_amount(&base_ata(&m, &k.mint)) > 0);
    env.set_time(l.execute_end_ts + 60);
    env.send(&[execute_batch(&payer, &k)], &[]).fails_with(
        code(E::NotExecuteWindow),
        "NotExecuteWindow",
        "execute after its window",
    );
    assert_eq!(policy_data(env, &k), policy_at_launch);
    assert_eq!(
        env.anchor::<HookPolicy>(&k.policy).snipe_shield_end_ts,
        l.execute_end_ts
    );

    for (who, amount) in committers.iter().zip(amounts) {
        let owner = who.pubkey();
        let before = env.token_amount(&wsol_ata(&owner));
        env.send(&[claim(&payer, &k, &owner, false, false)], &[])
            .expect_ok("refund");
        assert_eq!(env.token_amount(&wsol_ata(&owner)) - before, amount);
        assert!(env.account(&base_ata(&owner, &k.mint)).is_none());
        assert_escrow_invariants(env, &k);
    }
    let l: Launch = env.anchor(&k.launch);
    assert!(!l.executed);
    assert_eq!((l.quote_refunded, l.tokens_out), (l.total_committed, 0));
}

/// Round 2, a batch late in its window. A keeper that lands `execute_batch`
/// in the last second of the ten-minute window still executes it, and gets
/// exactly the deal of a batch at the window's first second (same opening
/// price, same floor fee, same tokens); the shield ends then. Shown on the
/// shortest and on the longest commit window. The longest keeps the shield
/// up for 40 minutes (30 + 10), within the hook's one-hour bound, so the
/// hook accepts every policy the launchpad's bounds allow.
#[test]
fn r2_a_batch_late_in_its_window_executes_and_ends_the_shield_then() {
    assert!(i64::from(MAX_OPEN_DELAY + EXECUTION_GRACE_SECS) <= MAX_SNIPE_SHIELD_SECS);
    for (what, longest) in [
        ("the shortest commit window", false),
        ("the longest commit window", true),
    ] {
        // The longest: 30 minutes, and the shortest guard that covers it.
        let tweak = move |p: &mut LaunchParams| {
            if longest {
                p.open_delay_secs = MAX_OPEN_DELAY;
                p.guard_secs = MAX_OPEN_DELAY + EXECUTION_GRACE_SECS;
            }
        };
        let mut w = launched_with(tweak);
        let k = w.k;
        let env = &mut w.env;
        let payer = env.payer.pubkey();
        let l: Launch = env.anchor(&k.launch);
        let shield_secs = l.execute_end_ts - l.launch_ts;
        assert_eq!(
            shield_secs,
            i64::from(w.params.open_delay_secs + EXECUTION_GRACE_SECS)
        );
        let policy: HookPolicy = env.anchor(&k.policy);
        assert_eq!(policy.snipe_shield_end_ts - policy.launch_ts, shield_secs);

        // One commit as the window opens, one in its last second.
        for at in [l.launch_ts, l.commit_end_ts - 1] {
            env.set_time(at);
            let who = committer(env, 2 * LAMPORTS_PER_SOL);
            env.send(&[commit(&who.pubkey(), &k, 2 * LAMPORTS_PER_SOL)], &[&who])
                .expect_ok("commit");
        }
        let mallory = buyer(env, &k);
        let m = mallory.pubkey();

        let batch_at = l.execute_end_ts - 1;
        env.set_time(batch_at);
        env.send(&[dbc_swap(&m, &k, true, SMALL_BUY)], &[&mallory])
            .fails_with(shield(), "SnipeShield", "a buy just before a late batch");
        let sent = env
            .send(&[execute_batch(&payer, &k)], &[])
            .expect_ok("execute_batch in the last second of its window");
        let e = shield_ended(&sent);
        assert_eq!(
            (e.scheduled_end_ts, e.snipe_shield_end_ts),
            (l.execute_end_ts, batch_at)
        );
        assert_eq!(
            env.anchor::<HookPolicy>(&k.policy).snipe_shield_end_ts,
            batch_at
        );
        env.send(&[dbc_swap(&m, &k, true, SMALL_BUY)], &[&mallory])
            .expect_ok("a buy right after a late batch");

        let l: Launch = env.anchor(&k.launch);
        assert_eq!(l.quote_spent, 4 * LAMPORTS_PER_SOL);
        assert_eq!(l.tokens_out, batch_tokens_out(tweak), "{what}");
        println!(
            "{what}: a {shield_secs} s shield, ended by a batch {} s into its {EXECUTION_GRACE_SECS} s window",
            batch_at - l.commit_end_ts
        );
    }
}

/// Round 2 (batch caps that neuter the fair open while every check stays
/// green). The policy accepted any total cap up to the threshold and any
/// wallet cap, so a creator could shrink the batch to dust, or cap each
/// wallet so low that no realistic number of wallets fills it (each
/// `Commit` costs rent that is never returned); and a 10 s commit window
/// was cheap to block with write-lock contention. `create_launch` now
/// refuses, before DBC is involved: a non-zero total cap under 10% of the
/// threshold (or over it), a non-zero wallet cap under 1/200 of the
/// resolved total cap (the threshold when the total cap is 0), commit
/// windows under a minute, and guards shorter than the commit window plus
/// the ten-minute execution window. Every floor itself is accepted.
#[test]
fn r2_batch_cap_floors_and_minute_windows_hold_at_create_launch() {
    let mut w = created_with(|_| {});
    let creator = w.creator.insecure_clone();
    let c = creator.pubkey();
    let base = w.params.clone();
    let threshold = base.migration_quote_threshold;
    assert_eq!(
        (threshold, base.open_delay_secs, base.batch_total_cap),
        (10 * LAMPORTS_PER_SOL, MIN_OPEN_DELAY, 0)
    );
    let with = |tweak: &dyn Fn(&mut LaunchParams)| {
        let mut p = base.clone();
        tweak(&mut p);
        p
    };
    let caps = (code(E::InvalidBatchCap), "InvalidBatchCap");
    let delay = (code(E::InvalidOpenDelay), "InvalidOpenDelay");
    let guard = (code(E::InvalidGuard), "InvalidGuard");
    let k = Keys::new(&c, [9; 32], Keypair::new().pubkey());
    for (what, (error, name), p) in [
        (
            "a 1-lamport total cap",
            caps,
            with(&|p| p.batch_total_cap = 1),
        ),
        (
            "a total cap 1 lamport under 10% of the threshold",
            caps,
            with(&|p| p.batch_total_cap = threshold / 10 - 1),
        ),
        (
            "a total cap over the threshold",
            caps,
            with(&|p| p.batch_total_cap = threshold + 1),
        ),
        (
            "a 1-lamport wallet cap",
            caps,
            with(&|p| p.batch_wallet_cap = 1),
        ),
        (
            "no total cap, a wallet cap 1 lamport under 1/200 of the threshold",
            caps,
            with(&|p| p.batch_wallet_cap = threshold / 200 - 1),
        ),
        (
            "a wallet cap 1 lamport under 1/200 of the total cap",
            caps,
            with(&|p| {
                p.batch_total_cap = threshold / 10;
                p.batch_wallet_cap = threshold / 2_000 - 1;
            }),
        ),
        (
            "a 10 s commit window (the old minimum)",
            delay,
            with(&|p| p.open_delay_secs = 10),
        ),
        (
            "a 59 s commit window",
            delay,
            with(&|p| p.open_delay_secs = MIN_OPEN_DELAY - 1),
        ),
        (
            "a commit window over 30 minutes",
            delay,
            with(&|p| {
                p.open_delay_secs = MAX_OPEN_DELAY + 1;
                p.guard_secs = MAX_GUARD_SECS;
            }),
        ),
        (
            "a guard 1 s shorter than the commit and execution windows",
            guard,
            with(&|p| p.guard_secs = MIN_OPEN_DELAY + EXECUTION_GRACE_SECS - 1),
        ),
        (
            "the longest commit window, a guard 1 s too short",
            guard,
            with(&|p| {
                p.open_delay_secs = MAX_OPEN_DELAY;
                p.guard_secs = MAX_OPEN_DELAY + EXECUTION_GRACE_SECS - 1;
            }),
        ),
    ] {
        w.env
            .send(&[create_launch(&c, &k, p)], &[&creator])
            .fails_with(error, name, what);
    }

    // Exactly at the floors: created, and launched with the shortest windows.
    for (seed, what, p, (total, wallet)) in [
        (
            [10; 32],
            "no total cap, a wallet cap of 1/200 of the threshold",
            with(&|p| p.batch_wallet_cap = threshold / 200),
            (threshold, threshold / 200),
        ),
        (
            [11; 32],
            "a total cap equal to the threshold",
            with(&|p| p.batch_total_cap = threshold),
            (threshold, 0),
        ),
        (
            [12; 32],
            "every floor at once",
            with(&|p| {
                p.guard_secs = MIN_OPEN_DELAY + EXECUTION_GRACE_SECS;
                p.batch_total_cap = threshold / 10;
                p.batch_wallet_cap = threshold / 2_000;
            }),
            (threshold / 10, threshold / 2_000),
        ),
    ] {
        let mint = Keypair::new();
        let k = Keys::new(&c, seed, mint.pubkey());
        w.env
            .send(&[create_launch(&c, &k, p)], &[&creator])
            .expect_ok(what);
        pq::attest(&mut w.env, &k, META);
        w.env
            .send(&[launch(&c, &k, NAME, SYMBOL, URI)], &[&creator, &mint])
            .expect_ok(what);
        let l: Launch = w.env.anchor(&k.launch);
        assert_eq!(
            (l.batch_total_cap, l.batch_wallet_cap),
            (total, wallet),
            "{what}"
        );
        let policy: HookPolicy = w.env.anchor(&k.policy);
        assert_eq!(
            (policy.snipe_shield_end_ts, policy.guard_end_ts),
            (l.execute_end_ts, l.guard_end_ts),
            "{what}"
        );
        if seed == [12; 32] {
            assert_eq!(
                (
                    l.commit_end_ts - l.launch_ts,
                    l.execute_end_ts - l.commit_end_ts,
                    l.guard_end_ts - l.launch_ts
                ),
                (60, 600, 660)
            );
        }
    }
}

/// Round 2: the SDK's three presets, built exactly as the SDK builds them
/// (curve, flat fee, dynamic fee, windows, caps), pass the new floors
/// on-chain: `create_launch` accepts them, `launch` writes a policy the hook
/// accepts (community keeps the shield up for 40 minutes), a wallet commits
/// up to its cap (community: 2 SOL of a 250 SOL batch, above the 1.25 SOL
/// floor) and not a lamport more, and the batch executes and ends the shield.
#[test]
fn r2_the_sdk_presets_launch_and_batch_under_the_new_rules() {
    // The port reproduces the SDK's numbers (presets.ts and curve.ts, in
    // exact integers).
    for (p, start, first, liquidity, control) in [
        (
            &PRESETS[0],
            101_036_978_416_954_620,
            368_934_881_474_191_032,
            107_966_508_353_371_298_468_401_376_040_587,
            956,
        ),
        (
            &PRESETS[1],
            130_438_178_253_327_822,
            451_851_103_962_979_245,
            264_676_946_461_957_757_840_076_013_249_444,
            956,
        ),
        (
            &PRESETS[2],
            82_496_347_424_711_897,
            319_506_979_698_850_302,
            57_429_046_731_937_456_994_634_684_898_884,
            1_434,
        ),
    ] {
        let params = preset_params(p, &[]);
        assert_eq!(
            (
                params.sqrt_start_price,
                params.curve[0].sqrt_price,
                params.curve[0].liquidity,
                params.dynamic_fee.unwrap().variable_fee_control
            ),
            (start, first, liquidity, control),
            "{}",
            p.name
        );
    }

    for p in PRESETS {
        let mut w = launched_with(|x| {
            let recipients = x.recipients.clone();
            *x = preset_params(&p, &[]);
            x.recipients = recipients;
        });
        let k = w.k;
        let env = &mut w.env;
        let payer = env.payer.pubkey();
        let l: Launch = env.anchor(&k.launch);
        let threshold = p.threshold_sol * LAMPORTS_PER_SOL;
        let wallet_cap = p.batch_wallet_cap_sol * LAMPORTS_PER_SOL;
        assert_eq!(
            (l.batch_total_cap, l.batch_wallet_cap),
            (threshold, wallet_cap),
            "{}",
            p.name
        );
        assert!(wallet_cap == 0 || wallet_cap >= threshold / 200);
        assert_eq!(
            (
                l.commit_end_ts - l.launch_ts,
                l.execute_end_ts - l.commit_end_ts,
                l.guard_end_ts - l.launch_ts
            ),
            (
                i64::from(p.open_delay_secs),
                i64::from(EXECUTION_GRACE_SECS),
                i64::from(p.guard_secs)
            ),
            "{}",
            p.name
        );
        let policy: HookPolicy = env.anchor(&k.policy);
        assert_eq!(policy.snipe_shield_end_ts, l.execute_end_ts);
        assert!(policy.snipe_shield_end_ts - policy.launch_ts <= MAX_SNIPE_SHIELD_SECS);

        // A wallet commits up to its cap (2 SOL where there is none) ...
        let up_to = if wallet_cap > 0 {
            wallet_cap
        } else {
            2 * LAMPORTS_PER_SOL
        };
        let alice = committer(env, up_to + 1);
        let a = alice.pubkey();
        env.send(&[commit(&a, &k, up_to)], &[&alice])
            .expect_ok("commit up to the wallet cap");
        let one_more = env.send(&[commit(&a, &k, 1)], &[&alice]);
        if wallet_cap > 0 {
            one_more.fails_with(
                code(E::CapExceeded),
                "CapExceeded",
                "one lamport over the wallet cap",
            );
        } else {
            one_more.expect_ok("no wallet cap");
        }
        let bob = committer(env, LAMPORTS_PER_SOL);
        env.send(&[commit(&bob.pubkey(), &k, LAMPORTS_PER_SOL)], &[&bob])
            .expect_ok("bob commits");

        // ... and the batch executes as the pool's first swap and ends the
        // shield, so the public buys right after it.
        env.set_time(l.commit_end_ts);
        let sent = env
            .send(&[execute_batch(&payer, &k)], &[])
            .expect_ok("execute_batch");
        let l: Launch = env.anchor(&k.launch);
        assert!(l.executed && l.tokens_out > 0);
        assert_eq!(l.quote_spent, l.total_committed);
        assert_eq!(shield_ended(&sent).snipe_shield_end_ts, l.commit_end_ts);
        let mallory = buyer(env, &k);
        env.send(
            &[dbc_swap(&mallory.pubkey(), &k, true, SMALL_BUY)],
            &[&mallory],
        )
        .expect_ok("a buy right after the batch");
        execute_batch_cu(&format!("execute_batch ({} preset)", p.name), &sent);
    }
}

/// Round 2: the shield's early end belongs to the batch alone. The hook's
/// `end_snipe_shield` accepts only the launchpad's `["hook-authority"]` PDA
/// as signer, which only the launchpad program can produce; the launchpad
/// signs only inside `execute_batch`, after its batch bought, and only for
/// its own launch's policy (seeds of its base mint). With two live
/// launches, before any batch: direct calls signed by the creator or a
/// random wallet, or naming the PDA without its signature, fail;
/// `execute_batch` handed the other launch's policy, a look-alike authority
/// or another program in the hook slot, or its own policy read-only, fails;
/// both shields stay as scheduled. Then the real batch ends its own
/// launch's shield and only that one.
#[test]
fn r2_only_the_launchpad_ends_the_shield_and_only_its_own() {
    let mut w = launched();
    let a = w.k;
    let b = w.launch_another([8; 32], |_| {});
    let creator = w.creator.insecure_clone();
    let env = &mut w.env;
    let payer = env.payer.pubkey();
    let l: Launch = env.anchor(&a.launch);
    assert_eq!(
        env.anchor::<Launch>(&b.launch).execute_end_ts,
        l.execute_end_ts
    );
    commit_two(env, &a);
    let mallory = env.funded(2);
    let m = mallory.pubkey();
    env.set_time(l.commit_end_ts);
    let (policy_a, policy_b) = (policy_data(env, &a), policy_data(env, &b));

    // Directly, nobody can.
    for (signer, what) in [(&creator, "the creator"), (&mallory, "a random wallet")] {
        let f = env
            .send(
                &[end_snipe_shield(&signer.pubkey(), true, &a.policy)],
                &[signer],
            )
            .fails_with(CONSTRAINT_SEEDS, "ConstraintSeeds", what);
        caused_by(&f, "launchpad_authority");
    }
    let f = env
        .send(
            &[end_snipe_shield(&hook_authority(), false, &a.policy)],
            &[],
        )
        .fails_with(
            ACCOUNT_NOT_SIGNER,
            "AccountNotSigner",
            "the launchpad PDA without its signature",
        );
    caused_by(&f, "launchpad_authority");

    // Through the launchpad, only for the launch's own policy, signed by the
    // real PDA, calling the real hook.
    let other_policy = execute_batch_with(&payer, &a, |x| x.policy = b.policy);
    let f = env.send(&[other_policy], &[]).fails_with(
        CONSTRAINT_SEEDS,
        "ConstraintSeeds",
        "execute_batch handed another launch's policy",
    );
    caused_by(&f, "policy");
    let look_alike = Pubkey::find_program_address(&[HOOK_AUTHORITY_SEED], &noised_hook::ID).0;
    let other_authority = execute_batch_with(&payer, &a, |x| x.hook_authority = look_alike);
    let f = env.send(&[other_authority], &[]).fails_with(
        CONSTRAINT_SEEDS,
        "ConstraintSeeds",
        "execute_batch handed a look-alike authority",
    );
    caused_by(&f, "hook_authority");
    let other_program = execute_batch_with(&payer, &a, |x| x.hook_program = DBC_PROGRAM_ID);
    let f = env.send(&[other_program], &[]).fails_with(
        code(E::AccountMismatch),
        "AccountMismatch",
        "execute_batch handed another program as the hook",
    );
    caused_by(&f, "hook_program");
    // Transaction builders must mark the policy writable (A9).
    let mut read_only = execute_batch(&payer, &a);
    for meta in read_only
        .accounts
        .iter_mut()
        .filter(|m| m.pubkey == a.policy)
    {
        meta.is_writable = false;
    }
    let f = env.send(&[read_only], &[]).fails_with(
        CONSTRAINT_MUT,
        "ConstraintMut",
        "execute_batch with the policy read-only",
    );
    caused_by(&f, "policy");

    assert_eq!(
        (policy_data(env, &a), policy_data(env, &b)),
        (policy_a.clone(), policy_b.clone())
    );
    assert!(!env.anchor::<Launch>(&a.launch).executed);
    let buyer_a = buyer(env, &a);
    let buyer_b = buyer(env, &b);
    for (k, who) in [(&a, &buyer_a), (&b, &buyer_b)] {
        env.send(&[dbc_swap(&who.pubkey(), k, true, SMALL_BUY)], &[who])
            .fails_with(shield(), "SnipeShield", "a buy while both shields hold");
    }

    // The real batch of launch A ends A's shield, and only A's.
    env.send(&[execute_batch(&m, &a)], &[&mallory])
        .expect_ok("execute_batch");
    assert_only_the_shield_end_changed(&policy_a, &policy_data(env, &a));
    assert_eq!(
        env.anchor::<HookPolicy>(&a.policy).snipe_shield_end_ts,
        l.commit_end_ts
    );
    assert_eq!(policy_data(env, &b), policy_b);
    env.send(
        &[dbc_swap(&buyer_a.pubkey(), &a, true, SMALL_BUY)],
        &[&buyer_a],
    )
    .expect_ok("a buy on launch A after its batch");
    env.send(
        &[dbc_swap(&buyer_b.pubkey(), &b, true, SMALL_BUY)],
        &[&buyer_b],
    )
    .fails_with(
        shield(),
        "SnipeShield",
        "a buy on launch B, whose batch has not run",
    );
    // A's executed batch is no lever on B either.
    env.send(
        &[end_snipe_shield(&creator.pubkey(), true, &b.policy)],
        &[&creator],
    )
    .fails_with(
        CONSTRAINT_SEEDS,
        "ConstraintSeeds",
        "the creator, on launch B",
    );
    assert_eq!(policy_data(env, &b), policy_b);
}

/// Round 2: keepers will send `execute_batch` with a tight compute limit and
/// a priority fee (SDK). Its cost with the `end_snipe_shield` CPI, on the
/// longest curve the policy accepts (8 points, the batch crossing 7 of
/// them) and with the largest dynamic fee, stays under 250,000 CU, and the
/// transaction with both compute-budget instructions fits a legacy
/// transaction.
#[test]
fn r2_execute_batch_compute_on_the_longest_curve() {
    let dynamic = max_dynamic_fee();
    let mut w = launched_with(move |p| {
        p.dynamic_fee = Some(dynamic);
        let start = p.sqrt_start_price;
        let main = p.curve[0];
        p.curve = (1..=7u128)
            .map(|i| CurvePoint {
                sqrt_price: start + start * i / 16,
                liquidity: main.liquidity,
            })
            .chain([main])
            .collect();
        assert_eq!(p.curve.len(), MAX_CURVE_POINTS);
    });
    let k = w.k;
    let crossed = w.params.curve[6].sqrt_price;
    let env = &mut w.env;
    commit_two(env, &k);
    let l: Launch = env.anchor(&k.launch);
    env.set_time(l.commit_end_ts);
    let payer = env.payer.pubkey();
    let ixs = [
        ComputeBudgetInstruction::set_compute_unit_price(1_000),
        execute_batch(&payer, &k),
    ];
    let sent = env
        .send_with(&payer, &ixs, &[], true)
        .expect_ok("execute_batch");
    let pool = env.anchor::<TransferHookPool>(&k.pool).pool_state;
    assert!(
        pool.sqrt_price > crossed,
        "the batch crossed 7 curve points"
    );
    execute_batch_cu(
        "execute_batch on an 8-point curve, with a priority fee",
        &sent,
    );
    assert!(sent.cu < 250_000, "{} CU", sent.cu);
    assert!(sent.size <= PACKET_DATA_SIZE);
}

/// The mint's transfer-hook program (`None` once DBC revoked the hook).
fn hook_program(env: &Env, mint: &Pubkey) -> Option<Pubkey> {
    let account = env.account(mint).expect("mint");
    let state = StateWithExtensions::<Mint>::unpack(&account.data).unwrap();
    state
        .get_extension::<TransferHook>()
        .unwrap()
        .program_id
        .into()
}

/// Round 2 (A9): `end_snipe_shield` never reads the mint, so a batch whose
/// swap completes the curve, in which DBC revokes the hook (program and
/// authority set to None) before `execute_batch` calls the hook, still
/// executes and still ends the shield. A batch capped at the threshold
/// cannot complete the curve by itself (the fee comes out of its input, so
/// the reserve stays under the threshold), so the pool's quote reserve is
/// raised in the ledger first, and nothing else: the batch is still the
/// pool's first swap at the opening price. Claims then need no hook
/// accounts.
#[test]
fn r2_a_batch_that_completes_the_curve_still_ends_the_shield() {
    let mut w = launched();
    let k = w.k;
    let env = &mut w.env;
    let payer = env.payer.pubkey();
    let l: Launch = env.anchor(&k.launch);
    let threshold = l.migration_quote_threshold;
    assert_eq!(l.batch_total_cap, threshold);
    let alice = committer(env, 2 * LAMPORTS_PER_SOL);
    let bob = committer(env, 2 * LAMPORTS_PER_SOL);
    for who in [&alice, &bob] {
        env.send(&[commit(&who.pubkey(), &k, 2 * LAMPORTS_PER_SOL)], &[who])
            .expect_ok("commit");
    }

    // The batch's 4 SOL less the fee lands the reserve over the threshold.
    let mut pool = env.account(&k.pool).expect("pool");
    let at = 8 + std::mem::offset_of!(TransferHookPool, pool_state.quote_reserve);
    let before = pool.data.clone();
    assert_eq!(&pool.data[at..at + 8], &0u64.to_le_bytes());
    pool.data[at..at + 8].copy_from_slice(&(threshold - LAMPORTS_PER_SOL).to_le_bytes());
    env.svm.set_account(k.pool, pool).expect("set pool");
    let changed: Vec<usize> = (0..before.len())
        .filter(|&i| env.account(&k.pool).unwrap().data[i] != before[i])
        .collect();
    assert!(changed.iter().all(|i| (at..at + 8).contains(i)));
    assert_eq!(hook_program(env, &k.mint), Some(noised_hook::ID));

    let batch_at = l.commit_end_ts + 1;
    env.set_time(batch_at);
    let sent = env
        .send(&[execute_batch(&payer, &k)], &[])
        .expect_ok("execute_batch completing the curve");
    execute_batch_cu("execute_batch completing the curve", &sent);
    // DBC completed the curve and revoked the hook inside the swap ...
    let s = env.anchor::<TransferHookPool>(&k.pool).pool_state;
    assert!(s.quote_reserve >= threshold && s.finish_curve_timestamp > 0);
    assert_eq!(hook_program(env, &k.mint), None);
    // ... and the hook still ended the shield, at the batch.
    let e = shield_ended(&sent);
    assert_eq!(
        (e.scheduled_end_ts, e.snipe_shield_end_ts),
        (l.execute_end_ts, batch_at)
    );
    let policy: HookPolicy = env.anchor(&k.policy);
    assert_eq!(
        (policy.snipe_shield_end_ts, policy.guard_end_ts),
        (batch_at, l.guard_end_ts)
    );
    let l: Launch = env.anchor(&k.launch);
    assert!(l.executed && l.tokens_out > 0);
    assert_eq!(l.quote_spent, 4 * LAMPORTS_PER_SOL);

    // Claims after the revocation pass no hook accounts.
    for who in [&alice, &bob] {
        env.send(&[claim(&payer, &k, &who.pubkey(), true, false)], &[])
            .expect_ok("claim after the curve completed");
        assert_eq!(
            env.token_amount(&base_ata(&who.pubkey(), &k.mint)),
            l.tokens_out / 2
        );
    }
    assert_escrow_invariants(env, &k);
}

/// Round 2 (A9): `end_snipe_shield` only ever moves the shield's end
/// earlier. No real batch finds that end already behind it (a batch runs
/// only before `execute_end_ts`, the scheduled end), so the end is moved
/// back in the ledger first, to 30 s after launch, and nothing else changes.
/// The batch still executes as the pool's first swap (once the shield is
/// over its buy is an ordinary buy into the exempt batch escrow), and the
/// hook keeps the earlier end: the policy is byte for byte what it was, and
/// the event reports that end twice.
#[test]
fn r2_the_batch_never_moves_the_shield_end_later() {
    let mut w = launched();
    let k = w.k;
    let env = &mut w.env;
    let payer = env.payer.pubkey();
    let l: Launch = env.anchor(&k.launch);
    commit_two(env, &k);

    let earlier = l.launch_ts + 30;
    let at_launch = policy_data(env, &k);
    let mut policy = env.account(&k.policy).expect("policy");
    policy.data[SHIELD_END_OFFSET..SHIELD_END_OFFSET + 8].copy_from_slice(&earlier.to_le_bytes());
    env.svm.set_account(k.policy, policy).expect("set policy");
    let moved = policy_data(env, &k);
    assert_only_the_shield_end_changed(&at_launch, &moved);
    assert_eq!(
        env.anchor::<HookPolicy>(&k.policy).snipe_shield_end_ts,
        earlier
    );

    let batch_at = l.commit_end_ts + 5;
    env.set_time(batch_at);
    let sent = env
        .send(&[execute_batch(&payer, &k)], &[])
        .expect_ok("execute_batch after the shield's end");
    let e = shield_ended(&sent);
    assert_eq!(
        (e.scheduled_end_ts, e.snipe_shield_end_ts),
        (earlier, earlier)
    );
    assert_eq!(policy_data(env, &k), moved);
    let l: Launch = env.anchor(&k.launch);
    assert!(l.executed);
    assert_eq!(l.tokens_out, batch_tokens_out(|_| {}));
}

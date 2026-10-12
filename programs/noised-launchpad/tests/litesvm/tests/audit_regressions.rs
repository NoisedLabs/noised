//! Regression tests for the launchpad findings of the first audit (L1-L3),
//! for what the review of those fixes found (zero-output buys through the
//! snipe shield, the batch as the pool's first swap, a buy into the base
//! vault) and for the residuals the docs disclose. They replay each attack
//! against the mainnet DBC, Token-2022, SPL Token and ATA programs. Each
//! test is named after its finding and its doc comment describes the
//! attack; they run with the round-2 rules (minute-long commit windows, the
//! ten-minute execution window the batch ends early, the batch-cap floors),
//! whose own tests are in `audit_round2.rs`. How to build and run: see
//! `src/lib.rs`.

mod common;

use anchor_lang::{solana_program::system_instruction, system_program};
use anchor_spl::token_interface::spl_token_2022::{
    self,
    error::TokenError,
    extension::{memo_transfer, ExtensionType},
    instruction::AuthorityType,
    state::Account as TokenAccount,
};
use common::{launch::*, pq, world::*, *};
use noised_hook::{state::HookPolicy, HookError};
use noised_launchpad::{
    constants::{dbc, *},
    dynamic_bonding_curve::accounts::TransferHookPool,
    error::LaunchpadError as E,
    state::{Commit, CurvePoint, DynamicFeeParams, Launch, LaunchParams},
};
use solana_instruction::{error::InstructionError, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;

/// What `spl-tlv-account-resolution` returns when a transfer lacks one of the
/// hook's extra accounts (`AccountResolutionError::IncorrectAccount`).
const INCORRECT_HOOK_ACCOUNT: u32 = 2_724_315_840;

/// DBC 0.2.x sends 20% of every trading fee to the protocol (rounded down).
const DBC_PROTOCOL_FEE_PERCENT: u64 = 20;

/// DBC's `SwapMode::ExactIn` (`dbc::SWAP_MODE_PARTIAL_FILL` is 1).
const SWAP_MODE_EXACT_IN: u8 = 0;

/// Anchor's `ConstraintDuplicateMutableAccount`, as DBC (an Anchor program)
/// reports it.
const DUPLICATE_MUTABLE_ACCOUNT: u32 = 2_040;

/// A new, non-ATA token account of `mint` owned by `owner`, created by
/// `payer`: anyone can open a token account for any owner.
fn token_account(
    env: &mut Env,
    payer: &Keypair,
    mint: &Pubkey,
    token_program: &Pubkey,
    owner: &Pubkey,
) -> Pubkey {
    let account = Keypair::new();
    // Token-2022 accounts of a hooked mint carry the TransferHookAccount extension.
    let extensions: &[ExtensionType] = if *token_program == TOKEN_2022_PROGRAM_ID {
        &[ExtensionType::TransferHookAccount]
    } else {
        &[]
    };
    let space = ExtensionType::try_calculate_account_len::<TokenAccount>(extensions).unwrap();
    let lamports = env.svm.minimum_balance_for_rent_exemption(space);
    let ixs = [
        system_instruction::create_account(
            &payer.pubkey(),
            &account.pubkey(),
            lamports,
            space as u64,
            token_program,
        ),
        spl_token_2022::instruction::initialize_account3(
            token_program,
            &account.pubkey(),
            mint,
            owner,
        )
        .unwrap(),
    ];
    env.send(&ixs, &[payer, &account])
        .expect_ok("create token account");
    account.pubkey()
}

/// SPL Token `SetAuthority(AccountOwner)` on `account`, signed by `owner`.
fn set_account_owner(account: &Pubkey, owner: &Pubkey, new_owner: &Pubkey) -> Instruction {
    spl_token_2022::instruction::set_authority(
        &TOKEN_PROGRAM_ID,
        account,
        Some(new_owner),
        AuthorityType::AccountOwner,
        owner,
        &[],
    )
    .unwrap()
}

/// What one commit must receive from an executed batch, computed here
/// independently of the program: `floor(tokens_out * c / total)` tokens and
/// `floor((total - quote_spent) * c / total)` wSOL.
fn expected_share(l: &Launch, c: u64) -> (u64, u64) {
    let total = u128::from(l.total_committed);
    let tokens = u128::from(l.tokens_out) * u128::from(c) / total;
    let unspent = u128::from(l.total_committed - l.quote_spent);
    let refund = unspent * u128::from(c) / total;
    (tokens as u64, refund as u64)
}

/// Execute the batch at `commit_end_ts`, then let a third party claim every
/// commit and check each payout against the claim math. Returns the executed
/// launch and `(tokens, refund)` per committer.
fn execute_and_claim_all(
    env: &mut Env,
    k: &Keys,
    committers: &[&Keypair],
) -> (Launch, Vec<(u64, u64)>) {
    let l: Launch = env.anchor(&k.launch);
    env.set_time(l.commit_end_ts);
    let payer = env.payer.pubkey();
    let sent = env
        .send(&[execute_batch(&payer, k)], &[])
        .expect_ok("execute_batch");
    println!("execute_batch: {} CU, {} bytes", sent.cu, sent.size);
    let l: Launch = env.anchor(&k.launch);
    // Below the migration threshold the curve takes the whole input.
    assert_eq!(l.quote_spent, l.total_committed.min(l.batch_total_cap));
    assert!(l.tokens_out > 0);
    assert_escrow_invariants(env, k);

    let mut paid = Vec::new();
    for who in committers {
        let owner = who.pubkey();
        let c: Commit = env.anchor(&k.commit(&owner));
        let (tokens, refund) = expected_share(&l, c.amount);
        let wsol_before = env.token_amount(&wsol_ata(&owner));
        let base_before = env.token_amount(&base_ata(&owner, &k.mint));
        env.send(&[claim(&payer, k, &owner, true, true)], &[])
            .expect_ok("claim");
        assert_eq!(
            env.token_amount(&base_ata(&owner, &k.mint)) - base_before,
            tokens,
            "tokens of a {} lamport commit",
            c.amount
        );
        assert_eq!(
            env.token_amount(&wsol_ata(&owner)) - wsol_before,
            refund,
            "refund of a {} lamport commit",
            c.amount
        );
        env.send(&[claim(&payer, k, &owner, true, true)], &[])
            .fails_with(code(E::AlreadyClaimed), "AlreadyClaimed", "double claim");
        assert_escrow_invariants(env, k);
        paid.push((tokens, refund));
    }

    let l: Launch = env.anchor(&k.launch);
    let tokens: u64 = paid.iter().map(|p| p.0).sum();
    let refunds: u64 = paid.iter().map(|p| p.1).sum();
    assert_eq!((l.tokens_claimed, l.quote_refunded), (tokens, refunds));
    let unspent = l.total_committed - l.quote_spent;
    assert!(tokens <= l.tokens_out && refunds <= unspent);
    // Rounding leaves less than one unit per commit in each escrow.
    let n = committers.len() as u64;
    assert!(l.tokens_out - tokens < n && unspent - refunds < n);
    (l, paid)
}

/// The compute budget of a `[launch, commit]` bundle sent as a v1
/// transaction: the whole limit, a priority fee, and room to load DBC.
fn launch_commit_config() -> solana_message::v1::TransactionConfig {
    solana_message::v1::TransactionConfig::empty()
        .with_compute_unit_limit(1_400_000)
        .with_priority_fee(10_000)
        .with_loaded_accounts_data_size_limit(64 * 1024 * 1024)
}

/// L1 (first-come-first-served batch cap: the creator self-snipes the
/// batch). `commit` refused anything past `batch_total_cap`, and commits open
/// in the `launch` transaction itself, so a creator could send
/// `[launch, commit(cap)]` atomically: every later commit failed with
/// CapExceeded and the creator alone bought the whole batch at the opening
/// price (75% of the supply in the auditors' PoC), exempt from max-wallet.
/// Now the total cap never refuses a commit: the batch spends
/// `min(total_committed, batch_total_cap)` and everyone, the creator
/// included, gets the same pro-rata share of the tokens and of the unspent
/// wSOL. The per-wallet cap still refuses.
#[test]
fn l1_creator_filling_the_cap_in_the_launch_transaction_is_scaled_pro_rata() {
    let cap = 2 * LAMPORTS_PER_SOL;
    let mut w = created_with(|p| {
        p.batch_total_cap = cap;
        p.batch_wallet_cap = cap;
    });
    let k = w.k;
    let env = &mut w.env;
    let c = w.creator.pubkey();
    env.send(&wrap_sol(&c, cap + 1), &[&w.creator])
        .expect_ok("creator wraps");

    // The creator's commit rides in the launch transaction itself. (Size is
    // no defense: with a compute-unit price this pair outgrows a legacy
    // transaction since PQ v2, and a v1 transaction carries it. Clients
    // send `launch` alone.)
    pq::attest(env, &k, META);
    let ixs = [launch(&c, &k, NAME, SYMBOL, URI), commit(&c, &k, cap)];
    let sent = env
        .send_v1(&w.creator, &ixs, &[&w.mint], launch_commit_config())
        .expect_ok("launch + commit(cap) in one transaction");
    println!(
        "launch + commit (v1, with a priority fee): {} CU, {} bytes",
        sent.cu, sent.size
    );
    let l: Launch = env.anchor(&k.launch);
    assert_eq!((l.total_committed, l.batch_total_cap), (cap, cap));

    // The per-wallet cap still binds ...
    env.send(&[commit(&c, &k, 1)], &[&w.creator]).fails_with(
        code(E::CapExceeded),
        "CapExceeded",
        "creator over the wallet cap",
    );
    // ... but a full batch no longer shuts anyone out, until the last second.
    let alice = committer(env, cap);
    let bob = committer(env, 1_234_567_891);
    let carol = committer(env, 765_432_111);
    let a = alice.pubkey();
    env.send(&[commit(&a, &k, cap - 1)], &[&alice])
        .expect_ok("alice commits into a full batch");
    env.send(&[commit(&a, &k, 2)], &[&alice]).fails_with(
        code(E::CapExceeded),
        "CapExceeded",
        "alice over the wallet cap",
    );
    env.send(&[commit(&a, &k, 1)], &[&alice])
        .expect_ok("alice tops up to exactly the wallet cap");
    env.send(&[commit(&bob.pubkey(), &k, 1_234_567_891)], &[&bob])
        .expect_ok("bob commits");
    env.set_time(l.commit_end_ts - 1);
    env.send(&[commit(&carol.pubkey(), &k, 765_432_111)], &[&carol])
        .expect_ok("carol commits in the last second");
    let total = 2 * cap + 1_234_567_891 + 765_432_111;
    let l: Launch = env.anchor(&k.launch);
    assert_eq!(l.total_committed, total);

    let creator = w.creator.insecure_clone();
    let (l, paid) = execute_and_claim_all(env, &k, &[&creator, &alice, &bob, &carol]);
    // Oversubscribed 3x: the batch bought exactly the cap, the rest comes back.
    assert_eq!(l.quote_spent, cap);
    let (creator_tokens, creator_refund) = paid[0];
    // First in (inside the launch transaction) or last in, everyone pays the
    // same price: the creator's cap-sized commit gets a third, not all.
    assert_eq!(creator_tokens, expected_share(&l, cap).0);
    assert!(creator_tokens < l.tokens_out / 2 && creator_refund > 0);
    println!(
        "oversubscribed batch: {} of {} lamports spent; the creator got {} of {} tokens and {} lamports back",
        l.quote_spent, total, creator_tokens, l.tokens_out, creator_refund
    );
}

/// L1, boundary: commits that add up to exactly `batch_total_cap` are all
/// spent and nothing is refunded.
#[test]
fn l1_batch_exactly_at_the_cap_spends_everything() {
    let cap = 3 * LAMPORTS_PER_SOL;
    let mut w = launched_with(|p| p.batch_total_cap = cap);
    let k = w.k;
    let env = &mut w.env;
    let alice = committer(env, 1_000_000_001);
    let bob = committer(env, 1_999_999_999);
    env.send(&[commit(&alice.pubkey(), &k, 1_000_000_001)], &[&alice])
        .expect_ok("alice commits");
    env.send(&[commit(&bob.pubkey(), &k, 1_999_999_999)], &[&bob])
        .expect_ok("bob commits");
    let (l, paid) = execute_and_claim_all(env, &k, &[&alice, &bob]);
    assert_eq!((l.total_committed, l.quote_spent), (cap, cap));
    assert!(paid
        .iter()
        .all(|&(tokens, refund)| tokens > 0 && refund == 0));
}

/// L1, undersubscribed: below the cap the batch spends every lamport
/// committed, as before the fix.
#[test]
fn l1_undersubscribed_batch_spends_the_whole_total() {
    let cap = 5 * LAMPORTS_PER_SOL;
    let mut w = launched_with(|p| p.batch_total_cap = cap);
    let k = w.k;
    let env = &mut w.env;
    let amounts = [LAMPORTS_PER_SOL, 500_000_001, 333_333_333];
    let committers: Vec<Keypair> = amounts.iter().map(|&a| committer(env, a)).collect();
    for (who, amount) in committers.iter().zip(amounts) {
        env.send(&[commit(&who.pubkey(), &k, amount)], &[who])
            .expect_ok("commit");
    }
    let refs: Vec<&Keypair> = committers.iter().collect();
    let (l, paid) = execute_and_claim_all(env, &k, &refs);
    let total: u64 = amounts.iter().sum();
    assert!(total < cap);
    assert_eq!((l.total_committed, l.quote_spent), (total, total));
    assert!(paid
        .iter()
        .all(|&(tokens, refund)| tokens > 0 && refund == 0));
}

/// L1, documented residual (the self-snipe that remains). With
/// `batch_wallet_cap = 0` nothing limits one wallet's commit, so the creator
/// can still commit a multiple of `batch_total_cap` inside the launch
/// transaction. That buys no head start: the creator gets exactly
/// `floor(tokens_out * c / total)` tokens like everyone, pays exactly its
/// share of the cap (rounded up by at most one lamport) and has the excess
/// refunded. What remains is the disclosed "proportionally larger share":
/// capital, locked only for the commit window, buys most of the batch.
#[test]
fn l1_creator_overcommitting_in_the_launch_transaction_gets_exactly_its_pro_rata_share() {
    let cap = 2 * LAMPORTS_PER_SOL;
    let mut w = created_with(|p| p.batch_total_cap = cap);
    assert_eq!(w.params.batch_wallet_cap, 0);
    let k = w.k;
    let env = &mut w.env;
    let c = w.creator.pubkey();
    let creator_commit = 4 * cap;
    env.send(&wrap_sol(&c, creator_commit), &[&w.creator])
        .expect_ok("creator wraps");
    pq::attest(env, &k, META);
    let ixs = [
        launch(&c, &k, NAME, SYMBOL, URI),
        commit(&c, &k, creator_commit),
    ];
    env.send_v1(&w.creator, &ixs, &[&w.mint], launch_commit_config())
        .expect_ok("launch + commit(4 x cap) in one transaction");
    let alice = committer(env, LAMPORTS_PER_SOL);
    let bob = committer(env, 1_000_000_007);
    env.send(&[commit(&alice.pubkey(), &k, LAMPORTS_PER_SOL)], &[&alice])
        .expect_ok("alice commits");
    env.send(&[commit(&bob.pubkey(), &k, 1_000_000_007)], &[&bob])
        .expect_ok("bob commits");

    let creator = w.creator.insecure_clone();
    let (l, paid) = execute_and_claim_all(env, &k, &[&creator, &alice, &bob]);
    let total = creator_commit + LAMPORTS_PER_SOL + 1_000_000_007;
    assert_eq!((l.total_committed, l.quote_spent), (total, cap));
    let (tokens, refund) = paid[0];
    assert_eq!((tokens, refund), expected_share(&l, creator_commit));
    // Its wSOL cost is its share of the cap: c - floor((total - cap) * c / total)
    // = ceil(cap * c / total). The rest of its commit came back.
    let spent = creator_commit - refund;
    let share_of_cap = (u128::from(cap) * u128::from(creator_commit)).div_ceil(u128::from(total));
    assert_eq!(u128::from(spent), share_of_cap);
    // 80% of the commits buy 80% of the batch: most of it, not all of it.
    assert!(tokens > l.tokens_out / 4 * 3 && tokens < l.tokens_out);
    println!(
        "creator committed {creator_commit} of {total} lamports in the launch transaction: \
         {tokens} of {} tokens for {spent} lamports, {refund} refunded",
        l.tokens_out
    );
}

/// L1 and guarantee L4: a batch too small to buy anything cannot execute
/// and refunds in full. One lamport committed is all fee (the 1% floor,
/// rounded up) and buys 0 base units, so `execute_batch` fails with
/// `EmptySwap` whenever it is tried: the batch expires and the commit comes
/// back. Two lamports already buy something. (Until round 2 a 1-lamport
/// `batch_total_cap` did the same to any batch; the policy now refuses it.)
#[test]
fn l1_a_batch_too_small_to_buy_anything_refunds_in_full() {
    let mut w = launched();
    let k = w.k;
    let env = &mut w.env;
    let payer = env.payer.pubkey();
    let l: Launch = env.anchor(&k.launch);
    let pool_at_launch = env.account(&k.pool).expect("pool").data;
    let policy_at_launch = env.account(&k.policy).expect("policy").data;
    let amounts = [1];
    let committers: Vec<Keypair> = amounts.iter().map(|&a| committer(env, a)).collect();
    for (who, amount) in committers.iter().zip(amounts) {
        env.send(&[commit(&who.pubkey(), &k, amount)], &[who])
            .expect_ok("commit");
    }

    for at in [l.commit_end_ts, l.execute_end_ts - 1] {
        env.set_time(at);
        let f = env.send(&[execute_batch(&payer, &k)], &[]).fails_with(
            code(E::EmptySwap),
            "EmptySwap",
            "1-lamport batch",
        );
        // DBC ran the swap and the hook passed the batch's 0-unit transfer;
        // the launchpad's own check refused the result.
        let hook_passed = format!("Program {} success", noised_hook::ID);
        assert!(invoked(&f.logs, &DBC_PROGRAM_ID) && f.logs.contains(&hook_passed));
    }
    // Nothing changed: the pool, and the shield, which a failed batch never ends.
    assert_eq!(env.account(&k.pool).unwrap().data, pool_at_launch);
    assert_eq!(env.account(&k.policy).unwrap().data, policy_at_launch);
    assert!(!env.anchor::<Launch>(&k.launch).executed);

    env.set_time(l.execute_end_ts);
    env.send(&[execute_batch(&payer, &k)], &[]).fails_with(
        code(E::NotExecuteWindow),
        "NotExecuteWindow",
        "execute after the window",
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
    assert_eq!(l.quote_refunded, l.total_committed);
    assert_eq!(env.token_amount(&wsol_ata(&k.batch_authority)), 0);

    // Two lamports: one of fee, one that buys, shared by two committers.
    let mut w = launched();
    let k = w.k;
    let env = &mut w.env;
    let amounts = [1, 1];
    let committers: Vec<Keypair> = amounts.iter().map(|&a| committer(env, a)).collect();
    for (who, amount) in committers.iter().zip(amounts) {
        env.send(&[commit(&who.pubkey(), &k, amount)], &[who])
            .expect_ok("commit");
    }
    let refs: Vec<&Keypair> = committers.iter().collect();
    let (l, paid) = execute_and_claim_all(env, &k, &refs);
    assert_eq!(l.quote_spent, 2);
    assert!(paid
        .iter()
        .all(|&(tokens, refund)| tokens > 0 && refund == 0));
    println!("2-lamport batch: {} base units bought", l.tokens_out);
}

/// The base fee once the schedule is over (the linear scheduler of `params()`).
fn floor_fee_numerator(p: &LaunchParams) -> u64 {
    assert_eq!(p.base_fee.base_fee_mode, dbc::BASE_FEE_MODE_LINEAR);
    p.base_fee.cliff_fee_numerator - u64::from(p.base_fee.first_factor) * p.base_fee.third_factor
}

/// DBC's variable fee for a volatility accumulator:
/// `ceil((accumulator * bin_step)^2 * variable_fee_control / 1e11)`.
fn variable_fee_numerator(accumulator: u128, d: &DynamicFeeParams) -> u64 {
    let scaled = accumulator * u128::from(d.bin_step);
    let fee =
        (scaled * scaled * u128::from(d.variable_fee_control)).div_ceil(dbc::VARIABLE_FEE_SCALE);
    u64::try_from(fee).unwrap()
}

/// DBC's fee on a quote input: `ceil(amount * numerator / 1e9)`.
fn trading_fee(amount: u64, numerator: u64) -> u64 {
    let fee =
        (u128::from(amount) * u128::from(numerator)).div_ceil(u128::from(dbc::FEE_DENOMINATOR));
    u64::try_from(fee).unwrap()
}

/// Every quote fee the DBC pool has collected (partner, protocol, creator).
fn pool_quote_fees(env: &Env, k: &Keys) -> (u64, u64, u64) {
    let pool: TransferHookPool = env.anchor(&k.pool);
    let s = pool.pool_state;
    (
        s.partner_quote_fee,
        s.protocol_quote_fee,
        s.creator_quote_fee,
    )
}

/// Sum of `pool_quote_fees`.
fn total_quote_fees(env: &Env, k: &Keys) -> u64 {
    let (partner, protocol, creator) = pool_quote_fees(env, k);
    partner + protocol + creator
}

/// The pool was never swapped: no swap flag, the opening price, an empty
/// volatility tracker.
#[track_caller]
fn assert_never_swapped(env: &Env, k: &Keys, sqrt_start_price: u128) {
    let s = env.anchor::<TransferHookPool>(&k.pool).pool_state;
    let v = s.volatility_tracker;
    assert_eq!((s.has_swap, s.sqrt_price), (0, sqrt_start_price));
    assert_eq!((v.volatility_accumulator, v.volatility_reference), (0, 0));
    assert_eq!((v.sqrt_price_reference, v.last_update_timestamp), (0, 0));
}

/// The reviewer's curve: a first segment (+2% sqrt price) holding liquidity
/// 1, then the main segment of `params()`.
fn dust_first_segment(p: &mut LaunchParams) {
    let start = p.sqrt_start_price;
    let main = p.curve[0];
    p.curve = vec![
        CurvePoint {
            sqrt_price: start + start / 50,
            liquidity: 1,
        },
        main,
    ];
}

/// L2 (exempt-owner buys during the snipe shield). The hook let any buy
/// through the shield when the receiving owner was exempt, and anyone can
/// open a token account owned by the batch or launch authority PDA. One
/// cheap buy into such an account before `execute_batch` moved the opening
/// price and saturated DBC's volatility accumulator, so the batch paid the
/// creator's maximum dynamic fee instead of the floor (+0.22 SOL to the
/// creator's fee recipients on a 4 SOL batch in the auditors' PoC). Now,
/// until the shield ends, the only buy that passes is the one inside the
/// launchpad's top-level `execute_batch`, read from the instructions sysvar.
#[test]
fn l2_exempt_owner_accounts_cannot_buy_through_the_snipe_shield() {
    // The hook recognizes the batch by the launchpad's instruction discriminator.
    assert_eq!(
        <noised_launchpad::instruction::ExecuteBatch as anchor_lang::Discriminator>::DISCRIMINATOR,
        &noised_hook::EXECUTE_BATCH_DISCRIMINATOR[..]
    );
    let dynamic = max_dynamic_fee();
    let mut w = launched_with(|p| p.dynamic_fee = Some(dynamic));
    let k = w.k;
    let floor = floor_fee_numerator(&w.params);
    let start_sqrt_price = w.params.sqrt_start_price;
    let env = &mut w.env;
    let l: Launch = env.anchor(&k.launch);
    let pool_at_launch = env.account(&k.pool).expect("pool").data;
    for _ in 0..2 {
        let who = committer(env, 2 * LAMPORTS_PER_SOL);
        env.send(&[commit(&who.pubkey(), &k, 2 * LAMPORTS_PER_SOL)], &[&who])
            .expect_ok("commit");
    }

    // Every kind of account an attacker can open for an exempt owner.
    let mallory = committer(env, LAMPORTS_PER_SOL);
    let m = mallory.pubkey();
    env.send(
        &[
            create_ata(&m, &k.batch_authority, &k.mint, &TOKEN_2022_PROGRAM_ID),
            create_ata(&m, &k.launch_authority, &k.mint, &TOKEN_2022_PROGRAM_ID),
        ],
        &[&mallory],
    )
    .expect_ok("exempt-owner ATAs");
    let la_account = token_account(
        env,
        &mallory,
        &k.mint,
        &TOKEN_2022_PROGRAM_ID,
        &k.launch_authority,
    );
    let ba_account = token_account(
        env,
        &mallory,
        &k.mint,
        &TOKEN_2022_PROGRAM_ID,
        &k.batch_authority,
    );
    let targets = [
        (
            "buy into the batch base escrow",
            base_ata(&k.batch_authority, &k.mint),
        ),
        (
            "buy into the launch authority's ATA",
            base_ata(&k.launch_authority, &k.mint),
        ),
        ("buy into an account the launch authority owns", la_account),
        ("buy into an account the batch authority owns", ba_account),
    ];
    let buy = |target: Pubkey| dbc_buy_into(&m, &k, target, 10_500_000);
    let shield = hook_code(HookError::SnipeShield);

    // The PoC's timing (base-fee schedule over, commits open), then the
    // execution window right before the batch.
    for at in [l.launch_ts + 12, l.commit_end_ts] {
        env.set_time(at);
        for (what, target) in targets {
            env.send(&[buy(target)], &[&mallory])
                .fails_with(shield, "SnipeShield", what);
        }
    }
    // Not even next to the real batch, in one legacy transaction: the hook
    // checks the top-level instruction doing the transfer, not the
    // transaction. A buy placed after the batch in its transaction passes
    // since round 2: by then the batch has ended the shield (see
    // `audit_round2.rs`, `r2_the_batch_ends_the_snipe_shield_in_its_own_slot`).
    for target in [targets[0].1, targets[1].1] {
        let ixs = [buy(target), execute_batch(&m, &k)];
        env.send_with(&m, &ixs, &[&mallory], true).fails_with(
            shield,
            "SnipeShield",
            "buy before the batch, in the batch's transaction",
        );
    }
    // The hook only ever reads the real instructions sysvar: Token-2022
    // resolves that extra account by its fixed address, so any other account
    // in its slot is refused before the hook runs.
    let mut forged = buy(targets[0].1);
    let sysvar = forged
        .accounts
        .iter()
        .position(|a| a.pubkey == noised_hook::INSTRUCTIONS_SYSVAR_ID)
        .unwrap();
    forged.accounts[sysvar].pubkey = la_account;
    let f = env
        .send(&[forged], &[&mallory])
        .err()
        .expect("forged sysvar accepted");
    assert_eq!(f.custom_code(), Some(INCORRECT_HOOK_ACCOUNT), "{:?}", f.err);
    assert!(!env.anchor::<Launch>(&k.launch).executed);

    // None of it reached the pool: no swap, no price move, no volatility.
    assert_eq!(env.account(&k.pool).unwrap().data, pool_at_launch);
    let pool: TransferHookPool = env.anchor(&k.pool);
    let s = pool.pool_state;
    let v = s.volatility_tracker;
    assert_eq!((s.sqrt_price, s.has_swap), (start_sqrt_price, 0));
    assert_eq!((v.volatility_accumulator, v.volatility_reference), (0, 0));
    assert_eq!((v.sqrt_price_reference, v.last_update_timestamp), (0, 0));

    // The batch executes and pays exactly the floor fee.
    let payer = env.payer.pubkey();
    let sent = env
        .send(&[execute_batch(&payer, &k)], &[])
        .expect_ok("execute_batch");
    println!(
        "execute_batch: {} CU (the hook: {} checking the batch buy, which reads the \
         instructions sysvar, and {} ending the shield), {} bytes",
        sent.cu,
        program_cu(&sent.logs, &noised_hook::ID, Some(4)),
        program_cu(&sent.logs, &noised_hook::ID, Some(2)),
        sent.size
    );
    let l: Launch = env.anchor(&k.launch);
    assert_eq!(l.quote_spent, 4 * LAMPORTS_PER_SOL);
    let (partner, protocol, creator) = pool_quote_fees(env, &k);
    let batch_fee = trading_fee(l.quote_spent, floor);
    assert_eq!(partner + protocol + creator, batch_fee, "the floor fee");
    assert_eq!(
        (protocol, creator),
        (batch_fee * DBC_PROTOCOL_FEE_PERCENT / 100, 0)
    );
    // Same tokens as the same batch on a launch without a dynamic fee.
    assert_eq!(l.tokens_out, batch_tokens_out(|_| {}));

    // The dynamic fee is live: the batch's own price move sets the
    // accumulator that prices the next trade.
    let accumulator = env
        .anchor::<TransferHookPool>(&k.pool)
        .pool_state
        .volatility_tracker
        .volatility_accumulator;
    assert!(accumulator > 0);
    // The batch ended the shield (round 2), so from that same second anyone
    // buys, paying the floor plus the variable fee the batch's own price
    // move left.
    assert_eq!(
        env.anchor::<HookPolicy>(&k.policy).snipe_shield_end_ts,
        l.commit_end_ts
    );
    env.send(
        &[create_ata(&m, &m, &k.mint, &TOKEN_2022_PROGRAM_ID)],
        &[&mallory],
    )
    .expect_ok("mallory's base ATA");
    let before = pool_quote_fees(env, &k);
    let amount = LAMPORTS_PER_SOL / 200;
    let sent = env
        .send(&[dbc_swap(&m, &k, true, amount)], &[&mallory])
        .expect_ok("public buy right after the batch");
    println!(
        "public buy right after the batch: {} CU ({} in the hook), {} bytes",
        sent.cu,
        program_cu(&sent.logs, &noised_hook::ID, None),
        sent.size
    );
    let after = pool_quote_fees(env, &k);
    let paid = (after.0 + after.1 + after.2) - (before.0 + before.1 + before.2);
    let numerator = floor + variable_fee_numerator(accumulator, &dynamic);
    assert!(numerator > floor && numerator < dbc::MAX_FEE_NUMERATOR);
    assert_eq!(paid, trading_fee(amount, numerator));
    println!(
        "fee numerators: batch {floor} (floor), first public trade {numerator} (floor + dynamic)"
    );
}

/// L2, residual (zero-output buys; found in the review of round 1). DBC
/// 0.2.1 executes a buy whose output rounds to 0 base units: the input pays
/// the fee, `has_swap` is set, whatever input is left moves `sqrt_price` and
/// the volatility accumulator, and Token-2022 still calls the hook, with
/// amount 0. The round-1 hook let every zero-amount transfer through before
/// its shield check. On `params()` a 1-lamport buy got through that way (1
/// lamport of fee, nothing bought, `has_swap` set). On a creator curve whose
/// first segment holds dust liquidity, the reviewer's 2-lamport buy crossed
/// that segment (+2% sqrt price) and saturated the volatility accumulator,
/// so the batch paid the floor plus the maximum dynamic fee (395,666,224
/// instead of 40,000,000 lamports on 4 SOL). Now every buy out of the base
/// vault before `execute_end_ts` is refused, whatever its amount, unless it
/// is the batch's.
#[test]
fn l2b_zero_output_buys_cannot_cross_the_snipe_shield() {
    let shield = hook_code(HookError::SnipeShield);

    // (i) params(): 1 lamport is all fee (rounded up), so 0 base units come
    // out, in exact-in and in partial-fill mode.
    let mut w = launched();
    let k = w.k;
    let start = w.params.sqrt_start_price;
    let env = &mut w.env;
    let l: Launch = env.anchor(&k.launch);
    let pool_at_launch = env.account(&k.pool).expect("pool").data;
    let mallory = buyer(env, &k);
    let m = mallory.pubkey();
    for at in [
        l.launch_ts,
        l.launch_ts + 12,
        l.commit_end_ts,
        l.execute_end_ts - 1,
    ] {
        env.set_time(at);
        for swap_mode in [SWAP_MODE_EXACT_IN, dbc::SWAP_MODE_PARTIAL_FILL] {
            env.send(
                &[dbc_swap_mode(&m, &k, true, 1, swap_mode, true)],
                &[&mallory],
            )
            .fails_with(shield, "SnipeShield", "1-lamport buy during the shield");
        }
    }
    assert_eq!(env.account(&k.pool).unwrap().data, pool_at_launch);

    // Only the shield refuses it: from execute_end_ts the same buy runs and,
    // as the reviewer found, buys nothing for its lamport.
    env.set_time(l.execute_end_ts);
    let wsol_before = env.token_amount(&wsol_ata(&m));
    env.send(&[dbc_swap(&m, &k, true, 1)], &[&mallory])
        .expect_ok("1-lamport buy after the shield");
    assert_eq!(wsol_before - env.token_amount(&wsol_ata(&m)), 1);
    assert_eq!(env.token_amount(&base_ata(&m, &k.mint)), 0);
    let s = env.anchor::<TransferHookPool>(&k.pool).pool_state;
    assert_eq!((s.has_swap, s.sqrt_price), (1, start));
    assert_eq!(total_quote_fees(env, &k), 1);

    // (ii) The reviewer's launch: the creator's maximum dynamic fee and a
    // first curve segment holding liquidity 1.
    let dynamic = max_dynamic_fee();
    let tweak = move |p: &mut LaunchParams| {
        p.dynamic_fee = Some(dynamic);
        dust_first_segment(p);
    };
    let mut w = launched_with(tweak);
    let k = w.k;
    let floor = floor_fee_numerator(&w.params);
    let start = w.params.sqrt_start_price;
    let env = &mut w.env;
    let l: Launch = env.anchor(&k.launch);
    let pool_at_launch = env.account(&k.pool).expect("pool").data;
    for _ in 0..2 {
        let who = committer(env, 2 * LAMPORTS_PER_SOL);
        env.send(&[commit(&who.pubkey(), &k, 2 * LAMPORTS_PER_SOL)], &[&who])
            .expect_ok("commit");
    }
    let mallory = buyer(env, &k);
    let m = mallory.pubkey();
    for at in [l.launch_ts + 12, l.commit_end_ts] {
        env.set_time(at);
        env.send(&[dbc_swap(&m, &k, true, 2)], &[&mallory])
            .fails_with(
                shield,
                "SnipeShield",
                "2-lamport buy across the dust segment",
            );
    }
    assert_eq!(env.account(&k.pool).unwrap().data, pool_at_launch);
    assert_never_swapped(env, &k, start);

    // The batch is the pool's first swap and pays exactly the floor fee.
    let payer = env.payer.pubkey();
    let sent = env
        .send(&[execute_batch(&payer, &k)], &[])
        .expect_ok("execute_batch");
    println!(
        "execute_batch (dust first segment): {} CU (the hook: {} checking the batch buy, \
         {} ending the shield), {} bytes",
        sent.cu,
        program_cu(&sent.logs, &noised_hook::ID, Some(4)),
        program_cu(&sent.logs, &noised_hook::ID, Some(2)),
        sent.size
    );
    let l: Launch = env.anchor(&k.launch);
    assert_eq!(l.quote_spent, 4 * LAMPORTS_PER_SOL);
    let (partner, protocol, creator) = pool_quote_fees(env, &k);
    let batch_fee = trading_fee(l.quote_spent, floor);
    assert_eq!(partner + protocol + creator, batch_fee, "the floor fee");
    assert_eq!(
        (protocol, creator),
        (batch_fee * DBC_PROTOCOL_FEE_PERCENT / 100, 0)
    );

    // What the refused buy does once the shield is over, on a twin launch
    // nobody committed to: the 2 lamports buy nothing, yet push the price
    // across the dust segment and saturate the accumulator, so the next
    // trade pays the floor plus the maximum dynamic fee. Before the batch,
    // that next trade would have been the batch.
    let mut twin = launched_with(tweak);
    let k = twin.k;
    let env = &mut twin.env;
    let l: Launch = env.anchor(&k.launch);
    let mallory = buyer(env, &k);
    let m = mallory.pubkey();
    env.set_time(l.execute_end_ts);
    env.send(&[dbc_swap(&m, &k, true, 2)], &[&mallory])
        .expect_ok("2-lamport buy after the shield");
    assert_eq!(env.token_amount(&base_ata(&m, &k.mint)), 0);
    let s = env.anchor::<TransferHookPool>(&k.pool).pool_state;
    assert!(
        s.sqrt_price >= start + start / 50,
        "crossed the dust segment"
    );
    let accumulator = s.volatility_tracker.volatility_accumulator;
    assert_eq!(accumulator, u128::from(dynamic.max_volatility_accumulator));
    let before = total_quote_fees(env, &k);
    let amount = LAMPORTS_PER_SOL / 200;
    env.send(&[dbc_swap(&m, &k, true, amount)], &[&mallory])
        .expect_ok("the next buy");
    let numerator = floor + variable_fee_numerator(accumulator, &dynamic);
    assert_eq!(
        total_quote_fees(env, &k) - before,
        trading_fee(amount, numerator)
    );
    println!(
        "fee numerator after a 2-lamport buy across the dust segment: {numerator} (floor {floor})"
    );
}

/// L2, fail-safe (the batch must be the pool's first swap). The hook alone
/// keeps every other buy out until `execute_end_ts`, and nobody holds tokens
/// to sell before the batch. If anything ever got a swap past it, the batch
/// (which buys with no minimum out) would pay a moved price and whatever
/// dynamic fee that swap left. `execute_batch` now requires DBC's
/// `has_swap == 0`: after any earlier swap it can never execute, the batch
/// expires and every commit is refunded in full. The bypass is simulated by
/// setting the pool's `has_swap` byte in the ledger and nothing else.
#[test]
fn l2c_batch_must_be_the_first_swap() {
    let mut w = launched();
    let k = w.k;
    let env = &mut w.env;
    let payer = env.payer.pubkey();
    let amounts = [LAMPORTS_PER_SOL, 700_000_001];
    let committers: Vec<Keypair> = amounts.iter().map(|&a| committer(env, a)).collect();
    for (who, amount) in committers.iter().zip(amounts) {
        env.send(&[commit(&who.pubkey(), &k, amount)], &[who])
            .expect_ok("commit");
    }

    // The bypass: DBC's swap flag set, every other byte of the pool as before.
    let mut pool = env.account(&k.pool).expect("pool");
    let never_swapped = pool.data.clone();
    let has_swap = 8 + std::mem::offset_of!(TransferHookPool, pool_state.has_swap);
    assert_eq!(pool.data[has_swap], 0);
    pool.data[has_swap] = 1;
    env.svm.set_account(k.pool, pool).expect("set pool");
    let swapped = env.account(&k.pool).unwrap().data;
    let changed: Vec<usize> = (0..swapped.len())
        .filter(|&i| swapped[i] != never_swapped[i])
        .collect();
    assert_eq!(changed, [has_swap]);
    assert_eq!(
        env.anchor::<TransferHookPool>(&k.pool).pool_state.has_swap,
        1
    );

    // The batch can never execute ...
    let l: Launch = env.anchor(&k.launch);
    for at in [l.commit_end_ts, l.execute_end_ts - 1] {
        env.set_time(at);
        env.send(&[execute_batch(&payer, &k)], &[]).fails_with(
            code(E::PoolAlreadyTraded),
            "PoolAlreadyTraded",
            "execute after another swap",
        );
    }
    assert_eq!(env.account(&k.pool).unwrap().data, swapped);
    assert!(env
        .account(&base_ata(&k.batch_authority, &k.mint))
        .is_none());
    // A batch that cannot run never ends the shield.
    assert_eq!(
        env.anchor::<HookPolicy>(&k.policy).snipe_shield_end_ts,
        l.execute_end_ts
    );

    // ... so it expires, and every committer gets its whole commit back and
    // no tokens.
    env.set_time(l.execute_end_ts);
    env.send(&[execute_batch(&payer, &k)], &[]).fails_with(
        code(E::NotExecuteWindow),
        "NotExecuteWindow",
        "execute after the window",
    );
    for (who, amount) in committers.iter().zip(amounts) {
        let owner = who.pubkey();
        let before = env.token_amount(&wsol_ata(&owner));
        env.send(&[claim(&payer, &k, &owner, false, false)], &[])
            .expect_ok("refund");
        assert_eq!(env.token_amount(&wsol_ata(&owner)) - before, amount);
        assert!(env.account(&base_ata(&owner, &k.mint)).is_none());
        env.send(&[claim(&payer, &k, &owner, false, false)], &[])
            .fails_with(code(E::AlreadyClaimed), "AlreadyClaimed", "double refund");
        assert_escrow_invariants(env, &k);
    }
    let l: Launch = env.anchor(&k.launch);
    assert!(!l.executed);
    assert_eq!(
        (l.quote_refunded, l.tokens_out, l.tokens_claimed),
        (l.total_committed, 0, 0)
    );
    assert_eq!(env.token_amount(&wsol_ata(&k.batch_authority)), 0);
}

/// L2 and L7, a buy paid into the base vault itself. The hook decides sells
/// from keys alone (destination = base vault), so such a buy must never pass
/// as one. The hook now treats every transfer out of the base vault as a buy
/// (host test `a_transfer_out_of_the_base_vault_is_never_a_sell`), but it
/// would never be asked about this one: Token-2022 returns from a transfer
/// whose source and destination are the same account before it calls the
/// hook. What refuses the buy is DBC: its `output_token_account` and
/// `base_vault` are then the same mutable account, so Anchor's account
/// checks fail (ConstraintDuplicateMutableAccount on `base_vault`) before
/// any transfer. Both facts are pinned here, so a change in either program
/// shows up.
#[test]
fn l2d_dbc_refuses_a_buy_whose_output_is_the_base_vault() {
    let mut w = launched();
    let k = w.k;
    let env = &mut w.env;
    let payer = env.payer.pubkey();
    let l: Launch = env.anchor(&k.launch);
    let pool_at_launch = env.account(&k.pool).expect("pool").data;
    let alice = committer(env, LAMPORTS_PER_SOL);
    let a = alice.pubkey();
    env.send(&[commit(&a, &k, LAMPORTS_PER_SOL)], &[&alice])
        .expect_ok("alice commits");
    let mallory = buyer(env, &k);
    let m = mallory.pubkey();
    let buy_into_the_vault = |env: &mut Env, what: &str| {
        // A buy that pays out nothing and one that pays out tokens.
        for amount in [1, 10_500_000] {
            let ix = dbc_buy_into(&m, &k, k.base_vault, amount);
            let f = env.send(&[ix], &[&mallory]).fails_with(
                DUPLICATE_MUTABLE_ACCOUNT,
                "ConstraintDuplicateMutableAccount",
                what,
            );
            assert_eq!(
                f.err,
                TransactionError::InstructionError(
                    1,
                    InstructionError::Custom(DUPLICATE_MUTABLE_ACCOUNT)
                )
            );
            assert!(
                f.logs
                    .iter()
                    .any(|l| l.contains("AnchorError caused by account: base_vault.")),
                "{what}: refused for another account\n{}",
                f.logs.join("\n")
            );
            assert!(
                !invoked(&f.logs, &TOKEN_2022_PROGRAM_ID) && !invoked(&f.logs, &noised_hook::ID),
                "{what}: refused before any transfer\n{}",
                f.logs.join("\n")
            );
        }
    };

    for at in [l.launch_ts + 12, l.commit_end_ts] {
        env.set_time(at);
        buy_into_the_vault(env, "buy into the base vault during the shield");
    }
    assert_eq!(env.account(&k.pool).unwrap().data, pool_at_launch);
    env.send(&[execute_batch(&payer, &k)], &[])
        .expect_ok("execute_batch");
    env.send(&[claim(&payer, &k, &a, true, true)], &[])
        .expect_ok("alice claims");
    let tokens = env.token_amount(&base_ata(&a, &k.mint));
    assert!(tokens > 0);
    env.set_time(l.execute_end_ts);
    buy_into_the_vault(env, "buy into the base vault after the shield");

    // Token-2022 skips the hook on a self-transfer (shown on alice's account:
    // only DBC's pool authority can move the vault's tokens). During the
    // guard the hook refuses alice's wallet-to-wallet transfer (p2p lock);
    // her transfer from her account to itself passes, and the hook never
    // runs.
    env.send(&[hooked_transfer(&k, &a, &m, 1)], &[&alice])
        .fails_with(
            hook_code(HookError::TransfersLocked),
            "TransfersLocked",
            "alice to mallory during the guard",
        );
    let sent = env
        .send(&[hooked_transfer(&k, &a, &a, tokens)], &[&alice])
        .expect_ok("alice to herself during the guard");
    assert!(invoked(&sent.logs, &TOKEN_2022_PROGRAM_ID));
    assert!(
        !invoked(&sent.logs, &noised_hook::ID),
        "{}",
        sent.logs.join("\n")
    );
    assert_eq!(env.token_amount(&base_ata(&a, &k.mint)), tokens);
}

/// L3 (claim blocked by a reassigned wSOL ATA). `claim` checked the owner's
/// wSOL ATA with Anchor's ATA constraint, which compares the token account's
/// owner field. SPL Token lets a holder reassign its ATA (SetAuthority
/// AccountOwner), after which every claim of that commit failed with
/// ConstraintTokenOwner; an oversubscribed batch pays tokens and a refund in
/// the same claim, so both stayed in the escrows. Now both owner ATAs are
/// checked like `distribute` does (`AtaCreator::ensure`: canonical address,
/// created if missing, owner field not compared), and anything else in
/// those slots is refused.
#[test]
fn l3_claim_pays_a_reassigned_wsol_ata_and_creates_a_missing_base_ata() {
    let cap = 2 * LAMPORTS_PER_SOL;
    let mut w = launched_with(|p| p.batch_total_cap = cap);
    let k = w.k;
    let env = &mut w.env;
    let payer = env.payer.pubkey();
    let alice = committer(env, cap);
    let bob = committer(env, cap);
    let (a, b) = (alice.pubkey(), bob.pubkey());
    env.send(&[commit(&a, &k, cap)], &[&alice])
        .expect_ok("alice commits");
    env.send(&[commit(&b, &k, cap)], &[&bob])
        .expect_ok("bob commits");

    // Alice hands her wSOL ATA to a key nobody holds; she has no base ATA.
    let nobody = Pubkey::new_unique();
    env.send(&[set_account_owner(&wsol_ata(&a), &a, &nobody)], &[&alice])
        .expect_ok("alice reassigns her wSOL ATA");
    assert!(env.account(&base_ata(&a, &k.mint)).is_none());

    let l: Launch = env.anchor(&k.launch);
    env.set_time(l.commit_end_ts);
    env.send(&[execute_batch(&payer, &k)], &[])
        .expect_ok("execute_batch");
    let l: Launch = env.anchor(&k.launch);
    let (tokens, refund) = expected_share(&l, cap);
    assert!(tokens > 0 && refund > 0, "oversubscribed: both legs pay");

    let wsol_before = env.token_amount(&wsol_ata(&a));
    env.send(&[claim(&payer, &k, &a, true, true)], &[])
        .expect_ok("claim with a reassigned wSOL ATA");
    assert_eq!(env.token_amount(&wsol_ata(&a)) - wsol_before, refund);
    assert_eq!(env.token_owner(&wsol_ata(&a)), nobody);
    assert_eq!(env.token_amount(&base_ata(&a, &k.mint)), tokens);
    assert_eq!(env.token_owner(&base_ata(&a, &k.mint)), a);
    assert_escrow_invariants(env, &k);

    // Only bob's canonical ATAs are accepted in bob's ATA slots.
    let bob_wsol = token_account(env, &bob, &WSOL_MINT, &TOKEN_PROGRAM_ID, &b);
    let bob_base = token_account(env, &bob, &k.mint, &TOKEN_2022_PROGRAM_ID, &b);
    let (quote, base) = (wsol_ata(&b), base_ata(&b, &k.mint));
    for (what, q, t) in [
        ("bob's non-ATA wSOL account", bob_wsol, base),
        ("alice's wSOL ATA", wsol_ata(&a), base),
        ("bob's non-ATA base-token account", quote, bob_base),
        ("alice's base-token ATA", quote, base_ata(&a, &k.mint)),
    ] {
        env.send(&[claim_into(&payer, &k, &b, Some(q), Some(t), true)], &[])
            .fails_with(
                code(E::InvalidRecipientAccounts),
                "InvalidRecipientAccounts",
                what,
            );
    }
    // Every slot is required when its leg pays. Each case omits exactly one
    // slot and passes everything else, hook accounts included, so each
    // refusal comes from that slot's own check (the base escrow is checked
    // before the owner's base-token ATA). The base leg runs first: its
    // transfer (and so the hook) runs only when the wSOL slot is the one
    // missing.
    let escrow = Some(base_ata(&k.batch_authority, &k.mint));
    for (what, q, t, e, base_paid) in [
        ("no wSOL ATA", None, Some(base), escrow, true),
        ("no base-token ATA", Some(quote), None, escrow, false),
        ("no base escrow", Some(quote), Some(base), None, false),
    ] {
        let f = env
            .send(&[claim_slots(&payer, &k, &b, (&b, &b), q, t, e, true)], &[])
            .fails_with(code(E::AccountMismatch), "AccountMismatch", what);
        assert_eq!(invoked(&f.logs, &noised_hook::ID), base_paid, "{what}");
    }
    env.send(&[claim(&payer, &k, &b, true, true)], &[])
        .expect_ok("bob claims");
    assert_eq!(
        (env.token_amount(&base), env.token_amount(&quote)),
        (tokens, refund)
    );
    assert_escrow_invariants(env, &k);
}

/// L3, expired batch: every claim is a full refund. It reaches a reassigned
/// wSOL ATA, a closed one is recreated for its owner, and nothing stays in
/// the escrow.
#[test]
fn l3_expired_refund_pays_a_reassigned_or_closed_wsol_ata() {
    let mut w = launched();
    let k = w.k;
    let env = &mut w.env;
    let payer = env.payer.pubkey();
    let alice = committer(env, 1_000_000_001);
    let bob = committer(env, 700_000_000);
    let (a, b) = (alice.pubkey(), bob.pubkey());
    env.send(&[commit(&a, &k, 1_000_000_001)], &[&alice])
        .expect_ok("alice commits");
    env.send(&[commit(&b, &k, 700_000_000)], &[&bob])
        .expect_ok("bob commits");

    // Alice moves her wSOL ATA to another wallet; bob closes his.
    let alice_new = Pubkey::new_unique();
    env.send(
        &[set_account_owner(&wsol_ata(&a), &a, &alice_new)],
        &[&alice],
    )
    .expect_ok("alice reassigns her wSOL ATA");
    let close =
        spl_token_2022::instruction::close_account(&TOKEN_PROGRAM_ID, &wsol_ata(&b), &b, &b, &[])
            .unwrap();
    env.send(&[close], &[&bob])
        .expect_ok("bob closes his wSOL ATA");
    assert!(env.account(&wsol_ata(&b)).is_none());

    // Nobody executed in the window: the batch expired.
    let l: Launch = env.anchor(&k.launch);
    env.set_time(l.execute_end_ts);
    env.send(&[execute_batch(&payer, &k)], &[]).fails_with(
        code(E::NotExecuteWindow),
        "NotExecuteWindow",
        "execute after the window",
    );
    for (who, amount) in [(a, 1_000_000_001), (b, 700_000_000)] {
        let before = env.token_amount(&wsol_ata(&who));
        env.send(&[claim(&payer, &k, &who, false, false)], &[])
            .expect_ok("refund");
        assert_eq!(env.token_amount(&wsol_ata(&who)) - before, amount);
        env.send(&[claim(&payer, &k, &who, false, false)], &[])
            .fails_with(code(E::AlreadyClaimed), "AlreadyClaimed", "double refund");
        assert_escrow_invariants(env, &k);
    }
    assert_eq!(env.token_owner(&wsol_ata(&a)), alice_new);
    assert_eq!(env.token_owner(&wsol_ata(&b)), b);
    let l: Launch = env.anchor(&k.launch);
    assert_eq!(l.quote_refunded, l.total_committed);
    assert_eq!(env.token_amount(&wsol_ata(&k.batch_authority)), 0);
}

/// L3, liveness (the vault review's probes, ported to the batch). Anyone can
/// send lamports to an address before its ATA exists, which leaves a system
/// account there. That blocks neither `execute_batch` (its base escrow is
/// created with `init_if_needed`) nor `claim` (`AtaCreator::ensure` creates
/// a missing ATA through the ATA program, which takes over a pre-funded
/// address). Only a committer can make its own claim fail, the caveat
/// SECURITY_GUARANTEES L3 discloses: one that requires memos on its
/// Token-2022 base ATA cannot receive the tokens (`claim` makes no memo
/// CPI), so its refund, paid in the same claim, waits too until it lifts
/// the requirement. Nobody else's claim is affected.
#[test]
fn l3_prefunded_ata_addresses_block_nothing_and_memos_block_only_their_owner() {
    let mut w = launched_with(|p| p.batch_total_cap = LAMPORTS_PER_SOL);
    let k = w.k;
    let env = &mut w.env;
    let payer = env.payer.pubkey();
    let alice = committer(env, LAMPORTS_PER_SOL);
    let bob = committer(env, 700_000_001);
    let (a, b) = (alice.pubkey(), bob.pubkey());
    env.send(&[commit(&a, &k, LAMPORTS_PER_SOL)], &[&alice])
        .expect_ok("alice commits");
    env.send(&[commit(&b, &k, 700_000_001)], &[&bob])
        .expect_ok("bob commits");

    // Alice closes her empty wSOL ATA. Mallory then pre-funds every ATA
    // address the batch and alice's claim will create.
    let close =
        spl_token_2022::instruction::close_account(&TOKEN_PROGRAM_ID, &wsol_ata(&a), &a, &a, &[])
            .unwrap();
    env.send(&[close], &[&alice])
        .expect_ok("alice closes her wSOL ATA");
    let mallory = env.funded(1);
    for address in [
        base_ata(&k.batch_authority, &k.mint),
        base_ata(&a, &k.mint),
        wsol_ata(&a),
    ] {
        let fund = system_instruction::transfer(&mallory.pubkey(), &address, 1_000_000);
        env.send(&[fund], &[&mallory])
            .expect_ok("pre-fund an ATA address");
        assert_eq!(env.account(&address).unwrap().owner, system_program::ID);
    }

    // Bob makes his base-token ATA require memos on incoming transfers.
    let bob_base = base_ata(&b, &k.mint);
    env.send(
        &[create_ata(&b, &b, &k.mint, &TOKEN_2022_PROGRAM_ID)],
        &[&bob],
    )
    .expect_ok("bob's base ATA");
    let require_memos = [
        spl_token_2022::instruction::reallocate(
            &TOKEN_2022_PROGRAM_ID,
            &bob_base,
            &b,
            &b,
            &[],
            &[ExtensionType::MemoTransfer],
        )
        .unwrap(),
        memo_transfer::instruction::enable_required_transfer_memos(
            &TOKEN_2022_PROGRAM_ID,
            &bob_base,
            &b,
            &[],
        )
        .unwrap(),
    ];
    env.send(&require_memos, &[&bob])
        .expect_ok("bob requires memos");

    let l: Launch = env.anchor(&k.launch);
    env.set_time(l.commit_end_ts);
    env.send(&[execute_batch(&payer, &k)], &[])
        .expect_ok("execute_batch into a pre-funded escrow address");
    let l: Launch = env.anchor(&k.launch);
    assert!(l.executed && l.tokens_out > 0);
    assert_escrow_invariants(env, &k);

    // Alice's claim creates both of her ATAs at the pre-funded addresses.
    let (tokens, refund) = expected_share(&l, LAMPORTS_PER_SOL);
    assert!(tokens > 0 && refund > 0, "oversubscribed: both legs pay");
    env.send(&[claim(&payer, &k, &a, true, true)], &[])
        .expect_ok("alice claims");
    let (alice_base, alice_wsol) = (base_ata(&a, &k.mint), wsol_ata(&a));
    assert_eq!(
        (env.token_amount(&alice_base), env.token_amount(&alice_wsol)),
        (tokens, refund)
    );
    assert_eq!(
        (env.token_owner(&alice_base), env.token_owner(&alice_wsol)),
        (a, a)
    );
    assert_escrow_invariants(env, &k);

    // Bob's own memo requirement fails his claim, refund included ...
    let f = env
        .send(&[claim(&payer, &k, &b, true, true)], &[])
        .err()
        .expect("claim into a memo-required account succeeded");
    let no_memo = TokenError::NoMemo as u32;
    let refused =
        format!("Program {TOKEN_2022_PROGRAM_ID} failed: custom program error: {no_memo:#x}");
    assert!(
        f.custom_code() == Some(no_memo) && f.logs.contains(&refused),
        "{:?}\n{}",
        f.err,
        f.logs.join("\n")
    );
    assert!(!env.anchor::<Commit>(&k.commit(&b)).claimed);
    // ... until he lifts it.
    let lift = memo_transfer::instruction::disable_required_transfer_memos(
        &TOKEN_2022_PROGRAM_ID,
        &bob_base,
        &b,
        &[],
    )
    .unwrap();
    env.send(&[lift], &[&bob])
        .expect_ok("bob lifts the memo requirement");
    let wsol_before = env.token_amount(&wsol_ata(&b));
    env.send(&[claim(&payer, &k, &b, true, true)], &[])
        .expect_ok("bob claims");
    let (tokens, refund) = expected_share(&l, 700_000_001);
    assert_eq!(
        (
            env.token_amount(&bob_base),
            env.token_amount(&wsol_ata(&b)) - wsol_before
        ),
        (tokens, refund)
    );
    assert_escrow_invariants(env, &k);
}

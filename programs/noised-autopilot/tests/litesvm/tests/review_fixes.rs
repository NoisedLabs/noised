//! Regressions for the adversarial review of the autopilot: each test
//! replays a finding's proof of concept against the real programs (mainnet
//! DBC, DAMM v2 and Token-2022) and asserts the fixed behaviour. Every one
//! of them fails on the program as reviewed.
//!
//! * F1 (high): buybacks priced from a reference that lagged a market fall,
//!   or that one transaction per hour walked up.
//! * F2 (medium): a launch migrated through another DBC-accepted DAMM v2
//!   config could never be found by the autopilot.
//! * F3 (low): a newer authorization of any kind voided an older pending
//!   one (a revocation of a compromised operator).
//! * F4 (medium): a buyback too large for the pool within its premium could
//!   never run.
//! * F5 (low): dust burns farmed the daily tip cap.
//! * Info: a DAMM v2 pool layout change blocked every treasury outflow; a
//!   revocation did not reach a queued graph naming the same operator; a
//!   queued first graph could be replaced with one effective at once.

#[path = "../../../../noised-launchpad/tests/litesvm/tests/common/mod.rs"]
mod common;

mod ap;

use anchor_lang::{prelude::Pubkey, system_program, InstructionData, ToAccountMetas};
use ap::*;
use common::{
    events,
    launch::{base_ata, create_ata, wrap_sol, wsol_ata},
    lifecycle::damm_swap,
    Expect, Failed, Sent, LAMPORTS_PER_SOL, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
};
use noised_autopilot::{
    constants::*,
    error::AutopilotError as E,
    events::{NodeRan, OperatorRevoked, PoolBound},
    price,
};
use noised_rules::{
    graph::{action::*, trigger::*, FLAG_HAS_OPERATOR},
    GNode, GraphProgram,
};
use solana_keypair::Keypair;
use solana_signer::Signer;

const SOL: u64 = LAMPORTS_PER_SOL;
const HOUR: i64 = 3_600;

#[track_caller]
fn refused(r: Result<Sent, Failed>, e: E, what: &str) -> Failed {
    r.fails_with(ap_code(e), &format!("{e:?}"), what)
}

fn gnode(trig: u8, trigger_arg: u64, act: u8, p1: u64, p2: u64) -> GNode {
    GNode {
        trigger: trig,
        trigger_arg,
        cond_off: 0,
        cond_len: 0,
        action: act,
        operator_gated: 0,
        epoch_secs: 86_400,
        budget_per_epoch: p1 * 10,
        p1,
        p2,
        max_runs_per_epoch: 10,
        reserved: [0; 5],
    }
}

fn graph(nodes: Vec<GNode>) -> GraphProgram {
    GraphProgram {
        flags: 0,
        operator: [0; 32],
        recipients: vec![],
        nodes,
        cond: vec![],
    }
}

fn with_operator(mut p: GraphProgram, operator: &Pubkey) -> GraphProgram {
    p.flags = FLAG_HAS_OPERATOR;
    p.operator = operator.to_bytes();
    p
}

fn ran(sent: &Sent) -> NodeRan {
    events::<NodeRan>(&sent.logs).pop().expect("NodeRan")
}

/// Price (not sqrt) of a Q64.64 sqrt price, as a float.
fn px(sqrt: u128) -> f64 {
    let s = sqrt as f64 / 18_446_744_073_709_551_616.0;
    s * s
}

/// A trader holding `sol` SOL of wSOL and an empty token account.
fn trader(t: &mut ApWorld, sol: u64) -> Keypair {
    let m = t.w.env.funded(sol + 2);
    t.w.env
        .send(&wrap_sol(&m.pubkey(), sol * SOL), &[&m])
        .expect_ok("wrap");
    let ata = create_ata(&m.pubkey(), &m.pubkey(), &t.k.mint, &TOKEN_2022_PROGRAM_ID);
    t.w.env.send(&[ata], &[&m]).expect_ok("token account");
    m
}

fn wsol_of(t: &ApWorld, who: &Keypair) -> u64 {
    t.w.env.token_amount(&wsol_ata(&who.pubkey()))
}

fn tok_of(t: &ApWorld, who: &Keypair) -> u64 {
    t.w.env.token_amount(&base_ata(&who.pubkey(), &t.k.mint))
}

fn buy(t: &mut ApWorld, m: &Keypair, lamports: u64) -> bool {
    let ix = damm_swap(&m.pubkey(), &t.k, &t.d, false, lamports);
    t.send(&[ix], &[m]).is_ok()
}

fn sell(t: &mut ApWorld, m: &Keypair, tokens: u64) {
    let ix = damm_swap(&m.pubkey(), &t.k, &t.d, true, tokens);
    t.send(&[ix], &[m]).expect_ok("sell");
}

/// The keeper-attacker's best sandwich of node 0's buyback of `amount`:
/// the largest pump (bought first) that still lets the buyback through,
/// the buyback, then the pumped tokens sold back. Returns (attacker gain in
/// lamports, the run, the pump), or `None` if no buyback can run at all.
fn sandwich(
    t: &mut ApWorld,
    m: &Keypair,
    h: &[u8; 32],
    amount: Option<u64>,
) -> Option<(i128, NodeRan, u64)> {
    let extra = t.buyback();
    let (mut lo, mut hi) = (0u64, wsol_of(t, m));
    {
        let snap = t.w.env.svm.clone();
        let ok = t.run_amount(h, 0, amount, &extra).is_ok();
        t.w.env.svm = snap;
        if !ok {
            return None;
        }
    }
    while hi - lo > SOL / 1_000 {
        let mid = (lo + hi) / 2;
        let snap = t.w.env.svm.clone();
        let ok = buy(t, m, mid) && t.run_amount(h, 0, amount, &extra).is_ok();
        t.w.env.svm = snap;
        if ok {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let (s0, k0) = (wsol_of(t, m), tok_of(t, m));
    if lo > 0 {
        assert!(buy(t, m, lo), "pump");
    }
    let pumped = tok_of(t, m) - k0;
    let ev = ran(&t
        .run_amount(h, 0, amount, &extra)
        .expect_ok("sandwiched buyback"));
    if pumped > 0 {
        sell(t, m, pumped);
    }
    Some((wsol_of(t, m) as i128 - s0 as i128, ev, lo))
}

/// What the treasury would get for the same run with nobody around.
fn clean_run(t: &mut ApWorld, h: &[u8; 32], amount: Option<u64>) -> NodeRan {
    let extra = t.buyback();
    let snap = t.w.env.svm.clone();
    let ev = ran(&t
        .run_amount(h, 0, amount, &extra)
        .expect_ok("clean buyback"));
    t.w.env.svm = snap;
    ev
}

/// F1a. After an ordinary market fall (no manipulation), one observation by
/// anyone bounds every buyback from a minute later at the fallen price: the
/// keeper-attacker's best sandwich gains at most the premium on the amount.
/// As reviewed, a reference that may only follow 5% an hour let it pump the
/// pool to `reference * (1 + premium)`, double the market: 8.2x the bound.
#[test]
fn f1a_a_fall_anyone_observed_bounds_every_buyback() {
    let mut t = ap_world(true);
    let p1 = SOL;
    let premium = 500;
    let p = graph(vec![gnode(EVERY, 600, BUYBACK_BURN, p1, premium)]);
    t.fund_sol(5 * SOL);
    let h = t.activate_now(&p);
    let spot0 = t.pool_sqrt_price();
    // The market dumps (an ordinary seller, not the attacker).
    let reserve_a = t.w.env.token_amount(&t.d.token_a_vault);
    let carol = t.carol.pubkey();
    let carol_tokens = t.w.env.token_amount(&base_ata(&carol, &t.k.mint));
    t.carol_sells((reserve_a * 45 / 100).min(carol_tokens));
    let low = t.pool_sqrt_price();
    // An hour later an honest party observes the pool, once.
    let now = t.now();
    t.env().set_time(now + HOUR);
    t.observe().expect_ok("honest update_price");
    let reference = t.state().ref_sqrt_price;
    assert_eq!(reference, spot0, "one observation moves no reference");
    println!(
        "F1a market: price {:.3} of migration, reference {:.3} of migration",
        px(low) / px(spot0),
        px(reference) / px(spot0)
    );
    // Within the minute nothing prices a buyback: the honest observation is
    // too young, and nobody else observed.
    let extra = t.buyback();
    refused(
        t.run(&h, 0, &extra),
        E::PriceNotObserved,
        "the attacker right after the observation",
    );
    let now = t.now();
    t.env().set_time(now + OBS_MIN_SPAN_SECS);
    // The whole node (1 SOL) is too much for this pool within 5% of the
    // fallen price: the keeper runs a tenth.
    let amount = Some(SOL / 10);
    let clean = clean_run(&mut t, &h, amount);
    let m = trader(&mut t, 30);
    let (gain, ev, pump) = sandwich(&mut t, &m, &h, amount).expect("a buyback runs");
    let bound = i128::from(SOL / 10 * premium / 10_000);
    println!(
        "F1a sandwich: pump {pump} lamports; treasury paid {} lamports for {} tokens (unsandwiched {}); attacker gain {gain} lamports (premium x amount = {bound})",
        ev.spent, ev.bought, clean.bought
    );
    assert_eq!(ev.spent, SOL / 10);
    assert!(gain <= bound, "gain {gain} > premium x amount {bound}");
    // The treasury got at least the minimum out at the fallen price.
    let floor = price::min_out(ev.spent, low, premium).unwrap();
    assert!(ev.bought >= floor, "{} < {floor}", ev.bought);
    assert!(
        u128::from(clean.bought - ev.bought) * 10_000
            <= u128::from(clean.bought) * u128::from(premium),
        "the treasury lost at most the premium"
    );
}

/// F1a, the window: a price observed before a fall prices buybacks for at
/// most the 15 to 30 minutes of its window; after that a buyback needs a
/// new observation (which sees the fall).
#[test]
fn f1a_a_stale_observation_expires_with_its_window() {
    let mut t = ap_world(true);
    let p = graph(vec![gnode(EVERY, 600, BUYBACK_BURN, SOL / 10, 500)]);
    t.fund_sol(5 * SOL);
    let h = t.activate_now(&p);
    // Observed just before a fall nobody observes.
    let now = t.now();
    t.env()
        .set_time(now - now % OBS_BUCKET_SECS + OBS_BUCKET_SECS + 10);
    t.observe_and_wait();
    let extra = t.buyback();
    let snap = t.w.env.svm.clone();
    t.run(&h, 0, &extra).expect_ok("within the window");
    t.w.env.svm = snap;
    let start = t.now() - OBS_MIN_SPAN_SECS;
    // At the start of the bucket after next the window is gone.
    t.env()
        .set_time(start - start % OBS_BUCKET_SECS + 2 * OBS_BUCKET_SECS);
    refused(
        t.run(&h, 0, &extra),
        E::PriceNotObserved,
        "a 15 to 30 minute old window",
    );
}

/// F1b. One atomic transaction per hour [pump, update_price, sell back]
/// walked the reference up 5% compounding for the pool's fees (1.63x in 10
/// hours as reviewed); the walk then let sandwiches gross 0.74 SOL against
/// a documented bound of 0.2. Now each such observation is alone in its
/// window, and the reference does not move at all.
#[test]
fn f1b_an_atomic_walk_moves_nothing() {
    let mut t = ap_world(true);
    let p = graph(vec![gnode(EVERY, 600, BUYBACK_BURN, SOL / 10, 500)]);
    t.fund_sol(10 * SOL);
    let h = t.activate_now(&p);
    let m = trader(&mut t, 30);
    let (a, pool) = (t.a, t.d.pool);
    let start = t.state().ref_sqrt_price;
    let w0 = wsol_of(&t, &m);
    for i in 0..10 {
        let now = t.now();
        t.env().set_time(now + HOUR);
        let target = start * 10_246 / 10_000;
        // Smallest buy lifting the pool to +5%.
        let (mut lo, mut hi) = (0u64, 25 * SOL);
        while hi - lo > SOL / 10_000 {
            let mid = (lo + hi) / 2;
            let snap = t.w.env.svm.clone();
            assert!(buy(&mut t, &m, mid), "probe");
            let s = t.pool_sqrt_price();
            t.w.env.svm = snap;
            if s >= target {
                hi = mid;
            } else {
                lo = mid;
            }
        }
        let snap = t.w.env.svm.clone();
        let k0 = tok_of(&t, &m);
        assert!(buy(&mut t, &m, hi), "probe");
        let got = tok_of(&t, &m) - k0;
        t.w.env.svm = snap;
        let ixs = [
            damm_swap(&m.pubkey(), &t.k, &t.d, false, hi),
            update_price(&a, &pool),
            damm_swap(&m.pubkey(), &t.k, &t.d, true, got),
        ];
        let sent = t.send(&ixs, &[&m]).expect_ok("atomic walk step");
        assert_eq!(
            t.state().ref_sqrt_price,
            start,
            "hour {}: the reference moved",
            i + 1
        );
        if i == 0 {
            println!("F1b atomic step: {} bytes", sent.size);
        }
    }
    let cost = w0 as i128 - wsol_of(&t, &m) as i128;
    println!("F1b: 10 hourly atomic steps cost {cost} lamports; the reference did not move");
    // The walk left nothing to exploit: an honest keeper observes, and the
    // attacker's best sandwich gains at most the premium.
    t.observe_and_wait();
    let (gain, _, pump) = sandwich(&mut t, &m, &h, None).expect("a buyback runs");
    let bound = i128::from(SOL / 10 * 500 / 10_000);
    println!("F1b sandwich after the walk: pump {pump}, gain {gain} (bound {bound})");
    assert!(gain <= bound, "gain {gain} > {bound}");
}

/// F1b, two transactions a minute apart: an honest observation between them
/// stops the walk; with nobody else observing, the walk is at most 5% of
/// price per hour (the documented residual, each step paying the pool's
/// fees both ways twice).
#[test]
fn f1b_a_two_step_walk_is_stopped_by_one_honest_observation() {
    let mut t = ap_world(true);
    let m = trader(&mut t, 30);
    let (a, pool) = (t.a, t.d.pool);
    let start = t.state().ref_sqrt_price;
    // An atomic pumped observation (+10% of price).
    let pumped_observation = |t: &mut ApWorld, m: &Keypair| {
        let target = t.pool_sqrt_price() * 10_488 / 10_000;
        let (mut lo, mut hi) = (0u64, 25 * SOL);
        while hi - lo > SOL / 1_000 {
            let mid = (lo + hi) / 2;
            let snap = t.w.env.svm.clone();
            assert!(buy(t, m, mid), "probe");
            let s = t.pool_sqrt_price();
            t.w.env.svm = snap;
            if s >= target {
                hi = mid;
            } else {
                lo = mid;
            }
        }
        let snap = t.w.env.svm.clone();
        let k0 = tok_of(t, m);
        assert!(buy(t, m, hi), "probe");
        let got = tok_of(t, m) - k0;
        t.w.env.svm = snap;
        let ixs = [
            damm_swap(&m.pubkey(), &t.k, &t.d, false, hi),
            update_price(&a, &pool),
            damm_swap(&m.pubkey(), &t.k, &t.d, true, got),
        ];
        t.send(&ixs, &[m]).expect_ok("pumped observation");
    };
    // With an honest observation in between, the reference goes no higher
    // than what the honest observer saw (the pool after the attacker's
    // round trips, a hair above the start: the fees it paid stay in it).
    pumped_observation(&mut t, &m);
    let now = t.now();
    t.env().set_time(now + 30);
    let honest = t.pool_sqrt_price();
    t.observe().expect_ok("honest observation");
    t.env().set_time(now + OBS_MIN_SPAN_SECS);
    pumped_observation(&mut t, &m);
    let held = t.state().ref_sqrt_price;
    assert!(held <= honest, "the honest one holds it: {held} > {honest}");
    assert!(
        (held - start) * 10_000 < start,
        "within a basis point of the start"
    );
    // Alone, a minute apart, for three hours: at most e^0.0243 an hour (in
    // sqrt price) plus the hour banked.
    for _ in 0..3 {
        let now = t.now();
        t.env().set_time(now + HOUR);
        pumped_observation(&mut t, &m);
        let now = t.now();
        t.env().set_time(now + OBS_MIN_SPAN_SECS);
        pumped_observation(&mut t, &m);
    }
    let walked = t.state().ref_sqrt_price;
    let max = held as f64 * (0.0243f64 * 4.0).exp();
    println!(
        "F1b two-step walk, attacker alone for 3 hours: reference {:.4}x (price), at most {:.4}x",
        px(walked) / px(start),
        (max / start as f64).powi(2)
    );
    assert!(walked > held && (walked as f64) <= max);
}

/// DAMM v2 `initialize_pool` of (mint, wSOL) under `config` by `creator`
/// (who pays both tokens).
fn initialize_pool(
    t: &ApWorld,
    creator: &Keypair,
    nft: &Keypair,
    config: &Pubkey,
    sqrt_price: u128,
    liquidity: u128,
) -> (
    anchor_lang::solana_program::instruction::Instruction,
    Pubkey,
) {
    use noised_launchpad::cp_amm::{
        client::{accounts as amm_acc, args as amm_args},
        types::InitializePoolParameters,
    };
    let k = t.k;
    let d = common::lifecycle::Damm::new(&k, *config);
    let ix = anchor_lang::solana_program::instruction::Instruction {
        program_id: DAMM_V2_PROGRAM_ID,
        accounts: amm_acc::InitializePool {
            creator: creator.pubkey(),
            position_nft_mint: nft.pubkey(),
            position_nft_account: common::lifecycle::Damm::nft_account(&nft.pubkey()),
            payer: creator.pubkey(),
            config: *config,
            pool_authority: DAMM_V2_POOL_AUTHORITY,
            pool: d.pool,
            position: common::lifecycle::Damm::position(&nft.pubkey()),
            token_a_mint: k.mint,
            token_b_mint: WSOL_MINT,
            token_a_vault: d.token_a_vault,
            token_b_vault: d.token_b_vault,
            payer_token_a: base_ata(&creator.pubkey(), &k.mint),
            payer_token_b: wsol_ata(&creator.pubkey()),
            token_a_program: TOKEN_2022_PROGRAM_ID,
            token_b_program: TOKEN_PROGRAM_ID,
            token_2022_program: TOKEN_2022_PROGRAM_ID,
            system_program: system_program::ID,
            event_authority: DAMM_V2_EVENT_AUTHORITY,
            program: DAMM_V2_PROGRAM_ID,
        }
        .to_account_metas(None),
        data: amm_args::InitializePool {
            params: InitializePoolParameters {
                liquidity,
                sqrt_price,
                activation_point: None,
            },
        }
        .data(),
    };
    (ix, d.pool)
}

/// A copy of mainnet's fee-option-2 DAMM v2 config at its real address for
/// `index`, with `pool_creator_authority` (what Meteora's admin creates
/// with `create_config`).
fn put_config(t: &mut ApWorld, index: u64, pool_creator_authority: &Pubkey) -> Pubkey {
    let canonical = t.w.env.load_account_json(&common::fixture(&format!(
        "accounts/{}.json",
        common::lifecycle::DAMM_CONFIG_FEE_OPTION_2
    )));
    let mut acct = t.w.env.account(&canonical).unwrap();
    let pda = |i: u64| {
        Pubkey::find_program_address(&[b"config", &i.to_le_bytes()], &DAMM_V2_PROGRAM_ID).0
    };
    let original = u64::from_le_bytes(acct.data[208..216].try_into().unwrap());
    assert_eq!(pda(original), canonical, "static config = [config, index]");
    acct.data[208..216].copy_from_slice(&index.to_le_bytes());
    acct.data[40..72].copy_from_slice(pool_creator_authority.as_ref());
    let key = pda(index);
    t.w.env.svm.set_account(key, acct).unwrap();
    key
}

/// F2. DBC migrated the launch through another config it accepts (same
/// fields, another index). As reviewed, the autopilot was bound at
/// `bind_mint` to the pool of one fixed config and stayed un-graduated
/// forever. Now `bind_pool` takes the pool DBC created through any config
/// whose pool creator is DBC's pool authority, and no other pool: not one
/// anyone can make for the same pair under a permissionless config.
#[test]
fn f2_any_dbc_migration_config_binds_and_no_other_pool_does() {
    use common::{
        launch::{claim_fees, dbc_swap_mode},
        lifecycle::{claim_surplus, migrate, Damm},
    };
    let mut t = ap_world(false);
    let l: noised_launchpad::state::Launch = t.w.env.anchor(&t.k.launch);
    let other = put_config(&mut t, 20_099, &DBC_POOL_AUTHORITY);
    // Complete the curve exactly as ap_world does.
    t.env().set_time(l.execute_end_ts);
    let carol = t.carol.insecure_clone();
    let swap = dbc_swap_mode(&carol.pubkey(), &t.k, true, 20 * SOL, 1, true);
    t.send(&[swap], &[&carol]).expect_ok("buy to completion");
    let payer = t.payer();
    let k = t.k;
    t.send(&[claim_surplus(&payer, &k)], &[])
        .expect_ok("claim_surplus");
    t.send(&[claim_fees(&payer, &k)], &[])
        .expect_ok("claim_fees");
    // Anyone migrates, through the other (equally valid) config.
    t.w.env.airdrop(&DBC_POOL_AUTHORITY, 2 * SOL);
    let d = Damm::new(&k, other);
    let (n1, n2) = (Keypair::new(), Keypair::new());
    t.w.env
        .send_large(
            &[migrate(&payer, &k, &d, &n1.pubkey(), &n2.pubkey())],
            &[&n1, &n2],
        )
        .expect_ok("DBC migrates through the other config");
    assert!(t.w.env.account(&d.pool).is_some(), "the real pool exists");
    let a = t.a;
    let canonical = t.d;
    assert_ne!(canonical.pool, d.pool);

    // Not yet graduated for the autopilot.
    refused(
        t.send(&[update_price(&a, &d.pool)], &[]),
        E::NotGraduated,
        "update_price before bind_pool",
    );
    // The fixed config of the reviewed program: its pool does not exist.
    refused(
        t.send(&[bind_pool(&a, &canonical.config, &canonical.pool)], &[]),
        E::NotGraduated,
        "the fee option's usual config, never used",
    );
    refused(
        t.send(&[bind_pool(&a, &other, &canonical.pool)], &[]),
        E::InvalidPool,
        "a pool of another config",
    );
    refused(
        t.send(&[bind_pool(&a, &k.dbc_config, &d.pool)], &[]),
        E::InvalidDammConfig,
        "the DBC config as a DAMM config",
    );

    // An attacker makes its own (mint, wSOL) pool under a config anyone may
    // create pools with, and tries to bind it first: refused.
    let open = put_config(&mut t, 20_100, &Pubkey::default());
    let m = trader(&mut t, 5);
    let ix = damm_swap(&m.pubkey(), &k, &d, false, SOL);
    t.send(&[ix], &[&m]).expect_ok("the attacker buys tokens");
    let spot = {
        let pool: noised_launchpad::cp_amm::accounts::Pool = {
            let acct = t.w.env.account(&d.pool).unwrap();
            anchor_lang::__private::bytemuck::pod_read_unaligned(&acct.data[8..])
        };
        pool.sqrt_price
    };
    let nft = Keypair::new();
    let (ix, fake) = initialize_pool(&t, &m, &nft, &open, spot, 1u128 << 70);
    t.send(&[ix], &[&m, &nft])
        .expect_ok("anyone creates a pool under a permissionless config");
    refused(
        t.send(&[bind_pool(&a, &open, &fake)], &[]),
        E::InvalidDammConfig,
        "the attacker's pool",
    );
    // Under a config whose pool creator is DBC's pool authority, nobody but
    // DBC can create a pool (what bind_pool relies on).
    let dbc_only = put_config(&mut t, 20_101, &DBC_POOL_AUTHORITY);
    let nft = Keypair::new();
    let (ix, _) = initialize_pool(&t, &m, &nft, &dbc_only, spot, 1u128 << 70);
    match t.send(&[ix], &[&m, &nft]) {
        Ok(_) => panic!("DAMM v2 let someone else create a pool under DBC's config"),
        Err(f) => assert!(
            f.logs
                .iter()
                .any(|l| l.contains("InvalidAuthorityToCreateThePool")),
            "refused for another reason:
{}",
            f.logs.join(
                "
"
            )
        ),
    }
    // The attacker sells what it bought back to the real pool.
    let left = tok_of(&t, &m);
    let ix = damm_swap(&m.pubkey(), &k, &d, true, left);
    t.send(&[ix], &[&m]).expect_ok("the attacker sells");

    // The real pool binds; from then on the launch has graduated.
    let sent = t
        .send(&[bind_pool(&a, &other, &d.pool)], &[])
        .expect_ok("bind_pool");
    println!("bind_pool: {} CU, {} bytes", sent.cu, sent.size);
    let ev = events::<PoolBound>(&sent.logs).pop().unwrap();
    assert_eq!((ev.damm_pool, ev.damm_config), (d.pool, other));
    assert_eq!(t.state().damm_pool, d.pool);
    refused(
        t.send(&[bind_pool(&a, &other, &d.pool)], &[]),
        E::PoolAlreadyBound,
        "twice",
    );
    refused(
        t.send(&[update_price(&a, &fake)], &[]),
        E::InvalidPool,
        "observe the attacker's pool",
    );
    t.d = d;
    t.fund_sol(SOL);
    let h = t.activate_now(&graph(vec![gnode(EVERY, 600, BUYBACK_BURN, SOL / 10, 500)]));
    t.observe_and_wait();
    let extra = t.buyback();
    let ev = ran(&t.run(&h, 0, &extra).expect_ok("a buyback on the real pool"));
    assert!(ev.bought > 0);
    println!(
        "F2: DBC migrated through config index 20099 ({other}); the autopilot bound its pool {} and bought back {} tokens",
        d.pool, ev.bought
    );
}

/// F3. The creator, responding to a compromised operator, signs a
/// revocation and then an activation of a graph without it. As reviewed,
/// whoever applied the newer activation first voided the revocation (one
/// slot floor for every kind) and the operator kept running its node.
#[test]
fn f3_a_newer_activation_does_not_void_a_revocation() {
    let mut t = ap_world(true);
    let op = Keypair::new();
    let payer = t.payer();
    t.send(
        &[create_ata(
            &payer,
            &op.pubkey(),
            &WSOL_MINT,
            &TOKEN_PROGRAM_ID,
        )],
        &[],
    )
    .expect_ok("operator wSOL account");
    let mut n = gnode(EVERY, 600, BURN, 1_000, 0);
    n.operator_gated = 1;
    let h1 = t.activate_now(&with_operator(graph(vec![n]), &op.pubkey()));
    t.fund_tokens(1_000);
    t.fund_sol(SOL);
    let p2 = graph(vec![gnode(EVERY, 600, BURN, 1_000, 0)]);
    let (bytes2, h2) = compile(&p2);
    let a = t.a;
    t.send(&[publish_graph(&payer, &a, &bytes2)], &[])
        .expect_ok("publish");
    let slot = t.w.env.svm.get_sysvar::<solana_clock::Clock>().slot;
    let rev = revoke_auth(t.env(), &a, &h1, &op.pubkey(), Some(slot + 1));
    let at = t.now() + UPDATE_TIMELOCK_SECS;
    let act = activation_auth(t.env(), &a, &h2, at, Some(slot + 2));
    // The attacker applies the newer one first.
    t.send(&[activate(&a, &h2, &act, at)], &[])
        .expect_ok("newer activation first");
    let sent = t
        .send(&[revoke_operator(&a, &rev)], &[])
        .expect_ok("the revocation still applies");
    let ev = events::<OperatorRevoked>(&sent.logs).pop().unwrap();
    assert_eq!(ev.operator, op.pubkey());
    assert!(!ev.pending_cleared, "the queued graph has no operator");
    let now = t.now();
    t.env().set_time(now + 600);
    refused(
        t.run_as(&op, &h1, 0, Some(1), &Extra::None),
        E::NoOperator,
        "the revoked operator",
    );
}

/// F3 and info: what each kind of authorization may and may not void.
#[test]
fn f3_authorizations_only_void_what_they_could_undo() {
    let mut t = ap_world(true);
    let x = Keypair::new();
    let y = Keypair::new();
    let payer = t.payer();
    for o in [&x, &y] {
        t.send(
            &[create_ata(
                &payer,
                &o.pubkey(),
                &WSOL_MINT,
                &TOKEN_PROGRAM_ID,
            )],
            &[],
        )
        .expect_ok("operator wSOL account");
    }
    let mut n = gnode(EVERY, 600, BURN, 10, 0);
    n.operator_gated = 1;
    let g1 = with_operator(graph(vec![n]), &x.pubkey());
    // The same operator again, and another one, in two replacements.
    let mut n2 = n;
    n2.p1 = 11;
    n2.budget_per_epoch = 110;
    let g2 = with_operator(graph(vec![n2]), &x.pubkey());
    let mut n3 = n;
    n3.p1 = 12;
    n3.budget_per_epoch = 120;
    let g3 = with_operator(graph(vec![n3]), &y.pubkey());
    let h1 = t.activate_now(&g1);
    t.fund_tokens(10_000);
    let a = t.a;
    let (b2, h2) = compile(&g2);
    let (b3, h3) = compile(&g3);
    for b in [&b2, &b3] {
        t.send(&[publish_graph(&payer, &a, b)], &[])
            .expect_ok("publish");
    }
    let s = t.w.env.svm.get_sysvar::<solana_clock::Clock>().slot + 100;

    // An activation signed before a revocation is void once the revocation
    // is used (it could give the revoked operator its power back).
    let at = t.now() + UPDATE_TIMELOCK_SECS;
    let old_act = activation_auth(t.env(), &a, &h2, at, Some(s + 1));
    let rev = revoke_auth(t.env(), &a, &h1, &x.pubkey(), Some(s + 2));
    t.send(&[revoke_operator(&a, &rev)], &[])
        .expect_ok("revoke x");
    refused(
        t.send(&[activate(&a, &h2, &old_act, at)], &[]),
        E::StaleAuthorization,
        "an activation signed before the revocation",
    );

    // A queued graph naming the operator a revocation takes away does not
    // get it: re-appoint x (a new activation), queue g2 (x again), revoke x.
    let at = t.now() + UPDATE_TIMELOCK_SECS;
    let act2 = activation_auth(t.env(), &a, &h2, at, Some(s + 3));
    let sent = t
        .send(&[activate(&a, &h2, &act2, at)], &[])
        .expect_ok("queue g2 (operator x)");
    let q = events::<noised_autopilot::events::GraphQueued>(&sent.logs)
        .pop()
        .unwrap();
    assert_eq!(q.operator, x.pubkey());
    assert_eq!(t.state().pending_operator, x.pubkey());
    t.env().set_time(at);
    t.send(&[apply_pending(&a, &h2)], &[]).expect_ok("apply g2");
    assert_eq!(t.state().operator, x.pubkey(), "x appointed again");
    // Revoking x on g1 (no longer active) does nothing to g2.
    let stale = revoke_auth(t.env(), &a, &h1, &x.pubkey(), Some(s + 4));
    refused(
        t.send(&[revoke_operator(&a, &stale)], &[]),
        E::InvalidAuthorization,
        "a revocation names its graph",
    );
    let at = t.now() + UPDATE_TIMELOCK_SECS;
    let act_same = activation_auth(t.env(), &a, &h2, at, Some(s + 5));
    // Queue g2 again (x again) as the replacement of g2.
    t.send(&[activate(&a, &h2, &act_same, at)], &[])
        .expect_ok("queue g2 again");
    let rev2 = revoke_auth(t.env(), &a, &h2, &x.pubkey(), Some(s + 6));
    let sent = t
        .send(&[revoke_operator(&a, &rev2)], &[])
        .expect_ok("revoke x on g2");
    let ev = events::<OperatorRevoked>(&sent.logs).pop().unwrap();
    assert!(ev.pending_cleared, "the queued graph loses x too");
    assert_eq!(t.state().pending_operator, Pubkey::default());
    t.env().set_time(at);
    t.send(&[apply_pending(&a, &h2)], &[]).expect_ok("apply");
    assert_eq!(t.state().operator, Pubkey::default());
    let now = t.now();
    t.env().set_time(now + 600);
    refused(
        t.run_as(&x, &h2, 0, Some(1), &Extra::None),
        E::NoOperator,
        "x after the queued graph was applied",
    );

    // A freeze signed before the latest activation cannot cancel the newer
    // queued graph; a newer freeze can.
    let na = t.now() + 3_600;
    let old_freeze = freeze_auth(t.env(), &a, &h2, na, Some(s + 7));
    let at = t.now() + UPDATE_TIMELOCK_SECS;
    let act3 = activation_auth(t.env(), &a, &h3, at, Some(s + 8));
    t.send(&[activate(&a, &h3, &act3, at)], &[])
        .expect_ok("queue g3 (operator y)");
    refused(
        t.send(&[freeze(&a, &old_freeze, na)], &[]),
        E::StaleAuthorization,
        "a freeze older than the queued graph",
    );
    assert_eq!(t.state().pending_graph, h3);
    // Revoking an operator is still possible on the active graph... none
    // here; y on the queued graph stays (a revocation names only its own).
    assert_eq!(t.state().pending_operator, y.pubkey());
    let new_freeze = freeze_auth(t.env(), &a, &h2, na, Some(s + 9));
    t.send(&[freeze(&a, &new_freeze, na)], &[])
        .expect_ok("a newer freeze");
    let st = t.state();
    assert!(st.frozen);
    assert_eq!(
        (st.pending_graph, st.pending_operator),
        ([0; 32], Pubkey::default())
    );
}

/// Info: a first graph counting down is visible to holders; replacing it
/// waits for the 72-hour timelock like replacing an active one.
#[test]
fn a_queued_first_graph_is_replaced_only_after_the_timelock() {
    let mut t = ap_world(true);
    let a = t.a;
    let payer = t.payer();
    let (b1, h1) = compile(&graph(vec![gnode(EVERY, 600, BURN, 1, 0)]));
    let (b2, h2) = compile(&graph(vec![gnode(EVERY, 600, BURN, 2, 0)]));
    for b in [&b1, &b2] {
        t.send(&[publish_graph(&payer, &a, b)], &[])
            .expect_ok("publish");
    }
    let now = t.now();
    let at1 = now + 3 * 86_400;
    let auth1 = activation_auth(t.env(), &a, &h1, at1, None);
    t.send(&[activate(&a, &h1, &auth1, at1)], &[])
        .expect_ok("queue a first graph, three days out");
    let slot = t.state().auth_marks[0].slot;
    let now_auth = activation_auth(t.env(), &a, &h2, now, Some(slot + 1));
    refused(
        t.send(&[activate(&a, &h2, &now_auth, now)], &[]),
        E::TimelockTooShort,
        "replace it with one effective now",
    );
    let at2 = now + UPDATE_TIMELOCK_SECS;
    let later = activation_auth(t.env(), &a, &h2, at2, Some(slot + 2));
    t.send(&[activate(&a, &h2, &later, at2)], &[])
        .expect_ok("replace it 72 hours out");
    assert_eq!(t.state().pending_graph, h2);
}

/// F4. A buyback node of 2 SOL a run on a pool of ~10 SOL: the whole amount
/// can never run within a 5% premium. As reviewed, keepers had to move the
/// whole amount, so it never ran (24 of 24 hourly runs failed). Now a
/// keeper chooses a smaller amount, down to 1% of the pool's SOL.
#[test]
fn f4_a_keeper_shrinks_a_buyback_the_pool_cannot_take() {
    let mut t = ap_world(true);
    let premium = 500;
    let extra = t.buyback();
    t.fund_sol(5 * SOL);
    let mut burn = gnode(EVERY, 600, BURN, 10, 0);
    burn.budget_per_epoch = 100;
    let h = t.activate_now(&graph(vec![
        gnode(EVERY, 600, BUYBACK_BURN, 2 * SOL, premium),
        burn,
    ]));
    t.fund_tokens(100);
    let quote = t.w.env.token_amount(&t.d.token_b_vault);
    let mut fails = 0;
    for _ in 0..6 {
        let now = t.now();
        t.env().set_time(now + HOUR);
        t.observe_and_wait();
        if t.run(&h, 0, &extra).is_err() {
            fails += 1;
        }
    }
    assert_eq!(fails, 6, "2 SOL is more than this pool takes within 5%");
    let floor = quote / 100;
    refused(
        t.run_amount(&h, 0, Some(floor - 1), &extra),
        E::AmountTooSmall,
        "below 1% of the pool's SOL",
    );
    refused(
        t.run_amount(&h, 0, Some(2 * SOL + 1), &extra),
        E::InvalidAmount,
        "above the node's cap",
    );
    refused(
        t.run_amount(&h, 1, Some(5), &Extra::None),
        E::AmountNotAllowed,
        "a keeper's amount on a burn",
    );
    let sent = t
        .run_amount(&h, 0, Some(SOL / 4), &extra)
        .expect_ok("a quarter SOL runs");
    let ev = ran(&sent);
    assert_eq!(ev.spent, SOL / 4);
    assert!(ev.bought > 0 && ev.bought == ev.burned);
    // Audit 4, A4-2: an eighth of the node's amount, an eighth of a tip;
    // the node's run stays open for the rest.
    assert!(ev.partial);
    assert_eq!(ev.tip, TIP_LAMPORTS / 8);
    println!(
        "F4: pool {:.2} SOL; 2 SOL failed {fails}/{fails} hourly runs; a keeper ran 0.25 SOL (bought {}), floor {floor} lamports",
        quote as f64 / SOL as f64,
        ev.bought
    );
    let st = t.state();
    assert_eq!(
        (st.nodes[0].runs_in_epoch, st.nodes[0].spent_in_epoch),
        (0, SOL / 4)
    );
    assert_eq!(st.partial_spent[0], SOL / 4);
}

/// F5. Anyone donated one raw token before each run of a burn node and was
/// paid the full tip for burning it: 60 runs in a day took the day's whole
/// tip cap (0.005 SOL) for 60 raw units. Now a tip is at most a tenth of
/// what the run moved.
#[test]
fn f5_dust_burns_earn_no_tips() {
    let mut t = ap_world(true);
    let mut n = gnode(EVERY, 600, BURN, 1_000_000_000_000, 0);
    n.max_runs_per_epoch = 1_000;
    n.budget_per_epoch = 1 << 62;
    let h = t.activate_now(&graph(vec![n]));
    t.fund_sol(SOL);
    let tip_acct = t.keeper_tip();
    let tip0 = t.w.env.token_amount(&tip_acct);
    let sol0 = t.sol();
    let now = t.now();
    t.env().set_time(now - now % 86_400 + 86_400);
    let mut burned = 0;
    for _ in 0..60 {
        t.fund_tokens(1);
        let ev = ran(&t.run(&h, 0, &Extra::None).expect_ok("dust burn"));
        assert_eq!(ev.tip, 0);
        burned += ev.burned;
        let now = t.now();
        t.env().set_time(now + 600);
    }
    assert_eq!(burned, 60);
    assert_eq!(t.w.env.token_amount(&tip_acct), tip0);
    assert_eq!(t.sol(), sol0);
    // A burn worth a hundredth of a SOL earns the full tip.
    let reference = t.state().ref_sqrt_price;
    let worth = (10_000_000u128 << 64) / price::price_q64(reference).unwrap();
    let amount = u64::try_from(worth).unwrap() + 1;
    t.fund_tokens(amount);
    let ev = ran(&t.run(&h, 0, &Extra::None).expect_ok("a real burn"));
    assert_eq!((ev.burned, ev.tip), (amount, TIP_LAMPORTS));
    println!(
        "F5: 60 dust burns paid no tips; a burn worth 0.01 SOL paid {}",
        ev.tip
    );
}

/// Info: if DAMM v2 changed its pool layout, only buybacks (which trade on
/// the pool) and observations would stop; burns and distributions run on.
#[test]
fn a_pool_the_program_cannot_read_stops_only_buybacks() {
    let mut t = ap_world(true);
    let alice = Keypair::new().pubkey();
    let payer = t.payer();
    t.send(
        &[create_ata(&payer, &alice, &WSOL_MINT, &TOKEN_PROGRAM_ID)],
        &[],
    )
    .expect_ok("alice's wSOL account");
    let mut p = graph(vec![
        gnode(EVERY, 600, BUYBACK_BURN, SOL / 10, 500),
        gnode(EVERY, 600, BURN, 10, 0),
        gnode(EVERY, 600, DISTRIBUTE_SOL, SOL / 10, 0),
    ]);
    p.recipients = vec![noised_rules::Recipient {
        key: alice.to_bytes(),
        bps: 10_000,
    }];
    t.fund_sol(SOL);
    t.fund_tokens(100);
    let h = t.activate_now(&p);
    t.observe_and_wait();
    // DAMM v2 "reallocates" its pools.
    let pool = t.d.pool;
    let mut acct = t.w.env.account(&pool).unwrap();
    acct.data.extend_from_slice(&[0; 64]);
    acct.lamports += 1_000_000;
    t.w.env.svm.set_account(pool, acct).unwrap();
    let extra = t.buyback();
    refused(t.run(&h, 0, &extra), E::InvalidPool, "a buyback");
    refused(t.observe(), E::InvalidPool, "an observation");
    let before = t.state();
    t.run(&h, 1, &Extra::None).expect_ok("a burn runs");
    t.run(&h, 2, &Extra::Distribute(vec![wsol_ata(&alice)]))
        .expect_ok("a distribution runs");
    assert_eq!(t.w.env.token_amount(&wsol_ata(&alice)), SOL / 10);
    // They observed nothing.
    let after = t.state();
    assert_eq!(
        (after.observations, after.ref_sqrt_price),
        (before.observations, before.ref_sqrt_price)
    );
}

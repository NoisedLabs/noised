// Generator of autopilot.json (kept for reproducibility; not compiled here).
// Regenerated for SDK 0.9.0 against the programs as merged after audit round 4
// (freeze payload v2, revocation payload v3 with active_auth, partial buybacks
// and RemainderTooSmall, max_tip, burn_price, reference::lowest, the
// 1,244-byte Autopilot account).
// To regenerate: copy this file to programs/noised-autopilot/src/tests/
// sdk_vectors.rs in a scratch copy of the workspace, add `mod sdk_vectors;`
// to src/tests/mod.rs, then run
//   SDK_VECTORS_OUT=<path>/autopilot.json cargo test -p noised-autopilot --lib write_sdk_vectors
// and update the pinned hash in sdk/test/programmable/autopilot.vectors.test.ts.
//! SDK parity vectors (scratch copy only, never in the repo): runs the
//! program's own pure functions (`price`, `reference`, `logic`) on seeded
//! random inputs and writes every input and result as JSON to
//! `$SDK_VECTORS_OUT`. The TypeScript SDK replays them
//! (sdk/test/programmable/autopilot.vectors.test.ts).

use std::fmt::Write as _;

use noised_rules::{
    graph::{action, trigger, NodeState, FLAG_HAS_OPERATOR},
    op, GNode, Graph, GraphProgram, Node, Recipient,
};

use super::Lcg;
use crate::{
    constants::*,
    launchpad::{self, authorization::kind},
    logic::{self, Plan, RunInput},
    price,
    reference::{self, PriceState, Seen},
    state::{AuthMark, NodeRecord, ObsBucket, MAX_NODES},
};
use anchor_lang::prelude::*;

fn err_name<T>(r: &Result<T>) -> Option<String> {
    match r {
        Ok(_) => None,
        Err(Error::AnchorError(e)) => Some(e.error_name.clone()),
        Err(e) => Some(format!("{e:?}")),
    }
}

fn q(v: impl ToString) -> String {
    format!("\"{}\"", v.to_string())
}

fn opt_q<T: ToString>(v: Option<T>) -> String {
    v.map_or("null".to_string(), |x| q(x))
}

fn hex(b: &[u8]) -> String {
    let mut s = String::new();
    for x in b {
        let _ = write!(s, "{x:02x}");
    }
    s
}

/// `[index, first_at, min, max]`.
fn bucket_json(b: &ObsBucket) -> String {
    format!("[{},{},{},{}]", q(b.index), q(b.first_at), q(b.min), q(b.max))
}

/// `[reference, updated_at, allowance, allowance_at, current bucket, previous bucket]`.
fn price_state_json(p: &PriceState) -> String {
    format!(
        "[{},{},{},{},{},{}]",
        q(p.reference),
        q(p.updated_at),
        q(p.allowance),
        q(p.allowance_at),
        bucket_json(&p.observations[0]),
        bucket_json(&p.observations[1])
    )
}

fn seen_json(s: Option<Seen>) -> String {
    s.map_or("null".to_string(), |s| format!("{{\"min\":{},\"max\":{}}}", q(s.min), q(s.max)))
}

/// A sqrt price in DAMM v2's range (below 2^96), often near `around`.
fn sqrt_near(rng: &mut Lcg, around: u128) -> u128 {
    match rng.below(10) {
        0 => rng.bits128(96),
        1 => 0,
        2 => around,
        _ => {
            // around * (1 +- up to ~30%), in sqrt-bps.
            let bps = rng.below(6_000) as u128;
            let v = around / 10_000 * (7_000 + bps);
            v.max(1)
        }
    }
}

fn price_vectors(rng: &mut Lcg, out: &mut Vec<String>) {
    for i in 0..1_000 {
        let edge = i % 4 == 0;
        let sqrt = if edge { rng.bits128(128) } else { rng.bits128(97) };
        out.push(format!(
            "{{\"fn\":\"price_q64\",\"sqrt\":{},\"out\":{}}}",
            q(sqrt),
            opt_q(price::price_q64(sqrt))
        ));
        let spot = if edge { rng.bits128(128) } else { rng.bits128(96) };
        let reference = if rng.below(3) == 0 {
            spot
        } else if edge {
            rng.bits128(128)
        } else {
            sqrt_near(rng, spot.max(1))
        };
        let premium = match rng.below(5) {
            0 => 0,
            1 => 2_000,
            2 => rng.next(),
            _ => rng.below(2_001),
        };
        out.push(format!(
            "{{\"fn\":\"within_premium\",\"spot\":{},\"ref\":{},\"premium\":{},\"out\":{}}}",
            q(spot),
            q(reference),
            q(premium),
            price::within_premium(spot, reference, premium)
        ));
        let amount = match rng.below(4) {
            0 => rng.next(),
            1 => u64::MAX,
            _ => rng.below(1_000_000_000_000),
        };
        out.push(format!(
            "{{\"fn\":\"min_out\",\"amount_in\":{},\"ref\":{},\"premium\":{},\"out\":{}}}",
            q(amount),
            q(reference),
            q(premium),
            opt_q(price::min_out(amount, reference, premium))
        ));
        out.push(format!(
            "{{\"fn\":\"token_value\",\"amount\":{},\"sqrt\":{},\"out\":{}}}",
            q(amount),
            q(sqrt),
            q(price::token_value(amount, sqrt))
        ));
    }
}

/// Histories of observations and reference moves, as `update_price` and
/// every run make them (observe, seen, follow), with the bound.
fn reference_vectors(rng: &mut Lcg, out: &mut Vec<String>) {
    for _ in 0..100 {
        let reference = match rng.below(4) {
            0 => rng.bits128(96).max(1),
            _ => (1u128 << 64) >> rng.below(20) << rng.below(20),
        };
        let start: i64 = 1_800_000_000 + rng.below(1_000_000) as i64;
        let mut p = PriceState {
            reference,
            updated_at: 0,
            allowance: if rng.below(2) == 0 { 0 } else { rng.below(REF_ALLOWANCE_MAX + 1) },
            allowance_at: if rng.below(2) == 0 { 0 } else { start - rng.below(10_000) as i64 },
            observations: [ObsBucket::default(); 2],
        };
        let initial = price_state_json(&p);
        let mut now = start;
        let mut market = reference;
        let mut ops = Vec::new();
        for _ in 0..(5 + rng.below(35)) {
            now += match rng.below(12) {
                0 => -(rng.below(2_000) as i64),
                1 => rng.below(10_000) as i64,
                2 => 0,
                3 => 60,
                _ => rng.below(700) as i64,
            };
            // The market drifts; sometimes a spike or a dump.
            market = match rng.below(10) {
                0 => market / 10_000 * (10_000 + rng.below(3_000) as u128),
                1 => (market / 10_000 * (10_000 - rng.below(3_000) as u128)).max(1),
                _ => (market / 100_000 * (99_000 + rng.below(2_400) as u128)).max(1),
            };
            let spot = if rng.below(25) == 0 { 0 } else { market };
            let observe = rng.below(8) != 0; // a run before graduation does not observe
            if observe {
                reference::observe(&mut p.observations, now, spot);
            }
            let seen = reference::seen(&p.observations, now);
            let moved = reference::follow(&mut p, seen, now);
            let cap = reference::buyback_cap(p.reference, seen);
            ops.push(format!(
                "{{\"now\":{},\"spot\":{},\"obs\":{},\"seen\":{},\"moved\":{},\"cap\":{},\"st\":{}}}",
                q(now),
                q(spot),
                observe,
                seen_json(seen),
                moved,
                opt_q(cap),
                price_state_json(&p)
            ));
        }
        out.push(format!(
            "{{\"initial\":{},\"ops\":[{}]}}",
            initial,
            ops.join(",")
        ));
    }
}

fn logic_vectors(rng: &mut Lcg, out: &mut Vec<String>) {
    // keeper_floor
    for _ in 0..300 {
        let v = match rng.below(3) {
            0 => rng.next(),
            1 => u64::MAX - rng.below(5),
            _ => rng.below(1_000_000_000_000),
        };
        out.push(format!(
            "{{\"fn\":\"keeper_floor\",\"pool_quote\":{},\"out\":{}}}",
            q(v),
            q(logic::keeper_floor(v))
        ));
    }
    // run_amount
    let small = |rng: &mut Lcg| -> u64 {
        match rng.below(6) {
            0 => 0,
            1 => 1,
            2 => u64::MAX,
            _ => rng.below(2_000),
        }
    };
    for _ in 0..1_000 {
        let gated = rng.below(2) == 0;
        let amount = if rng.below(3) == 0 { None } else { Some(small(rng)) };
        let cap = small(rng);
        let available = small(rng);
        let floor = if rng.below(3) == 0 { None } else { Some(small(rng)) };
        let r = logic::run_amount(gated, amount, cap, available, floor);
        out.push(format!(
            "{{\"fn\":\"run_amount\",\"gated\":{},\"amount\":{},\"cap\":{},\"available\":{},\"floor\":{},\"out\":{},\"err\":{}}}",
            gated,
            opt_q(amount),
            q(cap),
            q(available),
            opt_q(floor),
            opt_q(r.as_ref().ok().copied()),
            opt_q(err_name(&r))
        ));
    }
    // run_amount at the partial-run edges (audit 4, A4-2): a keeper's amount near cap - floor.
    for _ in 0..400 {
        let floor = rng.below(1_000);
        let cap = rng.below(5_000);
        let available = match rng.below(3) {
            0 => cap.saturating_sub(rng.below(1_000)),
            1 => u64::MAX,
            _ => cap + rng.below(1_000),
        };
        let amount = match rng.below(6) {
            0 => cap,
            1 => cap.saturating_sub(floor),
            2 => cap.saturating_sub(floor).saturating_add(1),
            3 => cap.saturating_sub(floor).saturating_sub(1),
            4 => floor,
            _ => rng.below(cap.max(1)),
        };
        let r = logic::run_amount(false, Some(amount), cap, available, Some(floor));
        out.push(format!(
            "{{\"fn\":\"run_amount\",\"gated\":false,\"amount\":{},\"cap\":{},\"available\":{},\"floor\":{},\"out\":{},\"err\":{}}}",
            q(amount),
            q(cap),
            q(available),
            q(floor),
            opt_q(r.as_ref().ok().copied()),
            opt_q(err_name(&r))
        ));
    }
    // take_tip: sequences on one autopilot (max_tip: a partial buyback's share, audit 4 A4-2).
    for _ in 0..120 {
        let mut epoch_start: i64 = if rng.below(2) == 0 { 0 } else { 1_800_000_000 - 1_800_000_000 % 86_400 };
        let mut in_epoch: u64 = if rng.below(2) == 0 { 0 } else { rng.below(TIP_EPOCH_CAP + 10) };
        let (s0, i0) = (epoch_start, in_epoch);
        let mut now: i64 = 1_800_000_000 + rng.below(200_000) as i64;
        let mut steps = Vec::new();
        for _ in 0..(1 + rng.below(50)) {
            now += match rng.below(10) {
                0 => -(rng.below(200_000) as i64),
                1 => rng.below(200_000) as i64,
                _ => rng.below(3_000) as i64,
            };
            let treasury = match rng.below(5) {
                0 => rng.below(200_000),
                1 => 0,
                _ => rng.below(10_000_000_000),
            };
            let value = match rng.below(5) {
                0 => rng.below(2_000_000),
                1 => u64::MAX,
                2 => 0,
                _ => rng.below(10_000_000_000),
            };
            let max_tip = match rng.below(4) {
                0 => rng.below(TIP_LAMPORTS + 1),
                1 => 0,
                _ => TIP_LAMPORTS,
            };
            let tip = logic::take_tip(&mut epoch_start, &mut in_epoch, now, treasury, value, max_tip);
            steps.push(format!(
                "{{\"now\":{},\"treasury_sol\":{},\"value\":{},\"max_tip\":{},\"tip\":{},\"epoch_start\":{},\"in_epoch\":{}}}",
                q(now),
                q(treasury),
                q(value),
                q(max_tip),
                q(tip),
                q(epoch_start),
                q(in_epoch)
            ));
        }
        out.push(format!(
            "{{\"fn\":\"take_tip\",\"epoch_start\":{},\"in_epoch\":{},\"steps\":[{}]}}",
            q(s0),
            q(i0),
            steps.join(",")
        ));
    }
    // check_activation
    for _ in 0..500 {
        let active = if rng.below(2) == 0 { [0u8; 32] } else { [7u8; 32] };
        let pending = if rng.below(2) == 0 { [0u8; 32] } else { [9u8; 32] };
        let frozen = rng.below(6) == 0;
        let now: i64 = 1_800_000_000 + rng.below(1_000) as i64;
        let auth = now + rng.below(2_000) as i64 - 1_000;
        let at = match rng.below(6) {
            0 => i64::MAX - rng.below(10) as i64,
            1 => now + UPDATE_TIMELOCK_SECS + rng.below(2_000) as i64 - 1_000,
            2 => auth + UPDATE_TIMELOCK_SECS + rng.below(3) as i64 - 1,
            _ => now + rng.below(4_000) as i64 - 2_000,
        };
        let now = if rng.below(20) == 0 { i64::MAX - rng.below(100) as i64 } else { now };
        let r = logic::check_activation(&active, &pending, frozen, now, at, auth);
        out.push(format!(
            "{{\"fn\":\"check_activation\",\"active\":{},\"pending\":{},\"frozen\":{},\"now\":{},\"activate_at\":{},\"auth_unix_time\":{},\"err\":{}}}",
            active != [0; 32],
            pending != [0; 32],
            frozen,
            q(now),
            q(at),
            q(auth),
            opt_q(err_name(&r))
        ));
    }
    // check_fresh
    for _ in 0..500 {
        let mk = |rng: &mut Lcg| AuthMark {
            slot: rng.below(5),
            key: Pubkey::new_from_array([rng.below(3) as u8; 32]),
        };
        let marks = [mk(rng), mk(rng), mk(rng)];
        let mark = mk(rng);
        let k = rng.below(5) as u8;
        let r = logic::check_fresh(&mark, &marks, k);
        let mj = |m: &AuthMark| format!("{{\"slot\":{},\"key\":\"{}\"}}", q(m.slot), hex(m.key.as_ref()));
        out.push(format!(
            "{{\"fn\":\"check_fresh\",\"mark\":{},\"marks\":[{},{},{}],\"kind\":{},\"err\":{}}}",
            mj(&mark),
            mj(&marks[0]),
            mj(&marks[1]),
            mj(&marks[2]),
            k,
            opt_q(err_name(&r))
        ));
    }
    // check_apply
    for _ in 0..500 {
        let pending = if rng.below(4) == 0 { [0u8; 32] } else { [9u8; 32] };
        let frozen = rng.below(6) == 0;
        let at: i64 = 1_800_000_000 + rng.below(100) as i64;
        let now = at + rng.below(100) as i64 - 50;
        let r = logic::check_apply(&pending, at, frozen, now);
        out.push(format!(
            "{{\"fn\":\"check_apply\",\"pending\":{},\"activate_at\":{},\"frozen\":{},\"now\":{},\"err\":{}}}",
            pending != [0; 32],
            q(at),
            frozen,
            q(now),
            opt_q(err_name(&r))
        ));
    }
    // record_run
    for _ in 0..400 {
        let mut node = NodeRecord {
            last_run: 1_800_000_000 - rng.below(1_000_000) as i64,
            last_seq: rng.below(100),
            epoch_start: 1_800_000_000 - rng.below(500_000) as i64,
            runs_in_epoch: if rng.below(20) == 0 { u16::MAX } else { rng.below(20) as u16 },
            spent_in_epoch: if rng.below(20) == 0 { u64::MAX - rng.below(3) } else { rng.below(1_000_000) },
        };
        let before = node;
        let mut seq = if rng.below(30) == 0 { u64::MAX } else { rng.below(1_000) };
        let seq0 = seq;
        let epoch_secs = [3_600u32, 86_400, 604_800, 1][rng.below(4) as usize];
        let now = 1_800_000_000 + rng.below(1_000_000) as i64 - 300_000;
        let spent = if rng.below(10) == 0 { u64::MAX } else { rng.below(1_000_000) };
        // Audit 4, A4-2: a partial buyback only grows the node's open run.
        let mut partial_spent: u64 = match rng.below(4) {
            0 => 0,
            1 => u64::MAX - rng.below(3),
            _ => rng.below(1_000_000),
        };
        let partial_spent0 = partial_spent;
        let partial = rng.below(3) == 0;
        let r = logic::record_run(&mut node, &mut partial_spent, &mut seq, epoch_secs, now, spent, partial);
        let nj = |n: &NodeRecord| {
            format!(
                "{{\"last_run\":{},\"last_seq\":{},\"epoch_start\":{},\"runs_in_epoch\":{},\"spent_in_epoch\":{}}}",
                q(n.last_run),
                q(n.last_seq),
                q(n.epoch_start),
                n.runs_in_epoch,
                q(n.spent_in_epoch)
            )
        };
        let after = if r.is_ok() { nj(&node) } else { "null".to_string() };
        out.push(format!(
            "{{\"fn\":\"record_run\",\"node\":{},\"seq\":{},\"epoch_secs\":{},\"now\":{},\"spent\":{},\"partial\":{},\"partial_spent\":{},\"out\":{},\"seq_out\":{},\"partial_spent_out\":{},\"err\":{}}}",
            nj(&before),
            q(seq0),
            epoch_secs,
            q(now),
            q(spent),
            partial,
            q(partial_spent0),
            after,
            if r.is_ok() { q(seq) } else { "null".to_string() },
            if r.is_ok() { q(partial_spent) } else { "null".to_string() },
            opt_q(err_name(&r))
        ));
    }
    // burn_price (audit 4, A4-4): nothing before graduation, then min(reference, lowest observed).
    for _ in 0..300 {
        let graduated = rng.below(4) != 0;
        let reference = rng.bits128(97);
        let lowest = if rng.below(3) == 0 { None } else { Some(rng.bits128(97)) };
        out.push(format!(
            "{{\"fn\":\"burn_price\",\"graduated\":{},\"reference\":{},\"lowest\":{},\"out\":{}}}",
            graduated,
            q(reference),
            opt_q(lowest),
            q(logic::burn_price(graduated, reference, lowest))
        ));
    }
    // reference::lowest: the lowest price in the current and previous bucket, however recent.
    for _ in 0..300 {
        let now: i64 = 1_800_000_000 + rng.below(100_000) as i64;
        let bucket = |rng: &mut Lcg| -> ObsBucket {
            if rng.below(4) == 0 {
                return ObsBucket::default();
            }
            let index = now.div_euclid(OBS_BUCKET_SECS) - rng.below(4) as i64;
            let min = rng.bits128(97).max(1);
            ObsBucket { index, first_at: index * OBS_BUCKET_SECS + rng.below(OBS_BUCKET_SECS as u64) as i64, min, max: min.saturating_add(rng.bits128(90)) }
        };
        let obs = [bucket(rng), bucket(rng)];
        out.push(format!(
            "{{\"fn\":\"lowest\",\"now\":{},\"obs\":[{},{}],\"out\":{}}}",
            q(now),
            bucket_json(&obs[0]),
            bucket_json(&obs[1]),
            opt_q(reference::lowest(&obs, now))
        ));
    }
    // Plan::value (burn_price, kept), Plan::partial and Plan::max_tip (audit 4, A4-2 / A4-4 / M4).
    for _ in 0..300 {
        let amount = match rng.below(4) {
            0 => u64::MAX - rng.below(3),
            1 => rng.below(100),
            _ => rng.below(20_000_000_000),
        };
        let p1 = match rng.below(4) {
            0 => 0,
            1 => u64::MAX,
            _ => 1 + rng.below(20_000_000_000),
        };
        let price = rng.bits128(97);
        let kept = match rng.below(3) {
            0 => 0,
            1 => u64::MAX,
            _ => rng.below(20_000_000_000),
        };
        let mut shares = [0u64; 8];
        shares[0] = amount / 2;
        shares[1] = amount - amount / 2;
        let plan = match rng.below(4) {
            0 => Plan::Buyback { amount_in: amount, min_out: 1, partial: false },
            1 => Plan::Buyback { amount_in: amount.min(p1.saturating_sub(1)), min_out: 1, partial: true },
            2 => Plan::Burn { amount },
            _ => Plan::Distribute { shares, total: amount },
        };
        let (kind, a, partial) = match plan {
            Plan::Buyback { amount_in, partial, .. } => ("buyback", amount_in, partial),
            Plan::Burn { amount } => ("burn", amount, false),
            Plan::Distribute { total, .. } => ("distribute", total, false),
        };
        out.push(format!(
            "{{\"fn\":\"plan_value\",\"kind\":\"{}\",\"amount\":{},\"partial\":{},\"p1\":{},\"burn_price\":{},\"kept\":{},\"value\":{},\"is_partial\":{},\"max_tip\":{}}}",
            kind,
            q(a),
            partial,
            q(p1),
            q(price),
            q(kept),
            q(plan.value(price, kept)),
            plan.partial(),
            q(plan.max_tip(p1))
        ));
    }
    // Payload hashes of the three authorization kinds (freeze v2: not_after; revocation v3: active_auth).
    for _ in 0..50 {
        let ap = Pubkey::new_from_array(std::array::from_fn(|_| rng.below(256) as u8));
        let gh: [u8; 32] = std::array::from_fn(|_| rng.below(256) as u8);
        let opk = Pubkey::new_from_array(std::array::from_fn(|_| rng.below(256) as u8));
        let active_auth = Pubkey::new_from_array(std::array::from_fn(|_| rng.below(256) as u8));
        let at = match rng.below(3) {
            0 => -(rng.next() as i64 >> 1),
            _ => 1_800_000_000 + rng.below(1_000_000) as i64,
        };
        let not_after = at.saturating_add(rng.below(100_000) as i64);
        out.push(format!(
            "{{\"fn\":\"payloads\",\"autopilot\":\"{}\",\"graph_hash\":\"{}\",\"operator\":\"{}\",\"active_auth\":\"{}\",\"activate_at\":{},\"not_after\":{},\"activate\":\"{}\",\"freeze\":\"{}\",\"revoke\":\"{}\"}}",
            hex(ap.as_ref()),
            hex(&gh),
            hex(opk.as_ref()),
            hex(active_auth.as_ref()),
            q(at),
            q(not_after),
            hex(&launchpad::activation_payload(&ap, &gh, at)),
            hex(&launchpad::freeze_payload(&ap, &gh, not_after)),
            hex(&launchpad::revoke_payload(&ap, &gh, &opk, &active_auth))
        ));
    }
    let _ = kind::GRAPH_ACTIVATE;
}

fn leaf(op: u8, a: u8, arg: u64) -> Node {
    Node { op, a, arg }
}

/// A random graph that verifies, with its bytes.
fn random_graph(rng: &mut Lcg, reference: u128) -> Vec<u8> {
    loop {
        let n_nodes = 1 + rng.below(4) as usize;
        let mut nodes = Vec::new();
        let mut cond = Vec::new();
        let mut gated_any = false;
        let mut distributes = false;
        for i in 0..n_nodes {
            let act = [action::BUYBACK_BURN, action::BUYBACK_BURN, action::BURN, action::DISTRIBUTE_SOL][rng.below(4) as usize];
            let (trig, targ) = match rng.below(5) {
                0 if i > 0 => (trigger::AFTER, rng.below(i as u64)),
                1 => (trigger::ON_GRADUATED, 0),
                2 => (trigger::WHEN, 0),
                _ => (trigger::EVERY, [600u64, 3_600, 86_400][rng.below(3) as usize]),
            };
            let p1 = match rng.below(4) {
                0 => 1 + rng.below(100),
                1 => u64::MAX,
                _ => 1 + rng.below(10_000_000_000),
            };
            let budget = match rng.below(4) {
                0 => p1,
                1 => u64::MAX,
                _ => 1 + rng.below(20_000_000_000),
            };
            let gated = rng.below(4) == 0;
            gated_any |= gated;
            distributes |= act == action::DISTRIBUTE_SOL;
            let off = cond.len() as u8;
            let mut len = 0u8;
            if trig == trigger::WHEN || rng.below(3) == 0 {
                let price_arg = (reference.min(u64::MAX as u128) as u64)
                    .saturating_add(rng.below(1_000))
                    .saturating_sub(rng.below(1_000));
                let l = match rng.below(6) {
                    0 => leaf(op::graph::PRICE_LTE, 0, price_arg),
                    1 => leaf(op::graph::PRICE_GTE, 0, price_arg),
                    2 => leaf(op::graph::TREASURY_SOL_GTE, 0, rng.below(10_000_000_000)),
                    3 => leaf(op::graph::TREASURY_TOKEN_GTE, 0, rng.below(10_000_000_000)),
                    4 => leaf(op::graph::GRADUATED, 0, 0),
                    _ => leaf(op::graph::TIME_GE, 0, 1_800_000_000 + rng.below(2_000)),
                };
                cond.push(l);
                len = 1;
            }
            nodes.push(GNode {
                trigger: trig,
                trigger_arg: targ,
                cond_off: if len == 0 { 0 } else { off },
                cond_len: len,
                action: act,
                operator_gated: u8::from(gated),
                epoch_secs: [3_600u32, 86_400][rng.below(2) as usize],
                budget_per_epoch: budget,
                p1,
                p2: if act == action::BUYBACK_BURN { [0u64, 100, 300, 2_000][rng.below(4) as usize] } else { 0 },
                max_runs_per_epoch: 1 + rng.below(5) as u16,
                reserved: [0; 5],
            });
        }
        let program = GraphProgram {
            flags: if gated_any { FLAG_HAS_OPERATOR } else { 0 },
            operator: if gated_any { [0xEE; 32] } else { [0; 32] },
            recipients: if distributes {
                vec![
                    Recipient { key: [0xA1; 32], bps: 7_001 },
                    Recipient { key: [0xA2; 32], bps: 2_999 },
                ]
            } else {
                vec![]
            },
            nodes,
            cond,
        };
        let Ok(bytes) = program.encode() else { continue };
        if Graph::verify(&bytes).is_ok() {
            return bytes;
        }
    }
}

fn plan_vectors(rng: &mut Lcg, graphs: &mut Vec<String>, out: &mut Vec<String>) {
    const NOW: i64 = 1_800_000_000;
    for _ in 0..300 {
        let reference = match rng.below(3) {
            0 => 1u128 << 64,
            1 => (1u128 << 64) >> (1 + rng.below(20)),
            _ => rng.bits128(80).max(1),
        };
        let bytes = random_graph(rng, reference);
        let gi = graphs.len();
        graphs.push(format!("\"{}\"", hex(&bytes)));
        let g = Graph::parse(&bytes).unwrap();
        let n = g.node_count();
        for _ in 0..8 {
            // Half the cases are "favourable" (the keeper or the operator does
            // what the program expects), so every success path is covered.
            let fav = rng.below(2) == 0;
            let node = if rng.below(30) == 0 { n + rng.below(3) as usize } else { rng.below(n as u64) as usize };
            let mut states = [NodeState::default(); MAX_NODES];
            for s in states.iter_mut().take(n) {
                if fav || rng.below(2) == 0 {
                    continue;
                }
                s.last_run = NOW - rng.below(200_000) as i64;
                s.last_seq = rng.below(6);
                s.epoch_start = NOW - rng.below(200_000) as i64;
                s.runs_in_epoch = rng.below(6) as u16;
                s.spent_in_epoch = match rng.below(3) {
                    0 => 0,
                    1 => u64::MAX,
                    _ => rng.below(10_000_000_000),
                };
            }
            let gated_op = g.operator().map(|k| Pubkey::new_from_array(*k));
            let operator = if !fav && rng.below(6) == 0 { Pubkey::default() } else { gated_op.unwrap_or_default() };
            let signer = if fav {
                gated_op
            } else {
                match rng.below(4) {
                    0 => None,
                    1 => Some(Pubkey::new_from_array([0x11; 32])),
                    _ => Some(operator),
                }
            };
            let gated = g.node(node).map(|x| x.operator_gated == 1).unwrap_or(false);
            let amount = match (fav, gated) {
                (true, true) => Some(1 + rng.below(5_000_000_000)),
                (true, false) => {
                    if rng.below(2) == 0 {
                        None
                    } else {
                        Some(rng.below(20_000_000_000))
                    }
                }
                _ => match rng.below(4) {
                    0 | 1 => None,
                    2 => Some(rng.below(100)),
                    _ => Some(rng.below(20_000_000_000)),
                },
            };
            let graduated = fav || rng.below(5) != 0;
            let (spot, seen) = if fav {
                // Observed for a minute; spot within a few percent of the low.
                let low = sqrt_near(rng, reference).max(1);
                let spot = (low / 10_000 * (10_000 + rng.below(150) as u128)).max(low);
                (Some(spot), Some(Seen { min: low, max: spot }))
            } else {
                let spot = if !graduated || rng.below(15) == 0 {
                    if rng.below(2) == 0 {
                        None
                    } else {
                        Some(sqrt_near(rng, reference))
                    }
                } else {
                    Some(sqrt_near(rng, reference))
                };
                let seen = match rng.below(6) {
                    0 => None,
                    _ => {
                        let a = sqrt_near(rng, reference);
                        let b = sqrt_near(rng, reference);
                        Some(Seen { min: a.min(b), max: a.max(b) })
                    }
                };
                (spot, seen)
            };
            let pool_quote = match rng.below(5) {
                0 if !fav => None,
                1 => Some(u64::MAX),
                _ => Some(rng.below(1_000_000_000_000)),
            };
            let sol = match rng.below(4) {
                0 if !fav => 0,
                1 => rng.below(100),
                _ => rng.below(30_000_000_000),
            };
            let tokens = match rng.below(4) {
                0 if !fav => 0,
                _ => rng.below(30_000_000_000),
            };
            let now = NOW + rng.below(200_000) as i64 - 100_000;
            // What partial buybacks moved of the node's open run (audit 4, A4-2).
            let partial_spent = match rng.below(5) {
                0 => g.node(node).map_or(0, |x| x.p1.saturating_sub(rng.below(3))),
                1 => g.node(node).map_or(0, |x| rng.below(x.p1.max(1))),
                2 => u64::MAX,
                _ => 0,
            };
            let input = RunInput {
                graph: &g,
                node,
                now,
                states: &states,
                operator,
                operator_signer: signer,
                amount,
                treasury_sol: sol,
                treasury_token: tokens,
                graduated,
                spot,
                reference,
                seen,
                pool_quote,
                partial_spent,
            };
            out.push(plan_json(gi, n, &input));
        }
        // Keeper buybacks at the partial-run edges (audit 4, A4-2): amounts at the cap, at cap - floor and around
        // it, at the floor; with and without an open run. Favourable otherwise (graduated, observed, within premium).
        for node in 0..n {
            let Some(gn) = g.node(node) else { continue };
            if gn.action != action::BUYBACK_BURN || gn.operator_gated == 1 {
                continue;
            }
            for _ in 0..2 {
                let states = [NodeState::default(); MAX_NODES];
                let partial_spent = if rng.below(2) == 0 { 0 } else { rng.below(gn.p1.max(1)) };
                let cap = g.run_cap(node, &states[node], NOW).min(gn.p1.saturating_sub(partial_spent));
                let pool_quote = rng.below(1_000_000_000_000);
                let floor = logic::keeper_floor(pool_quote);
                let amount = match rng.below(6) {
                    0 => cap,
                    1 => cap.saturating_sub(floor),
                    2 => cap.saturating_sub(floor).saturating_add(1),
                    3 => floor.max(1),
                    4 => cap.saturating_sub(1),
                    _ => cap.saturating_sub(rng.below(floor.max(1))),
                };
                // Observed at or below the reference, the pool at that low: within any premium.
                let low = sqrt_near(rng, reference).max(1).min(reference.max(1));
                let spot = low;
                let input = RunInput {
                    graph: &g,
                    node,
                    now: NOW,
                    states: &states,
                    operator: g.operator().map(|k| Pubkey::new_from_array(*k)).unwrap_or_default(),
                    operator_signer: None,
                    amount: Some(amount),
                    treasury_sol: match rng.below(3) {
                        0 => cap.saturating_sub(rng.below(floor.max(1))),
                        _ => cap.saturating_add(rng.below(10_000_000_000)),
                    },
                    treasury_token: rng.below(30_000_000_000),
                    graduated: true,
                    spot: Some(spot),
                    reference,
                    seen: Some(Seen { min: low, max: spot }),
                    pool_quote: Some(pool_quote),
                    partial_spent,
                };
                out.push(plan_json(gi, n, &input));
            }
        }
    }
}

/// One `plan_run` case as JSON: its inputs, the plan (with spent, value at the reference, max_tip) or the error.
fn plan_json(gi: usize, n: usize, input: &RunInput) -> String {
    let r = logic::plan_run(input);
    let reference = input.reference;
    let p1 = input.graph.node(input.node).map_or(0, |x| x.p1);
    let tail = |r: &Result<Plan>| {
        let p = r.as_ref().unwrap();
        format!(",\"spent\":{},\"value\":{},\"max_tip\":{}}}", q(p.spent()), q(p.value(reference, 0)), q(p.max_tip(p1)))
    };
    let plan = match &r {
        Ok(Plan::Buyback { amount_in, min_out, partial }) => {
            format!("{{\"kind\":\"buyback\",\"amount_in\":{},\"min_out\":{},\"partial\":{}{}", q(amount_in), q(min_out), partial, tail(&r))
        }
        Ok(Plan::Burn { amount }) => format!("{{\"kind\":\"burn\",\"amount\":{}{}", q(amount), tail(&r)),
        Ok(Plan::Distribute { shares, total }) => format!(
            "{{\"kind\":\"distribute\",\"shares\":[{}],\"total\":{}{}",
            shares.iter().map(|s| q(s)).collect::<Vec<_>>().join(","),
            q(total),
            tail(&r)
        ),
        Err(_) => "null".to_string(),
    };
    // [last_run, last_seq, epoch_start, runs_in_epoch, spent_in_epoch]
    let sj = |s: &NodeState| {
        format!(
            "[{},{},{},{},{}]",
            q(s.last_run),
            q(s.last_seq),
            q(s.epoch_start),
            s.runs_in_epoch,
            q(s.spent_in_epoch)
        )
    };
    format!(
        "{{\"g\":{},\"node\":{},\"now\":{},\"states\":[{}],\"operator\":\"{}\",\"signer\":{},\"amount\":{},\"sol\":{},\"tokens\":{},\"graduated\":{},\"spot\":{},\"reference\":{},\"seen\":{},\"pool_quote\":{},\"partial_spent\":{},\"plan\":{},\"err\":{}}}",
        gi,
        input.node,
        q(input.now),
        input.states.iter().take(n).map(sj).collect::<Vec<_>>().join(","),
        hex(input.operator.as_ref()),
        input.operator_signer.map_or("null".to_string(), |s| format!("\"{}\"", hex(s.as_ref()))),
        opt_q(input.amount),
        q(input.treasury_sol),
        q(input.treasury_token),
        input.graduated,
        opt_q(input.spot),
        q(reference),
        seen_json(input.seen),
        opt_q(input.pool_quote),
        q(input.partial_spent),
        plan,
        opt_q(err_name(&r))
    )
}

#[test]
fn write_sdk_vectors() {
    let Ok(path) = std::env::var("SDK_VECTORS_OUT") else {
        return;
    };
    let mut rng = Lcg(0x5d6_0600);
    let mut prices = Vec::new();
    price_vectors(&mut rng, &mut prices);
    let mut refs = Vec::new();
    reference_vectors(&mut rng, &mut refs);
    let mut logic_v = Vec::new();
    logic_vectors(&mut rng, &mut logic_v);
    let mut graphs = Vec::new();
    let mut plans = Vec::new();
    plan_vectors(&mut rng, &mut graphs, &mut plans);
    let consts = format!(
        "{{\"UPDATE_TIMELOCK_SECS\":{},\"TIP_LAMPORTS\":{},\"TIP_EPOCH_SECS\":{},\"TIP_EPOCH_CAP\":{},\"TIP_MAX_SHARE_BPS\":{},\"OBS_BUCKET_SECS\":{},\"OBS_MIN_SPAN_SECS\":{},\"REF_UP_SQRT_BPS_PER_HOUR\":{},\"REF_ALLOWANCE_MAX\":{},\"KEEPER_MIN_POOL_BPS\":{},\"AUTOPILOT_LEN\":{},\"BUYBACK_ACCOUNTS\":{}}}",
        UPDATE_TIMELOCK_SECS,
        TIP_LAMPORTS,
        TIP_EPOCH_SECS,
        TIP_EPOCH_CAP,
        TIP_MAX_SHARE_BPS,
        OBS_BUCKET_SECS,
        OBS_MIN_SPAN_SECS,
        REF_UP_SQRT_BPS_PER_HOUR,
        REF_ALLOWANCE_MAX,
        KEEPER_MIN_POOL_BPS,
        8 + <crate::state::Autopilot as anchor_lang::Space>::INIT_SPACE,
        crate::instructions::run::BUYBACK_ACCOUNTS
    );
    let json = format!(
        "{{\"generator\":\"programs/noised-autopilot src after audit round 4 (price.rs, reference.rs, logic.rs, launchpad.rs payloads) on seeded inputs\",\"constants\":{},\"price\":[\n{}\n],\"reference\":[\n{}\n],\"logic\":[\n{}\n],\"graphs\":[\n{}\n],\"plan_run\":[\n{}\n]}}\n",
        consts,
        prices.join(",\n"),
        refs.join(",\n"),
        logic_v.join(",\n"),
        graphs.join(",\n"),
        plans.join(",\n")
    );
    std::fs::write(path, json).unwrap();
}

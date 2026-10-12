//! Parity vectors for the TypeScript SDK: `tests/vectors/rules.json` and
//! `tests/vectors/graph.json`, generated from the case catalogues in
//! `tests/common/cases.rs` and checked against the files on every run.
//!
//! Regenerate after a deliberate change (then review the diff):
//!
//! ```text
//! NOISED_REGEN_VECTORS=1 cargo test -p noised-rules --test vectors
//! ```
//! (PowerShell: `$env:NOISED_REGEN_VECTORS='1'; cargo test -p noised-rules --test vectors`)
//!
//! Integers that may exceed 2^53 are decimal strings; byte strings are
//! lowercase hex. Every expected result is computed by the crate and checked
//! here against the independent reference model in `tests/common`.

mod common;

use common::cases::{graph_invalid, graph_valid, rules_invalid, rules_valid};
use common::*;
use noised_rules::graph::{trigger, GNode};
use noised_rules::{
    current_epoch, exceeds, graph_hash, rules_hash, threshold, Error, Graph, GraphCtx, NodeState,
    RuleSet, RulesProgram, Sha2, TransferCtx, BPS_FLAG,
};
use serde_json::{json, Value};

const REGEN: &str = "NOISED_REGEN_VECTORS";
/// `REGEN` before the rename to Noised, still accepted for one release.
const LEGACY_REGEN: &str = "PHALANX_REGEN_VECTORS";
/// Provenance text pinned byte-for-byte in the committed vector file (written before the rename to Noised): kept so the file stays identical.
const PINNED_REGENERATE: &str =
    "PHALANX_REGEN_VECTORS=1 cargo test -p phalanx-rules --test vectors";

fn s<T: ToString>(x: T) -> Value {
    Value::String(x.to_string())
}

fn ctx_json(c: &TransferCtx) -> Value {
    json!({
        "now_rel": s(c.now_rel),
        "is_buy": c.is_buy,
        "is_p2p": c.is_p2p,
        "amount": s(c.amount),
        "dest_balance_after": s(c.dest_balance_after),
        "supply": s(c.supply),
        "dest_owner": hex(&c.dest_owner),
        "src_owner": hex(&c.src_owner),
        "top_program": hex(&c.top_program),
        "tx_ix_count": c.tx_ix_count,
    })
}

fn gctx_json(c: &GraphCtx) -> Value {
    json!({
        "now": s(c.now),
        "treasury_sol": s(c.treasury_sol),
        "treasury_token": s(c.treasury_token),
        "graduated": c.graduated,
        "sqrt_price": s(c.sqrt_price),
        "runs_in_epoch": c.runs_in_epoch.to_vec(),
    })
}

fn state_json(st: &NodeState) -> Value {
    json!({
        "last_run": s(st.last_run),
        "last_seq": s(st.last_seq),
        "epoch_start": s(st.epoch_start),
        "runs_in_epoch": st.runs_in_epoch,
        "spent_in_epoch": s(st.spent_in_epoch),
    })
}

/// Transfers for one rule set: each window's edges plus seeded random ones.
fn rule_cases(p: &RulesProgram, guard: u32, seed: u64) -> Vec<TransferCtx> {
    let mut out = Vec::new();
    for r in p.rules.iter().take(3) {
        for t in [
            r.from_rel as i64 - 1,
            r.from_rel as i64,
            r.to_rel as i64 - 1,
            r.to_rel as i64,
        ] {
            let c = TransferCtx {
                now_rel: t,
                ..ctx()
            };
            if !out.contains(&c) {
                out.push(c);
            }
        }
    }
    let mut rng = Rng::new(seed);
    while out.len() < 16 {
        out.push(gen_ctx(&mut rng, p, guard));
    }
    out
}

fn rules_vectors() -> Value {
    let mut valid = Vec::new();
    for (i, v) in rules_valid().iter().enumerate() {
        let bytes = enc(&v.program);
        let set = RuleSet::verify(&bytes, v.guard).unwrap_or_else(|e| panic!("{}: {e}", v.name));
        let cases: Vec<Value> = rule_cases(&v.program, v.guard, 1_000 + i as u64)
            .iter()
            .map(|c| {
                let got = set.evaluate(c);
                assert_eq!(got, ref_rules_eval(&v.program, c), "{}", v.name);
                let conditions: Vec<bool> = (0..v.program.rules.len())
                    .map(|r| {
                        let x = set.condition(r, c).unwrap();
                        assert_eq!(Some(x), ref_rule_condition(&v.program, r, c));
                        x
                    })
                    .collect();
                json!({
                    "ctx": ctx_json(c),
                    "violation": match got {
                        Ok(()) => Value::Null,
                        Err(v) => json!({ "rule": v.rule, "code": v.code }),
                    },
                    "conditions": conditions,
                })
            })
            .collect();
        valid.push(json!({
            "name": v.name,
            "guard_secs": v.guard,
            "len": bytes.len(),
            "hex": hex(&bytes),
            "hash": hex(&rules_hash::<Sha2>(&bytes)),
            "cases": cases,
        }));
    }
    let invalid: Vec<Value> = rules_invalid()
        .iter()
        .map(|c| {
            assert_eq!(RuleSet::verify(&c.bytes, c.guard).err(), Some(c.error), "{}", c.name);
            json!({ "name": c.name, "guard_secs": c.guard, "hex": hex(&c.bytes), "error": c.error.name() })
        })
        .collect();
    let mut rng = Rng::new(77);
    let mut thresholds = Vec::new();
    for i in 0..40 {
        let supply = match i % 4 {
            0 => rng.pick(&[0, 1, 9_999, 10_000, u64::MAX]),
            _ => rng.wide(),
        };
        let arg = if i % 3 == 0 {
            rng.wide() & !BPS_FLAG
        } else {
            BPS_FLAG | (1 + rng.below(10_000))
        };
        let t = threshold(arg, supply);
        for value in [t.saturating_sub(1), t, t.saturating_add(1)] {
            thresholds.push(json!({
                "value": s(value),
                "arg": s(arg),
                "supply": s(supply),
                "threshold": s(t),
                "exceeds": exceeds(value, arg, supply),
            }));
        }
    }
    json!({
        "format": "PXR1",
        "hash": "SHA256(\"PHX-RULES-V1\" || bytes)",
        "regenerate": PINNED_REGENERATE,
        "notes": "u64/i64 values are decimal strings; bytes are hex. A valid entry verifies with its guard_secs; each case gives the evaluator's result (violation null = allowed) and each rule's condition value. An invalid entry fails verification with exactly the named error.",
        "valid": valid,
        "invalid": invalid,
        "thresholds": thresholds,
    })
}

fn graph_vectors() -> Value {
    let mut valid = Vec::new();
    for (i, v) in graph_valid().iter().enumerate() {
        let p = &v.program;
        let bytes = genc(p);
        let g = Graph::verify(&bytes).unwrap_or_else(|e| panic!("{}: {e}", v.name));
        let mut rng = Rng::new(2_000 + i as u64);
        let conditions: Vec<Value> = (0..6)
            .map(|_| {
                let c = gen_gctx(&mut rng, p);
                let holds: Vec<bool> = (0..p.nodes.len())
                    .map(|n| {
                        let x = g.condition(n, &c).unwrap();
                        assert_eq!(Some(x), ref_graph_condition(p, n, &c));
                        x
                    })
                    .collect();
                json!({ "ctx": gctx_json(&c), "holds": holds })
            })
            .collect();
        let schedule: Vec<Value> = (0..6)
            .map(|_| {
                let states = gen_states(&mut rng, p.nodes.len());
                let mut c = gen_gctx(&mut rng, p);
                c.now = rng.pick(&[
                    0i64,
                    600,
                    1_799_996_400,
                    1_800_000_000,
                    1_800_086_400,
                    i64::MAX,
                ]);
                c.runs_in_epoch = g.runs_in_epoch(&states, c.now);
                let name = |r: Result<(), noised_rules::NotDue>| match r {
                    Ok(()) => "Due".to_string(),
                    Err(e) => e.name().to_string(),
                };
                let due: Vec<String> = (0..p.nodes.len())
                    .map(|n| name(g.due(n, &states, c.now, c.graduated)))
                    .collect();
                let runnable: Vec<String> = (0..p.nodes.len())
                    .map(|n| name(g.runnable(n, &states, &c)))
                    .collect();
                let run_cap: Vec<Value> = (0..p.nodes.len())
                    .map(|n| s(g.run_cap(n, &states[n], c.now)))
                    .collect();
                json!({
                    "ctx": gctx_json(&c),
                    "states": states.iter().map(state_json).collect::<Vec<_>>(),
                    "due": due,
                    "runnable": runnable,
                    "run_cap": run_cap,
                })
            })
            .collect();
        let shares: Vec<Value> = if p.recipients.is_empty() {
            vec![]
        } else {
            [0u64, 1, 9_999, 10_000, 123_456_789, u64::MAX]
                .iter()
                .map(|&a| {
                    let sh = g.shares(a);
                    json!({ "amount": s(a), "shares": sh[..p.recipients.len()].iter().map(|x| s(*x)).collect::<Vec<_>>() })
                })
                .collect()
        };
        valid.push(json!({
            "name": v.name,
            "len": bytes.len(),
            "hex": hex(&bytes),
            "hash": hex(&graph_hash::<Sha2>(&bytes)),
            "conditions": conditions,
            "schedule": schedule,
            "shares": shares,
        }));
    }
    let invalid: Vec<Value> = graph_invalid()
        .iter()
        .map(|c| {
            assert_eq!(Graph::verify(&c.bytes).err(), Some(c.error), "{}", c.name);
            json!({ "name": c.name, "hex": hex(&c.bytes), "error": c.error.name() })
        })
        .collect();
    let mut epochs = Vec::new();
    let mut rng = Rng::new(99);
    for i in 0..30 {
        let len = rng.pick(&[0u32, 1, 3_600, 86_400, u32::MAX]);
        let st = NodeState {
            epoch_start: rng.pick(&[0i64, 1_000, -5, i64::MIN, i64::MAX, 1_800_000_000]),
            runs_in_epoch: 3,
            spent_in_epoch: 77,
            ..NodeState::default()
        };
        let now = match i % 3 {
            0 => st
                .epoch_start
                .saturating_add(len as i64)
                .saturating_add(rng.pick(&[-1i64, 0, 1])),
            _ => rng.pick(&[0i64, 999, 1_000, 4_600, i64::MIN, i64::MAX, 1_800_086_399]),
        };
        let e = current_epoch(len, &st, now);
        epochs.push(json!({
            "epoch_secs": len,
            "state": state_json(&st),
            "now": s(now),
            "epoch": { "start": s(e.start), "runs": e.runs, "spent": s(e.spent) },
        }));
    }
    json!({
        "format": "PXG1",
        "hash": "SHA256(\"PHX-GRAPH-V1\" || bytes)",
        "regenerate": PINNED_REGENERATE,
        "notes": "u64/i64/u128 values are decimal strings; bytes are hex. conditions: each node's condition value under ctx. schedule: due (trigger, run limit, budget) and runnable (due, then condition) per node, \"Due\" or the NotDue name, with ctx.runs_in_epoch derived from the states at ctx.now; run_cap per node. shares: DISTRIBUTE_SOL's floor split. epochs: current_epoch cases. An invalid entry fails verification with exactly the named error.",
        "valid": valid,
        "invalid": invalid,
        "epochs": epochs,
    })
}

/// JSON with one line per case: nesting up to depth 3 is indented, deeper
/// values are compact.
fn layout(v: &Value, depth: usize, out: &mut String) {
    let pad = |d: usize| "  ".repeat(d);
    match v {
        Value::Array(items) if depth < 4 && !items.is_empty() => {
            out.push_str("[\n");
            for (i, item) in items.iter().enumerate() {
                out.push_str(&pad(depth + 1));
                layout(item, depth + 1, out);
                out.push_str(if i + 1 < items.len() { ",\n" } else { "\n" });
            }
            out.push_str(&pad(depth));
            out.push(']');
        }
        Value::Object(map) if depth < 4 && !map.is_empty() => {
            out.push_str("{\n");
            for (i, (k, item)) in map.iter().enumerate() {
                out.push_str(&pad(depth + 1));
                out.push_str(&serde_json::to_string(k).unwrap());
                out.push_str(": ");
                layout(item, depth + 1, out);
                out.push_str(if i + 1 < map.len() { ",\n" } else { "\n" });
            }
            out.push_str(&pad(depth));
            out.push('}');
        }
        _ => out.push_str(&serde_json::to_string(v).unwrap()),
    }
}

fn check(file: &str, value: Value) {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/vectors")
        .join(file);
    if [REGEN, LEGACY_REGEN]
        .iter()
        .any(|k| std::env::var(k).is_ok_and(|v| v == "1"))
    {
        let mut text = String::new();
        layout(&value, 0, &mut text);
        text.push('\n');
        std::fs::write(&path, text).unwrap();
        return;
    }
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{}: {e}; generate it with {REGEN}=1", path.display()));
    let stored: Value = serde_json::from_str(&text).unwrap();
    assert!(
        stored == value,
        "{} is stale: regenerate with {REGEN}=1 cargo test -p noised-rules --test vectors, then review the diff",
        path.display()
    );
}

#[test]
fn rules_vectors_are_current() {
    let v = rules_vectors();
    assert!(v["valid"].as_array().unwrap().len() >= 40);
    assert!(v["invalid"].as_array().unwrap().len() >= 40);
    // Every PXR1 error has a vector.
    let named: Vec<&str> = v["invalid"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["error"].as_str().unwrap())
        .collect();
    for e in Error::ALL.iter().take(Error::LeftoverValues as usize + 1) {
        if *e != Error::BadNodeRef {
            assert!(named.contains(&e.name()), "no PXR1 vector for {e}");
        }
    }
    check("rules.json", v);
}

#[test]
fn graph_vectors_are_current() {
    let v = graph_vectors();
    assert!(v["valid"].as_array().unwrap().len() >= 40);
    assert!(v["invalid"].as_array().unwrap().len() >= 40);
    // Every PXG1 error has a vector.
    let named: Vec<&str> = v["invalid"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["error"].as_str().unwrap())
        .collect();
    let rules_only = [
        Error::TooManyKeys,
        Error::NoRules,
        Error::TooManyRules,
        Error::ZeroKey,
        Error::DuplicateKey,
        Error::UnusedKey,
        Error::BadWindow,
        Error::WindowPastGuard,
        Error::BadCode,
        Error::UnknownEffect,
        Error::DenyArgNonZero,
        Error::ZeroCap,
        Error::BadBps,
        Error::EmptyCondition,
        Error::BadKeyMask,
    ];
    for e in Error::ALL {
        if !rules_only.contains(e) {
            assert!(named.contains(&e.name()), "no PXG1 vector for {e}");
        }
    }
    check("graph.json", v);
}

#[test]
fn the_vectors_cover_every_trigger_and_outcome() {
    let v = graph_vectors();
    let text = v.to_string();
    for name in [
        "Due",
        "Waiting",
        "AwaitingParent",
        "NotGraduated",
        "AlreadyRan",
        "MaxRunsReached",
        "BudgetSpent",
        "ConditionFalse",
    ] {
        assert!(text.contains(&format!("\"{name}\"")), "{name}");
    }
    let triggers: Vec<u8> = graph_valid()
        .iter()
        .flat_map(|g| {
            g.program
                .nodes
                .iter()
                .map(|n: &GNode| n.trigger)
                .collect::<Vec<_>>()
        })
        .collect();
    for t in [
        trigger::EVERY,
        trigger::AFTER,
        trigger::ON_GRADUATED,
        trigger::WHEN,
    ] {
        assert!(triggers.contains(&t));
    }
}

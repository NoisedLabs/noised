//! Host unit tests for the pure parts of the program: the launchpad and
//! Meteora layouts it reads (pinned against their own types), the price
//! bounds (against an exact 256-bit reference), every decision in `logic`
//! (each guard at its edges) and the treasury invariants over random runs.

mod invariant_tests;
mod layout_tests;
mod logic_tests;
mod price_tests;
mod reference_tests;

use anchor_lang::prelude::*;
use noised_rules::{
    graph::{action, trigger, FLAG_HAS_OPERATOR},
    GNode, GraphProgram, Node, Recipient,
};

use crate::error::AutopilotError;

/// The program's results (an `AutopilotError` by default; the layout
/// readers that log compared keys return a `ProgramError`).
pub type Result<T, E = AutopilotError> = core::result::Result<T, E>;

pub fn key(b: u8) -> Pubkey {
    Pubkey::new_from_array([b; 32])
}

/// The error number of an error the program returns: an `AutopilotError`,
/// or a `ProgramError::Custom` (the Anchor error number); `None` for any
/// other `ProgramError`.
pub trait ErrorNumber: std::fmt::Debug {
    fn number(&self) -> Option<u32>;
}

impl ErrorNumber for AutopilotError {
    fn number(&self) -> Option<u32> {
        Some(u32::from(*self))
    }
}

impl ErrorNumber for crate::ProgramError {
    fn number(&self) -> Option<u32> {
        match self {
            crate::ProgramError::Custom(n) => Some(*n),
            _ => None,
        }
    }
}

/// The Anchor error number of `r`'s error (panics on success or a
/// non-Anchor error).
#[track_caller]
pub fn code<T: std::fmt::Debug>(r: Result<T, impl ErrorNumber>) -> u32 {
    match r {
        Ok(v) => panic!("expected an error, got Ok({v:?})"),
        Err(e) => e
            .number()
            .unwrap_or_else(|| panic!("not an Anchor error: {e:?}")),
    }
}

/// The Anchor error number of an autopilot error.
pub fn num(e: AutopilotError) -> u32 {
    u32::from(e)
}

#[track_caller]
pub fn assert_err<T: std::fmt::Debug>(r: Result<T, impl ErrorNumber>, e: AutopilotError) {
    assert_eq!(code(r), num(e), "expected {e:?}");
}

/// Deterministic pseudo-random stream for property checks.
pub struct Lcg(pub u64);

impl Lcg {
    pub fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        let x = self.0;
        // Mix the high bits down (the low bits of an LCG are weak).
        (x ^ (x >> 29)).wrapping_mul(0xBF58_476D_1CE4_E5B9) ^ (x >> 32)
    }

    pub fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }

    pub fn u128(&mut self) -> u128 {
        (u128::from(self.next()) << 64) | u128::from(self.next())
    }

    /// A value of at most `max_bits` significant bits, often at an edge
    /// (a power of two, all ones).
    pub fn bits128(&mut self, max_bits: u32) -> u128 {
        let bits = self.below(u64::from(max_bits) + 1) as u32;
        if bits == 0 {
            return 0;
        }
        match self.below(8) {
            0 => 1u128 << (bits - 1),
            1 => u128::MAX >> (128 - bits),
            _ => self.u128() >> (128 - bits),
        }
    }
}

/// A graph node with the usual defaults: no condition, keeper-run, a day
/// epoch, budget 10x the per-run cap, 10 runs per epoch.
pub fn gnode(trig: u8, trigger_arg: u64, act: u8, p1: u64, p2: u64) -> GNode {
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

pub fn every(secs: u64, act: u8, p1: u64, p2: u64) -> GNode {
    gnode(trigger::EVERY, secs, act, p1, p2)
}

/// Encode and verify.
#[track_caller]
pub fn encode(p: &GraphProgram) -> Vec<u8> {
    let bytes = p.encode().expect("counts");
    noised_rules::Graph::verify(&bytes).unwrap_or_else(|e| panic!("graph does not verify: {e:?}"));
    bytes
}

/// Recipients of the test graphs: 70% / 30%.
pub const RECIPIENTS: [([u8; 32], u16); 2] = [([0xA1; 32], 7_000), ([0xA2; 32], 3_000)];

/// A graph of `nodes` and `cond`, with the test recipients if some node
/// distributes and `operator` if given.
pub fn program(nodes: Vec<GNode>, cond: Vec<Node>, operator: Option<Pubkey>) -> GraphProgram {
    let distributes = nodes.iter().any(|n| n.action == action::DISTRIBUTE_SOL);
    GraphProgram {
        flags: if operator.is_some() {
            FLAG_HAS_OPERATOR
        } else {
            0
        },
        operator: operator.map_or([0; 32], |k| k.to_bytes()),
        recipients: if distributes {
            RECIPIENTS
                .iter()
                .map(|&(key, bps)| Recipient { key, bps })
                .collect()
        } else {
            vec![]
        },
        nodes,
        cond,
    }
}

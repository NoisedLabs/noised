//! Programmable launches for Noised: the two small byte formats creators
//! publish, and the code every Noised program and client uses to check and
//! run them.
//!
//! * **PXR1 launch rules** ([`rules`]): extra restrictions for the Launch
//!   Guard period (at most 72 hours), checked by the transfer hook after
//!   every built-in allow and denial. A rule can only reject a transfer, so
//!   rules can never make a sell, a claim or the batch fail, and after the
//!   guard ends they do nothing.
//! * **PXG1 autopilot graphs** ([`graph`]): post-launch automation (buy back
//!   and burn, burn, pay declared recipients), each node with a trigger, an
//!   optional condition, a budget per epoch and a per-run cap.
//!
//! Both formats share the condition mini-VM in [`vm`]: a postfix program of
//! 10-byte nodes over a boolean stack of at most 16 values, whose leaf
//! predicates depend on the context (rules or graph).
//!
//! Every verifier is total (it returns an [`Error`] for any input, never
//! panics) and checks a canonical form, so one meaning has one encoding
//! wherever the format allows it. Evaluation is a single pass with no
//! allocation and no recursion; after verification it cannot fail. The
//! evaluators stay total on unverified bytes too: a malformed condition
//! fails closed (the rule rejects, the graph node does not run).
//!
//! The crate is `no_std` and has no `unsafe` code. Panic freedom of the
//! library code is enforced by clippy lints (no indexing, no unchecked
//! arithmetic, no unwrap) and exercised by seeded property tests. SHA-256 is
//! a trait ([`Sha256`]): the `sol_sha256` syscall on-chain, any
//! implementation off-chain (feature `sha2-backend`). The owned programs and
//! encoders (`RulesProgram`, `GraphProgram`) need the `alloc` feature.
//!
//! The byte layouts, the order of the verifier's checks and the parity
//! vectors are documented in this crate's README.
#![no_std]
#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![cfg_attr(
    not(test),
    deny(
        clippy::indexing_slicing,
        clippy::arithmetic_side_effects,
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::unreachable,
        clippy::todo,
        clippy::unimplemented,
        clippy::cast_possible_truncation,
        clippy::cast_possible_wrap,
        clippy::cast_sign_loss
    )
)]

#[cfg(feature = "alloc")]
extern crate alloc;

pub mod graph;
#[cfg(feature = "alloc")]
mod owned;
pub mod rules;
pub mod vm;

#[cfg(feature = "alloc")]
pub use owned::{CountOverflow, GraphProgram, RulesProgram};

pub use graph::{
    after_acyclic, current_epoch, graph_hash, Epoch, GNode, Graph, GraphCtx, NodeState, NotDue,
    Recipient,
};
pub use rules::{rules_hash, Rule, RuleSet, TransferCtx, Violation};
pub use vm::{op, Node};

/// SHA-256 backend: the `sol_sha256` syscall on-chain, any SHA-256 off-chain.
pub trait Sha256 {
    /// SHA-256 of the concatenation of `parts`.
    fn hashv(parts: &[&[u8]]) -> [u8; 32];
}

/// SHA-256 on the `sha2` crate (feature `sha2-backend`).
#[cfg(feature = "sha2-backend")]
#[derive(Clone, Copy, Debug, Default)]
pub struct Sha2;

#[cfg(feature = "sha2-backend")]
impl Sha256 for Sha2 {
    fn hashv(parts: &[&[u8]]) -> [u8; 32] {
        use sha2::Digest;
        let mut h = sha2::Sha256::new();
        for p in parts {
            h.update(p);
        }
        h.finalize().into()
    }
}

/// Bit 63 of a cap or amount argument: the low 16 bits are basis points of
/// the mint's supply instead of an absolute amount.
pub const BPS_FLAG: u64 = 1 << 63;
/// Mask of the basis points in a [`BPS_FLAG`] argument.
pub const BPS_MASK: u64 = 0xFFFF;
/// 100% in basis points.
pub const BPS_DENOMINATOR: u64 = 10_000;

/// Whether `value` exceeds the threshold `arg` stands for: `arg` itself, or
/// with [`BPS_FLAG`] set, `floor(supply * bps / 10_000)` where
/// `bps = arg & 0xFFFF` (see [`threshold`]).
pub fn exceeds(value: u64, arg: u64, supply: u64) -> bool {
    value > threshold(arg, supply)
}

/// The threshold `arg` stands for: `arg`, or with [`BPS_FLAG`] set,
/// `floor(supply * bps / 10_000)` (`bps = arg & 0xFFFF`), saturating at
/// `u64::MAX` (only reachable with unverified bps above 10,000).
///
/// Computed in `u64` without overflow: with `supply = q * 10_000 + r`,
/// `floor(supply * bps / 10_000) = q * bps + floor(r * bps / 10_000)`, and
/// `q * bps <= q * 10_000 <= supply` for `bps <= 10_000`.
pub fn threshold(arg: u64, supply: u64) -> u64 {
    if arg & BPS_FLAG == 0 {
        return arg;
    }
    let bps = arg & BPS_MASK;
    let q = supply.checked_div(BPS_DENOMINATOR).unwrap_or(0);
    let r = supply.checked_rem(BPS_DENOMINATOR).unwrap_or(0);
    let low = r
        .saturating_mul(bps)
        .checked_div(BPS_DENOMINATOR)
        .unwrap_or(0);
    q.saturating_mul(bps).saturating_add(low)
}

/// Check a basis-point argument: bits 16..=62 clear and 1 <= bps <= 10,000.
pub(crate) fn check_bps_arg(arg: u64) -> Result<(), Error> {
    let bps = arg & BPS_MASK;
    if arg & !(BPS_FLAG | BPS_MASK) != 0 || bps == 0 || bps > BPS_DENOMINATOR {
        return Err(Error::BadBps);
    }
    Ok(())
}

/// `now < arg` for a signed clock and an unsigned bound (a negative `now`
/// is before every bound).
pub(crate) fn time_lt(now: i64, arg: u64) -> bool {
    match u64::try_from(now) {
        Ok(n) => n < arg,
        Err(_) => true,
    }
}

/// Split `count` fixed-size records off the front of `bytes`.
pub(crate) fn take<'a, const N: usize>(bytes: &mut &'a [u8], count: u8) -> Option<&'a [[u8; N]]> {
    let len = usize::from(count).checked_mul(N)?;
    let (head, tail) = bytes.split_at_checked(len)?;
    let (records, rest) = head.as_chunks::<N>();
    if !rest.is_empty() {
        return None;
    }
    *bytes = tail;
    Some(records)
}

/// Little-endian field reader over a fixed record; reads past the end yield
/// zeros (never happens for the fixed layouts here, but keeps it total).
pub(crate) struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    pub(crate) fn new(bytes: &'a [u8]) -> Self {
        Self(bytes)
    }

    pub(crate) fn array<const N: usize>(&mut self) -> [u8; N] {
        match self.0.split_first_chunk::<N>() {
            Some((head, tail)) => {
                self.0 = tail;
                *head
            }
            None => {
                self.0 = &[];
                [0; N]
            }
        }
    }

    pub(crate) fn u8(&mut self) -> u8 {
        let [b] = self.array::<1>();
        b
    }

    pub(crate) fn u16(&mut self) -> u16 {
        u16::from_le_bytes(self.array())
    }

    pub(crate) fn u32(&mut self) -> u32 {
        u32::from_le_bytes(self.array())
    }

    pub(crate) fn u64(&mut self) -> u64 {
        u64::from_le_bytes(self.array())
    }
}

macro_rules! named_enum {
    (
        $(#[$meta:meta])*
        pub enum $ty:ident {
            $( $(#[doc = $doc:literal])* $name:ident = $val:literal, )*
        }
    ) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
        #[repr(u8)]
        pub enum $ty {
            $( $(#[doc = $doc])* $name = $val, )*
        }

        impl $ty {
            /// Every variant, in discriminant order.
            pub const ALL: &'static [$ty] = &[$($ty::$name,)*];

            /// The variant's name: the parity contract with the SDK and the
            /// vectors in `tests/vectors`.
            pub const fn name(self) -> &'static str {
                match self {
                    $($ty::$name => stringify!($name),)*
                }
            }

            /// The variant with this name.
            pub fn from_name(name: &str) -> Option<Self> {
                Self::ALL.iter().copied().find(|v| v.name() == name)
            }
        }

        impl core::fmt::Display for $ty {
            fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
                f.write_str(self.name())
            }
        }
    };
}
pub(crate) use named_enum;

named_enum! {
    /// Why a PXR1 rule set or a PXG1 graph was refused. The verifiers check
    /// in a fixed order (README, "Verification order") and return the first
    /// failure, so every input maps to exactly one error.
    pub enum Error {
        /// Shorter than the fixed header.
        TooShort = 0,
        /// The first four bytes are not the format's magic.
        BadMagic = 1,
        /// Unknown format version.
        BadVersion = 2,
        /// A reserved byte is not zero.
        ReservedNonZero = 3,
        /// The length is not exactly the one the header's counts give.
        BadLength = 4,
        /// More condition nodes than the format allows.
        TooManyNodes = 5,
        /// PXR1: more than 8 keys.
        TooManyKeys = 6,
        /// PXR1: no rules.
        NoRules = 7,
        /// PXR1: more than 16 rules.
        TooManyRules = 8,
        /// PXR1: a key is all zeros.
        ZeroKey = 9,
        /// PXR1: a key appears twice.
        DuplicateKey = 10,
        /// PXR1: a key no condition refers to.
        UnusedKey = 11,
        /// PXR1: a rule's window is empty (`from_rel >= to_rel`).
        BadWindow = 12,
        /// PXR1: a rule's window ends after the launch guard (or after 72 h).
        WindowPastGuard = 13,
        /// PXR1: a rule's code is 64 or more.
        BadCode = 14,
        /// PXR1: unknown rule effect.
        UnknownEffect = 15,
        /// PXR1: a DENY rule has a non-zero argument.
        DenyArgNonZero = 16,
        /// PXR1: a cap of zero.
        ZeroCap = 17,
        /// A basis-point argument has stray bits or bps outside 1..=10,000.
        BadBps = 18,
        /// PXR1: a rule without a condition.
        EmptyCondition = 19,
        /// Conditions are not laid out back to back in rule (node) order.
        ConditionNotContiguous = 20,
        /// A condition runs past the last node.
        ConditionOutOfRange = 21,
        /// A condition node no rule (graph node) uses.
        UnreferencedNode = 22,
        /// An operation unknown in this context.
        UnknownOp = 23,
        /// An operand the operation does not use is not zero.
        NonZeroOperand = 24,
        /// PXR1: a key mask that is empty or names a missing key.
        BadKeyMask = 25,
        /// A time bound out of range.
        TimeOutOfRange = 26,
        /// PXG1: a condition refers to a graph node that does not exist.
        BadNodeRef = 27,
        /// An operation pops more values than the stack holds.
        StackUnderflow = 28,
        /// The stack would hold more than 16 values.
        StackOverflow = 29,
        /// A condition leaves more than one value.
        LeftoverValues = 30,
        /// PXG1: unknown flag bits.
        UnknownFlags = 31,
        /// PXG1: more than 8 recipients.
        TooManyRecipients = 32,
        /// PXG1: no graph nodes.
        NoGraphNodes = 33,
        /// PXG1: more than 16 graph nodes.
        TooManyGraphNodes = 34,
        /// PXG1: the operator flag is set but the operator key is zero.
        MissingOperator = 35,
        /// PXG1: an operator key without the operator flag.
        UnexpectedOperator = 36,
        /// PXG1: a recipient key is all zeros.
        ZeroRecipient = 37,
        /// PXG1: a recipient appears twice.
        DuplicateRecipient = 38,
        /// PXG1: a recipient with 0 bps.
        ZeroRecipientBps = 39,
        /// PXG1: recipients' bps do not sum to 10,000.
        BadRecipientBps = 40,
        /// PXG1: unknown trigger.
        UnknownTrigger = 41,
        /// PXG1: an EVERY period under 600 seconds.
        EveryTooShort = 42,
        /// PXG1: an AFTER trigger names a node that does not exist.
        BadAfterRef = 43,
        /// PXG1: AFTER triggers form a cycle (a node after itself included).
        AfterCycle = 44,
        /// PXG1: ON_GRADUATED or WHEN with a non-zero trigger argument.
        TriggerArgNonZero = 45,
        /// PXG1: a WHEN trigger without a condition.
        WhenWithoutCondition = 46,
        /// PXG1: unknown action.
        UnknownAction = 47,
        /// PXG1: an action reserved for a later version.
        ReservedAction = 48,
        /// PXG1: a per-run cap (`p1`) of zero.
        ZeroP1 = 49,
        /// PXG1: a buyback premium over the maximum.
        PremiumTooHigh = 50,
        /// PXG1: `p2` set for an action that does not use it.
        P2NonZero = 51,
        /// PXG1: DISTRIBUTE_SOL without recipients.
        NoRecipients = 52,
        /// PXG1: `operator_gated` is neither 0 nor 1.
        BadOperatorGated = 53,
        /// PXG1: an operator-gated node in a graph without an operator.
        GatedWithoutOperator = 54,
        /// PXG1: an epoch shorter than one hour.
        EpochTooShort = 55,
        /// PXG1: a budget per epoch of zero.
        ZeroBudget = 56,
        /// PXG1: `max_runs_per_epoch` of zero.
        ZeroMaxRuns = 57,
        /// PXG1: an operator but no operator-gated node.
        OperatorUnused = 58,
        /// PXG1: recipients but no DISTRIBUTE_SOL node.
        RecipientsUnused = 59,
    }
}

impl core::error::Error for Error {}

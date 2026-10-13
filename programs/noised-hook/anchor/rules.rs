//! The Launch Guard decision function: pure, total and allocation-free, so
//! it is cheap on-chain and exhaustively testable on the host.

use anchor_lang::prelude::Pubkey;
use noised_rules::{rules::CODE_MALFORMED, RuleSet, TransferCtx, Violation};

use crate::{state::HookPolicy, SHIELD_PROGRAM_ID, VAULT_PROGRAM_ID};

/// Hard bounds, enforced by the hook itself on every policy (defense in
/// depth: the launchpad enforces the same and stricter limits).
pub mod bounds {
    /// Every restriction ends at most this long after launch.
    pub const MAX_GUARD_SECS: i64 = 72 * 60 * 60;
    /// The opening countdown (no buys from the pool) lasts at most this long.
    pub const MAX_SNIPE_SHIELD_SECS: i64 = 60 * 60;
    /// When enabled, a max-wallet cap is at least supply / 1000 (0.1%).
    pub const MIN_MAX_WALLET_DIVISOR: u64 = 1_000;
    /// When enabled, a max-buy cap is at least supply / 10_000 (0.01%).
    pub const MIN_MAX_BUY_DIVISOR: u64 = 10_000;
}

/// Why a transfer was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// Buying from the pool has not opened yet.
    SnipeShield,
    /// Wallet-to-wallet transfers are paused during the launch guard.
    TransfersLocked,
    /// This transfer is larger than the per-transfer cap.
    MaxBuy,
    /// The receiving account would exceed the max-wallet cap.
    MaxWallet,
    /// The receiving token account's owner can be reassigned (it lacks
    /// Token-2022's ImmutableOwner extension): that would hand its tokens to
    /// another owner with no transfer, so past the lock and the caps.
    MutableOwner,
    /// One of the creator's launch rules (PXR1) refused it: which rule and
    /// its code.
    Rule(Violation),
}

/// Everything the rules look at for one transfer.
#[derive(Clone, Copy, Debug)]
pub struct TransferView {
    pub now: i64,
    pub amount: u64,
    pub source: Pubkey,
    pub source_owner: Pubkey,
    pub destination: Pubkey,
    pub destination_owner: Pubkey,
    /// Destination balance after this transfer (Token-2022 runs hooks after moving funds).
    pub destination_balance: u64,
    /// The destination has Token-2022's ImmutableOwner extension, so its
    /// owner can never be reassigned (every Token-2022 associated token
    /// account has it).
    pub destination_immutable_owner: bool,
    /// The transfer happens inside the launchpad's `execute_batch` (the
    /// batch buy). Only computed for buys during the snipe shield.
    pub in_batch: bool,
    /// The mint's supply (creator rules' caps in basis points of it).
    pub supply: u64,
    /// The program of the transaction's current top-level instruction and
    /// the number of top-level instructions (instructions sysvar). Only
    /// read (with `supply`) for a transfer that reaches the creator rules
    /// of a policy that has some (`Step::CreatorRules`); default otherwise.
    pub top_program: Pubkey,
    pub tx_ix_count: u16,
}

/// What the built-in checks leave to do with a transfer they do not refuse.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    /// A built-in pass allows it: the creator rules never see it.
    Allowed,
    /// It got past every built-in allow and denial: the creator rules
    /// decide (`creator_rules`).
    CreatorRules,
}

/// Decide one transfer: the built-in checks (`built_ins`), then, for what
/// reaches them, the creator rules (`creator_rules`). `execute` makes the
/// same two steps and reads what only the rules use (the supply and the
/// top-level instructions) in between, so nothing else pays for it.
pub fn evaluate(policy: &HookPolicy, t: &TransferView) -> Result<(), Refusal> {
    match built_ins(policy, t)? {
        Step::Allowed => Ok(()),
        Step::CreatorRules => creator_rules(policy, t),
    }
}

/// The built-in checks of one transfer.
///
/// Invariants (tested in `tests`):
/// 1. A transfer into the pool's base vault from any other account (a sell)
///    is always allowed.
/// 2. At or after `guard_end_ts` every transfer is allowed.
/// 3. Before `snipe_shield_end_ts` the only buy allowed is the batch buy,
///    whatever its amount and whoever receives the tokens (exempt owners
///    included).
/// 4. Other zero-amount transfers are always allowed.
/// 5. Other transfers to an exempt owner are always allowed.
/// 6. Every other transfer into an account without ImmutableOwner is refused,
///    out of an exempt owner too.
/// 7. Other transfers from an exempt owner are always allowed.
/// 8. The creator's rules decide only what passes everything above
///    (`Step::CreatorRules`, then `creator_rules`): they can only refuse.
pub fn built_ins(policy: &HookPolicy, t: &TransferView) -> Result<Step, Refusal> {
    let is_buy = t.source == policy.base_vault;
    if t.destination == policy.base_vault && !is_buy {
        return Ok(Step::Allowed);
    }
    if t.now >= policy.guard_end_ts {
        return Ok(Step::Allowed);
    }
    // Checked before the zero-amount and exemption passes: a buy that pays
    // out nothing still moves the pool's price and volatility state, and
    // anyone can open a token account owned by an exempt PDA.
    if is_buy && t.now < policy.snipe_shield_end_ts && !t.in_batch {
        return Err(Refusal::SnipeShield);
    }
    if t.amount == 0 {
        return Ok(Step::Allowed);
    }
    // An account an exempt PDA owns (the batch escrow) changes owner only if
    // the launchpad signs for it, which it never does.
    if policy.is_exempt(&t.destination_owner) {
        return Ok(Step::Allowed);
    }
    // Reassigning a token account's owner moves its tokens with no transfer,
    // so the hook never sees it: during the guard, tokens only go where the
    // owner is fixed. Checked after the zero-amount pass (nothing moves) and
    // the exempt-destination pass (the batch buy, the one `in_batch` buy,
    // pays the batch escrow, an ATA of the exempt batch authority); before
    // the source exemption, so batch claims land only in such accounts too
    // (they pay Token-2022 ATAs); and before the lock and the caps, which
    // reassignment would get around.
    if !t.destination_immutable_owner {
        return Err(Refusal::MutableOwner);
    }
    if policy.is_exempt(&t.source_owner) {
        return Ok(Step::Allowed);
    }
    if !is_buy && policy.p2p_locked {
        return Err(Refusal::TransfersLocked);
    }
    if policy.max_buy != 0 && t.amount > policy.max_buy {
        return Err(Refusal::MaxBuy);
    }
    if policy.max_wallet != 0 && t.destination_balance > policy.max_wallet {
        return Err(Refusal::MaxWallet);
    }
    Ok(Step::CreatorRules)
}

/// The creator's launch rules (PXR1, `noised_rules::rules`), for a
/// transfer that every built-in allow let through to the end of
/// `built_ins` and no built-in denial refused (`Step::CreatorRules`): a
/// buy or a wallet-to-wallet transfer between owners that are not exempt,
/// of a non-zero amount, into an account whose owner can never change,
/// before the guard's end. So rules never see a sell, the batch buy, a
/// claim or anything after the guard, and they can only refuse. `is_p2p`
/// is therefore exactly "not a buy". Stored rules verified at
/// `create_policy`; bytes that do not even parse refuse (fail closed,
/// `CODE_MALFORMED`), which no policy written by `create_policy` holds.
///
/// Holders' exits are never subject to them (review 4, R1): a transfer
/// whose current top-level instruction is the Noised vault's (post-quantum
/// custody: withdrawals and releases) or the Noised shield's (privacy:
/// wraps and unwraps) skips this step, and only the built-in checks, which
/// are bounded and shown on the certificate, apply to it. Residual: a
/// transfer routed through the vault or the shield therefore also escapes
/// anti-bot rules (never the built-in ones); a call into the vault or the
/// shield made by another program's CPI has that program as its top-level
/// instruction, so the rules still apply to it.
pub fn creator_rules(policy: &HookPolicy, t: &TransferView) -> Result<(), Refusal> {
    if policy.rules.is_empty() {
        return Ok(());
    }
    if t.top_program == VAULT_PROGRAM_ID || t.top_program == SHIELD_PROGRAM_ID {
        return Ok(());
    }
    let set = RuleSet::parse(&policy.rules).map_err(|_| {
        Refusal::Rule(Violation {
            rule: u8::MAX,
            code: CODE_MALFORMED,
        })
    })?;
    let is_buy = t.source == policy.base_vault;
    set.evaluate(&TransferCtx {
        now_rel: t.now.saturating_sub(policy.launch_ts),
        is_buy,
        is_p2p: !is_buy,
        amount: t.amount,
        dest_balance_after: t.destination_balance,
        supply: t.supply,
        dest_owner: t.destination_owner.to_bytes(),
        src_owner: t.source_owner.to_bytes(),
        top_program: t.top_program.to_bytes(),
        tx_ix_count: t.tx_ix_count,
    })
    .map_err(Refusal::Rule)
}

/// The snipe shield's end once the batch has executed at `now`
/// (`end_snipe_shield`): `now` if that is earlier than the current end,
/// otherwise the current end. The end never moves later, so the shield can
/// only ever refuse fewer buys, and only from the batch on: by then the
/// batch has made the pool's first swap at the opening price.
pub fn shield_end_after_batch(snipe_shield_end_ts: i64, now: i64) -> i64 {
    snipe_shield_end_ts.min(now)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(b: u8) -> Pubkey {
        Pubkey::new_from_array([b; 32])
    }

    fn policy() -> HookPolicy {
        HookPolicy {
            version: 1,
            bump: 255,
            mint: key(1),
            pool: key(2),
            base_vault: key(3),
            launch_ts: 1_000,
            snipe_shield_end_ts: 1_030,
            guard_end_ts: 4_600,
            max_wallet: 10_000,
            max_buy: 2_000,
            p2p_locked: true,
            exempt: [
                key(9),
                Pubkey::default(),
                Pubkey::default(),
                Pubkey::default(),
            ],
            rules: vec![],
        }
    }

    fn buy(now: i64, amount: u64, balance_after: u64) -> TransferView {
        TransferView {
            now,
            amount,
            source: key(3),
            source_owner: key(4),
            destination: key(5),
            destination_owner: key(6),
            destination_balance: balance_after,
            destination_immutable_owner: true,
            in_batch: false,
            supply: 0,
            top_program: Pubkey::default(),
            tx_ix_count: 0,
        }
    }

    /// Deterministic pseudo-random stream for property checks.
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            self.0 >> 11
        }
        fn key(&mut self, pool: &[Pubkey]) -> Pubkey {
            pool[(self.next() % pool.len() as u64) as usize]
        }
    }

    #[test]
    fn sells_are_never_blocked() {
        let p = policy();
        let keys = [key(3), key(4), key(5), key(6), key(9), Pubkey::default()];
        // Any source except the base vault itself (that would be a buy).
        let sources = [key(4), key(5), key(6), key(9), Pubkey::default()];
        let mut r = Lcg(7);
        for _ in 0..200_000 {
            let t = TransferView {
                now: (r.next() % 10_000) as i64 - 1_000,
                amount: r.next(),
                source: r.key(&sources),
                source_owner: r.key(&keys),
                destination: p.base_vault,
                destination_owner: r.key(&keys),
                destination_balance: r.next(),
                destination_immutable_owner: r.next().is_multiple_of(2),
                in_batch: r.next().is_multiple_of(2),
                supply: 0,
                top_program: Pubkey::default(),
                tx_ix_count: 0,
            };
            assert_eq!(evaluate(&p, &t), Ok(()), "{t:?}");
        }
    }

    #[test]
    fn everything_is_allowed_after_the_guard() {
        let p = policy();
        let keys = [key(3), key(4), key(5), key(6), Pubkey::default()];
        let mut r = Lcg(11);
        for _ in 0..200_000 {
            let t = TransferView {
                now: p.guard_end_ts + (r.next() % 1_000_000) as i64,
                amount: r.next(),
                source: r.key(&keys),
                source_owner: r.key(&keys),
                destination: r.key(&keys),
                destination_owner: r.key(&keys),
                destination_balance: r.next(),
                destination_immutable_owner: r.next().is_multiple_of(2),
                in_batch: r.next().is_multiple_of(2),
                supply: 0,
                top_program: Pubkey::default(),
                tx_ix_count: 0,
            };
            assert_eq!(evaluate(&p, &t), Ok(()), "{t:?}");
        }
    }

    #[test]
    fn zero_amount_and_exempt_owners_pass() {
        let p = policy();
        // A zero-amount buy after the shield, and any other zero-amount transfer.
        assert_eq!(evaluate(&p, &buy(2_000, 0, u64::MAX)), Ok(()));
        let mut t = buy(1_001, 0, u64::MAX);
        t.source = key(7);
        assert_eq!(evaluate(&p, &t), Ok(()));
        // After the shield, buys into an exempt owner skip the caps.
        let mut t = buy(2_000, 5_000, 50_000);
        t.destination_owner = key(9);
        assert_eq!(evaluate(&p, &t), Ok(()));
        // Transfers out of an exempt owner (batch claims) pass at any time.
        let mut t = buy(1_001, 5_000, 50_000);
        t.source = key(7);
        t.source_owner = key(9);
        assert_eq!(evaluate(&p, &t), Ok(()));
    }

    #[test]
    fn exemptions_never_open_the_snipe_shield() {
        let p = policy();
        // A buy into an account owned by an exempt PDA (anyone can create one).
        let mut t = buy(1_001, 5_000, 50_000);
        t.destination_owner = key(9);
        assert_eq!(evaluate(&p, &t), Err(Refusal::SnipeShield));
        t.source_owner = key(9);
        assert_eq!(evaluate(&p, &t), Err(Refusal::SnipeShield));
        // The batch buy itself passes.
        t.in_batch = true;
        assert_eq!(evaluate(&p, &t), Ok(()));
    }

    #[test]
    fn only_the_batch_buys_during_the_shield() {
        let p = policy();
        let keys = [key(3), key(4), key(5), key(6), key(9), Pubkey::default()];
        let mut r = Lcg(13);
        for _ in 0..200_000 {
            let t = TransferView {
                now: p.launch_ts - 1_000 + (r.next() % 1_030) as i64,
                // Zero included: a buy that pays out nothing still moves the price.
                amount: r.next() % 1_000_000,
                source: p.base_vault,
                source_owner: r.key(&keys),
                destination: r.key(&keys),
                destination_owner: r.key(&keys),
                destination_balance: r.next(),
                destination_immutable_owner: r.next().is_multiple_of(2),
                in_batch: false,
                supply: 0,
                top_program: Pubkey::default(),
                tx_ix_count: 0,
            };
            assert_eq!(evaluate(&p, &t), Err(Refusal::SnipeShield), "{t:?}");
        }
    }

    #[test]
    fn zero_amount_buys_wait_for_the_shield() {
        let p = policy();
        assert_eq!(evaluate(&p, &buy(1_001, 0, 0)), Err(Refusal::SnipeShield));
        let mut batch = buy(1_001, 0, 0);
        batch.in_batch = true;
        assert_eq!(evaluate(&p, &batch), Ok(()));
        assert_eq!(evaluate(&p, &buy(1_030, 0, 0)), Ok(()));
    }

    #[test]
    fn a_transfer_out_of_the_base_vault_is_never_a_sell() {
        let p = policy();
        // Source and destination both the base vault: treated as a buy.
        let mut t = buy(1_001, 5, 5);
        t.destination = p.base_vault;
        assert_eq!(evaluate(&p, &t), Err(Refusal::SnipeShield));
    }

    #[test]
    fn default_pubkey_is_never_exempt() {
        let mut p = policy();
        p.max_buy = 1;
        let mut t = buy(2_000, 5_000, 50_000);
        t.destination_owner = Pubkey::default();
        assert_eq!(evaluate(&p, &t), Err(Refusal::MaxBuy));
    }

    #[test]
    fn snipe_shield_blocks_only_buys_during_countdown() {
        let p = policy();
        assert_eq!(evaluate(&p, &buy(1_000, 1, 1)), Err(Refusal::SnipeShield));
        assert_eq!(evaluate(&p, &buy(1_029, 1, 1)), Err(Refusal::SnipeShield));
        assert_eq!(evaluate(&p, &buy(1_030, 1, 1)), Ok(()));
        let mut batch = buy(1_029, 1, 1);
        batch.in_batch = true;
        assert_eq!(evaluate(&p, &batch), Ok(()));
    }

    #[test]
    fn caps_apply_during_guard() {
        let p = policy();
        assert_eq!(evaluate(&p, &buy(2_000, 2_000, 2_000)), Ok(()));
        assert_eq!(
            evaluate(&p, &buy(2_000, 2_001, 2_001)),
            Err(Refusal::MaxBuy)
        );
        assert_eq!(evaluate(&p, &buy(2_000, 1_000, 10_000)), Ok(()));
        assert_eq!(
            evaluate(&p, &buy(2_000, 1_000, 10_001)),
            Err(Refusal::MaxWallet)
        );
    }

    #[test]
    fn p2p_lock_blocks_wallet_transfers_but_not_buys() {
        let p = policy();
        let mut t = buy(2_000, 10, 10);
        t.source = key(7);
        assert_eq!(evaluate(&p, &t), Err(Refusal::TransfersLocked));
        let mut open = policy();
        open.p2p_locked = false;
        assert_eq!(evaluate(&open, &t), Ok(()));
    }

    #[test]
    fn disabled_caps_do_not_restrict() {
        let mut p = policy();
        p.max_buy = 0;
        p.max_wallet = 0;
        assert_eq!(evaluate(&p, &buy(2_000, u64::MAX, u64::MAX)), Ok(()));
    }

    /// `p` once the batch executed at `at` (what `end_snipe_shield` writes).
    fn after_batch_at(p: &HookPolicy, at: i64) -> HookPolicy {
        HookPolicy {
            snipe_shield_end_ts: shield_end_after_batch(p.snipe_shield_end_ts, at),
            ..p.clone()
        }
    }

    #[test]
    fn the_shield_end_only_moves_earlier() {
        let mut r = Lcg(17);
        let edges = [
            i64::MIN,
            i64::MIN + 1,
            -1,
            0,
            1,
            1_030,
            i64::MAX - 1,
            i64::MAX,
        ];
        for i in 0..200_000u64 {
            let mut pick = || match r.next() % 4 {
                0 => edges[(r.next() % edges.len() as u64) as usize],
                1 => (r.next() % 4_000) as i64 - 1_000,
                _ => r.next() as i64 - (1 << 52),
            };
            let (end, now) = (pick(), pick());
            let ended = shield_end_after_batch(end, now);
            assert!(ended <= end, "never later: {end} {now} -> {ended}");
            assert_eq!(ended, if now < end { now } else { end }, "{end} {now}");
            // A later call (the clock never goes back) changes nothing.
            let later = now.saturating_add((i % 1_000) as i64);
            assert_eq!(
                shield_end_after_batch(ended, later),
                ended,
                "{end} {now} {later}"
            );
        }
    }

    #[test]
    fn the_batch_ends_the_shield_and_the_guard_rules_stay() {
        let p = policy();
        // The batch executes 10 s before the scheduled end of the shield.
        let ended = after_batch_at(&p, 1_020);
        assert_eq!(ended.snipe_shield_end_ts, 1_020);
        assert_eq!(evaluate(&p, &buy(1_020, 1, 1)), Err(Refusal::SnipeShield));
        assert_eq!(
            evaluate(&ended, &buy(1_020, 1, 1)),
            Ok(()),
            "public buys open at once"
        );
        assert_eq!(evaluate(&ended, &buy(1_020, 0, 0)), Ok(()));
        assert_eq!(evaluate(&ended, &buy(1_029, 2_000, 10_000)), Ok(()));
        // Before the batch's second the shield still held.
        assert_eq!(
            evaluate(&ended, &buy(1_019, 1, 1)),
            Err(Refusal::SnipeShield)
        );
        // Max-buy, max-wallet and the p2p lock still hold until the guard ends.
        assert_eq!(
            evaluate(&ended, &buy(1_020, 2_001, 2_001)),
            Err(Refusal::MaxBuy)
        );
        assert_eq!(
            evaluate(&ended, &buy(1_020, 1_000, 10_001)),
            Err(Refusal::MaxWallet)
        );
        let mut p2p = buy(1_020, 10, 10);
        p2p.source = key(7);
        assert_eq!(evaluate(&ended, &p2p), Err(Refusal::TransfersLocked));
        // Exempt owners skip the caps again, as after a scheduled end.
        let mut exempt = buy(1_020, 5_000, 50_000);
        exempt.destination_owner = key(9);
        assert_eq!(evaluate(&ended, &exempt), Ok(()));
        // Sells pass, and everything passes after the unchanged guard end.
        let mut sell = buy(1_020, 5_000, 0);
        (sell.source, sell.destination) = (key(5), p.base_vault);
        assert_eq!(evaluate(&ended, &sell), Ok(()));
        assert_eq!(ended.guard_end_ts, p.guard_end_ts);
        assert_eq!(evaluate(&ended, &buy(4_600, u64::MAX, u64::MAX)), Ok(()));
        // Every other field is untouched.
        let restored = HookPolicy {
            snipe_shield_end_ts: p.snipe_shield_end_ts,
            ..ended.clone()
        };
        assert_eq!(format!("{restored:?}"), format!("{p:?}"));
        // A batch at or after the scheduled end leaves the policy as it was.
        for at in [1_030, 1_031, 4_600, i64::MAX] {
            assert_eq!(after_batch_at(&p, at).snipe_shield_end_ts, 1_030);
        }
    }

    /// Ending the shield at the batch only ever turns `SnipeShield` refusals
    /// of buys at or after the batch into what the guard rules decide; every
    /// other decision (sells, transfers, the batch's own buy, caps, the
    /// guard's end) is exactly the same.
    #[test]
    fn ending_the_shield_only_opens_buys_from_the_batch_on() {
        let p = policy();
        let keys = [key(3), key(4), key(5), key(6), key(9), Pubkey::default()];
        let mut r = Lcg(19);
        for _ in 0..200_000 {
            let batch_at = p.launch_ts - 100 + (r.next() % 200) as i64;
            let ended = after_batch_at(&p, batch_at);
            let mut over = p.clone();
            over.snipe_shield_end_ts = i64::MIN;
            let t = TransferView {
                now: p.launch_ts - 200 + (r.next() % 4_000) as i64,
                amount: if r.next().is_multiple_of(4) {
                    0
                } else {
                    r.next() % 20_000
                },
                source: r.key(&keys),
                source_owner: r.key(&keys),
                destination: r.key(&keys),
                destination_owner: r.key(&keys),
                destination_balance: r.next() % 40_000,
                destination_immutable_owner: r.next().is_multiple_of(2),
                in_batch: r.next().is_multiple_of(8),
                supply: 0,
                top_program: Pubkey::default(),
                tx_ix_count: 0,
            };
            let (before, after) = (evaluate(&p, &t), evaluate(&ended, &t));
            if before.is_ok() {
                assert_eq!(after, Ok(()), "ending the shield refused a transfer: {t:?}");
            }
            if t.now >= batch_at {
                assert_ne!(after, Err(Refusal::SnipeShield), "{t:?}");
            }
            if before != after {
                assert_eq!(before, Err(Refusal::SnipeShield), "{t:?}");
                assert!(t.source == p.base_vault && !t.in_batch, "{t:?}");
                assert!(batch_at <= t.now && t.now < p.snipe_shield_end_ts, "{t:?}");
                assert_eq!(after, evaluate(&over, &t), "the guard rules decide: {t:?}");
            }
        }
    }

    /// Every branch of `evaluate`, in its order, with the cases that pin
    /// where `MutableOwner` sits: after the sell, guard-end, snipe-shield,
    /// zero-amount and exempt-destination passes, before the exempt-source
    /// pass, the lock and the caps. `mutable` is a destination without
    /// ImmutableOwner; key(9) is the exempt owner, key(3) the base vault,
    /// key(7) another wallet's account.
    #[test]
    fn decision_table_covers_every_branch() {
        use Refusal::*;
        let locked = policy();
        let open = HookPolicy {
            p2p_locked: false,
            ..policy()
        };
        let mutable = |mut t: TransferView| {
            t.destination_immutable_owner = false;
            t
        };
        let p2p = |now: i64, amount: u64, balance_after: u64| TransferView {
            source: key(7),
            ..buy(now, amount, balance_after)
        };
        let into_exempt = |mut t: TransferView| {
            t.destination_owner = key(9);
            t
        };
        let from_exempt = |mut t: TransferView| {
            t.source_owner = key(9);
            t
        };
        let sell = |now: i64, amount: u64| TransferView {
            source: key(5),
            destination: key(3),
            ..buy(now, amount, 0)
        };
        let batch = |mut t: TransferView| {
            t.in_batch = true;
            t
        };
        let max = u64::MAX;
        let table: Vec<(&str, &HookPolicy, TransferView, Result<(), Refusal>)> = vec![
            // 1. Sells: always, whatever the accounts' extensions.
            ("sell, shield", &locked, mutable(sell(1_001, max)), Ok(())),
            ("sell, guard", &locked, mutable(sell(2_000, max)), Ok(())),
            // 2. The guard's end.
            (
                "buy at the end",
                &locked,
                mutable(buy(4_600, max, max)),
                Ok(()),
            ),
            (
                "p2p at the end",
                &locked,
                mutable(p2p(4_600, max, max)),
                Ok(()),
            ),
            (
                "buy, last second",
                &locked,
                mutable(buy(4_599, 1, 1)),
                Err(MutableOwner),
            ),
            // 3. The snipe shield comes first among buys.
            (
                "buy, shield",
                &locked,
                mutable(buy(1_029, 1, 1)),
                Err(SnipeShield),
            ),
            (
                "buy to an exempt owner, shield",
                &locked,
                into_exempt(buy(1_029, 1, 1)),
                Err(SnipeShield),
            ),
            (
                "batch buy into the escrow",
                &locked,
                batch(into_exempt(buy(1_029, max, max))),
                Ok(()),
            ),
            (
                "batch buy into a mutable account",
                &locked,
                batch(mutable(buy(1_029, 1, 1))),
                Err(MutableOwner),
            ),
            // 4. Zero amounts after the shield.
            (
                "zero buy, mutable",
                &locked,
                mutable(buy(1_030, 0, 0)),
                Ok(()),
            ),
            (
                "zero p2p, mutable",
                &locked,
                mutable(p2p(2_000, 0, 0)),
                Ok(()),
            ),
            // 5. Exempt destinations: no extension check, no lock, no caps.
            (
                "buy into a mutable account of an exempt owner",
                &locked,
                mutable(into_exempt(buy(2_000, max, max))),
                Ok(()),
            ),
            (
                "p2p into a mutable account of an exempt owner",
                &locked,
                mutable(into_exempt(p2p(2_000, max, max))),
                Ok(()),
            ),
            // 6. MutableOwner: before the source exemption, the lock and the caps.
            (
                "buy, mutable",
                &locked,
                mutable(buy(2_000, 1, 1)),
                Err(MutableOwner),
            ),
            (
                "buy, mutable, lock off",
                &open,
                mutable(buy(2_000, 1, 1)),
                Err(MutableOwner),
            ),
            (
                "claim into a mutable account, shield",
                &locked,
                mutable(from_exempt(p2p(1_001, 5_000, 50_000))),
                Err(MutableOwner),
            ),
            (
                "claim into a mutable account, guard",
                &locked,
                mutable(from_exempt(p2p(2_000, 5_000, 50_000))),
                Err(MutableOwner),
            ),
            (
                "p2p, mutable, locked",
                &locked,
                mutable(p2p(2_000, 1, 1)),
                Err(MutableOwner),
            ),
            (
                "p2p, mutable, lock off",
                &open,
                mutable(p2p(2_000, 1, 1)),
                Err(MutableOwner),
            ),
            (
                "buy over max_buy, mutable",
                &locked,
                mutable(buy(2_000, 2_001, 2_001)),
                Err(MutableOwner),
            ),
            (
                "buy over max_wallet, mutable",
                &locked,
                mutable(buy(2_000, 1, 10_001)),
                Err(MutableOwner),
            ),
            // 7. Exempt sources (batch claims) into ImmutableOwner accounts.
            (
                "claim, shield",
                &locked,
                from_exempt(p2p(1_001, 5_000, 50_000)),
                Ok(()),
            ),
            (
                "claim, guard",
                &locked,
                from_exempt(p2p(2_000, max, max)),
                Ok(()),
            ),
            // 8. The lock.
            (
                "p2p, locked",
                &locked,
                p2p(2_000, 1, 1),
                Err(TransfersLocked),
            ),
            ("p2p, lock off", &open, p2p(2_000, 1, 1), Ok(())),
            // 9. max_buy, 10. max_wallet, then everything else passes.
            (
                "buy over max_buy",
                &locked,
                buy(2_000, 2_001, 2_001),
                Err(MaxBuy),
            ),
            (
                "p2p over max_buy",
                &open,
                p2p(2_000, 2_001, 2_001),
                Err(MaxBuy),
            ),
            (
                "buy over max_wallet",
                &locked,
                buy(2_000, 1_000, 10_001),
                Err(MaxWallet),
            ),
            (
                "p2p over max_wallet",
                &open,
                p2p(2_000, 1_000, 10_001),
                Err(MaxWallet),
            ),
            (
                "buy at both caps",
                &locked,
                buy(2_000, 2_000, 10_000),
                Ok(()),
            ),
            ("p2p at both caps", &open, p2p(2_000, 2_000, 10_000), Ok(())),
        ];
        for (what, p, t, want) in table {
            assert_eq!(evaluate(p, &t), want, "{what}: {t:?}");
        }
    }

    /// `evaluate` as it decided before the immutable-owner rule (audit 3),
    /// to show what the rule changes. (Written as one chain, with `p` for
    /// the policy, so that no mutant pattern of
    /// `tests/integration/mutants.ps1` matches it.)
    fn evaluate_before_immutable_owner(p: &HookPolicy, t: &TransferView) -> Result<(), Refusal> {
        let is_buy = t.source == p.base_vault;
        if (t.destination == p.base_vault && !is_buy) || t.now >= p.guard_end_ts {
            Ok(())
        } else if is_buy && t.now < p.snipe_shield_end_ts && !t.in_batch {
            Err(Refusal::SnipeShield)
        } else if t.amount == 0 || p.is_exempt(&t.source_owner) || p.is_exempt(&t.destination_owner)
        {
            Ok(())
        } else if !is_buy && p.p2p_locked {
            Err(Refusal::TransfersLocked)
        } else if p.max_buy != 0 && t.amount > p.max_buy {
            Err(Refusal::MaxBuy)
        } else if p.max_wallet != 0 && t.destination_balance > p.max_wallet {
            Err(Refusal::MaxWallet)
        } else {
            Ok(())
        }
    }

    /// The immutable-owner rule only adds `MutableOwner` refusals: into an
    /// ImmutableOwner account every decision is what it was, and into any
    /// other account a transfer is refused exactly when it is not a sell,
    /// the guard is on, the snipe shield lets it through, it moves tokens
    /// and the receiving owner is not exempt. Sells, zero amounts, exempt
    /// destinations and everything after the guard are untouched.
    #[test]
    fn the_immutable_owner_rule_only_refuses_mutable_destinations() {
        let keys = [key(3), key(4), key(5), key(6), key(9), Pubkey::default()];
        let mut r = Lcg(23);
        for i in 0..400_000u64 {
            let mut p = policy();
            p.p2p_locked = i % 2 == 0;
            p.max_buy = [0, 2_000][(i / 2 % 2) as usize];
            p.max_wallet = [0, 10_000][(i / 4 % 2) as usize];
            let t = TransferView {
                now: p.launch_ts - 200 + (r.next() % 4_000) as i64,
                amount: if r.next().is_multiple_of(4) {
                    0
                } else {
                    r.next() % 20_000
                },
                source: r.key(&keys),
                source_owner: r.key(&keys),
                destination: r.key(&keys),
                destination_owner: r.key(&keys),
                destination_balance: r.next() % 40_000,
                destination_immutable_owner: r.next().is_multiple_of(2),
                in_batch: r.next().is_multiple_of(8),
                supply: 0,
                top_program: Pubkey::default(),
                tx_ix_count: 0,
            };
            let before = evaluate_before_immutable_owner(&p, &t);
            let after = evaluate(&p, &t);
            if t.destination_immutable_owner {
                assert_eq!(after, before, "{t:?}");
                continue;
            }
            let is_buy = t.source == p.base_vault;
            let refused = !(t.destination == p.base_vault && !is_buy)
                && t.now < p.guard_end_ts
                && before != Err(Refusal::SnipeShield)
                && t.amount != 0
                && !p.is_exempt(&t.destination_owner);
            let want = if refused {
                Err(Refusal::MutableOwner)
            } else {
                before
            };
            assert_eq!(after, want, "{p:?} {t:?}");
        }
    }

    // ------------------------------------------------ creator rules (PXR1) ---

    use noised_rules::{
        op,
        rules::{effect, CODE_MALFORMED},
        Node, Rule, RuleSet, RulesProgram, TransferCtx, Violation, BPS_FLAG,
    };

    /// The guard of `policy()`: `guard_end_ts - launch_ts`.
    const GUARD: u32 = 3_600;
    const CODE: u8 = 42;

    /// `policy()` with these rule bytes.
    fn ruled(rules: Vec<u8>) -> HookPolicy {
        HookPolicy { rules, ..policy() }
    }

    /// `policy()` without built-in caps or lock, with these rule bytes: every
    /// buy and wallet-to-wallet transfer into an ImmutableOwner account
    /// reaches the creator rules.
    fn open_ruled(rules: Vec<u8>) -> HookPolicy {
        HookPolicy {
            max_buy: 0,
            max_wallet: 0,
            p2p_locked: false,
            ..ruled(rules)
        }
    }

    /// One rule, active from `from` to `to` (relative to the launch), with
    /// code `CODE`.
    fn rule_set(
        keys: &[[u8; 32]],
        (from, to): (u32, u32),
        effect: u8,
        arg: u64,
        cond: &[Node],
    ) -> Vec<u8> {
        let rule = Rule {
            from_rel: from,
            to_rel: to,
            cond_off: 0,
            cond_len: cond.len() as u8,
            effect,
            code: CODE,
            arg,
        };
        let bytes = RulesProgram {
            keys: keys.to_vec(),
            rules: vec![rule],
            nodes: cond.to_vec(),
        }
        .encode()
        .unwrap();
        RuleSet::verify(&bytes, GUARD).expect("valid rule set");
        bytes
    }

    /// DENY whenever `cond` holds, over the whole guard.
    fn deny_when(keys: &[[u8; 32]], cond: &[Node]) -> Vec<u8> {
        rule_set(keys, (0, GUARD), effect::DENY, 0, cond)
    }

    fn leaf(op: u8, a: u8, arg: u64) -> Node {
        Node::new(op, a, arg)
    }

    const TRUE: Node = Node::new(op::TRUE, 0, 0);
    const REFUSED: Result<(), Refusal> = Err(Refusal::Rule(Violation {
        rule: 0,
        code: CODE,
    }));

    /// A wallet-to-wallet transfer (key(7)'s account to key(5)).
    fn p2p(now: i64, amount: u64, balance_after: u64) -> TransferView {
        TransferView {
            source: key(7),
            ..buy(now, amount, balance_after)
        }
    }

    /// Whether `t` gets past every built-in allow of `evaluate` (what the
    /// creator rules may decide), written from the documented order: not a
    /// sell, before the guard's end, a non-zero amount, neither owner exempt.
    fn passes_the_built_in_allows(p: &HookPolicy, t: &TransferView) -> bool {
        let sell = t.destination == p.base_vault && t.source != p.base_vault;
        !sell
            && t.now < p.guard_end_ts
            && t.amount != 0
            && !p.is_exempt(&t.destination_owner)
            && !p.is_exempt(&t.source_owner)
    }

    /// Whether the creator rules decide `t` once the built-in checks let it
    /// through: everything past the built-in allows, except holders' exits
    /// (the top-level instruction is the Noised vault's or shield's).
    fn reaches_the_rules(p: &HookPolicy, t: &TransferView) -> bool {
        passes_the_built_in_allows(p, t)
            && t.top_program != VAULT_PROGRAM
            && t.top_program != SHIELD_PROGRAM
    }

    /// The rules context of `t`, written from the spec (seconds since the
    /// launch; a buy comes out of the base vault; everything else that
    /// reaches the rules is wallet to wallet).
    fn spec_ctx(p: &HookPolicy, t: &TransferView) -> TransferCtx {
        let is_buy = t.source == p.base_vault;
        TransferCtx {
            now_rel: t.now - p.launch_ts,
            is_buy,
            is_p2p: !is_buy,
            amount: t.amount,
            dest_balance_after: t.destination_balance,
            supply: t.supply,
            dest_owner: t.destination_owner.to_bytes(),
            src_owner: t.source_owner.to_bytes(),
            top_program: t.top_program.to_bytes(),
            tx_ix_count: t.tx_ix_count,
        }
    }

    /// A rule that refuses everything changes exactly the transfers that
    /// get past every built-in allow and denial: sells, everything after the
    /// guard, zero amounts, the batch buy, claims and other exempt owners
    /// pass as before, and every built-in refusal keeps its own reason.
    #[test]
    fn creator_rules_come_after_every_built_in_decision() {
        let keys = [key(3), key(4), key(5), key(6), key(9), Pubkey::default()];
        let mut r = Lcg(29);
        let mut seen = [0u32; 3];
        for i in 0..400_000u64 {
            let mut p = ruled(deny_when(&[], &[TRUE]));
            p.p2p_locked = i % 2 == 0;
            p.max_buy = [0, 2_000][(i / 2 % 2) as usize];
            p.max_wallet = [0, 10_000][(i / 4 % 2) as usize];
            let bare = HookPolicy {
                rules: vec![],
                ..p.clone()
            };
            let t = TransferView {
                // From the launch (the policy's creation) on.
                now: p.launch_ts + (r.next() % 4_000) as i64,
                amount: if r.next().is_multiple_of(4) {
                    0
                } else {
                    r.next() % 20_000
                },
                source: r.key(&keys),
                source_owner: r.key(&keys),
                destination: r.key(&keys),
                destination_owner: r.key(&keys),
                destination_balance: r.next() % 40_000,
                destination_immutable_owner: r.next().is_multiple_of(2),
                in_batch: r.next().is_multiple_of(8),
                supply: r.next(),
                top_program: r.key(&keys),
                tx_ix_count: (r.next() % 8) as u16,
            };
            let (before, after) = (evaluate(&bare, &t), evaluate(&p, &t));
            // The step `execute` reads the supply and the top-level
            // instructions for: exactly what passes the built-in allows.
            let step = built_ins(&p, &t);
            assert_eq!(step, built_ins(&bare, &t), "rules never change it: {t:?}");
            if before.is_err() {
                assert_eq!(after, before, "{t:?}");
                assert_eq!(step.map(|_| ()), before, "{t:?}");
                seen[0] += 1;
            } else if reaches_the_rules(&p, &t) {
                assert_eq!(after, REFUSED, "{t:?}");
                assert_eq!(step, Ok(Step::CreatorRules), "{t:?}");
                seen[1] += 1;
            } else {
                assert_eq!(after, Ok(()), "{t:?}");
                assert_eq!(step, Ok(Step::Allowed), "{t:?}");
                seen[2] += 1;
            }
        }
        assert!(seen.iter().all(|&n| n > 10_000), "{seen:?}");
    }

    /// The same, case by case: what passes before the rules passes with a
    /// rule that refuses everything, and every built-in refusal is reported
    /// as itself.
    #[test]
    fn a_rule_that_refuses_everything_spares_sells_claims_and_the_batch() {
        use Refusal::*;
        let p = ruled(deny_when(&[], &[TRUE]));
        let open = HookPolicy {
            p2p_locked: false,
            ..p.clone()
        };
        let sell = TransferView {
            source: key(5),
            destination: key(3),
            ..buy(1_001, u64::MAX, 0)
        };
        let claim = TransferView {
            source_owner: key(9),
            ..p2p(1_001, 5_000, 50_000)
        };
        let batch = TransferView {
            destination_owner: key(9),
            in_batch: true,
            ..buy(1_001, 5_000, 5_000)
        };
        let into_exempt = TransferView {
            destination_owner: key(9),
            ..buy(2_000, 5_000, 50_000)
        };
        let mutable = TransferView {
            destination_immutable_owner: false,
            ..buy(2_000, 1, 1)
        };
        let table: Vec<(&str, &HookPolicy, TransferView, Result<(), Refusal>)> = vec![
            ("sell during the shield", &p, sell, Ok(())),
            (
                "sell during the guard",
                &p,
                TransferView { now: 2_000, ..sell },
                Ok(()),
            ),
            ("buy at the guard's end", &p, buy(4_600, 1, 1), Ok(())),
            ("p2p after the guard", &p, p2p(9_999, 1, 1), Ok(())),
            ("zero buy", &p, buy(2_000, 0, 0), Ok(())),
            ("zero p2p", &p, p2p(2_000, 0, 0), Ok(())),
            ("claim during the shield", &p, claim, Ok(())),
            (
                "claim during the guard",
                &p,
                TransferView {
                    now: 2_000,
                    ..claim
                },
                Ok(()),
            ),
            ("the batch buy", &p, batch, Ok(())),
            ("buy into an exempt owner", &p, into_exempt, Ok(())),
            (
                "buy during the shield",
                &p,
                buy(1_001, 1, 1),
                Err(SnipeShield),
            ),
            ("buy into a mutable account", &p, mutable, Err(MutableOwner)),
            ("p2p, locked", &p, p2p(2_000, 1, 1), Err(TransfersLocked)),
            (
                "buy over max_buy",
                &p,
                buy(2_000, 2_001, 2_001),
                Err(MaxBuy),
            ),
            (
                "buy over max_wallet",
                &p,
                buy(2_000, 1, 10_001),
                Err(MaxWallet),
            ),
            (
                "buy within the caps",
                &p,
                buy(2_000, 2_000, 10_000),
                REFUSED,
            ),
            (
                "buy in the guard's last second",
                &p,
                buy(4_599, 1, 1),
                REFUSED,
            ),
            ("p2p, lock off", &open, p2p(2_000, 1, 1), REFUSED),
        ];
        for (what, policy, t, want) in table {
            assert_eq!(evaluate(policy, &t), want, "{what}: {t:?}");
        }
    }

    /// Each leaf of a rule sees its own field of the transfer, and the
    /// windows count from the launch.
    #[test]
    fn creator_rules_see_the_transfer() {
        let supply = 1_000_000_000;
        let at = |now: i64| TransferView {
            supply,
            top_program: key(0x77),
            tx_ix_count: 3,
            ..buy(now, 1_000, 5_000)
        };
        // A window of [60, 120) seconds after the launch (launch_ts 1_000).
        let p = open_ruled(rule_set(&[], (60, 120), effect::DENY, 0, &[TRUE]));
        for (now, want) in [
            (1_059, Ok(())),
            (1_060, REFUSED),
            (1_119, REFUSED),
            (1_120, Ok(())),
        ] {
            assert_eq!(evaluate(&p, &at(now)), want, "window at {now}");
        }
        // TIME_LT / TIME_GE count from the launch too.
        let p = open_ruled(deny_when(&[], &[leaf(op::rules::TIME_LT, 0, 90)]));
        assert_eq!(evaluate(&p, &at(1_089)), REFUSED);
        assert_eq!(evaluate(&p, &at(1_090)), Ok(()));
        let p = open_ruled(deny_when(&[], &[leaf(op::rules::TIME_GE, 0, 90)]));
        assert_eq!(evaluate(&p, &at(1_089)), Ok(()));
        assert_eq!(evaluate(&p, &at(1_090)), REFUSED);
        // IS_BUY / IS_P2P.
        let p2p_at = |now: i64| TransferView {
            source: key(7),
            ..at(now)
        };
        let p = open_ruled(deny_when(&[], &[leaf(op::rules::IS_BUY, 0, 0)]));
        assert_eq!(evaluate(&p, &at(2_000)), REFUSED);
        assert_eq!(evaluate(&p, &p2p_at(2_000)), Ok(()));
        let p = open_ruled(deny_when(&[], &[leaf(op::rules::IS_P2P, 0, 0)]));
        assert_eq!(evaluate(&p, &at(2_000)), Ok(()));
        assert_eq!(evaluate(&p, &p2p_at(2_000)), REFUSED);
        // AMOUNT_GT and DEST_BAL_AFTER_GT, absolute and in bps of the supply.
        for (op, field_amount) in [
            (op::rules::AMOUNT_GT, true),
            (op::rules::DEST_BAL_AFTER_GT, false),
        ] {
            for (arg, threshold) in [(700, 700), (BPS_FLAG | 7, supply * 7 / 10_000)] {
                let p = open_ruled(deny_when(&[], &[leaf(op, 0, arg)]));
                let with = |v: u64| {
                    let mut t = at(2_000);
                    if field_amount {
                        t.amount = v;
                    } else {
                        t.destination_balance = v;
                    }
                    evaluate(&p, &t)
                };
                assert_eq!(with(threshold), Ok(()), "{op:#x} {arg:#x}");
                assert_eq!(with(threshold + 1), REFUSED, "{op:#x} {arg:#x}");
            }
        }
        // CAP_AMOUNT and CAP_DEST_BALANCE in bps of the supply.
        let p = open_ruled(rule_set(
            &[],
            (0, GUARD),
            effect::CAP_AMOUNT,
            BPS_FLAG | 3,
            &[TRUE],
        ));
        let cap = supply * 3 / 10_000;
        assert_eq!(
            evaluate(
                &p,
                &TransferView {
                    amount: cap,
                    ..at(2_000)
                }
            ),
            Ok(())
        );
        assert_eq!(
            evaluate(
                &p,
                &TransferView {
                    amount: cap + 1,
                    ..at(2_000)
                }
            ),
            REFUSED
        );
        let p = open_ruled(rule_set(
            &[],
            (0, GUARD),
            effect::CAP_DEST_BALANCE,
            BPS_FLAG | 3,
            &[TRUE],
        ));
        assert_eq!(
            evaluate(
                &p,
                &TransferView {
                    destination_balance: cap,
                    ..at(2_000)
                }
            ),
            Ok(())
        );
        assert_eq!(
            evaluate(
                &p,
                &TransferView {
                    destination_balance: cap + 1,
                    ..at(2_000)
                }
            ),
            REFUSED
        );
        // The key lists: destination owner, source owner, top-level program.
        let k = [key(0x55).to_bytes()];
        let p = open_ruled(deny_when(&k, &[leaf(op::rules::DEST_OWNER_IN, 1, 0)]));
        assert_eq!(evaluate(&p, &at(2_000)), Ok(()));
        assert_eq!(
            evaluate(
                &p,
                &TransferView {
                    destination_owner: key(0x55),
                    ..at(2_000)
                }
            ),
            REFUSED
        );
        assert_eq!(
            evaluate(
                &p,
                &TransferView {
                    source_owner: key(0x55),
                    ..at(2_000)
                }
            ),
            Ok(())
        );
        let p = open_ruled(deny_when(&k, &[leaf(op::rules::SRC_OWNER_IN, 1, 0)]));
        assert_eq!(evaluate(&p, &at(2_000)), Ok(()));
        assert_eq!(
            evaluate(
                &p,
                &TransferView {
                    source_owner: key(0x55),
                    ..at(2_000)
                }
            ),
            REFUSED
        );
        assert_eq!(
            evaluate(
                &p,
                &TransferView {
                    destination_owner: key(0x55),
                    ..at(2_000)
                }
            ),
            Ok(())
        );
        let p = open_ruled(deny_when(&k, &[leaf(op::rules::TOP_PROGRAM_IN, 1, 0)]));
        assert_eq!(evaluate(&p, &at(2_000)), Ok(()));
        assert_eq!(
            evaluate(
                &p,
                &TransferView {
                    top_program: key(0x55),
                    ..at(2_000)
                }
            ),
            REFUSED
        );
        // TX_IX_COUNT_GT.
        let p = open_ruled(deny_when(&[], &[leaf(op::rules::TX_IX_COUNT_GT, 0, 3)]));
        assert_eq!(evaluate(&p, &at(2_000)), Ok(()));
        assert_eq!(
            evaluate(
                &p,
                &TransferView {
                    tx_ix_count: 4,
                    ..at(2_000)
                }
            ),
            REFUSED
        );
    }

    /// The first active rule that refuses is reported, with its index and
    /// code.
    #[test]
    fn the_refusing_rule_is_reported() {
        let rules = [(0, 60, 5), (0, GUARD, 9), (0, GUARD, 11)]
            .iter()
            .enumerate()
            .map(|(i, &(from, to, code))| Rule {
                from_rel: from,
                to_rel: to,
                cond_off: i as u8,
                cond_len: 1,
                effect: effect::DENY,
                code,
                arg: 0,
            })
            .collect();
        let bytes = RulesProgram {
            keys: vec![],
            rules,
            nodes: vec![leaf(op::rules::IS_P2P, 0, 0), TRUE, TRUE],
        }
        .encode()
        .unwrap();
        RuleSet::verify(&bytes, GUARD).unwrap();
        let p = open_ruled(bytes);
        let refused = |rule, code| Err(Refusal::Rule(Violation { rule, code }));
        assert_eq!(evaluate(&p, &buy(1_030, 1, 1)), refused(1, 9));
        assert_eq!(evaluate(&p, &p2p(1_030, 1, 1)), refused(0, 5));
        assert_eq!(evaluate(&p, &p2p(1_060, 1, 1)), refused(1, 9));
    }

    /// Stored bytes that do not parse (no policy `create_policy` writes
    /// holds them) refuse every transfer that reaches the rules.
    #[test]
    fn malformed_stored_rules_fail_closed() {
        let malformed = Err(Refusal::Rule(Violation {
            rule: u8::MAX,
            code: CODE_MALFORMED,
        }));
        for junk in [vec![0u8], b"PXR1".to_vec(), vec![0xFF; 40]] {
            let p = open_ruled(junk);
            assert_eq!(evaluate(&p, &buy(2_000, 1, 1)), malformed);
            assert_eq!(evaluate(&p, &p2p(2_000, 1, 1)), malformed);
            // What never reaches the rules is unaffected.
            let sell = TransferView {
                source: key(5),
                destination: key(3),
                ..buy(2_000, 1, 1)
            };
            assert_eq!(evaluate(&p, &sell), Ok(()));
            assert_eq!(evaluate(&p, &buy(4_600, 1, 1)), Ok(()));
        }
    }

    /// A random rule set the hook could store: up to 16 rules in random
    /// windows of the guard, conditions of up to three leaves over up to
    /// four keys, every effect, caps in tokens and in bps of the supply.
    /// Drawn again until it verifies (too many nodes).
    fn random_rules(g: &mut Lcg) -> RulesProgram {
        loop {
            let n_keys = (g.next() % 5) as u8;
            let mut p = RulesProgram {
                keys: (0..n_keys).map(|i| [0xA0 + i; 32]).collect(),
                rules: vec![],
                nodes: vec![],
            };
            for _ in 0..=g.next() % 16 {
                let from = (g.next() % u64::from(GUARD)) as u32;
                let cond_off = p.nodes.len() as u8;
                for i in 0..=g.next() % 3 {
                    p.nodes.push(random_leaf(g, n_keys));
                    if i > 0 {
                        p.nodes
                            .push(Node::new([op::AND, op::OR][(g.next() % 2) as usize], 0, 0));
                    }
                    if g.next().is_multiple_of(5) {
                        p.nodes.push(Node::new(op::NOT, 0, 0));
                    }
                }
                let kind = 1 + (g.next() % 3) as u8;
                p.rules.push(Rule {
                    from_rel: from,
                    to_rel: from + 1 + (g.next() % u64::from(GUARD - from)) as u32,
                    cond_off,
                    cond_len: p.nodes.len() as u8 - cond_off,
                    effect: kind,
                    code: (g.next() % 64) as u8,
                    arg: if kind == effect::DENY {
                        0
                    } else {
                        random_threshold(g)
                    },
                });
            }
            // Every key must be named: widen the first key list, or drop them.
            let used = p
                .nodes
                .iter()
                .filter(|n| is_key_leaf(n))
                .fold(0, |m, n| m | n.a);
            match p.nodes.iter_mut().find(|n| is_key_leaf(n)) {
                Some(n) => n.a |= ((1u8 << n_keys) - 1) & !used,
                None => p.keys.clear(),
            }
            if p.encode()
                .is_ok_and(|bytes| RuleSet::verify(&bytes, GUARD).is_ok())
            {
                return p;
            }
        }
    }

    fn is_key_leaf(n: &Node) -> bool {
        (op::rules::DEST_OWNER_IN..=op::rules::TOP_PROGRAM_IN).contains(&n.op)
    }

    fn random_leaf(g: &mut Lcg, n_keys: u8) -> Node {
        let time = g.next() % u64::from(GUARD + 1);
        match g.next() % 10 {
            0 => Node::new(op::rules::IS_BUY, 0, 0),
            1 => Node::new(op::rules::IS_P2P, 0, 0),
            2 => Node::new(op::rules::TIME_LT, 0, time),
            3 => Node::new(op::rules::TIME_GE, 0, time),
            4 => Node::new(op::rules::AMOUNT_GT, 0, random_threshold(g)),
            5 => Node::new(op::rules::DEST_BAL_AFTER_GT, 0, random_threshold(g)),
            6 => Node::new(op::rules::TX_IX_COUNT_GT, 0, g.next() % 6),
            _ if n_keys == 0 => Node::new(op::TRUE, 0, 0),
            k => {
                let mask = (g.next() as u8 & ((1u8 << n_keys) - 1)).max(1);
                Node::new(op::rules::DEST_OWNER_IN + (k - 7) as u8, mask, 0)
            }
        }
    }

    fn random_threshold(g: &mut Lcg) -> u64 {
        match g.next() % 3 {
            0 => BPS_FLAG | (1 + g.next() % 10_000),
            1 => 1 + g.next() % 5_000,
            _ => 1 + g.next() % (1 << 40),
        }
    }

    /// A transfer context aimed at the edges of `p`: times at its windows
    /// and time leaves, amounts and balances at its caps and thresholds
    /// (bps ones of the drawn supply), owners and the top-level program
    /// among its keys.
    fn random_ctx(g: &mut Lcg, p: &RulesProgram) -> TransferCtx {
        let supply =
            [0, 1, 10_000, 1_000_000_000_000_000, u64::MAX, g.next()][(g.next() % 6) as usize];
        let is_time = |n: &&Node| n.op == op::rules::TIME_LT || n.op == op::rules::TIME_GE;
        let is_cap =
            |n: &&Node| n.op == op::rules::AMOUNT_GT || n.op == op::rules::DEST_BAL_AFTER_GT;
        let times: Vec<u64> = (p.rules.iter())
            .flat_map(|r| [u64::from(r.from_rel), u64::from(r.to_rel)])
            .chain(p.nodes.iter().filter(is_time).map(|n| n.arg))
            .collect();
        let caps: Vec<u64> = (p.rules.iter().map(|r| r.arg).filter(|&a| a != 0))
            .chain(p.nodes.iter().filter(is_cap).map(|n| n.arg))
            .map(|a| match a & BPS_FLAG {
                0 => a,
                _ => (u128::from(supply) * u128::from(a & 0xFFFF) / 10_000) as u64,
            })
            .collect();
        TransferCtx {
            now_rel: match edge(g, &times) {
                Some(t) => t as i64,
                None => (g.next() % u64::from(GUARD + 200)) as i64 - 100,
            },
            is_buy: g.next().is_multiple_of(2),
            is_p2p: false,
            amount: edge(g, &caps).unwrap_or(g.next() % (1 << 41)),
            dest_balance_after: edge(g, &caps).unwrap_or(g.next() % (1 << 41)),
            supply,
            dest_owner: owner(g, &p.keys),
            src_owner: owner(g, &p.keys),
            top_program: owner(g, &p.keys),
            tx_ix_count: [0, 1, 2, 3, 5, 6, u16::MAX][(g.next() % 7) as usize],
        }
    }

    /// Half the time (never for an empty pool) one of `pool` give or take one.
    fn edge(g: &mut Lcg, pool: &[u64]) -> Option<u64> {
        if pool.is_empty() || g.next().is_multiple_of(2) {
            return None;
        }
        let at = pool[(g.next() % pool.len() as u64) as usize];
        Some(at.saturating_add(g.next() % 3).saturating_sub(1))
    }

    /// Two times in three (when there are keys) one of `keys`, else another.
    fn owner(g: &mut Lcg, keys: &[[u8; 32]]) -> [u8; 32] {
        if keys.is_empty() || g.next().is_multiple_of(3) {
            return [g.next() as u8; 32];
        }
        keys[(g.next() % keys.len() as u64) as usize]
    }

    /// Random verified rule sets on random transfers: what reaches the rules
    /// is decided exactly as `noised_rules` decides the spec's context of
    /// the transfer; everything else is decided as without rules. So rules
    /// only ever add refusals, never to a sell, a claim, the batch or after
    /// the guard.
    #[test]
    fn random_rule_sets_only_refuse_what_reaches_them() {
        let mut g = Lcg(0x5EED_0001);
        let mut r = Lcg(31);
        let (mut refused, mut passed, mut built_in) = (0u32, 0u32, 0u32);
        for i in 0..3_000u64 {
            let program = random_rules(&mut g);
            let bytes = program.encode().unwrap();
            let set = RuleSet::verify(&bytes, GUARD).expect("generated rule set verifies");
            let mut p = ruled(bytes.clone());
            p.p2p_locked = i % 3 == 0;
            p.max_buy = [0, 2_000][(i / 3 % 2) as usize];
            p.max_wallet = [0, 10_000][(i / 6 % 2) as usize];
            let bare = HookPolicy {
                rules: vec![],
                ..p.clone()
            };
            for j in 0..100 {
                // A transfer whose context the generator aims at the rule
                // set's edges, placed in the guard.
                let mut c = random_ctx(&mut g, &program);
                // Now and then a holder's exit (the vault or the shield).
                if j % 16 == 15 {
                    c.top_program = [VAULT_PROGRAM, SHIELD_PROGRAM][j / 16 % 2].to_bytes();
                }
                let owners = [key(4), key(6), key(9), Pubkey::new_from_array(c.dest_owner)];
                let t = TransferView {
                    now: p
                        .launch_ts
                        .saturating_add(c.now_rel.clamp(-100, i64::from(GUARD) + 100)),
                    amount: if r.next().is_multiple_of(8) {
                        0
                    } else {
                        c.amount
                    },
                    source: if c.is_buy {
                        p.base_vault
                    } else {
                        r.key(&[key(5), key(7), key(3)])
                    },
                    source_owner: if r.next().is_multiple_of(4) {
                        r.key(&owners)
                    } else {
                        Pubkey::new_from_array(c.src_owner)
                    },
                    destination: r.key(&[key(5), key(7), key(3)]),
                    destination_owner: if r.next().is_multiple_of(4) {
                        r.key(&owners)
                    } else {
                        Pubkey::new_from_array(c.dest_owner)
                    },
                    destination_balance: c.dest_balance_after,
                    destination_immutable_owner: !r.next().is_multiple_of(8),
                    in_batch: r.next().is_multiple_of(8),
                    supply: c.supply,
                    top_program: Pubkey::new_from_array(c.top_program),
                    tx_ix_count: c.tx_ix_count,
                };
                let (before, after) = (evaluate(&bare, &t), evaluate(&p, &t));
                if before.is_ok() && reaches_the_rules(&p, &t) {
                    let want = set.evaluate(&spec_ctx(&p, &t)).map_err(Refusal::Rule);
                    assert_eq!(after, want, "{t:?}");
                    if after.is_err() {
                        refused += 1;
                    } else {
                        passed += 1;
                    }
                } else {
                    assert_eq!(after, before, "{t:?}");
                    built_in += 1;
                }
            }
        }
        assert!(
            refused > 1_000 && passed > 1_000 && built_in > 1_000,
            "{refused} {passed} {built_in}"
        );
    }

    // ------------------------------- review 4 (P1c): holders' exits (R1) ---

    const VAULT_PROGRAM: Pubkey =
        anchor_lang::prelude::pubkey!("7BQ6FQomidBkd5z7fQfwr9Zt87oahMvMV5dFnw6Dz7nb");
    const SHIELD_PROGRAM: Pubkey =
        anchor_lang::prelude::pubkey!("BUMHJyoS6JCz4pZDfryzXbFDorXb9nmGkj3ziR71z8E9");

    /// The ids the hook exempts are the vault's and the shield's (the
    /// integration and shield suites pin them against those crates).
    #[test]
    fn holders_exits_are_the_vault_and_the_shield() {
        assert_eq!(crate::VAULT_PROGRAM_ID, VAULT_PROGRAM);
        assert_eq!(crate::SHIELD_PROGRAM_ID, SHIELD_PROGRAM);
    }

    /// Review 4, R4-1 (the reviewer's PoC, inverted): with `p2p_locked =
    /// false`, a verified rule aimed at the Noised PQ vault and the shield
    /// (`IS_P2P AND TOP_PROGRAM_IN {vault, shield}`) used to refuse, for the
    /// whole guard, every vault withdrawal and every unwrap. Creator rules
    /// never see those exits now; the same transfer sent by a wallet is
    /// still theirs to decide, and sells and the guard's end are untouched.
    #[test]
    fn rules_never_freeze_pq_vault_or_shield_releases() {
        let keys = [VAULT_PROGRAM.to_bytes(), SHIELD_PROGRAM.to_bytes()];
        let bytes = deny_when(
            &keys,
            &[
                leaf(op::rules::IS_P2P, 0, 0),
                leaf(op::rules::TOP_PROGRAM_IN, 0b11, 0),
                Node::new(op::AND, 0, 0),
            ],
        );
        let p = open_ruled(bytes);
        assert!(!p.p2p_locked && p.max_buy == 0 && p.max_wallet == 0);
        // A vault withdrawal: source owned by a vault PDA (key(8)), paid to
        // its owner's ATA, top-level instruction = the vault program.
        let mut release = p2p(p.launch_ts + 1, 1_000, 1_000);
        release.source_owner = key(8);
        release.top_program = VAULT_PROGRAM;
        release.tx_ix_count = 2;
        assert_eq!(evaluate(&p, &release), Ok(()));
        let unwrap = TransferView {
            top_program: SHIELD_PROGRAM,
            ..release
        };
        assert_eq!(evaluate(&p, &unwrap), Ok(()));
        // Until the last second of the guard.
        let late = TransferView {
            now: p.guard_end_ts - 1,
            ..release
        };
        assert_eq!(evaluate(&p, &late), Ok(()));
        assert_eq!(
            evaluate(
                &p,
                &TransferView {
                    top_program: SHIELD_PROGRAM,
                    ..late
                }
            ),
            Ok(())
        );
        // A rule set that refuses everything does not hold them either.
        let deny_all = open_ruled(deny_when(&[], &[TRUE]));
        assert_eq!(evaluate(&deny_all, &release), Ok(()));
        assert_eq!(evaluate(&deny_all, &unwrap), Ok(()));
        // The same transfer sent by a wallet (Token-2022 top-level), or made
        // inside another program, is the rules' to decide.
        for other in [key(20), Pubkey::default(), crate::LAUNCHPAD_PROGRAM_ID] {
            let wallet = TransferView {
                top_program: other,
                ..release
            };
            assert_eq!(evaluate(&deny_all, &wallet), REFUSED, "{other}");
        }
        // Sells and the end of the guard are untouched.
        let sell = TransferView {
            destination: p.base_vault,
            ..release
        };
        assert_eq!(evaluate(&p, &sell), Ok(()));
        let after = TransferView {
            now: p.guard_end_ts,
            ..release
        };
        assert_eq!(evaluate(&p, &after), Ok(()));
    }

    /// Only the creator-rules step is skipped for a holder's exit: every
    /// built-in check still applies to it, exactly as without rules (the
    /// p2p lock, the caps, the immutable-owner rule, the snipe shield).
    #[test]
    fn holders_exits_still_meet_every_built_in_check() {
        use Refusal::*;
        let locked = ruled(deny_when(&[], &[TRUE]));
        let open = HookPolicy {
            p2p_locked: false,
            ..locked.clone()
        };
        for exit in [VAULT_PROGRAM, SHIELD_PROGRAM] {
            let release = TransferView {
                top_program: exit,
                ..p2p(2_000, 1_000, 1_000)
            };
            let table: Vec<(&str, &HookPolicy, TransferView, Result<(), Refusal>)> = vec![
                ("locked", &locked, release, Err(TransfersLocked)),
                ("lock off", &open, release, Ok(())),
                (
                    "into a mutable account",
                    &open,
                    TransferView {
                        destination_immutable_owner: false,
                        ..release
                    },
                    Err(MutableOwner),
                ),
                (
                    "over max_buy",
                    &open,
                    TransferView {
                        amount: 2_001,
                        ..release
                    },
                    Err(MaxBuy),
                ),
                (
                    "over max_wallet",
                    &open,
                    TransferView {
                        destination_balance: 10_001,
                        ..release
                    },
                    Err(MaxWallet),
                ),
                (
                    "a buy during the shield",
                    &open,
                    TransferView {
                        top_program: exit,
                        ..buy(1_001, 1, 1)
                    },
                    Err(SnipeShield),
                ),
                (
                    "a buy after it",
                    &open,
                    TransferView {
                        top_program: exit,
                        ..buy(2_000, 1, 1)
                    },
                    Ok(()),
                ),
            ];
            for (what, p, t, want) in table {
                assert_eq!(evaluate(p, &t), want, "{exit} {what}: {t:?}");
            }
        }
    }

    /// Whatever the rules and the transfer, a holder's exit is decided by
    /// the built-in checks alone (as without rules), and any other top-level
    /// program leaves it to the rules exactly as before.
    #[test]
    fn holders_exits_are_decided_by_the_built_ins_alone() {
        let keys = [key(3), key(4), key(5), key(6), key(9), Pubkey::default()];
        let programs = [VAULT_PROGRAM, SHIELD_PROGRAM, key(20), Pubkey::default()];
        let mut r = Lcg(37);
        let mut exits = 0u32;
        for i in 0..200_000u64 {
            let mut p = ruled(deny_when(&[], &[TRUE]));
            p.p2p_locked = i % 2 == 0;
            p.max_buy = [0, 2_000][(i / 2 % 2) as usize];
            p.max_wallet = [0, 10_000][(i / 4 % 2) as usize];
            let bare = HookPolicy {
                rules: vec![],
                ..p.clone()
            };
            let t = TransferView {
                now: p.launch_ts + (r.next() % 4_000) as i64,
                amount: r.next() % 20_000,
                source: r.key(&keys),
                source_owner: r.key(&keys),
                destination: r.key(&keys),
                destination_owner: r.key(&keys),
                destination_balance: r.next() % 40_000,
                destination_immutable_owner: !r.next().is_multiple_of(4),
                in_batch: r.next().is_multiple_of(8),
                supply: r.next(),
                top_program: r.key(&programs),
                tx_ix_count: (r.next() % 8) as u16,
            };
            let (before, after) = (evaluate(&bare, &t), evaluate(&p, &t));
            if t.top_program == VAULT_PROGRAM || t.top_program == SHIELD_PROGRAM {
                assert_eq!(after, before, "{t:?}");
                exits += u32::from(passes_the_built_in_allows(&p, &t) && before.is_ok());
            } else if before.is_ok() && passes_the_built_in_allows(&p, &t) {
                assert_eq!(after, REFUSED, "{t:?}");
            } else {
                assert_eq!(after, before, "{t:?}");
            }
        }
        assert!(exits > 5_000, "{exits}");
    }

    /// Review 4, R4-2 (residual, unchanged on-chain; R2 makes clients show
    /// it): an allowlist turns the guard into a private sale. After the
    /// batch only the listed wallets can buy from the curve, while every
    /// holder can still sell into it. It verifies and passes no built-in
    /// check off; the badge warns on buys restricted to a key list.
    #[test]
    fn insider_only_buying_verifies_and_sells_still_pass() {
        let insider = key(30);
        let bytes = deny_when(
            &[insider.to_bytes()],
            &[
                leaf(op::rules::IS_BUY, 0, 0),
                leaf(op::rules::DEST_OWNER_IN, 0b1, 0),
                Node::new(op::NOT, 0, 0),
                Node::new(op::AND, 0, 0),
            ],
        );
        let p = open_ruled(bytes);
        let public = buy(p.snipe_shield_end_ts, 1_000, 1_000);
        assert_eq!(evaluate(&p, &public), REFUSED);
        let insiders = TransferView {
            destination_owner: insider,
            ..public
        };
        assert_eq!(evaluate(&p, &insiders), Ok(()));
        let sell = TransferView {
            source: key(7),
            destination: p.base_vault,
            ..public
        };
        assert_eq!(evaluate(&p, &sell), Ok(()));
    }

    /// Review 4, R4-3 (residual, unchanged on-chain; R2 makes clients warn
    /// on it): a vacuous rule set (DENY when FALSE for one second) verifies
    /// and never refuses.
    #[test]
    fn vacuous_rules_verify_and_never_refuse() {
        let bytes = rule_set(&[], (0, 1), effect::DENY, 0, &[Node::new(op::FALSE, 0, 0)]);
        assert!(RuleSet::verify(&bytes, GUARD).is_ok());
        let p = open_ruled(bytes);
        assert_eq!(evaluate(&p, &buy(p.snipe_shield_end_ts, 1, 1)), Ok(()));
        assert_eq!(evaluate(&p, &p2p(p.launch_ts, 1, 1)), Ok(()));
    }
}

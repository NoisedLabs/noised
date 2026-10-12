use super::{key, Lcg};
use crate::{
    math::{batch_share, bps_of, pro_rata, split_fees},
    state::FeeRecipient,
};

#[test]
fn pro_rata_edges() {
    assert_eq!(pro_rata(100, 1, 3), Some(33));
    assert_eq!(pro_rata(100, 3, 3), Some(100));
    assert_eq!(pro_rata(0, 1, 3), Some(0));
    assert_eq!(pro_rata(u64::MAX, u64::MAX, u64::MAX), Some(u64::MAX));
    assert_eq!(pro_rata(u64::MAX, 1, u64::MAX), Some(1));
    assert_eq!(pro_rata(100, 1, 0), None, "empty batch");
    assert_eq!(
        pro_rata(100, 4, 3),
        None,
        "a share can never exceed the whole"
    );
}

#[test]
fn batch_share_rejects_overspend() {
    assert_eq!(batch_share(1, 10, 11, 5), None);
    let s = batch_share(5, 10, 4, 1_000).unwrap();
    assert_eq!((s.tokens, s.refund), (500, 3));
}

/// Simulate whole batches: every commit claims once. Payouts never exceed
/// what the batch holds, each payout is at most the exact rational share,
/// and the dust left behind is below one base unit per participant.
#[test]
fn batch_claims_never_overpay_and_dust_is_bounded() {
    let mut r = Lcg(42);
    for round in 0..2_000 {
        let n = 1 + r.below(if round % 10 == 0 { 300 } else { 12 }) as usize;
        let commits: Vec<u64> = (0..n)
            .map(|_| match r.below(4) {
                0 => 1 + r.below(10),
                1 => 1 + r.below(1_000_000_000),
                _ => 1 + r.below(100_000_000_000_000),
            })
            .collect();
        let total: u64 = commits.iter().sum();
        let quote_spent = r.below(total + 1);
        let tokens_out = match r.below(3) {
            0 => r.below(1_000),
            1 => r.next(),
            _ => u64::MAX - r.below(1_000),
        };
        let mut tokens_paid: u128 = 0;
        let mut refunds_paid: u128 = 0;
        for &c in &commits {
            let s = batch_share(c, total, quote_spent, tokens_out).unwrap();
            assert!(
                u128::from(s.tokens) * u128::from(total) <= u128::from(tokens_out) * u128::from(c)
            );
            let unspent = u128::from(total - quote_spent);
            assert!(u128::from(s.refund) * u128::from(total) <= unspent * u128::from(c));
            tokens_paid += u128::from(s.tokens);
            refunds_paid += u128::from(s.refund);
        }
        assert!(tokens_paid <= u128::from(tokens_out));
        assert!(refunds_paid <= u128::from(total - quote_spent));
        assert!(u128::from(tokens_out) - tokens_paid < n as u128);
        assert!(u128::from(total - quote_spent) - refunds_paid < n as u128);
    }
}

#[test]
fn single_committer_gets_everything() {
    let s = batch_share(777, 777, 700, 123_456).unwrap();
    assert_eq!((s.tokens, s.refund), (123_456, 77));
}

#[test]
fn splitting_across_wallets_gives_no_advantage() {
    // Same lamports in one commit or split in two: never more in total.
    let (total, spent, out) = (1_000_003u64, 999_999u64, 98_765_431u64);
    let whole = batch_share(600_001, total, spent, out).unwrap();
    let a = batch_share(300_000, total, spent, out).unwrap();
    let b = batch_share(300_001, total, spent, out).unwrap();
    assert!(a.tokens + b.tokens <= whole.tokens);
    assert!(a.refund + b.refund <= whole.refund);
}

#[test]
fn bps_of_rounds_down() {
    assert_eq!(bps_of(10_000, 1), Some(1));
    assert_eq!(bps_of(9_999, 1), Some(0));
    assert_eq!(bps_of(u64::MAX, 10_000), Some(u64::MAX));
    assert_eq!(bps_of(u64::MAX, 10_001), None);
}

fn recipients(bps: &[u16]) -> Vec<FeeRecipient> {
    bps.iter()
        .enumerate()
        .map(|(i, b)| FeeRecipient {
            wallet: key(i as u8 + 1),
            bps: *b,
        })
        .collect()
}

#[test]
fn fee_split_examples() {
    let s = split_fees(1_000_000, 2_000, &recipients(&[7_000, 3_000])).unwrap();
    assert_eq!(s.platform, 200_000);
    assert_eq!(s.recipients, [560_000, 240_000, 0, 0]);
    assert_eq!(s.total(), Some(1_000_000));

    // Rounding dust goes to the last recipient, never left behind.
    let s = split_fees(101, 3_333, &recipients(&[3_334, 3_333, 3_333])).unwrap();
    assert_eq!(s.platform, 33);
    assert_eq!(s.recipients, [22, 22, 24, 0]);
    assert_eq!(s.total(), Some(101));

    let s = split_fees(7, 0, &recipients(&[10_000])).unwrap();
    assert_eq!((s.platform, s.recipients), (0, [7, 0, 0, 0]));
    let s = split_fees(7, 5_000, &recipients(&[10_000])).unwrap();
    assert_eq!((s.platform, s.recipients), (3, [4, 0, 0, 0]));
    assert_eq!(
        split_fees(0, 5_000, &recipients(&[5_000, 5_000]))
            .unwrap()
            .total(),
        Some(0)
    );
}

#[test]
fn fee_split_rejects_malformed_input() {
    assert_eq!(split_fees(10, 0, &[]), None);
    assert_eq!(split_fees(10, 0, &recipients(&[2_000; 5])), None);
    assert_eq!(split_fees(10, 10_001, &recipients(&[10_000])), None);
}

#[test]
fn fee_split_always_sums_to_balance() {
    let mut r = Lcg(9);
    for _ in 0..50_000 {
        let n = 1 + r.below(4) as usize;
        let mut bps = vec![0u16; n];
        let mut left = 10_000u64;
        for b in bps.iter_mut().take(n - 1) {
            let x = r.below(left.min(9_999)) + 1;
            let x = x.min(left - (n as u64 - 1));
            *b = x as u16;
            left -= x;
        }
        bps[n - 1] = left as u16;
        if bps.contains(&0) {
            continue;
        }
        let balance = if r.below(2) == 0 {
            r.below(1_000)
        } else {
            r.next()
        };
        let platform_bps = r.below(5_001) as u16;
        let s = split_fees(balance, platform_bps, &recipients(&bps)).unwrap();
        assert_eq!(s.total(), Some(balance));
        assert_eq!(s.platform, bps_of(balance, platform_bps).unwrap());
        let creator = balance - s.platform;
        for (paid, b) in s.recipients.iter().zip(&bps).take(n - 1) {
            assert_eq!(*paid, bps_of(creator, *b).unwrap());
        }
        // The last recipient gets its own share plus less than one unit per other recipient.
        let own = bps_of(creator, bps[n - 1]).unwrap();
        assert!(s.recipients[n - 1] >= own && s.recipients[n - 1] - own < n as u64);
        assert!(s.recipients[n..].iter().all(|x| *x == 0));
    }
}

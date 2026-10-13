//! Payout math. Every division rounds down, so the sum of payouts never
//! exceeds what is held; the remainder ("dust") stays in the escrow.

use crate::constants::{BPS_DENOMINATOR, MAX_RECIPIENTS};
use crate::state::FeeRecipient;

/// `n / d` (rounded down) for a 128-bit `n` and a non-zero 64-bit `d`: the
/// high word by the CPU's 64-bit division, then the low word bit by bit
/// (restoring long division). Exactly `n / u128::from(d)`, without the
/// general 128-bit division routine (about 5 KB of program).
#[inline(never)]
pub fn div_wide(n: u128, d: u64) -> u128 {
    let (hi, lo) = ((n >> 64) as u64, n as u64);
    let divisor = u128::from(d);
    let mut rem = u128::from(hi % d);
    let mut q_lo = 0u64;
    let mut bit = 64;
    while bit > 0 {
        bit -= 1;
        // rem < d, so rem * 2 + 1 < 2^65: no overflow.
        rem = (rem << 1) | u128::from((lo >> bit) & 1);
        if rem >= divisor {
            rem -= divisor;
            q_lo |= 1 << bit;
        }
    }
    (u128::from(hi / d) << 64) | u128::from(q_lo)
}

/// `amount * part / total`, rounded down. `None` if `total` is zero or
/// `part > total` (a share can never exceed the whole).
pub fn pro_rata(amount: u64, part: u64, total: u64) -> Option<u64> {
    if total == 0 || part > total {
        return None;
    }
    u64::try_from(div_wide(u128::from(amount) * u128::from(part), total)).ok()
}

/// What one commit receives from an executed batch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BatchShare {
    pub tokens: u64,
    pub refund: u64,
}

/// `tokens = floor(tokens_out * commit / total)`,
/// `refund = floor((total - quote_spent) * commit / total)`.
pub fn batch_share(
    commit: u64,
    total_committed: u64,
    quote_spent: u64,
    tokens_out: u64,
) -> Option<BatchShare> {
    let unspent = total_committed.checked_sub(quote_spent)?;
    Some(BatchShare {
        tokens: pro_rata(tokens_out, commit, total_committed)?,
        refund: pro_rata(unspent, commit, total_committed)?,
    })
}

/// `amount * bps / 10_000`, rounded down.
pub fn bps_of(amount: u64, bps: u16) -> Option<u64> {
    pro_rata(amount, u64::from(bps), BPS_DENOMINATOR)
}

/// Fee routing for one `distribute` call.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FeeSplit {
    pub platform: u64,
    pub recipients: [u64; MAX_RECIPIENTS],
}

impl FeeSplit {
    pub fn total(&self) -> Option<u64> {
        self.recipients
            .iter()
            .try_fold(self.platform, |acc, x| acc.checked_add(*x))
    }
}

/// `platform = floor(balance * platform_bps / 10_000)`; the creator share
/// (the rest) goes to recipients by bps, rounded down, and the last recipient
/// takes whatever rounding left, so the split always sums to `balance`.
pub fn split_fees(
    balance: u64,
    platform_bps: u16,
    recipients: &[FeeRecipient],
) -> Option<FeeSplit> {
    if recipients.is_empty()
        || recipients.len() > MAX_RECIPIENTS
        || u64::from(platform_bps) > BPS_DENOMINATOR
    {
        return None;
    }
    let platform = bps_of(balance, platform_bps)?;
    let creator_share = balance.checked_sub(platform)?;
    let mut out = [0u64; MAX_RECIPIENTS];
    let last = recipients.len() - 1;
    let mut paid: u64 = 0;
    for (i, r) in recipients.iter().enumerate().take(last) {
        out[i] = bps_of(creator_share, r.bps)?;
        paid = paid.checked_add(out[i])?;
    }
    out[last] = creator_share.checked_sub(paid)?;
    Some(FeeSplit {
        platform,
        recipients: out,
    })
}

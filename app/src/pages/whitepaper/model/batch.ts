/**
 * Fair-open batch arithmetic (whitepaper section 6), mirrored from programs/noised-launchpad/src/math.rs:
 * tokens_i = floor(T c_i / C), refund_i = floor((C - S) c_i / C), with S <= min(C, cap) spent by the batch swap.
 */

/** floor(amount * part / total) with the program's preconditions (total > 0, part <= total). */
export function proRata(amount: bigint, part: bigint, total: bigint): bigint | null {
  if (total === 0n || part > total) return null;
  return (amount * part) / total;
}

export interface Share {
  tokens: bigint;
  refund: bigint;
}

export function batchShare(commit: bigint, totalCommitted: bigint, quoteSpent: bigint, tokensOut: bigint): Share | null {
  if (quoteSpent > totalCommitted) return null;
  const tokens = proRata(tokensOut, commit, totalCommitted);
  const refund = proRata(totalCommitted - quoteSpent, commit, totalCommitted);
  return tokens === null || refund === null ? null : { tokens, refund };
}

/** Fraction of each commit the batch spends when commits total `oversub` times the cap (a full fill spends the cap). */
export function spentFraction(oversub: number): number {
  return oversub <= 1 ? 1 : 1 / oversub;
}

/**
 * Splitting check (the property `splitting_across_wallets_gives_no_advantage` pins in math_tests.rs): the tokens a
 * committer receives from one commit c versus the same lamports split into k commits. Floors lose at most k - 1 base
 * units in total for the split, so splitting never gains.
 */
export function splitGain(commit: bigint, parts: number, total: bigint, tokensOut: bigint): bigint {
  const whole = proRata(tokensOut, commit, total) ?? 0n;
  const k = BigInt(parts);
  let split = 0n;
  for (let i = 0n; i < k; i++) {
    const piece = commit / k + (i < commit % k ? 1n : 0n);
    split += proRata(tokensOut, piece, total) ?? 0n;
  }
  return split - whole;
}

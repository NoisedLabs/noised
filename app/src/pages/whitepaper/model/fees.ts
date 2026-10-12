/**
 * Fee arithmetic for the whitepaper (section 9): the DBC base-fee scheduler exactly as the launchpad's policy mirrors
 * it (programs/noised-launchpad/src/policy.rs: linear and exponential modes, the exponential one with DBC's
 * floor-rounded Q64.64 square-and-multiply), the dynamic-fee cap of the presets (sdk dynamicFeeFor), and the fee
 * routing constants. Numerators are over DBC's FEE_DENOMINATOR = 1e9.
 */

export const FEE_DENOMINATOR = 1_000_000_000n;
export const MIN_FEE_NUMERATOR = 2_500_000n; // 0.25%
export const MAX_FEE_NUMERATOR = 990_000_000n; // 99%
/** Launchpad ceiling on floor base fee + largest dynamic fee: 10% (MAX_TRADING_FEE_BPS = 1,000). */
export const MAX_TRADING_FEE_BPS = 1_000;
/** Meteora DBC 0.2.1 protocol share of every trading fee (FACTS #28). */
export const DBC_PROTOCOL_SHARE_PCT = 20;
/** Largest platform share a Protocol account can hold (MAX_PLATFORM_FEE_BPS). */
export const MAX_PLATFORM_FEE_BPS = 5_000;
/** DAMM v2 fixed fee tier (bps) of each migration_fee_option 0..=5 (sdk constants). */
export const MIGRATION_FEE_TIERS_BPS: readonly number[] = [25, 30, 100, 200, 400, 600];

/** `cliff * (1 - reduction / 10_000)^periods` exactly as policy.rs::exponential_fee (and DBC) computes it. */
export function exponentialFee(cliff: bigint, reduction: bigint, periods: number): bigint | null {
  const ONE = 1n << 64n;
  const step = (reduction << 64n) / 10_000n;
  const base = ONE - step;
  if (base < 0n) return null;
  let result = ONE;
  let square = base;
  let e = periods;
  while (e > 0) {
    if (e & 1) result = (result * square) >> 64n;
    e >>= 1;
    if (e > 0) square = (square * square) >> 64n;
  }
  if (periods > 0 && result === 0n) return null;
  return (result * cliff) >> 64n;
}

export interface Schedule {
  mode: "linear" | "exponential";
  cliff: bigint;
  /** first_factor: number of periods. */
  periods: number;
  /** second_factor: seconds per period. */
  frequency: number;
  /** third_factor: linear decrement per period (numerator) or exponential reduction (bps). */
  reduction: bigint;
}

/** Base fee numerator `t` seconds after activation. */
export function baseFeeAt(s: Schedule, t: number): bigint {
  const elapsed = Math.max(0, Math.min(s.periods, Math.floor(t / s.frequency)));
  if (s.mode === "linear") return s.cliff - s.reduction * BigInt(elapsed);
  return exponentialFee(s.cliff, s.reduction, elapsed) ?? 0n;
}

export function scheduleDuration(s: Schedule): number {
  return s.periods * s.frequency;
}

/** The variable-fee cap of sdk `dynamicFeeFor(base, maxSharePct)`: maxSharePct% of the base fee. */
export function presetDynamicCap(baseFeeNumerator: bigint, maxSharePct = 20n): bigint {
  const maxVolatilityAccumulator = 14_460_000n;
  const squared = maxVolatilityAccumulator * maxVolatilityAccumulator;
  const target = (baseFeeNumerator * maxSharePct) / 100n;
  const VARIABLE_FEE_SCALE = 100_000_000_000n;
  const variableFeeControl = (target * VARIABLE_FEE_SCALE) / squared;
  // DBC: ceil((va * bin_step)^2 * vfc / 1e11) with bin_step = 1.
  const num = squared * variableFeeControl;
  return (num + VARIABLE_FEE_SCALE - 1n) / VARIABLE_FEE_SCALE;
}

export function pct(numerator: bigint): number {
  return (Number(numerator) / Number(FEE_DENOMINATOR)) * 100;
}

/**
 * Two example schedules that satisfy the launchpad policy for a 300-second commit window (the Fair preset's): both
 * fall from a 50% cliff to a 1% floor within 300 s, so the batch, which executes after the commit window, pays the
 * floor (plus at most the dynamic fee). Presets themselves use a flat 1-1.5% fee.
 */
export function exampleSchedules(openDelay = 300): { linear: Schedule; exponential: Schedule } {
  const periods = 30;
  const frequency = Math.floor(openDelay / periods);
  const cliff = 500_000_000n;
  const floor = 10_000_000n;
  // Linear: floor = cliff - periods * reduction.
  const linear: Schedule = { mode: "linear", cliff, periods, frequency, reduction: (cliff - floor) / BigInt(periods) };
  // Exponential: the largest reduction (bps) whose 30-period result stays >= the 1% floor.
  let r = 1n;
  for (let cand = 1n; cand < 10_000n; cand++) {
    const f = exponentialFee(cliff, cand, periods);
    if (f === null || f < floor) break;
    r = cand;
  }
  return { linear, exponential: { mode: "exponential", cliff, periods, frequency, reduction: r } };
}

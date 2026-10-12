/**
 * Client-side mirror of the launchpad safety policy
 * (programs/noised-launchpad/src/policy.rs + constants.rs, SPEC §1.2) and of
 * its payout math (math.rs).
 *
 * The on-chain `validate` stops at the first violation; `validateLaunchParams`
 * reports every violation as `"fieldName: message"` so a form can show them
 * all, but it accepts exactly the parameter sets the program accepts. Integer
 * arithmetic follows the Rust code, including its checked u64/u128
 * operations, so fee floors match bit for bit.
 */
import { PublicKey } from "@solana/web3.js";

import { isAllZero, isU128, isU64, isUint, U128_MAX, U16_MAX, U32_MAX, U64_MAX, U8_MAX } from "../codec/bytes.js";
import { DBC, POLICY } from "../constants.js";
import type { BaseFeeParams, DynamicFeeParams, FeeRecipient, LaunchParamsInput, LaunchState, ValidationResult } from "../types.js";

const BPS = BigInt(POLICY.BPS_DENOMINATOR);

/** `a * b` as u128, or null on overflow (Rust `checked_mul`). */
function mulU128(a: bigint, b: bigint): bigint | null {
  const p = a * b;
  return p > U128_MAX ? null : p;
}

/** `number_of_period * period_frequency`: seconds until the scheduler reaches its floor (u128, never overflows). */
export function feeScheduleDuration(fee: BaseFeeParams): bigint {
  return BigInt(fee.firstFactor) * fee.secondFactor;
}

/**
 * `cliff * (1 - reduction / 10_000)^periods` in Q64.64 fixed point with
 * DBC's floor-rounded square-and-multiply (least significant bit first), so
 * the result is bit-identical to `policy::exponential_fee`. Null where Rust
 * returns `None` (overflow, a power that underflows to zero, or > u64).
 */
export function exponentialFee(cliff: bigint, reduction: bigint, periods: number): bigint | null {
  const ONE = 1n << 64n;
  const step = (reduction << 64n) / BPS;
  if (step > ONE) return null; // ONE.checked_sub(step)
  const base = ONE - step;
  let result = ONE;
  let square = base;
  let exponent = periods;
  while (exponent > 0) {
    if ((exponent & 1) === 1) {
      const r = mulU128(result, square);
      if (r === null) return null;
      result = r >> 64n;
    }
    exponent >>= 1;
    if (exponent > 0) {
      const s = mulU128(square, square);
      if (s === null) return null;
      square = s >> 64n;
    }
  }
  if (periods > 0 && result === 0n) return null;
  const v = mulU128(result, cliff);
  if (v === null) return null;
  const out = v >> 64n;
  return out > U64_MAX ? null : out;
}

/** The scheduler's fee after its last period (what the batch pays). Null = DBC arithmetic error. */
export function minBaseFeeNumerator(fee: BaseFeeParams): bigint | null {
  const periods = BigInt(fee.firstFactor);
  if (fee.baseFeeMode === DBC.BASE_FEE_MODE_LINEAR) {
    const total = fee.thirdFactor * periods;
    if (total > U64_MAX) return null; // checked_mul
    const floor = fee.cliffFeeNumerator - total;
    return floor < 0n ? null : floor; // checked_sub
  }
  if (fee.baseFeeMode === DBC.BASE_FEE_MODE_EXPONENTIAL) {
    return exponentialFee(fee.cliffFeeNumerator, fee.thirdFactor, fee.firstFactor);
  }
  return null;
}

/** DBC's variable fee at the volatility cap: `ceil((mva * binStep)^2 * vfc / 1e11)`. Null on overflow. */
export function maxVariableFeeNumerator(d: DynamicFeeParams): bigint | null {
  const scaled = mulU128(BigInt(d.maxVolatilityAccumulator), BigInt(d.binStep));
  if (scaled === null) return null;
  const sq = mulU128(scaled, scaled);
  if (sq === null) return null;
  const withControl = mulU128(sq, BigInt(d.variableFeeControl));
  if (withControl === null) return null;
  const sum = withControl + DBC.VARIABLE_FEE_SCALE - 1n;
  if (sum > U128_MAX) return null;
  const fee = sum / DBC.VARIABLE_FEE_SCALE;
  return fee > U64_MAX ? null : fee;
}

/** Fee ceiling in fee-numerator units (`MAX_TRADING_FEE_BPS` of `FEE_DENOMINATOR`). */
export const TRADING_FEE_CEILING_NUMERATOR = (BigInt(POLICY.MAX_TRADING_FEE_BPS) * DBC.FEE_DENOMINATOR) / BPS;

/** `floor + dynamic <= MAX_TRADING_FEE_BPS`, compared in numerator units. */
export function withinFeeCeiling(floorFeeNumerator: bigint, maxDynamicFeeNumerator: bigint): boolean {
  return floorFeeNumerator + maxDynamicFeeNumerator <= TRADING_FEE_CEILING_NUMERATOR;
}

export function feeNumeratorToBps(n: bigint): number {
  return Number((n * BPS) / DBC.FEE_DENOMINATOR);
}

export function feeNumeratorToPercent(n: bigint): number {
  return (Number(n) / Number(DBC.FEE_DENOMINATOR)) * 100;
}

/** Fee facts derived from valid params (null when the fee params are invalid). */
export interface FeeSummary {
  cliffFeeNumerator: bigint;
  floorFeeNumerator: bigint;
  maxDynamicFeeNumerator: bigint;
  scheduleSecs: bigint;
}

export function feeSummary(p: Pick<LaunchParamsInput, "baseFee" | "dynamicFee">): FeeSummary | null {
  const floor = minBaseFeeNumerator(p.baseFee);
  if (floor === null) return null;
  const dyn = p.dynamicFee === null ? 0n : maxVariableFeeNumerator(p.dynamicFee);
  if (dyn === null) return null;
  return {
    cliffFeeNumerator: p.baseFee.cliffFeeNumerator,
    floorFeeNumerator: floor,
    maxDynamicFeeNumerator: dyn,
    scheduleSecs: feeScheduleDuration(p.baseFee),
  };
}

function fmtSol(lamports: bigint): string {
  const whole = lamports / POLICY.LAMPORTS_PER_SOL;
  const frac = lamports % POLICY.LAMPORTS_PER_SOL;
  return frac === 0n ? `${whole}` : `${whole}.${frac.toString().padStart(9, "0").replace(/0+$/, "")}`;
}

function isPublicKey(v: unknown): v is PublicKey {
  return v instanceof PublicKey;
}

/**
 * Validate everything a creator chose, exactly like `policy::validate`.
 * `forbidden` lists wallets that may not receive fees (the launch's own
 * launch-authority and batch-authority PDAs, once the launch seed is known;
 * `buildCreateLaunchTx` always passes them). The token's metadata is a
 * separate record: `validateTokenMeta`.
 */
export function validateLaunchParams(p: LaunchParamsInput, forbidden: readonly PublicKey[] = []): ValidationResult {
  const errors: string[] = [];
  const err = (field: string, message: string): void => {
    errors.push(`${field}: ${message}`);
  };

  // InvalidDecimals
  if (!isUint(p.tokenDecimal, U8_MAX) || p.tokenDecimal < POLICY.MIN_TOKEN_DECIMALS || p.tokenDecimal > POLICY.MAX_TOKEN_DECIMALS) {
    err("tokenDecimal", `must be between ${POLICY.MIN_TOKEN_DECIMALS} and ${POLICY.MAX_TOKEN_DECIMALS}`);
  }

  // InvalidThreshold
  const threshold = p.migrationQuoteThreshold;
  const thresholdOk = isU64(threshold) && threshold >= POLICY.MIN_THRESHOLD && threshold <= POLICY.MAX_THRESHOLD;
  if (!thresholdOk) {
    err("migrationQuoteThreshold", `must be between ${fmtSol(POLICY.MIN_THRESHOLD)} and ${fmtSol(POLICY.MAX_THRESHOLD)} SOL (in lamports)`);
  }

  // InvalidCurve: DBC start-price and curve-shape rules.
  const startOk = isU128(p.sqrtStartPrice) && p.sqrtStartPrice >= DBC.MIN_SQRT_PRICE && p.sqrtStartPrice < DBC.MAX_SQRT_PRICE;
  if (!startOk) err("sqrtStartPrice", `must be at least ${DBC.MIN_SQRT_PRICE} and below ${DBC.MAX_SQRT_PRICE}`);
  if (!Array.isArray(p.curve) || p.curve.length === 0 || p.curve.length > POLICY.MAX_CURVE_POINTS) {
    err("curve", `must have between 1 and ${POLICY.MAX_CURVE_POINTS} points`);
  }
  if (Array.isArray(p.curve)) {
    let previous: bigint | null = isU128(p.sqrtStartPrice) ? p.sqrtStartPrice : null;
    p.curve.forEach((point, i) => {
      const sp = point.sqrtPrice;
      if (!isU128(sp)) {
        err(`curve[${i}].sqrtPrice`, "must be a u128");
        previous = null;
      } else {
        if (previous !== null && sp <= previous) {
          err(`curve[${i}].sqrtPrice`, i === 0 ? "must be greater than sqrtStartPrice" : "must be greater than the previous point");
        }
        if (sp > DBC.MAX_SQRT_PRICE) err(`curve[${i}].sqrtPrice`, `must be at most ${DBC.MAX_SQRT_PRICE}`);
        previous = sp;
      }
      if (!isU128(point.liquidity) || point.liquidity === 0n) err(`curve[${i}].liquidity`, "must be greater than zero (u128)");
    });
  }

  // InvalidMigrationFeeOption
  if (!isUint(p.migrationFeeOption, DBC.MAX_MIGRATION_FEE_OPTION)) {
    err("migrationFeeOption", `must be one of the fixed DAMM v2 fee tiers 0..=${DBC.MAX_MIGRATION_FEE_OPTION}`);
  }

  // InvalidOpenDelay
  const openDelayOk = isUint(p.openDelaySecs, U32_MAX) && p.openDelaySecs >= POLICY.MIN_OPEN_DELAY && p.openDelaySecs <= POLICY.MAX_OPEN_DELAY;
  if (!openDelayOk) err("openDelaySecs", `must be between ${POLICY.MIN_OPEN_DELAY} and ${POLICY.MAX_OPEN_DELAY} seconds`);

  // InvalidGuard: guard in (open_delay + grace)..=72h
  if (!isUint(p.guardSecs, U32_MAX)) {
    err("guardSecs", "must be a whole number of seconds (u32)");
  } else if (isUint(p.openDelaySecs, U32_MAX)) {
    const shield = p.openDelaySecs + POLICY.EXECUTION_GRACE_SECS;
    if (shield > U32_MAX) err("guardSecs", "open delay plus the execution window overflows");
    else if (p.guardSecs < shield) {
      err("guardSecs", `must be at least the open delay plus the ${POLICY.EXECUTION_GRACE_SECS}s execution window (${shield}s)`);
    } else if (p.guardSecs > POLICY.MAX_GUARD_SECS) {
      err("guardSecs", `must be at most ${POLICY.MAX_GUARD_SECS} seconds (72 hours)`);
    }
  }

  // InvalidMaxWallet / InvalidMaxBuy
  if (!isUint(p.maxWalletBps, U16_MAX) || !(p.maxWalletBps === 0 || (p.maxWalletBps >= POLICY.MIN_MAX_WALLET_BPS && p.maxWalletBps <= POLICY.BPS_DENOMINATOR))) {
    err("maxWalletBps", `must be 0 (off) or between ${POLICY.MIN_MAX_WALLET_BPS} and ${POLICY.BPS_DENOMINATOR} bps`);
  }
  if (!isUint(p.maxBuyBps, U16_MAX) || p.maxBuyBps > POLICY.BPS_DENOMINATOR) {
    err("maxBuyBps", `must be 0 (off) or between 1 and ${POLICY.BPS_DENOMINATOR} bps`);
  }

  // InvalidBatchCap (`validate_batch_caps`): total 0 or threshold/10..=threshold;
  // wallet 0 or at least the resolved total cap / 200 (integer divisions).
  if (!isU64(p.batchWalletCap)) err("batchWalletCap", "must be a u64 amount of lamports (0 = no cap)");
  if (!isU64(p.batchTotalCap)) err("batchTotalCap", "must be a u64 amount of lamports (0 = the threshold)");
  else if (isU64(threshold)) {
    const minTotal = threshold / POLICY.MIN_BATCH_TOTAL_CAP_DIVISOR;
    if (p.batchTotalCap > threshold) err("batchTotalCap", "cannot exceed the migration threshold (0 means the threshold)");
    else if (p.batchTotalCap !== 0n && p.batchTotalCap < minTotal) {
      err("batchTotalCap", `must be 0 (the threshold) or at least 10% of the threshold (${fmtSol(minTotal)} SOL in lamports)`);
    } else if (isU64(p.batchWalletCap) && p.batchWalletCap !== 0n) {
      const resolved = p.batchTotalCap === 0n ? threshold : p.batchTotalCap;
      const minWallet = resolved / POLICY.MIN_BATCH_WALLET_CAP_DIVISOR;
      if (p.batchWalletCap < minWallet) {
        err("batchWalletCap", `must be 0 (no cap) or at least 1/200 of the batch's total cap (${fmtSol(minWallet)} SOL in lamports)`);
      }
    }
  }

  // Base fee: InvalidBaseFee / FeeScheduleTooLong
  let floor: bigint | null = null;
  const fee = p.baseFee;
  const feeShapeOk =
    typeof fee === "object" &&
    fee !== null &&
    isU64(fee.cliffFeeNumerator) &&
    isUint(fee.firstFactor, U16_MAX) &&
    isU64(fee.secondFactor) &&
    isU64(fee.thirdFactor) &&
    isUint(fee.baseFeeMode, U8_MAX);
  if (!feeShapeOk) {
    err("baseFee", "values are outside their integer ranges (cliff u64, periods u16, frequency u64, reduction u64, mode u8)");
  } else if (fee.baseFeeMode !== DBC.BASE_FEE_MODE_LINEAR && fee.baseFeeMode !== DBC.BASE_FEE_MODE_EXPONENTIAL) {
    err("baseFee.baseFeeMode", "must be 0 (linear scheduler) or 1 (exponential scheduler)");
  } else {
    const anySet = fee.firstFactor !== 0 || fee.secondFactor !== 0n || fee.thirdFactor !== 0n;
    const allSet = fee.firstFactor !== 0 && fee.secondFactor !== 0n && fee.thirdFactor !== 0n;
    let scheduleOk = true;
    if (anySet && !allSet) {
      err("baseFee", "a fee schedule needs periods (firstFactor), period length (secondFactor) and reduction (thirdFactor) all set, or all zero for a flat fee");
      scheduleOk = false;
    }
    if (fee.baseFeeMode === DBC.BASE_FEE_MODE_EXPONENTIAL && fee.thirdFactor >= BPS) {
      err("baseFee.thirdFactor", "exponential reduction must be below 10,000 bps");
      scheduleOk = false;
    }
    if (scheduleOk) {
      floor = minBaseFeeNumerator(fee);
      if (floor === null) {
        err("baseFee", "the schedule reduces the fee below zero (DBC arithmetic error)");
      } else {
        if (fee.cliffFeeNumerator > DBC.MAX_FEE_NUMERATOR) err("baseFee.cliffFeeNumerator", "must be at most 99% (990,000,000)");
        if (floor < DBC.MIN_FEE_NUMERATOR) err("baseFee", "the fee after the schedule must be at least 0.25% (2,500,000)");
        const duration = feeScheduleDuration(fee);
        if (openDelayOk && duration > BigInt(p.openDelaySecs)) {
          err("baseFee", `the fee schedule (${duration}s) must end before the batch executes (open delay ${p.openDelaySecs}s)`);
        }
        if (fee.cliffFeeNumerator > DBC.MAX_FEE_NUMERATOR || floor < DBC.MIN_FEE_NUMERATOR) floor = null;
      }
    }
  }

  // Dynamic fee: InvalidDynamicFee
  let maxDynamic: bigint | null = 0n;
  if (p.dynamicFee !== null) {
    const d = p.dynamicFee;
    const shapeOk =
      typeof d === "object" &&
      d !== null &&
      isUint(d.binStep, U16_MAX) &&
      isU128(d.binStepU128) &&
      isUint(d.filterPeriod, U16_MAX) &&
      isUint(d.decayPeriod, U16_MAX) &&
      isUint(d.reductionFactor, U16_MAX) &&
      isUint(d.maxVolatilityAccumulator, U32_MAX) &&
      isUint(d.variableFeeControl, U32_MAX);
    if (!shapeOk) {
      err("dynamicFee", "values are outside their integer ranges");
      maxDynamic = null;
    } else {
      let ok = true;
      if (d.binStep !== DBC.DYNAMIC_BIN_STEP || d.binStepU128 !== DBC.DYNAMIC_BIN_STEP_U128) {
        err("dynamicFee.binStep", `DBC only accepts a bin step of 1 bps (binStepU128 ${DBC.DYNAMIC_BIN_STEP_U128})`);
        ok = false;
      }
      if (d.filterPeriod >= d.decayPeriod) {
        err("dynamicFee.filterPeriod", "must be shorter than the decay period");
        ok = false;
      }
      if (d.reductionFactor > POLICY.BPS_DENOMINATOR) {
        err("dynamicFee.reductionFactor", "must be at most 10,000 bps");
        ok = false;
      }
      if (d.variableFeeControl > DBC.U24_MAX) {
        err("dynamicFee.variableFeeControl", `must be at most ${DBC.U24_MAX}`);
        ok = false;
      }
      if (d.maxVolatilityAccumulator > DBC.U24_MAX) {
        err("dynamicFee.maxVolatilityAccumulator", `must be at most ${DBC.U24_MAX}`);
        ok = false;
      }
      maxDynamic = ok ? maxVariableFeeNumerator(d) : null;
      if (ok && maxDynamic === null) err("dynamicFee", "the maximum variable fee overflows");
    }
  }

  // FeeTooHigh
  if (floor !== null && maxDynamic !== null && !withinFeeCeiling(floor, maxDynamic)) {
    const total = ((floor + maxDynamic) * BPS) / DBC.FEE_DENOMINATOR;
    err("baseFee", `fee after the schedule plus the maximum dynamic fee is ${Number(total) / 100}%, above the ${POLICY.MAX_TRADING_FEE_BPS / 100}% ceiling`);
  }

  // InvalidRecipients
  validateRecipients(p.recipients, forbidden, err);

  // InvalidPqIdentity: every launch names the identity that must attest it.
  if (!(p.pqIdentity instanceof Uint8Array) || p.pqIdentity.length !== 32) {
    err("pqIdentity", "must be the 32-byte id of the creator's post-quantum identity (SHA-256(0x21 || LMS public key))");
  } else if (isAllZero(p.pqIdentity)) {
    err("pqIdentity", "cannot be all zero: no key is behind it, so the launch could never be attested");
  }
  return { ok: errors.length === 0, errors };
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** False when `s` holds a lone UTF-16 surrogate (it has no UTF-8 encoding; TextEncoder would sign U+FFFD instead). */
export function isWellFormedText(s: string): boolean {
  return !LONE_SURROGATE.test(s);
}

function validateRecipients(
  recipients: readonly FeeRecipient[],
  forbidden: readonly PublicKey[],
  err: (field: string, message: string) => void,
): void {
  if (!Array.isArray(recipients) || recipients.length === 0 || recipients.length > POLICY.MAX_RECIPIENTS) {
    err("recipients", `must list between 1 and ${POLICY.MAX_RECIPIENTS} wallets`);
    if (!Array.isArray(recipients)) return;
  }
  let total = 0;
  recipients.forEach((r, i) => {
    if (!isPublicKey(r.wallet)) err(`recipients[${i}].wallet`, "must be a PublicKey");
    else if (r.wallet.equals(PublicKey.default)) err(`recipients[${i}].wallet`, "cannot be the default (all-zero) address");
    else if (forbidden.some((f) => f.equals(r.wallet))) err(`recipients[${i}].wallet`, "cannot be one of this launch's own program addresses");
    else if (recipients.slice(0, i).some((q) => isPublicKey(q.wallet) && q.wallet.equals(r.wallet))) err(`recipients[${i}].wallet`, "is listed twice");
    if (!isUint(r.bps, U16_MAX) || r.bps === 0) err(`recipients[${i}].bps`, "must be between 1 and 65,535 (u16) and the shares must total 10,000");
    else total += r.bps;
  });
  if (recipients.length > 0 && total !== POLICY.BPS_DENOMINATOR) {
    err("recipients", `shares must add up to 10,000 bps (100%); they add up to ${total}`);
  }
}

// The metadata limits (`policy::validate_metadata`: flags, document, name, symbol, external uri) are checked
// on the whole record by `validateTokenMeta` (`../metadata/record.ts`), in the program's order.

// ------------------------------------------------------- launch window ---
// The window and clock helpers (`launchWindowIsValid`, `launchWindowProblems`, `inLaunchWindow`,
// `validateLaunchWindow`, `defaultLaunchWindow`, `unixNowSecs`, `clusterUnixTime`) live in `./window.ts`.

// ---------------------------------------------------------------- math ---

/** `supply * bps / 10_000` rounded down; null where a non-zero bps rounds to zero (`policy::cap_from_bps`). */
export function capFromBps(supply: bigint, bps: number): bigint | null {
  if (bps === 0) return 0n;
  const cap = (supply * BigInt(bps)) / BPS;
  return cap > 0n && cap <= U64_MAX ? cap : null;
}

/** `amount * part / total` rounded down; null if `total` is zero or `part > total` (`math::pro_rata`). */
export function proRata(amount: bigint, part: bigint, total: bigint): bigint | null {
  if (total === 0n || part > total) return null;
  const v = (amount * part) / total;
  return v > U64_MAX ? null : v;
}

/** Pro-rata batch payout of one commit (`math::batch_share`). */
export function batchShare(
  commit: bigint,
  totalCommitted: bigint,
  quoteSpent: bigint,
  tokensOut: bigint,
): { tokens: bigint; refund: bigint } | null {
  if (quoteSpent > totalCommitted) return null;
  const tokens = proRata(tokensOut, commit, totalCommitted);
  const refund = proRata(totalCommitted - quoteSpent, commit, totalCommitted);
  return tokens === null || refund === null ? null : { tokens, refund };
}

/** What the fair-open batch spends and refunds (`expectedBatchFill`). */
export interface BatchFill {
  /** Total committed, including `extraCommit`. */
  totalCommitted: bigint;
  /** `batch_total_cap`: the most the batch swap spends. */
  cap: bigint;
  /** wSOL the batch spends: `min(total, cap)` while pending (an upper bound: a swap that completes the curve can spend less), `quote_spent` once executed. */
  fill: bigint;
  /** More was committed than the cap: every commit is filled pro rata and the rest refunded at claim. */
  oversubscribed: boolean;
  /** Share of every commit that is spent, in bps, rounded down (10,000 = all of it). */
  fillBps: number;
  /**
   * The commit of `existingCommit + extraCommit` lamports, with `claim`'s
   * rounding: `refund = floor((total - fill) * commit / total)` (at least
   * that while pending), `spent = commit - refund`, and `tokens` once
   * executed (`floor(tokens_out * commit / total)`; null while pending).
   */
  commit: { amount: bigint; spent: bigint; refund: bigint; tokens: bigint | null };
  /** Exact (executed batch) or estimated from the cap (pending batch). */
  exact: boolean;
}

/**
 * Pro-rata fill of the fair-open batch. `commit` never refuses an amount
 * above the total cap: `execute_batch` swaps `min(total_committed,
 * batch_total_cap)` and every commit gets the same share of it, the rest
 * back at claim (`math::batch_share`). Pass `extraCommit` to see the effect
 * of a commit about to be made, and `existingCommit` for the owner's commit
 * so far. An expired batch (never executed) refunds every commit in full.
 */
export function expectedBatchFill(
  launch: Pick<LaunchState, "totalCommitted" | "batchTotalCap" | "executed" | "quoteSpent" | "tokensOut">,
  extraCommit = 0n,
  existingCommit = 0n,
): BatchFill {
  if (!isU64(extraCommit) || !isU64(existingCommit)) throw new RangeError("commit amounts must be u64 lamports");
  if (launch.executed && extraCommit > 0n) throw new RangeError("the batch has executed: it takes no more commits");
  const total = launch.totalCommitted + extraCommit;
  const amount = existingCommit + extraCommit;
  if (amount > total) throw new RangeError("the commit is larger than the total committed");
  const fill = launch.executed ? launch.quoteSpent : total < launch.batchTotalCap ? total : launch.batchTotalCap;
  if (fill > total) throw new RangeError("inconsistent batch accounting: spent more than was committed");
  const refund = total === 0n ? 0n : ((total - fill) * amount) / total;
  return {
    totalCommitted: total,
    cap: launch.batchTotalCap,
    fill,
    oversubscribed: total > launch.batchTotalCap,
    fillBps: total === 0n ? POLICY.BPS_DENOMINATOR : Number((fill * BPS) / total),
    commit: { amount, spent: amount - refund, refund, tokens: launch.executed && total > 0n ? (launch.tokensOut * amount) / total : null },
    exact: launch.executed,
  };
}

/** Fee routing of one `distribute` (`math::split_fees`); recipient shares in stored order. */
export function splitFees(
  balance: bigint,
  platformBps: number,
  recipients: readonly { bps: number }[],
): { platform: bigint; recipients: bigint[] } | null {
  if (recipients.length === 0 || recipients.length > POLICY.MAX_RECIPIENTS || platformBps > POLICY.BPS_DENOMINATOR) return null;
  const platform = proRata(balance, BigInt(platformBps), BPS);
  if (platform === null) return null;
  const creatorShare = balance - platform;
  const out: bigint[] = [];
  let paid = 0n;
  for (let i = 0; i < recipients.length; i++) {
    if (i === recipients.length - 1) {
      if (paid > creatorShare) return null;
      out.push(creatorShare - paid);
    } else {
      const v = proRata(creatorShare, BigInt(recipients[i]!.bps), BPS);
      if (v === null) return null;
      out.push(v);
      paid += v;
    }
  }
  return { platform, recipients: out };
}

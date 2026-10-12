/**
 * validateLaunchParams accepts and rejects exactly what
 * programs/noised-launchpad/src/policy.rs does: every case of the Rust
 * `policy_tests.rs` is mirrored here (same baseline `good_params`), plus the
 * fee math of `schedule_tests.rs` and the payout math of `math_tests.rs`.
 */
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { DBC, POLICY } from "../src/constants.js";
import {
  batchShare,
  capFromBps,
  expectedBatchFill,
  exponentialFee,
  feeScheduleDuration,
  maxVariableFeeNumerator,
  minBaseFeeNumerator,
  proRata,
  splitFees,
  validateLaunchParams,
} from "../src/launch/policy.js";
import { validateTokenMeta } from "../src/metadata/record.js";
import { batchOutcome, launchPhase, PRESETS } from "../src/launch/presets.js";
import { unixNowSecs } from "../src/launch/window.js";
import type { BaseFeeParams, CurvePoint, DynamicFeeParams, FeeRecipient, LaunchParamsInput } from "../src/types.js";

const key = (b: number): PublicKey => new PublicKey(new Uint8Array(32).fill(b));
const FORBIDDEN = [key(0xa1), key(0xb2)];
const SOL = POLICY.LAMPORTS_PER_SOL;

/** `good_params()` of programs/noised-launchpad/src/tests/mod.rs (the metadata is a separate record now). */
function good(): LaunchParamsInput {
  return {
    tokenDecimal: 6,
    sqrtStartPrice: 1n << 60n,
    curve: [
      { sqrtPrice: 1n << 62n, liquidity: 1n << 90n },
      { sqrtPrice: 1n << 63n, liquidity: 1n << 89n },
    ],
    migrationQuoteThreshold: 85n * SOL,
    baseFee: { cliffFeeNumerator: 500_000_000n, firstFactor: 10, secondFactor: 1n, thirdFactor: 49_000_000n, baseFeeMode: 0 },
    dynamicFee: null,
    migrationFeeOption: 2,
    openDelaySecs: 60,
    guardSecs: 3_600,
    maxWalletBps: 100,
    maxBuyBps: 50,
    p2pLocked: false,
    batchWalletCap: 0n,
    batchTotalCap: 0n,
    recipients: [
      { wallet: key(7), bps: 7_000 },
      { wallet: key(8), bps: 3_000 },
    ],
    pqIdentity: new Uint8Array(32).fill(0x1d),
  };
}

function dynamic(): DynamicFeeParams {
  return {
    binStep: 1,
    binStepU128: DBC.DYNAMIC_BIN_STEP_U128,
    filterPeriod: 10,
    decayPeriod: 120,
    reductionFactor: 5_000,
    maxVolatilityAccumulator: 14_460_000,
    variableFeeControl: 956,
  };
}

function withP(f: (p: LaunchParamsInput) => void): LaunchParamsInput {
  const p = good();
  f(p);
  return p;
}

function accepts(f: (p: LaunchParamsInput) => void): void {
  const r = validateLaunchParams(withP(f), FORBIDDEN);
  expect(r.errors).toEqual([]);
  expect(r.ok).toBe(true);
}

/** Rejected, with at least one error on `field` (the "fieldName: message" prefix). */
function rejects(field: string, f: (p: LaunchParamsInput) => void): void {
  const r = validateLaunchParams(withP(f), FORBIDDEN);
  expect(r.ok).toBe(false);
  expect(r.errors.some((e) => e.startsWith(`${field}`)), `${JSON.stringify(r.errors)} should mention ${field}`).toBe(true);
  for (const e of r.errors) expect(e).toMatch(/^[A-Za-z][\w.[\]]*: \S/);
}

const point = (s: bigint): CurvePoint => ({ sqrtPrice: s, liquidity: 1n });
const flat = (p: LaunchParamsInput, numerator: bigint): void => {
  p.baseFee = { cliffFeeNumerator: numerator, firstFactor: 0, secondFactor: 0n, thirdFactor: 0n, baseFeeMode: 0 };
};

describe("validateLaunchParams mirrors policy.rs", () => {
  it("accepts the baseline", () => accepts(() => {}));

  it("token_decimal 6..=9 (InvalidDecimals)", () => {
    rejects("tokenDecimal", (p) => (p.tokenDecimal = 5));
    accepts((p) => (p.tokenDecimal = 6));
    accepts((p) => (p.tokenDecimal = 9));
    rejects("tokenDecimal", (p) => (p.tokenDecimal = 10));
    rejects("tokenDecimal", (p) => (p.tokenDecimal = 6.5));
  });

  it("migration_quote_threshold 1..=100,000 SOL (InvalidThreshold)", () => {
    rejects("migrationQuoteThreshold", (p) => (p.migrationQuoteThreshold = POLICY.MIN_THRESHOLD - 1n));
    accepts((p) => (p.migrationQuoteThreshold = POLICY.MIN_THRESHOLD));
    accepts((p) => (p.migrationQuoteThreshold = POLICY.MAX_THRESHOLD));
    rejects("migrationQuoteThreshold", (p) => (p.migrationQuoteThreshold = POLICY.MAX_THRESHOLD + 1n));
    rejects("migrationQuoteThreshold", (p) => (p.migrationQuoteThreshold = 0n));
  });

  it("curve shape (InvalidCurve)", () => {
    rejects("curve", (p) => (p.curve = []));
    expect(POLICY.MAX_CURVE_POINTS).toBe(8);
    accepts((p) => (p.curve = Array.from({ length: POLICY.MAX_CURVE_POINTS }, (_, i) => point((1n << 61n) * BigInt(i + 1)))));
    rejects("curve", (p) => (p.curve = Array.from({ length: POLICY.MAX_CURVE_POINTS + 1 }, (_, i) => point((1n << 61n) * BigInt(i + 1)))));
    rejects("curve[0].sqrtPrice", (p) => (p.curve[0]!.sqrtPrice = p.sqrtStartPrice));
    accepts((p) => (p.curve[0]!.sqrtPrice = p.sqrtStartPrice + 1n));
    rejects("curve[1].sqrtPrice", (p) => (p.curve[1]!.sqrtPrice = p.curve[0]!.sqrtPrice));
    rejects("curve[1].sqrtPrice", (p) => (p.curve[1]!.sqrtPrice = p.curve[0]!.sqrtPrice - 1n));
    rejects("curve[0].liquidity", (p) => (p.curve[0]!.liquidity = 0n));
    rejects("curve[1].liquidity", (p) => (p.curve[1]!.liquidity = 0n));
    accepts((p) => (p.curve[1]!.sqrtPrice = DBC.MAX_SQRT_PRICE));
    rejects("curve[1].sqrtPrice", (p) => (p.curve[1]!.sqrtPrice = DBC.MAX_SQRT_PRICE + 1n));
    rejects("sqrtStartPrice", (p) => (p.sqrtStartPrice = DBC.MIN_SQRT_PRICE - 1n));
    accepts((p) => {
      p.sqrtStartPrice = DBC.MIN_SQRT_PRICE;
      p.curve[0]!.sqrtPrice = DBC.MIN_SQRT_PRICE + 1n;
    });
    rejects("sqrtStartPrice", (p) => {
      p.sqrtStartPrice = DBC.MAX_SQRT_PRICE;
      p.curve = [point(DBC.MAX_SQRT_PRICE)];
    });
    rejects("curve[0].liquidity", (p) => (p.curve[0]!.liquidity = 1n << 128n));
  });

  it("migration_fee_option 0..=5 (InvalidMigrationFeeOption)", () => {
    for (let o = 0; o <= 5; o++) accepts((p) => (p.migrationFeeOption = o));
    rejects("migrationFeeOption", (p) => (p.migrationFeeOption = 6));
    rejects("migrationFeeOption", (p) => (p.migrationFeeOption = 255));
  });

  it("open_delay_secs 60..=1800 (InvalidOpenDelay)", () => {
    expect([POLICY.MIN_OPEN_DELAY, POLICY.EXECUTION_GRACE_SECS]).toEqual([60, 600]);
    for (const short of [0, 1, 10, 30, 59]) rejects("openDelaySecs", (p) => (p.openDelaySecs = short));
    rejects("openDelaySecs", (p) => (p.openDelaySecs = POLICY.MIN_OPEN_DELAY - 1));
    accepts((p) => {
      p.openDelaySecs = POLICY.MIN_OPEN_DELAY;
      p.baseFee.firstFactor = 10;
    });
    accepts((p) => (p.openDelaySecs = POLICY.MAX_OPEN_DELAY));
    rejects("openDelaySecs", (p) => (p.openDelaySecs = POLICY.MAX_OPEN_DELAY + 1));
  });

  it("guard_secs (open delay + 600)..=72h (InvalidGuard)", () => {
    rejects("guardSecs", (p) => (p.guardSecs = 659));
    accepts((p) => (p.guardSecs = 660));
    accepts((p) => {
      p.openDelaySecs = POLICY.MAX_OPEN_DELAY;
      p.guardSecs = POLICY.MAX_OPEN_DELAY + POLICY.EXECUTION_GRACE_SECS;
    });
    rejects("guardSecs", (p) => {
      p.openDelaySecs = POLICY.MAX_OPEN_DELAY;
      p.guardSecs = POLICY.MAX_OPEN_DELAY + POLICY.EXECUTION_GRACE_SECS - 1;
    });
    rejects("guardSecs", (p) => (p.guardSecs = p.openDelaySecs + POLICY.EXECUTION_GRACE_SECS - 1));
    accepts((p) => (p.guardSecs = p.openDelaySecs + POLICY.EXECUTION_GRACE_SECS));
    accepts((p) => (p.guardSecs = POLICY.MAX_GUARD_SECS));
    rejects("guardSecs", (p) => (p.guardSecs = POLICY.MAX_GUARD_SECS + 1));
    rejects("guardSecs", (p) => (p.guardSecs = 0));
  });

  it("max_wallet_bps 0 or 10..=10000 (InvalidMaxWallet)", () => {
    accepts((p) => (p.maxWalletBps = 0));
    rejects("maxWalletBps", (p) => (p.maxWalletBps = 1));
    rejects("maxWalletBps", (p) => (p.maxWalletBps = POLICY.MIN_MAX_WALLET_BPS - 1));
    accepts((p) => (p.maxWalletBps = POLICY.MIN_MAX_WALLET_BPS));
    accepts((p) => (p.maxWalletBps = 10_000));
    rejects("maxWalletBps", (p) => (p.maxWalletBps = 10_001));
  });

  it("max_buy_bps 0..=10000 (InvalidMaxBuy)", () => {
    accepts((p) => (p.maxBuyBps = 0));
    accepts((p) => (p.maxBuyBps = 1));
    accepts((p) => (p.maxBuyBps = 10_000));
    rejects("maxBuyBps", (p) => (p.maxBuyBps = 10_001));
  });

  it("batch caps (InvalidBatchCap): total 0 or threshold/10..=threshold, wallet 0 or >= resolved/200", () => {
    const threshold = 85n * SOL;
    accepts((p) => (p.batchTotalCap = 0n));
    accepts((p) => (p.batchTotalCap = threshold));
    rejects("batchTotalCap", (p) => (p.batchTotalCap = threshold + 1n));
    accepts((p) => (p.batchTotalCap = threshold - 1n));
    accepts((p) => (p.batchTotalCap = threshold / 10n));
    accepts((p) => (p.batchTotalCap = threshold / 10n + 1n));
    rejects("batchTotalCap", (p) => (p.batchTotalCap = threshold / 10n - 1n));
    rejects("batchTotalCap", (p) => (p.batchTotalCap = 1n));
    rejects("batchTotalCap", (p) => (p.batchTotalCap = (1n << 64n) - 1n));
    accepts((p) => (p.batchWalletCap = 0n));
    accepts((p) => (p.batchWalletCap = threshold / 200n));
    accepts((p) => (p.batchWalletCap = threshold / 200n + 1n));
    rejects("batchWalletCap", (p) => (p.batchWalletCap = threshold / 200n - 1n));
    rejects("batchWalletCap", (p) => (p.batchWalletCap = 1n));
    accepts((p) => (p.batchWalletCap = (1n << 64n) - 1n));
    // Measured against the resolved total cap, not the threshold.
    accepts((p) => {
      p.batchTotalCap = threshold / 10n;
      p.batchWalletCap = threshold / 2_000n;
    });
    rejects("batchWalletCap", (p) => {
      p.batchTotalCap = threshold / 10n;
      p.batchWalletCap = threshold / 2_000n - 1n;
    });
    accepts((p) => {
      p.batchTotalCap = threshold / 10n;
      p.batchWalletCap = threshold;
    });
    rejects("batchWalletCap", (p) => (p.batchWalletCap = 1n << 64n));
    rejects("batchTotalCap", (p) => (p.batchTotalCap = -1n));
  });

  it("batch-cap floors match their definition (batch_cap_floors_match_their_definition)", () => {
    // A non-zero total cap c needs 10c + 9 >= threshold and c <= threshold; a
    // non-zero wallet cap w needs 200w + 199 >= the resolved total cap.
    let seed = 31n;
    const next = (): bigint => {
      seed = (seed * 6_364_136_223_846_793_005n + 1_442_695_040_888_963_407n) & ((1n << 64n) - 1n);
      return seed >> 11n;
    };
    const below = (n: bigint): bigint => next() % n;
    const near = (x: bigint): bigint => (x >= 2n ? x - 2n : 0n) + below(5n);
    for (let i = 0; i < 5_000; i++) {
      const threshold = POLICY.MIN_THRESHOLD + below(POLICY.MAX_THRESHOLD - POLICY.MIN_THRESHOLD + 1n);
      const pick = below(5n);
      const total = pick === 0n ? 0n : pick === 1n ? near(threshold / 10n) : pick === 2n ? near(threshold) : pick === 3n ? below(threshold + 2n) : next();
      const resolved = total === 0n ? threshold : total;
      const wpick = below(4n);
      const wallet = wpick === 0n ? 0n : wpick === 1n ? near(resolved / 200n) : wpick === 2n ? below(resolved + 1n) : next();
      const totalOk = total === 0n || (10n * total + 9n >= threshold && total <= threshold);
      const walletOk = wallet === 0n || 200n * wallet + 199n >= resolved;
      const r = validateLaunchParams(withP((p) => Object.assign(p, { migrationQuoteThreshold: threshold, batchTotalCap: total, batchWalletCap: wallet })), FORBIDDEN);
      expect(r.ok, `threshold ${threshold}, total ${total}, wallet ${wallet}`).toBe(totalOk && walletOk);
    }
  });

  it("pq_identity must be named: 32 bytes, never all zero (InvalidPqIdentity)", () => {
    rejects("pqIdentity", (p) => (p.pqIdentity = new Uint8Array(32)));
    for (let i = 0; i < 32; i++) {
      accepts((p) => {
        p.pqIdentity = new Uint8Array(32);
        p.pqIdentity[i] = 1;
      });
    }
    accepts((p) => (p.pqIdentity = new Uint8Array(32).fill(0xff)));
    rejects("pqIdentity", (p) => (p.pqIdentity = new Uint8Array(31).fill(1)));
    rejects("pqIdentity", (p) => ((p as { pqIdentity: unknown }).pqIdentity = undefined));
    // Other faults are reported too.
    const r = validateLaunchParams(withP((p) => Object.assign(p, { pqIdentity: new Uint8Array(32), tokenDecimal: 5 })), FORBIDDEN);
    expect(r.errors.map((e) => e.split(":")[0])).toEqual(["tokenDecimal", "pqIdentity"]);
  });

  it("base fee mode and shape (InvalidBaseFee)", () => {
    rejects("baseFee.baseFeeMode", (p) => (p.baseFee.baseFeeMode = 2));
    rejects("baseFee.baseFeeMode", (p) => (p.baseFee.baseFeeMode = 3));
    rejects("baseFee", (p) => (p.baseFee.secondFactor = 0n));
    rejects("baseFee", (p) => (p.baseFee.firstFactor = 0));
    rejects("baseFee", (p) => (p.baseFee.thirdFactor = 0n));
    accepts((p) => flat(p, 10_000_000n));
  });

  it("base fee numerator bounds (InvalidBaseFee)", () => {
    accepts((p) => (p.baseFee.thirdFactor = (500_000_000n - DBC.MIN_FEE_NUMERATOR) / 10n));
    rejects("baseFee", (p) => flat(p, DBC.MIN_FEE_NUMERATOR - 1n));
    rejects("baseFee", (p) => (p.baseFee.thirdFactor = 50_000_001n));
    rejects("baseFee", (p) => {
      p.baseFee.cliffFeeNumerator = 500_000_000n;
      p.baseFee.thirdFactor = (500_000_000n - DBC.MIN_FEE_NUMERATOR) / 10n + 1n;
    });
    accepts((p) => {
      p.baseFee.cliffFeeNumerator = DBC.MAX_FEE_NUMERATOR;
      p.baseFee.thirdFactor = (DBC.MAX_FEE_NUMERATOR - 10_000_000n) / 10n;
    });
    rejects("baseFee.cliffFeeNumerator", (p) => {
      p.baseFee.cliffFeeNumerator = DBC.MAX_FEE_NUMERATOR + 1n;
      p.baseFee.thirdFactor = (DBC.MAX_FEE_NUMERATOR + 1n - 10_000_000n) / 10n;
    });
  });

  it("exponential base fee (InvalidBaseFee)", () => {
    accepts((p) => {
      p.baseFee.baseFeeMode = 1;
      p.baseFee.thirdFactor = 3_000n;
    });
    rejects("baseFee.thirdFactor", (p) => {
      p.baseFee.baseFeeMode = 1;
      p.baseFee.thirdFactor = 10_000n;
    });
    rejects("baseFee.thirdFactor", (p) => {
      p.baseFee.baseFeeMode = 1;
      p.baseFee.thirdFactor = 10_001n;
    });
    rejects("baseFee", (p) => {
      p.baseFee.baseFeeMode = 1;
      p.baseFee.thirdFactor = 6_000n;
    });
  });

  it("the fee schedule ends before the batch (FeeScheduleTooLong)", () => {
    expect(good().openDelaySecs).toBe(60);
    accepts((p) => {
      p.baseFee.firstFactor = 10;
      p.baseFee.secondFactor = 6n;
    });
    rejects("baseFee", (p) => {
      p.baseFee.firstFactor = 10;
      p.baseFee.secondFactor = 7n;
    });
    rejects("baseFee", (p) => {
      p.baseFee.firstFactor = 1;
      p.baseFee.secondFactor = (1n << 64n) - 1n;
      p.baseFee.thirdFactor = 1n;
    });
    accepts((p) => {
      p.openDelaySecs = POLICY.MAX_OPEN_DELAY;
      p.guardSecs = POLICY.MAX_GUARD_SECS;
      p.baseFee.firstFactor = 600;
      p.baseFee.secondFactor = 3n;
      p.baseFee.thirdFactor = 800_000n;
    });
  });

  it("floor + max dynamic fee <= 10% (FeeTooHigh)", () => {
    accepts((p) => flat(p, 100_000_000n));
    rejects("baseFee", (p) => flat(p, 100_000_001n));
    accepts((p) => {
      p.baseFee.cliffFeeNumerator = 990_000_000n;
      p.baseFee.thirdFactor = 98_000_000n;
    });
    accepts((p) => {
      flat(p, 10_000_000n);
      p.dynamicFee = dynamic();
    });
    rejects("baseFee", (p) => {
      flat(p, 99_000_000n);
      p.dynamicFee = dynamic();
    });
    rejects("baseFee", (p) => (p.dynamicFee = { ...dynamic(), variableFeeControl: DBC.U24_MAX }));
  });

  it("dynamic fee mirrors DBC (InvalidDynamicFee)", () => {
    expect(maxVariableFeeNumerator(dynamic())).toBe(1_998_916n);
    const bad = (field: string, f: (d: DynamicFeeParams) => void): void =>
      rejects(field, (p) => {
        const d = dynamic();
        f(d);
        p.dynamicFee = d;
      });
    bad("dynamicFee.binStep", (d) => (d.binStep = 2));
    bad("dynamicFee.binStep", (d) => (d.binStepU128 += 1n));
    bad("dynamicFee.filterPeriod", (d) => (d.filterPeriod = d.decayPeriod));
    bad("dynamicFee.reductionFactor", (d) => (d.reductionFactor = 10_001));
    bad("dynamicFee.variableFeeControl", (d) => (d.variableFeeControl = DBC.U24_MAX + 1));
    bad("dynamicFee.maxVolatilityAccumulator", (d) => (d.maxVolatilityAccumulator = DBC.U24_MAX + 1));
    accepts((p) => (p.dynamicFee = { ...dynamic(), reductionFactor: 10_000, filterPeriod: 0, decayPeriod: 1 }));
  });

  it("recipients (InvalidRecipients)", () => {
    const r = (b: number, bps: number): FeeRecipient => ({ wallet: key(b), bps });
    rejects("recipients", (p) => (p.recipients = []));
    accepts((p) => (p.recipients = [r(1, 10_000)]));
    accepts((p) => (p.recipients = [r(1, 2_500), r(2, 2_500), r(3, 2_500), r(4, 2_500)]));
    rejects("recipients", (p) => (p.recipients = [r(1, 2_000), r(2, 2_000), r(3, 2_000), r(4, 2_000), r(5, 2_000)]));
    rejects("recipients", (p) => (p.recipients = [r(1, 9_999)]));
    rejects("recipients", (p) => (p.recipients = [r(1, 10_001)]));
    rejects("recipients[1].wallet", (p) => (p.recipients = [r(1, 5_000), r(1, 5_000)]));
    rejects("recipients[0].wallet", (p) => (p.recipients = [r(0, 10_000)]));
    rejects("recipients[1].bps", (p) => (p.recipients = [r(1, 10_000), r(2, 0)]));
    rejects("recipients[0].wallet", (p) => (p.recipients = [r(0xa1, 10_000)]));
    rejects("recipients[1].wallet", (p) => (p.recipients = [r(1, 5_000), r(0xb2, 5_000)]));
    rejects("recipients", (p) => (p.recipients = [r(1, 65_535), r(2, 10_000)]));
    rejects("recipients[0].bps", (p) => (p.recipients = [r(1, 65_536)]));
  });

  it("metadata limits (the record's, checked by publish_metadata) are not launch parameters any more", () => {
    expect(validateTokenMeta({ name: "n".repeat(32), symbol: "s".repeat(10) }).ok).toBe(true);
    expect(validateTokenMeta({ name: "a", symbol: "b", uri: "" }).ok).toBe(true);
    expect(validateTokenMeta({ name: "", symbol: "b" }).ok).toBe(false);
    expect(validateTokenMeta({ name: "a", symbol: "" }).ok).toBe(false);
    expect(validateTokenMeta({ name: "n".repeat(33), symbol: "b" }).ok).toBe(false);
    expect(validateTokenMeta({ name: "a", symbol: "s".repeat(11) }).ok).toBe(false);
    // Lengths are UTF-8 bytes, like Rust's str::len.
    expect(validateTokenMeta({ name: "é".repeat(16), symbol: "b" }).ok).toBe(true);
    expect(validateTokenMeta({ name: "é".repeat(17), symbol: "b" }).ok).toBe(false);
    // Launch parameters carrying the old fields are judged on the parameters alone.
    expect(validateLaunchParams({ ...good(), ...{ name: "", symbol: "", uri: "u".repeat(201) } } as LaunchParamsInput, FORBIDDEN).errors).toEqual([]);
  });

  it("every preset passes once recipients are added", () => {
    for (const preset of Object.values(PRESETS)) {
      const p: LaunchParamsInput = { ...preset.params, recipients: [{ wallet: key(9), bps: 10_000 }], pqIdentity: new Uint8Array(32).fill(1) };
      expect(validateLaunchParams(p).errors, preset.name).toEqual([]);
    }
    expect(Object.isFrozen(PRESETS.fair.params.curve)).toBe(true);
  });

  it("acceptance does not depend on how many errors are reported", () => {
    // Random mutations: ok must be exactly "no error", whatever else fails.
    let seed = 12345;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let i = 0; i < 500; i++) {
      const p = good();
      if (rnd(3) === 0) p.tokenDecimal = rnd(12);
      if (rnd(3) === 0) p.openDelaySecs = rnd(2_000);
      if (rnd(3) === 0) p.guardSecs = rnd(4_000);
      if (rnd(3) === 0) p.maxWalletBps = rnd(30);
      if (rnd(3) === 0) p.baseFee.secondFactor = BigInt(rnd(5));
      const r = validateLaunchParams(p, FORBIDDEN);
      expect(r.ok).toBe(r.errors.length === 0);
    }
  });
});

describe("fee schedule math (schedule_tests.rs)", () => {
  const fee = (mode: number, cliff: bigint, periods: number, frequency: bigint, reduction: bigint): BaseFeeParams => ({
    cliffFeeNumerator: cliff,
    firstFactor: periods,
    secondFactor: frequency,
    thirdFactor: reduction,
    baseFeeMode: mode,
  });

  it("schedule duration is periods x frequency", () => {
    expect(feeScheduleDuration(fee(0, 1n, 0, 0n, 0n))).toBe(0n);
    expect(feeScheduleDuration(fee(0, 1n, 10, 3n, 1n))).toBe(30n);
    expect(feeScheduleDuration(fee(1, 1n, 600, 3n, 1n))).toBe(1_800n);
    expect(feeScheduleDuration(fee(0, 1n, 65_535, (1n << 64n) - 1n, 1n))).toBe(65_535n * ((1n << 64n) - 1n));
  });

  it("linear floor", () => {
    expect(minBaseFeeNumerator(fee(0, 500_000_000n, 10, 1n, 49_000_000n))).toBe(10_000_000n);
    expect(minBaseFeeNumerator(fee(0, 500_000_000n, 0, 0n, 0n))).toBe(500_000_000n);
    expect(minBaseFeeNumerator(fee(0, 500_000_000n, 10, 1n, 50_000_001n))).toBeNull();
    expect(minBaseFeeNumerator(fee(0, 1n, 65_535, 1n, (1n << 64n) - 1n))).toBeNull();
    expect(minBaseFeeNumerator(fee(2, 1n, 0, 0n, 0n))).toBeNull();
  });

  it("exponential exact values (bit-identical to DBC)", () => {
    expect(exponentialFee(123_456_789n, 0n, 0)).toBe(123_456_789n);
    expect(exponentialFee(123_456_789n, 5_000n, 0)).toBe(123_456_789n);
    expect(exponentialFee(1_000_000_000n, 5_000n, 1)).toBe(500_000_000n);
    expect(exponentialFee(1_000_000_000n, 5_000n, 2)).toBe(250_000_000n);
    expect(exponentialFee(1_000_000_000n, 5_000n, 3)).toBe(125_000_000n);
    expect(exponentialFee(1_000_000_000n, 7_500n, 2)).toBe(62_500_000n);
    expect(exponentialFee(1_000_000_000n, 10_000n, 1)).toBeNull();
    expect(exponentialFee(1_000_000_000n, 10_001n, 1)).toBeNull();
    expect(exponentialFee(990_000_000n, 9_999n, 65_535)).toBeNull();
  });

  it("exponential matches real math and is monotone", () => {
    let s = 77;
    const rnd = (n: number): number => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s % n;
    };
    for (let i = 0; i < 2_000; i++) {
      const cliff = 2_500_000n + BigInt(rnd(987_000_000));
      const reduction = BigInt(1 + rnd(9_998));
      const periods = rnd(400);
      const got = exponentialFee(cliff, reduction, periods);
      if (got === null) continue;
      const real = Number(cliff) * (1 - Number(reduction) / 10_000) ** periods;
      expect(Math.abs(Number(got) - real)).toBeLessThanOrEqual(1 + real * 1e-9);
      if (periods > 0) expect(got <= exponentialFee(cliff, reduction, periods - 1)!).toBe(true);
    }
  });

  it("variable fee at the volatility cap", () => {
    const d = (va: number, vfc: number): DynamicFeeParams => ({ ...dynamic(), maxVolatilityAccumulator: va, variableFeeControl: vfc });
    expect(maxVariableFeeNumerator(d(0, DBC.U24_MAX))).toBe(0n);
    expect(maxVariableFeeNumerator(d(1, 1))).toBe(1n);
    expect(maxVariableFeeNumerator(d(100_000, 10))).toBe(1n);
  });
});

describe("payout math (math_tests.rs)", () => {
  it("pro_rata edges", () => {
    const MAX = (1n << 64n) - 1n;
    expect(proRata(100n, 1n, 3n)).toBe(33n);
    expect(proRata(100n, 3n, 3n)).toBe(100n);
    expect(proRata(0n, 1n, 3n)).toBe(0n);
    expect(proRata(MAX, MAX, MAX)).toBe(MAX);
    expect(proRata(MAX, 1n, MAX)).toBe(1n);
    expect(proRata(100n, 1n, 0n)).toBeNull();
    expect(proRata(100n, 4n, 3n)).toBeNull();
  });

  it("batch shares", () => {
    expect(batchShare(1n, 10n, 11n, 5n)).toBeNull();
    expect(batchShare(5n, 10n, 4n, 1_000n)).toEqual({ tokens: 500n, refund: 3n });
    expect(batchShare(777n, 777n, 700n, 123_456n)).toEqual({ tokens: 123_456n, refund: 77n });
    const whole = batchShare(600_001n, 1_000_003n, 999_999n, 98_765_431n)!;
    const a = batchShare(300_000n, 1_000_003n, 999_999n, 98_765_431n)!;
    const b = batchShare(300_001n, 1_000_003n, 999_999n, 98_765_431n)!;
    expect(a.tokens + b.tokens <= whole.tokens).toBe(true);
    expect(a.refund + b.refund <= whole.refund).toBe(true);
  });

  it("fee split examples", () => {
    const rs = (bps: number[]): { bps: number }[] => bps.map((b) => ({ bps: b }));
    expect(splitFees(1_000_000n, 2_000, rs([7_000, 3_000]))).toEqual({ platform: 200_000n, recipients: [560_000n, 240_000n] });
    expect(splitFees(101n, 3_333, rs([3_334, 3_333, 3_333]))).toEqual({ platform: 33n, recipients: [22n, 22n, 24n] });
    expect(splitFees(7n, 0, rs([10_000]))).toEqual({ platform: 0n, recipients: [7n] });
    expect(splitFees(7n, 5_000, rs([10_000]))).toEqual({ platform: 3n, recipients: [4n] });
    expect(splitFees(10n, 0, [])).toBeNull();
    expect(splitFees(10n, 0, rs([2_000, 2_000, 2_000, 2_000, 2_000]))).toBeNull();
    expect(splitFees(10n, 10_001, rs([10_000]))).toBeNull();
  });

  it("expected batch fill: min(total, cap) is spent, every commit pro rata, the rest refunded", () => {
    const pending = { totalCommitted: 30n * SOL, batchTotalCap: 10n * SOL, executed: false, quoteSpent: 0n, tokensOut: 0n };
    // Oversubscribed 3x: a third of every commit is spent.
    const f = expectedBatchFill(pending, 6n * SOL);
    expect(f).toMatchObject({ totalCommitted: 36n * SOL, cap: 10n * SOL, fill: 10n * SOL, oversubscribed: true, fillBps: 2_777, exact: false });
    // claim's rounding: refund = floor((total - fill) * commit / total); spent = the rest.
    expect(f.commit).toEqual({ amount: 6n * SOL, refund: (26n * SOL * 6n * SOL) / (36n * SOL), spent: 6n * SOL - (26n * SOL * 6n * SOL) / (36n * SOL), tokens: null });
    // The owner's earlier commit counts in its share.
    expect(expectedBatchFill(pending, 1n * SOL, 2n * SOL).commit.amount).toBe(3n * SOL);
    // Under the cap: everything is spent.
    const under = expectedBatchFill({ ...pending, totalCommitted: 4n * SOL }, 1n * SOL);
    expect(under).toMatchObject({ fill: 5n * SOL, oversubscribed: false, fillBps: 10_000 });
    expect(under.commit).toEqual({ amount: 1n * SOL, spent: 1n * SOL, refund: 0n, tokens: null });
    // Executed: exactly what claim pays (math::batch_share).
    const done = { totalCommitted: 1_000_003n, batchTotalCap: 999_999n, executed: true, quoteSpent: 999_999n, tokensOut: 98_765_431n };
    const exact = expectedBatchFill(done, 0n, 300_001n);
    expect(exact.exact).toBe(true);
    expect({ tokens: exact.commit.tokens, refund: exact.commit.refund }).toEqual(batchShare(300_001n, 1_000_003n, 999_999n, 98_765_431n));
    expect(() => expectedBatchFill(done, 1n)).toThrow(/executed/);
    expect(() => expectedBatchFill(pending, 0n, 31n * SOL)).toThrow(/larger than the total/);
    expect(() => expectedBatchFill(pending, -1n)).toThrow(/u64/);
    expect(expectedBatchFill({ ...pending, totalCommitted: 0n })).toMatchObject({ fill: 0n, fillBps: 10_000, commit: { amount: 0n, spent: 0n, refund: 0n } });
  });

  it("hook caps from bps (cap_from_bps)", () => {
    expect(capFromBps(1_000_000n, 0)).toBe(0n);
    expect(capFromBps(1_000_000n, 10)).toBe(1_000n);
    expect(capFromBps(1_000_000n, 10_000)).toBe(1_000_000n);
    expect(capFromBps(999n, 10)).toBeNull();
    expect(capFromBps((1n << 64n) - 1n, 10_000)).toBe((1n << 64n) - 1n);
  });
});

describe("launchPhase (PQ v2 timeline)", () => {
  const l = { status: "live" as const, commitEndTs: 1_060n, executeEndTs: 1_660n, guardEndTs: 5_000n };
  it("the execution phase lasts ten minutes, but ends as soon as the batch executes (the shield ends with it)", () => {
    expect(l.executeEndTs - l.commitEndTs).toBe(BigInt(POLICY.EXECUTION_GRACE_SECS));
    expect(launchPhase(l, 1_059n)).toBe("commit");
    expect(launchPhase(l, 1_060n)).toBe("execute");
    expect(launchPhase({ ...l, executed: false }, 1_659n)).toBe("execute");
    expect(launchPhase({ ...l, executed: true }, 1_061n)).toBe("guarded");
    expect(launchPhase(l, 1_660n)).toBe("guarded");
    expect(launchPhase(l, 5_000n)).toBe("open");
    expect(launchPhase({ ...l, status: "configured" }, 0n)).toBe("configured");
  });

  it("one type for now: bigint unix seconds; a number or milliseconds is refused, never silently compared (SDK v2 follow-up)", () => {
    const b = { ...l, executed: false, totalCommitted: 5n };
    expect(batchOutcome(b, 1_659n)).toBe("pending");
    expect(batchOutcome(b, 1_660n)).toBe("expired");
    expect(batchOutcome({ ...b, totalCommitted: 0n }, 1_660n)).toBe("empty");
    expect(batchOutcome({ ...b, executed: true }, 0n)).toBe("executed");
    // `1_059 < 1_060n` is true in JavaScript: a number used to be compared silently. Now it is a TypeError.
    for (const n of [1_059, Number.NaN]) {
      expect(() => launchPhase(l, n as unknown as bigint)).toThrow(TypeError);
      expect(() => batchOutcome(b, n as unknown as bigint)).toThrow(TypeError);
    }
    // Date.now() milliseconds would read as "open" forever.
    expect(() => launchPhase(l, BigInt(Date.now()))).toThrow(/milliseconds/);
    expect(() => batchOutcome(b, BigInt(Date.now()))).toThrow(/milliseconds/);
    expect(launchPhase(l, unixNowSecs())).toBe("open");
    expect(unixNowSecs(5_000_999)).toBe(5_000n);
  });
});

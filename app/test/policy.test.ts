/**
 * The Create wizard's contract with the SDK's `validateLaunchParams` (through
 * the adapter): presets pass, and every violation comes back as
 * "fieldName: message" with the field names the wizard maps to its inputs
 * and steps (src/pages/create/draft.ts). The policy's own exactness against
 * policy.rs is tested in sdk/test/policy.test.ts.
 */
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { formatSolExact, formatUnits, parsePercentToBps, parseUnits, tryParseUnits } from "../src/lib/amounts";
import { batchShare, dynamicFeeFor, estimateSupply, POLICY, PRESETS, splitFees, validateLaunchParams, validateTokenMeta, type LaunchParamsInput, type PresetName } from "../src/lib/noised";

const A = new PublicKey("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
const B = new PublicKey("4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T");

function input(preset: PresetName = "fair", patch: Partial<LaunchParamsInput> = {}): LaunchParamsInput {
  return { ...PRESETS[preset].params, recipients: [{ wallet: A, bps: 10_000 }], pqIdentity: new Uint8Array(32).fill(1), ...patch };
}

const fieldsOf = (p: LaunchParamsInput): string[] => validateLaunchParams(p).errors.map((e) => e.split(":")[0] ?? "");

describe("presets", () => {
  for (const name of Object.keys(PRESETS) as PresetName[]) {
    it(`${name} passes the safety policy`, () => {
      const v = validateLaunchParams(input(name));
      expect(v.errors).toEqual([]);
      expect(v.ok).toBe(true);
    });
  }

  it("curves hold exactly the threshold at the graduation price", () => {
    const p = PRESETS.fair.params;
    const est = estimateSupply(p.sqrtStartPrice, p.curve, p.migrationQuoteThreshold);
    expect(est).not.toBeNull();
    const grad = p.curve[0]?.sqrtPrice ?? 0n;
    const migration = est?.migrationSqrtPrice ?? 0n;
    // Liquidity is rounded down, so the threshold is reached at (or a hair past) the first point.
    expect(migration).toBeGreaterThanOrEqual(grad);
    expect(Number(migration - grad) / Number(grad)).toBeLessThan(1e-9);
    expect(migration).toBeLessThanOrEqual(p.curve[1]?.sqrtPrice ?? 0n);
    // ~776M tokens (6 decimals) sold on the fair curve: realistic DBC numbers.
    expect(Number(est?.curveBase ?? 0n) / 1e6).toBeGreaterThan(5e8);
    expect(Number(est?.curveBase ?? 0n) / 1e6).toBeLessThan(1e9);
  });
});

describe("validateLaunchParams mirrors policy.rs", () => {
  it("formats every error as 'fieldName: message'", () => {
    const v = validateLaunchParams(input("fair", { tokenDecimal: 5, openDelaySecs: 5 }));
    expect(v.ok).toBe(false);
    for (const e of v.errors) expect(e).toMatch(/^[A-Za-z][\w.[\]]*: \S/);
    expect(fieldsOf(input("fair", { tokenDecimal: 5 }))).toContain("tokenDecimal");
  });

  it("enforces the metadata record's byte limits (SDK 0.4.0: the record's, not the parameters')", () => {
    const fields = (m: { name: string; symbol: string; uri?: string }): string[] => validateTokenMeta(m).errors.map((e) => e.split(":")[0] ?? "");
    expect(fields({ name: "Aegis", symbol: "AEGS" })).toEqual([]);
    expect(fields({ name: "", symbol: "AEGS" })).toContain("name");
    expect(fields({ name: "x".repeat(33), symbol: "AEGS" })).toContain("name");
    expect(fields({ name: "é".repeat(16), symbol: "AEGS" })).toEqual([]);
    expect(fields({ name: "é".repeat(17), symbol: "AEGS" })).toContain("name");
    expect(fields({ name: "Aegis", symbol: "ABCDEFGHIJK" })).toContain("symbol");
    // No uri without a uri mode (the app never sets one: the mint's link stays empty).
    expect(fields({ name: "Aegis", symbol: "AEGS", uri: "ipfs://bafy" })).toContain("uri");
  });

  it("bounds decimals, threshold, open delay and guard", () => {
    expect(fieldsOf(input("fair", { tokenDecimal: 5 }))).toContain("tokenDecimal");
    expect(fieldsOf(input("fair", { tokenDecimal: 10 }))).toContain("tokenDecimal");
    expect(fieldsOf(input("fair", { migrationQuoteThreshold: 999_999_999n }))).toContain("migrationQuoteThreshold");
    expect(fieldsOf(input("fair", { migrationQuoteThreshold: 100_000_000_000_001n }))).toContain("migrationQuoteThreshold");
    // PQ v2: a batch window of at least 60 s, and a 600 s execution window after it.
    expect(POLICY.MIN_OPEN_DELAY).toBe(60);
    expect(POLICY.EXECUTION_GRACE_SECS).toBe(600);
    expect(fieldsOf(input("fair", { openDelaySecs: POLICY.MIN_OPEN_DELAY - 1 }))).toContain("openDelaySecs");
    expect(fieldsOf(input("fair", { openDelaySecs: 1801, guardSecs: 4000 }))).toContain("openDelaySecs");
    // guard >= open delay + the execution window, <= 72 h
    expect(fieldsOf(input("fair", { openDelaySecs: 300, guardSecs: 300 + POLICY.EXECUTION_GRACE_SECS - 1 }))).toContain("guardSecs");
    expect(fieldsOf(input("fair", { openDelaySecs: 300, guardSecs: 300 + POLICY.EXECUTION_GRACE_SECS }))).toEqual([]);
    expect(fieldsOf(input("fair", { guardSecs: 72 * 3600 + 1 }))).toContain("guardSecs");
  });

  it("bounds max wallet, max buy and batch caps", () => {
    expect(fieldsOf(input("fair", { maxWalletBps: 9 }))).toContain("maxWalletBps");
    expect(fieldsOf(input("fair", { maxWalletBps: 0 }))).toEqual([]);
    expect(fieldsOf(input("fair", { maxWalletBps: 10_001 }))).toContain("maxWalletBps");
    expect(fieldsOf(input("fair", { maxBuyBps: 1 }))).toEqual([]);
    expect(fieldsOf(input("fair", { maxBuyBps: 10_001 }))).toContain("maxBuyBps");
    const t = PRESETS.fair.params.migrationQuoteThreshold;
    expect(fieldsOf(input("fair", { batchTotalCap: t }))).toEqual([]);
    expect(fieldsOf(input("fair", { batchTotalCap: t + 1n }))).toContain("batchTotalCap");
  });

  it("checks the curve shape like DBC", () => {
    const p = PRESETS.fair.params;
    expect(fieldsOf(input("fair", { curve: [] }))).toContain("curve");
    expect(fieldsOf(input("fair", { sqrtStartPrice: 4_295_048_015n }))).toContain("sqrtStartPrice");
    const first = p.curve[0];
    if (!first) throw new Error("preset curve empty");
    expect(fieldsOf(input("fair", { curve: [{ sqrtPrice: p.sqrtStartPrice, liquidity: 1n }] }))).toContain("curve[0].sqrtPrice");
    expect(fieldsOf(input("fair", { curve: [{ ...first, liquidity: 0n }] }))).toContain("curve[0].liquidity");
    expect(fieldsOf(input("fair", { curve: [first, first] }))).toContain("curve[1].sqrtPrice");
    // At most 8 points (programs/noised-launchpad constants.rs): a 16-point create_launch does not fit a legacy transaction.
    expect(POLICY.MAX_CURVE_POINTS).toBe(8);
    const points = (n: number) => Array.from({ length: n }, (_, i) => ({ sqrtPrice: p.sqrtStartPrice + BigInt(i + 1), liquidity: 1n }));
    expect(fieldsOf(input("fair", { curve: points(8) }))).not.toContain("curve");
    expect(fieldsOf(input("fair", { curve: points(9) }))).toContain("curve");
  });

  it("requires the fee schedule to end before the batch and the floor to stay >= 0.25%", () => {
    const flat = { cliffFeeNumerator: 10_000_000n, firstFactor: 0, secondFactor: 0n, thirdFactor: 0n, baseFeeMode: 0 };
    expect(fieldsOf(input("fair", { baseFee: flat }))).toEqual([]);
    // 30 periods of 11 s = 330 s > 300 s open delay
    expect(fieldsOf(input("fair", { baseFee: { cliffFeeNumerator: 50_000_000n, firstFactor: 30, secondFactor: 11n, thirdFactor: 1_000_000n, baseFeeMode: 0 } }))).toContain("baseFee");
    expect(fieldsOf(input("fair", { baseFee: { cliffFeeNumerator: 50_000_000n, firstFactor: 30, secondFactor: 10n, thirdFactor: 1_000_000n, baseFeeMode: 0 } }))).toEqual([]);
    // partially configured schedule
    expect(fieldsOf(input("fair", { baseFee: { ...flat, firstFactor: 3 } }))).toContain("baseFee");
    // floor below 0.25 %
    expect(fieldsOf(input("fair", { baseFee: { ...flat, cliffFeeNumerator: 2_499_999n } }))).toContain("baseFee");
    // exponential reduction must be < 10 000 bps
    expect(fieldsOf(input("fair", { baseFee: { cliffFeeNumerator: 50_000_000n, firstFactor: 2, secondFactor: 10n, thirdFactor: 10_000n, baseFeeMode: 1 } }))).toContain("baseFee.thirdFactor");
    expect(fieldsOf(input("fair", { baseFee: { ...flat, baseFeeMode: 2 } }))).toContain("baseFee.baseFeeMode");
  });

  it("caps floor fee + maximum dynamic fee at 10%", () => {
    const nine = { cliffFeeNumerator: 90_000_000n, firstFactor: 0, secondFactor: 0n, thirdFactor: 0n, baseFeeMode: 0 };
    expect(fieldsOf(input("fair", { baseFee: nine, dynamicFee: null }))).toEqual([]);
    expect(fieldsOf(input("fair", { baseFee: nine, dynamicFee: dynamicFeeFor(90_000_000n, 20n) }))).toContain("baseFee");
    expect(fieldsOf(input("fair", { baseFee: { ...nine, cliffFeeNumerator: 100_000_001n }, dynamicFee: null }))).toContain("baseFee");
  });

  it("validates the dynamic fee like DBC", () => {
    const d = dynamicFeeFor(10_000_000n);
    expect(fieldsOf(input("fair", { dynamicFee: { ...d, binStep: 2 } }))).toContain("dynamicFee.binStep");
    expect(fieldsOf(input("fair", { dynamicFee: { ...d, filterPeriod: 120 } }))).toContain("dynamicFee.filterPeriod");
    expect(fieldsOf(input("fair", { dynamicFee: { ...d, reductionFactor: 10_001 } }))).toContain("dynamicFee.reductionFactor");
    expect(fieldsOf(input("fair", { dynamicFee: { ...d, variableFeeControl: 0x1000000 } }))).toContain("dynamicFee.variableFeeControl");
    expect(fieldsOf(input("fair", { dynamicFee: { ...d, maxVolatilityAccumulator: 0x1000000 } }))).toContain("dynamicFee.maxVolatilityAccumulator");
  });

  it("checks fee recipients", () => {
    expect(fieldsOf(input("fair", { recipients: [] }))).toContain("recipients");
    expect(fieldsOf(input("fair", { recipients: [{ wallet: PublicKey.default, bps: 10_000 }] }))).toContain("recipients[0].wallet");
    expect(fieldsOf(input("fair", { recipients: [{ wallet: A, bps: 5_000 }, { wallet: A, bps: 5_000 }] }))).toContain("recipients[1].wallet");
    expect(fieldsOf(input("fair", { recipients: [{ wallet: A, bps: 5_000 }, { wallet: B, bps: 4_999 }] }))).toContain("recipients");
    expect(fieldsOf(input("fair", { recipients: [{ wallet: A, bps: 0 }, { wallet: B, bps: 10_000 }] }))).toContain("recipients[0].bps");
    expect(fieldsOf(input("fair", { recipients: [A, B, A, B, A].map((w, i) => ({ wallet: i < 2 ? w : new PublicKey(i + 7), bps: 2_000 })) }))).toContain("recipients");
    // create_launch refuses the launch's own authority PDAs as recipients (the SDK's optional second argument).
    expect(validateLaunchParams(input("fair", { recipients: [{ wallet: A, bps: 10_000 }] }), [A]).errors[0]).toMatch(/^recipients\[0\]\.wallet: /);
  });
});

describe("payout math the batch panel shows", () => {
  it("batch shares round down and never exceed the escrow", () => {
    const total = 1_000_000_007n;
    const spent = 900_000_000n;
    const out = 123_456_789_012n;
    let tokens = 0n;
    let refund = 0n;
    for (const c of [1n, 333_333_335n, 666_666_671n]) {
      const share = batchShare(c, total, spent, out);
      expect(share).not.toBeNull();
      tokens += share?.tokens ?? 0n;
      refund += share?.refund ?? 0n;
    }
    expect(tokens).toBeLessThanOrEqual(out);
    expect(refund).toBeLessThanOrEqual(total - spent);
    expect(batchShare(2n, 1n, 0n, 10n)).toBeNull();
  });

  it("fee split gives the remainder to the last recipient", () => {
    const split = splitFees(1_000_003n, 2_000, [{ bps: 3_333 }, { bps: 6_667 }]);
    expect(split).not.toBeNull();
    expect((split?.platform ?? 0n) + (split?.recipients.reduce((x, y) => x + y, 0n) ?? 0n)).toBe(1_000_003n);
  });
});

describe("amount parsing (no floating point)", () => {
  it("parses and formats exactly", () => {
    expect(parseUnits("1.25", 9)).toBe(1_250_000_000n);
    expect(parseUnits(".5", 6)).toBe(500_000n);
    expect(() => parseUnits("1e3", 6)).toThrow();
    expect(() => parseUnits("1.0000001", 6)).toThrow();
    expect(() => parseUnits("-1", 6)).toThrow();
    expect(tryParseUnits("", 6)).toBeNull();
    expect(formatUnits(1_234_567_890n, 6)).toBe("1,234.56789");
    expect(parsePercentToBps("2.5")).toBe(250);
    expect(() => parsePercentToBps("100.01")).toThrow();
  });

  it("shows caps and thresholds exactly, never rounded down", () => {
    expect(formatSolExact(2_500_000_000n)).toBe("2.5 SOL");
    expect(formatSolExact(500_000_000n)).toBe("0.5 SOL");
    expect(formatSolExact(40_000_000_000n)).toBe("40 SOL");
    expect(formatSolExact(1_000_000_001n)).toBe("1.000000001 SOL");
    expect(formatSolExact(123_456_789_000_000n)).toBe("123,456.789 SOL");
  });
});

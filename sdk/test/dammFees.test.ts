/**
 * The DAMM v2 fee model of the verifier (`src/verify/dammFees.ts`) against
 * Meteora's six migration configs as read from mainnet
 * (`vectors/damm_v2_migration_configs.json`), DAMM v2's own arithmetic
 * (`get_variable_fee`, `get_total_fee_numerator`) and the launchpad's Rust
 * known answers for the same variable-fee formula (`schedule_tests.rs`).
 */
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { DAMM_V2_MIGRATION_CONFIGS, MIGRATION_FEE_TIERS_BPS, PROGRAM_IDS } from "../src/constants.js";
import { decodeDammPool } from "../src/meteora/state.js";
import {
  compareDammPoolFee,
  DAMM_V2_MIGRATION_POOL_FEES,
  DAMM_V2_MIGRATION_VARIABLE_FEE_CONTROL,
  dammFeePercent,
  dammMaxFeeNumerator,
  dammMaxVariableFeeNumerator,
  dammTotalFeeNumerator,
  dammVariableFeeNumerator,
} from "../src/verify/dammFees.js";
import { DAMM_CONFIGS, decodeDammConfig, pristinePoolFees } from "./verifyFixtures.js";
import { accountBytes, zeroed } from "./world.js";

const U24_MAX = (1 << 24) - 1;
const dyn = (maxVolatilityAccumulator: number, variableFeeControl: number, binStep = 1) => ({ initialized: 1, maxVolatilityAccumulator, variableFeeControl, binStep });

/** A DAMM v2 pool as DBC's migration through fee option `option` creates it, encoded and decoded through the IDL. */
function pristinePool(option: number, mutate: (poolFees: Record<string, unknown>, pool: Record<string, unknown>) => void = () => {}) {
  const pool = zeroed("dammV2", "Pool");
  pool["feeVersion"] = 1; // Pool::initialize: CURRENT_POOL_VERSION
  pristinePoolFees(pool["poolFees"] as Record<string, unknown>, option, 1n << 64n);
  mutate(pool["poolFees"] as Record<string, unknown>, pool);
  return decodeDammPool(accountBytes("dammV2", "Pool", pool));
}

describe("the canonical migration pool fees are the mainnet configs'", () => {
  it("six configs: owner DAMM v2, addresses DAMM_V2_MIGRATION_CONFIGS, base fee = the tier, static", () => {
    expect(DAMM_CONFIGS.map((c) => c.address)).toEqual(DAMM_V2_MIGRATION_CONFIGS.map((k) => k.toBase58()));
    expect(DAMM_CONFIGS.every((c) => new PublicKey(c.owner).equals(PROGRAM_IDS.dammV2))).toBe(true);
    expect(DAMM_V2_MIGRATION_POOL_FEES.length).toBe(6);
    for (const v of DAMM_CONFIGS) {
      const cfg = decodeDammConfig(v).poolFees;
      const e = DAMM_V2_MIGRATION_POOL_FEES[v.option]!;
      expect(e.config.toBase58()).toBe(v.address);
      expect(e.tierBps).toBe(MIGRATION_FEE_TIERS_BPS[v.option]);
      expect(e.tierBps).toBe(v.tierBps);
      expect([...cfg.baseFee.data]).toEqual([...e.baseFeeInfo]);
      expect(e.cliffFeeNumerator).toBe(BigInt(v.tierBps) * 100_000n);
      const d = cfg.dynamicFee;
      expect({
        initialized: d.initialized,
        maxVolatilityAccumulator: d["maxVolatilityAccumulator"],
        variableFeeControl: d["variableFeeControl"],
        binStep: d["binStep"],
        filterPeriod: d["filterPeriod"],
        decayPeriod: d["decayPeriod"],
        reductionFactor: d["reductionFactor"],
        binStepU128: d["binStepU128"],
      }).toEqual(e.dynamicFee);
      expect([cfg.protocolFeePercent, cfg.referralFeePercent, cfg.compoundingFeeBps]).toEqual([e.protocolFeePercent, e.referralFeePercent, e.compoundingFeeBps]);
    }
    // Every canonical config carries an ENABLED dynamic fee: the source of the audit's false operator change.
    expect(DAMM_V2_MIGRATION_POOL_FEES.every((f) => f.dynamicFee.initialized === 1)).toBe(true);
    expect(DAMM_V2_MIGRATION_VARIABLE_FEE_CONTROL).toEqual([239, 286, 956, 1_913, 3_826, 5_739]);
  });

  it("their dynamic fee adds about 20% of the tier: +5, +6, +20, +40, +80, +120 bps at the volatility cap", () => {
    const bps = DAMM_V2_MIGRATION_POOL_FEES.map((f) => Math.round(Number(dammMaxVariableFeeNumerator(f.dynamicFee)!) / 100_000));
    expect(bps).toEqual([5, 6, 20, 40, 80, 120]);
    // 6% tier: 60,000,000 + ceil(14,460,000^2 * 5,739 / 1e11) = ceil(11,999,766.924) = 71,999,767 of 1e9.
    expect(dammMaxVariableFeeNumerator(DAMM_V2_MIGRATION_POOL_FEES[5]!.dynamicFee)).toBe(11_999_767n);
    expect(dammFeePercent(60_000_000n + 11_999_767n)).toBe("7.1999767%");
  });
});

describe("DAMM v2 fee arithmetic", () => {
  it("get_variable_fee: the launchpad's Rust known answers for the same formula (ceil to 1e9 units)", () => {
    expect(dammMaxVariableFeeNumerator(dyn(0, U24_MAX))).toBe(0n);
    expect(dammMaxVariableFeeNumerator(dyn(1, 1))).toBe(1n); // rounds up
    expect(dammMaxVariableFeeNumerator(dyn(100_000, 10))).toBe(1n);
    expect(dammMaxVariableFeeNumerator(dyn(1_000_000, 100))).toBe(1_000n);
    expect(dammMaxVariableFeeNumerator(dyn(14_460_000, 956))).toBe(1_998_916n);
    const u24 = BigInt(U24_MAX);
    expect(dammMaxVariableFeeNumerator(dyn(U24_MAX, U24_MAX))).toBe((u24 ** 3n + 99_999_999_999n) / 100_000_000_000n);
  });

  it("no dynamic fee charges nothing whatever its parameters; the accumulator, not its cap, prices a trade; u128 overflow is an error", () => {
    expect(dammMaxVariableFeeNumerator({ ...dyn(14_460_000, 5_739), initialized: 0 })).toBe(0n);
    expect(dammVariableFeeNumerator(dyn(14_460_000, 956), 0n)).toBe(0n);
    expect(dammVariableFeeNumerator(dyn(14_460_000, 956), 1_000_000n)).toBe(9_560n); // 1e12 * 956 / 1e11, exact
    expect(dammVariableFeeNumerator(dyn(14_460_000, 956), 1_000n)).toBe(1n); // 1e6 * 956 / 1e11 = 0.00956, rounded up
    expect(dammVariableFeeNumerator(dyn(0, 1, 1 << 16), 1n << 64n)).toBeNull(); // (2^80)^2 > u128
  });

  it("the total is capped at the pool's fee_version maximum (50% v0, 99% v1)", () => {
    expect([dammMaxFeeNumerator(0), dammMaxFeeNumerator(1), dammMaxFeeNumerator(2)]).toEqual([500_000_000n, 990_000_000n, null]);
    expect(dammTotalFeeNumerator(60_000_000n, 11_999_767n, 990_000_000n)).toBe(71_999_767n);
    expect(dammTotalFeeNumerator(100_000_000n, 950_000_000n, 990_000_000n)).toBe(990_000_000n);
    expect(dammTotalFeeNumerator(100_000_000n, 950_000_000n, 500_000_000n)).toBe(500_000_000n);
    expect(dammTotalFeeNumerator((1n << 64n) - 1n, 1n, 990_000_000n)).toBeNull();
  });

  it("percent formatting is exact", () => {
    expect([dammFeePercent(2_500_000n), dammFeePercent(10_000_000n), dammFeePercent(499_729n), dammFeePercent(0n)]).toEqual(["0.25%", "1%", "0.0499729%", "0%"]);
  });
});

describe("compareDammPoolFee: a pool exactly as DBC's migration creates it", () => {
  it("matches for every fee option, whatever the dynamic fee's runtime state", () => {
    for (let option = 0; option < 6; option++) {
      const f = compareDammPoolFee(pristinePool(option), option);
      expect(f.differences, `option ${option}`).toEqual([]);
      expect(f.matches).toBe(true);
      expect(f.baseFeeNumerator).toBe(BigInt(MIGRATION_FEE_TIERS_BPS[option]!) * 100_000n);
      expect(f.maxTotalFeeNumerator).toBe(f.baseFeeNumerator + f.maxVariableFeeNumerator!);
    }
    const traded = pristinePool(2, (pf) => {
      Object.assign(pf["dynamicFee"] as object, { volatilityAccumulator: 14_460_000n, volatilityReference: 7_230_000n, sqrtPriceReference: 1n << 63n, lastUpdateTimestamp: 1_800_000_123n });
    });
    expect(compareDammPoolFee(traded, 2).matches).toBe(true);
  });

  it("reports every operator change of the fee and the resulting maximum", () => {
    const cases: [string, (pf: Record<string, unknown>) => void, RegExp][] = [
      ["base fee changed", (pf) => ((pf["baseFee"] as { baseFeeInfo: { data: Uint8Array } }).baseFeeInfo.data[0] = 0x01), /base fee .* instead of 1%/],
      [
        "base fee schedule",
        (pf) => {
          (pf["baseFee"] as { baseFeeInfo: { data: Uint8Array } }).baseFeeInfo.data[14] = 1;
        },
        /base fee mode or schedule changed/,
      ],
      ["dynamic fee disabled", (pf) => ((pf["dynamicFee"] as Record<string, unknown>)["initialized"] = 0), /dynamic fee disabled/],
      ["variable fee control", (pf) => ((pf["dynamicFee"] as Record<string, unknown>)["variableFeeControl"] = 957), /dynamic fee parameters changed \(variableFeeControl\)/],
      ["volatility cap", (pf) => ((pf["dynamicFee"] as Record<string, unknown>)["maxVolatilityAccumulator"] = 14_460_001), /maxVolatilityAccumulator/],
      ["bin step", (pf) => ((pf["dynamicFee"] as Record<string, unknown>)["binStep"] = 2), /binStep/],
      ["filter period", (pf) => ((pf["dynamicFee"] as Record<string, unknown>)["filterPeriod"] = 11), /filterPeriod/],
      ["decay period", (pf) => ((pf["dynamicFee"] as Record<string, unknown>)["decayPeriod"] = 121), /decayPeriod/],
      ["reduction factor", (pf) => ((pf["dynamicFee"] as Record<string, unknown>)["reductionFactor"] = 5_001), /reductionFactor/],
      ["bin step u128", (pf) => ((pf["dynamicFee"] as Record<string, unknown>)["binStepU128"] = 1n), /binStepU128/],
      ["protocol share", (pf) => (pf["protocolFeePercent"] = 50), /protocol\/referral shares 50%\/20%/],
      ["referral share", (pf) => (pf["referralFeePercent"] = 0), /protocol\/referral shares 20%\/0%/],
      ["compounding", (pf) => (pf["compoundingFeeBps"] = 1), /compounding fee 1 bps/],
    ];
    for (const [name, mutate, want] of cases) {
      const f = compareDammPoolFee(
        pristinePool(2, (pf) => mutate(pf)),
        2,
      );
      expect(f.matches, name).toBe(false);
      expect(f.differences.join("; "), name).toMatch(want);
    }
    // A raised base fee and a dynamic fee at u24 maxima: the reported maximum is capped at 99%.
    const extreme = compareDammPoolFee(
      pristinePool(5, (pf) => {
        (pf["baseFee"] as { baseFeeInfo: { data: Uint8Array } }).baseFeeInfo.data.set([0x00, 0xe1, 0xf5, 0x05], 0); // 100,000,000 = 10%
        Object.assign(pf["dynamicFee"] as object, { maxVolatilityAccumulator: U24_MAX, variableFeeControl: U24_MAX, binStep: 1 });
      }),
      5,
    );
    expect(extreme.baseFeeNumerator).toBe(100_000_000n);
    expect(extreme.maxTotalFeeNumerator).toBe(990_000_000n);
  });

  it("a pool of another tier, or an option with no canonical config, does not match", () => {
    expect(compareDammPoolFee(pristinePool(2), 5).matches).toBe(false);
    const none = compareDammPoolFee(pristinePool(2), 6);
    expect(none.expected).toBeNull();
    expect(none.differences.join()).toMatch(/no canonical migration config/);
  });
});

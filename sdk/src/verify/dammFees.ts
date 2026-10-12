/**
 * The trading fee of a graduated pool, modeled exactly as Meteora DAMM v2
 * computes it (cp-amm `state/fee.rs`, `state/config.rs`; IDL 0.2.5).
 *
 * DBC 0.2.1 migrates a fixed fee option (0..5) by calling DAMM v2
 * `initialize_pool` on a static config (`DAMM_V2_MIGRATION_CONFIGS`), and
 * `PoolFeesConfig::to_pool_fees_struct` copies that config's fees into the
 * pool: the base fee bytes verbatim, the dynamic-fee parameters (runtime
 * fields zero), the protocol and referral shares. All six canonical configs
 * carry an ENABLED dynamic fee (bin step 1, filter 10 s, decay 120 s,
 * reduction 50%, volatility capped at 14,460,000). Its maximum is about 20%
 * of the tier, so every graduated Noised pool charges the tier plus up to
 * +5 / +6 / +20 / +40 / +80 / +120 bps. That default is not an operator
 * change; anything else in these fields is (DAMM v2 operators can raise a
 * static base fee to 10% and set any dynamic fee, up to the pool's 99% cap).
 *
 * The values below were read from mainnet (fixtures in
 * `test/vectors/damm_v2_migration_configs.json`; the tests decode them and
 * compare). Meteora can close a config and create another: a pool that
 * migrated through different parameters then shows as changed, which is
 * what a verifier must report.
 */
import type { PublicKey } from "@solana/web3.js";

import { U128_MAX, U64_MAX, u64le } from "../codec/bytes.js";
import { DAMM_V2_MIGRATION_CONFIGS, MIGRATION_FEE_TIERS_BPS } from "../constants.js";
import type { DammPool } from "../meteora/state.js";

/** DAMM v2 `FEE_DENOMINATOR`: fee numerators are parts of 1e9. */
export const DAMM_FEE_DENOMINATOR = 1_000_000_000n;
/** `MAX_FEE_NUMERATOR_V0` (50%) and `_V1` (99%), by the pool's `fee_version`. */
export const DAMM_MAX_FEE_NUMERATOR_BY_VERSION: readonly bigint[] = [500_000_000n, 990_000_000n];
/** `MAX_FEE_NUMERATOR_POST_UPDATE`: the highest static base fee an operator can set (10%). */
export const DAMM_MAX_OPERATOR_BASE_FEE_NUMERATOR = 100_000_000n;
/** `get_variable_fee` scale: `(volatility * bin_step)^2 * control` is in 1e20 units, rounded UP to 1e9. */
const VARIABLE_FEE_SCALE = 100_000_000_000n;

/** The parameters of a DAMM v2 dynamic fee (`DynamicFeeConfig`, and the same fields of the pool's `DynamicFeeStruct`). */
export interface DammDynamicFeeParams {
  /** 0: no dynamic fee (every other field is then ignored). */
  initialized: number;
  maxVolatilityAccumulator: number;
  variableFeeControl: number;
  binStep: number;
  filterPeriod: number;
  decayPeriod: number;
  reductionFactor: number;
  binStepU128: bigint;
}

/** The pool's `DynamicFeeStruct`: the parameters plus the runtime state swaps update. */
export interface DammDynamicFeeState extends DammDynamicFeeParams {
  lastUpdateTimestamp: bigint;
  sqrtPriceReference: bigint;
  volatilityAccumulator: bigint;
  volatilityReference: bigint;
}

/** The fee fields of a DAMM v2 `Pool` (`PoolFeesStruct`) the comparison reads. */
export interface DammPoolFeesView {
  baseFee: { baseFeeInfo: { data: Uint8Array } };
  protocolFeePercent: number;
  referralFeePercent: number;
  compoundingFeeBps: number;
  dynamicFee: DammDynamicFeeState;
}

/** What DBC's migration writes into a pool for one fixed fee option. */
export interface DammMigrationPoolFee {
  /** DBC `migration_fee_option` (0..5). */
  option: number;
  /** The canonical DAMM v2 config of that option. */
  config: PublicKey;
  tierBps: number;
  /** The static base fee (`cliff_fee_numerator`, no schedule). */
  cliffFeeNumerator: bigint;
  /** The config's `base_fee.data`, copied verbatim into the pool's `base_fee_info.data`. */
  baseFeeInfo: Uint8Array;
  dynamicFee: DammDynamicFeeParams;
  protocolFeePercent: number;
  referralFeePercent: number;
  compoundingFeeBps: number;
}

/** `variable_fee_control` of the canonical configs, fee options 0..5 (the other dynamic-fee fields are shared). */
export const DAMM_V2_MIGRATION_VARIABLE_FEE_CONTROL: readonly number[] = [239, 286, 956, 1_913, 3_826, 5_739];

const SHARED_DYNAMIC_FEE = {
  initialized: 1,
  maxVolatilityAccumulator: 14_460_000,
  binStep: 1,
  filterPeriod: 10,
  decayPeriod: 120,
  reductionFactor: 5_000,
  /** `(bin_step << 64) / 10_000`. */
  binStepU128: 1_844_674_407_370_955n,
} as const;

/**
 * The fees a DBC migration gives a pool, per fixed fee option (index =
 * option): base fee = the tier, static; the canonical dynamic fee; Meteora's
 * 20% protocol share and 20% referral share; no compounding.
 */
export const DAMM_V2_MIGRATION_POOL_FEES: readonly DammMigrationPoolFee[] = DAMM_V2_MIGRATION_CONFIGS.map((config, option) => {
  const tierBps = MIGRATION_FEE_TIERS_BPS[option]!;
  const cliffFeeNumerator = (BigInt(tierBps) * DAMM_FEE_DENOMINATOR) / 10_000n;
  const baseFeeInfo = new Uint8Array(32);
  baseFeeInfo.set(u64le(cliffFeeNumerator), 0); // cliff; base_fee_mode 0, number_of_period 0, period_frequency 0, reduction_factor 0
  return {
    option,
    config,
    tierBps,
    cliffFeeNumerator,
    baseFeeInfo,
    dynamicFee: { ...SHARED_DYNAMIC_FEE, variableFeeControl: DAMM_V2_MIGRATION_VARIABLE_FEE_CONTROL[option]! },
    protocolFeePercent: 20,
    referralFeePercent: 20,
    compoundingFeeBps: 0,
  };
});

/**
 * Exactly `DynamicFeeStruct::get_variable_fee` at a volatility accumulator:
 * 0 without a dynamic fee, else `ceil((volatility * bin_step)^2 * control /
 * 1e11)` in checked u128 arithmetic (null where DAMM v2 errors).
 */
export function dammVariableFeeNumerator(d: Pick<DammDynamicFeeParams, "initialized" | "binStep" | "variableFeeControl">, volatilityAccumulator: bigint): bigint | null {
  if (d.initialized === 0) return 0n;
  const scaled = volatilityAccumulator * BigInt(d.binStep);
  if (volatilityAccumulator < 0n || scaled > U128_MAX) return null;
  const square = scaled * scaled;
  if (square > U128_MAX) return null;
  const vFee = square * BigInt(d.variableFeeControl);
  if (vFee > U128_MAX) return null;
  const rounded = vFee + (VARIABLE_FEE_SCALE - 1n);
  if (rounded > U128_MAX) return null;
  return rounded / VARIABLE_FEE_SCALE;
}

/** The variable fee at its cap: swaps never push the accumulator above `max_volatility_accumulator`. */
export function dammMaxVariableFeeNumerator(d: Pick<DammDynamicFeeParams, "initialized" | "binStep" | "variableFeeControl" | "maxVolatilityAccumulator">): bigint | null {
  return dammVariableFeeNumerator(d, BigInt(d.maxVolatilityAccumulator));
}

/** `get_max_fee_numerator(fee_version)`; null for a version DAMM v2 refuses. */
export function dammMaxFeeNumerator(feeVersion: number): bigint | null {
  return DAMM_MAX_FEE_NUMERATOR_BY_VERSION[feeVersion] ?? null;
}

/** `PoolFeesStruct::get_total_fee_numerator`: base + variable, capped at the pool's maximum (null where DAMM v2 errors). */
export function dammTotalFeeNumerator(baseFeeNumerator: bigint, variableFeeNumerator: bigint, maxFeeNumerator: bigint): bigint | null {
  const total = baseFeeNumerator + variableFeeNumerator;
  if (total > U64_MAX) return null; // u64 try_into
  return total > maxFeeNumerator ? maxFeeNumerator : total;
}

/** A fee numerator as a percentage string ("1.2%", "0.0499729%"). */
export function dammFeePercent(numerator: bigint): string {
  const scaled = numerator * 100n; // percent * 1e9
  const whole = scaled / DAMM_FEE_DENOMINATOR;
  const frac = (scaled % DAMM_FEE_DENOMINATOR).toString().padStart(9, "0").replace(/0+$/, "");
  return frac === "" ? `${whole}%` : `${whole}.${frac}%`;
}

/** How a pool's fee compares with what DBC's migration gives it. */
export interface DammPoolFeeComparison {
  /** The canonical fees of the launch's fee option (null: no such option). */
  expected: DammMigrationPoolFee | null;
  /** Every fee field equals the migration's: the pool is as DBC created it. */
  matches: boolean;
  /** What differs, in plain words (empty when `matches`). */
  differences: string[];
  /** The pool's current cliff (static) base fee. */
  baseFeeNumerator: bigint;
  /** The pool's variable fee at its volatility cap (null on DAMM arithmetic error). */
  maxVariableFeeNumerator: bigint | null;
  /** The most one trade can be charged: base + capped variable, at most the pool's fee cap (null if not computable). */
  maxTotalFeeNumerator: bigint | null;
}

function view(pool: DammPool): { fees: Partial<DammPoolFeesView>; feeVersion: number | undefined } {
  const p = pool as unknown as { poolFees?: Partial<DammPoolFeesView>; feeVersion?: number };
  return { fees: p.poolFees ?? {}, feeVersion: p.feeVersion };
}

/**
 * Compare a decoded DAMM v2 pool's fee with the one DBC's migration sets for
 * `migrationFeeOption`: base fee bytes, every dynamic-fee PARAMETER (the
 * runtime volatility state that swaps update is ignored), protocol and
 * referral shares, compounding fee.
 */
export function compareDammPoolFee(pool: DammPool, migrationFeeOption: number): DammPoolFeeComparison {
  const expected = DAMM_V2_MIGRATION_POOL_FEES[migrationFeeOption] ?? null;
  const { fees, feeVersion } = view(pool);
  const differences: string[] = [];
  const data = fees.baseFee?.baseFeeInfo?.data;
  if (!(data instanceof Uint8Array) || data.length !== 32) throw new Error("DAMM v2 pool base fee info must be 32 bytes");
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const baseFeeNumerator = dv.getBigUint64(0, true);
  const d = fees.dynamicFee;
  if (d === undefined) throw new Error("DAMM v2 pool has no dynamic fee struct");
  const maxVariableFeeNumerator = dammMaxVariableFeeNumerator(d);
  const cap = feeVersion === undefined ? null : dammMaxFeeNumerator(feeVersion);
  const maxTotalFeeNumerator = maxVariableFeeNumerator === null || cap === null ? null : dammTotalFeeNumerator(baseFeeNumerator, maxVariableFeeNumerator, cap);

  if (expected === null) {
    differences.push(`fee option ${migrationFeeOption} has no canonical migration config`);
  } else {
    if (baseFeeNumerator !== expected.cliffFeeNumerator) differences.push(`base fee ${dammFeePercent(baseFeeNumerator)} instead of ${dammFeePercent(expected.cliffFeeNumerator)}`);
    else if (data.some((b, i) => b !== expected.baseFeeInfo[i])) differences.push("base fee mode or schedule changed");
    const e = expected.dynamicFee;
    if (d.initialized === 0) differences.push("dynamic fee disabled");
    else {
      const fields = ["maxVolatilityAccumulator", "variableFeeControl", "binStep", "filterPeriod", "decayPeriod", "reductionFactor"] as const;
      const changed: string[] = fields.filter((f) => d[f] !== e[f]);
      if (d.binStepU128 !== e.binStepU128) changed.push("binStepU128");
      if (d.initialized !== e.initialized) changed.push("initialized");
      if (changed.length > 0) differences.push(`dynamic fee parameters changed (${changed.join(", ")})`);
    }
    if (fees.protocolFeePercent !== expected.protocolFeePercent || fees.referralFeePercent !== expected.referralFeePercent) {
      differences.push(`protocol/referral shares ${fees.protocolFeePercent}%/${fees.referralFeePercent}% instead of ${expected.protocolFeePercent}%/${expected.referralFeePercent}%`);
    }
    if (fees.compoundingFeeBps !== expected.compoundingFeeBps) differences.push(`compounding fee ${fees.compoundingFeeBps} bps`);
  }
  return { expected, matches: differences.length === 0, differences, baseFeeNumerator, maxVariableFeeNumerator, maxTotalFeeNumerator };
}

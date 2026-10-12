/** Launch presets and timeline logic (pure). */
import { DBC, POLICY } from "../constants.js";
import type { DynamicFeeParams, LaunchAccount, LaunchPhase, LaunchPreset, PresetName } from "../types.js";
import { designCurve } from "./curve.js";
import { checkNowSecs } from "./window.js";

/**
 * DBC-style dynamic fee whose maximum is `maxSharePct` percent (default 20)
 * of `baseFeeNumerator`, with DBC's default periods and the only bin step it
 * accepts.
 */
export function dynamicFeeFor(baseFeeNumerator: bigint, maxSharePct = 20n): DynamicFeeParams {
  const maxVolatilityAccumulator = 14_460_000;
  const squared = BigInt(maxVolatilityAccumulator) * BigInt(maxVolatilityAccumulator);
  const target = (baseFeeNumerator * maxSharePct) / 100n;
  return {
    binStep: DBC.DYNAMIC_BIN_STEP,
    binStepU128: DBC.DYNAMIC_BIN_STEP_U128,
    filterPeriod: 10,
    decayPeriod: 120,
    reductionFactor: 5_000,
    maxVolatilityAccumulator,
    variableFeeControl: Number((target * DBC.VARIABLE_FEE_SCALE) / squared),
  };
}

interface PresetShape {
  /** SOL per whole token at the start of the curve and at graduation (exact decimal strings). */
  startPrice: string;
  graduationPrice: string;
  thresholdSol: bigint;
  feeBps: number;
  migrationFeeOption: number;
  openDelaySecs: number;
  guardSecs: number;
  maxWalletBps: number;
  maxBuyBps: number;
  p2pLocked: boolean;
  batchWalletCapSol: bigint;
}

/** Freeze plain objects and arrays recursively (presets are shared, read-only data). */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

function preset(name: PresetName, title: string, summary: string, o: PresetShape): LaunchPreset {
  const tokenDecimal = 6;
  const threshold = o.thresholdSol * POLICY.LAMPORTS_PER_SOL;
  const { sqrtStartPrice, curve } = designCurve(tokenDecimal, o.startPrice, o.graduationPrice, threshold);
  const cliffFeeNumerator = (BigInt(o.feeBps) * DBC.FEE_DENOMINATOR) / BigInt(POLICY.BPS_DENOMINATOR);
  return deepFreeze({
    name,
    title,
    summary,
    params: {
      tokenDecimal,
      sqrtStartPrice,
      curve,
      migrationQuoteThreshold: threshold,
      // Flat fee: a schedule would have to end before the batch executes anyway.
      baseFee: { cliffFeeNumerator, firstFactor: 0, secondFactor: 0n, thirdFactor: 0n, baseFeeMode: DBC.BASE_FEE_MODE_LINEAR },
      dynamicFee: dynamicFeeFor(cliffFeeNumerator),
      migrationFeeOption: o.migrationFeeOption,
      openDelaySecs: o.openDelaySecs,
      guardSecs: o.guardSecs,
      maxWalletBps: o.maxWalletBps,
      maxBuyBps: o.maxBuyBps,
      p2pLocked: o.p2pLocked,
      batchWalletCap: o.batchWalletCapSol * POLICY.LAMPORTS_PER_SOL,
      batchTotalCap: 0n,
    },
  });
}

/** Safe starting points; every one passes `validateLaunchParams` once recipients are added. */
export const PRESETS: Readonly<Record<PresetName, LaunchPreset>> = Object.freeze({
  fair: preset("fair", "Fair", "Five-minute fair-open batch, six-hour guard, 1% max wallet, 5 SOL per wallet in the batch. The balanced default.", {
    startPrice: "0.00000003",
    graduationPrice: "0.0000004",
    thresholdSol: 85n,
    feeBps: 100,
    migrationFeeOption: 2,
    openDelaySecs: 300,
    guardSecs: 6 * 3600,
    maxWalletBps: 100,
    maxBuyBps: 50,
    p2pLocked: false,
    batchWalletCapSol: 5n,
  }),
  community: preset(
    "community",
    "Community",
    "Thirty-minute batch so everyone can join, 24-hour guard, wallet-to-wallet transfers paused during the guard, 2 SOL per wallet in the batch.",
    {
      startPrice: "0.00000005",
      graduationPrice: "0.0000006",
      thresholdSol: 250n,
      feeBps: 100,
      migrationFeeOption: 1,
      openDelaySecs: 1800,
      guardSecs: 24 * 3600,
      maxWalletBps: 200,
      maxBuyBps: 100,
      p2pLocked: true,
      batchWalletCapSol: 2n,
    },
  ),
  turbo: preset("turbo", "Turbo", "One-minute batch, one-hour guard, no per-wallet batch cap. Every safety guarantee still applies.", {
    startPrice: "0.00000002",
    graduationPrice: "0.0000003",
    thresholdSol: 40n,
    feeBps: 150,
    migrationFeeOption: 3,
    openDelaySecs: 60,
    guardSecs: 3600,
    maxWalletBps: 300,
    maxBuyBps: 0,
    p2pLocked: false,
    batchWalletCapSol: 0n,
  }),
});

/**
 * Where a launch is in its timeline (SPEC §1.3) at `nowSecs`, a bigint of
 * unix SECONDS (`unixNowSecs()`, or the cluster's `clusterUnixTime`): a
 * `number` is a TypeError and a value that looks like milliseconds a
 * RangeError. `graduated` needs the market snapshot: the Launch account
 * alone cannot tell that the curve completed. Phases from the Launch
 * account's own timestamps: commit `[launch_ts, commit_end_ts)`, execute
 * `[commit_end_ts, execute_end_ts)` (ten minutes) but only until the batch
 * executes (it then ends the snipe shield at once, so pass `executed`),
 * guarded until `guard_end_ts`, then open.
 */
export function launchPhase(
  launch: Pick<LaunchAccount, "status" | "commitEndTs" | "executeEndTs" | "guardEndTs"> & {
    executed?: boolean | undefined;
    market?: { curveComplete: boolean; migrated: boolean } | undefined;
  },
  nowSecs: bigint,
): LaunchPhase {
  const now = checkNowSecs(nowSecs);
  if (launch.status === "configured") return "configured";
  if (launch.market?.curveComplete === true || launch.market?.migrated === true) return "graduated";
  if (now < launch.commitEndTs) return "commit";
  if (now < launch.executeEndTs && launch.executed !== true) return "execute";
  if (now < launch.guardEndTs) return "guarded";
  return "open";
}

/** The batch executed, expired (nobody executed it in its window), is still pending, or was empty, at `nowSecs` (bigint unix seconds, as `launchPhase`). */
export function batchOutcome(
  launch: Pick<LaunchAccount, "executed" | "status" | "executeEndTs" | "totalCommitted">,
  nowSecs: bigint,
): "pending" | "executed" | "expired" | "empty" {
  const now = checkNowSecs(nowSecs);
  if (launch.executed) return "executed";
  if (launch.status !== "live" || now < launch.executeEndTs) return "pending";
  return launch.totalCommitted === 0n ? "empty" : "expired";
}

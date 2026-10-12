/**
 * Typed views of the Meteora accounts the SDK reads, decoded with the
 * vendored IDLs (the same files the launchpad's `declare_program!` uses).
 * Only the fields the SDK uses are typed; the decoder reads every field.
 */
import type { PublicKey } from "@solana/web3.js";

import { idlCodecs } from "../idl/index.js";

// ------------------------------------------------------------------ DBC ---

export interface DbcLiquidityVestingInfo {
  isInitialized: number;
  vestingPercentage: number;
  bpsPerPeriod: number;
  numberOfPeriods: number;
  frequency: number;
  cliffDurationFromMigrationTime: number;
}

export interface DbcLockedVestingConfig {
  amountPerPeriod: bigint;
  cliffDurationFromMigrationTime: bigint;
  frequency: bigint;
  numberOfPeriod: bigint;
  cliffUnlockAmount: bigint;
}

export interface DbcBaseFeeConfig {
  cliffFeeNumerator: bigint;
  secondFactor: bigint;
  thirdFactor: bigint;
  firstFactor: number;
  baseFeeMode: number;
}

export interface DbcDynamicFeeConfig {
  initialized: number;
  maxVolatilityAccumulator: number;
  variableFeeControl: number;
  binStep: number;
  filterPeriod: number;
  decayPeriod: number;
  reductionFactor: number;
  binStepU128: bigint;
}

export interface DbcPoolConfig {
  quoteMint: PublicKey;
  feeClaimer: PublicKey;
  leftoverReceiver: PublicKey;
  poolFees: { baseFee: DbcBaseFeeConfig; dynamicFee: DbcDynamicFeeConfig };
  partnerLiquidityVestingInfo: DbcLiquidityVestingInfo;
  creatorLiquidityVestingInfo: DbcLiquidityVestingInfo;
  collectFeeMode: number;
  migrationOption: number;
  activationType: number;
  tokenDecimal: number;
  version: number;
  tokenType: number;
  quoteTokenFlag: number;
  partnerPermanentLockedLiquidityPercentage: number;
  partnerLiquidityPercentage: number;
  creatorPermanentLockedLiquidityPercentage: number;
  creatorLiquidityPercentage: number;
  migrationFeeOption: number;
  fixedTokenSupplyFlag: number;
  creatorTradingFeePercentage: number;
  tokenUpdateAuthority: number;
  migrationFeePercentage: number;
  creatorMigrationFeePercentage: number;
  swapBaseAmount: bigint;
  migrationQuoteThreshold: bigint;
  migrationBaseThreshold: bigint;
  migrationSqrtPrice: bigint;
  lockedVestingConfig: DbcLockedVestingConfig;
  preMigrationTokenSupply: bigint;
  postMigrationTokenSupply: bigint;
  migratedCollectFeeMode: number;
  migratedDynamicFee: number;
  migratedPoolFeeBps: number;
  migratedPoolBaseFeeMode: number;
  enableFirstSwapWithMinFee: number;
  migratedCompoundingFeeBps: number;
  poolCreationFee: bigint;
  sqrtStartPrice: bigint;
  curve: { sqrtPrice: bigint; liquidity: bigint }[];
}

export interface DbcConfigWithTransferHook {
  config: DbcPoolConfig;
  transferHookProgram: PublicKey;
}

export interface DbcPoolState {
  config: PublicKey;
  creator: PublicKey;
  baseMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  baseReserve: bigint;
  quoteReserve: bigint;
  sqrtPrice: bigint;
  activationPoint: bigint;
  poolType: number;
  isMigrated: number;
  isPartnerWithdrawSurplus: number;
  isProtocolWithdrawSurplus: number;
  migrationProgress: number;
  isWithdrawLeftover: number;
  isCreatorWithdrawSurplus: number;
  finishCurveTimestamp: bigint;
  /** Set by the pool's first swap (DBC `has_swap`); `execute_batch` requires 0 (`PoolAlreadyTraded`). */
  hasSwap: number;
}

export interface DbcTransferHookPool {
  poolState: DbcPoolState;
}

/** DBC `MigrationProgress`: 0 PreBondingCurve, 1 PostBondingCurve, 2 LockedVesting, 3 CreatedPool. */
export const DBC_MIGRATION_PROGRESS = { PRE_BONDING_CURVE: 0, POST_BONDING_CURVE: 1, LOCKED_VESTING: 2, CREATED_POOL: 3 } as const;

export function decodeDbcConfigWithTransferHook(data: Uint8Array): DbcConfigWithTransferHook {
  return idlCodecs().dbc.decodeAccount<DbcConfigWithTransferHook>("ConfigWithTransferHook", data);
}

export function decodeDbcTransferHookPool(data: Uint8Array): DbcTransferHookPool {
  return idlCodecs().dbc.decodeAccount<DbcTransferHookPool>("TransferHookPool", data);
}

// -------------------------------------------------------------- DAMM v2 ---

export interface DammPool {
  poolFees: {
    baseFee: { baseFeeInfo: { data: Uint8Array } };
    protocolFeePercent: number;
    referralFeePercent: number;
    dynamicFee: { initialized: number; maxVolatilityAccumulator: number; variableFeeControl: number; binStep: number };
  };
  tokenAMint: PublicKey;
  tokenBMint: PublicKey;
  tokenAVault: PublicKey;
  tokenBVault: PublicKey;
  liquidity: bigint;
  sqrtMinPrice: bigint;
  sqrtMaxPrice: bigint;
  sqrtPrice: bigint;
  activationPoint: bigint;
  activationType: number;
  poolStatus: number;
  tokenAFlag: number;
  tokenBFlag: number;
  collectFeeMode: number;
  poolType: number;
  feeAPerLiquidity: Uint8Array;
  feeBPerLiquidity: Uint8Array;
  permanentLockLiquidity: bigint;
  creator: PublicKey;
  tokenAAmount: bigint;
  tokenBAmount: bigint;
}

export interface DammPosition {
  pool: PublicKey;
  nftMint: PublicKey;
  feeAPerTokenCheckpoint: Uint8Array;
  feeBPerTokenCheckpoint: Uint8Array;
  feeAPending: bigint;
  feeBPending: bigint;
  unlockedLiquidity: bigint;
  vestedLiquidity: bigint;
  permanentLockedLiquidity: bigint;
}

export interface DammOperator {
  whitelistedAddress: PublicKey;
  permission: bigint;
}

/** DAMM v2 `PoolStatus`: 0 enabled, 1 disabled (by an operator). */
export const DAMM_POOL_STATUS_ENABLED = 0;

/** DAMM v2 operator permission bits (`OperatorPermission`). */
export const DAMM_OPERATOR_PERMISSIONS: readonly string[] = [
  "CreateConfigKey",
  "RemoveConfigKey",
  "CreateTokenBadge",
  "CloseTokenBadge",
  "SetPoolStatus",
  "InitializeReward",
  "UpdateRewardDuration",
  "UpdateRewardFunder",
  "UpdatePoolFees",
  "ClaimProtocolFee",
  "ZapProtocolFee",
  "FixPool",
];

export function decodeDammPool(data: Uint8Array): DammPool {
  return idlCodecs().dammV2.decodeAccount<DammPool>("Pool", data);
}

export function decodeDammPosition(data: Uint8Array): DammPosition {
  return idlCodecs().dammV2.decodeAccount<DammPosition>("Position", data);
}

export function decodeDammOperator(data: Uint8Array): DammOperator {
  return idlCodecs().dammV2.decodeAccount<DammOperator>("Operator", data);
}

/** DAMM v2 time-scheduler base fee (`PodAlignedFeeTimeScheduler` in `base_fee_info.data`). */
export function dammBaseFeeScheduler(pool: DammPool): {
  cliffFeeNumerator: bigint;
  baseFeeMode: number;
  numberOfPeriod: number;
  periodFrequency: bigint;
  reductionFactor: bigint;
} {
  const d = pool.poolFees.baseFee.baseFeeInfo.data;
  if (d.length !== 32) throw new Error("DAMM v2 base fee info must be 32 bytes");
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return {
    cliffFeeNumerator: v.getBigUint64(0, true),
    baseFeeMode: d[8]!,
    numberOfPeriod: v.getUint16(14, true),
    periodFrequency: v.getBigUint64(16, true),
    reductionFactor: v.getBigUint64(24, true),
  };
}

/** U256 stored little-endian in 32 bytes (DAMM v2 fee-per-liquidity accumulators). */
export function u256le(b: Uint8Array): bigint {
  let v = 0n;
  for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]!);
  return v;
}

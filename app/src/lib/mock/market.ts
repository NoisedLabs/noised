/**
 * MOCK market model: a constant-product curve with virtual quote reserves
 * stands in for Meteora DBC / DAMM v2 pricing. Good enough for realistic
 * quotes; the real SDK quotes with the DBC SDK.
 */
import { launchPdasFromLaunch, type MarketSnapshot, type SwapQuote, type SwapSide } from "@noisedlabs/sdk";
import type { PublicKey } from "@solana/web3.js";

import type { MockLaunch } from "./store";

const BPS = 10_000n;
/** DBC keeps 20% of trading fees as protocol fee; the partner (launch authority) gets the rest. */
const PARTNER_SHARE_PCT = 80n;

export interface SwapResult {
  amountInUsed: bigint;
  amountOut: bigint;
  fee: bigint;
  refund: bigint;
  completes: boolean;
}

export function currentFeeBps(l: MockLaunch): number {
  return l.migrated ? l.dammFeeBps : l.feeBps;
}

/** Quote (x) and base (y) the price formula uses. */
function reserves(l: MockLaunch): { x: bigint; y: bigint } {
  return { x: l.virtualQuote + l.quoteReserve, y: l.baseReserve };
}

/** Simulate a swap without changing state. Buys stop at the graduation threshold (DBC partial fill). */
export function simulateSwap(l: MockLaunch, side: SwapSide, amountIn: bigint): SwapResult {
  const bps = BigInt(currentFeeBps(l));
  const { x, y } = reserves(l);
  if (amountIn <= 0n || y <= 0n) return { amountInUsed: 0n, amountOut: 0n, fee: 0n, refund: amountIn, completes: false };
  const k = x * y;
  if (side === "buy") {
    let used = amountIn;
    let refund = 0n;
    if (!l.migrated) {
      const room = l.state.migrationQuoteThreshold - l.quoteReserve;
      const maxGross = room <= 0n ? 0n : (room * BPS) / (BPS - bps) + 1n;
      if (used > maxGross) {
        refund = used - maxGross;
        used = maxGross;
      }
    }
    const fee = (used * bps + BPS - 1n) / BPS;
    const net = used - fee;
    const out = y - (k + (x + net) - 1n) / (x + net);
    const completes = !l.migrated && l.quoteReserve + net >= l.state.migrationQuoteThreshold;
    return { amountInUsed: used, amountOut: out > 0n ? out : 0n, fee, refund, completes };
  }
  const grossOut = x - (k + (y + amountIn) - 1n) / (y + amountIn);
  const cappedOut = grossOut > l.quoteReserve ? l.quoteReserve : grossOut;
  const fee = (cappedOut * bps + BPS - 1n) / BPS;
  return { amountInUsed: amountIn, amountOut: cappedOut - fee, fee, refund: 0n, completes: false };
}

export function applySwap(l: MockLaunch, side: SwapSide, r: SwapResult): void {
  // DBC sets `has_swap` in every swap, including one that moves nothing.
  l.hasSwap = true;
  if (side === "buy") {
    l.quoteReserve += r.amountInUsed - r.fee;
    l.baseReserve -= r.amountOut;
  } else {
    l.quoteReserve -= r.amountOut + r.fee;
    l.baseReserve += r.amountInUsed;
  }
  if (l.migrated) l.lpFeesQuote += r.fee;
  else l.feesClaimable += (r.fee * PARTNER_SHARE_PCT) / 100n;
  if (r.completes) markComplete(l);
}

export function quote(l: MockLaunch, side: SwapSide, amountIn: bigint, slippageBps: number): SwapQuote {
  const r = simulateSwap(l, side, amountIn);
  const before = spotPrice(l);
  const paid = side === "buy" ? Number(r.amountInUsed - r.fee) : Number(r.amountOut + r.fee);
  const got = side === "buy" ? Number(r.amountOut) : Number(r.amountInUsed);
  const effective = got > 0 ? paid / got : before;
  const impact = before > 0 ? Math.abs(effective - before) / before : 0;
  return {
    side,
    venue: l.migrated ? "damm-v2" : "dbc",
    amountIn: r.amountInUsed,
    expectedOut: r.amountOut,
    minimumOut: (r.amountOut * BigInt(10_000 - slippageBps)) / BPS,
    feeAmount: r.fee,
    feeBps: currentFeeBps(l),
    priceImpactBps: Math.round(impact * 10_000),
    // A constant-product approximation computed by the simulated chain.
    method: "simulation",
  };
}

/** Quote atomic units per base atomic unit. */
export function spotPrice(l: MockLaunch): number {
  const { x, y } = reserves(l);
  return y === 0n ? 0 : Number(x) / Number(y);
}

export function sqrtPriceQ64(l: MockLaunch): bigint {
  const p = spotPrice(l);
  if (!(p > 0)) return 0n;
  return BigInt(Math.round(Math.sqrt(p) * 2 ** 32)) * (1n << 32n);
}

export function snapshot(l: MockLaunch): MarketSnapshot | undefined {
  if (l.meta === null || l.state.status !== "live") return undefined;
  return {
    name: l.meta.name,
    symbol: l.meta.symbol,
    uri: l.meta.uri,
    initialSupply: l.initialSupply,
    supply: l.initialSupply,
    quoteReserve: l.quoteReserve,
    baseReserve: l.baseReserve,
    sqrtPrice: sqrtPriceQ64(l),
    curveComplete: l.curveComplete,
    migrated: l.migrated,
    dammPool: l.dammPool,
    hookActive: !l.curveComplete,
  };
}

export type HookRefusal = "SnipeShield" | "TransfersLocked" | "MaxBuy" | "MaxWallet" | "MutableOwner" | "RuleDenied";

export interface TransferView {
  amount: bigint;
  /** Transfer out of the DBC base vault. */
  isBuy: boolean;
  /** Transfer into the DBC base vault. */
  isSell: boolean;
  sourceOwner: PublicKey | null;
  destinationOwner: PublicKey | null;
  destinationBalanceAfter: bigint;
  /** The buy runs inside the launchpad's top-level `execute_batch` (the batch buy). */
  inBatch?: boolean;
  /**
   * The receiving token account has Token-2022's ImmutableOwner extension
   * (default true: every token account of the simulated chain is a canonical
   * associated token account, and those always have it).
   */
  destinationImmutableOwner?: boolean;
  /** Program of the transaction's current top-level instruction (custom launch rules: TOP_PROGRAM_IN); unknown when absent. */
  topProgram?: PublicKey;
  /** Number of top-level instructions in the transaction (custom launch rules: TX_IX_COUNT_GT); unknown when absent. */
  txIxCount?: number;
}

/** Launch Guard decision, line for line with programs/noised-hook/src/rules.rs::evaluate. */
export function hookEvaluate(l: MockLaunch, now: number, t: TransferView): HookRefusal | null {
  // DBC revokes the hook when the curve completes; a mint without a policy is unrestricted.
  if (l.curveComplete || l.certificate === null) return null;
  // A sell (into the base vault, never out of it) always passes.
  if (t.isSell && !t.isBuy) return null;
  if (BigInt(now) >= l.state.guardEndTs) return null;
  // Before the zero-amount and exemption passes: until the shield ends the only buy is the batch buy.
  if (t.isBuy && BigInt(now) < l.certificate.snipeShieldEndTs && t.inBatch !== true) return "SnipeShield";
  if (t.amount === 0n) return null;
  const pdas = launchPdasFromLaunch(l.address);
  const exempt = (k: PublicKey | null): boolean => k !== null && (k.equals(pdas.batchAuthority) || k.equals(pdas.launchAuthority));
  // Audit round 3, F2: an account whose owner can be reassigned would carry tokens past the pause and the cap. Checked
  // before the exemption pass (a payout from the batch escrow into such an account is refused too), except for an exempt
  // receiver (the protocol's own accounts).
  if (t.destinationImmutableOwner === false && !exempt(t.destinationOwner)) return "MutableOwner";
  if (exempt(t.sourceOwner) || exempt(t.destinationOwner)) return null;
  if (!t.isBuy && l.state.p2pLocked) return "TransfersLocked";
  if (l.maxBuy !== 0n && t.amount > l.maxBuy) return "MaxBuy";
  if (l.maxWallet !== 0n && t.destinationBalanceAfter > l.maxWallet) return "MaxWallet";
  return null;
}

/** What the batch swap spends: `min(total_committed, batch_total_cap)`; claims refund the rest pro rata. */
export function batchAmountIn(l: MockLaunch): bigint {
  return l.state.totalCommitted < l.state.batchTotalCap ? l.state.totalCommitted : l.state.batchTotalCap;
}

/** Execute the batch: one buy of min(total, cap) inside `execute_batch` (the hook lets only this buy through the shield), paid out pro rata later. */
export function executeBatch(l: MockLaunch): void {
  const r = simulateSwap(l, "buy", batchAmountIn(l));
  applySwap(l, "buy", r);
  l.state.executed = true;
  l.state.quoteSpent = r.amountInUsed;
  l.state.tokensOut = r.amountOut;
}

export function markComplete(l: MockLaunch): void {
  if (l.curveComplete) return;
  l.curveComplete = true;
  l.completedAt = Math.floor(Date.now() / 1000);
}

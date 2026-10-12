/**
 * What a buyback's swap returns, estimated off-chain. The program does not
 * estimate anything: it swaps on the launch's DAMM v2 pool with a minimum
 * out priced at the buyback's bound plus the node's premium
 * (`buybackMinOut`), and the whole run fails (SwapShortfall) when the pool
 * returns less. Whether a buyback can fill therefore depends on the pool:
 * its trading fee and its depth (price impact).
 *
 * The estimate is the constant-product swap of a full-range DAMM v2 pool
 * (the pool DBC's migration creates), with the trading fee taken from the
 * SOL going in (DBC-migrated pools collect fees in SOL):
 *
 *   in'  = amountIn * (10,000 - feeBps) / 10,000
 *   out  = tokens * in' / (poolSol + in')      tokens = poolSol / price
 *
 * Without the pool's SOL (`poolSol` undefined) there is no price impact:
 * `out = in' / price`, an upper bound. Keepers should still simulate the
 * transaction before sending it.
 */
import { BPS_DENOMINATOR } from "../constants.js";
import { ProgError } from "../errors.js";
import { minOut, priceQ64 } from "./reference.js";

const D = BigInt(BPS_DENOMINATOR);

function feeOf(poolFeeBps: number): bigint {
  if (!Number.isInteger(poolFeeBps) || poolFeeBps < 0 || poolFeeBps >= BPS_DENOMINATOR) {
    throw new ProgError("BadModel", "poolFeeBps must be a whole number of bps from 0 to 9,999");
  }
  return BigInt(poolFeeBps);
}

/**
 * Whether a buyback premium can ever cover the pool's fee: at best (the pool
 * price at the bound itself) a swap returns `in * (1 - fee) / price` while
 * the program wants at least `in / (price * (1 + premium))`, so a premium
 * below `fee / (1 - fee)` never fills, whatever the amount.
 */
export function premiumCoversFee(premiumBps: number | bigint, poolFeeBps: number): boolean {
  return (D - feeOf(poolFeeBps)) * (D + BigInt(premiumBps)) >= D * D;
}

/** The smallest premium (bps) that covers a pool fee: ceil(fee / (1 - fee) * 10,000). */
export function minPremiumForFee(poolFeeBps: number): number {
  const f = feeOf(poolFeeBps);
  return Number((f * D + (D - f) - 1n) / (D - f));
}

/** Estimated tokens (raw units) a buyback of `amountIn` lamports gets at the pool's sqrt price (see the module note). */
export function estimateBuybackOut(amountIn: bigint, spotSqrtQ64: bigint, poolFeeBps: number, poolSol?: bigint | null): bigint {
  const price = priceQ64(spotSqrtQ64);
  if (price === null || price === 0n || amountIn <= 0n) return 0n;
  const net = (amountIn * (D - feeOf(poolFeeBps))) / D;
  if (poolSol === undefined || poolSol === null) return (net << 64n) / price;
  if (poolSol <= 0n) return 0n;
  // tokens = poolSol / price (raw units), out = tokens * net / (poolSol + net), in one division.
  return ((poolSol << 64n) * net) / (price * (poolSol + net));
}

/** The pool after a buyback of `amountIn` (constant product): its SOL and its new sqrt price. */
export function poolAfterBuyback(amountIn: bigint, spotSqrtQ64: bigint, poolFeeBps: number, poolSol: bigint): { poolSol: bigint; spotSqrtQ64: bigint } {
  const net = (amountIn * (D - feeOf(poolFeeBps))) / D;
  if (poolSol <= 0n) return { poolSol, spotSqrtQ64 };
  // price = poolSol^2 / k: the sqrt price scales with the pool's SOL.
  return { poolSol: poolSol + net, spotSqrtQ64: (spotSqrtQ64 * (poolSol + net)) / poolSol };
}

/** Whether a buyback of `amount` would fill: the estimate is at least the program's minimum out at `boundSqrt` + premium. */
export function buybackFills(amount: bigint, boundSqrtQ64: bigint, premiumBps: number | bigint, spotSqrtQ64: bigint, poolFeeBps: number, poolSol?: bigint | null): boolean {
  const least = minOut(amount, boundSqrtQ64, premiumBps);
  if (least === null || least === 0n) return false;
  return estimateBuybackOut(amount, spotSqrtQ64, poolFeeBps, poolSol) >= least;
}

/**
 * The largest amount in `lo..=hi` whose buyback fills (null when none does).
 * Tiny amounts can fail by rounding and large ones by price impact, so the
 * amounts that fill form a range: this finds one (scanning up from `lo` by
 * a quarter at a time), then the range's top by binary search.
 */
export function largestFillable(lo: bigint, hi: bigint, fills: (amount: bigint) => boolean): bigint | null {
  if (lo < 1n) lo = 1n;
  if (hi < lo) return null;
  if (fills(hi)) return hi;
  let good: bigint | null = null;
  for (let a = lo; a < hi; a = a + (a / 4n > 0n ? a / 4n : 1n)) {
    if (fills(a)) {
      good = a;
      break;
    }
  }
  if (good === null) return null;
  let ok: bigint = good;
  let bad = hi;
  while (bad - ok > 1n) {
    const mid: bigint = ok + (bad - ok) / 2n;
    if (fills(mid)) ok = mid;
    else bad = mid;
  }
  return ok;
}

/**
 * Bonding-curve helpers: convert human prices to Meteora DBC's Q64.64 square
 * root prices and design simple constant-liquidity curves. Exact bigint math
 * for everything that becomes a parameter; floating point only for display.
 *
 * DBC units: sqrt prices are Q64.64 of sqrt(lamports per base unit). On a
 * segment [sqrtA, sqrtB] with liquidity L, the quote absorbed is
 * `L * (sqrtB - sqrtA) / 2^128` and the base released is
 * `L * (sqrtB - sqrtA) / (sqrtA * sqrtB)`.
 */
import { DBC } from "../constants.js";
import type { CurvePoint } from "../types.js";

export const Q64 = 1n << 64n;
const QUOTE_DECIMALS = 9;

/** Floor square root of a non-negative bigint (Newton's method, exact). */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError("square root of a negative number");
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) break;
    x = y;
  }
  while (x * x > n) x -= 1n;
  while ((x + 1n) * (x + 1n) <= n) x += 1n;
  return x;
}

/** Exact rational from a decimal string: "0.000000028", "2.8e-8", "150". */
export function parseRational(input: string): { num: bigint; den: bigint } {
  const m = /^(\d+)?(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(input.trim());
  if (!m || (m[1] === undefined && m[2] === undefined)) throw new Error(`not a decimal number: ${JSON.stringify(input)}`);
  const whole = m[1] ?? "0";
  const frac = m[2] ?? "";
  const exp = Number(m[3] ?? "0");
  if (!Number.isSafeInteger(exp) || Math.abs(exp) > 60) throw new Error("exponent out of range");
  let num = BigInt(whole + frac);
  let den = 10n ** BigInt(frac.length);
  if (exp >= 0) num *= 10n ** BigInt(exp);
  else den *= 10n ** BigInt(-exp);
  if (num === 0n) throw new Error("price must be greater than zero");
  return { num, den };
}

/** Q64.64 sqrt price (rounded down) for a price in SOL per whole token. */
export function sqrtPriceFromPrice(price: string, tokenDecimals: number): bigint {
  const { num, den } = parseRational(price);
  // lamports per base unit = price * 10^9 / 10^decimals; sqrt in Q64.64 = isqrt(p * 2^128)
  const scaledNum = num * 10n ** BigInt(QUOTE_DECIMALS) * (1n << 128n);
  const scaledDen = den * 10n ** BigInt(tokenDecimals);
  return isqrt(scaledNum / scaledDen);
}

/** Display only: SOL per whole token for a Q64.64 sqrt price. */
export function priceFromSqrtPrice(sqrtPrice: bigint, tokenDecimals: number): number {
  const s = Number(sqrtPrice) / 2 ** 64;
  return s * s * 10 ** (tokenDecimals - QUOTE_DECIMALS);
}

/** Liquidity that makes [sqrtA, sqrtB] absorb exactly `quote` lamports (rounded down). */
export function liquidityForQuote(quote: bigint, sqrtA: bigint, sqrtB: bigint): bigint {
  if (sqrtB <= sqrtA) throw new RangeError("segment end must be above its start");
  return (quote << 128n) / (sqrtB - sqrtA);
}

/** Quote lamports a segment absorbs (rounded down). */
export function quoteForSegment(liquidity: bigint, sqrtA: bigint, sqrtB: bigint): bigint {
  return (liquidity * (sqrtB - sqrtA)) >> 128n;
}

/** Base units a segment releases (rounded down). */
export function baseForSegment(liquidity: bigint, sqrtA: bigint, sqrtB: bigint): bigint {
  return (liquidity * (sqrtB - sqrtA)) / (sqrtA * sqrtB);
}

export interface CurveDesign {
  sqrtStartPrice: bigint;
  curve: CurvePoint[];
}

/**
 * A two-point curve: constant liquidity from the start price to the
 * graduation price, sized so the curve holds `thresholdLamports` there, then
 * a second segment of the same liquidity up to 1.5x the graduation sqrt
 * price as headroom for the final swap past the threshold.
 */
export function designCurve(tokenDecimals: number, startPrice: string, graduationPrice: string, thresholdLamports: bigint): CurveDesign {
  const s0 = sqrtPriceFromPrice(startPrice, tokenDecimals);
  const s1 = sqrtPriceFromPrice(graduationPrice, tokenDecimals);
  if (s0 < DBC.MIN_SQRT_PRICE) throw new Error("start price is below what Meteora DBC can represent");
  if (s1 <= s0) throw new Error("graduation price must be above the start price");
  const s2 = s1 + s1 / 2n;
  if (s2 > DBC.MAX_SQRT_PRICE) throw new Error("graduation price is above what Meteora DBC can represent");
  const liquidity = liquidityForQuote(thresholdLamports, s0, s1);
  if (liquidity === 0n) throw new Error("threshold is too small for this price range");
  return {
    sqrtStartPrice: s0,
    curve: [
      { sqrtPrice: s1, liquidity },
      { sqrtPrice: s2, liquidity },
    ],
  };
}

/**
 * Display-only estimate of the supply a curve implies: base sold on the
 * curve up to the threshold plus the base DBC pairs with the raise at
 * migration. Null if the curve cannot absorb the threshold.
 */
export function estimateSupply(
  sqrtStartPrice: bigint,
  curve: readonly CurvePoint[],
  thresholdLamports: bigint,
): { curveBase: bigint; migrationBase: bigint; migrationSqrtPrice: bigint } | null {
  let remaining = thresholdLamports;
  let lower = sqrtStartPrice;
  let base = 0n;
  for (const point of curve) {
    if (point.sqrtPrice <= lower || point.liquidity <= 0n) return null;
    const capacity = quoteForSegment(point.liquidity, lower, point.sqrtPrice);
    if (capacity >= remaining) {
      const upper = lower + (remaining << 128n) / point.liquidity;
      base += baseForSegment(point.liquidity, lower, upper);
      const migrationBase = (thresholdLamports << 128n) / (upper * upper);
      return { curveBase: base, migrationBase, migrationSqrtPrice: upper };
    }
    base += baseForSegment(point.liquidity, lower, point.sqrtPrice);
    remaining -= capacity;
    lower = point.sqrtPrice;
  }
  return null;
}

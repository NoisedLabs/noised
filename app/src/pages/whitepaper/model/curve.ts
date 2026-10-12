/**
 * Meteora DBC bonding-curve arithmetic for the whitepaper's figures, mirrored from the SDK (sdk/src/launch/curve.ts:
 * exact bigint for parameters, floating point only for display) together with the three launch presets'
 * parameters (sdk/src/launch/presets.ts). app/test/whitepaper-model.test.ts checks this mirror against the SDK, so a
 * preset change that is not reflected here fails the tests. The UI may not import the SDK directly (UI code reaches
 * the chain only through lib/noised), hence the mirror.
 *
 * DBC units: a sqrt price is Q64.64 of sqrt(lamports per base unit). On a segment [a, b] with liquidity L the curve
 * absorbs L (b - a) / 2^128 lamports of quote and releases L (b - a) / (a b) base units.
 */

export const Q64 = 1n << 64n;
const QUOTE_DECIMALS = 9;
export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const MIN_SQRT_PRICE = 4_295_048_016n;

export function isqrt(n: bigint): bigint {
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

function rational(input: string): { num: bigint; den: bigint } {
  const m = /^(\d+)?(?:\.(\d+))?$/.exec(input.trim());
  if (!m) throw new Error(`not a decimal: ${input}`);
  const frac = m[2] ?? "";
  return { num: BigInt((m[1] ?? "0") + frac), den: 10n ** BigInt(frac.length) };
}

/** Q64.64 sqrt price (rounded down) for a price in SOL per whole token. */
export function sqrtPriceFromPrice(price: string, decimals: number): bigint {
  const { num, den } = rational(price);
  return isqrt((num * 10n ** BigInt(QUOTE_DECIMALS) * (1n << 128n)) / (den * 10n ** BigInt(decimals)));
}

/** SOL per whole token for a Q64.64 sqrt price (display). */
export function priceOf(sqrtPrice: bigint, decimals: number): number {
  const s = Number(sqrtPrice) / 2 ** 64;
  return s * s * 10 ** (decimals - QUOTE_DECIMALS);
}

export interface CurvePoint {
  sqrtPrice: bigint;
  liquidity: bigint;
}

export interface Curve {
  decimals: number;
  sqrtStart: bigint;
  points: CurvePoint[];
  thresholdLamports: bigint;
}

/** The SDK's two-point design: constant liquidity from start to graduation price, then 1.5x sqrt-price headroom. */
export function designCurve(decimals: number, startPrice: string, graduationPrice: string, thresholdLamports: bigint): Curve {
  const s0 = sqrtPriceFromPrice(startPrice, decimals);
  const s1 = sqrtPriceFromPrice(graduationPrice, decimals);
  const s2 = s1 + s1 / 2n;
  const liquidity = (thresholdLamports << 128n) / (s1 - s0);
  return { decimals, sqrtStart: s0, points: [{ sqrtPrice: s1, liquidity }, { sqrtPrice: s2, liquidity }], thresholdLamports };
}

export interface PresetShape {
  name: "fair" | "community" | "turbo";
  title: string;
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

/** Copied from sdk/src/launch/presets.ts (checked by the tests). Token decimals are 6 in every preset. */
export const PRESET_SHAPES: readonly PresetShape[] = [
  { name: "fair", title: "Fair", startPrice: "0.00000003", graduationPrice: "0.0000004", thresholdSol: 85n, feeBps: 100, migrationFeeOption: 2, openDelaySecs: 300, guardSecs: 6 * 3600, maxWalletBps: 100, maxBuyBps: 50, p2pLocked: false, batchWalletCapSol: 5n },
  { name: "community", title: "Community", startPrice: "0.00000005", graduationPrice: "0.0000006", thresholdSol: 250n, feeBps: 100, migrationFeeOption: 1, openDelaySecs: 1800, guardSecs: 24 * 3600, maxWalletBps: 200, maxBuyBps: 100, p2pLocked: true, batchWalletCapSol: 2n },
  { name: "turbo", title: "Turbo", startPrice: "0.00000002", graduationPrice: "0.0000003", thresholdSol: 40n, feeBps: 150, migrationFeeOption: 3, openDelaySecs: 60, guardSecs: 3600, maxWalletBps: 300, maxBuyBps: 0, p2pLocked: false, batchWalletCapSol: 0n },
];

export const PRESET_DECIMALS = 6;

export function presetCurve(p: PresetShape): Curve {
  return designCurve(PRESET_DECIMALS, p.startPrice, p.graduationPrice, p.thresholdSol * LAMPORTS_PER_SOL);
}

/** Where the curve is after absorbing `quote` lamports from the start: sqrt price and base released so far. */
export function stateAfter(curve: Curve, quote: bigint): { sqrtPrice: bigint; base: bigint } | null {
  let remaining = quote;
  let lower = curve.sqrtStart;
  let base = 0n;
  for (const pt of curve.points) {
    const capacity = (pt.liquidity * (pt.sqrtPrice - lower)) >> 128n;
    if (capacity >= remaining) {
      const upper = lower + (remaining << 128n) / pt.liquidity;
      base += (pt.liquidity * (upper - lower)) / (lower * upper);
      return { sqrtPrice: upper, base };
    }
    base += (pt.liquidity * (pt.sqrtPrice - lower)) / (lower * pt.sqrtPrice);
    remaining -= capacity;
    lower = pt.sqrtPrice;
  }
  return null;
}

/** Base units the curve releases for `quote` lamports starting after `before` lamports (no fee). */
export function baseFor(curve: Curve, before: bigint, quote: bigint): bigint {
  const a = stateAfter(curve, before);
  const b = stateAfter(curve, before + quote);
  if (!a || !b) return 0n;
  return b.base - a.base;
}

/** Display: SOL per whole token paid on average for `quoteSol` SOL bought after `beforeSol` SOL (no fee). */
export function averagePrice(curve: Curve, beforeSol: number, quoteSol: number): number {
  const before = BigInt(Math.round(beforeSol * 1e9));
  const q = BigInt(Math.round(quoteSol * 1e9));
  const base = baseFor(curve, before, q);
  if (base === 0n) return Number.NaN;
  return (quoteSol * 10 ** curve.decimals) / Number(base);
}

/** Display: the marginal price (SOL per whole token) after `quoteSol` SOL has entered the curve. */
export function marginalPrice(curve: Curve, quoteSol: number): number {
  const st = stateAfter(curve, BigInt(Math.round(quoteSol * 1e9)));
  return st ? priceOf(st.sqrtPrice, curve.decimals) : Number.NaN;
}

/** Tokens (whole) released by the curve up to the graduation threshold. */
export function curveSupplyAtThreshold(curve: Curve): number {
  const st = stateAfter(curve, curve.thresholdLamports);
  return st ? Number(st.base) / 10 ** curve.decimals : Number.NaN;
}

/**
 * Base DBC pairs with the raise at migration (the SDK's estimate: threshold / price at the migration sqrt price),
 * in whole tokens.
 */
export function migrationBase(curve: Curve): number {
  const st = stateAfter(curve, curve.thresholdLamports);
  if (!st) return Number.NaN;
  return Number((curve.thresholdLamports << 128n) / (st.sqrtPrice * st.sqrtPrice)) / 10 ** curve.decimals;
}

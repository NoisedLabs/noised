/**
 * Exact decimal <-> integer conversions. Amounts never go through floating
 * point: a typo must not silently turn into a different on-chain amount.
 */

export const U64_MAX = (1n << 64n) - 1n;

/** "12", "12.", "12.5" or ".5" — nothing else (no signs, exponents, separators). */
const DECIMAL_RE = /^(?:(\d+)(?:\.(\d*))?|\.(\d+))$/;

/**
 * Parse a human decimal ("1.25") into base units with `decimals` places.
 * Rejects signs, exponents, separators, empty input and excess precision
 * (rather than rounding the user's number).
 */
export function parseUnits(input: string, decimals: number): bigint {
  const s = input.trim();
  const m = DECIMAL_RE.exec(s);
  if (!m) throw new Error("Enter a plain number like 1.5");
  const whole = m[1] ?? "0";
  const frac = m[2] ?? m[3] ?? "";
  if (frac.length > decimals) throw new Error(`At most ${decimals} decimal places`);
  const value = BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
  if (value > U64_MAX) throw new Error("Amount is too large");
  return value;
}

/** Like `parseUnits` but returns null instead of throwing (for live inputs). */
export function tryParseUnits(input: string, decimals: number): bigint | null {
  try {
    return parseUnits(input, decimals);
  } catch {
    return null;
  }
}

/** Format base units as a decimal string, trimming trailing zeros. */
export function formatUnits(value: bigint, decimals: number, maxFraction = decimals): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  let frac = (v % base).toString().padStart(decimals, "0").slice(0, Math.max(0, maxFraction));
  frac = frac.replace(/0+$/, "");
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${wholeStr}${frac ? "." + frac : ""}`;
}

export const SOL_DECIMALS = 9;

export function formatSol(lamports: bigint, maxFraction = 4): string {
  return `${formatUnits(lamports, SOL_DECIMALS, maxFraction)} SOL`;
}

/** Every lamport shown (trailing zeros trimmed): for exact protocol values such as caps and thresholds, which must never be rounded down. */
export function formatSolExact(lamports: bigint): string {
  return formatSol(lamports, SOL_DECIMALS);
}

/** Basis points as a percentage string ("2.5%"). */
export function formatBps(bps: number): string {
  const pct = bps / 100;
  return `${Number.isInteger(pct) ? pct.toString() : pct.toFixed(2).replace(/0+$/, "")}%`;
}

/** Parse a percentage ("2.5") into basis points; integers only after scaling. */
export function parsePercentToBps(input: string): number {
  const s = input.trim();
  const m = /^(\d+)(?:\.(\d{0,2}))?$/.exec(s);
  if (!m) throw new Error("Enter a percentage like 2.5 (at most 2 decimals)");
  const bps = Number(m[1]) * 100 + Number(((m[2] ?? "") + "00").slice(0, 2));
  if (bps > 10_000) throw new Error("At most 100%");
  return bps;
}

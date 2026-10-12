/**
 * Exact unit conversions: durations, SOL <-> lamports, tokens <-> raw units,
 * percent <-> bps, price <-> DAMM v2 sqrt price (Q64.64), dates.
 *
 * Convention used across the module: a `number` or decimal string is a human
 * amount (SOL, whole tokens), a `bigint` is a raw on-chain amount (lamports,
 * raw token units). Every conversion is exact or throws ProgError.
 */
import { BPS_DENOMINATOR, DEFAULT_TOKEN_DECIMALS, LAMPORTS_PER_SOL, U64_MAX } from "./constants.js";
import { ProgError } from "./errors.js";

/** Seconds (number) or text such as "90s", "2m", "1h30m", "1d", "2 minutes". */
export type Duration = number | string;
/** SOL as a number / decimal string, or lamports as a bigint. */
export type SolAmount = number | string | bigint;
/** Whole tokens as a number / decimal string, or raw units as a bigint. */
export type TokenAmount = number | string | bigint;
/** A share of supply: "1%", "0.5%", "25bps" or { bps }. */
export type Percent = `${number}%` | `${number}bps` | { bps: number };

// ------------------------------------------------------------ decimals ---

/** An exact decimal: value = num / 10^scale. */
export interface Decimal {
  num: bigint;
  scale: number;
}

const DECIMAL_RE = /^([+-]?)(\d[\d_]*)?(?:\.(\d[\d_]*)?)?(?:[eE]([+-]?\d+))?$/;

/** Parses "1.5", "0.000001", "1e-7", "1_000" exactly; null if not a plain decimal. */
export function parseDecimal(text: string): Decimal | null {
  const m = DECIMAL_RE.exec(text.trim());
  if (!m || (m[2] === undefined && m[3] === undefined)) return null;
  const sign = m[1] === "-" ? -1n : 1n;
  const int = (m[2] ?? "0").replaceAll("_", "");
  const frac = (m[3] ?? "").replaceAll("_", "");
  const exp = m[4] === undefined ? 0 : Number(m[4]);
  if (!Number.isSafeInteger(exp) || Math.abs(exp) > 400) return null;
  let num = BigInt(int + frac) * sign;
  let scale = frac.length - exp;
  if (scale < 0) {
    num *= 10n ** BigInt(-scale);
    scale = 0;
  }
  // normalize trailing zeros
  while (scale > 0 && num % 10n === 0n) {
    num /= 10n;
    scale--;
  }
  return { num, scale };
}

function decimalOf(v: number | string, what: string): Decimal {
  const text = typeof v === "number" ? numberText(v, what) : v;
  const d = parseDecimal(text);
  if (d === null) throw new ProgError("BadAmount", `${what}: "${text}" is not a number`);
  return d;
}

function numberText(v: number, what: string): string {
  if (!Number.isFinite(v)) throw new ProgError("BadAmount", `${what}: ${v} is not a finite number`);
  return String(v);
}

/**
 * The decimal a JS number stands for, at most `decimals` places. Binary
 * floating point can't hold most decimals exactly (0.1 * 3 is
 * 0.30000000000000004), so a number within a few ULPs of a `decimals`-place
 * decimal is read as that decimal; anything genuinely more precise
 * (1e-10 SOL) keeps all its digits and is refused by scaleDecimal. Strings
 * and bigints are always taken exactly.
 */
function numberDecimal(v: number, decimals: number, what: string): Decimal {
  const d = decimalOf(v, what);
  if (d.scale <= decimals || decimals > 100) return d;
  const fixed = v.toFixed(decimals);
  const noise = Math.abs(Number(fixed) - v) <= Math.abs(v) * Number.EPSILON * 8;
  return noise ? decimalOf(fixed, what) : d;
}

/** decimal * 10^decimals as an exact integer; throws if it has more precision. */
export function scaleDecimal(d: Decimal, decimals: number, what: string): bigint {
  if (d.scale > decimals) {
    throw new ProgError("BadAmount", `${what}: too many decimal places (at most ${decimals})`);
  }
  return d.num * 10n ** BigInt(decimals - d.scale);
}

/** Formats raw / 10^decimals exactly ("1.5", "0.000001", "1000"). */
export function formatScaled(raw: bigint, decimals: number, group = false): string {
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  let int = (abs / base).toString();
  if (group) int = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  let frac = decimals === 0 ? "" : (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  if (frac) frac = "." + frac;
  return (neg ? "-" : "") + int + frac;
}

function checkU64(v: bigint, what: string): bigint {
  if (v < 0n) throw new ProgError("BadAmount", `${what} can't be negative`);
  if (v > U64_MAX) throw new ProgError("BadAmount", `${what} is too large`);
  return v;
}

// ------------------------------------------------------------ SOL ---

/** SOL (number / decimal string) or lamports (bigint) -> lamports. A number may carry float noise (0.1 * 3). */
export function toLamports(v: SolAmount, what = "SOL amount"): bigint {
  if (typeof v === "bigint") return checkU64(v, what);
  const d = typeof v === "number" ? numberDecimal(v, 9, what) : decimalOf(v, what);
  return checkU64(scaleDecimal(d, 9, what), what);
}

/** lamports -> "0.5" (exact). */
export function formatSol(lamports: bigint, group = false): string {
  return formatScaled(lamports, 9, group);
}

/** lamports -> SOL as a float, for charts. */
export function lamportsToSol(lamports: bigint): number {
  return Number(lamports) / Number(LAMPORTS_PER_SOL);
}

// ------------------------------------------------------------ tokens ---

/** Whole tokens (number / decimal string) or raw units (bigint) -> raw units. A number may carry float noise. */
export function toTokenUnits(v: TokenAmount, decimals = DEFAULT_TOKEN_DECIMALS, what = "token amount"): bigint {
  if (typeof v === "bigint") return checkU64(v, what);
  const d = typeof v === "number" ? numberDecimal(v, decimals, what) : decimalOf(v, what);
  return checkU64(scaleDecimal(d, decimals, what), what);
}

/** raw units -> "1000.5" (exact). */
export function formatTokens(units: bigint, decimals = DEFAULT_TOKEN_DECIMALS, group = false): string {
  return formatScaled(units, decimals, group);
}

/** raw units -> whole tokens as a float, for charts. */
export function unitsToTokens(units: bigint, decimals = DEFAULT_TOKEN_DECIMALS): number {
  return Number(units) / 10 ** decimals;
}

// ------------------------------------------------------------ percent ---

/** "1%" | "0.25%" | "25bps" | { bps } | number of bps -> integer bps. Throws below 0.01% precision. */
export function toBps(v: Percent | number | string, what = "percentage"): number {
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new ProgError("BadAmount", `${what}: bps must be a whole number`);
    return v;
  }
  if (typeof v === "object") return toBps(v.bps, what);
  const t = v.trim();
  if (t.endsWith("%")) {
    const d = decimalOf(t.slice(0, -1).trim(), what);
    if (d.scale > 2) throw new ProgError("BadAmount", `${what}: percentages go in steps of 0.01%`);
    return Number(scaleDecimal(d, 2, what));
  }
  if (t.endsWith("bps")) {
    const d = decimalOf(t.slice(0, -3).trim(), what);
    if (d.scale > 0) throw new ProgError("BadAmount", `${what}: bps must be a whole number`);
    return Number(d.num);
  }
  throw new ProgError("BadAmount", `${what}: write a percentage like "1%" or "25bps"`);
}

/** True for "1%", "25bps", { bps } — values that toBps understands as a share. */
export function isPercentLike(v: unknown): v is Percent {
  if (typeof v === "object" && v !== null && "bps" in v) return true;
  return typeof v === "string" && /^\s*[\d.]+\s*(%|bps)\s*$/.test(v);
}

/** 50 -> "0.5%", 10000 -> "100%". */
export function formatBps(bps: number): string {
  return `${formatScaled(BigInt(bps), 2)}%`;
}

/** floor(supply * bps / 10000) — the hook's bps-of-supply cap. */
export function bpsOfSupply(supply: bigint, bps: number): bigint {
  return (supply * BigInt(bps)) / BigInt(BPS_DENOMINATOR);
}

// ------------------------------------------------------------ durations ---

const UNIT_SECS: Readonly<Record<string, number>> = {
  s: 1, sec: 1, secs: 1, second: 1, seconds: 1,
  m: 60, min: 60, mins: 60, minute: 60, minutes: 60,
  h: 3_600, hr: 3_600, hrs: 3_600, hour: 3_600, hours: 3_600,
  d: 86_400, day: 86_400, days: 86_400,
  w: 604_800, week: 604_800, weeks: 604_800,
};

/** Seconds per duration unit word ("m", "minutes", ...), or undefined. */
export function durationUnitSecs(unit: string): number | undefined {
  return UNIT_SECS[unit.toLowerCase()];
}

/** "90s" | "2m" | "1h30m" | "1 day" | 120 -> seconds (whole, >= 0). */
export function toSeconds(v: Duration, what = "duration"): number {
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || v < 0) throw new ProgError("BadDuration", `${what}: ${v} is not a whole number of seconds`);
    return v;
  }
  const t = v.trim().toLowerCase();
  if (/^\d+$/.test(t)) return Number(t);
  const re = /(\d+(?:\.\d+)?)\s*([a-z]+)\s*/gy;
  let total = 0;
  let pos = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    const unit = UNIT_SECS[m[2]!];
    if (unit === undefined) throw new ProgError("BadDuration", `${what}: unknown unit "${m[2]}" (use s, m, h, d or w)`);
    const d = parseDecimal(m[1]!)!;
    const secs = d.num * BigInt(unit);
    const scale = 10n ** BigInt(d.scale);
    if (secs % scale !== 0n) throw new ProgError("BadDuration", `${what}: "${v}" is not a whole number of seconds`);
    total += Number(secs / scale);
    pos = re.lastIndex;
  }
  if (pos !== t.length || pos === 0) throw new ProgError("BadDuration", `${what}: "${v}" is not a duration (try "2m", "1h30m" or "1d")`);
  if (!Number.isSafeInteger(total)) throw new ProgError("BadDuration", `${what}: too long`);
  return total;
}

/** Canonical short form: 0 -> "0s", 90 -> "1m30s", 93600 -> "1d2h". */
export function formatDuration(secs: number): string {
  if (secs === 0) return "0s";
  const parts: string[] = [];
  let r = secs;
  for (const [u, n] of [["d", 86_400], ["h", 3_600], ["m", 60], ["s", 1]] as const) {
    const q = Math.floor(r / n);
    if (q > 0) parts.push(`${q}${u}`);
    r -= q * n;
  }
  return parts.join("");
}

/** Plain English: 120 -> "2 minutes", 5400 -> "1 hour 30 minutes", 86400 -> "1 day". */
export function formatDurationLong(secs: number): string {
  if (secs === 0) return "0 seconds";
  const parts: string[] = [];
  let r = secs;
  for (const [u, n] of [["day", 86_400], ["hour", 3_600], ["minute", 60], ["second", 1]] as const) {
    const q = Math.floor(r / n);
    if (q > 0) parts.push(`${q} ${u}${q === 1 ? "" : "s"}`);
    r -= q * n;
  }
  return parts.join(" ");
}

/** "every day" style: 86400 -> "day", 3600 -> "hour", 7200 -> "2 hours". */
export function formatPeriod(secs: number): string {
  for (const [u, n] of [["week", 604_800], ["day", 86_400], ["hour", 3_600], ["minute", 60]] as const) {
    if (secs === n) return u;
  }
  return formatDurationLong(secs);
}

// ------------------------------------------------------------ dates ---

/** Date | unix seconds | ISO text ("2026-12-01", "2026-12-01T12:00:00Z") -> unix seconds. */
export function toUnix(v: Date | number | bigint | string, what = "date"): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || v < 0) throw new ProgError("BadAmount", `${what}: ${v} is not a unix time in seconds`);
    return BigInt(v);
  }
  if (v instanceof Date) {
    const ms = v.getTime();
    if (!Number.isFinite(ms) || ms < 0) throw new ProgError("BadAmount", `${what}: invalid date`);
    return BigInt(Math.floor(ms / 1000));
  }
  const t = v.trim();
  if (/^\d+$/.test(t)) return BigInt(t);
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})?)?$/.test(t)) {
    throw new ProgError("BadAmount", `${what}: write a date like 2026-12-01 or 2026-12-01T12:00:00Z`);
  }
  const iso = t.length === 10 ? `${t}T00:00:00Z` : /Z|[+-]\d{2}:\d{2}$/.test(t) ? t : `${t}Z`;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) throw new ProgError("BadAmount", `${what}: invalid date "${t}"`);
  return BigInt(Math.floor(ms / 1000));
}

/** Last second of year 9999: later times have no YYYY-MM-DD form. */
const MAX_ISO_UNIX = 253_402_300_799n;

/**
 * unix -> "2026-12-01" (midnight UTC) or "2026-12-01T12:30:00Z"; times past
 * year 9999 stay numeric, so toUnix(formatDate(t)) === t for every t >= 0.
 */
export function formatDate(unix: bigint): string {
  if (unix < 0n || unix > MAX_ISO_UNIX) return unix.toString();
  const iso = new Date(Number(unix) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  return iso.endsWith("T00:00:00Z") ? iso.slice(0, 10) : iso;
}

// ------------------------------------------------------------ prices ---

const Q128 = 1n << 128n;

/** Integer square root (floor). */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError("isqrt of a negative number");
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  // Newton refine from the float guess.
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) break;
    x = y;
  }
  while (x * x > n) x--;
  while ((x + 1n) * (x + 1n) <= n) x++;
  return x;
}

/**
 * SOL per whole token -> DAMM v2 sqrt price (Q64.64, floor), for a token with
 * `decimals` decimals against SOL (9). Throws PriceOutOfRange above u64.
 */
export function priceToSqrtPriceQ64(solPerToken: number | string, decimals = DEFAULT_TOKEN_DECIMALS): bigint {
  const d = decimalOf(solPerToken, "price");
  if (d.num < 0n) throw new ProgError("PriceOutOfRange", "a price can't be negative");
  // raw price = solPerToken * 10^9 / 10^decimals; sqrt * 2^64 = isqrt(raw * 2^128)
  const num = d.num * LAMPORTS_PER_SOL * Q128;
  const den = 10n ** BigInt(d.scale + decimals);
  const s = isqrt(num / den);
  if (s > U64_MAX) {
    throw new ProgError("PriceOutOfRange", "price is too high to compare on-chain (a u64 sqrt price)");
  }
  return s;
}

/**
 * The shortest decimal SOL-per-token price whose sqrt price is exactly `s`
 * (so priceToSqrtPriceQ64(sqrtPriceQ64ToPriceText(s)) === s).
 */
export function sqrtPriceQ64ToPriceText(s: bigint, decimals = DEFAULT_TOKEN_DECIMALS): string {
  if (s === 0n) return "0";
  // s^2 <= c * Kn / (10^n * Kd) < (s+1)^2 with Kn = 10^9 * 2^128, Kd = 10^decimals
  const kn = LAMPORTS_PER_SOL * Q128;
  const kd = 10n ** BigInt(decimals);
  for (let n = 0; n <= 120; n++) {
    const p = 10n ** BigInt(n);
    const lo = s * s * p * kd;
    const c = (lo + kn - 1n) / kn;
    if (c * kn < (s + 1n) * (s + 1n) * p * kd) return formatScaled(c, n);
  }
  throw new ProgError("PriceOutOfRange", "price has no short decimal form");
}

/** sqrt price (Q64.64) -> SOL per whole token as a float, for charts. */
export function sqrtPriceQ64ToPrice(s: bigint, decimals = DEFAULT_TOKEN_DECIMALS): number {
  const x = Number(s) / 2 ** 64;
  return (x * x * 10 ** decimals) / 1e9;
}

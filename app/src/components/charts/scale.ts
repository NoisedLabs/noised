/**
 * Scales, ticks and number formats for the in-house SVG charts (no chart library: CSP script-src 'self' and no new
 * runtime dependencies). Pure functions only.
 */

export interface Scale {
  (v: number): number;
  readonly domain: readonly [number, number];
  readonly range: readonly [number, number];
  readonly log: boolean;
  /** Pixel back to data value. */
  invert(px: number): number;
  /** Tick values inside the domain. */
  ticks(count?: number): number[];
}

/** Linear scale. */
export function linearScale(domain: readonly [number, number], range: readonly [number, number]): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  const f = ((v: number) => r0 + (v - d0) * k) as Scale;
  return Object.assign(f, {
    domain,
    range,
    log: false,
    invert: (px: number) => (k === 0 ? d0 : d0 + (px - r0) / k),
    ticks: (count = 5) => niceTicks(d0, d1, count),
  });
}

/** Logarithmic scale (any base > 1); the domain must be positive. Ticks fall on powers of the base. */
export function logScale(domain: readonly [number, number], range: readonly [number, number], base = 10): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const l0 = Math.log(d0) / Math.log(base);
  const l1 = Math.log(d1) / Math.log(base);
  const k = l1 === l0 ? 0 : (r1 - r0) / (l1 - l0);
  const f = ((v: number) => r0 + (Math.log(Math.max(v, Number.MIN_VALUE)) / Math.log(base) - l0) * k) as Scale;
  return Object.assign(f, {
    domain,
    range,
    log: true,
    invert: (px: number) => base ** (l0 + (px - r0) / (k === 0 ? 1 : k)),
    ticks: (count = 6) => {
      const lo = Math.ceil(l0 - 1e-9);
      const hi = Math.floor(l1 + 1e-9);
      const span = Math.max(1, hi - lo);
      const step = Math.max(1, Math.ceil(span / Math.max(1, count - 1)));
      const out: number[] = [];
      for (let e = lo; e <= hi; e += step) out.push(base ** e);
      return out;
    },
  });
}

/** "Nice" ticks (1, 2, 2.5, 5 x 10^k steps) covering [lo, hi]. */
export function niceTicks(lo: number, hi: number, count = 5): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  if (hi < lo) [lo, hi] = [hi, lo];
  if (hi === lo) return [lo];
  const raw = (hi - lo) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const first = Math.ceil(lo / step - 1e-9) * step;
  const out: number[] = [];
  for (let v = first; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : Number(v.toPrecision(12)));
  return out;
}

const SUPERSCRIPT: Record<string, string> = { "-": "⁻", "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹" };

/** "10⁶"-style power label. */
export function powerLabel(base: number, exponent: number): string {
  return `${base}${String(exponent)
    .split("")
    .map((c) => SUPERSCRIPT[c] ?? c)
    .join("")}`;
}

/** Thousands-separated number with at most `digits` decimals (trailing zeros dropped). */
export function fmt(v: number, digits = 2): string {
  if (!Number.isFinite(v)) return "–";
  return v.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

/** Compact: 1.2k, 3.4M, 5.6B. */
export function fmtCompact(v: number, digits = 1): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `${fmt(v / 1e9, digits)}B`;
  if (a >= 1e6) return `${fmt(v / 1e6, digits)}M`;
  if (a >= 1e3) return `${fmt(v / 1e3, digits)}k`;
  return fmt(v, digits);
}

/** Tick label for a log axis: powers of ten as 10^k, other bases as plain numbers. */
export function fmtLogTick(v: number, base = 10): string {
  const e = Math.round(Math.log(v) / Math.log(base));
  if (base === 10 && (e >= 4 || e <= -3)) return powerLabel(10, e);
  if (base === 2) return powerLabel(2, e);
  return fmt(v, 4);
}

/** Index of the point whose x is nearest to `x` (points sorted by x). */
export function nearestIndex(xs: readonly number[], x: number): number {
  let lo = 0;
  let hi = xs.length - 1;
  if (hi < 0) return -1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((xs[mid] ?? 0) < x) lo = mid;
    else hi = mid;
  }
  return Math.abs((xs[lo] ?? 0) - x) <= Math.abs((xs[hi] ?? 0) - x) ? lo : hi;
}

/** SVG path through points ("M x y L x y ..."), optionally as steps (horizontal first). */
export function linePath(points: readonly (readonly [number, number])[], step = false): string {
  let d = "";
  let prev: readonly [number, number] | undefined;
  for (const p of points) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
      prev = undefined;
      continue;
    }
    if (prev === undefined) d += `M${p[0].toFixed(2)} ${p[1].toFixed(2)}`;
    else if (step) d += `H${p[0].toFixed(2)}V${p[1].toFixed(2)}`;
    else d += `L${p[0].toFixed(2)} ${p[1].toFixed(2)}`;
    prev = p;
  }
  return d;
}

/** Closed area between an upper and a lower polyline (same x samples). */
export function bandPath(upper: readonly (readonly [number, number])[], lower: readonly (readonly [number, number])[]): string {
  if (upper.length === 0) return "";
  const top = upper.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join("");
  const bottom = [...lower]
    .reverse()
    .map((p) => `L${p[0].toFixed(2)} ${p[1].toFixed(2)}`)
    .join("");
  return `${top}${bottom}Z`;
}

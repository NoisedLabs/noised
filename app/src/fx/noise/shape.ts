/**
 * Shapes for the noise engine: simple vector paths defined in code, sampled into point sets the dots coalesce into.
 *
 *   const lock = shape(100, 100)
 *     .stroke(roundRect(26, 46, 48, 40, 7))                       // dots spaced evenly along the outline
 *     .fill(roundRect(30, 50, 40, 32, 5), { weight: 0.6 })          // a sparser field of dots inside
 *     .stroke("M36 46 V34 C36 18 64 18 64 34 V46", { group: 1 })   // SVG path data (M L H V C S Q T Z, any case)
 *     .build();
 *   const pts = sampleShape(lock, 600, seed);                       // exactly 600 points, the same for the same seed
 *
 * Coordinates are in the shape's own box (w x h, y down). A stroke places points at even arc-length steps (a hairline
 * of dots); a fill places them on a jittered grid inside the outline (even-odd, so inner outlines cut holes). Each
 * element can carry a `group` (moved as one by a scene: a lock's shackle, a dial) and a `weight` (its share of dots).
 */
import { rng, shuffle } from "./rng";

/** A flattened polyline: x0, y0, x1, y1, ... */
export interface Poly {
  readonly pts: Float32Array;
  readonly closed: boolean;
}

export interface ShapeElement {
  readonly mode: "stroke" | "fill";
  readonly polys: readonly Poly[];
  readonly weight: number;
  readonly group: number;
}

export interface Shape {
  readonly w: number;
  readonly h: number;
  readonly elements: readonly ShapeElement[];
}

export interface ElementOptions {
  /** Share of the dots relative to the element's length (stroke) or area (fill). Default 1. */
  weight?: number;
  /** Moved as one by the scene's transform (default 0). */
  group?: number;
}

export type PathSource = string | Poly | readonly Poly[];

// ------------------------------------------------------------- builders ---

function poly(points: readonly number[], closed: boolean): Poly {
  return { pts: Float32Array.from(points), closed };
}

/** A straight segment. */
export function line(x1: number, y1: number, x2: number, y2: number): Poly {
  return poly([x1, y1, x2, y2], false);
}

/** An open or closed polyline through [x, y] pairs. */
export function polygon(points: readonly (readonly [number, number])[], closed = true): Poly {
  return poly(points.flatMap(([x, y]) => [x, y]), closed);
}

/** An arc of a circle (angles in radians, 0 = +x, clockwise on screen since y points down). */
export function arc(cx: number, cy: number, r: number, a0: number, a1: number, segments?: number): Poly {
  const n = segments ?? Math.max(8, Math.ceil((Math.abs(a1 - a0) / (Math.PI * 2)) * 72));
  const out: number[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  return poly(out, false);
}

/** An ellipse (closed). */
export function ellipse(cx: number, cy: number, rx: number, ry: number, segments = 72): Poly {
  const out: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2 - Math.PI / 2;
    out.push(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry);
  }
  return poly(out, true);
}

/** A circle (closed), starting at the top and going clockwise. */
export function circle(cx: number, cy: number, r: number, segments = 72): Poly {
  return ellipse(cx, cy, r, r, segments);
}

/** An axis-aligned rectangle (closed). */
export function rect(x: number, y: number, w: number, h: number): Poly {
  return poly([x, y, x + w, y, x + w, y + h, x, y + h], true);
}

/** A rectangle with round corners of radius r (closed). */
export function roundRect(x: number, y: number, w: number, h: number, r: number): Poly {
  const k = Math.max(0, Math.min(r, w / 2, h / 2));
  const out: number[] = [];
  const corner = (cx: number, cy: number, a0: number): void => {
    for (let i = 0; i <= 6; i++) {
      const a = a0 + (Math.PI / 2) * (i / 6);
      out.push(cx + Math.cos(a) * k, cy + Math.sin(a) * k);
    }
  };
  corner(x + w - k, y + k, -Math.PI / 2);
  corner(x + w - k, y + h - k, 0);
  corner(x + k, y + h - k, Math.PI / 2);
  corner(x + k, y + k, Math.PI);
  return poly(out, true);
}

/** A regular hexagon (closed); pointy top by default, like the hero wall's cells. */
export function hexagon(cx: number, cy: number, r: number, rotation = -Math.PI / 2): Poly {
  const out: number[] = [];
  for (let i = 0; i < 6; i++) {
    const a = rotation + (i * Math.PI) / 3;
    out.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  return poly(out, true);
}

// ------------------------------------------------------- SVG path data ---

const CMD = /[MmLlHhVvCcSsQqTtZz]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g;

/** Flattens SVG path data (M L H V C S Q T Z, absolute or relative; no arcs: use arc() / circle()) into polylines. */
export function parsePath(d: string, curveSegments = 18): Poly[] {
  const tokens = d.match(CMD) ?? [];
  const out: Poly[] = [];
  let cur: number[] = [];
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  // The last control point (for S / T reflections).
  let cx = 0;
  let cy = 0;
  let prev = "";
  let i = 0;
  let cmd = "";
  const num = (): number => Number(tokens[i++] ?? 0);
  const flush = (closed: boolean): void => {
    if (cur.length >= 4) out.push(poly(cur, closed));
    cur = [];
  };
  const cubic = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): void => {
    const x0 = x;
    const y0 = y;
    for (let k = 1; k <= curveSegments; k++) {
      const t = k / curveSegments;
      const u = 1 - t;
      cur.push(u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3);
    }
    cx = x2;
    cy = y2;
    x = x3;
    y = y3;
  };
  const quad = (x1: number, y1: number, x2: number, y2: number): void => {
    const x0 = x;
    const y0 = y;
    for (let k = 1; k <= curveSegments; k++) {
      const t = k / curveSegments;
      const u = 1 - t;
      cur.push(u * u * x0 + 2 * u * t * x1 + t * t * x2, u * u * y0 + 2 * u * t * y1 + t * t * y2);
    }
    cx = x1;
    cy = y1;
    x = x2;
    y = y2;
  };
  while (i < tokens.length) {
    const tok = tokens[i] ?? "";
    if (/[a-zA-Z]/.test(tok)) {
      cmd = tok;
      i++;
    } else if (cmd === "") {
      i++;
      continue;
    }
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    switch (cmd.toUpperCase()) {
      case "M": {
        flush(false);
        x = ox + num();
        y = oy + num();
        sx = x;
        sy = y;
        cur.push(x, y);
        // Further pairs after M are line-tos.
        cmd = rel ? "l" : "L";
        break;
      }
      case "L":
        x = ox + num();
        y = oy + num();
        cur.push(x, y);
        break;
      case "H":
        x = ox + num();
        cur.push(x, y);
        break;
      case "V":
        y = oy + num();
        cur.push(x, y);
        break;
      case "C": {
        const x1 = ox + num();
        const y1 = oy + num();
        const x2 = ox + num();
        const y2 = oy + num();
        cubic(x1, y1, x2, y2, ox + num(), oy + num());
        break;
      }
      case "S": {
        const reflect = /[CcSs]/.test(prev);
        const x1 = reflect ? 2 * x - cx : x;
        const y1 = reflect ? 2 * y - cy : y;
        const x2 = ox + num();
        const y2 = oy + num();
        cubic(x1, y1, x2, y2, ox + num(), oy + num());
        break;
      }
      case "Q": {
        const x1 = ox + num();
        const y1 = oy + num();
        quad(x1, y1, ox + num(), oy + num());
        break;
      }
      case "T": {
        const reflect = /[QqTt]/.test(prev);
        quad(reflect ? 2 * x - cx : x, reflect ? 2 * y - cy : y, ox + num(), oy + num());
        break;
      }
      case "Z":
        x = sx;
        y = sy;
        flush(true);
        cur.push(x, y);
        break;
      default:
        i++;
    }
    prev = cmd;
  }
  flush(false);
  return out;
}

// ------------------------------------------------------------- builder ---

export interface ShapeBuilder {
  /** Dots along the outline. */
  stroke(src: PathSource, opts?: ElementOptions): ShapeBuilder;
  /** Dots inside the outline (even-odd). */
  fill(src: PathSource, opts?: ElementOptions): ShapeBuilder;
  build(): Shape;
}

function toPolys(src: PathSource): readonly Poly[] {
  if (typeof src === "string") return parsePath(src);
  return "pts" in src ? [src as Poly] : (src as readonly Poly[]);
}

/** Starts a shape in a w x h box. */
export function shape(w: number, h: number): ShapeBuilder {
  const elements: ShapeElement[] = [];
  const builder: ShapeBuilder = {
    stroke(src, opts = {}) {
      elements.push({ mode: "stroke", polys: toPolys(src), weight: opts.weight ?? 1, group: opts.group ?? 0 });
      return builder;
    },
    fill(src, opts = {}) {
      elements.push({ mode: "fill", polys: toPolys(src), weight: opts.weight ?? 1, group: opts.group ?? 0 });
      return builder;
    },
    build() {
      return { w, h, elements: elements.slice() };
    },
  };
  return builder;
}

// ------------------------------------------------------------ sampling ---

/** Points sampled from a shape: positions in the shape's box, the element and group of each, the outline normal
 *  of stroke points (outward on closed outlines; 0, 0 for fill points) and `u`: how far along its stroke a point sits (0..1; fills: 0..1 by
 *  height, top = 0). */
export interface ShapePoints {
  readonly n: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly nx: Float32Array;
  readonly ny: Float32Array;
  readonly u: Float32Array;
  readonly el: Uint16Array;
  readonly group: Uint8Array;
}

export interface SampleOptions {
  /** Fill dot spacing relative to stroke dot spacing (default 1.7: fills read as a softer field than outlines). */
  fillSpacing?: number;
  /** Jitter of stroke points along the outline, as a share of their spacing (default 0.12). */
  jitter?: number;
}

function polyLength(p: Poly): number {
  const a = p.pts;
  let len = 0;
  const m = a.length / 2;
  const segs = p.closed ? m : m - 1;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % m;
    len += Math.hypot(a[j * 2]! - a[i * 2]!, a[j * 2 + 1]! - a[i * 2 + 1]!);
  }
  return len;
}

/** Shoelace area of a closed outline (positive: clockwise on screen, y down). */
function signedArea(p: Poly): number {
  const a = p.pts;
  const m = a.length / 2;
  let sum = 0;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    sum += a[i * 2]! * a[j * 2 + 1]! - a[j * 2]! * a[i * 2 + 1]!;
  }
  return sum / 2;
}

/** Even-odd point-in-polygon over all of an element's outlines. */
export function insideElement(polys: readonly Poly[], x: number, y: number): boolean {
  let inside = false;
  for (const p of polys) {
    const a = p.pts;
    const m = a.length / 2;
    for (let i = 0, j = m - 1; i < m; j = i++) {
      const xi = a[i * 2]!;
      const yi = a[i * 2 + 1]!;
      const xj = a[j * 2]!;
      const yj = a[j * 2 + 1]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi) inside = !inside;
    }
  }
  return inside;
}

function bounds(polys: readonly Poly[]): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of polys) {
    for (let i = 0; i < p.pts.length; i += 2) {
      const x = p.pts[i]!;
      const y = p.pts[i + 1]!;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  return [x0, y0, x1, y1];
}

/** Area inside an element (even-odd), by counting a fine grid over its bounds. */
function elementArea(polys: readonly Poly[]): number {
  const [x0, y0, x1, y1] = bounds(polys);
  const w = x1 - x0;
  const h = y1 - y0;
  if (!(w > 0 && h > 0)) return 0;
  const G = 48;
  let inside = 0;
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) if (insideElement(polys, x0 + ((i + 0.5) / G) * w, y0 + ((j + 0.5) / G) * h)) inside++;
  return (w * h * inside) / (G * G);
}

/** Splits n into integer shares proportional to `weights` (largest remainder), summing to exactly n. */
export function apportion(n: number, weights: readonly number[]): number[] {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return weights.map((_, i) => (i === 0 ? n : 0));
  const exact = weights.map((w) => (w / total) * n);
  const out = exact.map(Math.floor);
  let left = n - out.reduce((a, b) => a + b, 0);
  const order = exact.map((e, i) => [e - Math.floor(e), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0 && k < order.length; k++, left--) out[order[k]![1]]! += 1;
  return out;
}

/**
 * How many points `s` needs for its outlines to carry one point every `spacing` box units (weights apply) and its
 * fills one point every `spacing * fillSpacing` units.
 */
export function shapeDemand(s: Shape, spacing: number, fillSpacing = 1.7): number {
  if (!(spacing > 0)) return 0;
  let n = 0;
  for (const e of s.elements) {
    if (e.mode === "stroke") n += (e.polys.reduce((a, p) => a + polyLength(p), 0) / spacing) * e.weight;
    else n += (elementArea(e.polys) / (spacing * fillSpacing) ** 2) * e.weight;
  }
  return Math.round(n);
}

/** Samples exactly `n` points from `s`, deterministically for a given seed. */
export function sampleShape(s: Shape, n: number, seed: number, opts: SampleOptions = {}): ShapePoints {
  const fillSpacing = opts.fillSpacing ?? 1.7;
  const jitter = opts.jitter ?? 0.12;
  const rand = rng(seed);
  const lengths = s.elements.map((e) => (e.mode === "stroke" ? e.polys.reduce((a, p) => a + polyLength(p), 0) : 0));
  const areas = s.elements.map((e) => (e.mode === "fill" ? elementArea(e.polys) : 0));
  // Stroke dots per unit length rho, fill dots per unit area (rho / fillSpacing)^2: solve rho for n points in all.
  const L = s.elements.reduce((a, e, i) => a + (lengths[i] ?? 0) * e.weight, 0);
  const A = s.elements.reduce((a, e, i) => a + (areas[i] ?? 0) * e.weight, 0) / (fillSpacing * fillSpacing);
  const rho = A > 0 ? (-L + Math.sqrt(L * L + 4 * A * n)) / (2 * A) : L > 0 ? n / L : 0;
  const demand = s.elements.map((e, i) => (e.mode === "stroke" ? (lengths[i] ?? 0) * rho : ((areas[i] ?? 0) * rho * rho) / (fillSpacing * fillSpacing)) * e.weight);
  const counts = apportion(n, demand);

  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const nx = new Float32Array(n);
  const ny = new Float32Array(n);
  const u = new Float32Array(n);
  const el = new Uint16Array(n);
  const group = new Uint8Array(n);
  let k = 0;
  const put = (px: number, py: number, nnx: number, nny: number, uu: number, e: number): void => {
    if (k >= n) return;
    x[k] = px;
    y[k] = py;
    nx[k] = nnx;
    ny[k] = nny;
    u[k] = uu;
    el[k] = e;
    group[k] = s.elements[e]?.group ?? 0;
    k++;
  };

  s.elements.forEach((e, ei) => {
    const count = counts[ei] ?? 0;
    if (count <= 0) return;
    if (e.mode === "stroke") {
      const total = lengths[ei] ?? 0;
      if (total <= 0) {
        const p = e.polys[0]?.pts;
        for (let c = 0; c < count; c++) put(p?.[0] ?? 0, p?.[1] ?? 0, 0, 0, 0, ei);
        return;
      }
      const step = total / count;
      // Walk the outlines once, dropping a point every `step` (half a step in, a little jitter).
      let target = step * 0.5;
      let walked = 0;
      let placed = 0;
      for (const p of e.polys) {
        const a = p.pts;
        const m = a.length / 2;
        const segs = p.closed ? m : m - 1;
        // Outward normals on closed outlines: (dy, -dx) points out when the outline runs clockwise on screen
        // (positive shoelace area with y down), so flip it for the other winding.
        const flip = p.closed && signedArea(p) < 0 ? -1 : 1;
        for (let si = 0; si < segs && placed < count; si++) {
          const j = (si + 1) % m;
          const ax = a[si * 2]!;
          const ay = a[si * 2 + 1]!;
          const bx = a[j * 2]!;
          const by = a[j * 2 + 1]!;
          const len = Math.hypot(bx - ax, by - ay);
          if (len <= 0) continue;
          while (placed < count && target <= walked + len) {
            const f = Math.min(1, Math.max(0, (target - walked) / len));
            put(ax + (bx - ax) * f, ay + (by - ay) * f, (flip * (by - ay)) / len, (-flip * (bx - ax)) / len, target / total, ei);
            placed++;
            target = step * (placed + 0.5) + (rand() - 0.5) * jitter * step;
          }
          walked += len;
        }
      }
      // Rounding at the very end of the last outline: put any remainder on its last vertex.
      const last = e.polys[e.polys.length - 1]?.pts;
      while (placed < count) {
        put(last?.[last.length - 2] ?? 0, last?.[last.length - 1] ?? 0, 0, 0, 1, ei);
        placed++;
      }
      return;
    }
    // Fill: a jittered grid inside the outline, trimmed or topped up to exactly `count`.
    const [bx0, by0, bx1, by1] = bounds(e.polys);
    const area = areas[ei] ?? 0;
    const spacing = Math.sqrt(Math.max(area, 1e-6) / count);
    const pts: [number, number][] = [];
    for (let gy = by0 + spacing / 2; gy < by1; gy += spacing) {
      for (let gx = bx0 + spacing / 2; gx < bx1; gx += spacing) {
        const px = gx + (rand() - 0.5) * spacing * 0.7;
        const py = gy + (rand() - 0.5) * spacing * 0.7;
        if (insideElement(e.polys, px, py)) pts.push([px, py]);
      }
    }
    shuffle(pts, rand);
    for (let tries = 0; pts.length < count && tries < count * 40; tries++) {
      const px = bx0 + rand() * (bx1 - bx0);
      const py = by0 + rand() * (by1 - by0);
      if (insideElement(e.polys, px, py)) pts.push([px, py]);
    }
    const h = Math.max(1e-6, by1 - by0);
    for (let c = 0; c < count; c++) {
      const q = pts[c % Math.max(1, pts.length)] ?? [(bx0 + bx1) / 2, (by0 + by1) / 2];
      put(q[0], q[1], 0, 0, (q[1] - by0) / h, ei);
    }
  });
  return { n, x, y, nx, ny, u, el, group };
}

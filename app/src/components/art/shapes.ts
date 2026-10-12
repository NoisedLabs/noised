/**
 * The shared shape vocabulary of the "signal from noise" illustrations (fx/noise): a few simple vector shapes,
 * defined in code, that every scene draws with the same hand. Each helper adds its outlines (dots spaced along
 * them) and fills (a softer field of dots) to a shape builder, in that builder's box units.
 *
 *   const s = shape(200, 100);
 *   addShield(s, 118, 14, 56, 76);
 *   addLock(s, 100, 58, 1, { shackleGroup: 1 });
 */
import { circle, parsePath, roundRect, type Poly, type ShapeBuilder } from "../../fx/noise";

/** Moves and scales polylines (x' = x * sx + dx). */
export function place(polys: readonly Poly[], sx: number, sy: number, dx: number, dy: number): Poly[] {
  return polys.map((p) => {
    const pts = new Float32Array(p.pts.length);
    for (let i = 0; i < p.pts.length; i += 2) {
      pts[i] = (p.pts[i] ?? 0) * sx + dx;
      pts[i + 1] = (p.pts[i + 1] ?? 0) * sy + dy;
    }
    return { pts, closed: p.closed };
  });
}

/** A heater shield outline: flat top with round corners, straight sides, curving to a point at the bottom. */
export function shieldPath(cx: number, top: number, w: number, h: number): string {
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const r = w * 0.14;
  const side = top + h * 0.46;
  const tip = top + h;
  return [
    `M${x0} ${top + r}`,
    `Q${x0} ${top} ${x0 + r} ${top}`,
    `L${x1 - r} ${top}`,
    `Q${x1} ${top} ${x1} ${top + r}`,
    `L${x1} ${side}`,
    `C${x1} ${side + h * 0.26} ${cx + w * 0.24} ${tip - h * 0.1} ${cx} ${tip}`,
    `C${cx - w * 0.24} ${tip - h * 0.1} ${x0} ${side + h * 0.26} ${x0} ${side}`,
    "Z",
  ].join(" ");
}

/** A shield: its outline, a quieter inner outline and a faint field inside. */
export function addShield(b: ShapeBuilder, cx: number, top: number, w: number, h: number, opts: { group?: number; inner?: boolean; fill?: boolean } = {}): ShapeBuilder {
  const g = opts.group ?? 0;
  b.stroke(shieldPath(cx, top, w, h), { weight: 1.25, group: g });
  if (opts.inner !== false) b.stroke(shieldPath(cx, top + h * 0.13, w * 0.7, h * 0.72), { weight: 0.55, group: g });
  if (opts.fill !== false) b.fill(shieldPath(cx, top + h * 0.13, w * 0.7, h * 0.72), { weight: 0.22, group: g });
  return b;
}

/**
 * A padlock centred on (cx, cy) at scale k (1 = a body 44 wide, 38 tall; the shackle rises 24 above it). The
 * shackle is its own group (so a scene can lift it and drop it shut). The keyhole is cut out of the body's field.
 */
export function addLock(b: ShapeBuilder, cx: number, cy: number, k = 1, opts: { shackleGroup?: number; group?: number; fill?: number } = {}): ShapeBuilder {
  const g = opts.group ?? 0;
  const bw = 44 * k;
  const bh = 38 * k;
  const x = cx - bw / 2;
  const y = cy - bh / 2 + 6 * k;
  b.stroke(roundRect(x, y, bw, bh, 6 * k), { weight: 1.2, group: g });
  const hole = [circle(cx, y + bh * 0.4, 4.2 * k, 24), ...parsePath(`M${cx - 1.7 * k} ${y + bh * 0.4} L${cx - 2.6 * k} ${y + bh * 0.74} L${cx + 2.6 * k} ${y + bh * 0.74} L${cx + 1.7 * k} ${y + bh * 0.4} Z`)];
  b.fill([roundRect(x + 4 * k, y + 4 * k, bw - 8 * k, bh - 8 * k, 4 * k), ...hole], { weight: opts.fill ?? 0.55, group: g });
  const sw = 14 * k;
  b.stroke(`M${cx - sw} ${y} V${y - 10 * k} C${cx - sw} ${y - 28 * k} ${cx + sw} ${y - 28 * k} ${cx + sw} ${y - 10 * k} V${y}`, {
    weight: 1.15,
    group: opts.shackleGroup ?? g,
  });
  return b;
}

/** A coin: rim, inner ring and the Noised mark (3 x 3 dots) in the middle. */
export function addCoin(b: ShapeBuilder, cx: number, cy: number, r: number, opts: { group?: number; mark?: boolean } = {}): ShapeBuilder {
  const g = opts.group ?? 0;
  b.stroke(circle(cx, cy, r), { weight: 1.2, group: g });
  b.stroke(circle(cx, cy, r * 0.8), { weight: 0.45, group: g });
  if (opts.mark !== false) {
    const step = r * 0.26;
    const dots: Poly[] = [];
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) dots.push(circle(cx + i * step, cy + j * step, r * 0.075, 16));
    b.fill(dots, { weight: 1.1, group: g });
  }
  return b;
}

/** A check mark in a ring. */
export function addCheck(b: ShapeBuilder, cx: number, cy: number, r: number, opts: { ring?: boolean; group?: number } = {}): ShapeBuilder {
  const g = opts.group ?? 0;
  if (opts.ring !== false) b.stroke(circle(cx, cy, r), { weight: 1, group: g });
  const k = r / 14;
  b.stroke(`M${cx - 7 * k} ${cy + 0.5 * k} L${cx - 2 * k} ${cy + 5.5 * k} L${cx + 7.5 * k} ${cy - 5 * k}`, { weight: 1.5, group: g });
  return b;
}

// ---------------------------------------------------------- digits ---

/** A monoline figure set in a 10 x 16 cell (only what the illustrations need). */
const DIGITS: Record<string, { d: string; w: number }> = {
  "0": { d: "M5 1 C7.4 1 8.8 3.6 8.8 8 C8.8 12.4 7.4 15 5 15 C2.6 15 1.2 12.4 1.2 8 C1.2 3.6 2.6 1 5 1 Z", w: 10 },
  "1": { d: "M2.6 3.6 L6 1 L6 15", w: 9 },
  "2": { d: "M1.6 4.6 C1.6 2.4 3.2 1 5.1 1 C7.1 1 8.5 2.4 8.5 4.4 C8.5 7.4 1.6 10.6 1.6 15 L8.6 15", w: 10 },
  "5": { d: "M8.2 1 L2.4 1 L1.8 7.4 C2.8 6.5 3.9 6.1 5.1 6.1 C7.3 6.1 8.7 7.8 8.7 10.5 C8.7 13.3 7.1 15 4.8 15 C3.3 15 2.1 14.4 1.3 13.2", w: 10 },
  "7": { d: "M1.4 1 L8.6 1 L3.8 15", w: 10 },
  ",": { d: "M2.6 14.2 L1.6 17.4", w: 4.5 },
};

/** Polylines spelling `text` (digits and commas), left edge at x, top at y, cell height `size`. Returns the width too. */
export function digits(text: string, x: number, y: number, size: number): { polys: Poly[]; width: number } {
  const k = size / 16;
  const polys: Poly[] = [];
  let cx = x;
  for (const ch of text) {
    const g = DIGITS[ch];
    if (!g) {
      cx += 6 * k;
      continue;
    }
    polys.push(...place(parsePath(g.d), k, k, cx, y));
    cx += (g.w + 2.2) * k;
  }
  return { polys, width: cx - x - 2.2 * k };
}

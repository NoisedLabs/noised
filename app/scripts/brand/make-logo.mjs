#!/usr/bin/env node
/**
 * The Noised logo: the "Why Noised" shield (components/art/shapes.ts shieldPath + addShield) drawn as dots in the
 * site's "signal from noise" style: a dense dotted outline, a quieter inner outline, a faint dotted field inside,
 * and loose noise dots around it that thin out with distance (signal emerging from noise).
 *
 *   node app/scripts/brand/make-logo.mjs [outDir]       writes noised-logo-{light,dark,mark-light,mark-dark}.svg
 *
 * Deterministic: the same seed always draws the same dots, so the logo never changes between runs.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const OUT = resolve(process.argv[2] ?? "app/public/brand");
const SIZE = 500;

// mulberry32: small, fast, deterministic.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The same heater-shield outline as components/art/shapes.ts shieldPath, as sampled segments.
function shieldSegments(cx, top, w, h) {
  const x0 = cx - w / 2, x1 = cx + w / 2, r = w * 0.14, side = top + h * 0.46, tip = top + h;
  return [
    ["Q", [x0, top + r], [x0, top], [x0 + r, top]],
    ["L", [x0 + r, top], [x1 - r, top]],
    ["Q", [x1 - r, top], [x1, top], [x1, top + r]],
    ["L", [x1, top + r], [x1, side]],
    ["C", [x1, side], [x1, side + h * 0.26], [cx + w * 0.24, tip - h * 0.1], [cx, tip]],
    ["C", [cx, tip], [cx - w * 0.24, tip - h * 0.1], [x0, side + h * 0.26], [x0, side]],
    ["L", [x0, side], [x0, top + r]],
  ];
}
function point(seg, t) {
  const [k, ...p] = seg;
  const u = 1 - t;
  if (k === "L") return [p[0][0] * u + p[1][0] * t, p[0][1] * u + p[1][1] * t];
  if (k === "Q") return [u * u * p[0][0] + 2 * u * t * p[1][0] + t * t * p[2][0], u * u * p[0][1] + 2 * u * t * p[1][1] + t * t * p[2][1]];
  return [
    u ** 3 * p[0][0] + 3 * u * u * t * p[1][0] + 3 * u * t * t * p[2][0] + t ** 3 * p[3][0],
    u ** 3 * p[0][1] + 3 * u * u * t * p[1][1] + 3 * u * t * t * p[2][1] + t ** 3 * p[3][1],
  ];
}
/** A polyline approximating the outline, finely. */
function outline(cx, top, w, h) {
  const pts = [];
  for (const seg of shieldSegments(cx, top, w, h)) for (let i = 0; i < 64; i++) pts.push(point(seg, i / 64));
  return pts;
}
/** Points every `step` along a closed polyline (even spacing by arc length). */
function along(poly, step, offset = 0) {
  const out = [];
  let carry = offset;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let d = carry;
    while (d < len) {
      const t = d / len;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      d += step;
    }
    carry = d - len;
  }
  return out;
}
function inside(poly, x, y) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function distToPoly(poly, x, y) {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(a[0] + dx * t - x, a[1] + dy * t - y));
  }
  return best;
}

function draw({ bg, ink, mark }) {
  const rand = rng(0x4e015ed); // "noised"
  // Geometry: the shield fills ~62% of the height, centred (optically a touch high).
  const h = mark ? 330 : 300, w = h * (66 / 90), cx = SIZE / 2, top = (SIZE - h) / 2 - 6;
  const outer = outline(cx, top, w, h);
  const innerTop = top + h * 0.13, innerW = w * 0.7, innerH = h * 0.72;
  const inner = outline(cx, innerTop, innerW, innerH);
  const dots = [];
  // 1. The outline: dense, crisp, two staggered rows so it reads as a solid edge at small sizes.
  for (const [x, y] of along(outer, 5.2)) dots.push([x, y, 2.05, 1]);
  for (const [x, y] of along(outer, 5.2, 2.6)) {
    const j = (rand() - 0.5) * 1.2;
    dots.push([x + j, y + j, 1.25, 0.55]);
  }
  // 2. The inner outline: quieter.
  for (const [x, y] of along(inner, 6.4)) dots.push([x, y, 1.35, 0.7]);
  // 3. A faint field inside the inner shield: a jittered grid, thinning toward the centre.
  for (let y = innerTop + 10; y < innerTop + innerH - 6; y += 9.5) {
    for (let x = cx - innerW / 2 + 6; x < cx + innerW / 2 - 4; x += 9.5) {
      const jx = x + (rand() - 0.5) * 4, jy = y + (rand() - 0.5) * 4;
      if (!inside(inner, jx, jy) || distToPoly(inner, jx, jy) < 7) continue;
      const k = 0.25 + 0.35 * rand();
      dots.push([jx, jy, 0.9 + rand() * 0.5, k]);
    }
  }
  // 4. Noise around it: loose dots that thin out with distance (none on the mark variant's corners).
  const NOISE = mark ? 260 : 420;
  let placed = 0, guard = 0;
  while (placed < NOISE && guard++ < 40000) {
    const x = rand() * SIZE, y = rand() * SIZE;
    if (inside(outer, x, y)) continue;
    const d = distToPoly(outer, x, y);
    if (d < 9) continue;
    const p = Math.exp(-d / (mark ? 38 : 58));
    if (rand() > p) continue;
    const edge = Math.min(x, y, SIZE - x, SIZE - y);
    if (edge < 14) continue;
    dots.push([x, y, 0.7 + rand() * 1.05 * p, 0.18 + 0.6 * p * rand()]);
    placed++;
  }
  const r2 = (v) => Math.round(v * 100) / 100;
  const body = dots.map(([x, y, r, o]) => `<circle cx="${r2(x)}" cy="${r2(y)}" r="${r2(r)}"${o < 1 ? ` opacity="${r2(o)}"` : ""}/>`).join("");
  const background = bg === null ? "" : mark
    ? `<rect width="${SIZE}" height="${SIZE}" rx="112" fill="${bg}"/>`
    : `<rect width="${SIZE}" height="${SIZE}" fill="${bg}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" role="img" aria-label="Noised">${background}<g fill="${ink}">${body}</g></svg>\n`;
}

mkdirSync(OUT, { recursive: true });
const variants = {
  "noised-logo-light.svg": { bg: "#f4f4f2", ink: "#0b0b0c", mark: false },
  "noised-logo-dark.svg": { bg: "#070707", ink: "#ececea", mark: false },
  "noised-logo-transparent-ink.svg": { bg: null, ink: "#0b0b0c", mark: false },
  "noised-logo-transparent-white.svg": { bg: null, ink: "#ffffff", mark: false },
  "noised-icon-light.svg": { bg: "#f4f4f2", ink: "#0b0b0c", mark: true },
  "noised-icon-dark.svg": { bg: "#070707", ink: "#ececea", mark: true },
};
for (const [name, v] of Object.entries(variants)) writeFileSync(join(OUT, name), draw(v));
console.log(`wrote ${Object.keys(variants).length} SVGs to ${OUT}`);

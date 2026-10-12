/**
 * Paints a noise frame on a 2D canvas: round dots in the theme's ink (white / silver on graphite, graphite on paper),
 * batched by brightness so a frame of ~1,500 dots is a dozen fills, plus the scene's 1px hairline accents, the stream
 * particles (a dot with a hairline tail) and their impact ripples.
 */
import type { AccentPen, Field, FrameOut } from "./field";

const LEVELS = 14;
const TAU = Math.PI * 2;

/** Scratch buffers for the brightness buckets (grown on demand, shared by every canvas). */
let levelOf = new Uint8Array(0);
let sorted = new Int32Array(0);
const counts = new Int32Array(LEVELS + 1);
const starts = new Int32Array(LEVELS + 1);

export interface Ink {
  r: number;
  g: number;
  b: number;
}

function rgba(ink: Ink, a: number): string {
  return `rgba(${ink.r},${ink.g},${ink.b},${a < 0 ? 0 : a > 1 ? 1 : +a.toFixed(3)})`;
}

/** A pen that draws a step's accents in the shape's box units, mapped onto the canvas. */
function makePen(ctx: CanvasRenderingContext2D, field: Field, ink: Ink, inkScale: number): AccentPen {
  const { s, ox, oy } = field;
  const X = (x: number): number => ox + x * s;
  const Y = (y: number): number => oy + y * s;
  const stroke = (alpha: number): boolean => {
    const a = alpha * inkScale;
    if (a <= 0.004) return false;
    ctx.strokeStyle = rgba(ink, a);
    return true;
  };
  return {
    line(x1, y1, x2, y2, alpha) {
      if (!stroke(alpha)) return;
      ctx.beginPath();
      ctx.moveTo(X(x1), Y(y1));
      ctx.lineTo(X(x2), Y(y2));
      ctx.stroke();
    },
    arc(cx, cy, r, a0, a1, alpha) {
      if (!stroke(alpha) || r <= 0) return;
      ctx.beginPath();
      ctx.arc(X(cx), Y(cy), r * s, a0, a1, a1 < a0);
      ctx.stroke();
    },
    circle(cx, cy, r, alpha) {
      if (!stroke(alpha) || r <= 0) return;
      ctx.beginPath();
      ctx.arc(X(cx), Y(cy), r * s, 0, TAU);
      ctx.stroke();
    },
    poly(points, alpha, closed = false) {
      if (points.length < 4 || !stroke(alpha)) return;
      ctx.beginPath();
      ctx.moveTo(X(points[0] ?? 0), Y(points[1] ?? 0));
      for (let i = 2; i + 1 < points.length; i += 2) ctx.lineTo(X(points[i] ?? 0), Y(points[i + 1] ?? 0));
      if (closed) ctx.closePath();
      ctx.stroke();
    },
    dot(x, y, r, alpha) {
      const a = alpha * inkScale;
      if (a <= 0.004) return;
      ctx.fillStyle = rgba(ink, a);
      ctx.beginPath();
      ctx.arc(X(x), Y(y), r, 0, TAU);
      ctx.fill();
    },
  };
}

/**
 * Draws `out` (computed for `field`) on `ctx`, whose backing store is `field.w * dpr` x `field.h * dpr`.
 * `inkScale` dims the whole frame (accents included).
 */
export function drawFrame(ctx: CanvasRenderingContext2D, field: Field, out: FrameOut, ink: Ink, dpr: number, inkScale = 1): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, field.w, field.h);
  ctx.lineWidth = 1;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Hairline accents under the dots.
  const step = field.steps[out.step];
  if (step?.spec.accents) step.spec.accents(makePen(ctx, field, ink, inkScale), out.lt, out.k, step.timing);

  // Impact ripples: hairline circles that widen and fade.
  for (let i = 0; i < out.rCount; i++) {
    const a = out.ra[i]!;
    if (a <= 0.004) continue;
    ctx.strokeStyle = rgba(ink, a);
    ctx.beginPath();
    ctx.arc(out.rx[i]!, out.ry[i]!, out.rr[i]!, 0, TAU);
    ctx.stroke();
  }

  // Stream particles: a hairline tail while incoming, then the dot.
  for (let i = 0; i < out.pCount; i++) {
    const a = out.pa[i]!;
    if (a <= 0.004) continue;
    const x = out.px[i]!;
    const y = out.py[i]!;
    const tx = out.pTx[i]!;
    const ty = out.pTy[i]!;
    if (tx !== x || ty !== y) {
      const g = ctx.createLinearGradient(tx, ty, x, y);
      g.addColorStop(0, rgba(ink, 0));
      g.addColorStop(1, rgba(ink, a * 0.7));
      ctx.strokeStyle = g;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    ctx.fillStyle = rgba(ink, a);
    ctx.beginPath();
    ctx.arc(x, y, field.dotR * 1.15, 0, TAU);
    ctx.fill();
  }

  // The dots, bucketed by brightness (a counting sort into one path per bucket).
  const n = field.n;
  if (levelOf.length < n) {
    levelOf = new Uint8Array(n);
    sorted = new Int32Array(n);
  }
  counts.fill(0);
  for (let i = 0; i < n; i++) {
    const a = out.a[i]!;
    const lv = a <= 0.01 ? 0 : Math.min(LEVELS, Math.max(1, Math.round(a * LEVELS)));
    levelOf[i] = lv;
    counts[lv]! += 1;
  }
  let acc = 0;
  for (let l = 0; l <= LEVELS; l++) {
    starts[l] = acc;
    acc += counts[l]!;
  }
  const fillAt = starts.slice();
  for (let i = 0; i < n; i++) {
    const lv = levelOf[i]!;
    sorted[fillAt[lv]!++] = i;
  }
  for (let l = 1; l <= LEVELS; l++) {
    const c = counts[l]!;
    if (c === 0) continue;
    ctx.fillStyle = rgba(ink, l / LEVELS);
    ctx.beginPath();
    const s0 = starts[l]!;
    for (let k = s0; k < s0 + c; k++) {
      const i = sorted[k]!;
      const x = out.x[i]!;
      const y = out.y[i]!;
      const r = out.r[i]!;
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, TAU);
    }
    ctx.fill();
  }
}

/**
 * "How it works" as one screen of drifting dots that forms each step's glyph in turn (fx/noise):
 *   01 Create      a new coin, the Noised mark in its middle, a hairline drawing its orbit
 *   02 Fair launch eight identical rings inside one batch (a hairline box): everyone, the same price
 *   03 Trading     a price line rising over its own faint area, with an arrow at the end
 *   04 Graduate    a padlock inside a bigger ring (the pool), the ring's hairline closing around it
 * Between steps the glyph dissolves back into noise and the next one coalesces. The player (HowItWorks.tsx) reads
 * the playing step through `onStep` and jumps with `seekTo` (step i starts at i * HOW_STEP seconds).
 */
import { circle, roundRect, shape, type NoiseScene, type SceneStep } from "../../../fx/noise";
import { addCoin, addLock } from "../../art/shapes";

const W = 160;
const H = 100;

/** Seconds per step: forming, holding, dissolving, a breath of plain noise. */
const FORM = 1.3;
const HOLD = 2.3;
const RELEASE = 0.8;
const REST = 0.3;
export const HOW_STEP = FORM + HOLD + RELEASE + REST;
export const HOW_STEPS = 4;
/** Where a picked step lands: formed, early in its hold (seconds into the step). */
export const HOW_STILL_AT: readonly number[] = [FORM + 0.5, FORM + 0.5, FORM + 0.5, FORM + 0.5];

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeInOut = (v: number): number => {
  const x = clamp01(v);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
};

const timing = { form: FORM, hold: HOLD, release: RELEASE, rest: REST } as const;

function create(): SceneStep {
  const s = shape(W, H);
  addCoin(s, 80, 50, 30);
  return {
    shape: s.build(),
    ...timing,
    accents: (pen, lt, k) => {
      const q = easeInOut(lt / (FORM + 0.4));
      if (q > 0) pen.arc(80, 50, 38, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * q, 0.16 * k);
    },
  };
}

function batch(): SceneStep {
  const s = shape(W, H);
  const xs = [53, 71, 89, 107];
  for (const y of [41, 59]) for (const x of xs) s.stroke(circle(x, y, 6.4, 40));
  return {
    shape: s.build(),
    ...timing,
    // Row by row, left to right: they file into the batch.
    order: (p) => clamp01(((p.x - 44) / 72) * 0.7 + (p.y > 50 ? 0.22 : 0) + p.rand * 0.08),
    accents: (pen, _lt, k) => {
      pen.poly(roundRectPoints(37, 27, 86, 46, 9), 0.3 * k, true);
    },
  };
}

function trading(): SceneStep {
  const s = shape(W, H);
  const pts = "M30 74 L46 64 L58 68 L74 53 L87 57 L103 41 L116 45 L130 28";
  s.stroke(pts, { weight: 1.5 });
  s.stroke("M121 27.5 L130 28 L129.5 37", { weight: 1.5 });
  s.fill(`${pts} L130 78 L30 78 Z`, { weight: 0.2 });
  return {
    shape: s.build(),
    ...timing,
    // The line draws itself left to right; the area fills in under it.
    order: (p) => clamp01((p.x - 30) / 100 * 0.85 + p.rand * 0.15),
    accents: (pen, _lt, k) => {
      pen.line(26, 80, 136, 80, 0.22 * k);
    },
  };
}

function graduate(): SceneStep {
  const s = shape(W, H);
  s.stroke(circle(80, 50, 38), { weight: 0.9 });
  addLock(s, 80, 53, 0.62, { fill: 0.7 });
  return {
    shape: s.build(),
    ...timing,
    accents: (pen, lt, k) => {
      const q = easeInOut((lt - FORM * 0.6) / 0.9);
      if (q > 0) pen.arc(80, 50, 44, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * q, 0.22 * k);
    },
  };
}

/** Points of a round rectangle as a flat list (for a hairline). */
function roundRectPoints(x: number, y: number, w: number, h: number, r: number): number[] {
  return [...roundRect(x, y, w, h, r).pts];
}

export function howScene(): NoiseScene {
  return {
    id: "how-it-works",
    spacing: 3.4,
    ambientGap: 18,
    pad: 0.08,
    still: { step: 0, at: 0.6 },
    steps: [create(), batch(), trading(), graduate()],
  };
}

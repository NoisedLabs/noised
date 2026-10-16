/**
 * "How it works" as one screen of drifting dots that forms each step's glyph in turn (fx/noise):
 *   01 Make your quantum key  a key (bow, shaft, two teeth), a hairline circling its bow
 *   02 Sign your launch       a new coin, the Noised mark in its middle, a hairline sealing it all the way round
 *   03 Checked on-chain       a check mark in a ring, drawn left to right, a wider hairline ring closing around it
 *   04 Keep it safe           a padlock inside a bigger ring (the vault), the ring's hairline closing around it
 * Between steps the glyph dissolves back into noise and the next one coalesces. The player (HowItWorks.tsx) reads
 * the playing step through `onStep` and jumps with `seekTo` (step i starts at i * HOW_STEP seconds).
 */
import { circle, line, shape, type AccentPen, type NoiseScene, type SceneStep } from "../../../fx/noise";
import { addCheck, addCoin, addLock } from "../../art/shapes";

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

/** A hairline arc from the top, clockwise, `q` (0..1) of the way round. */
const sweep = (pen: AccentPen, cx: number, cy: number, r: number, q: number, alpha: number): void => {
  if (q > 0) pen.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * q, alpha);
};

function key(): SceneStep {
  const s = shape(W, H);
  s.stroke(circle(56, 50, 19, 64), { weight: 1.2 });
  s.fill(circle(56, 50, 6.5, 32), { weight: 1.3 });
  s.stroke(line(75, 50, 126, 50), { weight: 1.4 });
  s.stroke([line(107, 50, 107, 65), line(119, 50, 119, 62)], { weight: 1.4 });
  return {
    shape: s.build(),
    ...timing,
    // The bow first, then the shaft and its teeth, left to right.
    order: (p) => clamp01(((p.x - 37) / 90) * 0.8 + p.rand * 0.2),
    accents: (pen, lt, k) => sweep(pen, 56, 50, 26, easeInOut(lt / (FORM + 0.4)), 0.16 * k),
  };
}

function sign(): SceneStep {
  const s = shape(W, H);
  addCoin(s, 80, 50, 30);
  return {
    shape: s.build(),
    ...timing,
    accents: (pen, lt, k) => sweep(pen, 80, 50, 38, easeInOut(lt / (FORM + 0.4)), 0.16 * k),
  };
}

function verified(): SceneStep {
  const s = shape(W, H);
  addCheck(s, 80, 50, 30);
  return {
    shape: s.build(),
    ...timing,
    // The ring, then the check drawn left to right.
    order: (p) => (p.el === 0 ? p.rand * 0.45 : clamp01(0.45 + ((p.x - 65) / 31) * 0.45 + p.rand * 0.1)),
    accents: (pen, lt, k) => sweep(pen, 80, 50, 38, easeInOut((lt - FORM * 0.6) / 0.9), 0.2 * k),
  };
}

function vault(): SceneStep {
  const s = shape(W, H);
  s.stroke(circle(80, 50, 38), { weight: 0.9 });
  addLock(s, 80, 53, 0.62, { fill: 0.7 });
  return {
    shape: s.build(),
    ...timing,
    accents: (pen, lt, k) => sweep(pen, 80, 50, 44, easeInOut((lt - FORM * 0.6) / 0.9), 0.22 * k),
  };
}

export function howScene(): NoiseScene {
  return {
    id: "how-it-works",
    spacing: 3.4,
    ambientGap: 18,
    pad: 0.08,
    still: { step: 0, at: 0.6 },
    steps: [key(), sign(), verified(), vault()],
  };
}

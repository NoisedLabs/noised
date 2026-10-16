/**
 * "Why Noised" scenes (fx/noise): three cards, each a field of drifting dots that coalesces into one idea.
 *   shield  a shield forms; streaks of noise fly at it and bounce off its edge, a faint ripple where they hit
 *   limit   five columns of dots rise, at different speeds, to exactly the same height and no further (Autopilot's
 *           hard limits); a hairline marks the limit once they are all there
 *   lock    a padlock forms with its shackle up; the shackle drops shut while a hairline loop closes around it (the vault)
 */
import { line, shape, type NoiseScene } from "../../../fx/noise";
import { addLock, addShield } from "../../art/shapes";

const W = 200;
const H = 100;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeInOut = (v: number): number => {
  const x = clamp01(v);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
};

export function shieldScene(): NoiseScene {
  const s = shape(W, H);
  addShield(s, 120, 5, 66, 90);
  return {
    id: "why-shield",
    pad: 0.06,
    steps: [
      {
        shape: s.build(),
        form: 1.7,
        hold: 5.2,
        release: 1.3,
        rest: 0.6,
        // The streaks come in from the left and hit the shield's outer outline (element 0).
        streams: [{ count: 6, heading: 0.06, spread: 0.32, hit: [0], speed: 78, period: 2.9, bounce: 0.42, tail: 12, travel: 92 }],
      },
    ],
  };
}

const COLS = [56, 78, 100, 122, 144] as const;
const BOTTOM = 88;
const TOP = 22;
/** How fast each column rises (1 = it needs the whole forming time). They all end level. */
const RISE = [0.62, 1, 0.74, 0.9, 0.55] as const;

export function limitScene(): NoiseScene {
  const s = shape(W, H);
  for (const x of COLS) for (const dx of [-2.2, 2.2]) s.stroke(line(x + dx, BOTTOM, x + dx, TOP));
  const form = 2.4;
  return {
    id: "why-limit",
    pad: 0.06,
    steps: [
      {
        shape: s.build(),
        form,
        hold: 4.4,
        release: 1.2,
        rest: 0.6,
        // Bottom first, each column at its own pace: dots arrive in rising order.
        order: (p) => {
          const col = Math.floor(p.el / 2);
          const h = (BOTTOM - p.y) / (BOTTOM - TOP);
          return clamp01(h * (RISE[col] ?? 1) + p.rand * 0.04);
        },
        // Leave from the top down.
        releaseOrder: (p) => clamp01((p.y - TOP) / (BOTTOM - TOP) * 0.8 + p.rand * 0.2),
        accents: (pen, lt, k) => {
          // The limit, once every column has reached it; and a quiet baseline.
          const level = clamp01((lt - form * 0.92) / 0.6) * k;
          pen.line(42, TOP, 158, TOP, 0.4 * easeInOut(level));
          pen.line(44, BOTTOM + 5, 156, BOTTOM + 5, 0.14 * k);
        },
      },
    ],
  };
}

export function lockScene(): NoiseScene {
  const s = shape(W, H);
  addLock(s, 100, 55, 1.15, { shackleGroup: 1 });
  const form = 1.7;
  const dropAt = form + 0.35;
  const dropFor = 0.5;
  return {
    id: "why-lock",
    pad: 0.06,
    steps: [
      {
        shape: s.build(),
        form,
        hold: 4.8,
        release: 1.3,
        rest: 0.6,
        transform: (group, lt) => {
          if (group !== 1) return null;
          // Open (lifted) until it drops shut with a small settle.
          const q = clamp01((lt - dropAt) / dropFor);
          const settle = q < 1 ? 1 - (1 - q) ** 3 + Math.sin(q * Math.PI) * 0.08 : 1;
          return { dy: -12 * (1 - settle) };
        },
        accents: (pen, lt, k) => {
          // A hairline loop that closes around the lock as the shackle drops.
          const q = easeInOut((lt - form + 0.4) / (dropAt + dropFor - form + 0.4));
          if (q > 0) pen.arc(100, 50, 47, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * q, 0.2 * k);
        },
      },
    ],
  };
}

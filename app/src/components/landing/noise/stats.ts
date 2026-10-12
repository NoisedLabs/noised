/**
 * The hero tiles' small icons (fx/noise), each a few hundred dots that coalesce out of noise:
 *   launches  an arrow rising out of a short trail
 *   raised    three columns at the same height (one price for everyone)
 *   verified  a check mark in a ring
 * Slightly different hold times, so after the first coalesce the three drift out of step and never pulse together.
 */
import { line, shape, type NoiseScene } from "../../../fx/noise";
import { addCheck } from "../../art/shapes";

const B = 40;

const common = { spacing: 2.3, ambientGap: 7, maxDots: 260, pad: 0.04, dot: 0.7, drift: 0.09 } as const;

export function launchesIcon(): NoiseScene {
  const s = shape(B, B);
  s.stroke(line(20, 34, 20, 7), { weight: 1.2 });
  s.stroke("M10.5 16.5 L20 7 L29.5 16.5", { weight: 1.3 });
  return { id: "stat-launches", ...common, steps: [{ shape: s.build(), form: 1.4, hold: 5.2, release: 1, rest: 0.5, order: (p) => Math.min(1, (40 - p.y) / 40 * 0.6 + p.rand * 0.4) }] };
}

export function raisedIcon(): NoiseScene {
  const s = shape(B, B);
  for (const x of [11, 20, 29]) for (const dx of [-1.6, 1.6]) s.stroke(line(x + dx, 33, x + dx, 12));
  return {
    id: "stat-raised",
    ...common,
    steps: [
      {
        shape: s.build(),
        form: 1.6,
        hold: 5.9,
        release: 1,
        rest: 0.5,
        order: (p) => Math.min(1, ((33 - p.y) / 21) * [0.7, 1, 0.8][Math.floor(p.el / 2)]! + p.rand * 0.05),
        accents: (pen, lt, k) => pen.line(5, 12, 35, 12, 0.35 * Math.min(1, Math.max(0, (lt - 1.5) / 0.5)) * k),
      },
    ],
  };
}

export function verifiedIcon(): NoiseScene {
  const s = shape(B, B);
  addCheck(s, 20, 20, 15);
  return { id: "stat-verified", ...common, steps: [{ shape: s.build(), form: 1.4, hold: 6.6, release: 1, rest: 0.5 }] };
}

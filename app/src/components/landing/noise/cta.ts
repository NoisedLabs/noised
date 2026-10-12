/**
 * The closing band's scene (fx/noise): a row of hexagonal shields, the hero wall's cells, standing together. They
 * coalesce out of noise; dots of static fall on them and bounce off their tops, a faint ripple where they land.
 */
import { hexagon, shape, type NoiseScene } from "../../../fx/noise";

const W = 300;
const H = 64;
const R = 13.5;

export function ctaScene(): NoiseScene {
  const s = shape(W, H);
  const step = R * Math.sqrt(3) + 3;
  const hit: number[] = [];
  for (let i = 0; i < 9; i++) {
    hit.push(i);
    s.stroke(hexagon(W / 2 + (i - 4) * step, 38, R), { weight: 1 });
  }
  // A quieter inner hexagon in every cell.
  for (let i = 0; i < 9; i++) s.stroke(hexagon(W / 2 + (i - 4) * step, 38, R * 0.55), { weight: 0.5 });
  return {
    id: "cta-wall",
    ambientGap: 16,
    pad: 0.04,
    steps: [
      {
        shape: s.build(),
        form: 1.8,
        hold: 6,
        release: 1.4,
        rest: 0.6,
        // From the middle shield outwards: they close ranks.
        order: (p) => Math.min(1, (Math.abs(p.x - W / 2) / (W / 2)) * 0.75 + p.rand * 0.25),
        streams: [{ count: 10, heading: Math.PI / 2, spread: 0.18, hit, speed: 46, period: 3.1, bounce: 0.38, tail: 9, travel: 40 }],
      },
    ],
  };
}

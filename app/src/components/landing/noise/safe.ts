/**
 * "Keep it safe" scenes (fx/noise):
 *   vault    a combination dial formed of dots: rim, ticks, inner ring and handle; the dial turns right, left and
 *            right again and stops, under a hairline index mark
 *   private  a balance ("1,250") forms in a hairline field, dissolves into noise and comes back as four dots: the
 *            amount is hidden
 */
import { circle, line, shape, type AccentPen, type NoiseScene, type Poly } from "../../../fx/noise";
import { digits, place } from "../../art/shapes";

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeInOut = (v: number): number => {
  const x = clamp01(v);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
};

const V = 120;
const C = 60;

export function vaultScene(): NoiseScene {
  const s = shape(V, V);
  // The fixed rim.
  s.stroke(circle(C, C, 50), { weight: 1.1 });
  // The dial (group 1): ticks every 10 degrees (longer every 30), its ring, a three-spoke handle and the hub.
  const ticks: Poly[] = [];
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * Math.PI * 2 - Math.PI / 2;
    const r0 = i % 3 === 0 ? 37 : 40.5;
    ticks.push(line(C + Math.cos(a) * r0, C + Math.sin(a) * r0, C + Math.cos(a) * 44.5, C + Math.sin(a) * 44.5));
  }
  s.stroke(ticks, { weight: 1.1, group: 1 });
  s.stroke(circle(C, C, 31), { weight: 0.9, group: 1 });
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 - Math.PI / 2;
    s.stroke(line(C + Math.cos(a) * 9, C + Math.sin(a) * 9, C + Math.cos(a) * 25, C + Math.sin(a) * 25), { weight: 1.3, group: 1 });
    s.stroke(circle(C + Math.cos(a) * 25, C + Math.sin(a) * 25, 2.6, 18), { weight: 0.8, group: 1 });
  }
  s.stroke(circle(C, C, 7, 30), { weight: 1, group: 1 });
  s.fill(circle(C, C, 5, 30), { weight: 0.6, group: 1 });

  const form = 1.8;
  // The combination: right, left, right, then rest (seconds after forming, degrees).
  const turns: readonly [number, number, number][] = [
    [0.2, 1.3, 110],
    [1.8, 1.0, -70],
    [3.1, 0.7, 30],
  ];
  const angleAt = (lt: number): number => {
    let deg = 0;
    for (const [at, dur, by] of turns) deg += by * easeInOut((lt - form - at) / dur);
    return (deg * Math.PI) / 180;
  };
  const stopAt = form + 3.8;
  return {
    id: "safe-vault",
    pad: 0.05,
    still: { step: 0, at: 4.5 },
    steps: [
      {
        shape: s.build(),
        form,
        hold: 5.6,
        release: 1.4,
        rest: 0.7,
        // The rim first, then the dial from the outside in.
        order: (p) => clamp01((p.group === 0 ? 0 : 0.3) + (1 - Math.hypot(p.x - C, p.y - C) / 52) * 0.45 + p.rand * 0.25),
        transform: (group, lt) => (group === 1 ? { rotate: angleAt(lt), cx: C, cy: C } : null),
        accents: (pen, lt, k) => {
          // The index mark above the dial, and a faint outer orbit.
          pen.poly([C - 3.2, 3, C + 3.2, 3, C, 7.6], 0.45 * k, true);
          pen.circle(C, C, 55, 0.08 * k);
          // A soft "click" ring when the dial stops.
          const q = (lt - stopAt) / 0.7;
          if (q > 0 && q < 1) pen.circle(C, C, 50 + q * 6, 0.22 * (1 - q) * k);
        },
      },
    ],
  };
}

const PW = 160;
const PH = 80;

export function privateScene(): NoiseScene {
  const amount = shape(PW, PH);
  const size = 28;
  const { polys, width } = digits("1,250", 0, 0, size);
  const dx = (PW - width) / 2;
  const dy = (PH - size) / 2;
  amount.stroke(place(polys, 1, 1, dx, dy));
  const hidden = shape(PW, PH);
  for (let i = 0; i < 4; i++) hidden.fill(circle(PW / 2 + (i - 1.5) * 17, PH / 2, 4.2, 28));
  const field = (pen: AccentPen, k: number): void => {
    pen.poly(pill(22, 18, PW - 44, PH - 36), 0.22 * k, true);
  };
  return {
    id: "safe-private",
    pad: 0.04,
    still: { step: 1, at: 1.2 },
    steps: [
      { shape: amount.build(), form: 1.4, hold: 2.4, release: 1.4, rest: 0.4, order: (p) => clamp01((p.x - 30) / 100 * 0.6 + p.rand * 0.4), accents: (pen, _lt, k) => field(pen, k) },
      { shape: hidden.build(), form: 1.3, hold: 2.8, release: 1.2, rest: 0.5, accents: (pen, _lt, k) => field(pen, k) },
    ],
  };
}

/** A pill (fully rounded rectangle) outline as a flat point list. */
function pill(x: number, y: number, w: number, h: number): number[] {
  const r = h / 2;
  const out: number[] = [];
  for (let i = 0; i <= 16; i++) {
    const a = -Math.PI / 2 + (i / 16) * Math.PI;
    out.push(x + w - r + Math.cos(a) * r, y + r + Math.sin(a) * r);
  }
  for (let i = 0; i <= 16; i++) {
    const a = Math.PI / 2 + (i / 16) * Math.PI;
    out.push(x + r + Math.cos(a) * r, y + r + Math.sin(a) * r);
  }
  return out;
}

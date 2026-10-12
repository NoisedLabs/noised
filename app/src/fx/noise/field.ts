/**
 * The noise field: a cloud of fine dots drifting in a curl-noise flow that coalesce into a crisp shape, hold it with
 * a faint shimmer, dissolve back into noise and re-form (the next shape of the scene, or the same one again).
 *
 * Pure: no DOM. A field is built for a canvas size (CSS px) and every frame is a function of the running time, so a
 * frame can be recomputed exactly (seeking, the reduced-motion still, tests). The only state that carries between
 * frames is the pointer offset (dots part around the cursor and drift back).
 *
 *   const field = buildField(scene, 320, 180);
 *   const out = createFrame(field);
 *   computeFrame(field, t, out);                 // out.x / out.y / out.a / out.r per dot, plus streams and ripples
 *   computeFrame(field, 0, out, { still: true }); // the formed still frame (reduced motion)
 */
import { rng, seedOf, shuffle } from "./rng";
import { sampleShape, shapeDemand, type Shape, type ShapePoints } from "./shape";
import { simplex, type Simplex } from "./simplex";

// ---------------------------------------------------------------- scene ---

/** Moves one group of a shape's points (in the shape's box units): scale and rotate about (cx, cy), then shift. */
export interface GroupTransform {
  dx?: number;
  dy?: number;
  /** Radians, clockwise on screen. */
  rotate?: number;
  scaleX?: number;
  scaleY?: number;
  cx?: number;
  cy?: number;
}

/** Hairline accents, drawn under the dots in the shape's box units (1 CSS px wide, in the theme's ink). */
export interface AccentPen {
  line(x1: number, y1: number, x2: number, y2: number, alpha: number): void;
  arc(cx: number, cy: number, r: number, a0: number, a1: number, alpha: number): void;
  circle(cx: number, cy: number, r: number, alpha: number): void;
  poly(points: readonly number[], alpha: number, closed?: boolean): void;
  /** One solid dot (radius in CSS px). */
  dot(x: number, y: number, r: number, alpha: number): void;
}

/** Particles that fly at the formed shape and bounce off its outline (a shield deflecting what comes at it). */
export interface StreamSpec {
  /** Particles in flight at once. */
  count: number;
  /** Direction of travel in radians (0 = moving right, PI / 2 = falling). */
  heading: number;
  /** Random spread of the heading, radians (default 0.25). */
  spread?: number;
  /** Indexes of the shape elements (strokes) they hit. */
  hit: readonly number[];
  /** Box units per second. */
  speed: number;
  /** Seconds between a particle's runs (default 2.6). */
  period?: number;
  /** Share of the speed kept after the bounce (default 0.5). */
  bounce?: number;
  /** Length of the hairline tail behind an incoming particle, box units (default 8). */
  tail?: number;
  /** How far before the hit a particle appears, box units (default: half the box diagonal). */
  travel?: number;
}

export interface PointInfo {
  x: number;
  y: number;
  /** Along its stroke 0..1 (fills: 0..1 top to bottom). */
  u: number;
  el: number;
  group: number;
  /** A stable random number 0..1 for this point. */
  rand: number;
  /** The shape's box. */
  w: number;
  h: number;
}

export interface SceneStep {
  shape: Shape;
  /** Seconds from noise to formed (default 1.6). */
  form?: number;
  /** Seconds formed (default 3.4). */
  hold?: number;
  /** Seconds from formed back to noise (default 1.3). */
  release?: number;
  /** Seconds of plain noise before the next step (default 0.7). */
  rest?: number;
  /** When each point arrives, 0..1 (default: mostly random, a little from the centre out). */
  order?: (p: PointInfo) => number;
  /** When each point leaves, 0..1 (default random). */
  releaseOrder?: (p: PointInfo) => number;
  /** Per-group motion while this step plays (lt = seconds since the step began). */
  transform?: (group: number, lt: number, t: StepTiming) => GroupTransform | null;
  /** Hairline accents (k = how formed the step is, 0..1). */
  accents?: (pen: AccentPen, lt: number, k: number, t: StepTiming) => void;
  streams?: readonly StreamSpec[];
}

export interface NoiseScene {
  /** A stable name (seeds the point sets). */
  readonly id: string;
  readonly steps: readonly SceneStep[];
  /** CSS px between neighbouring dots on an outline (default 3.2): the shapes stay dotted at any canvas size. A
   *  function gets the canvas's smaller side (small glyphs space their dots more tightly). */
  readonly spacing?: number | ((side: number) => number);
  /** CSS px between the dots that never form and keep drifting around the shape (default 20). */
  readonly ambientGap?: number;
  /** Most dots on one canvas (default 1600); a larger canvas spaces them out instead. */
  readonly maxDots?: number;
  /** Padding around the shape, as a share of the smaller side (default 0.1). */
  readonly pad?: number;
  /** Radius of a formed dot, CSS px (default 0.95), or a function of the canvas's smaller side. */
  readonly dot?: number | ((side: number) => number);
  /** Drift amplitude, as a share of the smaller side (default 0.07). */
  readonly drift?: number;
  /** Flow speed (default 0.16). */
  readonly flow?: number;
  /** The still frame: which step, and how many seconds into its hold (default step 0, mid-hold). */
  readonly still?: { step: number; at?: number };
  /** Fill dot spacing relative to outline dot spacing (default 1.7). */
  readonly fillSpacing?: number;
  /** Where the drifting cloud lives: 1 = the whole canvas (default 1); smaller hugs the centre. */
  readonly cloud?: number;
}

export interface StepTiming {
  form: number;
  hold: number;
  release: number;
  rest: number;
  dur: number;
}

// ---------------------------------------------------------------- field ---

interface StreamData {
  spec: StreamSpec;
  /** Per particle: contact point, outward normal, heading (unit), phase 0..1. */
  cx: Float32Array;
  cy: Float32Array;
  nx: Float32Array;
  ny: Float32Array;
  hx: Float32Array;
  hy: Float32Array;
  phase: Float32Array;
}

interface StepData {
  spec: SceneStep;
  timing: StepTiming;
  start: number;
  /** Target of formed particle i (box units). */
  tx: Float32Array;
  ty: Float32Array;
  group: Uint8Array;
  /** Arrival / departure order per particle, 0..1. */
  d: Float32Array;
  r: Float32Array;
  groups: number[];
  streams: StreamData[];
}

export interface Field {
  readonly scene: NoiseScene;
  readonly w: number;
  readonly h: number;
  /** All dots; the first `nForm` form shapes, the rest drift. */
  readonly n: number;
  readonly nForm: number;
  /** Shape box -> canvas: X = ox + x * s. */
  readonly s: number;
  readonly ox: number;
  readonly oy: number;
  readonly homeX: Float32Array;
  readonly homeY: Float32Array;
  readonly seedP: Float32Array;
  readonly steps: readonly StepData[];
  readonly loop: number;
  readonly dotR: number;
  readonly noise: Simplex;
  /** Pointer offsets (the only state carried between frames). */
  readonly offX: Float32Array;
  readonly offY: Float32Array;
  pointerEnergy: number;
}

export interface FrameOut {
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly a: Float32Array;
  readonly r: Float32Array;
  /** Stream particles: position, tail end, alpha. */
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pTx: Float32Array;
  readonly pTy: Float32Array;
  readonly pa: Float32Array;
  pCount: number;
  /** Impact ripples: centre, radius, alpha. */
  readonly rx: Float32Array;
  readonly ry: Float32Array;
  readonly rr: Float32Array;
  readonly ra: Float32Array;
  rCount: number;
  step: number;
  lt: number;
  k: number;
}

const DEFAULTS = { form: 1.6, hold: 3.4, release: 1.3, rest: 0.7 } as const;
const STAGGER = 0.5;
const MAX_STREAM = 64;
const TAU = Math.PI * 2;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Smootherstep: zero velocity and acceleration at both ends (dots ease in and settle softly). */
const ease = (v: number): number => {
  const x = clamp01(v);
  return x * x * x * (x * (x * 6 - 15) + 10);
};
const smooth = (a: number, b: number, v: number): number => {
  const x = clamp01((v - a) / (b - a));
  return x * x * (3 - 2 * x);
};

export function timingOf(step: SceneStep): StepTiming {
  const form = step.form ?? DEFAULTS.form;
  const hold = step.hold ?? DEFAULTS.hold;
  const release = step.release ?? DEFAULTS.release;
  const rest = step.rest ?? DEFAULTS.rest;
  return { form, hold, release, rest, dur: form + hold + release + rest };
}

/** Seconds per full loop of a scene. */
export function loopOf(scene: NoiseScene): number {
  return scene.steps.reduce((a, s) => a + timingOf(s).dur, 0);
}

/** Seconds at which step `i` begins. */
export function stepStart(scene: NoiseScene, i: number): number {
  let t = 0;
  for (let k = 0; k < i && k < scene.steps.length; k++) t += timingOf(scene.steps[k]!).dur;
  return t;
}

/** Running time of the still frame (reduced motion): mid-hold of the still step. */
export function stillTime(scene: NoiseScene): number {
  const i = Math.min(scene.steps.length - 1, Math.max(0, scene.still?.step ?? 0));
  const step = scene.steps[i];
  if (!step) return 0;
  const tm = timingOf(step);
  return stepStart(scene, i) + tm.form + Math.min(tm.hold, scene.still?.at ?? tm.hold * 0.5);
}

export interface TimelinePoint {
  step: number;
  /** Seconds since the step began. */
  lt: number;
  /** How formed: 0 noise .. 1 formed. */
  k: number;
  /** 0 forming, 1 holding, 2 releasing, 3 resting. */
  phase: 0 | 1 | 2 | 3;
}

export function timelineAt(scene: NoiseScene, t: number): TimelinePoint {
  const loop = loopOf(scene);
  if (!(loop > 0)) return { step: 0, lt: 0, k: 1, phase: 1 };
  let tt = t % loop;
  if (tt < 0) tt += loop;
  let step = 0;
  for (; step < scene.steps.length - 1; step++) {
    const d = timingOf(scene.steps[step]!).dur;
    if (tt < d) break;
    tt -= d;
  }
  const tm = timingOf(scene.steps[step]!);
  const lt = tt;
  if (lt < tm.form) return { step, lt, k: tm.form > 0 ? lt / tm.form : 1, phase: 0 };
  if (lt < tm.form + tm.hold) return { step, lt, k: 1, phase: 1 };
  if (lt < tm.form + tm.hold + tm.release) return { step, lt, k: 1 - (lt - tm.form - tm.hold) / Math.max(1e-6, tm.release), phase: 2 };
  return { step, lt, k: 0, phase: 3 };
}

/** Formed and drifting dots for a w x h CSS px canvas where one box unit is `scale` px. */
export function dotBudget(scene: NoiseScene, w: number, h: number, scale: number): { nForm: number; nAmbient: number } {
  const px = typeof scene.spacing === "function" ? scene.spacing(Math.min(w, h)) : (scene.spacing ?? 3.2);
  const spacing = px / Math.max(1e-6, scale);
  const fill = scene.fillSpacing ?? 1.7;
  let nForm = 1;
  for (const st of scene.steps) nForm = Math.max(nForm, shapeDemand(st.shape, spacing, fill));
  const gap = scene.ambientGap ?? 20;
  let nAmbient = Math.round((w * h * 0.6) / (gap * gap));
  const max = scene.maxDots ?? 1600;
  if (nForm + nAmbient > max) {
    const k = max / (nForm + nAmbient);
    nForm = Math.max(1, Math.floor(nForm * k));
    nAmbient = Math.floor(nAmbient * k);
  }
  return { nForm, nAmbient };
}

/** Scatters n homes over the canvas: an even (jittered-grid) cloud that thins out towards the edges. */
function scatter(n: number, w: number, h: number, cloud: number, rand: () => number): [Float32Array, Float32Array] {
  const pts: [number, number][] = [];
  const cell = Math.sqrt((w * h) / (n * 1.25));
  for (let y = cell / 2; y < h; y += cell) {
    for (let x = cell / 2; x < w; x += cell) {
      const px = x + (rand() - 0.5) * cell;
      const py = y + (rand() - 0.5) * cell;
      const ex = (px - w / 2) / (w / 2);
      const ey = (py - h / 2) / (h / 2);
      const d = Math.sqrt(ex * ex + ey * ey) / Math.max(0.2, cloud);
      if (rand() < 1 - smooth(0.6, 1.25, d)) pts.push([px, py]);
    }
  }
  shuffle(pts, rand);
  while (pts.length < n) pts.push([w / 2 + (rand() - 0.5) * w * 0.8 * cloud, h / 2 + (rand() - 0.5) * h * 0.8 * cloud]);
  const hx = new Float32Array(n);
  const hy = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    hx[i] = pts[i]![0];
    hy[i] = pts[i]![1];
  }
  return [hx, hy];
}

function buildStream(spec: StreamSpec, pts: ShapePoints, rand: () => number): StreamData {
  const count = Math.min(MAX_STREAM, Math.max(0, spec.count));
  const hits = new Set(spec.hit);
  const spread = spec.spread ?? 0.25;
  // Candidate contacts: outline points of the hit elements whose outward normal faces the incoming particles (the
  // side of the outline they reach first; a particle never passes through a shape to hit its far side).
  const hx0 = Math.cos(spec.heading);
  const hy0 = Math.sin(spec.heading);
  const cand: number[] = [];
  for (let i = 0; i < pts.n; i++) {
    if (!hits.has(pts.el[i]!)) continue;
    if (pts.nx[i]! * hx0 + pts.ny[i]! * hy0 < -0.3) cand.push(i);
  }
  const s: StreamData = {
    spec,
    cx: new Float32Array(count),
    cy: new Float32Array(count),
    nx: new Float32Array(count),
    ny: new Float32Array(count),
    hx: new Float32Array(count),
    hy: new Float32Array(count),
    phase: new Float32Array(count),
  };
  for (let j = 0; j < count; j++) {
    const a = spec.heading + (rand() - 0.5) * 2 * spread;
    const hx = Math.cos(a);
    const hy = Math.sin(a);
    // A contact that faces this particle's own heading too.
    let best = cand.length > 0 ? cand[Math.floor(rand() * cand.length)]! : 0;
    for (let tries = 0; tries < 8 && cand.length > 0; tries++) {
      const c = cand[Math.floor(rand() * cand.length)]!;
      if (pts.nx[c]! * hx + pts.ny[c]! * hy < -0.35) {
        best = c;
        break;
      }
    }
    s.cx[j] = pts.x[best] ?? 0;
    s.cy[j] = pts.y[best] ?? 0;
    s.nx[j] = pts.nx[best] ?? 0;
    s.ny[j] = pts.ny[best] ?? 0;
    s.hx[j] = hx;
    s.hy[j] = hy;
    s.phase[j] = (j + rand() * 0.8) / Math.max(1, count);
  }
  return s;
}

/** Builds the field of `scene` for a w x h CSS px canvas. Deterministic for the same scene and size. */
export function buildField(scene: NoiseScene, w: number, h: number): Field {
  const W = Math.max(1, w);
  const H = Math.max(1, h);
  const seed = seedOf(scene.id);
  const rand = rng(seed ^ 0x9e3779b9);

  // Fit: every step of a scene shares the first shape's box.
  const first = scene.steps[0]?.shape ?? { w: 1, h: 1, elements: [] };
  const pad = Math.min(W, H) * (scene.pad ?? 0.1);
  const s = Math.max(1e-6, Math.min((W - 2 * pad) / first.w, (H - 2 * pad) / first.h));
  const ox = (W - first.w * s) / 2;
  const oy = (H - first.h * s) / 2;

  const { nForm, nAmbient } = dotBudget(scene, W, H, s);
  const n = nForm + nAmbient;
  const [homeX, homeY] = scatter(n, W, H, scene.cloud ?? 1, rand);
  const seedP = new Float32Array(n);
  for (let i = 0; i < n; i++) seedP[i] = rand();

  // Formed particles sorted by the angle of their home around the centre (with a little shuffle): each one is
  // paired with the target at the same rank of angle around the shape's centre, so dots travel inwards, not across.
  const angleOrder = (xs: ArrayLike<number>, ys: ArrayLike<number>, cx: number, cy: number, count: number, wobble: number): number[] => {
    const idx = Array.from({ length: count }, (_, i) => i);
    const ang = new Float32Array(count);
    for (let i = 0; i < count; i++) ang[i] = Math.atan2((ys[i] ?? 0) - cy, (xs[i] ?? 0) - cx) + (wobble > 0 ? (rand() - 0.5) * wobble : 0);
    return idx.sort((a, b) => ang[a]! - ang[b]!);
  };
  const pOrder = angleOrder(homeX, homeY, W / 2, H / 2, nForm, 0.5);

  let start = 0;
  const steps: StepData[] = scene.steps.map((spec, si) => {
    const pts = sampleShape(spec.shape, nForm, seed + si * 7919, scene.fillSpacing === undefined ? {} : { fillSpacing: scene.fillSpacing });
    const cx = pts.x.reduce((a, v) => a + v, 0) / Math.max(1, pts.n);
    const cy = pts.y.reduce((a, v) => a + v, 0) / Math.max(1, pts.n);
    const tOrder = angleOrder(pts.x, pts.y, cx, cy, nForm, 0);
    const tx = new Float32Array(nForm);
    const ty = new Float32Array(nForm);
    const group = new Uint8Array(nForm);
    const d = new Float32Array(nForm);
    const r = new Float32Array(nForm);
    const groups = new Set<number>();
    const maxR = Math.hypot(spec.shape.w, spec.shape.h) / 2 || 1;
    for (let k = 0; k < nForm; k++) {
      const p = pOrder[k]!;
      const q = tOrder[k]!;
      tx[p] = pts.x[q]!;
      ty[p] = pts.y[q]!;
      group[p] = pts.group[q]!;
      groups.add(pts.group[q]!);
      const info: PointInfo = { x: pts.x[q]!, y: pts.y[q]!, u: pts.u[q]!, el: pts.el[q]!, group: pts.group[q]!, rand: seedP[p]!, w: spec.shape.w, h: spec.shape.h };
      d[p] = clamp01(spec.order ? spec.order(info) : 0.65 * info.rand + 0.35 * clamp01(Math.hypot(info.x - cx, info.y - cy) / maxR));
      r[p] = clamp01(spec.releaseOrder ? spec.releaseOrder(info) : rand());
    }
    const timing = timingOf(spec);
    const data: StepData = {
      spec,
      timing,
      start,
      tx,
      ty,
      group,
      d,
      r,
      groups: [...groups].sort((a, b) => a - b),
      streams: (spec.streams ?? []).map((st) => buildStream(st, pts, rand)),
    };
    start += timing.dur;
    return data;
  });

  return {
    scene,
    w: W,
    h: H,
    n,
    nForm,
    s,
    ox,
    oy,
    homeX,
    homeY,
    seedP,
    steps,
    loop: start,
    dotR: typeof scene.dot === "function" ? scene.dot(Math.min(W, H)) : (scene.dot ?? 0.95),
    noise: simplex(seed),
    offX: new Float32Array(n),
    offY: new Float32Array(n),
    pointerEnergy: 0,
  };
}

export function createFrame(field: Field): FrameOut {
  return {
    x: new Float32Array(field.n),
    y: new Float32Array(field.n),
    a: new Float32Array(field.n),
    r: new Float32Array(field.n),
    px: new Float32Array(MAX_STREAM * 4),
    py: new Float32Array(MAX_STREAM * 4),
    pTx: new Float32Array(MAX_STREAM * 4),
    pTy: new Float32Array(MAX_STREAM * 4),
    pa: new Float32Array(MAX_STREAM * 4),
    pCount: 0,
    rx: new Float32Array(MAX_STREAM * 4),
    ry: new Float32Array(MAX_STREAM * 4),
    rr: new Float32Array(MAX_STREAM * 4),
    ra: new Float32Array(MAX_STREAM * 4),
    rCount: 0,
    step: 0,
    lt: 0,
    k: 0,
  };
}

/** A 2D affine matrix [a, b, c, d, e, f]: X = a x + c y + e, Y = b x + d y + f. */
type Mat = [number, number, number, number, number, number];
const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

function matrixOf(g: GroupTransform | null | undefined): Mat {
  if (!g) return IDENTITY;
  const cx = g.cx ?? 0;
  const cy = g.cy ?? 0;
  const sx = g.scaleX ?? 1;
  const sy = g.scaleY ?? 1;
  const c = Math.cos(g.rotate ?? 0);
  const s = Math.sin(g.rotate ?? 0);
  // translate(cx, cy) . rotate . scale . translate(-cx, -cy), then shift.
  const a = c * sx;
  const b = s * sx;
  const cc = -s * sy;
  const d = c * sy;
  const e = cx - a * cx - cc * cy + (g.dx ?? 0);
  const f = cy - b * cx - d * cy + (g.dy ?? 0);
  return [a, b, cc, d, e, f];
}

export interface FrameOptions {
  /** The reduced-motion frame: formed, no drift, no shimmer (t is ignored). */
  still?: boolean;
  /** With `still`: the running time whose step is shown (a sequence player's pick; default the scene's still). */
  stillAt?: number | undefined;
  /** Pointer in canvas px (null when away) and the seconds since the last frame, for the parting dots. */
  pointer?: { x: number; y: number } | null;
  dt?: number;
  /** Overall alpha scale (the light theme paints a touch lighter). */
  ink?: number;
}

const curlOut = new Float32Array(2);
const mats: Mat[] = [];

/** Fills `out` with the frame at running time `t`. */
export function computeFrame(field: Field, t: number, out: FrameOut, opts: FrameOptions = {}): void {
  const { scene, n, nForm, homeX, homeY, seedP, s, ox, oy, noise } = field;
  const still = opts.still === true;
  const time = still ? (opts.stillAt ?? stillTime(scene)) : t;
  const tl = timelineAt(scene, time);
  const step = field.steps[tl.step];
  out.step = tl.step;
  out.lt = tl.lt;
  out.k = tl.k;
  out.pCount = 0;
  out.rCount = 0;
  if (!step) return;
  const inkScale = opts.ink ?? 1;
  const W = field.w;
  const H = field.h;
  const minSide = Math.min(W, H);
  const amp = minSide * (scene.drift ?? 0.07);
  const flowT = (still ? 0 : time) * (scene.flow ?? 0.16);
  const freq = 2.2 / Math.max(80, minSide);
  const band = Math.max(8, minSide * 0.14);
  const rF = field.dotR;
  const rN = rF * 0.82;

  // Group transforms of this step.
  mats.length = 0;
  for (const g of step.groups) mats[g] = matrixOf(step.spec.transform?.(g, tl.lt, step.timing));

  const forming = tl.phase === 0;
  const releasing = tl.phase === 2;
  const k = tl.k;
  const shimmerT = still ? 0 : time * 2.3;

  for (let i = 0; i < n; i++) {
    let e = 0;
    if (i < nForm) {
      if (tl.phase === 1) e = 1;
      else if (forming) e = ease((k - step.d[i]! * STAGGER) / (1 - STAGGER));
      else if (releasing) e = 1 - ease((1 - k - step.r[i]! * STAGGER) / (1 - STAGGER));
      if (still) e = 1;
    }
    const seed = seedP[i]!;
    let x = 0;
    let y = 0;
    let a = 0;
    if (e < 1) {
      const hx = homeX[i]!;
      const hy = homeY[i]!;
      noise.curl2(hx * freq + seed * 3.1, hy * freq, flowT, curlOut);
      const nxp = hx + curlOut[0]! * amp * 2.2;
      const nyp = hy + curlOut[1]! * amp * 2.2;
      // Twinkle: a slow per-dot shimmer of brightness (well under one cycle a second, never a flash).
      const tw = 0.5 + 0.5 * Math.sin(seed * TAU * 7 + (still ? 0 : time) * (0.6 + seed * 0.9));
      const aN = (i < nForm ? 0.22 + 0.3 * tw : 0.12 + 0.22 * tw) * inkScale;
      x = nxp;
      y = nyp;
      a = aN;
    }
    if (e > 0) {
      const m = mats[step.group[i]!] ?? IDENTITY;
      const bx = step.tx[i]!;
      const by = step.ty[i]!;
      let fx = ox + (m[0] * bx + m[2] * by + m[4]) * s;
      let fy = oy + (m[1] * bx + m[3] * by + m[5]) * s;
      if (!still) {
        // Hold shimmer: a fraction of a pixel, each dot on its own slow phase.
        fx += Math.sin(shimmerT + seed * 40) * 0.32;
        fy += Math.cos(shimmerT * 0.83 + seed * 23) * 0.32;
      }
      const aF = (0.84 + 0.14 * Math.sin(shimmerT * 0.7 + seed * 17)) * inkScale;
      if (e >= 1) {
        x = fx;
        y = fy;
        a = aF;
      } else {
        x += (fx - x) * e;
        y += (fy - y) * e;
        a += (aF - a) * e;
      }
    }
    // Soft edges: the drifting cloud fades out near the canvas border instead of ending in a hard rectangle (formed
    // dots keep their full ink).
    const edge = Math.min(x, W - x, y, H - y);
    if (edge < band && e < 1) a *= 1 - (1 - smooth(0, band, edge)) * (1 - e);
    out.x[i] = x;
    out.y[i] = y;
    out.a[i] = a;
    out.r[i] = rN + (rF - rN) * e;
  }

  // Dots part around the pointer and drift back when it leaves.
  const pointer = still ? null : (opts.pointer ?? null);
  if (pointer || field.pointerEnergy > 0.02) {
    const R = Math.max(22, Math.min(64, minSide * 0.16));
    const push = R * 0.5;
    const follow = 1 - Math.exp(-(opts.dt ?? 1 / 60) * 9);
    let energy = 0;
    for (let i = 0; i < n; i++) {
      let gx = 0;
      let gy = 0;
      if (pointer) {
        const dx = out.x[i]! - pointer.x;
        const dy = out.y[i]! - pointer.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < R * R) {
          const d = Math.sqrt(d2) || 0.001;
          const f = (1 - d / R) ** 2 * push;
          gx = (dx / d) * f;
          gy = (dy / d) * f;
        }
      }
      const ox2 = field.offX[i]! + (gx - field.offX[i]!) * follow;
      const oy2 = field.offY[i]! + (gy - field.offY[i]!) * follow;
      field.offX[i] = ox2;
      field.offY[i] = oy2;
      const mag = Math.abs(ox2) + Math.abs(oy2);
      if (mag > energy) energy = mag;
      out.x[i] = out.x[i]! + ox2;
      out.y[i] = out.y[i]! + oy2;
    }
    field.pointerEnergy = energy;
  } else if (field.pointerEnergy !== 0) {
    field.offX.fill(0);
    field.offY.fill(0);
    field.pointerEnergy = 0;
  }

  // Streams: particles that fly at the formed outline and bounce off it, with a small ripple where they hit.
  const visible = smooth(0.55, 1, still ? 1 : k);
  if (visible > 0) {
    for (const st of step.streams) {
      const spec = st.spec;
      const period = spec.period ?? 2.6;
      const travel = spec.travel ?? Math.hypot(step.spec.shape.w, step.spec.shape.h) * 0.5;
      const speed = spec.speed;
      const tHit = travel / speed;
      const bounce = spec.bounce ?? 0.5;
      const tail = spec.tail ?? 8;
      const life = Math.min(period - tHit, 1.1);
      for (let j = 0; j < st.cx.length; j++) {
        const tau = ((((still ? 0.62 : time / period) + st.phase[j]!) % 1) + 1) % 1 * period;
        const cx = st.cx[j]!;
        const cy = st.cy[j]!;
        const hx = st.hx[j]!;
        const hy = st.hy[j]!;
        let bx: number;
        let by: number;
        let tx2: number;
        let ty2: number;
        let pa: number;
        if (tau < tHit) {
          const back = (tHit - tau) * speed;
          bx = cx - hx * back;
          by = cy - hy * back;
          tx2 = bx - hx * tail;
          ty2 = by - hy * tail;
          pa = smooth(0, tHit * 0.35, tau) * 0.9;
        } else {
          const sT = tau - tHit;
          if (sT > life) continue;
          const nx = st.nx[j]!;
          const ny = st.ny[j]!;
          const dot = hx * nx + hy * ny;
          const rx = (hx - 2 * dot * nx) * speed * bounce;
          const ry = (hy - 2 * dot * ny) * speed * bounce;
          bx = cx + rx * sT;
          by = cy + ry * sT;
          tx2 = bx;
          ty2 = by;
          pa = 0.85 * (1 - sT / life) ** 2;
          if (sT < 0.5 && out.rCount < out.rx.length) {
            const q = out.rCount++;
            out.rx[q] = ox + cx * s;
            out.ry[q] = oy + cy * s;
            out.rr[q] = 1.5 + sT * 18;
            out.ra[q] = 0.32 * (1 - sT / 0.5) * visible * inkScale;
          }
        }
        if (out.pCount >= out.px.length) continue;
        const q = out.pCount++;
        out.px[q] = ox + bx * s;
        out.py[q] = oy + by * s;
        out.pTx[q] = ox + tx2 * s;
        out.pTy[q] = oy + ty2 * s;
        out.pa[q] = pa * visible * inkScale;
      }
    }
  }
}

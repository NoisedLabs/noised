/**
 * The shield-wall run loop: camera, clock, cursor, shots.
 * Follows the canvas-effect rules:
 *   - drawing buffer at most 1.5 device px per CSS px (lower on slow devices),
 *   - paused while the canvas is off screen or the tab is hidden; the clock
 *     stops with it,
 *   - WebGL context loss and restore handled,
 *   - at most ~60 frames per second, even on 120 Hz displays,
 *   - `still` (reduced motion): one static frame, redrawn only on resize or
 *     theme change; no intro, no shots, no cursor, no drift.
 */
import { defaultWall, MAX_EVENTS, type Shield, type WallGeometry } from "./geometry";
import { clamp, invert, multiply, perspective, rotationX, rotationY, transform, translation, type Mat4 } from "./math";
import type { GlassShape } from "./post";
import { WallRenderer, type Rgb, type WallFrame } from "./renderer";

export const MAX_DPR = 1.5;
const MIN_QUALITY = 0.55;
/** Minimum time between two impacts (s): at most three flashes in any one second. */
const FLASH_GAP = 0.36;
/** ... and around the bigger shot's brighter flash. */
const FLASH_GAP_BIG = 0.7;

/** Composition of the wall for one layout. Angles in radians, distances in lattice steps. */
export interface Framing {
  yaw: number;
  pitch: number;
  dist: number;
  fov: number;
  /** Lens shift in NDC (moves the projected wall without changing perspective). */
  shiftX: number;
  shiftY: number;
  /** Bend: z -= curve * x^2. */
  curve: number;
  fogNear: number;
  fogFar: number;
  alpha: number;
  size: number;
  /** Where shots land, as fractions of the canvas: x0, x1, y0, y1. */
  target: readonly [number, number, number, number];
  /** Light pool: centre x, y (fractions of the canvas), radius (fraction of the larger side), floor alpha. */
  spot: readonly [number, number, number, number];
  /** Depth of field: focus distance (multiple of dist), depth of field (lattice steps), max blur (CSS px). */
  dof: readonly [number, number, number];
  /**
   * Width-locked framing for tall canvases (phones, where the hero's height
   * follows its content): focal length as a multiple of the canvas width
   * (replaces fov) and the wall's vertical centre in px as a multiple of the
   * width (replaces shiftY); spot y is then a multiple of the width too.
   */
  focalW?: number;
  centerYW?: number;
}

export const DESKTOP: Framing = {
  yaw: -0.92,
  pitch: -0.16,
  dist: 172,
  fov: 0.94,
  shiftX: 0.36,
  shiftY: -0.12,
  curve: -0.0005,
  fogNear: 170,
  fogFar: 430,
  alpha: 1,
  size: 1,
  target: [0.58, 0.86, 0.2, 0.66],
  spot: [0.66, 0.5, 0.38, 0.3],
  dof: [0.92, 60, 3.2],
};

export const MOBILE: Framing = {
  yaw: -1.1,
  pitch: -0.16,
  dist: 160,
  fov: 0.9,
  shiftX: -0.1,
  shiftY: 0,
  curve: -0.0005,
  fogNear: 150,
  fogFar: 380,
  alpha: 0.95,
  size: 1,
  target: [0.3, 0.98, 0.12, 0.62],
  spot: [0.7, 0.45, 0.8, 0.32],
  dof: [0.9, 60, 2.4],
  focalW: 1.5,
  centerYW: 0.57,
};

/** Portrait tablets: the wall sits top right, above the headline. */
export const TABLET: Framing = {
  yaw: -1.0,
  pitch: -0.14,
  dist: 190,
  fov: 0.9,
  shiftX: 0.42,
  shiftY: 0,
  curve: -0.0005,
  fogNear: 170,
  fogFar: 420,
  alpha: 0.95,
  size: 1,
  target: [0.45, 0.98, 0.05, 0.62],
  spot: [0.76, 0.32, 0.7, 0.32],
  dof: [0.92, 60, 2.8],
  focalW: 0.95,
  centerYW: 0.38,
};

/** The framing for a canvas of w x h CSS px (phones: width-locked; portrait tablets; desktop). */
export function framingFor(w: number, h: number, overrides?: Partial<Framing>): Framing {
  const base = w < 700 ? MOBILE : w / h < 0.9 ? TABLET : DESKTOP;
  return { ...base, ...overrides };
}

export interface WallCamera {
  mvp: Mat4;
  /** Rotation of the wall (wall-local -> world). */
  invModel: Mat4 | null;
  focal: number;
  camPos: [number, number, number];
}

/** Camera matrices for one frame: the framing plus drift (radians / fraction of dist) and cursor parallax. */
export function wallCamera(f: Framing, w: number, h: number, drift = { yaw: 0, pitch: 0, dolly: 0 }): WallCamera {
  const model = multiply(rotationX(f.pitch + drift.pitch), rotationY(f.yaw + drift.yaw));
  const fov = f.focalW ? 2 * Math.atan(h / 2 / (f.focalW * w)) : f.fov;
  const focal = h / 2 / Math.tan(fov / 2);
  const view = translation(0, 0, -f.dist * (1 + drift.dolly));
  const proj = perspective(fov, w / h, 1, 5000);
  const viewModel = multiply(view, model);
  const inv = invert(viewModel);
  let camPos: [number, number, number] = [0, 0, f.dist];
  if (inv) {
    const c = transform(inv, 0, 0, 0, 1);
    camPos = [c[0], c[1], c[2]];
  }
  return { mvp: multiply(proj, viewModel), invModel: invert(model), focal, camPos };
}

/** Vertical lens shift of the framing (before scroll parallax). */
export function baseShiftY(f: Framing, w: number, h: number): number {
  return f.centerYW !== undefined ? 1 - (2 * f.centerYW * w) / h : f.shiftY;
}

export interface ImpactInfo {
  /** The user fired it (click / tap) rather than the ambient attacker. */
  user: boolean;
  /** A big "quantum" shot (it shatters). */
  quantum: boolean;
}

/** A DOM element the wall draws a pane of liquid glass under (its rect and border radius are tracked). */
export interface GlassSource {
  el: HTMLElement;
  /** Dark tint 0..1 (how much of the backdrop is held back behind its text). */
  tint: number;
  /** 0: clear lens rim .. 1: fully frosted. */
  frost: number;
}

export interface WallOptions {
  /** Called once when WebGL cannot draw (no context, shader error): show the fallback. */
  onFail: () => void;
  /** The headline block: the wall is calmer behind it and shots avoid it. */
  focus?: () => HTMLElement | null;
  /** One static frame (reduced motion / motion paused). */
  still?: boolean;
  /** false holds the intro; nothing is drawn until play. Default true. */
  play?: boolean;
  onImpact?: (info: ImpactInfo) => void;
  /** Overrides for the composition (merged over the layout's framing). */
  framing?: Partial<Framing>;
  /** Shot interval in seconds (default ~2.1). */
  shotEvery?: number;
  /** Intro speed multiplier (default 1): the wall assembles in ~2.3 s / introSpeed. */
  introSpeed?: number;
  /** Start with the wall already in formation (no assembly, the canvas just fades in). */
  skipIntro?: boolean;
  /** Top of the visible area in CSS px of the canvas (the navbar's bottom edge); the wall fades in below it. */
  topInset?: number;
  /** Elements to draw liquid glass under (dark theme only; read at every layout pass). */
  glass?: () => readonly GlassSource[];
  /** Whether the wall draws the glass (true) or the page should fall back to CSS backdrop blur (false). */
  onGlass?: (active: boolean) => void;
}

export interface WallEngine {
  /** Fire a shot at a viewport point; false when the point misses the wall. */
  fireAt: (clientX: number, clientY: number) => boolean;
  setStill: (still: boolean) => void;
  /** Release the intro hold (see WallOptions.play). */
  play: () => void;
  stop: () => void;
}

interface ShotEvent {
  impact: [number, number, number];
  origin: [number, number, number];
  t0: number;
  travel: number;
  user: boolean;
  quantum: boolean;
  reported: boolean;
}

// ------------------------------------------------------------------ colour ---

function parseColor(text: string, fallback: Rgb): Rgb {
  const s = text.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m && m[1]) {
    const h = m[1];
    return [parseInt(h[0]! + h[0]!, 16) / 255, parseInt(h[1]! + h[1]!, 16) / 255, parseInt(h[2]! + h[2]!, 16) / 255];
  }
  m = /^#([0-9a-f]{6})/i.exec(s);
  if (m && m[1]) {
    const h = m[1];
    return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
  if (m) return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255];
  return fallback;
}

/** Neutral grey of a colour's luma (sRGB-encoded values; good enough for picking an ink level). */
const greyOf = (c: Rgb): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const grey = (v: number): Rgb => [v, v, v];

/**
 * The wall's colours. v5.1 "Graphite Glass": strictly monochrome, whatever
 * the palette tokens say (any hue in them is dropped). Graphite theme: silver
 * dots, white light (edge glow, ripple, shots, sparks), fog that sinks into
 * the page colour. Paper theme: graphite dots and graphite ink for the shots.
 */
interface Palette {
  /** Dot ink (silver on Graphite, graphite on Paper). */
  ink: Rgb;
  /** The wall's light: rims lit from below, the ripple, the cursor (white / near-black). */
  ice: Rgb;
  /** Depth fog (far shields sink into it). */
  deep: Rgb;
  /** The shot's trail. */
  shot: Rgb;
  /** The shot's head, the impact core and fresh sparks. */
  hot: Rgb;
  /** The bigger shot's trail. */
  quant: Rgb;
  light: boolean;
  /** Theme key (re-read only when it changes). */
  key: string;
}

function readPalette(el: Element): Palette {
  const light = document.documentElement.dataset.theme === "light";
  const cs = getComputedStyle(el);
  const get = (name: string, fallback: Rgb): Rgb => parseColor(cs.getPropertyValue(name), fallback);
  const text = greyOf(get("--text", light ? [0.04, 0.04, 0.04] : [0.96, 0.96, 0.96]));
  const bg = greyOf(get("--bg", light ? [0.957, 0.957, 0.949] : [0.027, 0.027, 0.027]));
  const key = `${light ? "l" : "d"}:${text.toFixed(3)}:${bg.toFixed(3)}`;
  if (light) {
    // Paper: graphite dots; the light parts of the wall turn into deeper graphite.
    const ink = Math.min(0.16, text);
    return { ink: grey(ink), ice: grey(ink * 0.35), deep: grey(bg + (ink - bg) * 0.42), shot: grey(0.1), hot: grey(0.02), quant: grey(0.05), light, key };
  }
  // Graphite: silver dots under white light.
  const ink = Math.max(0.72, Math.min(0.86, text * 0.86));
  return { ink: grey(ink), ice: grey(1), deep: grey(Math.max(0.05, bg + (ink - bg) * 0.14)), shot: grey(0.92), hot: grey(1), quant: grey(1), light, key };
}

// -------------------------------------------------------------- the engine ---

export function startWall(canvas: HTMLCanvasElement, opts: WallOptions): WallEngine {
  const noop: WallEngine = { fireAt: () => false, setStill: () => undefined, play: () => undefined, stop: () => undefined };
  const geometry: WallGeometry = defaultWall();
  const renderer = WallRenderer.create(canvas, geometry);
  if (!renderer) {
    opts.onFail();
    return noop;
  }
  const R = geometry.spec.radius;

  let still = opts.still === true;
  let held = opts.play === false && !still;
  let w = 1;
  let h = 1;
  let framing: Framing = DESKTOP;
  let palette = readPalette(canvas);
  let mask: [number, number, number, number] = [-2, -2, 0.01, 0.01];
  let maskPx: DOMRect | null = null;

  let raf = 0;
  let running = false;
  let onScreen = false;
  let lost = false;
  let disposed = false;
  let lastNow = 0;
  let clock = 0;
  let intro = still || opts.skipIntro === true ? 99 : 0;
  let sinceLayout = 0;
  let failed = false;
  let readyRaf = 0;

  // Cursor: client coordinates in, smoothed canvas coordinates out.
  let pointerX = Number.NaN;
  let pointerY = Number.NaN;
  let pointerIn = false;
  let cx = 0;
  let cy = 0;
  let hover = 0;
  let parX = 0;
  let parY = 0;

  // Canvas rect top relative to the viewport (scroll parallax).
  let rectTop = 0;
  let rectLeft = 0;

  // Liquid glass under DOM elements: sources (re-read at layout), shapes (every frame), fade-in.
  let glassSources: { el: HTMLElement; radius: number; tint: number; frost: number }[] = [];
  const glassShapes: GlassShape[] = [];
  let glassIn = still ? 1 : 0;
  let glassReported: boolean | null = null;

  // Dev capture hook: a frozen clock (see the end of startWall).
  let frozen = false;

  // Adaptive resolution.
  let quality = 1;
  let ema = 16.7;
  let slowFor = 0;
  let fpsFrames = 0;
  let fpsTime = 0;

  const events: (ShotEvent | null)[] = Array.from({ length: MAX_EVENTS }, () => null);
  const evA = new Float32Array(MAX_EVENTS * 4);
  const evB = new Float32Array(MAX_EVENTS * 4);
  const evC = new Float32Array(MAX_EVENTS * 4);
  // With the poster frame and no assembly the wall is there at once: the first shot comes soon after.
  let nextShot = opts.skipIntro === true ? 1.1 : 2.6;
  let lastShot: ShotEvent | null = null;
  let shotsSinceQuantum = 0;
  const shotEvery = opts.shotEvery ?? 2.1;
  const introSpeed = Math.max(0.25, opts.introSpeed ?? 1);

  // Matrices of the current frame (also used to aim shots and to unproject clicks).
  let mvp: Mat4 = new Float32Array(16);
  let invModel: Mat4 | null = null;
  let focal = 1;
  let camPos: [number, number, number] = [0, 0, 100];

  const dpr = (): number => Math.min(window.devicePixelRatio || 1, MAX_DPR) * quality;

  const pickFraming = (): Framing => framingFor(w, h, opts.framing);

  const measure = (): void => {
    const r = canvas.getBoundingClientRect();
    w = Math.max(1, r.width);
    h = Math.max(1, r.height);
    rectTop = r.top;
    rectLeft = r.left;
    renderer.resize(w, h, dpr());
    glassSources = (opts.glass?.() ?? []).map((g) => {
      const radius = Number.parseFloat(getComputedStyle(g.el).borderTopLeftRadius) || 0;
      return { el: g.el, radius, tint: g.tint, frost: g.frost };
    });
    framing = pickFraming();
    const el = opts.focus?.() ?? null;
    if (el) {
      const f = el.getBoundingClientRect();
      maskPx = new DOMRect(f.left - r.left, f.top - r.top, f.width, f.height);
      mask = [((maskPx.left + maskPx.width / 2) / w) * 2 - 1, 1 - ((maskPx.top + maskPx.height / 2) / h) * 2, (maskPx.width / w) * 1.05, (maskPx.height / h) * 1.05];
    } else {
      maskPx = null;
      mask = [-2, -2, 0.01, 0.01];
    }
  };

  const camera = (): void => {
    const f = framing;
    // Slow camera drift: a lazy orbit, a nod and a breath of dolly; the cursor adds a little parallax.
    const sway = still ? 0 : Math.sin(clock * 0.09) * 0.045 + Math.sin(clock * 0.23 + 0.7) * 0.012;
    const nod = still ? 0 : Math.sin(clock * 0.071 + 1.3) * 0.018;
    const breathe = still ? 0 : Math.sin(clock * 0.13) * 0.022;
    const cam = wallCamera(f, w, h, { yaw: sway + parX * 0.07, pitch: nod + parY * 0.04, dolly: breathe });
    mvp = cam.mvp;
    invModel = cam.invModel;
    focal = cam.focal;
    camPos = cam.camPos;
  };

  /** A direction given in camera space, expressed in wall-local space. */
  const toLocalDir = (x: number, y: number, z: number): [number, number, number] => {
    if (!invModel) return [x, y, z];
    const d = transform(invModel, x, y, z, 0);
    const len = Math.hypot(d[0], d[1], d[2]) || 1;
    return [d[0] / len, d[1] / len, d[2] / len];
  };

  /** Wall-local point to canvas px (and clip w). */
  const project = (x: number, y: number, z: number): [number, number, number] => {
    const c = transform(mvp, x, y, z, 1);
    const sx = c[0] / c[3] + shiftX();
    const sy = c[1] / c[3] + shiftY();
    return [((sx + 1) / 2) * w, ((1 - sy) / 2) * h, c[3]];
  };

  const scrolled = (): number => (still ? 0 : Math.max(0, -rectTop));
  const shiftX = (): number => framing.shiftX;
  /** The wall drifts up slower than the page (parallax). */
  const shiftY = (): number => baseShiftY(framing, w, h) - ((scrolled() * 0.38) / h) * 2;

  /** Now and then a soft band of light runs the length of the wall (far end to near end). */
  const SCAN_EVERY = 9;
  const SCAN_TIME = 2.8;
  const scanUniform = (): Rgb => {
    if (still || intro < 2) return [0, 1, 0];
    const t = (clock - 4) % SCAN_EVERY;
    if (clock < 4 || t > SCAN_TIME) return [0, 1, 0];
    const p = t / SCAN_TIME;
    const ease = p * p * (3 - 2 * p);
    const x = geometry.minX - 24 + (geometry.maxX - geometry.minX + 48) * ease;
    return [x, 8, Math.sin(Math.PI * p) * 0.75];
  };

  const surfaceZ = (x: number, y: number, s: Shield): number => {
    const ux = x - s.x;
    const uy = y - s.y;
    const rr = (ux * ux + uy * uy) / (R * R);
    return s.row * 0.9 + 3.2 * (1 - rr) - framing.curve * x * x;
  };

  const inMask = (px: number, py: number): boolean => {
    if (!maskPx) return false;
    const m = 64;
    return px > maskPx.left - m && px < maskPx.right + m && py > maskPx.top - m && py < maskPx.bottom + m;
  };

  /**
   * Flash budget (WCAG 2.3.1, "three flashes or below"): impacts land at least
   * FLASH_GAP s apart, so no second ever holds more than three; the bigger
   * shot's flash keeps a wider berth. A shot that would break it is not fired
   * (a click) or waits a moment (the ambient attacker).
   */
  const clearOfFlashes = (at: number, quantum: boolean): boolean => {
    for (const e of events) {
      if (!e) continue;
      const gap = quantum || e.quantum ? FLASH_GAP_BIG : FLASH_GAP;
      if (Math.abs(e.t0 + e.travel - at) < gap) return false;
    }
    return true;
  };

  /** Fire a shot at a wall-local point; false when it would break the flash budget. */
  const launch = (impact: [number, number, number], user: boolean, quantum: boolean): boolean => {
    // Shots come from high ground above the wall, toward the viewer, out of
    // frame; never across the copy column on the left.
    const dir = toLocalDir(0.05 + Math.random() * 0.4, 0.62 + Math.random() * 0.28, 0.6);
    let L = 40;
    let origin: [number, number, number] = impact;
    for (; L <= 520; L += 20) {
      const o: [number, number, number] = [impact[0] + dir[0] * L, impact[1] + dir[1] * L, impact[2] + dir[2] * L];
      const [px, py, cw] = project(o[0], o[1], o[2]);
      if (cw < 30) break;
      origin = o;
      if (px < -40 || py < -40 || px > w + 40 || py > h + 40) break;
    }
    const dist = Math.hypot(origin[0] - impact[0], origin[1] - impact[1], origin[2] - impact[2]);
    // A quantum shot is heavier: it takes a moment longer to arrive.
    const travel = clamp(dist / (user ? 700 : quantum ? 420 : 560), 0.24, quantum ? 0.8 : 0.62);
    if (!clearOfFlashes(clock + travel, quantum)) return false;
    // Reuse a free slot, else the oldest.
    let slot = 0;
    let oldest = Infinity;
    for (let i = 0; i < MAX_EVENTS; i++) {
      const e = events[i];
      if (!e || clock > e.t0 + e.travel + 3.9) {
        slot = i;
        oldest = -Infinity;
        break;
      }
      if (e.t0 < oldest) {
        oldest = e.t0;
        slot = i;
      }
    }
    const shot: ShotEvent = { impact, origin, t0: clock, travel, user, quantum, reported: false };
    events[slot] = shot;
    lastShot = shot;
    return true;
  };

  /** The ambient attacker picks a near shield in the target zone (never behind the copy); `force` sets the size. */
  const ambientShot = (force?: boolean): boolean => {
    const [x0, x1, y0, y1] = framing.target;
    const yUnit = framing.centerYW !== undefined ? w : h;
    const candidates: { s: Shield; weight: number }[] = [];
    for (const s of geometry.shields) {
      const [px, py, cw] = project(s.x, s.y, surfaceZ(s.x, s.y, s));
      if (cw < 20) continue;
      if (px < x0 * w || px > x1 * w || py < y0 * yUnit || py > y1 * yUnit) continue;
      if (inMask(px, py)) continue;
      // Favour near (big) shields.
      candidates.push({ s, weight: 1 / Math.max(40, cw) });
    }
    if (candidates.length === 0) return false;
    let total = 0;
    for (const c of candidates) total += c.weight;
    let pick = Math.random() * total;
    let chosen = candidates[0]!.s;
    for (const c of candidates) {
      pick -= c.weight;
      if (pick <= 0) {
        chosen = c.s;
        break;
      }
    }
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * R * 0.45;
    const ix = chosen.x + Math.cos(a) * r;
    const iy = chosen.y + Math.sin(a) * r;
    // Every so often a bigger shot: never two in a row, at least one in ~7.
    const quantum = force ?? (shotsSinceQuantum >= 2 && (Math.random() < 0.2 || shotsSinceQuantum >= 6));
    if (!launch([ix, iy, surfaceZ(ix, iy, chosen)], false, quantum)) return false;
    shotsSinceQuantum = quantum ? 0 : shotsSinceQuantum + 1;
    return true;
  };

  /** The glass panes for this frame, in CSS px of the canvas (follows hover lifts and entrance moves). */
  const measureGlass = (): GlassShape[] => {
    glassShapes.length = 0;
    // Still frames (reduced motion) draw no panes: their rects would be measured once, before fonts and the
    // entrance moves settle, and never redrawn (ghost outlines). The page's CSS backdrop frosts them instead.
    if (palette.light || glassIn <= 0 || still) return glassShapes;
    for (const g of glassSources) {
      const b = g.el.getBoundingClientRect();
      if (b.width < 2 || b.height < 2) continue;
      const x = b.left - rectLeft;
      const y = b.top - rectTop;
      if (y > h || y + b.height < 0 || x > w || x + b.width < 0) continue;
      glassShapes.push({ x, y, w: b.width, h: b.height, radius: g.radius, tint: g.tint, frost: g.frost, alpha: glassIn });
    }
    return glassShapes;
  };

  /** Tell the page whether the wall draws the glass (else it keeps its CSS backdrop blur). */
  const reportGlass = (): void => {
    const active = renderer.hasPost && !palette.light && !still && glassSources.length > 0;
    if (active === glassReported) return;
    glassReported = active;
    canvas.dataset.glass = active ? "1" : "0";
    opts.onGlass?.(active);
  };

  const draw = (): void => {
    camera();
    for (let i = 0; i < MAX_EVENTS; i++) {
      const e = events[i];
      if (e && clock <= e.t0 + e.travel + 3.9) {
        evA.set([e.impact[0], e.impact[1], e.impact[2], e.t0], i * 4);
        evB.set([e.origin[0], e.origin[1], e.origin[2], e.travel], i * 4);
        evC.set([e.quantum ? 1 : 0, e.user ? 1 : 0, 0, 0], i * 4);
      } else {
        events[i] = null;
        evA.set([0, 0, 0, -1], i * 4);
        evB.set([0, 0, 0, 1], i * 4);
        evC.set([0, 0, 0, 0], i * 4);
      }
    }
    // The key light stays in front of the wall (a lit silver sculpture) and swings a little, so glints travel.
    const swing = still ? 0 : Math.sin(clock * 0.21) * 0.16 + Math.sin(clock * 0.083 + 1.1) * 0.08;
    const key = toLocalDir(-0.56 + swing, 0.76, 0.56);
    // Ice under-light: the lower edge of every dome glows.
    const rim = toLocalDir(0.1, -0.85, 0.5);
    const light = palette.light;
    const wide = framing.centerYW !== undefined;
    const top = opts.topInset ?? 0;
    const frame: WallFrame = {
      mvp,
      focal,
      time: clock,
      intro,
      cursor: [cx, cy, still ? 0 : hover],
      shift: [shiftX(), shiftY()],
      mask,
      evA,
      evB,
      evC,
      ink: palette.ink,
      ice: palette.ice,
      deep: palette.deep,
      shot: palette.shot,
      hot: palette.hot,
      quant: palette.quant,
      look: [framing.alpha * (light ? 1.15 : 1), framing.size, 0.16, 1],
      grid: [geometry.spec.cols, geometry.spec.rows, R, framing.curve],
      fog: [framing.fogNear, framing.fogFar],
      keyDir: key,
      rimDir: rim,
      camPos,
      spot: [framing.spot[0] * w, wide ? framing.spot[1] * w : framing.spot[1] * h, framing.spot[2] * (wide ? w : Math.max(w, h)), framing.spot[3]],
      scan: scanUniform(),
      dust: [geometry.minY - 12, geometry.maxY - geometry.minY + 24, light ? 0.14 : 0.42],
      focus: [framing.dist * framing.dof[0], framing.dof[1], still ? framing.dof[2] * 0.8 : framing.dof[2], light ? 0.25 : 0.55],
      // With WebGL glass the wall runs on under the stat tiles (frosted there) and fades only at the very bottom.
      fade: [Math.max(0, top - 24), top + 90, glassReported ? h * 0.84 : h * 0.8, glassReported ? h : h * 0.995],
      light,
    };
    // Bloom: soft light around impacts, tracers and the brightest rims (dark theme only).
    const drawn = light
      ? renderer.render(frame)
      : renderer.render(frame, {
          bloom: [0.55, 0.9],
          glass: measureGlass(),
          pointer: [cx, cy, still ? 0 : hover],
          look: [w < 700 ? 14 : 18, w < 700 ? 7 : 10, 0.08, 0.035],
          cap: 0.13,
          // PIXEL_V6: the glow is dithered into 2 px Bayer pixels (the dots themselves stay crisp).
          dither: 2,
        });
    reportGlass();
    // The canvas fades in (hero.css) once it has a first real frame, not while the shaders still compile.
    if (drawn && canvas.dataset.started !== "1") canvas.dataset.started = "1";
    if (renderer.state === "failed") failNow();
  };

  /** WebGL cannot draw after all (the program did not link): stop and let the caller show the fallback. */
  const failNow = (): void => {
    if (failed) return;
    failed = true;
    running = false;
    cancelAnimationFrame(raf);
    cancelAnimationFrame(readyRaf);
    opts.onFail();
  };

  /** Run `then` once the background shader compile has finished (polls once per frame). */
  const whenReady = (then: () => void): void => {
    cancelAnimationFrame(readyRaf);
    const tick = (): void => {
      if (disposed || lost || failed) return;
      const st = renderer.poll();
      if (st === "pending") {
        readyRaf = requestAnimationFrame(tick);
        return;
      }
      if (st === "failed") {
        failNow();
        return;
      }
      then();
    };
    readyRaf = requestAnimationFrame(tick);
  };

  const frame = (now: number): void => {
    raf = requestAnimationFrame(frame);
    // While the shaders compile in the background, hold the clock (the intro starts with the first real frame).
    if (renderer.state !== "ready") {
      const st = renderer.poll();
      if (st === "failed") {
        failNow();
        return;
      }
      if (st === "pending") {
        lastNow = 0;
        return;
      }
    }
    const elapsed = lastNow === 0 ? 1000 / 60 : now - lastNow;
    // Cap at ~60 fps on high-refresh displays.
    if (elapsed < 1000 / 64) return;
    lastNow = now;
    const dt = frozen ? 0 : Math.min(0.05, elapsed / 1000);
    clock += dt;
    intro += dt * introSpeed;

    ema = ema * 0.92 + elapsed * 0.08;
    fpsFrames++;
    fpsTime += elapsed;
    if (fpsTime > 1000) {
      canvas.dataset.fps = String(Math.round((fpsFrames * 1000) / fpsTime));
      canvas.dataset.quality = quality.toFixed(2);
      fpsFrames = 0;
      fpsTime = 0;
    }
    // Real time spent slow (dt is capped, so it would under-count at low frame rates).
    slowFor = ema > 26 ? slowFor + elapsed / 1000 : 0;
    if (slowFor > 2 && quality > MIN_QUALITY) {
      quality = Math.max(MIN_QUALITY, quality - 0.15);
      slowFor = 0;
      renderer.resize(w, h, dpr());
    }

    sinceLayout += dt;
    const r = canvas.getBoundingClientRect();
    if (sinceLayout > 0.75 || Math.abs(r.width - w) > 0.5 || Math.abs(r.height - h) > 0.5) {
      sinceLayout = 0;
      measure();
    } else {
      rectTop = r.top;
      rectLeft = r.left;
    }
    // The glass fades in once the copy has arrived.
    if (glassIn < 1 && intro > 0.35) glassIn = Math.min(1, glassIn + dt / 0.7);

    let targetHover = 0;
    let tx = cx;
    let ty = cy;
    if (pointerIn && Number.isFinite(pointerX)) {
      tx = pointerX - r.left;
      ty = pointerY - r.top;
      targetHover = tx >= 0 && ty >= 0 && tx <= r.width && ty <= r.height ? 1 : 0;
    }
    const k = 1 - Math.exp(-dt * 10);
    cx += (tx - cx) * k;
    cy += (ty - cy) * k;
    hover += (targetHover - hover) * (1 - Math.exp(-dt * (targetHover > hover ? 6 : 2.5)));
    const ptx = targetHover > 0 ? tx / w - 0.5 : 0;
    const pty = targetHover > 0 ? ty / h - 0.5 : 0;
    const kp = 1 - Math.exp(-dt * 1.8);
    parX += (ptx - parX) * kp;
    parY += (pty - parY) * kp;

    // No shots while the hero is mostly scrolled away.
    if ((intro > 2.2 || opts.skipIntro === true) && clock >= nextShot && -rectTop < h * 0.6 && !frozen) {
      // Over the flash budget (a burst of clicks): try again a moment later.
      nextShot = ambientShot() ? clock + shotEvery * (0.75 + Math.random() * 0.5) : clock + 0.25;
    }

    draw();

    for (const e of events) {
      if (e && !e.reported && clock >= e.t0 + e.travel) {
        e.reported = true;
        opts.onImpact?.({ user: e.user, quantum: e.quantum });
      }
    }
  };

  const update = (): void => {
    const go = !still && !held && onScreen && document.visibilityState === "visible" && !lost && !disposed;
    if (go && !running) {
      running = true;
      lastNow = 0;
      raf = requestAnimationFrame(frame);
    } else if (!go && running) {
      running = false;
      cancelAnimationFrame(raf);
    }
    canvas.dataset.running = running ? "1" : "0";
  };

  const drawStill = (): void => {
    if (lost || disposed || failed) return;
    glassIn = 1;
    if (renderer.state === "pending") {
      whenReady(drawStill);
      return;
    }
    measure();
    const savedClock = clock;
    if (still) {
      clock = 3.1;
      intro = 99;
    }
    draw();
    clock = savedClock;
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (e.pointerType === "touch") return;
    pointerX = e.clientX;
    pointerY = e.clientY;
    pointerIn = true;
  };
  const onPointerOut = (e: PointerEvent): void => {
    if (e.relatedTarget === null) pointerIn = false;
  };
  const onBlur = (): void => {
    pointerIn = false;
  };
  const onLost = (e: Event): void => {
    e.preventDefault();
    lost = true;
    // Nothing draws the glass now: the page falls back to CSS blur until the context is back.
    glassReported = false;
    canvas.dataset.glass = "0";
    opts.onGlass?.(false);
    update();
  };
  const onRestored = (): void => {
    if (!renderer.init()) {
      opts.onFail();
      return;
    }
    lost = false;
    measure();
    if (still) drawStill();
    update();
  };

  measure();
  if (still) drawStill();
  else if (!held) draw();
  canvas.dataset.points = String(geometry.count);

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) onScreen = entry.isIntersecting;
      update();
    },
    { threshold: 0 },
  );
  io.observe(canvas);
  const ro = new ResizeObserver(() => {
    measure();
    if (!running && !lost && !held) (still ? drawStill : draw)();
  });
  ro.observe(canvas);
  const themeWatch = new MutationObserver(() => {
    palette = readPalette(canvas);
    if (!running && !lost && !held) (still ? drawStill : draw)();
  });
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-palette"] });

  if (import.meta.env.DEV) {
    // Dev only (compiled out of builds): capture scripts fire shots and step a frozen clock.
    Object.assign(canvas, {
      phxWall: {
        fire: (quantum?: boolean) => {
          if (!ambientShot(quantum) || !lastShot) return null;
          const [x, y] = project(lastShot.impact[0], lastShot.impact[1], lastShot.impact[2]);
          const [ox, oy] = project(lastShot.origin[0], lastShot.origin[1], lastShot.origin[2]);
          return { x: x + rectLeft, y: y + rectTop, ox: ox + rectLeft, oy: oy + rectTop, travel: lastShot.travel };
        },
        freeze: (on: boolean) => {
          frozen = on;
        },
        step: (s: number) => {
          clock += s;
          intro += s * introSpeed;
          draw();
        },
        clock: () => clock,
      },
    });
  }

  document.addEventListener("visibilitychange", update);
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  window.addEventListener("pointerout", onPointerOut, { passive: true });
  window.addEventListener("blur", onBlur);
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  return {
    fireAt(clientX, clientY) {
      if (still || held || lost || disposed) return false;
      const r = canvas.getBoundingClientRect();
      const px = clientX - r.left;
      const py = clientY - r.top;
      const inv = invert(mvp);
      if (!inv) return false;
      const nx = (px / w) * 2 - 1 - shiftX();
      const ny = 1 - (py / h) * 2 - shiftY();
      const a = transform(inv, nx, ny, -1, 1);
      const b = transform(inv, nx, ny, 1, 1);
      const p0 = [a[0] / a[3], a[1] / a[3], a[2] / a[3]] as const;
      const p1 = [b[0] / b[3], b[1] / b[3], b[2] / b[3]] as const;
      const dz = p1[2] - p0[2];
      if (Math.abs(dz) < 1e-6) return false;
      // Intersect with the wall's mid plane, then find the shield that was hit.
      const t = (3 - p0[2]) / dz;
      const x = p0[0] + (p1[0] - p0[0]) * t;
      const y = p0[1] + (p1[1] - p0[1]) * t;
      let best: Shield | null = null;
      let bestD = Infinity;
      for (const s of geometry.shields) {
        const d = Math.hypot(s.x - x, s.y - y);
        if (d < bestD) {
          bestD = d;
          best = s;
        }
      }
      if (!best || bestD > R * 1.05) return false;
      return launch([x, y, surfaceZ(x, y, best)], true, false);
    },
    play() {
      if (!held) return;
      held = false;
      intro = still || opts.skipIntro === true ? 99 : 0;
      update();
    },
    setStill(next) {
      if (next === still) return;
      still = next;
      if (still) {
        update();
        drawStill();
      } else {
        intro = 99;
        update();
      }
      reportGlass();
    },
    stop() {
      disposed = true;
      running = false;
      cancelAnimationFrame(raf);
      cancelAnimationFrame(readyRaf);
      io.disconnect();
      ro.disconnect();
      themeWatch.disconnect();
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerout", onPointerOut);
      window.removeEventListener("blur", onBlur);
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      renderer.dispose();
    },
  };
}

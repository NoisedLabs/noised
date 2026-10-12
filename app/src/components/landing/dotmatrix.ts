/**
 * Dot-matrix canvas engine for the landing illustrations.
 *
 * A scene lights cells of a square dot grid (a level 0..1 and an ink per
 * cell); the engine draws every cell as a round dot whose size and opacity
 * follow its level, over a pre-rendered sheet of dim "off" dots. It is
 * purely decorative and CSP-safe (canvas 2D only, colours read from CSS
 * custom properties so the light theme works).
 *
 * Performance: DPR capped at 1.5, one fill per (ink, level) bucket, ~30 fps
 * stepping, and the loop runs only while the canvas is on screen, the tab is visible, the
 * shell's ambient motion is not paused and the user has not asked for
 * reduced motion. Reduced motion draws one representative still frame.
 */
import { useEffect, useRef, type RefObject } from "react";

/** Ink indices: signal (coral), text (white), phosphor (green), amber, muted, violet. */
export const INK = { signal: 0, text: 1, phosphor: 2, amber: 3, muted: 4, violet: 5 } as const;
export type Ink = (typeof INK)[keyof typeof INK];
const INK_VARS = ["--ld-signal", "--ld-text", "--ld-phosphor", "--ld-amber", "--ld-muted", "--ld-violet"] as const;
const LEVELS = 8;
/** Seconds the power-on scan takes. */
const INTRO_S = 0.8;

export interface Grid {
  readonly cols: number;
  readonly rows: number;
  /** CSS px between dot centres. */
  readonly pitch: number;
  readonly width: number;
  readonly height: number;
  /** Pixel position of cell (0, 0). */
  readonly ox: number;
  readonly oy: number;
  readonly level: Float32Array;
  readonly ink: Uint8Array;
  /** Pointer in cell units (x = column, y = row); active while it is over the host; `downs` counts presses. */
  readonly pointer: { x: number; y: number; active: boolean; strength: number; downs: number };
  /** Light a cell, keeping the brighter value. */
  set(c: number, r: number, v: number, ink?: Ink): void;
  /** Splat a fractional position over its four neighbours (smooth sub-cell motion). */
  splat(x: number, y: number, v: number, ink?: Ink): void;
  /** Multiply every level by k (trails). */
  fade(k: number): void;
  clear(): void;
}

export interface Scene<S> {
  /** Dot pitch in CSS px for a canvas of this size. */
  pitch: (width: number, height: number) => number;
  /** Fresh scene state for a (re)sized grid. */
  init: (g: Grid) => S;
  /** Advance and paint one frame. `t` counts seconds of visible running time. */
  step: (g: Grid, s: S, t: number, dt: number) => void;
  /** Running time at which the reduced-motion still frame is taken (default 3 s). */
  still?: number;
  /** Opacity of the dim "off" dots (default 1 = the theme's dot-grid colour; 0 hides them). */
  base?: number;
  /** Largest dot radius as a fraction of the pitch (default 0.34). */
  radius?: number;
  /** React to the pointer over the host element (default true). */
  pointer?: boolean;
}

function makeGrid(cols: number, rows: number, pitch: number, width: number, height: number): Grid {
  const level = new Float32Array(cols * rows);
  const ink = new Uint8Array(cols * rows);
  const ox = (width - (cols - 1) * pitch) / 2;
  const oy = (height - (rows - 1) * pitch) / 2;
  const put = (c: number, r: number, v: number, k: Ink): void => {
    if (c < 0 || r < 0 || c >= cols || r >= rows || v <= 0) return;
    const i = r * cols + c;
    const cur = level[i] ?? 0;
    if (v >= cur) {
      level[i] = v > 1 ? 1 : v;
      ink[i] = k;
    }
  };
  return {
    cols,
    rows,
    pitch,
    width,
    height,
    ox,
    oy,
    level,
    ink,
    pointer: { x: -99, y: -99, active: false, strength: 0, downs: 0 },
    set(c, r, v, k = INK.signal) {
      put(Math.round(c), Math.round(r), v, k);
    },
    splat(x, y, v, k = INK.signal) {
      const c0 = Math.floor(x);
      const r0 = Math.floor(y);
      const fx = x - c0;
      const fy = y - r0;
      put(c0, r0, v * (1 - fx) * (1 - fy) * 1.6, k);
      put(c0 + 1, r0, v * fx * (1 - fy) * 1.6, k);
      put(c0, r0 + 1, v * (1 - fx) * fy * 1.6, k);
      put(c0 + 1, r0 + 1, v * fx * fy * 1.6, k);
    },
    fade(k) {
      for (let i = 0; i < level.length; i++) {
        const v = (level[i] ?? 0) * k;
        level[i] = v < 0.02 ? 0 : v;
      }
    },
    clear() {
      level.fill(0);
    },
  };
}

function readColors(el: Element): { inks: string[]; base: string; bloom: boolean } {
  const cs = getComputedStyle(el);
  const pick = (name: string, fallback: string): string => cs.getPropertyValue(name).trim() || fallback;
  return {
    inks: INK_VARS.map((v, i) => pick(v, ["#7fe7ff", "#e8f0ff", "#6cf0c2", "#ffd166", "#9aaac6", "#a594ff"][i] ?? "#fff")),
    base: pick("--ld-dotgrid", "rgba(255,255,255,.05)"),
    // Glow reads as light on a dark screen; on paper it would be a grey smudge.
    bloom: document.documentElement.dataset.theme !== "light",
  };
}

/** html[data-motion="still"]: the visitor paused ambient motion (or asked for reduced motion). */
function isStill(el: Element): boolean {
  return document.documentElement.dataset.motion === "still" || el.closest('[data-motion="still"], [data-motion="paused"]') !== null;
}

function reducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Attach a scene to a canvas. The canvas fills its (positioned) parent via
 * CSS; pointer events are read from `hostRef` (or the canvas's parent).
 */
export function useDotMatrix<S>(scene: Scene<S>, hostRef?: RefObject<HTMLElement | null>): RefObject<HTMLCanvasElement | null> {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // The scene object is module-level in practice; keep the latest without restarting the loop.
  const sceneRef = useRef(scene);
  sceneRef.current = scene;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;
    const host = hostRef?.current ?? canvas.parentElement ?? canvas;

    let grid: Grid | null = null;
    let state: S | null = null;
    let colors = readColors(canvas);
    let baseSheet: HTMLCanvasElement | null = null;
    let raf = 0;
    let last = 0;
    let t = 0;
    let inView = false;
    let pageVisible = document.visibilityState !== "hidden";
    let reduce = reducedMotion();
    let dpr = 1;
    let frameCount = 0;
    let shellPaused = false;
    // Counting-sort scratch for the (ink, level) buckets.
    let order = new Int32Array(0);
    const counts = new Int32Array(INK_VARS.length * LEVELS + 1);
    const starts = new Int32Array(INK_VARS.length * LEVELS + 1);
    const cursor = new Int32Array(INK_VARS.length * LEVELS + 1);

    const renderBase = (): void => {
      if (!grid) return;
      const s = sceneRef.current;
      const alpha = s.base ?? 1;
      baseSheet = null;
      if (alpha <= 0) return;
      const sheet = document.createElement("canvas");
      sheet.width = canvas.width;
      sheet.height = canvas.height;
      const b = sheet.getContext("2d");
      if (!b) return;
      b.setTransform(dpr, 0, 0, dpr, 0, 0);
      b.fillStyle = colors.base;
      b.globalAlpha = Math.min(1, alpha);
      const r = Math.max(0.55, grid.pitch * 0.1);
      b.beginPath();
      for (let row = 0; row < grid.rows; row++) {
        const y = grid.oy + row * grid.pitch;
        for (let col = 0; col < grid.cols; col++) {
          const x = grid.ox + col * grid.pitch;
          b.moveTo(x + r, y);
          b.arc(x, y, r, 0, Math.PI * 2);
        }
      }
      b.fill();
      baseSheet = sheet;
    };

    const draw = (): void => {
      const g = grid;
      if (!g) return;
      const s = sceneRef.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, g.width, g.height);
      // Power-on: the first time a matrix is seen it prints in under a coral scan line (never under reduced motion).
      const intro = reduce || shellPaused ? 1 : Math.min(1, t / INTRO_S);
      const scanY = g.height * (1 - Math.pow(1 - intro, 2));
      if (intro < 1) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, g.width, scanY);
        ctx.clip();
      }
      if (baseSheet) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(baseSheet, 0, 0);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      const n = g.level.length;
      if (order.length !== n) order = new Int32Array(n);
      counts.fill(0);
      const nb = INK_VARS.length * LEVELS;
      for (let i = 0; i < n; i++) {
        const v = g.level[i] ?? 0;
        if (v < 0.03) continue;
        const q = Math.min(LEVELS - 1, Math.floor(v * LEVELS));
        const b = (g.ink[i] ?? 0) * LEVELS + q;
        counts[b] = (counts[b] ?? 0) + 1;
      }
      let acc = 0;
      for (let b = 0; b < nb; b++) {
        starts[b] = acc;
        acc += counts[b] ?? 0;
      }
      cursor.set(starts);
      for (let i = 0; i < n; i++) {
        const v = g.level[i] ?? 0;
        if (v < 0.03) continue;
        const q = Math.min(LEVELS - 1, Math.floor(v * LEVELS));
        const b = (g.ink[i] ?? 0) * LEVELS + q;
        const at = cursor[b] ?? 0;
        order[at] = i;
        cursor[b] = at + 1;
      }
      const rMax = g.pitch * (s.radius ?? 0.34);
      const rMin = Math.max(0.6, g.pitch * 0.11);
      for (let b = 0; b < nb; b++) {
        const count = counts[b] ?? 0;
        if (count === 0) continue;
        const ink = Math.floor(b / LEVELS);
        const q = b % LEVELS;
        const lv = (q + 0.5) / LEVELS;
        const r = rMin + (rMax - rMin) * Math.sqrt(lv);
        ctx.fillStyle = colors.inks[ink] ?? "#fff";
        const from = starts[b] ?? 0;
        // Soft bloom under the brightest dots.
        if (colors.bloom && q >= LEVELS - 2 && ink !== INK.muted) {
          ctx.globalAlpha = 0.11;
          ctx.beginPath();
          for (let k = from; k < from + count; k++) {
            const i = order[k] ?? 0;
            const x = g.ox + (i % g.cols) * g.pitch;
            const y = g.oy + Math.floor(i / g.cols) * g.pitch;
            ctx.moveTo(x + r * 2.6, y);
            ctx.arc(x, y, r * 2.6, 0, Math.PI * 2);
          }
          ctx.fill();
        }
        ctx.globalAlpha = 0.28 + 0.72 * lv;
        ctx.beginPath();
        for (let k = from; k < from + count; k++) {
          const i = order[k] ?? 0;
          const x = g.ox + (i % g.cols) * g.pitch;
          const y = g.oy + Math.floor(i / g.cols) * g.pitch;
          ctx.moveTo(x + r, y);
          ctx.arc(x, y, r, 0, Math.PI * 2);
        }
        ctx.fill();
      }
      if (intro < 1) {
        ctx.restore();
        ctx.fillStyle = colors.inks[INK.signal] ?? "#7fe7ff";
        ctx.globalAlpha = 0.16;
        ctx.fillRect(0, scanY - 10, g.width, 10);
        ctx.globalAlpha = 0.95;
        ctx.fillRect(0, scanY - 1, g.width, 1.5);
      }
      ctx.globalAlpha = 1;
    };

    const resize = (): void => {
      const rect = canvas.getBoundingClientRect();
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      if (w < 8 || h < 8) return;
      dpr = Math.min(1.5, window.devicePixelRatio || 1);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      const s = sceneRef.current;
      const pitch = Math.max(3, s.pitch(w, h));
      const cols = Math.max(2, Math.floor(w / pitch));
      const rows = Math.max(2, Math.floor(h / pitch));
      const prevPointer = grid?.pointer;
      grid = makeGrid(cols, rows, pitch, w, h);
      if (prevPointer) Object.assign(grid.pointer, prevPointer);
      state = s.init(grid);
      renderBase();
      if (!running()) still();
    };

    const still = (): void => {
      if (!grid) return;
      const s = sceneRef.current;
      if (reduce || shellPaused) {
        // One representative frame: replay the scene up to its still time.
        grid.clear();
        state = s.init(grid);
        const target = s.still ?? 3;
        const dt = 1 / 30;
        for (let x = 0; x < target; x += dt) s.step(grid, state, x, dt);
        draw();
        return;
      }
      if (state !== null) {
        s.step(grid, state, t, 0);
        draw();
      }
    };

    const running = (): boolean => inView && pageVisible && !reduce && !shellPaused;

    const frame = (now: number): void => {
      raf = 0;
      if (!running() || !grid || state === null) return;
      // Dot-matrix art steps at ~30 fps (it reads as a stepped display anyway): half the paint cost per canvas.
      if (last !== 0 && now - last < 31) {
        raf = requestAnimationFrame(frame);
        return;
      }
      const dt = last === 0 ? 1 / 30 : Math.min(0.08, (now - last) / 1000);
      last = now;
      t += dt;
      if (++frameCount % 30 === 0) {
        shellPaused = isStill(canvas);
        if (shellPaused) {
          last = 0;
          return;
        }
      }
      const p = grid.pointer;
      p.strength += ((p.active ? 1 : 0) - p.strength) * Math.min(1, dt * 6);
      sceneRef.current.step(grid, state, t, dt);
      draw();
      raf = requestAnimationFrame(frame);
    };

    const sync = (): void => {
      shellPaused = isStill(canvas);
      if (running()) {
        if (raf === 0) {
          last = 0;
          raf = requestAnimationFrame(frame);
        }
      } else {
        if (raf !== 0) cancelAnimationFrame(raf);
        raf = 0;
        if (reduce || shellPaused) still();
      }
    };

    const io =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(
            (entries) => {
              for (const e of entries) inView = e.isIntersecting;
              sync();
            },
            { rootMargin: "80px 0px" },
          );
    if (io) io.observe(canvas);
    else inView = true;

    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => resize());
    ro?.observe(canvas);

    const onVisibility = (): void => {
      pageVisible = document.visibilityState !== "hidden";
      sync();
    };
    document.addEventListener("visibilitychange", onVisibility);

    const mq = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    const onMotion = (): void => {
      reduce = reducedMotion();
      sync();
      if (reduce) still();
    };
    mq?.addEventListener("change", onMotion);

    // Theme switches change the colour tokens.
    const mo = new MutationObserver(() => {
      colors = readColors(canvas);
      renderBase();
      if (!running()) still();
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-palette", "class"] });
    // The shell's motion toggle sets html[data-motion="still"] (paused, or reduced motion).
    const moShell = new MutationObserver(() => {
      sync();
      if (!running()) still();
    });
    moShell.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
    const legacyShell = canvas.closest("[data-motion]");
    if (legacyShell && legacyShell !== document.documentElement) moShell.observe(legacyShell, { attributes: true, attributeFilter: ["data-motion"] });

    const usePointer = sceneRef.current.pointer !== false;
    const onMove = (e: PointerEvent): void => {
      if (!grid) return;
      const rect = canvas.getBoundingClientRect();
      grid.pointer.x = (e.clientX - rect.left - grid.ox) / grid.pitch;
      grid.pointer.y = (e.clientY - rect.top - grid.oy) / grid.pitch;
      grid.pointer.active = true;
    };
    const onLeave = (): void => {
      if (grid) grid.pointer.active = false;
    };
    const onDown = (e: PointerEvent): void => {
      if (!grid || e.button !== 0) return;
      onMove(e);
      grid.pointer.downs++;
    };
    if (usePointer) {
      host.addEventListener("pointermove", onMove);
      host.addEventListener("pointerleave", onLeave);
      host.addEventListener("pointerdown", onDown);
    }

    shellPaused = isStill(canvas);
    resize();
    sync();

    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      io?.disconnect();
      ro?.disconnect();
      mo.disconnect();
      moShell.disconnect();
      mq?.removeEventListener("change", onMotion);
      document.removeEventListener("visibilitychange", onVisibility);
      if (usePointer) {
        host.removeEventListener("pointermove", onMove);
        host.removeEventListener("pointerleave", onLeave);
        host.removeEventListener("pointerdown", onDown);
      }
    };
  }, [hostRef]);

  return canvasRef;
}

// ------------------------------------------------------------- helpers ---

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smooth = (x: number): number => {
  const v = clamp01(x);
  return v * v * (3 - 2 * v);
};
export const easeOut = (x: number): number => 1 - Math.pow(1 - clamp01(x), 3);

/** Deterministic PRNG (mulberry32) so still frames are stable. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** Light cells near the pointer (a soft flashlight over the off dots). */
export function pointerGlow(g: Grid, radius: number, amount: number, ink: Ink = INK.muted): void {
  const p = g.pointer;
  if (p.strength < 0.02) return;
  const r2 = radius * radius;
  const c0 = Math.max(0, Math.floor(p.x - radius));
  const c1 = Math.min(g.cols - 1, Math.ceil(p.x + radius));
  const r0 = Math.max(0, Math.floor(p.y - radius));
  const r1 = Math.min(g.rows - 1, Math.ceil(p.y + radius));
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const d2 = (c - p.x) * (c - p.x) + (r - p.y) * (r - p.y);
      if (d2 > r2) continue;
      g.set(c, r, amount * p.strength * (1 - d2 / r2), ink);
    }
  }
}

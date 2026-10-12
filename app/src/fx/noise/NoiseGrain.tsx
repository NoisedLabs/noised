/**
 * <NoiseGrain />: an extremely quiet field of fine dots behind a section. A loose lattice of tiny round dots whose
 * brightness drifts with slow simplex noise, like faint static that never settles. Fills its positioned parent
 * (absolute, under the content), aria-hidden.
 *
 *   <section style="position: relative"><NoiseGrain fade="left" /> ...</section>
 *
 * Cheap by design: one dot per `pitch` CSS px square (~3k dots on a wide screen) at 1x resolution, 12 frames a
 * second, only while on screen and the tab is visible, on the shared frame loop. Reduced motion: one still frame.
 */
import { useEffect, useRef, type ReactNode } from "react";

import { lightTheme, motionStill, observeOnScreen, onMotionChange, onThemeChange, readInk } from "./env";
import { rng } from "./rng";
import { noiseScheduler } from "./scheduler";
import { simplex } from "./simplex";
import "./noise.css";

export type GrainFade = "left" | "right" | "top" | "bottom" | "radial" | "none";

export interface NoiseGrainProps {
  /** Where the field is strongest (it fades out away from there). Default "radial" (the middle). */
  fade?: GrainFade;
  /** Spacing of the dots, CSS px (default 22). */
  pitch?: number;
  /** Brightest dot alpha (default 0.16). */
  strength?: number;
  /** Drift speed (default 1). */
  speed?: number;
  /** Seed (different sections drift differently). */
  seed?: number;
  className?: string;
}

const LEVELS = 8;

export function NoiseGrain({ fade = "radial", pitch = 22, strength = 0.16, speed = 1, seed = 7, className = "" }: NoiseGrainProps): ReactNode {
  const box = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = box.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d", { alpha: true });
    if (!el || !canvas || !ctx) return;
    const noise = simplex(seed);
    let w = 0;
    let h = 0;
    // 1x is plenty for dots this faint (and keeps a full-width canvas cheap).
    const dpr = 1;
    let xs = new Float32Array(0);
    let ys = new Float32Array(0);
    let base = new Float32Array(0);
    let lv = new Uint8Array(0);
    let t = 0;
    let onScreen = false;
    let still = motionStill();
    let stopTask: (() => void) | null = null;
    let colour = "0,0,0";
    let scale = 1;

    const recolor = (): void => {
      const [r, g, b] = readInk(canvas);
      colour = `${r},${g},${b}`;
      scale = lightTheme() ? 0.8 : 1;
    };

    const layout = (): void => {
      const r = el.getBoundingClientRect();
      const nw = Math.round(r.width);
      const nh = Math.round(r.height);
      if (nw < 2 || nh < 2 || (nw === w && nh === h)) return;
      w = nw;
      h = nh;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      const rand = rng(seed * 131 + 7);
      const pts: number[] = [];
      const fades: number[] = [];
      for (let y = pitch / 2; y < h; y += pitch) {
        for (let x = pitch / 2; x < w; x += pitch) {
          const px = x + (rand() - 0.5) * pitch * 0.9;
          const py = y + (rand() - 0.5) * pitch * 0.9;
          const u = px / w;
          const v = py / h;
          let f = 1;
          if (fade === "left") f = 1 - smooth(0.05, 0.62, u);
          else if (fade === "right") f = smooth(0.38, 0.95, u);
          else if (fade === "top") f = 1 - smooth(0.05, 0.7, v);
          else if (fade === "bottom") f = smooth(0.3, 0.95, v);
          else if (fade === "radial") f = 1 - smooth(0.25, 0.75, Math.hypot(u - 0.5, (v - 0.5) * (h / Math.max(1, w)) * 1.4));
          // Soft top and bottom edges so a section's field never shows a seam against the next one.
          f *= smooth(0, 0.12, v) * (1 - smooth(0.88, 1, v));
          if (f < 0.04) continue;
          pts.push(px, py);
          fades.push(f);
        }
      }
      const n = fades.length;
      xs = new Float32Array(n);
      ys = new Float32Array(n);
      base = Float32Array.from(fades);
      lv = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        xs[i] = pts[i * 2]!;
        ys[i] = pts[i * 2 + 1]!;
      }
      paint();
    };

    const paint = (): void => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const n = base.length;
      const f = 1 / 260;
      const tt = (still ? 0 : t) * 0.05 * speed;
      for (let i = 0; i < n; i++) {
        // Slow patches of slightly brighter static drifting across the lattice.
        const v = 0.5 + 0.5 * noise.noise3(xs[i]! * f, ys[i]! * f, tt);
        const a = base[i]! * (0.25 + 0.75 * v * v * v) * strength * scale;
        lv[i] = Math.min(LEVELS, Math.round((a / Math.max(0.001, strength)) * LEVELS));
      }
      for (let l = 1; l <= LEVELS; l++) {
        ctx.fillStyle = `rgba(${colour},${((l / LEVELS) * strength * scale).toFixed(3)})`;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          if (lv[i] !== l) continue;
          const x = xs[i]!;
          const y = ys[i]!;
          ctx.moveTo(x + 0.85, y);
          ctx.arc(x, y, 0.85, 0, Math.PI * 2);
        }
        ctx.fill();
      }
    };

    const task = {
      fps: 12,
      frame(dt: number): void {
        t += dt;
        paint();
      },
    };
    const sync = (): void => {
      const run = onScreen && !still;
      if (run && !stopTask) stopTask = noiseScheduler().add(task);
      else if (!run && stopTask) {
        stopTask();
        stopTask = null;
      }
    };

    recolor();
    layout();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(layout);
    ro?.observe(el);
    const offScreen = observeOnScreen(el, (on) => {
      onScreen = on;
      sync();
    });
    const offMotion = onMotionChange(() => {
      still = motionStill();
      sync();
      paint();
    });
    const offTheme = onThemeChange(() => {
      recolor();
      paint();
    });
    return () => {
      stopTask?.();
      ro?.disconnect();
      offScreen();
      offMotion();
      offTheme();
    };
  }, [fade, pitch, strength, speed, seed]);

  return (
    <div ref={box} className={`nz-grain ${className}`} aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  );
}

function smooth(a: number, b: number, v: number): number {
  const x = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return x * x * (3 - 2 * x);
}

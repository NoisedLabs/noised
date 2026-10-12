/**
 * <NoiseArt scene={...} />: a field of fine dots drifting in noise that coalesces into the scene's shapes, holds,
 * dissolves and re-forms (fx/noise/field.ts). Decorative (aria-hidden).
 *
 *   <div className="my-art-box"><NoiseArt scene={lockScene} /></div>   // the box is positioned and sized; the art fills it
 *
 * Runs on the page's one shared frame loop (at most 60 fps; 30 while the shape only holds or rests), only while it
 * is on screen, the tab is visible, it is playing and motion is on. Reduced motion (or the visitor's motion switch) shows the formed still frame. The dots part around the
 * pointer over `host` (default: the art's parent). Canvas 2D at devicePixelRatio <= 1.5, colours from the theme
 * (--nz-ink, else --text), redrawn on a theme switch. CSP-safe: no injected markup or styles.
 */
import { useEffect, useRef, type ReactNode, type RefObject } from "react";

import { drawFrame } from "./draw";
import { cappedDpr, lightTheme, motionStill, observeOnScreen, onMotionChange, onThemeChange, readInk } from "./env";
import { buildField, computeFrame, createFrame, timelineAt, type Field, type FrameOut, type NoiseScene } from "./field";
import { noiseScheduler } from "./scheduler";
import "./noise.css";

export interface NoiseArtProps {
  scene: NoiseScene;
  className?: string;
  /** false holds the current frame (default true). */
  playing?: boolean;
  /** Jump to this running time (seconds) whenever it changes. */
  seekTo?: number | undefined;
  /** Called whenever the scene moves on to another step (sequence players). */
  onStep?: (step: number) => void;
  /** Element whose pointer the dots part around (default: the art's parent). */
  host?: RefObject<HTMLElement | null>;
  /** Running time to start from (default 0: the art first appears as noise and coalesces). */
  start?: number;
}

export function NoiseArt({ scene, className = "", playing = true, seekTo, onStep, host, start = 0 }: NoiseArtProps): ReactNode {
  const wrap = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const api = useRef<{ setPlaying(p: boolean): void; seek(t: number): void } | null>(null);
  const onStepRef = useRef(onStep);
  onStepRef.current = onStep;
  const playingRef = useRef(playing);
  playingRef.current = playing;

  useEffect(() => {
    const box = wrap.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d", { alpha: true });
    if (!box || !canvas || !ctx) return;
    const scheduler = noiseScheduler();
    let field: Field | null = null;
    let out: FrameOut | null = null;
    let t = start;
    let w = 0;
    let h = 0;
    let dpr = cappedDpr();
    let ink = { r: 0, g: 0, b: 0 };
    let inkScale = 1;
    let onScreen = false;
    let still = motionStill();
    let playingNow = playingRef.current;
    let stopTask: (() => void) | null = null;
    let pointer: { x: number; y: number } | null = null;
    let lastStep = -1;
    let rebuild = 0;
    // A seek while motion is off picks which step the still frame shows (How it works: the picked step).
    let stillAt: number | undefined;

    const recolor = (): void => {
      const [r, g, b] = readInk(canvas);
      ink = { r, g, b };
      // Graphite dots on paper read a little heavier than light ones on graphite: ease them off a touch.
      inkScale = lightTheme() ? 0.9 : 1;
    };

    const paint = (dt: number): void => {
      if (!field || !out) return;
      computeFrame(field, t, out, { still, stillAt, pointer, dt, ink: inkScale });
      drawFrame(ctx, field, out, ink, dpr);
      if (out.step !== lastStep) {
        lastStep = out.step;
        onStepRef.current?.(out.step);
      }
    };

    // At most 60 frames a second (a 120 Hz screen paints every other frame), and 30 while the shape only shimmers
    // and drifts (holding, resting) and the pointer is away: those movements are slow, a fast frame rate buys nothing.
    let sincePaint = 0;
    const task = {
      fps: 60,
      frame(dt: number): void {
        t += dt;
        sincePaint += dt;
        if (field && !pointer && field.pointerEnergy === 0 && sincePaint < 1 / 30 - 0.004) {
          const phase = timelineAt(field.scene, t).phase;
          if (phase === 1 || phase === 3) return;
        }
        paint(sincePaint);
        sincePaint = 0;
      },
    };

    const sync = (): void => {
      const run = onScreen && playingNow && !still && field !== null;
      if (run && !stopTask) stopTask = scheduler.add(task);
      else if (!run && stopTask) {
        stopTask();
        stopTask = null;
      }
    };

    const build = (): void => {
      rebuild = 0;
      const r = box.getBoundingClientRect();
      const nw = Math.round(r.width);
      const nh = Math.round(r.height);
      if (nw < 2 || nh < 2) return;
      dpr = cappedDpr();
      if (nw === w && nh === h && field) return;
      w = nw;
      h = nh;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      field = buildField(scene, w, h);
      out = createFrame(field);
      paint(0);
      sync();
    };

    recolor();
    build();
    const ro =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            // The first size builds at once; later resizes settle first (a field is rebuilt from its shapes).
            if (!field) build();
            else {
              window.clearTimeout(rebuild);
              rebuild = window.setTimeout(build, 140);
            }
          });
    ro?.observe(box);

    const offScreen = observeOnScreen(box, (on) => {
      onScreen = on;
      sync();
    });
    const offMotion = onMotionChange(() => {
      still = motionStill();
      sync();
      paint(0);
    });
    const offTheme = onThemeChange(() => {
      recolor();
      paint(0);
    });

    const hostEl = host?.current ?? box.parentElement ?? box;
    const onMove = (e: PointerEvent): void => {
      const r = box.getBoundingClientRect();
      pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onLeave = (): void => {
      pointer = null;
    };
    hostEl.addEventListener("pointermove", onMove, { passive: true });
    hostEl.addEventListener("pointerleave", onLeave, { passive: true });

    api.current = {
      setPlaying(p) {
        playingNow = p;
        sync();
      },
      seek(next) {
        t = Math.max(0, next);
        stillAt = t;
        paint(0);
      },
    };

    return () => {
      api.current = null;
      stopTask?.();
      stopTask = null;
      window.clearTimeout(rebuild);
      ro?.disconnect();
      offScreen();
      offMotion();
      offTheme();
      hostEl.removeEventListener("pointermove", onMove);
      hostEl.removeEventListener("pointerleave", onLeave);
    };
    // A new scene object rebuilds the art; `start` only matters on mount.
  }, [scene, host]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    api.current?.setPlaying(playing);
  }, [playing]);

  useEffect(() => {
    if (seekTo !== undefined) api.current?.seek(seekTo);
  }, [seekTo]);

  return (
    <span ref={wrap} className={`nz-art ${className}`} aria-hidden="true">
      <canvas ref={canvasRef} />
    </span>
  );
}

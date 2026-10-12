/**
 * <ShieldWall />: the hero's WebGL shield wall (a 3D wall of hexagonal
 * shields made of ~27k dots that blocks incoming shots). Reduced motion (or
 * ambient motion switched off) gets one still WebGL frame; without WebGL a
 * 2D canvas draws the same wall once. Decorative: hidden from assistive
 * technology and never takes pointer events (the hero forwards clicks to
 * `fireAt` through the ref). No labels, numbers or panels.
 */
import { useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";

import { useAmbientMotion } from "../../components/AmbientMotion";
import { usePrefersReducedMotion } from "../motion";
import { startWall, type Framing, type GlassSource, type ImpactInfo, type WallEngine } from "./engine";
import { drawStillWall } from "./still2d";
import "./wall.css";

export type { GlassSource, ImpactInfo } from "./engine";

export interface ShieldWallHandle {
  /** Fire a shot at a viewport point; false when it misses the wall (or in the still frame). */
  fireAt: (clientX: number, clientY: number) => boolean;
}

/** The fixed navbar's bottom edge in the viewport (the wall fades in below it). */
function navBottom(): number {
  const header = [...document.querySelectorAll("header")].find((h) => getComputedStyle(h).position === "fixed");
  const nav = header?.querySelector("nav") ?? header;
  const r = nav?.getBoundingClientRect();
  return r && r.height > 0 && r.height < 200 ? r.bottom : 72;
}

/** The navbar's bottom edge in the CSS px of an element that scrolls with the page (as at the top of the page). */
function topInsetOf(el: Element): number {
  return Math.max(0, navBottom() - (el.getBoundingClientRect().top + window.scrollY));
}

export function ShieldWall({
  className = "",
  focus,
  onImpact,
  framing,
  play = true,
  introSpeed = 1,
  skipIntro = false,
  startDelayMs = 0,
  onFallback,
  glass,
  onGlass,
  ref,
}: {
  className?: string;
  /** The headline block: the wall calms down behind it and shots avoid it. */
  focus?: () => HTMLElement | null;
  onImpact?: (info: ImpactInfo) => void;
  /** Overrides for the wall's composition (camera, framing, light pool). */
  framing?: Partial<Framing>;
  /** false holds the intro; the wall assembles when it turns true. */
  play?: boolean;
  /** Intro (assembly) speed multiplier: >1 assembles faster (repeat visits). */
  introSpeed?: number;
  /** Start with the wall already in formation (it only fades in). */
  skipIntro?: boolean;
  /** Create the WebGL engine this many ms after mount (0: at once). */
  startDelayMs?: number;
  /** Called when WebGL is unavailable and the 2D still frame is shown instead. */
  onFallback?: () => void;
  /** Elements to draw liquid glass under (their rects are tracked every frame). */
  glass?: () => readonly GlassSource[];
  /** true: the wall draws the glass; false: the page keeps its CSS backdrop blur. */
  onGlass?: (active: boolean) => void;
  ref?: Ref<ShieldWallHandle>;
}): ReactNode {
  const ambient = useAmbientMotion();
  const reducedOs = usePrefersReducedMotion();
  const reduced = ambient.still || reducedOs;
  const [failed, setFailed] = useState(false);
  const fallbackRef = useRef(onFallback);
  fallbackRef.current = onFallback;
  useEffect(() => {
    if (failed) fallbackRef.current?.();
  }, [failed]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engine = useRef<WallEngine | null>(null);
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const impactRef = useRef(onImpact);
  impactRef.current = onImpact;
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;
  const playRef = useRef(play);
  playRef.current = play;
  const glassRef = useRef(glass);
  glassRef.current = glass;
  const onGlassRef = useRef(onGlass);
  onGlassRef.current = onGlass;
  const framingKey = framing ? JSON.stringify(framing) : "";

  useImperativeHandle(ref, () => ({ fireAt: (x, y) => engine.current?.fireAt(x, y) ?? false }), []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (failed || !canvas) return;
    // The engine compiles its shaders in the background and fades the canvas in on its first real frame.
    let e: WallEngine | null = null;
    const start = (): void => {
      e = startWall(canvas, {
        onFail: () => setFailed(true),
        focus: () => focusRef.current?.() ?? null,
        still: reducedRef.current,
        play: playRef.current,
        introSpeed,
        skipIntro,
        topInset: topInsetOf(canvas),
        onImpact: (info) => impactRef.current?.(info),
        glass: () => glassRef.current?.() ?? [],
        onGlass: (active) => onGlassRef.current?.(active),
        ...(framingKey ? { framing: JSON.parse(framingKey) as Partial<Framing> } : {}),
      });
      engine.current = e;
    };
    const timer = startDelayMs > 0 ? window.setTimeout(start, startDelayMs) : 0;
    if (startDelayMs <= 0) start();
    return () => {
      window.clearTimeout(timer);
      engine.current = null;
      e?.stop();
      onGlassRef.current?.(false);
    };
    // introSpeed / skipIntro / startDelayMs are read once per engine (they only shape the intro).
  }, [failed, framingKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    engine.current?.setStill(reduced);
  }, [reduced]);

  useEffect(() => {
    if (play) engine.current?.play();
  }, [play]);

  if (failed) {
    return (
      <div aria-hidden="true" className={`sw sw-fallback ${className}`}>
        <StillWall focus={focus} framing={framing} />
      </div>
    );
  }
  // The 2D still frame is painted at once as a poster under the WebGL canvas, so the wall is there on the first
  // paint; the live canvas cross-fades over it on its first real frame (wall.css) and the poster stops redrawing.
  return (
    <div aria-hidden="true" className={`sw ${className}`}>
      <canvas ref={canvasRef} className="sw-canvas" data-mode={reduced ? "still" : "live"} />
      <StillWall focus={focus} framing={framing} poster={canvasRef} />
    </div>
  );
}

/**
 * No WebGL: the same wall as one still frame on a 2D canvas (redrawn on resize and theme change). With `poster`
 * (the live WebGL canvas) it is the placeholder under that canvas and stops redrawing once the canvas has started.
 */
function StillWall({
  focus,
  framing,
  poster,
}: {
  focus?: (() => HTMLElement | null) | undefined;
  framing?: Partial<Framing> | undefined;
  poster?: RefObject<HTMLCanvasElement | null>;
}): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const framingKey = framing ? JSON.stringify(framing) : "";
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf = 0;
    const live = (): boolean => poster?.current?.dataset.started === "1";
    const paint = (): void => {
      if (live()) return;
      {
        const r = canvas.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return;
        const el = focusRef.current?.() ?? null;
        const f = el?.getBoundingClientRect();
        // Monochrome (v5.1): silver dots and white light on Graphite, graphite on Paper.
        const light = document.documentElement.dataset.theme === "light";
        const ok = drawStillWall(canvas, {
          width: r.width,
          height: r.height,
          dpr: Math.min(window.devicePixelRatio || 1, 1.5),
          ink: light ? "rgb(30 30 30)" : "rgb(208 208 208)",
          ice: light ? "rgb(6 6 6)" : "rgb(255 255 255)",
          light,
          calm: f ? new DOMRect(f.left - r.left, f.top - r.top, f.width, f.height) : null,
          topInset: topInsetOf(canvas),
          ...(framingKey ? { framing: JSON.parse(framingKey) as Partial<Framing> } : {}),
        });
        canvas.dataset.started = ok ? "1" : "0";
      }
    };
    const draw = (): void => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(paint);
    };
    // The poster paints right away (before the next frame), the fallback on the next frame.
    if (poster) paint();
    else draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    const mo = new MutationObserver(draw);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-palette"] });
    // Poster: once the live canvas has faded in over it, release its pixels (a full-hero bitmap).
    let release = 0;
    const liveWatch = new MutationObserver(() => {
      if (!live() || release) return;
      release = window.setTimeout(() => {
        canvas.width = 0;
        canvas.height = 0;
      }, 800);
    });
    const target = poster?.current;
    if (target) liveWatch.observe(target, { attributes: true, attributeFilter: ["data-started"] });
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(release);
      ro.disconnect();
      mo.disconnect();
      liveWatch.disconnect();
    };
  }, [framingKey]); // eslint-disable-line react-hooks/exhaustive-deps
  return <canvas ref={canvasRef} className={poster ? "sw-poster" : "sw-canvas"} data-mode="still2d" />;
}

/**
 * "Resolve from noise": an element fades in through a mask of soft round dots that grow until they merge, so it
 * appears as faint static first and then settles into focus. Three dot lattices of unrelated pitch overlap, so the
 * pattern reads as noise, not as a grid.
 *
 *   const ref = useRef<HTMLDivElement>(null);
 *   useNoiseReveal(ref, { delay: 200 });          // when it first scrolls into view
 *   useNoiseReveal(ref, { immediate: true });     // right away (hero, page change)
 *   <NoiseReveal as="p" className="lead">...</NoiseReveal>
 *
 * CSP-safe: the mask and the opacity are set through the CSSOM (element.style), never a <style> tag. Runs on the
 * shared frame loop and cleans every property it set when done. Reduced motion (or no IntersectionObserver): the
 * element simply shows. Like any mask / opacity fade, frosted glass inside the element shows its blur once the
 * reveal ends (about half a second).
 */
import { createElement, useEffect, useRef, type ElementType, type ReactNode, type RefObject } from "react";

import { motionStill } from "./env";
import { noiseScheduler } from "./scheduler";

export type ResolveSweep = "none" | "right" | "down" | "up";

export interface NoiseRevealOptions {
  /** Milliseconds (default 700). */
  duration?: number;
  /** Milliseconds after it starts to be seen (default 0). */
  delay?: number;
  /** Also sweep in from one side while the dots grow (default "none"). */
  sweep?: ResolveSweep;
  /** IntersectionObserver threshold (default 0.12). */
  threshold?: number;
  /** Start on mount instead of on first view. */
  immediate?: boolean;
  /** Called when it has finished (or at once under reduced motion). */
  onDone?: () => void;
}

/** The dot lattices: pitch (px) and offset (px). Unrelated pitches, so their union looks random. */
const LATTICES: readonly (readonly [number, number, number])[] = [
  [7, 0, 0],
  [11, 4, 6],
  [13, 9, 3],
];
const MASK_PROPS = ["mask-image", "-webkit-mask-image", "mask-size", "-webkit-mask-size", "mask-position", "-webkit-mask-position", "mask-repeat", "-webkit-mask-repeat"];

const ease = (v: number): number => 1 - (1 - v) ** 3;

/**
 * The mask at progress p (0 hidden .. 1 fully shown): growing soft dots, plus an optional sweep. `invert` gives the
 * holes instead (transparent dots on solid: intersect the layers, see noiseWipe).
 */
export function resolveMask(p: number, sweep: ResolveSweep = "none", invert = false): { image: string; size: string; position: string } {
  const layers: string[] = [];
  const sizes: string[] = [];
  const positions: string[] = [];
  for (const [pitch, x, y] of LATTICES) {
    // Radius grows past the cell's half-diagonal (0.71 x pitch), so at p = 1 the dots cover everything.
    const r = Math.max(0, p * pitch * 0.78);
    const [inside, outside] = invert ? ["transparent", "#000"] : ["#000", "transparent"];
    layers.push(`radial-gradient(circle, ${inside} ${r.toFixed(2)}px, ${outside} ${(r + 1.4).toFixed(2)}px)`);
    sizes.push(`${pitch}px ${pitch}px`);
    positions.push(`${x}px ${y}px`);
  }
  if (sweep !== "none") {
    const dir = sweep === "right" ? "90deg" : sweep === "down" ? "180deg" : "0deg";
    const edge = -30 + p * 160;
    layers.push(`linear-gradient(${dir}, #000 ${edge.toFixed(1)}%, transparent ${(edge + 30).toFixed(1)}%)`);
    sizes.push("100% 100%");
    positions.push("0 0");
  }
  return { image: layers.join(", "), size: sizes.join(", "), position: positions.join(", ") };
}

function apply(el: HTMLElement, p: number, sweep: ResolveSweep): void {
  const m = resolveMask(p, sweep);
  const s = el.style;
  s.setProperty("mask-image", m.image);
  s.setProperty("-webkit-mask-image", m.image);
  s.setProperty("mask-size", m.size);
  s.setProperty("-webkit-mask-size", m.size);
  s.setProperty("mask-position", m.position);
  s.setProperty("-webkit-mask-position", m.position);
  s.setProperty("mask-repeat", "repeat");
  s.setProperty("-webkit-mask-repeat", "repeat");
  s.setProperty("opacity", Math.min(1, 0.15 + p * 1.1).toFixed(3));
}

function clear(el: HTMLElement): void {
  for (const p of MASK_PROPS) el.style.removeProperty(p);
  el.style.removeProperty("opacity");
}

/**
 * Plays the resolve on `el` now (after `delay`). Returns a cancel function that also restores the element.
 * Under reduced motion it does nothing (and calls onDone).
 */
export function playResolve(el: HTMLElement, opts: NoiseRevealOptions = {}): () => void {
  const { duration = 700, delay = 0, sweep = "none", onDone } = opts;
  if (motionStill()) {
    onDone?.();
    return () => undefined;
  }
  apply(el, 0, sweep);
  let elapsed = -delay / 1000;
  let stop: (() => void) | null = null;
  let finished = false;
  const total = Math.max(0.05, duration / 1000);
  stop = noiseScheduler().add({
    frame(dt) {
      elapsed += dt;
      if (elapsed < 0) return;
      const p = elapsed / total;
      if (p >= 1) {
        finished = true;
        stop?.();
        stop = null;
        clear(el);
        onDone?.();
        return;
      }
      apply(el, ease(p), sweep);
    },
  });
  return () => {
    stop?.();
    stop = null;
    if (!finished) clear(el);
  };
}

/** Resolves `ref`'s element in from noise when it first enters the viewport (or at once with `immediate`). */
export function useNoiseReveal(ref: RefObject<HTMLElement | null>, opts: NoiseRevealOptions = {}): void {
  const { duration = 700, delay = 0, sweep = "none", threshold = 0.12, immediate = false } = opts;
  const done = useRef(opts.onDone);
  done.current = opts.onDone;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (motionStill() || (!immediate && typeof IntersectionObserver === "undefined")) {
      done.current?.();
      return;
    }
    let cancel: (() => void) | null = null;
    // Hidden from mount until it plays (no flash of the finished element first).
    apply(el, 0, sweep);
    const run = (): void => {
      cancel = playResolve(el, { duration, delay, sweep, onDone: () => done.current?.() });
    };
    let io: IntersectionObserver | null = null;
    if (immediate) run();
    else {
      io = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            io?.disconnect();
            io = null;
            run();
          }
        },
        { threshold },
      );
      io.observe(el);
    }
    return () => {
      io?.disconnect();
      cancel?.();
      clear(el);
    };
  }, [ref, duration, delay, sweep, threshold, immediate]);
}

export interface NoiseRevealProps extends NoiseRevealOptions {
  as?: ElementType;
  className?: string;
  id?: string;
  children?: ReactNode;
}

export function NoiseReveal({ as = "div", className = "", id, children, ...opts }: NoiseRevealProps): ReactNode {
  const ref = useRef<HTMLElement>(null);
  useNoiseReveal(ref, opts);
  return createElement(as, { ref, className, id }, children);
}

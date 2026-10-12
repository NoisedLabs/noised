/**
 * <ResolveText>: a headline that resolves out of noise, left to right: faint dots of the letters appear first, then
 * merge into the crisp text while a soft edge sweeps across (the same "signal from noise" mask as useNoiseReveal).
 *
 *   <h1><ResolveText text="Quantum security" trigger="mount" /></h1>
 *   <h2><ResolveText text="Why " /><ResolveText text="Noised" className="hm-accent" delay={140} /></h2>
 *
 * The real text is always in the DOM and holds the layout (screen readers and find-in-page read it); only a mask
 * and opacity change, through the CSSOM. Reduced motion: the text, at once.
 */
import { createElement, useEffect, useRef, type ElementType, type ReactNode } from "react";

import { motionStill } from "./env";
import { playResolve } from "./reveal";
import "./noise.css";

export interface ResolveTextProps {
  text: string;
  as?: ElementType;
  className?: string;
  /** Total time in ms (default 700). */
  durationMs?: number;
  /** Delay in ms before it starts (default 0). */
  delay?: number;
  /** "view" (default): when it first scrolls into view; "mount": right away. */
  trigger?: "view" | "mount";
}

export function ResolveText({ text, as = "span", className = "", durationMs = 700, delay = 0, trigger = "view" }: ResolveTextProps): ReactNode {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current?.firstElementChild;
    if (!(el instanceof HTMLElement) || motionStill()) return;
    let cancel: (() => void) | null = null;
    let io: IntersectionObserver | null = null;
    // Hidden until it plays.
    el.style.setProperty("opacity", "0");
    const run = (): void => {
      el.style.removeProperty("opacity");
      cancel = playResolve(el, { duration: durationMs, delay, sweep: "right" });
    };
    if (trigger === "mount" || typeof IntersectionObserver === "undefined") run();
    else {
      io = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io?.disconnect();
          io = null;
          run();
        }
      });
      io.observe(el);
    }
    return () => {
      io?.disconnect();
      cancel?.();
      el.style.removeProperty("opacity");
    };
  }, [text, durationMs, delay, trigger]);

  return createElement(as, { ref, className: `nz-text ${className}` }, <span className="nz-text-in">{text}</span>);
}

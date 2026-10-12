/**
 * Ambient motion switch: decorative loops (dot fields, marquees, tickers,
 * WebGL) pause when the user turns motion off, and are always off under
 * prefers-reduced-motion. The choice persists (localStorage "noised.motion").
 *
 *   const { paused, reduced, still, toggle } = useAmbientMotion();
 *   // still === paused || reduced: render a static frame.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { usePrefersReducedMotion } from "../fx/motion";
import { sfx } from "../fx/sfx";

const KEY = "noised.motion";

interface AmbientMotionState {
  paused: boolean;
  reduced: boolean;
  /** paused || reduced. */
  still: boolean;
  toggle: () => void;
  setPaused: (p: boolean) => void;
}

const AmbientMotion = createContext<AmbientMotionState>({ paused: false, reduced: false, still: false, toggle: () => {}, setPaused: () => {} });

function readPaused(): boolean {
  try {
    return globalThis.localStorage?.getItem(KEY) === "off";
  } catch {
    return false;
  }
}

export function AmbientMotionProvider({ children }: { children: ReactNode }): ReactNode {
  const [paused, setPausedState] = useState(readPaused);
  const reduced = usePrefersReducedMotion();
  const setPaused = useCallback((p: boolean) => {
    setPausedState(p);
    try {
      globalThis.localStorage?.setItem(KEY, p ? "off" : "on");
    } catch {
      // Storage blocked: the choice lasts for this page only.
    }
  }, []);
  const toggle = useCallback(() => {
    setPausedState((p) => {
      const next = !p;
      try {
        globalThis.localStorage?.setItem(KEY, next ? "off" : "on");
      } catch {
        // ignore
      }
      return next;
    });
    sfx.play("toggle");
  }, []);
  useEffect(() => {
    document.documentElement.dataset.motion = paused || reduced ? "still" : "on";
  }, [paused, reduced]);
  useInViewFlags();
  const value = useMemo(() => ({ paused, reduced, still: paused || reduced, toggle, setPaused }), [paused, reduced, toggle, setPaused]);
  return <AmbientMotion.Provider value={value}>{children}</AmbientMotion.Provider>;
}

export const useAmbientMotion = (): AmbientMotionState => useContext(AmbientMotion);

/** Sections (and panels, and the footer) whose CSS loops pause while they are off screen. */
const INVIEW_SELECTOR = "main section, main .ip-panel, main [data-observe], footer";

/**
 * One IntersectionObserver for the whole app: every section gets
 * `data-inview="true" | "false"`, and styles.css pauses the CSS animations
 * inside the ones that are off screen (`animation-play-state: paused`).
 * New sections (route changes, lazy content) are picked up by a debounced
 * MutationObserver on <main>. Pure presentation: no state, no re-renders.
 */
function useInViewFlags(): void {
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined" || typeof MutationObserver === "undefined") return;
    const observed = new Set<Element>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) (e.target as HTMLElement).dataset.inview = e.isIntersecting ? "true" : "false";
      },
      { rootMargin: "160px 0px" },
    );
    const scan = (): void => {
      for (const el of observed) {
        if (!el.isConnected) {
          io.unobserve(el);
          observed.delete(el);
        }
      }
      for (const el of document.querySelectorAll(INVIEW_SELECTOR)) {
        if (observed.has(el)) continue;
        observed.add(el);
        io.observe(el);
      }
    };
    scan();
    let timer = 0;
    const mo = new MutationObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(scan, 120);
    });
    mo.observe(document.getElementById("main") ?? document.body, { childList: true, subtree: true });
    return () => {
      window.clearTimeout(timer);
      mo.disconnect();
      io.disconnect();
    };
  }, []);
}

/** "[≋ MOTION]" switch (footer, mobile sheet). */
export function AmbientMotionToggle({ className = "" }: { className?: string }): ReactNode {
  const { paused, reduced, toggle } = useAmbientMotion();
  return (
    <button
      type="button"
      className={`terminal-motion-toggle ${className}`}
      onClick={toggle}
      disabled={reduced}
      aria-label={reduced ? "Animation disabled by reduced motion preference" : paused ? "Play ambient animations" : "Pause ambient animations"}
      aria-pressed={paused || reduced}
    >
      <span className="terminal-motion-bars" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>{paused || reduced ? "MOTION OFF" : "MOTION ON"}</span>
    </button>
  );
}

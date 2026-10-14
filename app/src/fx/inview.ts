/**
 * Scroll-entrance helpers (UI v3 "everything enters with choreography").
 *
 *   const ref = useRef<HTMLDivElement>(null);
 *   const shown = useInViewOnce(ref);          // false until the element first enters the viewport, then true
 *   <div ref={ref} data-drawn={shown} />       // CSS draws lines / decodes text on data-drawn="true"
 *
 * Reduced motion (or no IntersectionObserver): true immediately, so the static final state shows.
 *
 *   const stop = observeSeen(el, () => reveal(), { threshold: 0.12 });   // once, when enough of it is on screen
 */
import { useEffect, useState, type RefObject } from "react";

import { prefersReducedMotion } from "./text";

export interface InViewOptions {
  /** IntersectionObserver rootMargin (default: trigger a little before the element is fully on screen). */
  rootMargin?: string;
  /** Visible fraction that counts as "in view" (default 0.15). */
  threshold?: number;
}

export function useInViewOnce(ref: RefObject<Element | null>, { rootMargin = "0px 0px -8% 0px", threshold = 0.15 }: InViewOptions = {}): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (shown || !el) return;
    if (prefersReducedMotion() || typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }
    return observeSeen(el, () => setShown(true), { rootMargin, threshold });
  }, [ref, shown, rootMargin, threshold]);
  return shown;
}

/** Fine steps, so an element taller than the window still reports how much of it is on screen as it scrolls in. */
const SEEN_STEPS = [0, 0.01, 0.02, 0.04, 0.08, 0.12, 0.2, 0.35, 0.5, 0.75, 1];

/**
 * Calls `onSeen` once, when enough of `el` is on screen: `threshold` of the element, or that share of the window (an
 * element several windows tall can never show 12% of itself), or all of it. Before the page prints, it fires at once,
 * so nothing waiting for a scroll prints blank. No IntersectionObserver: at once. Returns a cancel function.
 */
export function observeSeen(el: Element, onSeen: () => void, { rootMargin = "0px", threshold = 0.12 }: InViewOptions = {}): () => void {
  if (typeof IntersectionObserver === "undefined") {
    onSeen();
    return () => undefined;
  }
  let done = false;
  const stop = (): void => {
    done = true;
    io.disconnect();
    if (typeof window !== "undefined") window.removeEventListener("beforeprint", fire);
  };
  function fire(): void {
    if (done) return;
    stop();
    onSeen();
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const rootHeight = e.rootBounds?.height ?? (typeof window !== "undefined" ? window.innerHeight : 0);
        if (e.intersectionRatio >= threshold - 0.001 || e.intersectionRatio >= 0.999 || (rootHeight > 0 && e.intersectionRect.height >= rootHeight * threshold)) {
          fire();
          return;
        }
      }
    },
    { rootMargin, threshold: [...new Set([...SEEN_STEPS, Math.min(1, Math.max(0, threshold))])].sort((a, b) => a - b) },
  );
  io.observe(el);
  if (typeof window !== "undefined") window.addEventListener("beforeprint", fire);
  return stop;
}

/** Live visibility (true while on screen): pause loops / canvases when false. */
export function useInView(ref: RefObject<Element | null>, rootMargin = "120px 0px"): boolean {
  const [inView, setInView] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last) setInView(last.isIntersecting);
    }, { rootMargin });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, rootMargin]);
  return inView;
}

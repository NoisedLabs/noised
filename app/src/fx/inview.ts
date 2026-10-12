/**
 * Scroll-entrance helpers (UI v3 "everything enters with choreography").
 *
 *   const ref = useRef<HTMLDivElement>(null);
 *   const shown = useInViewOnce(ref);          // false until the element first enters the viewport, then true
 *   <div ref={ref} data-drawn={shown} />       // CSS draws lines / decodes text on data-drawn="true"
 *
 * Reduced motion (or no IntersectionObserver): true immediately, so the static final state shows.
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
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin, threshold },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, shown, rootMargin, threshold]);
  return shown;
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

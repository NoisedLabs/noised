/**
 * Motion presets (TERMINAL_V2). Components animate with `m.*` from
 * "motion/react" inside <MotionRoot> (src/fx/MotionRoot.tsx, mounted in
 * main.tsx), which loads the full feature set once (layout, layoutId,
 * gestures, whileInView) and honours prefers-reduced-motion.
 *
 * CSP rules for motion (style-src 'self'): never `AnimatePresence
 * mode="popLayout"`, never "motion/react-animate-view" / animateView(); both
 * inject <style> elements the policy blocks. Everything here animates
 * through element.style (CSSOM) or SVG attributes, which the CSP allows.
 */
import type { Transition, Variants } from "motion/react";
import { useSyncExternalStore } from "react";

export const spring = {
  /** Nav caret, tabs, toggles. */
  snappy: { type: "spring", stiffness: 520, damping: 38 },
  /** Panels, sheets, layout shifts. */
  smooth: { type: "spring", stiffness: 260, damping: 30 },
  /** Number tickers, large surfaces. */
  gentle: { type: "spring", stiffness: 120, damping: 20 },
} as const satisfies Record<string, Transition>;

export const ease = {
  out: [0.22, 1, 0.36, 1],
  snap: [0.2, 0.9, 0.1, 1],
  inOut: [0.65, 0, 0.35, 1],
} as const satisfies Record<string, Transition["ease"]>;

export const dur = { fast: 0.15, base: 0.3, slow: 0.6 } as const;

/** Reveal on scroll: opacity 0 -> 1, y 6 -> 0 (terminal "decode in"). */
export const reveal: Variants = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: { duration: 0.45, ease: ease.out } },
};

/** Reduced-motion variant of `reveal`: opacity only. */
export const revealReduced: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: dur.base } },
};

/** Parent variant that staggers its children's `reveal` (default 0.06s apart). */
export function stagger(each = 0.06, delayChildren = 0): Variants {
  return { hidden: {}, show: { transition: { staggerChildren: each, delayChildren } } };
}

/** Props for a whileInView reveal: spread on an `m.*` element with `variants`. */
export const inView = {
  initial: "hidden",
  whileInView: "show",
  viewport: { once: true, margin: "-80px" },
} as const;

/** Page transition: a soft fade (opacity + 6px y). */
export const page: Variants = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: { duration: 0.32, ease: ease.out } },
};

/** Hover lift for panels: `whileHover={hoverLift}`. */
export const hoverLift = { y: -2, transition: spring.smooth } as const;

/** Press feedback for buttons: `whileTap={press}`. */
export const press = { scale: 0.98 } as const;

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReduced(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
  const mq = window.matchMedia(REDUCED_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function readReduced(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(REDUCED_QUERY).matches;
}

/** The OS "reduce motion" preference, live. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduced, readReduced, () => false);
}

// ------------------------------------------------------------------ boot ---
// v4 has no boot overlay: the page simply fades in. The boot API stays (hero intros wait on useBootDone), and
// prepareBoot() marks the boot finished before the first paint, so nothing ever waits.

const BOOT_KEY = "noised.booted";
const BOOT_EVENT = "phx:boot-done";

/** Sets html[data-boot] = "done" before the first paint (there is no boot overlay any more). Returns false. */
export function prepareBoot(): boolean {
  if (typeof document === "undefined") return false;
  document.documentElement.dataset.boot = "done";
  return false;
}

/** True once the boot overlay has finished (or never ran). */
export function isBootDone(): boolean {
  return typeof document === "undefined" || document.documentElement.dataset.boot !== "running";
}

/** Mark the boot finished: html[data-boot="done"], session flag, and the "phx:boot-done" window event. */
export function finishBoot(): void {
  if (typeof document === "undefined") return;
  try {
    globalThis.sessionStorage?.setItem(BOOT_KEY, "1");
  } catch {
    // Storage blocked: the boot may run again next load; harmless.
  }
  if (document.documentElement.dataset.boot === "done") return;
  document.documentElement.dataset.boot = "done";
  window.dispatchEvent(new Event(BOOT_EVENT));
}

/** Re-renders when the boot overlay finishes. Hero intros should wait for this. */
export function useBootDone(): boolean {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener(BOOT_EVENT, cb);
      return () => window.removeEventListener(BOOT_EVENT, cb);
    },
    isBootDone,
    () => true,
  );
}

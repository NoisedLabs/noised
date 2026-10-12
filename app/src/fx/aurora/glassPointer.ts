/**
 * Pointer-following specular highlight for glass surfaces (GLASS_V5 section 1).
 *
 *   installGlassPointer();   // once (Layout); returns an uninstall function
 *
 * One delegated, rAF-throttled pointermove listener: the glass surface under the pointer (and the glass surface
 * that contains it) gets --mx / --my, the pointer position in px relative to its own box. The CSS draws the
 * highlight (styles.css: .glass::before and friends). Mouse and pen only: touch has no hover.
 * CSSOM writes (element.style.setProperty) are allowed by the CSP (style-src 'self').
 */

/** Surfaces that catch the light. Add data-glass to any element to opt in. */
export const GLASS_SELECTOR = [
  "[data-glass]",
  ".glass",
  ".glass-strong",
  ".glass-pill",
  ".glass-card",
  ".card",
  ".btn",
  ".phx-nav",
  ".phx-mode",
  ".hx-find",
].join(",");

function setPos(el: HTMLElement, x: number, y: number): void {
  const r = el.getBoundingClientRect();
  el.style.setProperty("--mx", `${Math.round(x - r.left)}px`);
  el.style.setProperty("--my", `${Math.round(y - r.top)}px`);
}

export function installGlassPointer(): () => void {
  if (typeof window === "undefined") return () => undefined;
  let raf = 0;
  let x = 0;
  let y = 0;
  let target: Element | null = null;

  const apply = (): void => {
    raf = 0;
    const inner = target?.closest(GLASS_SELECTOR);
    if (!(inner instanceof HTMLElement)) return;
    setPos(inner, x, y);
    const outer = inner.parentElement?.closest(GLASS_SELECTOR);
    if (outer instanceof HTMLElement) setPos(outer, x, y);
  };

  const onMove = (e: PointerEvent): void => {
    if (e.pointerType === "touch") return;
    x = e.clientX;
    y = e.clientY;
    target = e.target instanceof Element ? e.target : null;
    if (!raf) raf = requestAnimationFrame(apply);
  };

  window.addEventListener("pointermove", onMove, { passive: true });
  return () => {
    window.removeEventListener("pointermove", onMove);
    if (raf) cancelAnimationFrame(raf);
  };
}

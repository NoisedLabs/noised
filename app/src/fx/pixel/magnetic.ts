/**
 * Magnetic buttons (PIXEL_V6 section 3): every .btn (and any [data-magnetic] element) leans a few pixels toward
 * the pointer while it is hovered, then settles back. One delegated listener for the whole app (Layout installs
 * it); it only writes two custom properties (--mag-x / --mag-y, read by .btn's `translate`) through the CSSOM, so
 * it is CSP-safe. Mouse / pen only; off under reduced motion or when ambient motion is paused.
 *
 *   useEffect(() => installMagnetic(), []);   // returns the uninstall function
 */
import { motionStill as motionStillNow } from "../noise/env";

const SELECTOR = ".btn:not(:disabled):not([aria-disabled='true']), [data-magnetic]";
/** Max pull in px (x, y). */
const PULL_X = 4;
const PULL_Y = 3;

export function installMagnetic(): () => void {
  if (typeof document === "undefined") return () => undefined;
  let current: HTMLElement | null = null;
  let raf = 0;
  let pending: { el: HTMLElement; x: number; y: number } | null = null;

  const release = (el: HTMLElement | null): void => {
    if (!el) return;
    el.style.removeProperty("--mag-x");
    el.style.removeProperty("--mag-y");
  };
  const flush = (): void => {
    raf = 0;
    if (!pending) return;
    const { el, x, y } = pending;
    pending = null;
    el.style.setProperty("--mag-x", `${x.toFixed(2)}px`);
    el.style.setProperty("--mag-y", `${y.toFixed(2)}px`);
  };
  const onMove = (e: PointerEvent): void => {
    if (e.pointerType === "touch") return;
    const target = e.target instanceof Element ? (e.target.closest(SELECTOR) as HTMLElement | null) : null;
    if (target !== current) {
      release(current);
      current = target;
      pending = null;
    }
    if (!target || motionStillNow()) return;
    const r = target.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const nx = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / (r.width / 2)));
    const ny = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / (r.height / 2)));
    // Snap to half pixels: the pull steps like a pixel sprite instead of gliding.
    pending = { el: target, x: Math.round(nx * PULL_X * 2) / 2, y: Math.round(ny * PULL_Y * 2) / 2 };
    if (!raf) raf = requestAnimationFrame(flush);
  };
  const onLeave = (): void => {
    release(current);
    current = null;
    pending = null;
  };
  document.addEventListener("pointermove", onMove, { passive: true });
  document.addEventListener("pointerleave", onLeave);
  window.addEventListener("blur", onLeave);
  return () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerleave", onLeave);
    window.removeEventListener("blur", onLeave);
    if (raf) cancelAnimationFrame(raf);
    release(current);
  };
}

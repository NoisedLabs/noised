/**
 * noiseWipe: a theme switch that dissolves into noise. A full-screen sheet of the OLD background shrinks away
 * through soft round holes that grow until nothing is left (the resolve mask, run backwards), so the new theme
 * comes through as static settling into place.
 *
 *   noiseWipe({ color: getComputedStyle(document.documentElement).getPropertyValue("--bg") });
 *   setTheme("light");
 *
 * CSP-safe: one fixed <div> styled through the CSSOM, removed when done; pointer events pass through. Does nothing
 * under reduced motion or with ambient motion paused.
 */
import { motionStill } from "./env";
import { resolveMask } from "./reveal";
import { noiseScheduler } from "./scheduler";
import "./noise.css";

export interface NoiseWipeOptions {
  /** The colour that dissolves away (usually the old --bg). */
  color: string;
  /** Milliseconds (default 520). */
  duration?: number;
}

export function noiseWipe({ color, duration = 520 }: NoiseWipeOptions): void {
  if (typeof document === "undefined" || motionStill()) return;
  const el = document.createElement("div");
  el.className = "nz-wipe";
  el.setAttribute("aria-hidden", "true");
  el.style.background = color;
  // The sheet keeps only what lies outside the growing dots of every lattice (inverted layers, intersected: the
  // composite mode is in the static stylesheet, .nz-wipe).
  const paint = (p: number): void => {
    const m = resolveMask(p, "none", true);
    const { image, size, position } = m;
    const s = el.style;
    s.setProperty("mask-image", image);
    s.setProperty("-webkit-mask-image", image);
    s.setProperty("mask-size", size);
    s.setProperty("-webkit-mask-size", size);
    s.setProperty("mask-position", position);
    s.setProperty("-webkit-mask-position", position);
    s.setProperty("opacity", (1 - p * 0.6).toFixed(3));
  };
  paint(0);
  document.body.append(el);
  let elapsed = 0;
  const total = Math.max(0.05, duration / 1000);
  const stop = noiseScheduler().add({
    frame(dt) {
      elapsed += dt;
      const p = elapsed / total;
      if (p >= 1) {
        stop();
        el.remove();
        return;
      }
      paint(1 - (1 - p) ** 2);
    },
  });
}

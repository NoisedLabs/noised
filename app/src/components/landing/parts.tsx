/**
 * Landing atoms still shared outside the home page: the decorative dot-matrix
 * canvas (the 404 page's "404"). CSP-safe: drawn on a canvas, no injected
 * <style>; the canvas fills its positioned parent (.ld-art, tokens.css).
 */
import type { ReactNode, RefObject } from "react";

import { useDotMatrix, type Scene } from "./dotmatrix";

import "./tokens.css";

/** A decorative dot-matrix canvas filling its positioned parent. */
export function DotArt<S>({ scene, className = "", host }: { scene: Scene<S>; className?: string; host?: RefObject<HTMLElement | null> }): ReactNode {
  const ref = useDotMatrix(scene, host);
  return <canvas ref={ref} className={`ld-art ${className}`} aria-hidden="true" />;
}

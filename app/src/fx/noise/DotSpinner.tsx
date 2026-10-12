/**
 * <DotSpinner>: the loading mark, a small ring of round dots with a soft light running around it over a 1px hairline
 * ring. Pure CSS (static stylesheet, compositor-only opacity keyframes): no canvas, no frame loop.
 *
 *   <DotSpinner />                          // 32px, announces "Loading" politely
 *   <DotSpinner size={48} label="Loading page" />
 *   <DotSpinner size={16} decorative />     // inside a busy button (the button carries the label)
 *
 * Reduced motion (or the motion switch off): a still ring, brighter at the top.
 */
import type { CSSProperties, ReactNode } from "react";

import "./noise.css";

export interface DotSpinnerProps {
  /** CSS px (default 32). */
  size?: number;
  /** Screen-reader text (default "Loading"). */
  label?: string;
  /** No status role / label (the parent announces the busy state). */
  decorative?: boolean;
  className?: string;
}

export function DotSpinner({ size = 32, label = "Loading", decorative = false, className = "" }: DotSpinnerProps): ReactNode {
  // Small rings get fewer, relatively larger dots so each one stays round.
  const count = size < 24 ? 8 : 12;
  const style = { "--nz-spin": `${size}px` } as CSSProperties;
  return (
    <span className={`nz-spin ${className}`} data-n={count} style={style} {...(decorative ? { "aria-hidden": true } : { role: "status" })}>
      <span className="nz-spin-ring" aria-hidden="true">
        {Array.from({ length: count }, (_, i) => (
          <i key={i} />
        ))}
      </span>
      {decorative ? null : <span className="sr-only">{label}</span>}
    </span>
  );
}

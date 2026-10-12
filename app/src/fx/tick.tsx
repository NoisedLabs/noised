/**
 * Numbers that tick (UI v3 section 5: "numbers tick and scramble on change").
 *
 *   <TickNumber value={61.4} format={(n) => n.toFixed(1)} />
 *   <TickNumber value={7} format={(n) => String(Math.round(n)).padStart(2, "0")} className="t-dot" />
 *
 * When `value` changes, the number counts from the previous value to the new one (ease-out) while the digits
 * that have not landed yet flicker; screen readers only ever get the final value (sr-only text, the animated
 * copy is aria-hidden). The first render shows the value as is (pass `from` to count up on mount).
 * Reduced motion: the new value appears at once.
 * v6: Geist Pixel's figures are proportional (no tnum), so the animated copy sets every digit in a fixed-width cell
 * (.tick-d, width --tick-w, default 0.69em = the widest Geist Pixel digit): the number never jitters while it ticks.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

import { prefersReducedMotion } from "./text";

export interface TickNumberProps {
  value: number;
  /** Number -> text (called with intermediate values too). Default: String(Math.round(n)). */
  format?: (n: number) => string;
  /** Count up from this value on mount (default: no mount animation). */
  from?: number;
  durationMs?: number;
  /** Flicker the digits that have not landed yet (default true). */
  scramble?: boolean;
  className?: string;
}

const DIGITS = "0123456789";

function flicker(current: string, target: string, progress: number): string {
  if (current.length !== target.length) return current;
  let out = "";
  for (let i = 0; i < current.length; i++) {
    const c = current[i] ?? "";
    const t = target[i] ?? "";
    out += c !== t && DIGITS.includes(c) && Math.random() > progress ? (DIGITS[Math.floor(Math.random() * 10)] ?? c) : c;
  }
  return out;
}

export function TickNumber({ value, format, from, durationMs = 700, scramble = true, className = "" }: TickNumberProps): ReactNode {
  const fmt = useRef(format ?? ((n: number) => String(Math.round(n))));
  fmt.current = format ?? ((n: number) => String(Math.round(n)));
  const start = from !== undefined && Number.isFinite(from) && !prefersReducedMotion() ? from : value;
  const [shown, setShown] = useState(() => fmt.current(start));
  const prev = useRef(start);

  useEffect(() => {
    const a = prev.current;
    prev.current = value;
    const target = fmt.current(value);
    if (a === value || !Number.isFinite(a) || !Number.isFinite(value) || prefersReducedMotion()) {
      setShown(target);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number): void => {
      const p = Math.min(1, (t - t0) / durationMs);
      const e = 1 - (1 - p) ** 3;
      const text = fmt.current(a + (value - a) * e);
      setShown(p >= 1 ? target : scramble ? flicker(text, target, p) : text);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, durationMs, scramble]);

  return (
    <span className={`tick-num ${className}`}>
      <span className="sr-only">{fmt.current(value)}</span>
      <span aria-hidden="true">
        {[...shown].map((ch, i) =>
          ch >= "0" && ch <= "9" ? (
            <span key={i} className="tick-d">
              {ch}
            </span>
          ) : (
            ch
          ),
        )}
      </span>
    </span>
  );
}

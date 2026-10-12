/**
 * Shared chart plumbing: container measurement (charts render at their real pixel width so text stays 11-12 px at
 * any size), the one-time "draw in" when a chart first scrolls into view, ink and dash styles, the legend and the
 * HTML tooltip. Monochrome by design (white / silver on graphite, graphite on paper); status colours only where a
 * value means good / bad.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

/** Grey level of a mark: 1 = full ink (the series the story is about), 2 = secondary, 3 = quiet, 4 = faint. */
export type Ink = 1 | 2 | 3 | 4 | "ok" | "warn" | "danger";
export type Dash = "solid" | "dash" | "dot" | "dashdot";

export const DASH: Record<Dash, string | undefined> = {
  solid: undefined,
  dash: "7 5",
  dot: "0.5 5",
  dashdot: "8 4 0.5 4",
};

export function inkClass(ink: Ink): string {
  return `c-ink-${ink}`;
}

/** Width of an element, kept current with a ResizeObserver (fallback until the first measurement). */
export function useWidth<T extends Element>(fallback = 680): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => {
      const next = Math.round(el.getBoundingClientRect().width);
      if (next > 0) setW((prev) => (Math.abs(prev - next) >= 1 ? next : prev));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function reducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * "pending" until the element first comes into view, then "drawn" (CSS runs the one-time reveal on that change).
 * Reduced motion, printing or no IntersectionObserver: "static" at once (final state, no animation).
 */
export function useDrawState(ref: RefObject<Element | null>, { threshold = 0.12, rootMargin = "0px 0px -6% 0px" }: { threshold?: number; rootMargin?: string } = {}): "pending" | "drawn" | "static" {
  const [state, setState] = useState<"pending" | "drawn" | "static">("pending");
  useEffect(() => {
    const el = ref.current;
    if (!el || state !== "pending") return;
    if (reducedMotion() || typeof IntersectionObserver === "undefined") {
      setState("static");
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setState("drawn");
          io.disconnect();
        }
      },
      { rootMargin, threshold },
    );
    io.observe(el);
    const onPrint = (): void => setState("static");
    window.addEventListener("beforeprint", onPrint);
    return () => {
      io.disconnect();
      window.removeEventListener("beforeprint", onPrint);
    };
  }, [ref, state, threshold, rootMargin]);
  return state;
}

/** A short line key for legends and tooltips. */
export function LineKey({ ink, dash = "solid", band = false }: { ink: Ink; dash?: Dash | undefined; band?: boolean | undefined }): ReactNode {
  return (
    <svg className="c-key" width="22" height="10" viewBox="0 0 22 10" aria-hidden="true" focusable="false">
      {band ? <rect x="1" y="1" width="20" height="8" className={`${inkClass(ink)} c-band-fill`} /> : null}
      <line x1="1" y1="5" x2="21" y2="5" className={`${inkClass(ink)} c-stroke`} strokeDasharray={DASH[dash]} strokeLinecap="round" />
    </svg>
  );
}

/** A small filled square key (bars). */
export function SwatchKey({ ink, hatch = false }: { ink: Ink; hatch?: boolean | undefined }): ReactNode {
  return (
    <svg className="c-key" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <rect x="0.5" y="0.5" width="11" height="11" className={`${inkClass(ink)} ${hatch ? "c-fill-hatch" : "c-fill"}`} />
      {hatch ? <path d="M-1 4 L4 -1 M-1 9 L9 -1 M3 13 L13 3 M8 13 L13 8" className={`${inkClass(ink)} c-hatch-lines`} /> : null}
    </svg>
  );
}

export interface LegendItem {
  key: string;
  label: ReactNode;
  ink: Ink;
  dash?: Dash | undefined;
  kind?: "line" | "swatch" | "band" | "hatch" | undefined;
}

export function Legend({ items }: { items: readonly LegendItem[] }): ReactNode {
  if (items.length < 2) return null;
  return (
    <ul className="c-legend">
      {items.map((it) => (
        <li key={it.key}>
          {it.kind === "swatch" || it.kind === "hatch" ? <SwatchKey ink={it.ink} hatch={it.kind === "hatch"} /> : <LineKey ink={it.ink} dash={it.dash} band={it.kind === "band"} />}
          <span>{it.label}</span>
        </li>
      ))}
    </ul>
  );
}

export interface TipRow {
  key: string;
  label: ReactNode;
  value: ReactNode;
  ink?: Ink | undefined;
  dash?: Dash | undefined;
  kind?: "line" | "swatch" | undefined;
}

/** HTML tooltip positioned inside the chart container (flips to stay inside it). */
export function Tooltip({ x, y, width, title, rows }: { x: number; y: number; width: number; title: ReactNode; rows: readonly TipRow[] }): ReactNode {
  const left = x > width * 0.58;
  return (
    <div className="c-tip" data-side={left ? "left" : "right"} style={{ left: `${Math.round(x)}px`, top: `${Math.round(y)}px` }} role="presentation">
      <div className="c-tip-title">{title}</div>
      {rows.map((r) => (
        <div key={r.key} className="c-tip-row">
          {r.ink !== undefined ? r.kind === "swatch" ? <SwatchKey ink={r.ink} /> : <LineKey ink={r.ink} dash={r.dash} /> : null}
          <span className="c-tip-label">{r.label}</span>
          <span className="c-tip-value">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

/** Rough text width for layout before render (px). */
export function textWidth(s: string, px = 11.5): number {
  return s.length * px * 0.58;
}

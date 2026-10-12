/**
 * Diagram primitives (architecture, sequence, state and tree figures): a fixed coordinate system scaled to the
 * container, never below `minWidth` (narrow screens scroll the figure sideways, never the page). Boxes, arrows and
 * labels take their ink from the theme tokens, so the same diagram reads on graphite and on paper.
 */
import { createContext, useContext, useId, type ReactNode } from "react";

import { DASH, inkClass, useDrawState, useWidth, type Dash, type Ink } from "./frame";

const MarkerCtx = createContext<{ arrow: string; arrowSoft: string; dot: string }>({ arrow: "", arrowSoft: "", dot: "" });

export function Diagram({
  w,
  h,
  minWidth = 560,
  label,
  children,
  className = "",
}: {
  /** Coordinate width and height. */
  w: number;
  h: number;
  /** Below this container width the figure scrolls horizontally. */
  minWidth?: number | undefined;
  label: string;
  children: ReactNode;
  className?: string | undefined;
}): ReactNode {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [ref, width] = useWidth<HTMLDivElement>();
  const draw = useDrawState(ref);
  const ids = { arrow: `d-arrow-${uid}`, arrowSoft: `d-arrow-s-${uid}`, dot: `d-dot-${uid}` };
  const scroll = width < minWidth;
  const renderW = scroll ? minWidth : width;
  return (
    <div className={`d-wrap ${className}`} ref={ref} data-scroll={scroll ? "true" : "false"}>
      <div className="d-scroll" tabIndex={scroll ? 0 : undefined} role={scroll ? "region" : undefined} aria-label={scroll ? `${label} (scrolls sideways)` : undefined}>
        <svg
          viewBox={`0 0 ${w} ${h}`}
          width={renderW}
          height={(renderW * h) / w}
          className="d-svg"
          role="img"
          aria-label={label}
          data-draw={draw}
          focusable="false"
        >
          <defs>
            <marker id={ids.arrow} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0.8 L9.2 5 L0 9.2 Z" className="d-arrowhead" />
            </marker>
            <marker id={ids.arrowSoft} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0.8 L9.2 5 L0 9.2 Z" className="d-arrowhead-soft" />
            </marker>
            <marker id={ids.dot} viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5">
              <circle cx="5" cy="5" r="4" className="d-arrowhead" />
            </marker>
          </defs>
          <MarkerCtx.Provider value={ids}>{children}</MarkerCtx.Provider>
        </svg>
      </div>
    </div>
  );
}

export type NodeKind = "box" | "strong" | "ext" | "pda" | "ghost" | "note";

/** A rectangle with two-step "pixel" corners (step c), as an SVG path. */
export function steppedRect(x: number, y: number, w: number, h: number, c = 3): string {
  const s = Math.max(0, Math.min(c, w / 4, h / 4));
  const d = 2 * s;
  return `M${x + d} ${y}H${x + w - d}V${y + s}H${x + w - s}V${y + d}H${x + w}V${y + h - d}H${x + w - s}V${y + h - s}H${x + w - d}V${y + h}H${x + d}V${y + h - s}H${x + s}V${y + h - d}H${x}V${y + d}H${x + s}V${y + s}H${x + d}Z`;
}

/** A box with a title and up to three lines of small text, centred. */
export function DNode({
  x,
  y,
  w,
  h,
  title,
  lines = [],
  kind = "box",
  r = 10,
  align = "middle",
  step,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  lines?: readonly string[] | undefined;
  kind?: NodeKind | undefined;
  r?: number | undefined;
  align?: "start" | "middle" | undefined;
  /** Reveal order (CSS stagger). */
  step?: number | undefined;
}): ReactNode {
  const total = 1 + lines.length;
  const lineH = 15;
  const startY = y + h / 2 - ((total - 1) * lineH) / 2;
  const tx = align === "middle" ? x + w / 2 : x + 12;
  return (
    <g className="d-node" data-kind={kind} style={step !== undefined ? { ["--d-step" as string]: String(step) } : undefined}>
      <path d={steppedRect(x, y, w, h, r > 12 ? 4 : 3)} className="d-box" />
      <text x={tx} y={startY} dy="0.35em" textAnchor={align} className="d-title">
        {title}
      </text>
      {lines.map((l, i) => (
        <text key={i} x={tx} y={startY + (i + 1) * lineH} dy="0.35em" textAnchor={align} className="d-line">
          {l}
        </text>
      ))}
    </g>
  );
}

/** An arrow along a polyline or a custom path. */
export function DEdge({
  points,
  d,
  label,
  labelAt,
  dash = "solid",
  ink = 2,
  head = "end",
  soft = false,
  step,
}: {
  points?: readonly (readonly [number, number])[] | undefined;
  d?: string | undefined;
  label?: string | undefined;
  /** Label position (default: midpoint of the first segment, nudged above). */
  labelAt?: readonly [number, number, ("start" | "middle" | "end")?] | undefined;
  dash?: Dash | undefined;
  ink?: Ink | undefined;
  head?: "end" | "both" | "none" | "dot" | undefined;
  soft?: boolean | undefined;
  step?: number | undefined;
}): ReactNode {
  const ids = useContext(MarkerCtx);
  const path = d ?? (points ?? []).map((p, i) => `${i === 0 ? "M" : "L"}${p[0]} ${p[1]}`).join("");
  const a = points?.[0];
  const b = points?.[1];
  const auto: readonly [number, number, "start" | "middle" | "end"] | undefined = a && b ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 7, "middle"] : undefined;
  const at = labelAt ?? auto;
  const marker = head === "none" ? undefined : head === "dot" ? `url(#${ids.dot})` : `url(#${soft ? ids.arrowSoft : ids.arrow})`;
  return (
    <g className="d-edge" style={step !== undefined ? { ["--d-step" as string]: String(step) } : undefined}>
      <path
        d={path}
        className={`${inkClass(ink)} d-path`}
        strokeDasharray={DASH[dash]}
        markerEnd={marker}
        markerStart={head === "both" ? marker : undefined}
      />
      {label && at ? (
        <text x={at[0]} y={at[1]} textAnchor={at[2] ?? "middle"} className="d-edge-label">
          {label}
        </text>
      ) : null}
    </g>
  );
}

/** Free text in diagram coordinates. */
export function DText({
  x,
  y,
  children,
  anchor = "start",
  kind = "label",
}: {
  x: number;
  y: number;
  children: ReactNode;
  anchor?: "start" | "middle" | "end" | undefined;
  kind?: "label" | "small" | "title" | "mono" | "faint" | undefined;
}): ReactNode {
  return (
    <text x={x} y={y} textAnchor={anchor} className={`d-text d-text-${kind}`}>
      {children}
    </text>
  );
}

/** A dashed group outline with a caption (trust boundary, program, ...). */
export function DGroup({ x, y, w, h, label, r = 14 }: { x: number; y: number; w: number; h: number; label: string; r?: number | undefined }): ReactNode {
  return (
    <g className="d-group">
      <path d={steppedRect(x, y, w, h, Math.min(4, r))} className="d-group-box" />
      <text x={x + 14} y={y + 17} className="d-group-label">
        {label}
      </text>
    </g>
  );
}

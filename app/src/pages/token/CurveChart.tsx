/**
 * The bonding curve (v6 pixel): the curve drawn as a skyline of pixel
 * columns, each a stack of square blocks as tall as the curve at that
 * point. Columns already paid for are solid ink, what the batch will spend
 * is dithered, the rest is faint; the position is a lit block on top of its
 * column. The columns grow in, block by block, the first time the chart
 * scrolls into view. Hovering with a mouse marks a column and shows a small
 * glass readout of the x axis.
 *
 * Honest by construction: the curve's SHAPE is that of a constant-liquidity
 * curve (decorative); only the x axis (SOL raised, 0 to the graduation
 * threshold) and the position on it are real, so the readout reads x only.
 * Presentation only; styles in ./token.css (.tk-cv*).
 */
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode, type RefObject } from "react";

import { formatSol } from "../../lib/amounts";
import { revealAttr, useReveal, type KitTone } from "../inner/kit";

function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(720);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w !== undefined && w > 0) setWidth(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

const CURVE_K = 2.4;
const curveAt = (x: number): number => ((1 + CURVE_K * x) ** 2 - 1) / ((1 + CURVE_K) ** 2 - 1);

export function CurveChart({
  progress,
  pending,
  tone,
  caption,
  threshold,
}: {
  /** SOL raised as a fraction of the graduation threshold (0..1). */
  progress: number;
  /** What the pending batch will spend, as a fraction of the threshold. */
  pending: number;
  tone: KitTone;
  caption: string;
  /** The graduation threshold in lamports (labels the x axis). */
  threshold: bigint;
}): ReactNode {
  const [plotRef, width] = useWidth<HTMLDivElement>();
  const [figRef, on] = useReveal<HTMLElement>();
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [hover, setHover] = useState<number | null>(null);
  const W = Math.max(240, width);
  const small = W < 520;
  // One block = `cell` px plus a 2 px gap, both ways: the chart is a grid of square pixels.
  const cell = small ? 6 : 8;
  const gap = 2;
  const step = cell + gap;
  const rows = small ? 18 : 24;
  const H = rows * step + 4;
  const bottom = H;
  const cols = Math.max(12, Math.floor((W + gap) / step));
  const colW = (W + gap) / cols;
  const p = Math.max(0, Math.min(1, progress));
  const q = Math.max(p, Math.min(1, progress + pending));
  const current = Math.min(cols - 1, Math.floor(p * cols));
  const columns = useMemo(
    () =>
      Array.from({ length: cols }, (_, i) => {
        const x1 = (i + 1) / cols;
        const n = Math.max(1, Math.round(curveAt(x1) * rows));
        return { i, x: i * colW, n, mid: (i + 0.5) / cols };
      }),
    [cols, colW, rows],
  );
  const raised = (x: number): string => formatSol(BigInt(Math.round(x * Number(threshold))), 2);
  const pct = (v: number): string => `${(Math.max(0, Math.min(1, v)) * 100).toFixed(2)}%`;
  const topOf = (n: number): number => bottom - n * step + gap;
  const hoverCol = hover === null ? null : Math.min(cols - 1, Math.floor(hover * cols));
  const track = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.pointerType !== "mouse" && e.pointerType !== "pen") return;
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width <= 0) return;
    setHover(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
  };
  const head = columns[current];
  const headX = head ? head.x + (colW - gap) / 2 : 0;
  const headY = head ? topOf(head.n) : bottom;
  return (
    <figure ref={figRef} className="tk-cv" data-tone={tone} data-reveal={revealAttr(on)}>
      <div className="tk-cv-plot" ref={plotRef} onPointerMove={track} onPointerLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="tk-cv-svg" role="img" aria-label={caption} shapeRendering="crispEdges">
          <defs>
            {/* Rows of blocks: a white stripe per block, the gap left out. */}
            <pattern id={`${uid}-rows`} width={W} height={step} patternUnits="userSpaceOnUse" y={bottom % step}>
              <rect x={0} y={gap} width={W} height={cell} fill="#fff" />
            </pattern>
            <mask id={`${uid}-m`} maskUnits="userSpaceOnUse" x={0} y={0} width={W} height={H}>
              <rect x={0} y={0} width={W} height={H} fill={`url(#${uid}-rows)`} />
            </mask>
            {/* The batch: a 2x2 checker dither. */}
            <pattern id={`${uid}-d`} width={4} height={4} patternUnits="userSpaceOnUse">
              <rect x={0} y={0} width={2} height={2} className="tk-cv-dot" />
              <rect x={2} y={2} width={2} height={2} className="tk-cv-dot" />
            </pattern>
          </defs>
          <g mask={`url(#${uid}-m)`}>
            {columns.map((c) => {
              const kind = c.mid <= p ? "raised" : c.mid <= q ? "pend" : "rest";
              return (
                <rect
                  key={c.i}
                  x={c.x}
                  y={topOf(c.n)}
                  width={colW - gap}
                  height={c.n * step - gap}
                  className={`tk-cv-col tk-cv-${kind}`}
                  data-hover={hoverCol === c.i ? "" : undefined}
                  fill={kind === "pend" ? `url(#${uid}-d)` : undefined}
                  style={{ "--i": c.i } as CSSProperties}
                />
              );
            })}
          </g>
          {head ? (
            <g className="tk-cv-pos">
              <rect x={head.x - 2} y={headY - step - 2} width={colW - gap + 4} height={cell + 4} className="tk-cv-ring" />
              <rect x={head.x} y={headY - step} width={colW - gap} height={cell} className="tk-cv-head" />
            </g>
          ) : null}
        </svg>
        {q > p ? (
          <span className="tk-cv-batch" style={{ left: pct(p), width: pct(q - p) }} aria-hidden="true">
            <span>batch, one price</span>
          </span>
        ) : null}
        <span className="tk-cv-tag" style={{ left: `${headX}px`, top: `${headY - step}px` }} data-edge={p > 0.8 ? "right" : undefined} aria-hidden="true">
          now · {raised(p)}
        </span>
        {hover !== null && hoverCol !== null ? (
          <span
            className="tk-cv-read"
            style={{ left: `${(columns[hoverCol]?.x ?? 0) + (colW - gap) / 2}px`, top: `${topOf(columns[hoverCol]?.n ?? 1)}px` }}
            data-edge={hover > 0.72 ? "right" : undefined}
            aria-hidden="true"
          >
            {raised(hover)} raised · {pct(hover)} of the way
          </span>
        ) : null}
      </div>
      <div className="tk-cv-axis" aria-hidden="true">
        <span>0 SOL</span>
        <span>SOL raised →</span>
        <span>{raised(1)} · graduates</span>
      </div>
    </figure>
  );
}

/**
 * The 67 Winternitz chains of one LM-OTS signature as a pixel grid: one column per chain (64 message digits, then
 * the 3 checksum digits), one cell per chain position 0..15 from the secret x (bottom) to the public end z (top).
 * Filled cells are the steps the signer hashed, the bright cell is the value revealed in the signature, hollow
 * cells are the steps a verifier hashes to reach z. Hover or focus a column to read it.
 */
import { useState, type KeyboardEvent, type ReactNode } from "react";

import { useDrawState, useWidth } from "../../../components/charts";
import { CHAIN_END, P, U } from "../model/lmots";

export function ChainGrid({ digits, label, compact = false }: { digits: readonly number[]; label: string; compact?: boolean | undefined }): ReactNode {
  const [ref, width] = useWidth<HTMLDivElement>();
  const draw = useDrawState(ref, { threshold: 0, rootMargin: "0px" });
  const [hover, setHover] = useState<number | null>(null);
  const gapCols = 2; // blank columns between message and checksum digits
  const leftPad = compact ? 0 : 0;
  const pitch = Math.max(4, Math.floor((width - leftPad) / (P + gapCols)));
  const cell = pitch >= 8 ? pitch - 2 : pitch - 1;
  const rows = CHAIN_END + 1;
  const gridW = pitch * (P + gapCols);
  const h = rows * pitch;
  const colX = (i: number): number => leftPad + (i < U ? i : i + gapCols) * pitch;

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    let next = hover;
    if (e.key === "ArrowRight") next = Math.min(P - 1, (hover ?? -1) + 1);
    else if (e.key === "ArrowLeft") next = Math.max(0, (hover ?? P) - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = P - 1;
    else if (e.key === "Escape") next = null;
    else return;
    e.preventDefault();
    setHover(next);
  };

  const hd = hover !== null ? (digits[hover] ?? 0) : 0;
  return (
    <div className="wp-grid" ref={ref}>
      <div
        className="wp-grid-canvas"
        role="group"
        aria-roledescription="chart"
        aria-label={`${label}. Arrow keys read one chain at a time.`}
        tabIndex={0}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
      >
        <svg width={gridW} height={h} viewBox={`0 0 ${gridW} ${h}`} className="wp-grid-svg" data-draw={draw} shapeRendering="crispEdges" aria-hidden="true" focusable="false">
          {digits.slice(0, P).map((d, i) => {
            const x = colX(i);
            const cells: ReactNode[] = [];
            for (let r = 0; r < rows; r++) {
              const y = (rows - 1 - r) * pitch;
              const kind = r < d ? "s" : r === d ? "y" : "v";
              cells.push(<rect key={r} x={x} y={y} width={cell} height={cell} data-k={kind} />);
            }
            return (
              <g
                key={i}
                className="wp-grid-col"
                data-cs={i >= U ? "true" : "false"}
                data-on={hover === i ? "true" : "false"}
                style={{ ["--col" as string]: String(i) }}
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover(null)}
              >
                <rect x={x - 1} y={0} width={pitch} height={h} className="wp-grid-hit" />
                {cells}
              </g>
            );
          })}
        </svg>
        <div className="wp-grid-read" aria-live="polite">
          {hover !== null ? (
            <>
              <span className="wp-grid-read-k">{hover < U ? `message digit ${hover + 1} of 64` : `checksum digit ${hover - U + 1} of 3`}</span>
              <span>{`value ${hd} (0x${hd.toString(16)})`}</span>
              <span>{`signer hashed ${hd} step${hd === 1 ? "" : "s"}`}</span>
              <span>{`verifier hashes ${CHAIN_END - hd}`}</span>
            </>
          ) : (
            <>
              <span className="wp-grid-key" data-k="s">signer's steps</span>
              <span className="wp-grid-key" data-k="y">revealed value y</span>
              <span className="wp-grid-key" data-k="v">verifier's steps to the public end</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

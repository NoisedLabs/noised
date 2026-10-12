/**
 * Horizontal bar chart: one row per category, one or more bars per row (groups told apart by grey level, hatching,
 * the legend and the value at each bar's tip). A bar may be a range (lo to hi, e.g. measured minimum to maximum)
 * with an optional point inside it. Hover or focus a bar for its exact numbers.
 */
import { Fragment, useMemo, useState, type ReactNode } from "react";

import { inkClass, Legend, Tooltip, textWidth, useDrawState, useWidth, type Ink, type LegendItem, type TipRow } from "./frame";
import { fmt, fmtLogTick, linearScale, logScale } from "./scale";

export interface BarGroup {
  key: string;
  label: string;
  ink: Ink;
  hatch?: boolean | undefined;
}

export interface BarValue {
  group: string;
  /** Bar end (or the point inside a range). */
  value: number;
  /** Range start; the bar then spans lo..hi. */
  lo?: number | undefined;
  hi?: number | undefined;
  /** Text at the bar's tip (default: the formatted value). */
  label?: string | undefined;
  /** Extra tooltip line. */
  note?: string | undefined;
}

export interface BarRow {
  key: string;
  label: string;
  sub?: string | undefined;
  bars: readonly BarValue[];
}

export interface BarChartProps {
  rows: readonly BarRow[];
  groups: readonly BarGroup[];
  axis: { domain: readonly [number, number]; label: string; log?: number | undefined; ticks?: readonly number[] | undefined; format?: ((v: number) => string) | undefined };
  ariaLabel: string;
  /** Bar thickness (px). */
  thickness?: number | undefined;
  /** Vertical reference lines. */
  rules?: readonly { value: number; label: string }[] | undefined;
}

export function BarChart({ rows, groups, axis, ariaLabel, thickness = 12, rules = [] }: BarChartProps): ReactNode {
  const [ref, width] = useWidth<HTMLDivElement>();
  const draw = useDrawState(ref);
  const [hover, setHover] = useState<string | null>(null);
  const narrow = width < 560;

  const perRow = Math.max(1, ...rows.map((r) => r.bars.length));
  const gap = 3;
  const rowInner = perRow * thickness + (perRow - 1) * gap;
  const labelOnTop = narrow;
  const rowH = rowInner + (labelOnTop ? 34 : 18);
  const labelW = labelOnTop ? 0 : Math.min(width * 0.36, Math.max(...rows.map((r) => Math.max(textWidth(r.label, 12.5), textWidth(r.sub ?? "", 11)))) + 18);
  const left = labelOnTop ? 8 : labelW;
  const right = 64;
  const top = rules.length > 0 ? 24 : 8;
  const h = top + rows.length * rowH + 40;
  const fmtV = axis.format ?? ((v: number) => fmt(v, 2));

  const xs = useMemo(
    () => (axis.log ? logScale(axis.domain, [left, Math.max(left + 40, width - right)], axis.log) : linearScale(axis.domain, [left, Math.max(left + 40, width - right)])),
    [axis.domain, axis.log, left, width],
  );
  const ticks = (axis.ticks ?? xs.ticks(narrow ? 4 : 6)).filter((v) => v >= axis.domain[0] - 1e-12 && v <= axis.domain[1] + 1e-12);
  const tickText = (v: number): string => (axis.format ? axis.format(v) : axis.log ? fmtLogTick(v, axis.log) : fmt(v, 2));
  const base = xs(axis.domain[0]);
  const groupOf = (k: string): BarGroup | undefined => groups.find((g) => g.key === k);

  let tip: { x: number; y: number; title: string; rows: TipRow[] } | null = null;
  const legend: LegendItem[] = groups.map((g) => ({ key: g.key, label: g.label, ink: g.ink, kind: g.hatch ? "hatch" : "swatch" }));

  const body = rows.map((row, ri) => {
    const y0 = top + ri * rowH + (labelOnTop ? 26 : 9);
    return (
      <g key={row.key}>
        {labelOnTop ? (
          <text x={left} y={y0 - 9} className="c-row-label">
            {row.label}
            {row.sub ? <tspan className="c-row-sub">{`  ${row.sub}`}</tspan> : null}
          </text>
        ) : (
          <>
            <text x={labelW - 12} y={y0 + rowInner / 2 - (row.sub ? 5 : 0)} dy="0.34em" textAnchor="end" className="c-row-label">
              {row.label}
            </text>
            {row.sub ? (
              <text x={labelW - 12} y={y0 + rowInner / 2 + 9} dy="0.34em" textAnchor="end" className="c-row-sub">
                {row.sub}
              </text>
            ) : null}
          </>
        )}
        {row.bars.map((b, bi) => {
          const g = groupOf(b.group);
          const ink = g?.ink ?? 1;
          const yb = y0 + bi * (thickness + gap);
          const lo = b.lo ?? axis.domain[0];
          const hi = b.hi ?? b.value;
          const x0 = b.lo !== undefined ? xs(Math.max(lo, axis.domain[0])) : base;
          const x1 = xs(Math.min(Math.max(hi, axis.domain[0]), axis.domain[1]));
          const w = Math.max(b.lo !== undefined ? 3 : 0, x1 - x0);
          const id = `${row.key}:${b.group}`;
          if (b.value === 0 && b.lo === undefined) return null;
          const label = b.label ?? (b.lo !== undefined ? `${fmtV(lo)}–${fmtV(hi)}` : fmtV(b.value));
          if (hover === id) {
            tip = {
              x: x1,
              y: yb - 4,
              title: `${row.label}${row.sub ? ` (${row.sub})` : ""}`,
              rows: [
                { key: "v", label: g?.label ?? b.group, value: label, ink, kind: "swatch" },
                ...(b.note ? [{ key: "n", label: b.note, value: "" }] : []),
              ],
            };
          }
          // Pixel system: square bars; a one-step notch marks the data end (and both ends of a floating range).
          const n = Math.min(2, w / 3);
          const d =
            b.lo !== undefined
              ? `M${x0 + n} ${yb}H${x0 + w - n}V${yb + n}H${x0 + w}V${yb + thickness - n}H${x0 + w - n}V${yb + thickness}H${x0 + n}V${yb + thickness - n}H${x0}V${yb + n}H${x0 + n}Z`
              : `M${x0} ${yb}H${x0 + w - n}V${yb + n}H${x0 + w}V${yb + thickness - n}H${x0 + w - n}V${yb + thickness}H${x0}Z`;
          return (
            <g
              key={id}
              className="c-bar-g"
              tabIndex={0}
              role="img"
              aria-label={`${row.label}${row.sub ? ` (${row.sub})` : ""}, ${g?.label ?? b.group}: ${label}`}
              onPointerEnter={() => setHover(id)}
              onPointerLeave={() => setHover(null)}
              onFocus={() => setHover(id)}
              onBlur={() => setHover(null)}
            >
              <rect x={x0 - 2} y={yb - 2} width={Math.max(w, 6) + 4} height={thickness + 4} className="c-hit" />
              {w > 0 ? <path d={d} className={`${inkClass(ink)} ${g?.hatch ? "c-bar-hatch" : "c-bar"}`} data-hover={hover === id ? "true" : "false"} /> : null}
              {b.lo !== undefined && b.value > lo && b.value < hi ? <line x1={xs(b.value)} x2={xs(b.value)} y1={yb - 2} y2={yb + thickness + 2} className="c-bar-point" /> : null}
              <text x={x0 + w + 6} y={yb + thickness / 2} dy="0.34em" className="c-bar-value">
                {label}
              </text>
            </g>
          );
        })}
      </g>
    );
  });

  const t = tip as { x: number; y: number; title: string; rows: TipRow[] } | null;
  return (
    <div className="c-chart" ref={ref}>
      <Legend items={legend} />
      <div className="c-canvas" role="group" aria-roledescription="chart" aria-label={ariaLabel}>
        <svg width={width} height={h} viewBox={`0 0 ${width} ${h}`} className="c-svg" focusable="false">
          <defs>
            <pattern id="c-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="5" height="5" className="c-hatch-bg" />
              <line x1="0" y1="0" x2="0" y2="5" className="c-hatch-line" />
            </pattern>
          </defs>
          {ticks.map((v) => (
            <g key={`t-${v}`}>
              <line x1={xs(v)} x2={xs(v)} y1={top} y2={h - 34} className="c-grid" />
              <text x={xs(v)} y={h - 20} textAnchor="middle" className="c-tick">
                {tickText(v)}
              </text>
            </g>
          ))}
          <text x={left + (xs.range[1] - left) / 2} y={h - 4} textAnchor="middle" className="c-axis-label">
            {axis.label}
          </text>
          {rules.map((r) => (
            <g key={`r-${r.value}`}>
              <line x1={xs(r.value)} x2={xs(r.value)} y1={top - 4} y2={h - 34} className="c-ink-3 c-rule" strokeDasharray="7 5" />
              <text x={xs(r.value)} y={top - 9} textAnchor="middle" className="c-rule-label">
                {r.label}
              </text>
            </g>
          ))}
          <g className="c-plot c-plot-bars" data-draw={draw}>
            {body.map((b, i) => (
              <Fragment key={i}>{b}</Fragment>
            ))}
          </g>
        </svg>
        {t ? <Tooltip x={t.x} y={t.y} width={width} title={t.title} rows={t.rows} /> : null}
      </div>
    </div>
  );
}

/**
 * Line / area chart on one x and one y axis (never two y-scales), linear or log on either axis. Hover or the arrow
 * keys move a crosshair that reads every series at the nearest sample; series are told apart by grey level, dash
 * pattern, the legend and selective end labels, never by colour alone.
 */
import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

import { DASH, inkClass, Legend, Tooltip, textWidth, useDrawState, useWidth, type Dash, type Ink, type LegendItem, type TipRow } from "./frame";
import { bandPath, fmt, fmtLogTick, linePath, linearScale, logScale, nearestIndex, type Scale } from "./scale";

export type Pt = readonly [number, number];

export interface AxisSpec {
  domain: readonly [number, number];
  label: string;
  /** Log base (2 or 10); linear when absent. */
  log?: number | undefined;
  ticks?: readonly number[] | undefined;
  format?: ((v: number) => string) | undefined;
}

export interface LineSeries {
  id: string;
  label: string;
  points: readonly Pt[];
  ink?: Ink | undefined;
  dash?: Dash | undefined;
  width?: number | undefined;
  /** Fill under the line (to the x axis) at ~10% ink. */
  area?: boolean | undefined;
  step?: boolean | undefined;
  /** Text at the line's last point. */
  endLabel?: string | undefined;
  /** Draw as stems (a vertical line from the x axis and a dot per point) instead of a line. */
  stem?: boolean | undefined;
  /** Leave out of the crosshair readout. */
  noTip?: boolean | undefined;
  /** Leave out of the legend. */
  noLegend?: boolean | undefined;
  format?: ((y: number) => string) | undefined;
}

export interface BandSpec {
  id: string;
  label: string;
  lower: readonly Pt[];
  upper: readonly Pt[];
  ink?: Ink | undefined;
}

export interface RuleSpec {
  axis: "x" | "y";
  value: number;
  label?: string | undefined;
  ink?: Ink | undefined;
  dash?: Dash | undefined;
  /** Label position along the rule. */
  at?: "start" | "end" | undefined;
}

export interface SpanSpec {
  from: number;
  to: number;
  label?: string | undefined;
}

export interface MarkSpec {
  x: number;
  y: number;
  label?: string | undefined;
  ink?: Ink | undefined;
  /** Label side. */
  side?: "left" | "right" | "above" | "below" | undefined;
}

export interface LineChartProps {
  series: readonly LineSeries[];
  bands?: readonly BandSpec[] | undefined;
  rules?: readonly RuleSpec[] | undefined;
  spans?: readonly SpanSpec[] | undefined;
  marks?: readonly MarkSpec[] | undefined;
  x: AxisSpec;
  y: AxisSpec;
  /** Plot height in px at full width (narrow screens use a little less). */
  height?: number | undefined;
  ariaLabel: string;
  /** Crosshair title for an x value. */
  xTip?: ((x: number) => string) | undefined;
}

const PAD_TOP = 26;
const PAD_BOTTOM = 44;

function makeScale(spec: AxisSpec, range: readonly [number, number]): Scale {
  return spec.log ? logScale(spec.domain, range, spec.log) : linearScale(spec.domain, range);
}

function tickText(spec: AxisSpec, v: number): string {
  if (spec.format) return spec.format(v);
  return spec.log ? fmtLogTick(v, spec.log) : fmt(v, 4);
}

export function LineChart({ series, bands = [], rules = [], spans = [], marks = [], x, y, height = 320, ariaLabel, xTip }: LineChartProps): ReactNode {
  const [ref, width] = useWidth<HTMLDivElement>();
  const draw = useDrawState(ref);
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [hover, setHover] = useState<number | null>(null);

  const narrow = width < 520;
  // Printed (the PDF), charts are a little shorter: the page is narrower than a screen and paper is precious.
  const printing = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("print").matches;
  const h = narrow ? Math.max(220, Math.round(height * 0.82)) : printing ? Math.round(height * 0.78) : height;

  const layout = useMemo(() => {
    const ys0 = makeScale(y, [h - PAD_BOTTOM, PAD_TOP]);
    const yTicks = (y.ticks ?? ys0.ticks(narrow ? 4 : 6)).filter((v) => v >= Math.min(...y.domain) - 1e-12 && v <= Math.max(...y.domain) + 1e-12);
    const left = Math.min(84, Math.max(30, Math.max(...yTicks.map((v) => textWidth(tickText(y, v)))) + 14));
    const endLabels = series.filter((s) => s.endLabel !== undefined && !narrow);
    const right = endLabels.length > 0 ? Math.min(width * 0.3, Math.max(...endLabels.map((s) => textWidth(s.endLabel ?? ""))) + 14) : 14;
    const xs = makeScale(x, [left, Math.max(left + 40, width - right)]);
    const ys = makeScale(y, [h - PAD_BOTTOM, PAD_TOP]);
    const xTicks = (x.ticks ?? xs.ticks(narrow ? 4 : 7)).filter((v) => v >= Math.min(...x.domain) - 1e-12 && v <= Math.max(...x.domain) + 1e-12);
    return { xs, ys, xTicks, yTicks, left, right };
  }, [series, x, y, width, h, narrow]);

  const { xs, ys, xTicks, yTicks, left } = layout;
  const plotW = Math.max(1, xs.range[1] - left);
  const project = (pts: readonly Pt[]): Pt[] =>
    pts.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]) && (!y.log || p[1] > 0) && (!x.log || p[0] > 0)).map((p) => [xs(p[0]), ys(p[1])] as const);

  // Crosshair samples: the x values of the first series that has a readout.
  const tipSeries = series.filter((s) => !s.noTip && s.points.length > 0);
  const anchor = tipSeries[0];
  const anchorXs = useMemo(() => (anchor ? anchor.points.map((p) => p[0]) : []), [anchor]);

  const onMove = (e: PointerEvent<SVGRectElement>): void => {
    if (!anchor) return;
    const rect = e.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (!rect) return;
    const px = ((e.clientX - rect.left) / rect.width) * width;
    setHover(nearestIndex(anchorXs, xs.invert(px)));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (!anchor) return;
    const n = anchorXs.length;
    const step = Math.max(1, Math.round(n / 40));
    let next: number | null = hover;
    if (e.key === "ArrowRight") next = Math.min(n - 1, (hover ?? -1) + step);
    else if (e.key === "ArrowLeft") next = Math.max(0, (hover ?? n) - step);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    else if (e.key === "Escape") next = null;
    else return;
    e.preventDefault();
    setHover(next);
  };

  const hx = hover !== null && anchor ? anchorXs[hover] : undefined;
  const tipRows: TipRow[] = [];
  const dots: { key: string; cx: number; cy: number; ink: Ink }[] = [];
  if (hx !== undefined) {
    for (const s of tipSeries) {
      const xsOf = s.points.map((p) => p[0]);
      const i = nearestIndex(xsOf, hx);
      const p = s.points[i];
      if (!p || !Number.isFinite(p[1])) continue;
      tipRows.push({ key: s.id, label: s.label, value: (s.format ?? y.format ?? ((v: number) => fmt(v, 3)))(p[1]), ink: s.ink ?? 1, dash: s.dash });
      if (!y.log || p[1] > 0) dots.push({ key: s.id, cx: xs(p[0]), cy: ys(p[1]), ink: s.ink ?? 1 });
    }
  }
  const tipY = dots.length > 0 ? Math.max(PAD_TOP, Math.min(...dots.map((d) => d.cy)) - 8) : PAD_TOP;

  const legend: LegendItem[] = [
    ...series.filter((s) => !s.noLegend).map((s) => ({ key: s.id, label: s.label, ink: s.ink ?? 1, dash: s.dash })),
    ...bands.map((b) => ({ key: b.id, label: b.label, ink: b.ink ?? 2, kind: "band" as const })),
  ];
  const clip = `c-clip-${uid}`;

  return (
    <div className="c-chart" ref={ref}>
      <Legend items={legend} />
      <div
        className="c-canvas"
        role="group"
        aria-roledescription="chart"
        aria-label={`${ariaLabel}. Use the left and right arrow keys to read values.`}
        tabIndex={0}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
      >
        <svg width={width} height={h} viewBox={`0 0 ${width} ${h}`} className="c-svg" aria-hidden="true" focusable="false">
          <defs>
            <clipPath id={clip}>
              <rect x={left} y={0} width={plotW} height={h - PAD_BOTTOM + 1} />
            </clipPath>
          </defs>
          {/* y label (horizontal, above the axis) */}
          <text x={4} y={12} className="c-axis-label">
            {y.label}
          </text>
          {spans.map((sp, i) => {
            const a = xs(Math.max(sp.from, x.domain[0]));
            const b = xs(Math.min(sp.to, x.domain[1]));
            return (
              <g key={`span-${i}`}>
                <rect x={a} y={PAD_TOP} width={Math.max(0, b - a)} height={h - PAD_BOTTOM - PAD_TOP} className="c-span" />
                {sp.label ? (
                  <text x={a + 6} y={PAD_TOP + 13} className="c-span-label">
                    {sp.label}
                  </text>
                ) : null}
              </g>
            );
          })}
          {yTicks.map((v) => (
            <g key={`y-${v}`}>
              <line x1={left} x2={xs.range[1]} y1={ys(v)} y2={ys(v)} className="c-grid" />
              <text x={left - 7} y={ys(v)} dy="0.34em" textAnchor="end" className="c-tick">
                {tickText(y, v)}
              </text>
            </g>
          ))}
          <line x1={left} x2={xs.range[1]} y1={h - PAD_BOTTOM} y2={h - PAD_BOTTOM} className="c-axis" />
          {xTicks.map((v) => (
            <g key={`x-${v}`}>
              <line x1={xs(v)} x2={xs(v)} y1={h - PAD_BOTTOM} y2={h - PAD_BOTTOM + 4} className="c-axis" />
              <text x={xs(v)} y={h - PAD_BOTTOM + 17} textAnchor="middle" className="c-tick">
                {tickText(x, v)}
              </text>
            </g>
          ))}
          <text x={left + plotW / 2} y={h - 6} textAnchor="middle" className="c-axis-label">
            {x.label}
          </text>
          <g clipPath={`url(#${clip})`}>
          <g className="c-plot" data-draw={draw}>
            {bands.map((b) => (
              <path key={b.id} d={bandPath(project(b.upper), project(b.lower))} className={`${inkClass(b.ink ?? 2)} c-band-fill`} />
            ))}
            {series
              .filter((s) => s.area)
              .map((s) => {
                const pts = project(s.points);
                const first = pts[0];
                const last = pts[pts.length - 1];
                if (!first || !last) return null;
                const d = `${linePath(pts, s.step)}L${last[0].toFixed(2)} ${(h - PAD_BOTTOM).toFixed(2)}L${first[0].toFixed(2)} ${(h - PAD_BOTTOM).toFixed(2)}Z`;
                return <path key={`a-${s.id}`} d={d} className={`${inkClass(s.ink ?? 1)} c-area`} />;
              })}
            {series.map((s) =>
              s.stem ? (
                <g key={s.id} className={inkClass(s.ink ?? 1)}>
                  <path d={project(s.points).map((p) => `M${p[0].toFixed(2)} ${(h - PAD_BOTTOM).toFixed(2)}V${p[1].toFixed(2)}`).join("")} className="c-line" strokeWidth={s.width ?? 2} />
                  {project(s.points).map((p, i) => (
                    <rect key={i} x={p[0] - 3.5} y={p[1] - 3.5} width={7} height={7} className="c-dot" />
                  ))}
                </g>
              ) : (
              <path
                key={s.id}
                d={linePath(project(s.points), s.step)}
                className={`${inkClass(s.ink ?? 1)} c-line`}
                strokeWidth={s.width ?? 2}
                strokeDasharray={DASH[s.dash ?? "solid"]}
              />
              ),
            )}
          </g>
          </g>
          {rules.map((r, i) => {
            const label = r.label ? (
              r.axis === "x" ? (
                <text x={xs(r.value) + 5} y={r.at === "end" ? h - PAD_BOTTOM - 6 : PAD_TOP + 10} className="c-rule-label">
                  {r.label}
                </text>
              ) : (
                <text x={r.at === "start" ? left + 6 : xs.range[1] - 6} y={ys(r.value) - 6} textAnchor={r.at === "start" ? "start" : "end"} className="c-rule-label">
                  {r.label}
                </text>
              )
            ) : null;
            return (
              <g key={`r-${i}`}>
                {r.axis === "x" ? (
                  <line x1={xs(r.value)} x2={xs(r.value)} y1={PAD_TOP} y2={h - PAD_BOTTOM} className={`${inkClass(r.ink ?? 3)} c-rule`} strokeDasharray={DASH[r.dash ?? "dash"]} />
                ) : (
                  <line x1={left} x2={xs.range[1]} y1={ys(r.value)} y2={ys(r.value)} className={`${inkClass(r.ink ?? 3)} c-rule`} strokeDasharray={DASH[r.dash ?? "dash"]} />
                )}
                {label}
              </g>
            );
          })}
          {marks.map((m, i) => {
            const cx = xs(m.x);
            const cy = ys(m.y);
            const side = m.side ?? "right";
            const tx = side === "left" ? cx - 9 : side === "right" ? cx + 9 : cx;
            const ty = side === "above" ? cy - 10 : side === "below" ? cy + 17 : cy;
            return (
              <g key={`m-${i}`}>
                <rect x={cx - 4.5} y={cy - 4.5} width={9} height={9} className={`${inkClass(m.ink ?? 1)} c-dot`} />
                {m.label ? (
                  <text x={tx} y={ty} dy={side === "left" || side === "right" ? "0.34em" : undefined} textAnchor={side === "left" ? "end" : side === "right" ? "start" : "middle"} className="c-mark-label">
                    {m.label}
                  </text>
                ) : null}
              </g>
            );
          })}
          {!narrow
            ? series
                .filter((s) => s.endLabel !== undefined)
                .map((s) => {
                  const pts = project(s.points);
                  const last = pts[pts.length - 1];
                  if (!last) return null;
                  return (
                    <text key={`e-${s.id}`} x={last[0] + 7} y={last[1]} dy="0.34em" className="c-end-label">
                      {s.endLabel}
                    </text>
                  );
                })
            : null}
          {hx !== undefined ? (
            <g className="c-cross">
              <line x1={xs(hx)} x2={xs(hx)} y1={PAD_TOP} y2={h - PAD_BOTTOM} className="c-cross-line" />
              {dots.map((d) => (
                <rect key={d.key} x={d.cx - 4.5} y={d.cy - 4.5} width={9} height={9} className={`${inkClass(d.ink)} c-dot`} />
              ))}
            </g>
          ) : null}
          <rect
            x={left}
            y={PAD_TOP}
            width={plotW}
            height={h - PAD_BOTTOM - PAD_TOP}
            className="c-hit"
            onPointerMove={onMove}
            onPointerDown={onMove}
            onPointerLeave={() => setHover(null)}
          />
        </svg>
        {hx !== undefined && tipRows.length > 0 ? <Tooltip x={xs(hx)} y={tipY} width={width} title={xTip ? xTip(hx) : `${x.label}: ${tickText(x, hx)}`} rows={tipRows} /> : null}
        <div className="sr-only" aria-live="polite">
          {hx !== undefined ? `${xTip ? xTip(hx) : fmt(hx, 4)}: ${tipRows.map((r) => `${typeof r.label === "string" ? r.label : ""} ${typeof r.value === "string" ? r.value : ""}`).join("; ")}` : ""}
        </div>
      </div>
    </div>
  );
}

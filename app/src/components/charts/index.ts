/**
 * In-house SVG chart and diagram primitives (no chart library). Used by the whitepaper and the docs.
 *
 *   <LineChart series={[...]} x={{ domain, label }} y={{ domain, label, log: 2 }} ariaLabel="..." />
 *   <BarChart rows={[...]} groups={[...]} axis={{ domain, label }} ariaLabel="..." />
 *   <Diagram w={720} h={300} label="..."><DNode .../><DEdge .../></Diagram>
 */
import "./charts.css";

export { BarChart, type BarChartProps, type BarGroup, type BarRow, type BarValue } from "./BarChart";
export { DEdge, DGroup, Diagram, DNode, DText, steppedRect, type NodeKind } from "./Diagram";
export { DASH, inkClass, Legend, LineKey, SwatchKey, Tooltip, useDrawState, useWidth, type Dash, type Ink, type LegendItem, type TipRow } from "./frame";
export { LineChart, type AxisSpec, type BandSpec, type LineChartProps, type LineSeries, type MarkSpec, type Pt, type RuleSpec, type SpanSpec } from "./LineChart";
export { bandPath, fmt, fmtCompact, fmtLogTick, linePath, linearScale, logScale, nearestIndex, niceTicks, powerLabel, type Scale } from "./scale";

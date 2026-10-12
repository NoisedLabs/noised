/** Section 6 and 7 figures: pro-rata fill, batch price on a real preset curve, the shield timeline, contention cost. */
import { useMemo, type ReactNode } from "react";

import { DEdge, Diagram, DText, LineChart, type LineSeries } from "../../../components/charts";
import { spentFraction } from "../model/batch";
import { attackerSol, PRICE_LEVELS, TX_PER_BLOCK } from "../model/contention";
import { marginalPrice, PRESET_SHAPES, presetCurve } from "../model/curve";
import { C, Figure, SecRef } from "../paper";
import { Fn } from "../refs";
import { M } from "../tex";

export function FillFigure(): ReactNode {
  const pts = useMemo(() => {
    const spent: [number, number][] = [];
    const refund: [number, number][] = [];
    for (let i = 0; i <= 250; i++) {
      const x = i / 50;
      const f = x === 0 ? 1 : spentFraction(x);
      spent.push([x, f * 100]);
      refund.push([x, (1 - f) * 100]);
    }
    return { spent, refund };
  }, []);
  const series: LineSeries[] = [
    { id: "spent", label: "share of every commit the batch spends", points: pts.spent, ink: 1, endLabel: "spent", format: (v) => `${v.toFixed(1)}%` },
    { id: "refund", label: "share refunded at claim", points: pts.refund, ink: 2, dash: "dash", endLabel: "refunded", format: (v) => `${v.toFixed(1)}%` },
  ];
  return (
    <Figure
      id="fig-fill"
      title="Pro-rata fill against oversubscription."
      caption={
        <>
          With commits totalling <M>{"C"}</M> against a cap <M>{"K"}</M>, every commit has the same fraction{" "}
          <M>{"\\min(1, K/C)"}</M> spent and the rest refunded, whatever its size, wallet or arrival time. First come, first served would instead
          fill the cap with the earliest commits and refuse the rest.
        </>
      }
    >
      <LineChart
        series={series}
        x={{ domain: [0, 5], label: "oversubscription C / K", ticks: [0, 1, 2, 3, 4, 5], format: (v) => `${v}×` }}
        y={{ domain: [0, 100], label: "share of each commit", ticks: [0, 25, 50, 75, 100], format: (v) => `${v}%` }}
        marks={[{ x: 2, y: 50, label: "2×: half spent, half refunded", side: "above" }]}
        height={280}
        xTip={(x) => `C = ${x.toFixed(2)} K`}
        ariaLabel="Share of each commit spent and refunded as a function of oversubscription"
      />
    </Figure>
  );
}

export function PriceFigure(): ReactNode {
  const fair = PRESET_SHAPES[0];
  const data = useMemo(() => {
    if (!fair) return null;
    const curve = presetCurve(fair);
    const B = 20;
    const toLamports = (solPerToken: number): number => solPerToken * 1e9;
    const marginal: [number, number][] = [];
    for (let i = 0; i <= 120; i++) {
      const q = i * 0.5;
      marginal.push([q, toLamports(marginalPrice(curve, q))]);
    }
    const p0 = toLamports(marginalPrice(curve, 0));
    const pB = toLamports(marginalPrice(curve, B));
    const avg = Math.sqrt(p0 * pB);
    const batch: [number, number][] = [
      [0, avg],
      [B, avg],
    ];
    return { marginal, batch, p0, pB, avg, B, threshold: Number(fair.thresholdSol) };
  }, [fair]);
  if (!data || !fair) return null;
  const series: LineSeries[] = [
    { id: "m", label: "marginal price: what the next lamport buys at", points: data.marginal, ink: 2, format: (v) => `${v.toFixed(1)} lamports` },
    { id: "b", label: `price every batch participant pays (${data.B} SOL batch)`, points: data.batch, ink: 1, width: 3, format: (v) => `${v.toFixed(1)} lamports` },
  ];
  return (
    <Figure
      id="fig-price"
      title="One price for the whole batch, on the Fair preset's real curve."
      caption={
        <>
          The SDK's Fair preset (start 0.00000003 SOL, graduation 0.0000004 SOL per token, {data.threshold} SOL threshold), recomputed with the
          SDK's exact curve arithmetic. Without a batch, the first buyer pays {data.p0.toFixed(1)} lamports per token and whoever buys the 20th SOL
          pays {data.pB.toFixed(1)}: a race that bots and bundlers win. The batch spends the same {data.B} SOL in one swap and every participant
          pays the geometric mean, {data.avg.toFixed(1)} lamports (Lemma 6.4). Fees are left out; they scale every price by the same factor.
        </>
      }
    >
      <LineChart
        series={series}
        spans={[{ from: 0, to: data.B, label: "fair-open batch" }]}
        x={{ domain: [0, 60], label: "SOL already in the curve", ticks: [0, 10, 20, 30, 40, 50, 60] }}
        y={{ domain: [0, 260], label: "price (lamports per token)", ticks: [0, 50, 100, 150, 200, 250] }}
        marks={[
          { x: 0, y: data.p0, ink: 2 },
          { x: data.B, y: data.pB, ink: 2 },
          { x: data.B / 2, y: data.avg, label: `everyone in the batch: ${data.avg.toFixed(1)}`, side: "above", ink: 1 },
        ]}
        height={300}
        xTip={(x) => `${x} SOL in the curve`}
        ariaLabel="Bonding curve price versus SOL already in the curve, with the single batch price"
      />
    </Figure>
  );
}

export function TimelineFigure(): ReactNode {
  // Fair preset timeline, drawn piecewise (each segment's width is not to scale; durations are labelled).
  const segs = [
    { label: "commit window", dur: "300 s (60-1,800)", w: 150 },
    { label: "execution window", dur: "≤ 600 s, ends at the batch", w: 170 },
    { label: "guard", dur: "until 6 h (≤ 72 h)", w: 250 },
    { label: "open", dur: "until graduation", w: 170 },
  ];
  const x0 = 120;
  let x = x0;
  const xs = segs.map((s) => {
    const a = x;
    x += s.w;
    return [a, x] as const;
  });
  const end = x;
  const bar = (y: number, from: number, to: number, label: string, kind: string): ReactNode => (
    <g>
      <rect x={from} y={y} width={to - from} height={20} rx={5} className={`tl-bar tl-${kind}`} />
      <text x={from + 8} y={y + 14} className="tl-bar-label">
        {label}
      </text>
    </g>
  );
  const e1 = xs[1]?.[1] ?? 0;
  const g1 = xs[2]?.[1] ?? 0;
  const c1 = xs[0]?.[1] ?? 0;
  return (
    <Figure
      id="fig-timeline"
      title="Snipe shield and guard timeline (Fair preset)."
      caption={
        <>
          Segment widths are not to scale. Until the batch executes, or the execution window ends, the hook refuses every buy except the one
          inside a top-level <C>execute_batch</C>; the batch ends the shield at once, so a long window never delays trading. Max-buy, max-wallet
          and the optional wallet-to-wallet lock then apply until the guard ends. Sells into the pool pass at every moment.
        </>
      }
      wide
    >
      <Diagram w={900} h={232} minWidth={640} label="Timeline of a launch's commit window, execution window, guard and open trading">
        <line x1={x0} x2={end + 20} y1={44} y2={44} className="tl-axis" />
        {segs.map((s, i) => {
          const [a, b] = xs[i] ?? [0, 0];
          return (
            <g key={s.label}>
              <line x1={a} x2={a} y1={36} y2={52} className="tl-tick" />
              <DText x={(a + b) / 2} y={26} anchor="middle" kind="title">
                {s.label}
              </DText>
              <DText x={(a + b) / 2} y={68} anchor="middle" kind="small">
                {s.dur}
              </DText>
            </g>
          );
        })}
        <DText x={x0} y={92} anchor="middle" kind="mono">
          T0
        </DText>
        <DEdge points={[[end, 44], [end + 24, 44]]} />
        <DText x={10} y={122} kind="label">
          buys
        </DText>
        {bar(108, x0, e1, "refused, except the batch's own buy", "shield")}
        <DText x={10} y={154} kind="label">
          caps, lock
        </DText>
        {bar(140, e1, g1, "max-buy, max-wallet, optional p2p lock", "guard")}
        <DText x={10} y={186} kind="label">
          sells
        </DText>
        {bar(172, x0, end, "always pass", "free")}
        <line x1={c1} x2={c1} y1={100} y2={206} className="tl-mark" />
        <DText x={c1 + 4} y={218} kind="small">
          execute_batch, any time in its window
        </DText>
      </Diagram>
    </Figure>
  );
}

export function ContentionFigure(): ReactNode {
  const series = useMemo<LineSeries[]>(
    () =>
      PRICE_LEVELS.map((lvl, i) => ({
        id: `pi-${lvl.pi}`,
        label: lvl.label,
        points: Array.from({ length: 121 }, (_, k) => {
          const s = 10 + k * 20;
          return [s, attackerSol(s, lvl.pi)] as [number, number];
        }),
        ink: ([3, 2, 2, 1] as const)[i] ?? 1,
        endLabel: (["no priority fee", "10k", "100k", "1M µlamports/CU"] as const)[i],
        dash: (["dot", "dash", "solid", "solid"] as const)[i] ?? "solid",
        format: (v: number) => `${v < 1 ? v.toFixed(3) : v.toFixed(1)} SOL`,
      })),
    [],
  );
  return (
    <Figure
      id="fig-contention"
      title="What it costs to keep honest transactions out of a launch's accounts."
      caption={
        <>
          Attacker SOL to fill the Launch account's per-block write budget (24M CU, {TX_PER_BLOCK} transactions per block) for a whole window, at
          a compute-unit price one micro-lamport above the honest transactions' (equation 7.1, 400 ms slots<Fn k="slot" />). Vertical lines: the
          shortest commit window (60 s), the execution window (600 s) and the longest commit window (1,800 s). If nobody pays a priority fee,
          blocking a one-minute window costs about 0.014 SOL; if honest commits pay 1 lamport per CU, blocking the execution window costs about 36
          SOL. A blocked batch refunds in full (<SecRef to="liveness" />).
        </>
      }
    >
      <LineChart
        series={series}
        x={{ domain: [10, 2410], label: "window the attacker must cover (seconds)", ticks: [60, 600, 1200, 1800, 2400] }}
        y={{ domain: [0.001, 1000], label: "attacker cost (SOL, log scale)", log: 10, ticks: [0.001, 0.01, 0.1, 1, 10, 100, 1000], format: (v) => (v >= 1 ? v.toLocaleString("en-US") : String(v)) }}
        rules={[
          { axis: "x", value: 60, label: "60 s", ink: 4 },
          { axis: "x", value: 600, label: "600 s", ink: 3 },
          { axis: "x", value: 1800, label: "1,800 s", ink: 4 },
        ]}
        height={330}
        xTip={(x) => `${x} s window`}
        ariaLabel="Attacker cost in SOL to block a launch's accounts as a function of window length, for four honest priority-fee levels"
      />
    </Figure>
  );
}

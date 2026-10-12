/** Section 8 and 9 figures: the hook's decision tree, the presets' bonding curves, fee schedules. */
import { useMemo, type ReactNode } from "react";

import { DEdge, Diagram, DNode, LineChart, type LineSeries } from "../../../components/charts";
import { LAMPORTS_PER_SOL, PRESET_SHAPES, presetCurve, priceOf, stateAfter } from "../model/curve";
import { baseFeeAt, exampleSchedules, pct } from "../model/fees";
import { C, Figure } from "../paper";
import { M } from "../tex";

const STEPS: { q: string; sub: string; yes: { label: string; refuse: boolean } }[] = [
  { q: "1. Policy for this mint?", sub: "none: allow · another mint's: refuse", yes: { label: "allow / PolicyMismatch", refuse: false } },
  { q: "2. Not a buy, and a sell or amount 0?", sub: "decided from keys and amount alone", yes: { label: "allow", refuse: false } },
  { q: "3. now ≥ guard_end?", sub: "every rule has a hard expiry", yes: { label: "allow", refuse: false } },
  { q: "4. Buy before shield_end, not in execute_batch?", sub: "top-level instruction read from the sysvar", yes: { label: "refuse: SnipeShield", refuse: true } },
  { q: "5. Amount 0?", sub: "only a buy can reach here with 0", yes: { label: "allow", refuse: false } },
  { q: "6. Exempt source or destination owner?", sub: "batch and launch authorities", yes: { label: "allow", refuse: false } },
  { q: "7. Wallet-to-wallet lock, max-buy, max-wallet", sub: "TransfersLocked · MaxBuy · MaxWallet", yes: { label: "refuse if violated", refuse: true } },
];

export function HookFigure(): ReactNode {
  const rowH = 66;
  const top = 14;
  const h = top + STEPS.length * rowH + 50;
  return (
    <Figure
      id="fig-hook"
      title="Launch Guard's decision order."
      caption={
        <>
          The order is the argument: sells (2) and expiry (3) are decided before any rule can refuse, so no rule can ever block a sell or outlive
          the guard; the shield (4) is checked before the zero-amount (5) and exemption (6) passes, so neither can open it. Audit round 3's F2
          splits step 6: an exempt destination passes, then a receiving account without <C>ImmutableOwner</C> is refused
          (<C>MutableOwner</C>), then an exempt source passes.
        </>
      }
    >
      <Diagram w={760} h={h} minWidth={600} label="Decision tree of the Launch Guard transfer hook">
        {STEPS.map((s, i) => {
          const y = top + i * rowH;
          return (
            <g key={s.q}>
              <DNode x={10} y={y} w={430} h={50} title={s.q} lines={[s.sub]} align="start" kind={i === 3 ? "strong" : "box"} step={i} />
              <DEdge points={[[440, y + 25], [520, y + 25]]} label="yes" labelAt={[480, y + 19, "middle"]} step={i} />
              <DNode x={520} y={y + 6} w={226} h={38} title={s.yes.label} kind={s.yes.refuse ? "strong" : "pda"} r={19} step={i} />
              {i < STEPS.length - 1 ? <DEdge points={[[60, y + 50], [60, y + rowH]]} label="no" labelAt={[68, y + 61, "start"]} step={i} /> : null}
            </g>
          );
        })}
        <DEdge points={[[60, top + (STEPS.length - 1) * rowH + 50], [60, top + (STEPS.length - 1) * rowH + 78], [520, top + (STEPS.length - 1) * rowH + 78]]} label="none violated" labelAt={[290, top + (STEPS.length - 1) * rowH + 72, "middle"]} />
        <DNode x={520} y={top + (STEPS.length - 1) * rowH + 60} w={226} h={36} title="allow" kind="pda" r={18} />
      </Diagram>
    </Figure>
  );
}

export function CurveFigure(): ReactNode {
  const data = useMemo(
    () =>
      PRESET_SHAPES.map((p) => {
        const curve = presetCurve(p);
        const price: [number, number][] = [];
        const reserve: [number, number][] = [];
        const N = 120;
        for (let i = 0; i <= N; i++) {
          const q = (curve.thresholdLamports * BigInt(i)) / BigInt(N);
          const st = stateAfter(curve, q);
          if (!st) continue;
          const sold = Number(st.base) / 10 ** curve.decimals / 1e6;
          price.push([sold, priceOf(st.sqrtPrice, curve.decimals) * 1e9]);
          reserve.push([sold, Number(q) / Number(LAMPORTS_PER_SOL)]);
        }
        return { p, price, reserve };
      }),
    [],
  );
  const inks = [1, 2, 3] as const;
  const dashes = ["solid", "dash", "dot"] as const;
  const price: LineSeries[] = data.map((d, i) => ({ id: `p-${d.p.name}`, label: d.p.title, points: d.price, ink: inks[i] ?? 1, dash: dashes[i] ?? "solid", endLabel: d.p.title, format: (v: number) => `${v.toFixed(1)} lamports` }));
  const reserve: LineSeries[] = data.map((d, i) => ({ id: `r-${d.p.name}`, label: d.p.title, points: d.reserve, ink: inks[i] ?? 1, dash: dashes[i] ?? "solid", endLabel: `${d.p.title}, ${d.p.thresholdSol} SOL`, format: (v: number) => `${v.toFixed(1)} SOL` }));
  return (
    <Figure
      id="fig-curve"
      title="The three presets' bonding curves, from the SDK's exact parameters."
      caption={
        <>
          Price (left) and SOL held by the curve (right) against tokens sold, up to each preset's graduation threshold. Each preset is one
          constant-liquidity segment from its start price to its graduation price, sized so the curve holds exactly the threshold there; at
          graduation DBC moves the reserve and the matching tokens into a DAMM v2 pool whose liquidity is then locked forever. The price grows as
          the square of <M>{"s = s_0 + q / L"}</M>, i.e. quadratically in the SOL raised.
        </>
      }
      wide
    >
      <div className="wp-split">
        <LineChart series={price} x={{ domain: [0, 1500], label: "tokens sold (millions)" }} y={{ domain: [0, 650], label: "price (lamports per token)" }} height={290} xTip={(x) => `${x.toFixed(0)}M tokens sold`} ariaLabel="Price against tokens sold for the Fair, Community and Turbo presets" />
        <LineChart series={reserve} x={{ domain: [0, 1500], label: "tokens sold (millions)" }} y={{ domain: [0, 260], label: "SOL in the curve" }} height={290} xTip={(x) => `${x.toFixed(0)}M tokens sold`} ariaLabel="SOL reserve against tokens sold for the three presets" />
      </div>
    </Figure>
  );
}

export function FeeFigure(): ReactNode {
  const { series, floorAt } = useMemo(() => {
    const s = exampleSchedules(300);
    const mk = (sch: typeof s.linear): [number, number][] => Array.from({ length: 421 }, (_, t) => [t, pct(baseFeeAt(sch, t))] as [number, number]);
    const out: LineSeries[] = [
      { id: "exp", label: `exponential: 50% cliff, ${s.exponential.reduction} bps per 10 s, 30 periods`, points: mk(s.exponential), ink: 1, step: true, format: (v) => `${v.toFixed(2)}%` },
      { id: "lin", label: "linear: 50% cliff, equal steps, 30 periods", points: mk(s.linear), ink: 2, dash: "dash", step: true, format: (v) => `${v.toFixed(2)}%` },
    ];
    return { series: out, floorAt: pct(baseFeeAt(s.exponential, 300)) };
  }, []);
  return (
    <Figure
      id="fig-fees"
      title="Base-fee schedules the policy accepts for a 300-second commit window."
      caption={
        <>
          Two schedules, computed with the launchpad's bit-exact mirror of DBC's fee scheduler (the exponential one with DBC's Q64.64
          square-and-multiply). The policy requires the whole schedule to end within the commit window (<M>{"N \\cdot f \\le \\delta"}</M>), so
          the batch, which executes after it, pays the floor ({floorAt.toFixed(2)}% here) plus at most the dynamic fee, and floor plus maximum
          dynamic fee may not exceed 10%. A decaying fee is DBC's usual defence against snipers; under Noised no buy is possible before the batch
          anyway, so the presets use a flat 1-1.5% fee.
        </>
      }
    >
      <LineChart
        series={series}
        x={{ domain: [0, 420], label: "seconds since launch", ticks: [0, 60, 120, 180, 240, 300, 360, 420] }}
        y={{ domain: [0, 52], label: "base fee (% of the input)", ticks: [0, 10, 20, 30, 40, 50], format: (v) => `${v}%` }}
        rules={[
          { axis: "x", value: 300, label: "commit window ends", ink: 3 },
          { axis: "y", value: 10, label: "10% ceiling (floor + dynamic)", ink: 4, at: "end" },
        ]}
        height={280}
        xTip={(x) => `t = ${x} s`}
        ariaLabel="Base fee over time for an exponential and a linear schedule"
      />
      <p className="wp-art-cap">
        <C>first_factor</C> = periods N, <C>second_factor</C> = seconds per period f, <C>third_factor</C> = reduction per period.
      </p>
    </Figure>
  );
}

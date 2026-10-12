/**
 * "Try it first": the SDK's treasury simulator over the next days with fees
 * flowing in and a price path, drawn as small charts with plain totals. Every
 * run is the program's own decision (the SDK replays plan_run): budgets, runs,
 * the reference price that starts at the launch's migration price (review U4),
 * tips, and buybacks that must fill at the pool's fee and depth (review U5).
 * The simulator's market assumptions are shown next to the numbers.
 */
import { useMemo, useState, type ReactNode } from "react";

import { LineChart, type LineSeries } from "../../components/charts";
import { buybackImpactBps, sqrtPriceOf, simulate, type Graph, type GraphTimeline } from "../../lib/programmable";
import { ChoiceChips, StopSlider } from "../create/SimpleControls";
import { Metric, NoteBox, Panel, Tiles } from "../inner/kit";

type PricePath = "flat" | "up" | "down" | "swing";

export interface SimSettings {
  days: number;
  feesPerDay: number;
  path: PricePath;
  /** Days until graduation (0 = already graduated). */
  graduatesIn: number;
}

/** What the simulation starts from (the launch and its treasury). */
export interface SimContext {
  startTime: number;
  /** Spot SOL per token now (or the launch's first price). */
  startPrice: number;
  /** Where the reference price starts, SOL per token: the autopilot's, or the launch's migration price. */
  refPrice: number;
  treasurySol: bigint;
  treasuryTokens: bigint;
  supply: bigint;
  decimals: number;
  /** The pool's trading fee after graduation (bps). */
  poolFeeBps: number;
  /** The pool's SOL (lamports): what price impact is estimated against; null: unknown (the totals are an upper bound). */
  poolSol: bigint | null;
}

/** The price on day `step` for a path starting at `p0` (deterministic). */
export function pricePath(path: PricePath, p0: number, step: number): number {
  switch (path) {
    case "flat":
      return p0;
    case "up":
      return p0 * 1.03 ** step;
    case "down":
      return p0 * 0.97 ** step;
    case "swing":
      return p0 * (1 + 0.28 * Math.sin(step / 2.2) + 0.06 * Math.sin(step * 1.7));
  }
}

/** The biggest buyback one run of the graph may make (lamports), for the price-impact estimate. */
export function biggestBuyback(g: Graph): bigint {
  return g.nodes.reduce((m, n) => (n.action.kind === "buybackBurn" && n.action.maxInLamports > m ? n.action.maxInLamports : m), 0n);
}

/** What the biggest buyback pays the pool (its fee) and loses to its own price impact (bps), at the start price. */
export function costBps(g: Graph, ctx: Pick<SimContext, "poolFeeBps" | "poolSol" | "startPrice" | "decimals">): { fee: number; impact: number } {
  const amount = biggestBuyback(g);
  if (amount === 0n || ctx.poolSol === null || !(ctx.startPrice > 0)) return { fee: ctx.poolFeeBps, impact: 0 };
  return { fee: ctx.poolFeeBps, impact: buybackImpactBps(amount, sqrtPriceOf(ctx.startPrice, ctx.decimals), ctx.poolFeeBps, ctx.poolSol) };
}

/** Runs the simulator with the panel's settings (pure; test/autopilot-sim.test.ts). */
export function runSimulation(g: Graph, s: SimSettings, ctx: SimContext): GraphTimeline | { error: string } {
  if (!Number.isFinite(s.feesPerDay) || s.feesPerDay < 0) return { error: "Pick how much SOL the treasury earns per day." };
  return simulate(g, {
    epochs: s.days,
    stepSecs: 86_400,
    startTime: ctx.startTime,
    priceFn: (step) => pricePath(s.path, ctx.startPrice, step),
    feeInflowFn: () => s.feesPerDay.toFixed(9),
    initialTreasury: { sol: ctx.treasurySol, tokens: ctx.treasuryTokens },
    supply: ctx.supply,
    tokenDecimals: ctx.decimals,
    graduatedAtStep: s.graduatesIn,
    migrationPrice: ctx.refPrice,
    poolFeeBps: ctx.poolFeeBps,
    poolSol: ctx.poolSol === null ? "none" : ctx.poolSol,
  });
}

const sol = (lamports: bigint): number => Number(lamports) / 1e9;
const FEES = [0, 0.1, 0.4, 1, 2, 5];

export function SimPanel({ graph, ctx, graduated }: { graph: Graph | null; ctx: SimContext; graduated: boolean }): ReactNode {
  const [s, setS] = useState<SimSettings>({ days: 30, feesPerDay: 0.4, path: "swing", graduatesIn: graduated ? 0 : 3 });
  const set = (patch: Partial<SimSettings>): void => setS((v) => ({ ...v, ...patch }));
  const result = useMemo(() => (graph === null ? null : runSimulation(graph, s, ctx)), [graph, s, ctx]);
  const fi = FEES.indexOf(s.feesPerDay);
  const cost = graph !== null ? costBps(graph, ctx) : null;
  const scale = 10 ** ctx.decimals;

  return (
    <Panel title="Try it first" description="A simulation of the next days with your steps, the fees flowing into the treasury and a price path. It applies the same limits the chain does.">
      <div className="ap-sim-controls">
        <ChoiceChips
          label="How long"
          choices={[7, 30, 90].map((d) => ({ id: String(d), text: `${d} days` }))}
          value={String(s.days)}
          onPick={(d) => set({ days: Number(d) })}
        />
        <ChoiceChips<PricePath>
          label="The price"
          choices={[
            { id: "flat", text: "Stays flat" },
            { id: "up", text: "Rises" },
            { id: "down", text: "Falls" },
            { id: "swing", text: "Swings" },
          ]}
          value={s.path}
          onPick={(path) => set({ path })}
        />
        {!graduated ? (
          <ChoiceChips
            label="Graduates after"
            choices={[0, 1, 3, 7, 14].map((d) => ({ id: String(d), text: d === 0 ? "Today" : `${d} day${d === 1 ? "" : "s"}` }))}
            value={String(s.graduatesIn)}
            onPick={(d) => set({ graduatesIn: Number(d) })}
          />
        ) : null}
        <StopSlider
          label="Fees into the treasury per day"
          stops={FEES.length}
          index={fi < 0 ? 2 : fi}
          exact
          valueText={`${s.feesPerDay} SOL`}
          stopText={(i) => `${FEES[i] ?? 0} SOL`}
          onIndex={(i) => set({ feesPerDay: FEES[i] ?? 0 })}
          ends={["0 SOL", "5 SOL"]}
          say={s.feesPerDay === 0 ? "Only what the treasury holds now." : `The treasury earns ${s.feesPerDay} SOL a day from trading fees.`}
        />
      </div>
      {cost !== null && graph !== null && biggestBuyback(graph) > 0n ? (
        <p className="ap-sim-cost">
          Every buyback pays the pool's {cost.fee / 100}% fee
          {ctx.poolSol !== null
            ? ` and moves the price about ${(cost.impact / 100).toFixed(2)}% (a ${sol(biggestBuyback(graph))} SOL buy into a pool holding about ${Math.round(sol(ctx.poolSol)).toLocaleString("en-US")} SOL)`
            : ", and its price impact is not known yet, so the totals are the most it could do"}
          . A buyback runs only when the pool can fill it within its premium, exactly as on Solana.
        </p>
      ) : null}

      {graph === null ? (
        <NoteBox tone="warn" title="Nothing to simulate yet">
          Switch a job on (or fix the problems above) to see what it would do.
        </NoteBox>
      ) : result === null ? null : "error" in result ? (
        <NoteBox tone="warn" title="Can't simulate this">
          {result.error}
        </NoteBox>
      ) : (
        <SimResult t={result} scale={scale} supply={ctx.supply} />
      )}
    </Panel>
  );
}

function SimResult({ t, scale, supply }: { t: GraphTimeline; scale: number; supply: bigint }): ReactNode {
  const days = t.steps.length;
  const treasury: LineSeries[] = [{ id: "treasury", label: "Treasury (SOL)", points: t.steps.map((x) => [x.step, sol(x.treasurySol)] as const), area: true, ink: 1, format: (v) => `${v.toFixed(3)} SOL` }];
  const burned: LineSeries[] = [{ id: "burned", label: "Tokens burned", points: t.steps.map((x) => [x.step, Number(x.burnedTotal) / scale] as const), area: true, ink: 1, step: true, format: (v) => compact(v) }];
  const price: LineSeries[] = [
    { id: "price", label: "Price", points: t.steps.map((x) => [x.step, x.price] as const), ink: 1, format: (v) => `${v.toPrecision(3)} SOL` },
    { id: "ref", label: "Reference price (buybacks can't pay much more)", points: t.steps.map((x) => [x.step, x.refPrice] as const), ink: 3, dash: "dash", format: (v) => `${v.toPrecision(3)} SOL` },
  ];
  const maxT = Math.max(0.001, ...(treasury[0]?.points ?? []).map((p) => p[1]));
  const maxB = Math.max(1, ...(burned[0]?.points ?? []).map((p) => p[1]));
  const prices = t.steps.map((x) => x.price).concat(t.steps.map((x) => x.refPrice));
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const pad = (hi - lo) * 0.1 || hi * 0.1 || 1e-9;
  const burnedPct = supply > 0n ? (Number(t.totals.burned) / Number(supply)) * 100 : 0;
  // SDK 0.9.0: the timeline holds keepers' partial buybacks too; a "run" is a completed one (totals.runs counts both).
  const runs = completedRuns(t);
  const events = t.steps.flatMap((x) => [
    ...x.runs.map((r) => ({ day: x.step, kind: "run" as const, node: r.node, text: runText(r, scale) })),
    ...x.blocked.map((b) => ({ day: x.step, kind: "wait" as const, node: b.node, text: b.why })),
  ]);
  const x = { domain: [0, Math.max(1, days - 1)] as const, label: "day", format: (v: number) => `day ${Math.round(v)}` };
  return (
    <div className="ap-sim">
      <Tiles label="Simulation totals" className="ap-sim-tiles">
        <Metric label="Tokens burned" value={compact(Number(t.totals.burned) / scale)} hint={`${burnedPct.toFixed(2)}% of the supply, at most`} />
        <Metric label="SOL spent on buybacks" value={sol(t.totals.solSpent).toLocaleString("en-US", { maximumFractionDigits: 3 })} unit="SOL" />
        <Metric label="Paid to recipients" value={sol(t.totals.distributed).toLocaleString("en-US", { maximumFractionDigits: 3 })} unit="SOL" />
        <Metric label="Tips to whoever ran it" value={sol(t.totals.tips).toLocaleString("en-US", { maximumFractionDigits: 4 })} unit="SOL" hint={`${runs} run${runs === 1 ? "" : "s"}`} />
      </Tiles>
      <div className="ap-charts">
        <figure className="ap-chart">
          <figcaption className="pg-label">Tokens burned (total)</figcaption>
          <LineChart series={burned} x={x} y={{ domain: [0, maxB * 1.1], label: "tokens", format: compact }} height={180} ariaLabel="Tokens burned in total by day" xTip={(v) => `Day ${Math.round(v)}`} />
        </figure>
        <figure className="ap-chart">
          <figcaption className="pg-label">Treasury</figcaption>
          <LineChart series={treasury} x={x} y={{ domain: [0, maxT * 1.1], label: "SOL", format: (v) => v.toFixed(2) }} height={180} ariaLabel="Treasury SOL by day" xTip={(v) => `Day ${Math.round(v)}`} />
        </figure>
        <figure className="ap-chart">
          <figcaption className="pg-label">Price (SOL per token)</figcaption>
          <LineChart
            series={price}
            x={x}
            y={{ domain: [Math.max(0, lo - pad), hi + pad], label: "SOL", format: (v) => v.toPrecision(2) }}
            height={180}
            ariaLabel="Price and the slow average price by day"
            xTip={(v) => `Day ${Math.round(v)}`}
          />
        </figure>
      </div>
      {events.length > 0 ? (
        <details className="pg-details ap-events">
          <summary>
            <span>
              What happened, day by day ({runs} run{runs === 1 ? "" : "s"}, {t.totals.blocked} waits)
            </span>
            <span className="pg-chev" aria-hidden="true" />
          </summary>
          <ol className="ap-event-list">
            {events.slice(0, 60).map((e, i) => (
              <li key={i} data-kind={e.kind}>
                <span className="ap-event-day">Day {e.day}</span>
                <span className="ap-event-node">{e.node}</span>
                <span>{e.text}</span>
              </li>
            ))}
          </ol>
          {events.length > 60 ? <p className="ap-muted">…and {events.length - 60} more.</p> : null}
        </details>
      ) : (
        <p className="ap-muted">Nothing ran in this simulation. Check the conditions and how much the treasury holds.</p>
      )}
      {t.assumptions.length > 0 ? (
        <details className="pg-details ap-assumptions">
          <summary>
            <span>What this simulation assumes</span>
            <span className="pg-chev" aria-hidden="true" />
          </summary>
          <ul className="ap-event-list">
            {t.assumptions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/** The completed runs of a simulation: a keeper's partial buyback leaves its step's run open (SDK 0.9.0, audit 4 A4-2). */
export function completedRuns(t: Pick<GraphTimeline, "steps">): number {
  return t.steps.reduce((n, x) => n + x.runs.filter((r) => !r.partial).length, 0);
}

function runText(r: GraphTimeline["steps"][number]["runs"][number], scale: number): string {
  const tip = r.tip > 0n ? ` · tip ${sol(r.tip).toFixed(4)} SOL` : "";
  if (r.action === "buybackBurn") return `${r.partial ? "partial buyback: " : ""}bought ${compact(Number(r.tokensBought) / scale)} tokens with ${sol(r.amount).toFixed(3)} SOL and burned them${tip}`;
  if (r.action === "burn") return `burned ${compact(Number(r.burned) / scale)} tokens${tip}`;
  return `paid ${sol(r.amount).toFixed(3)} SOL to ${r.paid.length} recipient${r.paid.length === 1 ? "" : "s"}${tip}`;
}

function compact(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

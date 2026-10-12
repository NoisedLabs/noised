/**
 * The Autopilot simulation (pages/autopilot/SimPanel.tsx) runs the SDK's
 * simulator, whose every run is the program's own plan_run, with the pool's
 * real fee and depth (review U5) and the reference starting where the program
 * starts it, at the launch's migration price (review U4); its market
 * assumptions are shown with the numbers.
 */
import { describe, expect, it } from "vitest";

import { buybackImpactBps, sqrtPriceOf, type Graph } from "../src/lib/programmable";
import { composeJobs, defaultChoices, type JobContext } from "../src/pages/autopilot/simple";
import { costBps, pricePath, runSimulation, type SimContext, type SimSettings } from "../src/pages/autopilot/SimPanel";

const LAMPORTS = 1_000_000_000n;

/** A buyback every hour with a 3% premium (built through the Simple jobs at a 1% fee, where 3% is offered). */
function premium3(): Graph {
  const c = defaultChoices();
  c.buyback = { on: true, amount: 3, every: 0, premium: 1 };
  const ctx: JobContext = { symbol: "T", decimals: 6, poolFeeBps: 100, recipients: [] };
  const g = composeJobs(c, ctx).graph;
  if (!g) throw new Error("no graph");
  return g;
}

const base: SimContext = {
  startTime: 1_800_000_000,
  startPrice: 0.00001,
  refPrice: 0.00001,
  treasurySol: 50n * LAMPORTS,
  treasuryTokens: 0n,
  supply: 1_000_000_000_000_000n,
  decimals: 6,
  poolFeeBps: 100,
  poolSol: 10_000n * LAMPORTS,
};
const settings: SimSettings = { days: 5, feesPerDay: 0, path: "flat", graduatesIn: 0 };

function run(s: SimSettings, c: SimContext) {
  const r = runSimulation(premium3(), s, c);
  if ("error" in r) throw new Error(r.error);
  return r;
}

describe("simulation wiring", () => {
  it("passes the pool's fee: a 3% premium buys at a 1% fee and never at a 4% fee (review U5)", () => {
    expect(premium3().nodes[0]?.action).toMatchObject({ kind: "buybackBurn", maxPremiumBps: 300 });
    expect(run(settings, base).totals.runs).toBeGreaterThan(0);
    const at4 = run(settings, { ...base, poolFeeBps: 400 });
    expect(at4.totals.runs).toBe(0);
    expect(at4.totals.blocked).toBeGreaterThan(0);
  });

  it("passes the pool's depth: a shallow pool's price impact stops buybacks a deep one allows", () => {
    const deep = run(settings, base);
    const thin = run(settings, { ...base, poolSol: 10n * LAMPORTS });
    // Keepers buy only what the pool can fill within the premium: less SOL goes in, in smaller buys.
    expect(thin.totals.solSpent).toBeLessThan(deep.totals.solSpent);
    expect(costBps(premium3(), { ...base, poolSol: 10n * LAMPORTS }).impact).toBeGreaterThan(costBps(premium3(), base).impact);
    expect(costBps(premium3(), base).impact).toBe(buybackImpactBps(LAMPORTS / 2n, sqrtPriceOf(0.00001, 6), 100, 10_000n * LAMPORTS));
  });

  it("an unknown pool depth says the totals are an upper bound", () => {
    const r = run(settings, { ...base, poolSol: null });
    expect(r.assumptions.join(" ").toLowerCase()).toMatch(/upper bound|no price impact|most it could/);
    expect(run(settings, base).assumptions.length).toBeGreaterThan(0);
  });

  it("the reference starts at the migration price (review U4): from half the spot price, buybacks wait for it to rise", () => {
    const atSpot = run({ ...settings, days: 1 }, base);
    const below = run({ ...settings, days: 1 }, { ...base, refPrice: base.startPrice / 2 });
    expect(atSpot.steps[0]?.refPrice).toBeCloseTo(0.00001, 9);
    const first = (t: typeof atSpot): number => Math.min(...t.steps.flatMap((s) => s.runs.map((r) => r.time)));
    expect(first(atSpot) - base.startTime).toBeLessThan(3600);
    // About 14 hours at 5% an hour before a 3% premium covers the spot price.
    expect(below.totals.runs).toBeLessThan(atSpot.totals.runs);
    if (below.totals.runs > 0) expect(first(below) - base.startTime).toBeGreaterThan(10 * 3600);
  });

  it("price paths are deterministic and start at the start price; a bad fee input is a plain message", () => {
    for (const p of ["flat", "up", "down", "swing"] as const) expect(pricePath(p, 2, 0)).toBeCloseTo(2, 9);
    expect(pricePath("up", 1, 2)).toBeCloseTo(1.03 ** 2, 9);
    const r = runSimulation(premium3(), { ...settings, feesPerDay: Number.NaN }, base);
    expect("error" in r && r.error).toMatch(/SOL the treasury earns/);
  });
});

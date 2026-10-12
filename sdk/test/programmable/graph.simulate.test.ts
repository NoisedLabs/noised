/**
 * The treasury simulator: accounting identities, budgets and run limits,
 * graduation, the operator's bounds, the buyback price guard as the program
 * applies it (observations, the 5%-an-hour reference, min(reference, lowest
 * observed)), the pool's fee and depth as explicit inputs (review U4 / U5),
 * determinism. Every timeline is also replayed through an independent chain
 * model in sim.differential.test.ts.
 */
import { describe, expect, it } from "vitest";

import {
  GRAPH_TEMPLATES,
  after,
  buybackBurn,
  burn,
  distributeSol,
  every,
  graph,
  graphTemplate,
  minPremiumForFee,
  onGraduation,
  simulateGraph,
  when,
  whenever,
} from "../../src/programmable/index.js";
import type { Graph, GraphTimeline, SimulateGraphOptions } from "../../src/programmable/index.js";
import { ka, randGraph, Rng } from "./helpers.js";

const SOL = 1_000_000_000n;
const HOUR = 3_600;
const sumRuns = (tl: GraphTimeline, f: (r: GraphTimeline["steps"][number]["runs"][number]) => bigint): bigint =>
  tl.steps.reduce((a, s) => a + s.runs.reduce((b, r) => b + f(r), 0n), 0n);
const runs = (tl: GraphTimeline): GraphTimeline["steps"][number]["runs"] => tl.steps.flatMap((s) => s.runs);

/** The market every test states explicitly: the migration price, a 1% pool fee, no price impact unless given. */
const M = { migrationPrice: 0.000001, poolFeeBps: 100, poolSol: "none" } as const satisfies Partial<SimulateGraphOptions>;

const daily = graph()
  .recipient(ka(1), "70%", "team")
  .recipient(ka(2), "30%", "dao")
  .node("buyback", every("1d"), when.treasurySolGte(0.5), buybackBurn({ maxIn: 0.5, maxPremiumBps: 300 }), { budgetPerEpoch: 1 })
  .node("burn-rest", after("buyback"), when.treasuryTokensGte(1), burn(1_000_000))
  .node("share", every("6h"), null, distributeSol(0.1), { budgetPerEpoch: 0.3 })
  .build();

describe("simulateGraph: accounting", () => {
  const opts: SimulateGraphOptions = {
    ...M,
    poolSol: 80,
    epochs: 30,
    initialTreasury: { sol: 2, tokens: 5_000_000 },
    feeInflowFn: (s: number) => (s % 3 === 0 ? 1.5 : 0.25),
    priceFn: (s: number, t: number) => 0.000001 * (1 + 0.1 * Math.sin(s / 3 + t / 1e6)),
  };
  const tl = simulateGraph(daily, opts);

  it("SOL in = SOL out: start + inflows = end + buybacks + distributions + tips (exact)", () => {
    const inflow = Array.from({ length: 30 }, (_, s) => (s % 3 === 0 ? 1_500_000_000n : 250_000_000n)).reduce((a, b) => a + b, 0n);
    expect(2n * SOL + inflow).toBe(tl.final.treasurySol + tl.totals.solSpent + tl.totals.distributed + tl.totals.tips);
  });

  it("every token bought back is burned in the same run, never less than the program's minimum; supply falls by exactly what is burned", () => {
    for (const r of runs(tl)) {
      if (r.action !== "buybackBurn") continue;
      expect(r.burned).toBe(r.tokensBought);
      expect(r.tokensBought).toBeGreaterThanOrEqual(r.minOut!);
    }
    expect(1_000_000_000n * 1_000_000n - tl.final.supply).toBe(tl.totals.burned);
    expect(tl.totals.burned).toBe(sumRuns(tl, (r) => r.burned));
    // treasury tokens only ever decrease by burns (no token ever leaves to anyone)
    expect(5_000_000n * 1_000_000n - tl.final.treasuryTokens).toBe(sumRuns(tl, (r) => (r.action === "burn" ? r.burned : 0n)));
  });

  it("distributions pay only the declared recipients, by share (floored, the dust stays)", () => {
    for (const r of runs(tl)) {
      if (r.action !== "distributeSol") continue;
      expect(r.paid.map((p) => p.address)).toEqual([ka(1), ka(2)]);
      expect(r.paid.reduce((a, p) => a + p.lamports, 0n)).toBe(r.amount);
      expect(r.paid[0]!.lamports * 3n).toBeLessThanOrEqual(r.paid[1]!.lamports * 7n + 7n);
    }
  });

  it("budgets and run limits hold in every epoch; tips are at most a tenth of what a run moved", () => {
    const per = new Map<string, { runs: number; spent: bigint }>();
    for (const r of runs(tl)) {
      const node = daily.nodes[r.nodeIndex]!;
      const key = `${r.node}@${r.time - (r.time % node.epochSecs)}`;
      const e = per.get(key) ?? { runs: 0, spent: 0n };
      e.runs++;
      e.spent += r.amount;
      per.set(key, e);
      expect(r.amount).toBeLessThanOrEqual(node.action.kind === "buybackBurn" ? node.action.maxInLamports : node.action.kind === "burn" ? node.action.maxTokens : node.action.maxLamports);
      expect(e.runs).toBeLessThanOrEqual(node.maxRunsPerEpoch);
      expect(e.spent).toBeLessThanOrEqual(node.budgetPerEpoch);
      expect(r.tip).toBeLessThanOrEqual(100_000n);
      if (r.action !== "burn") expect(r.tip * 10n).toBeLessThanOrEqual(r.amount);
    }
    expect(tl.totals.runs).toBeGreaterThan(30);
  });

  it("AFTER nodes run in the same tick, right after their parent", () => {
    for (const s of tl.steps) {
      s.runs.forEach((r, i) => {
        if (r.node === "burn-rest") expect(s.runs.slice(0, i).some((p) => p.node === "buyback" && p.time === r.time)).toBe(true);
      });
    }
  });

  it("is deterministic, and states its assumptions", () => {
    expect(simulateGraph(daily, opts)).toEqual(tl);
    expect(tl.assumptions.join(" ")).toMatch(/1% fee/);
    expect(tl.assumptions.join(" ")).toMatch(/migration price/);
    expect(simulateGraph(daily, { ...opts, poolSol: "none" }).assumptions.join(" ")).toMatch(/upper bound/);
  });
});

describe("simulateGraph: behaviour", () => {
  it("an every-6h node runs 4 times a day", () => {
    const g = graph().node("b", every("6h"), null, burn(1)).build();
    const tl = simulateGraph(g, { ...M, epochs: 3, initialTreasury: { tokens: 1_000 } });
    expect(tl.steps.map((s) => s.runs.length)).toEqual([4, 4, 4]);
  });

  it("no buyback before graduation; on-graduation fires once at graduation; the first buyback waits for a price check a minute old", () => {
    const g = graph()
      .node("buy", every("1d"), null, buybackBurn({ maxIn: 0.1 }))
      .node("grad", onGraduation(), null, burn(100))
      .build();
    const tl = simulateGraph(g, { ...M, epochs: 6, graduatedAtStep: 3, initialTreasury: { sol: 5, tokens: 1_000 } });
    expect(tl.steps.slice(0, 3).every((s) => s.runs.length === 0)).toBe(true);
    expect(tl.steps[0]!.blocked.map((b) => b.reason)).toContain("notGraduated");
    const day3 = tl.steps[3]!;
    expect(day3.runs.map((r) => r.node).sort()).toEqual(["buy", "grad"]);
    expect(day3.runs.find((r) => r.node === "grad")!.time).toBe(day3.time);
    expect(day3.runs.find((r) => r.node === "buy")!.time).toBe(day3.time + 600); // the next keeper check
    expect(day3.blocked.map((b) => b.reason)).toContain("notObserved");
    expect(runs(tl).filter((r) => r.node === "grad")).toHaveLength(1);
  });

  it("the operator acts only within bounds: its amount is capped, null skips, keepers never run gated nodes", () => {
    const g = graph({ operator: ka(9) })
      .node("ai", whenever(), when.graduated(), buybackBurn({ maxIn: 0.25 }), { operatorGated: true, budgetPerEpoch: 1, maxRunsPerEpoch: 8 })
      .build();
    const greedy = simulateGraph(g, { ...M, epochs: 3, initialTreasury: { sol: 100 }, operator: () => 1_000 });
    expect(greedy.totals.runs).toBeGreaterThan(0);
    for (const s of greedy.steps) {
      expect(s.runs.every((r) => r.by === "operator" && r.amount <= 250_000_000n && r.amountArg === r.amount)).toBe(true);
      expect(s.solSpent).toBeLessThanOrEqual(SOL);
    }
    const idle = simulateGraph(g, { ...M, epochs: 3, initialTreasury: { sol: 100 }, operator: () => null });
    expect(idle.totals.runs).toBe(0);
    const picky = simulateGraph(g, { ...M, epochs: 2, initialTreasury: { sol: 100 }, operator: (q) => (q.price < 0.0000009 ? "max" : 0.01) });
    expect(runs(picky).length).toBeGreaterThan(0);
    expect(runs(picky).every((r) => r.amount === 10_000_000n)).toBe(true);
  });

  it("the buyback price guard refuses spikes above the bound + premium until the reference catches up (5% an hour)", () => {
    const g = graph().node("buy", every("1h"), null, buybackBurn({ maxIn: 0.1, maxPremiumBps: 300 }), { maxRunsPerEpoch: 24, budgetPerEpoch: 10 }).build();
    // day 0 at the migration price; day 1 the price doubles
    const tl = simulateGraph(g, { ...M, epochs: 2, initialTreasury: { sol: 100 }, priceFn: (s) => (s === 0 ? 0.000001 : 0.000002) });
    expect(tl.steps[0]!.runs.length).toBe(24);
    const day1 = tl.steps[1]!;
    expect(day1.blocked.map((b) => b.reason)).toContain("priceAboveRef");
    expect(day1.runs.length).toBeGreaterThan(0);
    expect(day1.runs.length).toBeLessThan(12);
    // ln(2 / (0.99 * 1.03)) / ln(1.0498) = 14 hours of rises, one of them banked, plus the old observations leaving the window.
    for (const r of day1.runs) expect(r.time - day1.time).toBeGreaterThanOrEqual(13 * HOUR);
  });

  it("review U4: a steady rally (2.5% per 10 minutes) gets at most what the program allows, not a buyback every tick", () => {
    // The old model moved the reference 5% after every buyback and showed 18 buybacks in 3 hours.
    const g = graph().node("buy", every("10m"), null, buybackBurn({ maxIn: 0.1, maxPremiumBps: 300 }), { maxRunsPerEpoch: 144, budgetPerEpoch: 100 }).build();
    const start = 1_798_761_600;
    const tl = simulateGraph(g, { ...M, epochs: 1, stepSecs: 3 * HOUR, initialTreasury: { sol: 100 }, priceFn: (_s, t) => 0.000001 * 1.025 ** ((t - start) / 600) });
    expect(tl.totals.runs).toBeLessThanOrEqual(1);
    expect(tl.steps[0]!.blocked.map((b) => b.reason).some((r) => r === "priceAboveRef" || r === "swapShortfall")).toBe(true);
  });

  it("review U4: after a sudden 20% jump buybacks resume once the reference has followed (the old model blocked forever)", () => {
    const g = graph().node("buy", every("1h"), null, buybackBurn({ maxIn: 0.1, maxPremiumBps: 300 }), { maxRunsPerEpoch: 24, budgetPerEpoch: 10 }).build();
    const start = 1_798_761_600;
    const jump = start + 2 * HOUR;
    const tl = simulateGraph(g, { ...M, epochs: 1, initialTreasury: { sol: 100 }, priceFn: (_s, t) => (t < jump ? 0.000001 : 0.0000012) });
    const before = runs(tl).filter((r) => r.time < jump);
    const afterJump = runs(tl).filter((r) => r.time >= jump);
    expect(before.length).toBe(2);
    expect(afterJump.length).toBeGreaterThan(10);
    // ln(1.2 / (0.99 * 1.03)) / ln(1.0498) = 3.4 hours of rises, one of them banked.
    const first = afterJump[0]!.time - jump;
    expect(first).toBeGreaterThanOrEqual(2 * HOUR);
    expect(first).toBeLessThanOrEqual(5 * HOUR);
    expect(afterJump[0]!.refPrice).toBeGreaterThan(0.00000115);
  });

  it("review U5: the pool fee is an input; a premium below fee / (1 - fee) never buys back, at any amount", () => {
    const ai = graphTemplate("ai-buyback", { operator: ka(4) }); // premium 200 bps
    const dailyT = graphTemplate("daily-buyback-burn"); // premium 300 bps
    const sim = (g: Graph, fee: number): GraphTimeline => simulateGraph(g, { ...M, poolFeeBps: fee, poolSol: 500, epochs: 4, initialTreasury: { sol: 50 } });
    expect(sim(ai, 100).totals.runs).toBeGreaterThan(0);
    const turbo = sim(ai, 200); // migration fee option 3 (2%)
    expect(turbo.totals.runs).toBe(0);
    expect(turbo.steps.flatMap((s) => s.blocked.map((b) => b.reason))).toContain("premiumBelowFee");
    expect(sim(dailyT, 100).totals.runs).toBeGreaterThan(0);
    expect(sim(dailyT, 400).totals.runs).toBe(0);
    expect(minPremiumForFee(100)).toBe(102);
    expect(minPremiumForFee(200)).toBe(205);
    expect(minPremiumForFee(400)).toBe(417);
  });

  it("price impact: a buyback too large for the pool runs smaller, down to 1% of the pool's SOL, and always fills", () => {
    const g = graph().node("buy", every("1d"), null, buybackBurn({ maxIn: 10, maxPremiumBps: 300 }), { budgetPerEpoch: 10 }).build();
    const tl = simulateGraph(g, { ...M, poolSol: 50, epochs: 3, initialTreasury: { sol: 100 } });
    const rs = runs(tl);
    // Audit 4, A4-2: keepers move the day's 10 SOL in partial buybacks (the node stays due), then complete the run: one run a day.
    expect(rs.filter((r) => !r.partial)).toHaveLength(3);
    expect(rs.length).toBeGreaterThan(3);
    for (let day = 0; day < 3; day++) {
      const today = rs.filter((r) => r.step === day);
      expect(today.reduce((a, r) => a + r.amount, 0n)).toBe(10n * SOL);
      expect(today.at(-1)!.partial).toBe(false);
      expect(today.slice(0, -1).every((r) => r.partial)).toBe(true);
    }
    for (const r of rs) {
      expect(r.amount).toBeLessThan(10n * SOL);
      expect(r.amount).toBeGreaterThanOrEqual(SOL / 2n); // the keeper's floor: 1% of 50 SOL
      expect(r.amountArg === null || r.amountArg === r.amount).toBe(true);
      expect(r.tokensBought).toBeGreaterThanOrEqual(r.minOut!);
      // A partial buyback's tip is its share of one tip: TIP_LAMPORTS * amount / p1.
      if (r.partial) expect(r.tip).toBe((100_000n * r.amount) / (10n * SOL));
    }
    // A pool too shallow for even the floor: nothing runs, and the timeline says why.
    const shallow = graph().node("buy", every("1d"), null, buybackBurn({ maxIn: 10, maxPremiumBps: 110 }), { budgetPerEpoch: 10 }).build();
    const none = simulateGraph(shallow, { ...M, poolSol: 0.01, epochs: 2, initialTreasury: { sol: 100 } });
    expect(none.totals.runs).toBe(0);
    expect(none.steps[0]!.blocked.map((b) => b.reason)).toContain("swapShortfall");
  });

  it("an operator's amount the pool cannot fill is refused, as the program refuses it (SwapShortfall)", () => {
    const g = graph({ operator: ka(9) })
      .node("ai", whenever(), when.graduated(), buybackBurn({ maxIn: 5, maxPremiumBps: 300 }), { operatorGated: true, budgetPerEpoch: 10, maxRunsPerEpoch: 8 })
      .build();
    const greedy = simulateGraph(g, { ...M, poolSol: 10, epochs: 1, initialTreasury: { sol: 100 }, operator: () => "max" });
    expect(greedy.totals.runs).toBe(0);
    expect(greedy.steps[0]!.blocked.map((b) => b.reason)).toContain("swapShortfall");
    const fit = simulateGraph(g, { ...M, poolSol: 10, epochs: 1, initialTreasury: { sol: 100 }, operator: () => "fillable" });
    expect(fit.totals.runs).toBeGreaterThan(0);
    for (const r of runs(fit)) {
      expect(r.amount).toBeLessThan(5n * SOL);
      expect(r.tokensBought).toBeGreaterThanOrEqual(r.minOut!);
    }
  });

  it("the reference price rises at most 5% an hour (one hour banked) and falls at once", () => {
    const g = graph().node("buy", every("1h"), null, buybackBurn({ maxIn: 0.01, maxPremiumBps: 2_000 }), { maxRunsPerEpoch: 24, budgetPerEpoch: 1 }).build();
    const tl = simulateGraph(g, { ...M, epochs: 3, initialTreasury: { sol: 10 }, priceFn: (s) => 0.000001 * (1 + s * 0.15) });
    let prev: { time: number; ref: number } | null = null;
    for (const r of runs(tl)) {
      if (prev !== null) {
        const hours = (r.time - prev.time) / HOUR + 1;
        expect(r.refPrice / prev.ref).toBeLessThanOrEqual(Math.exp(2 * 0.0243 * hours) + 1e-9);
      }
      prev = { time: r.time, ref: r.refPrice };
    }
    const fall = simulateGraph(g, { ...M, epochs: 2, initialTreasury: { sol: 10 }, priceFn: (s) => (s === 0 ? 0.000001 : 0.0000005) });
    expect(fall.final.refPrice).toBeCloseTo(0.0000005, 9);
  });

  it("every template simulates without errors on a realistic pool", () => {
    for (const t of GRAPH_TEMPLATES) {
      const g: Graph = graphTemplate(t.id, t.id === "revenue-share" ? { recipients: [{ address: ka(3), share: "100%" }] } : t.id === "ai-buyback" ? { operator: ka(4) } : {});
      const tl = simulateGraph(g, { ...M, poolSol: 200, epochs: 10, initialTreasury: { sol: 10, tokens: 10_000_000 }, feeInflowFn: () => 1 });
      expect(tl.totals.runs).toBeGreaterThan(0);
    }
  });

  it("random graphs keep the SOL identity and never pay anyone undeclared", () => {
    const rng = new Rng(0x53494d31);
    for (let i = 0; i < 40; i++) {
      const g = randGraph(rng);
      const declared = new Set(g.recipients.map((r) => r.address));
      const sol0 = BigInt(rng.range(0, 50)) * SOL;
      const tl = simulateGraph(g, {
        ...M,
        poolSol: rng.pick([20, 500, "none"] as const),
        poolFeeBps: rng.pick([25, 100, 400]),
        epochs: 8,
        stepSecs: 21_600,
        tickSecs: 1_800,
        initialTreasury: { sol: sol0, tokens: rng.range(0, 1_000_000) },
        feeInflowFn: () => 0.5,
        graduatedAtStep: rng.pick([0, 2, null]),
        priceFn: (s) => 0.000001 * (1 + 0.05 * s),
      });
      expect(sol0 + 8n * (SOL / 2n)).toBe(tl.final.treasurySol + tl.totals.solSpent + tl.totals.distributed + tl.totals.tips);
      for (const r of runs(tl)) for (const p of r.paid) expect(declared.has(p.address)).toBe(true);
      expect(tl.final.treasurySol).toBeGreaterThanOrEqual(0n);
      expect(tl.final.treasuryTokens).toBeGreaterThanOrEqual(0n);
    }
  });
});

/** Autopilot runtime rules (mirroring the crate's due / current_epoch / run_cap / shares) and the keeper view. */
import { describe, expect, it } from "vitest";

import {
  after,
  buybackBurn,
  burn,
  compiledGraph,
  currentEpoch,
  distributeSol,
  every,
  findDueNodes,
  graph,
  graphShares,
  newAutopilotState,
  nodeDue,
  nodeStatus,
  observePrice,
  onGraduation,
  priceAboveRef,
  recordRun,
  runCap,
  shares,
  runValue,
  takeTip,
  when,
  whenever,
} from "../../src/programmable/index.js";
import type { AutopilotEnv, Graph, NodeRuntime } from "../../src/programmable/index.js";
import { ACTION, TRIGGER, gnode, graphProg, ka, kb } from "./helpers.js";

const T0 = 1_800_000_000;
/** The reference every model state starts at (on chain: the launch's migration price). */
const REF = 1n << 50n;
const env = (o: Partial<AutopilotEnv> = {}): AutopilotEnv => ({
  now: T0,
  treasurySol: 100_000_000_000n,
  treasuryTokens: 1_000_000_000_000n,
  graduated: true,
  spotSqrtPriceQ64: 1n << 50n,
  ...o,
});
const rt = (o: Partial<NodeRuntime> = {}): NodeRuntime => ({ lastRun: 0, lastSeq: 0, epochStart: 0, runsInEpoch: 0, spentInEpoch: 0n, ...o });

describe("currentEpoch (the crate's current_epoch)", () => {
  it("keeps the stored epoch inside it and before it", () => {
    expect(currentEpoch(100, rt({ epochStart: 1_000, runsInEpoch: 3, spentInEpoch: 7n }), 1_099)).toEqual({ start: 1_000, runs: 3, spent: 7n });
    expect(currentEpoch(100, rt({ epochStart: 1_000, runsInEpoch: 3 }), 900)).toMatchObject({ start: 1_000, runs: 3 });
  });
  it("rolls over to the latest start + k * len <= now (aligned to the first epoch)", () => {
    expect(currentEpoch(100, rt({ epochStart: 1_000, runsInEpoch: 3, spentInEpoch: 7n }), 1_100)).toEqual({ start: 1_100, runs: 0, spent: 0n });
    expect(currentEpoch(100, rt({ epochStart: 1_000, runsInEpoch: 3 }), 1_357)).toEqual({ start: 1_300, runs: 0, spent: 0n });
    expect(currentEpoch(86_400, rt(), 1_800_000_123)).toEqual({ start: 1_800_000_123 - (1_800_000_123 % 86_400), runs: 0, spent: 0n });
  });
});

describe("nodeDue (the crate's Graph::due)", () => {
  const g: Graph = graph()
    .node("tick", every("1h"), null, burn(1), { epoch: "1d", maxRunsPerEpoch: 3, budgetPerEpoch: 2_500_000n })
    .node("next", after("tick"), null, burn(1), { maxRunsPerEpoch: 5 })
    .node("grad", onGraduation(), null, burn(1))
    .node("cond", whenever(), when.treasurySolGte(5), burn(1))
    .build();
  const cg = compiledGraph(g);

  it("EVERY: due if never ran, waits secs after the last run, due again exactly then", () => {
    const s = newAutopilotState(g, REF);
    expect(nodeDue(cg, s, 0, T0, true)).toBeNull();
    recordRun(g, s, 0, T0, 1n);
    expect(nodeDue(cg, s, 0, T0 + 3_599, true)).toBe("Waiting");
    expect(nodeDue(cg, s, 0, T0 + 3_600, true)).toBeNull();
  });

  it("AFTER: once per parent success, by run sequence (works within one second)", () => {
    const s = newAutopilotState(g, REF);
    expect(nodeDue(cg, s, 1, T0, true)).toBe("AwaitingParent");
    recordRun(g, s, 0, T0, 1n);
    expect(nodeDue(cg, s, 1, T0, true)).toBeNull();
    recordRun(g, s, 1, T0, 1n);
    expect(nodeDue(cg, s, 1, T0, true)).toBe("AwaitingParent");
    // the parent succeeds again in the same second: the child is due again
    s.nodes[0]!.lastRun = 0; // let the EVERY parent run again immediately for this check
    recordRun(g, s, 0, T0, 1n);
    expect(nodeDue(cg, s, 1, T0, true)).toBeNull();
  });

  it("ON_GRADUATED: AlreadyRan wins over NotGraduated; due once after graduation", () => {
    const s = newAutopilotState(g, REF);
    expect(nodeDue(cg, s, 2, T0, false)).toBe("NotGraduated");
    expect(nodeDue(cg, s, 2, T0, true)).toBeNull();
    recordRun(g, s, 2, T0, 1n);
    expect(nodeDue(cg, s, 2, T0 + 1, false)).toBe("AlreadyRan");
    expect(nodeDue(cg, s, 2, T0 + 1, true)).toBe("AlreadyRan");
  });

  it("then max runs, then budget, per epoch; both reset in the next epoch", () => {
    const s = newAutopilotState(g, REF);
    const day = T0 - (T0 % 86_400);
    for (let k = 0; k < 2; k++) recordRun(g, s, 0, day + k * 3_600, 1_000_000n);
    expect(nodeDue(cg, s, 0, day + 2 * 3_600, true)).toBeNull();
    recordRun(g, s, 0, day + 2 * 3_600, 1_000_000n);
    expect(nodeDue(cg, s, 0, day + 3 * 3_600, true)).toBe("MaxRunsReached");
    expect(nodeDue(cg, s, 0, day + 86_400, true)).toBeNull();
    const s2 = newAutopilotState(g, REF);
    recordRun(g, s2, 0, day, 2_500_000n);
    expect(nodeDue(cg, s2, 0, day + 3_600, true)).toBe("BudgetSpent");
  });

  it("WHEN: the condition alone (checked after the limits)", () => {
    const s = newAutopilotState(g, REF);
    expect(nodeStatus(g, s, env({ treasurySol: 4_999_999_999n }), 3)).toMatchObject({ due: false, notDue: "ConditionFalse", reason: "condition" });
    expect(nodeStatus(g, s, env({ treasurySol: 5_000_000_000n }), 3)).toMatchObject({ due: true });
  });
});

describe("runCap / shares / tips", () => {
  it("runCap = min(budget left this epoch, p1)", () => {
    const g = graph().node("b", every("1h"), null, burn(3), { budgetPerEpoch: 10_000_000n, maxRunsPerEpoch: 9 }).build();
    const cg = compiledGraph(g);
    const s = newAutopilotState(g, REF);
    expect(runCap(cg, s, 0, T0)).toBe(3_000_000n);
    recordRun(g, s, 0, T0, 8_000_000n);
    expect(runCap(cg, s, 0, T0 + 10)).toBe(2_000_000n);
    expect(runCap(cg, s, 0, T0 + 86_400)).toBe(3_000_000n);
  });

  it("shares floor each recipient's part; the dust stays", () => {
    const g = graph()
      .recipient(ka(1), 3_333)
      .recipient(ka(2), 3_333)
      .recipient(ka(3), 3_334)
      .node("d", every("1d"), null, distributeSol(1))
      .build();
    const s = shares(g, 100n);
    expect(s).toEqual([33n, 33n, 33n]);
    expect(100n - s.reduce((a, b) => a + b, 0n)).toBe(1n);
  });

  it("graphShares: a share that does not fit a u64 (unverified bps) is 0, as the crate", () => {
    // Only Graph::parse accepts recipients like these (the verifier needs bps summing to 10,000).
    const raw = graphProg(null, [[kb(1), 0xffff], [kb(2), 10_001], [kb(3), 10_000]], [[gnode(TRIGGER.EVERY, 600, ACTION.DISTRIBUTE_SOL, 1, 0), []]]);
    const MAX = (1n << 64n) - 1n;
    expect(graphShares(raw, MAX)).toEqual([0n, 0n, MAX, 0n, 0n, 0n, 0n, 0n]);
    expect(graphShares(raw, 10_000n)).toEqual([65_535n, 10_001n, 10_000n, 0n, 0n, 0n, 0n, 0n]);
    // the largest amount whose 65535-bps share still fits, and the next one
    const edge = ((MAX + 1n) * 10_000n - 1n) / 65_535n;
    expect(graphShares(raw, edge)[0]).toBe((edge * 65_535n) / 10_000n);
    expect(graphShares(raw, edge + 1n)[0]).toBe(0n);
  });

  it("tips: per run, capped per tip epoch, never more than the treasury holds", () => {
    const g = graph().node("b", every("1d"), null, burn(1)).build();
    const s = newAutopilotState(g, REF);
    const tip = { lamports: 100n, epochCap: 250n, epochSecs: 1_000 };
    const big = 10_000n;
    expect(takeTip(s, 5_000, 10_000n, big, tip)).toBe(100n);
    expect(takeTip(s, 5_001, 10_000n, big, tip)).toBe(100n);
    expect(takeTip(s, 5_002, 10_000n, big, tip)).toBe(50n);
    expect(takeTip(s, 5_003, 10_000n, big, tip)).toBe(0n);
    expect(takeTip(s, 6_000, 30n, big, tip)).toBe(30n);
    // A clock that steps back does not reopen an old tip epoch.
    expect(takeTip(s, 5_500, 10_000n, big, tip)).toBe(100n);
    expect(s.tipEpochStart).toBe(6_000);
  });

  it("tips: at most a tenth of what the run moved (the program's dust guard)", () => {
    const g = graph().node("b", every("1d"), null, burn(1)).build();
    const s = newAutopilotState(g, REF);
    expect(takeTip(s, T0, 10n ** 12n, 0n)).toBe(0n);
    expect(takeTip(s, T0, 10n ** 12n, 9n)).toBe(0n);
    expect(takeTip(s, T0, 10n ** 12n, 123_456n)).toBe(12_345n);
    expect(takeTip(s, T0, 10n ** 12n, 10n ** 9n)).toBe(100_000n);
    // A dust burn (one raw token below a lamport) earns nothing.
    expect(takeTip(s, T0, 10n ** 12n, runValue(ACTION.BURN, 1n, 1n << 60n))).toBe(0n);
    expect(runValue(ACTION.BURN, 1_000n, 1n << 64n)).toBe(1_000n);
    expect(runValue(ACTION.BURN, 1_000n, 1n << 63n)).toBe(250n); // a quarter lamport per raw token
    expect(runValue(ACTION.DISTRIBUTE_SOL, 1_000n, 1n << 63n)).toBe(1_000n);
    expect(runValue(ACTION.BUYBACK_BURN, 7n, 1n)).toBe(7n);
  });
});

describe("nodeStatus: program-side checks the keeper sees", () => {
  const g = graph()
    .node("buy", every("1d"), null, buybackBurn({ maxIn: 2, maxPremiumBps: 300 }), { budgetPerEpoch: 3 })
    .node("price", whenever(), when.priceLte(1n << 40n), burn(1))
    .build();

  it("buybacks need graduation; empty treasuries can't run; amount = min(p1, budget, balance)", () => {
    const s = newAutopilotState(g, REF);
    observePrice(s, T0 - 60, 1n << 50n);
    expect(nodeStatus(g, s, env({ graduated: false }), 0)).toMatchObject({ due: false, reason: "notGraduated" });
    expect(nodeStatus(g, s, env({ treasurySol: 0n }), 0)).toMatchObject({ due: false, reason: "empty" });
    expect(nodeStatus(g, s, env({ treasurySol: 1_500_000_000n }), 0)).toMatchObject({ due: true, maxAmount: 1_500_000_000n });
    expect(nodeStatus(g, s, env(), 0)).toMatchObject({ due: true, maxAmount: 2_000_000_000n });
  });

  it("buybacks need a price check a minute old (the program's observation window)", () => {
    const s = newAutopilotState(g, REF);
    expect(nodeStatus(g, s, env(), 0)).toMatchObject({ due: false, reason: "notObserved" });
    observePrice(s, T0 - 59, 1n << 50n);
    expect(nodeStatus(g, s, env(), 0)).toMatchObject({ due: false, reason: "notObserved" });
    expect(nodeStatus(g, s, env({ now: T0 + 1 }), 0)).toMatchObject({ due: true });
    // 15 to 30 minutes later the window is gone.
    const bucket = Math.floor((T0 - 59) / 900);
    expect(nodeStatus(g, s, env({ now: (bucket + 2) * 900 }), 0)).toMatchObject({ due: false, reason: "notObserved" });
  });

  it("a keeper may size a buyback down to 1% of the pool's SOL", () => {
    const s = newAutopilotState(g, REF);
    observePrice(s, T0 - 60, 1n << 50n);
    expect(nodeStatus(g, s, env({ poolSol: 10_000_000_000n }), 0)).toMatchObject({ due: true, maxAmount: 2_000_000_000n, minAmount: 100_000_000n });
    expect(nodeStatus(g, s, env({ poolSol: 10n ** 12n }), 0)).toMatchObject({ minAmount: 2_000_000_000n });
    expect(nodeStatus(g, s, env({ poolSol: 5n }), 0)).toMatchObject({ minAmount: 1n });
    expect(nodeStatus(g, s, env(), 0)).toMatchObject({ minAmount: 2_000_000_000n });
  });

  it("refuses a buyback when spot is above the bound + premium (exact on prices)", () => {
    const s = newAutopilotState(g, REF);
    const r = 1n << 70n;
    s.refSqrtPriceQ64 = r;
    observePrice(s, T0 - 60, r);
    // price ratio (spot/ref)^2 must be <= 1.03
    expect(priceAboveRef(1_014_889n, 1_000_000n, 300)).toBe(false); // 1.0300... ratio^2 = 1.029999...
    expect(priceAboveRef(1_014_890n, 1_000_000n, 300)).toBe(true);
    expect(nodeStatus(g, s, env({ spotSqrtPriceQ64: r + (r / 1_000_000n) * 14_889n }), 0)).toMatchObject({ due: true });
    expect(nodeStatus(g, s, env({ spotSqrtPriceQ64: r + (r / 1_000_000n) * 14_890n }), 0)).toMatchObject({ due: false, reason: "priceAboveRef" });
    expect(nodeStatus(g, s, env({ spotSqrtPriceQ64: (r * 9n) / 10n }), 0)).toMatchObject({ due: true });
  });

  it("before graduation the run observes nothing (there is no pool): the reference follows only real observations", () => {
    const r = 1n << 60n;
    const cond = graph()
      .node("cheap", whenever(), when.priceLte((r * 95n) / 100n), burn(1))
      .build();
    const s = newAutopilotState(cond, REF);
    s.refSqrtPriceQ64 = r;
    observePrice(s, T0 - 600, (r * 9n) / 10n); // every observation below the reference
    // Not graduated, a curve price far above: not an observation, so the reference falls to what was observed.
    expect(nodeStatus(cond, s, env({ graduated: false, spotSqrtPriceQ64: r * 2n }), 0)).toMatchObject({ due: true });
    // Graduated: the run's own observation (2x) straddles the reference, which then stays.
    expect(nodeStatus(cond, s, env({ graduated: true, spotSqrtPriceQ64: r * 2n }), 0)).toMatchObject({ due: false, reason: "condition" });
  });

  it("price conditions read the reference price, not spot", () => {
    const s = newAutopilotState(g, REF);
    expect(nodeStatus(g, s, env({ spotSqrtPriceQ64: 1n << 41n }), 1).due).toBe(false);
    s.refSqrtPriceQ64 = 1n << 39n;
    expect(nodeStatus(g, s, env({ spotSqrtPriceQ64: 1n << 41n }), 1).due).toBe(true);
  });

  it("a fall anyone observed bounds the buyback, whatever the reference says", () => {
    const s = newAutopilotState(g, REF);
    const r = 1n << 70n;
    s.refSqrtPriceQ64 = r;
    observePrice(s, T0 - 600, r);
    observePrice(s, T0 - 60, (r * 7_071n) / 10_000n); // the market halved
    expect(s.refSqrtPriceQ64).toBe(r); // a window straddling the reference moves nothing
    // Pumped back to the reference: refused, though within 3% of the reference.
    expect(nodeStatus(g, s, env({ spotSqrtPriceQ64: r }), 0)).toMatchObject({ due: false, reason: "priceAboveRef" });
    expect(nodeStatus(g, s, env({ spotSqrtPriceQ64: (r * 7_071n) / 10_000n }), 0)).toMatchObject({ due: true });
  });

  it("findDueNodes lists exactly the runnable nodes", () => {
    const s = newAutopilotState(g, REF);
    observePrice(s, T0 - 60, 1n << 48n);
    expect(findDueNodes(g, s, env({ spotSqrtPriceQ64: 1n << 48n }))).toEqual([0]); // the reference fell to 2^48 > the price node's 2^40
    s.refSqrtPriceQ64 = 1n << 39n;
    s.observations = [];
    expect(findDueNodes(g, s, env({ spotSqrtPriceQ64: 1n << 48n }))).toEqual([1]); // no window yet: no buyback
    observePrice(s, T0, 1n << 39n);
    expect(findDueNodes(g, s, env({ now: T0 + 60, spotSqrtPriceQ64: 1n << 39n }))).toEqual([1]); // 2^39 prices no tokens for 2 SOL
    recordRun(g, s, 1, T0 + 60, 1_000_000n);
    expect(findDueNodes(g, s, env({ now: T0 + 61, spotSqrtPriceQ64: 1n << 39n }))).toEqual([]); // one run per epoch
    expect(nodeStatus(g, s, env({ now: T0 + 60, spotSqrtPriceQ64: 1n << 39n }), 0)).toMatchObject({ due: false, reason: "priceOutOfRange", error: "PriceOutOfRange" });
  });

  it("RUNS_IN_EPOCH_LT reads the other node's current epoch", () => {
    const h = graph()
      .node("a", every("1h"), null, burn(1), { maxRunsPerEpoch: 10 })
      .node("b", whenever(), when.runsInEpochLt("a", 2), burn(1), { maxRunsPerEpoch: 10 })
      .build();
    const s = newAutopilotState(h, REF);
    const day = T0 - (T0 % 86_400);
    recordRun(h, s, 0, day, 1n);
    expect(nodeStatus(h, s, env({ now: day + 10 }), 1).due).toBe(true);
    recordRun(h, s, 0, day + 3_600, 1n);
    expect(nodeStatus(h, s, env({ now: day + 3_700 }), 1).due).toBe(false);
    expect(nodeStatus(h, s, env({ now: day + 86_400 }), 1).due).toBe(true); // a's epoch rolled over
  });
});

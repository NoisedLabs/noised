/**
 * The simulator never shows a run the program would refuse (review U4 / U5).
 *
 * Every timeline of seeded random graphs and markets (rallies, crashes,
 * jumps, noise; pool fees from 0.25% to 6%; deep, shallow or no price
 * impact; graduation now, later or never; operators that take the most, the
 * fillable amount, a random amount or nothing) is replayed here through an
 * independent model of the chain: the `Autopilot` account's fields as
 * bigints, `update_price` at every keeper check, and each run exactly as
 * programs/noised-autopilot src/instructions/run.rs does it (observe, move
 * the reference, `plan_run`, the swap against its minimum out, `record_run`,
 * `take_tip`), using the port of the program's functions that
 * autopilot.vectors.test.ts pins to the program's own outputs. Each run the
 * simulator shows must be accepted, with the same amounts, minimum out,
 * tokens, tip and reference; balances must agree after every step; and after
 * the last run of every keeper check, no keeper-run node may still be
 * runnable (the simulator shows neither more nor fewer keeper runs).
 */
import { describe, expect, it } from "vitest";

import {
  MIGRATION_FEE_TIERS_BPS as _unused,
} from "../../src/constants.js";
import {
  addressBytes,
  burnPrice,
  buybackBurn,
  burn,
  compiledGraph,
  distributeSol,
  every,
  graph,
  keeperFloor,
  lowestObserved,
  observationWindow,
  observedPrices,
  followReference,
  planMaxTip,
  planPartial,
  planRun,
  planSpent,
  planValue,
  recordObservation,
  recordRunRaw,
  simulateGraph,
  sqrtPriceQ64ToPrice,
  takeTipRaw,
  toAddress,
  when,
  whenever,
  type Graph,
  type GraphTimeline,
  type ObsBucket,
  type PriceState,
  type RawNodeState,
  type SimulateGraphOptions,
} from "../../src/programmable/index.js";
import { ka, randGraph, Rng } from "./helpers.js";

void _unused;
const FEES = [25, 30, 100, 200, 400, 600];
const START = 1_798_761_600;

/** The simulator's price -> sqrt price conversion (the market's input), reproduced. */
const sqrtOf = (price: number, dec: number): bigint => BigInt(Math.floor(Math.sqrt((price * 1e9) / 10 ** dec) * 2 ** 64));

/** The market: a constant-product pool, the fee taken from the SOL in (written here independently of market.ts). */
function swapOut(amountIn: bigint, spot: bigint, fee: number, pool: bigint | null): bigint {
  const p = (spot * spot) >> 64n;
  if (p === 0n || p >> 128n !== 0n) return 0n;
  const net = (amountIn * BigInt(10_000 - fee)) / 10_000n;
  return pool === null ? (net << 64n) / p : ((pool << 64n) * net) / (p * (pool + net));
}

/** The chain: an `Autopilot` account, its treasury and the pool, changed only as the program's instructions change them. */
class Chain {
  price: PriceState;
  nodes: RawNodeState[] = Array.from({ length: 16 }, () => ({ lastRun: 0n, lastSeq: 0n, epochStart: 0n, runsInEpoch: 0, spentInEpoch: 0n }));
  /** `Autopilot.partial_spent`: what keepers' partial buybacks moved of each node's open run (audit 4, A4-2). */
  partialSpent: bigint[] = Array.from({ length: 16 }, () => 0n);
  seq = 0n;
  tips = { epochStart: 0n, inEpoch: 0n };
  operator: Uint8Array;
  constructor(
    readonly g: Graph,
    migration: bigint,
    public sol: bigint,
    public tokens: bigint,
    public supply: bigint,
  ) {
    this.price = { reference: migration, updatedAt: 0, allowance: 0n, allowanceAt: 0, observations: [empty(), empty()] };
    this.operator = g.operator === null ? new Uint8Array(32) : addressBytes(toAddress(g.operator));
  }
  /** update_price. */
  updatePrice(now: number, spot: bigint): void {
    recordObservation(this.price.observations, now, spot);
    followReference(this.price, observationWindow(this.price.observations, now), now);
  }
  /** run: returns the error, or what happened. */
  run(
    now: number,
    node: number,
    amount: bigint | null,
    signer: Uint8Array | null,
    market: { graduated: boolean; spot: bigint; pool: bigint | null; fee: number },
  ): { error: string } | { spent: bigint; minOut: bigint | null; out: bigint; tip: bigint; reference: bigint; paid: bigint[] } {
    const p: PriceState = { ...this.price, observations: [{ ...this.price.observations[0] }, { ...this.price.observations[1] }] };
    if (market.graduated) recordObservation(p.observations, now, market.spot);
    const seen = observationWindow(p.observations, now);
    followReference(p, seen, now);
    const r = planRun({
      graph: compiledGraph(this.g).raw,
      node,
      now: BigInt(now),
      states: this.nodes,
      operator: this.operator,
      operatorSigner: signer,
      amount,
      treasurySol: this.sol,
      treasuryToken: this.tokens,
      graduated: market.graduated,
      spot: market.graduated ? market.spot : null,
      reference: p.reference,
      seen,
      observed: observedPrices(p.observations, now),
      poolQuote: market.pool ?? 0n,
      partialSpent: this.partialSpent[node]!,
    });
    if (!r.ok) return { error: r.error };
    const plan = r.value;
    let out = 0n;
    let paid: bigint[] = [];
    if (plan.kind === "buyback") {
      out = swapOut(plan.amountIn, market.spot, market.fee, market.pool);
      if (out > this.supply) out = this.supply;
      if (out < plan.minOut) return { error: "SwapShortfall" };
      this.sol -= plan.amountIn;
      this.supply -= out;
    } else if (plan.kind === "burn") {
      this.tokens -= plan.amount;
      this.supply = this.supply > plan.amount ? this.supply - plan.amount : 0n;
    } else {
      this.sol -= plan.total;
      paid = plan.shares.slice(0, this.g.recipients.length);
    }
    this.price = p;
    const rec = recordRunRaw(this.nodes[node]!, this.seq, this.g.nodes[node]!.epochSecs, BigInt(now), planSpent(plan), {
      partial: planPartial(plan),
      partialSpent: this.partialSpent[node]!,
    });
    if (!rec.ok) return { error: rec.error };
    this.nodes[node] = rec.value.node;
    this.seq = rec.value.seq;
    this.partialSpent[node] = rec.value.partialSpent;
    // The tip (run.rs): burns valued at burn_price (none before graduation; else min(reference, lowest observed)), a partial buyback's share of one tip.
    const value = planValue(plan, burnPrice(market.graduated, p.reference, lowestObserved(p.observations, now)));
    const t = takeTipRaw(this.tips, BigInt(now), this.sol, value, planMaxTip(plan, compiledGraph(this.g).raw.nodes[node]!.p1));
    this.tips = t.counters;
    this.sol -= t.tip;
    return { spent: planSpent(plan), minOut: plan.kind === "buyback" ? plan.minOut : null, out, tip: t.tip, reference: p.reference, paid };
  }
  /** Whether a keeper could still run `node` now (some allowed amount the program accepts and the swap fills). */
  keeperCanRun(now: number, node: number, market: { graduated: boolean; spot: bigint; pool: bigint | null; fee: number }): boolean {
    const probe = (amount: bigint | null): boolean => {
      const copy = this.clone();
      return !("error" in copy.run(now, node, amount, null, market));
    };
    if (probe(null)) return true;
    if (this.g.nodes[node]!.action.kind !== "buybackBurn") return false;
    // A keeper may choose a buyback amount from max(1, min(1% of the pool, limit)) up to the limit: try the floor and a spread.
    const floor = keeperFloor(market.pool ?? 0n);
    const maxIn = this.g.nodes[node]!.action.kind === "buybackBurn" ? (this.g.nodes[node]!.action as { maxInLamports: bigint }).maxInLamports : 0n;
    const lo = floor < 1n ? 1n : floor;
    for (const a of [lo, lo * 2n, lo * 4n, (lo + maxIn) / 2n]) if (a >= 1n && probe(a)) return true;
    return false;
  }
  clone(): Chain {
    const c = Object.create(Chain.prototype) as Chain;
    Object.assign(c, this, {
      price: { ...this.price, observations: [{ ...this.price.observations[0] }, { ...this.price.observations[1] }] },
      nodes: this.nodes.map((n) => ({ ...n })),
      partialSpent: [...this.partialSpent],
      tips: { ...this.tips },
    });
    return c;
  }
}

const empty = (): ObsBucket => ({ index: 0, firstAt: 0, min: 0n, max: 0n });

interface Scenario {
  g: Graph;
  opts: SimulateGraphOptions;
  price: (step: number, t: number) => number;
  pool: (step: number, t: number) => number | null;
}

/** Replays a timeline through the chain model; returns the number of runs checked. */
function replay(s: Scenario, tl: GraphTimeline): number {
  const { g, opts } = s;
  const dec = g.tokenDecimals ?? 6;
  const stepSecs = opts.stepSecs ?? 86_400;
  const tickSecs = Math.min(opts.tickSecs ?? 600, stepSecs);
  const ticks = Math.max(1, Math.floor(stepSecs / tickSecs));
  const toL = (x: number): bigint => BigInt(Math.round(x * 1e9));
  const chain = new Chain(g, sqrtOf(opts.migrationPrice, dec), toL(Number(opts.initialTreasury?.sol ?? 0)), BigInt(Math.round(Number(opts.initialTreasury?.tokens ?? 0) * 10 ** dec)), 1_000_000_000n * 10n ** BigInt(dec));
  const fee = opts.poolFeeBps;
  let checked = 0;
  for (let step = 0; step < opts.epochs; step++) {
    const t0 = START + step * stepSecs;
    if (opts.feeInflowFn) chain.sol += toL(Number(opts.feeInflowFn(step, t0)));
    const graduated = opts.graduatedAtStep !== null && step >= (opts.graduatedAtStep ?? 0);
    const row = tl.steps[step]!;
    let next = 0;
    for (let k = 0; k < ticks; k++) {
      const now = t0 + k * tickSecs;
      let spot = sqrtOf(s.price(step, now), dec);
      const depth = s.pool(step, now);
      let pool = graduated && depth !== null ? toL(depth) : null;
      if (graduated) chain.updatePrice(now, spot);
      while (next < row.runs.length && row.runs[next]!.time === now) {
        const ev = row.runs[next++]!;
        const market = { graduated, spot, pool, fee };
        const signer = ev.by === "operator" ? chain.operator : null;
        const res = chain.run(now, ev.nodeIndex, ev.amountArg, signer, market);
        const where = `step ${step} t+${now - t0} ${ev.node} (${ev.by}, amount ${ev.amountArg})`;
        expect("error" in res ? res.error : "ok", where).toBe("ok");
        if ("error" in res) continue;
        expect(res.spent, where).toBe(ev.amount);
        expect(res.minOut, where).toBe(ev.minOut);
        expect(res.out, where).toBe(ev.tokensBought);
        expect(res.tip, where).toBe(ev.tip);
        expect(sqrtPriceQ64ToPrice(res.reference, dec), where).toBe(ev.refPrice);
        expect(res.paid, where).toEqual(ev.paid.map((p) => p.lamports));
        if (ev.action === "buybackBurn" && pool !== null) {
          const net = (ev.amount * BigInt(10_000 - fee)) / 10_000n;
          spot = (spot * (pool + net)) / pool;
          pool += net;
        }
        checked++;
      }
      // Nothing a keeper could still run was left out.
      g.nodes.forEach((n, i) => {
        if (n.operatorGated) return;
        expect(chain.keeperCanRun(now, i, { graduated, spot, pool, fee }), `step ${step} t+${now - t0}: ${n.id} was still runnable`).toBe(false);
      });
    }
    expect(next, `step ${step}: every run replayed`).toBe(row.runs.length);
    expect([chain.sol, chain.tokens, chain.supply], `step ${step} balances`).toEqual([row.treasurySol, row.treasuryTokens, row.supply]);
  }
  return checked;
}

/** A market path: drift with noise, a rally, a crash, a jump, a pump-and-dump. */
function pricePath(rng: Rng, p0: number, tickSecs: number): (step: number, t: number) => number {
  const kind = rng.below(5);
  const drift = (rng.below(2001) - 1000) / 100_000; // +-1% per tick
  const at = START + rng.range(1, 30) * tickSecs;
  const seed = rng.range(1, 1_000_000);
  return (_s, t) => {
    const k = (t - START) / tickSecs;
    const noise = 1 + 0.01 * Math.sin(seed + k * 1.7);
    switch (kind) {
      case 0:
        return p0 * Math.exp(drift * k) * noise;
      case 1:
        return p0 * 1.025 ** k;
      case 2:
        return t < at ? p0 : p0 * 0.6 * noise;
      case 3:
        return t < at ? p0 : p0 * 1.2 * noise;
      default:
        return t >= at && t < at + 3 * tickSecs ? p0 * 1.5 : p0 * noise;
    }
  };
}

function scenario(rng: Rng): Scenario {
  let g: Graph;
  switch (rng.below(4)) {
    case 0:
      g = randGraph(rng);
      break;
    case 1:
      g = graph()
        .node("buy", every(rng.pick(["10m", "1h", "6h"])), null, buybackBurn({ maxIn: rng.pick([0.1, 1, 10]), maxPremiumBps: rng.pick([50, 150, 300, 800]) }), { epoch: "1d", maxRunsPerEpoch: 144, budgetPerEpoch: 50 })
        .build();
      break;
    case 2:
      g = graph({ operator: ka(7) })
        .node("ai", whenever(), when.graduated(), buybackBurn({ maxIn: rng.pick([0.25, 2]), maxPremiumBps: rng.pick([100, 200, 500]) }), { operatorGated: true, budgetPerEpoch: 5, maxRunsPerEpoch: 8 })
        .node("burn", every("6h"), when.treasuryTokensGte(1), burn(1_000))
        .build();
      break;
    default:
      g = graph()
        .recipient(ka(1), "60%")
        .recipient(ka(2), "40%")
        .node("buy", every("1h"), when.graduated().and(when.treasurySolGte(0.2)), buybackBurn({ maxIn: 0.5, maxPremiumBps: 300 }), { maxRunsPerEpoch: 24, budgetPerEpoch: 5 })
        .node("share", every("6h"), null, distributeSol(0.3333))
        .build();
  }
  const tickSecs = rng.pick([600, 1_800]);
  const p0 = rng.pick([0.000001, 0.00003, 0.0002]);
  const migration = p0 * rng.pick([0.8, 1, 1.25]);
  const depth = rng.pick([null, 5, 80, 2_000]);
  const price = pricePath(rng, p0, tickSecs);
  const pool = (): number | null => depth;
  const opChoice = rng.below(4);
  const opts: SimulateGraphOptions = {
    epochs: rng.range(2, 6),
    stepSecs: rng.pick([21_600, 43_200]),
    tickSecs,
    migrationPrice: migration,
    poolFeeBps: rng.pick(FEES),
    poolSol: depth === null ? "none" : depth,
    priceFn: price,
    feeInflowFn: () => rng.pick([0, 0.5, 3]),
    initialTreasury: { sol: rng.pick([0, 1, 20, 200]), tokens: rng.pick([0, 1_000, 5_000_000]) },
    graduatedAtStep: rng.pick([0, 0, 1, null]),
    operator: (q) => (opChoice === 0 ? "max" : opChoice === 1 ? "fillable" : opChoice === 2 ? (q.time % 3 === 0 ? null : "fillable") : q.max / 3n),
  };
  // feeInflowFn must be deterministic for the replay: fix its values now.
  const inflows = Array.from({ length: opts.epochs }, () => rng.pick([0, 0.5, 3]));
  opts.feeInflowFn = (s) => inflows[s]!;
  return { g, opts, price, pool };
}

describe("simulator vs the chain model (the simulator never shows a run the program would refuse)", () => {
  it("400 seeded scenarios: every run accepted with the same numbers, balances equal, no keeper run left out", () => {
    const rng = new Rng(0x51d1ff);
    let total = 0;
    let buybacks = 0;
    let operatorRuns = 0;
    let smaller = 0;
    for (let i = 0; i < 400; i++) {
      const s = scenario(rng);
      const tl = simulateGraph(s.g, s.opts);
      total += replay(s, tl);
      for (const r of tl.steps.flatMap((x) => x.runs)) {
        if (r.action === "buybackBurn") buybacks++;
        if (r.by === "operator") operatorRuns++;
        if (r.amountArg !== null && r.by === "keeper") smaller++;
      }
    }
    expect(total).toBeGreaterThan(2_000);
    expect(buybacks).toBeGreaterThan(300);
    expect(operatorRuns).toBeGreaterThan(20);
    expect(smaller).toBeGreaterThan(10); // keepers sizing buybacks down to what the pool fills
  });
});

/** Autopilot graphs: builder, compile / decompile, text DSL, canvas model. */
import { describe, expect, it } from "vitest";

import {
  ACTION,
  OP,
  PXG1,
  ProgError,
  TRIGGER,
  after,
  autoLayout,
  buybackBurn,
  burn,
  canvasToGraph,
  compileGraph,
  connectNodes,
  decodeGraphRaw,
  decompileGraph,
  disconnectEdge,
  distributeSol,
  every,
  graph,
  graphToCanvas,
  normalizeGraph,
  onGraduation,
  parseGraph,
  printGraph,
  priceToSqrtPriceQ64,
  renameNode,
  tryParseGraph,
  validateCanvas,
  when,
  whenever,
} from "../../src/programmable/index.js";
import type { Graph } from "../../src/programmable/index.js";
import { ka, randGraph, Rng } from "./helpers.js";

const OPR = ka(0x0a);
const R1 = ka(0xa1);
const R2 = ka(0xa2);

const sample = () =>
  graph({ operator: OPR })
    .recipient(R1, "70%", "team")
    .recipient(R2, "30%", "dao")
    .node("buyback", every("1d"), when.graduated().and(when.treasurySolGte(1)), buybackBurn({ maxIn: 0.5, maxPremiumBps: 300 }), {
      budgetPerEpoch: 2,
      epoch: "1d",
      maxRunsPerEpoch: 4,
    })
    .node("burn-rest", after("buyback"), null, burn({ maxTokens: 1_000_000 }))
    .node("share", every("7d"), null, distributeSol(0.2), { operatorGated: true, epoch: "7d" });

describe("graph builder and compile", () => {
  it("lays out exactly the PXG1 fields", () => {
    const raw = decodeGraphRaw(sample().compile());
    expect(raw.flags).toBe(PXG1.FLAG_HAS_OPERATOR);
    expect(raw.recipients.map((r) => r.bps)).toEqual([7_000, 3_000]);
    const [b, r, s] = raw.nodes;
    expect(b).toMatchObject({ trigger: TRIGGER.EVERY, triggerArg: 86_400n, condOff: 0, condLen: 3, action: ACTION.BUYBACK_BURN, operatorGated: 0 });
    expect(b).toMatchObject({ epochSecs: 86_400, budgetPerEpoch: 2_000_000_000n, p1: 500_000_000n, p2: 300n, maxRunsPerEpoch: 4 });
    expect(r).toMatchObject({ trigger: TRIGGER.AFTER, triggerArg: 0n, condOff: 0, condLen: 0, action: ACTION.BURN, p1: 1_000_000_000_000n });
    expect(r!.budgetPerEpoch).toBe(1_000_000_000_000n); // default: per-run max x 1 run
    expect(s).toMatchObject({ trigger: TRIGGER.EVERY, triggerArg: 604_800n, action: ACTION.DISTRIBUTE_SOL, operatorGated: 1, p1: 200_000_000n, maxRunsPerEpoch: 1 });
    expect(raw.cond).toEqual([
      { op: OP.GRADUATED, a: 0, arg: 0n },
      { op: OP.TREASURY_SOL_GTE, a: 0, arg: 1_000_000_000n },
      { op: OP.AND, a: 0, arg: 0n },
    ]);
  });

  it("defaults: epoch 1d, runs = epoch / every, budget = p1 x runs", () => {
    const g = graph().node("b", every("6h"), null, burn(10)).build();
    expect(g.nodes[0]).toMatchObject({ epochSecs: 86_400, maxRunsPerEpoch: 4, budgetPerEpoch: 40_000_000n });
  });

  it("decompile(compile(g)) is the canonical model; compile(decompile(b)) is b", () => {
    const g = sample().build();
    const bytes = compileGraph(g);
    const back = decompileGraph(bytes, { ids: g.nodes.map((n) => n.id), labels: { [R1]: "team", [R2]: "dao" } });
    expect(back).toEqual(normalizeGraph(g));
    expect(compileGraph(back)).toEqual(bytes);
  });

  it("decompile names nodes after their actions when no ids are given", () => {
    const back = decompileGraph(sample().compile());
    expect(back.nodes.map((n) => n.id)).toEqual(["buyback", "burn", "distribute"]);
    expect(back.nodes[1]!.trigger).toEqual({ kind: "after", node: "buyback" });
  });

  it("friendly model errors", () => {
    const g = sample().build();
    const bad = (f: (x: Graph) => void, code: string): void => {
      const x = structuredClone(g);
      f(x);
      expect(() => compileGraph(x)).toThrow(expect.objectContaining({ code }));
    };
    bad((x) => (x.nodes[1]!.trigger = { kind: "after", node: "nope" }), "UnknownNode");
    bad((x) => (x.nodes[1]!.id = "buyback"), "DuplicateNode");
    bad((x) => (x.nodes[1]!.when = { op: "buy" }), "WrongContext");
    bad((x) => (x.operator = null), "GatedWithoutOperator");
    bad((x) => (x.nodes[2]!.operatorGated = false), "OperatorUnused");
    bad((x) => (x.nodes[2]!.action = { kind: "burn", maxTokens: 1n }), "RecipientsUnused");
    bad((x) => (x.recipients[0]!.bps = 6_000), "BadRecipientBps");
    bad((x) => (x.nodes[0]!.trigger = { kind: "every", secs: 60 }), "EveryTooShort");
    bad((x) => (x.nodes = []), "NoGraphNodes");
    expect(() => graph().node("x", every("10m"), null, burn(1), { epoch: "30m" })).toThrow(ProgError);
  });

  it("prices in conditions resolve with the token decimals", () => {
    const g = graph({ tokenDecimals: 9 }).node("b", every("1d"), when.priceLte(0.001), buybackBurn({ maxIn: 1 })).build();
    expect(g.nodes[0]!.when).toEqual({ op: "priceLte", price: { sqrtPriceQ64: priceToSqrtPriceQ64("0.001", 9) } });
  });

  it("renameNode updates triggers and conditions", () => {
    const g = graph()
      .node("a", every("1d"), null, burn(1))
      .node("b", after("a"), when.runsInEpochLt("a", 2), burn(1))
      .build();
    const r = renameNode(g, "a", "first");
    expect(r.nodes[1]!.trigger).toEqual({ kind: "after", node: "first" });
    expect(r.nodes[1]!.when).toEqual({ op: "runsInEpochLt", node: "first", n: 2 });
    expect(compileGraph(r)).toEqual(compileGraph(g));
  });
});

describe("graph DSL", () => {
  const TEXT = `autopilot v1
operator = ${OPR}
recipient team = ${R1} 70%
recipient dao = ${R2} 30%

node buyback: every 1d
  when graduated and treasury_sol >= 1 SOL
  do buyback 0.5 SOL premium 3%
  budget 2 SOL per 1d
  max 4 runs

node burn-rest: after buyback
  do burn 1000000 tokens
  budget 1000000 tokens per 1d
  max 1 run

node share: every 7d
  do distribute 0.2 SOL
  budget 0.2 SOL per 7d
  max 1 run
  operator decides
`;

  it("parses to the same bytes as the builder and prints canonically", () => {
    const g = parseGraph(TEXT);
    expect(compileGraph(g)).toEqual(sample().compile());
    expect(printGraph(g)).toBe(TEXT);
  });

  it("every trigger, every condition leaf, defaults", () => {
    const g = parseGraph(`autopilot v1
node a: on graduation
  do burn 5 tokens
node b: whenever
  when not graduated or price <= 0.0001 SOL and price >= 1 q64 or now >= 2027-01-01 and now < 2027-06-01T12:00:00Z
  do burn 1 tokens
node c: after a
  when runs(c) < 3 and treasury_tokens >= 10 tokens
  do buyback 500000 lamports premium 150bps
node d: every 10m
  do burn 7 units
`);
    expect(g.nodes.map((n) => n.trigger.kind)).toEqual(["graduated", "when", "after", "every"]);
    expect(g.nodes[3]).toMatchObject({ epochSecs: 86_400, maxRunsPerEpoch: 144, budgetPerEpoch: 7n * 144n });
    expect(g.nodes[2]!.action).toEqual({ kind: "buybackBurn", maxInLamports: 500_000n, maxPremiumBps: 150 });
    const again = parseGraph(printGraph(g));
    expect(compileGraph(again)).toEqual(compileGraph(g));
    expect(printGraph(again)).toBe(printGraph(g));
  });

  it("round trips random graphs (seeded): model -> text -> model -> bytes", () => {
    const rng = new Rng(0x47445331);
    for (let i = 0; i < 250; i++) {
      const g = randGraph(rng);
      const bytes = compileGraph(g);
      const text = printGraph(g);
      const back = parseGraph(text);
      expect(compileGraph(back)).toEqual(bytes);
      expect(printGraph(back)).toBe(text);
      // and from bytes
      expect(compileGraph(parseGraph(printGraph(decompileGraph(bytes))))).toEqual(bytes);
    }
  });

  it("positioned, friendly errors (one per line)", () => {
    const r = tryParseGraph(`autopilot v1
node a: every 5m
  do burn 1 tokens
node b: every 1d
  do buyback 1 premium 3%
node c: whenever
  do burn 1 tokens
node d: every 1d
  do burn 1 tokens
  budget 1 SOL per 1d
  colour blue
`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const msgs = r.errors.map((e) => `${e.line}:${e.col} ${e.message}`);
    expect(msgs[0]).toMatch(/^2:9 a node can repeat at most every 10 minutes/);
    expect(msgs[1]).toMatch(/^5:14 buyback: "1" needs a unit/);
    expect(msgs).toContainEqual(expect.stringMatching(/^11:3 unknown node setting "colour"/));
    expect(msgs).toContainEqual(expect.stringMatching(/^6:1 node "c" runs "whenever" but has no condition/));
    // node d is not built (its "colour" line failed), so its budget is not checked: no cascading errors
    expect(msgs).toHaveLength(4);
    const unit = tryParseGraph(["node d: every 1d", "  do burn 1 tokens", "  budget 1 SOL per 1d", ""].join("\n"));
    expect(!unit.ok && `${unit.errors[0]!.line}:${unit.errors[0]!.col} ${unit.errors[0]!.message}`).toMatch(/^3:3 the budget of "d" must be in tokens/);
  });

  it("verifier errors map back to the node's line", () => {
    const r = tryParseGraph(`autopilot v1
recipient team = ${R1} 60%
node a: every 1d
  do distribute 1 SOL
`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.message).toContain("add up to 6000 bps");
  });
});

describe("canvas model", () => {
  it("graph -> canvas -> graph is the identity; AFTER triggers become edges", () => {
    const g = sample().build();
    const c = graphToCanvas(g);
    expect(c.edges).toEqual([{ id: "buyback->burn-rest", source: "buyback", target: "burn-rest" }]);
    expect(c.nodes.map((n) => [n.id, n.x, n.y])).toEqual([
      ["buyback", 40, 40],
      ["burn-rest", 320, 40],
      ["share", 40, 200],
    ]);
    expect(canvasToGraph(c)).toEqual(g);
    expect(validateCanvas(c)).toEqual([]);
  });

  it("explicit positions win over the auto layout", () => {
    const c = graphToCanvas(sample().build(), { positions: { share: { x: 7, y: 9 } } });
    expect(c.nodes.find((n) => n.id === "share")).toMatchObject({ x: 7, y: 9 });
    expect(autoLayout(c, { colGap: 100 }).nodes[1]).toMatchObject({ x: 140 });
  });

  it("connect / disconnect edit triggers; edges are the source of truth", () => {
    let c = graphToCanvas(sample().build());
    c = connectNodes(c, "share", "burn-rest");
    expect(c.edges).toEqual([{ id: "share->burn-rest", source: "share", target: "burn-rest" }]);
    expect(canvasToGraph(c).nodes[1]!.trigger).toEqual({ kind: "after", node: "share" });
    c = disconnectEdge(c, "share->burn-rest");
    expect(canvasToGraph(c).nodes[1]!.trigger).toEqual({ kind: "every", secs: 86_400 });
    expect(() => connectNodes(c, "share", "share")).toThrow(ProgError);
  });

  it("validateCanvas explains every problem in plain words", () => {
    const base = graphToCanvas(sample().build());
    const two = { ...base, edges: [...base.edges, { id: "share->burn-rest", source: "share", target: "burn-rest" }] };
    expect(validateCanvas(two)).toEqual([expect.objectContaining({ code: "MultipleParents", nodeId: "burn-rest" })]);
    const dangling = { ...base, edges: [{ id: "x", source: "ghost", target: "share" }] };
    expect(validateCanvas(dangling).map((i) => i.code)).toContain("DanglingEdge");
    const orphan = { ...base, edges: [] };
    expect(validateCanvas(orphan)).toEqual([expect.objectContaining({ code: "UnknownNode", nodeId: "burn-rest" })]);
    const loop = connectNodes(base, "burn-rest", "buyback");
    expect(validateCanvas(loop)).toEqual([expect.objectContaining({ code: "AfterCycle" })]);
    const noOp = { ...base, operator: null };
    expect(validateCanvas(noOp)).toEqual([expect.objectContaining({ code: "GatedWithoutOperator", nodeId: "share" })]);
    expect(() => canvasToGraph(two)).toThrow(ProgError);
  });

  it("random graphs survive the canvas round trip", () => {
    const rng = new Rng(0x43414e31);
    for (let i = 0; i < 100; i++) {
      const g = normalizeGraph(randGraph(rng));
      expect(compileGraph(canvasToGraph(graphToCanvas(g)))).toEqual(compileGraph(g));
    }
  });
});

describe("triggers helpers", () => {
  it("onGraduation / whenever / every / after", () => {
    expect(onGraduation()).toEqual({ kind: "graduated" });
    expect(whenever()).toEqual({ kind: "when" });
    expect(every("1h30m")).toEqual({ kind: "every", secs: 5_400 });
    expect(after("x")).toEqual({ kind: "after", node: "x" });
  });
});

/**
 * Hardening: what the bytes say is exactly what the model says (no integer is
 * ever wrapped or truncated), errors point at the rule / node they belong to,
 * and no input, however absurd, gets anything but a friendly ProgError /
 * DslError (never a RangeError from deep recursion or a bad conversion).
 */
import { describe, expect, it } from "vitest";
import {
  type Cond,
  burn,
  buybackBurn,
  compileGraph,
  compileCanvas,
  compileRules,
  decompileCanvas,
  decompileRules,
  DslError,
  encodeGraphRaw,
  encodeRulesRaw,
  every,
  explainGraph,
  explainRules,
  formatDate,
  graph,
  graphCondition,
  GRAPH_TEMPLATES,
  graphTemplate,
  graphToCanvas,
  MAX_NESTING,
  MAX_SIM_STEPS,
  MAX_TREE_NODES,
  newAutopilotState,
  nodeStatus,
  nodeStatuses,
  parseGraph,
  parseRules,
  priceToSqrtPriceQ64,
  printGraph,
  printRules,
  ProgError,
  PXR1,
  type RawGraphCtx,
  recordRun,
  RULE_TEMPLATES,
  rules,
  ruleTemplate,
  simulateGraph,
  simulateTransfer,
  toLamports,
  toTokenUnits,
  toUnix,
  tryParseGraph,
  tryParseRules,
  U64_MAX,
  validateCanvas,
  verifyGraphBytes,
  verifyRules,
  verifyRulesBytes,
  when,
} from "../../src/programmable/index.js";
import { DAY, gnode, graphProg, ka, kb, randGraph, Rng, rulesProg, deny, isBuy, timeLt, TRIGGER, ACTION } from "./helpers.js";

/** The ProgError `f` throws (fails the test if it throws anything else, or nothing). */
function progError(f: () => unknown): ProgError {
  try {
    f();
  } catch (e) {
    if (e instanceof ProgError) return e;
    throw new Error(`expected a ProgError, got ${String(e)}`);
  }
  throw new Error("expected a ProgError, nothing was thrown");
}

const A = ka(7);
const B = ka(8);

describe("encoders never truncate", () => {
  it("raw encoders refuse a value that does not fit its field", () => {
    const base = rulesProg([], [deny(0, 60, 1, [isBuy()])]);
    const bad = (f: (p: typeof base) => void): ProgError => {
      const p = structuredClone(base);
      f(p);
      return progError(() => encodeRulesRaw(p));
    };
    expect(bad((p) => (p.rules[0]!.arg = -1n)).code).toBe("BadModel");
    expect(bad((p) => (p.rules[0]!.arg = 1n << 64n)).code).toBe("BadModel");
    expect(bad((p) => (p.rules[0]!.toRel = 2 ** 32)).code).toBe("BadModel");
    expect(bad((p) => (p.rules[0]!.code = 256)).code).toBe("BadModel");
    expect(bad((p) => (p.rules[0]!.fromRel = 1.5)).code).toBe("BadModel");
    expect(bad((p) => (p.nodes[0]!.a = -1)).code).toBe("BadModel");
    expect(bad((p) => p.keys.push(new Uint8Array(31))).code).toBe("BadModel");

    const g = graphProg(null, [[kb(3), 10_000]], [[gnode(TRIGGER.EVERY, DAY, ACTION.DISTRIBUTE_SOL, 1, 0), []]]);
    const gbad = (f: (x: typeof g) => void): ProgError => {
      const x = structuredClone(g);
      f(x);
      return progError(() => encodeGraphRaw(x));
    };
    expect(gbad((x) => (x.recipients[0]!.bps = 70_000)).code).toBe("BadModel");
    expect(gbad((x) => (x.nodes[0]!.budgetPerEpoch = -1n)).code).toBe("BadModel");
    expect(gbad((x) => (x.nodes[0]!.p1 = (1n << 64n) + 5n)).code).toBe("BadModel");
    expect(gbad((x) => (x.nodes[0]!.maxRunsPerEpoch = 65_536)).code).toBe("BadModel");
    expect(gbad((x) => (x.nodes[0]!.epochSecs = -3600)).code).toBe("BadModel");
    expect(gbad((x) => (x.operator = new Uint8Array(33))).code).toBe("BadModel");
    expect(gbad((x) => (x.nodes[0]!.reserved = new Uint8Array(4))).code).toBe("BadModel");
    // in range, the same values encode and verify
    expect(verifyGraphBytes(encodeGraphRaw(g)).nodes[0]!.budgetPerEpoch).toBe(5_000_000_000n);
  });

  it("a budget of -1 is refused, never compiled as an unlimited u64::MAX budget", () => {
    const g = graph().node("burner", every("1d"), null, burn(1000), { budgetPerEpoch: 1000 }).build();
    g.nodes[0]!.budgetPerEpoch = -1n;
    const e = progError(() => compileGraph(g));
    expect(e.code).toBe("BadAmount");
    expect(e.at.node).toBe(0);
    expect(e.message).toContain("burner");
    g.nodes[0]!.budgetPerEpoch = U64_MAX + 1n;
    expect(progError(() => compileGraph(g)).code).toBe("BadAmount");
    g.nodes[0]!.budgetPerEpoch = U64_MAX; // the widest value that fits is fine
    expect(compileGraph(g).length).toBe(44 + 48);
  });

  it("per-run caps beyond u64 are refused, never wrapped (2^64 + 5 is not 5)", () => {
    for (const action of [
      { kind: "buybackBurn", maxInLamports: (1n << 64n) + 5n, maxPremiumBps: 300 },
      { kind: "burn", maxTokens: (1n << 64n) + 5n },
      { kind: "distributeSol", maxLamports: -5n },
    ] as const) {
      const g = graph().recipient(A, "100%").node("x", every("1d"), null, burn(1), { budgetPerEpoch: 10 }).build();
      g.nodes[0]!.action = { ...action };
      if (action.kind !== "distributeSol") g.recipients = [];
      const e = progError(() => compileGraph(g));
      expect(e.code).toBe("BadAmount");
      expect(e.at.node).toBe(0);
    }
  });

  it("recipient shares must fit: 70536 + 5000 bps is refused, not encoded as 5000 + 5000", () => {
    const g = graph().recipient(A, 5_000).recipient(B, 5_000).node("pay", every("1d"), null, { kind: "distributeSol", maxLamports: 1n }).build();
    expect(compileGraph(g).length).toBeGreaterThan(0);
    g.recipients[0]!.bps = 70_536; // 70536 mod 65536 = 5000: the sum would "verify"
    const e = progError(() => compileGraph(g));
    expect(e.code).toBe("BadAmount");
    expect(e.at.key).toBe(0);
    g.recipients[0]!.bps = 10_001;
    expect(progError(() => compileGraph(g)).code).toBe("BadAmount");
    g.recipients[0]!.bps = 2.5;
    expect(progError(() => compileGraph(g)).code).toBe("BadAmount");
  });

  it("condition operands outside u64 are refused; inside u64 the verifier decides", () => {
    const withLeaf = (leaf: Cond): (() => Uint8Array) => () => {
      const g = graph().node("b", every("1d"), null, burn(1)).build();
      g.nodes[0]!.when = leaf;
      return compileGraph(g);
    };
    expect(progError(withLeaf({ op: "treasurySolGte", lamports: -1n })).code).toBe("BadAmount");
    expect(progError(withLeaf({ op: "treasurySolGte", lamports: 1n << 64n })).code).toBe("BadAmount");
    expect(progError(withLeaf({ op: "treasuryTokensGte", amount: { raw: -5n } })).code).toBe("BadAmount");
    expect(progError(withLeaf({ op: "nowGe", unix: -1n })).code).toBe("BadAmount");
    expect(progError(withLeaf({ op: "nowLt", unix: 1n << 64n })).code).toBe("BadAmount");
    expect(progError(withLeaf({ op: "nowLt", unix: 1n << 63n })).code).toBe("TimeOutOfRange"); // fits u64, not i64
    expect(progError(withLeaf({ op: "priceLte", price: { sqrtPriceQ64: 1n << 64n } })).code).toBe("PriceOutOfRange");
    expect(progError(withLeaf({ op: "priceGte", price: { sqrtPriceQ64: -1n } })).code).toBe("PriceOutOfRange");
    expect(withLeaf({ op: "treasurySolGte", lamports: U64_MAX })().length).toBe(44 + 48 + 10);
    // rule amounts: raw must be a bigint below the bps flag
    const r = rules({ guardSecs: 3600 }).deny(when.buy()).build();
    r.rules[0]!.when = { op: "amountGt", amount: { raw: 5 as unknown as bigint } };
    expect(progError(() => compileRules(r)).code).toBe("BadAmount");
  });

  it("property (seeded): any out-of-range budget or per-run cap is refused at its node", () => {
    const rng = new Rng(0x5eed_0001n);
    const bad = [-1n, -(1n << 63n), 1n << 64n, (1n << 64n) + 1n, 1n << 70n];
    for (let k = 0; k < 300; k++) {
      const g = randGraph(rng);
      const i = rng.below(g.nodes.length);
      const v = rng.pick(bad);
      const n = g.nodes[i]!;
      if (rng.coin()) n.budgetPerEpoch = v;
      else if (n.action.kind === "buybackBurn") n.action.maxInLamports = v;
      else if (n.action.kind === "burn") n.action.maxTokens = v;
      else n.action.maxLamports = v;
      const e = progError(() => compileGraph(g));
      expect(e.code).toBe("BadAmount");
      expect(e.at.node).toBe(i);
    }
  });
});

describe("errors point at the rule or node they belong to", () => {
  it("graph DSL: an AFTER to a missing node is reported on that node's line", () => {
    const r = tryParseGraph("autopilot v1\nnode a: every 1d\n  do burn 10 tokens\nnode b: after nosuch\n  do burn 10 tokens\n");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.line).toBe(4);
    expect(r.errors[0]!.message).toContain("nosuch");
  });

  it("canvas: an out-of-range budget is an issue on that node (it used to compile as u64::MAX)", () => {
    const c = graphToCanvas(
      graph().node("one", every("1d"), null, burn(5)).node("two", every("1d"), null, buybackBurn({ maxIn: 1 })).build(),
    );
    c.nodes[1]!.budgetPerEpoch = -1n;
    const issues = validateCanvas(c);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe("BadAmount");
    expect(issues[0]!.nodeId).toBe("two");
  });

  it("rules: a wrong-context leaf or an unknown key names its rule", () => {
    const ctx = rules({ guardSecs: 3600 }).deny(when.buy()).deny(when.graduated());
    const e1 = progError(() => ctx.compile());
    expect(e1.code).toBe("WrongContext");
    expect(e1.at.rule).toBe(1);
    const key = rules({ guardSecs: 3600 }).deny(when.buy()).deny(when.toIn("nobody"));
    const e2 = progError(() => key.compile());
    expect(e2.code).toBe("UnknownKey");
    expect(e2.at.rule).toBe(1);
    expect(e2.message).toContain("rule 2");
  });
});

describe("dates far in the future round-trip", () => {
  it("formatDate / toUnix are inverse for every u64 time the verifier accepts", () => {
    for (const t of [0n, 1_798_761_600n, 253_402_300_799n, 253_402_300_800n, 1_000_000_000_000n, 8_640_000_000_001n, (1n << 63n) - 1n]) {
      expect(toUnix(formatDate(t))).toBe(t);
    }
    expect(formatDate(253_402_300_799n)).toBe("9999-12-31T23:59:59Z");
    expect(formatDate(253_402_300_800n)).toBe("253402300800");
  });

  it("a graph with a year-30000 deadline prints and parses back to the same bytes", () => {
    const g = graph().node("b", every("1d"), when.before(1_000_000_000_000n), burn(1)).build();
    const text = printGraph(g);
    expect(compileGraph(parseGraph(text))).toEqual(compileGraph(g));
  });
});

describe("absurd inputs get friendly errors, never a crash", () => {
  it("deeply nested text is a positioned DslError, not a stack overflow", () => {
    const deep = (n: number): string => `rules v1\nguard 1h\nalways: deny when ${"(".repeat(n)}buy${")".repeat(n)}\n`;
    expect(tryParseRules(deep(MAX_NESTING)).ok).toBe(true);
    const r = tryParseRules(deep(50_000));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toBeInstanceOf(DslError);
    expect(r.errors[0]!.line).toBe(3);
    expect(tryParseRules(deep(MAX_NESTING + 1)).ok).toBe(false);
    const g = tryParseGraph(`node x: whenever\n  when ${"not ".repeat(50_000)}graduated\n  do burn 1 tokens\n`);
    expect(g.ok).toBe(false);
    if (g.ok) return;
    expect(g.errors[0]!.line).toBe(2);
  });

  it("63 nots and a leaf (64 nodes, the rule maximum) still parse and compile", () => {
    const set = parseRules(`guard 1h\nalways: deny when ${"not ".repeat(63)}buy\n`);
    expect(compileRules(set).length).toBe(12 + 20 + 64 * 10);
  });

  it("a 20,000-term and-chain is TooManyNodes on its line, not a RangeError", () => {
    const chain = Array.from({ length: 20_000 }, () => "buy").join(" and ");
    const r = tryParseRules(`guard 1h\nalways: deny when ${chain}\n`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.line).toBe(2);
    expect(r.errors[0]!.message).toContain("parts");
  });

  it("huge programmatic trees are refused before any recursive walk", () => {
    let c: Cond = { op: "buy" };
    for (let i = 0; i < 100_000; i++) c = { op: "not", x: c };
    const set = { guardSecs: 3600, keys: [], rules: [{ from: 0, to: 3600, effect: "deny" as const, when: c, code: 0 }] };
    for (const f of [() => compileRules(set), () => printRules(set), () => explainRules(set)]) {
      expect(progError(f).code).toBe("TooManyNodes");
    }
    const g = graph().node("b", every("1d"), null, burn(1)).build();
    let gc: Cond = { op: "graduated" };
    for (let i = 0; i < 100_000; i++) gc = { op: "and", a: gc, b: { op: "graduated" } };
    g.nodes[0]!.when = gc;
    for (const f of [() => compileGraph(g), () => printGraph(g), () => explainGraph(g)]) {
      expect(progError(f).code).toBe("TooManyNodes");
    }
    // the guard sits far above anything that fits on-chain
    expect(MAX_TREE_NODES).toBeGreaterThan(96);
  });
});

describe("launch guard bounds", () => {
  it("a model guard past 72 h is a clear BadModel, not a confusing window error", () => {
    const e = progError(() => rules({ guardSecs: 100 * 3600 }).deny(when.buy()).compile());
    expect(e.code).toBe("BadModel");
    expect(e.message).toContain("72 hours");
    expect(progError(() => rules({ guardSecs: 3600.5 }).deny(when.buy()).compile()).code).toBe("BadModel");
    expect(rules({ guardSecs: PXR1.MAX_GUARD_SECS }).deny(when.buy()).compile().length).toBe(12 + 20 + 10);
  });

  it("the verifiers take the crate's guard type (a u32): anything else is a wrong argument, never a verdict", () => {
    // A 72 h window with a time leaf: valid for a 72 h guard, refused for a shorter one.
    const bytes = encodeRulesRaw(rulesProg([], [deny(0, PXR1.MAX_GUARD_SECS, 1, [timeLt(100)])]));
    expect(verifyRules(bytes, { guardSecs: PXR1.MAX_GUARD_SECS }).ok).toBe(true);
    expect(verifyRules(bytes, { guardSecs: 0xffff_ffff }).ok).toBe(true); // capped at 72 h, like the crate
    expect(verifyRules(bytes, { guardSecs: 3_600 })).toMatchObject({ ok: false, code: "WindowPastGuard" });
    expect(verifyRules(bytes, { guardSecs: 0 })).toMatchObject({ ok: false, code: "WindowPastGuard" });
    // NaN used to compare false everywhere (a window past any guard passed); a fraction or
    // a negative number has no crate equivalent: all are refused before looking at the bytes.
    for (const bad of [Number.NaN, 3_600.5, -1, 2 ** 32, Number.POSITIVE_INFINITY]) {
      expect(progError(() => verifyRules(bytes, { guardSecs: bad })).code).toBe("BadModel");
      expect(progError(() => verifyRulesBytes(bytes, { guardSecs: bad })).code).toBe("BadModel");
      expect(progError(() => decompileRules(bytes, { guardSecs: bad })).code).toBe("BadModel");
    }
  });

  it("decompile and the transfer simulator use the effective guard (capped at 72 h, as on-chain)", () => {
    const bytes = rules({ guardSecs: PXR1.MAX_GUARD_SECS }).deny(when.buy(), "BOT").compile();
    const set = decompileRules(bytes, { guardSecs: 100 * 3600 });
    expect(set.guardSecs).toBe(PXR1.MAX_GUARD_SECS);
    expect(printRules(set)).toContain("first 3d: deny when buy code BOT"); // bytes carry explicit ends
    const late = simulateTransfer(bytes, { kind: "buy", at: "80h", amount: 1, guardSecs: 100 * 3600 });
    expect(late.allowed).toBe(true);
    expect(late.stage).toBe("guardOver");
    expect(simulateTransfer(bytes, { kind: "buy", at: "71h", amount: 1, guardSecs: 100 * 3600 }).allowed).toBe(false);
  });

  it("the instruction count is a u16, like the hook reads it", () => {
    const set = parseRules("guard 1h\nalways: deny when buy and instructions > 3 code BOT\n");
    for (const bad of [2.5, -1, 65_536, Number.NaN]) {
      expect(progError(() => simulateTransfer(set, { kind: "buy", at: 1, amount: 1, instructions: bad })).code).toBe("BadModel");
    }
    expect(simulateTransfer(set, { kind: "buy", at: 1, amount: 1, instructions: 65_535 }).allowed).toBe(false);
    expect(simulateTransfer(set, { kind: "buy", at: 1, amount: 1, instructions: 3 }).allowed).toBe(true);
  });
});

describe("gaps the mutation check found", () => {
  it("at exactly the guard end the guard is over: allowed before any rule or built-in is looked at", () => {
    const denyAll = parseRules("guard 1h\nalways: deny\n");
    for (const kind of ["buy", "p2p"] as const) {
      const v = simulateTransfer(denyAll, { kind, at: 3_600, amount: 1, builtin: { maxBuyBps: 1, p2pLocked: true } });
      expect(v.allowed).toBe(true);
      expect(v.stage).toBe("guardOver");
      expect(simulateTransfer(denyAll, { kind, at: 3_599, amount: 1 }).allowed).toBe(false);
    }
  });

  it("a raw cap at or above 2^63 is refused, never read as a share of supply (bit 63 is the bps flag)", () => {
    // 2^63 + 100 would encode exactly like "1% of supply"
    for (const raw of [1n << 63n, (1n << 63n) + 100n]) {
      expect(progError(() => rules({ guardSecs: 3600 }).capAmount(raw, when.buy()).compile()).code).toBe("BadAmount");
      expect(progError(() => rules({ guardSecs: 3600 }).deny(when.amountGt(raw)).compile()).code).toBe("BadAmount");
    }
    expect(rules({ guardSecs: 3600 }).capAmount((1n << 63n) - 1n, when.buy()).compile().length).toBe(12 + 20 + 10);
  });

  it("shares outside 0.01%..100% or fractional bps are a friendly BadAmount from the model", () => {
    for (const bps of [0, 10_001, 1.5, 65_636]) {
      const set = rules({ guardSecs: 3600 }).deny(when.buy()).build();
      set.rules[0] = { ...set.rules[0]!, effect: "capBalance", cap: { bps } };
      const e = progError(() => compileRules(set));
      expect(e.code).toBe("BadAmount");
      expect(e.at.rule).toBe(0);
    }
  });

  it("DSL: a share out of range is reported at the amount itself", () => {
    for (const amt of ["0%", "101%", "0bps", "10001bps"]) {
      const r = tryParseRules(`guard 1h\nalways: max amount ${amt} code WHALE\n`);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect([r.errors[0]!.line, r.errors[0]!.col]).toEqual([2, 20]);
    }
  });

  it("printer: the fewest parentheses (nested nots need none; not of and / or keeps them)", () => {
    const text = (c: string): string => printRules(parseRules(`guard 1h\nalways: deny when ${c}\n`)).split("\n").find((l) => l.startsWith("always"))!;
    expect(text("not not buy")).toBe("always: deny when not not buy");
    expect(text("not (not buy)")).toBe("always: deny when not not buy");
    expect(text("not (buy and p2p)")).toBe("always: deny when not (buy and p2p)");
    expect(text("not (buy or p2p) and p2p")).toBe("always: deny when not (buy or p2p) and p2p");
  });
});

describe("gaps from the second mutation run", () => {
  it("undeclared keys join the key table in first-use order, left to right (it decides the bytes)", () => {
    const set = rules({ guardSecs: 3600 }).deny(when.toIn(A).and(when.fromIn(B))).deny(when.programIn(ka(9)).or(when.toIn(B))).build();
    expect(set.keys.map((k) => k.address)).toEqual([A, B, ka(9)]);
    const swapped = rules({ guardSecs: 3600 }).deny(when.fromIn(B).and(when.toIn(A))).build();
    expect(swapped.keys.map((k) => k.address)).toEqual([B, A]);
  });

  it("a negative price is a PriceOutOfRange ProgError, not a RangeError", () => {
    expect(progError(() => priceToSqrtPriceQ64(-1)).code).toBe("PriceOutOfRange");
    expect(progError(() => priceToSqrtPriceQ64("-0.000001")).code).toBe("PriceOutOfRange");
    const e = progError(() => graph().node("b", every("1d"), when.priceLte(-0.5), burn(1)).build());
    expect(e.code).toBe("PriceOutOfRange");
    expect(e.at.node).toBe(0);
  });

  it("graph time leaves: NOW_GE is inclusive, NOW_LT strict, and a clock before 1970 is before every time", () => {
    const t = 1_900_000_000n;
    const g = graph()
      .node("ge", every("1d"), when.onOrAfter(t), burn(1))
      .node("lt", every("1d"), when.before(t), burn(1))
      .node("lt0", every("1d"), when.before(0n), burn(1))
      .node("ge0", every("1d"), when.onOrAfter(0n), burn(1))
      .compile();
    const raw = verifyGraphBytes(g);
    const ctx = (now: bigint): RawGraphCtx => ({ now, treasurySol: 0n, treasuryToken: 0n, graduated: false, sqrtPrice: 0n, runsInEpoch: new Array<number>(16).fill(0) });
    expect([graphCondition(raw, 0, ctx(t)), graphCondition(raw, 1, ctx(t))]).toEqual([true, false]);
    expect([graphCondition(raw, 0, ctx(t - 1n)), graphCondition(raw, 1, ctx(t - 1n))]).toEqual([false, true]);
    expect([graphCondition(raw, 2, ctx(-1n)), graphCondition(raw, 3, ctx(-1n))]).toEqual([true, false]);
    expect([graphCondition(raw, 2, ctx(0n)), graphCondition(raw, 3, ctx(0n))]).toEqual([false, true]);
  });

  it("compileCanvas refuses a canvas with issues (two links into one step) instead of keeping one silently", () => {
    const c = graphToCanvas(
      graph().node("a", every("1d"), null, burn(1)).node("b", every("1d"), null, burn(1)).node("c", every("1d"), null, burn(1)).build(),
    );
    const bad = { ...c, edges: [...c.edges, { id: "a->c", source: "a", target: "c" }, { id: "b->c", source: "b", target: "c" }] };
    expect(validateCanvas(bad).map((i) => i.code)).toContain("MultipleParents");
    expect(progError(() => compileCanvas(bad)).code).toBe("BadModel");
  });
});

describe("sliders", () => {
  it("numbers with binary float noise read as the decimal they stand for; real extra precision is refused", () => {
    expect(toLamports(0.1 * 3)).toBe(300_000_000n); // 0.30000000000000004
    expect(toLamports(0.07 * 100 * 0.01)).toBe(70_000_000n);
    expect(toTokenUnits(0.1 + 0.2, 6)).toBe(300_000n);
    expect(toTokenUnits(1.1 * 1.1, 2)).toBe(121n); // 1.2100000000000002
    for (const [v, dec] of [[1e-10, 9], [1.0000000001, 9], [0.0000001, 6], [2.5, 0]] as const) {
      expect(progError(() => toTokenUnits(v, dec)).code).toBe("BadAmount");
    }
    expect(progError(() => toLamports(1e-10)).code).toBe("BadAmount");
    // strings are always exact
    expect(progError(() => toLamports("0.30000000000000004")).code).toBe("BadAmount");
  });

  it("every template slider value from min to max (in steps, float arithmetic included) compiles and verifies", () => {
    const base: Record<string, Record<string, unknown>> = {
      "team-cant-buy": { team: [A] },
      "revenue-share": { recipients: [{ address: A, share: "70%" }, { address: B, share: "30%" }] },
      "ai-buyback": { operator: B },
    };
    const input = (kind: string, v: number): unknown => (kind === "percent" ? { bps: v } : v);
    let checked = 0;
    const sweep = <T>(templates: readonly { id: string; params: { key: string; kind: string; range?: { min: number; max: number; step: number } }[] }[], build: (id: string, p: Record<string, unknown>) => T, compile: (x: T) => Uint8Array): void => {
      for (const t of templates) {
        for (const prm of t.params) {
          if (!prm.range) continue;
          const { min, max, step } = prm.range;
          expect(min).toBeLessThan(max);
          const n = Math.round((max - min) / step);
          const ks = [0, 1, 2, 3, Math.floor(n / 3), Math.floor(n / 2), n - 1, n];
          for (const k of ks) {
            const v = Math.min(max, min + k * step); // float arithmetic, as a slider computes it
            const p = { ...(base[t.id] ?? {}), [prm.key]: input(prm.kind, v) };
            expect(() => compile(build(t.id, p)), `${t.id}.${prm.key} = ${v}`).not.toThrow();
            checked++;
          }
        }
      }
    };
    sweep(RULE_TEMPLATES, (id, p) => ruleTemplate(id as never, p), (s) => compileRules(s));
    sweep(GRAPH_TEMPLATES, (id, p) => graphTemplate(id as never, p), (g) => compileGraph(g));
    expect(checked).toBeGreaterThan(100);
  });
});

describe("canvas <-> PXG1", () => {
  it("compileCanvas / decompileCanvas round-trip bytes, names and explicit positions", () => {
    const rng = new Rng(0x5eed_0003n);
    for (let k = 0; k < 80; k++) {
      const g = randGraph(rng);
      const bytes = compileGraph(g);
      const ids = g.nodes.map((n) => n.id);
      const positions = Object.fromEntries(ids.map((id, i) => [id, { x: i * 10, y: 7 }]));
      const c = decompileCanvas(bytes, { ids, positions });
      expect(c.nodes.map((n) => n.id)).toEqual(ids);
      expect(c.nodes.map((n) => [n.x, n.y])).toEqual(ids.map((_, i) => [i * 10, 7]));
      expect(c.edges).toHaveLength(g.nodes.filter((n) => n.trigger.kind === "after").length);
      expect(compileCanvas(c)).toEqual(bytes);
    }
  });

  it("decompile refuses duplicate or invalid node names instead of building a graph that can't compile", () => {
    const bytes = compileGraph(graph().node("a", every("1d"), null, burn(1)).node("b", every("1d"), null, burn(1)).build());
    expect(progError(() => decompileCanvas(bytes, { ids: ["x", "x"] })).code).toBe("BadModel");
    expect(progError(() => decompileCanvas(bytes, { ids: ["x", "not a name"] })).code).toBe("BadModel");
    expect(decompileCanvas(bytes, { ids: ["x", "y"] }).nodes.map((n) => n.id)).toEqual(["x", "y"]);
  });

  it("a launch without a guard says so instead of reporting an empty window", () => {
    const e = progError(() => rules({ guardSecs: 0 }).deny(when.buy()).compile());
    expect(e.code).toBe("WindowPastGuard");
    expect(e.message).toContain("no launch guard");
  });
});

describe("simulateGraph input checks", () => {
  const g = graph().node("bb", every("1d"), null, buybackBurn({ maxIn: 1 })).build();
  const M = { migrationPrice: 0.000001, poolFeeBps: 100, poolSol: "none" as const };

  it("a price that is not a positive finite number is a ProgError naming the step", () => {
    for (const p of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const e = progError(() => simulateGraph(g, { ...M, epochs: 3, priceFn: (step) => (step === 2 ? p : 0.000001), initialTreasury: { sol: 10 } }));
      expect(e.code).toBe("BadAmount");
      expect(e.message).toContain("step 2");
    }
    expect(progError(() => simulateGraph(g, { ...M, epochs: 1, migrationPrice: 0 })).code).toBe("BadAmount");
    expect(progError(() => simulateGraph(g, { ...M, epochs: 1, poolSol: 0 })).code).toBe("BadAmount");
  });

  it("the market is explicit (review U5): the migration price, the pool fee and the pool depth are required", () => {
    const { migrationPrice, poolFeeBps, poolSol } = M;
    const missing = [{ poolFeeBps, poolSol }, { migrationPrice, poolSol }, { migrationPrice, poolFeeBps }];
    for (const o of missing) {
      const e = progError(() => simulateGraph(g, { epochs: 1, ...o } as unknown as Parameters<typeof simulateGraph>[1]));
      expect(e.code).toBe("BadModel");
      expect(e.message).toMatch(/required/);
    }
    for (const fee of [-1, 1.5, 10_000]) expect(progError(() => simulateGraph(g, { ...M, epochs: 1, poolFeeBps: fee })).code).toBe("BadModel");
  });

  it("epochs, step and tick lengths are checked", () => {
    for (const epochs of [-1, 1.5, MAX_SIM_STEPS + 1]) expect(progError(() => simulateGraph(g, { ...M, epochs })).code).toBe("BadModel");
    expect(progError(() => simulateGraph(g, { ...M, epochs: 1, stepSecs: 0 })).code).toBe("BadDuration");
    expect(progError(() => simulateGraph(g, { ...M, epochs: 1, tickSecs: -5 })).code).toBe("BadDuration");
    expect(simulateGraph(g, { ...M, epochs: 0 }).steps).toHaveLength(0);
  });

  it("a premium below the pool fee can never buy (min_out from the bound), and the timeline says why", () => {
    const at = (bps: number): ReturnType<typeof simulateGraph> =>
      simulateGraph(graph().node("bb", every("1d"), null, buybackBurn({ maxIn: 1, maxPremiumBps: bps })).build(), {
        ...M,
        epochs: 3,
        initialTreasury: { sol: 10 },
      });
    const none = at(0);
    expect(none.totals.runs).toBe(0);
    const reasons = none.steps.flatMap((s) => s.blocked.map((b) => b.reason));
    expect(reasons).toContain("premiumBelowFee");
    expect(none.steps.flatMap((s) => s.blocked).find((b) => b.reason === "premiumBelowFee")!.why).toContain("fee");
    expect(at(200).totals.runs).toBe(3);
  });

  it("supply never goes negative, even when the mock market is absurd", () => {
    const tiny = simulateGraph(g, { ...M, epochs: 3, priceFn: () => 1e-30, initialTreasury: { sol: 1000 }, supply: 1000 });
    for (const s of tiny.steps) expect(s.supply >= 0n).toBe(true);
    const burner = graph().node("b", every("1h"), null, burn(1_000_000)).build();
    const over = simulateGraph(burner, { ...M, epochs: 2, tokenInflowFn: () => 5_000_000, supply: 10 });
    for (const s of over.steps) expect(s.supply >= 0n).toBe(true);
    expect(over.final.supply).toBe(0n);
  });

  it("nodeStatuses equals nodeStatus node by node (seeded states)", () => {
    const rng = new Rng(0x5eed_0002n);
    for (let k = 0; k < 60; k++) {
      const rg = randGraph(rng);
      const st = newAutopilotState(rg, 1n << 50n);
      const t0 = 1_800_000_000;
      for (let j = 0; j < 6; j++) recordRun(rg, st, rng.below(rg.nodes.length), t0 + rng.range(0, 5 * DAY), BigInt(rng.range(0, 1_000_000_000)));
      const env = {
        now: t0 + rng.range(0, 10 * DAY),
        treasurySol: BigInt(rng.range(0, 5_000)) * 1_000_000n,
        treasuryTokens: BigInt(rng.range(0, 5_000)) * 1_000_000n,
        graduated: rng.coin(),
        spotSqrtPriceQ64: rng.next() >> 20n,
      };
      if (rng.coin()) st.refSqrtPriceQ64 = (rng.next() >> 20n) | 1n;
      const all = nodeStatuses(rg, st, env);
      rg.nodes.forEach((_, i) => expect(all[i]).toEqual(nodeStatus(rg, st, env, i)));
    }
  });
});

/**
 * The README's examples are real: every DSL example parses, compiles and
 * prints back canonically, and the TypeScript example builds what it says.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  after,
  buybackBurn,
  burn,
  compileGraph,
  compileRules,
  encodeBase58,
  every,
  graph,
  parseGraph,
  parseRules,
  printGraph,
  printRules,
  rules,
  verifyGraph,
  verifyRules,
  when,
} from "../../src/programmable/index.js";

const readme = readFileSync(new URL("../../src/programmable/README.md", import.meta.url), "utf8");
const blocks = [...readme.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]!);
const example = (head: string): string => {
  const b = blocks.find((x) => x.startsWith(head) && !x.includes(":="));
  if (!b) throw new Error(`README has no "${head}" example`);
  return b;
};
/** Fills `<address>` placeholders with distinct valid addresses. */
function fill(text: string): string {
  let i = 0;
  return text.replace(/<address>/g, () => encodeBase58(new Uint8Array(32).fill(++i + 40)));
}

describe("README examples", () => {
  it("the rules DSL example parses, compiles, verifies and prints back to itself", () => {
    const set = parseRules(example("rules v1"));
    const bytes = compileRules(set);
    expect(verifyRules(bytes, { guardSecs: 3600 }).ok).toBe(true);
    expect(set.rules).toHaveLength(4);
    expect(printRules(parseRules(printRules(set)))).toBe(printRules(set));
  });

  it("the autopilot DSL example parses, compiles, verifies and prints back to itself", () => {
    const g = parseGraph(fill(example("autopilot v1")));
    expect(verifyGraph(compileGraph(g)).ok).toBe(true);
    expect(g.nodes.map((n) => n.id)).toEqual(["buyback", "share"]);
    expect(g.nodes[1]!.operatorGated).toBe(true);
    expect(printGraph(parseGraph(printGraph(g)))).toBe(printGraph(g));
  });

  it("the TypeScript example builds valid bytes", () => {
    const ts = blocks.find((b) => b.includes("rules({ guardSecs: 3600 })"))!;
    expect(ts).toContain("graph()");
    const r = rules({ guardSecs: 3600 })
      .key("team", "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin")
      .deny(when.buy().and(when.timeLt("2m")).and(when.txIxCountGt(10)), "BOT")
      .capAmount("0.5%", when.buy(), { code: "WHALE", first: "10m" })
      .deny(when.buy().and(when.toIn("team")), "TEAM")
      .compile();
    expect(verifyRules(r, { guardSecs: 3600 }).ok).toBe(true);
    const g = graph()
      .node("buyback", every("1d"), when.treasurySolGte(1), buybackBurn({ maxIn: 0.5, maxPremiumBps: 300 }), { budgetPerEpoch: 2 })
      .node("burn-rest", after("buyback"), null, burn({ maxTokens: 1_000_000 }))
      .compile();
    expect(verifyGraph(g).ok).toBe(true);
  });
});

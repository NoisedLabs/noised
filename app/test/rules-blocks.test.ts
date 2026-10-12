/**
 * Custom launch rules in the Create wizard (PROGRAMMABLE_V1 §6): sentence
 * blocks <-> SDK rules <-> the text DSL. Blocks round-trip exactly through
 * the code; rules blocks can't express stay code-only (never rewritten);
 * every template compiles to verified PXR1 within the 1,228-byte limit; and
 * the draft's problems reach the wizard's step badge.
 */
import { describe, expect, it } from "vitest";

import { compileRuleSet, parseRulesText, printRulesText, type Rule } from "../src/lib/programmable";
import { amountOf, amountText, blockToRule, defaultBlock, itemsFromRules, ruleToBlock, sameCond, type RuleBlock } from "../src/pages/create/rules/blocks";
import { buildDraft, draftProblems, EMPTY_RULES, withItems, withText, type RulesEnv } from "../src/pages/create/rules/state";

const env: RulesEnv = { guardSecs: 6 * 3600, openDelaySecs: 300, graceSecs: 600, decimals: 6 };
const TEAM = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const OTHER = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
let n = 0;
const ids = (): string => `t${++n}`;

const BLOCKS: RuleBlock[] = [
  { window: "first", fromSecs: 0, toSecs: 1200, effect: "deny", cap: { value: "0.5", unit: "pct" }, who: "buys", extras: [{ kind: "ixCountGt", n: "10" }], code: 1 },
  { window: "between", fromSecs: 300, toSecs: 3600, effect: "capAmount", cap: { value: "0.25", unit: "pct" }, who: "buys", extras: [], code: 8 },
  { window: "whole", fromSecs: 0, toSecs: 0, effect: "capBalance", cap: { value: "1", unit: "pct" }, who: "all", extras: [], code: 3 },
  { window: "whole", fromSecs: 0, toSecs: 0, effect: "deny", cap: { value: "0.5", unit: "pct" }, who: "buys", extras: [{ kind: "toIn", keys: [TEAM] }], code: 4 },
  { window: "first", fromSecs: 0, toSecs: 900, effect: "deny", cap: { value: "0.5", unit: "pct" }, who: "buys", extras: [{ kind: "toNotIn", keys: [TEAM, OTHER] }, { kind: "amountGt", amount: { value: "1000", unit: "tokens" } }], code: 5 },
  { window: "first", fromSecs: 0, toSecs: 7200, effect: "capAmount", cap: { value: "5000", unit: "tokens" }, who: "p2p", extras: [{ kind: "programNotIn", keys: [OTHER] }], code: 7 },
];

/** A block as the editor would show it again after a trip through rules / code (whole-guard windows keep toSecs). */
function normal(b: RuleBlock, guardSecs = env.guardSecs): RuleBlock {
  return { ...b, toSecs: b.window === "whole" ? guardSecs : b.toSecs, fromSecs: b.window === "between" ? b.fromSecs : 0, cap: b.effect === "deny" ? { value: "0.5", unit: "pct" } : b.cap };
}

describe("sentence blocks <-> SDK rules", () => {
  it("every block converts to a rule and back to the same block", () => {
    for (const b of BLOCKS) {
      const r = blockToRule(b);
      const back = ruleToBlock(r, env.guardSecs, env.decimals);
      expect(back).toEqual(normal(b));
    }
  });

  it("the who and extra conditions become one left-leaning AND, in order", () => {
    const r = blockToRule(BLOCKS[4] as RuleBlock);
    expect(r.when).toEqual({
      op: "and",
      a: { op: "and", a: { op: "buy" }, b: { op: "not", x: { op: "toIn", keys: [TEAM, OTHER] } } },
      b: { op: "amountGt", amount: { tokens: "1000" } },
    });
    expect(r.cap).toBeUndefined();
    // "While the guard is on" follows the guard length: `to: null`.
    expect(blockToRule(BLOCKS[2] as RuleBlock).to).toBeNull();
    expect(blockToRule(BLOCKS[2] as RuleBlock).cap).toEqual({ bps: 100 });
  });

  it("rules blocks can't express stay code-only instead of being rewritten", () => {
    const or: Rule = { from: 0, to: 600, effect: "deny", when: { op: "or", a: { op: "buy" }, b: { op: "p2p" } }, code: 1 };
    const timeInside: Rule = { from: 0, to: 600, effect: "deny", when: { op: "and", a: { op: "buy" }, b: { op: "timeLt", secs: 60 } }, code: 1 };
    const rightLeaning: Rule = { from: 0, to: 600, effect: "deny", when: { op: "and", a: { op: "buy" }, b: { op: "and", a: { op: "ixCountGt", n: 3 }, b: { op: "amountGt", amount: { bps: 10 } } } }, code: 1 };
    const notBuy: Rule = { from: 0, to: 600, effect: "deny", when: { op: "not", x: { op: "buy" } }, code: 1 };
    for (const r of [or, timeInside, rightLeaning, notBuy]) expect(ruleToBlock(r, env.guardSecs, env.decimals)).toBeNull();
    const items = itemsFromRules([or, blockToRule(BLOCKS[0] as RuleBlock)], env.guardSecs, env.decimals, ids);
    expect("code" in (items[0] ?? {})).toBe(true);
    expect("block" in (items[1] ?? {})).toBe(true);
  });

  it("amounts: shares of supply in 0.01% steps, whole tokens, and plain refusals", () => {
    expect(amountOf({ value: "0.25", unit: "pct" }, "x")).toEqual({ bps: 25 });
    expect(amountOf({ value: "100", unit: "pct" }, "x")).toEqual({ bps: 10_000 });
    expect(amountOf({ value: "12.5", unit: "tokens" }, "x")).toEqual({ tokens: "12.5" });
    expect(() => amountOf({ value: "0.001", unit: "pct" }, "Cap")).toThrow(/two decimals/);
    expect(() => amountOf({ value: "0", unit: "pct" }, "Cap")).toThrow(/between 0.01% and 100%/);
    expect(() => amountOf({ value: "101", unit: "pct" }, "Cap")).toThrow(/between/);
    expect(() => amountOf({ value: "abc", unit: "tokens" }, "Cap")).toThrow(/number/);
    expect(amountText({ raw: 1_500_000n }, 6)).toEqual({ value: "1.5", unit: "tokens" });
    expect(amountText({ bps: 5 }, 6)).toEqual({ value: "0.05", unit: "pct" });
  });

  it("an incomplete block says what is missing", () => {
    expect(() => blockToRule({ ...(BLOCKS[3] as RuleBlock), extras: [{ kind: "toIn", keys: [] }] })).toThrow(/at least one wallet/);
    expect(() => blockToRule({ ...(BLOCKS[0] as RuleBlock), extras: [{ kind: "ixCountGt", n: "300" }] })).toThrow(/0 to 255/);
  });
});

describe("blocks <-> code (the rules DSL)", () => {
  it("blocks -> code -> blocks is exact, and the bytes are identical", () => {
    const items = BLOCKS.map((block) => ({ id: ids(), block }));
    const draft = withItems(EMPTY_RULES, items, env);
    // Printed without the guard line: "always" means until the guard ends, "first 20m" stays 20 minutes (review U15).
    expect(draft.text).toMatch(/^rules v1\n/);
    expect(draft.text).not.toMatch(/^guard/m);
    const before = buildDraft(draft, env).build;
    const parsed = withText(draft, draft.text, env);
    expect(parsed.problems).toEqual([]);
    expect(parsed.items.map((x) => ("block" in x ? x.block : null))).toEqual(BLOCKS.map((b) => normal(b)));
    const after = buildDraft(parsed, env).build;
    expect(before?.ok && after?.ok).toBe(true);
    if (before?.ok && after?.ok) expect(after.bytes).toEqual(before.bytes);
  });

  it("code with a mistake keeps the last blocks and points at the line and column", () => {
    const draft = withItems(EMPTY_RULES, [{ id: ids(), block: BLOCKS[0] as RuleBlock }], env);
    const broken = withText(draft, draft.text.replace("instructions > 10", "instructions > lots"), env);
    expect(broken.items).toBe(draft.items);
    expect(broken.problems.length).toBeGreaterThan(0);
    const p = broken.problems[0];
    expect(p?.line).toBe(draft.text.split("\n").findIndex((l) => l.includes("instructions")) + 1);
    expect(p?.col).toBeGreaterThan(1);
    expect(draftProblems(broken, env)[0]).toMatch(/code has 1 problem/);
  });

  it("a guard line that disagrees with the launch is refused (the chain verifies against the launch's guard)", () => {
    const r = parseRulesText("rules v1\nguard 1h\n\nalways: deny when buy\n", { guardSecs: env.guardSecs, tokenDecimals: 6 });
    expect(r.ok).toBe(false);
  });

  it("a window past the guard's end is a problem on its rule", () => {
    const longer = { ...(BLOCKS[0] as RuleBlock), toSecs: env.guardSecs + 60 };
    const draft = withItems(EMPTY_RULES, [{ id: ids(), block: longer }], env);
    const { build } = buildDraft(draft, env);
    expect(build?.ok).toBe(false);
    if (build && !build.ok) expect(build.rule).toBe(0);
    expect(draftProblems(draft, env).join(" ")).toMatch(/rule 1/);
  });

  it("no rules is no custom rule set (the all-zero hash at launch)", () => {
    expect(buildDraft(EMPTY_RULES, env).build).toBeNull();
    expect(draftProblems(EMPTY_RULES, env)).toEqual([]);
  });
});

describe("a window that ends when the guard ends (review U15)", () => {
  const guard1h: RulesEnv = { ...env, guardSecs: 3600 };
  it("'first 1h' with a 1-hour guard stays 'first 1h' through the code, and a longer guard never stretches it", () => {
    const block: RuleBlock = { window: "first", fromSecs: 0, toSecs: 3600, effect: "deny", cap: { value: "0.5", unit: "pct" }, who: "buys", extras: [], code: 1 };
    const draft = withItems(EMPTY_RULES, [{ id: ids(), block }], guard1h);
    expect(draft.text).toContain("first 1h: deny when buy");
    const parsed = withText(draft, draft.text, guard1h);
    const back = parsed.items[0];
    expect(back && "block" in back ? back.block.window : null).toBe("first");
    expect(back && "block" in back ? back.block.toSecs : null).toBe(3600);
    // The guard grows to 6 hours: the rule still ends after one hour.
    const longer = withItems(parsed, parsed.items, env);
    const b = buildDraft(longer, env).build;
    expect(b?.ok).toBe(true);
    expect(longer.text).toContain("first 1h: deny when buy");
  });

  it("'always' follows the guard: printed as always, parsed back as until the guard ends", () => {
    const block: RuleBlock = { window: "whole", fromSecs: 0, toSecs: 0, effect: "deny", cap: { value: "0.5", unit: "pct" }, who: "buys", extras: [], code: 1 };
    const draft = withItems(EMPTY_RULES, [{ id: ids(), block }], guard1h);
    expect(draft.text).toContain("always: deny when buy");
    const parsed = withText(draft, draft.text, env);
    const back = parsed.items[0];
    expect(back && "block" in back ? back.block.window : null).toBe("whole");
  });
});

describe("structural equality helper", () => {
  it("compares bigint amounts too", () => {
    expect(sameCond({ op: "amountGt", amount: { raw: 5n } }, { op: "amountGt", amount: { raw: 5n } })).toBe(true);
    expect(sameCond({ op: "amountGt", amount: { raw: 5n } }, { op: "amountGt", amount: { raw: 6n } })).toBe(false);
  });

  it("the default block is valid and ends inside the guard", () => {
    expect(compileRuleSet({ guardSecs: 300, keys: [], rules: [blockToRule(defaultBlock(300))] }).ok).toBe(true);
    expect(printRulesText({ guardSecs: 300, keys: [], rules: [blockToRule(defaultBlock(300))] })).toContain("first 5m: deny when buy and instructions > 10 code BOT");
    expect(printRulesText({ guardSecs: 3600, keys: [], rules: [blockToRule(defaultBlock(3600))] })).toContain("first 10m: deny when buy and instructions > 10 code BOT");
  });
});

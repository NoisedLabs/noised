/**
 * The Simple rules gallery (pages/create/rules/presets.ts, state.ts): every
 * stop of every slider builds a rule set the SDK compiles and verifies; no
 * preset refuses an ordinary buy (up to 8 instructions, a small amount, a
 * fresh wallet), and no window ends before trading opens (review U6); presets
 * compose into one rule set with the creator's own rules and stay in step with
 * the blocks and the code.
 */
import { describe, expect, it } from "vitest";

import { compileRuleSet, MAX_ORDINARY_BUY_INSTRUCTIONS, MIN_TX_IX_COUNT_THRESHOLD, ruleKeyList, tryRulesTransfer, type GuardFacts, type RuleSet } from "../src/lib/programmable";
import { defaultBlock } from "../src/pages/create/rules/blocks";
import { defaultValues, PRESETS, presetRules, tradingOpensAt, type PresetValues, type RulesEnv } from "../src/pages/create/rules/presets";
import { buildDraft, draftProblems, editItem, EMPTY_RULES, hasRules, presetProblems, refreshPresets, removeItems, ruleSetOf, setPreset, withItems, withText } from "../src/pages/create/rules/state";

const TEAM = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const ENVS: RulesEnv[] = [
  { guardSecs: 6 * 3600, openDelaySecs: 300, graceSecs: 600, decimals: 6 },
  { guardSecs: 3600, openDelaySecs: 1800, graceSecs: 600, decimals: 9 },
  { guardSecs: 72 * 3600, openDelaySecs: 60, graceSecs: 600, decimals: 6 },
];

function guardOf(env: RulesEnv): GuardFacts {
  return { openDelaySecs: env.openDelaySecs, graceSecs: env.graceSecs, guardSecs: env.guardSecs, maxBuyBps: 0, maxWalletBps: 0, p2pLocked: false, supply: 1_000_000_000n * 10n ** BigInt(env.decimals), decimals: env.decimals };
}

/** Every combination of slider stops of a preset. */
function* allValues(id: (typeof PRESETS)[number]["id"]): Generator<PresetValues> {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) return;
  const a = p.sliders[0].stops.length;
  const b = p.sliders[1]?.stops.length ?? 1;
  for (let i = 0; i < a; i++) for (let j = 0; j < b; j++) yield { a: i, b: j, wallets: p.wallets === true ? [TEAM] : [] };
}

describe("presets", () => {
  it("every stop of every slider builds rules the SDK compiles and verifies, for short and long guards", () => {
    for (const env of ENVS) {
      for (const p of PRESETS) {
        for (const v of allValues(p.id)) {
          const r = presetRules(p.id, v, env);
          expect(r.ok, `${p.id} ${JSON.stringify(v)}`).toBe(true);
          if (!r.ok) continue;
          const b = compileRuleSet({ ...r.set, guardSecs: env.guardSecs, tokenDecimals: env.decimals });
          expect(b.ok, `${p.id} ${JSON.stringify(v)} ${b.ok ? "" : b.message}`).toBe(true);
          expect(p.say(v, env).length).toBeGreaterThan(20);
        }
      }
    }
  });

  it("no preset refuses an ordinary buy right after trading opens (review U6)", () => {
    for (const env of ENVS) {
      const opens = tradingOpensAt(env);
      for (const p of PRESETS) {
        for (const v of allValues(p.id)) {
          const r = presetRules(p.id, v, env);
          if (!r.ok) continue;
          const set: RuleSet = { ...r.set, guardSecs: env.guardSecs, tokenDecimals: env.decimals };
          for (const instructions of [4, 6, MAX_ORDINARY_BUY_INSTRUCTIONS]) {
            const verdict = tryRulesTransfer(set, { kind: "buy", at: opens + 30, amount: (10n ** BigInt(env.decimals) * 1_000_000_000n) / 100_000n, instructions, program: "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN" }, guardOf(env));
            expect(verdict.allowed, `${p.id} ${JSON.stringify(v)} with ${instructions} instructions: ${verdict.why}`).toBe(true);
          }
        }
      }
    }
  });

  it("time windows run past the opening of trading, never end inside the batch (review U6)", () => {
    for (const env of ENVS) {
      for (const p of PRESETS) {
        for (const v of allValues(p.id)) {
          const r = presetRules(p.id, v, env);
          if (!r.ok) continue;
          for (const rule of r.set.rules) {
            const end = rule.to ?? env.guardSecs;
            if (p.id !== "team-cant-buy") expect(end, `${p.id} ends at ${end}`).toBeGreaterThan(tradingOpensAt(env));
            expect(end).toBeLessThanOrEqual(env.guardSecs);
          }
        }
      }
    }
  });

  it("the anti-bot preset refuses a bundled buy, and never offers a limit below an ordinary buy", () => {
    const env = ENVS[0] as RulesEnv;
    const anti = PRESETS.find((p) => p.id === "anti-bot");
    if (!anti) throw new Error("missing");
    // Review 4 (R6): never below the SDK's floor of 10 (wallets add their own compute-budget and similar steps).
    expect(Math.min(...(anti.sliders[1]?.stops ?? []))).toBe(MIN_TX_IX_COUNT_THRESHOLD);
    expect(MIN_TX_IX_COUNT_THRESHOLD).toBeGreaterThan(MAX_ORDINARY_BUY_INSTRUCTIONS);
    const r = presetRules("anti-bot", defaultValues(anti), env);
    if (!r.ok) throw new Error(r.problem);
    const set: RuleSet = { ...r.set, guardSecs: env.guardSecs, tokenDecimals: env.decimals };
    const v = tryRulesTransfer(set, { kind: "buy", at: tradingOpensAt(env) + 60, amount: 1_000_000n, instructions: 20 }, guardOf(env));
    expect(v.allowed).toBe(false);
    expect(v.refusal).toBe("RuleDenied");
  });

  it("a window longer than the early limits becomes 'until they end', and says so", () => {
    const env: RulesEnv = { guardSecs: 3600, openDelaySecs: 1800, graceSecs: 600, decimals: 6 };
    const fair = PRESETS.find((p) => p.id === "fair-start");
    if (!fair) throw new Error("missing");
    const v = { a: 6, b: 0, wallets: [] }; // six hours, more than the one-hour guard
    const r = presetRules("fair-start", v, env);
    expect(r.ok && r.set.rules[0]?.to).toBeNull();
    expect(fair.say(v, env)).toMatch(/Until the early limits end/);
  });

  it("the team preset needs a wallet, and names every wallet in full", () => {
    const env = ENVS[0] as RulesEnv;
    const team = PRESETS.find((p) => p.id === "team-cant-buy");
    if (!team) throw new Error("missing");
    expect(presetRules("team-cant-buy", defaultValues(team), env)).toEqual({ ok: false, problem: "Add at least one team wallet." });
    const d = setPreset(EMPTY_RULES, "team-cant-buy", defaultValues(team), env);
    expect(presetProblems(d, env)["team-cant-buy"]).toMatch(/team wallet/);
    expect(draftProblems(d, env).join(" ")).toMatch(/Team can't buy/);
    const ok = setPreset(d, "team-cant-buy", { ...defaultValues(team), wallets: [TEAM] }, env);
    expect(draftProblems(ok, env)).toEqual([]);
    expect(ruleKeyList(ruleSetOf(ok, env).set)).toEqual([{ address: TEAM, name: null }]);
    expect(team.say({ ...defaultValues(team), wallets: [TEAM] }, env)).toMatch(/can't receive tokens bought from the pool/);
  });
});

describe("the draft: gallery, blocks and code in step", () => {
  const env = ENVS[0] as RulesEnv;
  const fair = PRESETS.find((p) => p.id === "fair-start") as (typeof PRESETS)[number];
  const anti = PRESETS.find((p) => p.id === "anti-bot") as (typeof PRESETS)[number];

  it("presets compose with the creator's own rules into one rule set", () => {
    let d = setPreset(EMPTY_RULES, "fair-start", defaultValues(fair), env);
    d = withItems(d, [...d.items, { id: "own", block: defaultBlock(env.guardSecs) }], env);
    d = setPreset(d, "anti-bot", defaultValues(anti), env);
    expect(d.items.map((x) => x.preset ?? "own")).toEqual(["fair-start", "own", "anti-bot"]);
    const b = buildDraft(d, env).build;
    expect(b?.ok).toBe(true);
    expect(hasRules(d)).toBe(true);
    expect(d.text).toMatch(/^rules v1/);
  });

  it("moving a slider changes only that preset's rules, in place", () => {
    let d = setPreset(EMPTY_RULES, "fair-start", defaultValues(fair), env);
    d = setPreset(d, "anti-bot", defaultValues(anti), env);
    const before = d.items.map((x) => x.id);
    d = setPreset(d, "fair-start", { ...defaultValues(fair), b: 4 }, env);
    expect(d.items[0]?.preset).toBe("fair-start");
    expect(d.items[1]?.id).toBe(before[1]);
    const cap = ruleSetOf(d, env).set.rules[0]?.cap;
    expect(cap).toEqual({ bps: 100 });
  });

  it("switching a preset off removes its rules only", () => {
    let d = setPreset(EMPTY_RULES, "fair-start", defaultValues(fair), env);
    d = setPreset(d, "anti-bot", defaultValues(anti), env);
    d = setPreset(d, "fair-start", null, env);
    expect(d.items.every((x) => x.preset === "anti-bot")).toBe(true);
    expect(d.presets["fair-start"]).toBeUndefined();
  });

  it("new early limits or batch window rebuild the presets' windows", () => {
    const d = setPreset(EMPTY_RULES, "fair-start", defaultValues(fair), env);
    const longer = refreshPresets(d, { ...env, openDelaySecs: 900 });
    const to0 = ruleSetOf(d, env).set.rules[0]?.to ?? 0;
    const to1 = ruleSetOf(longer, { ...env, openDelaySecs: 900 }).set.rules[0]?.to ?? 0;
    expect(to1 - to0).toBe(600);
  });

  it("an unchanged code edit keeps the presets on; editing a preset's rule makes its rules your own", () => {
    let d = setPreset(EMPTY_RULES, "fair-start", defaultValues(fair), env);
    d = setPreset(d, "anti-bot", defaultValues(anti), env);
    const same = withText(d, d.text, env);
    expect(Object.keys(same.presets).sort()).toEqual(["anti-bot", "fair-start"]);
    expect(same.items.map((x) => x.preset)).toEqual(["fair-start", "anti-bot"]);
    const changed = withText(d, d.text.replace("instructions > 12", "instructions > 14"), env);
    expect(changed.presets["anti-bot"]).toBeUndefined();
    expect(changed.presets["fair-start"]).toBeDefined();
    expect(changed.items.length).toBe(2);
    const first = d.items[0];
    if (!first || !("block" in first)) throw new Error("block expected");
    const edited = editItem(d, first.id, { id: first.id, block: { ...first.block, code: 8 } }, env);
    expect(edited.presets["fair-start"]).toBeUndefined();
    expect(edited.items[0]?.preset).toBeUndefined();
    const removed = removeItems(d, [first.id], env);
    expect(removed.presets["fair-start"]).toBeUndefined();
    expect(removed.items.length).toBe(1);
  });
});

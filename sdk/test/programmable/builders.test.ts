/** Code builders, normalization, templates and the plain-English explanations. */
import { describe, expect, it } from "vitest";

import {
  Condition,
  GRAPH_TEMPLATES,
  ProgError,
  RULE_TEMPLATES,
  all,
  any,
  burn,
  compileGraph,
  compileRules,
  decompileRules,
  explainGraph,
  explainRules,
  graph,
  graphTemplate,
  mergeRuleSets,
  normalizeRules,
  not,
  ruleCode,
  ruleTemplate,
  rules,
  simulateTransfer,
  when,
  whenever,
} from "../../src/programmable/index.js";
import type { RuleSet } from "../../src/programmable/index.js";
import { ka } from "./helpers.js";

const TEAM = ka(0x7e);
const OPS = ka(0x0b);

describe("conditions", () => {
  it("combinators build plain trees", () => {
    expect(when.buy().and(when.p2p()).ast).toEqual({ op: "and", a: { op: "buy" }, b: { op: "p2p" } });
    expect(all().ast).toEqual({ op: "true" });
    expect(any().ast).toEqual({ op: "false" });
    expect(all(when.buy(), when.p2p(), when.always()).ast).toEqual({ op: "and", a: { op: "and", a: { op: "buy" }, b: { op: "p2p" } }, b: { op: "true" } });
    expect(not(when.buy()).ast).toEqual({ op: "not", x: { op: "buy" } });
    expect(when.buy().not()).toBeInstanceOf(Condition);
    expect(when.amountGt("0.5%").ast).toEqual({ op: "amountGt", amount: { bps: 50 } });
    expect(when.amountGt(1_000).ast).toEqual({ op: "amountGt", amount: { tokens: "1000" } });
    expect(when.amountGt(5n).ast).toEqual({ op: "amountGt", amount: { raw: 5n } });
    expect(when.timeLt("2m").ast).toEqual({ op: "timeLt", secs: 120 });
    expect(when.before("2027-01-01").ast).toEqual({ op: "nowLt", unix: 1_798_761_600n });
  });
});

describe("rules builder", () => {
  it("windows: whole guard by default, first / after / from..to", () => {
    const s = rules({ guardSecs: 3_600 })
      .deny(when.buy())
      .deny(when.buy(), { first: "2m" })
      .deny(when.buy(), { after: "10m" })
      .deny(when.buy(), { from: "1m", to: "5m" })
      .build();
    // "Until the guard ends" stays open (review U15: it follows the guard); compiling resolves it.
    expect(s.rules.map((r) => [r.from, r.to])).toEqual([
      [0, null],
      [0, 120],
      [600, null],
      [60, 300],
    ]);
    expect(normalizeRules(s).rules.map((r) => [r.from, r.to])).toEqual([
      [0, 3_600],
      [0, 120],
      [600, 3_600],
      [60, 300],
    ]);
  });

  it("codes by name or number; bad codes throw", () => {
    expect(ruleCode("BOT")).toBe(1);
    expect(ruleCode("whale" as never)).toBe(3);
    expect(ruleCode(63)).toBe(63);
    expect(() => ruleCode(64)).toThrow(ProgError);
    expect(() => ruleCode("NOPE" as never)).toThrow(/unknown rule code/);
  });

  it("labels resolve to addresses; key lists follow the key table; unused keys are dropped", () => {
    const s = rules({ guardSecs: 600 })
      .key("team", TEAM)
      .key("ops", OPS)
      .key("unused", ka(0x99))
      .deny(when.toIn(["ops", "team", TEAM]))
      .build();
    expect(s.keys).toEqual([
      { address: TEAM, label: "team" },
      { address: OPS, label: "ops" },
    ]);
    expect(s.rules[0]!.when).toEqual({ op: "toIn", keys: [TEAM, OPS] });
  });

  it("addresses used without a declaration are appended to the key table", () => {
    const s = rules({ guardSecs: 600 }).deny(when.fromIn(OPS)).deny(when.toIn([TEAM, OPS])).build();
    expect(s.keys.map((k) => k.address)).toEqual([OPS, TEAM]);
  });

  it("friendly errors: unknown label, graph leaf in a rule, unknown guard, too many keys", () => {
    expect(() => rules({ guardSecs: 600 }).deny(when.toIn("team")).compile()).toThrow(expect.objectContaining({ code: "UnknownKey" }));
    expect(() => rules({ guardSecs: 600 }).deny(when.graduated()).compile()).toThrow(/autopilot condition/);
    expect(() => rules().deny(when.buy()).compile()).toThrow(expect.objectContaining({ code: "BadWindow" }));
    const nine = Array.from({ length: 9 }, (_, i) => ka(i + 1));
    expect(() => rules({ guardSecs: 600 }).deny(when.toIn(nine)).compile()).toThrow(expect.objectContaining({ code: "TooManyKeys" }));
    expect(() => rules({ guardSecs: 600 }).compile()).toThrow(expect.objectContaining({ code: "NoRules" }));
  });

  it("tokens amounts use the set's decimals", () => {
    const a = rules({ guardSecs: 600, tokenDecimals: 9 }).capAmount(2, when.buy()).build();
    expect(a.rules[0]!.cap).toEqual({ raw: 2_000_000_000n });
    const b = rules({ guardSecs: 600 }).capAmount(2, when.buy()).build();
    expect(b.rules[0]!.cap).toEqual({ raw: 2_000_000n });
  });

  it("normalize is idempotent and compile ignores the difference", () => {
    const built = rules({ guardSecs: 600 }).key("team", TEAM).deny(when.toIn("team").and(when.amountGt(10))).build();
    const s = normalizeRules(built);
    expect(normalizeRules(s)).toEqual(s);
    expect(compileRules(s)).toEqual(compileRules(built));
    const d = decompileRules(compileRules(s), { guardSecs: 600, labels: { [TEAM]: "team" } });
    expect(d).toEqual(s);
  });
});

const PARAMS: Record<string, Record<string, unknown>> = {
  "team-cant-buy": { team: [TEAM, OPS] },
  "revenue-share": { recipients: [{ address: TEAM, share: "60%", label: "team" }, { address: OPS, share: "40%" }] },
  "ai-buyback": { operator: ka(0xa1) },
};

describe("templates", () => {
  it("every rule template builds a valid rule set with defaults", () => {
    for (const t of RULE_TEMPLATES) {
      const s = t.build(PARAMS[t.id]);
      expect(compileRules(s).length).toBeGreaterThan(12);
      expect(t.params.length).toBeGreaterThan(0);
    }
  });

  it("fair start, anti-bot, whale cap and team rules do what they say (windows count from when trading opens)", () => {
    // Defaults: guard 1h, batch window 5 min; trading opens by 15 min (batch window + 10 min to run the batch).
    const fair = ruleTemplate("fair-start");
    expect(fair.rules[0]).toMatchObject({ from: 300, to: 1_500 });
    expect(simulateTransfer(fair, { kind: "buy", at: "16m", amount: 5_000_001 }).allowed).toBe(false);
    expect(simulateTransfer(fair, { kind: "buy", at: "26m", amount: 5_000_001 }).allowed).toBe(true);
    const bot = ruleTemplate("anti-bot");
    expect(bot.rules[0]).toMatchObject({ from: 300, to: 1_020 });
    expect(simulateTransfer(bot, { kind: "buy", at: "15m", amount: 1, instructions: 11 }).codeName).toBe("BOT");
    expect(simulateTransfer(bot, { kind: "buy", at: "15m", amount: 1, instructions: 8 }).allowed).toBe(true);
    expect(() => ruleTemplate("anti-bot", { maxInstructions: 3 })).toThrow(/at least 10/);
    const whale = ruleTemplate("whale-cap", { maxBalance: "1%" });
    expect(simulateTransfer(whale, { kind: "p2p", at: "30m", amount: 10_000_001 }).allowed).toBe(false);
    const team = ruleTemplate("team-cant-buy", PARAMS["team-cant-buy"]);
    expect(simulateTransfer(team, { kind: "buy", at: "5m", amount: 1, to: OPS }).codeName).toBe("TEAM");
    expect(simulateTransfer(team, { kind: "sell", at: "5m", amount: 1, from: OPS }).allowed).toBe(true);
    expect(() => ruleTemplate("team-cant-buy")).toThrow(/team wallet/);
  });

  it("templates merge into one set", () => {
    const m: RuleSet = mergeRuleSets(ruleTemplate("anti-bot"), ruleTemplate("whale-cap"), ruleTemplate("team-cant-buy", PARAMS["team-cant-buy"]));
    expect(m.rules).toHaveLength(3);
    expect(compileRules(m).length).toBeGreaterThan(0);
    expect(() => mergeRuleSets(ruleTemplate("anti-bot", { guardSecs: 1_800 }), ruleTemplate("whale-cap"))).toThrow(/different guard/);
  });

  it("every graph template builds a valid graph", () => {
    for (const t of GRAPH_TEMPLATES) expect(compileGraph(t.build(PARAMS[t.id])).length).toBeGreaterThan(44);
    expect(() => graphTemplate("ai-buyback")).toThrow(/agent's key/);
    expect(() => graphTemplate("revenue-share")).toThrow(ProgError);
    expect(graphTemplate("ai-buyback", PARAMS["ai-buyback"]).nodes[0]).toMatchObject({ operatorGated: true, maxRunsPerEpoch: 8, budgetPerEpoch: 1_000_000_000n });
  });
});

describe("plain-English explanations (review U14: addresses, labels only next to them, no more than the chain enforces)", () => {
  it("rules: one sentence per rule, then the guarantees", () => {
    const JUP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
    const s = rules({ guardSecs: 3_600 })
      .key("team", TEAM)
      .key("jupiter", JUP)
      .key("router", OPS)
      .deny(when.buy().and(when.timeLt("2m")).and(when.txIxCountGt(10)), "BOT")
      .capAmount("0.5%", when.buy(), { code: "WHALE", first: "10m" })
      .capBalance("2%")
      .deny(when.buy().and(when.toIn("team")), "TEAM")
      .deny(when.p2p(), { after: "30m" })
      .deny(when.buy().and(when.programIn(["jupiter", "router"]).not()), { code: "ROUTER", first: "15m" })
      .build();
    expect(explainRules(s)).toEqual([
      "In the first 2 minutes: buys from the pool are refused when the transaction has more than 10 instructions. A refused transfer shows: “Looks like a bot transaction”.",
      "In the first 10 minutes: a single buy can't be more than 0.5% of the supply. A refused transfer shows: “Too large for one wallet right now”.",
      "During the launch guard (the first hour): a transfer can't leave the receiving account with more than 2% of the supply.",
      `During the launch guard (the first hour): buys from the pool are refused when the receiving wallet is “team” (${TEAM}). A refused transfer shows: “Team wallets can't do this during the launch”.`,
      "From 30 minutes after launch until the guard ends: wallet-to-wallet transfers are refused.",
      // A known program is named by the table, never by the creator's label; an unknown one only by its address.
      `In the first 15 minutes: buys from the pool are refused when it's not made through Jupiter (${JUP}) or the program ${OPS}. A refused transfer shows: “Only listed apps can do this right now”.`,
      "Selling is always allowed: no rule can block a sell.",
      "Every rule switches off for good 1 hour after launch.",
      "Rules never apply to holders using the Noised vault or shield directly (the built-in launch guard still does).",
      "Rules can only refuse a transfer. They can never move, freeze or take anyone's tokens.",
    ]);
    for (const line of explainRules(s)) expect(line).not.toMatch(/\[[A-Z]+\]/); // no code tags
    expect(explainRules(compileRules(s), { guardSecs: 3_600, guarantees: false })).toHaveLength(6);
    // short addresses on request (tight layouts)
    expect(explainRules(s, { addresses: "short", guarantees: false })[3]).toContain(`“team” (${TEAM.slice(0, 4)}…${TEAM.slice(-4)})`);
  });

  it("rules: the Noised vault and shield are named by their own names (a rule naming them never applies)", () => {
    const VAULT = "7BQ6FQomidBkd5z7fQfwr9Zt87oahMvMV5dFnw6Dz7nb";
    const SHIELD = "BUMHJyoS6JCz4pZDfryzXbFDorXb9nmGkj3ziR71z8E9";
    const s = rules({ guardSecs: 600 }).key("v", VAULT).key("s", SHIELD).deny(when.p2p().and(when.programIn(["v", "s"]))).build();
    expect(explainRules(s, { guarantees: false })).toEqual([
      `During the launch guard (the first 10 minutes): wallet-to-wallet transfers are refused when it's made through the Noised vault (${VAULT}) or the Noised shield (${SHIELD}).`,
    ]);
  });

  it("rules: a label can't pass for a known app (any address labelled \"jupiter\" reads as its address)", () => {
    const fake = ka(0x99);
    const s = rules({ guardSecs: 600 }).key("jupiter", fake).deny(when.buy().and(when.programIn("jupiter").not())).build();
    const [line] = explainRules(s, { guarantees: false });
    expect(line).toBe(`During the launch guard (the first 10 minutes): buys from the pool are refused when it's not made through the program ${fake}.`);
    expect(line).not.toMatch(/jupiter/i);
  });

  it("rules: negations and mixed and/or read naturally", () => {
    const s = rules({ guardSecs: 600 })
      .deny(when.buy().and(when.fromIn(TEAM).not()).and(when.amountGt("1%").or(when.balanceGt(5_000))))
      .deny(when.buy().and(when.timeGe("5m")).and(when.timeLt("2m")))
      .build();
    const [a, b] = explainRules(s, { guarantees: false });
    expect(a).toBe(
      `During the launch guard (the first 10 minutes): buys from the pool are refused when the sending wallet is not ${TEAM} and (the transfer is more than 1% of the supply or the receiving account would hold more than 5,000 tokens).`,
    );
    expect(b).toBe("Rule 2 can never apply: its time window is empty.");
  });

  it("rules: single units read as words, and verbs agree", () => {
    const s = rules({ guardSecs: 86_400 })
      .deny(when.p2p().and(when.timeGe("1m").not()))
      .deny(when.buy().and(when.timeLt("1h").not()).and(when.amountGt("5%")))
      .deny(when.buy().and(when.timeGe("2m")).and(when.amountGt("9%")), { first: "1h" })
      .build();
    expect(explainRules(s, { guarantees: false })).toEqual([
      "During the launch guard (the first day): wallet-to-wallet transfers are refused when it's within the first minute.",
      "During the launch guard (the first day): buys from the pool are refused when at least 1 hour has passed and the transfer is more than 5% of the supply.",
      "Between 2 minutes and 1 hour after launch: buys from the pool are refused when the transfer is more than 9% of the supply.",
    ]);
  });

  it("graphs: one sentence per node, then the guarantees (full addresses, tips included, price conditions on the reference)", () => {
    const g = graphTemplate("ai-buyback", PARAMS["ai-buyback"]);
    const lines = explainGraph(g);
    expect(lines[0]).toBe(
      `“ai-buyback”: whenever the token has graduated, buy back up to 0.25 SOL of the token and burn it, never paying more than 2% above its recent low price. At most 1 SOL and 8 runs per day. The operator (${ka(0xa1)}) decides when and how much, inside these limits.`,
    );
    expect(lines).toContain("Even with a stolen operator key, nobody can go past these limits, and the creator can remove the operator at any time (even after freezing).");
    expect(lines.some((l) => l.includes("never sells the token") && l.includes("tips"))).toBe(true);
    const share = explainGraph(graphTemplate("revenue-share", PARAMS["revenue-share"]), { guarantees: false });
    expect(share).toEqual([`Share: every day, pay up to 1 SOL to “team” ${TEAM} (60%), ${OPS} (40%). At most 1 SOL and 1 run per day. Anyone can run it for a small tip (up to 0.0001 SOL).`]);
    // an on-graduation node runs once: no per-period limits in its sentence
    expect(explainGraph(graphTemplate("burn-on-graduation", { maxTokens: 5_000 }), { guarantees: false })).toEqual([
      "Burn: once, when the token graduates, burn up to 5,000 tokens from the treasury. It runs once, for at most 5,000 tokens. Anyone can run it for a small tip (up to 0.0001 SOL).",
    ]);
    // price conditions read the reference price, and the guarantees say what it is
    const priced = graph().node("cheap", whenever(), when.priceLte(0.0000005), burn(1)).build();
    const pl = explainGraph(priced);
    expect(pl[0]).toContain("the reference price is at most 0.0000005 SOL per token");
    expect(pl.some((l) => l.startsWith("The reference price starts at the launch's migration price"))).toBe(true);
    expect(explainGraph(g).some((l) => l.startsWith("The reference price"))).toBe(false);
  });
});

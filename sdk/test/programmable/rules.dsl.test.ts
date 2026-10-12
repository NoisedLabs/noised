/** The launch-rules text DSL: grammar, canonical printing, round trips, and friendly positioned errors. */
import { describe, expect, it } from "vitest";

import {
  DslError,
  compileRules,
  decompileRules,
  normalizeRules,
  parseRules,
  printRules,
  rules,
  tryParseRules,
  when,
} from "../../src/programmable/index.js";
import type { Cond, RuleSet } from "../../src/programmable/index.js";
import { ka, randRuleSet, Rng } from "./helpers.js";

const TEAM = ka(0x7e);
const OPS = ka(0x0b);
const JUP = ka(0x4a);

const EXAMPLE = `rules v1
guard 1h
key team = ${TEAM}
key ops = ${OPS}

# anti-bot
first 2m: deny when buy and instructions > 3 code BOT
first 10m: max amount 0.5% when buy code WHALE
always: max balance 2% code WHALE
always: deny when buy and to in {team, ops} code TEAM
`;

describe("rules DSL: grammar", () => {
  it("parses the example into the same bytes as the builder", () => {
    const fromText = compileRules(parseRules(EXAMPLE));
    const fromCode = rules({ guardSecs: 3_600 })
      .key("team", TEAM)
      .key("ops", OPS)
      .deny(when.buy().and(when.txIxCountGt(3)), { code: "BOT", first: "2m" })
      .capAmount("0.5%", when.buy(), { code: "WHALE", first: "10m" })
      .capBalance("2%", undefined, "WHALE")
      .deny(when.buy().and(when.toIn(["team", "ops"])), "TEAM")
      .compile();
    expect(fromText).toEqual(fromCode);
  });

  it("prints canonical text that parses back to itself", () => {
    const set = parseRules(EXAMPLE);
    const text = printRules(set);
    expect(text).toBe(`rules v1
guard 1h
key team = ${TEAM}
key ops = ${OPS}

first 2m: deny when buy and instructions > 3 code BOT
first 10m: max amount 0.5% when buy code WHALE
always: max balance 2% code WHALE
always: deny when buy and to in {team, ops} code TEAM
`);
    expect(printRules(parseRules(text))).toBe(text);
  });

  it("windows: always / first / until / after / from..to / from..to end", () => {
    const s = parseRules(`guard 1h
always: deny
first 2m: deny
until 3m: deny
after 10m: deny
from 1m to 5m: deny
from 1m to end: deny`);
    // Open ends stay open (they follow the guard); explicit ends stay explicit (review U15).
    expect(s.rules.map((r) => [r.from, r.to])).toEqual([
      [0, null],
      [0, 120],
      [0, 180],
      [600, null],
      [60, 300],
      [60, null],
    ]);
  });

  it("durations: compact, spaced and long forms", () => {
    const s = parseRules(`guard 2h
first 1h30m: deny
first 1h 30m: deny
first 1 hour 30 minutes: deny
first 90 minutes: deny
first 5400s: deny`);
    expect(new Set(s.rules.map((r) => r.to))).toEqual(new Set([5_400]));
  });

  it("amounts: percent, bps, tokens (with decimals) and raw units", () => {
    const s = parseRules(`guard 1h
decimals 9
always: max amount 0.25%
always: max amount 25bps
always: max amount 25 bps
always: max amount 1.5 tokens
always: max amount 1500 units`);
    expect(s.tokenDecimals).toBe(9);
    expect(s.rules.map((r) => r.cap)).toEqual([{ bps: 25 }, { bps: 25 }, { bps: 25 }, { raw: 1_500_000_000n }, { raw: 1_500n }]);
  });

  it("every predicate, and precedence not > and > or with parentheses", () => {
    const s = parseRules(`guard 1h
key a = ${TEAM}
key b = ${OPS}
key j = ${JUP}
always: deny when buy or p2p and not time < 2m
always: deny when (buy or p2p) and time >= 2m
always: deny when amount > 1% or balance > 100 tokens
always: deny when to in {a} or from in {b} or program in {j} or instructions > 4
always: deny when not (buy and false) or true`);
    const w = s.rules.map((r) => r.when);
    expect(w[0]).toEqual<Cond>({ op: "or", a: { op: "buy" }, b: { op: "and", a: { op: "p2p" }, b: { op: "not", x: { op: "timeLt", secs: 120 } } } });
    expect(w[1]).toEqual<Cond>({ op: "and", a: { op: "or", a: { op: "buy" }, b: { op: "p2p" } }, b: { op: "timeGe", secs: 120 } });
    expect(w[2]).toEqual<Cond>({ op: "or", a: { op: "amountGt", amount: { bps: 100 } }, b: { op: "balanceGt", amount: { raw: 100_000_000n } } });
    expect(w[3]).toEqual<Cond>({
      op: "or",
      a: { op: "or", a: { op: "or", a: { op: "toIn", keys: [TEAM] }, b: { op: "fromIn", keys: [OPS] } }, b: { op: "programIn", keys: [JUP] } },
      b: { op: "ixCountGt", n: 4 },
    });
    expect(w[4]).toEqual<Cond>({ op: "or", a: { op: "not", x: { op: "and", a: { op: "buy" }, b: { op: "false" } } }, b: { op: "true" } });
    expect(printRules(s).split("\n").slice(-6, -1)).toEqual([
      "always: deny when buy or p2p and not time < 2m",
      "always: deny when (buy or p2p) and time >= 2m",
      "always: deny when amount > 1% or balance > 100 tokens",
      "always: deny when to in {a} or from in {b} or program in {j} or instructions > 4",
      "always: deny when not (buy and false) or true",
    ]);
  });

  it("right-nested chains keep their shape through print/parse", () => {
    const set: RuleSet = {
      guardSecs: 600,
      keys: [],
      rules: [{ from: 0, to: 600, effect: "deny", code: 0, when: { op: "and", a: { op: "buy" }, b: { op: "and", a: { op: "p2p" }, b: { op: "true" } } } }],
    };
    const text = printRules(set);
    expect(text).toContain("buy and (p2p and true)");
    expect(parseRules(text).rules[0]!.when).toEqual(set.rules[0]!.when);
  });

  it("comments, blank lines and indented continuation lines", () => {
    const s = parseRules(`# my rules
guard 1h   # one hour

first 2m: deny
    when buy
    and instructions > 3   # bots bundle many instructions
    code BOT`);
    expect(s.rules).toHaveLength(1);
    expect(s.rules[0]!.code).toBe(1);
  });

  it("codes by name (any case) or number; code 0 is printed as nothing", () => {
    const s = parseRules(`guard 1h
always: deny code bot
always: deny code 42
always: deny code 0`);
    expect(s.rules.map((r) => r.code)).toEqual([1, 42, 0]);
    expect(printRules(s)).toContain("always: deny code BOT\nalways: deny code 42\nalways: deny\n");
  });

  it("without a guard line, always/after stay open-ended until compile time", () => {
    const s = parseRules("always: deny when buy\nafter 5m: deny");
    expect(s.rules.map((r) => r.to)).toEqual([null, null]);
    expect(printRules(s)).toContain("always: deny when buy\nafter 5m: deny");
    expect(compileRules(s, { guardSecs: 600 }).length).toBeGreaterThan(0);
    const open = parseRules("always: deny", { guardSecs: 900 });
    expect(open.rules[0]!.to).toBeNull();
    expect(decompileRules(compileRules(open), { guardSecs: 900 }).rules[0]!.to).toBe(900);
    // Review U15: "first 1h" with a 1-hour guard stays "first 1h" (it does not grow with a longer guard).
    const first = parseRules(["guard 1h", "first 1h: deny when buy"].join("\n"));
    expect(printRules(first)).toContain("first 1h: deny when buy");
    expect(printRules(parseRules(["guard 1h", "always: deny when buy"].join("\n")))).toContain("always: deny when buy");
    expect(compileRules({ ...first, guardSecs: 7_200 })).toEqual(compileRules(parseRules(["guard 2h", "first 1h: deny when buy"].join("\n"))));
  });
});

describe("rules DSL: round trips (seeded property tests)", () => {
  it("model -> text -> model is the same rule set (and the same bytes)", () => {
    const rng = new Rng(0x44534c31);
    for (let i = 0; i < 300; i++) {
      const set = randRuleSet(rng);
      const text = printRules(set);
      const back = parseRules(text);
      expect(back).toEqual(normalizeRules(set));
      expect(compileRules(back)).toEqual(compileRules(set));
      expect(printRules(back)).toBe(text);
    }
  });

  it("bytes -> model -> text -> model -> bytes is the identity", () => {
    const rng = new Rng(0x44534c32);
    for (let i = 0; i < 200; i++) {
      const set = randRuleSet(rng);
      const bytes = compileRules(set);
      const text = printRules(decompileRules(bytes, { guardSecs: set.guardSecs! }));
      expect(compileRules(parseRules(text))).toEqual(bytes);
    }
  });
});

describe("rules DSL: friendly errors with positions", () => {
  const err = (text: string, opts = {}): DslError => {
    const r = tryParseRules(text, opts);
    if (r.ok) throw new Error("expected an error");
    return r.errors[0]!;
  };

  it("a number without a unit points at the number and suggests units", () => {
    const e = err("guard 1h\nfirst 2: deny");
    expect([e.line, e.col, e.length]).toEqual([2, 7, 1]);
    expect(e.message).toContain("needs a unit");
    expect(e.hint).toContain("2m");
  });

  it("an unsupported comparison says which ones work", () => {
    const e = err("guard 1h\nalways: deny when time > 2m");
    expect([e.line, e.col]).toEqual([2, 24]);
    expect(e.message).toContain("< or >=");
  });

  it("an undeclared key points at the name", () => {
    const e = err("guard 1h\nalways: deny when to in {team}");
    expect([e.line, e.col, e.length]).toEqual([2, 26, 4]);
    expect(e.hint).toContain("key team = <address>");
  });

  it("an unused key is reported at its declaration", () => {
    const e = err(`guard 1h\nkey team = ${TEAM}\nalways: deny`);
    expect([e.line, e.col]).toEqual([2, 5]);
    expect(e.message).toContain("never used");
  });

  it("missing colon, unknown words and trailing junk", () => {
    expect(err("guard 1h\nfirst 2m deny").message).toContain('expected ":"');
    expect(err("guard 1h\nsometimes: deny").message).toContain("always, first, after or from");
    expect(err("guard 1h\nalways: deny when buy please").message).toContain('unexpected "please"');
    expect(err("guard 1h\nalways: deny when buys or").message).toContain("expected a condition");
  });

  it("windows past the guard, reversed windows, guard mismatch", () => {
    expect(err("guard 1h\nfirst 2h: deny").message).toContain("past the end of the launch guard");
    expect(err("guard 1h\nfrom 5m to 2m: deny").message).toContain("ends before it starts");
    expect(err("guard 1h\nalways: deny", { guardSecs: 7_200 }).message).toContain("launch's guard is 2h");
  });

  it("limits from the verifier come back as positioned errors", () => {
    const many = ["guard 1h", ...Array.from({ length: 17 }, () => "always: deny")].join("\n");
    const e = err(many);
    expect(e.message).toContain("limit is 16");
    const percent = err("guard 1h\nalways: max amount 0.001%");
    expect(percent.message).toContain("0.01%");
  });

  it("collects one error per line so an editor can underline them all", () => {
    const r = tryParseRules("guard 1h\nfirst 2: deny\nalways: deny when time > 1m\nalways: deny when to in {x}");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.line)).toEqual([2, 3, 4]);
  });

  it("parseRules throws the first DslError with a pretty form", () => {
    try {
      parseRules("guard 1h\nfirst 2: deny");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DslError);
      expect((e as DslError).pretty).toMatch(/^line 2, col 7: /);
    }
  });
});

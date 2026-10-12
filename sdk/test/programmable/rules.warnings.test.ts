/**
 * `ruleWarnings`: what a holder should be warned about in a launch's rules
 * (QSL-1 revision 0.4 §6.4: buys only for insiders and for how long, buys
 * refused, rules on wallet-to-wallet transfers, rules on for more than an
 * hour, rules that do nothing). Each warning is checked against the hook's
 * own decision (`simulateTransfer`) on the transfers it describes.
 */
import { describe, expect, it } from "vitest";

import {
  compileRules,
  NOISED_SHIELD_PROGRAM,
  NOISED_VAULT_PROGRAM,
  RULE_WARNING_LONG_SECS,
  ruleWarnings,
  rules,
  ruleTemplate,
  RULE_TEMPLATES,
  simulateTransfer,
  when,
} from "../../src/programmable/index.js";
import { ka } from "./helpers.js";

const A = ka(0xa1);
const B = ka(0xb2);
const OUTSIDER = ka(0x33);
const ROUTER = ka(0x44);
const H6 = 6 * 3_600;
const brief = (ws: ReturnType<typeof ruleWarnings>): [string, number, number | null, number | null][] => ws.map((w) => [w.kind, w.rule, w.from, w.to]);

describe("ruleWarnings", () => {
  it("insider-only buying: only the listed wallets can buy, for how long, and the hook agrees", () => {
    const set = rules({ guardSecs: H6 }).key("a", A).key("b", B).deny(when.buy().and(when.toIn(["a", "b"]).not()), { code: "TEAM", first: "2h" }).build();
    const bytes = rules({ guardSecs: H6 }).key("a", A).key("b", B).deny(when.buy().and(when.toIn(["a", "b"]).not()), { code: "TEAM", first: "2h" }).compile();
    const ws = ruleWarnings(bytes, { guardSecs: H6 });
    expect(brief(ws)).toEqual([
      ["insiderBuying", 0, 0, 7_200],
      ["longRule", 0, 0, 7_200],
    ]);
    expect(ws[0]!.wallets).toEqual([A, B]);
    expect(ws[0]!.plain).toBe("For the first 2 hours, only 2 wallets chosen by the creator can buy; everyone else's buys are refused (rule 1).");
    expect(ws[1]!.plain).toBe("Rule 1 stays on for 2 hours, more than an hour.");
    // The hook's decision on the transfers the warning describes.
    expect(simulateTransfer(set, { kind: "buy", at: 60, amount: 1, to: OUTSIDER, guardSecs: H6 }).allowed).toBe(false);
    expect(simulateTransfer(set, { kind: "buy", at: 60, amount: 1, to: A, guardSecs: H6 }).allowed).toBe(true);
    expect(simulateTransfer(set, { kind: "buy", at: 7_200, amount: 1, to: OUTSIDER, guardSecs: H6 }).allowed).toBe(true);
  });

  it("audit 4, S4: larger buys refused for everyone but listed wallets (amount or balance caps that spare insiders) are insider buying too", () => {
    const set = rules({ guardSecs: H6 }).key("a", A).deny(when.buy().and(when.toIn(["a"]).not()).and(when.amountGt(1_000)), { first: "1h" }).build();
    const bytes = rules({ guardSecs: H6 }).key("a", A).deny(when.buy().and(when.toIn(["a"]).not()).and(when.amountGt(1_000)), { first: "1h" }).compile();
    const ws = ruleWarnings(bytes, { guardSecs: H6 });
    expect(brief(ws)).toEqual([["insiderBuying", 0, 0, 3_600]]);
    expect([ws[0]!.partial, ws[0]!.wallets]).toEqual([true, [A]]);
    expect(ws[0]!.plain).toBe("For the first hour, only 1 wallet chosen by the creator can make larger buys; everyone else's buys of more than 1,000 tokens are refused (rule 1).");
    // The hook agrees: a small buy passes for anyone, a larger one only for the listed wallet.
    const T = 1_000_000n; // 1 token at 6 decimals
    expect(simulateTransfer(set, { kind: "buy", at: 60, amount: 1_000n * T, to: OUTSIDER, guardSecs: H6 }).allowed).toBe(true);
    expect(simulateTransfer(set, { kind: "buy", at: 60, amount: 1_000n * T + 1n, to: OUTSIDER, guardSecs: H6 }).allowed).toBe(false);
    expect(simulateTransfer(set, { kind: "buy", at: 60, amount: 1_000n * T + 1n, to: A, guardSecs: H6 }).allowed).toBe(true);
    // A balance cap that spares the listed wallet.
    const bal = ruleWarnings(rules({ guardSecs: H6 }).key("a", A).deny(when.buy().and(when.toIn(["a"]).not()).and(when.balanceGt(5_000)), { first: "30m" }).compile(), { guardSecs: H6 });
    expect(brief(bal)).toEqual([["insiderBuying", 0, 0, 1_800]]);
    expect(bal[0]!.plain).toBe(
      "For the first 30 minutes, only 1 wallet chosen by the creator can make larger buys; everyone else's buys that would leave a wallet holding more than 5,000 tokens are refused (rule 1).",
    );
    // The same cap for everyone is no insider buying.
    expect(ruleWarnings(rules({ guardSecs: H6 }).deny(when.buy().and(when.amountGt(1_000)), { first: "30m" }).compile(), { guardSecs: H6 }).some((w) => w.kind === "insiderBuying")).toBe(false);
  });

  it("the snipe shield clips buy warnings: a buy rule entirely inside it does nothing, one past it counts from its end", () => {
    const bytes = rules({ guardSecs: H6 }).key("a", A).deny(when.buy().and(when.toIn(["a"]).not()), { first: "30m" }).compile();
    expect(brief(ruleWarnings(bytes, { guardSecs: H6, buysOpenAt: 1_800 }))).toEqual([["noOpRule", 0, null, null]]);
    const ws = ruleWarnings(bytes, { guardSecs: H6, buysOpenAt: 900 });
    expect(brief(ws)).toEqual([["insiderBuying", 0, 900, 1_800]]);
    expect(ws[0]!.plain).toBe("From 15 minutes to 30 minutes after launch, only 1 wallet chosen by the creator can buy; everyone else's buys are refused (rule 1).");
  });

  it("buys refused for everyone, through listed apps only, or only some ordinary buys (too strict an anti-bot limit)", () => {
    let ws = ruleWarnings(rules({ guardSecs: 3_600 }).deny(when.buy(), { first: "10m" }).compile(), { guardSecs: 3_600 });
    expect(brief(ws)).toEqual([["buysBlocked", 0, 0, 600]]);
    expect(ws[0]!.plain).toBe("For the first 10 minutes, ordinary buys are refused (rule 1).");
    ws = ruleWarnings(rules({ guardSecs: 3_600 }).key("router", ROUTER).deny(when.buy().and(when.programIn(["router"]).not()), { first: "10m" }).compile(), { guardSecs: 3_600 });
    expect([ws[0]!.kind, ws[0]!.apps]).toEqual(["buysBlocked", [ROUTER]]);
    expect(ws[0]!.plain).toBe("For the first 10 minutes, ordinary buys are refused, unless the buy goes through one app it lists (rule 1).");
    // More than 6 instructions: an ordinary 8-instruction buy is refused, a 4-instruction one is not.
    ws = ruleWarnings(rules({ guardSecs: 3_600 }).deny(when.buy().and(when.txIxCountGt(6)), { first: "10m" }).compile(), { guardSecs: 3_600 });
    expect([ws[0]!.kind, ws[0]!.partial]).toEqual(["buysBlocked", true]);
    expect(ws[0]!.plain).toMatch(/^For the first 10 minutes, some ordinary buys are refused/);
    // The anti-bot template's limit (at least 10) never refuses an ordinary buy: no warning.
    const anti = ruleTemplate("anti-bot", { guardSecs: "1h" });
    expect(ruleWarnings(compileRules(anti, { guardSecs: 3_600 }), { guardSecs: 3_600 })).toEqual([]);
  });

  it("wallet-to-wallet transfers: refused, or only limited (a cap that also applies to them)", () => {
    let ws = ruleWarnings(rules({ guardSecs: 3_600 }).deny(when.p2p(), { first: "20m" }).compile(), { guardSecs: 3_600 });
    expect(brief(ws)).toEqual([["transferLimits", 0, 0, 1_200]]);
    expect(ws[0]!.plain).toBe("For the first 20 minutes, sending tokens from one wallet to another is refused (rule 1).");
    ws = ruleWarnings(rules({ guardSecs: 3_600 }).capBalance("1%").compile(), { guardSecs: 3_600 });
    expect(ws.map((w) => w.plain)).toEqual(["For the first hour, some wallet-to-wallet transfers are limited (rule 1)."]);
    // A cap on buys only says nothing about wallet-to-wallet transfers, and a small buy passes it.
    expect(ruleWarnings(rules({ guardSecs: 3_600 }).capAmount("0.5%", when.buy()).compile(), { guardSecs: 3_600 })).toEqual([]);
  });

  it("rules that do nothing: a buy that is also wallet-to-wallet, a cap above the supply, a program the hook skips rules for", () => {
    const g = { guardSecs: 3_600 };
    expect(brief(ruleWarnings(rules(g).deny(when.buy().and(when.p2p())).compile(), g))).toEqual([["noOpRule", 0, null, null]]);
    expect(brief(ruleWarnings(rules(g).capAmount("100%").compile(), g))).toEqual([["noOpRule", 0, null, null]]);
    // Rules never apply when the vault or the shield is the top-level program (review 4, R1).
    const ws = ruleWarnings(rules(g).key("vault", NOISED_VAULT_PROGRAM).key("shield", NOISED_SHIELD_PROGRAM).deny(when.programIn(["vault", "shield"])).compile(), g);
    expect(ws.map((w) => w.plain)).toEqual(["Rule 1 can never block anything, so it does nothing."]);
    // A long rule that does nothing is reported as doing nothing, not as long.
    expect(brief(ruleWarnings(rules({ guardSecs: H6 }).deny(when.never()).compile(), { guardSecs: H6 }))).toEqual([["noOpRule", 0, null, null]]);
  });

  it("an hour exactly is not long; the most serious come first; a rule too complex to try is said so", () => {
    expect(RULE_WARNING_LONG_SECS).toBe(3_600);
    const bytes = rules({ guardSecs: H6 })
      .key("a", A)
      .capBalance("2%", undefined, { first: "1h" })
      .deny(when.buy().and(when.toIn(["a"]).not()), { from: "1h", to: "3h" })
      .compile();
    expect(brief(ruleWarnings(bytes, { guardSecs: H6 }))).toEqual([
      ["insiderBuying", 1, 3_600, 10_800],
      ["transferLimits", 0, 0, 3_600],
      ["longRule", 1, 3_600, 10_800],
    ]);
    expect(brief(ruleWarnings(bytes, { guardSecs: H6, maxProbes: 1 }))).toEqual([
      ["longRule", 1, 3_600, 10_800],
      ["complexRule", 0, null, null],
      ["complexRule", 1, null, null],
    ]);
  });

  it("every template's warnings are honest about it (long windows only on 6-hour guards; nothing for anti-bot)", () => {
    for (const t of RULE_TEMPLATES) {
      const params: Record<string, unknown> = t.id === "team-cant-buy" ? { team: [A], guardSecs: "6h" } : { guardSecs: "6h" };
      const set = ruleTemplate(t.id, params);
      const ws = ruleWarnings(compileRules(set, { guardSecs: H6 }), { guardSecs: H6 });
      expect(ws.some((w) => w.kind === "insiderBuying" || w.kind === "buysBlocked" || w.kind === "noOpRule"), t.id).toBe(false);
    }
  });
});

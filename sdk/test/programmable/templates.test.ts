/**
 * Review U6: the rule templates neither block ordinary buys nor do nothing.
 *
 * For each launch preset (the launchpad's fair / community / turbo timings:
 * batch window, guard, built-in caps), every template is built for that
 * launch and tried with realistic transfers through `simulateTransfer` with
 * the launch's built-in guard (the hook's own order):
 *
 * - an ordinary buy (4 to 8 top-level instructions: two compute-budget,
 *   create the token account, create the wSOL account, transfer, sync,
 *   swap, close; this SDK's `buildSwapTx` and Meteora's SDK make exactly
 *   these) is never refused by a template, from the moment trading can open
 *   (the batch ran early) to the end of the guard;
 * - every time window covers open trading: it ends after the latest moment
 *   trading opens (batch window + 10 minutes to run the batch) and no later
 *   than the guard; a bot-like buy just after trading opens is refused.
 * - review 4 R6: no template counts instructions with a threshold below 10
 *   (`MIN_TX_IX_COUNT_THRESHOLD`): wallets add compute-budget, Lighthouse and
 *   Jito instructions of their own, so an ordinary buy with up to 2 of them
 *   on top of the 8 still goes through.
 */
import { describe, expect, it } from "vitest";

import { POLICY, PRESETS } from "../../src/index.js";
import {
  type Cond,
  LAUNCH_TIMING,
  MIN_TX_IX_COUNT_THRESHOLD,
  ORDINARY_BUY_MAX_INSTRUCTIONS,
  ProgError,
  RULE_TEMPLATES,
  compileRules,
  explainRules,
  ruleTemplate,
  simulateTransfer,
  type RuleSet,
  type TransferInput,
} from "../../src/programmable/index.js";
import { ka } from "./helpers.js";

const DAMM_V2 = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
const TEAM = ka(0x11);
const BUYER = ka(0x22);

/** The launch timings of the SDK's presets. */
const LAUNCHES = (["fair", "community", "turbo"] as const).map((name) => {
  const p = PRESETS[name].params;
  return { name, openDelaySecs: p.openDelaySecs, guardSecs: p.guardSecs, maxWalletBps: p.maxWalletBps, maxBuyBps: p.maxBuyBps, p2pLocked: p.p2pLocked };
});

type Launch = (typeof LAUNCHES)[number];

const build = (id: (typeof RULE_TEMPLATES)[number]["id"], l: Launch, extra: Record<string, unknown> = {}): RuleSet =>
  ruleTemplate(id, { guardSecs: l.guardSecs, openDelaySecs: l.openDelaySecs, ...(id === "team-cant-buy" ? { team: [TEAM] } : {}), ...extra });

/** A buy of 0.05% of the supply into a fresh wallet, through DAMM v2, with `instructions` top-level instructions. */
const ordinaryBuy = (at: number, instructions: number, builtin?: Launch): TransferInput => ({
  kind: "buy",
  at,
  amount: 500_000,
  to: BUYER,
  program: DAMM_V2,
  instructions,
  ...(builtin ? { builtin: guardOf(builtin) } : {}),
});

const guardOf = (l: Launch) => ({
  snipeShieldSecs: l.openDelaySecs + POLICY.EXECUTION_GRACE_SECS,
  maxBuyBps: l.maxBuyBps,
  maxWalletBps: l.maxWalletBps,
  p2pLocked: l.p2pLocked,
});

/** Every instruction-count threshold (TX_IX_COUNT_GT) in a condition. */
const ixThresholds = (c: Cond): number[] =>
  c.op === "ixCountGt" ? [c.n] : c.op === "and" || c.op === "or" ? [...ixThresholds(c.a), ...ixThresholds(c.b)] : c.op === "not" ? ixThresholds(c.x) : [];

/** A template's every parameter at each value of its range (the others at their defaults). */
function* variants(t: (typeof RULE_TEMPLATES)[number], l: Launch): Generator<[string, RuleSet]> {
  yield ["defaults", build(t.id, l)];
  for (const p of t.params) {
    if (p.kind !== "count" || !p.range) continue;
    for (let v = p.range.min; v <= p.range.max; v += p.range.step) yield [`${p.key} = ${v}`, build(t.id, l, { [p.key]: v })];
  }
}

describe("rule templates on real launch timings (review U6)", () => {
  it("the templates' launch timing is the launchpad's", () => {
    expect(LAUNCH_TIMING.EXECUTION_GRACE_SECS).toBe(POLICY.EXECUTION_GRACE_SECS);
    expect(LAUNCH_TIMING.MIN_OPEN_DELAY_SECS).toBe(POLICY.MIN_OPEN_DELAY);
    expect(LAUNCH_TIMING.MAX_OPEN_DELAY_SECS).toBe(POLICY.MAX_OPEN_DELAY);
    expect(LAUNCH_TIMING.DEFAULT_OPEN_DELAY_SECS).toBe(PRESETS.fair.params.openDelaySecs);
  });

  for (const l of LAUNCHES) {
    describe(`${l.name} launch (batch window ${l.openDelaySecs}s, guard ${l.guardSecs}s)`, () => {
      const opens = l.openDelaySecs + POLICY.EXECUTION_GRACE_SECS;

      it("no template refuses an ordinary buy (4 to 8 instructions, plus up to 2 a wallet adds), from the earliest trading to the end of the guard", () => {
        for (const t of RULE_TEMPLATES) {
          const set = build(t.id, l);
          compileRules(set);
          const times = [l.openDelaySecs, l.openDelaySecs + 30, opens - 1, opens, opens + 60, opens + 600, Math.floor((opens + l.guardSecs) / 2), l.guardSecs - 1];
          for (const at of times) {
            for (let ix = 4; ix <= MIN_TX_IX_COUNT_THRESHOLD; ix++) {
              // The batch may have run early: the custom rules alone from the batch window's end...
              const v = simulateTransfer(set, ordinaryBuy(at, ix));
              expect(v.allowed, `${t.id} at ${at}s with ${ix} instructions: ${v.why}`).toBe(true);
              // ...and with the launch's own guard once the shield is surely over.
              if (at >= opens) {
                const w = simulateTransfer(set, ordinaryBuy(at, ix, l));
                expect(w.allowed, `${t.id} + guard at ${at}s with ${ix} instructions: ${w.why}`).toBe(true);
              }
            }
          }
        }
      });

      it("no template, at any value of its sliders, counts instructions with a threshold below 10 (review 4 R6)", () => {
        let thresholds = 0;
        for (const t of RULE_TEMPLATES) {
          for (const [what, set] of variants(t, l)) {
            for (const r of set.rules) {
              for (const n of ixThresholds(r.when)) {
                expect(n, `${t.id} (${what})`).toBeGreaterThanOrEqual(MIN_TX_IX_COUNT_THRESHOLD);
                thresholds++;
              }
            }
          }
        }
        expect(thresholds).toBeGreaterThan(10); // the anti-bot template's default and every slider value
      });

      it("time windows cover open trading: they end after trading is sure to be open and no later than the guard", () => {
        for (const id of ["fair-start", "anti-bot"] as const) {
          const set = build(id, l);
          for (const r of set.rules) {
            expect(r.from).toBe(l.openDelaySecs);
            expect(r.to).not.toBeNull();
            expect(r.to!).toBeGreaterThan(opens);
            expect(r.to!).toBeLessThanOrEqual(l.guardSecs);
          }
        }
      });

      it("a bot-like buy right after trading opens is refused (anti-bot), and so is an oversized early buy (fair start)", () => {
        const bot = build("anti-bot", l);
        for (const at of [l.openDelaySecs, opens, opens + 60]) {
          const v = simulateTransfer(bot, ordinaryBuy(at, 12, at >= opens ? l : undefined));
          expect(v.codeName, `${at}s`).toBe("BOT");
        }
        expect(simulateTransfer(bot, ordinaryBuy(bot.rules[0]!.to!, 12)).allowed).toBe(true);
        const fair = build("fair-start", l);
        const big: TransferInput = { kind: "buy", at: opens + 30, amount: 6_000_000, to: BUYER, program: DAMM_V2, instructions: 6 }; // 0.6% > 0.5%
        expect(simulateTransfer(fair, big).codeName).toBe("EARLY");
        expect(simulateTransfer(fair, { ...big, at: fair.rules[0]!.to! }).allowed).toBe(true);
      });

      it("team wallets can't receive pool buys during the guard; others can, and team sells always work", () => {
        const team = build("team-cant-buy", l);
        expect(simulateTransfer(team, { ...ordinaryBuy(opens + 60, 6), to: TEAM }).codeName).toBe("TEAM");
        expect(simulateTransfer(team, ordinaryBuy(opens + 60, 6)).allowed).toBe(true);
        expect(simulateTransfer(team, { kind: "sell", at: opens + 60, amount: 1, from: TEAM }).allowed).toBe(true);
        expect(simulateTransfer(team, { ...ordinaryBuy(l.guardSecs, 6), to: TEAM }).allowed).toBe(true);
      });
    });
  }

  it("a guard that ends before trading is sure to be open is refused (the rule would do nothing)", () => {
    expect(() => ruleTemplate("anti-bot", { guardSecs: 900, openDelaySecs: 300 })).toThrow(/would do nothing/);
    expect(() => ruleTemplate("fair-start", { guardSecs: 2_400, openDelaySecs: 1_800 })).toThrow(/lengthen the guard/);
    expect(ruleTemplate("fair-start", { guardSecs: 2_401, openDelaySecs: 1_800 }).rules[0]).toMatchObject({ from: 1_800, to: 2_401 });
    expect(() => ruleTemplate("anti-bot", { openDelaySecs: 30 })).toThrow(/batch window/);
  });

  it("the anti-bot limit is at least 10 instructions: the slider starts there and 9 is refused (review 4 R6)", () => {
    expect(MIN_TX_IX_COUNT_THRESHOLD).toBe(10);
    expect(ORDINARY_BUY_MAX_INSTRUCTIONS).toBe(8);
    const anti = RULE_TEMPLATES.find((t) => t.id === "anti-bot")!;
    const prm = anti.params.find((p) => p.key === "maxInstructions")!;
    expect(prm.range?.min).toBe(MIN_TX_IX_COUNT_THRESHOLD);
    expect(prm.default).toBe(MIN_TX_IX_COUNT_THRESHOLD);
    for (const bad of [9, 8, 3, 0, 9.5, Number.NaN]) {
      const err = (() => {
        try {
          ruleTemplate("anti-bot", { maxInstructions: bad });
        } catch (e) {
          return e;
        }
        return null;
      })();
      expect(err, String(bad)).toBeInstanceOf(ProgError);
      expect((err as ProgError).code).toBe("BadModel");
      expect((err as ProgError).message).toMatch(/at least 10 instructions/);
    }
    expect(ixThresholds(ruleTemplate("anti-bot", { maxInstructions: 10 }).rules[0]!.when)).toEqual([10]);
    expect(anti.summary).not.toMatch(/up to 8/);
  });

  it("their plain-English lines describe the window from when trading opens", () => {
    const lines = explainRules(ruleTemplate("anti-bot", { guardSecs: 21_600, openDelaySecs: 300 }));
    expect(lines[0]).toMatch(/Between 5 minutes and 17 minutes after launch/);
    expect(lines[0]).toMatch(/more than 10 instructions/);
  });
});

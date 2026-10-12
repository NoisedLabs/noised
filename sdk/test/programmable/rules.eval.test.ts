/**
 * Launch-rule evaluation: each leaf, each effect, windows, order, bps caps,
 * fail-closed on malformed input, and the safety invariants as property
 * tests against an independent reference model written from the spec.
 */
import { describe, expect, it } from "vitest";

import {
  BPS_FLAG,
  EFFECT,
  OP,
  PXR1,
  compileRules,
  encodeBase58,
  evaluateRuleSet,
  exceeds,
  rules,
  simulateTransfer,
  threshold,
  verifyRulesBytes,
  when,
} from "../../src/programmable/index.js";
import type { CondNode, RawRuleSet, RuleEvalCtx, RuleOutcome, RuleSet, TransferKind } from "../../src/programmable/index.js";
import {
  AND, F, GUARD, NOT, OR, T, amountGt, bps, capAmount, capBalance, deny, destBalGt, destIn, enc, isBuy, isP2p, ixGt, ka, kb, node,
  randRuleSet, rulesProg, srcIn, timeGe, timeLt, topIn, Rng,
} from "./helpers.js";

const D = ka(0xd0);
const S = ka(0x50);
const P = ka(0x70);
const ctx = (o: Partial<RuleEvalCtx> = {}): RuleEvalCtx => ({
  nowRel: 10,
  isBuy: true,
  isP2p: false,
  amount: 1_000n,
  destBalanceAfter: 1_000n,
  supply: 1_000_000_000n,
  destOwner: D,
  srcOwner: S,
  topProgram: P,
  txIxCount: 2,
  ...o,
});
const verified = (keys: Uint8Array[], rs: Parameters<typeof rulesProg>[1]): RawRuleSet => verifyRulesBytes(enc(rulesProg(keys, rs)));
/** One deny rule over the whole guard with this condition. */
const denyIf = (cond: CondNode[], keys: Uint8Array[] = []): RawRuleSet => verified(keys, [deny(0, GUARD, 7, cond)]);
const hits = (cond: CondNode[], c: Partial<RuleEvalCtx>, keys: Uint8Array[] = []): boolean => !evaluateRuleSet(denyIf(cond, keys), ctx(c)).ok;
/** Same, without the canonical-form check (a key list may name keys no mask uses). */
const hitsRaw = (cond: CondNode[], c: Partial<RuleEvalCtx>, keys: Uint8Array[]): boolean =>
  !evaluateRuleSet(rulesProg(keys, [deny(0, GUARD, 7, cond)]), ctx(c)).ok;

// ------------------------------------------------- reference model ---
function refThreshold(arg: bigint, supply: bigint): bigint {
  return (arg & BPS_FLAG) === 0n ? arg : (supply * (arg & 0xffffn)) / 10_000n;
}
function refEval(nodes: CondNode[], leaf: (n: CondNode) => boolean): boolean {
  const st: boolean[] = [];
  for (const n of nodes) {
    if (n.op === OP.TRUE) st.push(true);
    else if (n.op === OP.FALSE) st.push(false);
    else if (n.op === OP.AND || n.op === OP.OR) {
      const x = st.pop()!;
      const y = st.pop()!;
      st.push(n.op === OP.AND ? x && y : x || y);
    } else if (n.op === OP.NOT) st.push(!st.pop()!);
    else st.push(leaf(n));
  }
  return st[0]!;
}
function refRules(p: RawRuleSet, c: RuleEvalCtx): RuleOutcome {
  const keys = p.keys.map((k) => encodeBase58(k));
  const inMask = (mask: number, who: string): boolean => keys.some((k, i) => (mask & (1 << i)) !== 0 && k === who);
  const leaf = (n: CondNode): boolean => {
    switch (n.op) {
      case OP.IS_BUY: return c.isBuy;
      case OP.IS_P2P: return c.isP2p;
      case OP.TIME_LT: return c.nowRel < Number(n.arg);
      case OP.TIME_GE: return c.nowRel >= Number(n.arg);
      case OP.AMOUNT_GT: return c.amount > refThreshold(n.arg, c.supply);
      case OP.DEST_BAL_AFTER_GT: return c.destBalanceAfter > refThreshold(n.arg, c.supply);
      case OP.DEST_OWNER_IN: return inMask(n.a, c.destOwner);
      case OP.SRC_OWNER_IN: return inMask(n.a, c.srcOwner);
      case OP.TOP_PROGRAM_IN: return inMask(n.a, c.topProgram);
      case OP.TX_IX_COUNT_GT: return BigInt(c.txIxCount) > n.arg;
      default: throw new Error("unknown leaf");
    }
  };
  for (let i = 0; i < p.rules.length; i++) {
    const r = p.rules[i]!;
    if (!(r.fromRel <= c.nowRel && c.nowRel < r.toRel)) continue;
    const cond = refEval(p.nodes.slice(r.condOff, r.condOff + r.condLen), leaf);
    const violated =
      r.effect === EFFECT.DENY ||
      (r.effect === EFFECT.CAP_AMOUNT && c.amount > refThreshold(r.arg, c.supply)) ||
      (r.effect === EFFECT.CAP_DEST_BALANCE && c.destBalanceAfter > refThreshold(r.arg, c.supply));
    if (cond && violated) return { ok: false, index: i, code: r.code };
  }
  return { ok: true };
}

function randCtx(rng: Rng, keys: string[], guard: number): RuleEvalCtx {
  const who = (): string => (keys.length > 0 && rng.coin() ? rng.pick(keys) : ka(rng.range(1, 255)));
  const amount = rng.coin() ? BigInt(rng.range(0, 2_000_000)) : rng.wide() & ((1n << 62n) - 1n);
  const kind = rng.below(3);
  return {
    nowRel: rng.oneIn(5) ? rng.range(-100, 2 * guard) : rng.range(0, guard),
    isBuy: kind === 0,
    isP2p: kind === 1,
    amount,
    destBalanceAfter: amount + BigInt(rng.range(0, 5_000_000)),
    supply: rng.pick([1_000_000_000n, 1_000_000_000_000_000n, 7n, 0n, (1n << 64n) - 1n]),
    destOwner: who(),
    srcOwner: who(),
    topProgram: who(),
    txIxCount: rng.range(0, 70),
  };
}

// ------------------------------------------------- leaves ---
describe("rule leaves", () => {
  it("IS_BUY / IS_P2P", () => {
    expect(hits([isBuy()], { isBuy: true })).toBe(true);
    expect(hits([isBuy()], { isBuy: false })).toBe(false);
    expect(hits([isP2p()], { isP2p: true, isBuy: false })).toBe(true);
    expect(hits([isP2p()], { isP2p: false })).toBe(false);
  });
  it("TIME_LT is strict, TIME_GE inclusive", () => {
    expect(hits([timeLt(10)], { nowRel: 9 })).toBe(true);
    expect(hits([timeLt(10)], { nowRel: 10 })).toBe(false);
    expect(hits([timeGe(10)], { nowRel: 10 })).toBe(true);
    expect(hits([timeGe(10)], { nowRel: 9 })).toBe(false);
  });
  it("AMOUNT_GT: absolute and bps of supply, strictly greater", () => {
    expect(hits([amountGt(1_000)], { amount: 1_001n })).toBe(true);
    expect(hits([amountGt(1_000)], { amount: 1_000n })).toBe(false);
    // 1% of 1e9 = 1e7
    expect(hits([amountGt(bps(100))], { amount: 10_000_000n })).toBe(false);
    expect(hits([amountGt(bps(100))], { amount: 10_000_001n })).toBe(true);
    // floor: 1 bps of 15,000 = 1.5 -> threshold 1, so 2 exceeds and 1 doesn't
    expect(hits([amountGt(bps(1))], { amount: 2n, supply: 15_000n })).toBe(true);
    expect(hits([amountGt(bps(1))], { amount: 1n, supply: 15_000n })).toBe(false);
  });
  it("DEST_BAL_AFTER_GT reads the balance after the transfer", () => {
    expect(hits([destBalGt(5_000)], { destBalanceAfter: 5_001n, amount: 1n })).toBe(true);
    expect(hits([destBalGt(5_000)], { destBalanceAfter: 5_000n, amount: 9_999n })).toBe(false);
  });
  it("owner and program masks match only the masked keys", () => {
    const keys = [kb(0xd0), kb(0x50), kb(0x70)];
    expect(hitsRaw([destIn(0b001)], {}, keys)).toBe(true);
    expect(hitsRaw([destIn(0b110), srcIn(0b010), AND], {}, keys)).toBe(false); // dest is key0, not in 0b110
    expect(hitsRaw([srcIn(0b010)], {}, keys)).toBe(true);
    expect(hitsRaw([srcIn(0b001)], {}, keys)).toBe(false);
    expect(hitsRaw([topIn(0b100)], {}, keys)).toBe(true);
    expect(hitsRaw([topIn(0b011)], {}, keys)).toBe(false);
    // and through a verified set that uses every key
    expect(hits([destIn(0b001), srcIn(0b010), AND, topIn(0b100), AND], {}, keys)).toBe(true);
  });
  it("TX_IX_COUNT_GT is strict", () => {
    expect(hits([ixGt(3)], { txIxCount: 4 })).toBe(true);
    expect(hits([ixGt(3)], { txIxCount: 3 })).toBe(false);
  });
  it("TRUE / FALSE / AND / OR / NOT", () => {
    expect(hits([T], {})).toBe(true);
    expect(hits([F], {})).toBe(false);
    expect(hits([T, F, AND], {})).toBe(false);
    expect(hits([T, F, OR], {})).toBe(true);
    expect(hits([F, NOT], {})).toBe(true);
    expect(hits([...Array(16).fill(T), ...Array(15).fill(AND)], {})).toBe(true);
  });
});

// ------------------------------------------------- effects & order ---
describe("rule effects, windows, order", () => {
  it("DENY rejects whenever its condition holds, with its index and code", () => {
    expect(evaluateRuleSet(denyIf([isBuy()]), ctx())).toEqual({ ok: false, index: 0, code: 7 });
  });
  it("CAP_AMOUNT rejects only above the cap", () => {
    const s = verified([], [capAmount(0, GUARD, 2, 1_000, [isBuy()])]);
    expect(evaluateRuleSet(s, ctx({ amount: 1_000n })).ok).toBe(true);
    expect(evaluateRuleSet(s, ctx({ amount: 1_001n }))).toEqual({ ok: false, index: 0, code: 2 });
    expect(evaluateRuleSet(s, ctx({ amount: 5_000n, isBuy: false })).ok).toBe(true);
  });
  it("CAP_DEST_BALANCE rejects only when the balance after exceeds the cap (bps)", () => {
    const s = verified([], [capBalance(0, GUARD, 3, bps(100), [T])]);
    expect(evaluateRuleSet(s, ctx({ destBalanceAfter: 10_000_000n })).ok).toBe(true);
    expect(evaluateRuleSet(s, ctx({ destBalanceAfter: 10_000_001n })).ok).toBe(false);
  });
  it("windows: from inclusive, to exclusive; negative time is before every window", () => {
    const s = verified([], [deny(60, 120, 1, [T])]);
    expect(evaluateRuleSet(s, ctx({ nowRel: 59 })).ok).toBe(true);
    expect(evaluateRuleSet(s, ctx({ nowRel: 60 })).ok).toBe(false);
    expect(evaluateRuleSet(s, ctx({ nowRel: 119 })).ok).toBe(false);
    expect(evaluateRuleSet(s, ctx({ nowRel: 120 })).ok).toBe(true);
    expect(evaluateRuleSet(s, ctx({ nowRel: -5 })).ok).toBe(true);
  });
  it("the first active violating rule wins", () => {
    const s = verified([], [deny(0, 10, 1, [T]), capAmount(0, GUARD, 2, 5, [T]), deny(0, GUARD, 3, [T])]);
    expect(evaluateRuleSet(s, ctx({ nowRel: 5, amount: 100n }))).toEqual({ ok: false, index: 0, code: 1 });
    expect(evaluateRuleSet(s, ctx({ nowRel: 50, amount: 100n }))).toEqual({ ok: false, index: 1, code: 2 });
    expect(evaluateRuleSet(s, ctx({ nowRel: 50, amount: 1n }))).toEqual({ ok: false, index: 2, code: 3 });
  });
  it("exceeds() equals value > floor(supply * bps / 10000) and threshold() shows it", () => {
    const rng = new Rng(77);
    for (let i = 0; i < 3_000; i++) {
      const supply = rng.wide();
      const b = BigInt(rng.range(1, 10_000));
      const v = rng.wide();
      expect(exceeds(v, BPS_FLAG | b, supply)).toBe(v > (supply * b) / 10_000n);
      expect(threshold(BPS_FLAG | b, supply)).toBe((supply * b) / 10_000n);
    }
  });
});

describe("thresholds of unverified bps arguments (as the crate)", () => {
  const MAX = (1n << 64n) - 1n;
  it("threshold() saturates at u64::MAX instead of exceeding it", () => {
    // 65535 bps of u64::MAX is 6.55 * u64::MAX: the crate's threshold stops at u64::MAX.
    expect(threshold(BPS_FLAG | 0xffffn, MAX)).toBe(MAX);
    expect(threshold(BPS_FLAG | 10_001n, MAX)).toBe(MAX);
    // stray bits above the bps are ignored, as on-chain
    expect(threshold(BPS_FLAG | (1n << 40n) | 20_000n, MAX)).toBe(MAX);
    // below the bound it is the exact floor
    expect(threshold(BPS_FLAG | 20_000n, 10n ** 18n)).toBe(2n * 10n ** 18n);
    expect(threshold(BPS_FLAG | 10_000n, MAX)).toBe(MAX);
    expect(threshold(BPS_FLAG | 9_999n, MAX)).toBe((MAX * 9_999n) / 10_000n);
  });
  it("no u64 amount exceeds a saturated threshold, so such a cap never rejects", () => {
    expect(exceeds(MAX, BPS_FLAG | 0xffffn, MAX)).toBe(false);
    const p = rulesProg([], [capAmount(0, GUARD, 7, BPS_FLAG | 0xffffn, [T])]);
    expect(evaluateRuleSet(p, ctx({ amount: MAX, supply: MAX }))).toEqual({ ok: true });
    // 65535 bps of 1 token is 6.5535: above the floor (6) it rejects, as the crate does
    expect(evaluateRuleSet(p, ctx({ amount: 6n, supply: 1n }))).toEqual({ ok: true });
    expect(evaluateRuleSet(p, ctx({ amount: 7n, supply: 1n }))).toEqual({ ok: false, index: 0, code: 7 });
  });
});

describe("fail closed on unverified input (the crate's CODE_MALFORMED)", () => {
  it("an unknown effect rejects with code 0xFF", () => {
    const p = rulesProg([], [deny(0, GUARD, 1, [T])]);
    p.rules[0]!.effect = 9;
    expect(evaluateRuleSet(p, ctx())).toEqual({ ok: false, index: 0, code: PXR1.CODE_MALFORMED });
  });
  it("a malformed condition rejects with code 0xFF", () => {
    for (const cond of [[T, T], [AND], [node(0x55)], [node(OP.GRADUATED)]]) {
      const p = rulesProg([], [deny(0, GUARD, 1, cond)]);
      expect(evaluateRuleSet(p, ctx())).toEqual({ ok: false, index: 0, code: PXR1.CODE_MALFORMED });
    }
  });
  it("an inactive malformed rule is skipped like any inactive rule", () => {
    const p = rulesProg([], [deny(100, 200, 1, [AND])]);
    expect(evaluateRuleSet(p, ctx({ nowRel: 5 })).ok).toBe(true);
  });
});

// ------------------------------------------------- properties ---
describe("properties (seeded)", () => {
  const rng = new Rng(0x5052_4f50);
  const sets: { set: RuleSet; raw: RawRuleSet; keys: string[]; guard: number }[] = [];
  for (let i = 0; i < 150; i++) {
    const set = randRuleSet(rng);
    const bytes = compileRules(set);
    sets.push({ set, raw: verifyRulesBytes(bytes, { guardSecs: set.guardSecs! }), keys: set.keys.map((k) => k.address), guard: set.guardSecs! });
  }

  it("evaluateRuleSet equals the reference model", () => {
    for (const s of sets) {
      for (let j = 0; j < 60; j++) {
        const c = randCtx(rng, s.keys, s.guard);
        expect(evaluateRuleSet(s.raw, c)).toEqual(refRules(s.raw, c));
      }
    }
  });

  it("rules only reject: adding a rule never allows a transfer that was refused", () => {
    for (let i = 0; i + 1 < sets.length; i += 2) {
      const a = sets[i]!;
      const b = sets[i + 1]!;
      if (a.raw.keys.length + b.raw.keys.length > 8) continue;
      // b's rules appended to a (keys concatenated; b's masks shifted)
      const shift = a.raw.keys.length;
      const merged: RawRuleSet = {
        keys: [...a.raw.keys, ...b.raw.keys],
        rules: [...a.raw.rules, ...b.raw.rules.map((r) => ({ ...r, condOff: r.condOff + a.raw.nodes.length }))],
        nodes: [
          ...a.raw.nodes,
          ...b.raw.nodes.map((n) => (n.op === OP.DEST_OWNER_IN || n.op === OP.SRC_OWNER_IN || n.op === OP.TOP_PROGRAM_IN ? { ...n, a: n.a << shift } : n)),
        ],
      };
      for (let j = 0; j < 40; j++) {
        const c = randCtx(rng, [...a.keys, ...b.keys], Math.min(a.guard, b.guard));
        if (!evaluateRuleSet(a.raw, c).ok) expect(evaluateRuleSet(merged, c).ok).toBe(false);
      }
    }
  });

  const kinds: TransferKind[] = ["buy", "sell", "p2p", "batch", "protocol"];
  it("sells, the batch and protocol transfers are always allowed, whatever the rules", () => {
    for (const s of sets) {
      for (let j = 0; j < 10; j++) {
        const kind = rng.pick(["sell", "batch", "protocol"] as const);
        const v = simulateTransfer(s.set, { kind, at: rng.range(0, s.guard * 2), amount: BigInt(rng.range(0, 1e9)), to: rng.pick([...s.keys, ka(1)]) });
        expect(v.allowed).toBe(true);
      }
    }
  });

  it("at or after the guard end every transfer is allowed (rules are inert)", () => {
    for (const s of sets) {
      for (let j = 0; j < 10; j++) {
        const v = simulateTransfer(s.set, {
          kind: rng.pick(kinds),
          at: s.guard + rng.range(0, 1_000_000),
          amount: BigInt(rng.range(0, 1e12)),
          instructions: rng.range(0, 64),
          to: rng.pick([...s.keys, ka(2)]),
          from: rng.pick([...s.keys, ka(3)]),
        });
        expect(v.allowed).toBe(true);
        expect(["sell", "guardOver"]).toContain(v.stage);
      }
    }
  });

  it("zero-amount transfers are always allowed", () => {
    for (const s of sets.slice(0, 40)) {
      expect(simulateTransfer(s.set, { kind: rng.pick(kinds), at: rng.range(0, s.guard - 1), amount: 0n }).allowed).toBe(true);
    }
  });

  it("an always-deny rule blocks buys and p2p but not sells", () => {
    const set = rules({ guardSecs: 3_600 }).deny().build();
    expect(simulateTransfer(set, { kind: "buy", at: "1m", amount: 1 }).allowed).toBe(false);
    expect(simulateTransfer(set, { kind: "p2p", at: "1m", amount: 1 }).allowed).toBe(false);
    expect(simulateTransfer(set, { kind: "sell", at: "1m", amount: 1 }).allowed).toBe(true);
    expect(simulateTransfer(set, { kind: "buy", at: "1h", amount: 1 }).allowed).toBe(true);
  });
});

describe("simulateTransfer", () => {
  const team = ka(0x7e);
  const set = rules({ guardSecs: 3_600 })
    .key("team", team)
    .deny(when.buy().and(when.timeLt("2m")).and(when.txIxCountGt(3)), "BOT")
    .capAmount("0.5%", when.buy(), { code: "WHALE", first: "10m" })
    .capBalance("1%", undefined, { code: "WHALE" })
    .deny(when.buy().and(when.toIn(["team"])), "TEAM")
    .build();

  it("explains a refusal with the rule number, code and a plain sentence", () => {
    const v = simulateTransfer(set, { kind: "buy", at: "1m", amount: 1_000, instructions: 5 });
    expect(v).toMatchObject({ allowed: false, rule: 0, code: 1, codeName: "BOT", stage: "rules" });
    expect(v.why).toContain("rule 1");
    expect(v.why).toContain("more than 3 instructions");
  });
  it("caps by share of the default 1B supply", () => {
    expect(simulateTransfer(set, { kind: "buy", at: "5m", amount: 5_000_000 }).allowed).toBe(true);
    expect(simulateTransfer(set, { kind: "buy", at: "5m", amount: 5_000_001 })).toMatchObject({ allowed: false, codeName: "WHALE" });
    expect(simulateTransfer(set, { kind: "buy", at: "11m", amount: 5_000_001 }).allowed).toBe(true);
  });
  it("balance cap counts what the receiver already holds", () => {
    expect(simulateTransfer(set, { kind: "p2p", at: "20m", amount: 1, receiverBalance: 10_000_000 })).toMatchObject({ allowed: false, rule: 2 });
  });
  it("team wallets can't buy but can receive p2p (within the caps)", () => {
    expect(simulateTransfer(set, { kind: "buy", at: "30m", amount: 1, to: team })).toMatchObject({ allowed: false, codeName: "TEAM" });
    expect(simulateTransfer(set, { kind: "p2p", at: "30m", amount: 1, to: team }).allowed).toBe(true);
  });
  it("works on PXR1 bytes and with no rules", () => {
    const bytes = compileRules(set);
    expect(simulateTransfer(bytes, { kind: "buy", at: "1m", amount: 1, instructions: 9, guardSecs: 3_600 }).allowed).toBe(false);
    expect(simulateTransfer(null, { kind: "buy", at: "1m", amount: 1 })).toMatchObject({ allowed: true });
  });
});

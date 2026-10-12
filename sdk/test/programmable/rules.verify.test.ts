/**
 * PXR1 verifier: every case of crates/noised-rules/tests/common/cases.rs
 * `rules_invalid()` (same base program, same single defect, same expected
 * error name), plus valid edge programs. Each check has an input that only
 * that check rejects, so removing a check fails a test here.
 */
import { describe, expect, it } from "vitest";

import { OP, PXR1, ProgError, decodeRulesRaw, rulesHash, verifyRules, verifyRulesBytes } from "../../src/programmable/index.js";
import type { RawRuleSet, VerifyErrorCode } from "../../src/programmable/index.js";
import {
  AND, F, GUARD, NOT, OR, T, amountGt, bps, capAmount, capBalance, cloneRules, deny, destBalGt, destIn, enc, isBuy, ixGt,
  kb, node, rep, rulesProg, srcIn, timeGe, timeLt, topIn, Rng,
} from "./helpers.js";

const K1 = kb(0x11);
const K2 = kb(0x22);
const K3 = kb(0x33);

/** The crate's rules_base(): two keys, three rules, every effect. */
const rulesBase = (): RawRuleSet =>
  rulesProg(
    [K1, K2],
    [
      deny(0, 120, 1, [isBuy(), srcIn(0b01), AND]),
      capAmount(0, 3_600, 2, 1_000_000, [destIn(0b10)]),
      capBalance(60, 86_400, 3, bps(100), [isBuy(), timeLt(600), AND]),
    ],
  );
const withP = (f: (p: RawRuleSet) => void): Uint8Array => {
  const p = cloneRules(rulesBase());
  f(p);
  return enc(p);
};
const withB = (f: (b: number[]) => void): Uint8Array => {
  const b = [...enc(rulesBase())];
  f(b);
  return Uint8Array.from(b);
};
const one = (cond: ReturnType<typeof node>[]): Uint8Array => enc(rulesProg([K1, K2], [deny(0, 600, 9, [...cond, srcIn(0b11), OR])]));
const magic = (s: string) => (b: number[]): void => {
  for (let i = 0; i < 4; i++) b[i] = s.charCodeAt(i);
};

const G = GUARD;
const INVALID: [string, number, Uint8Array, VerifyErrorCode][] = [
  // layout
  ["empty input", G, new Uint8Array(0), "TooShort"],
  ["11 bytes", G, enc(rulesBase()).slice(0, 11), "TooShort"],
  ["graph magic", G, withB(magic("PXG1")), "BadMagic"],
  ["lowercase magic", G, withB(magic("pxr1")), "BadMagic"],
  ["version 0", G, withB((b) => (b[4] = 0)), "BadVersion"],
  ["version 2", G, withB((b) => (b[4] = 2)), "BadVersion"],
  ["reserved byte 8 set", G, withB((b) => (b[8] = 1)), "ReservedNonZero"],
  ["reserved byte 11 set", G, withB((b) => (b[11] = 0x80)), "ReservedNonZero"],
  ["9 keys", G, withP((p) => (p.keys = Array.from({ length: 9 }, (_, i) => kb(i + 1)))), "TooManyKeys"],
  ["no rules", G, withP((p) => (p.rules = [])), "NoRules"],
  ["17 rules", G, enc(rulesProg([], rep(deny(0, 10, 1, [T]), 17))), "TooManyRules"],
  ["65 nodes", G, enc(rulesProg([], [deny(0, 10, 1, [T]), deny(0, 10, 1, [...rep(F, 32), ...rep(AND, 32)])])), "TooManyNodes"],
  ["one byte short", G, withB((b) => b.pop()), "BadLength"],
  ["one byte extra", G, withB((b) => b.push(0)), "BadLength"],
  ["node count one too high", G, withB((b) => (b[7]! += 1)), "BadLength"],
  // keys
  ["zero key", G, withP((p) => (p.keys[1] = new Uint8Array(32))), "ZeroKey"],
  ["duplicate key", G, withP((p) => (p.keys[1] = K1.slice())), "DuplicateKey"],
  ["unused key", G, withP((p) => p.keys.push(K3)), "UnusedKey"],
  // rules
  ["empty window", G, withP((p) => (p.rules[1]!.fromRel = 3_600)), "BadWindow"],
  ["reversed window", G, withP((p) => (p.rules[0]!.fromRel = 121)), "BadWindow"],
  ["window past the guard", 86_399, enc(rulesBase()), "WindowPastGuard"],
  ["window past 72 h with a longer guard", 300_000, withP((p) => (p.rules[2]!.toRel = 259_201)), "WindowPastGuard"],
  ["code 64", G, withP((p) => (p.rules[1]!.code = 64)), "BadCode"],
  ["code 255", G, withP((p) => (p.rules[0]!.code = 255)), "BadCode"],
  ["effect 0", G, withP((p) => (p.rules[0]!.effect = 0)), "UnknownEffect"],
  ["effect 4", G, withP((p) => (p.rules[2]!.effect = 4)), "UnknownEffect"],
  ["deny with an argument", G, withP((p) => (p.rules[0]!.arg = 1n)), "DenyArgNonZero"],
  ["cap of zero", G, withP((p) => (p.rules[1]!.arg = 0n)), "ZeroCap"],
  ["cap of 0 bps", G, withP((p) => (p.rules[2]!.arg = bps(0))), "BadBps"],
  ["cap of 10001 bps", G, withP((p) => (p.rules[2]!.arg = bps(10_001))), "BadBps"],
  ["cap bps with bit 16 set", G, withP((p) => (p.rules[1]!.arg = bps(100) | (1n << 16n))), "BadBps"],
  ["leaf bps with bit 62 set", G, one([amountGt(bps(5) | (1n << 62n))]), "BadBps"],
  ["leaf bps 0", G, one([destBalGt(bps(0))]), "BadBps"],
  // condition placement
  [
    "empty condition",
    G,
    withP((p) => {
      p.rules[1]!.condLen = 0;
      p.nodes.splice(3, 1);
      p.rules[2]!.condOff -= 1;
    }),
    "EmptyCondition",
  ],
  [
    "empty condition at another offset",
    G,
    withP((p) => {
      p.rules[1]!.condLen = 0;
      p.rules[1]!.condOff = 0;
      p.nodes.splice(3, 1);
      p.rules[2]!.condOff -= 1;
    }),
    "EmptyCondition",
  ],
  ["condition starts late", G, withP((p) => (p.rules[0]!.condOff = 1)), "ConditionNotContiguous"],
  [
    "conditions overlap",
    G,
    withP((p) => {
      p.rules[1]!.condOff = 2;
      p.rules[1]!.condLen = 2;
    }),
    "ConditionNotContiguous",
  ],
  ["condition past the nodes", G, withP((p) => (p.rules[2]!.condLen = 4)), "ConditionOutOfRange"],
  ["unreferenced trailing node", G, withP((p) => p.nodes.push(T)), "UnreferencedNode"],
  // condition nodes
  ["op 0x05", G, one([node(0x05)]), "UnknownOp"],
  ["op 0x0f", G, one([node(0x0f)]), "UnknownOp"],
  ["op 0x1a", G, one([node(0x1a)]), "UnknownOp"],
  ["graph leaf in rules", G, one([node(OP.GRADUATED)]), "UnknownOp"],
  ["TRUE with a", G, one([node(OP.TRUE, 1)]), "NonZeroOperand"],
  ["FALSE with arg", G, one([node(OP.FALSE, 0, 1)]), "NonZeroOperand"],
  ["AND with arg", G, one([T, T, node(OP.AND, 0, 1)]), "NonZeroOperand"],
  ["OR with a", G, one([T, T, node(OP.OR, 1)]), "NonZeroOperand"],
  ["NOT with a", G, one([T, node(OP.NOT, 1)]), "NonZeroOperand"],
  ["IS_BUY with a", G, one([node(OP.IS_BUY, 1)]), "NonZeroOperand"],
  ["IS_P2P with arg", G, one([node(OP.IS_P2P, 0, 1)]), "NonZeroOperand"],
  ["TIME_LT with a", G, one([node(OP.TIME_LT, 1, 5)]), "NonZeroOperand"],
  ["TIME_GE with a", G, one([node(OP.TIME_GE, 1, 5)]), "NonZeroOperand"],
  ["AMOUNT_GT with a", G, one([node(OP.AMOUNT_GT, 1, 5)]), "NonZeroOperand"],
  ["DEST_BAL_AFTER_GT with a", G, one([node(OP.DEST_BAL_AFTER_GT, 1, 5)]), "NonZeroOperand"],
  ["TX_IX_COUNT_GT with a", G, one([node(OP.TX_IX_COUNT_GT, 1, 5)]), "NonZeroOperand"],
  ["DEST_OWNER_IN with arg", G, one([node(OP.DEST_OWNER_IN, 1, 1)]), "NonZeroOperand"],
  ["empty key mask", G, one([destIn(0)]), "BadKeyMask"],
  ["key mask names a missing key", G, one([topIn(0b100)]), "BadKeyMask"],
  ["key mask with no keys", G, enc(rulesProg([], [deny(0, 10, 1, [srcIn(1)])])), "BadKeyMask"],
  ["TIME_LT past the guard", 600, one([timeLt(601)]), "TimeOutOfRange"],
  ["TIME_GE past 72 h", 300_000, one([timeGe(259_201)]), "TimeOutOfRange"],
  ["AND on one value", G, one([T, AND]), "StackUnderflow"],
  ["NOT on nothing", G, one([NOT, T]), "StackUnderflow"],
  ["OR first", G, one([OR]), "StackUnderflow"],
  ["17 values on the stack", G, one([...rep(T, 17), ...rep(AND, 16)]), "StackOverflow"],
  ["two values left", G, one([T, F]), "LeftoverValues"],
  // precedence
  [
    "zero key before a bad window",
    G,
    withP((p) => {
      p.keys[0] = new Uint8Array(32);
      p.rules[0]!.toRel = 0;
    }),
    "ZeroKey",
  ],
  [
    "bad window before a bad code",
    G,
    withP((p) => {
      p.rules[0]!.toRel = 0;
      p.rules[0]!.code = 64;
    }),
    "BadWindow",
  ],
  [
    "earlier rule's error first",
    G,
    withP((p) => {
      p.rules[0]!.code = 64;
      p.rules[1]!.effect = 9;
    }),
    "BadCode",
  ],
  ["operand before stack", G, one([node(OP.AND, 0, 1)]), "NonZeroOperand"],
  [
    "length before keys",
    G,
    withB((b) => {
      b[12] = 0;
      b.push(0);
    }),
    "BadLength",
  ],
];

describe("PXR1 verifier: the crate's invalid cases", () => {
  it.each(INVALID)("%s -> %s", (_name, guard, bytes, code) => {
    const r = verifyRules(bytes, { guardSecs: guard });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(code);
    expect(() => verifyRulesBytes(bytes, { guardSecs: guard })).toThrow(ProgError);
  });

  it("the base program itself is valid (so each case has exactly the defect it names)", () => {
    expect(verifyRules(enc(rulesBase()), { guardSecs: GUARD }).ok).toBe(true);
  });
});

describe("PXR1 verifier: valid edges", () => {
  it("the largest rule set (8 keys, 16 rules, 64 nodes) is exactly 1,228 bytes", () => {
    const keys = Array.from({ length: 8 }, (_, i) => kb(i + 1));
    const rs = Array.from({ length: 16 }, (_, i) => {
      const cond =
        i % 4 === 0
          ? [destIn(0xff), isBuy(), AND, NOT]
          : i % 4 === 1
            ? [srcIn(1 << (i % 8)), timeLt(3_600 * (i + 1)), AND, NOT]
            : i % 4 === 2
              ? [topIn(0x81), amountGt(bps(25)), OR, NOT]
              : [destBalGt(1n << 40n), ixGt(i), OR, NOT];
      const effect = 1 + (i % 3);
      const arg = effect === 1 ? 0n : effect === 2 ? BigInt(1_000 * (i + 1)) : bps(100 + i);
      return { from: 60 * i, to: 3_600 * (i + 1), effect, code: i * 4, arg, cond };
    });
    const bytes = enc(rulesProg(keys, rs));
    expect(bytes.length).toBe(PXR1.MAX_SIZE);
    expect(verifyRules(bytes, { guardSecs: GUARD }).ok).toBe(true);
  });

  it("largest absolute caps, code 63, and any instruction count are valid", () => {
    const bytes = enc(
      rulesProg([], [capAmount(0, 600, 63, (1n << 63n) - 1n, [amountGt((1n << 63n) - 1n)]), capBalance(0, 600, 0, 1, [ixGt((1n << 64n) - 1n)])]),
    );
    expect(verifyRules(bytes, { guardSecs: GUARD }).ok).toBe(true);
  });

  it("a time bound equal to the guard is valid; one past it is not", () => {
    const ok = enc(rulesProg([], [deny(0, 600, 32, [timeLt(600), timeGe(0), AND])]));
    expect(verifyRules(ok, { guardSecs: 600 }).ok).toBe(true);
    const bad = enc(rulesProg([], [deny(0, 600, 32, [timeLt(601), timeGe(0), AND])]));
    expect(verifyRules(bad, { guardSecs: 600 })).toMatchObject({ ok: false, code: "TimeOutOfRange" });
  });

  it("a stack of exactly 16 values is valid; 17 overflows", () => {
    const ok = enc(rulesProg([], [deny(0, 10, 1, [...rep(T, 16), ...rep(AND, 15)])]));
    expect(verifyRules(ok).ok).toBe(true);
  });

  it("the guard is capped at 72 h and defaults to it", () => {
    const b = enc(rulesProg([], [deny(0, GUARD, 1, [isBuy()])]));
    expect(verifyRules(b).ok).toBe(true);
    expect(verifyRules(b, { guardSecs: 10 * GUARD }).ok).toBe(true);
    const past = enc(rulesProg([], [deny(0, GUARD + 1, 1, [isBuy()])]));
    expect(verifyRules(past, { guardSecs: 10 * GUARD })).toMatchObject({ ok: false, code: "WindowPastGuard" });
  });

  it("verifyRules returns the content hash of valid bytes", () => {
    const b = enc(rulesBase());
    const r = verifyRules(b, { guardSecs: GUARD });
    expect(r.ok && r.hash).toEqual(rulesHash(b));
  });

  it("decodeRulesRaw round-trips the layout exactly", () => {
    const p = rulesBase();
    expect(decodeRulesRaw(enc(p))).toEqual(p);
  });
});

describe("PXR1 verifier: totality", () => {
  it("never throws anything but ProgError on random or mutated bytes", () => {
    const rng = new Rng(0x5852_3101);
    const base = enc(rulesBase());
    for (let i = 0; i < 4_000; i++) {
      let b: Uint8Array;
      if (rng.coin()) {
        b = base.slice();
        for (let k = rng.range(1, 4); k > 0; k--) b[rng.below(b.length)] = Number(rng.next() & 0xffn);
      } else {
        b = rng.bytes(rng.range(0, 300));
        if (rng.coin() && b.length >= 5) b.set([0x50, 0x58, 0x52, 0x31, 1], 0);
      }
      const r = verifyRules(b, { guardSecs: rng.pick([60, 600, GUARD]) });
      if (!r.ok) expect(typeof r.code).toBe("string");
    }
  });
});

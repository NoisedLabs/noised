/**
 * PXG1 verifier: every case of crates/noised-rules/tests/common/cases.rs
 * `graph_invalid()` (same base graph, same single defect, same expected
 * error name), plus valid edges and totality on random bytes.
 */
import { describe, expect, it } from "vitest";

import { OP, PXG1, ProgError, decodeGraphRaw, graphHash, verifyGraph, verifyGraphBytes } from "../../src/programmable/index.js";
import type { RawGraph, VerifyErrorCode } from "../../src/programmable/index.js";
import { ACTION, AND, F, NOT, OR, T, TRIGGER, cloneGraph, genc, gnode, graphProg, isBuy, kb, node, rep, Rng } from "./helpers.js";

const OPK = kb(0x0a);
const R1 = kb(0xa1);
const R2 = kb(0xa2);
const R3 = kb(0xa3);
const tsol = (x: bigint | number) => node(OP.TREASURY_SOL_GTE, 0, x);
const U64_MAX = (1n << 64n) - 1n;

/** The crate's graph_base(): an operator, two recipients, every trigger and action. */
function graphBase(): RawGraph {
  const gated = gnode(TRIGGER.WHEN, 0, ACTION.BUYBACK_BURN, 1_000_000_000, 300);
  gated.operatorGated = 1;
  return graphProg(
    OPK,
    [
      [R1, 6_000],
      [R2, 4_000],
    ],
    [
      [gnode(TRIGGER.EVERY, 86_400, ACTION.BUYBACK_BURN, 500_000_000, 300), [tsol(1_000_000_000)]],
      [gnode(TRIGGER.AFTER, 0, ACTION.BURN, 1_000_000, 0), []],
      [gnode(TRIGGER.ON_GRADUATED, 0, ACTION.BURN, U64_MAX, 0), []],
      [gnode(TRIGGER.EVERY, 7 * 86_400, ACTION.DISTRIBUTE_SOL, 2_000_000_000, 0), []],
      [gated, [node(OP.PRICE_LTE, 0, 1n << 60n), node(OP.GRADUATED), AND]],
    ],
  );
}
const gwith = (f: (g: RawGraph) => void): Uint8Array => {
  const g = cloneGraph(graphBase());
  f(g);
  return genc(g);
};
const gwithBytes = (f: (b: number[]) => void): Uint8Array => {
  const b = [...genc(graphBase())];
  f(b);
  return Uint8Array.from(b);
};
/** The base graph with node 0's condition replaced. */
const gcond = (cond: ReturnType<typeof node>[]): Uint8Array => {
  const g = cloneGraph(graphBase());
  const old = g.nodes[0]!.condLen;
  g.cond.splice(0, old, ...cond);
  g.nodes[0]!.condLen = cond.length;
  g.nodes[4]!.condOff = cond.length;
  return genc(g);
};

const INVALID: [string, Uint8Array, VerifyErrorCode][] = [
  // layout
  ["empty input", new Uint8Array(0), "TooShort"],
  ["43 bytes", genc(graphBase()).slice(0, 43), "TooShort"],
  ["rules magic", gwithBytes((b) => [0x50, 0x58, 0x52, 0x31].forEach((x, i) => (b[i] = x))), "BadMagic"],
  ["version 0", gwithBytes((b) => (b[4] = 0)), "BadVersion"],
  ["version 2", gwithBytes((b) => (b[4] = 2)), "BadVersion"],
  ["flag bit 1", gwith((g) => (g.flags |= 2)), "UnknownFlags"],
  ["flag bit 7", gwith((g) => (g.flags |= 0x80)), "UnknownFlags"],
  ["reserved byte 9 set", gwithBytes((b) => (b[9] = 1)), "ReservedNonZero"],
  ["reserved byte 11 set", gwithBytes((b) => (b[11] = 1)), "ReservedNonZero"],
  [
    "9 recipients",
    gwith((g) => (g.recipients = Array.from({ length: 9 }, (_, i) => ({ key: kb(i + 1), bps: i + 1 === 9 ? 2_000 : 1_000 })))),
    "TooManyRecipients",
  ],
  ["no nodes", gwith((g) => (g.nodes = [])), "NoGraphNodes"],
  ["17 nodes", genc(graphProg(null, [], rep([gnode(TRIGGER.EVERY, 600, ACTION.BURN, 1, 0), []], 17))), "TooManyGraphNodes"],
  [
    "97 condition nodes",
    genc(graphProg(null, [], [[gnode(TRIGGER.WHEN, 0, ACTION.BURN, 1, 0), [...rep(F, 49), ...rep(OR, 48)]]])),
    "TooManyNodes",
  ],
  ["one byte short", gwithBytes((b) => b.pop()), "BadLength"],
  ["one byte extra", gwithBytes((b) => b.push(0)), "BadLength"],
  ["recipient count one too high", gwithBytes((b) => (b[5]! += 1)), "BadLength"],
  // operator
  ["operator flag without a key", gwith((g) => (g.operator = new Uint8Array(32))), "MissingOperator"],
  ["operator key without the flag", gwith((g) => (g.flags = 0)), "UnexpectedOperator"],
  // recipients
  ["zero recipient", gwith((g) => (g.recipients[0]!.key = new Uint8Array(32))), "ZeroRecipient"],
  ["duplicate recipient", gwith((g) => (g.recipients[1]!.key = R1.slice())), "DuplicateRecipient"],
  ["recipient with 0 bps", gwith((g) => g.recipients.push({ key: R3, bps: 0 })), "ZeroRecipientBps"],
  ["bps sum 9999", gwith((g) => (g.recipients[1]!.bps = 3_999)), "BadRecipientBps"],
  ["bps sum 10001", gwith((g) => (g.recipients[1]!.bps = 4_001)), "BadRecipientBps"],
  [
    "bps sum over u16",
    gwith((g) => {
      g.recipients[0]!.bps = 60_000;
      g.recipients[1]!.bps = 15_536;
    }),
    "BadRecipientBps",
  ],
  // nodes
  ["node reserved byte set", gwith((g) => (g.nodes[2]!.reserved![4] = 1)), "ReservedNonZero"],
  ["trigger 0", gwith((g) => (g.nodes[0]!.trigger = 0)), "UnknownTrigger"],
  ["trigger 5", gwith((g) => (g.nodes[3]!.trigger = 5)), "UnknownTrigger"],
  ["every 599 s", gwith((g) => (g.nodes[0]!.triggerArg = 599n)), "EveryTooShort"],
  ["after a missing node", gwith((g) => (g.nodes[1]!.triggerArg = 5n)), "BadAfterRef"],
  ["after node 2^32", gwith((g) => (g.nodes[1]!.triggerArg = 1n << 32n)), "BadAfterRef"],
  ["after itself", gwith((g) => (g.nodes[1]!.triggerArg = 1n)), "AfterCycle"],
  [
    "after itself before a later node's error",
    gwith((g) => {
      g.nodes[1]!.triggerArg = 1n;
      g.nodes[3]!.budgetPerEpoch = 0n;
    }),
    "AfterCycle",
  ],
  [
    "after cycle of two",
    gwith((g) => {
      g.nodes[0]!.trigger = TRIGGER.AFTER;
      g.nodes[0]!.triggerArg = 1n;
    }),
    "AfterCycle",
  ],
  [
    "after cycle of three",
    gwith((g) => {
      g.nodes[2]!.trigger = TRIGGER.AFTER;
      g.nodes[2]!.triggerArg = 1n;
      g.nodes[1]!.triggerArg = 3n;
      g.nodes[3]!.trigger = TRIGGER.AFTER;
      g.nodes[3]!.triggerArg = 2n;
    }),
    "AfterCycle",
  ],
  ["on-graduated with an argument", gwith((g) => (g.nodes[2]!.triggerArg = 1n)), "TriggerArgNonZero"],
  ["when with an argument", gwith((g) => (g.nodes[4]!.triggerArg = 600n)), "TriggerArgNonZero"],
  [
    "when without a condition",
    gwith((g) => {
      g.nodes[0]!.trigger = TRIGGER.WHEN;
      g.nodes[0]!.triggerArg = 0n;
      g.nodes[0]!.condLen = 0;
      g.cond.splice(0, 1);
      g.nodes[4]!.condOff = 0;
    }),
    "WhenWithoutCondition",
  ],
  ["action 0", gwith((g) => (g.nodes[1]!.action = 0)), "UnknownAction"],
  ["action 6", gwith((g) => (g.nodes[1]!.action = 6)), "UnknownAction"],
  ["add locked liquidity (reserved)", gwith((g) => (g.nodes[1]!.action = ACTION.ADD_LOCKED_LIQUIDITY)), "ReservedAction"],
  ["merkle airdrop (reserved)", gwith((g) => (g.nodes[2]!.action = ACTION.MERKLE_AIRDROP)), "ReservedAction"],
  ["p1 of zero", gwith((g) => (g.nodes[3]!.p1 = 0n)), "ZeroP1"],
  ["premium over the maximum", gwith((g) => (g.nodes[0]!.p2 = BigInt(PXG1.MAX_PREMIUM_BPS + 1))), "PremiumTooHigh"],
  ["burn with p2", gwith((g) => (g.nodes[1]!.p2 = 1n)), "P2NonZero"],
  ["distribute with p2", gwith((g) => (g.nodes[3]!.p2 = 1n)), "P2NonZero"],
  ["distribute without recipients", genc(graphProg(null, [], [[gnode(TRIGGER.EVERY, 600, ACTION.DISTRIBUTE_SOL, 1, 0), []]])), "NoRecipients"],
  ["operator_gated 2", gwith((g) => (g.nodes[4]!.operatorGated = 2)), "BadOperatorGated"],
  [
    "gated without an operator",
    gwith((g) => {
      g.flags = 0;
      g.operator = new Uint8Array(32);
    }),
    "GatedWithoutOperator",
  ],
  ["epoch 3599 s", gwith((g) => (g.nodes[2]!.epochSecs = 3_599)), "EpochTooShort"],
  ["zero budget", gwith((g) => (g.nodes[1]!.budgetPerEpoch = 0n)), "ZeroBudget"],
  ["zero max runs", gwith((g) => (g.nodes[3]!.maxRunsPerEpoch = 0)), "ZeroMaxRuns"],
  // conditions
  ["empty condition at an offset", gwith((g) => (g.nodes[1]!.condOff = 1)), "ConditionNotContiguous"],
  ["condition starts late", gwith((g) => (g.nodes[4]!.condOff = 2)), "ConditionNotContiguous"],
  ["conditions overlap", gwith((g) => (g.nodes[4]!.condOff = 0)), "ConditionNotContiguous"],
  ["condition past the nodes", gwith((g) => (g.nodes[4]!.condLen = 4)), "ConditionOutOfRange"],
  ["unreferenced trailing node", gwith((g) => g.cond.push(T)), "UnreferencedNode"],
  ["rules leaf in a graph", gcond([isBuy()]), "UnknownOp"],
  ["op 0x28", gcond([node(0x28)]), "UnknownOp"],
  ["GRADUATED with arg", gcond([node(OP.GRADUATED, 0, 1)]), "NonZeroOperand"],
  ["TREASURY_SOL_GTE with a", gcond([node(OP.TREASURY_SOL_GTE, 1, 1)]), "NonZeroOperand"],
  ["TREASURY_TOKEN_GTE with a", gcond([node(OP.TREASURY_TOKEN_GTE, 1, 1)]), "NonZeroOperand"],
  ["PRICE_LTE with a", gcond([node(OP.PRICE_LTE, 1, 1)]), "NonZeroOperand"],
  ["PRICE_GTE with a", gcond([node(OP.PRICE_GTE, 1, 1)]), "NonZeroOperand"],
  ["TIME_GE with a", gcond([node(OP.NOW_GE, 1, 1)]), "NonZeroOperand"],
  ["TIME_LT past i64", gcond([node(OP.NOW_LT, 0, 1n << 63n)]), "TimeOutOfRange"],
  ["TIME_GE past i64", gcond([node(OP.NOW_GE, 0, U64_MAX)]), "TimeOutOfRange"],
  ["runs of a missing node", gcond([node(OP.RUNS_IN_EPOCH_LT, 5, 1)]), "BadNodeRef"],
  ["NOT first", gcond([NOT]), "StackUnderflow"],
  ["17 values", gcond([...rep(T, 17), ...rep(OR, 16)]), "StackOverflow"],
  ["two values left", gcond([T, T]), "LeftoverValues"],
  // graph-wide
  ["operator but nothing gated", gwith((g) => (g.nodes[4]!.operatorGated = 0)), "OperatorUnused"],
  ["recipients but no distribute node", gwith((g) => (g.nodes[3]!.action = ACTION.BURN)), "RecipientsUnused"],
  // precedence
  [
    "operator before recipients",
    gwith((g) => {
      g.operator = new Uint8Array(32);
      g.recipients[0]!.key = new Uint8Array(32);
    }),
    "MissingOperator",
  ],
  [
    "trigger before action",
    gwith((g) => {
      g.nodes[0]!.triggerArg = 1n;
      g.nodes[0]!.action = 9;
    }),
    "EveryTooShort",
  ],
  [
    "node error before a cycle",
    gwith((g) => {
      g.nodes[0]!.trigger = TRIGGER.AFTER;
      g.nodes[0]!.triggerArg = 1n;
      g.nodes[3]!.budgetPerEpoch = 0n;
    }),
    "ZeroBudget",
  ],
];

describe("PXG1 verifier: the crate's invalid cases", () => {
  it.each(INVALID)("%s -> %s", (_name, bytes, code) => {
    const r = verifyGraph(bytes);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(code);
    expect(() => verifyGraphBytes(bytes)).toThrow(ProgError);
  });

  it("the base graph itself is valid", () => {
    expect(verifyGraph(genc(graphBase())).ok).toBe(true);
  });
});

describe("PXG1 verifier: valid edges", () => {
  it("the largest graph (8 recipients, 16 nodes, 96 condition nodes) is exactly 2,044 bytes", () => {
    const recipients: [Uint8Array, number][] = Array.from({ length: 8 }, (_, i) => [kb(0x40 + i), 1_250]);
    const nodes: [ReturnType<typeof gnode>, ReturnType<typeof node>[]][] = Array.from({ length: 16 }, (_, i) => {
      const g = gnode(TRIGGER.WHEN, 0, i === 0 ? ACTION.DISTRIBUTE_SOL : ACTION.BURN, 1 + i, 0);
      g.operatorGated = i === 1 ? 1 : 0;
      return [g, [node(OP.RUNS_IN_EPOCH_LT, i, 3), tsol(i), AND, node(OP.GRADUATED), OR, NOT]];
    });
    const bytes = genc(graphProg(OPK, recipients, nodes));
    expect(bytes.length).toBe(PXG1.MAX_SIZE);
    expect(verifyGraph(bytes).ok).toBe(true);
  });

  it("EVERY has no upper bound, RUNS_IN_EPOCH_LT takes any count, unix up to i64::MAX", () => {
    const b = genc(
      graphProg(null, [], [[gnode(TRIGGER.EVERY, U64_MAX, ACTION.BURN, 1, 0), [node(OP.RUNS_IN_EPOCH_LT, 0, 0), node(OP.NOW_LT, 0, (1n << 63n) - 1n), AND]]]),
    );
    expect(verifyGraph(b).ok).toBe(true);
  });

  it("verifyGraph returns the content hash; decodeGraphRaw round-trips the layout", () => {
    const g = graphBase();
    const b = genc(g);
    const r = verifyGraph(b);
    expect(r.ok && r.hash).toEqual(graphHash(b));
    expect(genc(decodeGraphRaw(b))).toEqual(b);
  });
});

describe("PXG1 verifier: totality", () => {
  it("never throws anything but ProgError on random or mutated bytes", () => {
    const rng = new Rng(0x5847_3101);
    const base = genc(graphBase());
    for (let i = 0; i < 4_000; i++) {
      let b: Uint8Array;
      if (rng.coin()) {
        b = base.slice();
        for (let k = rng.range(1, 4); k > 0; k--) b[rng.below(b.length)] = Number(rng.next() & 0xffn);
      } else {
        b = rng.bytes(rng.range(0, 400));
        if (rng.coin() && b.length >= 5) b.set([0x50, 0x58, 0x47, 0x31, 1], 0);
      }
      const r = verifyGraph(b);
      if (!r.ok) expect(typeof r.code).toBe("string");
    }
  });
});

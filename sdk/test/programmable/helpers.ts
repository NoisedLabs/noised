/**
 * Test support: the crate's SplitMix64 generator, raw builders mirroring
 * crates/noised-rules/tests/common (same names), and random valid models.
 */
import {
  ACTION,
  BPS_FLAG,
  type CondNode,
  type Cond,
  EFFECT,
  encodeBase58,
  encodeGraphRaw,
  encodeRulesRaw,
  type Graph,
  type GraphNode,
  OP,
  PXG1,
  type RawGNode,
  type RawGraph,
  type RawRule,
  type RawRuleSet,
  type Rule,
  type RuleSet,
  TRIGGER,
} from "../../src/programmable/index.js";

/** SplitMix64 (same as the crate's tests): deterministic, seeded. */
export class Rng {
  private s: bigint;
  constructor(seed: number | bigint) {
    this.s = BigInt(seed) & 0xffff_ffff_ffff_ffffn;
  }
  next(): bigint {
    const M = 0xffff_ffff_ffff_ffffn;
    this.s = (this.s + 0x9e37_79b9_7f4a_7c15n) & M;
    let z = this.s;
    z = ((z ^ (z >> 30n)) * 0xbf58_476d_1ce4_e5b9n) & M;
    z = ((z ^ (z >> 27n)) * 0x94d0_49bb_1331_11ebn) & M;
    return z ^ (z >> 31n);
  }
  /** Uniform in 0..n (n > 0). */
  below(n: number): number {
    return Number(this.next() % BigInt(n));
  }
  /** Uniform in lo..=hi. */
  range(lo: number, hi: number): number {
    return lo + this.below(hi - lo + 1);
  }
  coin(): boolean {
    return (this.next() & 1n) === 1n;
  }
  oneIn(n: number): boolean {
    return this.below(n) === 0;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.below(items.length)]!;
  }
  bytes(len: number): Uint8Array {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = Number(this.next() & 0xffn);
    return out;
  }
  key(): Uint8Array {
    const k = this.bytes(32);
    k[0]! |= 1;
    return k;
  }
  /**
   * A u64 biased toward edges. Not the crate's `wide` draw for draw (that one
   * also has 2^20 / 2^40 buckets); the exact mirror the differential run needs
   * is in differential.ts.
   */
  wide(): bigint {
    switch (this.below(6)) {
      case 0:
        return this.pick([0n, 1n, 2n, (1n << 64n) - 1n, (1n << 64n) - 2n, 1n << 63n, (1n << 63n) - 1n]);
      case 1:
        return BigInt(this.below(1000));
      default:
        return this.next();
    }
  }
}

/** A 32-byte key filled with `b`. */
export const kb = (b: number): Uint8Array => new Uint8Array(32).fill(b);
/** Its base58 address. */
export const ka = (b: number): string => encodeBase58(kb(b));

// ---------------------------------------------------------------- nodes ---
export const node = (op: number, a = 0, arg: bigint | number = 0n): CondNode => ({ op, a, arg: BigInt(arg) });
export const T = node(OP.TRUE);
export const F = node(OP.FALSE);
export const AND = node(OP.AND);
export const OR = node(OP.OR);
export const NOT = node(OP.NOT);
export const isBuy = (): CondNode => node(OP.IS_BUY);
export const isP2p = (): CondNode => node(OP.IS_P2P);
export const timeLt = (s: number | bigint): CondNode => node(OP.TIME_LT, 0, s);
export const timeGe = (s: number | bigint): CondNode => node(OP.TIME_GE, 0, s);
export const amountGt = (a: bigint | number): CondNode => node(OP.AMOUNT_GT, 0, a);
export const destBalGt = (a: bigint | number): CondNode => node(OP.DEST_BAL_AFTER_GT, 0, a);
export const destIn = (m: number): CondNode => node(OP.DEST_OWNER_IN, m);
export const srcIn = (m: number): CondNode => node(OP.SRC_OWNER_IN, m);
export const topIn = (m: number): CondNode => node(OP.TOP_PROGRAM_IN, m);
export const ixGt = (n: bigint | number): CondNode => node(OP.TX_IX_COUNT_GT, 0, n);
export const bps = (b: number | bigint): bigint => BPS_FLAG | BigInt(b);
export const rep = <X>(x: X, n: number): X[] => new Array<X>(n).fill(x);

// ---------------------------------------------------------------- rules ---
export const GUARD = 259_200;

export interface R {
  from: number;
  to: number;
  effect: number;
  code: number;
  arg: bigint;
  cond: CondNode[];
}
export const deny = (from: number, to: number, code: number, cond: CondNode[]): R => ({ from, to, effect: EFFECT.DENY, code, arg: 0n, cond });
export const capAmount = (from: number, to: number, code: number, cap: bigint | number, cond: CondNode[]): R => ({
  from, to, effect: EFFECT.CAP_AMOUNT, code, arg: BigInt(cap), cond,
});
export const capBalance = (from: number, to: number, code: number, cap: bigint | number, cond: CondNode[]): R => ({
  from, to, effect: EFFECT.CAP_DEST_BALANCE, code, arg: BigInt(cap), cond,
});

/** A raw rule set with conditions laid out back to back. */
export function rulesProg(keys: Uint8Array[], rs: R[]): RawRuleSet {
  const rules: RawRule[] = [];
  const nodes: CondNode[] = [];
  for (const r of rs) {
    rules.push({ fromRel: r.from, toRel: r.to, condOff: nodes.length, condLen: r.cond.length, effect: r.effect, code: r.code, arg: r.arg });
    nodes.push(...r.cond);
  }
  return { keys: keys.map((k) => k.slice()), rules, nodes };
}
export const enc = (p: RawRuleSet): Uint8Array => encodeRulesRaw(p);
export const cloneRules = (p: RawRuleSet): RawRuleSet => ({
  keys: p.keys.map((k) => k.slice()),
  rules: p.rules.map((r) => ({ ...r })),
  nodes: p.nodes.map((n) => ({ ...n })),
});

// ---------------------------------------------------------------- graph ---
export const DAY = 86_400;
export function gnode(trigger: number, targ: bigint | number, action: number, p1: bigint | number, p2: bigint | number): RawGNode {
  return {
    trigger,
    triggerArg: BigInt(targ),
    condOff: 0,
    condLen: 0,
    action,
    operatorGated: 0,
    epochSecs: DAY,
    budgetPerEpoch: 5_000_000_000n,
    p1: BigInt(p1),
    p2: BigInt(p2),
    maxRunsPerEpoch: 1,
    reserved: new Uint8Array(5),
  };
}

/** A raw graph with conditions laid out back to back (empty ones at offset 0). */
export function graphProg(operator: Uint8Array | null, recipients: [Uint8Array, number][], nodes: [RawGNode, CondNode[]][]): RawGraph {
  const cond: CondNode[] = [];
  const out: RawGNode[] = [];
  for (const [g, c] of nodes) {
    const x = { ...g, reserved: (g.reserved ?? new Uint8Array(5)).slice() };
    x.condLen = c.length;
    x.condOff = c.length === 0 ? 0 : cond.length;
    cond.push(...c);
    out.push(x);
  }
  return {
    flags: operator ? PXG1.FLAG_HAS_OPERATOR : 0,
    operator: operator ? operator.slice() : new Uint8Array(32),
    recipients: recipients.map(([key, b]) => ({ key: key.slice(), bps: b })),
    nodes: out,
    cond,
  };
}
export const genc = (g: RawGraph): Uint8Array => encodeGraphRaw(g);
export const cloneGraph = (g: RawGraph): RawGraph => ({
  flags: g.flags,
  operator: g.operator.slice(),
  recipients: g.recipients.map((r) => ({ key: r.key.slice(), bps: r.bps })),
  nodes: g.nodes.map((n) => ({ ...n, reserved: (n.reserved ?? new Uint8Array(5)).slice() })),
  cond: g.cond.map((c) => ({ ...c })),
});

export { ACTION, TRIGGER };

// ------------------------------------------------- random valid models ---

const LABELS = ["team", "ops", "dev", "router", "mm", "cex", "vault", "fund"];

function randLeaf(rng: Rng, keys: string[], guard: number): Cond {
  switch (rng.below(10)) {
    case 0:
      return { op: "buy" };
    case 1:
      return { op: "p2p" };
    case 2:
      return { op: "timeLt", secs: rng.range(0, guard) };
    case 3:
      return { op: "timeGe", secs: rng.range(0, guard) };
    case 4:
      return { op: "amountGt", amount: rng.coin() ? { bps: rng.range(1, 10_000) } : { raw: BigInt(rng.range(0, 1_000_000)) * 1000n } };
    case 5:
      return { op: "balanceGt", amount: rng.coin() ? { bps: rng.range(1, 10_000) } : { raw: BigInt(rng.range(0, 1_000_000)) * 7n } };
    case 6:
    case 7:
    case 8: {
      const n = rng.range(1, Math.min(3, keys.length));
      const pick = new Set<string>();
      while (pick.size < n) pick.add(rng.pick(keys));
      const op = rng.pick(["toIn", "fromIn", "programIn"] as const);
      return { op, keys: [...pick] };
    }
    default:
      return { op: "ixCountGt", n: rng.range(0, 64) };
  }
}

/** A random condition with at most `budget` nodes and depth <= 16. */
export function randCond(rng: Rng, leaf: () => Cond, budget: number, depth = 0): Cond {
  if (budget <= 1 || depth > 5 || rng.oneIn(3)) return rng.oneIn(12) ? { op: rng.coin() ? "true" : "false" } : leaf();
  const k = rng.below(3);
  if (k === 0) return { op: "not", x: randCond(rng, leaf, budget - 1, depth + 1) };
  const left = Math.max(1, Math.floor((budget - 1) / 2));
  return { op: k === 1 ? "and" : "or", a: randCond(rng, leaf, left, depth + 1), b: randCond(rng, leaf, budget - 1 - left, depth + 1) };
}

/** A random valid rule set model (canonical: keys labelled, amounts raw / bps). */
export function randRuleSet(rng: Rng): RuleSet {
  const guard = rng.pick([60, 600, 3_600, 86_400, GUARD]);
  const nKeys = rng.range(0, 8);
  const keys = Array.from({ length: nKeys }, (_, i) => ({ address: encodeBase58(rng.key()), label: LABELS[i]! }));
  const addrs = keys.map((k) => k.address);
  const nRules = rng.range(1, 6);
  const rules: Rule[] = [];
  for (let i = 0; i < nRules; i++) {
    const from = rng.range(0, guard - 1);
    const to = rng.range(from + 1, guard);
    const effect = rng.pick(["deny", "capAmount", "capBalance"] as const);
    const leafFn = (): Cond => (addrs.length === 0 ? randLeaf(rng, ["x"], guard) : randLeaf(rng, addrs, guard));
    let when = randCond(rng, () => {
      let l = leafFn();
      while ((l.op === "toIn" || l.op === "fromIn" || l.op === "programIn") && addrs.length === 0) l = { op: "buy" };
      return l;
    }, 9);
    if (rng.oneIn(5)) when = { op: "true" };
    const r: Rule = { from, to, effect, when, code: rng.range(0, 63) };
    if (effect !== "deny") r.cap = rng.coin() ? { bps: rng.range(1, 10_000) } : { raw: BigInt(rng.range(1, 1_000_000_000)) };
    rules.push(r);
  }
  // make sure every declared key is used: add a rule using all of them
  if (addrs.length > 0) rules.push({ from: 0, to: guard, effect: "deny", when: { op: "and", a: { op: "buy" }, b: { op: "toIn", keys: addrs } }, code: 4 });
  return { guardSecs: guard, keys, rules };
}

function randGraphLeaf(rng: Rng, ids: string[]): Cond {
  switch (rng.below(8)) {
    case 0:
      return { op: "treasurySolGte", lamports: BigInt(rng.range(0, 10_000)) * 1_000_000n };
    case 1:
      return { op: "treasuryTokensGte", amount: { raw: BigInt(rng.range(0, 1_000_000)) * 1_000_000n } };
    case 2:
      return { op: "graduated" };
    case 3:
      return { op: "priceLte", price: { sqrtPriceQ64: rng.next() >> BigInt(rng.range(0, 40)) } };
    case 4:
      return { op: "priceGte", price: { sqrtPriceQ64: rng.next() >> BigInt(rng.range(0, 40)) } };
    case 5:
      return { op: "nowGe", unix: BigInt(1_700_000_000 + rng.range(0, 400_000_000)) };
    case 6:
      return { op: "nowLt", unix: BigInt(1_700_000_000 + rng.range(0, 400_000_000)) };
    default:
      return { op: "runsInEpochLt", node: rng.pick(ids), n: rng.range(1, 20) };
  }
}

/** A random valid graph model. */
export function randGraph(rng: Rng): Graph {
  const n = rng.range(1, 8);
  const ids = Array.from({ length: n }, (_, i) => `n${i}`);
  const hasOp = rng.coin();
  const nRec = rng.range(0, 4);
  const recipients = Array.from({ length: nRec }, (_, i) => ({ address: encodeBase58(rng.key()), bps: 0, label: `r${i}` }));
  if (nRec > 0) {
    let left = 10_000;
    recipients.forEach((r, i) => {
      r.bps = i === nRec - 1 ? left : rng.range(1, left - (nRec - 1 - i));
      left -= r.bps;
    });
  }
  const nodes: GraphNode[] = ids.map((id, i) => {
    const tk = rng.below(4);
    const trigger: GraphNode["trigger"] =
      tk === 0 ? { kind: "every", secs: rng.range(600, 10 * DAY) } : tk === 1 && i > 0 ? { kind: "after", node: ids[rng.below(i)]! } : tk === 2 ? { kind: "graduated" } : { kind: "when" };
    const when = trigger.kind === "when" || rng.coin() ? randCond(rng, () => randGraphLeaf(rng, ids), 7) : null;
    const ak = rng.below(3);
    const action: GraphNode["action"] =
      ak === 0 || (ak === 2 && nRec === 0)
        ? { kind: "buybackBurn", maxInLamports: BigInt(rng.range(1, 10_000)) * 1_000_000n, maxPremiumBps: rng.range(0, 2_000) }
        : ak === 1
          ? { kind: "burn", maxTokens: BigInt(rng.range(1, 1_000_000)) * 1_000_000n }
          : { kind: "distributeSol", maxLamports: BigInt(rng.range(1, 10_000)) * 1_000_000n };
    return {
      id,
      trigger,
      when,
      action,
      operatorGated: hasOp && (i === 0 || rng.coin()),
      epochSecs: rng.range(3_600, 30 * DAY),
      budgetPerEpoch: BigInt(rng.range(1, 1_000_000)) * 1_000_000n,
      maxRunsPerEpoch: rng.range(1, 100),
    };
  });
  // recipients must be used
  if (nRec > 0 && !nodes.some((x) => x.action.kind === "distributeSol")) {
    nodes[nodes.length - 1]!.action = { kind: "distributeSol", maxLamports: 1_000_000n };
  }
  return { operator: hasOp ? encodeBase58(rng.key()) : null, recipients, nodes };
}

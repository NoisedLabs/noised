/**
 * Differential parity with crates/noised-rules: the TypeScript mirror of
 * the crate's `tests/differential.rs` generator (format DIFF1), line for
 * line. From the same seed both sides build the same programs (plausible
 * ones, then byte and field mutations), run them through every entry point
 * and must produce the same result lines; the crate commits one entry per
 * case to `tests/vectors/differential.json`:
 * `"<len>:<fnv of the bytes> <verify> <parse> <fnv of the full result line>"`.
 *
 * Keep this file in step with differential.rs: every random draw happens in
 * the same order (mind short-circuits and Rust's integer casts), and the
 * generator never looks at a result. A mismatch in `<len>:<fnv>` means the
 * generators drifted; a mismatch in the digest means the SDK and the crate
 * disagree (`NOISED_DIFF_DUMP=rules:<i>` on the crate prints its line).
 */
import {
  type CondNode,
  type RawGraphCtx,
  type RawNodeState,
  type RuleEvalCtx,
  ProgError,
  decodeGraphRaw,
  decodeRulesRaw,
  encodeBase58,
  encodeGraphRaw,
  encodeRulesRaw,
  evaluateRuleSet,
  exceeds,
  graphCondition,
  graphDue,
  graphRunCap,
  graphRunnable,
  graphRunsInEpoch,
  graphShares,
  ruleCondition,
  threshold,
  verifyGraph,
  verifyRules,
} from "../../src/programmable/index.js";
import type { NotDueCode, RawGraph, RawRuleSet } from "../../src/programmable/index.js";

export const FORMAT = "DIFF1";
export const RULES_SEED = 0x5058_5231_0000_0000n;
export const GRAPH_SEED = 0x5058_4731_0000_0000n;
export const SAMPLES = 4;

const M64 = (1n << 64n) - 1n;
const U64_MAX = M64;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
const BPS_FLAG = 1n << 63n;
const MAX_GUARD_SECS = 259_200;

// ------------------------------------------------------- shared tables ---

const U8S = [0, 1, 2, 3, 4, 5, 8, 15, 16, 17, 63, 64, 65, 96, 97, 0x7f, 0x80, 0xff];
const OPS = [
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x20, 0x21,
  0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0xff,
];
const WIDES: bigint[] = [
  0n, 1n, 2n, 3n, 15n, 16n, 17n, 599n, 600n, 2_000n, 2_001n, 3_599n, 3_600n, 10_000n, 10_001n, 259_199n, 259_200n,
  259_201n, 1n << 32n, BPS_FLAG, BPS_FLAG | 1n, BPS_FLAG | 10_000n, BPS_FLAG | 10_001n, BPS_FLAG | 0xffffn,
  BPS_FLAG | 0x1_0001n, I64_MAX, U64_MAX - 1n, U64_MAX,
];
const U32S = [0, 1, 59, 60, 119, 120, 3_600, 259_199, 259_200, 259_201, 0xffff_ffff];
const GUARDS = [0, 1, 2, 59, 60, 3_600, 86_400, 259_199, 259_200, 259_201, 0xffff_ffff];

const OP_TRUE = 0x00;
const OP_FALSE = 0x01;
const OP_AND = 0x02;
const OP_OR = 0x03;
const OP_NOT = 0x04;
const R_IS_BUY = 0x10;
const R_IS_P2P = 0x11;
const R_TIME_LT = 0x12;
const R_TIME_GE = 0x13;
const R_AMOUNT_GT = 0x14;
const R_DEST_BAL_AFTER_GT = 0x15;
const R_DEST_OWNER_IN = 0x16;
const R_TOP_PROGRAM_IN = 0x18;
const R_TX_IX_COUNT_GT = 0x19;
const G_TREASURY_SOL_GTE = 0x20;
const G_TREASURY_TOKEN_GTE = 0x21;
const G_GRADUATED = 0x22;
const G_PRICE_LTE = 0x23;
const G_PRICE_GTE = 0x24;
const G_TIME_GE = 0x25;
const G_TIME_LT = 0x26;
const G_RUNS_IN_EPOCH_LT = 0x27;
const EFFECT_DENY = 1;
const T_EVERY = 1;
const T_AFTER = 2;
const T_ON_GRADUATED = 3;
const T_WHEN = 4;
const A_BUYBACK_BURN = 1;
const A_BURN = 2;
const A_DISTRIBUTE_SOL = 3;

/** SplitMix64, exactly the crate's `tests/common` Rng (u64 in bigint). */
export class Rng {
  private s: bigint;
  constructor(seed: bigint) {
    this.s = seed & M64;
  }
  next(): bigint {
    this.s = (this.s + 0x9e37_79b9_7f4a_7c15n) & M64;
    let z = this.s;
    z = ((z ^ (z >> 30n)) * 0xbf58_476d_1ce4_e5b9n) & M64;
    z = ((z ^ (z >> 27n)) * 0x94d0_49bb_1331_11ebn) & M64;
    return z ^ (z >> 31n);
  }
  /** `below(n)` on u64: next() % n. */
  belowN(n: bigint): bigint {
    return this.next() % n;
  }
  /** `below(n) as usize` for small n. */
  below(n: number): number {
    return Number(this.belowN(BigInt(n)));
  }
  /** `range(lo, hi)`: lo + below(hi - lo + 1). */
  rangeN(lo: bigint, hi: bigint): bigint {
    return lo + this.belowN(hi - lo + 1n);
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
  /** `next() as u8`. */
  byte(): number {
    return Number(this.next() & 0xffn);
  }
  key(): Uint8Array {
    const k = new Uint8Array(32);
    for (let i = 0; i < 32; i++) k[i] = this.byte();
    k[0]! |= 1;
    return k;
  }
  /** The crate's `wide()`: a u64 biased toward edges. */
  wide(): bigint {
    switch (this.below(6)) {
      case 0:
        return this.pick([0n, 1n, 2n, U64_MAX, U64_MAX - 1n, 1n << 63n, (1n << 63n) - 1n]);
      case 1:
        return this.belowN(1_000n);
      case 2:
        return this.belowN(1n << 20n);
      case 3:
        return this.belowN(1n << 40n);
      default:
        return this.next();
    }
  }
}

/** FNV-1a 64. */
export function fnv(bytes: Uint8Array): bigint {
  let h = 0xcbf2_9ce4_8422_2325n;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * 0x0100_0000_01b3n) & M64;
  }
  return h;
}
const fnvHex = (bytes: Uint8Array): string => fnv(bytes).toString(16).padStart(16, "0");
const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);

/** The generator's own little-endian writer (independent of the encoders under test). */
class W {
  readonly out: number[] = [];
  u8(v: number): void {
    this.out.push(v & 0xff);
  }
  u16(v: number): void {
    this.out.push(v & 0xff, (v >>> 8) & 0xff);
  }
  u32(v: number): void {
    for (let i = 0; i < 4; i++) this.out.push(Math.floor(v / 2 ** (8 * i)) & 0xff);
  }
  u64(v: bigint): void {
    for (let i = 0n; i < 8n; i++) this.out.push(Number((v >> (8n * i)) & 0xffn));
  }
  bytes(b: Iterable<number>): void {
    for (const x of b) this.out.push(x);
  }
  node(n: CondNode): void {
    this.u8(n.op);
    this.u8(n.a);
    this.u64(n.arg);
  }
}

const le64 = (v: bigint): number[] => {
  const out: number[] = [];
  for (let i = 0n; i < 8n; i++) out.push(Number((v >> (8n * i)) & 0xffn));
  return out;
};
const le32 = (v: number): number[] => [0, 1, 2, 3].map((i) => Math.floor(v / 2 ** (8 * i)) & 0xff);
const le16 = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff];

/** `b[at] = v` if in range. */
function set(b: number[], at: number, v: number): void {
  if (at < b.length) b[at] = v;
}

/** `b[at..at + v.length] = v` if entirely in range. */
function put(b: number[], at: number, v: readonly number[]): void {
  if (at + v.length <= b.length) for (let i = 0; i < v.length; i++) b[at + i] = v[i]!;
}

const zeros = (n: number): number[] => new Array<number>(n).fill(0);
const node = (op: number, a: number, arg: bigint): CondNode => ({ op, a, arg });

/** A field byte: an interesting value or a small one. */
function smallU8(rng: Rng): number {
  if (rng.coin()) return rng.pick(U8S);
  return rng.below(6);
}

/** A wide field value: an interesting one or a small one. */
function wideField(rng: Rng): bigint {
  if (rng.coin()) return rng.pick(WIDES);
  return rng.belowN(4n);
}

/** One more condition node (TRUE) at the end, counted in the header. */
function appendNode(b: number[]): void {
  if (b.length > 7) b[7] = (b[7]! + 1) & 0xff;
  b.push(...zeros(10));
}

/** Random byte edits: 0 a random byte, 1 an interesting byte, 2 a bit flip, otherwise truncate or append. */
function byteEdit(rng: Rng, b: number[], kind: number): void {
  if (kind <= 2) {
    if (b.length === 0) return;
    const p = rng.below(b.length);
    if (kind === 0) b[p] = rng.byte();
    else if (kind === 1) b[p] = rng.pick(U8S);
    else b[p] = b[p]! ^ (1 << rng.below(8));
    return;
  }
  if (rng.coin() && b.length > 0) {
    const keep = rng.oneIn(4) ? rng.below(Math.min(b.length, 48)) : b.length - 1 - rng.below(Math.min(b.length, 16));
    b.length = keep;
  } else {
    const k = 1 + rng.below(3);
    for (let i = 0; i < k; i++) b.push(rng.byte());
  }
}

/** A random well-formed postfix condition of 1..=maxLen nodes. */
function genCond(rng: Rng, maxLen: number, leaf: (r: Rng) => CondNode): CondNode[] {
  const maxLeaves = Math.min(Math.ceil(maxLen / 2), 24);
  const leaves = 1 + rng.below(maxLeaves);
  const out: CondNode[] = [];
  let depth = 0;
  let left = leaves;
  while (left > 0 || depth > 1) {
    const canPush = left > 0 && depth < 16;
    const canCombine = depth >= 2;
    if (canPush && (!canCombine || rng.below(3) !== 0)) {
      let n: CondNode;
      if (rng.oneIn(8)) n = node(rng.coin() ? OP_TRUE : OP_FALSE, 0, 0n);
      else n = leaf(rng);
      out.push(n);
      left -= 1;
      depth += 1;
    } else {
      const o = rng.coin() ? OP_AND : OP_OR;
      out.push(node(o, 0, 0n));
      depth -= 1;
    }
    const needed = left + Math.max(depth + left - 1, 0);
    if (out.length + 1 + needed <= maxLen && rng.oneIn(5)) out.push(node(OP_NOT, 0, 0n));
  }
  if (out.length === 0 || out.length > maxLen) throw new Error("genCond: bad length");
  return out;
}

// ------------------------------------------------------------- rules ---

export interface RulesCase {
  guard: number;
  bytes: Uint8Array;
  ctxs: RuleEvalCtx[];
  /** [value, arg, supply] */
  thresholds: [bigint, bigint, bigint][];
}

/** [from, to, effect, code, arg, condOff, condLen] of the model's rules. */
type MRule = [number, number, number, number, bigint, number, number];

function bpsArg(rng: Rng): bigint {
  return BPS_FLAG | rng.pick([1n, 2n, 10n, 50n, 100n, 250n, 1_000n, 5_000n, 9_999n, 10_000n]);
}

function rulesLeaf(rng: Rng, nKeys: number, g: number): CondNode {
  for (;;) {
    const kind = rng.below(10);
    switch (kind) {
      case 0:
        return node(R_IS_BUY, 0, 0n);
      case 1:
        return node(R_IS_P2P, 0, 0n);
      case 2:
      case 3:
        return node(kind === 2 ? R_TIME_LT : R_TIME_GE, 0, rng.rangeN(0n, BigInt(g)));
      case 4:
      case 5: {
        const o = kind === 4 ? R_AMOUNT_GT : R_DEST_BAL_AFTER_GT;
        const arg = rng.coin() ? bpsArg(rng) : rng.wide() & ~BPS_FLAG & M64;
        return node(o, 0, arg);
      }
      case 6:
      case 7:
      case 8: {
        if (nKeys === 0) continue;
        const all = (1 << nKeys) - 1;
        const mask = Math.max(rng.byte() & all, 1);
        const o = R_DEST_OWNER_IN + rng.below(3);
        return node(o, mask, 0n);
      }
      default:
        return node(R_TX_IX_COUNT_GT, 0, rng.belowN(20n));
    }
  }
}

const isMaskOp = (o: number): boolean => o >= R_DEST_OWNER_IN && o <= R_TOP_PROGRAM_IN;

/** The generator's own threshold (exact, saturating), for picking amounts near caps. */
function genCap(arg: bigint, supply: bigint): bigint {
  if ((arg & BPS_FLAG) === 0n) return arg;
  const t = (supply * (arg & 0xffffn)) / 10_000n;
  return t > U64_MAX ? U64_MAX : t;
}

const satAdd = (a: bigint, b: bigint): bigint => (a + b > U64_MAX ? U64_MAX : a + b);
const satSub = (a: bigint, b: bigint): bigint => (a < b ? 0n : a - b);

function nearCap(rng: Rng, caps: readonly bigint[]): bigint {
  if (caps.length > 0 && rng.coin()) {
    const t = rng.pick(caps);
    const d = rng.pick([0n, 1n, 2n]);
    return satSub(satAdd(t, d), 1n);
  }
  return rng.wide();
}

function who(rng: Rng, keys: readonly Uint8Array[]): Uint8Array {
  if (keys.length > 0 && rng.below(3) !== 0) return rng.pick(keys);
  return rng.key();
}

function genTctx(rng: Rng, guard: number, keys: readonly Uint8Array[], rs: readonly MRule[], nodes: readonly CondNode[]): RuleEvalCtx {
  const g = BigInt(Math.min(guard, MAX_GUARD_SECS));
  const windows: bigint[] = rs.flatMap((r) => [BigInt(r[0]), BigInt(r[1])]);
  const times: bigint[] = nodes.filter((n) => n.op === R_TIME_LT || n.op === R_TIME_GE).map((n) => BigInt.asIntN(64, n.arg));
  const branch = rng.below(5);
  let nowRel: bigint;
  if (branch === 0 && windows.length > 0) {
    const w = rng.pick(windows);
    const d = rng.pick([-1n, 0n, 1n]);
    nowRel = w + d;
  } else if (branch === 1 && times.length > 0) {
    const t = rng.pick(times);
    const d = rng.pick([-1n, 0n, 1n]);
    nowRel = t + d;
  } else if (branch === 2) {
    nowRel = rng.pick([-1n, 0n, g - 1n, g, I64_MIN, I64_MAX]);
  } else {
    nowRel = rng.belowN(g + 10n) - 5n;
  }
  const isBuy = rng.coin();
  const isP2p = rng.coin();
  let supply: bigint;
  switch (rng.below(4)) {
    case 0:
      supply = rng.pick([0n, 1n, 9_999n, 10_000n, 10_001n, U64_MAX]);
      break;
    case 1:
      supply = 1_000_000_000_000_000_000n;
      break;
    default:
      supply = rng.wide();
  }
  const caps = [
    ...rs.filter((r) => r[2] !== EFFECT_DENY).map((r) => r[4]),
    ...nodes.filter((n) => n.op === R_AMOUNT_GT || n.op === R_DEST_BAL_AFTER_GT).map((n) => n.arg),
  ].map((a) => genCap(a, supply));
  const amount = nearCap(rng, caps);
  const destBalanceAfter = nearCap(rng, caps);
  const destOwner = who(rng, keys);
  const srcOwner = who(rng, keys);
  const topProgram = who(rng, keys);
  const txIxCount = rng.pick([0, 1, 2, 3, 4, 5, 10, 19, 20, 64, 0xffff]);
  return {
    nowRel,
    isBuy,
    isP2p,
    amount,
    destBalanceAfter,
    supply,
    destOwner: encodeBase58(destOwner),
    srcOwner: encodeBase58(srcOwner),
    topProgram: encodeBase58(topProgram),
    txIxCount,
  };
}

function mutateRules(rng: Rng, b: number[], nKeys: number, nRules: number, nNodes: number): void {
  const keyAt = (k: number): number => 12 + 32 * k;
  const ruleAt = (r: number): number => 12 + 32 * nKeys + 20 * r;
  const nodeAt = (n: number): number => 12 + 32 * nKeys + 20 * nRules + 10 * n;
  const kind = rng.below(14);
  switch (kind) {
    case 0:
    case 1:
    case 2:
      return byteEdit(rng, b, kind);
    case 3: {
      const at = rng.pick([0, 4, 5, 6, 7, 8, 9, 10, 11]);
      const v = smallU8(rng);
      return set(b, at, v);
    }
    case 4: {
      const r = rng.below(nRules);
      const off = rng.pick([8, 9, 10, 11]);
      const v = smallU8(rng);
      return set(b, ruleAt(r) + off, v);
    }
    case 5: {
      const r = rng.below(nRules);
      const off = rng.pick([0, 4]);
      const v = rng.pick(U32S);
      return put(b, ruleAt(r) + off, le32(v));
    }
    case 6: {
      const r = rng.below(nRules);
      const v = wideField(rng);
      return put(b, ruleAt(r) + 12, le64(v));
    }
    case 7:
    case 8:
    case 9: {
      if (nNodes === 0) return;
      const n = rng.below(nNodes);
      if (kind === 7) return set(b, nodeAt(n), rng.pick(OPS));
      if (kind === 8) return set(b, nodeAt(n) + 1, rng.pick(U8S));
      return put(b, nodeAt(n) + 2, le64(wideField(rng)));
    }
    case 10: {
      if (nNodes === 0) return;
      const n = rng.below(nNodes);
      const k = 1 + rng.below(24);
      for (let i = n; i < Math.min(n + k, nNodes); i++) put(b, nodeAt(i), zeros(10));
      return;
    }
    case 11: {
      if (nKeys === 0) return;
      const k = rng.below(nKeys);
      if (nKeys >= 2 && rng.coin()) {
        const j = rng.below(nKeys);
        if (keyAt(j) + 32 <= b.length) put(b, keyAt(k), b.slice(keyAt(j), keyAt(j) + 32));
      } else {
        put(b, keyAt(k), zeros(32));
      }
      return;
    }
    case 12:
      return appendNode(b);
    default:
      return byteEdit(rng, b, 3);
  }
}

export function genRulesCase(rng: Rng): RulesCase {
  let guard: number;
  switch (rng.below(8)) {
    case 0:
      guard = rng.pick(GUARDS);
      break;
    case 1:
      guard = MAX_GUARD_SECS;
      break;
    default:
      guard = Number(rng.rangeN(2n, BigInt(MAX_GUARD_SECS)));
  }
  const g = Math.min(guard, MAX_GUARD_SECS);
  let nKeys = rng.below(9);
  let keys: Uint8Array[] = [];
  for (let i = 0; i < nKeys; i++) keys.push(rng.key());
  const nRules = 1 + rng.below(16);
  let budget = rng.oneIn(4) ? 64 : Number(rng.rangeN(BigInt(nRules), 64n));
  const rs: MRule[] = [];
  const nodes: CondNode[] = [];
  for (let i = 0; i < nRules; i++) {
    const rulesAfter = nRules - i - 1;
    const maxLen = Math.min(Math.max(budget - rulesAfter, 1), 24);
    const keysNow = nKeys;
    const cond = genCond(rng, maxLen, (r) => rulesLeaf(r, keysNow, g));
    budget -= cond.length;
    const from = rng.below(Math.max(g, 1));
    const to = Number(rng.rangeN(BigInt(from) + 1n, BigInt(Math.max(g, from + 1))));
    const code = rng.below(64);
    const eff = 1 + rng.below(3);
    let arg: bigint;
    if (eff === EFFECT_DENY) arg = 0n;
    else if (rng.coin()) arg = bpsArg(rng);
    else {
      const w = rng.wide();
      arg = w < 1n ? 1n : w > I64_MAX ? I64_MAX : w;
    }
    rs.push([from, to, eff, code, arg, nodes.length, cond.length]);
    nodes.push(...cond);
  }
  // Every key must be used: widen the first key mask, or drop the keys.
  const all = (1 << nKeys) - 1;
  const used = nodes.filter((n) => isMaskOp(n.op)).reduce((m, n) => m | n.a, 0);
  if (used !== all) {
    const first = nodes.find((n) => isMaskOp(n.op));
    if (first) first.a |= all & ~used & 0xff;
    else {
      nKeys = 0;
      keys = [];
    }
  }
  const w = new W();
  w.bytes(ascii("PXR1"));
  for (const v of [1, nKeys, nRules, nodes.length, 0, 0, 0, 0]) w.u8(v);
  for (const k of keys) w.bytes(k);
  for (const r of rs) {
    w.u32(r[0]);
    w.u32(r[1]);
    w.u8(r[5]);
    w.u8(r[6]);
    w.u8(r[2]);
    w.u8(r[3]);
    w.u64(r[4]);
  }
  for (const n of nodes) w.node(n);
  const bytes = w.out;
  const nMut = rng.pick([0, 0, 0, 0, 1, 1, 1, 2, 2, 3]);
  for (let i = 0; i < nMut; i++) mutateRules(rng, bytes, nKeys, nRules, nodes.length);
  const ctxs: RuleEvalCtx[] = [];
  for (let i = 0; i < SAMPLES; i++) ctxs.push(genTctx(rng, guard, keys, rs, nodes));
  const thresholds: [bigint, bigint, bigint][] = [];
  for (let i = 0; i < 2; i++) {
    let arg: bigint;
    switch (rng.below(3)) {
      case 0:
        arg = rng.pick(WIDES);
        break;
      case 1:
        arg = BPS_FLAG | rng.belowN(0x1_0000n);
        break;
      default:
        arg = rng.next() | BPS_FLAG;
    }
    const supply = rng.wide();
    const value = rng.wide();
    thresholds.push([value, arg, supply]);
  }
  return { guard, bytes: Uint8Array.from(bytes), ctxs, thresholds };
}

const bit = (b: boolean): string => (b ? "1" : "0");
const tri = (x: boolean | null): string => (x === null ? "x" : x ? "1" : "0");

/** The value, or the ProgError's code. */
function attempt<T>(f: () => T): { value: T; name: "ok" } | { value: null; name: string } {
  try {
    return { value: f(), name: "ok" };
  } catch (e) {
    if (e instanceof ProgError) return { value: null, name: e.code };
    throw e;
  }
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** The full result line of a rules case (the crate's `rules_line`). */
export function rulesLine(c: RulesCase): string {
  const v = verifyRules(c.bytes, { guardSecs: c.guard });
  let r = v.ok ? `ok:${v.hashHex}` : v.code;
  const parsed = attempt(() => decodeRulesRaw(c.bytes));
  r += ` ${parsed.name}`;
  const s: RawRuleSet | null = parsed.value;
  if (s !== null) {
    const back = attempt(() => encodeRulesRaw(s)).value;
    r += back !== null && sameBytes(back, c.bytes) ? " rt" : " RT!";
    for (const ctx of c.ctxs) {
      const out = evaluateRuleSet(s, ctx);
      r += ` ${out.ok ? "-" : `${out.index}.${out.code}`}/`;
      for (let i = 0; i <= s.rules.length; i++) r += tri(ruleCondition(s, i, ctx));
    }
  }
  for (const [value, arg, supply] of c.thresholds) {
    const t = threshold(arg, supply);
    r += ` t${t}:${bit(exceeds(value, arg, supply))}${bit(exceeds(t, arg, supply))}${bit(exceeds(satAdd(t, 1n), arg, supply))}`;
  }
  return r;
}

// ------------------------------------------------------------- graph ---

export interface GraphCase {
  bytes: Uint8Array;
  samples: [RawNodeState[], RawGraphCtx][];
  amounts: bigint[];
}

function graphLeaf(rng: Rng, nNodes: number): CondNode {
  switch (rng.below(8)) {
    case 0:
      return node(G_TREASURY_SOL_GTE, 0, rng.wide());
    case 1:
      return node(G_TREASURY_TOKEN_GTE, 0, rng.wide());
    case 2:
      return node(G_GRADUATED, 0, 0n);
    case 3:
      return node(G_PRICE_LTE, 0, rng.wide());
    case 4:
      return node(G_PRICE_GTE, 0, rng.wide());
    case 5:
      return node(G_TIME_GE, 0, rng.wide() & (M64 >> 1n));
    case 6:
      return node(G_TIME_LT, 0, rng.wide() & (M64 >> 1n));
    default: {
      const a = rng.below(nNodes);
      const arg = rng.belowN(10n);
      return node(G_RUNS_IN_EPOCH_LT, a, arg);
    }
  }
}

/** A graph node of the model, before encoding. */
interface MNode {
  trigger: number;
  triggerArg: bigint;
  action: number;
  gated: number;
  epochSecs: number;
  budget: bigint;
  p1: bigint;
  p2: bigint;
  maxRuns: number;
  cond: CondNode[];
}

function near(rng: Rng, args: readonly bigint[]): bigint {
  if (args.length > 0 && rng.coin()) {
    const a = rng.pick(args);
    const d = rng.pick([0n, 1n, 2n]);
    return satSub(satAdd(a, d), 1n);
  }
  return rng.wide();
}

function genState(rng: Rng): RawNodeState {
  const lastRun = rng.pick([0n, 1_700_000_000n, 1_799_999_400n, 1_800_000_000n, -5n, I64_MIN, I64_MAX]);
  const lastSeq = rng.belowN(5n);
  const epochStart = rng.pick([0n, 1_799_913_600n, 1_799_996_400n, 1_800_000_000n, I64_MIN, I64_MAX]);
  const runsInEpoch = rng.pick([0, 1, 2, 3, 0xffff]);
  const spentInEpoch = rng.wide();
  return { lastRun, lastSeq, epochStart, runsInEpoch, spentInEpoch };
}

function genGctx(rng: Rng, args: readonly bigint[]): RawGraphCtx {
  let now: bigint;
  switch (rng.below(4)) {
    case 0:
      now = rng.pick([0n, 600n, 1_799_996_400n, 1_800_000_000n, 1_800_003_599n, 1_800_003_600n, 1_800_086_400n, -1n, I64_MIN, I64_MAX]);
      break;
    case 1:
      now = BigInt.asIntN(64, near(rng, args));
      break;
    default:
      now = 1_800_000_000n + rng.belowN(200_000n) - 100_000n;
  }
  const treasurySol = near(rng, args);
  const treasuryToken = near(rng, args);
  const graduated = rng.coin();
  const sqrtPrice = rng.oneIn(6) ? rng.pick([(1n << 128n) - 1n, 1n << 64n, (1n << 64n) + 1n, 0n]) : near(rng, args);
  const runsInEpoch: number[] = [];
  for (let i = 0; i < 16; i++) runsInEpoch.push(rng.pick([0, 1, 2, 3, 9, 10, 0xffff]));
  return { now, treasurySol, treasuryToken, graduated, sqrtPrice, runsInEpoch };
}

function mutateGraph(rng: Rng, b: number[], nRec: number, n: number, nCond: number): void {
  const recAt = (r: number): number => 44 + 34 * r;
  const nodeAt = (i: number): number => 44 + 34 * nRec + 48 * i;
  const condAt = (c: number): number => 44 + 34 * nRec + 48 * n + 10 * c;
  const kind = rng.below(18);
  switch (kind) {
    case 0:
    case 1:
    case 2:
      return byteEdit(rng, b, kind);
    case 3: {
      const at = rng.pick([0, 4, 5, 6, 7, 8, 9, 10, 11]);
      const v = smallU8(rng);
      return set(b, at, v);
    }
    case 4:
      switch (rng.below(4)) {
        case 0:
          return put(b, 12, zeros(32));
        case 1:
          return put(b, 12, [...rng.key()]);
        case 2:
          // An operator (flag and key) whatever the nodes say.
          put(b, 12, [...rng.key()]);
          if (b.length > 8) b[8] = b[8]! | 1;
          return;
        default:
          // No operator (flag and key) whatever the nodes say.
          put(b, 12, zeros(32));
          if (b.length > 8) b[8] = b[8]! & ~1 & 0xff;
          return;
      }
    case 5: {
      if (nRec === 0) return;
      const r = rng.below(nRec);
      switch (rng.below(3)) {
        case 0: {
          const v = rng.pick([0, 1, 2, 5_000, 9_999, 10_000, 10_001, 0xffff]);
          return put(b, recAt(r) + 32, le16(v));
        }
        case 1:
          return put(b, recAt(r), zeros(32));
        default: {
          const j = rng.below(nRec);
          if (recAt(j) + 32 <= b.length) put(b, recAt(r), b.slice(recAt(j), recAt(j) + 32));
          return;
        }
      }
    }
    case 6: {
      const i = rng.below(n);
      const off = rng.pick([0, 9, 10, 11, 12, 43, 47]);
      const v = smallU8(rng);
      return set(b, nodeAt(i) + off, v);
    }
    case 7: {
      const i = rng.below(n);
      return put(b, nodeAt(i) + 1, le64(wideField(rng)));
    }
    case 8: {
      const i = rng.below(n);
      const v = rng.pick([0, 1, 3_599, 3_600, 3_601, 86_400, 0xffff_ffff]);
      return put(b, nodeAt(i) + 13, le32(v));
    }
    case 9: {
      const i = rng.below(n);
      const off = rng.pick([17, 25, 33]);
      return put(b, nodeAt(i) + off, le64(wideField(rng)));
    }
    case 10: {
      const i = rng.below(n);
      const v = rng.pick([0, 1, 2, 0xffff]);
      return put(b, nodeAt(i) + 41, le16(v));
    }
    case 11:
    case 12: {
      if (nCond === 0) return;
      const c = rng.below(nCond);
      if (kind === 11) return set(b, condAt(c), rng.pick(OPS));
      if (rng.coin()) return set(b, condAt(c) + 1, rng.pick(U8S));
      return put(b, condAt(c) + 2, le64(wideField(rng)));
    }
    case 13: {
      if (nCond === 0) return;
      const c = rng.below(nCond);
      const k = 1 + rng.below(24);
      for (let i = c; i < Math.min(c + k, nCond); i++) put(b, condAt(i), zeros(10));
      return;
    }
    case 14:
      return appendNode(b);
    case 15: {
      // Another action, without a premium.
      const i = rng.below(n);
      const v = rng.below(6);
      set(b, nodeAt(i) + 11, v);
      return put(b, nodeAt(i) + 33, zeros(8));
    }
    case 16: {
      // Another trigger, with a small argument.
      const i = rng.below(n);
      const t = rng.below(6);
      const a = rng.belowN(4n);
      set(b, nodeAt(i), t);
      return put(b, nodeAt(i) + 1, le64(a));
    }
    default:
      return byteEdit(rng, b, 3);
  }
}

export function genGraphCase(rng: Rng): GraphCase {
  const n = 1 + rng.below(16);
  const nRec = rng.coin() ? 0 : 1 + rng.below(8);
  const recipients: [Uint8Array, number][] = [];
  let left = 10_000;
  for (let i = 0; i < nRec; i++) {
    let bps: number;
    if (i + 1 === nRec) bps = left;
    else {
      const max = left - (nRec - i - 1);
      bps = 1 + Math.min(rng.below(Math.floor(max / 2) + 1), max - 1);
    }
    left -= bps;
    const key = rng.key();
    recipients.push([key, bps]);
  }
  const operator = rng.coin() ? rng.key() : null;
  // AFTER parents come earlier in a random order, so no cycles.
  const order = [...Array(n).keys()];
  for (let i = n - 1; i >= 1; i--) {
    const j = rng.below(i + 1);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  let budget = rng.oneIn(4) ? 96 : rng.below(97);
  const nodes: MNode[] = [];
  for (let i = 0; i < n; i++) {
    const pos = order.indexOf(i);
    let trig = 1 + rng.below(4);
    if (trig === T_AFTER && pos === 0) trig = T_EVERY;
    if (trig === T_WHEN && budget === 0) trig = T_ON_GRADUATED;
    let triggerArg = 0n;
    if (trig === T_EVERY) triggerArg = rng.pick([600n, 601n, 3_600n, 86_400n, 604_800n, U64_MAX]);
    else if (trig === T_AFTER) triggerArg = BigInt(order[rng.below(pos)]!);
    const k = rng.below(3);
    const act = k === 0 && nRec > 0 ? A_DISTRIBUTE_SOL : k === 1 ? A_BURN : A_BUYBACK_BURN;
    const w1 = rng.wide();
    const p1 = w1 < 1n ? 1n : w1;
    const p2 = act === A_BUYBACK_BURN ? rng.belowN(2_001n) : 0n;
    const epochSecs = rng.pick([3_600, 3_601, 86_400, 604_800, 0xffff_ffff]);
    const wb = rng.wide();
    const budgetPerEpoch = wb < 1n ? 1n : wb;
    const maxRuns = rng.pick([1, 2, 3, 24, 0xffff]);
    const gated = operator !== null && rng.coin() ? 1 : 0;
    let cond: CondNode[] = [];
    if (budget > 0 && (trig === T_WHEN || rng.coin())) {
      cond = genCond(rng, Math.min(budget, 24), (r) => graphLeaf(r, n));
      budget -= cond.length;
    }
    nodes.push({ trigger: trig, triggerArg, action: act, gated, epochSecs, budget: budgetPerEpoch, p1, p2, maxRuns, cond });
  }
  if (nRec > 0 && !nodes.some((x) => x.action === A_DISTRIBUTE_SOL)) {
    nodes[0]!.action = A_DISTRIBUTE_SOL;
    nodes[0]!.p2 = 0n;
  }
  if (operator !== null && !nodes.some((x) => x.gated === 1)) nodes[0]!.gated = 1;
  const nCond = nodes.reduce((s, x) => s + x.cond.length, 0);
  const w = new W();
  w.bytes(ascii("PXG1"));
  const flags = operator !== null ? 1 : 0;
  for (const v of [1, nRec, n, nCond, flags, 0, 0, 0]) w.u8(v);
  w.bytes(operator ?? new Uint8Array(32));
  for (const [k, bps] of recipients) {
    w.bytes(k);
    w.u16(bps);
  }
  let off = 0;
  for (const x of nodes) {
    w.u8(x.trigger);
    w.u64(x.triggerArg);
    w.u8(x.cond.length === 0 ? 0 : off);
    w.u8(x.cond.length);
    w.u8(x.action);
    w.u8(x.gated);
    w.u32(x.epochSecs);
    w.u64(x.budget);
    w.u64(x.p1);
    w.u64(x.p2);
    w.u16(x.maxRuns);
    w.bytes(zeros(5));
    off += x.cond.length;
  }
  const args: bigint[] = [];
  for (const x of nodes) {
    for (const c of x.cond) {
      w.node(c);
      args.push(c.arg);
    }
  }
  const bytes = w.out;
  const nMut = rng.pick([0, 0, 0, 0, 1, 1, 1, 2, 2, 3]);
  for (let i = 0; i < nMut; i++) mutateGraph(rng, bytes, nRec, n, nCond);
  const samples: [RawNodeState[], RawGraphCtx][] = [];
  for (let s = 0; s < SAMPLES; s++) {
    const nStates = rng.oneIn(6) ? rng.below(n + 2) : n;
    const states: RawNodeState[] = [];
    for (let i = 0; i < nStates; i++) states.push(genState(rng));
    const ctx = genGctx(rng, args);
    samples.push([states, ctx]);
  }
  const last = rng.wide();
  const amounts = [0n, 1n, 9_999n, 10_000n, 123_456_789n, U64_MAX, last];
  return { bytes: Uint8Array.from(bytes), samples, amounts };
}

const NOT_DUE_CHAR: Record<NotDueCode, string> = {
  NoSuchNode: "N",
  Waiting: "W",
  AwaitingParent: "P",
  NotGraduated: "G",
  AlreadyRan: "A",
  MaxRunsReached: "M",
  BudgetSpent: "B",
  ConditionFalse: "C",
  Malformed: "X",
};
const dueChar = (r: NotDueCode | null): string => (r === null ? "D" : NOT_DUE_CHAR[r]);
const DEFAULT_STATE: RawNodeState = { lastRun: 0n, lastSeq: 0n, epochStart: 0n, runsInEpoch: 0, spentInEpoch: 0n };

/** The full result line of a graph case (the crate's `graph_line`). */
export function graphLine(c: GraphCase): string {
  const v = verifyGraph(c.bytes);
  let r = v.ok ? `ok:${v.hashHex}` : v.code;
  const parsed = attempt(() => decodeGraphRaw(c.bytes));
  r += ` ${parsed.name}`;
  const g: RawGraph | null = parsed.value;
  if (g === null) return r;
  const back = attempt(() => encodeGraphRaw(g)).value;
  r += back !== null && sameBytes(back, c.bytes) ? " rt" : " RT!";
  const n = g.nodes.length;
  for (const [states, ctx] of c.samples) {
    r += " ";
    for (let i = 0; i <= n; i++) r += dueChar(graphDue(g, i, states, ctx.now, ctx.graduated));
    r += "/";
    for (let i = 0; i <= n; i++) r += dueChar(graphRunnable(g, i, states, ctx));
    r += "/";
    for (let i = 0; i <= n; i++) r += tri(graphCondition(g, i, ctx));
    const caps: bigint[] = [];
    for (let i = 0; i <= n; i++) caps.push(graphRunCap(g, i, states[i] ?? DEFAULT_STATE, ctx.now));
    r += `/${caps.join(",")}/${graphRunsInEpoch(g, states, ctx.now).join(",")}`;
  }
  for (const a of c.amounts) r += ` s${graphShares(g, a).join(",")}`;
  return r;
}

// ------------------------------------------------------------ driver ---

function verdicts(line: string): [string, string] {
  const [v, p] = line.split(" ");
  return [v!.startsWith("ok:") ? "ok" : v!, p!];
}

/** `"<len>:<fnv> <verify> <parse> <digest>"`, the crate's `entry`. */
export function entry(bytes: Uint8Array, line: string): string {
  const [v, p] = verdicts(line);
  return `${bytes.length}:${fnvHex(bytes)} ${v} ${p} ${fnvHex(ascii(line))}`;
}

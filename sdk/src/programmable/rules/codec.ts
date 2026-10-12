/**
 * PXR1 launch rule sets (spec §1.2): raw codec and verifier, byte-exact with
 * crates/noised-rules.
 *
 *   magic "PXR1" | version u8 = 1 | n_keys u8 (<= 8) | n_rules u8 (1..=16)
 *   | n_nodes u8 (<= 64) | reserved [0; 4] | keys [[u8; 32]; n_keys]
 *   | rules [Rule; n_rules] | nodes [Node; n_nodes]          (exact length)
 *
 *   Rule (20 B): from_rel u32 | to_rel u32 | cond_off u8 | cond_len u8
 *                | effect u8 | code u8 | arg u64
 */
import { BPS_FLAG, EFFECT, PXR1, VM } from "../constants.js";
import { ByteReader, ByteWriter, bytesEqual, isZero, toHex } from "../bytes.js";
import { ProgError, type VerifyErrorCode } from "../errors.js";
import { rulesHash } from "../hash.js";
import { type CondNode, isValidBpsArg, verifyCondition } from "../cond/vm.js";

export interface RawRule {
  fromRel: number;
  toRel: number;
  condOff: number;
  condLen: number;
  effect: number;
  code: number;
  arg: bigint;
}

export interface RawRuleSet {
  keys: Uint8Array[];
  rules: RawRule[];
  nodes: CondNode[];
}

/**
 * Serializes without semantic checks (tests use it to build bad inputs). Every
 * field must still fit its width (ProgError("BadModel") otherwise): nothing is
 * ever truncated.
 */
export function encodeRulesRaw(r: RawRuleSet): Uint8Array {
  const w = new ByteWriter();
  w.bytes(new TextEncoder().encode(PXR1.MAGIC)).u8(PXR1.VERSION).u8(r.keys.length).u8(r.rules.length).u8(r.nodes.length).zeros(4);
  for (const k of r.keys) w.bytes(k, PXR1.KEY_SIZE);
  for (const x of r.rules) w.u32(x.fromRel).u32(x.toRel).u8(x.condOff).u8(x.condLen).u8(x.effect).u8(x.code).u64(x.arg);
  for (const n of r.nodes) w.u8(n.op).u8(n.a).u64(n.arg);
  return w.finish();
}

const fail = (code: VerifyErrorCode, msg: string, at = {}): never => {
  throw new ProgError(code, msg, at);
};

/**
 * Parses the header and exact length only (the crate's RuleSet::parse), in
 * this order: TooShort, BadMagic, BadVersion, ReservedNonZero, TooManyKeys,
 * NoRules, TooManyRules, TooManyNodes, BadLength.
 */
export function decodeRulesRaw(bytes: Uint8Array): RawRuleSet {
  if (bytes.length < PXR1.HEADER_SIZE) fail("TooShort", `rule set is ${bytes.length} bytes, shorter than its header`);
  if (!bytesEqual(bytes.subarray(0, 4), new TextEncoder().encode(PXR1.MAGIC))) fail("BadMagic", "not a PXR1 rule set");
  if (bytes[4] !== PXR1.VERSION) fail("BadVersion", `unsupported rule set version ${bytes[4]}`);
  if (!isZero(bytes.subarray(8, 12))) fail("ReservedNonZero", "reserved header bytes must be zero");
  const nKeys = bytes[5]!;
  const nRules = bytes[6]!;
  const nNodes = bytes[7]!;
  if (nKeys > PXR1.MAX_KEYS) fail("TooManyKeys", `${nKeys} keys; at most ${PXR1.MAX_KEYS}`);
  if (nRules === 0) fail("NoRules", "a rule set needs at least one rule");
  if (nRules > PXR1.MAX_RULES) fail("TooManyRules", `${nRules} rules; at most ${PXR1.MAX_RULES}`);
  if (nNodes > PXR1.MAX_NODES) fail("TooManyNodes", `${nNodes} condition nodes; at most ${PXR1.MAX_NODES}`);
  const want = PXR1.HEADER_SIZE + nKeys * PXR1.KEY_SIZE + nRules * PXR1.RULE_SIZE + nNodes * VM.NODE_SIZE;
  if (bytes.length !== want) fail("BadLength", `rule set is ${bytes.length} bytes; its header says ${want}`);
  const r = new ByteReader(bytes, PXR1.HEADER_SIZE);
  const keys: Uint8Array[] = [];
  for (let i = 0; i < nKeys; i++) keys.push(r.bytes(32));
  const rules: RawRule[] = [];
  for (let i = 0; i < nRules; i++) {
    rules.push({ fromRel: r.u32(), toRel: r.u32(), condOff: r.u8(), condLen: r.u8(), effect: r.u8(), code: r.u8(), arg: r.u64() });
  }
  const nodes: CondNode[] = [];
  for (let i = 0; i < nNodes; i++) nodes.push({ op: r.u8(), a: r.u8(), arg: r.u64() });
  return { keys, rules, nodes };
}

export interface RulesVerifyOptions {
  /**
   * The launch's guard length in whole seconds (launch params), a u32 like the
   * crate's `guard_secs`; capped at 72 h; default 72 h. Anything else (negative,
   * fractional, NaN, > u32::MAX) throws ProgError("BadModel"): it is a wrong
   * argument, not a verdict about the bytes.
   */
  guardSecs?: number;
}

/** The effective guard: min(guardSecs, 72 h) for a u32 guardSecs (the crate's argument type). */
function effectiveGuard(opts: RulesVerifyOptions): number {
  const g = opts.guardSecs ?? PXR1.MAX_GUARD_SECS;
  if (typeof g !== "number" || !Number.isInteger(g) || g < 0 || g > 0xffff_ffff) {
    throw new ProgError("BadModel", `guardSecs is the launch guard in whole seconds, 0..=4294967295 (got ${String(g)})`);
  }
  return Math.min(g, PXR1.MAX_GUARD_SECS);
}

/**
 * Full verification (the crate's RuleSet::verify, what publish_rules and the
 * hook's policy init run). Order, first failure wins:
 * 1. decodeRulesRaw; 2. each key: ZeroKey, DuplicateKey;
 * 3. each rule in order: BadWindow, WindowPastGuard, BadCode, UnknownEffect /
 *    DenyArgNonZero / ZeroCap / BadBps, EmptyCondition, ConditionNotContiguous,
 *    ConditionOutOfRange, then the condition's nodes (cond/vm.ts);
 * 4. UnreferencedNode; 5. UnusedKey.
 */
export function verifyRulesBytes(bytes: Uint8Array, opts: RulesVerifyOptions = {}): RawRuleSet {
  const guard = effectiveGuard(opts);
  const set = decodeRulesRaw(bytes);
  set.keys.forEach((k, i) => {
    if (isZero(k)) fail("ZeroKey", `key ${i} is the all-zero key`, { key: i });
    for (let j = 0; j < i; j++) if (bytesEqual(set.keys[j]!, k)) fail("DuplicateKey", `key ${i} repeats key ${j}`, { key: i });
  });
  const used = { mask: 0 };
  const ctx = { kind: "rules" as const, nKeys: set.keys.length, guardSecs: guard, usedKeys: used };
  let next = 0;
  set.rules.forEach((x, i) => {
    const at = { rule: i };
    if (x.fromRel >= x.toRel) fail("BadWindow", `rule ${i}: its window ${x.fromRel}..${x.toRel}s is empty`, at);
    if (x.toRel > guard) fail("WindowPastGuard", `rule ${i}: its window ends after the launch guard (${guard}s)`, at);
    if (x.code > PXR1.MAX_CODE) fail("BadCode", `rule ${i}: code ${x.code} must be < 64`, at);
    switch (x.effect) {
      case EFFECT.DENY:
        if (x.arg !== 0n) fail("DenyArgNonZero", `rule ${i}: deny takes no cap`, at);
        break;
      case EFFECT.CAP_AMOUNT:
      case EFFECT.CAP_DEST_BALANCE:
        if ((x.arg & BPS_FLAG) !== 0n) {
          if (!isValidBpsArg(x.arg)) fail("BadBps", `rule ${i}: a share of supply must be 1..=10000 bps`, at);
        } else if (x.arg === 0n) fail("ZeroCap", `rule ${i}: a cap must be more than zero`, at);
        break;
      default:
        fail("UnknownEffect", `rule ${i}: unknown effect ${x.effect}`, at);
    }
    if (x.condLen === 0) fail("EmptyCondition", `rule ${i}: empty condition`, at);
    if (x.condOff !== next) fail("ConditionNotContiguous", `rule ${i}: its condition must start at node ${next}`, at);
    const end = next + x.condLen;
    if (end > set.nodes.length) fail("ConditionOutOfRange", `rule ${i}: its condition runs past the last node`, at);
    try {
      verifyCondition(set.nodes.slice(next, end), ctx, next);
    } catch (e) {
      if (e instanceof ProgError) throw new ProgError(e.code, `rule ${i}: ${e.message}`, { ...e.at, rule: i });
      throw e;
    }
    next = end;
  });
  if (next !== set.nodes.length) fail("UnreferencedNode", `condition nodes ${next}.. are not part of any rule`, { condNode: next });
  const all = (1 << set.keys.length) - 1;
  if (used.mask !== all) {
    const k = [...Array(set.keys.length).keys()].find((i) => !(used.mask & (1 << i)))!;
    fail("UnusedKey", `key ${k} is not used by any rule`, { key: k });
  }
  return set;
}

export type VerifyResult =
  | { ok: true; size: number; hash: Uint8Array; hashHex: string }
  | { ok: false; code: VerifyErrorCode; message: string; at: ProgError["at"] };

/**
 * Verification with the content hash; never throws for bad bytes (only for
 * a guardSecs that is not a u32, see RulesVerifyOptions).
 */
export function verifyRules(bytes: Uint8Array, opts: RulesVerifyOptions = {}): VerifyResult {
  effectiveGuard(opts);
  try {
    verifyRulesBytes(bytes, opts);
    const hash = rulesHash(bytes);
    return { ok: true, size: bytes.length, hash, hashHex: toHex(hash) };
  } catch (e) {
    if (e instanceof ProgError) return { ok: false, code: e.code as VerifyErrorCode, message: e.message, at: e.at };
    throw e;
  }
}

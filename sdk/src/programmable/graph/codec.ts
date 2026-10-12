/**
 * PXG1 autopilot graphs (spec §1.3): raw codec and verifier, mirroring
 * crates/noised-rules src/graph.rs check for check.
 *
 *   magic "PXG1" | version u8 = 1 | n_recipients u8 (<= 8) | n_nodes_g u8 (1..=16)
 *   | n_cond u8 (<= 96) | flags u8 (bit0 has_operator) | reserved [0; 3]
 *   | operator [u8; 32] | recipients [(Pubkey, bps u16)] | gnodes [GNode] | cond [Node]
 *
 *   GNode (48 B): trigger u8 | trigger_arg u64 | cond_off u8 | cond_len u8 | action u8
 *   | operator_gated u8 | epoch_secs u32 | budget_per_epoch u64 | p1 u64 | p2 u64
 *   | max_runs_per_epoch u16 | reserved [0; 5]
 */
import { ACTION, BPS_DENOMINATOR, PXG1, TRIGGER, VM } from "../constants.js";
import { ByteReader, ByteWriter, bytesEqual, isZero, toHex } from "../bytes.js";
import { ProgError, type VerifyErrorCode } from "../errors.js";
import { graphHash } from "../hash.js";
import { type CondNode, verifyCondition } from "../cond/vm.js";

export interface RawRecipient {
  key: Uint8Array;
  bps: number;
}

export interface RawGNode {
  trigger: number;
  triggerArg: bigint;
  condOff: number;
  condLen: number;
  action: number;
  operatorGated: number;
  epochSecs: number;
  budgetPerEpoch: bigint;
  p1: bigint;
  p2: bigint;
  maxRunsPerEpoch: number;
  /** 5 reserved bytes (zero); kept so tests can build bad inputs. */
  reserved?: Uint8Array;
}

export interface RawGraph {
  flags: number;
  operator: Uint8Array;
  recipients: RawRecipient[];
  nodes: RawGNode[];
  cond: CondNode[];
  /** 3 reserved header bytes (zero). */
  reserved?: Uint8Array;
}

/**
 * Serializes without semantic checks (tests use it to build bad inputs). Every
 * field must still fit its width (ProgError("BadModel") otherwise): nothing is
 * ever truncated.
 */
export function encodeGraphRaw(g: RawGraph): Uint8Array {
  const w = new ByteWriter();
  w.bytes(new TextEncoder().encode(PXG1.MAGIC)).u8(PXG1.VERSION).u8(g.recipients.length).u8(g.nodes.length).u8(g.cond.length).u8(g.flags);
  w.bytes(g.reserved ?? new Uint8Array(3), 3);
  w.bytes(g.operator, PXG1.OPERATOR_SIZE);
  for (const r of g.recipients) w.bytes(r.key, 32).u16(r.bps);
  for (const n of g.nodes) {
    w.u8(n.trigger).u64(n.triggerArg).u8(n.condOff).u8(n.condLen).u8(n.action).u8(n.operatorGated);
    w.u32(n.epochSecs).u64(n.budgetPerEpoch).u64(n.p1).u64(n.p2).u16(n.maxRunsPerEpoch);
    w.bytes(n.reserved ?? new Uint8Array(5), 5);
  }
  for (const c of g.cond) w.u8(c.op).u8(c.a).u64(c.arg);
  return w.finish();
}

const fail = (code: VerifyErrorCode, msg: string, at = {}): never => {
  throw new ProgError(code, msg, at);
};

const FIXED = PXG1.HEADER_SIZE + PXG1.OPERATOR_SIZE;

/**
 * Parses the header and exact length only (the crate's Graph::parse), in
 * this order: TooShort, BadMagic, BadVersion, UnknownFlags, ReservedNonZero,
 * TooManyRecipients, NoGraphNodes, TooManyGraphNodes, TooManyNodes, BadLength.
 */
export function decodeGraphRaw(bytes: Uint8Array): RawGraph {
  if (bytes.length < FIXED) fail("TooShort", `graph is ${bytes.length} bytes, shorter than its header`);
  if (!bytesEqual(bytes.subarray(0, 4), new TextEncoder().encode(PXG1.MAGIC))) fail("BadMagic", "not a PXG1 graph");
  if (bytes[4] !== PXG1.VERSION) fail("BadVersion", `unsupported graph version ${bytes[4]}`);
  const nRec = bytes[5]!;
  const nNodes = bytes[6]!;
  const nCond = bytes[7]!;
  const flags = bytes[8]!;
  if ((flags & ~PXG1.FLAG_HAS_OPERATOR) !== 0) fail("UnknownFlags", `unknown flag bits 0x${flags.toString(16)}`);
  if (!isZero(bytes.subarray(9, 12))) fail("ReservedNonZero", "reserved header bytes must be zero");
  if (nRec > PXG1.MAX_RECIPIENTS) fail("TooManyRecipients", `${nRec} recipients; at most ${PXG1.MAX_RECIPIENTS}`);
  if (nNodes === 0) fail("NoGraphNodes", "a graph needs at least one node");
  if (nNodes > PXG1.MAX_NODES) fail("TooManyGraphNodes", `${nNodes} nodes; at most ${PXG1.MAX_NODES}`);
  if (nCond > PXG1.MAX_COND_NODES) fail("TooManyNodes", `${nCond} condition nodes; at most ${PXG1.MAX_COND_NODES}`);
  const want = FIXED + nRec * PXG1.RECIPIENT_SIZE + nNodes * PXG1.GNODE_SIZE + nCond * VM.NODE_SIZE;
  if (bytes.length !== want) fail("BadLength", `graph is ${bytes.length} bytes; its header says ${want}`);
  const r = new ByteReader(bytes, PXG1.HEADER_SIZE);
  const operator = r.bytes(32);
  const recipients: RawRecipient[] = [];
  for (let i = 0; i < nRec; i++) recipients.push({ key: r.bytes(32), bps: r.u16() });
  const nodes: RawGNode[] = [];
  for (let i = 0; i < nNodes; i++) {
    nodes.push({
      trigger: r.u8(),
      triggerArg: r.u64(),
      condOff: r.u8(),
      condLen: r.u8(),
      action: r.u8(),
      operatorGated: r.u8(),
      epochSecs: r.u32(),
      budgetPerEpoch: r.u64(),
      p1: r.u64(),
      p2: r.u64(),
      maxRunsPerEpoch: r.u16(),
      reserved: r.bytes(5),
    });
  }
  const cond: CondNode[] = [];
  for (let i = 0; i < nCond; i++) cond.push({ op: r.u8(), a: r.u8(), arg: r.u64() });
  return { flags, operator, recipients, nodes, cond };
}

/** The crate's after_acyclic: AFTER parents in range and without cycles. */
export function afterAcyclic(n: number, parent: (i: number) => number | null): boolean {
  for (let start = 0; start < n; start++) {
    let node = start;
    let steps = 0;
    for (let p = parent(node); p !== null; p = parent(node)) {
      if (p >= n || steps >= n) return false;
      steps++;
      node = p;
    }
  }
  return true;
}

/**
 * Full verification (the crate's Graph::verify, what publish_graph runs).
 * Order, first failure wins:
 * 1. decodeGraphRaw; 2. MissingOperator / UnexpectedOperator;
 * 3. each recipient: ZeroRecipient, DuplicateRecipient, ZeroRecipientBps; then BadRecipientBps;
 * 4. each node: ReservedNonZero; trigger (UnknownTrigger, EveryTooShort, BadAfterRef,
 *    AfterCycle for itself, TriggerArgNonZero, WhenWithoutCondition); UnknownAction /
 *    ReservedAction; ZeroP1; PremiumTooHigh / P2NonZero; NoRecipients; GatedWithoutOperator /
 *    BadOperatorGated; EpochTooShort; ZeroBudget; ZeroMaxRuns; condition
 *    (ConditionNotContiguous, ConditionOutOfRange, then its nodes);
 * 5. UnreferencedNode, AfterCycle, OperatorUnused, RecipientsUnused.
 */
export function verifyGraphBytes(bytes: Uint8Array): RawGraph {
  const g = decodeGraphRaw(bytes);
  const hasOp = (g.flags & PXG1.FLAG_HAS_OPERATOR) !== 0;
  const zeroOp = isZero(g.operator);
  if (hasOp && zeroOp) fail("MissingOperator", "the operator flag is set but the operator key is empty");
  if (!hasOp && !zeroOp) fail("UnexpectedOperator", "an operator key is given but the operator flag is not set");
  let sum = 0;
  g.recipients.forEach((r, i) => {
    if (isZero(r.key)) fail("ZeroRecipient", `recipient ${i} is the all-zero key`, { key: i });
    for (let j = 0; j < i; j++) {
      if (bytesEqual(g.recipients[j]!.key, r.key)) fail("DuplicateRecipient", `recipient ${i} repeats recipient ${j}`, { key: i });
    }
    if (r.bps === 0) fail("ZeroRecipientBps", `recipient ${i} has a zero share`, { key: i });
    sum += r.bps;
  });
  if (g.recipients.length > 0 && sum !== BPS_DENOMINATOR) fail("BadRecipientBps", `recipient shares add up to ${sum} bps, not 10000`);
  const n = g.nodes.length;
  const ctx = { kind: "graph" as const, nGraphNodes: n };
  let next = 0;
  let anyGated = false;
  let anyDistribute = false;
  g.nodes.forEach((x, i) => {
    const at = { node: i };
    if (x.reserved && !isZero(x.reserved)) fail("ReservedNonZero", `node ${i}: reserved bytes must be zero`, at);
    switch (x.trigger) {
      case TRIGGER.EVERY:
        if (x.triggerArg < BigInt(PXG1.MIN_EVERY_SECS)) fail("EveryTooShort", `node ${i}: "every" must be at least ${PXG1.MIN_EVERY_SECS}s`, at);
        break;
      case TRIGGER.AFTER:
        if (x.triggerArg >= BigInt(n)) fail("BadAfterRef", `node ${i}: "after" names a node that does not exist`, at);
        if (x.triggerArg === BigInt(i)) fail("AfterCycle", `node ${i}: a node can't run after itself`, at);
        break;
      case TRIGGER.ON_GRADUATED:
      case TRIGGER.WHEN:
        if (x.triggerArg !== 0n) fail("TriggerArgNonZero", `node ${i}: this trigger takes no argument`, at);
        if (x.trigger === TRIGGER.WHEN && x.condLen === 0) fail("WhenWithoutCondition", `node ${i}: a "when" trigger needs a condition`, at);
        break;
      default:
        fail("UnknownTrigger", `node ${i}: unknown trigger ${x.trigger}`, at);
    }
    switch (x.action) {
      case ACTION.BUYBACK_BURN:
      case ACTION.BURN:
      case ACTION.DISTRIBUTE_SOL:
        break;
      case ACTION.ADD_LOCKED_LIQUIDITY:
      case ACTION.MERKLE_AIRDROP:
        fail("ReservedAction", `node ${i}: action ${x.action} is reserved for a later version`, at);
        break;
      default:
        fail("UnknownAction", `node ${i}: unknown action ${x.action}`, at);
    }
    if (x.p1 === 0n) fail("ZeroP1", `node ${i}: the per-run maximum must be more than zero`, at);
    if (x.action === ACTION.BUYBACK_BURN) {
      if (x.p2 > BigInt(PXG1.MAX_PREMIUM_BPS)) fail("PremiumTooHigh", `node ${i}: the premium is above ${PXG1.MAX_PREMIUM_BPS} bps`, at);
    } else if (x.p2 !== 0n) {
      fail("P2NonZero", `node ${i}: p2 must be 0 for this action`, at);
    }
    if (x.action === ACTION.DISTRIBUTE_SOL) {
      if (g.recipients.length === 0) fail("NoRecipients", `node ${i}: distribute needs recipients`, at);
      anyDistribute = true;
    }
    if (x.operatorGated === 1) {
      if (!hasOp) fail("GatedWithoutOperator", `node ${i}: operator-gated but the graph has no operator`, at);
      anyGated = true;
    } else if (x.operatorGated !== 0) {
      fail("BadOperatorGated", `node ${i}: operator_gated must be 0 or 1`, at);
    }
    if (x.epochSecs < PXG1.MIN_EPOCH_SECS) fail("EpochTooShort", `node ${i}: budget epochs last at least ${PXG1.MIN_EPOCH_SECS}s`, at);
    if (x.budgetPerEpoch === 0n) fail("ZeroBudget", `node ${i}: the budget per epoch must be more than zero`, at);
    if (x.maxRunsPerEpoch === 0) fail("ZeroMaxRuns", `node ${i}: at least one run per epoch`, at);
    if (x.condLen === 0) {
      if (x.condOff !== 0) fail("ConditionNotContiguous", `node ${i}: an empty condition must have offset 0`, at);
    } else {
      if (x.condOff !== next) fail("ConditionNotContiguous", `node ${i}: its condition must start at node ${next}`, at);
      const end = next + x.condLen;
      if (end > g.cond.length) fail("ConditionOutOfRange", `node ${i}: its condition runs past the last node`, at);
      try {
        verifyCondition(g.cond.slice(next, end), ctx, next);
      } catch (e) {
        if (e instanceof ProgError) throw new ProgError(e.code, `node ${i}: ${e.message}`, { ...e.at, node: i });
        throw e;
      }
      next = end;
    }
  });
  if (next !== g.cond.length) fail("UnreferencedNode", `condition nodes ${next}.. are not part of any graph node`, { condNode: next });
  const parent = (i: number): number | null => {
    const x = g.nodes[i];
    return x && x.trigger === TRIGGER.AFTER ? Number(x.triggerArg) : null;
  };
  if (!afterAcyclic(n, parent)) fail("AfterCycle", `"after" links form a loop`);
  if (hasOp && !anyGated) fail("OperatorUnused", "the graph names an operator but no node is operator-gated");
  if (g.recipients.length > 0 && !anyDistribute) fail("RecipientsUnused", "the graph lists recipients but no node pays them");
  return g;
}

export type GraphVerifyResult =
  | { ok: true; size: number; hash: Uint8Array; hashHex: string }
  | { ok: false; code: VerifyErrorCode; message: string; at: ProgError["at"] };

/** Non-throwing verification with the content hash. */
export function verifyGraph(bytes: Uint8Array): GraphVerifyResult {
  try {
    verifyGraphBytes(bytes);
    const hash = graphHash(bytes);
    return { ok: true, size: bytes.length, hash, hashHex: toHex(hash) };
  } catch (e) {
    if (e instanceof ProgError) return { ok: false, code: e.code as VerifyErrorCode, message: e.message, at: e.at };
    throw e;
  }
}

/**
 * The RPN condition mini-VM (spec §1.1), mirroring crates/noised-rules
 * src/vm.rs check for check.
 *
 * A condition is a postfix array of 10-byte nodes (op u8 | a u8 | arg u64 LE)
 * over a boolean stack of at most 16 values. Verification, per node in
 * order: the op is known in the context and its operands are valid (unused
 * operands zero), then its stack effect (no underflow, never more than 16
 * values); at the end exactly one value. Evaluation is one pass and fails
 * closed (null) on a malformed condition, which verification rules out.
 */
import { BPS_DENOMINATOR, BPS_FLAG, OP, PXG1, U64_MAX, VM } from "../constants.js";
import { ProgError, type VerifyErrorCode } from "../errors.js";

/** One raw condition node. */
export interface CondNode {
  op: number;
  a: number;
  arg: bigint;
}

/** What the leaves of a condition may reference while verifying. */
export type CondContext =
  | {
      kind: "rules";
      nKeys: number;
      /** min(guard_secs, 72 h). */
      guardSecs: number;
      /** Accumulates the key bits masks use (for UnusedKey). */
      usedKeys?: { mask: number };
    }
  | { kind: "graph"; nGraphNodes: number };

const RULE_LEAVES = new Set<number>([
  OP.IS_BUY, OP.IS_P2P, OP.TIME_LT, OP.TIME_GE, OP.AMOUNT_GT, OP.DEST_BAL_AFTER_GT,
  OP.DEST_OWNER_IN, OP.SRC_OWNER_IN, OP.TOP_PROGRAM_IN, OP.TX_IX_COUNT_GT,
]);
const GRAPH_LEAVES = new Set<number>([
  OP.TREASURY_SOL_GTE, OP.TREASURY_TOKEN_GTE, OP.GRADUATED, OP.PRICE_LTE, OP.PRICE_GTE,
  OP.NOW_GE, OP.NOW_LT, OP.RUNS_IN_EPOCH_LT,
]);

export function isRuleLeafOp(op: number): boolean {
  return RULE_LEAVES.has(op);
}
export function isGraphLeafOp(op: number): boolean {
  return GRAPH_LEAVES.has(op);
}

/** The crate's check_bps_arg: bits 16..=62 clear and 1 <= bps <= 10,000. */
export function isValidBpsArg(arg: bigint): boolean {
  const bps = arg & 0xffffn;
  return (arg & ~(BPS_FLAG | 0xffffn)) === 0n && bps >= 1n && bps <= BigInt(BPS_DENOMINATOR);
}

/** The crate's `exceeds`: value > threshold(arg, supply). */
export function exceeds(value: bigint, arg: bigint, supply: bigint): boolean {
  return value > threshold(arg, supply);
}

/**
 * The crate's `threshold`: arg, or with BPS_FLAG, floor(supply * bps / 10000)
 * with bps = arg & 0xFFFF, saturating at u64::MAX (only reachable with
 * unverified bps above 10,000, as on-chain).
 */
export function threshold(arg: bigint, supply: bigint): bigint {
  if ((arg & BPS_FLAG) === 0n) return arg;
  const t = (supply * (arg & 0xffffn)) / BigInt(BPS_DENOMINATOR);
  return t > U64_MAX ? U64_MAX : t;
}

const err = (code: VerifyErrorCode, at: number, what: string): ProgError =>
  new ProgError(code, `condition node ${at}: ${what}`, { condNode: at });

/** Operand checks of one leaf (the crate's LeafCheck). */
function checkLeaf(n: CondNode, ctx: CondContext, at: number): void {
  const noOperands = (): void => {
    if (n.a !== 0 || n.arg !== 0n) throw err("NonZeroOperand", at, "this op takes no operands");
  };
  const noA = (): void => {
    if (n.a !== 0) throw err("NonZeroOperand", at, "`a` must be 0 for this op");
  };
  if (ctx.kind === "rules") {
    switch (n.op) {
      case OP.IS_BUY:
      case OP.IS_P2P:
        return noOperands();
      case OP.TIME_LT:
      case OP.TIME_GE:
        noA();
        if (n.arg > BigInt(ctx.guardSecs)) throw err("TimeOutOfRange", at, "time is past the end of the launch guard");
        return;
      case OP.AMOUNT_GT:
      case OP.DEST_BAL_AFTER_GT:
        noA();
        if ((n.arg & BPS_FLAG) !== 0n && !isValidBpsArg(n.arg)) throw err("BadBps", at, "a share of supply must be 1..=10000 bps");
        return;
      case OP.DEST_OWNER_IN:
      case OP.SRC_OWNER_IN:
      case OP.TOP_PROGRAM_IN: {
        if (n.arg !== 0n) throw err("NonZeroOperand", at, "`arg` must be 0 for a key list");
        const all = (1 << Math.min(ctx.nKeys, 8)) - 1;
        if (n.a === 0 || (n.a & ~all) !== 0) throw err("BadKeyMask", at, "key mask is empty or names a missing key");
        if (ctx.usedKeys) ctx.usedKeys.mask |= n.a;
        return;
      }
      case OP.TX_IX_COUNT_GT:
        return noA();
      default:
        throw err("UnknownOp", at, `op 0x${n.op.toString(16)} is not a launch-rule op`);
    }
  }
  switch (n.op) {
    case OP.TREASURY_SOL_GTE:
    case OP.TREASURY_TOKEN_GTE:
    case OP.PRICE_LTE:
    case OP.PRICE_GTE:
      return noA();
    case OP.GRADUATED:
      return noOperands();
    case OP.NOW_GE:
    case OP.NOW_LT:
      noA();
      if (n.arg > PXG1.MAX_UNIX) throw err("TimeOutOfRange", at, "unix time must fit in an i64");
      return;
    case OP.RUNS_IN_EPOCH_LT:
      if (n.a >= ctx.nGraphNodes) throw err("BadNodeRef", at, "names a graph node that does not exist");
      return;
    default:
      throw err("UnknownOp", at, `op 0x${n.op.toString(16)} is not an autopilot op`);
  }
}

/**
 * Verifies one condition (the crate's vm::verify): per node, the op and its
 * operands, then its stack effect; at the end exactly one value.
 * `base` is the slice's first index, for error positions.
 */
export function verifyCondition(nodes: readonly CondNode[], ctx: CondContext, base = 0): void {
  let depth = 0;
  nodes.forEach((n, i) => {
    const at = base + i;
    let pops: number;
    switch (n.op) {
      case OP.TRUE:
      case OP.FALSE:
        if (n.a !== 0 || n.arg !== 0n) throw err("NonZeroOperand", at, "this op takes no operands");
        pops = 0;
        break;
      case OP.AND:
      case OP.OR:
        if (n.a !== 0 || n.arg !== 0n) throw err("NonZeroOperand", at, "this op takes no operands");
        pops = 2;
        break;
      case OP.NOT:
        if (n.a !== 0 || n.arg !== 0n) throw err("NonZeroOperand", at, "this op takes no operands");
        pops = 1;
        break;
      default:
        checkLeaf(n, ctx, at);
        pops = 0;
    }
    if (depth < pops) throw err("StackUnderflow", at, "pops more values than the stack holds");
    depth -= pops;
    if (depth >= VM.MAX_STACK) throw err("StackOverflow", at, `more than ${VM.MAX_STACK} values on the stack`);
    depth += 1;
  });
  if (depth === 0) throw new ProgError("EmptyCondition", "a condition needs at least one node", { condNode: base });
  if (depth !== 1) {
    throw new ProgError("LeftoverValues", `the condition ending at node ${base + nodes.length - 1} leaves ${depth} values`, {
      condNode: base + nodes.length - 1,
    });
  }
}

/**
 * Evaluates a condition in one pass (the crate's vm::eval). `leaf` decides
 * each leaf (null = unknown op). Returns null for a malformed condition.
 */
export function evalCondition(nodes: readonly CondNode[], leaf: (n: CondNode) => boolean | null): boolean | null {
  const stack: boolean[] = [];
  for (const n of nodes) {
    let bit: boolean;
    switch (n.op) {
      case OP.TRUE:
        bit = true;
        break;
      case OP.FALSE:
        bit = false;
        break;
      case OP.AND:
      case OP.OR: {
        if (stack.length < 2) return null;
        const x = stack.pop()!;
        const y = stack.pop()!;
        bit = n.op === OP.AND ? x && y : x || y;
        break;
      }
      case OP.NOT:
        if (stack.length < 1) return null;
        bit = !stack.pop()!;
        break;
      default: {
        const v = leaf(n);
        if (v === null) return null;
        bit = v;
      }
    }
    if (stack.length >= VM.MAX_STACK) return null;
    stack.push(bit);
  }
  return stack.length === 1 ? stack[0]! : null;
}

/**
 * Evaluates a condition some of whose leaves are uncertain, in one pass (the
 * crate's vm::eval_bounded). `leaf` gives each leaf as `[must, may]`: whether
 * it holds for every value its inputs may take, and whether it holds for
 * some (null = unknown op). AND and OR combine the two halves separately; NOT
 * swaps them (not may, not must). The result is the root's `must`: true only
 * if the condition holds whatever the uncertain inputs are. With certain
 * leaves (`[v, v]`) it is exactly `evalCondition`. Returns null for a
 * malformed condition.
 */
export function evalConditionBounded(
  nodes: readonly CondNode[],
  leaf: (n: CondNode) => readonly [boolean, boolean] | null,
): boolean | null {
  const stack: [boolean, boolean][] = [];
  for (const n of nodes) {
    let v: [boolean, boolean];
    switch (n.op) {
      case OP.TRUE:
        v = [true, true];
        break;
      case OP.FALSE:
        v = [false, false];
        break;
      case OP.AND:
      case OP.OR: {
        if (stack.length < 2) return null;
        const x = stack.pop()!;
        const y = stack.pop()!;
        v = n.op === OP.AND ? [x[0] && y[0], x[1] && y[1]] : [x[0] || y[0], x[1] || y[1]];
        break;
      }
      case OP.NOT: {
        if (stack.length < 1) return null;
        const x = stack.pop()!;
        v = [!x[1], !x[0]];
        break;
      }
      default: {
        const l = leaf(n);
        if (l === null) return null;
        v = [l[0], l[1]];
      }
    }
    if (stack.length >= VM.MAX_STACK) return null;
    stack.push(v);
  }
  return stack.length === 1 ? stack[0]![0] : null;
}

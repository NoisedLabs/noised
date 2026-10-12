/**
 * Condition trees: the readable form of an RPN condition. One tree type
 * serves both contexts; leaves are launch-rule leaves or autopilot leaves.
 *
 * compile = post-order walk (children left to right, then the operator), so
 * decompile(compile(t)) is t again, node for node.
 */
import { BPS_FLAG, DEFAULT_TOKEN_DECIMALS, OP, U64_MAX } from "../constants.js";
import { type Address, addressBytes, encodeBase58, isAddress, toAddress } from "../bytes.js";
import { ProgError } from "../errors.js";
import { priceToSqrtPriceQ64, toBps, toTokenUnits } from "../units.js";
import type { CondNode } from "./vm.js";

/**
 * A token amount in a condition or cap: raw units, a share of supply in bps
 * (1..=10000), or whole tokens as decimal text (resolved with the set's
 * token decimals when compiled; decompiled trees always use raw / bps).
 */
export type Amount = { raw: bigint } | { bps: number } | { tokens: string };

/** A token quantity (no supply share): raw units or whole tokens as decimal text. */
export type TokenQty = { raw: bigint } | { tokens: string };

/** A price: raw DAMM v2 sqrt price (Q64.64) or SOL per whole token as decimal text. */
export type PriceQty = { sqrtPriceQ64: bigint } | { sol: string };

/** Launch-rule leaves (spec §1.2, context RULES). */
export type RuleLeaf =
  | { op: "buy" }
  | { op: "p2p" }
  | { op: "timeLt"; secs: number }
  | { op: "timeGe"; secs: number }
  | { op: "amountGt"; amount: Amount }
  | { op: "balanceGt"; amount: Amount }
  | { op: "toIn"; keys: string[] }
  | { op: "fromIn"; keys: string[] }
  | { op: "programIn"; keys: string[] }
  | { op: "ixCountGt"; n: number };

/** Autopilot leaves (spec §1.3, context GRAPH). */
export type GraphLeaf =
  | { op: "treasurySolGte"; lamports: bigint }
  | { op: "treasuryTokensGte"; amount: TokenQty }
  | { op: "graduated" }
  | { op: "priceLte"; price: PriceQty }
  | { op: "priceGte"; price: PriceQty }
  | { op: "nowGe"; unix: bigint }
  | { op: "nowLt"; unix: bigint }
  | { op: "runsInEpochLt"; node: string; n: number };

/** A condition tree. `toIn` / `fromIn` / `programIn` keys are addresses (or key labels before build). */
export type Cond =
  | { op: "true" }
  | { op: "false" }
  | { op: "and"; a: Cond; b: Cond }
  | { op: "or"; a: Cond; b: Cond }
  | { op: "not"; x: Cond }
  | RuleLeaf
  | GraphLeaf;

export type CondOpName = Cond["op"];

const RULE_LEAF_NAMES = new Set<string>(["buy", "p2p", "timeLt", "timeGe", "amountGt", "balanceGt", "toIn", "fromIn", "programIn", "ixCountGt"]);
const GRAPH_LEAF_NAMES = new Set<string>([
  "treasurySolGte", "treasuryTokensGte", "graduated", "priceLte", "priceGte", "nowGe", "nowLt", "runsInEpochLt",
]);

export const isRuleLeaf = (c: Cond): c is RuleLeaf => RULE_LEAF_NAMES.has(c.op);
export const isGraphLeaf = (c: Cond): c is GraphLeaf => GRAPH_LEAF_NAMES.has(c.op);

/** Every leaf of a tree, left to right (iterative: safe on any depth). */
export function leaves(c: Cond): Cond[] {
  const out: Cond[] = [];
  const stack: Cond[] = [c];
  while (stack.length > 0) {
    const x = stack.pop()!;
    if (x.op === "and" || x.op === "or") stack.push(x.b, x.a);
    else if (x.op === "not") stack.push(x.x);
    else out.push(x);
  }
  return out;
}

/** Number of RPN nodes the tree compiles to. */
export function condSize(c: Cond): number {
  switch (c.op) {
    case "and":
    case "or":
      return condSize(c.a) + condSize(c.b) + 1;
    case "not":
      return condSize(c.x) + 1;
    default:
      return 1;
  }
}

/** Maximum stack depth the compiled tree reaches. */
export function condDepth(c: Cond): number {
  switch (c.op) {
    case "and":
    case "or":
      return Math.max(condDepth(c.a), condDepth(c.b) + 1);
    case "not":
      return condDepth(c.x);
    default:
      return 1;
  }
}

/**
 * Most nodes a condition tree may have before any recursive walk (compile,
 * normalize, print, explain) touches it. Far above what fits on-chain (64
 * nodes in a rule set, 96 in a graph), low enough that no walk can exhaust
 * the call stack: an absurd tree fails with ProgError("TooManyNodes").
 */
export const MAX_TREE_NODES = 512;

/** Throws ProgError("TooManyNodes") if `c` has more than MAX_TREE_NODES nodes (iterative, never recurses). */
export function checkCondSize(c: Cond): void {
  const stack: Cond[] = [c];
  let n = 0;
  while (stack.length > 0) {
    const x = stack.pop()!;
    if (++n > MAX_TREE_NODES) {
      throw new ProgError("TooManyNodes", `a condition can't have more than ${MAX_TREE_NODES} parts (a rule set holds 64 in all, a graph 96)`);
    }
    if (x.op === "and" || x.op === "or") stack.push(x.a, x.b);
    else if (x.op === "not") stack.push(x.x);
  }
}

// ------------------------------------------------------------ compile ---

/** How leaves resolve while compiling. */
export interface CompileEnv {
  kind: "rules" | "graph";
  tokenDecimals?: number;
  /** rules: key address -> index in the key table. */
  keyIndex?: (address: Address) => number;
  /** graph: node id -> index. */
  nodeIndex?: (id: string) => number;
}

/** Amount -> u64 arg (raw, or BPS_FLAG | bps). */
export function amountArg(a: Amount, decimals: number, what: string): bigint {
  if ("bps" in a) {
    const bps = a.bps;
    if (!Number.isInteger(bps) || bps < 1 || bps > 10_000) {
      throw new ProgError("BadAmount", `${what}: a share of supply must be between 0.01% and 100%`);
    }
    return BPS_FLAG | BigInt(bps);
  }
  const raw = "raw" in a ? a.raw : toTokenUnits(a.tokens, decimals, what);
  if (typeof raw !== "bigint") throw new ProgError("BadAmount", `${what}: a raw amount is a bigint`);
  if (raw < 0n || raw >= BPS_FLAG) throw new ProgError("BadAmount", `${what}: amount out of range`);
  return raw;
}

/** u64 arg -> canonical Amount. */
export function argAmount(arg: bigint): Amount {
  return (arg & BPS_FLAG) !== 0n ? { bps: Number(arg & 0xffffn) } : { raw: arg };
}

/** A raw u64 operand, or ProgError("BadAmount"): never wrapped or truncated. */
export function u64Operand(v: bigint, what: string): bigint {
  if (typeof v !== "bigint") throw new ProgError("BadAmount", `${what} must be a whole number (bigint)`);
  if (v < 0n) throw new ProgError("BadAmount", `${what} can't be negative`);
  if (v > U64_MAX) throw new ProgError("BadAmount", `${what} is too large`);
  return v;
}

export function tokenQtyUnits(q: TokenQty, decimals: number, what: string): bigint {
  return "raw" in q ? u64Operand(q.raw, what) : toTokenUnits(q.tokens, decimals, what);
}

export function priceQtySqrt(p: PriceQty, decimals: number): bigint {
  if (!("sqrtPriceQ64" in p)) return priceToSqrtPriceQ64(p.sol, decimals);
  const s = p.sqrtPriceQ64;
  if (typeof s !== "bigint" || s < 0n) throw new ProgError("PriceOutOfRange", "a sqrt price is a whole number >= 0");
  if (s > U64_MAX) throw new ProgError("PriceOutOfRange", "price is too high to compare on-chain (a u64 sqrt price)");
  return s;
}

function wrongContext(op: string, kind: "rules" | "graph"): never {
  throw new ProgError(
    "WrongContext",
    kind === "rules"
      ? `"${op}" is an autopilot condition; it can't be used in a launch rule`
      : `"${op}" is a launch-rule condition; it can't be used in an autopilot graph`,
  );
}

function maskOf(keys: readonly string[], env: CompileEnv, op: string): number {
  if (keys.length === 0) throw new ProgError("BadModel", `"${op}" needs at least one wallet or program`);
  let mask = 0;
  for (const k of keys) {
    const i = env.keyIndex!(k);
    mask |= 1 << i;
  }
  return mask;
}

/** Compiles a tree to RPN nodes (post-order). Throws ProgError on a bad leaf. */
export function compileCond(c: Cond, env: CompileEnv): CondNode[] {
  checkCondSize(c);
  const out: CondNode[] = [];
  const dec = env.tokenDecimals ?? DEFAULT_TOKEN_DECIMALS;
  const leaf = (op: number, a = 0, arg = 0n): void => {
    out.push({ op, a, arg });
  };
  const walk = (n: Cond): void => {
    if (env.kind === "rules" && isGraphLeaf(n)) wrongContext(n.op, "rules");
    if (env.kind === "graph" && isRuleLeaf(n)) wrongContext(n.op, "graph");
    switch (n.op) {
      case "true":
        return leaf(OP.TRUE);
      case "false":
        return leaf(OP.FALSE);
      case "and":
      case "or":
        walk(n.a);
        walk(n.b);
        return leaf(n.op === "and" ? OP.AND : OP.OR);
      case "not":
        walk(n.x);
        return leaf(OP.NOT);
      case "buy":
        return leaf(OP.IS_BUY);
      case "p2p":
        return leaf(OP.IS_P2P);
      case "timeLt":
      case "timeGe":
        if (!Number.isSafeInteger(n.secs) || n.secs < 0) throw new ProgError("BadDuration", "time must be whole seconds");
        return leaf(n.op === "timeLt" ? OP.TIME_LT : OP.TIME_GE, 0, BigInt(n.secs));
      case "amountGt":
        return leaf(OP.AMOUNT_GT, 0, amountArg(n.amount, dec, "amount"));
      case "balanceGt":
        return leaf(OP.DEST_BAL_AFTER_GT, 0, amountArg(n.amount, dec, "balance"));
      case "toIn":
        return leaf(OP.DEST_OWNER_IN, maskOf(n.keys, env, n.op));
      case "fromIn":
        return leaf(OP.SRC_OWNER_IN, maskOf(n.keys, env, n.op));
      case "programIn":
        return leaf(OP.TOP_PROGRAM_IN, maskOf(n.keys, env, n.op));
      case "ixCountGt":
        if (!Number.isSafeInteger(n.n) || n.n < 0) throw new ProgError("BadModel", "instruction count must be a whole number");
        return leaf(OP.TX_IX_COUNT_GT, 0, BigInt(n.n));
      case "treasurySolGte":
        return leaf(OP.TREASURY_SOL_GTE, 0, u64Operand(n.lamports, "treasury SOL (lamports)"));
      case "treasuryTokensGte":
        return leaf(OP.TREASURY_TOKEN_GTE, 0, tokenQtyUnits(n.amount, dec, "treasury tokens"));
      case "graduated":
        return leaf(OP.GRADUATED);
      case "priceLte":
        return leaf(OP.PRICE_LTE, 0, priceQtySqrt(n.price, dec));
      case "priceGte":
        return leaf(OP.PRICE_GTE, 0, priceQtySqrt(n.price, dec));
      case "nowGe":
        return leaf(OP.NOW_GE, 0, u64Operand(n.unix, "date (unix seconds)"));
      case "nowLt":
        return leaf(OP.NOW_LT, 0, u64Operand(n.unix, "date (unix seconds)"));
      case "runsInEpochLt":
        if (!Number.isSafeInteger(n.n) || n.n < 0) throw new ProgError("BadModel", "run count must be a whole number");
        return leaf(OP.RUNS_IN_EPOCH_LT, env.nodeIndex!(n.node), BigInt(n.n));
    }
  };
  walk(c);
  return out;
}

// ------------------------------------------------------------ decompile ---

export interface DecompileEnv {
  /** rules: the key table (addresses). */
  keys?: readonly Address[];
  /** graph: node ids by index. */
  nodeIds?: readonly string[];
}

function maskKeys(mask: number, env: DecompileEnv): string[] {
  const out: string[] = [];
  const keys = env.keys ?? [];
  for (let i = 0; i < keys.length; i++) if (mask & (1 << i)) out.push(keys[i]!);
  return out;
}

/** A u64 as a JS number, or ProgError("BadModel") if it can't be represented exactly. */
export function safeNumber(v: bigint, what: string): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ProgError("BadModel", `${what} ${v} is too large to show exactly`);
  return Number(v);
}

/** RPN nodes (already verified) -> tree. */
export function decompileCond(nodes: readonly CondNode[], env: DecompileEnv): Cond {
  const st: Cond[] = [];
  for (const n of nodes) {
    switch (n.op) {
      case OP.TRUE:
        st.push({ op: "true" });
        break;
      case OP.FALSE:
        st.push({ op: "false" });
        break;
      case OP.AND:
      case OP.OR: {
        const b = st.pop()!;
        const a = st.pop()!;
        st.push({ op: n.op === OP.AND ? "and" : "or", a, b });
        break;
      }
      case OP.NOT:
        st.push({ op: "not", x: st.pop()! });
        break;
      case OP.IS_BUY:
        st.push({ op: "buy" });
        break;
      case OP.IS_P2P:
        st.push({ op: "p2p" });
        break;
      case OP.TIME_LT:
        st.push({ op: "timeLt", secs: Number(n.arg) });
        break;
      case OP.TIME_GE:
        st.push({ op: "timeGe", secs: Number(n.arg) });
        break;
      case OP.AMOUNT_GT:
        st.push({ op: "amountGt", amount: argAmount(n.arg) });
        break;
      case OP.DEST_BAL_AFTER_GT:
        st.push({ op: "balanceGt", amount: argAmount(n.arg) });
        break;
      case OP.DEST_OWNER_IN:
        st.push({ op: "toIn", keys: maskKeys(n.a, env) });
        break;
      case OP.SRC_OWNER_IN:
        st.push({ op: "fromIn", keys: maskKeys(n.a, env) });
        break;
      case OP.TOP_PROGRAM_IN:
        st.push({ op: "programIn", keys: maskKeys(n.a, env) });
        break;
      case OP.TX_IX_COUNT_GT:
        st.push({ op: "ixCountGt", n: safeNumber(n.arg, "instruction count") });
        break;
      case OP.TREASURY_SOL_GTE:
        st.push({ op: "treasurySolGte", lamports: n.arg });
        break;
      case OP.TREASURY_TOKEN_GTE:
        st.push({ op: "treasuryTokensGte", amount: { raw: n.arg } });
        break;
      case OP.GRADUATED:
        st.push({ op: "graduated" });
        break;
      case OP.PRICE_LTE:
        st.push({ op: "priceLte", price: { sqrtPriceQ64: n.arg } });
        break;
      case OP.PRICE_GTE:
        st.push({ op: "priceGte", price: { sqrtPriceQ64: n.arg } });
        break;
      case OP.NOW_GE:
        st.push({ op: "nowGe", unix: n.arg });
        break;
      case OP.NOW_LT:
        st.push({ op: "nowLt", unix: n.arg });
        break;
      case OP.RUNS_IN_EPOCH_LT:
        st.push({ op: "runsInEpochLt", node: env.nodeIds?.[n.a] ?? `node${n.a + 1}`, n: safeNumber(n.arg, "run count") });
        break;
      default:
        throw new ProgError("UnknownOp", `unknown op 0x${n.op.toString(16)}`);
    }
  }
  if (st.length !== 1) throw new ProgError("LeftoverValues", "condition does not leave exactly one value");
  return st[0]!;
}

// ------------------------------------------------------------ normalize ---

export interface NormalizeEnv {
  tokenDecimals: number;
  /** Resolves a key label or address to an address (rules). */
  resolveKey?: (k: string) => Address;
}

/**
 * Canonical tree: token amounts as raw units, prices as sqrt Q64, key labels
 * resolved to addresses (sorted by `keyOrder` when given). Throws on bad leaves.
 */
export function normalizeCond(c: Cond, env: NormalizeEnv, keyOrder?: (a: Address) => number): Cond {
  checkCondSize(c);
  const keys = (ks: readonly string[]): string[] => {
    const resolved = ks.map((k) => (env.resolveKey ? env.resolveKey(k) : toAddress(k)));
    const uniq = [...new Set(resolved)];
    return keyOrder ? uniq.sort((x, y) => keyOrder(x) - keyOrder(y)) : uniq;
  };
  const dec = env.tokenDecimals;
  const amount = (a: Amount, what: string): Amount => {
    if ("bps" in a) {
      amountArg(a, dec, what);
      return { bps: a.bps };
    }
    return { raw: amountArg(a, dec, what) };
  };
  const walk = (n: Cond): Cond => {
    switch (n.op) {
      case "and":
      case "or":
        return { op: n.op, a: walk(n.a), b: walk(n.b) };
      case "not":
        return { op: "not", x: walk(n.x) };
      case "amountGt":
      case "balanceGt":
        return { op: n.op, amount: amount(n.amount, n.op === "amountGt" ? "amount" : "balance") };
      case "toIn":
      case "fromIn":
      case "programIn":
        return { op: n.op, keys: keys(n.keys) };
      case "treasuryTokensGte":
        return { op: n.op, amount: { raw: tokenQtyUnits(n.amount, dec, "treasury tokens") } };
      case "priceLte":
      case "priceGte":
        return { op: n.op, price: { sqrtPriceQ64: priceQtySqrt(n.price, dec) } };
      default:
        return { ...n };
    }
  };
  return walk(c);
}

/** Key strings of a tree that are not addresses (labels to resolve). */
export function condKeyRefs(c: Cond): string[] {
  const out: string[] = [];
  for (const l of leaves(c)) if (l.op === "toIn" || l.op === "fromIn" || l.op === "programIn") out.push(...l.keys);
  return out;
}

/** True if `s` should be treated as an address rather than a label. */
export const looksLikeAddress = (s: string): boolean => isAddress(s);

/** Bytes of an address (re-exported for codecs). */
export const keyBytes = (a: Address): Uint8Array => addressBytes(a);
export const bytesKey = (b: Uint8Array): Address => encodeBase58(b);

/** Parses a share-or-tokens input into an Amount. */
export function toAmount(v: unknown, what = "amount"): Amount {
  if (typeof v === "bigint") return { raw: v };
  if (typeof v === "number") return { tokens: String(v) };
  if (typeof v === "object" && v !== null) {
    if ("bps" in v) return { bps: toBps((v as { bps: number }).bps, what) };
    if ("raw" in v) return { raw: (v as { raw: bigint }).raw };
    if ("tokens" in v) return { tokens: String((v as { tokens: string }).tokens) };
  }
  if (typeof v === "string") {
    const t = v.trim();
    if (t.endsWith("%") || t.endsWith("bps")) return { bps: toBps(t, what) };
    return { tokens: t };
  }
  throw new ProgError("BadAmount", `${what}: use a number of tokens, a bigint of raw units, or a share like "1%"`);
}

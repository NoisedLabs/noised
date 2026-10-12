/**
 * Autopilot graphs as data (what the canvas, the text DSL and the code
 * builder produce), and the exact mapping to / from PXG1 bytes.
 *
 * Amounts are raw bigints: lamports for SOL actions and budgets, raw token
 * units for burns. Node ids are names for people; on-chain a node is its index.
 */
import { ACTION, DEFAULT_TOKEN_DECIMALS, PXG1, TRIGGER } from "../constants.js";
import { type Address, addressBytes, encodeBase58, isZero, toAddress } from "../bytes.js";
import { ProgError } from "../errors.js";
import { type Cond, compileCond, decompileCond, leaves, normalizeCond, safeNumber, u64Operand } from "../cond/ast.js";
import type { CondNode } from "../cond/vm.js";
import { encodeGraphRaw, type RawGNode, type RawGraph, verifyGraphBytes } from "./codec.js";

/** What makes a node due. */
export type Trigger =
  /** Due when at least `secs` (>= 600) passed since its last run. */
  | { kind: "every"; secs: number }
  /** Due once after node `node` succeeded since this node's last run. */
  | { kind: "after"; node: string }
  /** Due once, after the token graduated (migrated to its locked pool). */
  | { kind: "graduated" }
  /** Due whenever its condition holds (needs a condition). */
  | { kind: "when" };

export type TriggerKind = Trigger["kind"];

/** The closed action catalogue. Nothing else can move treasury value. */
export type Action =
  /** Swap up to `maxInLamports` wSOL -> token in the locked pool, burn everything received. */
  | { kind: "buybackBurn"; maxInLamports: bigint; maxPremiumBps: number }
  /** Burn up to `maxTokens` treasury tokens (raw units). */
  | { kind: "burn"; maxTokens: bigint }
  /** Pay up to `maxLamports` wSOL to the graph's recipients by their shares. */
  | { kind: "distributeSol"; maxLamports: bigint };

export type ActionKind = Action["kind"];

export interface GraphNode {
  /** Unique name (not on-chain). */
  id: string;
  trigger: Trigger;
  /** Extra condition; null = always. */
  when: Cond | null;
  action: Action;
  /** Only the graph's operator may run it (choosing timing and amount within the limits). */
  operatorGated: boolean;
  /** Budget epoch length (>= 3600 s). */
  epochSecs: number;
  /** Max spent per epoch: lamports (buyback, distribute) or raw tokens (burn). */
  budgetPerEpoch: bigint;
  /** Max successful runs per epoch (1..=65535). */
  maxRunsPerEpoch: number;
}

/** A declared payee of distributeSol. */
export interface Recipient {
  address: Address;
  /** Share in bps; all shares add up to 10000. */
  bps: number;
  label?: string;
}

export interface Graph {
  /** The AI / human operator allowed to run operator-gated nodes, or null. */
  operator: Address | null;
  recipients: Recipient[];
  nodes: GraphNode[];
  /** Token decimals for display and "tokens" amounts (default 6). */
  tokenDecimals?: number;
}

const ID_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
export const isNodeId = (s: string): boolean => ID_RE.test(s);

/** The amount unit of an action's budget and per-run max. */
export function actionUnit(a: Action | ActionKind): "lamports" | "tokens" {
  const k = typeof a === "string" ? a : a.kind;
  return k === "burn" ? "tokens" : "lamports";
}

/** Per-run maximum (p1) of an action. */
export function actionMax(a: Action): bigint {
  switch (a.kind) {
    case "buybackBurn":
      return a.maxInLamports;
    case "burn":
      return a.maxTokens;
    case "distributeSol":
      return a.maxLamports;
  }
}

/** Runs `f` for node `i`, attributing any ProgError without a position to that node. */
function atNode<T>(i: number, id: string, f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof ProgError && e.at.node === undefined) {
      throw new ProgError(e.code, e.message.startsWith("node ") ? e.message : `node "${id}": ${e.message}`, { ...e.at, node: i });
    }
    throw e;
  }
}

/** Canonical graph: addresses canonical, condition amounts / prices resolved. */
export function normalizeGraph(g: Graph): Graph {
  const dec = g.tokenDecimals ?? DEFAULT_TOKEN_DECIMALS;
  const ids = new Set<string>();
  for (const n of g.nodes) {
    if (!isNodeId(n.id)) throw new ProgError("BadModel", `"${n.id}" can't be a node name (letters, digits, _ and -)`);
    if (ids.has(n.id)) throw new ProgError("DuplicateNode", `two nodes are called "${n.id}"`);
    ids.add(n.id);
  }
  const out: Graph = {
    operator: g.operator === null ? null : toAddress(g.operator),
    recipients: g.recipients.map((r, i) => {
      // A share must fit the u16 field exactly: 70536 bps must never encode as 5000.
      if (typeof r.bps !== "number" || !Number.isInteger(r.bps) || r.bps < 0 || r.bps > 10_000) {
        throw new ProgError("BadAmount", `recipient ${i + 1}: a share must be between 0.01% and 100%`, { key: i });
      }
      const x: Recipient = { address: toAddress(r.address), bps: r.bps };
      if (r.label !== undefined) x.label = r.label;
      return x;
    }),
    nodes: g.nodes.map((n, i) =>
      atNode(i, n.id, () => ({
        id: n.id,
        trigger: { ...n.trigger },
        when: n.when === null ? null : normalizeCond(n.when, { tokenDecimals: dec }),
        action: { ...n.action },
        operatorGated: n.operatorGated,
        epochSecs: n.epochSecs,
        budgetPerEpoch: n.budgetPerEpoch,
        maxRunsPerEpoch: n.maxRunsPerEpoch,
      })),
    ),
  };
  if (g.tokenDecimals !== undefined) out.tokenDecimals = g.tokenDecimals;
  return out;
}

const u = (v: number, max: number, what: string, at: number): number => {
  if (!Number.isInteger(v) || v < 0 || v > max) throw new ProgError("BadModel", `node ${at + 1}: ${what} out of range`, { node: at });
  return v;
};

/** Model -> raw (normalizes first; resolves node names; friendly limit errors). */
export function graphToRaw(input: Graph): RawGraph {
  const g = normalizeGraph(input);
  const dec = g.tokenDecimals ?? DEFAULT_TOKEN_DECIMALS;
  if (g.nodes.length === 0) throw new ProgError("NoGraphNodes", "add at least one node");
  if (g.nodes.length > PXG1.MAX_NODES) throw new ProgError("TooManyGraphNodes", `${g.nodes.length} nodes; the limit is ${PXG1.MAX_NODES}`);
  if (g.recipients.length > PXG1.MAX_RECIPIENTS) {
    throw new ProgError("TooManyRecipients", `${g.recipients.length} recipients; the limit is ${PXG1.MAX_RECIPIENTS}`);
  }
  const index = new Map(g.nodes.map((n, i) => [n.id, i] as const));
  const nodeIndex = (id: string): number => {
    const i = index.get(id);
    if (i === undefined) throw new ProgError("UnknownNode", `there is no node called "${id}"`);
    return i;
  };
  const cond: CondNode[] = [];
  const nodes: RawGNode[] = g.nodes.map((n, i) => atNode(i, n.id, () => {
    let trigger: number;
    let triggerArg = 0n;
    switch (n.trigger.kind) {
      case "every":
        trigger = TRIGGER.EVERY;
        triggerArg = BigInt(u(n.trigger.secs, Number.MAX_SAFE_INTEGER, "interval", i));
        break;
      case "after":
        trigger = TRIGGER.AFTER;
        triggerArg = BigInt(nodeIndex(n.trigger.node));
        break;
      case "graduated":
        trigger = TRIGGER.ON_GRADUATED;
        break;
      case "when":
        trigger = TRIGGER.WHEN;
        break;
      default:
        throw new ProgError("BadModel", `unknown trigger "${(n.trigger as { kind: string }).kind}"`);
    }
    const c = n.when === null ? [] : compileCond(n.when, { kind: "graph", tokenDecimals: dec, nodeIndex });
    const raw: RawGNode = {
      trigger,
      triggerArg,
      condOff: c.length === 0 ? 0 : cond.length,
      condLen: c.length,
      action: 0,
      operatorGated: n.operatorGated ? 1 : 0,
      epochSecs: u(n.epochSecs, 0xffff_ffff, "epoch", i),
      budgetPerEpoch: u64Operand(n.budgetPerEpoch, "the budget per epoch"),
      p1: 0n,
      p2: 0n,
      maxRunsPerEpoch: u(n.maxRunsPerEpoch, 0xffff, "max runs per epoch", i),
    };
    switch (n.action.kind) {
      case "buybackBurn":
        raw.action = ACTION.BUYBACK_BURN;
        raw.p1 = u64Operand(n.action.maxInLamports, "the buyback's SOL per run");
        raw.p2 = BigInt(u(n.action.maxPremiumBps, 0xffff, "premium", i));
        break;
      case "burn":
        raw.action = ACTION.BURN;
        raw.p1 = u64Operand(n.action.maxTokens, "the tokens burned per run");
        break;
      case "distributeSol":
        raw.action = ACTION.DISTRIBUTE_SOL;
        raw.p1 = u64Operand(n.action.maxLamports, "the SOL paid per run");
        break;
      default:
        throw new ProgError("BadModel", `unknown action "${(n.action as { kind: string }).kind}"`);
    }
    cond.push(...c);
    return raw;
  }));
  if (cond.length > PXG1.MAX_COND_NODES) {
    throw new ProgError("TooManyNodes", `the conditions use ${cond.length} parts; the limit is ${PXG1.MAX_COND_NODES}`);
  }
  if (cond.length > 255) throw new ProgError("TooManyNodes", "too many condition parts");
  return {
    flags: g.operator === null ? 0 : PXG1.FLAG_HAS_OPERATOR,
    operator: g.operator === null ? new Uint8Array(32) : addressBytes(g.operator),
    recipients: g.recipients.map((r) => ({ key: addressBytes(r.address), bps: r.bps })),
    nodes,
    cond,
  };
}

/** Compiles to verified PXG1 bytes; throws ProgError (friendly message) if invalid. */
export function compileGraph(g: Graph): Uint8Array {
  const bytes = encodeGraphRaw(graphToRaw(g));
  verifyGraphBytes(bytes);
  return bytes;
}

export interface GraphDecompileOptions {
  /** Names for the nodes, by index (default: from the action, e.g. "buyback", "burn2"). */
  ids?: readonly string[];
  /** Labels for recipients / the operator. */
  labels?: Readonly<Record<Address, string>>;
  tokenDecimals?: number;
}

const ACTION_ID: Readonly<Record<number, string>> = {
  [ACTION.BUYBACK_BURN]: "buyback",
  [ACTION.BURN]: "burn",
  [ACTION.DISTRIBUTE_SOL]: "distribute",
};

/** Default node names: the action's name, numbered from the second one. */
export function defaultNodeIds(actions: readonly number[]): string[] {
  const seen = new Map<string, number>();
  return actions.map((a) => {
    const base = ACTION_ID[a] ?? "node";
    const k = (seen.get(base) ?? 0) + 1;
    seen.set(base, k);
    return k === 1 ? base : `${base}${k}`;
  });
}

/** Verifies and decodes PXG1 bytes into the canonical model. */
export function decompileGraph(bytes: Uint8Array, opts: GraphDecompileOptions = {}): Graph {
  const raw = verifyGraphBytes(bytes);
  const ids = opts.ids && opts.ids.length === raw.nodes.length ? [...opts.ids] : defaultNodeIds(raw.nodes.map((n) => n.action));
  if (new Set(ids).size !== ids.length || !ids.every(isNodeId)) {
    throw new ProgError("BadModel", "node names must be distinct, made of letters, digits, _ and -");
  }
  const nodes = raw.nodes.map((n, i): GraphNode => {
    const trigger: Trigger =
      n.trigger === TRIGGER.EVERY
        ? { kind: "every", secs: safeNumber(n.triggerArg, "interval") }
        : n.trigger === TRIGGER.AFTER
          ? { kind: "after", node: ids[Number(n.triggerArg)]! }
          : n.trigger === TRIGGER.ON_GRADUATED
            ? { kind: "graduated" }
            : { kind: "when" };
    const action: Action =
      n.action === ACTION.BUYBACK_BURN
        ? { kind: "buybackBurn", maxInLamports: n.p1, maxPremiumBps: Number(n.p2) }
        : n.action === ACTION.BURN
          ? { kind: "burn", maxTokens: n.p1 }
          : { kind: "distributeSol", maxLamports: n.p1 };
    return {
      id: ids[i]!,
      trigger,
      when: n.condLen === 0 ? null : decompileCond(raw.cond.slice(n.condOff, n.condOff + n.condLen), { nodeIds: ids }),
      action,
      operatorGated: n.operatorGated === 1,
      epochSecs: n.epochSecs,
      budgetPerEpoch: n.budgetPerEpoch,
      maxRunsPerEpoch: n.maxRunsPerEpoch,
    };
  });
  const g: Graph = {
    operator: isZero(raw.operator) ? null : encodeBase58(raw.operator),
    recipients: raw.recipients.map((r) => {
      const address = encodeBase58(r.key);
      const label = opts.labels?.[address];
      return label !== undefined ? { address, bps: r.bps, label } : { address, bps: r.bps };
    }),
    nodes,
  };
  if (opts.tokenDecimals !== undefined) g.tokenDecimals = opts.tokenDecimals;
  return g;
}

/** Node ids a condition refers to (runsInEpochLt). */
export function condNodeRefs(c: Cond | null): string[] {
  if (c === null) return [];
  return leaves(c).flatMap((l) => (l.op === "runsInEpochLt" ? [l.node] : []));
}

/** Renames a node everywhere (triggers and conditions). */
export function renameNode(g: Graph, from: string, to: string): Graph {
  const fix = (c: Cond): Cond => {
    switch (c.op) {
      case "and":
      case "or":
        return { op: c.op, a: fix(c.a), b: fix(c.b) };
      case "not":
        return { op: "not", x: fix(c.x) };
      case "runsInEpochLt":
        return c.node === from ? { ...c, node: to } : c;
      default:
        return c;
    }
  };
  return {
    ...g,
    nodes: g.nodes.map((n) => ({
      ...n,
      id: n.id === from ? to : n.id,
      trigger: n.trigger.kind === "after" && n.trigger.node === from ? { kind: "after", node: to } : n.trigger,
      when: n.when === null ? null : fix(n.when),
    })),
  };
}

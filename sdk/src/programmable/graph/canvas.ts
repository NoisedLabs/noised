/**
 * The visual graph editor's model: nodes with positions, and AFTER edges
 * (an edge source -> target means "target runs right after source").
 *
 * Edges are the source of truth for AFTER triggers: a node with an incoming
 * edge has trigger after(source); a node can follow only one other node.
 */
import { ProgError, type ProgErrorCode } from "../errors.js";
import { compileGraph, decompileGraph, type Graph, type GraphDecompileOptions, type GraphNode, type Recipient } from "./model.js";
import type { Address } from "../bytes.js";

export interface CanvasNode extends GraphNode {
  x: number;
  y: number;
}

export interface CanvasEdge {
  id: string;
  /** Runs first. */
  source: string;
  /** Runs right after `source`. */
  target: string;
}

export interface Canvas {
  operator: Address | null;
  recipients: Recipient[];
  tokenDecimals?: number;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export interface CanvasIssue {
  code: ProgErrorCode | "MultipleParents" | "DanglingEdge" | "SelfEdge";
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface LayoutOptions {
  positions?: Readonly<Record<string, { x: number; y: number }>>;
  /** Horizontal distance between AFTER levels (default 280). */
  colGap?: number;
  /** Vertical distance between nodes of a level (default 160). */
  rowGap?: number;
}

export const edgeId = (source: string, target: string): string => `${source}->${target}`;

function depths(nodes: readonly GraphNode[]): Map<string, number> {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const out = new Map<string, number>();
  const depth = (id: string, seen: Set<string>): number => {
    const known = out.get(id);
    if (known !== undefined) return known;
    const n = byId.get(id);
    if (!n || n.trigger.kind !== "after" || seen.has(id)) return 0;
    seen.add(id);
    const d = depth(n.trigger.node, seen) + 1;
    out.set(id, d);
    return d;
  };
  for (const n of nodes) out.set(n.id, depth(n.id, new Set()));
  return out;
}

/** Positions nodes in columns by AFTER depth (explicit positions win). */
export function autoLayout(c: Canvas, opts: LayoutOptions = {}): Canvas {
  const col = opts.colGap ?? 280;
  const row = opts.rowGap ?? 160;
  const d = depths(c.nodes);
  const rows = new Map<number, number>();
  return {
    ...c,
    nodes: c.nodes.map((n) => {
      const p = opts.positions?.[n.id];
      const level = d.get(n.id) ?? 0;
      const r = rows.get(level) ?? 0;
      rows.set(level, r + 1);
      return { ...n, x: p?.x ?? 40 + level * col, y: p?.y ?? 40 + r * row };
    }),
  };
}

/** Graph -> canvas (one node per graph node, one edge per AFTER trigger). */
export function graphToCanvas(g: Graph, opts: LayoutOptions = {}): Canvas {
  const c: Canvas = {
    operator: g.operator,
    recipients: g.recipients.map((r) => ({ ...r })),
    nodes: g.nodes.map((n) => ({ ...n, x: 0, y: 0 })),
    edges: g.nodes.flatMap((n) => (n.trigger.kind === "after" ? [{ id: edgeId(n.trigger.node, n.id), source: n.trigger.node, target: n.id }] : [])),
  };
  if (g.tokenDecimals !== undefined) c.tokenDecimals = g.tokenDecimals;
  return autoLayout(c, opts);
}

/** Everything that keeps a canvas from compiling, in plain English ([] = ready). */
export function validateCanvas(c: Canvas): CanvasIssue[] {
  const issues: CanvasIssue[] = [];
  const ids = new Set(c.nodes.map((n) => n.id));
  const parents = new Map<string, CanvasEdge[]>();
  for (const e of c.edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) {
      issues.push({ code: "DanglingEdge", message: "This link points to a step that no longer exists.", edgeId: e.id });
      continue;
    }
    if (e.source === e.target) {
      issues.push({ code: "SelfEdge", message: "A step can't follow itself.", edgeId: e.id, nodeId: e.target });
      continue;
    }
    parents.set(e.target, [...(parents.get(e.target) ?? []), e]);
  }
  for (const [target, es] of parents) {
    if (es.length > 1) issues.push({ code: "MultipleParents", message: `“${target}” can follow only one step.`, nodeId: target });
  }
  for (const n of c.nodes) {
    if (n.trigger.kind === "after" && !parents.has(n.id)) {
      issues.push({ code: "UnknownNode", message: `“${n.id}” runs “after” another step: connect it to one.`, nodeId: n.id });
    }
  }
  if (issues.length > 0) return issues;
  try {
    compileGraph(canvasGraphUnchecked(c));
  } catch (e) {
    if (!(e instanceof ProgError)) throw e;
    const nodeId = e.at.node !== undefined ? c.nodes[e.at.node]?.id : undefined;
    issues.push(nodeId !== undefined ? { code: e.code, message: e.message, nodeId } : { code: e.code, message: e.message });
  }
  return issues;
}

function canvasGraphUnchecked(c: Canvas): Graph {
  const parent = new Map(c.edges.map((e) => [e.target, e.source] as const));
  const g: Graph = {
    operator: c.operator,
    recipients: c.recipients.map((r) => ({ ...r })),
    nodes: c.nodes.map(({ x: _x, y: _y, ...n }) => {
      const p = parent.get(n.id);
      return p !== undefined ? { ...n, trigger: { kind: "after", node: p } } : { ...n };
    }),
  };
  if (c.tokenDecimals !== undefined) g.tokenDecimals = c.tokenDecimals;
  return g;
}

/** Canvas -> graph; throws ProgError with the first issue. */
export function canvasToGraph(c: Canvas): Graph {
  const issues = validateCanvas(c);
  if (issues.length > 0) {
    const i = issues[0]!;
    const code: ProgErrorCode = i.code === "MultipleParents" || i.code === "DanglingEdge" || i.code === "SelfEdge" ? "BadModel" : i.code;
    throw new ProgError(code, i.message);
  }
  return canvasGraphUnchecked(c);
}

/** Canvas -> verified PXG1 bytes (positions are not on-chain); throws ProgError with the first issue. */
export function compileCanvas(c: Canvas): Uint8Array {
  return compileGraph(canvasToGraph(c));
}

/** PXG1 bytes -> canvas: verifies, names the nodes (`ids`), then lays them out (`positions` win). */
export function decompileCanvas(bytes: Uint8Array, opts: GraphDecompileOptions & LayoutOptions = {}): Canvas {
  return graphToCanvas(decompileGraph(bytes, opts), opts);
}

/** Connects source -> target: target now runs right after source (replacing its previous link). */
export function connectNodes(c: Canvas, source: string, target: string): Canvas {
  if (source === target) throw new ProgError("BadModel", "A step can't follow itself.");
  const edges = c.edges.filter((e) => e.target !== target);
  edges.push({ id: edgeId(source, target), source, target });
  return {
    ...c,
    edges,
    nodes: c.nodes.map((n) => (n.id === target ? { ...n, trigger: { kind: "after", node: source } } : n)),
  };
}

/** Removes a link; its target goes back to running on its own (every day). */
export function disconnectEdge(c: Canvas, id: string): Canvas {
  const e = c.edges.find((x) => x.id === id);
  if (!e) return c;
  return {
    ...c,
    edges: c.edges.filter((x) => x.id !== id),
    nodes: c.nodes.map((n) => (n.id === e.target && n.trigger.kind === "after" ? { ...n, trigger: { kind: "every", secs: 86_400 } } : n)),
  };
}

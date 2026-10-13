/**
 * The Autopilot editor's operations on the SDK's canvas model (nodes with
 * positions, AFTER edges): add a step, set its trigger / conditions /
 * action / limits, rename, remove, and the short card text. Pure (no React):
 * test/autopilot-canvas.test.ts covers every operation and that the result
 * still compiles to the same bytes the SDK produces for the same graph.
 *
 * The canvas is the SDK's: edges are the truth for "runs after" (the SDK's
 * connectNodes / disconnectEdge keep triggers and edges in step).
 */
import {
  canvasToGraphOrThrow as canvasToGraph,
  connectCanvas,
  disconnectCanvas,
  formatDurationShort,
  newGraphNode,
  priceOf,
  sqrtPriceOf,
  type Action,
  type ActionKind,
  type Canvas,
  type CanvasIssue,
  type CanvasNode,
  type Cond,
  type Graph,
  type GraphNode,
  type Trigger,
} from "../../lib/programmable";
import { freeSpot, snapPoint, wouldCycle, type Point } from "./canvasModel";
import type { CanvasNodeView } from "./GraphCanvas";

export const LAMPORTS = 1_000_000_000n;

/** Graph leaves the editor offers (the closed catalogue of autopilot conditions). */
export type GraphLeafOp = "treasurySolGte" | "treasuryTokensGte" | "graduated" | "priceLte" | "priceGte" | "nowGe" | "nowLt" | "runsInEpochLt";
export type TriggerKind = Trigger["kind"];

export interface PaletteEntry<T extends string> {
  id: T;
  label: string;
  hint: string;
}

export const TRIGGER_ITEMS: readonly PaletteEntry<TriggerKind>[] = [
  { id: "every", label: "Every…", hint: "Runs on a schedule (at least every 10 minutes)." },
  { id: "after", label: "After another step", hint: "Runs once each time the step before it succeeds." },
  { id: "graduated", label: "At graduation", hint: "Runs once, after the token moves to its locked pool." },
  { id: "when", label: "Whenever…", hint: "Runs whenever its conditions hold (needs a condition)." },
];

export const CONDITION_ITEMS: readonly PaletteEntry<GraphLeafOp>[] = [
  { id: "treasurySolGte", label: "Treasury has SOL", hint: "Only when the treasury holds at least this much SOL." },
  { id: "treasuryTokensGte", label: "Treasury has tokens", hint: "Only when the treasury holds at least this many tokens." },
  { id: "graduated", label: "Has graduated", hint: "Only after the token moved to its locked pool." },
  { id: "priceLte", label: "Price at most", hint: "Only while the price has stayed at or below this for the last 15 to 30 minutes." },
  { id: "priceGte", label: "Price at least", hint: "Only while the price has stayed at or above this for the last 15 to 30 minutes." },
  { id: "nowGe", label: "From a date", hint: "Only from this date on." },
  { id: "nowLt", label: "Until a date", hint: "Only before this date." },
  { id: "runsInEpochLt", label: "Runs this period", hint: "Only while a step ran fewer times this period." },
];

export const ACTION_ITEMS: readonly PaletteEntry<ActionKind>[] = [
  { id: "buybackBurn", label: "Buy back & burn", hint: "Buys the token in its locked pool with treasury SOL and burns all of it." },
  { id: "burn", label: "Burn tokens", hint: "Burns tokens the treasury holds." },
  { id: "distributeSol", label: "Pay recipients", hint: "Pays treasury SOL to the people you list, by their shares." },
];

export const ACTION_TITLES: Record<ActionKind, string> = { buybackBurn: "Buy back & burn", burn: "Burn tokens", distributeSol: "Pay recipients" };

/** A palette item as dragged / clicked: "action:burn", "trigger:every", "condition:graduated". */
export type PaletteRef = `action:${ActionKind}` | `trigger:${TriggerKind}` | `condition:${GraphLeafOp}`;

// ------------------------------------------------------------------ ids ---

const BASE_ID: Record<ActionKind, string> = { buybackBurn: "buyback", burn: "burn", distributeSol: "pay" };

export function uniqueId(c: Canvas, base: string): string {
  const clean = base.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^[^A-Za-z_]+/, "") || "step";
  const taken = new Set(c.nodes.map((n) => n.id));
  if (!taken.has(clean)) return clean;
  for (let i = 2; ; i++) if (!taken.has(`${clean}${i}`)) return `${clean}${i}`;
}

export function emptyCanvas(decimals: number): Canvas {
  return { operator: null, recipients: [], tokenDecimals: decimals, nodes: [], edges: [] };
}

// -------------------------------------------------------------- defaults ---

function defaultAction(kind: ActionKind, decimals: number): Action {
  if (kind === "buybackBurn") return { kind, maxInLamports: LAMPORTS / 4n, maxPremiumBps: 300 };
  if (kind === "burn") return { kind, maxTokens: 1_000_000n * 10n ** BigInt(decimals) };
  return { kind, maxLamports: LAMPORTS / 10n };
}

function defaultTrigger(kind: ActionKind): Trigger {
  return kind === "distributeSol" ? { kind: "every", secs: 7 * 86_400 } : { kind: "every", secs: 86_400 };
}

function defaultWhen(kind: ActionKind): Cond | null {
  if (kind === "buybackBurn") return { op: "and", a: { op: "graduated" }, b: { op: "treasurySolGte", lamports: LAMPORTS / 2n } };
  if (kind === "distributeSol") return { op: "treasurySolGte", lamports: LAMPORTS / 5n };
  return null;
}

export function defaultLeaf(op: GraphLeafOp, self: string, decimals: number, now: number): Cond {
  switch (op) {
    case "treasurySolGte":
      return { op, lamports: LAMPORTS };
    case "treasuryTokensGte":
      return { op, amount: { raw: 1_000n * 10n ** BigInt(decimals) } };
    case "graduated":
      return { op };
    case "priceLte":
    case "priceGte":
      return { op, price: { sqrtPriceQ64: sqrtPriceOf("0.000001", decimals) } };
    case "nowGe":
    case "nowLt":
      return { op, unix: BigInt(now + 7 * 86_400) };
    case "runsInEpochLt":
      return { op, node: self, n: 2 };
  }
}

// ------------------------------------------------------------ operations ---

function mapNode(c: Canvas, id: string, f: (n: CanvasNode) => CanvasNode): Canvas {
  return { ...c, nodes: c.nodes.map((n) => (n.id === id ? f(n) : n)) };
}

/** A new step with the SDK's defaults (budget = per-run max x runs, one-day period) at a free spot. */
export function addStep(c: Canvas, kind: ActionKind, at: Point | null, decimals: number): { canvas: Canvas; id: string } {
  const id = uniqueId(c, BASE_ID[kind]);
  const node: GraphNode = newGraphNode(id, defaultTrigger(kind), defaultAction(kind, decimals), defaultWhen(kind), decimals);
  const laid = c.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y, lines: 4 }));
  const p = at !== null ? snapPoint(at) : freeSpot(laid, 4);
  return { canvas: { ...c, nodes: [...c.nodes, { ...node, x: p.x, y: p.y }] }, id };
}

export function moveStep(c: Canvas, id: string, p: Point): Canvas {
  const s = snapPoint(p);
  return mapNode(c, id, (n) => ({ ...n, x: s.x, y: s.y }));
}

export function patchStep(c: Canvas, id: string, patch: Partial<Omit<GraphNode, "id" | "trigger">>): Canvas {
  return mapNode(c, id, (n) => ({ ...n, ...patch }));
}

/** Sets a step's trigger. "after" goes through the SDK's connect (it refuses nothing; the editor checks loops first). */
export function setTrigger(c: Canvas, id: string, t: Trigger): { canvas: Canvas; error: string | null } {
  if (t.kind === "after") return connectSteps(c, t.node, id);
  let next = c;
  for (const e of c.edges.filter((x) => x.target === id)) next = disconnectCanvas(next, e.id);
  return { canvas: mapNode(next, id, (n) => ({ ...n, trigger: t })), error: null };
}

/** "Target runs after source", unless that would make a loop (the chain refuses cyclic graphs). */
export function connectSteps(c: Canvas, source: string, target: string): { canvas: Canvas; error: string | null } {
  if (source === target) return { canvas: c, error: "A step can't run after itself." };
  const edges = c.edges.map((e) => ({ from: e.source, to: e.target }));
  if (wouldCycle(edges, source, target)) return { canvas: c, error: "That would make a loop: a step would wait for itself. The chain refuses loops." };
  return { canvas: connectCanvas(c, source, target), error: null };
}

export function disconnectSteps(c: Canvas, source: string, target: string): Canvas {
  const e = c.edges.find((x) => x.source === source && x.target === target);
  return e ? disconnectCanvas(c, e.id) : c;
}

/** Removes a step; steps that ran after it go back to their own schedule. */
export function removeStep(c: Canvas, id: string): Canvas {
  let next = c;
  for (const e of c.edges.filter((x) => x.source === id || x.target === id)) next = disconnectCanvas(next, e.id);
  return { ...next, nodes: next.nodes.filter((n) => n.id !== id) };
}

/** Renames a step everywhere it is referenced (links, "after" triggers, run-count conditions). */
export function renameStep(c: Canvas, from: string, to: string): { canvas: Canvas; error: string | null } {
  if (from === to) return { canvas: c, error: null };
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(to)) return { canvas: c, error: "Names use letters, digits, _ and -, and start with a letter." };
  if (c.nodes.some((n) => n.id === to)) return { canvas: c, error: `There is already a step called "${to}".` };
  const swapCond = (x: Cond | null): Cond | null => {
    if (x === null) return null;
    switch (x.op) {
      case "and":
      case "or":
        return { op: x.op, a: swapCond(x.a) as Cond, b: swapCond(x.b) as Cond };
      case "not":
        return { op: "not", x: swapCond(x.x) as Cond };
      case "runsInEpochLt":
        return x.node === from ? { ...x, node: to } : x;
      default:
        return x;
    }
  };
  const nodes = c.nodes.map((n) => ({
    ...n,
    id: n.id === from ? to : n.id,
    trigger: n.trigger.kind === "after" && n.trigger.node === from ? { kind: "after" as const, node: to } : n.trigger,
    when: swapCond(n.when),
  }));
  const edges = c.edges.map((e) => {
    const source = e.source === from ? to : e.source;
    const target = e.target === from ? to : e.target;
    return { id: `${source}->${target}`, source, target };
  });
  return { canvas: { ...c, nodes, edges }, error: null };
}

// ------------------------------------------------------------ conditions ---

/** A condition as an AND chain of leaves, or null when it uses or / not (then only code can edit it). */
export function conditionChain(c: Cond | null): Cond[] | null {
  if (c === null || c.op === "true") return [];
  if (c.op === "and") {
    const a = conditionChain(c.a);
    const b = conditionChain(c.b);
    return a === null || b === null ? null : [...a, ...b];
  }
  if (c.op === "or" || c.op === "not" || c.op === "false") return null;
  return [c];
}

/** Leaves -> left-leaning AND (null for none). */
export function chainCondition(leaves: readonly Cond[]): Cond | null {
  if (leaves.length === 0) return null;
  return leaves.slice(1).reduce<Cond>((acc, x) => ({ op: "and", a: acc, b: x }), leaves[0] as Cond);
}

export function addCondition(c: Canvas, id: string, op: GraphLeafOp, now: number): { canvas: Canvas; error: string | null } {
  const n = c.nodes.find((x) => x.id === id);
  if (!n) return { canvas: c, error: "Select a step first." };
  const chain = conditionChain(n.when);
  if (chain === null) return { canvas: c, error: "This step's condition is written in code (it uses or / not). Edit it in the Code tab." };
  const leaf = defaultLeaf(op, id, c.tokenDecimals ?? 6, now);
  return { canvas: patchStep(c, id, { when: chainCondition([...chain, leaf]) }), error: null };
}

// ------------------------------------------------------------------ text ---

const sol = (lamports: bigint): string => `${trimNum(Number(lamports) / 1e9)} SOL`;
const tokens = (raw: bigint, decimals: number): string => `${compact(Number(raw) / 10 ** decimals)} tokens`;

function trimNum(v: number): string {
  return v.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function compact(v: number): string {
  if (v >= 1e9) return `${trimNum(v / 1e9)}B`;
  if (v >= 1e6) return `${trimNum(v / 1e6)}M`;
  if (v >= 1e4) return `${trimNum(v / 1e3)}K`;
  return trimNum(v);
}

export function priceText(sqrtPriceQ64: bigint, decimals: number): string {
  const p = priceOf(sqrtPriceQ64, decimals);
  if (!(p > 0)) return "0";
  return p >= 0.001 ? trimNum(p) : p.toExponential(2);
}

/**
 * How close (in percent of price) a price condition's limit may sit to today's price before the editor warns.
 * One trade across the limit and back every 15 minutes keeps a price condition false (never true), and the
 * closer the limit, the cheaper that is (follow-up review of the price-condition fix, L-1; THREAT_MODEL R37).
 */
export const PRICE_NEAR_PCT = 5;

/** A price condition's limit as a sqrt price (Q64.64), or null when it is not a valid price. */
export function condSqrtPrice(c: Extract<Cond, { op: "priceLte" | "priceGte" }>, decimals: number): bigint | null {
  if ("sqrtPriceQ64" in c.price) return c.price.sqrtPriceQ64 > 0n ? c.price.sqrtPriceQ64 : null;
  try {
    const s = sqrtPriceOf(c.price.sol, decimals);
    return s > 0n ? s : null;
  } catch {
    return null;
  }
}

/**
 * Whether a limit (sqrt price, Q64.64) is within PRICE_NEAR_PCT of any of today's prices (sqrt prices; zeros,
 * unknown, are skipped). Prices are the squares of sqrt prices, so the price ratio is (limit / now)^2.
 */
export function priceNearNow(limitSqrt: bigint, now: readonly bigint[]): boolean {
  if (limitSqrt <= 0n) return false;
  return now.some((n) => {
    if (n <= 0n) return false;
    const r = Number(limitSqrt) / Number(n);
    return Math.abs(r * r - 1) * 100 <= PRICE_NEAR_PCT;
  });
}

export function dateText(unix: bigint): string {
  const d = new Date(Number(unix) * 1000);
  return Number.isNaN(d.getTime()) ? String(unix) : d.toISOString().slice(0, 10);
}

/** Every 1 day -> "every day"; 7 days -> "every 7d". */
export function periodText(secs: number): string {
  if (secs === 86_400) return "day";
  if (secs === 3_600) return "hour";
  if (secs === 7 * 86_400) return "week";
  return formatDurationShort(secs);
}

export function triggerText(t: Trigger, indexOf: (id: string) => number): string {
  switch (t.kind) {
    case "every":
      return `every ${periodText(t.secs)}`;
    case "after":
      return `after step ${indexOf(t.node)}`;
    case "graduated":
      return "at graduation";
    case "when":
      return "whenever ready";
  }
}

/** Short text of one graph leaf (card lines and the inspector's chips). */
export function leafText(c: Cond, decimals: number, indexOf: (id: string) => number): string {
  switch (c.op) {
    case "treasurySolGte":
      return `treasury ≥ ${sol(c.lamports)}`;
    case "treasuryTokensGte":
      return `treasury ≥ ${"raw" in c.amount ? tokens(c.amount.raw, decimals) : `${c.amount.tokens} tokens`}`;
    case "graduated":
      return "graduated";
    case "priceLte":
      return `price ≤ ${"sqrtPriceQ64" in c.price ? priceText(c.price.sqrtPriceQ64, decimals) : c.price.sol} SOL`;
    case "priceGte":
      return `price ≥ ${"sqrtPriceQ64" in c.price ? priceText(c.price.sqrtPriceQ64, decimals) : c.price.sol} SOL`;
    case "nowGe":
      return `from ${dateText(c.unix)}`;
    case "nowLt":
      return `until ${dateText(c.unix)}`;
    case "runsInEpochLt":
      return `step ${indexOf(c.node)} ran < ${c.n}×`;
    case "true":
      return "always";
    case "false":
      return "never";
    case "and":
      return `${leafText(c.a, decimals, indexOf)} and ${leafText(c.b, decimals, indexOf)}`;
    case "or":
      return `(${leafText(c.a, decimals, indexOf)} or ${leafText(c.b, decimals, indexOf)})`;
    case "not":
      return `not ${leafText(c.x, decimals, indexOf)}`;
    default:
      return c.op;
  }
}

export function actionText(a: Action, decimals: number): string {
  switch (a.kind) {
    case "buybackBurn":
      return `buy ≤ ${sol(a.maxInLamports)}, +${a.maxPremiumBps / 100}% max`;
    case "burn":
      return `burn ≤ ${tokens(a.maxTokens, decimals)}`;
    case "distributeSol":
      return `pay ≤ ${sol(a.maxLamports)}`;
  }
}

export function budgetText(n: GraphNode, decimals: number): string {
  const amount = n.action.kind === "burn" ? tokens(n.budgetPerEpoch, decimals) : sol(n.budgetPerEpoch);
  return `${amount}/${periodText(n.epochSecs)} · ${n.maxRunsPerEpoch}×`;
}

const GLYPH: Record<ActionKind, CanvasNodeView["glyph"]> = { buybackBurn: "buyback", burn: "burn", distributeSol: "pay" };

/** The canvas cards: step number, title, four short lines, badges and what a screen reader hears. */
export function nodeViews(c: Canvas, issues: readonly CanvasIssue[], pulse: string | null = null): CanvasNodeView[] {
  const dec = c.tokenDecimals ?? 6;
  const indexOf = (id: string): number => c.nodes.findIndex((n) => n.id === id) + 1;
  return c.nodes.map((n, i) => {
    const mine = issues.filter((x) => x.nodeId === n.id);
    const trig = triggerText(n.trigger, indexOf);
    const cond = n.when === null ? "always" : leafText(n.when, dec, indexOf);
    const act = actionText(n.action, dec);
    const cap = budgetText(n, dec);
    const badges = [...(n.operatorGated ? ["AI"] : []), ...(mine.length > 0 ? ["!"] : [])];
    return {
      id: n.id,
      x: n.x,
      y: n.y,
      index: i + 1,
      glyph: GLYPH[n.action.kind],
      title: ACTION_TITLES[n.action.kind],
      subtitle: n.id,
      lines: [
        { k: "When", v: trig },
        { k: "If", v: cond },
        { k: "Do", v: act },
        { k: "Cap", v: cap },
      ],
      badges,
      tone: mine.length > 0 ? "warn" : undefined,
      pulse: pulse === n.id,
      describe: `Step ${i + 1}, ${n.id}: ${ACTION_TITLES[n.action.kind]}, ${trig}, if ${cond}, ${act}, ${cap}${n.operatorGated ? ", the operator decides" : ""}${mine.length > 0 ? `. Problem: ${mine[0]?.message ?? ""}` : ""}`,
    };
  });
}

/** The graph a valid canvas stands for, or null (the issues say why). */
export function graphOrNull(c: Canvas): Graph | null {
  try {
    return canvasToGraph(c);
  } catch {
    return null;
  }
}

/** Positions of a canvas by node id (kept when the code is edited). */
export function positionsOf(c: Canvas): Record<string, { x: number; y: number }> {
  return Object.fromEntries(c.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
}

/** Steps a step may run after: every other step that would not make a loop. */
export function afterChoices(c: Canvas, id: string): string[] {
  const edges = c.edges.map((e) => ({ from: e.source, to: e.target }));
  return c.nodes.map((n) => n.id).filter((other) => other !== id && !wouldCycle(edges, other, id));
}

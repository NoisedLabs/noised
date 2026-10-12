/**
 * Geometry of the Autopilot graph canvas (pure: no React, no DOM), so the
 * editor's behaviour is unit-tested (test/autopilot-canvas.test.ts):
 *   - node positions live in "world" pixels and always snap to the pixel grid;
 *   - the view is a pan (world offset) and a zoom, clamped to sane limits;
 *   - an edge runs from a step's bottom port to the next step's top port as
 *     an orthogonal (pixel) path;
 *   - an AFTER edge that would close a loop is refused before it is drawn
 *     (the chain refuses cyclic graphs: PXG1 verifier).
 */

/** The pixel grid every node snaps to (world px). */
export const GRID = 16;
/** Node card width (world px). */
export const NODE_W = 256;
const NODE_HEAD = 48;
const NODE_LINE = 24;
const NODE_PAD = 14;
export const ZOOM_MIN = 0.25;
/** Fitting a very wide graph may go below ZOOM_MIN (the whole graph must fit), never below this. */
const FIT_MIN = 0.1;
export const ZOOM_MAX = 2;

export interface Point {
  x: number;
  y: number;
}

export interface View {
  /** World point shown at the canvas's top-left corner. */
  x: number;
  y: number;
  zoom: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LaidNode {
  id: string;
  x: number;
  y: number;
  /** Number of detail lines the card shows (its height follows). */
  lines: number;
}

export interface Edge {
  from: string;
  to: string;
}

/** Round to the nearest grid point. */
export function snap(v: number): number {
  return Math.round(v / GRID) * GRID;
}

export function snapPoint(p: Point): Point {
  return { x: snap(p.x), y: snap(p.y) };
}

/** Card height for `lines` detail lines: a whole number of grid cells, so ports sit on the grid too. */
export function nodeHeight(lines: number): number {
  const raw = NODE_HEAD + Math.max(0, lines) * NODE_LINE + NODE_PAD;
  return Math.ceil(raw / GRID) * GRID;
}

export function nodeBox(n: LaidNode): Box {
  return { x: n.x, y: n.y, w: NODE_W, h: nodeHeight(n.lines) };
}

/** Output port (bottom centre) and input port (top centre) of a node. */
export function outPort(n: LaidNode): Point {
  return { x: n.x + NODE_W / 2, y: n.y + nodeHeight(n.lines) };
}

export function inPort(n: LaidNode): Point {
  return { x: n.x + NODE_W / 2, y: n.y };
}

/**
 * Orthogonal path from an output port to an input port: down, across at the
 * midpoint, down. When the target sits above the source the path loops
 * around the side so it never crosses either card.
 */
export function edgePath(a: Point, b: Point): string {
  const lead = GRID;
  if (b.y - a.y >= lead * 2) {
    const midY = snap((a.y + b.y) / 2);
    return `M${a.x} ${a.y}V${midY}H${b.x}V${b.y}`;
  }
  const side = Math.max(a.x, b.x) + NODE_W / 2 + lead * 2;
  return `M${a.x} ${a.y}V${a.y + lead}H${side}V${b.y - lead}H${b.x}V${b.y}`;
}

/** The point an arrowhead sits on and which way it points (always down into the input port). */
export function arrowHead(b: Point, size = 6): string {
  return `M${b.x - size} ${b.y - size}H${b.x + size}L${b.x} ${b.y}Z`;
}

export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

/** Screen (canvas-relative) point -> world point. */
export function toWorld(view: View, screen: Point): Point {
  return { x: view.x + screen.x / view.zoom, y: view.y + screen.y / view.zoom };
}

/** World point -> screen (canvas-relative) point. */
export function toScreen(view: View, world: Point): Point {
  return { x: (world.x - view.x) * view.zoom, y: (world.y - view.y) * view.zoom };
}

/** Zoom to `zoom` keeping the world point under `anchor` (a screen point) where it is. */
export function zoomAround(view: View, zoom: number, anchor: Point): View {
  // A fitted view may sit below ZOOM_MIN: zooming further out stays there instead of jumping in.
  const floor = Math.min(ZOOM_MIN, view.zoom);
  const z = Number.isFinite(zoom) ? Math.min(ZOOM_MAX, Math.max(floor, zoom)) : view.zoom;
  const w = toWorld(view, anchor);
  return { x: w.x - anchor.x / z, y: w.y - anchor.y / z, zoom: z };
}

/** Pan by a screen-pixel delta (dragging the background right moves the world right). */
export function panBy(view: View, dx: number, dy: number): View {
  return { ...view, x: view.x - dx / view.zoom, y: view.y - dy / view.zoom };
}

/** Bounding box of every node (null when there are none). */
export function boundsOf(nodes: readonly LaidNode[]): Box | null {
  if (nodes.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const n of nodes) {
    const b = nodeBox(n);
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * The view that shows every node inside a `width` x `height` canvas with a margin (zoom never above 1), centred in
 * the area left once `top` (default: the margin) is kept clear at the top, e.g. for a toolbar.
 */
export function fitView(nodes: readonly LaidNode[], width: number, height: number, margin = 40, top = margin): View {
  const b = boundsOf(nodes);
  if (b === null || width <= 0 || height <= 0) return { x: -margin, y: -top, zoom: 1 };
  const availW = Math.max(1, width - margin * 2);
  const availH = Math.max(1, height - margin - top);
  const zoom = Math.max(FIT_MIN, Math.min(1, availW / b.w, availH / b.h));
  const cy = top + availH / 2;
  return { x: b.x + b.w / 2 - width / 2 / zoom, y: b.y + b.h / 2 - cy / zoom, zoom };
}

/** Whether two boxes overlap (with a one-cell gap counted as overlap). */
function overlaps(a: Box, b: Box): boolean {
  const g = GRID;
  return a.x < b.x + b.w + g && b.x < a.x + a.w + g && a.y < b.y + b.h + g && b.y < a.y + a.h + g;
}

/**
 * A free grid position for a new card of `lines` lines near `near` (default: under the lowest card):
 * scans right then down so new steps never land on top of others.
 */
export function freeSpot(nodes: readonly LaidNode[], lines: number, near?: Point): Point {
  const h = nodeHeight(lines);
  const b = boundsOf(nodes);
  const start = near !== undefined ? snapPoint(near) : b === null ? { x: 0, y: 0 } : { x: snap(b.x), y: snap(b.y + b.h + GRID * 3) };
  for (let row = 0; row < 40; row++) {
    for (let col = 0; col < 6; col++) {
      const p = { x: start.x + col * (NODE_W + GRID * 3), y: start.y + row * GRID * 4 };
      const box = { x: p.x, y: p.y, w: NODE_W, h };
      if (!nodes.some((n) => overlaps(box, nodeBox(n)))) return p;
    }
  }
  return start;
}

/** Move a node by whole grid cells (keyboard: arrows move one cell, Shift+arrows four). */
export function nudge(p: Point, dx: number, dy: number, cells = 1): Point {
  return { x: snap(p.x) + dx * GRID * cells, y: snap(p.y) + dy * GRID * cells };
}

/**
 * Whether adding `from -> to` would close a loop (or connect a node to itself).
 * Edges mean "`to` runs after `from`"; the chain refuses cyclic AFTER chains.
 */
export function wouldCycle(edges: readonly Edge[], from: string, to: string): boolean {
  if (from === to) return true;
  // A loop appears iff `from` is already reachable from `to`.
  const next = new Map<string, string[]>();
  for (const e of edges) {
    if (e.to === to) continue; // `to` keeps one trigger: its old incoming edge is replaced
    const list = next.get(e.from) ?? [];
    list.push(e.to);
    next.set(e.from, list);
  }
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (cur === from) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const n of next.get(cur) ?? []) stack.push(n);
  }
  return false;
}

/**
 * A simple top-down layout (one row per AFTER depth) used when a graph comes from code or a template and has no
 * saved positions.
 */
export function autoLayout(ids: readonly string[], edges: readonly Edge[], linesOf: (id: string) => number): Map<string, Point> {
  const parent = new Map<string, string>();
  for (const e of edges) parent.set(e.to, e.from);
  const depth = new Map<string, number>();
  const depthOf = (id: string, guard = 0): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    const p = parent.get(id);
    const d = p === undefined || guard > ids.length ? 0 : depthOf(p, guard + 1) + 1;
    depth.set(id, d);
    return d;
  };
  const rows = new Map<number, string[]>();
  for (const id of ids) {
    const d = depthOf(id);
    const row = rows.get(d) ?? [];
    row.push(id);
    rows.set(d, row);
  }
  const out = new Map<string, Point>();
  let y = 0;
  const sorted = [...rows.keys()].sort((a, b) => a - b);
  for (const d of sorted) {
    const row = rows.get(d) ?? [];
    let tallest = 0;
    row.forEach((id, i) => {
      out.set(id, { x: i * (NODE_W + GRID * 4), y });
      tallest = Math.max(tallest, nodeHeight(linesOf(id)));
    });
    y += tallest + GRID * 5;
  }
  return out;
}

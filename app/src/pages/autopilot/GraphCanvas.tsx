/**
 * The Autopilot graph canvas: step cards on a pixel grid, joined by "runs
 * after" edges. Pure presentation over a list of positioned cards; the page
 * owns the graph and decides what a move, a connection or a delete means.
 *
 *   - drag a card to move it (it snaps to the grid); drag from a card's
 *     bottom port onto another card to make that card run after it;
 *   - drag the background to pan; Ctrl/⌘ + wheel or the buttons zoom; "Fit"
 *     shows everything; the minimap (shown while a card is out of view)
 *     jumps anywhere;
 *   - auto-fit: until the viewer pans or zooms, the view keeps every card in
 *     sight whenever the canvas is shown, resized, or gains or loses a card
 *     (a hidden tab measures 0 x 0, so the fit happens when it opens); "Fit"
 *     turns it back on;
 *   - keyboard: Tab reaches every card; arrows move the focused card one
 *     grid cell (Shift: four); Enter selects; C then Enter on another card
 *     connects; Delete removes; on the canvas itself arrows pan, + and -
 *     zoom and 0 fits. Every change is announced.
 *
 * CSP: no inline style injection. Positions are React style props (CSSOM)
 * and CSS custom properties; edges and the minimap are SVG drawn by React.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

import {
  arrowHead,
  edgePath,
  fitView,
  GRID,
  inPort,
  nodeBox,
  nodeHeight,
  NODE_W,
  nudge,
  outPort,
  panBy,
  snapPoint,
  toWorld,
  zoomAround,
  type Edge,
  type LaidNode,
  type Point,
  type View,
} from "./canvasModel";

export interface CanvasNodeView {
  id: string;
  x: number;
  y: number;
  /** Step number shown on the card (1-based). */
  index: number;
  /** Action family: picks the card's pixel glyph. */
  glyph: "buyback" | "burn" | "pay" | "unknown";
  title: string;
  /** The step's name, shown small after the title. */
  subtitle?: string | undefined;
  lines: readonly { k: string; v: string }[];
  badges?: readonly string[] | undefined;
  tone?: "ok" | "warn" | "danger" | undefined;
  /** What a screen reader hears for the card. */
  describe: string;
  /** Lit up (e.g. the step that ran last in the simulation). */
  pulse?: boolean | undefined;
}

export interface GraphCanvasProps {
  nodes: readonly CanvasNodeView[];
  edges: readonly Edge[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** Read-only canvases (the token page, a frozen graph) can be looked at but not changed. */
  readOnly?: boolean | undefined;
  onMove?: ((id: string, to: Point) => void) | undefined;
  /** Returns an error to announce when the connection is refused (e.g. it would make a loop), else null. */
  onConnect?: ((from: string, to: string) => string | null) | undefined;
  onDeleteNode?: ((id: string) => void) | undefined;
  onDeleteEdge?: ((edge: Edge) => void) | undefined;
  /** A palette item dropped on the canvas (desktop drag and drop); `target` is the card under it, if any. */
  onDropItem?: ((item: string, at: Point, target: string | null) => void) | undefined;
  label: string;
  className?: string | undefined;
}

/** The mime type palette items are dragged with. */
export const PALETTE_MIME = "application/x-noised-autopilot";

type Gesture =
  | { kind: "pan"; startX: number; startY: number; view: View; moved: boolean }
  | { kind: "drag"; id: string; offset: Point; start: Point; moved: boolean; pointerStart: Point }
  | { kind: "connect"; from: string; at: Point };

const edgeKey = (e: Edge): string => `${e.from}->${e.to}`;
/** Fit margins (screen px): the top one keeps cards clear of the zoom toolbar. */
const FIT_MARGIN = 32;
const FIT_TOP = 60;

export function GraphCanvas({
  nodes,
  edges,
  selected,
  onSelect,
  readOnly = false,
  onMove,
  onConnect,
  onDeleteNode,
  onDeleteEdge,
  onDropItem,
  label,
  className = "",
}: GraphCanvasProps): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [size, setSize] = useState({ w: 800, h: 480 });
  const [view, setView] = useState<View>({ x: -40, y: -40, zoom: 1 });
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [dragPos, setDragPos] = useState<{ id: string; p: Point } | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  // Auto-fit until the viewer pans or zooms by hand (Fit turns it back on).
  const auto = useRef(true);
  const cardRefs = useRef(new Map<string, HTMLDivElement>());

  const laid: LaidNode[] = useMemo(
    () => nodes.map((n) => (dragPos !== null && dragPos.id === n.id ? { id: n.id, x: dragPos.p.x, y: dragPos.p.y, lines: n.lines.length } : { id: n.id, x: n.x, y: n.y, lines: n.lines.length })),
    [nodes, dragPos],
  );
  const byId = useMemo(() => new Map(laid.map((n) => [n.id, n])), [laid]);
  const titleOf = useCallback((id: string): string => nodes.find((n) => n.id === id)?.title ?? id, [nodes]);
  const indexOf = useCallback((id: string): number => nodes.find((n) => n.id === id)?.index ?? 0, [nodes]);

  // Track the canvas size; keep the graph fitted while auto-fit is on.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.max(1, r.width), h: Math.max(1, r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Refit when the canvas is shown or resized, or a card is added or removed (not when one is dragged: same ids).
  const idsKey = nodes.map((n) => n.id).join("|");
  const laidRef = useRef(laid);
  laidRef.current = laid;
  useEffect(() => {
    if (!auto.current || laidRef.current.length === 0 || size.w <= 1 || size.h <= 1) return;
    setView(fitView(laidRef.current, size.w, size.h, FIT_MARGIN, FIT_TOP));
  }, [idsKey, size.w, size.h]);
  const manual = (): void => {
    auto.current = false;
  };
  const fit = (): void => {
    auto.current = true;
    setView(fitView(laid, size.w, size.h, FIT_MARGIN, FIT_TOP));
  };

  // Ctrl/⌘ + wheel (and trackpad pinch, which browsers report the same way) zooms around the pointer. A plain
  // wheel keeps scrolling the page. Non-passive so the browser's own page zoom does not run as well.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      auto.current = false;
      const r = el.getBoundingClientRect();
      setView((v) => zoomAround(v, v.zoom * Math.exp(-e.deltaY * 0.0022), { x: e.clientX - r.left, y: e.clientY - r.top }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const local = (e: { clientX: number; clientY: number }): Point => {
    const r = ref.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };

  const hitNode = (world: Point): string | null => {
    for (let i = laid.length - 1; i >= 0; i--) {
      const n = laid[i];
      if (!n) continue;
      const b = nodeBox(n);
      if (world.x >= b.x && world.x <= b.x + b.w && world.y >= b.y - GRID && world.y <= b.y + b.h) return n.id;
    }
    return null;
  };

  const connect = (from: string, to: string): void => {
    if (!onConnect) return;
    const problem = onConnect(from, to);
    setAnnounce(problem ?? `Step ${indexOf(to)} now runs after step ${indexOf(from)}.`);
  };

  // ------------------------------------------------------------- pointer ---

  const onBackgroundDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    ref.current?.setPointerCapture(e.pointerId);
    setGesture({ kind: "pan", startX: e.clientX, startY: e.clientY, view, moved: false });
  };

  const onCardDown = (e: PointerEvent<HTMLDivElement>, id: string): void => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const n = byId.get(id);
    if (!n) return;
    const w = toWorld(view, local(e));
    ref.current?.setPointerCapture(e.pointerId);
    setGesture({ kind: "drag", id, offset: { x: w.x - n.x, y: w.y - n.y }, start: { x: n.x, y: n.y }, moved: false, pointerStart: { x: e.clientX, y: e.clientY } });
  };

  const onPortDown = (e: PointerEvent<HTMLElement>, id: string): void => {
    if (e.button !== 0 || readOnly) return;
    e.stopPropagation();
    ref.current?.setPointerCapture(e.pointerId);
    setGesture({ kind: "connect", from: id, at: toWorld(view, local(e)) });
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (gesture === null) return;
    if (gesture.kind === "pan") {
      const dx = e.clientX - gesture.startX;
      const dy = e.clientY - gesture.startY;
      if (!gesture.moved && Math.hypot(dx, dy) < 3) return;
      auto.current = false;
      setView(panBy(gesture.view, dx, dy));
      if (!gesture.moved) setGesture({ ...gesture, moved: true });
    } else if (gesture.kind === "drag") {
      if (readOnly) return;
      const moved = gesture.moved || Math.hypot(e.clientX - gesture.pointerStart.x, e.clientY - gesture.pointerStart.y) >= 3;
      if (!moved) return;
      const w = toWorld(view, local(e));
      setDragPos({ id: gesture.id, p: snapPoint({ x: w.x - gesture.offset.x, y: w.y - gesture.offset.y }) });
      if (!gesture.moved) setGesture({ ...gesture, moved: true });
    } else {
      setGesture({ ...gesture, at: toWorld(view, local(e)) });
    }
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>): void => {
    const g = gesture;
    setGesture(null);
    if (ref.current?.hasPointerCapture(e.pointerId)) ref.current.releasePointerCapture(e.pointerId);
    if (g === null) return;
    if (g.kind === "pan") {
      if (!g.moved) {
        onSelect(null);
        setSelectedEdge(null);
      }
    } else if (g.kind === "drag") {
      const p = dragPos?.id === g.id ? dragPos.p : null;
      setDragPos(null);
      if (g.moved && p !== null && (p.x !== g.start.x || p.y !== g.start.y)) {
        onMove?.(g.id, p);
        setAnnounce(`Moved step ${indexOf(g.id)}.`);
      } else if (!g.moved) {
        onSelect(g.id);
        setSelectedEdge(null);
      }
    } else {
      const target = hitNode(toWorld(view, local(e)));
      if (target !== null && target !== g.from) connect(g.from, target);
    }
  };

  // ------------------------------------------------------------ keyboard ---

  const onCanvasKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget) return;
    const step = 48;
    const by = (f: (v: View) => View): void => {
      manual();
      setView(f);
    };
    if (e.key === "ArrowLeft") by((v) => panBy(v, step, 0));
    else if (e.key === "ArrowRight") by((v) => panBy(v, -step, 0));
    else if (e.key === "ArrowUp") by((v) => panBy(v, 0, step));
    else if (e.key === "ArrowDown") by((v) => panBy(v, 0, -step));
    else if (e.key === "+" || e.key === "=") by((v) => zoomAround(v, v.zoom * 1.2, { x: size.w / 2, y: size.h / 2 }));
    else if (e.key === "-" || e.key === "_") by((v) => zoomAround(v, v.zoom / 1.2, { x: size.w / 2, y: size.h / 2 }));
    else if (e.key === "0") fit();
    else if (e.key === "Escape") {
      // Nothing to cancel: let the page use Escape (the editor's full screen closes with it).
      if (selected === null && selectedEdge === null && connectFrom === null) return;
      onSelect(null);
      setSelectedEdge(null);
      setConnectFrom(null);
    } else if ((e.key === "Delete" || e.key === "Backspace") && selectedEdge !== null && !readOnly) {
      const edge = edges.find((x) => edgeKey(x) === selectedEdge);
      if (edge) {
        onDeleteEdge?.(edge);
        setAnnounce(`Step ${indexOf(edge.to)} no longer runs after step ${indexOf(edge.from)}.`);
      }
      setSelectedEdge(null);
    } else return;
    e.preventDefault();
  };

  const onCardKey = (e: KeyboardEvent<HTMLDivElement>, id: string): void => {
    const n = byId.get(id);
    if (!n) return;
    const dirs: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const d = dirs[e.key];
    if (d !== undefined && !readOnly) {
      const p = nudge(n, d[0], d[1], e.shiftKey ? 4 : 1);
      onMove?.(id, p);
      setAnnounce(`Step ${indexOf(id)} moved.`);
    } else if (e.key === "Enter" || e.key === " ") {
      if (connectFrom !== null && connectFrom !== id) {
        connect(connectFrom, id);
        setConnectFrom(null);
      } else {
        onSelect(id);
        setSelectedEdge(null);
      }
    } else if ((e.key === "c" || e.key === "C") && !readOnly && onConnect) {
      setConnectFrom(id);
      setAnnounce(`Connecting from step ${indexOf(id)}: move to another step and press Enter. Escape cancels.`);
    } else if (e.key === "Escape") {
      setConnectFrom(null);
      onSelect(null);
    } else if ((e.key === "Delete" || e.key === "Backspace") && !readOnly && onDeleteNode) {
      onDeleteNode(id);
      setAnnounce(`Removed step ${indexOf(id)}.`);
      ref.current?.focus();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  // Keep keyboard focus on a card while it moves (React re-renders it in place, so focus stays).
  useEffect(() => {
    if (selected === null) return;
    const el = cardRefs.current.get(selected);
    if (el && document.activeElement !== el && ref.current?.contains(document.activeElement) !== true) el.focus({ preventScroll: true });
  }, [selected]);

  // ------------------------------------------------------------- drawing ---

  const worldStyle = { transform: `translate(${-view.x * view.zoom}px, ${-view.y * view.zoom}px) scale(${view.zoom})` } as CSSProperties;
  const gridStyle = {
    "--gs": `${GRID * view.zoom}px`,
    "--gx": `${-view.x * view.zoom}px`,
    "--gy": `${-view.y * view.zoom}px`,
  } as CSSProperties;

  const connectLine = gesture?.kind === "connect" ? { from: byId.get(gesture.from), at: gesture.at } : null;
  // The minimap only helps while something is out of view.
  const allInView = useMemo(() => {
    const vx1 = view.x + size.w / view.zoom;
    const vy1 = view.y + size.h / view.zoom;
    return laid.every((n) => {
      const b = nodeBox(n);
      return b.x >= view.x && b.y >= view.y - GRID && b.x + b.w <= vx1 && b.y + b.h <= vy1;
    });
  }, [laid, view, size]);

  return (
    <div className={`ap-canvas-wrap ${className}`}>
      <div
        ref={ref}
        className="ap-canvas"
        data-gesture={gesture?.kind ?? undefined}
        data-readonly={readOnly ? "" : undefined}
        style={gridStyle}
        tabIndex={0}
        role="group"
        aria-roledescription="graph canvas"
        aria-label={label}
        aria-describedby={`${uid}-help`}
        onPointerDown={onBackgroundDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          setGesture(null);
          setDragPos(null);
        }}
        onKeyDown={onCanvasKey}
        onDragOver={(e) => {
          if (!onDropItem || readOnly || !e.dataTransfer.types.includes(PALETTE_MIME)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(e) => {
          if (!onDropItem || readOnly) return;
          const item = e.dataTransfer.getData(PALETTE_MIME);
          if (item === "") return;
          e.preventDefault();
          const w = toWorld(view, local(e));
          onDropItem(item, snapPoint({ x: w.x - NODE_W / 2, y: w.y - GRID }), hitNode(w));
        }}
      >
        <div className="ap-world" style={worldStyle}>
          <svg className="ap-edges" width="1" height="1" aria-hidden="true" focusable="false">
            {edges.map((e) => {
              const a = byId.get(e.from);
              const b = byId.get(e.to);
              if (!a || !b) return null;
              const pa = outPort(a);
              const pb = inPort(b);
              const k = edgeKey(e);
              return (
                <g key={k} className="ap-edge" data-selected={selectedEdge === k ? "" : undefined}>
                  <path className="ap-edge-hit" d={edgePath(pa, pb)} onPointerDown={(ev) => {
                    ev.stopPropagation();
                    if (readOnly) return;
                    setSelectedEdge(k);
                    onSelect(null);
                    ref.current?.focus({ preventScroll: true });
                    setAnnounce(`Selected the link from step ${indexOf(e.from)} to step ${indexOf(e.to)}. Press Delete to remove it.`);
                  }} />
                  <path className="ap-edge-line" d={edgePath(pa, pb)} />
                  <path className="ap-edge-head" d={arrowHead(pb)} />
                </g>
              );
            })}
            {connectLine?.from ? <path className="ap-edge-temp" d={`M${outPort(connectLine.from).x} ${outPort(connectLine.from).y}L${connectLine.at.x} ${connectLine.at.y}`} /> : null}
          </svg>
          {nodes.map((n) => {
            const p = byId.get(n.id) ?? n;
            const h = nodeHeight(n.lines.length);
            const isSel = selected === n.id;
            return (
              <div
                key={n.id}
                ref={(el) => {
                  if (el) cardRefs.current.set(n.id, el);
                  else cardRefs.current.delete(n.id);
                }}
                className="ap-node"
                data-selected={isSel ? "" : undefined}
                data-tone={n.tone}
                data-connecting={connectFrom === n.id ? "" : undefined}
                data-dragging={dragPos?.id === n.id ? "" : undefined}
                data-pulse={n.pulse ? "" : undefined}
                style={{ left: p.x, top: p.y, width: NODE_W, height: h }}
                role="button"
                tabIndex={0}
                aria-pressed={isSel}
                aria-label={n.describe}
                aria-keyshortcuts={readOnly ? "Enter" : "Enter ArrowUp ArrowDown ArrowLeft ArrowRight C Delete"}
                onPointerDown={(e) => onCardDown(e, n.id)}
                onKeyDown={(e) => onCardKey(e, n.id)}
              >
                <div className="ap-card px-corners px-frame" aria-hidden="true">
                  <div className="ap-node-head">
                    <NodeGlyph kind={n.glyph} />
                    <span className="ap-node-n">{n.index}</span>
                    <span className="ap-node-title">{n.title}</span>
                    {n.subtitle !== undefined ? <span className="ap-node-sub">{n.subtitle}</span> : null}
                  </div>
                  <dl className="ap-node-lines">
                    {n.lines.map((l, i) => (
                      <div key={i}>
                        <dt>{l.k}</dt>
                        <dd>{l.v}</dd>
                      </div>
                    ))}
                  </dl>
                  {n.badges && n.badges.length > 0 ? (
                    <span className="ap-node-badges">
                      {n.badges.map((b) => (
                        <span key={b} className="ap-node-badge">
                          {b}
                        </span>
                      ))}
                    </span>
                  ) : null}
                </div>
                <span className="ap-port ap-port-in" aria-hidden="true" />
                {!readOnly && onConnect ? (
                  <span className="ap-port ap-port-out" aria-hidden="true" title="Drag onto another step to run it after this one" onPointerDown={(e) => onPortDown(e, n.id)} />
                ) : null}
              </div>
            );
          })}
        </div>
        {nodes.length === 0 ? <p className="ap-canvas-empty">Add a step from the palette, or start from a template.</p> : null}
      </div>

      <div className="ap-canvas-tools" role="toolbar" aria-label="Canvas view">
        <button
          type="button"
          className="ap-tool"
          onClick={() => {
            manual();
            setView((v) => zoomAround(v, v.zoom / 1.2, { x: size.w / 2, y: size.h / 2 }));
          }}
          aria-label="Zoom out"
        >
          −
        </button>
        <span className="ap-tool-zoom" aria-live="off">
          {Math.round(view.zoom * 100)}%
        </span>
        <button
          type="button"
          className="ap-tool"
          onClick={() => {
            manual();
            setView((v) => zoomAround(v, v.zoom * 1.2, { x: size.w / 2, y: size.h / 2 }));
          }}
          aria-label="Zoom in"
        >
          +
        </button>
        <button type="button" className="ap-tool ap-tool-fit" onClick={fit} title="Show every step">
          Fit
        </button>
      </div>

      {laid.length > 0 && !allInView ? (
        <Minimap
          nodes={laid}
          view={view}
          size={size}
          onJump={(center) => {
            manual();
            setView((v) => ({ ...v, x: center.x - size.w / 2 / v.zoom, y: center.y - size.h / 2 / v.zoom }));
          }}
        />
      ) : null}

      <p id={`${uid}-help`} className="sr-only">
        {readOnly
          ? "Each card is one step. Tab moves between steps. Arrow keys pan the canvas, plus and minus zoom, 0 fits everything."
          : "Each card is one step. Tab moves between steps; arrow keys move the focused step on the grid (Shift moves further); Enter selects it; C starts a link, then Enter on another step makes it run after the first; Delete removes. On the canvas itself, arrow keys pan, plus and minus zoom and 0 fits everything."}
      </p>
      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>
      {connectFrom !== null ? (
        <p className="ap-connect-hint" role="note">
          Linking from step {indexOf(connectFrom)} ({titleOf(connectFrom)}): choose the step that should run after it. Esc cancels.
        </p>
      ) : null}
    </div>
  );
}

/** A small overview of the whole graph with the visible area; clicking moves the view there. */
function Minimap({ nodes, view, size, onJump }: { nodes: readonly LaidNode[]; view: View; size: { w: number; h: number }; onJump: (center: Point) => void }): ReactNode {
  const W = 168;
  const H = 104;
  const vis = { x: view.x, y: view.y, w: size.w / view.zoom, h: size.h / view.zoom };
  let x0 = vis.x;
  let y0 = vis.y;
  let x1 = vis.x + vis.w;
  let y1 = vis.y + vis.h;
  for (const n of nodes) {
    const b = nodeBox(n);
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  const pad = 40;
  x0 -= pad;
  y0 -= pad;
  x1 += pad;
  y1 += pad;
  const s = Math.min(W / (x1 - x0), H / (y1 - y0));
  const sx = (x: number): number => (x - x0) * s;
  const sy = (y: number): number => (y - y0) * s;
  return (
    <svg
      className="ap-minimap"
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      shapeRendering="crispEdges"
      role="img"
      aria-label="Minimap of the whole graph"
      onPointerDown={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onJump({ x: x0 + (e.clientX - r.left) / s, y: y0 + (e.clientY - r.top) / s });
      }}
    >
      {nodes.map((n) => {
        const b = nodeBox(n);
        return <rect key={n.id} className="ap-mini-node" x={sx(b.x)} y={sy(b.y)} width={Math.max(2, b.w * s)} height={Math.max(2, b.h * s)} />;
      })}
      <rect className="ap-mini-view" x={sx(vis.x)} y={sy(vis.y)} width={vis.w * s} height={vis.h * s} />
    </svg>
  );
}

/** 8 x 8 pixel glyphs for the action families (decorative). */
const GLYPHS: Record<CanvasNodeView["glyph"], readonly string[]> = {
  buyback: ["..####..", ".#....#.", "#..##..#", "#.#..#.#", "#.#..#.#", "#..##..#", ".#....#.", "..####.."],
  burn: ["...#....", "..##....", "..###.#.", ".#####..", ".##.###.", "##..####", "##...###", ".######."],
  pay: ["########", "#......#", "#.####.#", "#......#", "#.##...#", "#......#", "########", "........"],
  unknown: ["..####..", ".#....#.", "......#.", ".....#..", "....#...", "........", "....#...", "........"],
};

export function NodeGlyph({ kind }: { kind: CanvasNodeView["glyph"] }): ReactNode {
  const rows = GLYPHS[kind];
  return (
    <svg className="ap-glyph" viewBox="0 0 8 8" width={16} height={16} shapeRendering="crispEdges" aria-hidden="true" focusable="false">
      {rows.flatMap((row, y) => [...row].map((c, x) => (c === "#" ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} /> : null)))}
    </svg>
  );
}

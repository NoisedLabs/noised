/**
 * The Autopilot canvas's geometry and the editor's operations on the SDK
 * canvas model: positions always on the pixel grid, zoom clamped and
 * anchored, loops refused before they are drawn (the chain refuses cyclic
 * AFTER chains), new steps never on top of others, and every edit still
 * compiling to exactly the bytes the SDK builds for the same graph.
 */
import { describe, expect, it } from "vitest";

import { buildCanvas, canvasOf, compileRuleSet, graphTemplates, printGraphText, parseGraphText, sqrtPriceOf, type Canvas, type Graph } from "../src/lib/programmable";
import {
  autoLayout,
  boundsOf,
  clampZoom,
  edgePath,
  fitView,
  freeSpot,
  GRID,
  nodeBox,
  nodeHeight,
  nudge,
  panBy,
  snap,
  toScreen,
  toWorld,
  wouldCycle,
  zoomAround,
  ZOOM_MAX,
  ZOOM_MIN,
} from "../src/pages/autopilot/canvasModel";
import {
  addCondition,
  addStep,
  afterChoices,
  chainCondition,
  CONDITION_ITEMS,
  conditionChain,
  condSqrtPrice,
  connectSteps,
  emptyCanvas,
  graphOrNull,
  moveStep,
  nodeViews,
  PRICE_NEAR_PCT,
  priceNearNow,
  removeStep,
  renameStep,
  setTrigger,
} from "../src/pages/autopilot/editor";
import { graphToTypeScript } from "../src/pages/autopilot/tsCode";

describe("canvas geometry", () => {
  it("snaps to the grid and keeps card heights (and so ports) on it", () => {
    expect(snap(7)).toBe(0);
    expect(snap(9)).toBe(GRID);
    expect(snap(-9)).toBe(-GRID);
    for (let lines = 0; lines < 8; lines++) expect(nodeHeight(lines) % GRID).toBe(0);
    expect(nudge({ x: 5, y: 37 }, 1, 0)).toEqual({ x: GRID, y: 32 });
    expect(nudge({ x: 0, y: 0 }, 0, -1, 4)).toEqual({ x: 0, y: -4 * GRID });
  });

  it("zoom is clamped and keeps the point under the pointer still", () => {
    expect(clampZoom(100)).toBe(ZOOM_MAX);
    expect(clampZoom(0)).toBe(ZOOM_MIN);
    expect(clampZoom(Number.NaN)).toBe(1);
    const v = { x: 40, y: -20, zoom: 1 };
    const anchor = { x: 300, y: 200 };
    const before = toWorld(v, anchor);
    const z = zoomAround(v, 1.6, anchor);
    const after = toWorld(z, anchor);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
    expect(toScreen(z, after).x).toBeCloseTo(anchor.x, 9);
  });

  it("panning moves the world with the pointer", () => {
    const v = panBy({ x: 0, y: 0, zoom: 2 }, 20, -10);
    expect(v).toEqual({ x: -10, y: 5, zoom: 2 });
  });

  it("fit shows every card and never zooms in past 100%", () => {
    const nodes = [
      { id: "a", x: 0, y: 0, lines: 4 },
      { id: "b", x: 2000, y: 1200, lines: 4 },
    ];
    const v = fitView(nodes, 800, 500);
    const b = boundsOf(nodes);
    if (!b) throw new Error("no bounds");
    const tl = toScreen(v, { x: b.x, y: b.y });
    const br = toScreen(v, { x: b.x + b.w, y: b.y + b.h });
    expect(tl.x).toBeGreaterThanOrEqual(0);
    expect(tl.y).toBeGreaterThanOrEqual(0);
    expect(br.x).toBeLessThanOrEqual(800);
    expect(br.y).toBeLessThanOrEqual(500);
    expect(fitView([{ id: "a", x: 0, y: 0, lines: 1 }], 1600, 1000).zoom).toBe(1);
  });

  it("fit keeps a top band clear (the zoom toolbar) and centres the cards below it", () => {
    const nodes = [
      { id: "a", x: 0, y: 0, lines: 4 },
      { id: "b", x: 0, y: 400, lines: 4 },
      { id: "c", x: 320, y: 400, lines: 4 },
    ];
    const b = boundsOf(nodes);
    if (!b) throw new Error("no bounds");
    for (const [w, h] of [
      [888, 540],
      [322, 440],
      [1200, 700],
    ] as const) {
      const v = fitView(nodes, w, h, 32, 60);
      const tl = toScreen(v, { x: b.x, y: b.y });
      const br = toScreen(v, { x: b.x + b.w, y: b.y + b.h });
      expect(tl.y).toBeGreaterThanOrEqual(60 - 1e-6);
      expect(br.y).toBeLessThanOrEqual(h - 32 + 1e-6);
      expect(tl.x).toBeGreaterThanOrEqual(32 - 1e-6);
      expect(br.x).toBeLessThanOrEqual(w - 32 + 1e-6);
      // Centred horizontally, and vertically in the band below the toolbar.
      expect(Math.abs(tl.x + br.x - w)).toBeLessThan(1e-6);
      expect(Math.abs((tl.y + br.y) / 2 - (60 + (h - 60 - 32) / 2))).toBeLessThan(1e-6);
    }
    // The default (top = margin) is the old symmetric fit.
    expect(fitView(nodes, 800, 500, 40)).toEqual(fitView(nodes, 800, 500, 40, 40));
  });

  it("a new card's free spot never overlaps another", () => {
    const nodes = [
      { id: "a", x: 0, y: 0, lines: 4 },
      { id: "b", x: 0, y: 208, lines: 4 },
    ];
    const p = freeSpot(nodes, 4, { x: 0, y: 0 });
    const box = { x: p.x, y: p.y, w: nodeBox({ id: "n", x: p.x, y: p.y, lines: 4 }).w, h: nodeHeight(4) };
    for (const n of nodes) {
      const o = nodeBox(n);
      const overlap = box.x < o.x + o.w && o.x < box.x + box.w && box.y < o.y + o.h && o.y < box.y + box.h;
      expect(overlap).toBe(false);
    }
  });

  it("edges are orthogonal pixel paths, looping around when the target sits above", () => {
    expect(edgePath({ x: 0, y: 0 }, { x: 64, y: 96 })).toBe("M0 0V48H64V96");
    expect(edgePath({ x: 0, y: 200 }, { x: 0, y: 0 })).toMatch(/^M0 200V216H\d+V-16H0V0$/);
  });

  it("refuses links that would make a loop (a step waiting for itself)", () => {
    const edges = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ];
    expect(wouldCycle(edges, "c", "a")).toBe(true);
    expect(wouldCycle(edges, "a", "a")).toBe(true);
    expect(wouldCycle(edges, "a", "c")).toBe(false);
    // Re-pointing c's own trigger at a step that does not depend on c is fine.
    expect(wouldCycle(edges, "a", "c")).toBe(false);
    const layout = autoLayout(["a", "b", "c"], edges, () => 4);
    expect((layout.get("a")?.y ?? 0) < (layout.get("b")?.y ?? 0) && (layout.get("b")?.y ?? 0) < (layout.get("c")?.y ?? 0)).toBe(true);
  });
});

const NOW = 1_790_000_000;

function bytesOf(c: Canvas): Uint8Array {
  const b = buildCanvas(c);
  if (!b.ok) throw new Error(b.issues.map((x) => x.message).join("; "));
  return b.bytes;
}

describe("price limits close to today's price (review L-1)", () => {
  it("the hints use the program's rule: the price has stayed past the limit", () => {
    for (const id of ["priceLte", "priceGte"] as const) {
      const hint = CONDITION_ITEMS.find((c) => c.id === id)?.hint ?? "";
      expect(hint).toMatch(/has stayed at or (below|above) this for the last 15 to 30 minutes/);
      expect(hint).not.toMatch(/reference price/);
    }
  });

  it("warns within PRICE_NEAR_PCT of any known price, on either side, and never for unknown prices", () => {
    const at = (sol: string): bigint => sqrtPriceOf(sol, 6);
    const today = at("0.000001");
    expect(PRICE_NEAR_PCT).toBe(5);
    for (const sol of ["0.000001", "0.00000096", "0.00000104", "0.000000951", "0.000001049"]) expect(priceNearNow(at(sol), [today]), sol).toBe(true);
    for (const sol of ["0.00000094", "0.00000106", "0.0000008", "0.000002"]) expect(priceNearNow(at(sol), [today]), sol).toBe(false);
    // Any of the prices: the reference or the pool's.
    expect(priceNearNow(at("0.00000098"), [at("0.000002"), today])).toBe(true);
    // Unknown (zero) prices and an empty list never warn; nor does a zero limit.
    expect(priceNearNow(at("0.000001"), [])).toBe(false);
    expect(priceNearNow(at("0.000001"), [0n])).toBe(false);
    expect(priceNearNow(0n, [today])).toBe(false);
  });

  it("reads a limit given as a sqrt price or as SOL per token", () => {
    const s = sqrtPriceOf("0.000002", 6);
    expect(condSqrtPrice({ op: "priceLte", price: { sqrtPriceQ64: s } }, 6)).toBe(s);
    expect(condSqrtPrice({ op: "priceGte", price: { sol: "0.000002" } }, 6)).toBe(s);
    expect(condSqrtPrice({ op: "priceGte", price: { sol: "not a price" } }, 6)).toBeNull();
    expect(condSqrtPrice({ op: "priceGte", price: { sqrtPriceQ64: 0n } }, 6)).toBeNull();
  });
});

describe("editor operations", () => {
  it("adds steps with the SDK's defaults at free spots on the grid, and they compile", () => {
    let c = emptyCanvas(6);
    const a = addStep(c, "buybackBurn", null, 6);
    c = a.canvas;
    const b = addStep(c, "burn", null, 6);
    c = b.canvas;
    expect(c.nodes.map((n) => n.id)).toEqual(["buyback", "burn"]);
    for (const n of c.nodes) {
      expect(n.x % GRID).toBe(0);
      expect(n.y % GRID).toBe(0);
    }
    expect(c.nodes[0]?.y).not.toBe(c.nodes[1]?.y);
    expect(bytesOf(c).length).toBeGreaterThan(0);
    // Ids stay unique.
    expect(addStep(c, "buybackBurn", null, 6).id).toBe("buyback2");
  });

  it("links steps through the SDK and refuses loops", () => {
    let c = addStep(emptyCanvas(6), "buybackBurn", null, 6).canvas;
    c = addStep(c, "burn", null, 6).canvas;
    const linked = connectSteps(c, "buyback", "burn");
    expect(linked.error).toBeNull();
    c = linked.canvas;
    expect(c.nodes.find((n) => n.id === "burn")?.trigger).toEqual({ kind: "after", node: "buyback" });
    expect(c.edges.map((e) => e.id)).toEqual(["buyback->burn"]);
    const loop = connectSteps(c, "burn", "buyback");
    expect(loop.error).toMatch(/loop/);
    expect(loop.canvas).toBe(c);
    expect(afterChoices(c, "buyback")).toEqual([]);
    // Back to its own schedule: the link goes.
    const own = setTrigger(c, "burn", { kind: "every", secs: 3600 });
    expect(own.canvas.edges).toEqual([]);
    expect(bytesOf(own.canvas).length).toBeGreaterThan(0);
  });

  it("renaming a step updates its links and run-count conditions", () => {
    let c = addStep(emptyCanvas(6), "buybackBurn", null, 6).canvas;
    c = addStep(c, "burn", null, 6).canvas;
    c = connectSteps(c, "buyback", "burn").canvas;
    c = addCondition(c, "burn", "runsInEpochLt", NOW).canvas;
    const r = renameStep(c, "buyback", "daily_buyback");
    expect(r.error).toBeNull();
    expect(r.canvas.edges[0]).toEqual({ id: "daily_buyback->burn", source: "daily_buyback", target: "burn" });
    expect(r.canvas.nodes.find((n) => n.id === "burn")?.trigger).toEqual({ kind: "after", node: "daily_buyback" });
    expect(renameStep(c, "buyback", "burn").error).toMatch(/already/);
    expect(renameStep(c, "buyback", "9bad").error).toMatch(/letters/);
    // The renamed graph is the same program: identical bytes (names are not on chain).
    const g1 = graphOrNull(c);
    const g2 = graphOrNull(r.canvas);
    expect(g1 && g2).toBeTruthy();
    expect(bytesOf(r.canvas)).toEqual(bytesOf(c));
  });

  it("removing a step sends the steps after it back to their own schedule", () => {
    let c = addStep(emptyCanvas(6), "buybackBurn", null, 6).canvas;
    c = addStep(c, "burn", null, 6).canvas;
    c = connectSteps(c, "buyback", "burn").canvas;
    const r = removeStep(c, "buyback");
    expect(r.nodes.map((n) => n.id)).toEqual(["burn"]);
    expect(r.edges).toEqual([]);
    expect(r.nodes[0]?.trigger.kind).toBe("every");
    expect(bytesOf(r).length).toBeGreaterThan(0);
  });

  it("conditions are an AND chain the inspector edits; or / not stay code-only", () => {
    const chain = conditionChain({ op: "and", a: { op: "graduated" }, b: { op: "treasurySolGte", lamports: 5n } });
    expect(chain).toEqual([{ op: "graduated" }, { op: "treasurySolGte", lamports: 5n }]);
    expect(chainCondition(chain ?? [])).toEqual({ op: "and", a: { op: "graduated" }, b: { op: "treasurySolGte", lamports: 5n } });
    expect(conditionChain({ op: "or", a: { op: "graduated" }, b: { op: "graduated" } })).toBeNull();
    expect(conditionChain(null)).toEqual([]);
    expect(chainCondition([])).toBeNull();
  });

  it("moving keeps cards on the grid and never changes the program", () => {
    const c = addStep(emptyCanvas(6), "burn", null, 6).canvas;
    const m = moveStep(c, "burn", { x: 101, y: 57 });
    expect(m.nodes[0]).toMatchObject({ x: 96, y: 64 });
    expect(bytesOf(m)).toEqual(bytesOf(c));
  });

  it("cards describe themselves for screen readers and flag problems", () => {
    let c = addStep(emptyCanvas(6), "distributeSol", null, 6).canvas;
    const issues = buildCanvas(c);
    expect(issues.ok).toBe(false);
    const views = nodeViews(c, issues.ok ? [] : issues.issues);
    expect(views[0]?.badges).toContain("!");
    expect(views[0]?.describe).toMatch(/^Step 1, pay: Pay recipients, every week/);
    c = { ...c, recipients: [{ address: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", bps: 10_000 }] };
    expect(buildCanvas(c).ok).toBe(true);
  });
});

describe("templates, code and TypeScript agree", () => {
  const recipients = [{ address: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", share: 7000 }, { address: "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T", share: 3000 }];
  const graphs: Graph[] = graphTemplates.map((t) =>
    t.build(t.id === "revenue-share" ? { recipients } : t.id === "ai-buyback" ? { operator: "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T" } : {}),
  );

  it("every template lays out on the canvas and compiles to the same bytes as the graph", () => {
    for (const g of graphs) {
      const c = canvasOf(g);
      const fromCanvas = bytesOf(c);
      const direct = buildCanvas(canvasOf(g, Object.fromEntries(c.nodes.map((n) => [n.id, { x: n.x + 32, y: n.y }]))));
      expect(direct.ok).toBe(true);
      if (direct.ok) expect(direct.bytes).toEqual(fromCanvas);
    }
  });

  it("the Code tab round-trips (print -> parse -> same bytes)", () => {
    for (const g of graphs) {
      const text = printGraphText(g);
      const parsed = parseGraphText(text, { tokenDecimals: 6 });
      expect(parsed.ok, text).toBe(true);
      if (parsed.ok) expect(bytesOf(canvasOf(parsed.graph))).toEqual(bytesOf(canvasOf(g)));
    }
  });

  it("the TypeScript tab writes raw amounts and every step", () => {
    const g = graphs.find((x) => x.nodes.some((n) => n.operatorGated));
    if (!g) throw new Error("no operator template");
    const ts = graphToTypeScript(g);
    expect(ts).toMatch(/^import \{ [^}]*buybackBurn[^}]*graph[^}]*whenever[^}]*\} from "@noisedlabs\/sdk";/);
    expect(ts).toContain(`operator: "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T"`);
    expect(ts).toContain("operatorGated: true");
    for (const n of g.nodes) expect(ts).toContain(`.node(${JSON.stringify(n.id)}`);
    expect(ts).toMatch(/maxIn: \d[\d_]*n/);
  });

  it("rule sets and graphs are separate formats (a rule leaf in a graph is refused)", () => {
    const bad = canvasOf({ operator: null, recipients: [], nodes: [{ ...(graphs[0]?.nodes[0] as Graph["nodes"][number]), when: { op: "buy" } }] });
    expect(buildCanvas(bad).ok).toBe(false);
    expect(compileRuleSet({ guardSecs: 3600, keys: [], rules: [{ from: 0, to: 60, effect: "deny", when: { op: "graduated" }, code: 0 }] }).ok).toBe(false);
  });
});

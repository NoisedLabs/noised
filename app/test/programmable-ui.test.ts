/**
 * Accessibility basics of the programmable-launch UI, rendered with
 * react-dom/server (no DOM): every field has a label, every button a name,
 * the graph canvas is a named, described group whose step cards are
 * focusable buttons with what a screen reader should hear, the canvas's
 * tools are labelled, and nothing injects HTML or inline <style>.
 * (Keyboard moves and announcements are exercised in the browser QA,
 * scripts/prog-qa.mjs.)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { buildCanvas, canvasOf, graphTemplates, type Canvas, type GuardFacts } from "../src/lib/programmable";
import { AutopilotSimple } from "../src/pages/autopilot/AutopilotSimple";
import { defaultChoices, type JobContext } from "../src/pages/autopilot/simple";
import { GraphCanvas } from "../src/pages/autopilot/GraphCanvas";
import { Inspector } from "../src/pages/autopilot/Inspector";
import { nodeViews } from "../src/pages/autopilot/editor";
import { defaultValues, PRESETS } from "../src/pages/create/rules/presets";
import { RulesEditor } from "../src/pages/create/rules/RulesEditor";
import { RulesGallery } from "../src/pages/create/rules/RulesGallery";
import { EMPTY_RULES, setPreset, type RulesDraft, type RulesEnv } from "../src/pages/create/rules/state";
import { TryTransfer } from "../src/pages/create/rules/TryTransfer";

const env: RulesEnv = { guardSecs: 6 * 3600, openDelaySecs: 300, graceSecs: 600, decimals: 6 };
const guard: GuardFacts = { openDelaySecs: 300, graceSecs: 600, guardSecs: 6 * 3600, maxBuyBps: 100, maxWalletBps: 200, p2pLocked: false, supply: 1_000_000_000_000_000n, decimals: 6 };
const TEAM = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

/** Every preset switched on (the team one with a wallet). */
function allPresets(): RulesDraft {
  let d = EMPTY_RULES;
  for (const p of PRESETS) d = setPreset(d, p.id, { ...defaultValues(p), wallets: p.wallets === true ? [TEAM] : [] }, env);
  return d;
}

function render(el: ReactElement): string {
  return renderToStaticMarkup(el);
}

/** Problems a screen reader user would hit: unlabelled fields, nameless buttons, duplicate ids. */
function a11yProblems(html: string): string[] {
  const out: string[] = [];
  const labels = [...html.matchAll(/<label\b[^>]*>[\s\S]*?<\/label>/g)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length] as const);
  const fors = new Set([...html.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g)].map((m) => m[1]));
  for (const m of html.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
    const attrs = m[2] ?? "";
    if (/type="hidden"/.test(attrs)) continue;
    const id = /\bid="([^"]+)"/.exec(attrs)?.[1];
    const inLabel = labels.some(([a, b]) => (m.index ?? 0) > a && (m.index ?? 0) < b);
    const named = /aria-label="[^"]+"/.test(attrs) || /aria-labelledby="[^"]+"/.test(attrs);
    if (!inLabel && !named && (id === undefined || !fors.has(id))) out.push(`unlabelled ${m[1]}: ${m[0].slice(0, 120)}`);
  }
  for (const m of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
    const attrs = m[1] ?? "";
    const text = (m[2] ?? "").replace(/<[^>]+>/g, "").trim();
    if (text === "" && !/aria-label="[^"]+"/.test(attrs) && !/title="[^"]+"/.test(attrs)) out.push(`nameless button: ${m[0].slice(0, 120)}`);
  }
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
  if (dup.length > 0) out.push(`duplicate ids: ${[...new Set(dup)].join(", ")}`);
  if (/<style\b/i.test(html)) out.push("inline <style> element");
  return out;
}

function demoCanvas(): Canvas {
  const t = graphTemplates.find((x) => x.id === "daily-buyback-burn");
  if (!t) throw new Error("template missing");
  return canvasOf({ ...t.build({}), tokenDecimals: 6 });
}

describe("the checker", () => {
  it("catches an unlabelled field, a nameless button and duplicate ids", () => {
    expect(a11yProblems('<input id="x"><button type="button"><svg></svg></button><span id="x"></span>')).toHaveLength(3);
    expect(a11yProblems('<label for="x">Name</label><input id="x"><label><input></label><button aria-label="Close">✕</button>')).toEqual([]);
  });
});

describe("rules step", () => {
  it("the Simple gallery: every preset is a named tick, its sliders are labelled, its sentence is live", () => {
    for (const d of [EMPTY_RULES, allPresets()]) {
      const html = render(createElement(RulesGallery, { draft: d, onChange: () => undefined, env, guard, available: true }));
      expect(a11yProblems(html)).toEqual([]);
      for (const p of PRESETS) expect(html).toContain(p.title.replace("'", "&#x27;"));
      expect(html).toContain("Selling is always allowed. No rule can block a sell.");
      // Advanced (blocks and code) sits in a fold, closed.
      expect(html).toMatch(/<details[^>]*class="pg-details[^"]*rg-advanced"/);
    }
    const on = render(createElement(RulesGallery, { draft: allPresets(), onChange: () => undefined, env, guard, available: true }));
    expect((on.match(/type="range"/g) ?? []).length).toBeGreaterThanOrEqual(PRESETS.length);
    // Every wallet a rule names is shown in full.
    expect(on).toContain(TEAM);
  });

  it("where rules are not live, the gallery says coming soon and offers nothing to switch on (review U8)", () => {
    const html = render(createElement(RulesGallery, { draft: EMPTY_RULES, onChange: () => undefined, env, guard, available: false }));
    expect(html).toContain("Coming soon");
    expect(html).not.toMatch(/type="checkbox"/);
    expect(html).not.toMatch(/type="range"/);
  });

  it("the block builder labels every control (with every preset on)", () => {
    const html = render(createElement(RulesEditor, { draft: allPresets(), onChange: () => undefined, env }));
    expect(a11yProblems(html)).toEqual([]);
    expect(html).toMatch(/role="tablist"[^>]*aria-label="Edit rules as"/);
    expect(html).toMatch(/role="tabpanel"/);
    expect(html).toContain("From Fair start");
  });

  it("the code editor is a labelled textarea that reports problems in a live region", () => {
    const html = render(createElement(RulesEditor, { draft: allPresets(), onChange: () => undefined, env }));
    expect(html).toMatch(/<textarea[^>]*aria-label="Rules code"[^>]*aria-describedby="rules-code-problems"/);
    expect(html).toMatch(/id="rules-code-problems" aria-live="polite"/);
  });

  it("try a transfer: labelled choices and sliders and a live verdict", () => {
    const html = render(createElement(TryTransfer, { set: null, guard, wallets: [] }));
    expect(a11yProblems(html)).toEqual([]);
    expect(html).toMatch(/class="rl-verdict[^"]*"[^>]*aria-live="polite"/);
    expect(html).toMatch(/role="radiogroup" aria-label="What happens"/);
  });
});

describe("autopilot canvas", () => {
  it("is a named, described group of focusable step cards with labelled tools", () => {
    const c = demoCanvas();
    const b = buildCanvas(c);
    const html = render(
      createElement(GraphCanvas, {
        nodes: nodeViews(c, b.ok ? [] : b.issues),
        edges: c.edges.map((e) => ({ from: e.source, to: e.target })),
        selected: null,
        onSelect: () => undefined,
        onMove: () => undefined,
        onConnect: () => null,
        label: "Autopilot steps",
      }),
    );
    expect(a11yProblems(html)).toEqual([]);
    expect(html).toMatch(/role="group" aria-roledescription="graph canvas" aria-label="Autopilot steps" aria-describedby="[^"]+-help"/);
    const cards = [...html.matchAll(/<div class="ap-node"[^>]*>/g)].map((m) => m[0]);
    expect(cards.length).toBe(c.nodes.length);
    for (const card of cards) {
      expect(card).toMatch(/role="button"/);
      expect(card).toMatch(/tabindex="0"/);
      expect(card).toMatch(/aria-pressed="false"/);
      expect(card).toMatch(/aria-label="Step \d+, [^"]{20,}"/);
      expect(card).toMatch(/aria-keyshortcuts="Enter ArrowUp ArrowDown ArrowLeft ArrowRight C Delete"/);
    }
    expect(html).toMatch(/role="toolbar" aria-label="Canvas view"/);
    expect(html).toMatch(/aria-label="Zoom in"/);
    expect(html).toMatch(/aria-label="Zoom out"/);
    // Edges and glyphs are decoration: hidden from assistive technology.
    expect(html).toMatch(/<svg class="ap-edges"[^>]*aria-hidden="true"/);
    // The keyboard help is in the page (the canvas points at it).
    expect(html).toMatch(/Tab moves between steps; arrow keys move the focused step/);
    expect(html).toMatch(/role="status" aria-live="polite"/);
  });

  it("a read-only canvas offers no moving or linking", () => {
    const c = demoCanvas();
    const html = render(createElement(GraphCanvas, { nodes: nodeViews(c, []), edges: [], selected: null, onSelect: () => undefined, readOnly: true, label: "Running steps" }));
    expect(html).not.toMatch(/ap-port-out/);
    expect(html).toMatch(/aria-keyshortcuts="Enter"/);
  });

  it("the inspector labels every field", () => {
    const c = demoCanvas();
    const node = c.nodes[0];
    if (!node) throw new Error("no node");
    const html = render(createElement(Inspector, { canvas: c, node, graph: null, onChange: () => undefined, onRemove: () => undefined, onAnnounce: () => undefined, readOnly: false, now: 1_790_000_000, poolFeeBps: 100 }));
    expect(a11yProblems(html)).toEqual([]);
    for (const legend of ["Starts", "Only if", "Does", "Limits"]) expect(html).toContain(`<legend class="ap-legend">${legend}</legend>`);
  });
});

describe("autopilot, Simple", () => {
  const ctx: JobContext = { symbol: "TEST", decimals: 6, poolFeeBps: 100, recipients: [{ address: TEAM, bps: 10_000 }] };
  it("every job is a named tick; its sliders and the agent's key are labelled", () => {
    const c = defaultChoices();
    for (const id of ["buyback", "burn", "share", "ai"] as const) c[id].on = true;
    c.ai.operator = "not-a-key";
    const html = render(createElement(AutopilotSimple, { choices: c, onChoices: () => undefined, ctx, problems: { ai: "That is not a valid key: check every character." }, readOnly: false }));
    expect(a11yProblems(html)).toEqual([]);
    // The typo shows as a visible error tied to the field (review U1).
    expect(html).toMatch(/aria-invalid="true"[^>]*aria-describedby="[^"]+-op-e"/);
    expect(html).toContain("That is not a valid key");
    expect(html).toContain(TEAM);
  });
});

describe("CSP: no injected markup", () => {
  it("the new pages never use HTML sinks", () => {
    const files = [
      "pages/autopilot/GraphCanvas.tsx",
      "pages/autopilot/AutopilotPage.tsx",
      "pages/autopilot/AutopilotEditor.tsx",
      "pages/autopilot/Inspector.tsx",
      "pages/autopilot/SimPanel.tsx",
      "pages/autopilot/ReviewPanel.tsx",
      "pages/autopilot/RunPanel.tsx",
      "pages/autopilot/AutopilotSimple.tsx",
      "pages/autopilot/PendingChange.tsx",
      "pages/autopilot/AutopilotIndex.tsx",
      "pages/create/rules/RulesEditor.tsx",
      "pages/create/rules/RulesGallery.tsx",
      "pages/create/rules/RulesReview.tsx",
      "pages/create/rules/TryTransfer.tsx",
      "pages/token/ProgrammableCards.tsx",
    ];
    for (const f of files) {
      const text = readFileSync(fileURLToPath(new URL(`../src/${f}`, import.meta.url)), "utf8");
      expect(text, f).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML|insertAdjacentHTML|<style\b|document\.write/);
    }
  });
});

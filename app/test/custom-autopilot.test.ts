/**
 * Custom launch's Autopilot step (src/pages/create/autopilotDraft.ts) and the treasury's share of the fees
 * (src/pages/create/quick.ts), and the quick launch's logo framing (src/pages/create/logo.ts):
 *   - off builds nothing; on, the Simple jobs build the graph the SDK verifies, and the canvas shows it; an edited
 *     graph builds from the canvas; no job or a broken job is a problem, never bytes;
 *   - the treasury's share keeps the other recipients' proportions and always adds up to 100%, and the result passes
 *     the launch policy;
 *   - the logo's crop is always a square inside the picture, at any zoom and drag.
 */
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { graphVerifies } from "../src/lib/programmable";
import { autopilotBuild, autopilotDraft, graphRecipients, undoCanvas, withCanvas, withChoices } from "../src/pages/create/autopilotDraft";
import { convertDraft, draftFromPreset } from "../src/pages/create/draft";
import { CENTRED, cropSquare, MAX_ZOOM, panCrop } from "../src/pages/create/logo";
import { launchTreasury, resolveTreasury, TREASURY_WALLET, treasuryShareOf, withTreasuryShare } from "../src/pages/create/quick";
import type { JobContext } from "../src/pages/autopilot/simple";

const W1 = Keypair.generate().publicKey.toBase58();
const W2 = Keypair.generate().publicKey.toBase58();
const ctx: JobContext = { symbol: "TEST", decimals: 6, poolFeeBps: 100, recipients: graphRecipients([{ address: W1, bps: 10_000 }]) };

describe("custom launch: the Autopilot step", () => {
  it("is off by default and builds nothing; switched on, the buyback job builds verified bytes and the canvas shows it", () => {
    const off = autopilotDraft(6);
    expect(off.on).toBe(false);
    expect(autopilotBuild(off, ctx)).toBeNull();
    const on = withChoices({ ...off, on: true }, off.choices, ctx);
    const b = autopilotBuild(on, ctx);
    if (b === null || !b.ok) throw new Error("does not build");
    expect(graphVerifies(b.bytes)).toBe(true);
    expect(b.graph.nodes.map((n) => n.id)).toEqual(["buyback"]);
    expect(on.canvas.nodes.map((n) => n.id)).toEqual(["buyback"]);
  });

  it("every job together builds; a job that can't build is a problem, not bytes", () => {
    const base = { ...autopilotDraft(6), on: true };
    const all = withChoices(base, { ...base.choices, burn: { ...base.choices.burn, on: true }, share: { ...base.choices.share, on: true }, ai: { ...base.choices.ai, on: true, operator: W2 } }, ctx);
    const b = autopilotBuild(all, ctx);
    if (b === null || !b.ok) throw new Error(`does not build: ${JSON.stringify(b)}`);
    expect(b.graph.nodes.map((n) => n.id).sort()).toEqual(["agent", "burn", "buyback", "share"]);
    expect(b.graph.operator).toBe(W2);
    const badAi = withChoices(base, { ...base.choices, ai: { ...base.choices.ai, on: true, operator: "not a key" } }, ctx);
    const bad = autopilotBuild(badAi, ctx);
    expect(bad?.ok).toBe(false);
    const none = withChoices(base, { ...base.choices, buyback: { ...base.choices.buyback, on: false } }, ctx);
    expect(autopilotBuild(none, ctx)).toMatchObject({ ok: false });
  });

  it("an edited graph builds from the canvas, and undo brings the jobs' graph back", () => {
    const on = withChoices({ ...autopilotDraft(6), on: true }, autopilotDraft(6).choices, ctx);
    const edited = withCanvas(on, { ...on.canvas, nodes: on.canvas.nodes.map((n) => ({ ...n, position: { x: 400, y: 200 } })) });
    expect(edited.source).toBe("advanced");
    expect(autopilotBuild(edited, ctx)?.ok).toBe(true);
    expect(undoCanvas(edited).canvas).toBe(on.canvas);
    expect(autopilotBuild({ ...edited, canvas: { ...edited.canvas, nodes: [], edges: [] } }, ctx)).toMatchObject({ ok: false });
  });

  it("revenue-share recipients always add up to 100%", () => {
    expect(graphRecipients([])).toEqual([]);
    const r = graphRecipients([
      { address: W1, bps: 3_333 },
      { address: W2, bps: 3_333 },
    ]);
    expect(r.reduce((s, x) => s + x.bps, 0)).toBe(10_000);
  });
});

describe("the treasury's share of the fees", () => {
  it("keeps the others' proportions, adds up to 100%, and passes the launch policy once resolved", () => {
    const creator = Keypair.generate().publicKey;
    const { treasury } = launchTreasury(creator, Uint8Array.from({ length: 32 }, () => 7));
    const pq = Uint8Array.from({ length: 32 }, (_, i) => i + 3);
    const start = [
      { wallet: W1, pct: "60" },
      { wallet: W2, pct: "40" },
    ];
    for (const pct of [0, 10, 25, 33, 50, 75, 90, 100]) {
      const rs = withTreasuryShare(start, pct, W1);
      const sum = rs.reduce((s, r) => s + Math.round(Number(r.pct) * 100), 0);
      expect(sum, `${pct}%`).toBe(10_000);
      expect(treasuryShareOf(rs), `${pct}%`).toBe(pct);
      if (pct > 0 && pct < 100) {
        const [a, b] = rs.filter((r) => r.wallet !== TREASURY_WALLET).map((r) => Number(r.pct));
        expect(Math.abs((a ?? 0) / (b ?? 1) - 1.5), `${pct}%`).toBeLessThan(0.01);
      }
      const d = resolveTreasury({ ...draftFromPreset("fair"), name: "T", symbol: "T", recipients: rs }, treasury);
      const conv = convertDraft(d, pq, null);
      expect(conv.inputErrors, `${pct}%`).toEqual({});
      expect(conv.policyErrors, `${pct}%`).toEqual([]);
    }
    // Back to 0 removes the treasury; with nobody else, the fallback wallet takes everything.
    expect(withTreasuryShare([{ wallet: TREASURY_WALLET, pct: "100" }], 0, W2)).toEqual([{ wallet: W2, pct: "100" }]);
    expect(withTreasuryShare([{ wallet: W1, pct: "100" }], 100, W1)).toEqual([{ wallet: TREASURY_WALLET, pct: "100" }]);
  });
});

describe("the logo's frame", () => {
  it("is always a square inside the picture, at any zoom and drag", () => {
    for (const [w, h] of [
      [1000, 400],
      [300, 900],
      [64, 64],
    ] as const) {
      for (const zoom of [0.5, 1, 1.7, MAX_ZOOM, 9]) {
        for (const [dx, dy] of [
          [0, 0],
          [500, -500],
          [-10_000, 10_000],
        ] as const) {
          const c = panCrop(w, h, { ...CENTRED, zoom }, dx, dy, 224);
          const s = cropSquare(w, h, c);
          expect(s.side).toBeGreaterThan(0);
          expect(s.side).toBeLessThanOrEqual(Math.min(w, h) + 1e-9);
          expect(s.sx).toBeGreaterThanOrEqual(-1e-9);
          expect(s.sy).toBeGreaterThanOrEqual(-1e-9);
          expect(s.sx + s.side).toBeLessThanOrEqual(w + 1e-9);
          expect(s.sy + s.side).toBeLessThanOrEqual(h + 1e-9);
        }
      }
    }
    // Zoom 2 of a 1000 x 400 picture: a 200-pixel square, centred.
    expect(cropSquare(1000, 400, { cx: 0.5, cy: 0.5, zoom: 2 })).toMatchObject({ sx: 400, sy: 100, side: 200 });
    // Dragging right shows more of the left.
    expect(panCrop(1000, 400, { cx: 0.5, cy: 0.5, zoom: 2 }, 50, 0, 200).cx).toBeLessThan(0.5);
  });
});

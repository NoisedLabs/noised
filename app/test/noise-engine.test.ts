/**
 * The "signal from noise" engine (src/fx/noise): shapes sampled from vector paths are deterministic and land on
 * their outlines; the field forms every shape exactly and holds a static, fully formed frame under reduced motion;
 * the shared frame loop runs only while something needs it and pauses while the tab is hidden (without the hidden
 * time jumping the animation forward); no dot flickers faster than three times a second; dots part around the
 * pointer and settle back; every scene on the site builds at phone and desktop sizes; the effects stay CSP-safe.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { cardScene, glyphScene, pageScene } from "../src/components/art/scenes";
import { ctaScene } from "../src/components/landing/noise/cta";
import { HOW_STEP, HOW_STEPS, HOW_STILL_AT, howScene } from "../src/components/landing/noise/how";
import { privateScene, vaultScene } from "../src/components/landing/noise/safe";
import { launchesIcon, raisedIcon, verifiedIcon } from "../src/components/landing/noise/stats";
import { limitScene, lockScene, shieldScene } from "../src/components/landing/noise/why";
import { buildField, computeFrame, createFrame, loopOf, stepStart, stillTime, timelineAt, type Field, type NoiseScene } from "../src/fx/noise/field";
import { createScheduler, type SchedulerEnv } from "../src/fx/noise/scheduler";
import { apportion, circle, parsePath, roundRect, sampleShape, shape, type Shape } from "../src/fx/noise/shape";

const src = (path: string): string => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

const lockShape = (): Shape =>
  shape(100, 100)
    .stroke(roundRect(26, 46, 48, 40, 7))
    .fill(roundRect(30, 50, 40, 32, 5), { weight: 0.6 })
    .stroke("M36 46 V34 C36 18 64 18 64 34 V46", { group: 1 })
    .build();

/** Distance from (x, y) to the nearest segment of a polyline. */
function distToPoly(pts: Float32Array, closed: boolean, x: number, y: number): number {
  let best = Infinity;
  const m = pts.length / 2;
  const segs = closed ? m : m - 1;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % m;
    const ax = pts[i * 2]!;
    const ay = pts[i * 2 + 1]!;
    const bx = pts[j * 2]!;
    const by = pts[j * 2 + 1]!;
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(x - (ax + dx * t), y - (ay + dy * t)));
  }
  return best;
}

describe("shape sampling", () => {
  it("is deterministic: the same seed gives the same points, another seed other points", () => {
    const s = lockShape();
    const a = sampleShape(s, 600, 42);
    const b = sampleShape(s, 600, 42);
    const c = sampleShape(s, 600, 43);
    expect(a.n).toBe(600);
    expect([...a.x]).toEqual([...b.x]);
    expect([...a.y]).toEqual([...b.y]);
    expect([...a.el]).toEqual([...b.el]);
    expect([...a.x]).not.toEqual([...c.x]);
  });

  it("puts stroke points on their outline, fill points inside, and keeps each element's group", () => {
    const s = lockShape();
    const pts = sampleShape(s, 800, 7);
    let strokes = 0;
    let fills = 0;
    for (let i = 0; i < pts.n; i++) {
      const e = s.elements[pts.el[i]!]!;
      const x = pts.x[i]!;
      const y = pts.y[i]!;
      expect(pts.group[i]).toBe(e.group);
      if (e.mode === "stroke") {
        strokes++;
        const d = Math.min(...e.polys.map((p) => distToPoly(p.pts, p.closed, x, y)));
        expect(d).toBeLessThan(0.05);
      } else {
        fills++;
        expect(x).toBeGreaterThanOrEqual(30);
        expect(x).toBeLessThanOrEqual(70);
        expect(y).toBeGreaterThanOrEqual(50);
        expect(y).toBeLessThanOrEqual(82);
      }
    }
    expect(strokes).toBeGreaterThan(0);
    expect(fills).toBeGreaterThan(0);
  });

  it("gives closed outlines outward normals", () => {
    const pts = sampleShape(shape(100, 100).stroke(circle(50, 50, 30)).build(), 120, 1);
    for (let i = 0; i < pts.n; i++) {
      const rx = (pts.x[i]! - 50) / 30;
      const ry = (pts.y[i]! - 50) / 30;
      expect(pts.nx[i]! * rx + pts.ny[i]! * ry).toBeGreaterThan(0.95);
    }
  });

  it("parses SVG path data (absolute, relative, curves, close) and splits counts exactly", () => {
    const [tri] = parsePath("M0 0 L10 0 l0 10 Z");
    expect(tri?.closed).toBe(true);
    expect([...(tri?.pts ?? [])]).toEqual([0, 0, 10, 0, 10, 10]);
    const curve = parsePath("M0 0 C0 10 10 10 10 0", 8)[0];
    expect(curve?.pts.length).toBe(18);
    expect(curve?.pts[16]).toBe(10);
    expect(apportion(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(apportion(7, [0, 0])).toEqual([7, 0]);
  });
});

const W = 320;
const H = 180;

function formedOffsets(field: Field, t: number, still = false): number[] {
  const out = createFrame(field);
  computeFrame(field, t, out, { still });
  const step = field.steps[out.step]!;
  const offs: number[] = [];
  for (let i = 0; i < field.nForm; i++) offs.push(Math.hypot(out.x[i]! - (field.ox + step.tx[i]! * field.s), out.y[i]! - (field.oy + step.ty[i]! * field.s)));
  return offs;
}

describe("noise field", () => {
  const scene: NoiseScene = { id: "test-lock", steps: [{ shape: lockShape(), form: 1, hold: 2, release: 1, rest: 0.5 }] };

  it("builds the same field for the same scene and size", () => {
    const a = buildField(scene, W, H);
    const b = buildField(scene, W, H);
    expect(a.n).toBe(b.n);
    expect([...a.homeX]).toEqual([...b.homeX]);
    expect([...a.steps[0]!.tx]).toEqual([...b.steps[0]!.tx]);
    expect(a.nForm).toBeGreaterThan(50);
    expect(a.n).toBeGreaterThan(a.nForm);
  });

  it("starts as noise, forms the shape exactly while holding, and dissolves back", () => {
    const f = buildField(scene, W, H);
    expect(Math.min(...formedOffsets(f, 0))).toBeGreaterThan(0);
    // Holding: every formed dot sits on its target (within the sub-pixel shimmer).
    expect(Math.max(...formedOffsets(f, 1.5))).toBeLessThan(0.5);
    expect(timelineAt(scene, 1.5)).toMatchObject({ phase: 1, k: 1 });
    // Resting (plain noise) before the loop starts over.
    expect(timelineAt(scene, 4.2)).toMatchObject({ phase: 3, k: 0 });
    expect(timelineAt(scene, loopOf(scene) + 1.5)).toMatchObject({ phase: 1 });
  });

  it("shows a static, fully formed frame under reduced motion, whatever the time", () => {
    const f = buildField(scene, W, H);
    // On target (to float precision): no drift, no shimmer.
    expect(Math.max(...formedOffsets(f, 0, true))).toBeLessThan(1e-3);
    const a = createFrame(f);
    const b = createFrame(f);
    computeFrame(f, 0, a, { still: true });
    computeFrame(f, 123.4, b, { still: true, pointer: { x: W / 2, y: H / 2 }, dt: 0.1 });
    expect([...a.x]).toEqual([...b.x]);
    expect([...a.y]).toEqual([...b.y]);
    expect([...a.a]).toEqual([...b.a]);
    expect(timelineAt(scene, stillTime(scene))).toMatchObject({ phase: 1, k: 1 });
  });

  it("shows the picked step in the still frame when a sequence player seeks under reduced motion", () => {
    const s = howScene();
    const f = buildField(s, 640, 400);
    const out = createFrame(f);
    for (let i = 0; i < HOW_STEPS; i++) {
      computeFrame(f, 0, out, { still: true, stillAt: i * HOW_STEP + (HOW_STILL_AT[i] ?? 0) });
      expect(out.step).toBe(i);
      expect(out.k).toBe(1);
    }
  });

  it("never flickers: no dot's brightness turns around more than 3 times a second", () => {
    const f = buildField(howScene(), 640, 400);
    const frames = 120;
    const series: Float32Array[] = [];
    for (let k = 0; k <= frames; k++) {
      const out = createFrame(f);
      computeFrame(f, 2 + k / 60, out);
      series.push(out.a);
    }
    let worst = 0;
    for (let i = 0; i < f.n; i++) {
      let turns = 0;
      let prev = 0;
      for (let k = 1; k <= frames; k++) {
        const d = series[k]![i]! - series[k - 1]![i]!;
        const dir = Math.abs(d) < 1e-4 ? prev : Math.sign(d);
        if (prev !== 0 && dir !== prev) turns++;
        prev = dir;
      }
      worst = Math.max(worst, turns / 2);
    }
    // A flash is a rise and a fall: at most 3 a second over these 2 seconds.
    expect(worst / 2).toBeLessThanOrEqual(3);
  });

  it("parts the dots around the pointer and lets them drift back", () => {
    const f = buildField(scene, W, H);
    const base = createFrame(f);
    computeFrame(f, 1.5, base);
    const px = base.x[0]! + 3;
    const py = base.y[0]!;
    const out = createFrame(f);
    for (let k = 0; k < 30; k++) computeFrame(f, 1.5, out, { pointer: { x: px, y: py }, dt: 1 / 60 });
    expect(Math.hypot(out.x[0]! - px, out.y[0]! - py)).toBeGreaterThan(Math.hypot(base.x[0]! - px, base.y[0]! - py) + 4);
    for (let k = 0; k < 240; k++) computeFrame(f, 1.5, out, { pointer: null, dt: 1 / 60 });
    expect(Math.hypot(out.x[0]! - base.x[0]!, out.y[0]! - base.y[0]!)).toBeLessThan(0.05);
  });

  it("lets streams hit only the side of an outline that faces them", () => {
    const f = buildField(ctaScene(), 920, 196);
    const st = f.steps[0]!.streams[0]!;
    for (let j = 0; j < st.cx.length; j++) expect(st.nx[j]! * st.hx[j]! + st.ny[j]! * st.hy[j]!).toBeLessThan(0);
  });
});

describe("the site's scenes", () => {
  const scenes: [string, NoiseScene][] = [
    ["shield", shieldScene()],
    ["limit", limitScene()],
    ["lock", lockScene()],
    ["how", howScene()],
    ["vault", vaultScene()],
    ["private", privateScene()],
    ["cta", ctaScene()],
    ["launches", launchesIcon()],
    ["raised", raisedIcon()],
    ["verified", verifiedIcon()],
    ...(["create", "vault", "privacy", "security", "verify", "docs"] as const).map((n): [string, NoiseScene] => [`page ${n}`, pageScene(n)]),
    ...(["phrase", "deposit", "key", "wrap", "hide", "unwrap", "book", "paper", "letter", "courier", "agent"] as const).map((n): [string, NoiseScene] => [`glyph ${n}`, glyphScene(n)]),
    ...(["quick", "custom", "wallet", "token", "split"] as const).map((n): [string, NoiseScene] => [`card ${n}`, cardScene(n)]),
  ];

  it.each(scenes)("%s builds at phone and desktop sizes with finite, in-canvas formed frames", (_name, scene) => {
    for (const [w, h] of [
      [32, 32],
      [64, 64],
      [330, 165],
      [920, 400],
    ] as const) {
      const f = buildField(scene, w, h);
      expect(f.n).toBeLessThanOrEqual(scene.maxDots ?? 1600);
      expect(f.nForm).toBeGreaterThan(0);
      const out = createFrame(f);
      for (const t of [0, stillTime(scene), loopOf(scene) * 0.77]) {
        computeFrame(f, t, out, { still: t === stillTime(scene) });
        for (let i = 0; i < f.n; i++) {
          expect(Number.isFinite(out.x[i]) && Number.isFinite(out.y[i]) && Number.isFinite(out.a[i])).toBe(true);
          expect(out.a[i]).toBeGreaterThanOrEqual(0);
          expect(out.a[i]).toBeLessThanOrEqual(1);
        }
      }
      computeFrame(f, 0, out, { still: true });
      for (let i = 0; i < f.nForm; i++) {
        expect(out.x[i]).toBeGreaterThanOrEqual(-1);
        expect(out.x[i]).toBeLessThanOrEqual(w + 1);
        expect(out.y[i]).toBeGreaterThanOrEqual(-1);
        expect(out.y[i]).toBeLessThanOrEqual(h + 1);
      }
    }
  });

  it("plays How it works as four equal steps the player can seek to", () => {
    const s = howScene();
    expect(s.steps).toHaveLength(HOW_STEPS);
    for (let i = 0; i < HOW_STEPS; i++) expect(stepStart(s, i)).toBeCloseTo(i * HOW_STEP, 6);
    expect(loopOf(s)).toBeCloseTo(HOW_STEPS * HOW_STEP, 6);
  });
});

/** A fake browser: frames run when the test says so; visibility is a flag. */
function fakeEnv(): SchedulerEnv & { flush(ms: number): void; hide(): void; show(): void; pending(): number } {
  let now = 0;
  let visible = true;
  let next = 1;
  const frames = new Map<number, (t: number) => void>();
  const listeners = new Set<() => void>();
  return {
    requestFrame(cb) {
      const id = next++;
      frames.set(id, cb);
      return id;
    },
    cancelFrame(id) {
      frames.delete(id);
    },
    visible: () => visible,
    onVisibility(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    flush(ms) {
      now += ms;
      const due = [...frames.values()];
      frames.clear();
      for (const cb of due) cb(now);
    },
    hide() {
      visible = false;
      for (const cb of [...listeners]) cb();
    },
    show() {
      visible = true;
      for (const cb of [...listeners]) cb();
    },
    pending: () => frames.size,
  };
}

describe("shared frame loop", () => {
  it("runs one frame request for every task, only while some task is in", () => {
    const env = fakeEnv();
    const sched = createScheduler(env);
    expect(env.pending()).toBe(0);
    const calls: number[] = [];
    const offA = sched.add({ frame: (dt) => calls.push(dt) });
    const offB = sched.add({ frame: () => undefined });
    expect(env.pending()).toBe(1);
    env.flush(16);
    env.flush(16);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBeCloseTo(0.016, 6);
    offA();
    offB();
    env.flush(16);
    expect(env.pending()).toBe(0);
    expect(sched.running).toBe(false);
  });

  it("pauses while the tab is hidden and resumes without jumping over the hidden time", () => {
    const env = fakeEnv();
    const sched = createScheduler(env);
    const calls: number[] = [];
    sched.add({ frame: (dt) => calls.push(dt) });
    env.flush(16);
    env.flush(16);
    env.hide();
    expect(env.pending()).toBe(0);
    expect(sched.running).toBe(false);
    // Ten seconds away: nothing runs.
    for (let k = 0; k < 10; k++) env.flush(1000);
    expect(calls).toHaveLength(2);
    env.show();
    expect(env.pending()).toBe(1);
    env.flush(16);
    // The first frame back is one ordinary frame, not the ten seconds the tab was hidden.
    expect(calls).toHaveLength(3);
    expect(calls[2]).toBeLessThanOrEqual(1 / 15);
  });

  it("caps a task's rate when it asks for fewer frames", () => {
    const env = fakeEnv();
    const sched = createScheduler(env);
    let slow = 0;
    let fast = 0;
    sched.add({ fps: 15, frame: () => slow++ });
    sched.add({ frame: () => fast++ });
    for (let k = 0; k < 60; k++) env.flush(1000 / 60);
    expect(fast).toBe(60);
    expect(slow).toBeGreaterThanOrEqual(14);
    expect(slow).toBeLessThanOrEqual(16);
  });
});

describe("CSP and accessibility of the effects", () => {
  const files = readdirSync(new URL("../src/fx/noise/", import.meta.url)).filter((f) => /\.(ts|tsx)$/.test(f));

  it("never injects markup or <style>: CSSOM only", () => {
    for (const f of files) {
      // Comments may say what the code must not do.
      const text = src(`fx/noise/${f}`).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
      expect(text, f).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|createElement\(["']style["']\)|insertRule|adoptedStyleSheets|cssText/);
    }
  });

  it("keeps decoration out of the accessibility tree and caps the canvas resolution", () => {
    expect(src("fx/noise/NoiseArt.tsx")).toMatch(/aria-hidden="true"/);
    expect(src("fx/noise/NoiseGrain.tsx")).toMatch(/aria-hidden="true"/);
    expect(src("fx/noise/env.ts")).toMatch(/Math\.min\(1\.5, /);
    // The spinner is still under reduced motion and when the visitor pauses motion.
    const css = src("fx/noise/noise.css");
    expect(css).toMatch(/:root\[data-motion="still"\] \.nz-spin-ring > i \{\s+animation: none;/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s+\.nz-spin-ring > i \{\s+animation: none;/);
  });
});

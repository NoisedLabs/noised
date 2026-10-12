/**
 * Performance and type leftovers of UI v6 (INTEGRATION_INPUTS §5), updated for the "signal from noise" effects: the
 * resolve-from-noise reveal starts hidden, ends fully shown and runs on the page's one shared frame loop; nothing
 * reads the scroll position or the viewport size inside an animation frame (the navbar and the aurora background
 * read them in passive listeners); the retired font setting is gone; the hero's buttons and stat labels use the UI
 * pixel font at its native size.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { resolveMask } from "../src/fx/noise/reveal";

const src = (path: string): string => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

/** The body of `const name = (...) ... => { ... };` (brace-matched). */
function arrowBody(text: string, name: string): string {
  const start = text.indexOf(`const ${name} = `);
  if (start < 0) throw new Error(`no ${name}`);
  const open = text.indexOf("{", text.indexOf("=>", start));
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

describe("noise reveal", () => {
  /** [radius, pitch] of each dot lattice in a resolve mask. */
  const lattices = (p: number): [number, number][] => {
    const m = resolveMask(p);
    const radii = [...m.image.matchAll(/#000 ([\d.]+)px/g)].map((x) => Number(x[1]));
    const pitches = [...m.size.matchAll(/(\d+)px \d+px/g)].map((x) => Number(x[1]));
    return radii.map((r, i) => [r, pitches[i] ?? 0]);
  };

  it("starts with nothing shown and ends with every lattice covering its whole cell", () => {
    expect(lattices(0).every(([r]) => r === 0)).toBe(true);
    // A dot covers its square cell once its radius passes half the diagonal (0.71 x pitch).
    for (const [r, pitch] of lattices(1)) expect(r).toBeGreaterThan(pitch * Math.SQRT1_2);
    // Unrelated pitches, so the growing dots read as noise rather than a grid.
    const pitches = lattices(0.5).map(([, p]) => p);
    expect(new Set(pitches).size).toBe(pitches.length);
  });

  it("runs on the shared frame loop (no requestAnimationFrame of its own) and cleans up after itself", () => {
    const text = src("fx/noise/reveal.ts");
    expect(text).not.toMatch(/requestAnimationFrame\(/);
    expect(text).toMatch(/noiseScheduler\(\)\.add\(/);
    expect(text).toMatch(/function clear\(el: HTMLElement\): void \{\s+for \(const p of MASK_PROPS\) el\.style\.removeProperty\(p\);/);
  });
});

describe("no layout reads inside animation frames", () => {
  it("the aurora background reads the scroll position and the viewport size only in passive listeners", () => {
    const text = src("fx/aurora/renderer.ts");
    for (const fn of ["tick", "draw", "resize"]) expect(arrowBody(text, fn)).not.toMatch(/window\.(scrollY|innerWidth|innerHeight|pageYOffset)/);
    expect(arrowBody(text, "onScroll")).toMatch(/window\.scrollY/);
    expect(arrowBody(text, "onResize")).toMatch(/window\.innerWidth/);
    expect(text).toMatch(/addEventListener\("scroll", onScroll, \{ passive: true \}\)/);
    expect(text).toMatch(/addEventListener\("resize", onResize, \{ passive: true \}\)/);
  });

  it("the navbar reads the scroll position in a passive scroll listener, not in a frame", () => {
    const text = src("app/Layout.tsx");
    expect(text).toMatch(/const onScroll = \(\): void => setScrolled\(window\.scrollY > 24\);/);
    expect(text).toMatch(/addEventListener\("scroll", onScroll, \{ passive: true \}\)/);
    expect(text).not.toMatch(/requestAnimationFrame\([^)]*scrollY/);
  });
});

describe("type", () => {
  it("has no font setting: html[data-font] is never set and the retired fonts are not offered", () => {
    const code = src("app/settings.tsx").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/dataset\.font|data-font|setFont|FONT_KEY/);
    expect(code).not.toMatch(/Saira|Barlow|Chakra/);
  });

  it("sets the hero's buttons and stat labels in the UI pixel font at its native size", () => {
    const css = src("fx/wall/hero.css");
    const rule = (selector: string): string => {
      const at = css.indexOf(`${selector} {`);
      return at < 0 ? "" : css.slice(at, css.indexOf("}", at));
    };
    expect(rule(".hx-cta.btn")).toMatch(/font-family: var\(--font-ui/);
    expect(rule(".hx-cta.btn")).toMatch(/font-size: var\(--ui-px/);
    expect(rule(".hx-stat-label")).toMatch(/var\(--ui-px[^)]*\)\s*\/\s*1 var\(--font-ui/);
  });
});

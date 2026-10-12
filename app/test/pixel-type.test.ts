/**
 * PIXEL_V6 typography guard: Geist Pixel is only crisp on its pixel grid (one font pixel = 0.038 em), so every
 * CSS rule that sets it (font-family var(--font-head / --font-pixel / --font-num / --font-dot / --font-accent))
 * must size it with a pixel-exact token (--px-n, or a stepped token built from them). Below 26px the face renders
 * as a soft sans: small titles use Jersey 10 at --ui-px instead. Print rules (pt sizes) are exempt.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : name.endsWith(".css") ? [path] : [];
  });
}

const PIXEL_FAMILY = /var\(--font-(head|pixel|num|dot|accent)\b/;
/** Sizes that resolve to Geist Pixel's grid (or inherit one: 1em / a multiple of a grid size). */
const GRID_SIZE = /var\(--(px-|text-hero|text-h1|text-h2|text-title|hm-title-size|hm-cta-size|hx-title-size|ui-px|pg-big)|calc\(1em\b|\d+(\.\d+)?pt\b|^inherit$/;

interface Offender {
  file: string;
  line: number;
  selector: string;
  size: string;
}

function offenders(): Offender[] {
  const out: Offender[] = [];
  for (const path of walk(SRC)) {
    const file = relative(SRC, path).split(sep).join("/");
    const css = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const body = m[2] ?? "";
      const family = /font-family\s*:\s*([^;]+)/.exec(body)?.[1] ?? "";
      const shorthand = /(?<![-\w])font\s*:\s*([^;]+)/.exec(body)?.[1] ?? "";
      const pixel = (PIXEL_FAMILY.test(family) && !family.trim().startsWith("var(--font-ui")) || PIXEL_FAMILY.test(shorthand);
      if (!pixel) continue;
      const size = (/font-size\s*:\s*([^;]+)/.exec(body)?.[1] ?? shorthand).trim();
      if (size === "" || GRID_SIZE.test(size)) continue;
      out.push({ file, line: css.slice(0, (m.index ?? 0) + (m[1]?.length ?? 0)).split("\n").length, selector: (m[1] ?? "").trim().slice(-60), size });
    }
  }
  return out;
}

describe("pixel typography", () => {
  it("sets Geist Pixel only at pixel-exact sizes", () => {
    expect(offenders()).toEqual([]);
  });
});

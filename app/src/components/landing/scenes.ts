/**
 * Dot-matrix illustrations (see ./dotmatrix.ts): the 404 page's scrambling
 * "404". A pure function of running time over a cell grid; coordinates are in
 * cells: x = column, y = row (row 0 at the top).
 */
import { clamp01, INK, pointerGlow, rng, type Scene } from "./dotmatrix";

// ------------------------------------------------------- dot font ---

const FONT: Record<string, string[]> = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  ",": ["00", "00", "00", "00", "01", "01", "10"],
  ".": ["0", "0", "0", "0", "0", "0", "1"],
};

// --------------------------------------------------------------- 404 ---

interface NotFoundState {
  cells: { c: number; r: number; at: number }[];
  rand: () => number;
}

/**
 * The 404 page's "404": dot-matrix glyphs (2x2 dots per font pixel) that
 * scramble in from noise in under a second, then a slow scan column passes
 * across them. Pointer light as everywhere else.
 */
export const notFoundScene: Scene<NotFoundState> = {
  pitch: (w) => (w < 520 ? 6 : 9),
  base: 0.8,
  radius: 0.4,
  still: 2,
  init: (g) => {
    const rand = rng(404);
    const glyphs = ["4", "0", "4"].map((d) => FONT[d] ?? []);
    const scale = g.cols >= 3 * 5 * 2 + 2 * 2 * 2 + 4 ? 2 : 1;
    const wide = (3 * 5 + 2 * 2) * scale;
    const c0 = Math.floor((g.cols - wide) / 2);
    const r0 = Math.floor((g.rows - 7 * scale) / 2);
    const cells: NotFoundState["cells"] = [];
    glyphs.forEach((rows, gi) => {
      rows.forEach((bits, r) => {
        [...bits].forEach((b, c) => {
          if (b !== "1") return;
          for (let dy = 0; dy < scale; dy++)
            for (let dx = 0; dx < scale; dx++) cells.push({ c: c0 + (gi * 7 + c) * scale + dx, r: r0 + r * scale + dy, at: 0.15 + rand() * 0.7 });
        });
      });
    });
    return { cells, rand };
  },
  step(g, s, t) {
    g.clear();
    // Scramble-in: noise dots flicker while the glyph dots resolve one by one.
    if (t < 1) {
      const n = Math.round(g.cols * g.rows * 0.05 * (1 - t));
      for (let i = 0; i < n; i++) g.set(Math.floor(s.rand() * g.cols), Math.floor(s.rand() * g.rows), 0.35 + s.rand() * 0.4, INK.muted);
    }
    const scan = ((t * 0.35) % 1.4) * g.cols - g.cols * 0.2;
    for (const cell of s.cells) {
      if (t < cell.at) continue;
      const fresh = clamp01(1 - (t - cell.at) / 0.25);
      const near = Math.max(0, 1 - Math.abs(cell.c - scan) / 3);
      g.set(cell.c, cell.r, 0.72 + 0.28 * Math.max(fresh, near), fresh > 0.4 ? INK.text : INK.signal);
    }
    pointerGlow(g, 4, 0.35);
  },
};

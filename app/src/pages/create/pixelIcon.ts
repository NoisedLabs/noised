/**
 * Token icons as 32x32 pixel art with at most 16 colours (PIXEL_V6 §4).
 *
 * An icon is a palette of up to 16 "#rrggbb" colours and 1024 pixels, each
 * empty (transparent) or an index into the palette. In the draft the pixels
 * are a 1024-character string, one character per pixel: "." for empty, or
 * a hex digit 0-f for the palette slot. Packed for storage that is 4 bits a
 * pixel (512 bytes, slot 15 doubling as "empty" when the palette has fewer
 * than 16 colours) plus 3 bytes a colour.
 *
 * Pure functions only (no DOM): the editor (PixelIconEditor.tsx) draws them.
 */

export const ICON_SIZE = 32;
export const ICON_PIXELS = ICON_SIZE * ICON_SIZE;
export const ICON_MAX_COLORS = 16;
export const EMPTY = ".";

export interface IconDraft {
  /** Up to 16 colours, "#rrggbb" (lower case). */
  palette: readonly string[];
  /** 1024 characters: "." or a hex digit (a palette slot). Row by row, top left first. */
  pixels: string;
}

/**
 * The editor's default 16 colours: a neutral ramp (it suits the graphite
 * site) and ten clear hues for the token's own colours.
 */
export const DEFAULT_PALETTE: readonly string[] = [
  "#0b0b0c",
  "#2c2c30",
  "#5c5c63",
  "#9d9da5",
  "#d9d9de",
  "#ffffff",
  "#ff4f5e",
  "#ff9b3d",
  "#ffd84d",
  "#4fe07f",
  "#2fcfc2",
  "#3d8bff",
  "#7b5cff",
  "#ff6fd2",
  "#8b5a3c",
  "#f1c8a0",
];

export const blankPixels = (): string => EMPTY.repeat(ICON_PIXELS);

export const blankIcon = (palette: readonly string[] = DEFAULT_PALETTE): IconDraft => ({ palette: [...palette], pixels: blankPixels() });

/** Slot of a pixel character, or -1 for empty / anything else. */
export function slotOf(ch: string | undefined): number {
  if (ch === undefined || ch === EMPTY) return -1;
  const n = Number.parseInt(ch, 16);
  return Number.isInteger(n) && n >= 0 && n < ICON_MAX_COLORS ? n : -1;
}

export const charOf = (slot: number): string => (slot < 0 ? EMPTY : slot.toString(16));

export const isBlank = (pixels: string): boolean => !/[0-9a-f]/.test(pixels);

/** Pixels that are not empty. */
export function filledCount(pixels: string): number {
  let n = 0;
  for (let i = 0; i < pixels.length; i++) if (pixels[i] !== EMPTY) n++;
  return n;
}

/** Palette slots the pixels use (sorted). */
export function usedSlots(pixels: string): number[] {
  const seen = new Set<number>();
  for (let i = 0; i < pixels.length; i++) {
    const s = slotOf(pixels[i]);
    if (s >= 0) seen.add(s);
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * The slot to draw with by default: the most used colour that is neither
 * near-black nor near-white (an outline or a highlight), else the most used.
 */
export function mainSlot(icon: IconDraft, fallback = 11): number {
  const counts = new Map<number, number>();
  for (let i = 0; i < icon.pixels.length; i++) {
    const s = slotOf(icon.pixels[i]);
    if (s >= 0) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((x, y) => y[1] - x[1]).map(([s]) => s);
  const mid = ranked.find((s) => {
    const [r, g, b] = hexToRgb(icon.palette[s] ?? "#000000");
    const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return l > 0.12 && l < 0.92;
  });
  return mid ?? ranked[0] ?? fallback;
}

/** Bytes the icon takes packed: 4 bits a pixel plus 3 bytes for each palette colour it uses. */
export function packedBytes(icon: IconDraft): number {
  return ICON_PIXELS / 2 + usedSlots(icon.pixels).length * 3;
}

export const HEX = /^#[0-9a-f]{6}$/;

export function normalizeHex(c: string): string | null {
  const t = c.trim().toLowerCase();
  if (HEX.test(t)) return t;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(t);
  return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : null;
}

export function hexToRgb(c: string): [number, number, number] {
  const h = normalizeHex(c) ?? "#000000";
  return [Number.parseInt(h.slice(1, 3), 16), Number.parseInt(h.slice(3, 5), 16), Number.parseInt(h.slice(5, 7), 16)];
}

export const rgbToHex = (r: number, g: number, b: number): string => `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;

// ------------------------------------------------------------- editing ---

/** The pixels with the cells at `indices` set to `ch`. Returns the same string when nothing changes. */
export function setPixels(pixels: string, indices: Iterable<number>, ch: string): string {
  let out: string[] | null = null;
  for (const i of indices) {
    if (i < 0 || i >= ICON_PIXELS) continue;
    if ((out ?? pixels)[i] === ch) continue;
    out ??= pixels.split("");
    out[i] = ch;
  }
  return out === null ? pixels : out.join("");
}

export const indexOf = (x: number, y: number): number => (x < 0 || y < 0 || x >= ICON_SIZE || y >= ICON_SIZE ? -1 : y * ICON_SIZE + x);

/** The cells of a straight line (Bresenham), both ends included. */
export function lineCells(x0: number, y0: number, x1: number, y1: number): number[] {
  const out: number[] = [];
  let x = x0;
  let y = y0;
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (let guard = 0; guard < 4 * ICON_SIZE; guard++) {
    const i = indexOf(x, y);
    if (i >= 0) out.push(i);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
  return out;
}

/** The cell and, with `mirror`, its mirror image across the vertical centre line. */
export function withMirror(cells: readonly number[], mirror: boolean): number[] {
  if (!mirror) return [...cells];
  const out = new Set<number>(cells);
  for (const i of cells) out.add(Math.floor(i / ICON_SIZE) * ICON_SIZE + (ICON_SIZE - 1 - (i % ICON_SIZE)));
  return [...out];
}

/** The 4-connected region of same-valued cells around (x, y). */
export function fillCells(pixels: string, x: number, y: number): number[] {
  const start = indexOf(x, y);
  if (start < 0) return [];
  const target = pixels[start];
  const seen = new Uint8Array(ICON_PIXELS);
  const stack = [start];
  const out: number[] = [];
  seen[start] = 1;
  while (stack.length > 0) {
    const i = stack.pop() as number;
    out.push(i);
    const cx = i % ICON_SIZE;
    const cy = (i - cx) / ICON_SIZE;
    for (const [nx, ny] of [
      [cx + 1, cy],
      [cx - 1, cy],
      [cx, cy + 1],
      [cx, cy - 1],
    ] as const) {
      const n = indexOf(nx, ny);
      if (n < 0 || seen[n] === 1 || pixels[n] !== target) continue;
      seen[n] = 1;
      stack.push(n);
    }
  }
  return out;
}

/** Moves every pixel by (dx, dy), wrapping around the edges. */
export function shiftPixels(pixels: string, dx: number, dy: number): string {
  const out = new Array<string>(ICON_PIXELS);
  for (let y = 0; y < ICON_SIZE; y++) {
    for (let x = 0; x < ICON_SIZE; x++) {
      const sx = (((x - dx) % ICON_SIZE) + ICON_SIZE) % ICON_SIZE;
      const sy = (((y - dy) % ICON_SIZE) + ICON_SIZE) % ICON_SIZE;
      out[y * ICON_SIZE + x] = pixels[sy * ICON_SIZE + sx] ?? EMPTY;
    }
  }
  return out.join("");
}

/** The pixels mirrored left to right. */
export function flipPixels(pixels: string): string {
  const out = new Array<string>(ICON_PIXELS);
  for (let y = 0; y < ICON_SIZE; y++) for (let x = 0; x < ICON_SIZE; x++) out[y * ICON_SIZE + x] = pixels[y * ICON_SIZE + (ICON_SIZE - 1 - x)] ?? EMPTY;
  return out.join("");
}

// ------------------------------------------------------------ quantize ---

interface Box {
  px: number[][];
}

function channelRange(px: number[][], c: number): number {
  let lo = 255;
  let hi = 0;
  for (const p of px) {
    const v = p[c] ?? 0;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return hi - lo;
}

/**
 * An RGBA image of exactly 32x32 pixels as an icon: pixels under 50% alpha
 * become empty, the rest are reduced to at most `maxColors` colours by
 * median cut and mapped to the nearest one.
 */
export function quantizeRgba(rgba: Uint8ClampedArray | Uint8Array, maxColors = ICON_MAX_COLORS): IconDraft {
  const opaque: number[][] = [];
  for (let i = 0; i < ICON_PIXELS; i++) {
    const a = rgba[i * 4 + 3] ?? 0;
    if (a >= 128) opaque.push([rgba[i * 4] ?? 0, rgba[i * 4 + 1] ?? 0, rgba[i * 4 + 2] ?? 0]);
  }
  if (opaque.length === 0) return blankIcon();

  // Median cut: split the box with the widest channel until there are enough boxes.
  const boxes: Box[] = [{ px: opaque }];
  const limit = Math.max(1, Math.min(ICON_MAX_COLORS, maxColors));
  while (boxes.length < limit) {
    let best = -1;
    let bestRange = 0;
    let bestChannel = 0;
    boxes.forEach((b, i) => {
      if (b.px.length < 2) return;
      for (let c = 0; c < 3; c++) {
        const r = channelRange(b.px, c);
        // Bigger boxes win ties, so busy colour areas get more colours.
        const score = r * Math.sqrt(b.px.length);
        if (r > 0 && score > bestRange) {
          bestRange = score;
          best = i;
          bestChannel = c;
        }
      }
    });
    if (best < 0) break;
    const box = boxes[best] as Box;
    const sorted = [...box.px].sort((a, b) => (a[bestChannel] ?? 0) - (b[bestChannel] ?? 0));
    const mid = Math.floor(sorted.length / 2);
    boxes.splice(best, 1, { px: sorted.slice(0, mid) }, { px: sorted.slice(mid) });
  }
  const palette = boxes.map((b) => {
    const sum = [0, 0, 0];
    for (const p of b.px) for (let c = 0; c < 3; c++) sum[c] = (sum[c] ?? 0) + (p[c] ?? 0);
    return [(sum[0] ?? 0) / b.px.length, (sum[1] ?? 0) / b.px.length, (sum[2] ?? 0) / b.px.length] as [number, number, number];
  });
  // Merge colours that rounded to the same hex.
  const hexes: string[] = [];
  for (const [r, g, b] of palette) {
    const h = rgbToHex(r, g, b);
    if (!hexes.includes(h)) hexes.push(h);
  }
  const rgb = hexes.map(hexToRgb);
  const out: string[] = [];
  for (let i = 0; i < ICON_PIXELS; i++) {
    const a = rgba[i * 4 + 3] ?? 0;
    if (a < 128) {
      out.push(EMPTY);
      continue;
    }
    const r = rgba[i * 4] ?? 0;
    const g = rgba[i * 4 + 1] ?? 0;
    const b = rgba[i * 4 + 2] ?? 0;
    let best = 0;
    let bestD = Number.POSITIVE_INFINITY;
    rgb.forEach(([pr, pg, pb], s) => {
      // Weighted distance (the eye is most sensitive to green).
      const d = 2 * (r - pr) ** 2 + 4 * (g - pg) ** 2 + 3 * (b - pb) ** 2;
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    });
    out.push(charOf(best));
  }
  return { palette: hexes, pixels: out.join("") };
}

/**
 * The icon with its palette padded back to 16 editable slots (the unused
 * ones from the default palette), so a quantized upload can be retouched.
 */
export function withFullPalette(icon: IconDraft): IconDraft {
  const palette = [...icon.palette];
  for (const c of DEFAULT_PALETTE) {
    if (palette.length >= ICON_MAX_COLORS) break;
    if (!palette.includes(c)) palette.push(c);
  }
  return { palette, pixels: icon.pixels };
}

// ------------------------------------------------------------ generate ---

/** A small deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 32-bit hash of a string (FNV-1a), for seeding the generator from a name. */
export function seedOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const HUE_SLOTS = [6, 7, 8, 9, 10, 11, 12, 13] as const;

/**
 * A symmetric pixel creature / crest from a seed: a 12x12 half-random mask
 * mirrored left to right, doubled to 24x24, centred, with a dark outline,
 * a lit top edge and two eyes. Uses the default palette's slots.
 */
export function generateIcon(seed: number, palette: readonly string[] = DEFAULT_PALETTE): IconDraft {
  const r = rng(seed);
  const N = 12;
  const half = N / 2;
  const mask: boolean[] = new Array<boolean>(N * N).fill(false);
  for (let tries = 0; tries < 8; tries++) {
    mask.fill(false);
    for (let y = 1; y < N - 1; y++) {
      for (let x = 0; x < half; x++) {
        // Denser towards the middle column and the vertical centre: a body, not noise.
        const dx = (half - 1 - x) / half;
        const dy = Math.abs(y - N / 2 + 0.5) / (N / 2);
        const p = 0.78 - dx * 0.55 - dy * 0.32;
        const on = r() < p;
        mask[y * N + x] = on;
        mask[y * N + (N - 1 - x)] = on;
      }
    }
    const filled = mask.filter(Boolean).length;
    if (filled > N * N * 0.28 && filled < N * N * 0.72) break;
  }
  // Two tones: a body hue and a darker or lighter accent; outline in near-black.
  const body: number = HUE_SLOTS[Math.floor(r() * HUE_SLOTS.length)] ?? 11;
  let accent: number = HUE_SLOTS[Math.floor(r() * HUE_SLOTS.length)] ?? 8;
  if (accent === body) accent = 5;
  const light = 5;
  const outline = 0;
  const cells = new Array<number>(ICON_PIXELS).fill(-1);
  const off = (ICON_SIZE - N * 2) / 2;
  // Accent bands on a few rows (decided per row, so the sides match).
  const bands = Array.from({ length: N }, (_, y) => (y * 7 + seed) % 5 === 0 && r() < 0.8);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (!mask[y * N + x]) continue;
      const band = bands[y] === true;
      for (let k = 0; k < 4; k++) {
        const px = off + x * 2 + (k & 1);
        const py = off + y * 2 + (k >> 1);
        cells[py * ICON_SIZE + px] = band ? accent : body;
      }
    }
  }
  // Light on the top edges (a pixel highlight).
  for (let y = 1; y < ICON_SIZE; y++) {
    for (let x = 0; x < ICON_SIZE / 2; x++) {
      const lit = r() < 0.4;
      for (const cx of [x, ICON_SIZE - 1 - x]) {
        const i = y * ICON_SIZE + cx;
        if (lit && cells[i] !== -1 && cells[i - ICON_SIZE] === -1) cells[i] = light;
      }
    }
  }
  // Eyes: two dark 2x2 dots, mirrored, in the upper half of the body.
  const eyeRow = off + 2 * (3 + Math.floor(r() * 3));
  const eyeCol = off + 2 * (2 + Math.floor(r() * 3));
  for (const ex of [eyeCol, ICON_SIZE - 2 - eyeCol]) {
    const inside = cells[eyeRow * ICON_SIZE + ex] !== -1;
    if (!inside) continue;
    for (let k = 0; k < 4; k++) cells[(eyeRow + (k >> 1)) * ICON_SIZE + ex + (k & 1)] = outline;
  }
  // Outline: every empty cell touching the body.
  const outlined = [...cells];
  for (let y = 0; y < ICON_SIZE; y++) {
    for (let x = 0; x < ICON_SIZE; x++) {
      const i = y * ICON_SIZE + x;
      if (cells[i] !== -1) continue;
      const touch = [indexOf(x + 1, y), indexOf(x - 1, y), indexOf(x, y + 1), indexOf(x, y - 1)].some((n) => n >= 0 && cells[n] !== -1);
      if (touch) outlined[i] = outline;
    }
  }
  return { palette: [...palette], pixels: outlined.map(charOf).join("") };
}

// ---------------------------------------------------------- on-chain icon ---

/**
 * The icon as RGBA bytes (32 x 32 x 4, row by row): empty pixels fully
 * transparent, the others their palette colour, opaque. What the record's
 * PNG is made of (`encodeIndexedPng` keeps the exact colours: at most 16
 * plus transparent).
 */
export function iconRgba(icon: IconDraft): Uint8Array {
  const out = new Uint8Array(ICON_PIXELS * 4);
  for (let i = 0; i < ICON_PIXELS; i++) {
    const slot = slotOf(icon.pixels[i]);
    const colour = slot < 0 ? undefined : icon.palette[slot];
    if (colour === undefined) continue;
    const [r, g, b] = hexToRgb(colour);
    out.set([r, g, b, 255], i * 4);
  }
  return out;
}

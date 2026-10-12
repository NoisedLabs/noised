/**
 * Token pixel icons (PIXEL_V6 section 4): 32x32, at most 16 colours, stored by Noised itself (no links).
 *
 *   const icon = quantizeToIcon(imageBitmap);            // upload -> 32x32, <= 16 colours (median cut)
 *   const icon = emptyIcon();                            // a blank icon for the built-in editor
 *   setPixel(icon, x, y, paletteIndex);                  // edit (255 = transparent)
 *   <img src={iconToDataUrl(icon, 8)} alt="" />          // crisp preview (img-src data: is allowed)
 *   const bytes = packIcon(icon);                        // compact bytes (<= 3 + 64 + 512) for the draft / chain
 *   const back = unpackIcon(bytes);
 *   const text = iconToBase64(icon); iconFromBase64(text);
 *
 * PixelIcon.pixels holds one palette index per pixel, row-major; TRANSPARENT (255) is an empty pixel.
 */

export const TRANSPARENT = 255;
export const ICON_SIZE = 32;
export const ICON_MAX_COLORS = 16;

export interface PixelIcon {
  size: number;
  /** "#rrggbb" colours, at most 16. */
  palette: string[];
  /** size * size palette indices (TRANSPARENT = empty). */
  pixels: Uint8Array;
}

/**
 * The editor palette: 15 colours + transparent (packIcon keeps nibble 15 for "empty"). A neutral ramp first (it
 * matches the monochrome UI), then muted accents so creators can still make a colourful icon.
 */
export const ICON_PALETTE: readonly string[] = [
  "#0a0a0a",
  "#555555",
  "#8a8a8a",
  "#c2c2c2",
  "#f5f5f5",
  "#7a2e2e",
  "#d0605a",
  "#c98a2c",
  "#e8cf6b",
  "#2f6b45",
  "#6cc28a",
  "#2e5a8a",
  "#79aee0",
  "#5b3f86",
  "#b48ad9",
];

export function emptyIcon(size = ICON_SIZE, palette: readonly string[] = ICON_PALETTE): PixelIcon {
  return { size, palette: [...palette].slice(0, ICON_MAX_COLORS), pixels: new Uint8Array(size * size).fill(TRANSPARENT) };
}

export function getPixel(icon: PixelIcon, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= icon.size || y >= icon.size) return TRANSPARENT;
  return icon.pixels[y * icon.size + x] ?? TRANSPARENT;
}

/** Returns a NEW icon (immutable update, React friendly). */
export function setPixel(icon: PixelIcon, x: number, y: number, index: number): PixelIcon {
  if (x < 0 || y < 0 || x >= icon.size || y >= icon.size) return icon;
  const i = y * icon.size + x;
  if (icon.pixels[i] === index) return icon;
  const pixels = icon.pixels.slice();
  pixels[i] = index;
  return { ...icon, pixels };
}

/** Flood fill (4-connected) from (x, y) with `index`. Returns a new icon. */
export function fillPixels(icon: PixelIcon, x: number, y: number, index: number): PixelIcon {
  const target = getPixel(icon, x, y);
  if (target === index || x < 0 || y < 0 || x >= icon.size || y >= icon.size) return icon;
  const pixels = icon.pixels.slice();
  const stack: number[] = [x, y];
  while (stack.length) {
    const py = stack.pop() ?? 0;
    const px = stack.pop() ?? 0;
    if (px < 0 || py < 0 || px >= icon.size || py >= icon.size) continue;
    const i = py * icon.size + px;
    if (pixels[i] !== target) continue;
    pixels[i] = index;
    stack.push(px + 1, py, px - 1, py, px, py + 1, px, py - 1);
  }
  return { ...icon, pixels };
}

/** True when every pixel is transparent. */
export function isIconEmpty(icon: PixelIcon): boolean {
  return icon.pixels.every((p) => p === TRANSPARENT);
}

function hex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
}

function parseHex(c: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
  const n = m?.[1] ? Number.parseInt(m[1], 16) : 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Median cut over opaque RGB samples -> up to `max` representative colours. */
function medianCut(samples: number[][], max: number): number[][] {
  if (samples.length === 0) return [];
  let boxes: number[][][] = [samples];
  while (boxes.length < max) {
    // Split the box with the widest channel range.
    let best = -1;
    let bestRange = 0;
    let bestCh = 0;
    boxes.forEach((box, bi) => {
      if (box.length < 2) return;
      for (let ch = 0; ch < 3; ch++) {
        let lo = 255;
        let hi = 0;
        for (const s of box) {
          const v = s[ch] ?? 0;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        if (hi - lo > bestRange) {
          bestRange = hi - lo;
          best = bi;
          bestCh = ch;
        }
      }
    });
    if (best < 0 || bestRange < 8) break;
    const box = (boxes[best] ?? []).slice().sort((a, b) => (a[bestCh] ?? 0) - (b[bestCh] ?? 0));
    const mid = box.length >> 1;
    boxes = [...boxes.slice(0, best), box.slice(0, mid), box.slice(mid), ...boxes.slice(best + 1)];
  }
  return boxes
    .filter((b) => b.length > 0)
    .map((box) => {
      const sum = [0, 0, 0];
      for (const s of box) for (let ch = 0; ch < 3; ch++) sum[ch]! += s[ch] ?? 0;
      return sum.map((v) => v / box.length);
    });
}

export interface QuantizeOptions {
  size?: number;
  maxColors?: number;
  /** "cover" (default): centre-crop to a square; "contain": letterbox with transparency. */
  fit?: "cover" | "contain";
  /** Alpha below this (0-255) becomes transparent (default 110). */
  alphaCutoff?: number;
}

/**
 * Downscale any image (img, ImageBitmap, canvas, video frame) to size x size and quantize to <= maxColors.
 * Downscaling averages 4x4 blocks of a 4x-size draw, so detail survives better than one bilinear pass.
 */
export function quantizeToIcon(source: CanvasImageSource, { size = ICON_SIZE, maxColors = ICON_MAX_COLORS, fit = "cover", alphaCutoff = 110 }: QuantizeOptions = {}): PixelIcon {
  const big = size * 4;
  const c = document.createElement("canvas");
  c.width = big;
  c.height = big;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return emptyIcon(size);
  const dims = source as { width?: number | { baseVal?: { value: number } }; height?: number | { baseVal?: { value: number } }; naturalWidth?: number; naturalHeight?: number; videoWidth?: number; videoHeight?: number };
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  const sw = num(dims.naturalWidth) || num(dims.videoWidth) || num(dims.width) || big;
  const sh = num(dims.naturalHeight) || num(dims.videoHeight) || num(dims.height) || big;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  if (fit === "cover") {
    const s = Math.min(sw, sh);
    ctx.drawImage(source, (sw - s) / 2, (sh - s) / 2, s, s, 0, 0, big, big);
  } else {
    const k = big / Math.max(sw, sh);
    const w = sw * k;
    const h = sh * k;
    ctx.drawImage(source, 0, 0, sw, sh, (big - w) / 2, (big - h) / 2, w, h);
  }
  const data = ctx.getImageData(0, 0, big, big).data;
  // Box-average 4x4 blocks (alpha-weighted colour).
  const rgba: number[][] = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let j = 0; j < 4; j++) {
        for (let i = 0; i < 4; i++) {
          const o = ((y * 4 + j) * big + (x * 4 + i)) * 4;
          const al = data[o + 3] ?? 0;
          r += (data[o] ?? 0) * al;
          g += (data[o + 1] ?? 0) * al;
          b += (data[o + 2] ?? 0) * al;
          a += al;
        }
      }
      rgba.push(a > 0 ? [r / a, g / a, b / a, a / 16] : [0, 0, 0, 0]);
    }
  }
  const opaque = rgba.filter((p) => (p[3] ?? 0) >= alphaCutoff);
  // Keep one nibble free for transparency when the image has see-through pixels (see packIcon).
  const cap = opaque.length < rgba.length ? ICON_MAX_COLORS - 1 : ICON_MAX_COLORS;
  const colours = medianCut(opaque, Math.max(1, Math.min(cap, maxColors)));
  const pixels = new Uint8Array(size * size).fill(TRANSPARENT);
  rgba.forEach((p, i) => {
    if ((p[3] ?? 0) < alphaCutoff) return;
    let best = 0;
    let bestD = Infinity;
    colours.forEach((c2, ci) => {
      // Perceptual-ish weights (red 0.3, green 0.59, blue 0.11).
      const dr = (p[0] ?? 0) - (c2[0] ?? 0);
      const dg = (p[1] ?? 0) - (c2[1] ?? 0);
      const db = (p[2] ?? 0) - (c2[2] ?? 0);
      const d = dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11;
      if (d < bestD) {
        bestD = d;
        best = ci;
      }
    });
    pixels[i] = best;
  });
  return { size, palette: colours.map((c2) => hex(c2[0] ?? 0, c2[1] ?? 0, c2[2] ?? 0)), pixels };
}

/** Draw the icon into a new canvas at an integer scale (crisp). */
export function iconToCanvas(icon: PixelIcon, scale = 1): HTMLCanvasElement {
  const k = Math.max(1, Math.floor(scale));
  const c = document.createElement("canvas");
  c.width = icon.size * k;
  c.height = icon.size * k;
  const ctx = c.getContext("2d");
  if (!ctx) return c;
  for (let y = 0; y < icon.size; y++) {
    for (let x = 0; x < icon.size; x++) {
      const idx = icon.pixels[y * icon.size + x] ?? TRANSPARENT;
      const col = idx === TRANSPARENT ? undefined : icon.palette[idx];
      if (!col) continue;
      ctx.fillStyle = col;
      ctx.fillRect(x * k, y * k, k, k);
    }
  }
  return c;
}

/** PNG data: URL of the icon (img-src 'self' data: allows it). Scale >= 4 keeps previews crisp everywhere. */
export function iconToDataUrl(icon: PixelIcon, scale = 1): string {
  return iconToCanvas(icon, scale).toDataURL("image/png");
}

/**
 * Compact binary form: [version 1][size][n colours][n x RGB][size*size/2 bytes of 4-bit indices]. Index 15 is
 * transparent when the palette has fewer than 16 colours; with 16 colours, transparency is not representable and
 * transparent pixels become colour 0.
 */
export function packIcon(icon: PixelIcon): Uint8Array {
  const n = Math.min(ICON_MAX_COLORS, icon.palette.length);
  const count = icon.size * icon.size;
  const out = new Uint8Array(3 + n * 3 + Math.ceil(count / 2));
  out[0] = 1;
  out[1] = icon.size;
  out[2] = n;
  icon.palette.slice(0, n).forEach((c, i) => {
    const [r, g, b] = parseHex(c);
    out[3 + i * 3] = r;
    out[4 + i * 3] = g;
    out[5 + i * 3] = b;
  });
  const base = 3 + n * 3;
  const transparentNibble = n < 16 ? 15 : 0;
  for (let i = 0; i < count; i++) {
    const p = icon.pixels[i] ?? TRANSPARENT;
    const nib = p === TRANSPARENT || p >= n ? transparentNibble : p;
    const at = base + (i >> 1);
    out[at] = (out[at] ?? 0) | (i & 1 ? nib : nib << 4);
  }
  return out;
}

export function unpackIcon(bytes: Uint8Array): PixelIcon | null {
  if (bytes.length < 3 || bytes[0] !== 1) return null;
  const size = bytes[1] ?? 0;
  const n = bytes[2] ?? 0;
  if (size < 1 || size > 64 || n > 16) return null;
  const base = 3 + n * 3;
  const count = size * size;
  if (bytes.length < base + Math.ceil(count / 2)) return null;
  const palette: string[] = [];
  for (let i = 0; i < n; i++) palette.push(hex(bytes[3 + i * 3] ?? 0, bytes[4 + i * 3] ?? 0, bytes[5 + i * 3] ?? 0));
  const pixels = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const byte = bytes[base + (i >> 1)] ?? 0;
    const nib = i & 1 ? byte & 15 : byte >> 4;
    pixels[i] = n < 16 && nib === 15 ? TRANSPARENT : nib < n ? nib : TRANSPARENT;
  }
  return { size, palette, pixels };
}

export function iconToBase64(icon: PixelIcon): string {
  let s = "";
  for (const b of packIcon(icon)) s += String.fromCharCode(b);
  return btoa(s);
}

export function iconFromBase64(text: string): PixelIcon | null {
  try {
    const bin = atob(text);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return unpackIcon(bytes);
  } catch {
    return null;
  }
}

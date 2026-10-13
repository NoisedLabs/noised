/**
 * An uploaded logo as the token's on-chain icon: the best-looking smooth picture that fits in the token's metadata
 * document (owner's request, 2026-10-13: "don't pixelize it"). Pixel art stays an option (the 32 x 32 editor,
 * ./pixelIcon.ts); a picture never becomes pixel art.
 *
 *   1. The framed picture is shrunk to a square master (canvas, ./logo.ts) and from there to each icon size by area
 *      averaging with premultiplied alpha (`shrinkRgba`): no aliasing, and no dark fringe around transparent edges.
 *   2. Its colours are reduced to a palette of at most 256 (`quantizeLogo`): a variance-minimising median cut and a few
 *      k-means rounds in OKLab (a perceptual colour space), premultiplied by alpha, so partly transparent edges keep
 *      their soft look. Deterministic: the same picture always gives the same palette and pixels.
 *   3. The SDK's PNG encoder writes it, and `LogoFitter` keeps the best variant whose PNG fits in the bytes the
 *      document has left (`iconByteBudget`): 64 x 64 with 256, 192, 128, 96 then 64 colours, then the same at 56 and
 *      48 pixels. When even 48 x 48 with 64 colours does not fit, the creator is asked to shorten the description.
 *
 * Pure functions (no DOM): tested in test/logo-icon.test.ts.
 */
import { encodeIndexedPng, METADATA, type MetadataDocInput } from "../../lib/noised";

// -------------------------------------------------------------- variants ---

/** Icon sizes tried for an uploaded logo, best first (the SDK allows up to METADATA.MAX_ICON_SIDE). */
export const LOGO_SIDES: readonly number[] = [64, 56, 48];
/** Palette sizes tried at each size, best first. */
export const LOGO_COLOURS: readonly number[] = [256, 192, 128, 96, 64];

export interface LogoVariant {
  side: number;
  /** The most colours the palette may have (transparent counts as one). */
  colours: number;
}

/** Every variant in order of quality: 64 px with 256 -> 64 colours, then 56 px, then 48 px. */
export const LOGO_VARIANTS: readonly LogoVariant[] = LOGO_SIDES.flatMap((side) => LOGO_COLOURS.map((colours) => ({ side, colours })));

// ---------------------------------------------------------------- budget ---

const IMAGE_PREFIX = "data:image/png;base64,";
/** What an icon adds to the document besides its base64: `,"image":"data:image/png;base64,` and the closing quote. */
export const ICON_DOC_OVERHEAD = `,"image":"${IMAGE_PREFIX}"`.length;

const utf8Len = (s: string): number => new TextEncoder().encode(s).length;

/**
 * The document's text without an icon, exactly as the SDK writes it (`buildMetadataDoc`: compact JSON, the keys in the
 * fixed order name, symbol, description, image, external_url, extensions{x, telegram}, empty parts left out).
 */
export function docTextWithoutIcon(input: MetadataDocInput): string {
  const o: Record<string, unknown> = { name: input.name, symbol: input.symbol };
  const set = (k: string, v: string | undefined): void => {
    if (v !== undefined && v !== "") o[k] = v;
  };
  set("description", input.description);
  const links = input.links ?? {};
  set("external_url", links.website);
  const ext: Record<string, string> = {};
  if (links.x !== undefined && links.x !== "") ext["x"] = links.x;
  if (links.telegram !== undefined && links.telegram !== "") ext["telegram"] = links.telegram;
  if (Object.keys(ext).length > 0) o["extensions"] = ext;
  return JSON.stringify(o);
}

/**
 * The most bytes an icon's PNG can have in this document (name, symbol, description and links as entered; any icon in
 * `input` is ignored): the document holds at most METADATA.MAX_DOC_LEN bytes, the PNG goes in as base64 (4 characters
 * for every 3 bytes). 0 when there is no room at all.
 */
export function iconByteBudget(input: MetadataDocInput): number {
  const room = METADATA.MAX_DOC_LEN - utf8Len(docTextWithoutIcon(input)) - ICON_DOC_OVERHEAD;
  return room < 4 ? 0 : Math.floor(room / 4) * 3;
}

// ---------------------------------------------------------------- shrink ---

/** For each output index, the source indices it covers and how much of each (they sum to 1). */
function areaWeights(from: number, to: number): { first: Int32Array; count: Int32Array; weight: Float64Array; stride: number } {
  const ratio = from / to;
  const stride = Math.ceil(ratio) + 1;
  const first = new Int32Array(to);
  const count = new Int32Array(to);
  const weight = new Float64Array(to * stride);
  for (let o = 0; o < to; o++) {
    const x0 = o * ratio;
    const x1 = (o + 1) * ratio;
    const s0 = Math.floor(x0);
    const s1 = Math.min(from, Math.ceil(x1));
    first[o] = s0;
    count[o] = s1 - s0;
    for (let s = s0; s < s1; s++) weight[o * stride + (s - s0)] = (Math.min(x1, s + 1) - Math.max(x0, s)) / ratio;
  }
  return { first, count, weight, stride };
}

/**
 * A square RGBA image (straight alpha, `from` x `from`) shrunk to `to` x `to` by area averaging: every output pixel is
 * the exact average of the source area it covers. The colours are averaged premultiplied by alpha, so a transparent
 * pixel (whatever colour it nominally has) never darkens or tints the edge next to it.
 */
export function shrinkRgba(rgba: Uint8Array | Uint8ClampedArray, from: number, to: number): Uint8Array {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < 1) throw new RangeError("sizes must be positive integers");
  if (rgba.length !== from * from * 4) throw new RangeError(`expected ${from * from * 4} RGBA bytes, got ${rgba.length}`);
  const pre = new Float64Array(from * from * 4);
  for (let i = 0; i < from * from; i++) {
    const a = (rgba[i * 4 + 3] ?? 0) / 255;
    pre[i * 4] = (rgba[i * 4] ?? 0) * a;
    pre[i * 4 + 1] = (rgba[i * 4 + 1] ?? 0) * a;
    pre[i * 4 + 2] = (rgba[i * 4 + 2] ?? 0) * a;
    pre[i * 4 + 3] = a;
  }
  const w = areaWeights(from, to);
  // Rows first (from x from -> to x from), then columns (-> to x to).
  const mid = new Float64Array(to * from * 4);
  for (let y = 0; y < from; y++) {
    for (let o = 0; o < to; o++) {
      const s0 = w.first[o] ?? 0;
      const n = w.count[o] ?? 0;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = 0; k < n; k++) {
        const q = w.weight[o * w.stride + k] ?? 0;
        const i = (y * from + s0 + k) * 4;
        r += (pre[i] ?? 0) * q;
        g += (pre[i + 1] ?? 0) * q;
        b += (pre[i + 2] ?? 0) * q;
        a += (pre[i + 3] ?? 0) * q;
      }
      const j = (y * to + o) * 4;
      mid[j] = r;
      mid[j + 1] = g;
      mid[j + 2] = b;
      mid[j + 3] = a;
    }
  }
  const out = new Uint8Array(to * to * 4);
  for (let x = 0; x < to; x++) {
    for (let o = 0; o < to; o++) {
      const s0 = w.first[o] ?? 0;
      const n = w.count[o] ?? 0;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = 0; k < n; k++) {
        const q = w.weight[o * w.stride + k] ?? 0;
        const i = ((s0 + k) * to + x) * 4;
        r += (mid[i] ?? 0) * q;
        g += (mid[i + 1] ?? 0) * q;
        b += (mid[i + 2] ?? 0) * q;
        a += (mid[i + 3] ?? 0) * q;
      }
      const j = (o * to + x) * 4;
      const alpha = Math.round(a * 255);
      if (alpha <= 0) continue; // fully transparent: 0, 0, 0, 0
      out[j] = clampByte(r / a);
      out[j + 1] = clampByte(g / a);
      out[j + 2] = clampByte(b / a);
      out[j + 3] = Math.min(255, alpha);
    }
  }
  return out;
}

const clampByte = (v: number): number => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));

// ----------------------------------------------------------------- OKLab ---

const LINEAR = Float64Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

function toOklab(r8: number, g8: number, b8: number): [number, number, number] {
  const r = LINEAR[r8] ?? 0;
  const g = LINEAR[g8] ?? 0;
  const b = LINEAR[b8] ?? 0;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

const toSrgb8 = (v: number): number => clampByte(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(0, v) ** (1 / 2.4) - 0.055));

function fromOklab(L: number, A: number, B: number): [number, number, number] {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    toSrgb8(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toSrgb8(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toSrgb8(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

// -------------------------------------------------------------- quantize ---

/** A palette image as the SDK's `encodeIndexedPng` takes it: indices into RGBA quadruples. */
export interface LogoIndexed {
  readonly indices: Uint8Array;
  /** 4 bytes (R, G, B, A) per colour: transparent first, then partly transparent, then opaque (dark to light). */
  readonly palette: Uint8Array;
}

/** Alpha at or below this is fully transparent (invisible); at or above OPAQUE it is fully opaque. */
const CLEAR = 4;
const OPAQUE = 251;

const DIM = 4;

/** The feature vector of a colour: OKLab premultiplied by alpha, and alpha (so faint pixels count for little). */
function featureOf(key: number, out: Float64Array, at: number): void {
  const a = (key & 0xff) / 255;
  const [L, A, B] = toOklab(key >>> 24, (key >>> 16) & 0xff, (key >>> 8) & 0xff);
  out[at] = L * a;
  out[at + 1] = A * a;
  out[at + 2] = B * a;
  out[at + 3] = a;
}

/** The RGBA colour (packed) of a feature vector. */
function colourOf(f: Float64Array, at: number): number {
  const a = f[at + 3] ?? 0;
  if (a <= 0) return 0;
  const alpha = Math.max(CLEAR + 1, Math.min(255, Math.round(a * 255)));
  const [r, g, b] = fromOklab((f[at] ?? 0) / a, (f[at + 1] ?? 0) / a, (f[at + 2] ?? 0) / a);
  return ((r << 24) | (g << 16) | (b << 8) | (alpha >= OPAQUE ? 255 : alpha)) >>> 0;
}

function dist(f: Float64Array, i: number, c: Float64Array, j: number): number {
  const d0 = (f[i] ?? 0) - (c[j] ?? 0);
  const d1 = (f[i + 1] ?? 0) - (c[j + 1] ?? 0);
  const d2 = (f[i + 2] ?? 0) - (c[j + 2] ?? 0);
  const d3 = (f[i + 3] ?? 0) - (c[j + 3] ?? 0);
  return d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3;
}

/** Index of the nearest of `k` centres to feature `i` (ties: the lower index). */
function nearest(f: Float64Array, i: number, c: Float64Array, k: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let j = 0; j < k; j++) {
    const d = dist(f, i, c, j * DIM);
    if (d < bestD) {
      bestD = d;
      best = j;
    }
  }
  return best;
}

interface Box {
  /** Indices into the unique colours. */
  members: number[];
  sse: number;
}

/** Weighted sum of squared distances to the mean, of `members` (features `f`, weights `w`). */
function sseOf(members: readonly number[], f: Float64Array, w: Float64Array): number {
  let sw = 0;
  const s = [0, 0, 0, 0];
  let s2 = 0;
  for (const i of members) {
    const q = w[i] ?? 0;
    sw += q;
    for (let d = 0; d < DIM; d++) {
      const v = f[i * DIM + d] ?? 0;
      s[d] = (s[d] ?? 0) + q * v;
      s2 += q * v * v;
    }
  }
  if (sw <= 0) return 0;
  return Math.max(0, s2 - s.reduce((n, v) => n + v * v, 0) / sw);
}

/**
 * Split `box` along the axis where it varies most, at the cut that leaves the least total error (a 1-D optimal split
 * over the sorted colours). Null when it cannot be split.
 */
function splitBox(box: Box, f: Float64Array, w: Float64Array, keys: Uint32Array): [Box, Box] | null {
  const m = box.members;
  if (m.length < 2) return null;
  let axis = 0;
  let bestVar = -1;
  for (let d = 0; d < DIM; d++) {
    let sw = 0;
    let s = 0;
    let s2 = 0;
    for (const i of m) {
      const q = w[i] ?? 0;
      const v = f[i * DIM + d] ?? 0;
      sw += q;
      s += q * v;
      s2 += q * v * v;
    }
    const variance = sw > 0 ? s2 / sw - (s / sw) ** 2 : 0;
    if (variance > bestVar) {
      bestVar = variance;
      axis = d;
    }
  }
  const sorted = m.slice().sort((x, y) => (f[x * DIM + axis] ?? 0) - (f[y * DIM + axis] ?? 0) || (keys[x] ?? 0) - (keys[y] ?? 0));
  // Prefix sums of weight, weighted features and weighted squared norms: the error of any prefix or suffix in O(1).
  const n = sorted.length;
  const pw = new Float64Array(n + 1);
  const ps = new Float64Array((n + 1) * DIM);
  const p2 = new Float64Array(n + 1);
  for (let k = 0; k < n; k++) {
    const i = sorted[k] ?? 0;
    const q = w[i] ?? 0;
    pw[k + 1] = (pw[k] ?? 0) + q;
    let sq = 0;
    for (let d = 0; d < DIM; d++) {
      const v = f[i * DIM + d] ?? 0;
      ps[(k + 1) * DIM + d] = (ps[k * DIM + d] ?? 0) + q * v;
      sq += v * v;
    }
    p2[k + 1] = (p2[k] ?? 0) + q * sq;
  }
  const err = (from: number, to: number): number => {
    const sw = (pw[to] ?? 0) - (pw[from] ?? 0);
    if (sw <= 0) return 0;
    let mean2 = 0;
    for (let d = 0; d < DIM; d++) {
      const s = (ps[to * DIM + d] ?? 0) - (ps[from * DIM + d] ?? 0);
      mean2 += s * s;
    }
    return (p2[to] ?? 0) - (p2[from] ?? 0) - mean2 / sw;
  };
  let cut = -1;
  let bestErr = Infinity;
  for (let k = 1; k < n; k++) {
    // Only between different values along the axis (equal colours stay together).
    if ((f[(sorted[k - 1] ?? 0) * DIM + axis] ?? 0) === (f[(sorted[k] ?? 0) * DIM + axis] ?? 0)) continue;
    const e = err(0, k) + err(k, n);
    if (e < bestErr) {
      bestErr = e;
      cut = k;
    }
  }
  if (cut < 0) return null;
  const left = sorted.slice(0, cut);
  const right = sorted.slice(cut);
  return [
    { members: left, sse: Math.max(0, err(0, cut)) },
    { members: right, sse: Math.max(0, err(cut, n)) },
  ];
}

/** Lloyd (k-means) rounds after the median cut: each centre moves to the weighted mean of the colours nearest to it. */
const KMEANS_ROUNDS = 6;

/**
 * An RGBA image (straight alpha, 4 bytes a pixel) as a palette of at most `maxColours` colours (2..256; transparent
 * counts as one) and one index a pixel. Pixels at alpha <= 4 become transparent; alpha >= 251 counts as opaque. When
 * the image has few enough colours they are kept exactly; otherwise a variance-minimising median cut in premultiplied
 * OKLab, refined by k-means, picks them and every pixel takes the nearest. Deterministic.
 */
export function quantizeLogo(rgba: Uint8Array | Uint8ClampedArray, maxColours: number): LogoIndexed {
  if (!Number.isInteger(maxColours) || maxColours < 2 || maxColours > 256) throw new RangeError("maxColours must be an integer in 2..256");
  if (rgba.length % 4 !== 0 || rgba.length === 0) throw new RangeError("rgba must hold 4 bytes a pixel");
  const pixels = rgba.length / 4;
  // Packed colours (RGBA, transparent = 0) and their pixel counts.
  const packed = new Uint32Array(pixels);
  const counts = new Map<number, number>();
  for (let i = 0; i < pixels; i++) {
    const a = rgba[i * 4 + 3] ?? 0;
    const c = a <= CLEAR ? 0 : (((rgba[i * 4] ?? 0) << 24) | ((rgba[i * 4 + 1] ?? 0) << 16) | ((rgba[i * 4 + 2] ?? 0) << 8) | (a >= OPAQUE ? 255 : a)) >>> 0;
    packed[i] = c;
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const clear = counts.has(0);
  const keys = Uint32Array.from([...counts.keys()].filter((c) => c !== 0)).sort();
  const room = maxColours - (clear ? 1 : 0);

  let colours: number[];
  if (keys.length <= room) {
    colours = [...keys];
  } else {
    const u = keys.length;
    const f = new Float64Array(u * DIM);
    const w = new Float64Array(u);
    for (let i = 0; i < u; i++) {
      featureOf(keys[i] ?? 0, f, i * DIM);
      w[i] = counts.get(keys[i] ?? 0) ?? 0;
    }
    // Median cut: split the box with the most error until there are `room` boxes.
    const all = Array.from({ length: u }, (_, i) => i);
    const boxes: Box[] = [{ members: all, sse: sseOf(all, f, w) }];
    while (boxes.length < room) {
      let pick = -1;
      let most = 0;
      boxes.forEach((b, i) => {
        if (b.members.length > 1 && b.sse > most) {
          most = b.sse;
          pick = i;
        }
      });
      if (pick < 0) break;
      const halves = splitBox(boxes[pick] as Box, f, w, keys);
      if (halves === null) {
        (boxes[pick] as Box).sse = 0;
        continue;
      }
      boxes.splice(pick, 1, ...halves);
    }
    // Centres: the boxes' weighted means.
    const k = boxes.length;
    const centres = new Float64Array(k * DIM);
    const mean = (members: Iterable<number>, j: number): void => {
      let sw = 0;
      const s = [0, 0, 0, 0];
      for (const i of members) {
        const q = w[i] ?? 0;
        sw += q;
        for (let d = 0; d < DIM; d++) s[d] = (s[d] ?? 0) + q * (f[i * DIM + d] ?? 0);
      }
      if (sw > 0) for (let d = 0; d < DIM; d++) centres[j * DIM + d] = (s[d] ?? 0) / sw;
    };
    boxes.forEach((b, j) => mean(b.members, j));
    // k-means rounds.
    const owner = new Int32Array(u).fill(-1);
    for (let round = 0; round < KMEANS_ROUNDS; round++) {
      let moved = 0;
      for (let i = 0; i < u; i++) {
        const j = nearest(f, i * DIM, centres, k);
        if (owner[i] !== j) {
          owner[i] = j;
          moved++;
        }
      }
      if (moved === 0) break;
      const sums = new Float64Array(k * DIM);
      const sw = new Float64Array(k);
      for (let i = 0; i < u; i++) {
        const j = owner[i] ?? 0;
        const q = w[i] ?? 0;
        sw[j] = (sw[j] ?? 0) + q;
        for (let d = 0; d < DIM; d++) sums[j * DIM + d] = (sums[j * DIM + d] ?? 0) + q * (f[i * DIM + d] ?? 0);
      }
      for (let j = 0; j < k; j++) {
        const q = sw[j] ?? 0;
        if (q > 0) for (let d = 0; d < DIM; d++) centres[j * DIM + d] = (sums[j * DIM + d] ?? 0) / q;
      }
    }
    const set = new Set<number>();
    for (let j = 0; j < k; j++) {
      const c = colourOf(centres, j * DIM);
      if (c !== 0) set.add(c);
    }
    colours = [...set];
  }

  // Palette order: transparent, then partly transparent (by alpha), then opaque from dark to light.
  const lum = new Map<number, number>(colours.map((c) => [c, toOklab(c >>> 24, (c >>> 16) & 0xff, (c >>> 8) & 0xff)[0]]));
  colours.sort((x, y) => (x & 0xff) - (y & 0xff) || (lum.get(x) ?? 0) - (lum.get(y) ?? 0) || x - y);
  const palette = clear ? [0, ...colours] : colours;

  // Each distinct pixel colour -> the nearest palette colour (an exact match when it is one).
  const pf = new Float64Array(palette.length * DIM);
  palette.forEach((c, j) => featureOf(c, pf, j * DIM));
  const exact = new Map<number, number>(palette.map((c, j) => [c, j]));
  const one = new Float64Array(DIM);
  const lookup = new Map<number, number>();
  const indices = new Uint8Array(pixels);
  const firstOpaque = clear ? 1 : 0;
  for (let i = 0; i < pixels; i++) {
    const c = packed[i] ?? 0;
    let q = exact.get(c) ?? lookup.get(c);
    if (q === undefined) {
      featureOf(c, one, 0);
      // Never map a visible pixel to the transparent entry.
      q = firstOpaque + nearest(one, 0, pf.subarray(firstOpaque * DIM), palette.length - firstOpaque);
      lookup.set(c, q);
    }
    indices[i] = q;
  }
  const out = new Uint8Array(palette.length * 4);
  palette.forEach((c, j) => out.set([c >>> 24, (c >>> 16) & 0xff, (c >>> 8) & 0xff, c & 0xff], j * 4));
  return { indices, palette: out };
}

// ------------------------------------------------------------------- fit ---

/** The framed picture: a square RGBA image (straight alpha) at least 64 pixels a side, kept in memory only. */
export interface LogoSource {
  readonly rgba: Uint8Array;
  readonly side: number;
}

/** One stored icon made from a logo. */
export interface LogoIcon {
  /** The PNG that goes into the document, exactly. */
  readonly png: Uint8Array;
  readonly side: number;
  /** Colours in its palette (transparent counts as one). */
  readonly colours: number;
  /** The variant it was made as. */
  readonly variant: LogoVariant;
}

/** Writes a palette image as a PNG (the SDK's encoder by default). */
export type LogoEncoder = (image: LogoIndexed, side: number) => Promise<Uint8Array>;

const sdkEncoder: LogoEncoder = (image, side) => encodeIndexedPng(image, side, side, 256);

let fitters = 0;

/**
 * Makes and keeps the variants of one logo, so a change of budget (the description being typed) picks again without
 * redoing the work: `fit(budget)` makes variants in order of quality until one fits.
 */
export class LogoFitter {
  /** Tells logos apart (React keys, memo keys); the same object keeps its id. */
  readonly id = ++fitters;
  private readonly shrunk = new Map<number, Uint8Array>();
  private readonly made = new Map<string, Promise<LogoIcon>>();

  readonly source: LogoSource;
  private readonly encode: LogoEncoder;

  constructor(source: LogoSource, encode: LogoEncoder = sdkEncoder) {
    if (source.rgba.length !== source.side * source.side * 4) throw new RangeError("the logo's RGBA does not match its side");
    this.source = source;
    this.encode = encode;
  }

  /** The picture at `side` x `side` (shrunk once, then kept). */
  pixels(side: number): Uint8Array {
    let px = this.shrunk.get(side);
    if (px === undefined) {
      px = side === this.source.side ? this.source.rgba : shrinkRgba(this.source.rgba, this.source.side, side);
      this.shrunk.set(side, px);
    }
    return px;
  }

  /** The icon of one variant (made once, then kept). */
  variant(v: LogoVariant): Promise<LogoIcon> {
    const key = `${v.side}:${v.colours}`;
    let p = this.made.get(key);
    if (p === undefined) {
      const image = quantizeLogo(this.pixels(v.side), v.colours);
      p = this.encode(image, v.side).then((png) => ({ png, side: v.side, colours: image.palette.length / 4, variant: v }));
      this.made.set(key, p);
    }
    return p;
  }

  /** The best variant whose PNG is at most `budget` bytes (LOGO_VARIANTS order), or null when even the smallest is bigger. */
  async fit(budget: number): Promise<LogoIcon | null> {
    let last: LogoIcon | null = null;
    for (const v of LOGO_VARIANTS) {
      // A picture with fewer colours than allowed comes out the same with fewer allowed, down to its own count.
      if (last !== null && last.side === v.side && last.colours <= v.colours) continue;
      last = await this.variant(v);
      if (last.png.length <= budget) return last;
    }
    return null;
  }

  /** The smallest variant (48 x 48, 64 colours): what is reported when nothing fits. */
  smallest(): Promise<LogoIcon> {
    return this.variant(LOGO_VARIANTS[LOGO_VARIANTS.length - 1] as LogoVariant);
  }
}

/** `data:image/png;base64,…` of an icon, as the document stores it (and as an `<img>` shows it, under img-src data:). */
export function pngDataUri(png: Uint8Array): string {
  let s = "";
  for (let i = 0; i < png.length; i += 0x2000) s += String.fromCharCode(...png.subarray(i, i + 0x2000));
  return IMAGE_PREFIX + btoa(s);
}

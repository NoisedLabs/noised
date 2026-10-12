/**
 * Small indexed PNGs for a token's on-chain icon (METADATA_ONCHAIN.md §1.4,
 * §4.8): `encodeIndexedPng` writes a palette PNG (IHDR, PLTE, tRNS when a
 * colour is not opaque, IDAT, IEND) of at most 256 colours, and `pngInfo`
 * checks one strictly (signature, every chunk's CRC-32, IHDR first, IEND
 * last, nothing after it). Nothing here touches the network or the DOM.
 *
 * A 32x32 icon with 16 colours is at most about 700 bytes: 8 (signature) +
 * 25 (IHDR) + 60 (PLTE) + 28 (tRNS) + 567 (the 544 scanline bytes stored
 * uncompressed) + 12 (IEND); compressed, typically 130-660 bytes.
 */

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/** The 8-byte PNG signature (a copy: changing it changes nothing the checks use). */
export const PNG_SIGNATURE: Readonly<Uint8Array> = Uint8Array.from(SIGNATURE);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (ISO 3309, the PNG chunk checksum) of `bytes`. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Adler-32 (RFC 1950), the zlib trailer. */
function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const x of bytes) {
    a = (a + x) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function u32be(v: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, v >>> 0, false);
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const t = Uint8Array.from(type, (ch) => ch.charCodeAt(0));
  return concat([u32be(data.length), t, data, u32be(crc32(concat([t, data])))]);
}

/** A PNG's header, from `pngInfo`. */
export interface PngInfo {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  /** 0 grey, 2 RGB, 3 palette, 4 grey + alpha, 6 RGBA. */
  readonly colourType: number;
  readonly interlaced: boolean;
  /** Bytes of the whole file. */
  readonly length: number;
}

/** Thrown by `pngInfo` for bytes that are not a well-formed PNG. */
export class PngError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PngError";
  }
}

const VALID_DEPTHS: Readonly<Record<number, readonly number[]>> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

/**
 * The header of the PNG `bytes`, after checking its structure: the
 * signature, chunks whose lengths stay inside the file and whose CRC-32s
 * match, IHDR first (13 bytes; width and height 1..2^31-1, a valid colour
 * type and bit depth), IDAT present, IEND last with nothing after it.
 * Throws `PngError` otherwise. It does not inflate the image data.
 */
export function pngInfo(bytes: Uint8Array): PngInfo {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("png must be a Uint8Array");
  if (bytes.length < SIGNATURE.length || SIGNATURE.some((b, i) => bytes[i] !== b)) throw new PngError("not a PNG (wrong signature)");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = SIGNATURE.length;
  let header: Omit<PngInfo, "length"> | null = null;
  let sawIdat = false;
  for (let index = 0; ; index++) {
    if (off + 12 > bytes.length) throw new PngError("truncated chunk");
    const len = view.getUint32(off, false);
    if (len > bytes.length - off - 12) throw new PngError("a chunk runs past the end of the file");
    const type = String.fromCharCode(...bytes.subarray(off + 4, off + 8));
    if (!/^[A-Za-z]{4}$/.test(type)) throw new PngError("invalid chunk type");
    const data = bytes.subarray(off + 8, off + 8 + len);
    if (crc32(bytes.subarray(off + 4, off + 8 + len)) !== view.getUint32(off + 8 + len, false)) throw new PngError(`bad CRC in the ${type} chunk`);
    off += 12 + len;
    if (index === 0) {
      if (type !== "IHDR" || len !== 13) throw new PngError("the first chunk is not a 13-byte IHDR");
      const h = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const width = h.getUint32(0, false);
      const height = h.getUint32(4, false);
      const [bitDepth, colourType, compression, filter, interlace] = [data[8]!, data[9]!, data[10]!, data[11]!, data[12]!];
      if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) throw new PngError("invalid image size");
      if (!(VALID_DEPTHS[colourType] ?? []).includes(bitDepth)) throw new PngError(`invalid colour type ${colourType} / bit depth ${bitDepth}`);
      if (compression !== 0 || filter !== 0 || interlace > 1) throw new PngError("invalid compression, filter or interlace method");
      header = { width, height, bitDepth, colourType, interlaced: interlace === 1 };
      continue;
    }
    if (type === "IHDR") throw new PngError("a second IHDR");
    if (type === "IDAT") sawIdat = true;
    if (type === "IEND") {
      if (len !== 0) throw new PngError("IEND carries data");
      if (off !== bytes.length) throw new PngError("bytes after IEND");
      break;
    }
  }
  if (header === null || !sawIdat) throw new PngError("no image data");
  return { ...header, length: bytes.length };
}

/** An image as palette indices: `indices[y * width + x]` names a `palette` entry; the palette holds RGBA quadruples. */
export interface IndexedImage {
  readonly indices: Uint8Array;
  /** `4 * colours` bytes: R, G, B, A per entry. */
  readonly palette: Uint8Array;
}

/** `encodeIndexedPng` options. */
export interface EncodePngOptions {
  /**
   * `"auto"` (default): zlib through `CompressionStream("deflate")` when the
   * platform has it and the result is smaller, else stored. `"store"`:
   * uncompressed deflate blocks, byte-identical on every platform.
   */
  readonly compression?: "auto" | "store" | undefined;
}

/** zlib (RFC 1950) of `raw` with stored deflate blocks: header 78 01, blocks of at most 65,535 bytes, Adler-32. */
function zlibStored(raw: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [Uint8Array.of(0x78, 0x01)];
  let off = 0;
  do {
    const n = Math.min(65_535, raw.length - off);
    const final = off + n === raw.length ? 1 : 0;
    parts.push(Uint8Array.of(final, n & 0xff, n >>> 8, ~n & 0xff, (~n >>> 8) & 0xff), raw.subarray(off, off + n));
    off += n;
  } while (off < raw.length);
  parts.push(u32be(adler32(raw)));
  return concat(parts);
}

/** zlib of `raw` through the platform's `CompressionStream("deflate")`, or null without one. */
async function zlibDeflate(raw: Uint8Array): Promise<Uint8Array | null> {
  const CS = (globalThis as { CompressionStream?: new (format: "deflate") => { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> } }).CompressionStream;
  if (CS === undefined) return null;
  const cs = new CS("deflate");
  const writer = cs.writable.getWriter();
  const writing = writer.write(Uint8Array.from(raw)).then(() => writer.close());
  // A failed write also errors the readable side: the reads below (or the await after them) report it, never an unhandled rejection.
  writing.catch(() => undefined);
  const chunks: Uint8Array[] = [];
  const reader = cs.readable.getReader();
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    chunks.push(r.value);
  }
  await writing;
  return concat(chunks);
}

/** Colours of `rgba` (fully transparent pixels count as one colour, 0/0/0/0), as packed RGBA with their pixel counts. */
function histogram(rgba: Uint8Array): Map<number, number> {
  const counts = new Map<number, number>();
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3]!;
    const c = a === 0 ? 0 : ((rgba[i]! << 24) | (rgba[i + 1]! << 16) | (rgba[i + 2]! << 8) | a) >>> 0;
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return counts;
}

const channel = (c: number, k: number): number => (c >>> (24 - 8 * k)) & 0xff;

/**
 * Median cut down to `max` colours, deterministic: split the box with the
 * widest channel range (ties: the earlier box, then the lower channel) at
 * its pixel-weighted median along that channel; each box becomes the
 * rounded pixel-weighted mean of its colours.
 */
function medianCut(counts: Map<number, number>, max: number): number[] {
  type Box = { colours: number[] };
  const range = (b: Box, k: number): number => {
    let lo = 255;
    let hi = 0;
    for (const c of b.colours) {
      const v = channel(c, k);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return hi - lo;
  };
  const boxes: Box[] = [{ colours: [...counts.keys()].sort((a, b) => a - b) }];
  while (boxes.length < max) {
    let best = -1;
    let bestK = 0;
    let bestRange = 0;
    boxes.forEach((b, i) => {
      if (b.colours.length < 2) return;
      for (let k = 0; k < 4; k++) {
        const r = range(b, k);
        if (r > bestRange) [best, bestK, bestRange] = [i, k, r];
      }
    });
    if (best < 0) break;
    const box = boxes[best]!;
    const sorted = box.colours.slice().sort((a, b) => channel(a, bestK) - channel(b, bestK) || a - b);
    const total = sorted.reduce((n, c) => n + counts.get(c)!, 0);
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < sorted.length - 1; i++) {
      acc += counts.get(sorted[i]!)!;
      cut = i + 1;
      if (2 * acc >= total) break;
    }
    boxes.splice(best, 1, { colours: sorted.slice(0, cut) }, { colours: sorted.slice(cut) });
  }
  const out = new Set<number>();
  for (const b of boxes) {
    const sum = [0, 0, 0, 0];
    let n = 0;
    for (const c of b.colours) {
      const w = counts.get(c)!;
      for (let k = 0; k < 4; k++) sum[k]! += channel(c, k) * w;
      n += w;
    }
    const [r, g, bl, a] = sum.map((s) => Math.round(s / n)) as [number, number, number, number];
    out.add(a === 0 ? 0 : ((r << 24) | (g << 16) | (bl << 8) | a) >>> 0);
  }
  return [...out];
}

/** Palette order: transparent entries first (tRNS then stays short), then by packed RGBA. */
function paletteOrder(a: number, b: number): number {
  return (a & 0xff) - (b & 0xff) || a - b;
}

function nearest(palette: readonly number[], c: number): number {
  let best = 0;
  let bestD = Infinity;
  palette.forEach((p, i) => {
    let d = 0;
    for (let k = 0; k < 4; k++) {
      const x = channel(p, k) - channel(c, k);
      d += x * x;
    }
    if (d < bestD) [best, bestD] = [i, d];
  });
  return best;
}

/** RGBA pixels -> palette indices of at most `max` colours (the exact colours when there are few enough). */
function quantize(rgba: Uint8Array, max: number): IndexedImage {
  const counts = histogram(rgba);
  const colours = (counts.size <= max ? [...counts.keys()] : medianCut(counts, max)).sort(paletteOrder);
  const index = new Map<number, number>();
  const indices = new Uint8Array(rgba.length / 4);
  for (let i = 0; i < indices.length; i++) {
    const a = rgba[4 * i + 3]!;
    const c = a === 0 ? 0 : ((rgba[4 * i]! << 24) | (rgba[4 * i + 1]! << 16) | (rgba[4 * i + 2]! << 8) | a) >>> 0;
    let q = index.get(c);
    if (q === undefined) {
      q = nearest(colours, c);
      index.set(c, q);
    }
    indices[i] = q;
  }
  const palette = new Uint8Array(4 * colours.length);
  colours.forEach((c, i) => palette.set([channel(c, 0), channel(c, 1), channel(c, 2), channel(c, 3)], 4 * i));
  return { indices, palette };
}

/**
 * A palette PNG of `image`, `width` x `height` pixels (each 1..1,024):
 * RGBA bytes (`4 * width * height`, quantized to at most `maxColours`
 * colours: the exact colours when there are that few, else a deterministic
 * median cut; fully transparent pixels are one colour) or an
 * `IndexedImage` (used as given; at most `maxColours` entries). The bit
 * depth is the smallest that fits the palette (1, 2, 4 or 8), tRNS is
 * written only when a colour is not opaque, and no ancillary chunk is
 * added. The same input gives the same bytes; zlib output can differ
 * between platforms (`compression: "store"` never does), so keep the bytes
 * that were signed rather than re-encoding.
 */
export async function encodeIndexedPng(image: Uint8Array | IndexedImage, width: number, height: number, maxColours = 16, opts: EncodePngOptions = {}): Promise<Uint8Array> {
  for (const [name, v] of [
    ["width", width],
    ["height", height],
  ] as const) {
    if (!Number.isInteger(v) || v < 1 || v > 1_024) throw new RangeError(`${name} must be an integer in 1..1024`);
  }
  if (!Number.isInteger(maxColours) || maxColours < 1 || maxColours > 256) throw new RangeError("maxColours must be an integer in 1..256");
  const pixels = width * height;
  let indexed: IndexedImage;
  if (image instanceof Uint8Array) {
    if (image.length !== 4 * pixels) throw new RangeError(`RGBA data must be ${4 * pixels} bytes (4 per pixel), got ${image.length}`);
    indexed = quantize(image, maxColours);
  } else {
    if (image === null || typeof image !== "object" || !(image.indices instanceof Uint8Array) || !(image.palette instanceof Uint8Array)) {
      throw new TypeError("image must be RGBA bytes or { indices, palette }");
    }
    const n = image.palette.length / 4;
    if (!Number.isInteger(n) || n < 1 || n > maxColours) throw new RangeError(`the palette must hold 1..${maxColours} RGBA entries`);
    if (image.indices.length !== pixels) throw new RangeError(`indices must hold ${pixels} entries, got ${image.indices.length}`);
    if (image.indices.some((q) => q >= n)) throw new RangeError("an index names no palette entry");
    indexed = { indices: Uint8Array.from(image.indices), palette: Uint8Array.from(image.palette) };
  }
  const colours = indexed.palette.length / 4;
  const depth = colours <= 2 ? 1 : colours <= 4 ? 2 : colours <= 16 ? 4 : 8;
  const perByte = 8 / depth;
  const rowBytes = Math.ceil(width / perByte);
  const raw = new Uint8Array(height * (1 + rowBytes)); // filter 0 (None) per scanline
  for (let y = 0; y < height; y++) {
    const row = y * (1 + rowBytes) + 1;
    for (let x = 0; x < width; x++) {
      raw[row + Math.floor(x / perByte)]! |= indexed.indices[y * width + x]! << (8 - depth * ((x % perByte) + 1));
    }
  }
  const ihdr = new Uint8Array(13);
  const h = new DataView(ihdr.buffer);
  h.setUint32(0, width, false);
  h.setUint32(4, height, false);
  ihdr.set([depth, 3, 0, 0, 0], 8);
  const plte = new Uint8Array(3 * colours);
  const alphas: number[] = [];
  for (let i = 0; i < colours; i++) {
    plte.set(indexed.palette.subarray(4 * i, 4 * i + 3), 3 * i);
    alphas.push(indexed.palette[4 * i + 3]!);
  }
  while (alphas.length > 0 && alphas[alphas.length - 1] === 255) alphas.pop();
  const stored = zlibStored(raw);
  let idat = stored;
  if ((opts.compression ?? "auto") === "auto") {
    const deflated = await zlibDeflate(raw);
    if (deflated !== null && deflated.length < stored.length) idat = deflated;
  } else if (opts.compression !== "store") {
    throw new RangeError('compression must be "auto" or "store"');
  }
  return concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("PLTE", plte),
    ...(alphas.length > 0 ? [chunk("tRNS", Uint8Array.from(alphas))] : []),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

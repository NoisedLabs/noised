/**
 * `encodeIndexedPng` and `pngInfo` (src/metadata/png.ts): the vector icon of
 * `vectors/metadata.json` (a 32x32, 16-colour, 4-bit PNG with one stored
 * deflate block, built from documented palette and pixel rules) is
 * reproduced byte for byte; every encoding decodes back (inflated here with
 * node:zlib) to exactly the pixels given; the output is the same for the
 * same input; malformed PNGs are refused.
 */
import { inflateSync } from "node:zlib";

import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";

import { concatBytes, fromHex, toHex, utf8 } from "../src/codec/bytes.js";
import { crc32, encodeIndexedPng, PNG_SIGNATURE, PngError, pngInfo, type IndexedImage } from "../src/metadata/png.js";
import { readJson } from "./helpers.js";

const ICON = readJson<{ icon: { png: string; pngLen: number; pngSha256: string; scanlinesSha256: string; width: number; height: number; bitDepth: number; colourType: number; palette: string } }>("./vectors/metadata.json").icon;

const isqrt = (n: number): number => {
  let x = Math.floor(Math.sqrt(n));
  while (x * x > n) x--;
  while ((x + 1) * (x + 1) <= n) x++;
  return x;
};

/** The vector icon from its documented rules: entry i = (10 + 15i, 44 + 13i, 90 + 10i); index(x, y) = 15 - min(15, isqrt((2x - 31)^2 + (2y - 31)^2) / 2). */
function vectorIcon(): IndexedImage {
  const palette = new Uint8Array(64);
  for (let i = 0; i < 16; i++) palette.set([10 + 15 * i, 44 + 13 * i, 90 + 10 * i, 255], 4 * i);
  const indices = new Uint8Array(32 * 32);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) indices[y * 32 + x] = 15 - Math.min(15, Math.floor(isqrt((2 * x - 31) ** 2 + (2 * y - 31) ** 2) / 2));
  return { indices, palette };
}

function rgbaOf(img: IndexedImage): Uint8Array {
  const out = new Uint8Array(img.indices.length * 4);
  img.indices.forEach((q, i) => out.set(img.palette.subarray(4 * q, 4 * q + 4), 4 * i));
  return out;
}

interface Decoded {
  width: number;
  height: number;
  bitDepth: number;
  palette: Uint8Array;
  alphas: Uint8Array;
  indices: Uint8Array;
  chunks: string[];
  scanlines: Uint8Array;
}

/** A small reader for the PNGs these tests make (palette, no interlace, filter 0): chunks, inflate, unpack. */
function decode(png: Uint8Array): Decoded {
  expect(toHex(png.subarray(0, 8))).toBe(toHex(Uint8Array.from(PNG_SIGNATURE)));
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let off = 8;
  const chunks: string[] = [];
  let ihdr: Uint8Array = new Uint8Array(0);
  let palette: Uint8Array = new Uint8Array(0);
  let alphas: Uint8Array = new Uint8Array(0);
  const idat: Uint8Array[] = [];
  while (off < png.length) {
    const len = view.getUint32(off, false);
    const type = String.fromCharCode(...png.subarray(off + 4, off + 8));
    const data = png.subarray(off + 8, off + 8 + len);
    chunks.push(type);
    if (type === "IHDR") ihdr = data;
    if (type === "PLTE") palette = data;
    if (type === "tRNS") alphas = data;
    if (type === "IDAT") idat.push(data);
    off += 12 + len;
  }
  const h = new DataView(ihdr.buffer, ihdr.byteOffset, ihdr.byteLength);
  const width = h.getUint32(0, false);
  const height = h.getUint32(4, false);
  const bitDepth = ihdr[8]!;
  expect([ihdr[9], ihdr[10], ihdr[11], ihdr[12]]).toEqual([3, 0, 0, 0]);
  const scanlines = new Uint8Array(inflateSync(concatBytes(idat)));
  const perByte = 8 / bitDepth;
  const rowBytes = Math.ceil(width / perByte);
  expect(scanlines.length).toBe(height * (1 + rowBytes));
  const indices = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    expect(scanlines[y * (1 + rowBytes)]).toBe(0); // filter None
    for (let x = 0; x < width; x++) {
      const b = scanlines[y * (1 + rowBytes) + 1 + Math.floor(x / perByte)]!;
      indices[y * width + x] = (b >> (8 - bitDepth * ((x % perByte) + 1))) & ((1 << bitDepth) - 1);
    }
  }
  return { width, height, bitDepth, palette, alphas, indices, chunks, scanlines };
}

/** The RGBA pixels a decoded PNG shows. */
function pixels(d: Decoded): Uint8Array {
  const out = new Uint8Array(d.indices.length * 4);
  d.indices.forEach((q, i) => out.set([d.palette[3 * q]!, d.palette[3 * q + 1]!, d.palette[3 * q + 2]!, q < d.alphas.length ? d.alphas[q]! : 255], 4 * i));
  return out;
}

describe("CRC-32", () => {
  it("the ISO 3309 known answer, and every chunk of the vector icon", () => {
    expect(crc32(utf8("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
    expect(pngInfo(fromHex(ICON.png)).length).toBe(ICON.pngLen); // pngInfo checks every chunk's CRC
  });
});

describe("encodeIndexedPng", () => {
  it("reproduces the vector icon byte for byte (stored deflate), from indices and from RGBA", async () => {
    const img = vectorIcon();
    const png = await encodeIndexedPng(img, 32, 32, 16, { compression: "store" });
    expect(png.length).toBe(ICON.pngLen);
    expect(toHex(sha256(png))).toBe(ICON.pngSha256);
    expect(toHex(png)).toBe(ICON.png);
    const d = decode(png);
    expect(toHex(sha256(d.scanlines))).toBe(ICON.scanlinesSha256);
    expect(toHex(d.palette)).toBe(ICON.palette);
    expect(d.chunks).toEqual(["IHDR", "PLTE", "IDAT", "IEND"]); // opaque: no tRNS, no ancillary chunk
    // The same image as RGBA: its 16 colours, in the same order, the same bytes.
    expect(toHex(await encodeIndexedPng(rgbaOf(img), 32, 32, 16, { compression: "store" }))).toBe(ICON.png);
    expect(pngInfo(png)).toEqual({ width: 32, height: 32, bitDepth: ICON.bitDepth, colourType: ICON.colourType, interlaced: false, length: 672 });
  });

  it("compressed (CompressionStream deflate): smaller, the same bytes for the same input, and exactly the same pixels", async () => {
    const img = vectorIcon();
    expect(typeof (globalThis as { CompressionStream?: unknown }).CompressionStream).toBe("function"); // Node 22 has it
    const a = await encodeIndexedPng(img, 32, 32);
    const b = await encodeIndexedPng(img, 32, 32);
    expect(toHex(a)).toBe(toHex(b));
    expect(a.length).toBeLessThan(ICON.pngLen);
    expect(toHex(a.subarray(0, 8 + 25 + 60))).toBe(ICON.png.slice(0, 2 * (8 + 25 + 60))); // signature, IHDR, PLTE unchanged
    const d = decode(a);
    expect(toHex(d.indices)).toBe(toHex(img.indices));
    expect(toHex(pixels(d))).toBe(toHex(rgbaOf(img)));
    expect(pngInfo(a).width).toBe(32);
  });

  it("without CompressionStream, the stored encoding (the same bytes everywhere)", async () => {
    const g = globalThis as { CompressionStream?: unknown };
    const saved = g.CompressionStream;
    try {
      delete g.CompressionStream;
      expect(toHex(await encodeIndexedPng(vectorIcon(), 32, 32))).toBe(ICON.png);
    } finally {
      g.CompressionStream = saved;
    }
  });

  it("a CompressionStream that fails: encodeIndexedPng rejects with its error, and leaves no unhandled rejection behind", async () => {
    const g = globalThis as { CompressionStream?: unknown };
    const saved = g.CompressionStream;
    const boom = new Error("deflate failed");
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => {
      unhandled.push(e);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      g.CompressionStream = class {
        readonly writable = { getWriter: () => ({ write: () => Promise.reject(boom), close: () => Promise.resolve() }) };
        readonly readable = { getReader: () => ({ read: () => Promise.reject(boom) }) };
      };
      await expect(encodeIndexedPng(vectorIcon(), 32, 32)).rejects.toBe(boom);
      await new Promise((r) => setTimeout(r, 20)); // let Node report anything left unhandled
      expect(unhandled).toEqual([]);
    } finally {
      g.CompressionStream = saved;
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("transparency: fully transparent pixels are one colour, listed first; tRNS covers the non-opaque entries only", async () => {
    const w = 4;
    const rgba = new Uint8Array([
      ...[1, 2, 3, 0],
      ...[9, 9, 9, 0], // another transparent colour: the same palette entry
      ...[200, 10, 10, 128],
      ...[0, 255, 0, 255],
    ]);
    const png = await encodeIndexedPng(rgba, w, 1);
    const d = decode(png);
    expect(d.chunks).toEqual(["IHDR", "PLTE", "tRNS", "IDAT", "IEND"]);
    expect(d.bitDepth).toBe(2); // 3 colours
    expect(toHex(d.alphas)).toBe("0080"); // transparent, half, then opaque entries (omitted)
    expect(Array.from(d.indices)).toEqual([0, 0, 1, 2]);
    expect(toHex(pixels(d))).toBe(toHex(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 200, 10, 10, 128, 0, 255, 0, 255])));
  });

  it("deflate is used only when it is smaller: an incompressible image keeps the stored encoding, byte for byte", async () => {
    const palette = new Uint8Array(4 * 256);
    for (let i = 0; i < 256; i++) palette.set([i, 255 - i, (i * 7) & 255, 255], 4 * i);
    const indices = new Uint8Array(64 * 64);
    let x = 0x2545f491;
    for (let i = 0; i < indices.length; i++) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      indices[i] = x & 255;
    }
    const stored = await encodeIndexedPng({ indices, palette }, 64, 64, 256, { compression: "store" });
    expect(toHex(await encodeIndexedPng({ indices, palette }, 64, 64, 256))).toBe(toHex(stored));
    expect(toHex(decode(stored).indices)).toBe(toHex(indices));
  });

  it("stored deflate over 65,535 bytes: several blocks, only the last one final (300x300 at 8 bits: 90,300 scanline bytes)", async () => {
    const palette = new Uint8Array(4 * 17);
    for (let i = 0; i < 17; i++) palette.set([i * 15, 255 - i * 15, i, 255], 4 * i);
    const indices = new Uint8Array(300 * 300);
    for (let i = 0; i < indices.length; i++) indices[i] = (i * 7 + (i >> 9)) % 17;
    const out = await encodeIndexedPng({ indices, palette }, 300, 300, 256, { compression: "store" });
    const d = decode(out);
    expect([d.bitDepth, d.scanlines.length]).toEqual([8, 300 * 301]);
    expect(toHex(sha256(d.indices))).toBe(toHex(sha256(indices)));
  });

  it("the smallest bit depth that fits: 1, 2, 4 or 8", async () => {
    const depthFor = async (colours: number, max = 256): Promise<number> => {
      const rgba = new Uint8Array(colours * 4);
      for (let i = 0; i < colours; i++) rgba.set([i, 255 - i, i * 3 % 256, 255], 4 * i);
      return decode(await encodeIndexedPng(rgba, colours, 1, max)).bitDepth;
    };
    expect([await depthFor(1), await depthFor(2), await depthFor(3), await depthFor(4), await depthFor(5), await depthFor(16), await depthFor(17), await depthFor(200)]).toEqual([1, 1, 2, 2, 4, 4, 8, 8]);
  });

  it("more colours than allowed: a deterministic median cut to at most maxColours, each pixel its nearest palette colour", async () => {
    const rgba = new Uint8Array(32 * 32 * 4);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) rgba.set([x * 8, y * 8, (x * y) % 256, 255], 4 * (y * 32 + x));
    const a = await encodeIndexedPng(rgba, 32, 32, 16);
    const b = await encodeIndexedPng(Uint8Array.from(rgba), 32, 32, 16);
    expect(toHex(a)).toBe(toHex(b));
    const d = decode(a);
    const colours = d.palette.length / 3;
    expect(colours).toBeLessThanOrEqual(16);
    expect(colours).toBeGreaterThan(8);
    // Every pixel shows the palette colour nearest to it.
    for (let i = 0; i < 32 * 32; i += 37) {
      const want = [rgba[4 * i]!, rgba[4 * i + 1]!, rgba[4 * i + 2]!];
      const dist = (q: number): number => [0, 1, 2].reduce((s, k) => s + (d.palette[3 * q + k]! - want[k]!) ** 2, 0);
      const best = Math.min(...Array.from({ length: colours }, (_, q) => dist(q)));
      expect(dist(d.indices[i]!)).toBe(best);
    }
    expect(decode(await encodeIndexedPng(rgba, 32, 32, 2)).palette.length).toBe(6);
  });

  it("refuses sizes, lengths, palettes and options it cannot encode", async () => {
    const img = vectorIcon();
    await expect(encodeIndexedPng(img, 0, 32)).rejects.toThrow(/width/);
    await expect(encodeIndexedPng(img, 32, 1_025)).rejects.toThrow(/height/);
    await expect(encodeIndexedPng(img, 32.5, 32)).rejects.toThrow(/width/);
    await expect(encodeIndexedPng(new Uint8Array(10), 32, 32)).rejects.toThrow(/4096 bytes/);
    await expect(encodeIndexedPng(img, 32, 32, 8)).rejects.toThrow(/palette must hold 1\.\.8/);
    await expect(encodeIndexedPng({ indices: img.indices, palette: new Uint8Array(0) }, 32, 32)).rejects.toThrow(/palette/);
    await expect(encodeIndexedPng({ indices: img.indices.subarray(1), palette: img.palette }, 32, 32)).rejects.toThrow(/1024 entries/);
    await expect(encodeIndexedPng({ indices: new Uint8Array(1024).fill(16), palette: img.palette }, 32, 32)).rejects.toThrow(/names no palette entry/);
    await expect(encodeIndexedPng(img, 32, 32, 0)).rejects.toThrow(/maxColours/);
    await expect(encodeIndexedPng(img, 32, 32, 257)).rejects.toThrow(/maxColours/);
    await expect(encodeIndexedPng(img, 32, 32, 16, { compression: "best" as never })).rejects.toThrow(/compression/);
    await expect(encodeIndexedPng("png" as never, 32, 32)).rejects.toThrow(TypeError);
    // A wide image needs more than one stored block (65,535 bytes each).
    const wide = await encodeIndexedPng({ indices: new Uint8Array(1_024 * 1_024 / 4).fill(1), palette: new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255]) }, 1_024, 256, 2, { compression: "store" });
    expect(decode(wide).indices.every((q) => q === 1)).toBe(true);
  });
});

describe("pngInfo refuses malformed PNGs", () => {
  const png = (): Uint8Array => fromHex(ICON.png);
  /** Recompute the CRC of the chunk at `off` after a change. */
  const fixCrc = (b: Uint8Array, off: number): void => {
    const len = new DataView(b.buffer).getUint32(off, false);
    new DataView(b.buffer).setUint32(off + 8 + len, crc32(b.subarray(off + 4, off + 8 + len)), false);
  };

  it("signature, chunk bounds and CRCs, IHDR first and valid, IDAT present, IEND last and empty, nothing after", () => {
    expect(() => pngInfo(utf8("GIF89a"))).toThrow(PngError);
    let b = png();
    b[0] = 0x88;
    expect(() => pngInfo(b)).toThrow(/signature/);
    b = png();
    b[200]! ^= 1; // inside IDAT
    expect(() => pngInfo(b)).toThrow(/bad CRC in the IDAT chunk/);
    expect(() => pngInfo(png().subarray(0, 600))).toThrow(/runs past the end|truncated/);
    expect(() => pngInfo(png().subarray(0, 660))).toThrow(/truncated chunk/);
    expect(() => pngInfo(concatBytes([png(), Uint8Array.of(0)]))).toThrow(/bytes after IEND|truncated/);
    // IHDR: zero width, an invalid depth for the colour type, interlace 2.
    b = png();
    new DataView(b.buffer).setUint32(16, 0, false);
    fixCrc(b, 8);
    expect(() => pngInfo(b)).toThrow(/invalid image size/);
    b = png();
    b[24] = 3; // bit depth 3
    fixCrc(b, 8);
    expect(() => pngInfo(b)).toThrow(/bit depth 3/);
    b = png();
    b[28] = 2; // interlace method 2
    fixCrc(b, 8);
    expect(() => pngInfo(b)).toThrow(/interlace/);
    // A PNG whose first chunk is not IHDR, one without IDAT, and an IEND that carries data.
    const sig = png().subarray(0, 8);
    const ihdr = png().subarray(8, 33);
    const plte = png().subarray(33, 93);
    const idat = png().subarray(93, 660);
    const iend = png().subarray(660);
    expect(() => pngInfo(concatBytes([sig, plte, ihdr, idat, iend]))).toThrow(/first chunk is not a 13-byte IHDR/);
    expect(() => pngInfo(concatBytes([sig, ihdr, plte, iend]))).toThrow(/no image data/);
    expect(() => pngInfo(concatBytes([sig, ihdr, ihdr, plte, idat, iend]))).toThrow(/second IHDR/);
    // An IHDR of 14 bytes (with a valid CRC): only a 13-byte IHDR is one.
    const long = concatBytes([Uint8Array.of(0, 0, 0, 14), ihdr.subarray(4, 21), Uint8Array.of(0), new Uint8Array(4)]);
    fixCrc(long, 0);
    expect(() => pngInfo(concatBytes([sig, long, plte, idat, iend]))).toThrow(/first chunk is not a 13-byte IHDR/);
    const iendData = concatBytes([Uint8Array.of(0, 0, 0, 1), utf8("IEND"), Uint8Array.of(0), new Uint8Array(4)]);
    fixCrc(iendData, 0);
    expect(() => pngInfo(concatBytes([sig, ihdr, plte, idat, iendData]))).toThrow(/IEND carries data/);
    expect(() => pngInfo("png" as never)).toThrow(TypeError);
  });
});

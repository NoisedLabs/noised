/**
 * An uploaded logo as the token's on-chain icon (src/pages/create/logoIcon.ts): a smooth picture, never pixel art.
 *
 *   - the icon's byte budget is exactly what the SDK's document still takes (checked against `validateMetadataDoc`);
 *   - shrinking averages areas with premultiplied alpha (no dark fringe at transparent edges);
 *   - the palette quantizer is deterministic, keeps few colours exactly, keeps transparency, and never maps a visible
 *     pixel to the transparent entry;
 *   - the fitter picks the best variant that fits (64 px with 256 -> 64 colours, then 56, then 48 px), re-picks from
 *     what it already made when the budget changes, and reports "nothing fits" with the smallest variant;
 *   - in the draft, the logo is the icon the record stores, re-fitted when the words next to it change, and a logo that
 *     cannot fit blocks the record with plain words;
 *   - token icons over 32 x 32 are drawn smoothly, pixel art up to 32 x 32 crisp.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";

import { buildMetadataDoc, crc32, encodeIndexedPng, METADATA, parseMetadataDoc, pngInfo, validateMetadataDoc, type MetadataDocInput } from "@noisedlabs/sdk";

import { isPixelArt, pngDataUriWidth } from "../src/components/iconLook";
import { convertDraft, draftFromPreset, LOGO_NO_ROOM, LOGO_TOO_DETAILED, storedIcon, storedIconKey, type Draft } from "../src/pages/create/draft";
import { docTextWithoutIcon, iconByteBudget, LOGO_VARIANTS, LogoFitter, pngDataUri, quantizeLogo, shrinkRgba, type LogoIndexed } from "../src/pages/create/logoIcon";
import { blankIcon } from "../src/pages/create/pixelIcon";

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/** A deterministic PRNG (mulberry32). */
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

/** A photo-like square: soft gradients, a lit ball, and grain (every pixel a different colour). */
function photo(side: number, seed = 7): Uint8Array {
  const r = rng(seed);
  const out = new Uint8Array(side * side * 4);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const u = x / side;
      const v = y / side;
      const d = Math.hypot(u - 0.42, v - 0.45);
      const ball = Math.max(0, 1 - d / 0.3);
      const grain = (r() - 0.5) * 18;
      const i = (y * side + x) * 4;
      out[i] = Math.max(0, Math.min(255, Math.round(40 + 160 * v + 90 * ball * ball + grain)));
      out[i + 1] = Math.max(0, Math.min(255, Math.round(70 + 90 * u + 120 * ball + grain)));
      out[i + 2] = Math.max(0, Math.min(255, Math.round(150 - 80 * v + 60 * ball + grain)));
      out[i + 3] = 255;
    }
  }
  return out;
}

/** A flat logo: an orange disk with a white bar on a transparent background, anti-aliased by 4x4 supersampling. */
function flatLogo(side: number): Uint8Array {
  const out = new Uint8Array(side * side * 4);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      let disk = 0;
      let bar = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const u = (x + (sx + 0.5) / 4) / side - 0.5;
          const v = (y + (sy + 0.5) / 4) / side - 0.5;
          if (Math.hypot(u, v) < 0.42) {
            disk++;
            if (Math.abs(v) < 0.08 && Math.abs(u) < 0.25) bar++;
          }
        }
      }
      if (disk === 0) continue;
      const i = (y * side + x) * 4;
      const w = bar / disk;
      out.set([Math.round(255 * w + 255 * (1 - w)), Math.round(255 * w + 122 * (1 - w)), Math.round(255 * w + 26 * (1 - w)), Math.round((255 * disk) / 16)], i);
    }
  }
  return out;
}

/** A valid PNG of exactly `size` bytes (a real 1 x 1 image padded with an ancillary chunk). */
async function pngOfSize(size: number): Promise<Uint8Array> {
  const base = await encodeIndexedPng(Uint8Array.of(10, 20, 30, 255), 1, 1, 2, { compression: "store" });
  const pad = size - base.length - 12;
  if (pad < 0) throw new Error("too small");
  const iend = base.length - 12;
  const chunk = new Uint8Array(12 + pad);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, pad);
  chunk.set([0x74, 0x45, 0x58, 0x74], 4); // "tEXt"
  chunk.fill(0x61, 8, 8 + pad);
  view.setUint32(8 + pad, crc32(chunk.subarray(4, 8 + pad)));
  const out = new Uint8Array(size);
  out.set(base.subarray(0, iend), 0);
  out.set(chunk, iend);
  out.set(base.subarray(iend), iend + chunk.length);
  expect(pngInfo(out).length).toBe(size);
  return out;
}

const DOCS: MetadataDocInput[] = [
  { name: "A", symbol: "A" },
  { name: "Quantum Lantern", symbol: "QLTN", links: { website: "https://example.org/token", x: "https://x.com/qltn" } },
  { name: "Éclair ⚡", symbol: "ECL", description: "Deux phrases « avec » des accents.\nEt une ligne.", links: { x: "https://x.com/e" } },
  { name: "Long", symbol: "LONG", description: "x".repeat(500), links: { website: "https://example.org" } },
];

describe("the icon's byte budget", () => {
  it("is exactly the room the SDK's document has left", async () => {
    for (const input of DOCS) {
      expect(docTextWithoutIcon(input)).toBe(new TextDecoder().decode(buildMetadataDoc(input)));
      const budget = iconByteBudget(input);
      expect(budget % 3).toBe(0);
      const fits = await pngOfSize(budget);
      expect(validateMetadataDoc({ ...input, iconPng: fits })).toEqual({ ok: true, errors: [] });
      expect(buildMetadataDoc({ ...input, iconPng: fits }).length).toBeLessThanOrEqual(METADATA.MAX_DOC_LEN);
      const over = await pngOfSize(budget + 1);
      const v = validateMetadataDoc({ ...input, iconPng: over });
      expect(v.ok).toBe(false);
      expect(v.errors.join()).toMatch(/^document: is \d+ bytes/);
    }
  });

  it("shrinks as the description grows, and is 0 when nothing is left", () => {
    const base = { name: "Token", symbol: "TKN" };
    const short = iconByteBudget({ ...base, description: "Short." });
    const long = iconByteBudget({ ...base, description: "A longer description of the token.".repeat(10) });
    expect(iconByteBudget(base)).toBeGreaterThan(short);
    expect(short).toBeGreaterThan(long);
    expect(iconByteBudget({ ...base, description: "x".repeat(3_100) })).toBe(0);
  });
});

describe("shrinking a logo", () => {
  it("averages areas exactly and keeps a flat colour flat", () => {
    // 2 x 2 -> 1 x 1: the mean of four opaque pixels.
    expect([...shrinkRgba(Uint8Array.of(0, 0, 0, 255, 255, 255, 255, 255, 100, 0, 0, 255, 0, 100, 0, 255), 2, 1)]).toEqual([89, 89, 64, 255]);
    const flat = new Uint8Array(100 * 100 * 4);
    for (let i = 0; i < 100 * 100; i++) flat.set([12, 200, 99, 255], i * 4);
    const small = shrinkRgba(flat, 100, 48);
    for (let i = 0; i < 48 * 48; i++) expect([...small.subarray(i * 4, i * 4 + 4)]).toEqual([12, 200, 99, 255]);
  });

  it("premultiplies alpha: a transparent background never darkens the edge", () => {
    // A red disk on transparent BLACK: averaged naively, the edges would turn dark red.
    const side = 256;
    const src = new Uint8Array(side * side * 4);
    for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) if (Math.hypot(x - 128, y - 128) < 100) src.set([255, 0, 0, 255], (y * side + x) * 4);
    for (const to of [64, 56, 48]) {
      const out = shrinkRgba(src, side, to);
      let edges = 0;
      for (let i = 0; i < to * to; i++) {
        const [r, g, b, a] = out.subarray(i * 4, i * 4 + 4);
        if (a === 0) continue;
        if ((a ?? 0) < 255) edges++;
        expect(r).toBe(255);
        expect(g).toBe(0);
        expect(b).toBe(0);
      }
      expect(edges).toBeGreaterThan(20);
    }
  });
});

/** Mean squared RGB error of an indexed image against its source (visible pixels; alpha folded in). */
function meanError(src: Uint8Array, q: LogoIndexed): number {
  let sum = 0;
  const n = src.length / 4;
  for (let i = 0; i < n; i++) {
    const p = (q.indices[i] ?? 0) * 4;
    for (let c = 0; c < 4; c++) sum += ((src[i * 4 + c] ?? 0) - (q.palette[p + c] ?? 0)) ** 2;
  }
  return sum / n;
}

describe("the logo's palette", () => {
  it("is deterministic: the same picture always gives the same palette and pixels", () => {
    const px = shrinkRgba(photo(256), 256, 64);
    const a = quantizeLogo(px, 256);
    const b = quantizeLogo(Uint8Array.from(px), 256);
    expect(hex(a.palette)).toBe(hex(b.palette));
    expect(hex(a.indices)).toBe(hex(b.indices));
    expect(a.palette.length / 4).toBe(256);
    // Pinned: a change to the quantizer changes these (and every icon made from now on).
    expect(hex(sha256(new Uint8Array([...a.palette, ...a.indices])))).toMatchInlineSnapshot(`"2fb1362b6ffdea817182d410a1891dbebe37c415f145e43d57e992899d90a5c9"`);
  });

  it("keeps at most the asked colours, and more colours look closer to the picture", () => {
    const px = shrinkRgba(photo(256, 3), 256, 64);
    let previous = Infinity;
    for (const k of [64, 96, 128, 192, 256]) {
      const q = quantizeLogo(px, k);
      expect(q.palette.length / 4).toBeLessThanOrEqual(k);
      expect(q.palette.length / 4).toBeGreaterThan(k * 0.9);
      expect(q.indices.length).toBe(64 * 64);
      expect(Math.max(...q.indices)).toBeLessThan(q.palette.length / 4);
      const e = meanError(px, q);
      expect(e).toBeLessThan(previous);
      previous = e;
    }
    // 256 colours of a grainy photo: within a few levels a channel on average.
    expect(Math.sqrt(previous / 4)).toBeLessThan(4);
  });

  it("keeps few colours exactly and transparency as the first entry", () => {
    const px = new Uint8Array(8 * 8 * 4);
    for (let i = 0; i < 64; i++) px.set(i < 16 ? [0, 0, 0, 0] : i < 40 ? [255, 122, 26, 255] : [255, 255, 255, 128], i * 4);
    const q = quantizeLogo(px, 64);
    expect([...q.palette]).toEqual([0, 0, 0, 0, 255, 255, 255, 128, 255, 122, 26, 255]);
    expect([...q.indices.subarray(0, 16)].every((x) => x === 0)).toBe(true);
    expect(q.indices[20]).toBe(2);
    expect(q.indices[50]).toBe(1);
  });

  it("keeps soft edges soft and never turns a visible pixel transparent", () => {
    const px = shrinkRgba(flatLogo(256), 256, 64);
    const q = quantizeLogo(px, 64);
    const entries = q.palette.length / 4;
    expect(q.palette.subarray(0, 4)).toEqual(Uint8Array.of(0, 0, 0, 0));
    const partial = Array.from({ length: entries }, (_, j) => q.palette[j * 4 + 3] ?? 0).filter((a) => a > 0 && a < 255);
    expect(partial.length).toBeGreaterThan(4);
    for (let i = 0; i < 64 * 64; i++) {
      if ((px[i * 4 + 3] ?? 0) > 4) expect(q.indices[i]).not.toBe(0);
      else expect(q.indices[i]).toBe(0);
    }
  });
});

describe("fitting a logo into the document", () => {
  it("picks the best variant that fits, in order, and re-picks from what it made", async () => {
    // A fake encoder: the PNG's size is side * colours / 4 bytes (so the order of variants is visible).
    const calls: string[] = [];
    const fitter = new LogoFitter({ rgba: photo(128), side: 128 }, (image, side) => {
      const colours = image.palette.length / 4;
      calls.push(`${side}:${colours}`);
      return Promise.resolve(new Uint8Array((side * colours) / 4));
    });
    // 64 x 256 / 4 = 4096 bytes; everything fits a big budget: the best.
    expect((await fitter.fit(5000))?.variant).toEqual({ side: 64, colours: 256 });
    // 64 px with 128 colours is 2048 bytes: the first under 2100.
    expect((await fitter.fit(2100))?.variant).toEqual({ side: 64, colours: 128 });
    // 64 px with 64 colours is 1024; 56 px: 56 * 256 / 4 = 3584 ... 56 * 64 / 4 = 896; 48 px with 64 colours = 768.
    expect((await fitter.fit(950))?.variant).toEqual({ side: 56, colours: 64 });
    expect((await fitter.fit(800))?.variant).toEqual({ side: 48, colours: 64 });
    expect(await fitter.fit(700)).toBeNull();
    expect((await fitter.smallest()).variant).toEqual({ side: 48, colours: 64 });
    // Each variant was made once, in order of quality.
    expect(calls).toEqual(LOGO_VARIANTS.map((v) => `${v.side}:${v.colours}`));
    expect((await fitter.fit(5000))?.variant).toEqual({ side: 64, colours: 256 });
    expect(calls).toHaveLength(LOGO_VARIANTS.length);
  });

  it("skips variants that would come out the same (a logo with few colours)", async () => {
    const px = new Uint8Array(64 * 64 * 4);
    for (let i = 0; i < 64 * 64; i++) px.set([255, 0, 0, 255], i * 4);
    const made: string[] = [];
    const fitter = new LogoFitter({ rgba: px, side: 64 }, (image, side) => {
      made.push(`${side}:${image.palette.length / 4}`);
      return Promise.resolve(new Uint8Array(side * 10));
    });
    expect(await fitter.fit(560)).toMatchObject({ side: 56, colours: 1 });
    expect(made).toEqual(["64:1", "56:1"]);
  });

  it("stores a smooth 64 x 64 picture with the SDK's encoder, and shrinks it when the description grows", async () => {
    const fitter = new LogoFitter({ rgba: photo(256, 11), side: 256 });
    const sizes: string[] = [];
    for (const description of ["", "A token about lanterns.", "x".repeat(250), "x".repeat(500)]) {
      const input: MetadataDocInput = { name: "Quantum Lantern", symbol: "QLTN", ...(description === "" ? {} : { description }), links: { website: "https://example.org" } };
      const budget = iconByteBudget(input);
      const icon = await fitter.fit(budget);
      if (icon === null) {
        // Nothing fits: the smallest variant is too big for this document, so the creator is asked to shorten it.
        const smallest = await fitter.smallest();
        expect(smallest.png.length).toBeGreaterThan(budget);
        expect(validateMetadataDoc({ ...input, iconPng: smallest.png }).ok).toBe(false);
        sizes.push("none");
        continue;
      }
      const doc = parseMetadataDoc(buildMetadataDoc({ ...input, iconPng: icon.png }), { name: input.name, symbol: input.symbol });
      expect(doc.ok).toBe(true);
      expect(doc.icon).toMatchObject({ width: icon.side, height: icon.side, dataUri: pngDataUri(icon.png) });
      expect(pngInfo(icon.png)).toMatchObject({ colourType: 3, bitDepth: 8 });
      sizes.push(`${icon.side}px/${icon.variant.colours}`);
    }
    // The order of quality holds: a longer description never gets a better icon.
    const rank = (s: string): number => (s === "none" ? LOGO_VARIANTS.length : LOGO_VARIANTS.findIndex((v) => `${v.side}px/${v.colours}` === s));
    const ranks = sizes.map(rank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(sizes[0]).toMatch(/^(64|56|48)px/);
  });

  it("keeps a flat logo at 64 x 64", async () => {
    const fit = await new LogoFitter({ rgba: flatLogo(256), side: 256 }).fit(iconByteBudget({ name: "Orange", symbol: "ORNG", description: "A flat orange logo." }));
    expect(fit?.side).toBe(64);
  });
});

describe("a logo in the draft", () => {
  const ready = (): Draft => ({ ...draftFromPreset("fair"), name: "Lantern", symbol: "LTRN" });

  it("is the icon the record stores, and is fitted again when the description changes", async () => {
    const d = ready();
    const logo = new LogoFitter({ rgba: photo(256, 5), side: 256 });
    const withLogo: Draft = { ...d, meta: { ...d.meta, logo, icon: blankIcon() } };
    const stored = await storedIcon(withLogo);
    if (stored.kind !== "logo") throw new Error("expected a logo");
    expect(stored.fits).toBe(true);
    const conv = convertDraft(withLogo, null, stored.png);
    expect(conv.policyErrors.filter((e) => e.startsWith("icon:"))).toEqual([]);
    const doc = parseMetadataDoc(conv.metadata.doc as Uint8Array, { name: "Lantern", symbol: "LTRN" });
    expect(doc.icon).toMatchObject({ width: stored.logo.side, dataUri: pngDataUri(stored.png) });
    // Typing a description changes the room, and so the key the page re-fits on; the drawing is not used.
    const described: Draft = { ...withLogo, meta: { ...withLogo.meta, description: "A lantern for the quantum night. ".repeat(12) } };
    expect(storedIconKey(described)).not.toBe(storedIconKey(withLogo));
    const again = await storedIcon(described);
    if (again.kind !== "logo") throw new Error("expected a logo");
    expect(again.png.length).toBeLessThanOrEqual(stored.png.length);
    expect(convertDraft(described, null, again.png).metadata.doc).toBeInstanceOf(Uint8Array);
  });

  it("says in plain words what to do when even the smallest logo does not fit", async () => {
    // An encoder whose every PNG is 3,000 bytes (valid, padded): nothing fits next to any words.
    const huge = new LogoFitter({ rgba: photo(64), side: 64 }, () => pngOfSize(3_000));
    const d: Draft = { ...ready(), meta: { ...ready().meta, logo: huge, icon: blankIcon() } };
    const plain = await storedIcon(d);
    expect(plain).toMatchObject({ kind: "logo", fits: false });
    const a = convertDraft(d, null, plain.png);
    expect(a.metadata.doc).toBeUndefined();
    expect(a.policyErrors).toContain(`icon: ${LOGO_TOO_DETAILED}`);
    const words: Draft = { ...d, meta: { ...d.meta, description: "Some words." } };
    const b = convertDraft(words, null, (await storedIcon(words)).png);
    expect(b.metadata.doc).toBeUndefined();
    expect(b.policyErrors).toContain(`icon: ${LOGO_NO_ROOM}`);
  });
});

describe("drawing a token's icon", () => {
  it("is smooth for a logo and crisp only for pixel art up to 32 x 32", async () => {
    const uri = async (side: number): Promise<string> => pngDataUri(await encodeIndexedPng(new Uint8Array(side * side * 4).fill(255), side, side, 16));
    expect(pngDataUriWidth(await uri(32))).toBe(32);
    expect(pngDataUriWidth(await uri(48))).toBe(48);
    expect(pngDataUriWidth(await uri(64))).toBe(64);
    expect(pngDataUriWidth("data:image/png;base64,AAAA")).toBeNull();
    expect(pngDataUriWidth("https://example.org/x.png")).toBeNull();
    expect([16, 32, 33, 48, 64].map(isPixelArt)).toEqual([true, true, false, false, false]);
    expect(isPixelArt(null)).toBe(false);
  });
});

/**
 * The Create wizard's token icon: 32x32 pixels, at most 16 colours. It never touches the launch parameters: the
 * icon (as a small PNG), the description and the links go into the document of the token's on-chain metadata record,
 * which the quantum key signs by its hash together with the name and symbol.
 */
import { describe, expect, it } from "vitest";

import { buildMetadataDoc, metadataHashV2, parseMetadataDoc, pngInfo, tokenUri, validateTokenMeta } from "@noisedlabs/sdk";

import { convertDraft, docInput, draftFromPreset, iconPng, metaProblems, type Draft } from "../src/pages/create/draft";
import {
  blankPixels,
  EMPTY,
  fillCells,
  filledCount,
  flipPixels,
  generateIcon,
  ICON_MAX_COLORS,
  ICON_PIXELS,
  ICON_SIZE,
  indexOf,
  lineCells,
  mainSlot,
  packedBytes,
  quantizeRgba,
  seedOf,
  setPixels,
  usedSlots,
  withFullPalette,
  withMirror,
} from "../src/pages/create/pixelIcon";

describe("pixel icon", () => {
  it("draws lines, mirrors and fills on the 32x32 grid", () => {
    expect(lineCells(0, 0, 3, 0)).toEqual([0, 1, 2, 3]);
    expect(lineCells(0, 0, 2, 2)).toEqual([indexOf(0, 0), indexOf(1, 1), indexOf(2, 2)]);
    expect(withMirror([indexOf(0, 5)], true).sort((a, b) => a - b)).toEqual([indexOf(0, 5), indexOf(ICON_SIZE - 1, 5)]);
    const box = setPixels(blankPixels(), [...lineCells(4, 4, 8, 4), ...lineCells(4, 8, 8, 8), ...lineCells(4, 4, 4, 8), ...lineCells(8, 4, 8, 8)], "3");
    // The inside of the box is 3x3; the outside is everything else that is empty.
    expect(fillCells(box, 6, 6)).toHaveLength(9);
    expect(fillCells(box, 0, 0)).toHaveLength(ICON_PIXELS - 16 - 9);
    expect(setPixels(box, [0], EMPTY)).toBe(box);
    expect(flipPixels(flipPixels(box))).toBe(box);
  });

  it("quantizes any RGBA image to at most 16 colours, transparent under 50% alpha", () => {
    const rgba = new Uint8ClampedArray(ICON_PIXELS * 4);
    for (let i = 0; i < ICON_PIXELS; i++) {
      // A smooth gradient: far more than 16 colours in, at most 16 out.
      rgba[i * 4] = (i * 7) % 256;
      rgba[i * 4 + 1] = (i * 3) % 256;
      rgba[i * 4 + 2] = 255 - ((i * 5) % 256);
      rgba[i * 4 + 3] = i % ICON_SIZE === 0 ? 0 : 255;
    }
    const icon = quantizeRgba(rgba);
    expect(icon.palette.length).toBeLessThanOrEqual(ICON_MAX_COLORS);
    expect(icon.pixels).toHaveLength(ICON_PIXELS);
    expect(filledCount(icon.pixels)).toBe(ICON_PIXELS - ICON_SIZE);
    for (const c of icon.palette) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    expect(usedSlots(icon.pixels).every((s) => s < icon.palette.length)).toBe(true);
    expect(withFullPalette(icon).palette).toHaveLength(ICON_MAX_COLORS);
    // A two-colour image stays two colours.
    const two = new Uint8ClampedArray(ICON_PIXELS * 4);
    for (let i = 0; i < ICON_PIXELS; i++) two.set(i < 512 ? [255, 0, 0, 255] : [0, 0, 255, 255], i * 4);
    expect([...quantizeRgba(two).palette].sort()).toEqual(["#0000ff", "#ff0000"]);
  });

  it("generates the same icon for the same seed, symmetric and outlined", () => {
    const a = generateIcon(seedOf("AEGS#1"));
    expect(generateIcon(seedOf("AEGS#1"))).toEqual(a);
    expect(a.pixels).not.toBe(generateIcon(seedOf("AEGS#2")).pixels);
    expect(flipPixels(a.pixels)).toBe(a.pixels);
    expect(filledCount(a.pixels)).toBeGreaterThan(100);
    expect(packedBytes(a)).toBe(512 + usedSlots(a.pixels).length * 3);
    expect(usedSlots(a.pixels)).toContain(mainSlot(a));
  });
});

describe("token metadata in the draft", () => {
  const ready = (): Draft => ({ ...draftFromPreset("fair"), name: "Aegis", symbol: "AEGS" });

  it("goes into the record's document, never into the parameters, and never as a uri", async () => {
    const d = ready();
    const withMeta: Draft = { ...d, meta: { ...d.meta, description: "A token.", website: "https://example.org", x: "@noised_xyz" } };
    const png = await iconPng(withMeta.meta.icon);
    expect(png).not.toBeNull();
    // A 32 x 32 indexed PNG of the drawing's exact colours (each slot it uses, and transparent for its empty pixels).
    expect(pngInfo(png as Uint8Array)).toMatchObject({ width: 32, height: 32, colourType: 3 });
    const bytes = png as Uint8Array;
    const at = [...bytes].findIndex((_, i) => bytes[i] === 0x50 && bytes[i + 1] === 0x4c && bytes[i + 2] === 0x54 && bytes[i + 3] === 0x45);
    const plteLen = new DataView(bytes.buffer, bytes.byteOffset).getUint32(at - 4);
    const icon = withMeta.meta.icon;
    const colours = new Set([...icon.pixels].filter((ch) => ch !== EMPTY).map((ch) => icon.palette[Number.parseInt(ch, 16)]));
    expect(plteLen / 3).toBe(colours.size + (icon.pixels.includes(EMPTY) ? 1 : 0));
    const a = convertDraft(d, null, await iconPng(d.meta.icon));
    const b = convertDraft(withMeta, null, png);
    expect(b.params).toEqual(a.params);
    expect(b.metadataReady).toBe(true);
    // The document the SDK builds from exactly these parts; the mint's uri stays empty (no uri mode).
    expect(b.metadata).toEqual({ name: "Aegis", symbol: "AEGS", doc: buildMetadataDoc(docInput(withMeta, png)) });
    expect(validateTokenMeta(b.metadata).ok).toBe(true);
    expect(tokenUri(b.metadata)).toBe("");
    expect(b.metadata.flags).toBeUndefined();
    const doc = parseMetadataDoc(b.metadata.doc as Uint8Array, { name: "Aegis", symbol: "AEGS" });
    expect(doc.ok).toBe(true);
    expect(doc.description).toBe("A token.");
    expect(doc.icon?.width).toBe(32);
    expect(doc.links.map((l) => [l.kind, l.host, l.url])).toEqual([
      ["website", "example.org", "https://example.org"],
      ["x", "x.com", "https://x.com/noised_xyz"],
    ]);
    // The signed hash covers the document: another description is another record.
    const c = convertDraft({ ...withMeta, meta: { ...withMeta.meta, description: "Another." } }, null, png);
    expect(metadataHashV2(c.metadata)).not.toEqual(metadataHashV2(b.metadata));
    expect(b.recordBytes).toBe(91 + 5 + 4 + (b.metadata.doc as Uint8Array).length);
    expect(b.docBytes).toBe((b.metadata.doc as Uint8Array).length);
  });

  it("waits for the icon's PNG, and a record with no optional part has no document", async () => {
    const d = ready();
    const waiting = convertDraft(d);
    expect(waiting.metadataReady).toBe(false);
    expect(waiting.metadata).toEqual({ name: "Aegis", symbol: "AEGS" });
    const blank: Draft = { ...d, meta: { ...d.meta, icon: { ...d.meta.icon, pixels: blankPixels() } } };
    expect(await iconPng(blank.meta.icon)).toBeNull();
    const plain = convertDraft(blank);
    expect(plain.metadataReady).toBe(true);
    expect(plain.metadata).toEqual({ name: "Aegis", symbol: "AEGS" });
    expect(plain.docBytes).toBe(0);
  });

  it("refuses document parts the record cannot hold, under the field that shows them", async () => {
    const d = ready();
    const png = await iconPng(d.meta.icon);
    const errorsOf = (meta: Partial<Draft["meta"]>): string[] =>
      convertDraft({ ...d, meta: { ...d.meta, ...meta } }, null, png).policyErrors.filter((e) => /^(description|website|x|icon): /.test(e));
    expect(errorsOf({})).toEqual([]);
    expect(errorsOf({ description: "x".repeat(501) })).toEqual(["description: must be at most 500 bytes (is 501)"]);
    expect(errorsOf({ website: "http://example.org" })).toEqual(["website: must start with https://"]);
    expect(errorsOf({ x: "a b" })).toEqual(["x: must be printable ASCII with no spaces"]);
    // A refused part keeps the document out of the record (nothing half-built is signed).
    expect(convertDraft({ ...d, meta: { ...d.meta, website: "http://example.org" } }, null, png).metadata.doc).toBeUndefined();
  });

  it("checks the optional fields in plain words", () => {
    const m = ready().meta;
    expect(metaProblems(m)).toEqual({ description: null, website: null, x: null });
    // Bytes, as the record counts them: 250 two-byte characters fit, 501 one-byte ones do not.
    expect(metaProblems({ ...m, description: "é".repeat(250) }).description).toBeNull();
    expect(metaProblems({ ...m, description: "a".repeat(501) }).description).toMatch(/500 bytes/);
    expect(metaProblems({ ...m, website: "http://example.com" }).website).toMatch(/https/);
    expect(metaProblems({ ...m, website: "https://example.com/token" }).website).toBeNull();
    expect(metaProblems({ ...m, x: "@noised_xyz" }).x).toBeNull();
    expect(metaProblems({ ...m, x: "way_too_long_handle_here" }).x).not.toBeNull();
  });

  it("keeps the icon and words when the preset changes", () => {
    const d = { ...ready(), meta: { ...ready().meta, description: "Kept" } };
    expect(draftFromPreset("turbo", d).meta).toBe(d.meta);
  });
});

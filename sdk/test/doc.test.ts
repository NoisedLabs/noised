/**
 * The metadata document (src/metadata/doc.ts): `buildMetadataDoc` writes
 * the vectors' documents byte for byte (compact JSON, the fixed key order of
 * METADATA_ONCHAIN.md §4.8, the icon inline), refuses what a reader would
 * not show, and `parseMetadataDoc` reads any document without trusting it
 * and without fetching anything.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { encodeBase64 } from "../src/codec/base64.js";
import { fromHex, toHex, utf8 } from "../src/codec/bytes.js";
import { buildMetadataDoc, parseMetadataDoc, validateMetadataDoc, type MetadataDocInput } from "../src/metadata/doc.js";
import { encodeIndexedPng } from "../src/metadata/png.js";
import { readJson } from "./helpers.js";

interface Case {
  name: string;
  record: { name: string; symbol: string; doc: string; docHex: string };
}
const V = readJson<{ icon: { png: string }; cases: Case[] }>("./vectors/metadata.json");
const LMS = readJson<{ metadata: { name: string; symbol: string; doc: string } }>("./vectors/lms.json");
const ICON = fromHex(V.icon.png);
const TYPICAL = V.cases[1]!.record;
const DESCRIPTION = "A fair-launched token on Phalanx. Its name, symbol, description and icon are stored on-chain and signed by its creator's post-quantum key.";
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildMetadataDoc", () => {
  it("writes the vectors' documents byte for byte: the typical one (with the icon), the multi-byte one, lms.json's", () => {
    const typical = buildMetadataDoc({ name: TYPICAL.name, symbol: TYPICAL.symbol, description: DESCRIPTION, iconPng: ICON });
    expect(toHex(typical)).toBe(TYPICAL.docHex);
    expect(typical.length).toBe(1_130);
    const multi = V.cases[8]!.record;
    const description = (JSON.parse(multi.doc) as { description: string }).description;
    expect(toHex(buildMetadataDoc({ name: multi.name, symbol: multi.symbol, description }))).toBe(multi.docHex);
    expect(dec(buildMetadataDoc({ name: LMS.metadata.name, symbol: LMS.metadata.symbol, description: "PQ v2 test vectors" }))).toBe(LMS.metadata.doc);
  });

  it("the fixed key order, empty parts left out, links last; the same input gives the same bytes", () => {
    const input: MetadataDocInput = {
      name: "Token",
      symbol: "TKN",
      description: "",
      iconPng: ICON,
      links: { telegram: "https://t.me/token", x: "https://x.com/token", website: "https://token.example/about?a=1" },
    };
    const doc = dec(buildMetadataDoc(input));
    expect(doc).toBe(
      `{"name":"Token","symbol":"TKN","image":"data:image/png;base64,${encodeBase64(ICON)}","external_url":"https://token.example/about?a=1","extensions":{"x":"https://x.com/token","telegram":"https://t.me/token"}}`,
    );
    expect(toHex(buildMetadataDoc({ ...input }))).toBe(toHex(buildMetadataDoc(input)));
    expect(dec(buildMetadataDoc({ name: "N", symbol: "S" }))).toBe('{"name":"N","symbol":"S"}');
    expect(dec(buildMetadataDoc({ name: "N", symbol: "S", links: { telegram: "https://t.me/x" } }))).toBe('{"name":"N","symbol":"S","extensions":{"telegram":"https://t.me/x"}}');
    // JSON escapes, not raw quotes or control characters.
    expect(dec(buildMetadataDoc({ name: 'say "hi"', symbol: "S", description: "line 1\nline 2\\" }))).toBe('{"name":"say \\"hi\\"","symbol":"S","description":"line 1\\nline 2\\\\"}');
  });

  it("refuses, with every problem listed: lengths in UTF-8 bytes, a PNG that is not one or is over 64x64, unsafe links, a document over 3,072 bytes", async () => {
    const errors = (i: MetadataDocInput): string[] => validateMetadataDoc(i).errors;
    expect(errors({ name: "€".repeat(11), symbol: "", description: "d".repeat(501) })).toEqual([
      "name: must be 1..=32 bytes of UTF-8 (is 33)",
      "symbol: must be 1..=32 bytes of UTF-8 (is 0)".replace("32", "10"),
      "description: must be at most 500 bytes of UTF-8 (is 501)",
    ]);
    expect(errors({ name: "N\uD800", symbol: "S" })).toEqual(["name: contains an unpaired UTF-16 surrogate (not valid text)"]);
    expect(errors({ name: "N", symbol: "S", iconPng: utf8("<svg/>") })).toEqual(["iconPng: is not a valid PNG (not a PNG (wrong signature))"]);
    const big = await encodeIndexedPng({ indices: new Uint8Array(65 * 65), palette: Uint8Array.of(0, 0, 0, 255) }, 65, 65);
    expect(errors({ name: "N", symbol: "S", iconPng: big })).toEqual(["iconPng: must be at most 64x64 pixels (is 65x65)"]);
    expect(errors({ name: "N", symbol: "S", iconPng: "x" as never })).toEqual(["iconPng: must be the PNG's bytes"]);
    expect(
      errors({
        name: "N",
        symbol: "S",
        links: { website: "http://token.example", x: "https://evil.example/token", telegram: "https://t.me@evil.example/x" },
      }),
    ).toEqual(["links.website: must start with https://", "links.x: must be a link to x.com", "links.telegram: must not carry a user name (an @ before the host hides the real site)"]);
    expect(errors({ name: "N", symbol: "S", links: { website: "https://a b" } })).toEqual(["links.website: must be printable ASCII with no spaces"]);
    expect(errors({ name: "N", symbol: "S", links: { website: `https://${"a".repeat(193)}` } })).toEqual(["links.website: must be at most 200 characters"]);
    expect(errors({ name: "N", symbol: "S", links: { website: "https://" } })).toEqual(["links.website: must name a host"]);
    expect(errors({ name: "N", symbol: "S", links: { x: "https://twitter.com/t", telegram: "https://telegram.me/t" } })).toEqual([]);
    // A stored 64x64 icon of 16 colours makes the document too big for the record.
    const noisy = new Uint8Array(64 * 64);
    noisy.forEach((_, i) => (noisy[i] = (i * 7919) % 16));
    const palette = new Uint8Array(64).map((_, i) => (i % 4 === 3 ? 255 : i * 13));
    const stored = await encodeIndexedPng({ indices: noisy, palette }, 64, 64, 16, { compression: "store" });
    expect(errors({ name: "N", symbol: "S", description: "d".repeat(500), iconPng: stored })).toEqual([expect.stringMatching(/^document: is \d+ bytes, at most 3072: shorten the description or use a smaller icon$/)]);
    expect(() => buildMetadataDoc({ name: "", symbol: "S" })).toThrow(/invalid metadata document:\nname: must be 1\.\.=32/);
    expect(validateMetadataDoc(null as never)).toEqual({ ok: false, errors: ["document: must be an object"] });
  });
});

describe("parseMetadataDoc: never trusted, never fetched", () => {
  it("the vectors' documents: the typical one with its 32x32 icon, the multi-byte one, the empty one, the largest one", () => {
    const fetch = vi.fn(() => {
      throw new Error("parseMetadataDoc must never fetch");
    });
    vi.stubGlobal("fetch", fetch);
    const p = parseMetadataDoc(fromHex(TYPICAL.docHex), { name: TYPICAL.name, symbol: TYPICAL.symbol });
    expect([p.ok, p.empty, p.problems, p.warnings]).toEqual([true, false, [], []]);
    expect([p.name, p.symbol, p.description]).toEqual([TYPICAL.name, TYPICAL.symbol, DESCRIPTION]);
    expect([p.icon?.width, p.icon?.height, toHex(p.icon!.png), p.icon?.dataUri.startsWith("data:image/png;base64,iVBORw0KGgo")]).toEqual([32, 32, V.icon.png, true]);
    expect(p.links).toEqual([]);
    const multi = parseMetadataDoc(V.cases[8]!.record.doc);
    expect([multi.ok, multi.description]).toEqual([true, "Multi-byte UTF-8: été ¿ÿ? € ☃ �é"]);
    expect(parseMetadataDoc(new Uint8Array(0))).toMatchObject({ ok: true, empty: true, name: null, icon: null, links: [] });
    // The largest document the program takes: valid, its description longer than the SDK writes.
    const largest = parseMetadataDoc(V.cases[5]!.record.doc);
    expect(largest.ok).toBe(true);
    expect(largest.warnings).toEqual([expect.stringMatching(/^description: is \d+ bytes \(the SDK writes at most 500\)$/)]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("links are inert text with their host; unusable ones are dropped with a warning", () => {
    const doc = buildMetadataDoc({ name: "N", symbol: "S", links: { website: "https://Token.Example:8443/a", x: "https://x.com/t", telegram: "https://t.me/t" } });
    expect(parseMetadataDoc(doc).links).toEqual([
      { kind: "website", url: "https://Token.Example:8443/a", host: "token.example" },
      { kind: "x", url: "https://x.com/t", host: "x.com" },
      { kind: "telegram", url: "https://t.me/t", host: "t.me" },
    ]);
    const bad = parseMetadataDoc('{"name":"N","symbol":"S","external_url":"javascript:alert(1)","extensions":{"x":"https://x.com@evil.example","telegram":5,"discord":"https://d.gg"}}');
    expect(bad.ok).toBe(true);
    expect(bad.links).toEqual([]);
    expect(bad.warnings).toEqual([
      "external_url: must start with https://; ignored",
      'extensions: unknown key "discord" ignored',
      "extensions.x: must not carry a user name (an @ before the host hides the real site); ignored",
      "extensions.telegram: must be text; ignored",
      "document: not in the canonical form the SDK writes (key order, spacing, escapes, unknown or repeated keys): other readers may show it differently",
    ]);
    expect(parseMetadataDoc('{"name":"N","symbol":"S","extensions":[1]}').warnings[0]).toBe("extensions: is not an object; ignored");
  });

  it("the image: only an inline PNG (canonical base64) of at most 64x64; anything else is not shown", async () => {
    const withImage = (image: unknown): ReturnType<typeof parseMetadataDoc> => parseMetadataDoc(JSON.stringify({ name: "N", symbol: "S", image }));
    for (const image of ["https://evil.example/x.png", "ipfs://bafy", "data:image/svg+xml;base64,PHN2Zy8+", "data:image/png;base64,", "data:image/png,iVBORw0KGgo", 5, "data:image/png;base64,iVBORw0KGgo AAAA"]) {
      const p = withImage(image);
      expect([p.ok, p.icon], String(image)).toEqual([false, null]);
      expect(p.problems, String(image)).toEqual(["image: is not an inline PNG (data:image/png;base64,…)"]);
    }
    // Base64 with non-zero pad bits: two texts for one byte string are not accepted.
    let padded = ICON;
    for (let w = 1; padded.length % 3 !== 1; w++) padded = await encodeIndexedPng({ indices: new Uint8Array(w), palette: Uint8Array.of(0, 0, 0, 255) }, w, 1, 1, { compression: "store" });
    const b64 = encodeBase64(padded);
    expect(b64.endsWith("==")).toBe(true);
    expect(withImage(`data:image/png;base64,${b64}`).ok).toBe(true);
    const last = b64.at(-3)!;
    const tweaked = b64.slice(0, -3) + String.fromCharCode(last.charCodeAt(0) + 1) + b64.slice(-2);
    expect(withImage(`data:image/png;base64,${tweaked}`).problems).toEqual(["image: is not canonical base64"]);
    expect(withImage(`data:image/png;base64,${encodeBase64(utf8("GIF89a-not-png"))}`).problems).toEqual(["image: is not a valid PNG (not a PNG (wrong signature))"]);
    const big = await encodeIndexedPng({ indices: new Uint8Array(65), palette: Uint8Array.of(0, 0, 0, 255) }, 65, 1);
    expect(withImage(`data:image/png;base64,${encodeBase64(big)}`).problems).toEqual(["image: must be at most 64x64 pixels (is 65x1)"]);
    // The name and symbol are still shown.
    expect(withImage("https://evil.example/x.png").name).toBe("N");
  });

  it("refuses what is not a document: too big, not UTF-8, not JSON, not an object; a name or symbol that is not the record's", () => {
    expect(parseMetadataDoc(new Uint8Array(3_073).fill(0x20)).problems).toEqual(["document: is 3073 bytes, over the 3072-byte limit"]);
    expect(parseMetadataDoc(Uint8Array.of(0x7b, 0xff, 0x7d)).problems).toEqual(["document: is not valid UTF-8"]);
    expect(parseMetadataDoc("{name:1}").problems).toEqual(["document: is not valid JSON"]);
    expect(parseMetadataDoc("﻿{}").problems).toEqual(["document: is not valid JSON"]); // a BOM is kept, so JSON.parse refuses it
    for (const notObject of ["[]", "null", '"text"', "3"]) expect(parseMetadataDoc(notObject).problems, notObject).toEqual(["document: is not a JSON object"]);
    const mismatch = parseMetadataDoc('{"name":"Other","symbol":"S"}', { name: "Token", symbol: utf8("S") });
    expect([mismatch.ok, mismatch.problems]).toEqual([false, ['name: the document says "Other", the record "Token"']]);
    expect(parseMetadataDoc('{"name":"N","symbol":"S"}', { symbol: Uint8Array.of(0xff) }).problems).toEqual(['symbol: the document says "S", the record "(not UTF-8)"']);
    expect(parseMetadataDoc('{"name":5,"symbol":"S","description":[]}').problems).toEqual(["name: is not text", "description: is not text"]);
    expect(parseMetadataDoc("{}").warnings).toEqual(["name: missing (the record's name is shown)", "symbol: missing (the record's symbol is shown)"]);
    expect(() => parseMetadataDoc(5 as never)).toThrow(TypeError);
  });

  it("a document not in the canonical form (repeated keys, spacing, key order) is shown with a warning: other readers may differ", () => {
    for (const text of ['{"name":"A","name":"B","symbol":"S"}', '{ "name": "N", "symbol": "S" }', '{"symbol":"S","name":"N"}', '{"name":"N","symbol":"S","description":""}']) {
      const p = parseMetadataDoc(text);
      expect(p.ok, text).toBe(true);
      expect(p.warnings, text).toEqual(["document: not in the canonical form the SDK writes (key order, spacing, escapes, unknown or repeated keys): other readers may show it differently"]);
    }
    expect(parseMetadataDoc(buildMetadataDoc({ name: "N", symbol: "S", description: "d", iconPng: ICON, links: { website: "https://n.example" } })).warnings).toEqual([]);
  });
});

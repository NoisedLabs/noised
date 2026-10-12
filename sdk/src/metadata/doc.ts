/**
 * The metadata document a record carries (METADATA_ONCHAIN.md §4.8): compact
 * JSON in a fixed key order, Metaplex's fungible keys, the icon inline.
 *
 * ```json
 * {"name":"…","symbol":"…","description":"… (<= 500 bytes)","image":"data:image/png;base64,…",
 *  "external_url":"https://…","extensions":{"x":"https://x.com/…","telegram":"https://t.me/…"}}
 * ```
 *
 * Every key but `name` and `symbol` is optional and left out when empty. The
 * program never parses the document: the SDK writes it (`buildMetadataDoc`)
 * and reads it defensively (`parseMetadataDoc`). Reading never fetches
 * anything: the icon is a PNG inside the document (no SVG, no remote image),
 * and links are returned as inert text with their host spelled out, for a
 * UI to show as text, never to load.
 */
import { decodeBase64, encodeBase64 } from "../codec/base64.js";
import { utf8 } from "../codec/bytes.js";
import { METADATA } from "../constants.js";
import type { ValidationResult } from "../types.js";
import { pngInfo, PngError } from "./png.js";
import { utf8Text, type MetadataText } from "./record.js";

/** A project's links: shown as text with the domain spelled out; never fetched. */
export interface MetadataLinks {
  /** `external_url`: any `https://` site. */
  readonly website?: string | undefined;
  /** `extensions.x`: an `https://x.com/…` (or twitter.com) link. */
  readonly x?: string | undefined;
  /** `extensions.telegram`: an `https://t.me/…` (or telegram.me) link. */
  readonly telegram?: string | undefined;
}

/** `buildMetadataDoc` input: the record's own name and symbol, and the optional parts. */
export interface MetadataDocInput {
  readonly name: string;
  readonly symbol: string;
  /** At most 500 bytes of UTF-8. */
  readonly description?: string | undefined;
  /** A PNG of at most 64x64 pixels (`encodeIndexedPng`: 32x32 with 16 colours is recommended). */
  readonly iconPng?: Uint8Array | undefined;
  readonly links?: MetadataLinks | undefined;
}

export type MetadataLinkKind = "website" | "x" | "telegram";

/** A link read from a document: inert text. */
export interface MetadataLink {
  readonly kind: MetadataLinkKind;
  readonly url: string;
  /** The host the link goes to, lower case (show it next to the link). */
  readonly host: string;
}

/** An icon read from a document. */
export interface MetadataIcon {
  readonly png: Uint8Array;
  /** `data:image/png;base64,…`, exactly as stored (an `<img src>` under `img-src data:`). */
  readonly dataUri: string;
  readonly width: number;
  readonly height: number;
}

/** `parseMetadataDoc`'s result. Show a field only when it is not null; show nothing of a document whose `ok` is false but what is not null. */
export interface ParsedMetadataDoc {
  /** No problem was found (warnings may remain). */
  readonly ok: boolean;
  /** The document is empty (a record without one): nothing to show but the name and symbol. */
  readonly empty: boolean;
  /** Why the document (or a part of it) cannot be used. */
  readonly problems: string[];
  /** Parts that were ignored or look unusual. */
  readonly warnings: string[];
  readonly name: string | null;
  readonly symbol: string | null;
  readonly description: string | null;
  readonly icon: MetadataIcon | null;
  readonly links: MetadataLink[];
}

const IMAGE_PREFIX = "data:image/png;base64,";
const IMAGE_RE = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const KNOWN_KEYS = ["name", "symbol", "description", "image", "external_url", "extensions"];
const LINK_HOSTS: Readonly<Record<Exclude<MetadataLinkKind, "website">, readonly string[]>> = {
  x: ["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"],
  telegram: ["t.me", "telegram.me", "www.telegram.me"],
};

const byteLen = (s: string): number => utf8(s).length;

/**
 * Why `url` is not a usable `kind` link (null when it is): `https://`, a
 * host (no user info), at most 200 bytes, every character printable ASCII;
 * an X or Telegram link must go to that service's own host.
 */
function linkProblem(kind: MetadataLinkKind, url: unknown): string | null {
  if (typeof url !== "string") return "must be text";
  if (url.length > METADATA.MAX_URI_LEN) return `must be at most ${METADATA.MAX_URI_LEN} characters`;
  if (!/^[\x21-\x7e]+$/.test(url)) return "must be printable ASCII with no spaces";
  if (!url.startsWith("https://")) return "must start with https://";
  const authority = /^https:\/\/([^/?#]*)/.exec(url)![1]!;
  if (authority.includes("@")) return "must not carry a user name (an @ before the host hides the real site)";
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[0-9]{1,5})?$/.test(authority)) return "must name a host";
  if (kind !== "website") {
    const host = authority.replace(/:[0-9]+$/, "").toLowerCase();
    if (!LINK_HOSTS[kind].includes(host)) return `must be a link to ${LINK_HOSTS[kind][0]}`;
  }
  return null;
}

function hostOf(url: string): string {
  return /^https:\/\/([^/?#:]*)/.exec(url)![1]!.toLowerCase();
}

function iconProblem(png: Uint8Array): string | null {
  try {
    const info = pngInfo(png);
    if (info.width > METADATA.MAX_ICON_SIDE || info.height > METADATA.MAX_ICON_SIDE) {
      return `must be at most ${METADATA.MAX_ICON_SIDE}x${METADATA.MAX_ICON_SIDE} pixels (is ${info.width}x${info.height})`;
    }
    return null;
  } catch (e) {
    if (e instanceof PngError) return `is not a valid PNG (${e.message})`;
    throw e;
  }
}

/** The parts of a document, as stored (the image as its data URI). */
interface DocParts {
  readonly name: string;
  readonly symbol: string;
  readonly description?: string | undefined;
  readonly image?: string | undefined;
  readonly website?: string | undefined;
  readonly x?: string | undefined;
  readonly telegram?: string | undefined;
}

/** The canonical text of a document: keys in the fixed order, empty parts left out, no whitespace. */
function canonicalText(p: DocParts): string {
  const o: Record<string, unknown> = { name: p.name, symbol: p.symbol };
  const set = (k: string, v: string | undefined): void => {
    if (v !== undefined && v !== "") o[k] = v;
  };
  set("description", p.description);
  set("image", p.image);
  set("external_url", p.website);
  const ext: Record<string, string> = {};
  if (p.x !== undefined && p.x !== "") ext["x"] = p.x;
  if (p.telegram !== undefined && p.telegram !== "") ext["telegram"] = p.telegram;
  if (Object.keys(ext).length > 0) o["extensions"] = ext;
  return JSON.stringify(o);
}

function docText(input: MetadataDocInput): string {
  const links = input.links ?? {};
  return canonicalText({
    name: input.name,
    symbol: input.symbol,
    description: input.description,
    image: input.iconPng === undefined ? undefined : IMAGE_PREFIX + encodeBase64(input.iconPng),
    website: links.website,
    x: links.x,
    telegram: links.telegram,
  });
}

/**
 * Check a document's parts before building it: name 1..=32 and symbol
 * 1..=10 bytes (the record's own), a description of at most 500 bytes, a
 * PNG icon of at most 64x64, `https://` links (X and Telegram to their own
 * hosts), no unpaired UTF-16 surrogate, and the whole document at most
 * 3,072 bytes. Every problem as `"field: message"`.
 */
export function validateMetadataDoc(input: MetadataDocInput): ValidationResult {
  const errors: string[] = [];
  if (input === null || typeof input !== "object") return { ok: false, errors: ["document: must be an object"] };
  const text = (field: string, v: unknown, min: number, max: number, unit: string): void => {
    if (typeof v !== "string") errors.push(`${field}: must be text`);
    else if (LONE_SURROGATE.test(v)) errors.push(`${field}: contains an unpaired UTF-16 surrogate (not valid text)`);
    else if (byteLen(v) < min || byteLen(v) > max) errors.push(`${field}: must be ${min === 0 ? `at most ${max}` : `${min}..=${max}`} ${unit} (is ${byteLen(v)})`);
  };
  text("name", input.name, 1, METADATA.MAX_NAME_LEN, "bytes of UTF-8");
  text("symbol", input.symbol, 1, METADATA.MAX_SYMBOL_LEN, "bytes of UTF-8");
  if (input.description !== undefined) text("description", input.description, 0, METADATA.MAX_DESCRIPTION_LEN, "bytes of UTF-8");
  if (input.iconPng !== undefined) {
    if (!(input.iconPng instanceof Uint8Array)) errors.push("iconPng: must be the PNG's bytes");
    else {
      const p = iconProblem(input.iconPng);
      if (p !== null) errors.push(`iconPng: ${p}`);
    }
  }
  const links = input.links ?? {};
  if (links === null || typeof links !== "object") errors.push("links: must be an object");
  else {
    for (const kind of ["website", "x", "telegram"] as const) {
      const url = links[kind];
      if (url === undefined || url === "") continue;
      const p = linkProblem(kind, url);
      if (p !== null) errors.push(`links.${kind}: ${p}`);
    }
  }
  if (errors.length === 0) {
    const size = byteLen(docText(input));
    if (size > METADATA.MAX_DOC_LEN) errors.push(`document: is ${size} bytes, at most ${METADATA.MAX_DOC_LEN}: shorten the description or use a smaller icon`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * The document's bytes: compact JSON (no whitespace) with the keys in the
 * fixed order `name, symbol, description, image, external_url,
 * extensions{x, telegram}`, empty parts left out, the icon as
 * `data:image/png;base64,…`. At most 3,072 bytes; throws with every problem
 * listed (`validateMetadataDoc`) otherwise. The same input gives the same
 * bytes, so its hash can be recomputed anywhere.
 */
export function buildMetadataDoc(input: MetadataDocInput): Uint8Array {
  const v = validateMetadataDoc(input);
  if (!v.ok) throw new Error(`invalid metadata document:\n${v.errors.join("\n")}`);
  return utf8(docText(input));
}

/** `parseMetadataDoc` options: the record the document belongs to (its name and symbol must match). */
export interface ParseMetadataDocOptions {
  readonly name?: MetadataText | undefined;
  readonly symbol?: MetadataText | undefined;
}

const asText = (v: MetadataText): string | null => (typeof v === "string" ? v : utf8Text(v));

/**
 * Read a record's document without trusting it and without fetching
 * anything:
 *
 * - at most 3,072 bytes, strict UTF-8, `JSON.parse`, a JSON object;
 * - `name` and `symbol`: text, equal to the record's (`opts`) when given;
 * - `description`: text (over 500 bytes is a warning);
 * - `image`: only `data:image/png;base64,…` (canonical base64) of a
 *   well-formed PNG (`pngInfo`) of at most 64x64 pixels;
 * - links (`external_url`, `extensions.x`, `extensions.telegram`): inert
 *   text with the host spelled out; an unusable link is dropped with a
 *   warning; unknown keys are ignored with a warning, as is a document not
 *   in the canonical form `buildMetadataDoc` writes (other readers may show
 *   a document with repeated keys differently).
 *
 * A part with a problem is null in the result; `ok` is false.
 */
export function parseMetadataDoc(doc: MetadataText, opts: ParseMetadataDocOptions = {}): ParsedMetadataDoc {
  const bytes = typeof doc === "string" ? utf8(doc) : doc;
  if (!(bytes instanceof Uint8Array)) throw new TypeError("doc must be a string or a Uint8Array");
  const problems: string[] = [];
  const warnings: string[] = [];
  const result = (o: Partial<ParsedMetadataDoc>): ParsedMetadataDoc => ({
    ok: problems.length === 0,
    empty: false,
    problems,
    warnings,
    name: null,
    symbol: null,
    description: null,
    icon: null,
    links: [],
    ...o,
  });
  if (bytes.length === 0) return result({ empty: true });
  if (bytes.length > METADATA.MAX_DOC_LEN) {
    problems.push(`document: is ${bytes.length} bytes, over the ${METADATA.MAX_DOC_LEN}-byte limit`);
    return result({});
  }
  const text = utf8Text(bytes);
  if (text === null) {
    problems.push("document: is not valid UTF-8");
    return result({});
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    problems.push("document: is not valid JSON");
    return result({});
  }
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    problems.push("document: is not a JSON object");
    return result({});
  }
  const o = json as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!KNOWN_KEYS.includes(k)) warnings.push(`document: unknown key "${k}" ignored`);

  const textField = (field: "name" | "symbol" | "description"): string | null => {
    const v = o[field];
    if (v === undefined) return null;
    if (typeof v !== "string") {
      problems.push(`${field}: is not text`);
      return null;
    }
    return v;
  };
  const name = textField("name");
  const symbol = textField("symbol");
  const description = textField("description");
  if (name === null && o["name"] === undefined) warnings.push("name: missing (the record's name is shown)");
  if (symbol === null && o["symbol"] === undefined) warnings.push("symbol: missing (the record's symbol is shown)");
  for (const [field, got, want] of [
    ["name", name, opts.name],
    ["symbol", symbol, opts.symbol],
  ] as const) {
    if (got === null || want === undefined) continue;
    if (got !== asText(want)) problems.push(`${field}: the document says "${got}", the record "${asText(want) ?? "(not UTF-8)"}"`);
  }
  if (description !== null && byteLen(description) > METADATA.MAX_DESCRIPTION_LEN) warnings.push(`description: is ${byteLen(description)} bytes (the SDK writes at most ${METADATA.MAX_DESCRIPTION_LEN})`);

  let icon: MetadataIcon | null = null;
  const image = o["image"];
  if (image !== undefined) {
    if (typeof image !== "string" || !IMAGE_RE.test(image)) problems.push("image: is not an inline PNG (data:image/png;base64,…)");
    else {
      const png = decodeBase64(image.slice(IMAGE_PREFIX.length));
      const p = png === null ? "is not canonical base64" : iconProblem(png);
      if (p !== null || png === null) problems.push(`image: ${p}`);
      else {
        const info = pngInfo(png);
        icon = { png, dataUri: image, width: info.width, height: info.height };
      }
    }
  }

  const links: MetadataLink[] = [];
  const link = (kind: MetadataLinkKind, where: string, url: unknown): void => {
    if (url === undefined) return;
    const p = linkProblem(kind, url);
    if (p !== null) warnings.push(`${where}: ${p}; ignored`);
    else links.push({ kind, url: url as string, host: hostOf(url as string) });
  };
  link("website", "external_url", o["external_url"]);
  const ext = o["extensions"];
  if (ext !== undefined) {
    if (ext === null || typeof ext !== "object" || Array.isArray(ext)) warnings.push("extensions: is not an object; ignored");
    else {
      const e = ext as Record<string, unknown>;
      for (const k of Object.keys(e)) if (k !== "x" && k !== "telegram") warnings.push(`extensions: unknown key "${k}" ignored`);
      link("x", "extensions.x", e["x"]);
      link("telegram", "extensions.telegram", e["telegram"]);
    }
  }

  // The canonical form: the same text `buildMetadataDoc` would write for these values.
  if (problems.length === 0 && name !== null && symbol !== null) {
    const e = (ext ?? {}) as Record<string, unknown>;
    const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
    const canonical = canonicalText({ name, symbol, description: description ?? undefined, image: str(image), website: str(o["external_url"]), x: str(e["x"]), telegram: str(e["telegram"]) });
    if (canonical !== text) warnings.push("document: not in the canonical form the SDK writes (key order, spacing, escapes, unknown or repeated keys): other readers may show it differently");
  }
  return result({ name, symbol, description, icon, links });
}

/**
 * Positioning (LAYER_V1 §B.1): Noised is "the quantum security layer for Solana" with the products Launch, Vault,
 * Shield and Verify, in the navigation, the home hero, the footer, every page title and the page's meta and OG text;
 * and none of it makes a claim the QSL-1 standard forbids (Appendix A.3: no "quantum-proof").
 */
import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { BRAND_MARK, HERO_SUB, HERO_TITLE, NAV, SITE_TITLE, TAGLINE } from "../src/app/brand";
import { ownTitle, pageTitle } from "../src/app/titles";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const meta = (attr: "name" | "property", key: string): string | null => new RegExp(`<meta ${attr}="${key}" content="([^"]*)"`).exec(html)?.[1] ?? null;
/** A file under app/public by its site path ("/brand/x.png" or "brand/x.png"). */
const publicFile = (path: string): Buffer => readFileSync(new URL(`../public/${path.replace(/^\//, "")}`, import.meta.url));
/** A PNG's width and height, from its IHDR chunk. */
const pngSize = (png: Buffer): [number, number] => {
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(png.subarray(12, 16).toString("latin1")).toBe("IHDR");
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
};

describe("positioning", () => {
  it("names the layer and its products in the navigation", () => {
    expect(NAV.map((n) => n.label)).toEqual(["Launch", "Vault", "Shield", "Verify", "Security", "Docs"]);
    expect(NAV.find((n) => n.label === "Verify")?.to).toBe("/verify");
    expect(NAV.find((n) => n.label === "Shield")?.hint).toBe("Private balances");
  });

  it("leads the home page and the footer with the quantum security layer, in plain words", () => {
    expect(HERO_TITLE.join("")).toBe("Quantum security for Solana.");
    expect(HERO_SUB).toMatch(/^Noised is the quantum security layer for Solana\./);
    for (const product of ["Launch tokens nobody can rug", "vault only your quantum key opens", "balances privately", "check any token"]) expect(HERO_SUB).toContain(product);
    expect(TAGLINE).toMatch(/^The quantum security layer for Solana\./);
  });

  it("titles every page with the layer", () => {
    expect(SITE_TITLE).toBe("Noised: the quantum security layer for Solana");
    expect(pageTitle("/")).toBe(SITE_TITLE);
    expect(pageTitle("/create")).toBe("Launch a token · Noised");
    expect(pageTitle("/vault")).toBe("Vault · Noised");
    expect(pageTitle("/shield")).toBe("Shield: private balances · Noised");
    expect(pageTitle("/verify")).toBe("Verify a token · Noised");
    expect(pageTitle("/security")).toBe("Security · Noised");
    expect(pageTitle("/nope")).toBe("Not found · Noised");
    // Pages that name themselves.
    expect(pageTitle("/docs/standard/qsl-1")).toBeNull();
    expect(pageTitle("/token/abc")).toBeNull();
    expect(pageTitle("/verify/abc")).toBeNull();
    expect(ownTitle("AEGS")).toBe("AEGS · Noised");
  });

  it("says the same in the HTML title, description and Open Graph text", () => {
    expect(/<title>([^<]*)<\/title>/.exec(html)?.[1]).toBe(SITE_TITLE);
    expect(meta("name", "description")).toMatch(/^Noised is the quantum security layer for Solana\./);
    expect(meta("property", "og:title")).toBe(SITE_TITLE);
    expect(meta("property", "og:description")).toMatch(/Launch, Vault, Shield and Verify/);
    expect(meta("name", "twitter:card")).toBe("summary_large_image");
  });

  it("previews links with the 1280 x 640 social card, by absolute URL on noised.fun", () => {
    const card = "https://noised.fun/brand/noised-social-1280x640.png";
    expect(meta("property", "og:image")).toBe(card);
    expect(meta("name", "twitter:image")).toBe(card);
    expect(meta("property", "og:image:type")).toBe("image/png");
    expect([meta("property", "og:image:width"), meta("property", "og:image:height")]).toEqual(["1280", "640"]);
    // public/ is copied to the site root, so the URL's path is the file's path under public/.
    expect(pngSize(publicFile(new URL(card).pathname))).toEqual([1280, 640]);
  });

  it("links the Noised hexagon favicons (PNG) and the Apple touch icon, all shipped in public/brand", () => {
    const icons = [...html.matchAll(/<link rel="(icon|apple-touch-icon)"([^>]*)>/g)].map((m) => ({
      rel: m[1],
      type: /type="([^"]*)"/.exec(m[2] ?? "")?.[1],
      sizes: /sizes="([^"]*)"/.exec(m[2] ?? "")?.[1],
      href: /href="([^"]*)"/.exec(m[2] ?? "")?.[1] ?? "",
    }));
    expect(icons.map((i) => [i.rel, i.href])).toEqual([
      ["icon", "/brand/favicon-32.png"],
      ["icon", "/brand/favicon-48.png"],
      ["icon", "/brand/favicon-192.png"],
      ["apple-touch-icon", "/brand/apple-touch-icon.png"],
    ]);
    for (const i of icons) {
      if (i.rel === "icon") expect(i.type).toBe("image/png");
      const [w, h] = pngSize(publicFile(i.href));
      expect(i.sizes).toBe(`${w}x${h}`);
    }
    expect(html).not.toMatch(/favicon\.svg/);
    expect(existsSync(new URL("../public/favicon.svg", import.meta.url))).toBe(false);
  });

  it("shows the official mark next to the wordmark, pre-scaled for 1x, 2x and 3x screens in both themes", () => {
    for (const files of [BRAND_MARK.light, BRAND_MARK.dark]) {
      expect(files.map((f) => pngSize(publicFile(f)))).toEqual([1, 2, 3].map((x) => [BRAND_MARK.size * x, BRAND_MARK.size * x]));
      // Relative paths: the site works from any path (IPFS gateways).
      for (const f of files) expect(f).toMatch(/^brand\/[\w-]+\.png$/);
    }
  });

  it("never calls a token or a launch quantum-proof", () => {
    for (const text of [html, HERO_SUB, TAGLINE, HERO_TITLE.join(""), ...NAV.map((n) => n.hint)]) expect(text).not.toMatch(/quantum[- ‑]?proof|quantum[- ‑]safe token/i);
  });
});

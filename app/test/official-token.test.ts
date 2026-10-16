/**
 * The official Noised token, $NOISED, on the home page (components/OfficialToken.tsx, facts in lib/brandPolicy.ts): the
 * full contract address with a copy button, and Buy (Jupiter), Chart (DEX Screener) and Explorer (Solscan), each in a
 * new tab without an opener or a referrer. It sits above the hero's headline; the footer links it too. Nothing is
 * fetched (the mark is the site's own file), and nothing calls it quantum-signed: it was launched on Meteora, not
 * through Noised.
 */
import { readFileSync } from "node:fs";

import { PublicKey } from "@solana/web3.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OFFICIAL_LINKS, OfficialTokenActions, OfficialTokenBar, copyOfficialMint } from "../src/components/OfficialToken";
import { brandFlag, officialToken } from "../src/lib/brandGuard";
import { OFFICIAL_NOISED, OFFICIAL_NOISED_SHORT, OFFICIAL_TOKENS } from "../src/lib/brandPolicy";

const MINT = "5oZbhxYrdoUiLWsgTxAPx3rgcvBCErw47oD5vXjnoisd";
const POOL = "7Xj1J43rn5VndyxjPmTjdX4yWUY8wmWm4szr3YKLr3QA";
const BUY = "https://jup.ag/swap/SOL-5oZbhxYrdoUiLWsgTxAPx3rgcvBCErw47oD5vXjnoisd";
const CHART = "https://dexscreener.com/solana/7xj1j43rn5vndyxjpmtjdx4ywuy8wmwm4szr3yklr3qa";
const EXPLORER = "https://solscan.io/token/5oZbhxYrdoUiLWsgTxAPx3rgcvBCErw47oD5vXjnoisd";

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const text = (h: string): string =>
  h
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the official token's facts", () => {
  it("are $NOISED, its mint, its pool and its three links", () => {
    expect(OFFICIAL_NOISED.mint).toBe(MINT);
    expect(new PublicKey(MINT).toBase58()).toBe(MINT);
    expect(OFFICIAL_NOISED.label).toBe("$NOISED");
    expect(OFFICIAL_NOISED.symbol).toBe("NOISED");
    expect(OFFICIAL_NOISED.pool).toBe(POOL);
    expect(OFFICIAL_NOISED.links).toEqual({ buy: BUY, chart: CHART, explorer: EXPLORER });
    // Every link names this mint or this pool.
    expect(CHART.toLowerCase()).toContain(POOL.toLowerCase());
    expect(BUY.endsWith(MINT) && EXPLORER.endsWith(MINT)).toBe(true);
    expect(OFFICIAL_NOISED_SHORT).toBe("5oZbhx…noisd");
  });

  it("are the one mint allowed to use the Noised name", () => {
    expect(OFFICIAL_TOKENS.map((o) => o.mint)).toEqual([MINT]);
    expect(officialToken(MINT)?.label).toBe("$NOISED");
    expect(brandFlag({ mint: MINT, name: "Noised", symbol: "NOISED" })).toBeNull();
    expect(brandFlag({ mint: new PublicKey(new Uint8Array(32).fill(9)), name: "Noised", symbol: "NOISED" })).toEqual({ reason: "impersonation" });
  });
});

/** Server rendering adds an image preload hint for every srcset; the site renders in the browser, where it has none. */
const ssr = (h: string): string => h.replace(/<link rel="preload" as="image"[^>]*\/>/g, "");

describe("the home page's official token bar", () => {
  const h = ssr(renderToStaticMarkup(createElement(OfficialTokenBar)));
  const anchors = [...h.matchAll(/<a [^>]*>.*?<\/a>/g)].map((m) => m[0]);

  it('says "$NOISED · Official token" and names its group', () => {
    expect(h).toMatch(/^<div class="ot" role="group" aria-labelledby="ot-name"><p class="ot-id" id="ot-name">/);
    expect(text(h)).toMatch(/^\$NOISED · Official token Contract address: 5oZbhx/);
  });

  it("shows the full address in the mono face", () => {
    expect(h).toContain(`<code class="ot-addr" translate="no">${MINT}</code>`);
    const css = read("src/components/officialToken.css");
    expect(css).toMatch(/\.ot-addr \{[^}]*var\(--font-mono/);
  });

  it("links Buy (Jupiter), Chart (DEX Screener) and Explorer (Solscan), in that order", () => {
    expect(anchors.map((a) => /href="([^"]*)"/.exec(a)?.[1])).toEqual([BUY, CHART, EXPLORER]);
    expect(OFFICIAL_LINKS.map((l) => l.label)).toEqual(["Buy", "Chart", "Explorer"]);
    expect(anchors.map(text)).toEqual([
      "Buy ($NOISED on Jupiter, opens in a new tab)",
      "Chart (on DEX Screener, opens in a new tab)",
      "Explorer (Solscan, opens in a new tab)",
    ]);
  });

  it("opens each link in a new tab, without an opener or a referrer", () => {
    expect(anchors).toHaveLength(3);
    for (const a of anchors) {
      expect(a).toContain('target="_blank"');
      expect(a).toContain('rel="noopener noreferrer"');
    }
  });

  it("has a Copy button with an accessible name and a polite status", () => {
    expect(h).toContain('<button type="button" class="ot-copy" data-state="idle" aria-label="Copy the $NOISED address">');
    expect(text(h)).toContain("Copy");
    expect(h).toContain('<p class="ot-hint" role="status" aria-live="polite">');
    // The icons are decorative.
    expect(h.match(/<svg [^>]*aria-hidden="true"/g)?.length).toBe(5);
  });

  it("loads nothing from elsewhere: the mark is the site's own file, one per theme", () => {
    const imgs = [...h.matchAll(/<img [^>]*>/g)].map((m) => m[0]);
    expect(imgs).toHaveLength(2);
    for (const img of imgs) {
      expect(img).toMatch(/src="brand\/noised-mark-(white-)?nav-26\.png"/);
      expect(img).toContain('alt=""');
    }
    expect(h).not.toMatch(/(src|srcset|srcSet)="[^"]*https?:/i);
    expect(h).not.toMatch(/<(script|iframe|link|style)\b/);
  });

  it("makes no price or market claims, and never calls it quantum-signed", () => {
    const words = text(h).toLowerCase();
    for (const w of ["price", "market cap", "mcap", "profit", "moon", "guarant", "quantum", "qsl", "verified"]) expect(words).not.toContain(w);
    const src = read("src/components/OfficialToken.tsx").replace(/\/\*\*[\s\S]*?\*\//g, "");
    expect(src).not.toMatch(/quantum|QSL/i);
  });

  it("has focus rings, a light theme and a phone layout", () => {
    const css = read("src/components/officialToken.css");
    expect(css).toMatch(/\.ot-copy:focus-visible,\s*\.ot-link:focus-visible \{\s*outline: 2px solid/);
    expect(css).toMatch(/:root\[data-theme="light"\] \.ot \{/);
    expect(css).toMatch(/@media \(max-width: 640px\) \{[^@]*\.ot-links \{\s*display: grid;\s*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
  });

  it("sits above the hero's headline", () => {
    const hero = read("src/components/landing/Hero.tsx");
    expect(hero).toMatch(/<div className="hx-copy" ref=\{copy\}>\s*<OfficialTokenBar ref=\{token\} \/>\s*<h1 id="hx-title"/);
  });

  it("the warning's compact version has the same address, copy button and links", () => {
    const c = ssr(renderToStaticMarkup(createElement(OfficialTokenActions, { compact: true })));
    expect(c).toMatch(/^<div class="ot-actions" data-compact="">/);
    expect(c).toContain(`>${MINT}</code>`);
    expect(c).toContain('class="ot-copy"');
    expect([...c.matchAll(/href="([^"]*)" target="_blank" rel="noopener noreferrer"/g)].map((m) => m[1])).toEqual([BUY, CHART, EXPLORER]);
  });
});

describe("the Copy button", () => {
  it("copies the full mint", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText }, userAgent: "test" });
    const select = vi.fn();
    expect(await copyOfficialMint(select)).toBe("copied");
    expect(writeText).toHaveBeenCalledWith(MINT);
    expect(select).not.toHaveBeenCalled();
  });

  it("falls back to the copy command when the clipboard refuses", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: async () => Promise.reject(new Error("denied")) }, userAgent: "test" });
    const field = { value: "", style: { setProperty: vi.fn() }, setAttribute: vi.fn(), select: vi.fn(), remove: vi.fn() };
    const execCommand = vi.fn(() => true);
    vi.stubGlobal("document", { createElement: () => field, body: { append: vi.fn() }, execCommand });
    expect(await copyOfficialMint(vi.fn())).toBe("copied");
    expect(field.value).toBe(MINT);
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(field.remove).toHaveBeenCalled();
  });

  it("selects the address for the visitor when nothing can copy", async () => {
    vi.stubGlobal("navigator", { userAgent: "test" });
    vi.stubGlobal("document", { createElement: () => ({ style: { setProperty: () => undefined }, setAttribute: () => undefined, select: () => undefined, remove: () => undefined }), body: { append: () => undefined }, execCommand: () => false });
    const select = vi.fn();
    expect(await copyOfficialMint(select)).toBe("manual");
    expect(select).toHaveBeenCalledOnce();
  });

  it("is what the button runs", () => {
    const src = read("src/components/OfficialToken.tsx");
    expect(src).toMatch(/className="ot-copy"[\s\S]*?onClick=\{\(\) => void copy\(\)\}/);
    expect(src).toMatch(/const next = await copyOfficialMint\(\(\) => selectContents\(code\.current\)\);/);
  });
});

describe("the footer", () => {
  it("links $NOISED to Jupiter, in a new tab", () => {
    const layout = read("src/app/Layout.tsx");
    expect(layout).toMatch(/<a href=\{OFFICIAL_NOISED\.links\.buy\} target="_blank" rel="noopener noreferrer" data-link="official-token">\s*\{OFFICIAL_NOISED\.label\}/);
  });
});

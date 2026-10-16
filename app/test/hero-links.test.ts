/**
 * The home hero's row of links (the SDK and the MCP server on npm, GitHub, the whitepaper PDF) and Noised on X in the
 * navbar, the mobile menu and the footer. Every link to another site opens in a new tab without an opener or a
 * referrer; the marks are inline SVG (the CSP allows nothing from elsewhere).
 */
import { existsSync, readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { HERO_LINKS, MCP_NPM_URL, REPO_URL, SDK_NPM_URL, WHITEPAPER_PDF, X_HANDLE, X_URL } from "../src/app/opensource";
import { DocMark, GitHubMark, NpmMark, XMark } from "../src/components/brandMarks";
import { HeroLinks } from "../src/components/landing/HeroLinks";

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const text = (h: string): string => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("hero links", () => {
  const h = renderToStaticMarkup(createElement(HeroLinks));
  const anchors = [...h.matchAll(/<a [^>]*>.*?<\/a>/g)].map((m) => m[0]);

  it("links the SDK, the MCP server, GitHub and the whitepaper, in that order", () => {
    expect(SDK_NPM_URL).toBe("https://www.npmjs.com/package/@noisedlabs/sdk");
    expect(MCP_NPM_URL).toBe("https://www.npmjs.com/package/@noisedlabs/mcp");
    expect(REPO_URL).toBe("https://github.com/NoisedLabs/noised");
    expect(anchors.map((a) => /href="([^"]*)"/.exec(a)?.[1])).toEqual([SDK_NPM_URL, MCP_NPM_URL, REPO_URL, "noised-whitepaper.pdf"]);
    expect(HERO_LINKS.map((l) => l.label)).toEqual(["SDK", "MCP server", "GitHub", "Whitepaper"]);
    expect(h).toMatch(/^<ul class="hx-links" aria-label="[^"]+">/);
  });

  it("opens each in a new tab, without an opener or a referrer", () => {
    expect(anchors).toHaveLength(4);
    for (const a of anchors) {
      expect(a).toContain('target="_blank"');
      expect(a).toContain('rel="noopener noreferrer"');
    }
  });

  it("names each link by its label, then where it goes", () => {
    expect(anchors.map(text)).toEqual([
      "SDK (on npm, opens in a new tab)",
      "MCP server (on npm, opens in a new tab)",
      "GitHub (source code, opens in a new tab)",
      "Whitepaper (PDF, opens in a new tab)",
    ]);
    // The marks are decorative: the text names the link.
    expect(h.match(/<svg [^>]*aria-hidden="true"/g)).toHaveLength(4);
  });

  it("draws the marks inline and loads nothing from elsewhere", () => {
    expect(h).not.toMatch(/<(img|script|iframe|link|style|image|use)\b/);
    expect(h).not.toMatch(/\s(src|xlink:href)="/);
    for (const Mark of [NpmMark, GitHubMark, XMark, DocMark]) {
      const svg = renderToStaticMarkup(createElement(Mark, { className: "m" }));
      expect(svg).toMatch(/^<svg viewBox="0 0 24 24" fill="currentColor" class="m" aria-hidden="true" focusable="false"><path [^>]*d="M[^"]+"><\/path><\/svg>$/);
    }
  });

  it("points at the whitepaper PDF the site ships (relative, so it works from any gateway path)", () => {
    expect(WHITEPAPER_PDF).toBe("noised-whitepaper.pdf");
    expect(existsSync(new URL(`../public/${WHITEPAPER_PDF}`, import.meta.url))).toBe(true);
    expect(read(`public/${WHITEPAPER_PDF}`).slice(0, 5)).toBe("%PDF-");
  });

  it("sits right under the verify field, with a visible focus ring, two per row on phones", () => {
    const hero = read("src/components/landing/Hero.tsx");
    expect(hero).toMatch(/<VerifyField ref=\{verify\} \/>\s*<HeroLinks ref=\{links\} \/>\s*<\/div>/);
    const css = read("src/fx/wall/hero.css");
    expect(css).toMatch(/\.hx-link:focus-visible \{\s*outline: 2px solid/);
    expect(css).toMatch(/@media \(max-width: 640px\) \{[^@]*\.hx-links \{\s*display: grid;\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  });
});

describe("Noised on X", () => {
  const layout = read("src/app/Layout.tsx");

  it("is x.com/noiseddotfun", () => {
    expect(X_URL).toBe("https://x.com/noiseddotfun");
    expect(X_HANDLE).toBe("@noiseddotfun");
  });

  it("has an icon button in the navbar, next to the sound and theme switches", () => {
    expect(layout).toMatch(
      /<a className="phx-icon-btn phx-nav-pref phx-x-btn" href=\{X_URL\} target="_blank" rel="noopener noreferrer" aria-label="Noised on X"[^>]*>\s*<XMark \/>\s*<\/a>/,
    );
    expect(layout).toMatch(/<XButton \/>\s*<SoundButton \/>\s*<ThemeButton \/>/);
  });

  it("is in the mobile menu and the footer, next to GitHub", () => {
    expect(layout).toMatch(/<a className="phx-sheet-x" href=\{X_URL\} target="_blank" rel="noopener noreferrer"/);
    expect(layout).toMatch(
      /<a href=\{REPO_URL\} target="_blank" rel="noopener noreferrer">\s*GitHub[\s\S]*?<\/li>\s*<li>\s*<a href=\{X_URL\} target="_blank" rel="noopener noreferrer">\s*X<span className="sr-only">/,
    );
  });
});

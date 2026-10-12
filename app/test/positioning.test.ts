/**
 * Positioning (LAYER_V1 §B.1): Noised is "the quantum security layer for Solana" with the products Launch, Vault,
 * Shield and Verify, in the navigation, the home hero, the footer, every page title and the page's meta and OG text;
 * and none of it makes a claim the QSL-1 standard forbids (Appendix A.3: no "quantum-proof").
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { HERO_SUB, HERO_TITLE, NAV, SITE_TITLE, TAGLINE } from "../src/app/brand";
import { ownTitle, pageTitle } from "../src/app/titles";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const meta = (attr: "name" | "property", key: string): string | null => new RegExp(`<meta ${attr}="${key}" content="([^"]*)"`).exec(html)?.[1] ?? null;

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
    expect(meta("name", "twitter:card")).toBe("summary");
  });

  it("never calls a token or a launch quantum-proof", () => {
    for (const text of [html, HERO_SUB, TAGLINE, HERO_TITLE.join(""), ...NAV.map((n) => n.hint)]) expect(text).not.toMatch(/quantum[- ‑]?proof|quantum[- ‑]safe token/i);
  });
});

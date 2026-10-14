/**
 * The home page before the first launch (mainnet until launches open): the launches section is one compact band, not
 * an empty board, saying launches open soon and pointing to what already works; once launches are open it invites
 * the first one. The hero's numbers say where Noised stands instead of three zeros. Plain words only.
 */
import { readFileSync } from "node:fs";

import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { LAUNCHES_SOON } from "../src/app/brand";
import type { AsyncState } from "../src/app/hooks";
import { VERIFIED_PROGRAMS } from "../src/app/opensource";
import { StartStats } from "../src/components/landing/HeroStats";
import { LaunchesEmpty, LiveLaunches } from "../src/components/landing/LiveLaunches";
import type { LaunchAccount } from "../src/lib/noised";

const html = (node: ReactNode): string => renderToStaticMarkup(createElement(MemoryRouter, null, node));
const text = (h: string): string =>
  h
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
const JARGON = /protocol|initiali[sz]e|account|RPC|PDA|genesis|lamport|program/i;

const list = (data: LaunchAccount[] | undefined): AsyncState<LaunchAccount[]> => ({ data, error: null, loading: data === undefined, reload: () => undefined });

describe("home: no launches yet", () => {
  it("says launches open soon in one band, with Vault and Verify, and no board", () => {
    const h = html(createElement(LaunchesEmpty, { state: "soon" }));
    const t = text(h);
    expect(t).toContain(`${LAUNCHES_SOON.title}.`);
    expect(t).toContain(LAUNCHES_SOON.meanwhile);
    expect(h).toContain('href="/vault"');
    expect(h).toContain('href="/verify"');
    // The band's title names the section.
    expect(h).toMatch(/<h2 id="launches-title"[^>]*>Launches open soon\.<\/h2>/);
    expect(h).not.toContain('href="/create"');
    expect(t).not.toMatch(JARGON);
    // Its dots are decoration only.
    expect(h).toMatch(/class="hm-soon-art" aria-hidden="true"/);
  });

  it("reads \"open soon\" while it is still being checked, and invites the first launch once launches are open", () => {
    for (const state of ["checking", "unknown"] as const) expect(text(html(createElement(LaunchesEmpty, { state })))).toContain(LAUNCHES_SOON.title);
    const open = html(createElement(LaunchesEmpty, { state: "open" }));
    expect(text(open)).toContain("No launches yet.");
    expect(text(open)).toContain("The first one could be yours.");
    expect(open).toContain('href="/create"');
    expect(text(open)).not.toContain(LAUNCHES_SOON.title);
  });

  it("the launches section shows the band, not an empty grid, once the list is in and empty", () => {
    const h = html(createElement(LiveLaunches, { launches: list([]), rows: [] }));
    expect(h).toContain('id="launches"');
    expect(h).toContain('aria-labelledby="launches-title"');
    expect(h).toContain("hm-soon");
    expect(h).not.toContain("hm-lc-grid");
    expect(h).not.toContain("View all");
    // Exactly one element names the section.
    expect(h.match(/id="launches-title"/g)?.length).toBe(1);
  });

  it("while the list loads, the section keeps its placeholder cards (no band yet)", () => {
    const h = html(createElement(LiveLaunches, { launches: list(undefined), rows: [] }));
    expect(h).toContain("hm-lc-grid");
    expect(h).toContain('aria-busy="true"');
    expect(h).not.toContain("hm-soon");
  });

  it("the hero tiles say where Noised stands, not three zeros", () => {
    const n = VERIFIED_PROGRAMS.length;
    expect(n).toBe(5);
    const soon = text(html(createElement(StartStats, { state: "soon" })));
    expect(soon).toContain("Soon");
    expect(soon).toContain("Opening on Solana shortly");
    expect(soon).toContain("Vault & Shield");
    expect(soon).toContain("Live");
    expect(soon).toContain("Verified builds");
    expect(soon).toContain(`${n} of ${n}`);
    expect(soon).toContain("Same code as on GitHub");
    expect(soon).not.toMatch(/\b0\.0\b|0 \/ 0/);
    expect(soon).not.toMatch(JARGON);
    const open = text(html(createElement(StartStats, { state: "open" })));
    expect(open).toContain("The first one could be yours");
    expect(open).not.toContain("Soon");
  });

  it("the hero switches to those tiles only on mainnet, only with no launch, and keeps the live numbers otherwise", () => {
    const src = readFileSync(new URL("../src/components/landing/HeroStats.tsx", import.meta.url), "utf8");
    expect(src).toContain('const ON_MAINNET = __NOISED_CLUSTER__ === "mainnet";');
    expect(src).toContain("if (ON_MAINNET && loaded && !error && summary.total === 0) return <StartStats state={launchesState} />;");
  });
});

/**
 * "Build with Noised" on the home page: the SDK, the MCP server for AI agents, the Rust crates, the source code and
 * the docs, each with one plain line, the command to paste (a copy button that falls back gracefully) and where it
 * lives; then the five mainnet programs, each a verified build with its Explorer page, and one honest line about the
 * upgrade keys. External links open in a new tab without an opener or a referrer; nothing is loaded from elsewhere.
 */
import { readFileSync } from "node:fs";

import { PROGRAM_IDS } from "@noisedlabs/sdk";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEV_TOOLS, REPO_URL, VERIFIED_PROGRAMS, mainnetExplorerUrl, shortProgramId, verifiedBuildUrl } from "../src/app/opensource";
import { BuildWithNoised, copyText } from "../src/components/landing/BuildWithNoised";

const html = (node: ReactNode): string => renderToStaticMarkup(createElement(MemoryRouter, null, node));
const text = (h: string): string =>
  h
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

afterEach(() => vi.unstubAllGlobals());

describe("Build with Noised", () => {
  const h = html(createElement(BuildWithNoised));
  const t = text(h);

  it("lists the SDK, the MCP server, the crates, the source and the docs, each with its command and link", () => {
    expect(h).toMatch(/<h2 id="build-title"/);
    expect(t).toContain("Build with Noised");
    // The commands as they are copied (on screen they may wrap after a "/").
    const commands = [...h.matchAll(/<code [^>]*>(.*?)<\/code>/g)].map((m) => (m[1] ?? "").replace(/<[^>]+>/g, ""));
    expect(commands).toEqual(["npm i @noisedlabs/sdk", "npx -y @noisedlabs/mcp", "cargo add noised-lmots", `git clone ${REPO_URL}`]);
    expect(DEV_TOOLS.map((d) => d.command)).toEqual(commands);
    expect(h).toContain("https://github.com/<wbr/>");
    for (const href of [
      "https://www.npmjs.com/package/@noisedlabs/sdk",
      "https://www.npmjs.com/package/@noisedlabs/mcp",
      "https://crates.io/crates/noised-lmots",
      "https://crates.io/crates/noised-rules",
      "https://github.com/NoisedLabs/noised",
    ])
      expect(h).toContain(`href="${href}"`);
    expect(h).toContain('href="/docs"');
    expect(t).toMatch(/never signs/i);
    expect(t).toContain("LangGraph");
    // One copy button per command.
    expect(h.match(/class="hm-cmd-copy"/g)?.length).toBe(DEV_TOOLS.length);
  });

  it("installs the packages this repository publishes, under their real names", () => {
    expect(JSON.parse(read("../sdk/package.json")).name).toBe("@noisedlabs/sdk");
    const mcp = JSON.parse(read("../packages/noised-mcp/package.json"));
    expect(mcp.name).toBe("@noisedlabs/mcp");
    // npx runs the package's one command.
    expect(Object.keys(mcp.bin)).toEqual(["noised-mcp"]);
    expect(read("../crates/noised-lmots/Cargo.toml")).toMatch(/^name = "noised-lmots"$/m);
    expect(read("../crates/noised-rules/Cargo.toml")).toMatch(/^name = "noised-rules"$/m);
    expect(read("../LICENSE")).toContain("Apache License");
  });

  it("opens every external link in a new tab, without an opener or a referrer, and loads nothing from elsewhere", () => {
    const external = [...h.matchAll(/<a [^>]*href="https?:[^"]*"[^>]*>/g)].map((m) => m[0]);
    expect(external.length).toBe(5 + VERIFIED_PROGRAMS.length * 2);
    for (const a of external) {
      expect(a).toContain('target="_blank"');
      expect(a).toContain('rel="noopener noreferrer"');
    }
    expect(h).not.toMatch(/<(img|script|iframe|link|style)\b/);
    expect(h).not.toMatch(/src="/);
  });

  it("shows the five mainnet programs, each a verified build with its Explorer page, and says they are not locked yet", () => {
    expect(VERIFIED_PROGRAMS.map((p) => p.name)).toEqual(["Launchpad", "Autopilot", "Shield", "Vault", "Hook"]);
    const sdk: Record<string, string> = {
      Launchpad: PROGRAM_IDS.launchpad.toBase58(),
      Autopilot: PROGRAM_IDS.autopilot.toBase58(),
      Shield: PROGRAM_IDS.shield.toBase58(),
      Vault: PROGRAM_IDS.vault.toBase58(),
      Hook: PROGRAM_IDS.hook.toBase58(),
    };
    for (const p of VERIFIED_PROGRAMS) {
      expect(p.id, p.name).toBe(sdk[p.name]);
      expect(h).toContain(`href="https://explorer.solana.com/address/${p.id}"`);
      expect(h).toContain(`href="https://verify.osec.io/status/${p.id}"`);
      expect(t).toContain(shortProgramId(p.id));
    }
    expect(mainnetExplorerUrl("x")).toBe("https://explorer.solana.com/address/x");
    expect(verifiedBuildUrl("x")).toBe("https://verify.osec.io/status/x");
    expect(shortProgramId("CfbRmsFpevhiXkbYK48orBDugdKznnezDiVekjAAbNgc")).toBe("CfbRms…bNgc");
    expect(t.match(/Verified build\b/g)?.length).toBe(VERIFIED_PROGRAMS.length);
    expect(t).toContain("Verified on-chain");
    expect(t).toContain("Not locked yet: the upgrade keys are removed after setup.");
  });

  it("comes after Keep it safe and before the closing call to action", () => {
    const home = read("src/pages/Home.tsx");
    const order = ["<KeepSafe />", "<BuildWithNoised />", "<CtaBand />"].map((tag) => home.indexOf(tag));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("the footer links the source code", () => {
    const layout = read("src/app/Layout.tsx");
    expect(layout).toMatch(/<a href=\{REPO_URL\} target="_blank" rel="noopener noreferrer">\s*GitHub/);
  });
});

describe("copy a command", () => {
  it("uses the clipboard when it can", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText }, userAgent: "test" });
    expect(await copyText("npm i @noisedlabs/sdk")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("npm i @noisedlabs/sdk");
  });

  it("falls back to the copy command on a hidden field, and removes the field", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: async () => Promise.reject(new Error("denied")) }, userAgent: "test" });
    const field = { value: "", style: { setProperty: vi.fn() }, setAttribute: vi.fn(), select: vi.fn(), remove: vi.fn() };
    const append = vi.fn();
    const execCommand = vi.fn(() => true);
    vi.stubGlobal("document", { createElement: () => field, body: { append }, execCommand });
    expect(await copyText("cargo add noised-lmots")).toBe(true);
    expect(field.value).toBe("cargo add noised-lmots");
    expect(append).toHaveBeenCalledWith(field);
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(field.remove).toHaveBeenCalled();
  });

  it("reports failure when neither works (the command is then selected for the visitor to copy)", async () => {
    vi.stubGlobal("navigator", { userAgent: "test" });
    vi.stubGlobal("document", { createElement: () => ({ style: { setProperty: () => undefined }, setAttribute: () => undefined, select: () => undefined, remove: () => undefined }), body: { append: () => undefined }, execCommand: () => false });
    expect(await copyText("x")).toBe(false);
    vi.stubGlobal("document", { createElement: () => ({ style: { setProperty: () => undefined }, setAttribute: () => undefined, select: () => undefined, remove: () => undefined }), body: { append: () => { throw new Error("no body"); } }, execCommand: () => true });
    expect(await copyText("x")).toBe(false);
  });
});

/**
 * Before the launchpad's one-time setup (its `Protocol` account; on mainnet until `initialize_protocol` runs), every
 * `create_launch` fails: the Launch page shows "Launches open soon" instead of its forms, the launch buttons say so,
 * and a launch started anyway gets plain words. Plain English only: no protocol, account or RPC names on screen.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { LAUNCHES_SOON } from "../src/app/brand";
import { launchCtaLabel } from "../src/app/network";
import { plainError } from "../src/lib/launchFlow";
import { LaunchGate } from "../src/pages/create/LaunchesSoon";

const html = (node: ReactNode): string => renderToStaticMarkup(createElement(MemoryRouter, null, node));
const text = (h: string): string =>
  h
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
const JARGON = /protocol|initiali[sz]e|account|RPC|PDA|genesis|lamport/i;

describe("Launches open soon", () => {
  it("says so in plain words and points to what already works", () => {
    const h = html(createElement(LaunchGate, { state: "soon", onRetry: () => undefined }));
    const t = text(h);
    expect(t).toContain("Launches open soon");
    expect(t).toContain(LAUNCHES_SOON.text);
    expect(t).toContain("Your vault, the Shield and Verify already work.");
    expect(h).toContain('href="/vault"');
    expect(h).toContain('href="/verify"');
    expect(t).not.toMatch(JARGON);
    // No form, no button that could start a launch.
    expect(h).not.toMatch(/<form|<input|Launch a token|Sign/);
  });

  it("waits quietly while it checks, and offers a retry when Solana cannot be reached", () => {
    const checking = text(html(createElement(LaunchGate, { state: "checking", onRetry: () => undefined })));
    expect(checking).toContain("One moment");
    expect(checking).not.toMatch(JARGON);
    const unknown = text(html(createElement(LaunchGate, { state: "unknown", onRetry: () => undefined })));
    expect(unknown).toContain("Can't reach Solana right now");
    expect(unknown).toContain("Try again");
    expect(unknown).toContain("Nothing was signed or sent.");
    expect(unknown).not.toMatch(JARGON);
  });

  it("the launch buttons read \"Launches open soon\" only while launches are not open", () => {
    expect(launchCtaLabel("soon")).toBe("Launches open soon");
    expect(launchCtaLabel("open")).toBe("Launch a token");
    // Checking or unreachable: the button keeps its name; the Launch page itself waits or offers a retry.
    expect(launchCtaLabel("checking")).toBe("Launch a token");
    expect(launchCtaLabel("unknown")).toBe("Launch a token");
  });

  it("a launch started just before gets plain words from the SDK's refusal (nothing was signed)", () => {
    expect(plainError(new Error("the launchpad protocol account is not initialized"))).toMatch(/^Launches open soon on this network: .*Nothing was signed\./);
  });

  it("the Launch page renders its forms only when launches are open", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/pages/create/CreatePage.tsx", import.meta.url)), "utf8");
    const page = src.slice(src.indexOf("export function CreatePage"), src.indexOf("function CustomLaunch"));
    const gate = page.indexOf('launches === "open" ? (');
    expect(gate).toBeGreaterThan(0);
    const otherwise = page.indexOf("<LaunchGate", gate);
    // ModeChooser, QuickLaunch and CustomLaunch appear only between the "open" check and the gate.
    for (const form of ["<ModeChooser", "<QuickLaunch", "<CustomLaunch"]) {
      const at = page.indexOf(form);
      expect(at, form).toBeGreaterThan(gate);
      expect(at, form).toBeLessThan(otherwise);
      expect(page.indexOf(form, at + 1), form).toBe(-1);
    }
  });
});

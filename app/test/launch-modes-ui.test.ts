/**
 * The launch's first choice and the AI side, as rendered (static markup) and as documented:
 *   - the mode chooser: Quick launch and Custom launch as a radio group, each promising the quantum key, locked
 *     liquidity and sells never blocked;
 *   - "Run it with an AI agent": the AI-operated buyback template, what an operator can and can never do (the chain
 *     enforces it), the Claude Code setup line and the guide link;
 *   - the docs page "AI agents (MCP + LangGraph)": in the Guides, with every MCP tool, "never signs", the setup line
 *     and the LangGraph operator loop.
 */
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { DOC_SECTIONS, findDocPage } from "../src/content/docs/nav";
import { blocksText } from "../src/content/docs/markdown";
import { AI_CAN, AI_CANNOT, AI_DOCS_PATH, AiAgentPanel, MCP_SETUP_LINE } from "../src/pages/autopilot/AiAgentPanel";
import { ModeChooser, PROMISES } from "../src/pages/create/ModeChooser";

const html = (node: ReactNode): string => renderToStaticMarkup(createElement(MemoryRouter, null, node));
const text = (h: string): string =>
  h
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");

describe("the mode chooser", () => {
  it("offers Quick launch and Custom launch as one radio group, each with the same three promises", () => {
    for (const mode of ["quick", "custom"] as const) {
      const h = html(createElement(ModeChooser, { mode, onPick: () => undefined }));
      expect(h).toMatch(/role="radiogroup"/);
      const radios = [...h.matchAll(/role="radio" aria-checked="(true|false)"/g)].map((m) => m[1]);
      expect(radios).toEqual(mode === "quick" ? ["true", "false"] : ["false", "true"]);
      const t = text(h);
      expect(t).toContain("Quick launch");
      expect(t).toContain("Custom launch");
      for (const p of PROMISES) expect(t.split(p).length - 1, p).toBe(2);
    }
    expect(PROMISES).toEqual(["Signed with your quantum key", "Checked on-chain by anyone", "No admin key"]);
    // The promises are about quantum security, not a liquidity lock or "no rug" (every launchpad says those).
    for (const p of PROMISES) expect(p).not.toMatch(/liquidity|locked|rug/i);
  });
});

describe("Run it with an AI agent", () => {
  it("shows the template, what an operator can and can never do, the setup line and the guide", () => {
    const t = text(html(createElement(AiAgentPanel, { onUseTemplate: () => undefined })));
    expect(t).toContain("AI-operated buyback");
    expect(t).toContain("Use this template");
    for (const c of [...AI_CAN, ...AI_CANNOT]) expect(t).toContain(c);
    expect(t).toContain("The chain enforces these limits, not the agent.");
    expect(t).toContain("It never signs");
    expect(t).toContain(MCP_SETUP_LINE);
    expect(MCP_SETUP_LINE).toBe("claude mcp add noised -- node packages/noised-mcp/dist/index.js");
    expect(t).toContain("Read the guide: AI agents (MCP + LangGraph)");
    expect(html(createElement(AiAgentPanel, {}))).toContain(`href="${AI_DOCS_PATH}"`);
    // Without a template action (a frozen autopilot), no button offers it.
    expect(text(html(createElement(AiAgentPanel, {})))).not.toContain("Use this template");
  });
});

describe("docs: AI agents (MCP + LangGraph)", () => {
  it("is a guide with every MCP tool, never signing, the setup line and the operator loop", () => {
    const page = findDocPage(AI_DOCS_PATH.replace(/^\/docs\//, ""));
    if (!page) throw new Error("no AI agents page");
    expect(page.title).toBe("AI agents (MCP + LangGraph)");
    expect(DOC_SECTIONS.find((s) => s.id === "guides")?.pages.map((p) => p.slug)).toContain("guides/ai-agents");
    const body = blocksText(page.blocks);
    for (const tool of [
      "list_launches",
      "get_launch",
      "verify_token",
      "get_rules",
      "get_autopilot",
      "get_due_nodes",
      "simulate_transfer",
      "simulate_autopilot",
      "build_update_price_tx",
      "build_run_tx",
      "build_publish_graph_tx",
    ]) {
      expect(body, tool).toContain(tool);
    }
    expect(body).toContain("never signs and never holds a key");
    expect(body).toContain("the chain enforces the limits, not the agent");
    const code = page.blocks.flatMap((b) => (b.t === "code" ? [b.code] : [])).join("\n");
    expect(code).toContain(MCP_SETUP_LINE);
    expect(code).toMatch(/StateGraph/);
    expect(code).toMatch(/build_run_tx/);
  });
});

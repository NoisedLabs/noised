/**
 * "Run it with an AI agent" (owner's request, 2026-10-11: make the AI side visible): the AI-operated buyback
 * template, what an AI operator can and cannot do (the chain enforces it, not the agent), and how to connect one
 * (the Noised MCP server: read, simulate and build unsigned transactions; it never signs) with a link to the docs.
 * Shown on a token's Autopilot page and in the Custom launch's Autopilot step. Plain words; honest about who enforces
 * what.
 */
import type { ReactNode } from "react";
import { Link } from "react-router";

import { Button, CopyButton } from "../../components/ui";
import { DotGlyph } from "../inner/glyphs";
import { Chip, Panel } from "../inner/kit";

/** The Claude Code line that connects the Noised MCP server (packages/noised-mcp). */
export const MCP_SETUP_LINE = "claude mcp add noised -- node packages/noised-mcp/dist/index.js";

export const AI_DOCS_PATH = "/docs/guides/ai-agents";

export const AI_CAN: readonly string[] = [
  "Decide when the AI-operated buyback runs",
  "Pick how much, up to your per-buyback and per-day limits",
  "Read the token, simulate, and prepare transactions with the Noised tools",
];

export const AI_CANNOT: readonly string[] = [
  "Send treasury funds anywhere else, or sell the token",
  "Pay more than your price limit above the recent low",
  "Change the steps, touch the locked liquidity, or mint",
  "Keep going after your quantum key removes it",
];

export function AiAgentPanel({ onUseTemplate, templateOn = false, className = "" }: { onUseTemplate?: (() => void) | undefined; templateOn?: boolean; className?: string }): ReactNode {
  return (
    <Panel
      title="Run it with an AI agent"
      glyph={<DotGlyph name="agent" />}
      status={<Chip tone="violet">Optional</Chip>}
      description="Let an AI agent you trust decide when to buy back and burn, and how much. The chain sets the limits; the agent only works inside them."
      className={`ai-panel ${className}`}
    >
      <div className="ai-tpl px-corners">
        <div className="ai-tpl-text">
          <p className="ai-tpl-title">AI-operated buyback</p>
          <p className="ai-tpl-line">
            Your agent&apos;s key can run one buyback step: it picks the moment and the amount, never more than your limits per buyback and per day, and never above your
            price limit. Everything it buys is burned in the same step.
          </p>
        </div>
        {onUseTemplate !== undefined ? (
          <Button size="sm" variant={templateOn ? "ghost" : "primary"} disabled={templateOn} onClick={onUseTemplate}>
            {templateOn ? "Switched on below" : "Use this template"}
          </Button>
        ) : null}
      </div>
      <div className="ai-cols">
        <div className="ai-col" data-kind="can">
          <p className="pg-label">An AI operator can</p>
          <ul>
            {AI_CAN.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
        <div className="ai-col" data-kind="cannot">
          <p className="pg-label">It can never</p>
          <ul>
            {AI_CANNOT.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      </div>
      <p className="ai-how">
        <strong>The chain enforces these limits, not the agent.</strong> The Noised MCP server gives an agent (Claude, or a LangGraph workflow) tools to read tokens,
        simulate, and build unsigned transactions. It never signs: your agent&apos;s own key does, and the program refuses anything outside the limits you signed.
      </p>
      <div className="ai-setup">
        <code className="ai-cmd">{MCP_SETUP_LINE}</code>
        <CopyButton value={MCP_SETUP_LINE} label="Copy the setup line" />
      </div>
      <p className="ai-more">
        <Link className="link" to={AI_DOCS_PATH}>
          Read the guide: AI agents (MCP + LangGraph)
        </Link>
      </p>
    </Panel>
  );
}

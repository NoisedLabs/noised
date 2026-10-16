/**
 * Build with Noised: what developers install, one glass card each (the SDK, the MCP server for AI agents, the Rust
 * crates, the source code, the docs), every card with a one-line description, the command to paste (with a copy
 * button) and where it lives. Under them, the five programs on Solana mainnet, each a verified build with its
 * Explorer page, and one honest line: the upgrade keys are still there until setup ends.
 *
 * Links only: nothing here fetches anything (the CSP allows no third-party requests); external pages open in a new
 * tab. Over a very faint dot field; the cards resolve in from noise like every home section.
 */
import { ArrowRight, ArrowUpRight, BadgeCheck, BookOpen, Bot, Boxes, Braces, Check, Copy, GitBranch, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { Link } from "react-router";

import { DEV_TOOLS, VERIFIED_ON, VERIFIED_PROGRAMS, mainnetExplorerUrl, shortProgramId, verifiedBuildUrl, type DevTool } from "../../app/opensource";
import { useNoiseReveal } from "../../fx/noise";
import { sfx } from "../../fx/sfx";
import { copyText, manualCopyHint, selectContents } from "../../lib/clipboard";
import { SectionField, SectionHead, useReveal } from "./glass";

const ICONS: Record<DevTool["id"], LucideIcon> = { sdk: Braces, agents: Bot, rust: Boxes, source: GitBranch };

/** Re-exported for the tests (lib/clipboard.ts). */
export { copyText };

export function BuildWithNoised(): ReactNode {
  const [ref, shown] = useReveal<HTMLElement>();
  const grid = useRef<HTMLUListElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  useNoiseReveal(grid, { duration: 700 });
  useNoiseReveal(strip, { duration: 680, sweep: "right" });
  return (
    <section ref={ref} id="build" className="hm-section hm-dev" aria-labelledby="build-title" data-in={shown ? "" : undefined}>
      <SectionField fade="right" seed={31} />
      <SectionHead id="build-title" title="Build with" accent="Noised" lead="All open source. Use it in your own app or agent." align="center" />
      <ul ref={grid} className="hm-dev-grid" role="list">
        {DEV_TOOLS.map((tool) => (
          <ToolCard key={tool.id} tool={tool} />
        ))}
        <li className="glass hm-dev-card" data-kind="docs">
          <div className="hm-dev-top">
            <span className="hm-dev-icon" aria-hidden="true">
              <BookOpen />
            </span>
            <span className="hm-dev-label">Docs</span>
          </div>
          <h3 className="hm-card-title hm-dev-title">Guides and reference</h3>
          <p className="hm-card-text hm-dev-text">How every part works, with examples you can copy. Right here on this site.</p>
          <Link to="/docs" className="btn btn-secondary btn-noglyph hm-more hm-dev-docs">
            Read the docs
            <ArrowRight aria-hidden="true" />
          </Link>
        </li>
      </ul>
      <VerifiedPrograms ref={strip} />
    </section>
  );
}

function ToolCard({ tool }: { tool: DevTool }): ReactNode {
  const Icon = ICONS[tool.id];
  return (
    <li className="glass hm-dev-card" data-kind={tool.id}>
      <div className="hm-dev-top">
        <span className="hm-dev-icon" aria-hidden="true">
          <Icon />
        </span>
        <span className="hm-dev-label">{tool.label}</span>
      </div>
      <h3 className="hm-card-title hm-dev-title">{tool.title}</h3>
      <p className="hm-card-text hm-dev-text">{tool.text}</p>
      <CommandLine command={tool.command} />
      <div className="hm-dev-links">
        {tool.links.map((l) => (
          <ExternalLink key={l.href} href={l.href} className="hm-dev-link">
            {l.label}
          </ExternalLink>
        ))}
      </div>
    </li>
  );
}

/** A link to another site: a new tab, no opener, no referrer, and it says so to screen readers. */
function ExternalLink({ href, className, label, children }: { href: string; className: string; label?: string; children: ReactNode }): ReactNode {
  return (
    <a href={href} className={className} target="_blank" rel="noopener noreferrer" aria-label={label ? `${label} (opens in a new tab)` : undefined}>
      {children}
      <ArrowUpRight aria-hidden="true" />
      {label ? null : <span className="sr-only"> (opens in a new tab)</span>}
    </a>
  );
}

type CopyState = "idle" | "copied" | "manual";

/** A command to paste, with a copy button. If the browser refuses to copy, the command is selected instead. */
export function CommandLine({ command }: { command: string }): ReactNode {
  const code = useRef<HTMLElement>(null);
  const [state, setState] = useState<CopyState>("idle");
  useEffect(() => {
    if (state === "idle") return;
    const t = window.setTimeout(() => setState("idle"), state === "copied" ? 1800 : 5000);
    return () => window.clearTimeout(t);
  }, [state]);
  const copy = async (): Promise<void> => {
    if (await copyText(command)) {
      sfx.play("click");
      setState("copied");
      return;
    }
    selectContents(code.current);
    setState("manual");
  };
  return (
    <div className="hm-cmd-wrap">
      <div className="hm-cmd">
        <span className="hm-cmd-prompt" aria-hidden="true">
          $
        </span>
        <code ref={code} className="hm-cmd-text" tabIndex={0}>
          <Breakable text={command} />
        </code>
        <button type="button" className="hm-cmd-copy" data-state={state} onClick={() => void copy()} aria-label={state === "copied" ? `Copied: ${command}` : `Copy: ${command}`}>
          {state === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          <span className="hm-cmd-copy-label" aria-hidden="true">
            {state === "copied" ? "Copied" : "Copy"}
          </span>
        </button>
      </div>
      <p className="hm-cmd-hint" role="status" aria-live="polite">
        {state === "manual" ? <span className="hm-cmd-hint-text">{manualCopyHint()}</span> : state === "copied" ? <span className="sr-only">Copied to the clipboard.</span> : null}
      </p>
    </div>
  );
}

/** A command that may wrap on a narrow card: it breaks after each path "/" (not inside "//") before anywhere else. */
function Breakable({ text }: { text: string }): ReactNode {
  const parts = text.split(/(?<=[^/]\/)(?!\/)/);
  return parts.map((part, i) => (
    <span key={i}>
      {part}
      {i < parts.length - 1 ? <wbr /> : null}
    </span>
  ));
}

/** The five programs on Solana mainnet: each a verified build, with its Explorer page and OtterSec's record. */
function VerifiedPrograms({ ref }: { ref?: Ref<HTMLDivElement> }): ReactNode {
  return (
    <div ref={ref} className="glass hm-chain" role="group" aria-labelledby="chain-title">
      <div className="hm-chain-head">
        <span className="hm-dev-icon" aria-hidden="true">
          <BadgeCheck />
        </span>
        <div className="hm-chain-copy">
          <h3 id="chain-title" className="hm-card-title hm-chain-title">
            Verified on-chain
          </h3>
          <p className="hm-card-text hm-chain-text">
            The five programs on Solana run exactly the open source code: OtterSec rebuilt each one and checked it on {VERIFIED_ON}.
          </p>
        </div>
      </div>
      <ul className="hm-chain-list" role="list">
        {VERIFIED_PROGRAMS.map((p) => (
          <li key={p.id} className="hm-chain-item">
            <span className="hm-chain-name">{p.name}</span>
            <ExternalLink href={mainnetExplorerUrl(p.id)} className="hm-chain-id" label={`${p.name} program ${p.id} on Solana Explorer`}>
              <span title={p.id}>{shortProgramId(p.id)}</span>
            </ExternalLink>
            <ExternalLink href={verifiedBuildUrl(p.id)} className="hm-chain-ok" label={`${p.name}: verified build, OtterSec's record`}>
              <Check className="hm-chain-check" aria-hidden="true" />
              Verified build
            </ExternalLink>
          </li>
        ))}
      </ul>
      <p className="hm-chain-note">
        <i className="ld-dot" aria-hidden="true" />
        Not locked yet: the upgrade keys are removed after setup.
      </p>
    </div>
  );
}

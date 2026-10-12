/**
 * Paper furniture for the whitepaper: sections, numbered figures and tables with cross-references, numbered
 * equations, theorem-like blocks, citations and footnotes. Numbers come from the ordered registries below, so a
 * cross-reference renders the same number as its target wherever either appears.
 */
import { useRef, type ReactNode } from "react";

import { useNoiseReveal } from "../../fx/noise";

import { SectionGlyph } from "./figures/glyphs";
import { MB } from "./tex";

// ------------------------------------------------------------- registries ---

export const SECTIONS = [
  { id: "abstract", n: 1, title: "Abstract and contributions", short: "Abstract" },
  { id: "threats", n: 2, title: "Threat model", short: "Threat model" },
  { id: "architecture", n: 3, title: "System architecture", short: "Architecture" },
  { id: "hbs", n: 4, title: "Hash-based signatures", short: "Hash-based signatures" },
  { id: "identity", n: 5, title: "Post-quantum creator identity, attestation and on-chain metadata", short: "PQ identity, metadata" },
  { id: "batch", n: 6, title: "The fair-open batch", short: "Fair-open batch" },
  { id: "liveness", n: 7, title: "Contention and liveness", short: "Contention" },
  { id: "guard", n: 8, title: "Launch Guard and the transfer hook", short: "Launch Guard" },
  { id: "liquidity", n: 9, title: "Liquidity and fees", short: "Liquidity and fees" },
  { id: "vault", n: 10, title: "The PQ vault (v4)", short: "PQ vault" },
  { id: "privacy", n: 11, title: "Private balances", short: "Private balances" },
  { id: "evaluation", n: 12, title: "Security evaluation", short: "Security evaluation" },
  { id: "performance", n: 13, title: "Performance", short: "Performance" },
  { id: "limitations", n: 14, title: "Limitations and future work", short: "Limitations" },
  { id: "references", n: 15, title: "References", short: "References" },
] as const;

export type SectionId = (typeof SECTIONS)[number]["id"];

const FIGURES = [
  "fig-bits",
  "fig-arch",
  "fig-seq",
  "fig-chain",
  "fig-digits",
  "fig-steps",
  "fig-tree",
  "fig-forge",
  "fig-identity",
  "fig-fill",
  "fig-price",
  "fig-timeline",
  "fig-contention",
  "fig-hook",
  "fig-curve",
  "fig-fees",
  "fig-vault",
  "fig-audit",
  "fig-cu",
  "fig-bytes",
] as const;

const TABLES = [
  "tab-adversaries",
  "tab-pdas",
  "tab-params",
  "tab-identity",
  "tab-meta",
  "tab-guard",
  "tab-vault",
  "tab-shield",
  "tab-invariants",
  "tab-findings",
  "tab-reviews",
  "tab-tests",
  "tab-trust",
] as const;

export type FigId = (typeof FIGURES)[number];
export type TabId = (typeof TABLES)[number];

export const FIGURE_COUNT = FIGURES.length;
export const TABLE_COUNT = TABLES.length;

export function figNo(id: FigId): number {
  return FIGURES.indexOf(id) + 1;
}

export function tabNo(id: TabId): number {
  return TABLES.indexOf(id) + 1;
}

// --------------------------------------------------------------- headings ---

export function Section({ id, children }: { id: SectionId; children: ReactNode }): ReactNode {
  const s = SECTIONS.find((x) => x.id === id);
  return (
    <section id={id} className="wp-section" aria-labelledby={`${id}-h`} data-wp-section={id}>
      <h2 id={`${id}-h`} className="wp-h2">
        <SectionGlyph id={id} />
        <span className="wp-h2-n" aria-hidden="true">
          {String(s?.n ?? 0).padStart(2, "0")}
        </span>
        <span className="wp-h2-t">
          <span className="sr-only">{`${s?.n ?? ""}. `}</span>
          {s?.title}
        </span>
      </h2>
      {children}
    </section>
  );
}

export function H3({ id, n, children }: { id: string; n: string; children: ReactNode }): ReactNode {
  return (
    <h3 id={id} className="wp-h3">
      <span className="wp-h3-n">{n}</span> {children}
    </h3>
  );
}

// ---------------------------------------------------------------- figures ---

/** Figures and tables dissolve in, cell by cell, the first time they scroll into view (nothing under reduced motion). */
const REVEAL = { duration: 600, sweep: "down" as const, threshold: 0.08 };

export function Figure({
  id,
  title,
  children,
  caption,
  wide = false,
}: {
  id: FigId;
  title: string;
  children: ReactNode;
  caption?: ReactNode;
  wide?: boolean | undefined;
}): ReactNode {
  const ref = useRef<HTMLElement>(null);
  useNoiseReveal(ref, REVEAL);
  return (
    <figure ref={ref} id={id} className="wp-figure wp-panel px-corners px-frame" data-wide={wide ? "true" : "false"} aria-labelledby={`${id}-cap`}>
      <div className="wp-figure-body">{children}</div>
      <figcaption id={`${id}-cap`} className="wp-caption">
        <span className="wp-caption-label">{`Fig. ${figNo(id)}`}</span>
        <span className="wp-caption-title">{title}</span>
        {caption ? <span className="wp-caption-text"> {caption}</span> : null}
      </figcaption>
    </figure>
  );
}

export function Table({ id, title, children, caption }: { id: TabId; title: string; children: ReactNode; caption?: ReactNode }): ReactNode {
  const ref = useRef<HTMLElement>(null);
  useNoiseReveal(ref, REVEAL);
  return (
    <figure ref={ref} id={id} className="wp-table-fig wp-panel px-corners px-frame" aria-labelledby={`${id}-cap`}>
      <figcaption id={`${id}-cap`} className="wp-caption wp-caption-top">
        <span className="wp-caption-label">{`Table ${tabNo(id)}`}</span>
        <span className="wp-caption-title">{title}</span>
        {caption ? <span className="wp-caption-text"> {caption}</span> : null}
      </figcaption>
      <div className="wp-table-scroll" tabIndex={0} role="region" aria-label={`Table ${tabNo(id)}: ${title}`}>
        <table className="wp-table">{children}</table>
      </div>
    </figure>
  );
}

/** "Fig. 3" / "Table 2" link. */
export function XRef({ to, children }: { to: FigId | TabId; children?: ReactNode }): ReactNode {
  const label = to.startsWith("fig-") ? `Fig. ${figNo(to as FigId)}` : `Table ${tabNo(to as TabId)}`;
  return (
    <a className="wp-xref" href={`#${to}`} onClick={(e) => jump(e, to)}>
      {children ?? label}
    </a>
  );
}

/** "§6" link to a section (or a subsection id). */
export function SecRef({ to, children }: { to: string; children?: ReactNode }): ReactNode {
  const s = SECTIONS.find((x) => x.id === to);
  return (
    <a className="wp-xref" href={`#${to}`} onClick={(e) => jump(e, to)}>
      {children ?? `§${s?.n ?? "?"}`}
    </a>
  );
}

/** In-page jump that keeps the hash router's route (the URL fragment is the route, so no fragment navigation). */
export function jump(e: { preventDefault: () => void }, id: string): void {
  e.preventDefault();
  const el = document.getElementById(id);
  if (!el) return;
  const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const top = el.getBoundingClientRect().top + window.scrollY - 96;
  window.scrollTo({ top, behavior: reduce ? "auto" : "smooth" });
  if (el instanceof HTMLElement) {
    if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
    el.focus({ preventScroll: true });
  }
}

// -------------------------------------------------------------- equations ---

/** A numbered display equation: <Eq n="4.1">{"..."}</Eq>. */
export function Eq({ n, children, label }: { n: string; children: string; label?: string | undefined }): ReactNode {
  return (
    <div className="wp-eq" id={`eq-${n.replace(".", "-")}`}>
      <div className="wp-eq-math">
        <MB label={label}>{children}</MB>
      </div>
      <span className="wp-eq-n">{`(${n})`}</span>
    </div>
  );
}

export function EqRef({ n }: { n: string }): ReactNode {
  const id = `eq-${n.replace(".", "-")}`;
  return (
    <a className="wp-xref" href={`#${id}`} onClick={(e) => jump(e, id)}>
      {`(${n})`}
    </a>
  );
}

// ---------------------------------------------------------- theorem-likes ---

export function Thm({ kind, n, title, children }: { kind: "Definition" | "Lemma" | "Proposition" | "Theorem" | "Corollary" | "Claim" | "Assumption" | "Remark"; n: string; title?: string | undefined; children: ReactNode }): ReactNode {
  return (
    <div className="wp-thm" data-kind={kind.toLowerCase()} id={`${kind.toLowerCase()}-${n.replace(".", "-")}`}>
      <p className="wp-thm-head">
        <span className="wp-thm-kind">{`${kind} ${n}`}</span>
        {title ? <span className="wp-thm-title">{` (${title}).`}</span> : <span className="wp-thm-title">.</span>}
      </p>
      <div className="wp-thm-body">{children}</div>
    </div>
  );
}

export function Proof({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="wp-proof">
      <p className="wp-proof-head">Proof.</p>
      {children}
      <span className="wp-qed" aria-label="end of proof">
        ∎
      </span>
    </div>
  );
}

/** Highlighted aside ("Honest scope", "In practice", ...). */
export function Aside({ title, children, tone = "note" }: { title: string; children: ReactNode; tone?: "note" | "warn" }): ReactNode {
  return (
    <aside className="wp-aside wp-panel px-corners px-frame" data-tone={tone}>
      <p className="wp-aside-title">{title}</p>
      {children}
    </aside>
  );
}

/** Small "measured" / "model" / build tag next to a number ("final build": the final programs with on-chain metadata). */
export function Tag({ kind }: { kind: "measured" | "model" | "v2" | "final" | "docs" | "estimate" }): ReactNode {
  const text = { measured: "measured", model: "model", v2: "v2 build", final: "final build", docs: "docs", estimate: "estimate" }[kind];
  return <span className="wp-tag" data-kind={kind}>{text}</span>;
}

/** Inline code. */
export function C({ children }: { children: ReactNode }): ReactNode {
  return <code className="wp-code">{children}</code>;
}

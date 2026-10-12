/**
 * The full QSL-1 report (Appendix A.1: the badge opens it): the verdict in plain words, the two levels and where the
 * token stands, the creator's launch rules and automation ("programmable": a description with warnings, never a
 * level), every check grouped by level (each with how it was checked one click away), what is missing, and the words
 * that must sit next to a level. Who you still trust follows it on each page (`TrustFold`). Used by Verify and by the
 * token page.
 */
import type { ReactNode } from "react";

import { QslBadge, QslLadder, QslMark, QslProgrammableTag } from "../../components/qsl/QslBadge";
import { RefreshIcon } from "../../components/icons";
import { Address, Alert, Button, Skeleton } from "../../components/ui";
import { LEVEL_NAMES, PROGRAMMABLE_MEANS, qslBadgeView, type QslCheck, type QslProgrammableView, type QslVerdict } from "../../lib/qsl";
import { CheckLine, Checks, Comment, Details, NoteBox, Panel } from "../inner/kit";

/** Scroll to an element of this page (instantly with reduced motion) and open a fold inside it when asked. */
export function scrollToId(id: string, open?: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  if (open !== undefined) {
    const d = document.getElementById(open);
    if (d instanceof HTMLDetailsElement) d.open = true;
  }
  const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" });
  if (el.tabIndex < 0 && !el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
  el.focus({ preventScroll: true });
}

/**
 * A check's mark: passed, failed, a warning (a SHOULD that does not hold, or what keeps a candidate from a level: the
 * programs are not final yet, or this is not mainnet), or "does not apply" (a condition not due yet).
 */
function lineStatus(check: QslCheck): "pass" | "fail" | "warn" | "none" {
  if (check.status === "skip" && check.ok) return "none";
  if (check.status === "warn") return "warn";
  if (check.ok) return "pass";
  return check.id === "final" || check.id === "C1.24" || check.id === "cluster" ? "warn" : "fail";
}

/** One check: its plain sentence, and how it was checked behind a small fold. */
function QslCheckLine({ check, i }: { check: QslCheck; i: number }): ReactNode {
  return (
    <CheckLine
      i={i}
      status={lineStatus(check)}
      detail={
        check.detail === "" ? undefined : (
          <details className="qsl-how">
            <summary>How this was checked</summary>
            <span>{check.detail}</span>
          </details>
        )
      }
    >
      {check.plain}
    </CheckLine>
  );
}

export function QslReport({
  verdict,
  loading,
  error,
  onRefresh,
  id = "qsl",
  headingLevel = 2,
  compact = false,
}: {
  verdict: QslVerdict | undefined;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  id?: string;
  headingLevel?: 2 | 3;
  /** Every check behind a fold (the token page, where the rest of the page matters too); Verify shows them open. */
  compact?: boolean;
}): ReactNode {
  const view = verdict ? qslBadgeView(verdict, "page") : null;
  const groups =
    verdict === undefined ? null : (
      <div className="qsl-groups">
        {([1, 2] as const).map((level) => {
          const checks = verdict.checks.filter((c) => c.level === level);
          if (checks.length === 0) return null;
          const passed = checks.filter((c) => c.ok).length;
          return (
            <section key={level} className="qsl-group" aria-label={`Level ${level}: ${LEVEL_NAMES[level]}`}>
              <h3 className="qsl-group-h">
                <span>
                  Level {level} · {LEVEL_NAMES[level]}
                </span>
                <span className="qsl-group-n">{`${passed}/${checks.length}`}</span>
              </h3>
              <Checks label={`${LEVEL_NAMES[level]} checks`}>
                {checks.map((c, i) => (
                  <QslCheckLine key={c.id} check={c} i={i} />
                ))}
              </Checks>
            </section>
          );
        })}
      </div>
    );
  return (
    <Panel
      id={id}
      headingLevel={headingLevel}
      title="QSL-1 safety standard"
      description="Checked on Solana just now, not taken from anyone's word."
      status={
        <Button size="sm" variant="ghost" onClick={onRefresh} loading={loading} aria-label="Check again">
          <RefreshIcon />
          Check again
        </Button>
      }
      className="qsl-report"
    >
      <div className="pg-stack" aria-live="polite">
        {error !== null ? (
          <Alert tone="fail" title="The check could not run">
            {error}
          </Alert>
        ) : null}
        {verdict === undefined && error === null ? (
          <div className="pg-stack-sm">
            <Skeleton className="h-10 w-64" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
          </div>
        ) : null}
        {verdict !== undefined && view !== null ? (
          <>
            <div className="qsl-hero" data-tone={view.tone}>
              <QslMark pips={view.pips} tone={view.tone} size={7} />
              <div className="qsl-hero-t">
                <p className="qsl-hero-label">{view.label}</p>
                <p className="qsl-hero-line">{view.line}</p>
                {view.programmable !== null ? (
                  <p className="qsl-hero-tag">
                    <QslProgrammableTag p={view.programmable} onRead={() => scrollToId(`${id}-rules`)} />
                  </p>
                ) : null}
                <p className="qsl-hero-mint">
                  Token <Address value={verdict.mint} />
                </p>
              </div>
            </div>
            {view.programmable !== null ? <ProgrammableSection p={view.programmable} id={`${id}-rules`} /> : null}
            <QslLadder verdict={verdict} size="lg" />
            {verdict.reasons.length > 0 && verdict.level < 2 ? (
              <NoteBox title={verdict.candidate ? "Why there is no level yet" : verdict.certified ? "What is missing" : "Not a Noised launch"}>
                <span className="qsl-reasons">
                  {verdict.reasons.map((r) => (
                    <span key={r}>{r}</span>
                  ))}
                </span>
              </NoteBox>
            ) : null}
            {verdict.certified ? (
              compact ? (
                <Details summary={`See every check (${verdict.checks.length})`} id={`${id}-all`}>
                  {groups}
                </Details>
              ) : (
                groups
              )
            ) : null}
            {view.lines.length > 0 ? (
              <details className="pg-details qsl-means">
                <summary>
                  <span>What {view.tone === "candidate" ? "it would mean" : "this means"} for you</span>
                  <span className="pg-chev" aria-hidden="true" />
                </summary>
                <ul className="pg-details-body qsl-means-list">
                  {view.lines.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              </details>
            ) : null}
            {view.required.length > 0 ? <Comment className="qsl-required">{view.required.join(" ")}</Comment> : null}
          </>
        ) : null}
      </div>
    </Panel>
  );
}

/** The badge next to a token's name, opening the explainer (the full report sits further down the same page). */
export function QslHeaderBadge({ verdict, loading, error }: { verdict: QslVerdict | undefined; loading: boolean; error: string | null }): ReactNode {
  return <QslBadge verdict={verdict} loading={loading} error={error} where="page" />;
}

/** The warnings' heading: what kind of thing the creator added. */
function warnTitle(p: QslProgrammableView): string {
  return p.hasRules && p.hasAutomation ? "Read its rules and automation before you buy" : p.hasAutomation ? "Read its automation before you buy" : "Read its rules before you buy";
}

/**
 * "read its rules": the creator's launch rules and automation in plain English, the SDK's warnings first and in full
 * (insider-only buying, transfer limits, long rules, an operator, not frozen...), then how they were checked. A
 * description, never a level.
 */
export function ProgrammableSection({ p, id }: { p: QslProgrammableView; id: string }): ReactNode {
  return (
    <section className="qsl-prog" id={id} aria-label="Its rules and automation" tabIndex={-1} data-tone={p.tone}>
      <div className="qsl-prog-head">
        <span className="qsl-prog-k">{p.text}</span>
        <span className="qsl-prog-not">not a level</span>
      </div>
      <p className="qsl-prog-s">{p.summary}</p>
      {p.warnings.length > 0 ? (
        <NoteBox tone="warn" title={warnTitle(p)}>
          <ul className="qsl-warn-list qsl-warn-list-lg">
            {p.warnings.map((w) => (
              <li key={w.plain} data-kind={w.kind}>
                {w.plain}
              </li>
            ))}
          </ul>
        </NoteBox>
      ) : null}
      {p.rules.length > 0 ? (
        <div className="qsl-prog-part">
          <p className="pg-label">Its launch rules</p>
          <ol className="rl-plain">
            {p.rules.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ol>
        </div>
      ) : null}
      {p.automation.length > 0 ? (
        <div className="qsl-prog-part">
          <p className="pg-label">Its automation (Autopilot)</p>
          <ol className="rl-plain">
            {p.automation.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ol>
        </div>
      ) : null}
      {p.checks.some((c) => c.status !== "skip") ? (
        <Details summary={`How these were checked (${p.checks.filter((c) => c.status !== "skip").length})`}>
          <Checks label="Rules and automation checks">
            {p.checks
              .filter((c) => c.status !== "skip")
              .map((c, i) => (
                <CheckLine
                  key={c.id}
                  i={i}
                  status={c.status === "pass" ? "pass" : c.id === "P.G5" ? "warn" : "fail"}
                  detail={
                    c.detail === "" ? undefined : (
                      <details className="qsl-how">
                        <summary>How this was checked</summary>
                        <span>{c.detail}</span>
                      </details>
                    )
                  }
                >
                  {c.plain}
                </CheckLine>
              ))}
          </Checks>
        </Details>
      ) : null}
      <Comment>{PROGRAMMABLE_MEANS}</Comment>
    </section>
  );
}

/**
 * The token page's notice right under its name: a token whose creator added launch rules or automation says so, with
 * every warning, before anything else (a description, never a level). Nothing when it has neither.
 */
export function ProgrammableNotice({ verdict, onRead }: { verdict: QslVerdict | undefined; onRead: () => void }): ReactNode {
  const p = verdict?.programmable ?? null;
  if (p === null) return null;
  return (
    <NoteBox tone={p.warnings.length > 0 ? "warn" : "muted"} title={warnTitle(p)} className="qsl-notice">
      <span className="qsl-notice-body">
        <span className="qsl-notice-tag">
          <QslProgrammableTag p={p} onRead={onRead} />
        </span>
        <span>{p.summary}</span>
        {p.warnings.length > 0 ? (
          <ul className="qsl-warn-list">
            {p.warnings.map((w) => (
              <li key={w.plain} data-kind={w.kind}>
                {w.plain}
              </li>
            ))}
          </ul>
        ) : null}
      </span>
    </NoteBox>
  );
}

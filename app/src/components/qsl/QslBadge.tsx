/**
 * The QSL-1 badge (docs/standard/QSL-1.md Appendix A): a pixel shield whose two bars are the standard's levels
 * (No-rug, Quantum-attested), the badge's words, and a small explainer that opens from it.
 *
 *   <QslChip view={badge} />                      // passive, on launch cards (the card itself is the link)
 *   <QslBadge verdict={v} loading={...} />        // a button: opens the explainer, which links to every check
 *
 * When the creator added launch rules or automation, a separate "programmable" tag follows the badge (QSL-1 revision
 * 0.4): "QSL-1 L2 · programmable — read its rules". It is a description, never a level: it never lights a bar, never
 * changes the badge's colour, and its tone is caution (it has warnings) or neutral, never positive.
 *
 * Every word comes from lib/qsl.ts (`qslBadgeView`), which follows Appendix A; nothing here adds a claim.
 * The explainer is a non-modal dialog in a portal (so no card clips it), placed under the badge and following it as
 * the page scrolls, closed by Escape, a click outside or its close button; focus moves into it and back to the badge.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";

import { sfx } from "../../fx/sfx";
import { shortKey } from "../../lib/format";
import { LEVELS, PROGRAMMABLE_MEANS, qslBadgeView, type QslBadgeView, type QslLevel, type QslProgrammableView, type QslVerdict } from "../../lib/qsl";
import "./qsl.css";

/** Bars of the shield, bottom (level 1) to top (level 2): [level, row]. */
const BARS: readonly [1 | 2, number][] = [
  [1, 6],
  [2, 3],
];

/** The shield's outline, as 1-pixel rects [x, y, w, h] on an 11 x 13 grid. */
const OUTLINE: readonly [number, number, number, number][] = [
  [1, 0, 9, 1],
  [0, 1, 1, 7],
  [10, 1, 1, 7],
  [1, 8, 1, 1],
  [9, 8, 1, 1],
  [2, 9, 1, 1],
  [8, 9, 1, 1],
  [3, 10, 1, 1],
  [7, 10, 1, 1],
  [4, 11, 1, 1],
  [6, 11, 1, 1],
  [5, 12, 1, 1],
];

/**
 * The pixel shield. `pips` bars light up from the bottom; a candidate's bars are drawn dashed (reached apart from
 * finality). Decorative: the badge's text says the same.
 */
export function QslMark({ pips, tone, size = 2 }: { pips: QslLevel; tone: QslBadgeView["tone"] | "loading"; size?: number }): ReactNode {
  return (
    <svg className="qsl-mark" data-tone={tone} viewBox="0 0 11 13" width={11 * size} height={13 * size} shapeRendering="crispEdges" aria-hidden="true" focusable="false">
      {OUTLINE.map(([x, y, w, h]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width={w} height={h} className="qsl-mark-rim" />
      ))}
      {BARS.map(([level, row], i) => (
        <rect key={level} x={2} y={row} width={7} height={1} className="qsl-mark-bar" data-on={level <= pips ? "" : undefined} style={{ ["--i" as string]: i } as CSSProperties} />
      ))}
    </svg>
  );
}

/** The badge on a launch card: the shield and the short words, no interaction (the card is the link). */
export function QslChip({ view }: { view: QslBadgeView }): ReactNode {
  return (
    <>
      <span className="qsl-chip" data-tone={view.tone} title={`${view.label}. ${view.line}`}>
        <QslMark pips={view.pips} tone={view.tone} />
        <span className="qsl-chip-k">QSL-1</span>
        <span className="qsl-chip-v">{view.short}</span>
      </span>
      {view.programmable !== null ? (
        <span className="qsl-tag" data-tone={view.programmable.tone} title={`${view.programmable.text}. ${view.programmable.summary}`}>
          programmable
        </span>
      ) : null}
    </>
  );
}

/**
 * The "programmable" tag next to a badge: the standard's words ("QSL-1 L2 · programmable") and "read its rules",
 * which goes to the rules and their warnings (`onRead`, or `href`). Never a level, never "safer".
 */
export function QslProgrammableTag({ p, onRead, href }: { p: QslProgrammableView; onRead?: (() => void) | undefined; href?: string | null | undefined }): ReactNode {
  const n = p.warnings.length;
  const body = (
    <>
      <span className="qsl-tag-t">{p.text}</span>
      <span className="qsl-tag-sep" aria-hidden="true">
        —
      </span>
      <span className="qsl-tag-link">{p.link}</span>
      {n > 0 ? (
        <span className="qsl-tag-n" aria-label={`${n} warning${n === 1 ? "" : "s"}`}>
          {n}
        </span>
      ) : null}
    </>
  );
  const title = `${p.summary}${n > 0 ? ` ${n} warning${n === 1 ? "" : "s"} to read.` : ""}`;
  if (onRead !== undefined) {
    return (
      <button type="button" className="qsl-tag qsl-tag-btn" data-tone={p.tone} title={title} onClick={onRead}>
        {body}
      </button>
    );
  }
  if (href !== undefined && href !== null) {
    return (
      <Link to={href} className="qsl-tag qsl-tag-btn" data-tone={p.tone} title={title}>
        {body}
      </Link>
    );
  }
  return (
    <span className="qsl-tag" data-tone={p.tone} title={title}>
      {body}
    </span>
  );
}

/** Where to read every check: Verify, for this mint. */
export const reportRoute = (mint: string): string => `/verify/${mint}`;

/**
 * The interactive badge: loading, the verdict's words, and the explainer. `where` picks Appendix A's rules for
 * lists ("card") or a token's own page ("page"); a badge that should not show renders nothing.
 */
export function QslBadge({
  verdict,
  loading = false,
  error = null,
  where = "page",
  reportHref,
  onSeeAll,
  onReadRules,
}: {
  verdict: QslVerdict | undefined;
  loading?: boolean;
  error?: string | null;
  where?: "card" | "page";
  /** Where "See every check" goes (default: Verify for this mint); null hides the link (on Verify itself). */
  reportHref?: string | null;
  /** "See every check" on the same page instead (the token page scrolls to its report). */
  onSeeAll?: () => void;
  /** "read its rules" on the same page (scrolls to the rules and their warnings); default: the report's rules on Verify. */
  onReadRules?: () => void;
}): ReactNode {
  if (verdict === undefined) {
    if (error !== null) return null;
    return loading ? (
      <span className="qsl-chip" data-tone="loading" role="status">
        <QslMark pips={0} tone="loading" />
        <span className="qsl-chip-k">QSL-1</span>
        <span className="qsl-chip-v">Checking…</span>
      </span>
    ) : null;
  }
  const view = qslBadgeView(verdict, where);
  if (view === null) return null;
  const href = reportHref === undefined ? reportRoute(verdict.mint.toBase58()) : reportHref;
  return (
    <span className="qsl-badge-row">
      <QslBadgeButton view={view} verdict={verdict} reportHref={href} onSeeAll={onSeeAll} />
      {view.programmable !== null ? <QslProgrammableTag p={view.programmable} onRead={onReadRules} href={href === null ? null : `${href}#rules`} /> : null}
    </span>
  );
}

function QslBadgeButton({ view, verdict, reportHref, onSeeAll }: { view: QslBadgeView; verdict: QslVerdict; reportHref: string | null; onSeeAll: (() => void) | undefined }): ReactNode {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  }, []);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="qsl-chip qsl-chip-btn"
        data-tone={view.tone}
        aria-expanded={open}
        aria-controls={open ? `qsl-pop-${id}` : undefined}
        aria-haspopup="dialog"
        onClick={() => {
          sfx.play(open ? "toggle" : "open");
          setOpen((v) => !v);
        }}
      >
        <QslMark pips={view.pips} tone={view.tone} />
        <span className="qsl-chip-k">QSL-1</span>
        <span className="qsl-chip-v">{view.short}</span>
        <span className="qsl-chip-i" aria-hidden="true">
          ?
        </span>
        <span className="sr-only">: what this means</span>
      </button>
      {open ? <QslPopover id={`qsl-pop-${id}`} view={view} verdict={verdict} anchor={trigger} reportHref={reportHref} onSeeAll={onSeeAll} onClose={close} /> : null}
    </>
  );
}

/** The level ladder: each level in plain words, and where this token stands on it. */
export function QslLadder({ verdict, size = "sm" }: { verdict: QslVerdict; size?: "sm" | "lg" }): ReactNode {
  return (
    <ol className="qsl-ladder" data-size={size} aria-label="QSL-1 levels">
      {LEVELS.map((l, i) => {
        const state = verdict.level >= l.level ? "reached" : verdict.candidate && verdict.wouldBe >= l.level ? "candidate" : "todo";
        const word = state === "reached" ? "Reached" : state === "candidate" ? "Passes, not final yet" : "Not reached";
        return (
          <li key={l.level} className="qsl-rung" data-state={state} style={{ ["--i" as string]: i } as CSSProperties}>
            <span className="qsl-rung-n" aria-hidden="true">
              {l.level}
            </span>
            <span className="qsl-rung-t">
              <span className="qsl-rung-name">{l.name}</span>
              <span className="qsl-rung-line">{l.line}</span>
            </span>
            <span className="qsl-rung-state">{word}</span>
          </li>
        );
      })}
    </ol>
  );
}

function QslPopover({
  id,
  view,
  verdict,
  anchor,
  reportHref,
  onSeeAll,
  onClose,
}: {
  id: string;
  view: QslBadgeView;
  verdict: QslVerdict;
  anchor: RefObject<HTMLButtonElement | null>;
  reportHref: string | null;
  onSeeAll: (() => void) | undefined;
  onClose: (refocus: boolean) => void;
}): ReactNode {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number; up: boolean } | null>(null);

  // Under the badge (above it when there is no room), inside the viewport with a 12px margin; it follows the badge
  // when the page scrolls or resizes.
  const place = useCallback(() => {
    const a = anchor.current?.getBoundingClientRect();
    const b = box.current?.getBoundingClientRect();
    if (!a || !b) return;
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const x = Math.max(12, Math.min(a.left, vw - b.width - 12));
    const below = a.bottom + 10;
    const up = below + b.height > vh - 12 && a.top - 10 - b.height > 12;
    setPos((prev) => {
      const y = up ? a.top - 10 - b.height : below;
      return prev !== null && prev.x === x && prev.y === y && prev.up === up ? prev : { x, y, up };
    });
  }, [anchor]);
  useLayoutEffect(() => place(), [place]);

  useEffect(() => {
    box.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose(true);
      }
    };
    const onDown = (e: PointerEvent): void => {
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (box.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose(false);
    };
    let frame = 0;
    const onMove = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("scroll", onMove, { passive: true, capture: true });
    window.addEventListener("resize", onMove);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", onMove, { capture: true });
      window.removeEventListener("resize", onMove);
    };
  }, [anchor, onClose, place]);

  const style = pos === null ? undefined : ({ ["--qsl-x" as string]: `${pos.x}px`, ["--qsl-y" as string]: `${pos.y}px` } as CSSProperties);
  return createPortal(
    <div
      ref={box}
      id={id}
      className="qsl-pop px-corners"
      role="dialog"
      aria-modal="false"
      aria-labelledby={`${id}-t`}
      tabIndex={-1}
      data-tone={view.tone}
      data-placed={pos === null ? undefined : pos.up ? "up" : "down"}
      style={style}
    >
      <div className="qsl-pop-head">
        <QslMark pips={view.pips} tone={view.tone} size={4} />
        <div>
          <p className="qsl-pop-eyebrow">QSL-1 · an open token safety standard</p>
          <h2 id={`${id}-t`} className="qsl-pop-title">
            {view.label}
          </h2>
        </div>
        <button type="button" className="qsl-pop-x" aria-label="Close" onClick={() => onClose(true)}>
          ×
        </button>
      </div>
      <p className="qsl-pop-line">{view.line}</p>
      {view.programmable !== null ? <PopProgrammable p={view.programmable} /> : null}
      <p className="qsl-pop-sub">Two levels; the second includes the first.</p>
      <QslLadder verdict={verdict} />
      {view.required.length > 0 ? <p className="qsl-pop-note">{view.required.join(" ")}</p> : null}
      <p className="qsl-pop-mint">
        Token <code title={verdict.mint.toBase58()}>{shortKey(verdict.mint.toBase58(), 6)}</code>
      </p>
      {onSeeAll !== undefined ? (
        <button
          type="button"
          className="qsl-pop-link"
          onClick={() => {
            onClose(false);
            onSeeAll();
          }}
        >
          See every check <span aria-hidden="true">↓</span>
        </button>
      ) : reportHref !== null ? (
        <Link to={reportHref} className="qsl-pop-link" onClick={() => onClose(false)}>
          See every check <span aria-hidden="true">→</span>
        </Link>
      ) : null}
    </div>,
    document.body,
  );
}

/** The explainer's "programmable" block: the tag's words, what it is not, and its warnings, before the levels. */
function PopProgrammable({ p }: { p: QslProgrammableView }): ReactNode {
  return (
    <div className="qsl-pop-prog" data-tone={p.tone}>
      <p className="qsl-pop-prog-t">
        {p.text} — {p.link}
      </p>
      <p className="qsl-pop-prog-s">{p.summary}</p>
      {p.warnings.length > 0 ? (
        <ul className="qsl-warn-list" aria-label="Warnings about its rules and automation">
          {p.warnings.slice(0, 4).map((w) => (
            <li key={w.plain}>{w.plain}</li>
          ))}
          {p.warnings.length > 4 ? <li>And {p.warnings.length - 4} more: see every check.</li> : null}
        </ul>
      ) : null}
      <p className="qsl-pop-prog-n">{PROGRAMMABLE_MEANS}</p>
    </div>
  );
}

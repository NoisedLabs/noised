/**
 * Inner-page kit (v5.1 "Graphite glass", GLASS_V51.md
 * on GLASS_V5.md §5 and SIMPLE_V4.md §4, the maintainers' design notes): the pieces every inner page (token,
 * create, vault, privacy, security) and the transaction / wallet dialogs
 * share. Pure presentation: no chain access, no state beyond what a control
 * needs to render. Styles live in ./kit.css (static, CSP-safe; the only
 * runtime styling is React style props and CSSOM custom properties).
 *
 * The look: two tones (graphite + white), frosted glass cards (the global
 * .glass material, whose pointer highlight fx/aurora/glassPointer.ts drives),
 * one square-ish display headline per page that blurs in, plain words, and
 * technical detail behind "Details" folds.
 */
import type { PublicKey } from "@solana/web3.js";
import { m } from "motion/react";
import { Children, Fragment, isValidElement, useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Link } from "react-router";

import { Identicon } from "../../components/Identicon";
import { useNoiseReveal } from "../../fx/noise";
import "../../fx/noise/noise.css";
import { useBootDone } from "../../fx/motion";
import { sfx } from "../../fx/sfx";
import { prefersReducedMotion } from "../../fx/text";
import "./kit.css";

export type KitTone = "signal" | "ok" | "warn" | "danger" | "violet" | "muted";

// --------------------------------------------------------------- reveal ---

let revealIO: IntersectionObserver | null = null;
const revealCallbacks = new Map<Element, () => void>();

/** One observer for every revealable element of the app (it stops watching each element once revealed). */
function revealObserver(): IntersectionObserver | null {
  if (revealIO !== null) return revealIO;
  if (typeof IntersectionObserver === "undefined") return null;
  revealIO = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const done = revealCallbacks.get(e.target);
        revealCallbacks.delete(e.target);
        revealIO?.unobserve(e.target);
        done?.();
      }
    },
    { rootMargin: "0px 0px -6% 0px", threshold: 0 },
  );
  return revealIO;
}

/**
 * `[ref, on]`: `on` turns true the first time the element scrolls into view
 * (after the boot), and stays true. Immediately true under reduced motion or
 * without IntersectionObserver, so nothing ever waits on it.
 */
export function useReveal<T extends Element>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const booted = useBootDone();
  const [on, setOn] = useState(() => prefersReducedMotion() || typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (on || !booted) return;
    const el = ref.current;
    const io = revealObserver();
    if (el === null || io === null) {
      setOn(true);
      return;
    }
    revealCallbacks.set(el, () => setOn(true));
    io.observe(el);
    return () => {
      revealCallbacks.delete(el);
      io.unobserve(el);
    };
  }, [on, booted]);
  return [ref, on];
}

/** `data-reveal` value for an element driven by useReveal. */
export const revealAttr = (on: boolean): "on" | "off" => (on ? "on" : "off");

// ------------------------------------------------------------- blur text ---

/**
 * A headline whose words blur in one after another (blur 12px -> 0, rising
 * 8px, 50 ms apart). Strings only: other children render as they are. The
 * text is always the real text (each word is a plain span).
 */
export function BlurWords({ children, delay = 0 }: { children: ReactNode; delay?: number }): ReactNode {
  let n = 0;
  const split = (node: ReactNode, key: string): ReactNode => {
    // A fragment's own children are words of the same headline.
    if (isValidElement<{ children?: ReactNode }>(node) && node.type === Fragment) return Children.toArray(node.props.children).map((c, i) => split(c, `${key}.${i}`));
    if (typeof node !== "string") return node;
    const parts = node.split(/(\s+)/);
    return parts.map((p, i) =>
      /^\s+$/.test(p) || p === "" ? (
        p
      ) : (
        <span key={`${key}-${i}`} className="pg-bw nz-resolve" style={{ "--w": n++, "--wd": `${delay}ms` } as CSSProperties}>
          {p}
        </span>
      ),
    );
  };
  return <>{Children.toArray(children).map((c, i) => split(c, String(i)))}</>;
}

// --------------------------------------------------------------- header ---

/** "← Launches / AEGS": a quiet way back. */
export function Crumbs({ here, to = "/", back = "Launches" }: { here: ReactNode; to?: string; back?: string }): ReactNode {
  return (
    <nav aria-label="Breadcrumb" className="pg-crumbs">
      <Link to={to}>
        <span aria-hidden="true">←</span> {back}
      </Link>
      <span aria-hidden="true" className="pg-crumbs-sep">
        /
      </span>
      <span aria-current="page">{here}</span>
    </nav>
  );
}

/**
 * Page header: a small eyebrow pill, the page's display headline (it blurs in
 * word by word), one plain sentence and optional actions; `aside` sits on the
 * right. `size="sm"` is the compact header (e.g. later wizard steps).
 */
export function PageHead({
  eyebrow,
  title,
  lede,
  children,
  aside,
  art,
  size = "lg",
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  lede?: ReactNode;
  children?: ReactNode;
  aside?: ReactNode;
  /** A dot illustration on the right (art.tsx PageArt); decorative. */
  art?: ReactNode;
  size?: "lg" | "sm" | undefined;
}): ReactNode {
  return (
    <header className="pg-head" data-size={size} data-art={art !== undefined ? "" : undefined}>
      <div className="pg-head-main">
        {eyebrow !== undefined ? (
          <p className="pg-eyebrow">
            <i aria-hidden="true" />
            {eyebrow}
          </p>
        ) : null}
        <h1 className="pg-title">
          <BlurWords>{title}</BlurWords>
        </h1>
        {lede !== undefined ? <p className="pg-lede">{lede}</p> : null}
        {children !== undefined ? <div className="pg-head-after">{children}</div> : null}
      </div>
      {aside !== undefined ? <div className="pg-head-aside">{aside}</div> : null}
      {art !== undefined ? <div className="pg-head-aside pg-head-art">{art}</div> : null}
    </header>
  );
}

/** The gradient word of a headline ("Your <Grad>quantum-proof</Grad> vault"). */
export function Grad({ children }: { children: ReactNode }): ReactNode {
  return <span className="pg-title-grad">{children}</span>;
}

// ----------------------------------------------------------------- card ---

/**
 * A glass card: heading (with an optional status on the right), one line of
 * description, then the content. It resolves in from noise the first
 * time it scrolls into view.
 */
export function Panel({
  title,
  description,
  status,
  children,
  id,
  className = "",
  tone,
  headingLevel = 2,
  flush = false,
  glyph,
}: {
  title?: ReactNode;
  description?: ReactNode;
  status?: ReactNode;
  /** A small animated dot glyph before the title (decorative). */
  glyph?: ReactNode;
  children?: ReactNode;
  id?: string | undefined;
  className?: string | undefined;
  tone?: KitTone | undefined;
  headingLevel?: 2 | 3 | undefined;
  flush?: boolean | undefined;
}): ReactNode {
  const auto = useId();
  const headingId = `${id ?? `pg${auto.replace(/[^a-zA-Z0-9_-]/g, "")}`}-h`;
  const H = headingLevel === 2 ? "h2" : "h3";
  const [ref, on] = useReveal<HTMLElement>();
  // The card resolves in from noise the first time it scrolls into view.
  useNoiseReveal(ref, { duration: 560 });
  return (
    <section
      ref={ref}
      className={`pg-card glass pg-glass${flush ? " pg-flush" : ""} ${className}`}
      id={id}
      aria-labelledby={title !== undefined ? headingId : undefined}
      data-tone={tone}
      data-reveal={revealAttr(on)}
    >
      {title !== undefined || status !== undefined ? (
        <div className="pg-card-head">
          {title !== undefined ? (
            <H id={headingId} className={`pg-card-title${glyph ? " pg-card-title-g" : ""}`}>
              {glyph ? (
                <span className="pg-card-glyph" aria-hidden="true">
                  {glyph}
                </span>
              ) : null}
              {title}
            </H>
          ) : (
            <span />
          )}
          {status !== undefined ? <div className="pg-card-status">{status}</div> : null}
        </div>
      ) : null}
      {description !== undefined ? <p className="pg-card-desc">{description}</p> : null}
      {children !== undefined ? <div className="pg-card-body">{children}</div> : null}
    </section>
  );
}

/** A full-width "Details" fold (a <details>): the title row opens it. */
export function Fold({
  label,
  status,
  children,
  id,
  className = "",
  open,
  headingLevel = 2,
}: {
  label: ReactNode;
  status?: ReactNode;
  children: ReactNode;
  id?: string | undefined;
  className?: string | undefined;
  open?: boolean | undefined;
  headingLevel?: 2 | 3 | undefined;
}): ReactNode {
  const H = headingLevel === 2 ? "h2" : "h3";
  return (
    <details className={`pg-more glass pg-glass ${className}`} id={id} open={open}>
      <summary>
        <H className="pg-more-title">{label}</H>
        {status !== undefined ? <span className="pg-more-status">{status}</span> : null}
        <span className="pg-chev" aria-hidden="true" />
      </summary>
      <div className="pg-more-body">{children}</div>
    </details>
  );
}

/** A small "Details" disclosure inside a card (technical detail stays one click away). */
export function Details({
  summary = "Details",
  children,
  open,
  className = "",
  boxed = false,
  id,
}: {
  summary?: ReactNode;
  children: ReactNode;
  open?: boolean | undefined;
  className?: string | undefined;
  boxed?: boolean | undefined;
  id?: string | undefined;
}): ReactNode {
  return (
    <details className={`pg-details${boxed ? " pg-boxed" : ""} ${className}`} open={open} id={id}>
      <summary>
        <span>{summary}</span>
        <span className="pg-chev" aria-hidden="true" />
      </summary>
      <div className="pg-details-body">{children}</div>
    </details>
  );
}

// -------------------------------------------------------------- readout ---

/** `key — value` rows (a <dl>). */
export function Readout({ children, className = "", label }: { children: ReactNode; className?: string | undefined; label?: string | undefined }): ReactNode {
  return (
    <dl className={`pg-kv ${className}`} aria-label={label}>
      {children}
    </dl>
  );
}

/** One row. `wide` puts a long value under its key. */
export function Row({ k, children, tone, wide = false }: { k: ReactNode; children: ReactNode; tone?: KitTone | undefined; wide?: boolean | undefined }): ReactNode {
  return (
    <div className="pg-kv-row" data-tone={tone} data-wide={wide ? "" : undefined}>
      <dt>{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}

// --------------------------------------------------------------- metric ---

function RollChar({ c, fresh }: { c: string; fresh: boolean }): ReactNode {
  // Decided once, at mount: only characters that change after the first render roll in.
  const [roll] = useState(fresh);
  return <span className={roll ? "pg-roll-c pg-roll-new" : "pg-roll-c"}>{c}</span>;
}

/**
 * Text whose changed characters roll in like an odometer (keyed from the
 * right, so "12m 16s" -> "12m 15s" moves one digit). The element's text is
 * always exactly `text`: nothing is drawn over it or held back.
 */
export function Roll({ text, className = "" }: { text: string; className?: string | undefined }): ReactNode {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
  }, []);
  const chars = [...text];
  const n = chars.length;
  return (
    <span className={`pg-roll ${className}`}>
      {chars.map((c, i) => (
        <RollChar key={`${n - i}:${c}`} c={c} fresh={mounted.current} />
      ))}
    </span>
  );
}

/** A label over a big number. String values roll digit by digit when they change (the text is always the real value). */
export function Metric({
  label,
  value,
  unit,
  hint,
  tone,
  className = "",
  children,
}: {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  hint?: ReactNode;
  tone?: KitTone | undefined;
  className?: string | undefined;
  /** Extra content under the value (e.g. a progress bar). */
  children?: ReactNode;
}): ReactNode {
  const text = typeof value === "string" || typeof value === "number" ? String(value) : null;
  return (
    <div className={`pg-stat ${className}`} data-tone={tone}>
      <span className="pg-stat-k">{label}</span>
      <span className="pg-stat-v">
        <span className="pg-num">{text !== null ? <Roll text={text} /> : value}</span>
        {unit !== undefined ? <small>{unit}</small> : null}
      </span>
      {children}
      {hint !== undefined ? <span className="pg-stat-h">{hint}</span> : null}
    </div>
  );
}

/** A row of glass stat tiles (2-4 Metrics). */
export function Tiles({ children, className = "", label }: { children: ReactNode; className?: string | undefined; label?: string | undefined }): ReactNode {
  const [ref, on] = useReveal<HTMLDivElement>();
  return (
    <div ref={ref} className={`pg-tiles ${className}`} role={label !== undefined ? "group" : undefined} aria-label={label} data-reveal={revealAttr(on)}>
      {children}
    </div>
  );
}

// ------------------------------------------------------------- progress ---

/** A progress bar that grows in when it first scrolls into view. `over` adds a warning part past the fill. With `label` it is a progressbar; without, decorative. */
export function DotBar({
  value,
  max,
  label,
  tone = "signal",
  over = 0,
  className = "",
  size,
}: {
  value: number;
  max: number;
  label?: string | undefined;
  tone?: KitTone | undefined;
  over?: number | undefined;
  className?: string | undefined;
  size?: "sm" | "md" | "lg" | undefined;
}): ReactNode {
  const [ref, on] = useReveal<HTMLSpanElement>();
  const ratio = max > 0 && Number.isFinite(value) ? Math.max(0, Math.min(1, value / max)) : 0;
  const extra = over > 0 ? Math.max(0, Math.min(1 - ratio, over)) : 0;
  const pct = Math.round(ratio * 100);
  const a11y =
    label === undefined
      ? { "aria-hidden": true as const }
      : { role: "progressbar" as const, "aria-label": label, "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": pct };
  return (
    <span ref={ref} className={`pg-bar ${className}`} data-tone={tone} data-size={size} data-reveal={revealAttr(on)} style={{ "--v": ratio, "--o": extra } as CSSProperties} {...a11y}>
      <i className="pg-bar-fill" />
      {extra > 0 ? <i className="pg-bar-over" /> : null}
    </span>
  );
}

export type StepState = "done" | "current" | "todo" | "fail" | "skip";

export interface StepItem {
  key: string;
  label: ReactNode;
  state: StepState;
  hint?: ReactNode;
}

const STEP_WORD: Record<StepState, string> = { done: "done", current: "in progress", todo: "not yet", fail: "failed", skip: "skipped" };

/** Steps as dots on a glowing line: done ones filled, the current one ringed. */
export function Steps({ steps, label, className = "", size = "md" }: { steps: readonly StepItem[]; label: string; className?: string | undefined; size?: "sm" | "md" | undefined }): ReactNode {
  const [ref, on] = useReveal<HTMLOListElement>();
  return (
    <ol ref={ref} className={`pg-steps ${className}`} data-size={size} data-reveal={revealAttr(on)} aria-label={label}>
      {steps.map((s, i) => (
        <li key={s.key} className="pg-step" data-state={s.state} aria-current={s.state === "current" ? "step" : undefined} style={{ "--i": i } as CSSProperties}>
          <span className="pg-step-dot" aria-hidden="true" />
          <span className="pg-step-label">
            {s.label}
            <span className="sr-only">: {STEP_WORD[s.state]}</span>
          </span>
          {s.hint !== undefined ? <span className="pg-step-hint">{s.hint}</span> : null}
        </li>
      ))}
    </ol>
  );
}

// ----------------------------------------------------------------- chip ---

/** A small status pill with a dot. */
export function Chip({ tone = "muted", children, dot = true, title, pulse = false }: { tone?: KitTone | undefined; children: ReactNode; dot?: boolean | undefined; title?: string | undefined; pulse?: boolean | undefined }): ReactNode {
  return (
    <span className="pg-pill" data-tone={tone} title={title}>
      {dot ? <i className="pg-pill-dot" data-pulse={pulse ? "" : undefined} aria-hidden="true" /> : null}
      <span>{children}</span>
    </span>
  );
}

// ----------------------------------------------------------- pixel mark ---

/** The token's identicon in a small glass tile (the same 7x7 algorithm as the launch board, so a mint looks the same everywhere). */
export function PixelMark({ address, size = 64, ink }: { address: PublicKey; size?: number | undefined; ink?: string | undefined }): ReactNode {
  return (
    <span className="pg-mark" style={{ width: size, height: size }} aria-hidden="true">
      <Identicon address={address} size={Math.round(size * 0.62)} className="pg-mark-ico" ink={ink} />
    </span>
  );
}

// ------------------------------------------------------------- sticky fit ---

/**
 * A sticky column that never needs its own scrollbar: publishes its height as
 * `--pg-aside-h`, so CSS can stick it at the top while it fits the window and,
 * when it is taller, let it scroll with the page until its bottom is in view.
 */
export function useStickyFit<T extends HTMLElement>(): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => el.style.setProperty("--pg-aside-h", `${Math.ceil(el.getBoundingClientRect().height)}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return ref;
}

// ----------------------------------------------------------------- tabs ---

export interface TabItem<T extends string> {
  value: T;
  label: string;
  /** Small count or dot after the label (e.g. something to claim). */
  badge?: ReactNode;
}

/** ARIA tabs as a segmented glass control with a sliding indicator; arrows, Home and End move between tabs. */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  label,
  idBase,
  className = "",
}: {
  items: readonly TabItem<T>[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  idBase: string;
  className?: string | undefined;
}): ReactNode {
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const move = (e: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let next = -1;
    if (e.key === "ArrowRight") next = (index + 1) % items.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const it = items[next];
    if (!it) return;
    sfx.play("toggle");
    onChange(it.value);
    refs.current.get(it.value)?.focus();
  };
  return (
    <div className={`pg-tabs ${className}`} role="tablist" aria-label={label}>
      {items.map((it, i) => {
        const selected = it.value === value;
        return (
          <button
            key={it.value}
            ref={(el) => {
              if (el) refs.current.set(it.value, el);
              else refs.current.delete(it.value);
            }}
            type="button"
            role="tab"
            id={`${idBase}-tab-${it.value}`}
            aria-selected={selected}
            aria-controls={`${idBase}-panel-${it.value}`}
            tabIndex={selected ? 0 : -1}
            className="pg-tab"
            onClick={() => {
              if (!selected) sfx.play("toggle");
              onChange(it.value);
            }}
            onKeyDown={(e) => move(e, i)}
          >
            {selected ? <m.span layoutId={`${idBase}-ind`} className="pg-tab-ind" transition={{ type: "spring", stiffness: 520, damping: 42 }} aria-hidden="true" /> : null}
            <span className="pg-tab-t">{it.label}</span>
            {it.badge !== undefined ? <span className="pg-tab-badge">{it.badge}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/** Props for the panel of tab `tab` (kept mounted while hidden, so its state survives a tab switch). */
export function tabPanel(idBase: string, tab: string, active: string): { role: "tabpanel"; id: string; "aria-labelledby": string; hidden: boolean; tabIndex: number; className: string } {
  return { role: "tabpanel", id: `${idBase}-panel-${tab}`, "aria-labelledby": `${idBase}-tab-${tab}`, hidden: tab !== active, tabIndex: 0, className: "pg-tabpanel" };
}

/** A labelled checkbox (a native checkbox underneath, so forms and screen readers see a checkbox). */
export function Toggle({
  checked,
  onChange,
  children,
  describedBy,
  strong = false,
  disabled,
  className = "",
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: ReactNode;
  describedBy?: string | undefined;
  strong?: boolean | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
}): ReactNode {
  return (
    <label className={`pg-tick${strong ? " pg-tick-strong" : ""} ${className}`}>
      <input
        type="checkbox"
        className="pg-tick-input"
        checked={checked}
        disabled={disabled}
        onChange={(e) => {
          sfx.play("toggle");
          onChange(e.target.checked);
        }}
        aria-describedby={describedBy}
      />
      <span className="pg-tick-box" aria-hidden="true" />
      <span className="pg-tick-text">{children}</span>
    </label>
  );
}

// ------------------------------------------------------------ amount field ---

/**
 * The big amount input: `[ 0.0        SOL  Max ]`. Presentation only: the
 * caller owns the value, the parsing and what Max fills in.
 */
export function AmountInput({
  id,
  value,
  onChange,
  unit,
  invalid,
  describedBy,
  disabled,
  placeholder = "0.0",
  onMax,
  maxDisabled,
  ariaLabel,
}: {
  id?: string | undefined;
  value: string;
  onChange: (v: string) => void;
  unit: ReactNode;
  invalid?: boolean | undefined;
  describedBy?: string | undefined;
  disabled?: boolean | undefined;
  placeholder?: string | undefined;
  onMax?: (() => void) | undefined;
  maxDisabled?: boolean | undefined;
  ariaLabel?: string | undefined;
}): ReactNode {
  return (
    <div className="pg-amount" data-disabled={disabled ? "" : undefined}>
      <input
        id={id}
        className="input pg-amount-input"
        inputMode="decimal"
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={invalid}
        aria-describedby={describedBy || undefined}
        aria-label={ariaLabel}
        disabled={disabled}
      />
      <span className="pg-amount-unit" aria-hidden="true">
        {unit}
      </span>
      {onMax !== undefined ? (
        <button
          type="button"
          className="pg-amount-max"
          disabled={maxDisabled}
          onClick={() => {
            sfx.play("click");
            onMax();
          }}
        >
          Max
        </button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------- text blocks ---

/** A code block with a caption (command lines on the Privacy and Security pages). */
export function CodeBlock({ title, children, className = "", label }: { title?: ReactNode; children: ReactNode; className?: string | undefined; label?: string | undefined }): ReactNode {
  return (
    <figure className={`pg-code ${className}`} aria-label={label}>
      {title !== undefined ? <figcaption className="pg-code-cap">{title}</figcaption> : null}
      <div className="pg-code-body">{children}</div>
    </figure>
  );
}

/** A quiet note under a control. */
export function Comment({ children, className = "", id }: { children: ReactNode; className?: string | undefined; id?: string | undefined }): ReactNode {
  return (
    <p className={`pg-hint ${className}`} id={id}>
      {children}
    </p>
  );
}

/** A tinted note box: a short title and one paragraph (previews, expected fills). */
export function NoteBox({ title, children, tone, live = false, className = "" }: { title?: ReactNode; children?: ReactNode; tone?: KitTone | undefined; live?: boolean; className?: string | undefined }): ReactNode {
  return (
    <div className={`pg-note-box ${className}`} data-tone={tone} aria-live={live ? "polite" : undefined}>
      {title !== undefined ? <p className="pg-note-title">{title}</p> : null}
      {children !== undefined ? <div className="pg-note-text">{children}</div> : null}
    </div>
  );
}

/** Why the main action is unavailable, right above it ("Connect a wallet to commit"). The navbar's Connect glows while one shows. */
export function Reason({ children, id }: { children: ReactNode; id?: string | undefined }): ReactNode {
  return (
    <p className="pg-reason ip-need-wallet" id={id}>
      {children}
    </p>
  );
}

/** A check line: an icon in a circle (✓ ! ✕ –) and the text. `i` staggers it when the list first scrolls into view. */
export function CheckLine({ status, children, detail, i }: { status: "pass" | "warn" | "fail" | "none"; children: ReactNode; detail?: ReactNode; i?: number | undefined }): ReactNode {
  const glyph = status === "pass" ? "✓" : status === "warn" ? "!" : status === "fail" ? "✕" : "–";
  const word = status === "pass" ? "Passed" : status === "warn" ? "Warning" : status === "fail" ? "Failed" : "Not checked";
  return (
    <li className="pg-ck" data-status={status} style={i === undefined ? undefined : ({ "--i": i } as CSSProperties)}>
      <span className="pg-ck-ico" role="img" aria-label={word}>
        {glyph}
      </span>
      <span className="pg-ck-t">
        {children}
        {detail !== undefined ? <span className="pg-ck-d">{detail}</span> : null}
      </span>
    </li>
  );
}

/** A list of check lines that blur in one after another the first time it scrolls into view. */
export function Checks({ children, className = "", label }: { children: ReactNode; className?: string | undefined; label?: string | undefined }): ReactNode {
  const [ref, on] = useReveal<HTMLUListElement>();
  return (
    <ul ref={ref} className={`pg-cks ${className}`} aria-label={label} data-reveal={revealAttr(on)}>
      {children}
    </ul>
  );
}

/** A list of record cards (signed withdrawals, payouts). */
export function Records({ children, className = "" }: { children: ReactNode; className?: string | undefined }): ReactNode {
  return <ul className={`pg-records ${className}`}>{children}</ul>;
}

// ------------------------------------------------------------ icon tile ---

/** The home page's small glass icon tile (a rounded square holding a line icon). Decorative. */
export function IconTile({ children, size = "md", className = "" }: { children: ReactNode; size?: "sm" | "md" | undefined; className?: string | undefined }): ReactNode {
  return (
    <span className={`pg-ico ${className}`} data-size={size} aria-hidden="true">
      {children}
    </span>
  );
}

// ---------------------------------------------------------- empty state ---

/** An empty list as a small animated dot glyph and one plain sentence (the glyph is decorative). */
export function EmptyState({ art, children, className = "" }: { art: ReactNode; children: ReactNode; className?: string | undefined }): ReactNode {
  return (
    <div className={`pg-emptybox ${className}`}>
      <span className="pg-emptybox-art" aria-hidden="true">
        {art}
      </span>
      <p className="pg-empty">{children}</p>
    </div>
  );
}

// --------------------------------------------------------- feature cards ---

export interface FeatItem {
  title: string;
  text: ReactNode;
  /** A 40x40 line icon; give its strokes pathLength={1} and they draw in when the row scrolls into view. */
  icon: ReactNode;
}

/** A row of numbered glass cards, each with an icon that draws in ("how it works in three steps"). */
export function Feats({ items, label, className = "" }: { items: readonly FeatItem[]; label: string; className?: string | undefined }): ReactNode {
  const [ref, on] = useReveal<HTMLOListElement>();
  return (
    <ol ref={ref} className={`pg-feats ${className}`} aria-label={label} data-reveal={revealAttr(on)} data-n={items.length}>
      {items.map((s, i) => (
        <li key={s.title} className="pg-feat glass" style={{ "--i": i } as CSSProperties}>
          <IconTile>{s.icon}</IconTile>
          <span className="pg-feat-n" aria-hidden="true">
            {i + 1}
          </span>
          <h2 className="pg-feat-title">{s.title}</h2>
          <p className="pg-feat-text">{s.text}</p>
        </li>
      ))}
    </ol>
  );
}

// ------------------------------------------------------------- key trail ---

/**
 * A vault's one-time keys as a short trail (decorative: the readout next to it
 * says the same in words). Keys before `sequence` are spent, the key of
 * `sequence` signs the next withdrawal, later ones are unused.
 */
export function KeyTrail({ sequence, className = "" }: { sequence: bigint; className?: string | undefined }): ReactNode {
  const [ref, on] = useReveal<HTMLDivElement>();
  const seq = Number(sequence > 1_000_000n ? 1_000_000n : sequence);
  const first = Math.max(0, seq - 3);
  const keys: { n: number; state: "spent" | "next" | "unused" }[] = [];
  for (let n = first; n <= seq + 3; n++) keys.push({ n, state: n < seq ? "spent" : n === seq ? "next" : "unused" });
  return (
    <div ref={ref} className={`pg-keys ${className}`} data-reveal={revealAttr(on)} aria-hidden="true">
      {first > 0 ? <span className="pg-keys-more">{first.toLocaleString("en-US")} used</span> : null}
      <ol className="pg-keys-list">
        {keys.map((k, i) => (
          <li key={k.n} className="pg-key" data-state={k.state} data-far={Math.abs(k.n - seq) >= 3 ? "" : undefined} style={{ "--i": i } as CSSProperties}>
            <span className="pg-key-node" />
            <span className="pg-key-n">Key {k.n}</span>
            <span className="pg-key-s">{k.state === "spent" ? "used" : k.state === "next" ? "signs next" : "unused"}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

// --------------------------------------------------------------- compare ---

export interface CompareColumn {
  title: ReactNode;
  /** The column's mark: a check (protected / hidden), an alert (still trusted) or an eye (still public). */
  mark: "check" | "alert" | "eye";
  items: readonly { k: ReactNode; v?: ReactNode }[];
}

function CompareMark({ mark }: { mark: CompareColumn["mark"] }): ReactNode {
  return (
    <svg className="pg-cmp-mark" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      {mark === "check" ? <path d="m5.5 10.4 3 3 6-6.8" /> : null}
      {mark === "alert" ? (
        <>
          <path d="M10 5.5v5.5" />
          <path d="M10 14.4v.1" />
        </>
      ) : null}
      {mark === "eye" ? (
        <>
          <path d="M3 10s2.6-4.6 7-4.6 7 4.6 7 4.6-2.6 4.6-7 4.6S3 10 3 10Z" />
          <circle cx="10" cy="10" r="2" />
        </>
      ) : null}
    </svg>
  );
}

/** Two (or more) side-by-side lists that compare: what is protected and what is still trusted, what is hidden and what is public. The headings carry the meaning; the marks are decorative. */
export function Compare({ columns, className = "" }: { columns: readonly CompareColumn[]; className?: string | undefined }): ReactNode {
  const [ref, on] = useReveal<HTMLDivElement>();
  return (
    <div ref={ref} className={`pg-cmp ${className}`} data-reveal={revealAttr(on)}>
      {columns.map((c, ci) => (
        <section key={ci} className="pg-cmp-col" data-mark={c.mark}>
          <h3 className="pg-cmp-title">
            <CompareMark mark={c.mark} />
            {c.title}
          </h3>
          <ul className="pg-cmp-list">
            {c.items.map((it, i) => (
              <li key={i} className="pg-cmp-item" style={{ "--i": i + ci * 2 } as CSSProperties}>
                <CompareMark mark={c.mark} />
                <span className="pg-cmp-t">
                  <span className="pg-cmp-k">{it.k}</span>
                  {it.v !== undefined ? <span className="pg-cmp-v">{it.v}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

// ------------------------------------------------------------ link cards ---

export interface LinkCardItem {
  to: string;
  title: string;
  text: ReactNode;
  icon: ReactNode;
  cta: string;
}

/** Large glass link cards ("Read the docs", "Read the whitepaper"). */
export function LinkCards({ items, label, className = "" }: { items: readonly LinkCardItem[]; label: string; className?: string | undefined }): ReactNode {
  const [ref, on] = useReveal<HTMLUListElement>();
  return (
    <ul ref={ref} className={`pg-links ${className}`} aria-label={label} data-reveal={revealAttr(on)}>
      {items.map((it, i) => (
        <li key={it.to} style={{ "--i": i } as CSSProperties}>
          <Link to={it.to} className="pg-link-card glass" onClick={() => sfx.play("click")}>
            <IconTile>{it.icon}</IconTile>
            <span className="pg-link-main">
              <span className="pg-link-title">{it.title}</span>
              <span className="pg-link-text">{it.text}</span>
            </span>
            <span className="pg-link-cta">
              {it.cta}
              <span className="pg-link-arrow" aria-hidden="true">
                →
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * UI primitives: buttons, panels, badges, fields, alerts, dialogs, addresses, meters, tabs and toasts.
 * Same exports and props as before; styles in src/styles.css (palette-aware CSS variables).
 * v4 (SIMPLE_V4): calmer variants. No hover scramble, no typed-in titles or toasts, icons instead of
 * bracket tags ("[OK]"), and XDivider draws a quiet hairline.
 * v6 (PIXEL_V6): pixel corners on buttons (styles.css) and pixel-segment meters; "signal from noise": a ring of
 * round dots for the button spinner and in <Spinner> (fx/noise DotSpinner), and small sparkles on success toasts.
 */
import type { PublicKey } from "@solana/web3.js";
import { m } from "motion/react";
import {
  Children,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
} from "react";

import { useNow } from "../app/hooks";
import { sfx, type SoundName } from "../fx/sfx";
import { useInViewOnce } from "../fx/inview";
import { spring } from "../fx/motion";
import { DotSpinner } from "../fx/noise/DotSpinner";
import { formatDuration, shortKey } from "../lib/format";
import { CheckIcon, CloseIcon, CopyIcon, ExternalIcon, FailIcon, InfoIcon, WarnIcon } from "./icons";

export type Tone = "ok" | "warn" | "fail" | "info" | "accent" | "neutral";

/** Children made only of strings/numbers, joined (else null). */
function plainText(children: ReactNode): string | null {
  const parts = Children.toArray(children);
  if (parts.length === 0) return null;
  if (!parts.every((p) => typeof p === "string" || typeof p === "number")) return null;
  return parts.join("");
}

// ---------------------------------------------------------------- buttons ---

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

/** Button: pixel corners + a magnetic pull (see .btn in styles.css). Plain-text labels are wrapped in .btn-label. Clicks tick (sfx "click"). */
export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  className = "",
  children,
  disabled,
  type = "button",
  onClick,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "sm" | "md"; loading?: boolean }): ReactNode {
  const label = plainText(children);
  return (
    <button
      type={type}
      className={`btn btn-${variant} ${size === "sm" ? "btn-sm" : ""} ${className}`}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      onClick={(e) => {
        sfx.play("click");
        onClick?.(e);
      }}
      {...rest}
    >
      {loading ? <span className="spinner" aria-hidden="true" /> : null}
      {label !== null ? <span className="btn-label">{label}</span> : children}
    </button>
  );
}

// ------------------------------------------------------------------ cards ---

/**
 * Panel with an optional header bar: "01 / TITLE ——————— [status] [actions]".
 * The index counts panels per page (CSS counter); pass `index` to set it.
 */
export function Card({
  title,
  subtitle,
  actions,
  children,
  className = "",
  id,
  headingLevel = 2,
  index,
  status,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
  headingLevel?: 2 | 3;
  /** Override the automatic "01 /" panel number (e.g. "A1"). */
  index?: string;
  /** Short status text at the right of the header bar (e.g. "LIVE"). */
  status?: ReactNode;
}): ReactNode {
  const H = headingLevel === 2 ? "h2" : "h3";
  return (
    <section className={`card ${className}`} id={id} aria-labelledby={title === undefined || id === undefined ? undefined : `${id}-title`}>
      {title !== undefined || actions !== undefined ? (
        <header className="card-header">
          <div className="card-bar">
            {index !== undefined ? (
              <span className="card-index card-index-fixed" aria-hidden="true">
                {index} /
              </span>
            ) : (
              <span className="card-index" aria-hidden="true" />
            )}
            {title !== undefined ? (
              <H className="card-title" id={id === undefined ? undefined : `${id}-title`}>
                {title}
              </H>
            ) : null}
            <span className="card-rule" aria-hidden="true" />
            {status !== undefined ? <span className="card-status">{status}</span> : null}
            {actions !== undefined ? <div className="card-actions">{actions}</div> : null}
          </div>
          {subtitle !== undefined ? <p className="card-subtitle">{subtitle}</p> : null}
        </header>
      ) : null}
      <div className="card-body">{children}</div>
    </section>
  );
}

// ----------------------------------------------------------------- badges ---

export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }): ReactNode {
  return (
    <span className={`badge ${tone === "neutral" ? "" : `badge-${tone}`}`} title={title}>
      {children}
    </span>
  );
}

export function StatusIcon({ status, className = "h-4 w-4" }: { status: "pass" | "warn" | "fail" | "info"; className?: string }): ReactNode {
  if (status === "pass") return <CheckIcon className={`${className} text-ok`} title="Pass" />;
  if (status === "warn") return <WarnIcon className={`${className} text-warn`} title="Warning" />;
  if (status === "fail") return <FailIcon className={`${className} text-fail`} title="Fail" />;
  return <InfoIcon className={`${className} text-info`} title="Information" />;
}

// ----------------------------------------------------------------- alerts ---

const ALERT_TAG: Record<"ok" | "warn" | "fail" | "info", { tag: string; label: string }> = {
  ok: { tag: "[OK]", label: "Success" },
  warn: { tag: "[!]", label: "Warning" },
  fail: { tag: "[×]", label: "Error" },
  info: { tag: "[i]", label: "Note" },
};

function ToneIcon({ tone, className }: { tone: "ok" | "warn" | "fail" | "info"; className: string }): ReactNode {
  if (tone === "ok") return <CheckIcon className={className} />;
  if (tone === "warn") return <WarnIcon className={className} />;
  if (tone === "fail") return <FailIcon className={className} />;
  return <InfoIcon className={className} />;
}

export function Alert({ tone = "info", title, children, className = "" }: { tone?: "ok" | "warn" | "fail" | "info"; title?: ReactNode; children?: ReactNode; className?: string }): ReactNode {
  const t = ALERT_TAG[tone];
  return (
    <div className={`alert alert-${tone} ${className}`} role={tone === "fail" ? "alert" : undefined}>
      <span className="alert-tag" role="img" aria-label={t.label}>
        <ToneIcon tone={tone} className="alert-icon" />
      </span>
      <div className="min-w-0 flex-1">
        {title !== undefined ? <p className="alert-title">{title}</p> : null}
        {children !== undefined ? <div className={title !== undefined ? "mt-1 text-muted" : ""}>{children}</div> : null}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- fields ---

export interface FieldIds {
  input: string;
  help: string;
  error: string;
  /** Value for the control's aria-describedby. */
  describedBy: string;
}

/** A labelled form control with help text ("// comment") and an error attached to it. */
export function Field({
  label,
  help,
  error,
  children,
  className = "",
  optional = false,
}: {
  label: ReactNode;
  help?: ReactNode;
  error?: string | null | undefined;
  children: (ids: FieldIds & { invalid: boolean }) => ReactNode;
  className?: string;
  optional?: boolean;
}): ReactNode {
  const base = useId();
  const ids: FieldIds = {
    input: `${base}-input`,
    help: `${base}-help`,
    error: `${base}-error`,
    describedBy: [help !== undefined ? `${base}-help` : "", error ? `${base}-error` : ""].filter((x) => x !== "").join(" "),
  };
  return (
    <div className={className}>
      <label className="label" htmlFor={ids.input}>
        {label}
        {optional ? <span className="ml-2 font-normal text-subtle">(optional)</span> : null}
      </label>
      {children({ ...ids, invalid: Boolean(error) })}
      {error ? (
        <p className="field-error" id={ids.error}>
          {error}
        </p>
      ) : null}
      {help !== undefined ? (
        <div className="help help-comment" id={ids.help}>
          {help}
        </div>
      ) : null}
    </div>
  );
}

// -------------------------------------------------------------- addresses ---

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      className="btn btn-ghost btn-icon"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            toast({ text: `copied ${value.length > 16 ? shortKey(value, 4) : value}`, tone: "ok", sound: "click" });
          },
          () => setCopied(false),
        );
      }}
      aria-label={copied ? "Copied" : `${label} ${value}`}
      title={copied ? "Copied" : label}
    >
      {copied ? <CheckIcon className="h-3.5 w-3.5 text-ok" /> : <CopyIcon className="h-3.5 w-3.5" />}
    </button>
  );
}

const EXPLORER_CLUSTER: Record<string, string> = { mainnet: "", devnet: "?cluster=devnet", localnet: "?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899" };

/** Solana Explorer link for an address (a plain navigation: nothing is fetched by this page). */
export function explorerUrl(address: string, kind: "address" | "tx" = "address"): string {
  return `https://explorer.solana.com/${kind}/${address}${EXPLORER_CLUSTER[__NOISED_CLUSTER__] ?? ""}`;
}

export function Address({
  value,
  full = false,
  copy = true,
  explorer = false,
  className = "",
}: {
  value: PublicKey | string;
  full?: boolean;
  copy?: boolean;
  explorer?: boolean;
  className?: string;
}): ReactNode {
  const text = typeof value === "string" ? value : value.toBase58();
  return (
    <span className={`address inline-flex max-w-full items-center gap-0.5 align-middle ${className}`}>
      <code className={`mono text-[0.82rem] ${full ? "break-all" : ""}`} title={text}>
        {full ? text : shortKey(text, 4)}
      </code>
      {copy ? <CopyButton value={text} label="Copy address" /> : null}
      {explorer ? (
        <a className="btn btn-ghost btn-icon" href={explorerUrl(text)} target="_blank" rel="noopener noreferrer" aria-label={`Open ${text} in Solana Explorer (new tab)`} title="Solana Explorer">
          <ExternalIcon className="h-3.5 w-3.5" />
        </a>
      ) : null}
    </span>
  );
}

// ------------------------------------------------------------------ misc ---

export function Spinner({ label = "Loading" }: { label?: string }): ReactNode {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-muted" role="status">
      <DotSpinner size={16} decorative />
      <span>{label}…</span>
    </span>
  );
}

export function Skeleton({ className = "h-4 w-full" }: { className?: string }): ReactNode {
  return <span className={`skeleton block ${className}`} aria-hidden="true" />;
}

export function Countdown({ to, prefix = "", done = "now" }: { to: number | bigint; prefix?: string; done?: string }): ReactNode {
  const now = useNow();
  const left = Number(to) - now;
  return (
    <span className="countdown tabular-nums" aria-live="off">
      {left > 0 ? `${prefix}${formatDuration(left)}` : done}
    </span>
  );
}

/** Readout tile: dim uppercase label, dot-matrix value. */
export function Stat({ label, value, hint }: { label: ReactNode; value: ReactNode; hint?: ReactNode }): ReactNode {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint !== undefined ? <div className="stat-hint">{hint}</div> : null}
    </div>
  );
}

/** Native <dialog>: focus is trapped and Escape closes it. */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  dismissable = true,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  dismissable?: boolean;
}): ReactNode {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      sfx.play("open");
    }
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (dismissable) onClose();
      }}
    >
      <div className="relative z-[3] flex max-h-[calc(100vh-2rem)] flex-col supports-[height:100dvh]:max-h-[calc(100dvh-2rem)]">
        <div className="modal-head">
          <span className="modal-head-tag" aria-hidden="true" />
          <h2 id={titleId} className="modal-title">
            {title}
          </h2>
          {dismissable ? (
            <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close dialog">
              <CloseIcon />
            </button>
          ) : null}
        </div>
        <div className="modal-body min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer !== undefined ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </dialog>
  );
}

/** A meter (native <progress>, drawn as a row of pixel segments), labelled for screen readers. */
export function Meter({ value, max, label }: { value: number; max: number; label: string }): ReactNode {
  const v = Number.isFinite(value) ? Math.max(0, Math.min(value, max)) : 0;
  return <progress className="meter" value={v} max={max} aria-label={label} />;
}

/**
 * Discrete dot-matrix progress (12-24 dots). `value` is 0..1. The leading
 * dot glows. Decorative unless `label` is given (then role="progressbar").
 */
export function DotMeter({
  value,
  dots = 16,
  tone = "signal",
  label,
  shape = "round",
  className = "",
}: {
  value: number;
  dots?: number;
  tone?: "signal" | "ok" | "warn" | "violet" | "fail" | "muted";
  label?: string;
  shape?: "round" | "square";
  className?: string;
}): ReactNode {
  const v = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  const on = Math.round(v * dots);
  const a11y = label === undefined ? { "aria-hidden": true as const } : { role: "progressbar", "aria-label": label, "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.round(v * 100) };
  return (
    <span className={`dotbar ${className}`} data-tone={tone} data-shape={shape} {...a11y}>
      {Array.from({ length: dots }, (_, i) => (
        <i key={i} data-on={i < on} data-head={on > 0 && on < dots && i === on - 1 ? true : undefined} style={i < on ? ({ "--d": `${i * 22}ms` } as CSSProperties) : undefined} />
      ))}
    </span>
  );
}

/** Toggle buttons (exclusive choice): "[ ALL ] [ OPEN ]" with a sliding signal bar. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: readonly { value: T; label: ReactNode; disabled?: boolean }[];
  label: string;
}): ReactNode {
  const id = useId();
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => {
            if (o.value !== value) sfx.play("toggle");
            onChange(o.value);
          }}
          disabled={o.disabled === true}
        >
          {o.value === value ? <m.span className="seg-pill" layoutId={`seg-${id}`} transition={spring.snappy} aria-hidden="true" /> : null}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Section divider (UI v3): an X of two hairlines crossing at a "+" node over a horizon rail, with a section
 * number. The lines draw out from the node when it scrolls into view. Decorative (aria-hidden): keep the real
 * heading in your section.
 */
export function XDivider({ index, label, className = "" }: { index?: string; label?: string; className?: string }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const drawn = useInViewOnce(ref);
  return (
    <div ref={ref} className={`x-divider ${className}`} data-drawn={drawn} aria-hidden="true">
      <svg focusable="false">
        <line className="x-rail" x1="50%" y1="50%" x2="0" y2="50%" pathLength={1} />
        <line className="x-rail" x1="50%" y1="50%" x2="100%" y2="50%" pathLength={1} />
        <line x1="50%" y1="50%" x2="0" y2="0" pathLength={1} />
        <line x1="50%" y1="50%" x2="100%" y2="100%" pathLength={1} />
        <line x1="50%" y1="50%" x2="100%" y2="0" pathLength={1} />
        <line x1="50%" y1="50%" x2="0" y2="100%" pathLength={1} />
      </svg>
      <span className="x-divider-mark">
        <i className="cross-node" />
        {index !== undefined ? <b>{index}</b> : null}
        {label !== undefined ? <span>{label}</span> : null}
        {index !== undefined || label !== undefined ? <i className="cross-node" /> : null}
      </span>
    </div>
  );
}

/** Keyboard hint chip. */
export function Kbd({ children }: { children: ReactNode }): ReactNode {
  return <kbd className="kbd">{children}</kbd>;
}

// ----------------------------------------------------------------- toasts ---

export interface ToastInput {
  text: string;
  tone?: "ok" | "warn" | "fail" | "info";
  /** Custom tag text; by default an icon for the tone. */
  tag?: string;
  /** Sound to play (default by tone), or false. */
  sound?: SoundName | false;
  /** Milliseconds before it leaves (default 4500). */
  ttl?: number;
}

interface ToastItem extends Required<Omit<ToastInput, "sound">> {
  id: number;
}

let toasts: ToastItem[] = [];
let toastSeq = 0;
const toastListeners = new Set<() => void>();
const emitToasts = (): void => {
  for (const l of toastListeners) l();
};

const TOAST_SOUND: Record<NonNullable<ToastInput["tone"]>, SoundName> = { ok: "success", warn: "warn", fail: "error", info: "click" };

/** Show a toast at the bottom-left: `toast({ text: "Committed 1.00 SOL" })`. */
export function toast(input: ToastInput): void {
  const tone = input.tone ?? "ok";
  const item: ToastItem = { id: ++toastSeq, text: input.text, tone, tag: input.tag ?? ALERT_TAG[tone].tag, ttl: input.ttl ?? 4500 };
  toasts = [...toasts.slice(-3), item];
  emitToasts();
  if (input.sound !== false) sfx.play(input.sound ?? TOAST_SOUND[tone]);
  setTimeout(() => dismissToast(item.id), item.ttl);
}

export function dismissToast(id: number): void {
  if (!toasts.some((t) => t.id === id)) return;
  toasts = toasts.filter((t) => t.id !== id);
  emitToasts();
}

/** Mount once (Layout). */
export function Toaster(): ReactNode {
  const items = useSyncExternalStore(
    (l) => {
      toastListeners.add(l);
      return () => toastListeners.delete(l);
    },
    () => toasts,
    () => toasts,
  );
  return (
    <div className="toast-region" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className="toast" data-tone={t.tone}>
          {t.tone === "ok" ? <ToastSparkles /> : null}
          <span className="toast-tag" aria-hidden="true">
            {t.tag === ALERT_TAG[t.tone].tag ? <ToneIcon tone={t.tone} className="toast-icon" /> : t.tag}
          </span>
          <span className="toast-text">{t.text}</span>
          <button type="button" className="toast-close" onClick={() => dismissToast(t.id)} aria-label="Dismiss notification">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/** Where the sparkles pop on a success toast: [left %, top px, delay ms]. */
const SPARKLES: readonly (readonly [string, string, number])[] = [
  ["10px", "6px", 60],
  ["30px", "30px", 180],
  ["38%", "5px", 300],
  ["66%", "31px", 420],
  ["88%", "8px", 520],
];

/** Small round sparkles that bloom once when a success toast appears (styles.css .toast-sparkles). */
function ToastSparkles(): ReactNode {
  return (
    <span className="toast-sparkles" aria-hidden="true">
      {SPARKLES.map(([x, y, d]) => (
        <i key={`${x}${y}`} style={{ "--sx": x, "--sy": y, "--sd": `${d}ms` } as CSSProperties} />
      ))}
    </span>
  );
}

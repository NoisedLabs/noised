/**
 * Text effects: typewriter and the blinking cursor. Pure DOM text updates (no innerHTML, no <style>), so they
 * are CSP-safe. Under prefers-reduced-motion every effect shows the final text immediately.
 *
 * v4 (SIMPLE_V4 section 1) retired the glyph scramble on labels: useScramble / <Scramble> render the final
 * text, and scrambleElement / useHoverScramble are no-ops. The exports stay so existing callers keep compiling.
 *
 *   const s = useScramble("LAUNCHPAD", { trigger: "manual" });
 *   <a onPointerEnter={s.replay}>{s.text}</a>
 *
 *   <Scramble text="QUANTUM SECURITY" trigger="view" />      // a11y-safe component
 *   <Typewriter text="> verifying programs… [OK]" speed={18} cursor />
 *   <Cursor />                                               // blinking "_" in the signal colour
 */
import { createElement, useCallback, useEffect, useRef, useState, type ElementType, type ReactNode, type RefObject } from "react";

import { sfx } from "./sfx";

/** Glyphs a scrambled character cycles through (spec: ▓▒░/\_<>[]01). */
export const SCRAMBLE_GLYPHS = "▓▒░/\\_<>[]01";

export function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * One frame of a scramble: the first `revealed` characters are final, the
 * rest are random glyphs. Whitespace stays whitespace so words keep their
 * shape. Pure (pass `rand` for deterministic tests).
 */
export function scrambleText(target: string, revealed: number, glyphs: string = SCRAMBLE_GLYPHS, rand: () => number = Math.random): string {
  const chars = [...target];
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i] ?? "";
    if (i < revealed || /\s/.test(c)) out += c;
    else out += glyphs[Math.floor(rand() * glyphs.length)] ?? c;
  }
  return out;
}

export interface ScrambleOptions {
  /** "mount": decode once when the component mounts (default). "manual": only on replay(). */
  trigger?: "mount" | "manual";
  /** Milliseconds per character (default 40). */
  charMs?: number;
  /** Cap on the whole effect (default 600 ms). */
  maxMs?: number;
  /** Delay before the first frame (default 0). */
  delayMs?: number;
  glyphs?: string;
  /** Play the soft "key" tick while decoding (default false). */
  sound?: boolean;
}

export interface ScrambleState {
  /** The string to render this frame (the final text when idle or reduced motion). */
  text: string;
  done: boolean;
  /** Run the decode again (e.g. on hover). No-op under reduced motion. */
  replay: () => void;
  /** Spread on an element to replay on pointer enter / keyboard focus. */
  hoverProps: { onPointerEnter: () => void; onFocus: () => void };
}

/**
 * Decode `text` from random glyphs, left to right: 40 ms per character,
 * at most 600 ms. Glyphs refresh at ~30 fps (terminal feel, cheap).
 */
export function useScramble(text: string, opts: ScrambleOptions = {}): ScrambleState {
  void opts;
  const replay = useCallback(() => undefined, []);
  return { text, done: true, replay, hoverProps: { onPointerEnter: replay, onFocus: replay } };
}

export interface TypewriterOptions {
  delayMs?: number;
  /** Start typing (default true). Set false to hold until e.g. in view. */
  start?: boolean;
  /** Soft key tick per character (default false; sfx rate-limits). */
  sound?: boolean;
  onDone?: () => void;
}

/**
 * Imperative hover scramble that never touches the element's text: frames go
 * to `data-scramble`, which CSS draws over the (transparent) real text with
 * `::after { content: attr(data-scramble) }` (classes .btn-label and
 * .scramble-host in styles.css / terminal.css). Accessible name, textContent
 * and layout stay exactly the same. Returns a cancel function.
 */
export function scrambleElement(el: HTMLElement, text: string, opts: { charMs?: number; maxMs?: number; glyphs?: string } = {}): () => void {
  void el;
  void text;
  void opts;
  return () => undefined;
}

/** Hover/focus scramble for one element: `const h = useHoverScramble("LAUNCH"); <span ref={h.ref} className="scramble-host" />`. */
export function useHoverScramble<T extends HTMLElement = HTMLSpanElement>(text: string): { ref: RefObject<T | null>; trigger: () => void } {
  const ref = useRef<T | null>(null);
  const cancel = useRef<() => void>(() => undefined);
  useEffect(() => () => cancel.current(), []);
  const trigger = useCallback(() => {
    if (ref.current) cancel.current = scrambleElement(ref.current, text);
  }, [text]);
  return { ref, trigger };
}

/** Type `text` out one character every `speed` ms (default 24). */
export function useTypewriter(text: string, speed = 24, opts: TypewriterOptions = {}): { text: string; done: boolean; restart: () => void } {
  const { delayMs = 0, start = true, sound = false, onDone } = opts;
  const chars = [...text];
  const [count, setCount] = useState(() => (prefersReducedMotion() ? chars.length : 0));
  const [nonce, setNonce] = useState(0);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    if (!start) return;
    if (prefersReducedMotion()) {
      setCount([...text].length);
      doneRef.current?.();
      return;
    }
    setCount(0);
    const n = [...text].length;
    let i = 0;
    let interval: ReturnType<typeof setInterval> | undefined;
    const t = setTimeout(() => {
      interval = setInterval(() => {
        i += 1;
        setCount(i);
        if (sound && i % 2 === 0) sfx.play("key");
        if (i >= n) {
          clearInterval(interval);
          doneRef.current?.();
        }
      }, speed);
    }, delayMs);
    return () => {
      clearTimeout(t);
      clearInterval(interval);
    };
  }, [text, speed, delayMs, start, sound, nonce]);

  return { text: chars.slice(0, count).join(""), done: count >= chars.length, restart: () => setNonce((x) => x + 1) };
}

/** Signal-coloured blinking cursor ("_" by default; block=true draws a solid block). Decorative. */
export function Cursor({ char = "_", block = false, className = "" }: { char?: string; block?: boolean; className?: string }): ReactNode {
  if (block) return createElement("span", { className: `cursor-block ${className}`, "aria-hidden": true });
  return createElement("span", { className: `cursor ${className}`, "aria-hidden": true }, char);
}

type Trigger = "mount" | "hover" | "both" | "view";

/** Formerly an accessible glyph scramble; v4 renders the text as is (same props, so callers keep compiling). */
export function Scramble(props: {
  text: string;
  as?: ElementType;
  trigger?: Trigger;
  className?: string;
  charMs?: number;
  maxMs?: number;
  delayMs?: number;
  sound?: boolean;
}): ReactNode {
  return createElement(props.as ?? "span", { className: props.className }, props.text);
}

/** Typed line (decorative typing, real text for assistive tech). */
export function Typewriter({
  text,
  speed = 24,
  delayMs = 0,
  as = "span",
  className,
  cursor = false,
  start = true,
  sound = false,
  onDone,
}: {
  text: string;
  speed?: number;
  delayMs?: number;
  as?: ElementType;
  className?: string;
  cursor?: boolean;
  start?: boolean;
  sound?: boolean;
  onDone?: () => void;
}): ReactNode {
  const t = useTypewriter(text, speed, { delayMs, start, sound, ...(onDone ? { onDone } : {}) });
  return createElement(
    as,
    { className },
    createElement("span", { className: "sr-only" }, text),
    createElement("span", { "aria-hidden": true }, t.text),
    cursor && !t.done ? createElement(Cursor, { block: true }) : null,
  );
}

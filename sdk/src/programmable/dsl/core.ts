/**
 * Shared pieces of the two text DSLs (launch rules, autopilot graphs):
 * a line-based lexer, a token cursor with friendly errors, unit parsing,
 * and the boolean-expression parser / printer (not > and > or).
 */
import { DslError, ProgError } from "../errors.js";
import type { Cond } from "../cond/ast.js";
import { durationUnitSecs, parseDecimal } from "../units.js";

export interface Tok {
  kind: "atom" | "punct";
  text: string;
  /** 0-based offset in the source. */
  offset: number;
  line: number;
  col: number;
}

export interface Line {
  /** 1-based line number. */
  line: number;
  /** Line starts with whitespace (continuation / block body). */
  indented: boolean;
  toks: Tok[];
  /** Offset of the line's end (for "expected more" errors). */
  endOffset: number;
  endCol: number;
}

const PUNCT = new Set(["(", ")", "{", "}", ",", "=", "<", ">", "!", ":"]);

/** Splits source text into lines of tokens (comments start with #). */
export function lex(src: string): Line[] {
  const out: Line[] = [];
  let offset = 0;
  const rawLines = src.split("\n");
  rawLines.forEach((raw, li) => {
    const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const lineStart = offset;
    offset += raw.length + 1;
    const hash = text.indexOf("#");
    const body = hash >= 0 ? text.slice(0, hash) : text;
    const toks: Tok[] = [];
    let i = 0;
    while (i < body.length) {
      const c = body[i]!;
      if (c === " " || c === "\t") {
        i++;
        continue;
      }
      const at = (start: number, t: string, kind: Tok["kind"]): Tok => ({ kind, text: t, offset: lineStart + start, line: li + 1, col: start + 1 });
      if (PUNCT.has(c) && !(c === ":" && /\d/.test(body[i - 1] ?? "") && /\d/.test(body[i + 1] ?? ""))) {
        // two-char operators
        const two = body.slice(i, i + 2);
        if (two === "<=" || two === ">=" || two === "==" || two === "!=") {
          toks.push(at(i, two, "punct"));
          i += 2;
        } else {
          toks.push(at(i, c, "punct"));
          i++;
        }
        continue;
      }
      const start = i;
      while (i < body.length) {
        const d = body[i]!;
        if (d === " " || d === "\t") break;
        if (PUNCT.has(d) && !(d === ":" && /\d/.test(body[i - 1] ?? "") && /\d/.test(body[i + 1] ?? ""))) break;
        i++;
      }
      toks.push(at(start, body.slice(start, i), "atom"));
    }
    if (toks.length > 0) {
      out.push({ line: li + 1, indented: /^[ \t]/.test(text), toks, endOffset: lineStart + body.trimEnd().length, endCol: body.trimEnd().length + 1 });
    }
  });
  return out;
}

/** A cursor over one statement's tokens. */
export class Cursor {
  i = 0;
  constructor(
    readonly toks: Tok[],
    /** Where "end of statement" errors point. */
    readonly end: { line: number; col: number; offset: number },
  ) {}

  peek(k = 0): Tok | undefined {
    return this.toks[this.i + k];
  }
  done(): boolean {
    return this.i >= this.toks.length;
  }
  next(): Tok {
    const t = this.toks[this.i];
    if (!t) this.fail("this line ends too early");
    this.i++;
    return t!;
  }
  /** True (and consumes) if the next token is `text` (case-insensitive for words). */
  eat(text: string): boolean {
    const t = this.peek();
    if (t && t.text.toLowerCase() === text.toLowerCase()) {
      this.i++;
      return true;
    }
    return false;
  }
  isNext(...texts: string[]): boolean {
    const t = this.peek();
    return !!t && texts.some((x) => x.toLowerCase() === t.text.toLowerCase());
  }
  expect(text: string, hint?: string): Tok {
    const t = this.peek();
    if (!t || t.text.toLowerCase() !== text.toLowerCase()) {
      this.fail(t ? `expected "${text}" but found "${t.text}"` : `expected "${text}"`, hint, t);
    }
    return this.next();
  }
  /** Throws a DslError at `t` (default: the next token, or the end of the line). */
  fail(message: string, hint?: string, t: Tok | undefined = this.peek()): never {
    if (t) throw new DslError(message, t.line, t.col, t.offset, Math.max(1, t.text.length), hint);
    throw new DslError(message, this.end.line, this.end.col, this.end.offset, 1, hint);
  }
  expectEnd(hint?: string): void {
    const t = this.peek();
    if (t) this.fail(`unexpected "${t.text}"`, hint, t);
  }
}

/** Re-throws a ProgError as a DslError at token `t`. */
export function atTok<T>(t: Tok, f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof ProgError) throw new DslError(e.message, t.line, t.col, t.offset, Math.max(1, t.text.length));
    throw e;
  }
}

// ------------------------------------------------------------ units ---

const NUM_RE = /^\d[\d_]*(\.\d+)?([eE][+-]?\d+)?$/;
export const isNumberAtom = (s: string): boolean => NUM_RE.test(s);

/** Reads a whole number. */
export function readInt(c: Cursor, what: string): number {
  const t = c.next();
  if (!/^\d[\d_]*$/.test(t.text)) c.fail(`${what} must be a whole number, not "${t.text}"`, undefined, t);
  const v = Number(t.text.replaceAll("_", ""));
  if (!Number.isSafeInteger(v)) c.fail(`${what} is too large`, undefined, t);
  return v;
}

/** Reads a decimal number atom as text. */
export function readNumber(c: Cursor, what: string): { text: string; tok: Tok } {
  const t = c.next();
  if (!isNumberAtom(t.text)) c.fail(`${what}: expected a number, found "${t.text}"`, undefined, t);
  return { text: t.text.replaceAll("_", ""), tok: t };
}

const DUR_FRAG = /^(\d+(?:\.\d+)?[a-zA-Z]+)+$/;

function fragSecs(text: string, c: Cursor, t: Tok): number {
  const re = /(\d+(?:\.\d+)?)([a-zA-Z]+)/g;
  let total = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const unit = durationUnitSecs(m[2]!);
    if (unit === undefined) c.fail(`"${m[2]}" is not a time unit`, "use s, m, h, d or w — e.g. 90s, 2m, 1h30m", t);
    const d = parseDecimal(m[1]!)!;
    const v = d.num * BigInt(unit!);
    const sc = 10n ** BigInt(d.scale);
    if (v % sc !== 0n) c.fail(`"${text}" is not a whole number of seconds`, undefined, t);
    total += Number(v / sc);
  }
  return total;
}

/** Is the cursor at the start of a duration? */
export function atDuration(c: Cursor): boolean {
  const t = c.peek();
  if (!t || t.kind !== "atom") return false;
  if (DUR_FRAG.test(t.text)) return true;
  const u = c.peek(1);
  return isNumberAtom(t.text) && !!u && u.kind === "atom" && durationUnitSecs(u.text) !== undefined;
}

/** Reads "2m", "1h30m", "1h 30m", "2 minutes", "1 hour 30 minutes". */
export function readDuration(c: Cursor, what: string): number {
  if (!atDuration(c)) {
    const t = c.peek();
    if (t && /^\d[\d_]*$/.test(t.text)) c.fail(`${what}: "${t.text}" needs a unit`, `write ${t.text}s, ${t.text}m or ${t.text}h`, t);
    c.fail(t ? `${what}: expected a duration like 2m, found "${t.text}"` : `${what}: expected a duration like 2m`, "durations look like 90s, 2m, 1h30m or 1d");
  }
  let total = 0;
  while (atDuration(c)) {
    const t = c.next();
    if (DUR_FRAG.test(t.text)) total += fragSecs(t.text, c, t);
    else {
      const u = c.next();
      total += fragSecs(t.text + u.text, c, t);
    }
  }
  if (!Number.isSafeInteger(total)) c.fail(`${what} is too long`);
  return total;
}

/** Splits an atom like "0.5%" / "25bps" / "1.5SOL" into number + unit, or the next atom as unit. */
export function readQuantity(c: Cursor, what: string): { num: string; unit: string; tok: Tok } {
  const t = c.next();
  const m = /^(\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)([a-zA-Z%][a-zA-Z0-9%]*)?$/.exec(t.text);
  if (!m) c.fail(`${what}: expected a number, found "${t.text}"`, undefined, t);
  let unit = m![2] ?? "";
  if (!unit) {
    const u = c.peek();
    if (u && u.kind === "atom" && /^[a-zA-Z%][a-zA-Z0-9%]*$/.test(u.text) && !/^(and|or|not|when|code|per|premium|to)$/i.test(u.text)) {
      unit = u.text;
      c.next();
    }
  }
  return { num: m![1]!.replaceAll("_", ""), unit: unit.toLowerCase(), tok: t };
}

// ------------------------------------------------------------ conditions ---

/** Parses the leaves of one context; returns null if the cursor is not at a leaf it knows. */
export type LeafParser = (c: Cursor) => Cond | null;

/**
 * Deepest nesting of "not" / "(" the parser follows. A condition that fits
 * on-chain (64 nodes in a rule set, 96 in a graph) never comes close; deeper
 * text gets a positioned error instead of exhausting the call stack.
 */
export const MAX_NESTING = 128;

/** cond := or ; or := and {"or" and} ; and := unary {"and" unary} ; unary := "not" unary | "(" cond ")" | leaf */
export function parseCond(c: Cursor, leaf: LeafParser, leafHint: string): Cond {
  let depth = 0;
  const nested = <T>(f: () => T): T => {
    if (++depth > MAX_NESTING) c.fail(`this condition is nested more than ${MAX_NESTING} levels deep`, "split it into simpler parts");
    try {
      return f();
    } finally {
      depth--;
    }
  };
  const parseOr = (): Cond => {
    let a = parseAnd();
    while (c.eat("or")) a = { op: "or", a, b: parseAnd() };
    return a;
  };
  const parseAnd = (): Cond => {
    let a = parseUnary();
    while (c.eat("and")) a = { op: "and", a, b: parseUnary() };
    return a;
  };
  const parseUnary = (): Cond => {
    if (c.eat("not")) return nested(() => ({ op: "not", x: parseUnary() }));
    if (c.eat("(")) {
      return nested(() => {
        const inner = parseOr();
        c.expect(")", "every ( needs a matching )");
        return inner;
      });
    }
    if (c.eat("true")) return { op: "true" };
    if (c.eat("false")) return { op: "false" };
    const l = leaf(c);
    if (l) return l;
    const t = c.peek();
    return c.fail(t ? `"${t.text}" is not a condition` : "expected a condition", leafHint);
  };
  return parseOr();
}

/** Prints a tree with the fewest parentheses that parse back to the same tree. */
export function printCond(cond: Cond, leaf: (c: Cond) => string): string {
  const prec = (c: Cond): number => (c.op === "or" ? 1 : c.op === "and" ? 2 : c.op === "not" ? 3 : 4);
  const go = (c: Cond, min: number): string => {
    let s: string;
    switch (c.op) {
      case "or":
        s = `${go(c.a, 1)} or ${go(c.b, 2)}`;
        break;
      case "and":
        s = `${go(c.a, 2)} and ${go(c.b, 3)}`;
        break;
      case "not":
        // "not" applies to a unary: another "not" needs no parentheses ("not not buy").
        s = `not ${go(c.x, 3)}`;
        break;
      case "true":
        s = "true";
        break;
      case "false":
        s = "false";
        break;
      default:
        s = leaf(c);
    }
    return prec(c) < min ? `(${s})` : s;
  };
  return go(cond, 0);
}

/** Joins a statement: a non-indented line plus following indented lines. */
export function statements(lines: Line[]): Line[][] {
  const out: Line[][] = [];
  for (const l of lines) {
    if (l.indented && out.length > 0) out[out.length - 1]!.push(l);
    else out.push([l]);
  }
  return out;
}

export function cursorOf(lines: Line[]): Cursor {
  const last = lines[lines.length - 1]!;
  return new Cursor(
    lines.flatMap((l) => l.toks),
    { line: last.line, col: last.endCol, offset: last.endOffset },
  );
}

/** Reads `{a, b}` or a single name; returns the raw tokens. */
export function readNameList(c: Cursor, what: string): Tok[] {
  const out: Tok[] = [];
  if (c.eat("{")) {
    do {
      const t = c.next();
      if (t.kind !== "atom") c.fail(`${what}: expected a name`, undefined, t);
      out.push(t);
    } while (c.eat(","));
    c.expect("}", "close the list with }");
  } else {
    const t = c.next();
    if (t.kind !== "atom") c.fail(`${what}: expected a name or {a, b}`, undefined, t);
    out.push(t);
  }
  return out;
}

/** A DslError at the start of a line. */
export function lineError(l: Line, message: string, hint?: string): DslError {
  const t = l.toks[0]!;
  return new DslError(message, t.line, t.col, t.offset, Math.max(1, t.text.length), hint);
}

/**
 * The launch-rules text DSL (grammar in src/programmable/README.md).
 *
 *   rules v1
 *   guard 1h
 *   key team = 9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin
 *
 *   first 2m: deny when buy and instructions > 10 code BOT
 *   first 10m: max amount 0.5% when buy code WHALE
 *   always: deny when buy and to in {team} code TEAM
 *
 * parseRules(printRules(s)) deep-equals normalizeRules(s) (keys get names),
 * and printRules(parseRules(t)) is the canonical text of t.
 */
import { DEFAULT_TOKEN_DECIMALS, PXR1 } from "../constants.js";
import { type Address, isAddress, toAddress } from "../bytes.js";
import { DslError, ProgError } from "../errors.js";
import type { Amount, Cond } from "../cond/ast.js";
import {
  type Cursor,
  type Line,
  type Tok,
  atTok,
  cursorOf,
  lex,
  lineError,
  parseCond,
  printCond,
  readDuration,
  readInt,
  readNameList,
  readQuantity,
  statements,
} from "../dsl/core.js";
import { formatBps, formatDuration, formatTokens, scaleDecimal, parseDecimal } from "../units.js";
import { ruleCode, ruleCodeName } from "./codes.js";
import { compileRules, isLabel, normalizeRules, type Rule, type RuleKey, type RuleSet } from "./model.js";

export interface ParseRulesOptions {
  /** The launch's guard length; a `guard` line must agree with it. */
  guardSecs?: number;
  /** Token decimals for "tokens" amounts when the text has no `decimals` line (default 6). */
  tokenDecimals?: number;
}

export type ParseRulesResult = { ok: true; rules: RuleSet } | { ok: false; errors: DslError[] };

const LEAF_HINT = "conditions: buy, p2p, time < 2m, time >= 2m, amount > 1%, balance > 1%, to in {name}, from in {name}, program in {name}, instructions > 10, not, and, or";

interface State {
  dec: number;
  keys: Map<string, { address: Address; tok: Tok; used: boolean }>;
}

function readAmount(c: Cursor, st: State, what: string): Amount {
  const q = readQuantity(c, what);
  const d = parseDecimal(q.num)!;
  switch (q.unit) {
    case "%":
      if (d.scale > 2) c.fail(`${what}: percentages go in steps of 0.01%`, undefined, q.tok);
      return checkBps(c, Number(scaleDecimal(d, 2, what)), q.tok, what);
    case "bps":
      if (d.scale > 0) c.fail(`${what}: bps must be a whole number`, undefined, q.tok);
      return checkBps(c, Number(d.num), q.tok, what);
    case "token":
    case "tokens":
      return { raw: atTok(q.tok, () => scaleDecimal(d, st.dec, what)) };
    case "unit":
    case "units":
      if (d.scale > 0) c.fail(`${what}: units are whole numbers`, undefined, q.tok);
      return { raw: d.num };
    case "":
      return c.fail(`${what}: "${q.num}" needs a unit`, `write ${q.num}%, ${q.num}bps or ${q.num} tokens`, q.tok);
    default:
      return c.fail(`${what}: unknown unit "${q.unit}"`, "use %, bps, tokens or units", q.tok);
  }
}

function checkBps(c: Cursor, bps: number, t: Tok, what: string): Amount {
  if (bps < 1 || bps > 10_000) c.fail(`${what}: a share of supply must be between 0.01% and 100%`, undefined, t);
  return { bps };
}

function ruleLeaf(st: State) {
  return (c: Cursor): Cond | null => {
    const t = c.peek();
    if (!t || t.kind !== "atom") return null;
    const w = t.text.toLowerCase();
    switch (w) {
      case "buy":
      case "buys":
        c.next();
        return { op: "buy" };
      case "p2p":
        c.next();
        return { op: "p2p" };
      case "time": {
        c.next();
        const op = c.next();
        if (op.text !== "<" && op.text !== ">=") c.fail(`"time" compares with < or >= only`, "e.g. time < 2m or time >= 10m", op);
        const secs = readDuration(c, "time");
        return { op: op.text === "<" ? "timeLt" : "timeGe", secs };
      }
      case "amount":
      case "balance": {
        c.next();
        const op = c.next();
        if (op.text !== ">") c.fail(`"${w}" compares with > only`, `e.g. ${w} > 1% (use "not" for the opposite)`, op);
        const amount = readAmount(c, st, w);
        return { op: w === "amount" ? "amountGt" : "balanceGt", amount };
      }
      case "instructions": {
        c.next();
        const op = c.next();
        if (op.text !== ">") c.fail(`"instructions" compares with > only`, "e.g. instructions > 10", op);
        return { op: "ixCountGt", n: readInt(c, "instruction count") };
      }
      case "to":
      case "from":
      case "program": {
        c.next();
        c.expect("in", `write ${w} in {name}`);
        const names = readNameList(c, w);
        const keys = names.map((n) => {
          const k = st.keys.get(n.text);
          if (k) {
            k.used = true;
            return k.address;
          }
          if (isAddress(n.text)) c.fail(`write addresses as named keys`, `add "key name = ${n.text}" above, then use the name`, n);
          return c.fail(`"${n.text}" is not a declared key`, `add "key ${n.text} = <address>" above`, n);
        });
        return { op: w === "to" ? "toIn" : w === "from" ? "fromIn" : "programIn", keys };
      }
      default:
        return null;
    }
  };
}

/**
 * A rule's window. "always", "after D" and "from D to end" last until the
 * guard ends (`to: null`, which follows the guard if it changes); "first D"
 * and "from D to E" keep their explicit end, even when it equals the guard
 * (review U15: an explicit "first 6h" never silently becomes "always").
 */
function parseWindow(c: Cursor, _guard: number | undefined): { from: number; to: number | null } {
  const t = c.next();
  const w = t.text.toLowerCase();
  const end = (): number | null => null;
  switch (w) {
    case "always":
      return { from: 0, to: end() };
    case "first":
    case "until":
      return { from: 0, to: readDuration(c, w) };
    case "after":
      return { from: readDuration(c, "after"), to: end() };
    case "from": {
      const from = readDuration(c, "from");
      c.expect("to", "write from 2m to 10m");
      if (c.eat("end")) return { from, to: end() };
      return { from, to: readDuration(c, "to") };
    }
    default:
      return c.fail(`expected a rule starting with always, first, after or from`, "e.g. first 2m: deny when buy and instructions > 10", t);
  }
}

function parseRule(c: Cursor, st: State, guard: number | undefined): Rule {
  const first = c.peek()!;
  const win = parseWindow(c, guard);
  if (win.to !== null && win.from >= win.to) c.fail("the window ends before it starts", undefined, first);
  if (guard !== undefined && win.to !== null && win.to > guard) {
    c.fail(`the window goes past the end of the launch guard (${formatDuration(guard)})`, undefined, first);
  }
  c.expect(":", "put a colon after the time window, e.g. first 2m: deny ...");
  const e = c.next();
  const ew = e.text.toLowerCase();
  let rule: Rule;
  if (ew === "deny" || ew === "block") {
    rule = { ...win, effect: "deny", when: { op: "true" }, code: 0 };
  } else if (ew === "max" || ew === "cap") {
    const what = c.next();
    const ww = what.text.toLowerCase();
    if (ww !== "amount" && ww !== "balance") c.fail(`after "${ew}" write amount or balance`, `e.g. ${ew} amount 0.5%`, what);
    const cap = readAmount(c, st, `${ww} cap`);
    if ("raw" in cap && cap.raw === 0n) c.fail("a cap must be more than zero", undefined, what);
    rule = { ...win, effect: ww === "amount" ? "capAmount" : "capBalance", cap, when: { op: "true" }, code: 0 };
  } else {
    return c.fail(`expected deny, max amount or max balance`, undefined, e);
  }
  if (c.eat("when")) rule.when = parseCond(c, ruleLeaf(st), LEAF_HINT);
  if (c.eat("code")) {
    const t = c.next();
    rule.code = atTok(t, () => ruleCode(/^\d+$/.test(t.text) ? Number(t.text) : (t.text as never)));
  }
  c.expectEnd(`after the condition you can only add "code NAME"`);
  return rule;
}

/** Parses rules text, collecting every error (one per statement) instead of stopping at the first. */
export function tryParseRules(text: string, opts: ParseRulesOptions = {}): ParseRulesResult {
  const errors: DslError[] = [];
  const st: State = { dec: opts.tokenDecimals ?? DEFAULT_TOKEN_DECIMALS, keys: new Map() };
  let guard = opts.guardSecs;
  let decimalsSet: number | undefined;
  const rules: Rule[] = [];
  const ruleLines: Line[] = [];
  const stmts = statements(lex(text));
  let headerSeen = false;
  stmts.forEach((lines, si) => {
    const c = cursorOf(lines);
    const head = c.peek()!;
    const w = head.text.toLowerCase();
    try {
      if (lines[0]!.indented) throw lineError(lines[0]!, "this line is indented but there is nothing to continue");
      if (w === "rules") {
        if (headerSeen || si !== 0) c.fail(`"rules v1" goes on the first line only`, undefined, head);
        headerSeen = true;
        c.next();
        const v = c.next();
        if (v.text.toLowerCase() !== "v1") c.fail(`unsupported version "${v.text}"`, "this is rules v1", v);
        c.expectEnd();
      } else if (w === "guard") {
        c.next();
        const t = c.peek();
        const g = readDuration(c, "guard");
        c.expectEnd();
        if (g < 1 || g > PXR1.MAX_GUARD_SECS) c.fail(`the launch guard lasts 1s to 72h`, undefined, t);
        if (opts.guardSecs !== undefined && g !== opts.guardSecs) {
          c.fail(`this says guard ${formatDuration(g)} but the launch's guard is ${formatDuration(opts.guardSecs)}`, undefined, t);
        }
        if (rules.length > 0) c.fail(`put "guard" above the rules`, undefined, head);
        guard = g;
      } else if (w === "decimals") {
        c.next();
        const t = c.peek();
        const d = readInt(c, "decimals");
        c.expectEnd();
        if (d > 18) c.fail("decimals must be 0..=18", undefined, t);
        if (rules.length > 0) c.fail(`put "decimals" above the rules`, undefined, head);
        st.dec = d;
        decimalsSet = d;
      } else if (w === "key") {
        c.next();
        const name = c.next();
        if (!isLabel(name.text)) c.fail(`"${name.text}" can't be a key name`, "use letters, digits, _ and -, starting with a letter", name);
        if (st.keys.has(name.text)) c.fail(`key "${name.text}" is declared twice`, undefined, name);
        c.expect("=", `write key ${name.text} = <address>`);
        const addr = c.next();
        if (!isAddress(addr.text)) c.fail(`"${addr.text}" is not a Solana address`, undefined, addr);
        c.expectEnd();
        const address = toAddress(addr.text);
        for (const [n, k] of st.keys) if (k.address === address) c.fail(`this address is already declared as "${n}"`, undefined, addr);
        st.keys.set(name.text, { address, tok: name, used: false });
      } else {
        rules.push(parseRule(c, st, guard));
        ruleLines.push(lines[0]!);
      }
    } catch (e) {
      if (e instanceof DslError) errors.push(e);
      else throw e;
    }
  });
  for (const [n, k] of st.keys) {
    if (!k.used) errors.push(new DslError(`key "${n}" is never used`, k.tok.line, k.tok.col, k.tok.offset, n.length, "remove it or use it in a rule"));
  }
  if (errors.length === 0 && rules.length === 0) {
    errors.push(new DslError("there are no rules yet", 1, 1, 0, 1, "e.g. first 2m: deny when buy and instructions > 10"));
  }
  if (errors.length > 0) return { ok: false, errors: sortErrors(errors) };
  const keys: RuleKey[] = [...st.keys].map(([label, k]) => ({ address: k.address, label }));
  const set: RuleSet = { keys, rules };
  if (guard !== undefined) set.guardSecs = guard;
  if (decimalsSet !== undefined) set.tokenDecimals = decimalsSet;
  // whole-set limits and the verifier, mapped back to the offending line
  try {
    if (guard !== undefined) compileRules(set);
    else checkLimitsWithoutGuard(set);
  } catch (e) {
    if (e instanceof ProgError) {
      const l = e.at.rule !== undefined ? ruleLines[e.at.rule] : ruleLines[ruleLines.length - 1];
      return { ok: false, errors: [lineError(l ?? ruleLines[0]!, e.message)] };
    }
    throw e;
  }
  return { ok: true, rules: normalizeRules(set, { keepOpenEnds: true }) };
}

function checkLimitsWithoutGuard(set: RuleSet): void {
  // Without a guard length, compile against the 72 h maximum for "always"/"after" rules.
  const filled: RuleSet = { ...set, rules: set.rules.map((r) => ({ ...r, to: r.to ?? PXR1.MAX_GUARD_SECS })) };
  compileRules(filled, { guardSecs: PXR1.MAX_GUARD_SECS });
}

function sortErrors(es: DslError[]): DslError[] {
  return es.sort((a, b) => a.offset - b.offset);
}

/** Parses rules text; throws the first DslError. */
export function parseRules(text: string, opts: ParseRulesOptions = {}): RuleSet {
  const r = tryParseRules(text, opts);
  if (!r.ok) throw r.errors[0]!;
  return r.rules;
}

// ------------------------------------------------------------ printer ---

function printAmount(a: Amount, dec: number): string {
  if ("bps" in a) return formatBps(a.bps);
  if ("tokens" in a) return `${a.tokens} tokens`;
  return `${formatTokens(a.raw, dec)} tokens`;
}

/**
 * Canonical text of a rule set (normalizes first; unnamed keys become key1,
 * key2, ...). An open-ended window prints as always / after / "to end"; an
 * explicit end stays explicit even when it equals the guard.
 */
export function printRules(input: RuleSet): string {
  const set = normalizeRules(input, { keepOpenEnds: true });
  const dec = set.tokenDecimals ?? DEFAULT_TOKEN_DECIMALS;
  const names = new Map<Address, string>();
  const taken = new Set(set.keys.flatMap((k) => (k.label ? [k.label] : [])));
  let n = 1;
  for (const k of set.keys) {
    if (k.label) names.set(k.address, k.label);
    else {
      while (taken.has(`key${n}`)) n++;
      names.set(k.address, `key${n}`);
      taken.add(`key${n}`);
    }
  }
  const out: string[] = ["rules v1"];
  if (set.guardSecs !== undefined) out.push(`guard ${formatDuration(set.guardSecs)}`);
  if (set.tokenDecimals !== undefined) out.push(`decimals ${set.tokenDecimals}`);
  for (const k of set.keys) out.push(`key ${names.get(k.address)} = ${k.address}`);
  out.push("");
  const leaf = (c: Cond): string => {
    switch (c.op) {
      case "buy":
        return "buy";
      case "p2p":
        return "p2p";
      case "timeLt":
        return `time < ${formatDuration(c.secs)}`;
      case "timeGe":
        return `time >= ${formatDuration(c.secs)}`;
      case "amountGt":
        return `amount > ${printAmount(c.amount, dec)}`;
      case "balanceGt":
        return `balance > ${printAmount(c.amount, dec)}`;
      case "ixCountGt":
        return `instructions > ${c.n}`;
      case "toIn":
      case "fromIn":
      case "programIn": {
        const w = c.op === "toIn" ? "to" : c.op === "fromIn" ? "from" : "program";
        return `${w} in {${c.keys.map((k) => names.get(k) ?? k).join(", ")}}`;
      }
      default:
        throw new ProgError("WrongContext", `"${c.op}" is an autopilot condition; it can't be used in a launch rule`);
    }
  };
  set.rules.forEach((r) => {
    // Only an open end ("until the guard ends": `to: null`) prints as always / after / to end:
    // an explicit end stays explicit, even when it equals the guard (review U15). Normalizing resolves null to the guard.
    const toEnd = r.to === null;
    const win =
      r.from === 0 && toEnd
        ? "always"
        : r.from === 0
          ? `first ${formatDuration(r.to!)}`
          : toEnd
            ? `after ${formatDuration(r.from)}`
            : `from ${formatDuration(r.from)} to ${formatDuration(r.to!)}`;
    const eff = r.effect === "deny" ? "deny" : `max ${r.effect === "capAmount" ? "amount" : "balance"} ${printAmount(r.cap!, dec)}`;
    const cond = r.when.op === "true" ? "" : ` when ${printCond(r.when, leaf)}`;
    const code = r.code === 0 ? "" : ` code ${ruleCodeName(r.code) ?? r.code}`;
    out.push(`${win}: ${eff}${cond}${code}`);
  });
  return out.join("\n") + "\n";
}

/**
 * Launch rules in plain English, one line per rule (plus the guarantees).
 *
 * The lines say exactly what the hook enforces and no more (review U14):
 * - every wallet and app is named by its address, with the creator's label
 *   in quotes next to it ("team" is only what the creator called it); an
 *   app (top-level program) is named only when its address is a well-known
 *   program (`KNOWN_PROGRAMS`), never by a free label;
 * - balance caps limit what a transfer leaves in the receiving account, not
 *   what a person holds (anyone can use several wallets);
 * - a rule's display code becomes the sentence holders see when it refuses
 *   (`RULE_CODE_TEXT`), not a tag.
 */
import { DEFAULT_TOKEN_DECIMALS, KNOWN_PROGRAMS, NOISED_SHIELD_PROGRAM, NOISED_VAULT_PROGRAM, RULE_CODE_TEXT } from "../constants.js";
import { shortAddress } from "../bytes.js";
import { type Amount, type Cond, checkCondSize } from "../cond/ast.js";
import { formatBps, formatDurationLong, formatPeriod, formatTokens } from "../units.js";
import { decompileRules, type Rule, type RuleSet, type RulesDecompileOptions } from "./model.js";

export interface ExplainRulesOptions extends RulesDecompileOptions {
  /** Append the always-true guarantees (sells allowed, rules end with the guard, never apply to the Noised vault or shield, only refuse). Default true. */
  guarantees?: boolean;
  /** How addresses appear: "full" (default; what a review or token page shows) or "short" (`7xKX…AsU`, for tight layouts). */
  addresses?: "full" | "short";
}

interface Ctx {
  set: RuleSet;
  dec: number;
  addresses: "full" | "short";
}

const cap1 = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** "at least 1 minute has passed" / "at least 2 minutes have passed". */
const passed = (secs: number): string => {
  const d = formatDurationLong(secs);
  return `${d} ${/^1 [a-z]+$/.test(d) ? "has" : "have"} passed`;
};

function amountText(a: Amount, ctx: Ctx): string {
  if ("bps" in a) return `${formatBps(a.bps)} of the supply`;
  if ("tokens" in a) return `${a.tokens} tokens`;
  return `${formatTokens(a.raw, ctx.dec, true)} tokens`;
}

const addr = (a: string, ctx: Ctx): string => (ctx.addresses === "full" ? a : shortAddress(a));

/** A wallet: its address, with the creator's label in quotes when there is one. */
function walletText(k: string, ctx: Ctx): string {
  const e = ctx.set.keys.find((x) => x.address === k || x.label === k);
  const a = e?.address ?? k;
  return e?.label !== undefined ? `“${e.label}” (${addr(a, ctx)})` : addr(a, ctx);
}

/** Noised's holder programs, by name (rules never apply to moves made through them). */
const NOISED_PROGRAMS: Readonly<Record<string, string>> = {
  [NOISED_VAULT_PROGRAM]: "the Noised vault",
  [NOISED_SHIELD_PROGRAM]: "the Noised shield",
};

/** An app (top-level program): a well-known program's name with its address, else the address alone. */
function appText(k: string, ctx: Ctx): string {
  const e = ctx.set.keys.find((x) => x.address === k || x.label === k);
  const a = e?.address ?? k;
  const known = KNOWN_PROGRAMS[a] ?? NOISED_PROGRAMS[a];
  return known !== undefined ? `${known} (${addr(a, ctx)})` : `the program ${addr(a, ctx)}`;
}

function listText(names: string[]): string {
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} or ${names[1]}`;
  return `one of ${names.join(", ")}`;
}

function leafText(c: Cond, neg: boolean, ctx: Ctx): string | null {
  switch (c.op) {
    case "true":
      return neg ? "never" : "always";
    case "false":
      return neg ? "always" : "never";
    case "buy":
      return neg ? "it's not a buy from the pool" : "it's a buy from the pool";
    case "p2p":
      return neg ? "it's not a wallet-to-wallet transfer" : "it's a wallet-to-wallet transfer";
    case "timeLt":
      return neg ? `at least ${passed(c.secs)}` : `it's within the first ${formatPeriod(c.secs)}`;
    case "timeGe":
      return neg ? `it's within the first ${formatPeriod(c.secs)}` : `at least ${passed(c.secs)}`;
    case "amountGt":
      return `the transfer is ${neg ? "at most" : "more than"} ${amountText(c.amount, ctx)}`;
    case "balanceGt":
      return `the receiving account would hold ${neg ? "at most" : "more than"} ${amountText(c.amount, ctx)}`;
    case "toIn":
      return `the receiving wallet is ${neg ? "not " : ""}${listText(c.keys.map((k) => walletText(k, ctx)))}`;
    case "fromIn":
      return `the sending wallet is ${neg ? "not " : ""}${listText(c.keys.map((k) => walletText(k, ctx)))}`;
    case "programIn":
      return `it's ${neg ? "not " : ""}made through ${listText(c.keys.map((k) => appText(k, ctx)))}`;
    case "ixCountGt":
      return `the transaction has ${neg ? "at most" : "more than"} ${c.n} instruction${c.n === 1 ? "" : "s"}`;
    default:
      return null;
  }
}

/** A condition as an English clause ("it's a buy and the transaction has more than 10 instructions"). */
export function condText(c: Cond, ctx: Ctx): string {
  const leaf = leafText(c, false, ctx);
  if (leaf !== null) return leaf;
  switch (c.op) {
    case "not": {
      const l = leafText(c.x, true, ctx);
      return l ?? `not (${condText(c.x, ctx)})`;
    }
    case "and":
    case "or": {
      const side = (x: Cond): string => {
        const t = condText(x, ctx);
        return (x.op === "and" || x.op === "or") && x.op !== c.op ? `(${t})` : t;
      };
      return `${side(c.a)} ${c.op} ${side(c.b)}`;
    }
    default:
      return c.op; // graph leaves never reach here (compile rejects them)
  }
}

function windowText(from: number, to: number | null, guard: number | undefined): string {
  const toEnd = to === null || (guard !== undefined && to >= guard);
  if (from === 0 && toEnd) {
    return guard !== undefined ? `During the launch guard (the first ${formatPeriod(guard)})` : "During the launch guard";
  }
  if (from === 0) return `In the first ${formatPeriod(to!)}`;
  if (toEnd) return `From ${formatDurationLong(from)} after launch until the guard ends`;
  return `Between ${formatDurationLong(from)} and ${formatDurationLong(to!)} after launch`;
}

/** The conjuncts of a top-level AND chain. */
function conjuncts(c: Cond): Cond[] {
  return c.op === "and" ? [...conjuncts(c.a), ...conjuncts(c.b)] : [c];
}

/**
 * Splits a condition for display: the transfer kind (buy / p2p) and time
 * bounds of a top-level AND chain move into the sentence's subject and time
 * window; the rest stays a clause. Display only — the meaning is unchanged.
 */
function shape(r: Rule): { kind: "buy" | "p2p" | null; from: number; to: number | null; rest: Cond | null } {
  let from = r.from;
  let to = r.to;
  let kind: "buy" | "p2p" | null = null;
  const rest: Cond[] = [];
  for (const p of r.when.op === "true" ? [] : conjuncts(r.when)) {
    if ((p.op === "buy" || p.op === "p2p") && (kind === null || kind === p.op)) kind = p.op;
    else if (p.op === "timeLt") to = to === null ? p.secs : Math.min(to, p.secs);
    else if (p.op === "timeGe") from = Math.max(from, p.secs);
    else rest.push(p);
  }
  const joined = rest.length === 0 ? null : rest.slice(1).reduce<Cond>((a, b) => ({ op: "and", a, b }), rest[0]!);
  return { kind, from, to, rest: joined };
}

/** What holders see when a rule with this code refuses: the code's sentence, or the generic one. */
function codeSentence(code: number): string {
  const text = RULE_CODE_TEXT[code] ?? RULE_CODE_TEXT[0]!;
  return ` A refused transfer shows: “${text}”.`;
}

function explainWith(set: RuleSet, index: number, addresses: "full" | "short"): string {
  const r = set.rules[index]!;
  checkCondSize(r.when);
  const ctx: Ctx = { set, dec: set.tokenDecimals ?? DEFAULT_TOKEN_DECIMALS, addresses };
  const { kind, from, to, rest } = shape(r);
  const code = r.code !== 0 ? codeSentence(r.code) : "";
  if (to !== null && from >= to) return `Rule ${index + 1} can never apply: its time window is empty.`;
  const w = windowText(from, to, set.guardSecs);
  const restText = rest ? condText(rest, ctx) : "";
  let body: string;
  if (r.effect === "deny") {
    if (kind === "buy") body = rest ? `buys from the pool are refused when ${restText}` : "all buys from the pool are refused";
    else if (kind === "p2p") body = rest ? `wallet-to-wallet transfers are refused when ${restText}` : "wallet-to-wallet transfers are refused";
    else body = rest ? `a transfer (other than a sell) is refused when ${restText}` : "buys and wallet-to-wallet transfers are refused (sells still work)";
  } else {
    const capText = amountText(r.cap!, ctx);
    const what = kind === "buy" ? "a single buy" : kind === "p2p" ? "a single wallet-to-wallet transfer" : "a single transfer";
    const verb =
      r.effect === "capAmount"
        ? `${what} can't be more than ${capText}`
        : `${kind === "buy" ? "a buy" : kind === "p2p" ? "a wallet-to-wallet transfer" : "a transfer"} can't leave the receiving account with more than ${capText}`;
    body = rest ? `when ${restText}, ${verb}` : verb;
  }
  return `${w}: ${body}.${code}`;
}

/** One rule as a sentence (addresses in full). */
export function explainRule(set: RuleSet, index: number, opts: { addresses?: "full" | "short" } = {}): string {
  return cap1(explainWith(set, index, opts.addresses ?? "full"));
}

/**
 * Plain-English lines for a rule set (model or PXR1 bytes): one per rule,
 * then the guarantees every Noised launch keeps whatever the rules say.
 */
export function explainRules(rules: RuleSet | Uint8Array, opts: ExplainRulesOptions = {}): string[] {
  const set = rules instanceof Uint8Array ? decompileRules(rules, opts) : rules;
  const withGuard: RuleSet = opts.guardSecs !== undefined && set.guardSecs === undefined ? { ...set, guardSecs: opts.guardSecs } : set;
  const lines = withGuard.rules.map((_, i) => explainWith(withGuard, i, opts.addresses ?? "full"));
  if (opts.guarantees ?? true) {
    lines.push("Selling is always allowed: no rule can block a sell.");
    lines.push(
      withGuard.guardSecs !== undefined
        ? `Every rule switches off for good ${formatDurationLong(withGuard.guardSecs)} after launch.`
        : "Every rule switches off for good when the launch guard ends (72 hours at most).",
    );
    // Directly: the hook skips the rules when the vault or shield is the transaction's top-level
    // instruction; reached through another program, the rules still apply (rules.rs creator_rules).
    lines.push("Rules never apply to holders using the Noised vault or shield directly (the built-in launch guard still does).");
    lines.push("Rules can only refuse a transfer. They can never move, freeze or take anyone's tokens.");
  }
  return lines.map(cap1);
}

/**
 * Sentence blocks for launch rules (PROGRAMMABLE_V1 §6): the no-code form of
 * one PXR1 rule. A block reads like a sentence:
 *
 *   During the first [2 min] · [block] · [buys] · when [more than 3 instructions]
 *
 * and converts exactly to the SDK's rule tree (`when` = the "who" leaf AND
 * every extra condition, in order). A rule from code that is not exactly
 * that shape (an OR, a NOT around anything but a wallet / app list, a time
 * leaf inside the condition, ...) stays a code-only rule: it is shown in
 * plain English and edited in the Code tab, never silently rewritten.
 *
 * Pure (no React): test/rules-blocks.test.ts checks blocks -> rule -> block
 * and blocks -> code text -> blocks round trips.
 */
import type { Amount, Cond, Rule, RuleEffect } from "../../../lib/programmable";

/** Which transfers a rule looks at. Sells are never restricted, so they are not offered. */
export type Who = "buys" | "p2p" | "all";

/** An amount as typed: a share of supply ("0.5" with unit "pct") or whole tokens. */
export interface AmountText {
  value: string;
  unit: "pct" | "tokens";
}

export type Extra =
  | { kind: "ixCountGt"; n: string }
  | { kind: "amountGt"; amount: AmountText }
  | { kind: "balanceGt"; amount: AmountText }
  | { kind: "toIn"; keys: string[] }
  | { kind: "toNotIn"; keys: string[] }
  | { kind: "fromIn"; keys: string[] }
  | { kind: "fromNotIn"; keys: string[] }
  | { kind: "programIn"; keys: string[] }
  | { kind: "programNotIn"; keys: string[] };

export type ExtraKind = Extra["kind"];

export type WindowMode = "first" | "between" | "whole";

export interface RuleBlock {
  /** "first": 0 .. to; "between": from .. to; "whole": 0 .. the guard's end (follows the guard length). Seconds after open. */
  window: WindowMode;
  fromSecs: number;
  toSecs: number;
  effect: RuleEffect;
  /** Cap for "capAmount" / "capBalance" (ignored for "deny"). */
  cap: AmountText;
  who: Who;
  extras: Extra[];
  /** The reason code shown to holders when the rule refuses (0..63). */
  code: number;
}

/** One rule in the editor: a sentence block, or a rule that only code can express. */
export type RuleItem = { id: string; block: RuleBlock } | { id: string; code: Rule };

export const EXTRA_LABELS: Record<ExtraKind, string> = {
  ixCountGt: "the transaction has more than … instructions",
  amountGt: "it moves more than …",
  balanceGt: "the receiver would hold more than …",
  toIn: "it goes to one of these wallets",
  toNotIn: "it goes to a wallet not on this list",
  fromIn: "it comes from one of these wallets",
  fromNotIn: "it comes from a wallet not on this list",
  programIn: "it is sent through one of these apps",
  programNotIn: "it is sent through an app not on this list",
};

export const WHO_LABELS: Record<Who, string> = {
  buys: "buys",
  p2p: "wallet-to-wallet transfers",
  all: "all transfers except sells",
};

export const EFFECT_LABELS: Record<RuleEffect, string> = {
  deny: "block",
  capAmount: "limit each transfer to",
  capBalance: "limit what a wallet can hold to",
};

export function newExtra(kind: ExtraKind): Extra {
  switch (kind) {
    case "ixCountGt":
      // Ordinary buys use up to about 8 top-level instructions; bundles use more.
      return { kind, n: "10" };
    case "amountGt":
    case "balanceGt":
      return { kind, amount: { value: "0.5", unit: "pct" } };
    default:
      return { kind, keys: [] };
  }
}

export function defaultBlock(guardSecs: number): RuleBlock {
  return {
    window: "first",
    fromSecs: 0,
    toSecs: Math.min(600, guardSecs),
    effect: "deny",
    cap: { value: "0.5", unit: "pct" },
    who: "buys",
    extras: [newExtra("ixCountGt")],
    code: 1,
  };
}

/** The window a block covers, as [from, to) seconds after open (`to` null: until the guard ends). */
export function windowOf(b: RuleBlock): { from: number; to: number | null } {
  if (b.window === "whole") return { from: 0, to: null };
  if (b.window === "first") return { from: 0, to: b.toSecs };
  return { from: b.fromSecs, to: b.toSecs };
}

// ------------------------------------------------------------ amounts ---

/** Amount text -> SDK amount. Throws a plain-English error the editor shows under the block. */
export function amountOf(a: AmountText, what: string): Amount {
  const v = a.value.trim();
  if (v === "" || !/^\d+(\.\d+)?$/.test(v)) throw new Error(`${what}: enter a number`);
  if (a.unit === "tokens") {
    if (Number(v) <= 0) throw new Error(`${what}: must be more than 0`);
    return { tokens: v };
  }
  // A share of supply in bps: two decimals of a percent at most.
  const [int = "0", frac = ""] = v.split(".");
  if (frac.length > 2) throw new Error(`${what}: at most two decimals (0.01% steps)`);
  const bps = Number(int) * 100 + Number(frac.padEnd(2, "0"));
  if (bps < 1 || bps > 10_000) throw new Error(`${what}: between 0.01% and 100% of supply`);
  return { bps };
}

/** SDK amount -> amount text (raw units shown as whole tokens with `decimals`). */
export function amountText(a: Amount, decimals: number): AmountText {
  if ("bps" in a) {
    const pct = a.bps / 100;
    return { value: Number.isInteger(pct) ? String(pct) : pct.toFixed(2).replace(/0$/, ""), unit: "pct" };
  }
  if ("tokens" in a) return { value: a.tokens, unit: "tokens" };
  return { value: unitsText(a.raw, decimals), unit: "tokens" };
}

function unitsText(raw: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const int = raw / base;
  const frac = (raw % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac === "" ? int.toString() : `${int}.${frac}`;
}

// --------------------------------------------------------- block -> rule ---

function extraCond(x: Extra): Cond {
  switch (x.kind) {
    case "ixCountGt": {
      const n = Number(x.n.trim());
      if (!/^\d+$/.test(x.n.trim()) || !Number.isSafeInteger(n) || n > 255) throw new Error("Instruction count: a whole number from 0 to 255");
      return { op: "ixCountGt", n };
    }
    case "amountGt":
      return { op: "amountGt", amount: amountOf(x.amount, "Amount") };
    case "balanceGt":
      return { op: "balanceGt", amount: amountOf(x.amount, "Balance") };
    case "toIn":
    case "fromIn":
    case "programIn":
    case "toNotIn":
    case "fromNotIn":
    case "programNotIn": {
      if (x.keys.length === 0) throw new Error(x.kind.startsWith("program") ? "Add at least one app (program address)" : "Add at least one wallet");
      const op = x.kind.startsWith("to") ? "toIn" : x.kind.startsWith("from") ? "fromIn" : "programIn";
      const leaf: Cond = { op, keys: [...x.keys] };
      return x.kind.endsWith("NotIn") ? { op: "not", x: leaf } : leaf;
    }
  }
}

/** The block as an SDK rule. Throws a plain-English error for an incomplete block. */
export function blockToRule(b: RuleBlock): Rule {
  const { from, to } = windowOf(b);
  const parts: Cond[] = [];
  if (b.who === "buys") parts.push({ op: "buy" });
  if (b.who === "p2p") parts.push({ op: "p2p" });
  for (const x of b.extras) parts.push(extraCond(x));
  const when: Cond = parts.length === 0 ? { op: "true" } : parts.slice(1).reduce<Cond>((acc, c) => ({ op: "and", a: acc, b: c }), parts[0] as Cond);
  const rule: Rule = { from, to, effect: b.effect, when, code: b.code };
  if (b.effect !== "deny") rule.cap = amountOf(b.cap, b.effect === "capAmount" ? "Limit per transfer" : "Wallet limit");
  return rule;
}

// --------------------------------------------------------- rule -> block ---

/** The AND chain of a condition, left to right (a single non-AND leaf is a chain of one). */
function andChain(c: Cond): Cond[] {
  return c.op === "and" ? [...andChain(c.a), ...andChain(c.b)] : [c];
}

function extraOf(c: Cond, decimals: number): Extra | null {
  switch (c.op) {
    case "ixCountGt":
      return { kind: "ixCountGt", n: String(c.n) };
    case "amountGt":
      return { kind: "amountGt", amount: amountText(c.amount, decimals) };
    case "balanceGt":
      return { kind: "balanceGt", amount: amountText(c.amount, decimals) };
    case "toIn":
      return { kind: "toIn", keys: [...c.keys] };
    case "fromIn":
      return { kind: "fromIn", keys: [...c.keys] };
    case "programIn":
      return { kind: "programIn", keys: [...c.keys] };
    case "not": {
      const x = c.x;
      if (x.op === "toIn") return { kind: "toNotIn", keys: [...x.keys] };
      if (x.op === "fromIn") return { kind: "fromNotIn", keys: [...x.keys] };
      if (x.op === "programIn") return { kind: "programNotIn", keys: [...x.keys] };
      return null;
    }
    default:
      return null;
  }
}

/**
 * A rule as a sentence block, or null when blocks cannot express it exactly. The chain must be a left-leaning AND
 * whose first leaf may be "buy" or "p2p" (the who), followed by known extras; anything else stays code.
 */
export function ruleToBlock(r: Rule, guardSecs: number, decimals: number): RuleBlock | null {
  const chain = r.when.op === "true" ? [] : andChain(r.when);
  // The left-leaning shape blockToRule builds: rebuilding from the chain must give the same tree.
  const rebuilt = chain.length === 0 ? ({ op: "true" } as Cond) : chain.slice(1).reduce<Cond>((acc, c) => ({ op: "and", a: acc, b: c }), chain[0] as Cond);
  if (!sameCond(rebuilt, r.when)) return null;
  let who: Who = "all";
  let rest = chain;
  const first = chain[0];
  if (first?.op === "buy") {
    who = "buys";
    rest = chain.slice(1);
  } else if (first?.op === "p2p") {
    who = "p2p";
    rest = chain.slice(1);
  }
  const extras: Extra[] = [];
  for (const c of rest) {
    const x = extraOf(c, decimals);
    if (x === null) return null;
    extras.push(x);
  }
  // "all transfers" with no condition is the tree { true }; with conditions the chain carries them.
  if (who === "all" && extras.length === 0 && r.when.op !== "true") return null;
  if (r.effect !== "deny" && r.cap === undefined) return null;
  // "Until the guard ends" is `to: null` in a block and the guard length once code has been parsed.
  // "Until the guard ends" is `to: null` (code: "always"). An explicit end stays explicit even when it equals today's
  // guard length, so a later guard change never stretches it (review U15).
  const window: WindowMode = r.from === 0 && r.to === null ? "whole" : r.from === 0 ? "first" : "between";
  if (window !== "whole" && r.to === null) return null;
  return {
    window,
    fromSecs: r.from,
    toSecs: r.to ?? guardSecs,
    effect: r.effect,
    cap: r.cap === undefined ? { value: "0.5", unit: "pct" } : amountText(r.cap, decimals),
    who,
    extras,
    code: r.code,
  };
}

/** Structural equality of two condition trees (amounts compared by their fields). */
export function sameCond(a: Cond, b: Cond): boolean {
  return JSON.stringify(a, bigintSafe) === JSON.stringify(b, bigintSafe);
}

function bigintSafe(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? `${v}n` : v;
}

/** Items from SDK rules: each becomes a block when it can, else a code-only rule. */
export function itemsFromRules(rules: readonly Rule[], guardSecs: number, decimals: number, ids: () => string): RuleItem[] {
  return rules.map((r) => {
    const block = ruleToBlock(r, guardSecs, decimals);
    return block !== null ? { id: ids(), block } : { id: ids(), code: r };
  });
}

/** SDK rules from items, with the first problem of each block (by item id). */
export function rulesFromItems(items: readonly RuleItem[]): { rules: Rule[]; problems: Map<string, string> } {
  const rules: Rule[] = [];
  const problems = new Map<string, string>();
  for (const it of items) {
    if ("code" in it) {
      rules.push(it.code);
      continue;
    }
    try {
      rules.push(blockToRule(it.block));
    } catch (e) {
      problems.set(it.id, e instanceof Error ? e.message : String(e));
    }
  }
  return { rules, problems };
}

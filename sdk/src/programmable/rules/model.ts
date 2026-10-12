/**
 * Launch rules as data (what the block builder, the text DSL and the code
 * builder all produce), and the exact mapping to / from PXR1 bytes.
 */
import { DEFAULT_TOKEN_DECIMALS, EFFECT, PXR1 } from "../constants.js";
import { type Address, addressBytes, encodeBase58, isAddress, toAddress } from "../bytes.js";
import { ProgError } from "../errors.js";
import {
  type Amount,
  type Cond,
  amountArg,
  argAmount,
  compileCond,
  condKeyRefs,
  decompileCond,
  normalizeCond,
} from "../cond/ast.js";
import type { CondNode } from "../cond/vm.js";
import { encodeRulesRaw, type RawRule, type RawRuleSet, verifyRulesBytes } from "./codec.js";

export type RuleEffect = "deny" | "capAmount" | "capBalance";

/** One launch rule. Times are seconds since the launch opened. */
export interface Rule {
  /** Active from this second (inclusive). */
  from: number;
  /** Active until this second (exclusive); null = until the guard ends. */
  to: number | null;
  /** deny: refuse when `when` holds. capAmount / capBalance: when `when` holds, refuse above `cap`. */
  effect: RuleEffect;
  /** The cap for capAmount (per transfer) / capBalance (receiver's balance after). */
  cap?: Amount;
  /** The condition; { op: "true" } for "always". */
  when: Cond;
  /** 0..=63, shown to the user when this rule refuses (see RULE_CODES). */
  code: number;
}

/** A wallet or program a rule refers to. Labels are for people; only addresses are on-chain. */
export interface RuleKey {
  address: Address;
  label?: string;
}

/** A launch rule set. */
export interface RuleSet {
  /** The launch guard length (launch params). Needed to resolve `to: null` and to verify. */
  guardSecs?: number;
  /** Token decimals, for "tokens" amounts (default 6). */
  tokenDecimals?: number;
  /** Key table, in on-chain order. Keys used in conditions but missing here are appended. */
  keys: RuleKey[];
  rules: Rule[];
}

export interface RulesCompileOptions {
  /** Overrides `set.guardSecs`. */
  guardSecs?: number;
  /**
   * Keep open-ended windows (`to: null`, "until the guard ends") open
   * instead of resolving them to the guard (review U15): what text and code
   * builders return, so "always" keeps following the guard and an explicit
   * "first 6h" stays 6 hours. Compiling resolves them either way.
   */
  keepOpenEnds?: boolean;
}

const LABEL_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** True if `s` can be used as a key label (and in the text DSL). */
export const isLabel = (s: string): boolean => LABEL_RE.test(s) && !isAddress(s);

/**
 * The canonical form of a rule set: labels resolved to addresses, amounts in
 * raw units / bps, key lists in table order, unused keys dropped, windows
 * resolved when the guard length is known. compile(normalize(s)) ===
 * compile(s), and decompile(compile(s)) deep-equals normalize(s).
 */
/** Runs `f` for rule `i`, attributing any ProgError without a position to that rule. */
function atRule<T>(i: number, f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof ProgError && e.at.rule === undefined) {
      throw new ProgError(e.code, e.message.startsWith("rule ") ? e.message : `rule ${i + 1}: ${e.message}`, { ...e.at, rule: i });
    }
    throw e;
  }
}

/** A launch guard length: whole seconds, at most 72 hours (the hook's bound). */
export function checkGuardSecs(g: number): number {
  if (typeof g !== "number" || !Number.isInteger(g) || g < 0 || g > PXR1.MAX_GUARD_SECS) {
    throw new ProgError("BadModel", `the launch guard is whole seconds and lasts at most 72 hours (got ${String(g)})`);
  }
  return g;
}

export function normalizeRules(set: RuleSet, opts: RulesCompileOptions = {}): RuleSet {
  const guardSecs = opts.guardSecs ?? set.guardSecs;
  if (guardSecs !== undefined) checkGuardSecs(guardSecs);
  const dec = set.tokenDecimals ?? DEFAULT_TOKEN_DECIMALS;
  const byLabel = new Map<string, Address>();
  const table: RuleKey[] = [];
  const seen = new Map<Address, number>();
  for (const k of set.keys) {
    const address = toAddress(k.address);
    if (k.label !== undefined) {
      if (!isLabel(k.label)) throw new ProgError("BadModel", `"${k.label}" can't be a key name (letters, digits, _ and -)`);
      if (byLabel.has(k.label) && byLabel.get(k.label) !== address) throw new ProgError("BadModel", `key name "${k.label}" is used twice`);
      byLabel.set(k.label, address);
    }
    if (!seen.has(address)) {
      seen.set(address, table.length);
      table.push(k.label !== undefined ? { address, label: k.label } : { address });
    }
  }
  const resolveKey = (k: string): Address => {
    const l = byLabel.get(k);
    if (l !== undefined) return l;
    if (isAddress(k)) return toAddress(k);
    throw new ProgError("UnknownKey", `"${k}" is not a declared key name or a Solana address`);
  };
  // append keys used but not declared, in first-use order
  for (const [i, r] of set.rules.entries()) {
    for (const ref of atRule(i, () => condKeyRefs(r.when))) {
      const a = atRule(i, () => resolveKey(ref));
      if (!seen.has(a)) {
        seen.set(a, table.length);
        table.push({ address: a });
      }
    }
  }
  const order = (a: Address): number => seen.get(a)!;
  const rules = set.rules.map((r, i): Rule => atRule(i, () => {
    const when = normalizeCond(r.when, { tokenDecimals: dec, resolveKey }, order);
    let to = r.to;
    if (to === null && guardSecs !== undefined && opts.keepOpenEnds !== true) to = guardSecs;
    const out: Rule = { from: r.from, to, effect: r.effect, when, code: r.code };
    if (r.effect !== "deny") {
      if (!r.cap) throw new ProgError("ZeroCap", `rule ${i + 1}: a cap needs an amount`, { rule: i });
      out.cap = argAmount(amountArg(r.cap, dec, "cap"));
    }
    return out;
  }));
  // drop unused keys (the verifier rejects them)
  const used = new Set<Address>();
  for (const r of rules) for (const ref of condKeyRefs(r.when)) used.add(ref);
  const keys = table.filter((k) => used.has(k.address));
  const out: RuleSet = { keys, rules };
  if (guardSecs !== undefined) out.guardSecs = guardSecs;
  if (set.tokenDecimals !== undefined) out.tokenDecimals = set.tokenDecimals;
  return out;
}

function effectByte(e: RuleEffect): number {
  switch (e) {
    case "deny":
      return EFFECT.DENY;
    case "capAmount":
      return EFFECT.CAP_AMOUNT;
    case "capBalance":
      return EFFECT.CAP_DEST_BALANCE;
    default:
      throw new ProgError("UnknownEffect", `unknown effect "${String(e)}" (use deny, capAmount or capBalance)`);
  }
}

/** Model -> raw (normalizes first; checks limits with friendly messages). */
export function rulesToRaw(set: RuleSet, opts: RulesCompileOptions = {}): RawRuleSet {
  const n = normalizeRules(set, opts);
  const dec = n.tokenDecimals ?? DEFAULT_TOKEN_DECIMALS;
  if (n.guardSecs === 0) throw new ProgError("WindowPastGuard", "this launch has no launch guard (0 seconds), so it can't have launch rules");
  if (n.rules.length === 0) throw new ProgError("NoRules", "add at least one rule");
  if (n.rules.length > PXR1.MAX_RULES) throw new ProgError("TooManyRules", `${n.rules.length} rules; the limit is ${PXR1.MAX_RULES}`);
  if (n.keys.length > PXR1.MAX_KEYS) {
    throw new ProgError("TooManyKeys", `${n.keys.length} different wallets/programs; the limit is ${PXR1.MAX_KEYS}`);
  }
  const index = new Map(n.keys.map((k, i) => [k.address, i] as const));
  const nodes: CondNode[] = [];
  const rules: RawRule[] = n.rules.map((r, i) => atRule(i, () => {
    if (r.to === null) {
      throw new ProgError("BadWindow", `rule ${i + 1} runs "until the guard ends" but the guard length isn't known`, { rule: i });
    }
    const cond = compileCond(r.when, { kind: "rules", tokenDecimals: dec, keyIndex: (a) => index.get(a)! });
    const raw: RawRule = {
      fromRel: r.from,
      toRel: r.to,
      condOff: nodes.length,
      condLen: cond.length,
      effect: effectByte(r.effect),
      code: r.code,
      arg: r.effect === "deny" ? 0n : amountArg(r.cap!, dec, "cap"),
    };
    nodes.push(...cond);
    return raw;
  }));
  if (nodes.length > PXR1.MAX_NODES) {
    throw new ProgError("TooManyNodes", `the conditions use ${nodes.length} parts; the limit is ${PXR1.MAX_NODES}`);
  }
  rules.forEach((r, i) => {
    if (!Number.isInteger(r.fromRel) || !Number.isInteger(r.toRel) || r.fromRel < 0 || r.toRel < 0 || r.toRel > 0xffff_ffff) {
      throw new ProgError("BadWindow", `rule ${i + 1}: rule windows are whole seconds`, { rule: i });
    }
    if (!Number.isInteger(r.code) || r.code < 0 || r.code > 255) throw new ProgError("BadCode", `rule ${i + 1}: rule codes are 0..=63`, { rule: i });
  });
  return { keys: n.keys.map((k) => addressBytes(k.address)), rules, nodes };
}

/** Compiles to verified PXR1 bytes; throws ProgError (friendly message) if invalid. */
export function compileRules(set: RuleSet, opts: RulesCompileOptions = {}): Uint8Array {
  const guardSecs = opts.guardSecs ?? set.guardSecs;
  const bytes = encodeRulesRaw(rulesToRaw(set, opts));
  verifyRulesBytes(bytes, guardSecs === undefined ? {} : { guardSecs });
  return bytes;
}

export interface RulesDecompileOptions {
  guardSecs?: number;
  tokenDecimals?: number;
  /** Labels for known addresses (shown in the DSL and explanations). */
  labels?: Readonly<Record<Address, string>>;
}

/** Verifies and decodes PXR1 bytes into the canonical model. */
export function decompileRules(bytes: Uint8Array, opts: RulesDecompileOptions = {}): RuleSet {
  const raw = verifyRulesBytes(bytes, opts.guardSecs === undefined ? {} : { guardSecs: opts.guardSecs });
  const keys = raw.keys.map((k): RuleKey => {
    const address = encodeBase58(k);
    const label = opts.labels?.[address];
    return label !== undefined && isLabel(label) ? { address, label } : { address };
  });
  const addrs = keys.map((k) => k.address);
  const rules = raw.rules.map((r): Rule => {
    const when = decompileCond(raw.nodes.slice(r.condOff, r.condOff + r.condLen), { keys: addrs });
    const effect: RuleEffect = r.effect === EFFECT.DENY ? "deny" : r.effect === EFFECT.CAP_AMOUNT ? "capAmount" : "capBalance";
    const out: Rule = { from: r.fromRel, to: r.toRel, effect, when, code: r.code };
    if (effect !== "deny") out.cap = argAmount(r.arg);
    return out;
  });
  const set: RuleSet = { keys, rules };
  // The verifier caps the guard at 72 h (as the crate does); the model keeps the effective value.
  if (opts.guardSecs !== undefined) set.guardSecs = Math.max(0, Math.min(Math.floor(opts.guardSecs), PXR1.MAX_GUARD_SECS));
  if (opts.tokenDecimals !== undefined) set.tokenDecimals = opts.tokenDecimals;
  return set;
}

/** Label of an address in a set, or a short form. */
export function keyName(set: RuleSet, address: Address): string {
  const k = set.keys.find((x) => x.address === address);
  return k?.label ?? `${address.slice(0, 4)}…${address.slice(-4)}`;
}

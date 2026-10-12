/**
 * Code-first launch rules:
 *
 *   rules({ guardSecs: 3600 })
 *     .key("team", "9xQe...")
 *     .deny(when.buy().and(when.timeLt("2m")).and(when.txIxCountGt(10)), "BOT")
 *     .capAmount("0.5%", when.buy(), { code: "WHALE", first: "10m" })
 *     .deny(when.buy().and(when.toIn(["team"])), "TEAM")
 *     .compile();
 */
import { type KeyInput, toAddress } from "../bytes.js";
import { toAmount } from "../cond/ast.js";
import { type CondLike, condOf, type SupplyAmount } from "../cond/when.js";
import { rulesHash } from "../hash.js";
import { type Duration, toSeconds } from "../units.js";
import { explainRules } from "./explain.js";
import { compileRules, normalizeRules, type Rule, type RuleEffect, type RuleSet } from "./model.js";
import { printRules } from "./dsl.js";
import { ruleCode, type RuleCodeLike } from "./codes.js";

export type { RuleCodeLike } from "./codes.js";

/** When a rule is active and what code it shows. Default: the whole guard, code 0. */
export interface RuleOptions {
  code?: RuleCodeLike;
  /** Active during the first `first` (from 0). */
  first?: Duration;
  /** Active from `after` until the guard ends. */
  after?: Duration;
  /** Explicit window start (seconds since open). */
  from?: Duration;
  /** Explicit window end (exclusive). */
  to?: Duration;
}

export interface RulesOptions {
  /** The launch guard length; needed to compile rules that run until the guard ends. */
  guardSecs?: number;
  /** Token decimals for amounts given as whole tokens (default 6). */
  tokenDecimals?: number;
}

function windowOf(o: RuleOptions): { from: number; to: number | null } {
  if (o.first !== undefined) return { from: 0, to: toSeconds(o.first, "first") };
  if (o.after !== undefined) return { from: toSeconds(o.after, "after"), to: null };
  return { from: o.from === undefined ? 0 : toSeconds(o.from, "from"), to: o.to === undefined ? null : toSeconds(o.to, "to") };
}

function optionsOf(o: RuleCodeLike | RuleOptions | undefined): RuleOptions {
  if (o === undefined) return {};
  return typeof o === "object" ? o : { code: o };
}

export class RulesBuilder {
  private readonly set: RuleSet;

  constructor(opts: RulesOptions = {}) {
    this.set = { keys: [], rules: [] };
    if (opts.guardSecs !== undefined) this.set.guardSecs = opts.guardSecs;
    if (opts.tokenDecimals !== undefined) this.set.tokenDecimals = opts.tokenDecimals;
  }

  /** Names a wallet / program so conditions can say when.toIn(["team"]). */
  key(label: string, address: KeyInput): this {
    this.set.keys.push({ address: toAddress(address), label });
    return this;
  }

  private push(effect: RuleEffect, cap: SupplyAmount | undefined, w: CondLike | undefined, o: RuleCodeLike | RuleOptions | undefined): this {
    const opts = optionsOf(o);
    const { from, to } = windowOf(opts);
    const rule: Rule = { from, to, effect, when: w === undefined ? { op: "true" } : condOf(w), code: ruleCode(opts.code) };
    if (cap !== undefined) rule.cap = toAmount(cap, "cap");
    this.set.rules.push(rule);
    return this;
  }

  /** Refuse transfers while `when` holds (default: always). Sells are never affected. */
  deny(w?: CondLike, opts?: RuleCodeLike | RuleOptions): this {
    return this.push("deny", undefined, w, opts);
  }

  /** While `when` holds, refuse a transfer that moves more than `cap`. */
  capAmount(cap: SupplyAmount, w?: CondLike, opts?: RuleCodeLike | RuleOptions): this {
    return this.push("capAmount", cap, w, opts);
  }

  /** While `when` holds, refuse a transfer that leaves the receiver above `cap`. */
  capBalance(cap: SupplyAmount, w?: CondLike, opts?: RuleCodeLike | RuleOptions): this {
    return this.push("capBalance", cap, w, opts);
  }

  /** Adds a rule given as data. */
  add(rule: Rule): this {
    this.set.rules.push(rule);
    return this;
  }

  /** The rule set (labels resolved, amounts exact; "until the guard ends" windows stay open: `to: null`). */
  build(): RuleSet {
    return normalizeRules(this.set, { keepOpenEnds: true });
  }

  /** Verified PXR1 bytes. */
  compile(): Uint8Array {
    return compileRules(this.set);
  }

  /** rules_hash of the compiled bytes. */
  hash(): Uint8Array {
    return rulesHash(this.compile());
  }

  explain(): string[] {
    return explainRules(this.build());
  }

  /** The text-DSL form. */
  toText(): string {
    return printRules(this.build());
  }
}

/** Starts a rule set. */
export function rules(opts: RulesOptions = {}): RulesBuilder {
  return new RulesBuilder(opts);
}

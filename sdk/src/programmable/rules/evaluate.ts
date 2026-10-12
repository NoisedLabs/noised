/**
 * Rule evaluation, exactly as the hook runs it (spec §1.2), and a friendly
 * transfer simulator for the "try a transfer" panel.
 *
 * In the hook the custom rules run LAST: sells, transfers at/after the guard
 * end, zero amounts, the batch and claims (exempt owners) are allowed before
 * any rule is looked at, and so is every move whose top-level instruction is
 * the Noised vault's or the Noised shield's (holders' custody and privacy).
 * Rules can only reject, so they can never allow something the built-in guard
 * refuses, and never block a sell.
 */
import { DEFAULT_TOKEN_DECIMALS, EFFECT, OP, PXR1, RULES_SKIPPED_PROGRAMS } from "../constants.js";
import { type Address, type KeyInput, DEFAULT_ADDRESS, encodeBase58, toAddress } from "../bytes.js";
import { ProgError } from "../errors.js";
import { type CondNode, evalCondition, exceeds } from "../cond/vm.js";
import { bpsOfSupply, formatDurationLong, formatTokens, toSeconds, toTokenUnits, type Duration, type TokenAmount } from "../units.js";
import { type RawRuleSet, verifyRulesBytes } from "./codec.js";
import { ruleCodeName, ruleCodeText } from "./codes.js";
import { explainRule } from "./explain.js";
import { compileRules, decompileRules, type RuleSet } from "./model.js";

/** The facts the hook knows about one transfer (rule evaluation input). */
export interface RuleEvalCtx {
  /** Seconds since the launch opened (i64; may be negative or a bigint). */
  nowRel: number | bigint;
  /** Source is the pool's base vault. */
  isBuy: boolean;
  /** Neither side is the pool or the protocol. */
  isP2p: boolean;
  amount: bigint;
  destBalanceAfter: bigint;
  supply: bigint;
  destOwner: Address;
  srcOwner: Address;
  /** Program id of the transaction's current top-level instruction. */
  topProgram: Address;
  /** Number of top-level instructions in the transaction. */
  txIxCount: number;
}

export type RuleOutcome = { ok: true } | { ok: false; index: number; code: number };

/**
 * Decides one transfer like the crate's RuleSet::evaluate: active rules
 * (from <= nowRel < to) in order; a CAP rule's cap is compared first, then
 * the condition; the first rule that rejects wins. Total on unverified sets:
 * a malformed rule rejects with PXR1.CODE_MALFORMED (fail closed).
 */
export function evaluateRuleSet(set: RawRuleSet, t: RuleEvalCtx): RuleOutcome {
  const leaf = rulesLeaf(set, t);
  const now = BigInt(t.nowRel);
  for (let i = 0; i < set.rules.length; i++) {
    const r = set.rules[i]!;
    if (!(BigInt(r.fromRel) <= now && now < BigInt(r.toRel))) continue;
    const malformed: RuleOutcome = { ok: false, index: i, code: PXR1.CODE_MALFORMED };
    let wouldReject: boolean;
    switch (r.effect) {
      case EFFECT.DENY:
        wouldReject = true;
        break;
      case EFFECT.CAP_AMOUNT:
        wouldReject = exceeds(t.amount, r.arg, t.supply);
        break;
      case EFFECT.CAP_DEST_BALANCE:
        wouldReject = exceeds(t.destBalanceAfter, r.arg, t.supply);
        break;
      default:
        return malformed;
    }
    if (!wouldReject) continue;
    if (r.condOff + r.condLen > set.nodes.length) return malformed;
    const hit = evalCondition(set.nodes.slice(r.condOff, r.condOff + r.condLen), leaf);
    if (hit === null) return malformed;
    if (hit) return { ok: false, index: i, code: r.code };
  }
  return { ok: true };
}

/**
 * Whether rule `index`'s condition holds for `t`, whatever its window (the
 * crate's RuleSet::condition). null if there is no such rule or its
 * condition is malformed (never for a verified set).
 */
export function ruleCondition(set: RawRuleSet, index: number, t: RuleEvalCtx): boolean | null {
  const r = set.rules[index];
  if (!r || r.condOff + r.condLen > set.nodes.length) return null;
  return evalCondition(set.nodes.slice(r.condOff, r.condOff + r.condLen), rulesLeaf(set, t));
}

function rulesLeaf(set: RawRuleSet, t: RuleEvalCtx): (n: CondNode) => boolean | null {
  const keys = set.keys.map((k) => encodeBase58(k));
  const maskOf = (who: Address): number => {
    let m = 0;
    for (let i = 0; i < Math.min(keys.length, 8); i++) if (keys[i] === who) m |= 1 << i;
    return m;
  };
  const dest = maskOf(t.destOwner);
  const src = maskOf(t.srcOwner);
  const top = maskOf(t.topProgram);
  const now = BigInt(t.nowRel);
  return (n: CondNode): boolean | null => {
    switch (n.op) {
      case OP.IS_BUY:
        return t.isBuy;
      case OP.IS_P2P:
        return t.isP2p;
      case OP.TIME_LT:
        return now < n.arg;
      case OP.TIME_GE:
        return !(now < n.arg);
      case OP.AMOUNT_GT:
        return exceeds(t.amount, n.arg, t.supply);
      case OP.DEST_BAL_AFTER_GT:
        return exceeds(t.destBalanceAfter, n.arg, t.supply);
      case OP.DEST_OWNER_IN:
        return (dest & n.a) !== 0;
      case OP.SRC_OWNER_IN:
        return (src & n.a) !== 0;
      case OP.TOP_PROGRAM_IN:
        return (top & n.a) !== 0;
      case OP.TX_IX_COUNT_GT:
        return BigInt(t.txIxCount) > n.arg;
      default:
        return null;
    }
  };
}

/**
 * What kind of transfer to try:
 * - "buy": out of the pool (its base vault), into the receiving account;
 * - "sell": into the pool (always allowed);
 * - "p2p": wallet to wallet;
 * - "batch": the opening batch buy, into the launch's batch escrow (always
 *   allowed, even before buying opens);
 * - "protocol": out of the launch's own accounts (claims of the batch):
 *   allowed, but like every transfer during the guard only into an account
 *   whose owner can never change (`toImmutableOwner`).
 */
export type TransferKind = "buy" | "sell" | "p2p" | "batch" | "protocol";

export interface TransferInput {
  kind: TransferKind;
  /** Time since the launch opened ("90s", "2m", or seconds). */
  at: Duration;
  /** Whole tokens (number / string) or raw units (bigint). */
  amount: TokenAmount;
  /** Receiver's balance before the transfer (default 0). */
  receiverBalance?: TokenAmount;
  /** Total supply (default 1,000,000,000 tokens). */
  supply?: TokenAmount;
  /** Receiving wallet. */
  to?: KeyInput;
  /** Sending wallet. */
  from?: KeyInput;
  /**
   * Program of the transaction's current top-level instruction (e.g. a
   * router). When it is the Noised vault or the Noised shield
   * (`RULES_SKIPPED_PROGRAMS`), the custom rules are skipped (stage
   * "holderExit"); the built-in guard still applies.
   */
  program?: KeyInput;
  /**
   * The receiving token account's owner can never be changed (Token-2022's
   * ImmutableOwner extension; every Token-2022 associated token account has
   * it). Default true. When false, the hook refuses the transfer during the
   * guard ("MutableOwner"), unless it is a sell, a zero amount or the batch
   * buy, whatever the launch's settings (with or without `builtin`).
   */
  toImmutableOwner?: boolean;
  /**
   * Top-level instructions in the transaction (every instruction of its
   * message). Default: 6 for a buy (an ordinary buy uses 4 to 8: compute
   * budget, account creation, wrap, swap, unwrap), 1 otherwise.
   */
  instructions?: number;
  /** Launch guard length (default: the rule set's, else 72 h). */
  guardSecs?: number;
  tokenDecimals?: number;
  /**
   * The launch's built-in Launch Guard settings (snipe shield, p2p lock,
   * caps). When given, they are checked first, exactly as the hook does
   * (programs/noised-hook rules.rs `built_ins`), and the custom rules run
   * after them; when absent those settings are off and only the checks every
   * launch has (sells, the guard's end, zero amounts, the batch and claims,
   * the receiving account's fixed owner) come before the custom rules.
   */
  builtin?: BuiltinGuard;
}

/** The built-in Launch Guard of a launch (launch params; the hook's policy). */
export interface BuiltinGuard {
  /**
   * Seconds after launch during which nobody but the opening batch can buy
   * (open delay + execution grace; the batch can end it earlier). Default 0.
   */
  snipeShieldSecs?: number;
  /** Max tokens one transfer may move during the guard, in bps of supply (launch param maxBuyBps; 0 = off). */
  maxBuyBps?: number;
  /** Max balance of a receiving account during the guard, in bps of supply (maxWalletBps; 0 = off). */
  maxWalletBps?: number;
  /** Wallet-to-wallet transfers paused during the guard (p2pLocked). */
  p2pLocked?: boolean;
}

/** The hook's refusal names: the built-in ones (`Refusal`), then RuleDenied for a custom rule. */
export type HookRefusal = "SnipeShield" | "TransfersLocked" | "MaxBuy" | "MaxWallet" | "MutableOwner" | "RuleDenied";

export interface TransferVerdict {
  allowed: boolean;
  /** Index of the refusing rule, or null. */
  rule: number | null;
  /** The refusing rule's code (0..=63), or null. */
  code: number | null;
  /** "BOT", ... for named codes. */
  codeName: string | null;
  /**
   * Which step decided, in the hook's order: an always-allowed path ("sell",
   * "guardOver", "zero", "exempt"), a built-in refusal ("shield", "p2pLocked",
   * "maxBuy", "maxWallet" only with `builtin`; "mutableOwner" whenever
   * `toImmutableOwner` is false), a move through the Noised vault or shield
   * that skips the custom rules ("holderExit"), or the rules.
   */
  stage: "sell" | "exempt" | "zero" | "guardOver" | "rules" | "shield" | "mutableOwner" | "p2pLocked" | "maxBuy" | "maxWallet" | "holderExit";
  /** The hook's error name when refused (RuleDenied for a custom rule); absent when allowed. */
  refusal?: HookRefusal;
  /** Plain English. */
  why: string;
}

/** floor(supply * bps / 10000), the launchpad's cap_from_bps (0 = off; a non-zero share that rounds to 0 is refused). */
function capFromBps(supply: bigint, bps: number | undefined, what: string): bigint {
  if (bps === undefined || bps === 0) return 0n;
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new ProgError("BadAmount", `${what} must be 0..=10000 bps`);
  const cap = bpsOfSupply(supply, bps);
  if (cap === 0n) throw new ProgError("BadAmount", `${what} of ${bps} bps rounds to zero tokens for this supply`);
  return cap;
}

/**
 * Tries one transfer against a rule set (model, PXR1 bytes, or null for "no
 * custom rules") the way the hook would (programs/noised-hook rules.rs
 * `evaluate`: `built_ins`, then `creator_rules`), in its order:
 *
 * 1. a sell is allowed;
 * 2. at or after the guard's end everything is allowed;
 * 3. a buy before buying opens is refused (SnipeShield; the batch buy is not);
 * 4. a zero amount is allowed;
 * 5. the batch buy (into the launch's exempt escrow) is allowed;
 * 6. a transfer into an account whose owner can be changed is refused
 *    (MutableOwner, `toImmutableOwner: false`; claims included);
 * 7. claims (out of the launch's exempt accounts) are allowed;
 * 8. the p2p lock, 9. max buy, 10. max wallet (with `builtin`);
 * 11. the custom rules: none allows; a move whose top-level instruction is
 *     the Noised vault's or shield's skips them ("holderExit"); else the
 *     first rule that refuses decides.
 *
 * Without `input.builtin` the launch's settings (shield, lock, caps) are off;
 * every other step above still applies.
 */
export function simulateTransfer(rules: RuleSet | Uint8Array | null, input: TransferInput): TransferVerdict {
  const set: RuleSet | null = rules === null ? null : rules instanceof Uint8Array ? decompileRules(rules, input.guardSecs === undefined ? {} : { guardSecs: input.guardSecs }) : rules;
  // The hook's guard lasts at most 72 h whatever the launch says (the verifier caps it the same way).
  const guardSecs = Math.min(input.guardSecs ?? set?.guardSecs ?? PXR1.MAX_GUARD_SECS, PXR1.MAX_GUARD_SECS);
  const ixCount = input.instructions ?? (input.kind === "buy" ? 6 : 1);
  if (!Number.isInteger(ixCount) || ixCount < 0 || ixCount > 0xffff) {
    // The hook reads it as a u16 from the instructions sysvar.
    throw new ProgError("BadModel", `instructions must be a whole number from 0 to 65535 (got ${String(ixCount)})`);
  }
  const immutableOwner = input.toImmutableOwner ?? true;
  if (typeof immutableOwner !== "boolean") {
    throw new ProgError("BadModel", `toImmutableOwner must be true or false (got ${String(immutableOwner)})`);
  }
  const dec = input.tokenDecimals ?? set?.tokenDecimals ?? DEFAULT_TOKEN_DECIMALS;
  const nowRel = toSeconds(input.at, "time");
  const amount = toTokenUnits(input.amount, dec, "amount");
  const supply = input.supply === undefined ? toTokenUnits(1_000_000_000, dec) : toTokenUnits(input.supply, dec, "supply");
  const before = input.receiverBalance === undefined ? 0n : toTokenUnits(input.receiverBalance, dec, "receiver balance");
  const b = input.builtin;
  const shieldSecs = b?.snipeShieldSecs === undefined ? 0 : toSeconds(b.snipeShieldSecs, "snipe shield");
  const maxBuy = capFromBps(supply, b?.maxBuyBps, "max buy");
  const maxWallet = capFromBps(supply, b?.maxWalletBps, "max wallet");
  const verdict = (stage: TransferVerdict["stage"], why: string): TransferVerdict => ({
    allowed: true,
    rule: null,
    code: null,
    codeName: null,
    stage,
    why,
  });
  const refuse = (stage: TransferVerdict["stage"], refusal: HookRefusal, why: string): TransferVerdict => ({
    allowed: false,
    rule: null,
    code: null,
    codeName: null,
    stage,
    refusal,
    why,
  });
  // The hook's order (rules.rs `built_ins`): sell, guard over, snipe shield, zero amount, exempt
  // destination (the batch buy), fixed owner, exempt source (claims), p2p lock, max buy, max wallet;
  // then `creator_rules`: none, the vault / shield skip, the custom rules.
  const isBuy = input.kind === "buy";
  if (input.kind === "sell") return verdict("sell", "Sells are always allowed. No rule can block a sell.");
  if (nowRel >= guardSecs) {
    return verdict("guardOver", `The launch guard ended ${formatDurationLong(guardSecs)} after launch, so no rule applies any more.`);
  }
  // Before the zero-amount pass: a buy that pays out nothing still waits for buying to open.
  if (isBuy && nowRel < shieldSecs) {
    return refuse("shield", "SnipeShield", `Buying opens ${formatDurationLong(shieldSecs)} after launch; until then only the opening batch can buy.`);
  }
  if (amount === 0n) return verdict("zero", "Zero-amount transfers are always allowed.");
  // The batch buy pays the batch escrow, an account of the launch whose owner never changes.
  if (input.kind === "batch") return verdict("exempt", "The opening batch buy is always allowed.");
  // Before the claims pass and the lock and caps, which reassigning the account's owner would get around.
  if (!immutableOwner) {
    return refuse(
      "mutableOwner",
      "MutableOwner",
      "During the launch guard, tokens can only go into accounts whose owner can never be changed (every wallet's standard token account is like that). This receiving account's owner could be changed, so the transfer is refused.",
    );
  }
  if (input.kind === "protocol") return verdict("exempt", "Launch transfers (claims of the opening batch) are always allowed.");
  if (!isBuy && b?.p2pLocked === true) {
    return refuse("p2pLocked", "TransfersLocked", "Wallet-to-wallet transfers are paused until the launch guard ends.");
  }
  if (maxBuy !== 0n && amount > maxBuy) {
    return refuse("maxBuy", "MaxBuy", `During the launch guard one transfer can move at most ${formatTokens(maxBuy, dec, true)} tokens.`);
  }
  if (maxWallet !== 0n && before + amount > maxWallet) {
    return refuse("maxWallet", "MaxWallet", `During the launch guard no wallet can hold more than ${formatTokens(maxWallet, dec, true)} tokens.`);
  }
  if (set === null || set.rules.length === 0) return verdict("rules", "There are no custom rules, so nothing extra blocks this.");
  const topProgram = input.program === undefined ? DEFAULT_ADDRESS : toAddress(input.program);
  if (RULES_SKIPPED_PROGRAMS.includes(topProgram)) {
    return verdict(
      "holderExit",
      "Moves made by the Noised vault or shield (holders' quantum-safe custody and privacy) skip the creator's rules; the built-in launch guard still applies.",
    );
  }

  const bytes = compileRules(set, { guardSecs });
  const raw = verifyRulesBytes(bytes, { guardSecs });
  const out = evaluateRuleSet(raw, {
    nowRel,
    isBuy,
    // Rules only see buys and wallet-to-wallet transfers: the hook's is_p2p is "not a buy".
    isP2p: !isBuy,
    amount,
    destBalanceAfter: before + amount,
    supply,
    destOwner: input.to === undefined ? DEFAULT_ADDRESS : toAddress(input.to),
    srcOwner: input.from === undefined ? DEFAULT_ADDRESS : toAddress(input.from),
    topProgram,
    txIxCount: ixCount,
  });
  if (out.ok) return verdict("rules", "No rule blocks this transfer.");
  // explain against the canonical model so indices match the bytes
  const canon = decompileRules(bytes, { guardSecs, tokenDecimals: dec, labels: labelsOf(set) });
  const name = ruleCodeName(out.code);
  const text = ruleCodeText(out.code);
  return {
    allowed: false,
    rule: out.index,
    code: out.code,
    codeName: name,
    stage: "rules",
    refusal: "RuleDenied",
    why: `Blocked by rule ${out.index + 1}${text ? ` (${text})` : ""}: ${explainRule(canon, out.index)}`,
  };
}

function labelsOf(set: RuleSet): Record<Address, string> {
  const out: Record<Address, string> = {};
  for (const k of set.keys) {
    if (k.label === undefined) continue;
    try {
      out[toAddress(k.address)] = k.label;
    } catch {
      // ignore malformed entries; compile already validated the set
    }
  }
  return out;
}

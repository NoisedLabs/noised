/**
 * What a holder should be warned about in a launch's rules (QSL-1 revision
 * 0.4 §6.4: "Programmable" is a description, not a safety level). Each rule
 * of a verified PXR1 set is tried, with the hook's own evaluation, on every
 * kind of transfer the rules can see (a buy, or a wallet-to-wallet transfer
 * between owners that are not exempt, of a non-zero amount, before the guard
 * ends), at every second where its condition can change, and for every
 * amount, balance, wallet, program and instruction count that can change its
 * outcome. The warnings say, in plain English, what the rule really does:
 *
 * - `insiderBuying`: ordinary buys are refused except for wallets the rule
 *   lists (only insiders can buy), and for how long; or (`partial`) larger
 *   buys are refused for everyone but wallets the rule lists (only insiders
 *   can buy more than a set amount; audit 4, S4);
 * - `buysBlocked`: ordinary buys are refused (or some of them), and for how
 *   long;
 * - `transferLimits`: the rule refuses or limits wallet-to-wallet transfers;
 * - `longRule`: the rule stays on for more than an hour;
 * - `noOpRule`: the rule can never refuse anything (it does nothing);
 * - `complexRule`: too many cases to try: read it yourself.
 *
 * Nothing here relaxes a rule's meaning: the hook skips the creator's rules
 * for transfers made by the Noised vault or shield (holders' custody and
 * privacy exits), so those programs are left out of the programs tried, and
 * a rule that can only match them is reported as doing nothing.
 */
import { EFFECT, OP, PXR1, RULES_SKIPPED_PROGRAMS } from "../constants.js";
import { encodeBase58 } from "../bytes.js";
import { type CondNode, evalCondition, exceeds, threshold } from "../cond/vm.js";
import { formatDurationLong, formatTokens } from "../units.js";
import { type RawRuleSet, verifyRulesBytes } from "./codec.js";

/** What a warning is about (see the module comment). */
export type RuleWarningKind = "insiderBuying" | "buysBlocked" | "transferLimits" | "longRule" | "noOpRule" | "complexRule";

/** One warning about one rule. */
export interface RuleWarning {
  readonly kind: RuleWarningKind;
  /** The rule's index (0-based; "rule 1" in `plain` is index 0). */
  readonly rule: number;
  /** Seconds after launch: the first second the restriction applies, and the second after its last (null for `noOpRule`, `complexRule`). */
  readonly from: number | null;
  readonly to: number | null;
  /** Seconds in [from, to) during which it applies (less than `to - from` when it pauses in between). */
  readonly secs: number;
  /** `insiderBuying`: the wallets the rule lets buy (base58), in key-table order. */
  readonly wallets: readonly string[];
  /** `insiderBuying` / `buysBlocked`: programs a buy can go through to pass the rule (base58). */
  readonly apps: readonly string[];
  /** `buysBlocked`: only some ordinary buys are refused (e.g. those of 8 instructions). */
  readonly partial: boolean;
  /** One plain-English sentence. */
  readonly plain: string;
}

export interface RuleWarningsOptions {
  /** The launch's guard (seconds): rules end by then. */
  guardSecs: number;
  /** The mint's supply in raw units (caps in basis points are a share of it). Default 1,000,000,000 tokens. */
  supply?: bigint;
  tokenDecimals?: number;
  /** Seconds after launch from which a buy can reach the rules (the snipe shield's end; before it only the batch buys). Default 0. */
  buysOpenAt?: number;
  /** Cases tried per rule before it is reported as `complexRule` (default 250,000). */
  maxProbes?: number;
}

/** A rule that stays on longer than this (seconds) gets a `longRule` warning. */
export const RULE_WARNING_LONG_SECS = 3_600;

/** The Noised vault and shield: the hook skips creator rules when either is the transaction's top-level program (review 4, R1). */
const RULES_SKIPPED = new Set<string>(RULES_SKIPPED_PROGRAMS);
/** Meteora DBC's pool authority: the owner of the pool's base vault, so the source owner of every buy. */
const DBC_POOL_AUTHORITY = "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM";
/** Instructions an ordinary buy's transaction has (compute budget, account creation, wrap, swap, unwrap): 4 to 8. */
const ORDINARY_BUY_IX = [4, 8] as const;
/** An ordinary wallet-to-wallet transfer: 1 to 4 instructions. */
const ORDINARY_P2P_IX = [1, 4] as const;

const SEVERITY: Readonly<Record<RuleWarningKind, number>> = { insiderBuying: 0, buysBlocked: 1, transferLimits: 2, longRule: 3, noOpRule: 4, complexRule: 5 };

interface Probe {
  now: bigint;
  isBuy: boolean;
  amount: bigint;
  bal: bigint;
  dest: number;
  src: number;
  top: number;
  ix: number;
}

const uniqSorted = (xs: Iterable<bigint>): bigint[] => [...new Set(xs)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "For the first hour" / "For the first 2 hours" / "From 10 minutes to 2 hours after launch". */
function span(from: number, to: number): string {
  const first = formatDurationLong(to);
  return from === 0 ? `For the first ${/^1 [a-z]+$/.test(first) ? first.slice(2) : first}` : `From ${formatDurationLong(from)} to ${first} after launch`;
}

/**
 * The warnings for a launch's rules (verified PXR1 bytes, or a verified raw
 * set), most serious first, then by rule. Throws a ProgError when the bytes
 * do not verify for `guardSecs`.
 */
export function ruleWarnings(rules: Uint8Array | RawRuleSet, opts: RuleWarningsOptions): RuleWarning[] {
  const guard = Math.min(opts.guardSecs, PXR1.MAX_GUARD_SECS);
  const raw = rules instanceof Uint8Array ? verifyRulesBytes(rules, { guardSecs: guard }) : rules;
  const dec = opts.tokenDecimals ?? 6;
  const supply = opts.supply ?? 1_000_000_000n * 10n ** BigInt(dec);
  if (supply <= 0n) throw new RangeError("supply must be positive");
  const buysOpenAt = Math.max(0, opts.buysOpenAt ?? 0);
  const maxProbes = opts.maxProbes ?? 250_000;
  const keys = raw.keys.slice(0, 8).map((k) => encodeBase58(k));
  const bit = (i: number): number => 1 << i;
  const maskOf = (who: string): number => keys.reduce((m, k, i) => (k === who ? m | bit(i) : m), 0);
  const poolAuthority = maskOf(DBC_POOL_AUTHORITY);
  const out: RuleWarning[] = [];

  raw.rules.forEach((r, index) => {
    const nodes: CondNode[] = raw.nodes.slice(r.condOff, r.condOff + r.condLen);
    const ops = new Set(nodes.map((n) => n.op));
    const from = r.fromRel;
    const to = Math.min(r.toRel, guard);
    const warn = (w: Omit<RuleWarning, "rule" | "wallets" | "apps" | "partial"> & Partial<Pick<RuleWarning, "wallets" | "apps" | "partial">>): void => {
      out.push({ rule: index, wallets: [], apps: [], partial: false, ...w });
    };
    const name = `rule ${index + 1}`;
    if (!(from < to)) {
      warn({ kind: "noOpRule", from: null, to: null, secs: 0, plain: `Rule ${index + 1} is never on, so it does nothing.` });
      return;
    }

    // Every value at which the rule's outcome can change.
    const times = uniqSorted([BigInt(from), ...nodes.filter((n) => (n.op === OP.TIME_LT || n.op === OP.TIME_GE) && n.arg > BigInt(from) && n.arg < BigInt(to)).map((n) => n.arg)]);
    const amountTs: bigint[] = nodes.filter((n) => n.op === OP.AMOUNT_GT).map((n) => threshold(n.arg, supply));
    if (r.effect === EFFECT.CAP_AMOUNT) amountTs.push(threshold(r.arg, supply));
    const balTs: bigint[] = nodes.filter((n) => n.op === OP.DEST_BAL_AFTER_GT).map((n) => threshold(n.arg, supply));
    if (r.effect === EFFECT.CAP_DEST_BALANCE) balTs.push(threshold(r.arg, supply));
    const within = (xs: bigint[]): bigint[] => uniqSorted(xs.flatMap((t) => [t, t + 1n]).concat([1n, supply]).filter((x) => x >= 1n && x <= supply));
    const amounts = amountTs.length === 0 && balTs.length === 0 ? [1n] : within([...amountTs, ...balTs]);
    const balancesFor = (amount: bigint): bigint[] => (balTs.length === 0 ? [amount] : within(balTs).filter((b) => b >= amount));
    const ownerMasks = (used: boolean): number[] => (used ? [0, ...keys.map((_, i) => bit(i))] : [0]);
    const dests = ownerMasks(ops.has(OP.DEST_OWNER_IN));
    const srcs = ownerMasks(ops.has(OP.SRC_OWNER_IN));
    const tops = ops.has(OP.TOP_PROGRAM_IN) ? [0, ...keys.map((k, i) => (RULES_SKIPPED.has(k) ? -1 : bit(i))).filter((m) => m >= 0)] : [0];
    const ixTs = nodes.filter((n) => n.op === OP.TX_IX_COUNT_GT).map((n) => n.arg);
    const ixs = ixTs.length === 0 ? [1] : uniqSorted([1n, 4n, 8n, ...ixTs.flatMap((t) => [t, t + 1n])].filter((x) => x >= 1n && x <= 0xffffn)).map(Number);

    const nBal = amounts.reduce((n, a) => n + balancesFor(a).length, 0);
    const probes = times.length * nBal * dests.length * tops.length * ixs.length * (1 + srcs.length);
    const longRule = to - from > RULE_WARNING_LONG_SECS;
    if (probes > maxProbes) {
      warn({ kind: "complexRule", from: null, to: null, secs: 0, plain: `Rule ${index + 1} has too many cases to summarize here: read it carefully.` });
      if (longRule) warn({ kind: "longRule", from, to, secs: to - from, plain: `Rule ${index + 1} stays on for ${formatDurationLong(to - from)}, more than an hour.` });
      return;
    }

    const p: Probe = { now: 0n, isBuy: true, amount: 1n, bal: 1n, dest: 0, src: 0, top: 0, ix: 1 };
    const leaf = (n: CondNode): boolean | null => {
      switch (n.op) {
        case OP.IS_BUY:
          return p.isBuy;
        case OP.IS_P2P:
          return !p.isBuy;
        case OP.TIME_LT:
          return p.now < n.arg;
        case OP.TIME_GE:
          return !(p.now < n.arg);
        case OP.AMOUNT_GT:
          return exceeds(p.amount, n.arg, supply);
        case OP.DEST_BAL_AFTER_GT:
          return exceeds(p.bal, n.arg, supply);
        case OP.DEST_OWNER_IN:
          return (p.dest & n.a) !== 0;
        case OP.SRC_OWNER_IN:
          return (p.src & n.a) !== 0;
        case OP.TOP_PROGRAM_IN:
          return (p.top & n.a) !== 0;
        case OP.TX_IX_COUNT_GT:
          return BigInt(p.ix) > n.arg;
        default:
          return null;
      }
    };
    /** The hook's decision for this rule alone (it is active at `p.now`): a malformed condition refuses, as on-chain. */
    const refuses = (): boolean => {
      const capped = r.effect === EFFECT.DENY ? true : r.effect === EFFECT.CAP_AMOUNT ? exceeds(p.amount, r.arg, supply) : r.effect === EFFECT.CAP_DEST_BALANCE ? exceeds(p.bal, r.arg, supply) : true;
      if (!capped) return false;
      return evalCondition(nodes, leaf) !== false;
    };
    /** Any case of this kind refused at `p.now`. */
    const anyRefused = (isBuy: boolean): boolean => {
      p.isBuy = isBuy;
      for (const amount of amounts) {
        p.amount = amount;
        for (const bal of balancesFor(amount)) {
          p.bal = bal;
          for (const dest of dests) {
            p.dest = dest;
            for (const src of isBuy ? [poolAuthority] : srcs) {
              p.src = src;
              for (const top of tops) {
                p.top = top;
                for (const ix of ixs) {
                  p.ix = ix;
                  if (refuses()) return true;
                }
              }
            }
          }
        }
      }
      return false;
    };
    /** An ordinary small buy into `dest` through `top`: refused at each ordinary instruction count. */
    const buyRefusals = (dest: number, top: number): boolean[] => {
      Object.assign(p, { isBuy: true, amount: 1n, bal: 1n, dest, src: poolAuthority, top });
      return ORDINARY_BUY_IX.map((ix) => {
        p.ix = ix;
        return refuses();
      });
    };
    const p2pRefused = (): boolean => {
      Object.assign(p, { isBuy: false, amount: 1n, bal: 1n, dest: 0, src: 0, top: 0 });
      return ORDINARY_P2P_IX.some((ix) => {
        p.ix = ix;
        return refuses();
      });
    };

    /** An ordinary buy of `amount` (destination balance `bal`) into `dest` is refused at some ordinary instruction count. */
    const buyRefusedAt = (amount: bigint, bal: bigint, dest: number): boolean => {
      Object.assign(p, { isBuy: true, amount, bal, dest, src: poolAuthority, top: 0 });
      return ORDINARY_BUY_IX.some((ix) => {
        p.ix = ix;
        return refuses();
      });
    };

    let any = false;
    const buys = { first: -1, last: -1, secs: 0, partial: false, wallets: new Set<number>(), apps: new Set<number>() };
    // Audit 4, S4: larger buys refused for everyone but wallets the rule lists (only insiders can buy more).
    const larger = { first: -1, last: -1, secs: 0, wallets: new Set<number>(), least: null as bigint | null, leastBal: null as bigint | null };
    const amountBased = amountTs.length > 0 || balTs.length > 0;
    const p2p = { first: -1, last: -1, secs: 0, ordinary: false };
    times.forEach((t, k) => {
      const start = Number(t);
      const end = k + 1 < times.length ? Number(times[k + 1]) : to;
      p.now = t;
      const p2pAny = anyRefused(false);
      if (p2pAny) any = true;
      // Buys reach the rules only once the snipe shield is over.
      const bStart = Math.max(start, buysOpenAt);
      if (bStart < end) {
        p.now = BigInt(bStart);
        if (anyRefused(true)) any = true;
        const outsider = buyRefusals(0, 0);
        if (outsider.some((x) => x)) {
          if (buys.first < 0) buys.first = bStart;
          buys.last = end;
          buys.secs += end - bStart;
          if (!outsider.every((x) => x)) buys.partial = true;
          keys.forEach((_, i) => {
            if (dests.includes(bit(i)) && buyRefusals(bit(i), 0).every((x) => !x)) buys.wallets.add(i);
            if (tops.includes(bit(i)) && buyRefusals(0, bit(i)).every((x) => !x)) buys.apps.add(i);
          });
        } else if (amountBased && dests.length > 1) {
          // A small buy passes: is a larger one refused for an outsider but not for a listed wallet?
          let hit = false;
          for (const amount of amounts) {
            for (const bal of balancesFor(amount)) {
              if (!buyRefusedAt(amount, bal, 0)) continue;
              const free = keys.flatMap((_, i) => (dests.includes(bit(i)) && !buyRefusedAt(amount, bal, bit(i)) ? [i] : []));
              if (free.length === 0) continue;
              hit = true;
              for (const i of free) larger.wallets.add(i);
              if (larger.least === null || amount < larger.least) larger.least = amount;
              if (larger.leastBal === null || bal < larger.leastBal) larger.leastBal = bal;
            }
          }
          if (hit) {
            if (larger.first < 0) larger.first = bStart;
            larger.last = end;
            larger.secs += end - bStart;
          }
        }
      }
      p.now = t;
      if (p2pAny) {
        if (p2p.first < 0) p2p.first = start;
        p2p.last = end;
        p2p.secs += end - start;
        if (p2pRefused()) p2p.ordinary = true;
      }
    });

    if (!any) {
      warn({ kind: "noOpRule", from: null, to: null, secs: 0, plain: `Rule ${index + 1} can never block anything, so it does nothing.` });
      return;
    }
    if (buys.first >= 0) {
      const wallets = [...buys.wallets].sort((a, b) => a - b).map((i) => keys[i]!);
      const apps = [...buys.apps].sort((a, b) => a - b).map((i) => keys[i]!);
      const via = apps.length === 0 ? "" : `, unless the buy goes through ${apps.length === 1 ? "one app" : `${apps.length} apps`} it lists`;
      if (wallets.length > 0) {
        warn({
          kind: "insiderBuying",
          from: buys.first,
          to: buys.last,
          secs: buys.secs,
          wallets,
          apps,
          partial: buys.partial,
          plain: `${span(buys.first, buys.last)}, only ${plural(wallets.length, "wallet", "wallets")} chosen by the creator can buy; everyone else's buys are refused${via} (${name}).`,
        });
      } else {
        warn({
          kind: "buysBlocked",
          from: buys.first,
          to: buys.last,
          secs: buys.secs,
          apps,
          partial: buys.partial,
          plain: buys.partial
            ? `${span(buys.first, buys.last)}, some ordinary buys are refused: those sent with more steps in one transaction, as some wallets do${via} (${name}).`
            : `${span(buys.first, buys.last)}, ordinary buys are refused${via} (${name}).`,
        });
      }
    }
    if (buys.first < 0 && larger.first >= 0 && larger.least !== null) {
      const wallets = [...larger.wallets].sort((a, b) => a - b).map((i) => keys[i]!);
      const most = larger.least > 1n ? larger.least - 1n : 0n;
      const mostBal = larger.leastBal !== null && larger.leastBal > 1n ? larger.leastBal - 1n : 0n;
      const what =
        balTs.length === 0
          ? `everyone else's buys of more than ${formatTokens(most, dec, true)} tokens are refused`
          : amountTs.length === 0
            ? `everyone else's buys that would leave a wallet holding more than ${formatTokens(mostBal, dec, true)} tokens are refused`
            : "everyone else's larger buys are refused";
      warn({
        kind: "insiderBuying",
        from: larger.first,
        to: larger.last,
        secs: larger.secs,
        wallets,
        partial: true,
        plain: `${span(larger.first, larger.last)}, only ${plural(wallets.length, "wallet", "wallets")} chosen by the creator can make larger buys; ${what} (${name}).`,
      });
    }
    if (p2p.first >= 0) {
      warn({
        kind: "transferLimits",
        from: p2p.first,
        to: p2p.last,
        secs: p2p.secs,
        plain: p2p.ordinary
          ? `${span(p2p.first, p2p.last)}, sending tokens from one wallet to another is refused (${name}).`
          : `${span(p2p.first, p2p.last)}, some wallet-to-wallet transfers are limited (${name}).`,
      });
    }
    if (longRule) warn({ kind: "longRule", from, to, secs: to - from, plain: `Rule ${index + 1} stays on for ${formatDurationLong(to - from)}, more than an hour.` });
  });

  return out.sort((a, b) => SEVERITY[a.kind] - SEVERITY[b.kind] || a.rule - b.rule);
}

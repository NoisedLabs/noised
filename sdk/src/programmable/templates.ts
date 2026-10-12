/**
 * Ready-made launch rules and autopilot graphs, with the parameters a UI
 * shows as a small form. Every template builds a valid, verifiable value.
 */
import { DEFAULT_TOKEN_DECIMALS, LAUNCH_TIMING, PXR1 } from "./constants.js";
import { type Address, type KeyInput, toAddress } from "./bytes.js";
import { ProgError } from "./errors.js";
import { when } from "./cond/when.js";
import { type Duration, formatDurationLong, type Percent, type SolAmount, type TokenAmount, toBps, toSeconds } from "./units.js";
import { rules } from "./rules/builder.js";
import { normalizeRules, type RuleKey, type RuleSet } from "./rules/model.js";
import { buybackBurn, burn, distributeSol, every, graph, onGraduation, whenever } from "./graph/builder.js";
import type { Graph } from "./graph/model.js";

export interface TemplateParam {
  key: string;
  label: string;
  kind: "duration" | "percent" | "sol" | "tokens" | "count" | "wallets" | "wallet" | "recipients" | "bps";
  default?: unknown;
  help?: string;
  /** The template can't be built without it. */
  required?: boolean;
  /**
   * Slider bounds for numeric kinds, in the kind's natural unit: duration =
   * seconds, percent / bps = basis points, sol = SOL, tokens = whole tokens,
   * count = a whole number. Every value in [min, max] builds a template that
   * compiles and verifies (tested), so a UI can offer the range without
   * checking anything itself.
   */
  range?: { min: number; max: number; step: number };
}

const GUARD_RANGE = { min: 600, max: 259_200, step: 600 };
/** Templates with a time window need the guard to outlast the batch window and its grace (see `tradingWindow`). */
const WINDOWED_GUARD_RANGE = { min: 1_800, max: 259_200, step: 600 };
const OPEN_DELAY_PARAM: TemplateParam = {
  key: "openDelaySecs",
  label: "Batch window",
  kind: "duration",
  default: LAUNCH_TIMING.DEFAULT_OPEN_DELAY_SECS,
  range: { min: LAUNCH_TIMING.MIN_OPEN_DELAY_SECS, max: LAUNCH_TIMING.MAX_OPEN_DELAY_SECS, step: 60 },
  help: "The launch's fair-open batch window (openDelaySecs). Nobody can buy from the pool before the batch has run, so time limits start when trading opens.",
};

const pick = <T>(p: Record<string, unknown> | undefined, k: string, d: T): T => (p && p[k] !== undefined ? (p[k] as T) : d);

/**
 * A rule window that covers the first `length` seconds of open trading.
 * Rule times count from the launch's open (the start of the batch window);
 * buys from the pool are refused by the snipe shield until the batch has
 * run, which happens between `openDelaySecs` and `openDelaySecs +
 * EXECUTION_GRACE_SECS` (10 minutes). So the window starts at
 * `openDelaySecs` and ends `length` after the latest moment trading opens
 * (`length` plus up to 10 minutes when the batch runs early), or when the
 * launch guard ends, if sooner. Refused (ProgError "BadWindow") when the
 * guard ends before trading is sure to be open: the rule would do nothing.
 */
export function tradingWindow(openDelaySecs: number, length: number, guardSecs: number): { from: number; to: number } {
  const opens = openDelaySecs + LAUNCH_TIMING.EXECUTION_GRACE_SECS;
  if (guardSecs <= opens) {
    throw new ProgError(
      "BadWindow",
      `the launch guard (${formatDurationLong(guardSecs)}) ends before trading is sure to be open (${formatDurationLong(openDelaySecs)} of batch window plus up to ${formatDurationLong(LAUNCH_TIMING.EXECUTION_GRACE_SECS)} for the batch to run): this rule would do nothing; lengthen the guard`,
    );
  }
  return { from: openDelaySecs, to: Math.min(opens + length, guardSecs) };
}

function openDelayOf(p: Record<string, unknown> | undefined): number {
  const v = toSeconds(pick<Duration>(p, "openDelaySecs", LAUNCH_TIMING.DEFAULT_OPEN_DELAY_SECS), "openDelaySecs");
  if (v < LAUNCH_TIMING.MIN_OPEN_DELAY_SECS || v > LAUNCH_TIMING.MAX_OPEN_DELAY_SECS) {
    throw new ProgError("BadModel", `the batch window must be ${LAUNCH_TIMING.MIN_OPEN_DELAY_SECS} to ${LAUNCH_TIMING.MAX_OPEN_DELAY_SECS} seconds (the launchpad's bounds)`);
  }
  return v;
}

// ------------------------------------------------------------ rules ---

export type RuleTemplateId = "fair-start" | "anti-bot" | "whale-cap" | "team-cant-buy";

export interface RuleTemplate {
  id: RuleTemplateId;
  title: string;
  summary: string;
  params: TemplateParam[];
  build(params?: Record<string, unknown>): RuleSet;
}

function guardOf(p: Record<string, unknown> | undefined): number {
  return toSeconds(pick<Duration>(p, "guardSecs", 3_600), "guard");
}

function keysOf(v: unknown, what: string): Address[] {
  const list = Array.isArray(v) ? (v as KeyInput[]) : v === undefined || v === null ? [] : [v as KeyInput];
  return list.map((k) => {
    try {
      return toAddress(k);
    } catch {
      throw new ProgError("BadAddress", `${what}: "${String(k)}" is not a Solana address`);
    }
  });
}

/**
 * What a buy looks like on chain, for the anti-bot threshold: the number of
 * TOP-LEVEL instructions in the buy's transaction (every instruction in its
 * message: compute-budget, token-account creation, SOL wrap and unwrap, the
 * swap, a memo; not the instructions programs call inside). An ordinary buy
 * from a wallet, Meteora's SDK, Jupiter or this SDK's `buildSwapTx` uses 4
 * to 8 (two compute-budget, create the token account, create the wSOL
 * account, transfer, sync, swap, close). The template refuses buys with
 * more than `maxInstructions` (at least `MIN_TX_IX_COUNT_THRESHOLD`, 10;
 * default 10).
 */
export const ORDINARY_BUY_MAX_INSTRUCTIONS = 8;

/**
 * The lowest instruction-count threshold (TX_IX_COUNT_GT) a template uses:
 * wallets add instructions of their own to a buy (compute budget, Lighthouse
 * safety checks, Jito tips), so a limit below 10 would refuse ordinary buys
 * made from them. Every template's anti-bot condition is "more than N" with
 * N >= this (tested).
 */
export const MIN_TX_IX_COUNT_THRESHOLD = 10;

export const RULE_TEMPLATES: readonly RuleTemplate[] = [
  {
    id: "fair-start",
    title: "Fair start",
    summary: "For the first minutes of trading, no single buy can be large and no buy can leave the receiving wallet holding too much.",
    params: [
      { key: "guardSecs", label: "Launch guard", kind: "duration", default: "1h", range: WINDOWED_GUARD_RANGE },
      OPEN_DELAY_PARAM,
      { key: "window", label: "For how long after trading opens", kind: "duration", default: "10m", range: { min: 60, max: 3_600, step: 60 } },
      { key: "maxBuy", label: "Biggest single buy", kind: "percent", default: "0.5%", range: { min: 1, max: 1_000, step: 1 } },
      { key: "maxBalance", label: "Most a buy can leave in one wallet", kind: "percent", default: "1%", range: { min: 10, max: 1_000, step: 10 } },
    ],
    build: (p) => {
      const guardSecs = guardOf(p);
      const w = tradingWindow(openDelayOf(p), toSeconds(pick<Duration>(p, "window", "10m"), "window"), guardSecs);
      return rules({ guardSecs })
        .capAmount(pick<Percent>(p, "maxBuy", "0.5%"), when.buy(), { code: "EARLY", from: w.from, to: w.to })
        .capBalance(pick<Percent>(p, "maxBalance", "1%"), when.buy(), { code: "WHALE", from: w.from, to: w.to })
        .build();
    },
  },
  {
    id: "anti-bot",
    title: "Anti-bot",
    summary: "For the first minutes of trading, buys packed into unusually busy transactions (bundles, bots) are refused. Ordinary buys still work, including the extra steps wallets add.",
    params: [
      { key: "guardSecs", label: "Launch guard", kind: "duration", default: "1h", range: WINDOWED_GUARD_RANGE },
      OPEN_DELAY_PARAM,
      { key: "window", label: "For how long after trading opens", kind: "duration", default: "2m", range: { min: 30, max: 1_800, step: 30 } },
      {
        key: "maxInstructions",
        label: "Most instructions in a buy",
        kind: "count",
        default: MIN_TX_IX_COUNT_THRESHOLD,
        range: { min: MIN_TX_IX_COUNT_THRESHOLD, max: 20, step: 1 },
        help: "Counts every instruction in the buy's transaction (fees, account setup, wrap, swap, unwrap). Ordinary buys use 4 to 8, and wallets often add a few of their own (fees, safety checks, tips), so the limit can't go below 10.",
      },
    ],
    build: (p) => {
      const guardSecs = guardOf(p);
      const max = pick<number>(p, "maxInstructions", MIN_TX_IX_COUNT_THRESHOLD);
      if (!Number.isInteger(max) || max < MIN_TX_IX_COUNT_THRESHOLD) {
        throw new ProgError(
          "BadModel",
          `the anti-bot limit must be at least ${MIN_TX_IX_COUNT_THRESHOLD} instructions: ordinary buys use up to ${ORDINARY_BUY_MAX_INSTRUCTIONS}, and wallets add a few of their own (fees, safety checks, tips)`,
        );
      }
      const w = tradingWindow(openDelayOf(p), toSeconds(pick<Duration>(p, "window", "2m"), "window"), guardSecs);
      return rules({ guardSecs })
        .deny(when.buy().and(when.txIxCountGt(max)), { code: "BOT", from: w.from, to: w.to })
        .build();
    },
  },
  {
    id: "whale-cap",
    title: "Whale cap",
    summary: "While the launch guard is on, no transfer (other than a sell) can leave the receiving wallet holding more than a set share of the supply.",
    params: [
      { key: "guardSecs", label: "Launch guard", kind: "duration", default: "1h", range: GUARD_RANGE },
      { key: "maxBalance", label: "Most one wallet can end up with", kind: "percent", default: "2%", range: { min: 10, max: 1_000, step: 10 } },
    ],
    build: (p) => rules({ guardSecs: guardOf(p) }).capBalance(pick<Percent>(p, "maxBalance", "2%"), undefined, "WHALE").build(),
  },
  {
    id: "team-cant-buy",
    title: "Team wallets can't receive pool buys",
    summary: "While the launch guard is on, tokens bought from the pool can't be sent to the team wallets you list. (Wallets you don't list are not covered.)",
    params: [
      { key: "guardSecs", label: "Launch guard", kind: "duration", default: "1h", range: GUARD_RANGE },
      { key: "team", label: "Team wallets", kind: "wallets", required: true, help: "1 to 8 wallets" },
    ],
    build: (p) => {
      const team = keysOf(p?.["team"], "team wallet");
      if (team.length === 0) throw new ProgError("BadModel", "add at least one team wallet");
      if (team.length > PXR1.MAX_KEYS) throw new ProgError("TooManyKeys", `at most ${PXR1.MAX_KEYS} team wallets`);
      const b = rules({ guardSecs: guardOf(p) });
      team.forEach((a, i) => b.key(team.length === 1 ? "team" : `team${i + 1}`, a));
      return b.deny(when.buy().and(when.toIn(team)), "TEAM").build();
    },
  },
];

/** Builds a rule template by id. */
export function ruleTemplate(id: RuleTemplateId, params?: Record<string, unknown>): RuleSet {
  const t = RULE_TEMPLATES.find((x) => x.id === id);
  if (!t) throw new ProgError("BadModel", `unknown rule template "${id}"`);
  return t.build(params);
}

/**
 * Combines rule sets (e.g. several templates): rules in order, keys merged by
 * address (first label wins). The guard length must agree.
 */
export function mergeRuleSets(...sets: RuleSet[]): RuleSet {
  const guards = new Set(sets.flatMap((s) => (s.guardSecs === undefined ? [] : [s.guardSecs])));
  if (guards.size > 1) throw new ProgError("BadWindow", "these rule sets were made for different guard lengths");
  const decs = new Set(sets.flatMap((s) => (s.tokenDecimals === undefined ? [] : [s.tokenDecimals])));
  if (decs.size > 1) throw new ProgError("BadModel", "these rule sets use different token decimals");
  const keys: RuleKey[] = [];
  const labels = new Set<string>();
  for (const s of sets) {
    for (const k of s.keys) {
      const address = toAddress(k.address);
      if (keys.some((x) => x.address === address)) continue;
      let label = k.label;
      if (label !== undefined) {
        let n = 2;
        const base = label;
        while (labels.has(label)) label = `${base}${n++}`;
        labels.add(label);
      }
      keys.push(label !== undefined ? { address, label } : { address });
    }
  }
  // Conditions may refer to keys by label; resolve each set on its own first.
  const merged: RuleSet = { keys, rules: sets.flatMap((s) => normalizeRules(s).rules) };
  const [g] = guards;
  if (g !== undefined) merged.guardSecs = g;
  const [d] = decs;
  if (d !== undefined) merged.tokenDecimals = d;
  return normalizeRules(merged);
}

// ------------------------------------------------------------ graphs ---

export type GraphTemplateId = "daily-buyback-burn" | "burn-on-graduation" | "revenue-share" | "ai-buyback";

export interface GraphTemplate {
  id: GraphTemplateId;
  title: string;
  summary: string;
  params: TemplateParam[];
  build(params?: Record<string, unknown>): Graph;
}

export const GRAPH_TEMPLATES: readonly GraphTemplate[] = [
  {
    id: "daily-buyback-burn",
    title: "Daily buyback and burn",
    summary: "Once a day, the treasury buys the token back from the locked pool and burns it.",
    params: [
      { key: "maxIn", label: "SOL per buyback", kind: "sol", default: 0.5, range: { min: 0.01, max: 100, step: 0.01 } },
      { key: "premiumBps", label: "Most it pays above the recent low price", kind: "bps", default: 300, range: { min: 50, max: 2_000, step: 25 } },
      { key: "minTreasury", label: "Only when the treasury has at least", kind: "sol", default: 0.5, range: { min: 0, max: 1_000, step: 0.1 } },
    ],
    build: (p) =>
      graph()
        .node(
          "buyback",
          every("1d"),
          when.graduated().and(when.treasurySolGte(pick<SolAmount>(p, "minTreasury", 0.5))),
          buybackBurn({ maxIn: pick<SolAmount>(p, "maxIn", 0.5), maxPremiumBps: toBps(pick<number | Percent>(p, "premiumBps", 300)) }),
          { epoch: "1d" },
        )
        .build(),
  },
  {
    id: "burn-on-graduation",
    title: "Burn on graduation",
    summary: "When the token graduates, the treasury burns the tokens it holds.",
    params: [{ key: "maxTokens", label: "Most tokens to burn", kind: "tokens", default: 1_000_000_000, range: { min: 1, max: 1_000_000_000, step: 1 } }],
    build: (p) => {
      const max = pick<TokenAmount>(p, "maxTokens", 1_000_000_000);
      return graph().node("burn", onGraduation(), null, burn({ maxTokens: max }), { epoch: "1d", budgetPerEpoch: max }).build();
    },
  },
  {
    id: "revenue-share",
    title: "Revenue share",
    summary: "Every day, the treasury pays its SOL to the people you list, by share.",
    params: [
      { key: "recipients", label: "Who gets paid", kind: "recipients", required: true, help: "addresses with shares adding up to 100%" },
      { key: "maxPerRun", label: "Most SOL per payout", kind: "sol", default: 1, range: { min: 0.01, max: 100, step: 0.01 } },
      { key: "every", label: "How often", kind: "duration", default: "1d", range: { min: 3_600, max: 604_800, step: 3_600 } },
    ],
    build: (p) => {
      const list = pick<{ address: KeyInput; share: Percent | number; label?: string }[]>(p, "recipients", []);
      if (list.length === 0) throw new ProgError("NoRecipients", "add at least one recipient");
      const b = graph();
      for (const r of list) b.recipient(r.address, r.share, r.label);
      const period = pick<Duration>(p, "every", "1d");
      const secs = toSeconds(period);
      return b.node("share", every(period), null, distributeSol(pick<SolAmount>(p, "maxPerRun", 1)), { epoch: Math.max(secs, 3_600) }).build();
    },
  },
  {
    id: "ai-buyback",
    title: "AI-operated buyback",
    summary: "An AI agent picks when and how much to buy back and burn, but only inside hard daily limits.",
    params: [
      { key: "operator", label: "Agent's key", kind: "wallet", required: true },
      { key: "maxIn", label: "Most SOL per buyback", kind: "sol", default: 0.25, range: { min: 0.01, max: 10, step: 0.01 } },
      { key: "budget", label: "Most SOL per day", kind: "sol", default: 1, range: { min: 0.01, max: 100, step: 0.01 } },
      { key: "maxRuns", label: "Most buybacks per day", kind: "count", default: 8, range: { min: 1, max: 144, step: 1 } },
      { key: "premiumBps", label: "Most it pays above the recent low price", kind: "bps", default: 200, range: { min: 50, max: 2_000, step: 25 } },
    ],
    build: (p) => {
      const op = p?.["operator"];
      if (op === undefined || op === null || op === "") throw new ProgError("BadModel", "the AI-operated buyback needs the agent's key");
      return graph({ operator: op as KeyInput })
        .node(
          "ai-buyback",
          whenever(),
          when.graduated(),
          buybackBurn({ maxIn: pick<SolAmount>(p, "maxIn", 0.25), maxPremiumBps: toBps(pick<number | Percent>(p, "premiumBps", 200)) }),
          { epoch: "1d", budgetPerEpoch: pick<SolAmount>(p, "budget", 1), maxRunsPerEpoch: pick(p, "maxRuns", 8), operatorGated: true },
        )
        .build();
    },
  },
];

/** Builds a graph template by id. */
export function graphTemplate(id: GraphTemplateId, params?: Record<string, unknown>): Graph {
  const t = GRAPH_TEMPLATES.find((x) => x.id === id);
  if (!t) throw new ProgError("BadModel", `unknown graph template "${id}"`);
  return t.build(params);
}

/** Token decimals the templates assume when given whole-token amounts. */
export const TEMPLATE_TOKEN_DECIMALS = DEFAULT_TOKEN_DECIMALS;

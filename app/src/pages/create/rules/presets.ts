/**
 * The Simple rules gallery (owner's direction: pick options and move sliders,
 * never write values down): six launch-rule presets a creator switches on,
 * each with one or two sliders over safe stops and a live plain sentence.
 * They compose into one rule set with the rules the creator writes under
 * Advanced. Every rule is built with the SDK's own rule builder; nothing here
 * evaluates a transfer (the SDK's evaluator does, in "Try a transfer").
 *
 * Time windows count from the launch, but nobody can buy from the pool until
 * the opening batch has run (the snipe shield: the batch window plus the
 * launchpad's execution grace). So every "first minutes of trading" window
 * starts at the launch and ends that long after the shield ends (review U6:
 * a window that ended inside the batch would never apply), and it is clamped
 * to the guard: a window that would pass the guard becomes "until the early
 * limits end".
 *
 * Pure (no React); test/rules-presets.test.ts checks every stop of every
 * slider builds a rule set the SDK verifies and that none refuses an
 * ordinary buy.
 */
import { MIN_TX_IX_COUNT_THRESHOLD, rulesBuilder, when, type RuleKey, type RuleSet } from "../../../lib/programmable";
import { plainDuration } from "../simple";

/** What rules depend on: the launch's timing and decimals (from the wizard's draft). */
export interface RulesEnv {
  guardSecs: number;
  /** The fair-open batch window: buys from the pool start after it (and the execution grace). */
  openDelaySecs: number;
  /** The launchpad's execution grace (POLICY.EXECUTION_GRACE_SECS). */
  graceSecs: number;
  decimals: number;
}

export type PresetId = "fair-start" | "anti-bot" | "whale-cap" | "team-cant-buy" | "slow-open" | "no-hopping";

/** A preset's slider positions (stop indexes) and, for the team preset, its wallets. */
export interface PresetValues {
  a: number;
  b: number;
  wallets: string[];
}

export interface PresetSlider {
  label: string;
  stops: readonly number[];
  /** A stop in words ("10 minutes", "0.25%"). */
  text: (v: number) => string;
}

export interface Preset {
  id: PresetId;
  title: string;
  /** One line, plain: what it is for. */
  blurb: string;
  sliders: readonly [PresetSlider] | readonly [PresetSlider, PresetSlider];
  /** Default slider positions. */
  defaults: { a: number; b: number };
  /** Needs a list of wallets. */
  wallets?: boolean;
  /**
   * Limits transfers between holders (not only buys): the card says plainly that moving tokens through a quantum vault
   * or the Shield is never blocked by launch rules (the hook skips them for those programs, review 4 R1).
   */
  limitsTransfers?: boolean;
  /** The live sentence for these values. */
  say: (v: PresetValues, env: RulesEnv) => string;
  /** The rules (via the SDK builder), without the guard length (so "until the early limits end" stays `to: null`). */
  build: (v: PresetValues, env: RulesEnv) => RuleSet;
}

const MIN = 60;
const HOUR = 3_600;
const pct = (bps: number): string => `${Number((bps / 100).toFixed(2))}%`;
const at = <T>(list: readonly T[], i: number): T => list[Math.max(0, Math.min(list.length - 1, i))] as T;

/** When trading from the pool can start at the latest: the batch window plus the execution grace. */
export const tradingOpensAt = (env: RulesEnv): number => env.openDelaySecs + env.graceSecs;

/** The end of a "first `secs` of trading" window, clamped to the guard; null means "until the early limits end". */
export function tradingWindowEnd(env: RulesEnv, secs: number): number | null {
  const end = tradingOpensAt(env) + secs;
  return end >= env.guardSecs ? null : end;
}

/** "For the first 10 minutes of trading" / "Until the early limits end (6 hours after launch)". */
function forTrading(env: RulesEnv, secs: number): string {
  return tradingWindowEnd(env, secs) === null ? `Until the early limits end (${plainDuration(env.guardSecs)} after launch)` : `For the first ${plainDuration(secs)} of trading`;
}

/** SDK rule options for a window from the launch to `end` (null: until the guard ends). */
const firstOrAlways = (end: number | null, code: number): { code: number; first?: number } => (end === null ? { code } : { code, first: end });

const builder = (env: RulesEnv) => rulesBuilder({ tokenDecimals: env.decimals });

/** Codes (RULE_CODES): what holders see when the rule refuses. */
const CODE = { BOT: 1, WHALE: 3, TEAM: 4, P2P: 7, EARLY: 8 } as const;

const DURATIONS = [5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 6 * HOUR] as const;
/** The anti-bot limits offered (top-level instructions in one buy), from the SDK's floor (MIN_TX_IX_COUNT_THRESHOLD, 10). */
export const ANTI_BOT_STOPS: readonly number[] = [MIN_TX_IX_COUNT_THRESHOLD, 12, 16, 20, 24];
const durationSlider = (label: string): PresetSlider => ({ label, stops: DURATIONS, text: (v) => plainDuration(v) });

export const PRESETS: readonly Preset[] = [
  {
    id: "fair-start",
    title: "Fair start",
    blurb: "Small buys only, right after trading opens.",
    sliders: [durationSlider("How long"), { label: "Biggest single buy", stops: [5, 10, 25, 50, 100], text: pct }],
    defaults: { a: 1, b: 2 },
    say: (v, env) => `${forTrading(env, at(DURATIONS, v.a))}, nobody can buy more than ${pct(at([5, 10, 25, 50, 100], v.b))} of the supply at once.`,
    build: (v, env) =>
      builder(env)
        .capAmount({ bps: at([5, 10, 25, 50, 100], v.b) }, when.buy(), firstOrAlways(tradingWindowEnd(env, at(DURATIONS, v.a)), CODE.WHALE))
        .build(),
  },
  {
    id: "anti-bot",
    title: "Anti-bot",
    blurb: "Refuses buys packed into busy, bot-style transactions.",
    sliders: [
      durationSlider("How long"),
      // An ordinary wallet or app buy uses up to about 8 steps (instructions), and wallets add compute-budget and similar
      // steps of their own: never offer a limit below the SDK's floor of 10 (review U6, review 4 R6).
      { label: "Most steps in one buy", stops: ANTI_BOT_STOPS, text: (n) => `${n} steps` },
    ],
    defaults: { a: 2, b: 1 },
    say: (v, env) =>
      `${forTrading(env, at(DURATIONS, v.a))}, a buy packed into a transaction with more than ${at(ANTI_BOT_STOPS, v.b)} steps is refused. Ordinary wallet and app buys use fewer.`,
    build: (v, env) =>
      builder(env)
        .deny(when.buy().and(when.txIxCountGt(at(ANTI_BOT_STOPS, v.b))), firstOrAlways(tradingWindowEnd(env, at(DURATIONS, v.a)), CODE.BOT))
        .build(),
  },
  {
    id: "whale-cap",
    title: "Whale cap",
    blurb: "No wallet can end up holding too much while the early limits last.",
    sliders: [{ label: "Most one wallet can hold", stops: [25, 50, 100, 200, 300], text: pct }],
    defaults: { a: 2, b: 0 },
    limitsTransfers: true,
    say: (v, env) => `Until the early limits end (${plainDuration(env.guardSecs)} after launch), no wallet can end up holding more than ${pct(at([25, 50, 100, 200, 300], v.a))} of the supply.`,
    build: (v, env) => builder(env).capBalance({ bps: at([25, 50, 100, 200, 300], v.a) }, undefined, { code: CODE.WHALE }).build(),
  },
  {
    id: "team-cant-buy",
    title: "Team can't buy",
    blurb: "Your team's wallets can't get tokens bought from the pool.",
    sliders: [{ label: "For how long", stops: [HOUR, 6 * HOUR, 24 * HOUR, 72 * HOUR], text: (s) => plainDuration(s) }],
    defaults: { a: 3, b: 0 },
    wallets: true,
    say: (v, env) => {
      const n = v.wallets.length;
      const who = n === 0 ? "The wallets you add below" : n === 1 ? "Your team's wallet" : `Your team's ${n} wallets`;
      const secs = at([HOUR, 6 * HOUR, 24 * HOUR, 72 * HOUR], v.a);
      const span = secs >= env.guardSecs ? `until the early limits end (${plainDuration(env.guardSecs)} after launch)` : `for the first ${plainDuration(secs)} after launch`;
      return `${who} can't receive tokens bought from the pool ${span}. Selling is never blocked.`;
    },
    build: (v, env) => {
      if (v.wallets.length === 0) throw new Error("Add at least one team wallet.");
      const secs = at([HOUR, 6 * HOUR, 24 * HOUR, 72 * HOUR], v.a);
      const end = secs >= env.guardSecs ? null : secs;
      return builder(env).deny(when.buy().and(when.toIn(v.wallets)), firstOrAlways(end, CODE.TEAM)).build();
    },
  },
  {
    id: "slow-open",
    title: "Slow open",
    blurb: "Buy limits that grow step by step as trading warms up.",
    sliders: [
      { label: "Starting limit per buy", stops: [5, 10, 25, 50], text: pct },
      { label: "Each step lasts", stops: [5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, HOUR], text: (s) => plainDuration(s) },
    ],
    defaults: { a: 1, b: 1 },
    say: (v, env) => {
      const cap = at([5, 10, 25, 50], v.a);
      const step = at([5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, HOUR], v.b);
      const steps = slowSteps(env, step).length;
      if (steps === 0) return "The early limits end before trading opens, so there is no room for a slow open. Make the early limits longer.";
      return `For the first ${plainDuration(step)} of trading one buy can be at most ${pct(cap)} of the supply${steps > 1 ? `, then ${pct(cap * 2)}` : ""}${steps > 2 ? `, then ${pct(cap * 4)}` : ""}, each for ${plainDuration(step)}. After that only the usual limits apply.`;
    },
    build: (v, env) => {
      const cap = at([5, 10, 25, 50], v.a);
      const step = at([5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, HOUR], v.b);
      const b = builder(env);
      slowSteps(env, step).forEach(([from, to], i) => {
        const opts = from === 0 ? (to === null ? { code: CODE.EARLY } : { code: CODE.EARLY, first: to }) : to === null ? { code: CODE.EARLY, after: from } : { code: CODE.EARLY, from, to };
        b.capAmount({ bps: cap * 2 ** i }, when.buy(), opts);
      });
      return b.build();
    },
  },
  {
    id: "no-hopping",
    title: "No wallet hopping",
    blurb: "Tokens can't be passed from wallet to wallet at first, so nobody dodges the limits.",
    sliders: [durationSlider("How long")],
    defaults: { a: 3, b: 0 },
    limitsTransfers: true,
    say: (v, env) => `${forTrading(env, at(DURATIONS, v.a))}, tokens can't be sent from one wallet to another. Buying and selling still work.`,
    build: (v, env) => builder(env).deny(when.p2p(), firstOrAlways(tradingWindowEnd(env, at(DURATIONS, v.a)), CODE.P2P)).build(),
  },
];

/** The slow open's windows: up to three steps of `step` from the launch through the start of trading, clamped to the guard. */
export function slowSteps(env: RulesEnv, step: number): [number, number | null][] {
  const open = tradingOpensAt(env);
  const out: [number, number | null][] = [];
  let from = 0;
  for (let i = 0; i < 3; i++) {
    const end = open + step * (i + 1);
    if (from >= env.guardSecs) break;
    if (end >= env.guardSecs) {
      out.push([from, null]);
      break;
    }
    out.push([from, end]);
    from = end;
  }
  return out;
}

export const presetById = (id: PresetId): Preset => PRESETS.find((p) => p.id === id) as Preset;

export function defaultValues(p: Preset): PresetValues {
  return { a: p.defaults.a, b: p.defaults.b, wallets: [] };
}

/** A preset's rules for these values, or the plain reason it can't build yet (e.g. no team wallet). */
export function presetRules(id: PresetId, v: PresetValues, env: RulesEnv): { ok: true; set: RuleSet } | { ok: false; problem: string } {
  try {
    return { ok: true, set: presetById(id).build(v, env) };
  } catch (e) {
    return { ok: false, problem: e instanceof Error ? e.message : String(e) };
  }
}

/** Keys a preset set names (team wallets), labelled for the code view. */
export function presetKeys(set: RuleSet): RuleKey[] {
  return set.keys;
}

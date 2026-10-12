/**
 * Autopilot, Simple (owner's direction: options and sliders, not typed
 * values): four ready-made jobs a creator switches on, each with one to
 * three sliders over safe stops and a plain sentence. They compose into one
 * Autopilot graph with the SDK's node maker; the Advanced canvas and code
 * edit the same graph.
 *
 *   - Buyback and burn: how much each time, how often, the most it may pay
 *     above the recent low price (never below what the pool's fee needs to
 *     fill: review U5);
 *   - Burn on graduation: how many of the treasury's tokens, once;
 *   - Revenue share: how much per payout and how often, to the launch's fee
 *     recipients (changed under Advanced);
 *   - AI-operated buyback: an agent's key, how much per buyback and per day,
 *     and the most above the recent low price.
 *
 * Node ids: buyback, burn, share, agent.
 *
 * Pure (no React); test/autopilot-simple.test.ts checks every stop builds a
 * graph the SDK verifies.
 */
import { buildGraph, graphNode, isAddress, minPremiumBps, shortAddr, type Graph, type GraphBuild, type GraphNode, type Recipient } from "../../lib/programmable";

export type JobId = "buyback" | "burn" | "share" | "ai";

export interface Choices {
  buyback: { on: boolean; amount: number; every: number; premium: number };
  burn: { on: boolean; amount: number };
  share: { on: boolean; amount: number; every: number };
  ai: { on: boolean; operator: string; perRun: number; perDay: number; premium: number };
}

const SOL = 1_000_000_000n;
const HOUR = 3_600;
const DAY = 86_400;

/** Slider stops. Amounts in SOL (strings, exact), times in seconds, premiums in bps. */
export const STOPS = {
  buybackSol: ["0.05", "0.1", "0.25", "0.5", "1", "2", "5"],
  every: [HOUR, 4 * HOUR, 12 * HOUR, DAY],
  premiumBps: [100, 200, 300, 500, 750, 1_000, 1_500, 2_000],
  burnTokens: [1_000_000, 5_000_000, 10_000_000, 50_000_000, 100_000_000],
  shareSol: ["0.1", "0.25", "0.5", "1", "2", "5"],
  shareEvery: [DAY, 7 * DAY, 30 * DAY],
  aiPerRunSol: ["0.05", "0.1", "0.25", "0.5", "1"],
  aiPerDaySol: ["0.25", "0.5", "1", "2", "5", "10"],
} as const;

export const JOB_TITLES: Record<JobId, string> = {
  buyback: "Buyback and burn",
  burn: "Burn on graduation",
  share: "Revenue share",
  ai: "AI-operated buyback",
};

export const JOB_BLURBS: Record<JobId, string> = {
  buyback: "On a schedule, the treasury buys the token back from its locked pool and burns it.",
  burn: "When the token graduates, the treasury burns the tokens it holds.",
  share: "On a schedule, the treasury pays its SOL to the people you list, by share.",
  ai: "An agent you trust picks when and how much to buy back and burn, inside hard daily limits.",
};

export function defaultChoices(): Choices {
  return {
    buyback: { on: false, amount: 3, every: 3, premium: 1 },
    burn: { on: false, amount: 3 },
    share: { on: false, amount: 3, every: 1 },
    ai: { on: false, operator: "", perRun: 2, perDay: 2, premium: 0 },
  };
}

const at = <T>(list: readonly T[], i: number): T => list[Math.max(0, Math.min(list.length - 1, i))] as T;
const lamports = (sol: string): bigint => {
  const [w = "0", f = ""] = sol.split(".");
  return BigInt(w) * SOL + BigInt((f + "000000000").slice(0, 9));
};

/** Premium stops a pool with this fee can fill at (review U5: below fee / (1 - fee) a buyback never buys). */
export function premiumStops(poolFeeBps: number): number[] {
  const min = minPremiumBps(poolFeeBps);
  const ok = STOPS.premiumBps.filter((b) => b >= min);
  return ok.length > 0 ? ok : [STOPS.premiumBps[STOPS.premiumBps.length - 1] as number];
}

export const pctText = (bps: number): string => `${Number((bps / 100).toFixed(2))}%`;
export const solText = (sol: string): string => `${sol} SOL`;

/** "every hour", "every 4 hours", "every day", "every week", "every 30 days". */
export function everyText(secs: number): string {
  if (secs === HOUR) return "every hour";
  if (secs === DAY) return "every day";
  if (secs === 7 * DAY) return "every week";
  if (secs % DAY === 0) return `every ${secs / DAY} days`;
  return `every ${secs / HOUR} hours`;
}

export function tokensText(n: number): string {
  return n >= 1_000_000 ? `${n / 1_000_000} million` : n.toLocaleString("en-US");
}

/** What the pages need to compose a graph: the launch's facts. */
export interface JobContext {
  symbol: string;
  decimals: number;
  /** The pool's fee after graduation (bps): what a buyback pays. */
  poolFeeBps: number;
  /** Who a revenue share pays: the launch's fee recipients by default. */
  recipients: Recipient[];
}

/** The plain sentence of each job for these choices. */
export function jobSay(id: JobId, c: Choices, ctx: JobContext): string {
  const prem = premiumStops(ctx.poolFeeBps);
  switch (id) {
    case "buyback": {
      const sol = at(STOPS.buybackSol, c.buyback.amount);
      const every = at(STOPS.every, c.buyback.every);
      const runs = Math.max(1, Math.floor(DAY / every));
      const perDay = (Number(sol) * runs).toLocaleString("en-US", { maximumFractionDigits: 4 });
      return `Once ${ctx.symbol} has graduated, ${everyText(every)} the treasury buys back up to ${sol} SOL of ${ctx.symbol} and burns it, never paying more than ${pctText(at(prem, c.buyback.premium))} above its recent low price. At most ${perDay} SOL a day.`;
    }
    case "burn":
      return `When ${ctx.symbol} graduates, the treasury burns up to ${tokensText(at(STOPS.burnTokens, c.burn.amount))} of the ${ctx.symbol} it holds, once.`;
    case "share": {
      const n = ctx.recipients.length;
      const who = n === 0 ? "the people you list" : n === 1 ? "1 wallet" : `${n} wallets (${ctx.recipients.map((r) => pctText(r.bps)).join(", ")})`;
      return `${cap(everyText(at(STOPS.shareEvery, c.share.every)))}, the treasury pays up to ${at(STOPS.shareSol, c.share.amount)} SOL to ${who}, while it holds that much.`;
    }
    case "ai": {
      const who = isAddress(c.ai.operator) ? `The agent ${shortAddr(c.ai.operator)}` : "The agent you name";
      return `${who} decides when to buy back and burn ${ctx.symbol}, up to ${at(STOPS.aiPerRunSol, c.ai.perRun)} SOL at a time and ${at(STOPS.aiPerDaySol, c.ai.perDay)} SOL a day, never more than ${pctText(at(prem, c.ai.premium))} above the recent low price. It can't send funds anywhere else, and your quantum key can remove it at any time.`;
    }
  }
}

const cap = (s: string): string => (s ? (s[0] ?? "").toUpperCase() + s.slice(1) : s);

/** Problems that stop a job from building (plain words), by job. */
export function jobProblems(c: Choices, ctx: JobContext): Partial<Record<JobId, string>> {
  const out: Partial<Record<JobId, string>> = {};
  if (c.ai.on && !isAddress(c.ai.operator.trim())) out.ai = c.ai.operator.trim() === "" ? "Paste the agent's key." : "That is not a valid key: check every character.";
  if (c.share.on && ctx.recipients.length === 0) out.share = "Add who gets paid under Advanced.";
  if (c.ai.on && lamports(at(STOPS.aiPerRunSol, c.ai.perRun)) > lamports(at(STOPS.aiPerDaySol, c.ai.perDay))) out.ai = "The most per buyback can't be more than the most per day.";
  return out;
}

/** The nodes of the jobs that are on (ids: buyback, burn, share, ai). */
function nodesOf(c: Choices, ctx: JobContext): GraphNode[] {
  const dec = ctx.decimals;
  const prem = premiumStops(ctx.poolFeeBps);
  const nodes: GraphNode[] = [];
  if (c.buyback.on) {
    const amount = lamports(at(STOPS.buybackSol, c.buyback.amount));
    const every = at(STOPS.every, c.buyback.every);
    nodes.push(
      graphNode(
        "buyback",
        { kind: "every", secs: every },
        { op: "and", a: { op: "graduated" }, b: { op: "treasurySolGte", lamports: amount } },
        { kind: "buybackBurn", maxInLamports: amount, maxPremiumBps: at(prem, c.buyback.premium) },
        { epochSecs: DAY },
        dec,
      ),
    );
  }
  if (c.burn.on) {
    const raw = BigInt(at(STOPS.burnTokens, c.burn.amount)) * 10n ** BigInt(dec);
    nodes.push(graphNode("burn", { kind: "graduated" }, null, { kind: "burn", maxTokens: raw }, { epochSecs: DAY, budgetPerEpoch: raw, maxRunsPerEpoch: 1 }, dec));
  }
  if (c.share.on) {
    const amount = lamports(at(STOPS.shareSol, c.share.amount));
    const every = at(STOPS.shareEvery, c.share.every);
    nodes.push(graphNode("share", { kind: "every", secs: every }, { op: "treasurySolGte", lamports: amount }, { kind: "distributeSol", maxLamports: amount }, { epochSecs: every, maxRunsPerEpoch: 1 }, dec));
  }
  if (c.ai.on) {
    const perRun = lamports(at(STOPS.aiPerRunSol, c.ai.perRun));
    const perDay = lamports(at(STOPS.aiPerDaySol, c.ai.perDay));
    const runs = Number(perDay / perRun) * 2;
    nodes.push(
      graphNode(
        "agent",
        { kind: "when" },
        { op: "graduated" },
        { kind: "buybackBurn", maxInLamports: perRun, maxPremiumBps: at(prem, c.ai.premium) },
        { epochSecs: DAY, budgetPerEpoch: perDay, maxRunsPerEpoch: Math.max(1, Math.min(144, runs)), operatorGated: true },
        dec,
      ),
    );
  }
  return nodes;
}

/** The graph the switched-on jobs make, or why it can't be made yet. */
export function composeJobs(c: Choices, ctx: JobContext): { graph: Graph | null; problems: Partial<Record<JobId, string>>; build: GraphBuild | null } {
  const problems = jobProblems(c, ctx);
  if (Object.keys(problems).length > 0) return { graph: null, problems, build: null };
  const nodes = nodesOf(c, ctx);
  if (nodes.length === 0) return { graph: null, problems, build: null };
  const graph: Graph = {
    operator: c.ai.on ? c.ai.operator.trim() : null,
    recipients: c.share.on ? ctx.recipients.map((r) => ({ address: r.address, bps: r.bps })) : [],
    nodes,
    tokenDecimals: ctx.decimals,
  };
  return { graph, problems, build: buildGraph(graph) };
}

/** Number of jobs switched on. */
export const jobsOn = (c: Choices): number => (["buyback", "burn", "share", "ai"] as const).filter((id) => c[id].on).length;

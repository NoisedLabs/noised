/**
 * Autopilot graphs in plain English, one line per node (plus the
 * guarantees). The lines say what the autopilot program enforces and no
 * more (review U14): recipients and the operator are named by their full
 * address (the creator's label in quotes next to it); a price condition must
 * hold for the slow reference price and every price seen in the last 15 to
 * 30 minutes, never the live one alone (review F1); tips are listed among
 * what can leave the treasury.
 */
import { AUTOPILOT, DEFAULT_TOKEN_DECIMALS } from "../constants.js";
import { shortAddress } from "../bytes.js";
import { type Cond, checkCondSize } from "../cond/ast.js";
import {
  formatBps,
  formatDate,
  formatDurationLong,
  formatPeriod,
  formatSol,
  formatTokens,
  sqrtPriceQ64ToPriceText,
} from "../units.js";
import { decompileGraph, type Graph, type GraphDecompileOptions, type GraphNode } from "./model.js";

export interface ExplainGraphOptions extends GraphDecompileOptions {
  /** Append the always-true guarantees. Default true. */
  guarantees?: boolean;
  /** How addresses appear: "full" (default; what a review or token page shows) or "short" (`7xKX…AsU`). */
  addresses?: "full" | "short";
}

type Addresses = "full" | "short";
const addr = (a: string, how: Addresses): string => (how === "full" ? a : shortAddress(a));

const cap1 = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

function nodeName(_g: Graph, id: string): string {
  return `“${id}”`;
}

function sol(l: bigint): string {
  return `${formatSol(l, true)} SOL`;
}

function tokens(u: bigint, dec: number): string {
  return `${formatTokens(u, dec, true)} tokens`;
}

function leafText(g: Graph, c: Cond, neg: boolean, dec: number): string | null {
  switch (c.op) {
    case "true":
      return neg ? "never" : "always";
    case "false":
      return neg ? "always" : "never";
    case "treasurySolGte":
      return `the treasury has ${neg ? "less than" : "at least"} ${sol(c.lamports)}`;
    case "treasuryTokensGte": {
      const amt = "raw" in c.amount ? tokens(c.amount.raw, dec) : `${c.amount.tokens} tokens`;
      return `the treasury has ${neg ? "less than" : "at least"} ${amt}`;
    }
    case "graduated":
      return neg ? "the token hasn't graduated yet" : "the token has graduated";
    case "priceLte":
    case "priceGte": {
      // The program checks the reference price (it follows the pool slowly) and every price seen in the
      // last 15 to 30 minutes, and all of them must pass, under NOT too (review F1): "has stayed". So one
      // trade across the limit and back can keep it false, never true (follow-up review L-1).
      const p = "sol" in c.price ? c.price.sol : sqrtPriceQ64ToPriceText(c.price.sqrtPriceQ64, dec);
      const atMost = (c.op === "priceLte") !== neg;
      return `the price has stayed ${atMost ? (neg ? "above" : "at most") : neg ? "below" : "at least"} ${p} SOL per token`;
    }
    case "nowGe":
      return neg ? `it's before ${formatDate(c.unix)}` : `it's ${formatDate(c.unix)} or later`;
    case "nowLt":
      return neg ? `it's ${formatDate(c.unix)} or later` : `it's before ${formatDate(c.unix)}`;
    case "runsInEpochLt": {
      const ref = g.nodes.find((n) => n.id === c.node);
      const period = ref ? formatPeriod(ref.epochSecs) : "budget period";
      return `${nodeName(g, c.node)} ran ${neg ? "at least" : "fewer than"} ${c.n} time${c.n === 1 ? "" : "s"} this ${period}`;
    }
    default:
      return null;
  }
}

function condText(g: Graph, c: Cond, dec: number): string {
  const l = leafText(g, c, false, dec);
  if (l !== null) return l;
  switch (c.op) {
    case "not":
      return leafText(g, c.x, true, dec) ?? `not (${condText(g, c.x, dec)})`;
    case "and":
    case "or": {
      const side = (x: Cond): string => {
        const t = condText(g, x, dec);
        return (x.op === "and" || x.op === "or") && x.op !== c.op ? `(${t})` : t;
      };
      return `${side(c.a)} ${c.op} ${side(c.b)}`;
    }
    default:
      return c.op;
  }
}

function triggerText(g: Graph, n: GraphNode, dec: number): string {
  switch (n.trigger.kind) {
    case "every":
      return n.trigger.secs % 86_400 === 0 || n.trigger.secs % 3_600 === 0 || n.trigger.secs % 60 === 0
        ? `every ${formatPeriod(n.trigger.secs)}`
        : `every ${formatDurationLong(n.trigger.secs)}`;
    case "after":
      return `right after ${nodeName(g, n.trigger.node)} runs`;
    case "graduated":
      return "once, when the token graduates";
    case "when":
      return n.when ? `whenever ${condText(g, n.when, dec)}` : "whenever possible";
  }
}

/** A recipient or the operator: the address, with the creator's label in quotes when there is one. */
function who(address: string, label: string | undefined, how: Addresses): string {
  return label !== undefined ? `“${label}” ${addr(address, how)}` : addr(address, how);
}

function recipientsText(g: Graph, how: Addresses): string {
  if (g.recipients.length === 0) return "the recipients";
  return g.recipients.map((r) => `${who(r.address, r.label, how)} (${formatBps(r.bps)})`).join(", ");
}

function actionText(g: Graph, n: GraphNode, dec: number, how: Addresses): string {
  const a = n.action;
  switch (a.kind) {
    case "buybackBurn":
      return `buy back up to ${sol(a.maxInLamports)} of the token and burn it, never paying more than ${formatBps(a.maxPremiumBps)} above its recent low price`;
    case "burn":
      return `burn up to ${tokens(a.maxTokens, dec)} from the treasury`;
    case "distributeSol":
      return `pay up to ${sol(a.maxLamports)} to ${recipientsText(g, how)}`;
  }
}

/** One node as a sentence (addresses in full unless `opts.addresses` is "short"). */
export function explainNode(g: Graph, index: number, opts: { addresses?: Addresses } = {}): string {
  const how = opts.addresses ?? "full";
  const n = g.nodes[index]!;
  if (n.when) checkCondSize(n.when);
  const dec = g.tokenDecimals ?? DEFAULT_TOKEN_DECIMALS;
  const period = formatPeriod(n.epochSecs);
  const cond = n.when && n.trigger.kind !== "when" ? `, if ${condText(g, n.when, dec)}` : "";
  const amount = (x: bigint): string => (n.action.kind === "burn" ? tokens(x, dec) : sol(x));
  const p1 = n.action.kind === "buybackBurn" ? n.action.maxInLamports : n.action.kind === "burn" ? n.action.maxTokens : n.action.maxLamports;
  // An on-graduation node runs once ever: its epoch limits never come into play beyond that one run.
  const limits =
    n.trigger.kind === "graduated"
      ? `It runs once, for at most ${amount(p1 < n.budgetPerEpoch ? p1 : n.budgetPerEpoch)}.`
      : `At most ${amount(n.budgetPerEpoch)} and ${n.maxRunsPerEpoch} run${n.maxRunsPerEpoch === 1 ? "" : "s"} per ${period}.`;
  const runner = n.operatorGated
    ? `The operator${g.operator ? ` (${addr(g.operator, how)})` : ""} decides when and how much, inside these limits.`
    : `Anyone can run it for a small tip (up to ${formatSol(AUTOPILOT.TIP_LAMPORTS)} SOL).`;
  // A one-word name reads as a title ("Buyback:"); anything else is shown as typed ("“ai-buyback”:").
  const title = /^[a-z]+$/.test(n.id) ? cap1(n.id) : nodeName(g, n.id);
  return `${title}: ${triggerText(g, n, dec)}${cond}, ${actionText(g, n, dec, how)}. ${limits} ${runner}`;
}

/** Whether any node's condition reads the price. */
function readsPrice(g: Graph): boolean {
  const walk = (c: Cond): boolean =>
    c.op === "priceLte" || c.op === "priceGte" ? true : c.op === "and" || c.op === "or" ? walk(c.a) || walk(c.b) : c.op === "not" ? walk(c.x) : false;
  return g.nodes.some((n) => n.when !== null && walk(n.when));
}

/** Plain-English lines for a graph (model or PXG1 bytes), then the guarantees. */
export function explainGraph(input: Graph | Uint8Array, opts: ExplainGraphOptions = {}): string[] {
  const g = input instanceof Uint8Array ? decompileGraph(input, opts) : input;
  const how = opts.addresses ?? "full";
  const lines = g.nodes.map((_, i) => explainNode(g, i, { addresses: how }));
  if (opts.guarantees ?? true) {
    if (readsPrice(g)) {
      lines.push(
        "A price check passes only if the reference price and every price seen in the last 15 to 30 minutes pass it: the price must have stayed at or above (or at or below) the limit across that time. So a brief spike or dip can hold a step back but never set it off: someone willing to pay trading fees can delay a step that waits on the price, never trigger it. The reference price starts at the launch's migration price and follows the pool's price slowly: it rises at most 5% an hour and falls at once.",
      );
    }
    const pays = g.recipients.length > 0 ? ", pay the recipients listed above" : "";
    lines.push(
      `The treasury can only buy back and burn the token, burn tokens it holds${pays} and pay small tips to whoever runs a step (at most ${formatSol(AUTOPILOT.TIP_LAMPORTS)} SOL a run and ${formatSol(AUTOPILOT.TIP_EPOCH_CAP)} SOL a day). It never sells the token.`,
    );
    lines.push("The autopilot never touches the pool's locked liquidity, and it can't mint new tokens or freeze anyone's tokens.");
    if (g.operator !== null) {
      lines.push("Even with a stolen operator key, nobody can go past these limits, and the creator can remove the operator at any time (even after freezing).");
    }
    lines.push("Replacing these steps needs the creator's quantum key and a 72-hour public wait, and the creator can freeze them forever.");
  }
  return lines;
}

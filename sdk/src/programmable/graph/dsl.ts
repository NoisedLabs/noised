/**
 * The autopilot text DSL (grammar in src/programmable/README.md).
 *
 *   autopilot v1
 *   recipient team = <address> 70%
 *   recipient dao = <address> 30%
 *
 *   node buyback: every 1d
 *     when graduated and treasury_sol >= 1 SOL
 *     do buyback 0.5 SOL premium 3%
 *     budget 2 SOL per 1d
 *     max 4 runs
 *
 * parseGraph(printGraph(g)) compiles to the same bytes as g, and
 * printGraph(parseGraph(t)) is the canonical text of t.
 */
import { DEFAULT_TOKEN_DECIMALS, PXG1 } from "../constants.js";
import { isAddress, toAddress } from "../bytes.js";
import { DslError, ProgError } from "../errors.js";
import type { Cond } from "../cond/ast.js";
import {
  type Cursor,
  type Line,
  atTok,
  cursorOf,
  lex,
  lineError,
  parseCond,
  printCond,
  readDuration,
  readInt,
  readQuantity,
} from "../dsl/core.js";
import {
  formatBps,
  formatDate,
  formatDuration,
  formatSol,
  formatTokens,
  parseDecimal,
  priceToSqrtPriceQ64,
  scaleDecimal,
  sqrtPriceQ64ToPriceText,
  toUnix,
} from "../units.js";
import { makeNode } from "./node.js";
import { type Action, compileGraph, type Graph, type GraphNode, isNodeId, normalizeGraph, type Recipient, type Trigger } from "./model.js";

export interface ParseGraphOptions {
  /** Token decimals when the text has no `decimals` line (default 6). */
  tokenDecimals?: number;
}

export type ParseGraphResult = { ok: true; graph: Graph } | { ok: false; errors: DslError[] };

const LEAF_HINT =
  "conditions: treasury_sol >= 1 SOL, treasury_tokens >= 1000 tokens, graduated, price <= 0.0001 SOL, price >= 0.0001 SOL, now >= 2027-01-01, now < 2027-01-01, runs(node) < 3, not, and, or";

function readSol(c: Cursor, what: string): bigint {
  const q = readQuantity(c, what);
  const d = parseDecimal(q.num)!;
  if (q.unit === "sol") return atTok(q.tok, () => scaleDecimal(d, 9, what));
  if (q.unit === "lamport" || q.unit === "lamports") {
    if (d.scale > 0) c.fail(`${what}: lamports are whole numbers`, undefined, q.tok);
    return d.num;
  }
  return c.fail(q.unit ? `${what}: "${q.unit}" is not a SOL unit` : `${what}: "${q.num}" needs a unit`, `write ${q.num} SOL`, q.tok);
}

function readTokens(c: Cursor, dec: number, what: string): bigint {
  const q = readQuantity(c, what);
  const d = parseDecimal(q.num)!;
  if (q.unit === "token" || q.unit === "tokens") return atTok(q.tok, () => scaleDecimal(d, dec, what));
  if (q.unit === "unit" || q.unit === "units") {
    if (d.scale > 0) c.fail(`${what}: units are whole numbers`, undefined, q.tok);
    return d.num;
  }
  return c.fail(q.unit ? `${what}: "${q.unit}" is not a token unit` : `${what}: "${q.num}" needs a unit`, `write ${q.num} tokens`, q.tok);
}

function readPercentBps(c: Cursor, what: string): number {
  const q = readQuantity(c, what);
  const d = parseDecimal(q.num)!;
  if (q.unit === "%") {
    if (d.scale > 2) c.fail(`${what}: percentages go in steps of 0.01%`, undefined, q.tok);
    return Number(scaleDecimal(d, 2, what));
  }
  if (q.unit === "bps") {
    if (d.scale > 0) c.fail(`${what}: bps must be a whole number`, undefined, q.tok);
    return Number(d.num);
  }
  return c.fail(`${what}: write a percentage like 3% or 300bps`, undefined, q.tok);
}

function graphLeaf(dec: number) {
  return (c: Cursor): Cond | null => {
    const t = c.peek();
    if (!t || t.kind !== "atom") return null;
    const w = t.text.toLowerCase();
    const cmp = (allowed: string[], example: string): string => {
      const op = c.next();
      if (!allowed.includes(op.text)) c.fail(`"${w}" compares with ${allowed.join(" or ")}`, example, op);
      return op.text;
    };
    switch (w) {
      case "graduated":
        c.next();
        return { op: "graduated" };
      case "treasury_sol":
        c.next();
        cmp([">="], "e.g. treasury_sol >= 1 SOL (use not for less than)");
        return { op: "treasurySolGte", lamports: readSol(c, "treasury_sol") };
      case "treasury_tokens":
        c.next();
        cmp([">="], "e.g. treasury_tokens >= 1000 tokens");
        return { op: "treasuryTokensGte", amount: { raw: readTokens(c, dec, "treasury_tokens") } };
      case "price": {
        c.next();
        const op = cmp(["<=", ">="], "e.g. price <= 0.0001 SOL");
        const q = readQuantity(c, "price");
        let s: bigint;
        if (q.unit === "sol") s = atTok(q.tok, () => priceToSqrtPriceQ64(q.num, dec));
        else if (q.unit === "q64") {
          if (!/^\d+$/.test(q.num)) c.fail("price: a q64 price is a whole number", undefined, q.tok);
          s = BigInt(q.num);
        } else return c.fail(`price: write it in SOL per token, e.g. ${q.num} SOL`, undefined, q.tok);
        if (s >= 1n << 64n) c.fail("price is too high to compare on-chain", undefined, q.tok);
        return { op: op === "<=" ? "priceLte" : "priceGte", price: { sqrtPriceQ64: s } };
      }
      case "now": {
        c.next();
        const op = cmp([">=", "<"], "e.g. now >= 2027-01-01");
        const d = c.next();
        const unix = atTok(d, () => toUnix(d.text));
        return { op: op === ">=" ? "nowGe" : "nowLt", unix };
      }
      case "runs": {
        c.next();
        c.expect("(", "write runs(node) < 3");
        const id = c.next();
        c.expect(")", "write runs(node) < 3");
        cmp(["<"], "e.g. runs(buyback) < 3");
        return { op: "runsInEpochLt", node: id.text, n: readInt(c, "run count") };
      }
      default:
        return null;
    }
  };
}

interface Draft {
  id: string;
  line: Line;
  trigger: Trigger;
  when: Cond | null;
  action: Action | null;
  budget: { amount: bigint; unit: "lamports" | "tokens"; line: Line } | null;
  epoch: number | null;
  maxRuns: number | null;
  gated: boolean;
  /** A line of this node had an error: report it, don't build the node. */
  broken: boolean;
}

function parseTrigger(c: Cursor): Trigger {
  const t = c.next();
  switch (t.text.toLowerCase()) {
    case "every": {
      const secs = readDuration(c, "every");
      if (secs < PXG1.MIN_EVERY_SECS) c.fail("a node can repeat at most every 10 minutes", "use every 10m or longer", t);
      return { kind: "every", secs };
    }
    case "after": {
      const id = c.next();
      return { kind: "after", node: id.text };
    }
    case "on":
      c.expect("graduation", "write on graduation");
      return { kind: "graduated" };
    case "whenever":
      return { kind: "when" };
    default:
      return c.fail(`unknown trigger "${t.text}"`, "use every 1d, after <node>, on graduation or whenever", t);
  }
}

function parseAction(c: Cursor, dec: number): Action {
  const t = c.next();
  switch (t.text.toLowerCase()) {
    case "buyback": {
      const maxIn = readSol(c, "buyback");
      c.expect("premium", "write buyback 0.5 SOL premium 3%");
      const p = c.peek();
      const premium = readPercentBps(c, "premium");
      if (premium > PXG1.MAX_PREMIUM_BPS) c.fail(`the premium can be at most ${formatBps(PXG1.MAX_PREMIUM_BPS)}`, undefined, p);
      return { kind: "buybackBurn", maxInLamports: maxIn, maxPremiumBps: premium };
    }
    case "burn":
      return { kind: "burn", maxTokens: readTokens(c, dec, "burn") };
    case "distribute":
      return { kind: "distributeSol", maxLamports: readSol(c, "distribute") };
    default:
      return c.fail(`unknown action "${t.text}"`, "use buyback 0.5 SOL premium 3%, burn 1000 tokens or distribute 1 SOL", t);
  }
}

/** Parses autopilot text, collecting errors (one per line) instead of stopping at the first. */
export function tryParseGraph(text: string, opts: ParseGraphOptions = {}): ParseGraphResult {
  const errors: DslError[] = [];
  let dec = opts.tokenDecimals ?? DEFAULT_TOKEN_DECIMALS;
  let decimalsSet: number | undefined;
  let operator: string | null = null;
  const recipients: Recipient[] = [];
  const drafts: Draft[] = [];
  let cur: Draft | null = null;
  const lines = lex(text);
  lines.forEach((line, li) => {
    const c = cursorOf([line]);
    const head = c.peek()!;
    const w = head.text.toLowerCase();
    try {
      if (line.indented) {
        if (!cur) throw lineError(line, "this line is indented but there is no node above it", "start a node with: node name: every 1d");
        const d: Draft = cur;
        c.next();
        switch (w) {
          case "when":
            if (d.when) c.fail("this node already has a condition", "combine them with and / or", head);
            d.when = parseCond(c, graphLeaf(dec), LEAF_HINT);
            break;
          case "do":
            if (d.action) c.fail("this node already has an action (one action per node)", undefined, head);
            d.action = parseAction(c, dec);
            break;
          case "budget": {
            const q = readQuantity(c, "budget");
            const d0 = parseDecimal(q.num)!;
            let amount: bigint;
            let unit: "lamports" | "tokens";
            if (q.unit === "sol") {
              amount = atTok(q.tok, () => scaleDecimal(d0, 9, "budget"));
              unit = "lamports";
            } else if (q.unit === "lamport" || q.unit === "lamports" || q.unit === "unit" || q.unit === "units") {
              if (d0.scale > 0) c.fail("budget: raw amounts are whole numbers", undefined, q.tok);
              amount = d0.num;
              unit = q.unit.startsWith("lamport") ? "lamports" : "tokens";
            } else if (q.unit === "token" || q.unit === "tokens") {
              amount = atTok(q.tok, () => scaleDecimal(d0, dec, "budget"));
              unit = "tokens";
            } else {
              return c.fail(`budget: write it in SOL or tokens, e.g. ${q.num} SOL`, undefined, q.tok);
            }
            if (amount === 0n) c.fail("the budget must be more than zero", undefined, q.tok);
            c.expect("per", "write budget 2 SOL per 1d");
            const p = c.peek();
            const epoch = readDuration(c, "budget period");
            if (epoch < PXG1.MIN_EPOCH_SECS) c.fail("a budget period is at least 1h", undefined, p);
            d.budget = { amount, unit, line };
            d.epoch = epoch;
            break;
          }
          case "max": {
            const p = c.peek();
            const n = readInt(c, "max runs");
            if (!c.eat("runs") && !c.eat("run")) c.fail(`write max ${n} runs`, undefined, c.peek());
            if (n < 1 || n > 0xffff) c.fail("max runs is 1..=65535", undefined, p);
            d.maxRuns = n;
            break;
          }
          case "operator":
            c.expect("decides", "write operator decides");
            d.gated = true;
            break;
          default:
            c.fail(`unknown node setting "${head.text}"`, "use when, do, budget, max or operator decides", head);
        }
        c.expectEnd();
        return;
      }
      cur = null;
      c.next();
      switch (w) {
        case "autopilot": {
          if (li !== 0) c.fail(`"autopilot v1" goes on the first line only`, undefined, head);
          const v = c.next();
          if (v.text.toLowerCase() !== "v1") c.fail(`unsupported version "${v.text}"`, "this is autopilot v1", v);
          break;
        }
        case "decimals": {
          const p = c.peek();
          const d = readInt(c, "decimals");
          if (d > 18) c.fail("decimals must be 0..=18", undefined, p);
          if (drafts.length > 0) c.fail(`put "decimals" above the nodes`, undefined, head);
          dec = d;
          decimalsSet = d;
          break;
        }
        case "operator": {
          c.expect("=", "write operator = <address>");
          const a = c.next();
          if (!isAddress(a.text)) c.fail(`"${a.text}" is not a Solana address`, undefined, a);
          if (operator !== null) c.fail("the operator is declared twice", undefined, head);
          operator = toAddress(a.text);
          break;
        }
        case "recipient": {
          const name = c.next();
          if (!isNodeId(name.text) || isAddress(name.text)) c.fail(`"${name.text}" can't be a recipient name`, undefined, name);
          if (recipients.some((r) => r.label === name.text)) c.fail(`recipient "${name.text}" is declared twice`, undefined, name);
          c.expect("=", `write recipient ${name.text} = <address> 50%`);
          const a = c.next();
          if (!isAddress(a.text)) c.fail(`"${a.text}" is not a Solana address`, undefined, a);
          const bps = readPercentBps(c, "share");
          recipients.push({ address: toAddress(a.text), bps, label: name.text });
          break;
        }
        case "node": {
          // the draft exists before the header is checked, so its body lines attach to it
          const d: Draft = { id: "", line, trigger: { kind: "when" }, when: null, action: null, budget: null, epoch: null, maxRuns: null, gated: false, broken: true };
          cur = d;
          const id = c.next();
          if (!isNodeId(id.text)) c.fail(`"${id.text}" can't be a node name`, "use letters, digits, _ and -", id);
          if (drafts.some((x) => x.id === id.text)) c.fail(`there is already a node called "${id.text}"`, undefined, id);
          d.id = id.text;
          drafts.push(d);
          c.expect(":", `write node ${id.text}: every 1d`);
          d.trigger = parseTrigger(c);
          c.expectEnd();
          d.broken = false;
          return;
        }
        default:
          c.fail(`expected node, recipient, operator or decimals`, "e.g. node buyback: every 1d", head);
      }
      c.expectEnd();
    } catch (e) {
      if (e instanceof DslError) {
        errors.push(e);
        if (line.indented && cur) cur.broken = true;
      } else throw e;
    }
  });
  const nodes: GraphNode[] = [];
  for (const d of drafts) {
    if (d.broken) continue;
    try {
      if (!d.action) throw lineError(d.line, `node "${d.id}" has no action`, "add an indented line: do buyback 0.5 SOL premium 3%");
      if (d.trigger.kind === "when" && !d.when) throw lineError(d.line, `node "${d.id}" runs "whenever" but has no condition`, "add: when <condition>");
      const unit = d.action.kind === "burn" ? "tokens" : "lamports";
      if (d.budget && d.budget.unit !== unit) {
        throw lineError(d.budget.line, `the budget of "${d.id}" must be in ${unit === "tokens" ? "tokens" : "SOL"}`);
      }
      const opts: Parameters<typeof makeNode>[4] = { operatorGated: d.gated };
      if (d.epoch !== null) opts.epoch = d.epoch;
      if (d.maxRuns !== null) opts.maxRunsPerEpoch = d.maxRuns;
      if (d.budget) opts.budgetPerEpoch = d.budget.amount;
      nodes.push(makeNode(d.id, d.trigger, d.when, d.action, opts, dec));
    } catch (e) {
      if (e instanceof DslError) errors.push(e);
      else if (e instanceof ProgError) errors.push(lineError(d.line, e.message));
      else throw e;
    }
  }
  if (errors.length === 0 && drafts.length === 0) {
    errors.push(new DslError("there are no nodes yet", 1, 1, 0, 1, "e.g. node buyback: every 1d"));
  }
  if (errors.length > 0) return { ok: false, errors: errors.sort((a, b) => a.offset - b.offset) };
  const g: Graph = { operator, recipients, nodes };
  if (decimalsSet !== undefined) g.tokenDecimals = decimalsSet;
  try {
    compileGraph(g);
  } catch (e) {
    if (e instanceof ProgError) {
      const l = e.at.node !== undefined ? drafts[e.at.node]?.line : drafts[0]?.line;
      return { ok: false, errors: [lineError(l ?? lines[0]!, e.message)] };
    }
    throw e;
  }
  return { ok: true, graph: normalizeGraph(g) };
}

/** Parses autopilot text; throws the first DslError. */
export function parseGraph(text: string, opts: ParseGraphOptions = {}): Graph {
  const r = tryParseGraph(text, opts);
  if (!r.ok) throw r.errors[0]!;
  return r.graph;
}

// ------------------------------------------------------------ printer ---

/** Canonical text of a graph. Unnamed recipients become recipient1, recipient2, ... */
export function printGraph(input: Graph): string {
  const g = normalizeGraph(input);
  const dec = g.tokenDecimals ?? DEFAULT_TOKEN_DECIMALS;
  const sol = (l: bigint): string => `${formatSol(l)} SOL`;
  const tok = (u: bigint): string => `${formatTokens(u, dec)} tokens`;
  const out: string[] = ["autopilot v1"];
  if (g.tokenDecimals !== undefined) out.push(`decimals ${g.tokenDecimals}`);
  if (g.operator) out.push(`operator = ${g.operator}`);
  const taken = new Set(g.recipients.flatMap((r) => (r.label ? [r.label] : [])));
  let k = 1;
  for (const r of g.recipients) {
    let name = r.label && isNodeId(r.label) && !isAddress(r.label) ? r.label : undefined;
    if (!name) {
      while (taken.has(`recipient${k}`)) k++;
      name = `recipient${k}`;
      taken.add(name);
    }
    out.push(`recipient ${name} = ${r.address} ${formatBps(r.bps)}`);
  }
  const leaf = (c: Cond): string => {
    switch (c.op) {
      case "graduated":
        return "graduated";
      case "treasurySolGte":
        return `treasury_sol >= ${sol(c.lamports)}`;
      case "treasuryTokensGte":
        return `treasury_tokens >= ${tok("raw" in c.amount ? c.amount.raw : 0n)}`;
      case "priceLte":
      case "priceGte": {
        const s = "sqrtPriceQ64" in c.price ? c.price.sqrtPriceQ64 : priceToSqrtPriceQ64(c.price.sol, dec);
        return `price ${c.op === "priceLte" ? "<=" : ">="} ${sqrtPriceQ64ToPriceText(s, dec)} SOL`;
      }
      case "nowGe":
        return `now >= ${formatDate(c.unix)}`;
      case "nowLt":
        return `now < ${formatDate(c.unix)}`;
      case "runsInEpochLt":
        return `runs(${c.node}) < ${c.n}`;
      default:
        throw new ProgError("WrongContext", `"${c.op}" is a launch-rule condition; it can't be used in an autopilot graph`);
    }
  };
  for (const n of g.nodes) {
    out.push("");
    const trig =
      n.trigger.kind === "every"
        ? `every ${formatDuration(n.trigger.secs)}`
        : n.trigger.kind === "after"
          ? `after ${n.trigger.node}`
          : n.trigger.kind === "graduated"
            ? "on graduation"
            : "whenever";
    out.push(`node ${n.id}: ${trig}`);
    if (n.when) out.push(`  when ${printCond(n.when, leaf)}`);
    const a = n.action;
    out.push(
      a.kind === "buybackBurn"
        ? `  do buyback ${sol(a.maxInLamports)} premium ${formatBps(a.maxPremiumBps)}`
        : a.kind === "burn"
          ? `  do burn ${tok(a.maxTokens)}`
          : `  do distribute ${sol(a.maxLamports)}`,
    );
    out.push(`  budget ${a.kind === "burn" ? tok(n.budgetPerEpoch) : sol(n.budgetPerEpoch)} per ${formatDuration(n.epochSecs)}`);
    out.push(`  max ${n.maxRunsPerEpoch} run${n.maxRunsPerEpoch === 1 ? "" : "s"}`);
    if (n.operatorGated) out.push("  operator decides");
  }
  return out.join("\n") + "\n";
}

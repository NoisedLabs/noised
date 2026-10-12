/**
 * Programmable launches, the pure side (PROGRAMMABLE_V1 §5): launch rules
 * (PXR1) and Autopilot graphs (PXG1) as data, their text DSLs, the exact byte
 * formats, the verifiers, explanations, the transfer evaluator and the
 * treasury simulator. All of it is the SDK's programmable module; this file
 * only adapts its results to what the pages show (plain problems instead of
 * exceptions, plain words instead of labels and codes) and is the ONE place
 * the app's pages import it from.
 *
 * Everything comes from "@noisedlabs/sdk/programmable" (SDK 0.6.0), the pure
 * entry point: no Solana client code, so the simulated chain uses it too.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import type { PublicKey } from "@solana/web3.js";

import {
  activationPayload as sdkActivationPayload,
  AUTH_DOMAINS as SDK_AUTH_DOMAINS,
  AUTH_KIND as SDK_AUTH_KIND,
  AUTOPILOT,
  canvasToGraph,
  compileGraph,
  compileRules,
  connectNodes,
  decompileGraph,
  decompileRules,
  disconnectEdge,
  DslError,
  explainGraph,
  explainNode,
  estimateBuybackOut,
  explainRule,
  explainRules,
  findDueNodes,
  formatDuration as sdkFormatDuration,
  FREEZE_DEFAULT_VALID_SECS,
  freezePayload as sdkFreezePayload,
  GRAPH_TEMPLATES,
  graphHash,
  graphToCanvas,
  isAddress as sdkIsAddress,
  KNOWN_PROGRAMS,
  LAUNCH_TIMING,
  makeNode,
  minPremiumForFee,
  newAutopilotState,
  nodeStatus,
  normalizeGraph,
  normalizeRules,
  ORDINARY_BUY_MAX_INSTRUCTIONS,
  printGraph,
  printRules,
  priceToSqrtPriceQ64,
  ProgError,
  burnPrice,
  lowestObserved,
  planMaxTip,
  planValue,
  revokePayload as sdkRevokePayload,
  takeTipRaw,
  PXG1,
  PXR1,
  RULE_CODE_TEXT,
  RULE_CODES,
  rulesHash,
  shares,
  shortAddress,
  simulateGraph,
  simulateTransfer,
  sqrtPriceQ64ToPrice,
  tryParseGraph,
  tryParseRules,
  validateCanvas,
  verifyGraph,
  type Action,
  type Amount,
  type BuiltinGuard,
  type Canvas,
  type CanvasIssue,
  type Cond,
  type Graph,
  type GraphNode,
  type GraphTimeline,
  type ObsBucket,
  type Recipient,
  type Rule,
  type RunPlan,
  type RuleEffect,
  type RuleKey,
  type RuleSet,
  type SimulateGraphOptions,
  type TransferInput,
  type TransferVerdict,
  type Trigger,
} from "@noisedlabs/sdk/programmable";

export type { Amount, BuiltinGuard, Cond, Rule, RuleEffect, RuleKey, RuleSet, TransferInput, TransferVerdict };
export type {
  Action,
  ActionKind,
  AutopilotEnv,
  AutopilotState,
  BlockedEvent,
  BlockReason,
  Canvas,
  CanvasEdge,
  CanvasIssue,
  CanvasNode,
  Graph,
  GraphNode,
  GraphTimeline,
  NodeRuntime,
  Recipient,
  RunEvent,
  SimulateGraphOptions,
  TimelineStep,
  Trigger,
} from "@noisedlabs/sdk/programmable";
// The SDK's rule builder and conditions: the rule presets build their rules with them (never by hand).
export { mergeRuleSets, rules as rulesBuilder, tradingWindow, when } from "@noisedlabs/sdk/programmable";
// Review 4: the programs whose moves skip the creator's rules (holders' quantum vault and the Shield, R1), the lowest
// instruction-count threshold an anti-bot rule may use (wallets add compute-budget and similar steps, R6), and what a
// holder should be warned about in a rule set (QSL-1 revision 0.4: insider-only buying, transfer limits, long rules).
export { MIN_TX_IX_COUNT_THRESHOLD, NOISED_SHIELD_PROGRAM, NOISED_VAULT_PROGRAM, RULES_SKIPPED_PROGRAMS, ruleWarnings, type RuleWarning } from "@noisedlabs/sdk/programmable";

/** The launchpad's timing (the execution grace, the batch window's bounds), as the SDK has it. */
export const TIMING = LAUNCH_TIMING;

/** A text-DSL problem with its position (1-based line / column, 0-based offset), ready to point at. */
export interface DslProblem {
  message: string;
  line: number;
  col: number;
  offset: number;
  length: number;
  hint?: string | undefined;
}

function problemOf(e: DslError): DslProblem {
  return { message: e.message, line: e.line, col: e.col, offset: e.offset, length: e.length, hint: e.hint };
}

/** A friendly message for anything the SDK throws while building. */
function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const isAddress = (s: string): boolean => sdkIsAddress(s);

/** "9xQe…VFin" */
export const shortAddr = (a: string): string => shortAddress(a);

/** "1m30s", "1d" (the DSL's duration words). */
export const formatDurationShort = (secs: number): string => sdkFormatDuration(secs);

/**
 * Programs buys usually go through, by address (names for people; never on chain): Meteora's bonding-curve program (a
 * direct swap) and Jupiter's router. Explanations name a program by its address through this list only, never by a
 * label someone typed (review U14).
 */
export const KNOWN_APPS: Readonly<Record<string, string>> = KNOWN_PROGRAMS;

// ================================================================ rules ===

export const RULES_LIMITS = {
  maxBytes: PXR1.MAX_SIZE,
  maxRules: PXR1.MAX_RULES,
  maxKeys: PXR1.MAX_KEYS,
  maxNodes: PXR1.MAX_NODES,
  maxGuardSecs: PXR1.MAX_GUARD_SECS,
} as const;

/** The reason codes a rule can show holders, as sentences (never the code names). */
export const RULE_CODE_CHOICES: readonly { code: number; name: string; text: string }[] = Object.entries(RULE_CODES as Readonly<Record<string, number>>)
  .map(([name, code]) => ({ code, name, text: RULE_CODE_TEXT[code] ?? name }))
  .sort((a, b) => a.code - b.code);

/** What holders see when rule `code` refuses a transfer. */
export const ruleCodeSentence = (code: number): string => RULE_CODE_TEXT[code] ?? RULE_CODE_TEXT[0] ?? "Not allowed by a launch rule";

export type RulesBuild = { ok: true; bytes: Uint8Array; hash: Uint8Array } | { ok: false; message: string; rule: number | null };

/** PXR1 bytes and rules_hash of a set, or the first problem (with the rule it is about). */
export function compileRuleSet(set: RuleSet): RulesBuild {
  try {
    const bytes = compileRules(set);
    return { ok: true, bytes, hash: rulesHash(bytes) };
  } catch (e) {
    if (e instanceof ProgError) return { ok: false, message: e.message, rule: e.at.rule ?? null };
    return { ok: false, message: messageOf(e), rule: null };
  }
}

/** rules_hash of PXR1 bytes (all zero for "no custom rules"). */
export function rulesHashOf(bytes: Uint8Array | null): Uint8Array {
  return rulesHash(bytes);
}

/** A set without its guard length (`exactOptionalPropertyTypes`: the key is left out, not undefined). */
function withoutGuard(set: RuleSet): RuleSet {
  const out: RuleSet = { keys: set.keys, rules: set.rules };
  if (set.tokenDecimals !== undefined) out.tokenDecimals = set.tokenDecimals;
  return out;
}

/**
 * Parses the rules DSL, collecting every problem with its position. Parsed WITHOUT the guard length, so "always"
 * stays "until the guard ends" (`to: null`) and "first 1h" stays one hour even when the guard is one hour too (review
 * U15: a later guard change never stretches a rule written with an explicit end). A `guard` line must match the
 * launch's guard; the guard is set on the result.
 */
export function parseRulesText(text: string, opts: { guardSecs: number; tokenDecimals: number }): { ok: true; set: RuleSet } | { ok: false; problems: DslProblem[] } {
  try {
    const r = tryParseRules(text, { tokenDecimals: opts.tokenDecimals });
    if (!r.ok) return { ok: false, problems: r.errors.map(problemOf) };
    if (r.rules.guardSecs !== undefined && r.rules.guardSecs !== opts.guardSecs) {
      const at = text.search(/^\s*guard\b/m);
      const line = at < 0 ? 1 : text.slice(0, at).split("\n").length;
      return {
        ok: false,
        problems: [{ message: `this says guard ${sdkFormatDuration(r.rules.guardSecs)} but the launch's guard is ${sdkFormatDuration(opts.guardSecs)}`, line, col: 1, offset: Math.max(0, at), length: 5, hint: "remove the guard line" }],
      };
    }
    return { ok: true, set: { ...r.rules, guardSecs: opts.guardSecs, tokenDecimals: opts.tokenDecimals } };
  } catch (e) {
    return { ok: false, problems: [{ message: messageOf(e), line: 1, col: 1, offset: 0, length: 1 }] };
  }
}

/**
 * The canonical DSL text of a set (what the Code tab shows), printed without the guard length so a window that ends
 * exactly when the guard does keeps its explicit end ("first 6h") and only "until the guard ends" reads "always"
 * (review U15).
 */
export function printRulesText(set: RuleSet): string {
  return printRules(withoutGuard(set));
}

/**
 * One plain-English sentence per rule, in order (no guarantees lines), the SDK's wording (review U14): every wallet by
 * its address (a label only in quotes next to it), apps only by their known address, and the sentence holders see when
 * a rule refuses. Empty when the set does not build.
 */
export function explainRuleSet(set: RuleSet, addresses: "full" | "short" = "full"): string[] {
  try {
    return explainRules(normalizeRules(set), { guarantees: false, addresses });
  } catch {
    return [];
  }
}

/** One rule of a set in plain English (null when it does not build). */
export function explainOneRule(set: RuleSet, index: number, addresses: "full" | "short" = "full"): string | null {
  try {
    return explainRule(normalizeRules(set), index, { addresses });
  } catch {
    return null;
  }
}

/**
 * Plain-English lines of published PXR1 bytes, with known programs named: one per rule, then (unless `guarantees` is
 * false) the guarantees every launch keeps (sells allowed, rules end with the guard, never applied to a holder's
 * quantum vault or the Shield, only refuse).
 */
export function explainRulesBytes(bytes: Uint8Array, guardSecs: number, tokenDecimals: number, guarantees = true): string[] {
  try {
    return explainRules(bytes, { guardSecs, tokenDecimals, guarantees });
  } catch (e) {
    return [`These rules could not be read: ${messageOf(e)}`];
  }
}

/** The addresses published rule bytes name (wallets and apps), in on-chain order; empty when they do not verify. */
export function ruleKeysOfBytes(bytes: Uint8Array, guardSecs: number): string[] {
  try {
    return decompileRules(bytes, { guardSecs }).keys.map((k) => k.address);
  } catch {
    return [];
  }
}

/** Every key a set names, with its full address (review U14: the label is never the only thing shown). */
export function ruleKeyList(set: RuleSet): { address: string; name: string | null }[] {
  let keys = set.keys;
  try {
    // Keys a condition names but the table does not are appended by the SDK (canonical order).
    keys = normalizeRules(set).keys;
  } catch {
    // A set that does not build yet: its table as written.
  }
  return keys.map((k) => ({ address: k.address, name: KNOWN_APPS[k.address] ?? k.label ?? null }));
}

/** The built-in Launch Guard of a launch, in the SDK's terms (snipe shield = batch window + execution grace). */
export interface GuardFacts {
  openDelaySecs: number;
  /** The launchpad's execution grace (the batch may run until open delay + grace; buys stay shielded until then). */
  graceSecs: number;
  guardSecs: number;
  /** 0 = off. */
  maxBuyBps: number;
  maxWalletBps: number;
  p2pLocked: boolean;
  /** Raw units at launch (an estimate is fine for trying transfers). */
  supply: bigint;
  decimals: number;
}

export function builtinOf(g: GuardFacts): BuiltinGuard {
  return { snipeShieldSecs: g.openDelaySecs + g.graceSecs, maxBuyBps: g.maxBuyBps, maxWalletBps: g.maxWalletBps, p2pLocked: g.p2pLocked };
}

/**
 * One transfer through the hook's own decision, as the SDK models it: sell, guard over, snipe shield, exempt, zero,
 * wallet-to-wallet lock, max buy, max wallet, then the custom rules last (review U17: the SDK's evaluator, not a copy).
 */
export function tryRulesTransfer(set: RuleSet | null, input: Omit<TransferInput, "builtin" | "guardSecs" | "tokenDecimals" | "supply">, guard: GuardFacts): TransferVerdict {
  return simulateTransfer(set !== null && set.rules.length > 0 ? set : null, {
    ...input,
    supply: guard.supply,
    guardSecs: guard.guardSecs,
    tokenDecimals: guard.decimals,
    builtin: builtinOf(guard),
  });
}

/**
 * Top-level instructions an ordinary buy uses (compute budget, token account, wrap, sync, swap, unwrap): what "Try a
 * transfer" assumes by default, and the floor every anti-bot limit stays above (review U6 / U17).
 */
export const ORDINARY_BUY_INSTRUCTIONS = 6;
export const MAX_ORDINARY_BUY_INSTRUCTIONS: number = ORDINARY_BUY_MAX_INSTRUCTIONS;

// ================================================================ graph ===

export const GRAPH_LIMITS = {
  maxBytes: PXG1.MAX_SIZE,
  maxNodes: PXG1.MAX_NODES,
  maxRecipients: PXG1.MAX_RECIPIENTS,
  maxCondNodes: PXG1.MAX_COND_NODES,
  minEverySecs: PXG1.MIN_EVERY_SECS,
  minEpochSecs: PXG1.MIN_EPOCH_SECS,
  maxPremiumBps: PXG1.MAX_PREMIUM_BPS,
} as const;

/** The program's fixed autopilot numbers (the update timelock, keeper tips, the buyback price checks). */
export const AUTOPILOT_CONSTANTS = {
  updateTimelockSecs: AUTOPILOT.UPDATE_TIMELOCK_SECS,
  tipLamports: AUTOPILOT.TIP_LAMPORTS,
  tipEpochCap: AUTOPILOT.TIP_EPOCH_CAP,
  tipEpochSecs: AUTOPILOT.TIP_EPOCH_SECS,
  tipMaxShareBps: AUTOPILOT.TIP_MAX_SHARE_BPS,
  refMaxMoveBps: AUTOPILOT.REF_MAX_MOVE_BPS,
  priceCheckSecs: AUTOPILOT.OBS_MIN_SPAN_SECS,
  keeperMinPoolBps: AUTOPILOT.KEEPER_MIN_POOL_BPS,
} as const;

export const graphTemplates = GRAPH_TEMPLATES;

export type GraphBuild = { ok: true; graph: Graph; bytes: Uint8Array; hash: Uint8Array } | { ok: false; issues: CanvasIssue[] };

/** A canvas compiled to PXG1: every issue the verifier would raise, in words, or the bytes and graph_hash. */
export function buildCanvas(c: Canvas): GraphBuild {
  let issues: CanvasIssue[];
  try {
    issues = validateCanvas(c);
  } catch (e) {
    return { ok: false, issues: [{ message: messageOf(e), code: e instanceof ProgError ? e.code : "BadModel" } as CanvasIssue] };
  }
  if (issues.length > 0) return { ok: false, issues };
  return buildGraph(canvasToGraph(c), c);
}

/** A graph compiled to PXG1, or its first problem (on the node it is about, when the canvas is given). */
export function buildGraph(g: Graph, c?: Canvas): GraphBuild {
  try {
    const bytes = compileGraph(g);
    return { ok: true, graph: g, bytes, hash: graphHash(bytes) };
  } catch (e) {
    const at = e instanceof ProgError ? e.at.node : undefined;
    const nodeId = at !== undefined ? (c?.nodes[at]?.id ?? g.nodes[at]?.id) : undefined;
    return { ok: false, issues: [{ message: messageOf(e), code: e instanceof ProgError ? e.code : "BadModel", ...(nodeId !== undefined ? { nodeId } : {}) } as CanvasIssue] };
  }
}

/** Whether PXG1 bytes pass the SDK's verifier (byte-exact with the program's). */
export const graphVerifies = (bytes: Uint8Array): boolean => verifyGraph(bytes).ok;

/** graph_hash of PXG1 bytes. */
export const graphHashOf = (bytes: Uint8Array): Uint8Array => graphHash(bytes);

/** A graph laid out on the canvas (positions kept for nodes that have one). */
export function canvasOf(g: Graph, positions?: Record<string, { x: number; y: number }>): Canvas {
  return graphToCanvas(g, positions === undefined ? { colGap: 320, rowGap: 208 } : { positions, colGap: 320, rowGap: 208 });
}

/** Published bytes back to a graph (null when they do not verify). */
export function graphFromBytes(bytes: Uint8Array, tokenDecimals: number): Graph | null {
  try {
    return decompileGraph(bytes, { tokenDecimals });
  } catch {
    return null;
  }
}

/** The graph a canvas stands for; throws the first problem (use `buildCanvas` for all of them). */
export const canvasToGraphOrThrow = (c: Canvas): Graph => canvasToGraph(c);

/** "Target runs after source" (replaces the target's trigger). */
export const connectCanvas = (c: Canvas, source: string, target: string): Canvas => connectNodes(c, source, target);
export const disconnectCanvas = (c: Canvas, edgeId: string): Canvas => disconnectEdge(c, edgeId);

/** Parses the graph DSL, collecting every problem with its position. */
export function parseGraphText(text: string, opts: { tokenDecimals?: number } = {}): { ok: true; graph: Graph } | { ok: false; problems: DslProblem[] } {
  try {
    const r = tryParseGraph(text, opts);
    return r.ok ? { ok: true, graph: r.graph } : { ok: false, problems: r.errors.map(problemOf) };
  } catch (e) {
    return { ok: false, problems: [{ message: messageOf(e), line: 1, col: 1, offset: 0, length: 1 }] };
  }
}

export function printGraphText(g: Graph): string {
  try {
    return printGraph(g);
  } catch (e) {
    return `# This autopilot can't be printed yet: ${messageOf(e)}\n`;
  }
}

/** One plain-English line per node (and, with `guarantees`, what the treasury can never do): the SDK's wording (full addresses). */
export function explainGraphLines(g: Graph | Uint8Array, guarantees = false, tokenDecimals?: number, addresses: "full" | "short" = "full"): string[] {
  try {
    const graph = g instanceof Uint8Array ? decompileGraph(g, tokenDecimals === undefined ? {} : { tokenDecimals }) : g;
    return explainGraph(graph, { guarantees, addresses });
  } catch (e) {
    return [`This autopilot could not be read: ${messageOf(e)}`];
  }
}

export function explainGraphNode(g: Graph, index: number, addresses: "full" | "short" = "full"): string {
  try {
    return explainNode(g, index, { addresses });
  } catch (e) {
    return messageOf(e);
  }
}

/** Who a graph pays and who operates it, with full addresses (review U1). */
export function graphPeople(g: Graph): { recipients: { address: string; bps: number }[]; operator: string | null } {
  return { recipients: g.recipients.map((r) => ({ address: r.address, bps: r.bps })), operator: g.operator };
}

/** Canonical JSON of a node (bigints as strings), for comparing two graphs. */
function nodeKey(n: GraphNode): string {
  return JSON.stringify(n, (_k, v: unknown) => (typeof v === "bigint" ? `${v}n` : v));
}

export interface GraphChange {
  kind: "added" | "removed" | "changed" | "recipients" | "operator";
  text: string;
}

/**
 * What a new graph changes compared with the running one, in plain words (review U1 / U2): steps added, removed or
 * changed (each with its new sentence), who gets paid, and the operator. `running` null: everything is new.
 */
export function graphChanges(running: Graph | null, next: Graph): GraphChange[] {
  const out: GraphChange[] = [];
  const a = running === null ? null : normalizeOrSelf(running);
  const b = normalizeOrSelf(next);
  const before = new Map((a?.nodes ?? []).map((n, i) => [n.id, { n, i }]));
  const after = new Map(b.nodes.map((n, i) => [n.id, { n, i }]));
  b.nodes.forEach((n, i) => {
    const old = before.get(n.id);
    if (old === undefined) out.push({ kind: "added", text: `New step: ${explainGraphNode(b, i)}` });
    else if (nodeKey(old.n) !== nodeKey(n)) out.push({ kind: "changed", text: `Changed: ${explainGraphNode(b, i)} (was: ${explainGraphNode(a as Graph, old.i)})` });
  });
  for (const [id, old] of before) if (!after.has(id)) out.push({ kind: "removed", text: `Removed: ${explainGraphNode(a as Graph, old.i)}` });
  const pay = (g: Graph | null): string => (g === null ? "" : g.recipients.map((r) => `${r.address}:${r.bps}`).join(","));
  if (pay(a) !== pay(b)) {
    out.push({
      kind: "recipients",
      text: b.recipients.length === 0 ? "Nobody is paid any more." : `Pays: ${b.recipients.map((r) => `${r.address} (${r.bps / 100}%)`).join(", ")}.`,
    });
  }
  if ((a?.operator ?? null) !== b.operator) {
    out.push({ kind: "operator", text: b.operator === null ? "No operator." : `Operator: ${b.operator}.` });
  }
  return out;
}

function normalizeOrSelf(g: Graph): Graph {
  try {
    return normalizeGraph(g);
  } catch {
    return g;
  }
}

/** A node with the SDK's defaults (budget = per-run max x runs, epoch 1 day). */
export function newGraphNode(id: string, trigger: Trigger, action: Action, when: Cond | null, tokenDecimals: number): GraphNode {
  return makeNode(id, trigger, when, action, {}, tokenDecimals);
}

/** A node with explicit limits, through the SDK (budget = per-run max x runs unless given). */
export function graphNode(
  id: string,
  trigger: Trigger,
  when: Cond | null,
  action: Action,
  opts: { epochSecs?: number; maxRunsPerEpoch?: number; budgetPerEpoch?: bigint; operatorGated?: boolean },
  tokenDecimals: number,
): GraphNode {
  const o: { epoch?: number; maxRunsPerEpoch?: number; budgetPerEpoch?: bigint; operatorGated?: boolean } = {};
  if (opts.epochSecs !== undefined) o.epoch = opts.epochSecs;
  if (opts.maxRunsPerEpoch !== undefined) o.maxRunsPerEpoch = opts.maxRunsPerEpoch;
  if (opts.budgetPerEpoch !== undefined) o.budgetPerEpoch = opts.budgetPerEpoch;
  if (opts.operatorGated !== undefined) o.operatorGated = opts.operatorGated;
  return makeNode(id, trigger, when, action, o, tokenDecimals);
}

export function simulate(g: Graph, opts: SimulateGraphOptions): GraphTimeline | { error: string } {
  try {
    return simulateGraph(g, opts);
  } catch (e) {
    return { error: messageOf(e) };
  }
}

/**
 * The least premium a buyback needs to ever buy in a pool that charges `feeBps` (the SDK's `minPremiumForFee`): the
 * program's minimum out is priced at the bound plus the premium, and the pool returns the amount less its fee, so a
 * premium below fee / (1 - fee) can never fill (review U5).
 */
export const minPremiumBps = (feeBps: number): number => minPremiumForFee(feeBps);

/**
 * How much a buyback of `amountIn` lamports moves the price against itself in a pool holding `poolSol` (bps), from
 * the SDK's constant-product estimate (the same model its simulator uses).
 */
export function buybackImpactBps(amountIn: bigint, spotSqrtQ64: bigint, poolFeeBps: number, poolSol: bigint): number {
  const without = estimateBuybackOut(amountIn, spotSqrtQ64, poolFeeBps, null);
  if (without <= 0n || poolSol <= 0n) return 0;
  const withImpact = estimateBuybackOut(amountIn, spotSqrtQ64, poolFeeBps, poolSol);
  return Number(((without - withImpact) * 10_000n) / without);
}

/** The keeper model the program enforces (the simulated chain runs the same one). */
export const keeper = { newAutopilotState, nodeStatus, findDueNodes } as const;

export const priceOf = (sqrtPriceQ64: bigint, decimals: number): number => sqrtPriceQ64ToPrice(sqrtPriceQ64, decimals);
export const sqrtPriceOf = (solPerToken: number | string, decimals: number): bigint => priceToSqrtPriceQ64(solPerToken, decimals);

// ==================================================== PQ authorization ===
// The launchpad's generic `pq_authorize` (PROGRAMMABLE_V1 §2): the launch's quantum identity signs
// "PHX-AUTH-V1" || program || launch || creator || kind || payload_hash (140 bytes), and the autopilot accepts a graph
// change only with that record. The payloads are exactly the autopilot program's (programs/noised-autopilot
// src/launchpad.rs activation_payload / freeze_payload / revoke_payload); test/autopilot-auth.test.ts pins them to
// vectors the program itself printed. The SDK's builders replace these once they ship.

export const AUTH_KIND = SDK_AUTH_KIND;
export type AuthKind = (typeof AUTH_KIND)[keyof typeof AUTH_KIND];

/** The program's 16-byte payload domains (launchpad.rs `ACTIVATE_DOMAIN`, `FREEZE_DOMAIN`, `REVOKE_DOMAIN`). */
export const AUTH_DOMAINS = { activate: SDK_AUTH_DOMAINS.ACTIVATE, freeze: SDK_AUTH_DOMAINS.FREEZE, revoke: SDK_AUTH_DOMAINS.REVOKE, message: "PHX-AUTH-V1" } as const;

const enc = new TextEncoder();

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function i64le(v: number | bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, BigInt(v), true);
  return b;
}

/** A payload and what it is: the exact bytes hashed into `payload_hash`. */
export interface AuthPayload {
  kind: AuthKind;
  /** Field by field, for the review ("what exactly gets signed"). */
  fields: { name: string; bytes: Uint8Array; text: string }[];
  bytes: Uint8Array;
  hash: Uint8Array;
}

/** A payload's fields and bytes, with the SDK's hash of exactly them (one source for what the program checks: review U3). */
function payload(kind: AuthKind, fields: AuthPayload["fields"], hash: Uint8Array): AuthPayload {
  const bytes = concat(fields.map((f) => f.bytes));
  if (!bytesEq(sha256(bytes), hash)) throw new Error("payload fields disagree with the program's payload");
  return { kind, fields, bytes, hash };
}

const bytesEq = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** Activation (kind 1): SHA256("PHX-GRAPH-ACT-V1" || autopilot || graph_hash || activate_at i64 LE). */
export function activationPayload(autopilot: PublicKey, graph: Uint8Array, activateAt: number): AuthPayload {
  return payload(AUTH_KIND.GRAPH_ACTIVATE, [
    { name: "tag", bytes: enc.encode(AUTH_DOMAINS.activate), text: AUTH_DOMAINS.activate },
    { name: "autopilot", bytes: autopilot.toBytes(), text: autopilot.toBase58() },
    { name: "graph_hash", bytes: graph, text: hexOf(graph) },
    { name: "activate_at", bytes: i64le(activateAt), text: String(activateAt) },
  ], sdkActivationPayload(autopilot.toBytes(), graph, activateAt));
}

/**
 * Freeze (kind 2, payload v2, review 4 R5): SHA256("PHX-GRAPH-FRZ-V2" || autopilot || graph_hash || not_after i64 LE).
 * The approval names the last second it may be used (`not_after`); `freeze` refuses after it (FreezeExpired).
 */
export function freezePayload(autopilot: PublicKey, graph: Uint8Array, notAfter: number | bigint): AuthPayload {
  return payload(AUTH_KIND.GRAPH_FREEZE, [
    { name: "tag", bytes: enc.encode(AUTH_DOMAINS.freeze), text: AUTH_DOMAINS.freeze },
    { name: "autopilot", bytes: autopilot.toBytes(), text: autopilot.toBase58() },
    { name: "graph_hash", bytes: graph, text: hexOf(graph) },
    { name: "not_after", bytes: i64le(notAfter), text: String(notAfter) },
  ], sdkFreezePayload(autopilot.toBytes(), graph, BigInt(notAfter)));
}

/** How long a freeze approval can be used by default (the SDK's FREEZE_DEFAULT_VALID_SECS: one hour). */
export const FREEZE_VALID_SECS = Number(FREEZE_DEFAULT_VALID_SECS);

/**
 * The longest a freeze approval may stay usable (the SDK's FREEZE_MAX_VALID_SECS, audit 4 ID-F5: 24 hours from this
 * device's clock). The SDK refuses to sign a longer one; the freeze slider stops here.
 */
export const FREEZE_MAX_SECS = 86_400;

/** The choices of the freeze slider: how long the approval may be used (seconds), one hour by default, never past 24 hours. */
export const FREEZE_WINDOW_CHOICES: readonly number[] = [15 * 60, 30 * 60, 3_600, 2 * 3_600, 4 * 3_600, 8 * 3_600, 12 * 3_600, 24 * 3_600].filter((s) => s <= FREEZE_MAX_SECS);

/** What the creator reads when a freeze approval expired (the program's FreezeExpired), in plain words. */
export const FREEZE_EXPIRED_MESSAGE = "This freeze approval has expired. Nothing was frozen: sign a new freeze.";

/**
 * A freeze approval's last second for one signed now (unix seconds): `validSecs` from `now` (one hour by default,
 * never more than 24 hours: a longer window throws RangeError, as the SDK's planFreeze does).
 */
export function freezeNotAfter(now: number, validSecs: number = FREEZE_VALID_SECS): number {
  if (!Number.isFinite(validSecs) || validSecs <= 0 || validSecs > FREEZE_MAX_SECS) throw new RangeError(`a freeze approval can be used for at most ${FREEZE_MAX_SECS / 3_600} hours`);
  return Math.floor(now) + Math.floor(validSecs);
}

/**
 * Why a freeze approval valid until `notAfter` can't be used now, in plain words, or null. `marginSecs` keeps room for
 * the transactions to land (the SDK refuses to sign one that would land too late), and an approval may never stay
 * usable more than 24 hours past this device's clock.
 */
export function freezeExpiryProblem(notAfter: number, now: number, marginSecs = 60): string | null {
  if (now > notAfter) return FREEZE_EXPIRED_MESSAGE;
  if (now + marginSecs > notAfter) return "This freeze approval is about to expire, so it can't land in time. Start again to sign a new one.";
  if (notAfter > Math.floor(now) + FREEZE_MAX_SECS) return "A freeze approval can be used for at most 24 hours. Pick a shorter time and sign again.";
  return null;
}

/**
 * Operator revocation (kind 3, payload v3, audit 4 A4-3):
 * SHA256("PHX-OP-REVOKE-V3" || autopilot || graph_hash || operator || active_auth). It names the running graph and the
 * authorization that activated it (`AutopilotInfo.activeAuth`), so it can't be replayed against a later activation that
 * appoints the same operator again, even of the same graph.
 */
export function revokePayload(autopilot: PublicKey, graph: Uint8Array, operator: PublicKey, activeAuth: PublicKey): AuthPayload {
  return payload(AUTH_KIND.OPERATOR_REVOKE, [
    { name: "tag", bytes: enc.encode(AUTH_DOMAINS.revoke), text: AUTH_DOMAINS.revoke },
    { name: "autopilot", bytes: autopilot.toBytes(), text: autopilot.toBase58() },
    { name: "graph_hash", bytes: graph, text: hexOf(graph) },
    { name: "operator", bytes: operator.toBytes(), text: operator.toBase58() },
    { name: "active_auth", bytes: activeAuth.toBytes(), text: activeAuth.toBase58() },
  ], sdkRevokePayload(autopilot.toBytes(), graph, operator.toBytes(), activeAuth.toBytes()));
}

export const AUTH_MESSAGE_LEN = 140;

/** The 140-byte message the quantum key signs: "PHX-AUTH-V1" || program || launch || creator || kind || payload_hash. */
export function authMessage(args: { program: PublicKey; launch: PublicKey; creator: PublicKey; kind: AuthKind; payloadHash: Uint8Array }): {
  bytes: Uint8Array;
  fields: { name: string; size: number; text: string }[];
} {
  if (args.payloadHash.length !== 32) throw new RangeError("payload hash must be 32 bytes");
  const parts = [
    { name: "tag", bytes: enc.encode(AUTH_DOMAINS.message), text: AUTH_DOMAINS.message },
    { name: "program", bytes: args.program.toBytes(), text: args.program.toBase58() },
    { name: "launch", bytes: args.launch.toBytes(), text: args.launch.toBase58() },
    { name: "creator", bytes: args.creator.toBytes(), text: args.creator.toBase58() },
    { name: "kind", bytes: Uint8Array.of(args.kind), text: String(args.kind) },
    { name: "payload_hash", bytes: args.payloadHash, text: hexOf(args.payloadHash) },
  ];
  const bytes = concat(parts.map((p) => p.bytes));
  if (bytes.length !== AUTH_MESSAGE_LEN) throw new Error("authorization message must be 140 bytes");
  return { bytes, fields: parts.map((p) => ({ name: p.name, size: p.bytes.length, text: p.text })) };
}

/**
 * When a signed graph takes effect, fixed once when the review opens (review U11): a first graph 5 minutes from then
 * (the program refuses a time in the past, and the quantum signature, its landing and the activation take a few
 * steps), a change 72 hours and one hour from then (the program wants at least 72 hours after both the signature and
 * the activation landed). Rounded up to the minute, so it reads as a plain time.
 */
export function chooseActivateAt(nowSecs: number, replacing: boolean): number {
  // A first graph has no waiting period: 5 minutes is only room for the signature and the activation to land.
  const t = nowSecs + (replacing ? AUTOPILOT.UPDATE_TIMELOCK_SECS + 3_600 : 5 * 60);
  return Math.ceil(t / 60) * 60;
}

/**
 * Whether a fixed activation time can still be used at `nowSecs` (checked right before anything is signed, so no
 * one-time key is spent on a time the program would refuse): a first graph needs a few minutes of room, a change still
 * needs the full 72 hours from now.
 */
export function activateAtProblem(activateAt: number, nowSecs: number, replacing: boolean): string | null {
  if (replacing) {
    return activateAt >= nowSecs + AUTOPILOT.UPDATE_TIMELOCK_SECS + 120
      ? null
      : "The time you reviewed is now less than 72 hours away, so the chain would refuse it. Review again to pick a new time.";
  }
  return activateAt >= nowSecs + 120 ? null : "The start time you reviewed is about to pass, so the chain would refuse it. Review again to pick a new time.";
}

function hexOf(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Recipients the graph pays, for display (full address and share). */
export type GraphRecipient = Pick<Recipient, "address" | "bps">;

/** A graph's rules for display (re-exported for pages that only need the plain list). */
export type { Rule as LaunchRule };

/** The SDK's own amount formats for one autopilot action's per-run maximum. */
export function actionMaxOf(a: Action): bigint {
  return a.kind === "buybackBurn" ? a.maxInLamports : a.kind === "burn" ? a.maxTokens : a.maxLamports;
}

/** Shares of `amount` the program pays (the SDK's mirror of Graph::shares: floor of each share; the dust stays in the treasury). */
export const paymentShares = (g: Graph, amount: bigint): bigint[] => shares(g, amount);

/** What `expectedRunTip` reads: one due step and the autopilot's state as read now. */
export interface RunTipInput {
  graph: Graph;
  node: number;
  /** What the run moves (lamports, or raw tokens for a burn). */
  amount: bigint;
  /** A keeper's partial buyback (it earns its share of a tip: SDK `planMaxTip`). */
  partial: boolean;
  /** Payout recipients (graph order) that have no wSOL account: skipped, their share is kept (audit 4, M4). */
  skipped?: readonly boolean[];
  graduated: boolean;
  /** The reference sqrt price (Q64) and the observation window (the program's current and previous buckets). */
  reference: bigint;
  observations: readonly ObsBucket[];
  now: number;
  tipEpochStart: number | bigint;
  tipsInEpoch: bigint;
  treasurySol: bigint;
}

/**
 * The tip a due step should earn, as the SDK's keeper estimates it (SDK 0.9.0, audit 4): the program's `take_tip` on the
 * state as read, with a run's value from `planValue` (a burn's tokens at `burnPrice`: nothing before graduation, after it
 * the lower of the reference and the lowest observed price; a payout less the shares it keeps for skipped recipients),
 * at most `planMaxTip` (a partial buyback earns its share), from what the treasury holds after the step.
 */
export function expectedRunTip(t: RunTipInput): bigint {
  const n = t.graph.nodes[t.node];
  if (n === undefined) return 0n;
  const a = n.action;
  let plan: RunPlan;
  let kept = 0n;
  let spent = t.amount;
  if (a.kind === "buybackBurn") plan = { kind: "buyback", amountIn: t.amount, minOut: 0n, partial: t.partial };
  else if (a.kind === "burn") {
    plan = { kind: "burn", amount: t.amount };
    spent = 0n;
  } else {
    const s = shares(t.graph, t.amount);
    const total = s.reduce((x, y) => x + y, 0n);
    s.forEach((v, i) => {
      if (t.skipped?.[i] === true) kept += v;
    });
    plan = { kind: "distribute", shares: s, total };
    spent = total - kept;
  }
  const price = burnPrice(t.graduated, t.reference, lowestObserved([...t.observations], t.now));
  const value = planValue(plan, price, kept);
  const treasury = t.treasurySol > spent ? t.treasurySol - spent : 0n;
  return takeTipRaw({ epochStart: BigInt(t.tipEpochStart), inEpoch: t.tipsInEpoch }, BigInt(t.now), treasury, value, planMaxTip(plan, actionMaxOf(a))).tip;
}

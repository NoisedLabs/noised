/**
 * Reading launch rules (PXR1) and autopilot graphs (PXG1) from what a tool
 * was given: the text DSL, raw bytes (base64 / hex), or the chain.
 * Everything is verified exactly as the programs verify it; an invalid
 * input comes back as a list of plain errors, never half-decoded.
 */
import {
  compileGraph,
  compileRules,
  decompileGraph,
  decompileRules,
  DslError,
  explainRules,
  fetchAutopilotView,
  fetchLaunch,
  printRules,
  rulesHashHex,
  tryParseGraph,
  tryParseRules,
  verifyGraph,
  verifyRules,
  type Graph,
  type LaunchAccount,
  type RuleSet,
} from "@noisedlabs/sdk";

import type { BoundRules } from "../boundRules.js";
import { boundRulesReader, bytesFromBase64, bytesFromHex, errorText, pubkey, Refusal, toBase64, type ToolContext } from "./common.js";

export interface RulesSource {
  rules_text?: string | undefined;
  rules_base64?: string | undefined;
  rules_hex?: string | undefined;
  launch?: string | undefined;
  guard_secs?: number | undefined;
  token_decimals?: number | undefined;
}

export type RulesRead =
  | {
      valid: true;
      source: string;
      set: RuleSet;
      bytes: Uint8Array;
      bytesBase64: string;
      rulesHash: string;
      sizeBytes: number;
      guardSecs: number | null;
      text: string;
      explanation: string[];
      launch: LaunchAccount | null;
      onChain?: Record<string, unknown>;
    }
  | { valid: false; source: string; errors: string[]; launch: LaunchAccount | null };

const dslErrors = (errors: readonly DslError[]): string[] => errors.map((e) => `line ${e.line}, column ${e.col}: ${e.message}${e.hint === undefined ? "" : ` (${e.hint})`}`);

function oneSource(fields: Record<string, string | undefined>, what: string): [string, string] | null {
  const given = Object.entries(fields).filter((e): e is [string, string] => e[1] !== undefined && e[1] !== "");
  if (given.length > 1) throw new Refusal(`give only one ${what} source (got ${given.map((g) => g[0]).join(" and ")})`);
  return given[0] ?? null;
}

/** Reads, verifies and explains a rule set. `launch` supplies the guard length, decimals (and, for the hook, the built-in guard). */
export async function readRules(ctx: ToolContext, args: RulesSource): Promise<RulesRead> {
  const src = oneSource({ rules_text: args.rules_text, rules_base64: args.rules_base64, rules_hex: args.rules_hex }, "rules");
  const launch = args.launch === undefined ? null : await fetchLaunch(ctx.conn, pubkey(args.launch));
  if (args.launch !== undefined && launch === null) throw new Refusal("no Noised launch exists at this address");
  if (src === null) throw new Refusal("give the rules as rules_text (the rules language), rules_base64 or rules_hex (PXR1 bytes)");
  const guardSecs = args.guard_secs ?? launch?.guardSecs;
  const tokenDecimals = args.token_decimals ?? launch?.tokenDecimal;
  const gOpt = guardSecs === undefined ? {} : { guardSecs };
  const dOpt = tokenDecimals === undefined ? {} : { tokenDecimals };
  const [kind, value] = src;
  let set: RuleSet;
  let bytes: Uint8Array;
  if (kind === "rules_text") {
    const parsed = tryParseRules(value, { ...gOpt, ...dOpt });
    if (!parsed.ok) return { valid: false, source: "rules language", errors: dslErrors(parsed.errors), launch };
    try {
      bytes = compileRules(parsed.rules, gOpt);
    } catch (e) {
      return { valid: false, source: "rules language", errors: [errorText(e)], launch };
    }
    set = parsed.rules;
  } else {
    bytes = kind === "rules_base64" ? bytesFromBase64(value) : bytesFromHex(value);
  }
  const v = verifyRules(bytes, gOpt);
  if (!v.ok) return { valid: false, source: kind === "rules_text" ? "rules language" : "PXR1 bytes", errors: [`${v.code}: ${v.message}`], launch };
  if (kind !== "rules_text") set = decompileRules(bytes, { ...gOpt, ...dOpt });
  const finalSet = set!;
  return {
    valid: true,
    source: kind === "rules_text" ? "rules language" : "PXR1 bytes",
    set: finalSet,
    bytes,
    bytesBase64: toBase64(bytes),
    rulesHash: rulesHashHex(bytes),
    sizeBytes: bytes.length,
    guardSecs: guardSecs ?? null,
    text: printRules(finalSet),
    explanation: explainRules(finalSet, gOpt),
    launch,
  };
}

export interface GraphSource {
  graph_text?: string | undefined;
  graph_base64?: string | undefined;
  graph_hex?: string | undefined;
  /** Read the launch's active (default) or queued graph from the chain. */
  launch?: string | undefined;
  which?: "active" | "pending" | undefined;
  token_decimals?: number | undefined;
}

export interface GraphRead {
  source: string;
  graph: Graph;
  bytes: Uint8Array;
  hash: string;
}

/** Reads and verifies a graph; refuses an invalid one with the verifier's reasons. */
export async function readGraph(ctx: ToolContext, args: GraphSource, allowLaunch = true): Promise<GraphRead> {
  const src = oneSource({ graph_text: args.graph_text, graph_base64: args.graph_base64, graph_hex: args.graph_hex }, "graph");
  const dOpt = args.token_decimals === undefined ? {} : { tokenDecimals: args.token_decimals };
  if (src === null) {
    if (!allowLaunch || args.launch === undefined) throw new Refusal("give the graph as graph_text (the graph language), graph_base64 or graph_hex (PXG1 bytes)");
    const view = await fetchAutopilotView(ctx.conn, pubkey(args.launch));
    if (view === null) throw new Refusal("this launch has no autopilot");
    const rec = (args.which ?? "active") === "active" ? view.active : view.pending;
    if (rec === null) throw new Refusal(`this launch's autopilot has no ${args.which ?? "active"} graph`);
    const graph = args.token_decimals === undefined ? rec.graph : decompileGraph(rec.bytes, dOpt);
    return { source: `the launch's ${args.which ?? "active"} graph (on-chain)`, graph, bytes: rec.bytes, hash: Buffer.from(rec.graphHash).toString("hex") };
  }
  const [kind, value] = src;
  if (kind === "graph_text") {
    const parsed = tryParseGraph(value, dOpt);
    if (!parsed.ok) throw new Refusal("the graph text does not parse", { errors: dslErrors(parsed.errors) });
    let bytes: Uint8Array;
    try {
      bytes = compileGraph(parsed.graph);
    } catch (e) {
      throw new Refusal(`the graph is not valid: ${errorText(e)}`);
    }
    const v = verifyGraph(bytes);
    if (!v.ok) throw new Refusal(`the graph is not valid (${v.code}): ${v.message}`);
    return { source: "graph language", graph: parsed.graph, bytes, hash: v.hashHex };
  }
  const bytes = kind === "graph_base64" ? bytesFromBase64(value) : bytesFromHex(value);
  const v = verifyGraph(bytes);
  if (!v.ok) throw new Refusal(`the graph bytes are not a valid PXG1 graph (${v.code}): ${v.message}`);
  return { source: "PXG1 bytes", graph: decompileGraph(bytes, dOpt), bytes, hash: v.hashHex };
}

export interface LaunchBoundRules {
  launch: LaunchAccount;
  bound: BoundRules;
  /** Plain JSON about where the rules come from and whether the Launch Guard enforces exactly them. */
  onChain: Record<string, unknown>;
}

/**
 * A launch's bound rules: the hash from its certificate (live) or attestation (before launch), the record's bytes,
 * and whether the Launch Guard policy holds exactly those bytes.
 */
export async function readBoundRules(ctx: ToolContext, launchAddr: string): Promise<LaunchBoundRules> {
  const reader = boundRulesReader(ctx);
  const launch = await fetchLaunch(ctx.conn, pubkey(launchAddr));
  if (launch === null) throw new Refusal("no Noised launch exists at this address");
  const bound = await reader(ctx.conn, launch);
  const hashHex = bound.rulesHash === null ? null : Buffer.from(bound.rulesHash).toString("hex");
  const enforcedHash = bound.enforced === null ? null : bound.enforced.length === 0 ? null : rulesHashHex(bound.enforced);
  const onChain = {
    boundIn: bound.boundIn,
    rulesHash: hashHex,
    record: bound.record?.address ?? null,
    recordPublished: bound.rulesHash === null ? null : bound.record !== null,
    launchGuardRulesHash: enforcedHash,
    enforcedByLaunchGuard: bound.enforced === null ? null : enforcedHash === hashHex,
  };
  return { launch, bound, onChain };
}

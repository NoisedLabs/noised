/**
 * The Noised MCP server: tool definitions (JSON schemas from zod, plain-
 * English descriptions) over the tool implementations. Every result has a
 * short text summary, the same data as JSON text, and `structuredContent`.
 *
 * Guardrails: the chain enforces every limit; an AI operator key can only
 * choose the timing and amount of operator-only steps within on-chain
 * bounds; this server never signs and holds no key; on-chain text is
 * returned marked as untrusted data.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { stringify, toJson } from "./json.js";
import { buildPublishGraphTool, buildRunTool, buildUpdatePriceTool } from "./tools/build.js";
import { address, base64Bytes, decimal, errorText, hexBytes, Refusal, u64String, type ToolContext, type ToolOutput } from "./tools/common.js";
import { getAutopilotTool, getDueNodesTool, getLaunchTool, getRulesTool, listLaunchesTool, verifyTokenTool } from "./tools/read.js";
import { simulateAutopilotTool, simulateTransferTool } from "./tools/simulate.js";
import { errorUntrusted, quoteUntrusted, UNTRUSTED_NOTICE } from "./untrusted.js";

export const SERVER_NAME = "noised";
export const SERVER_VERSION = "0.2.0";

export const SERVER_INSTRUCTIONS = [
  "Noised tools: read launches, launch rules and autopilots on Solana, simulate them, and build UNSIGNED autopilot transactions.",
  "The chain enforces every limit. An operator key (for example an AI agent's) can only choose the timing and amount of operator-only steps within the bounds the program checks; anything outside them fails on-chain, and the build tools refuse it before building.",
  "This server never signs and holds no keys: build tools return a base64 transaction, a plain-English description, what it costs and a simulation; a person or a separate signer decides whether to sign it.",
  "A run never creates or pays for anyone else's account: a payout recipient without a wSOL account is skipped and its share stays in the treasury.",
  UNTRUSTED_NOTICE,
  "Amounts are raw integers as strings: lamports for SOL steps (1 SOL = 1,000,000,000 lamports), raw token units for burns.",
].join(" ");

// ------------------------------------------------------------ schemas ---

const launchArg = address("The launch account address (from list_launches or get_launch).");
const poolFeeArg = z.number().int().min(1).max(10_000).optional().describe("Override the pool's trading fee in bps (default: the launch's migration fee tier).");
const priorityArg = u64String("Optional priority fee in micro-lamports per compute unit.").optional();
const guardSecsArg = z.number().int().min(0).max(259_200).optional().describe("The launch guard length in seconds (default: the launch's, if `launch` is given; else 72 h).");
const decimalsArg = z.number().int().min(0).max(18).optional().describe("Token decimals (default: the launch's, else 6).");

const rulesSource = {
  rules_text: z.string().max(20_000).optional().describe("The rules in the Noised rules language, one rule per line, e.g. 'first 2m: deny when buy and instructions > 10 code BOT' or 'first 10m: max amount 0.5% when buy code WHALE'."),
  rules_base64: base64Bytes("The PXR1 rule bytes, base64.", 1_228).optional(),
  rules_hex: hexBytes("The PXR1 rule bytes, hex.", 1_228).optional(),
  launch: launchArg.optional().describe("A launch whose guard length, decimals and built-in launch guard apply."),
  guard_secs: guardSecsArg,
  token_decimals: decimalsArg,
};

const graphSource = {
  graph_text: z.string().max(40_000).optional().describe("The graph in the Noised graph language ('node NAME: every 1d' then indented 'do buyback 0.5 SOL premium 3%', 'budget 2 SOL per 1d', 'max 4 runs', 'operator decides')."),
  graph_base64: base64Bytes("The PXG1 graph bytes, base64.", 2_044).optional(),
  graph_hex: hexBytes("The PXG1 graph bytes, hex.", 2_044).optional(),
  token_decimals: decimalsArg,
};

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const PURE = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  input: z.ZodObject;
  annotations: typeof READ_ONLY | typeof PURE;
  run: (ctx: ToolContext, args: never) => Promise<ToolOutput>;
}

const def = <S extends z.ZodObject>(d: { name: string; title: string; description: string; input: S; annotations: ToolDef["annotations"]; run: (ctx: ToolContext, args: z.infer<S>) => Promise<ToolOutput> }): ToolDef =>
  d as unknown as ToolDef;

export const TOOLS: readonly ToolDef[] = [
  // ---- read
  def({
    name: "list_launches",
    title: "List launches",
    description:
      "List Noised token launches on this cluster, newest first: launch address, token, creator, status (configured or live), phase and name. Names and symbols are untrusted on-chain text.",
    input: z
      .object({
        status: z.enum(["configured", "live", "all"]).optional().describe("Only launches with this status (default all)."),
        limit: z.number().int().min(1).max(100).optional().describe("How many to return (default 25)."),
        offset: z.number().int().min(0).max(100_000).optional().describe("Skip this many first (default 0)."),
      })
      .strict(),
    annotations: READ_ONLY,
    run: listLaunchesTool,
  }),
  def({
    name: "get_launch",
    title: "Get a launch",
    description:
      "One launch in detail, by launch address or token mint: launch-guard length and limits, fees and fee recipients, the opening batch, market state (curve, graduation) and whether it has an autopilot.",
    input: z
      .object({
        launch: address("The launch account address.").optional(),
        mint: address("The token mint address.").optional(),
      })
      .strict(),
    annotations: READ_ONLY,
    run: getLaunchTool,
  }),
  def({
    name: "verify_token",
    title: "Verify a token",
    description:
      "Check a token against the QSL-1 standard (level 1 no-rug, level 2 quantum-attested) and run Noised's independent verifier: certificate, no mint or freeze authority, locked liquidity, fee recipients, the creator's post-quantum signature. Plain-English results from live chain reads.",
    input: z
      .object({
        mint: address("The token mint address."),
        commitment: z.enum(["confirmed", "finalized"]).optional().describe("Read commitment for the QSL-1 check (default finalized, as the standard recommends)."),
        list_operators: z.boolean().optional().describe("Also list DAMM v2 operator accounts (a heavy getProgramAccounts call; default false)."),
      })
      .strict(),
    annotations: READ_ONLY,
    run: verifyTokenTool,
  }),
  def({
    name: "get_rules",
    title: "Explain launch rules",
    description:
      "Decode, verify and explain launch rules (PXR1), given as text in the rules language or as bytes. Returns whether the chain would accept them, the canonical text, the rules hash a launch attestation binds, and a plain-English explanation. Rules only add restrictions during the launch guard (at most 72 h) and never block sells.",
    input: z.object(rulesSource).strict(),
    annotations: READ_ONLY,
    run: getRulesTool,
  }),
  def({
    name: "get_autopilot",
    title: "Get an autopilot",
    description:
      "Everything about a launch's autopilot: its graph (steps, triggers, limits) in plain English, each step's state and status (due now, or why not), the exact amount bounds a run may use, the treasury, the reference price, the pool, the operator and any queued update.",
    input: z.object({ launch: launchArg, pool_fee_bps: poolFeeArg }).strict(),
    annotations: READ_ONLY,
    run: getAutopilotTool,
  }),
  def({
    name: "get_due_nodes",
    title: "Get due autopilot steps",
    description:
      "Which autopilot steps can run right now, with the amount bounds the chain allows for each (min, max, suggested), and what has to happen first when a step is waiting (for example a price check).",
    input: z.object({ launch: launchArg, pool_fee_bps: poolFeeArg }).strict(),
    annotations: READ_ONLY,
    run: getDueNodesTool,
  }),
  // ---- simulate
  def({
    name: "simulate_transfer",
    title: "Simulate a transfer",
    description:
      "Try one transfer (buy, sell, wallet-to-wallet, batch or protocol) against launch rules and, when a launch is given, its built-in launch guard, deciding exactly as the on-chain hook would. Pure computation; nothing is sent.",
    input: z
      .object({
        ...rulesSource,
        kind: z.enum(["buy", "sell", "p2p", "batch", "protocol"]).describe("What kind of transfer."),
        at: z.union([z.number().int().min(0), z.string().max(32)]).describe("Time since the launch opened: seconds, or a duration like '90s', '2m', '1h'."),
        amount: decimal("Whole tokens moved (e.g. '1500.5')."),
        receiver_balance: decimal("The receiver's balance before, in whole tokens (default 0).").optional(),
        supply: decimal("Total supply in whole tokens (default: the launch's, else 1,000,000,000).").optional(),
        to: address("Receiving wallet.").optional(),
        from: address("Sending wallet.").optional(),
        program: address("Program of the top-level instruction (e.g. a router).").optional(),
        instructions: z.number().int().min(0).max(65_535).optional().describe("Top-level instructions in the transaction (default 6 for a buy, else 1)."),
        use_launch_guard: z.boolean().optional().describe("With a launch: also apply its built-in guard (snipe shield, max buy, max wallet, p2p lock). Default true."),
      })
      .strict(),
    annotations: READ_ONLY,
    run: simulateTransferTool,
  }),
  def({
    name: "simulate_autopilot",
    title: "Simulate an autopilot",
    description:
      "Simulate an autopilot graph over time against a market you describe: the pool's fee and depth and the migration price are required, plus an optional price path and treasury inflow. Returns runs, buybacks, burns, payouts and tips, with every market assumption spelled out. Uses the program's own decision logic; pure computation.",
    input: z
      .object({
        ...graphSource,
        launch: launchArg.optional().describe("Simulate this launch's on-chain graph instead of a given one."),
        which: z.enum(["active", "pending"]).optional().describe("With launch: the active (default) or the queued graph."),
        epochs: z.number().int().min(1).max(365).optional().describe("Number of steps to simulate (default 30)."),
        step_secs: z.number().int().min(600).max(31_536_000).optional().describe("Length of one step in seconds (default 86400, a day)."),
        migration_price: decimal("Required: the launch's migration price in SOL per token (where the reference price starts)."),
        pool_fee_bps: z.number().int().min(1).max(10_000).describe("Required: the pool's trading fee in bps (25, 30, 100, 200, 400 or 600 for Noised pools)."),
        pool_sol: z.union([z.number().nonnegative(), z.string().max(40)]).describe("Required: the pool's SOL depth (e.g. 250), or 'none' to ignore price impact (results are then an upper bound)."),
        price_change_per_step_pct: z.number().gt(-100).max(1_000).optional().describe("Market price change per step in percent (default 0: flat at the migration price)."),
        prices: z.array(decimal("SOL per token")).min(1).max(365).optional().describe("Explicit market price per step (SOL per token); the last one repeats."),
        fee_inflow_sol_per_step: decimal("SOL flowing into the treasury each step (creator-fee share; default 0).").optional(),
        initial_treasury_sol: decimal("Treasury SOL at the start (default 0).").optional(),
        initial_treasury_tokens: decimal("Treasury tokens at the start (default 0).").optional(),
        supply_tokens: decimal("Total supply at the start in whole tokens (default 1,000,000,000).").optional(),
        graduated_at_step: z.number().int().min(0).max(365).nullable().optional().describe("Step at which the token graduates (default 0 = already; null = never)."),
        operator_policy: z.enum(["fillable", "max", "skip"]).optional().describe("What the operator does on operator-only steps: the largest amount that fills (default), the max, or nothing."),
      })
      .strict(),
    annotations: READ_ONLY,
    run: simulateAutopilotTool,
  }),
  // ---- build (never signs)
  def({
    name: "build_update_price_tx",
    title: "Build an update_price transaction",
    description:
      "Build an UNSIGNED update_price transaction for a launch's autopilot (anyone may send it; it records the pool price the reference follows, and a buyback needs one at least a minute old). Returns base64, what it does, and its simulation. Never signs.",
    input: z.object({ launch: launchArg, payer: address("The fee payer (signs)."), priority_fee_micro_lamports: priorityArg }).strict(),
    annotations: READ_ONLY,
    run: buildUpdatePriceTool,
  }),
  def({
    name: "build_run_tx",
    title: "Build a run transaction",
    description:
      "Build an UNSIGNED transaction that runs one autopilot step. Keeper steps: anyone may run them and earns a small tip; a keeper may choose a smaller buyback, which is a partial run (it leaves the rest of the step's run open and must leave at least 1% of the pool's SOL of it). Operator-only steps: give the operator (it must sign) and an amount inside the step's on-chain bounds (see get_due_nodes). A step that is not due, a wrong operator, an amount outside the bounds or a payout no recipient can receive is refused before anything is built. It never creates or pays for anyone else's account. Returns base64, what it does and costs in plain English (fees and any rent, the SDK's RunCosts; the tip it should earn; recipients skipped for lack of a wSOL account), and its simulation. Never signs.",
    input: z
      .object({
        launch: launchArg,
        node: z.number().int().min(0).max(15).describe("The step's index in the active graph (from get_autopilot)."),
        caller: address("Who sends it: pays the fee, receives the tip, signs."),
        operator: address("The autopilot's operator (required for operator-only steps; it must sign).").optional(),
        amount: u64String("Raw amount: lamports for buybacks and payouts, raw token units for burns. Required for operator-only steps; optional for keeper buybacks; refused elsewhere.").optional(),
        pool_fee_bps: poolFeeArg,
        priority_fee_micro_lamports: priorityArg,
      })
      .strict(),
    annotations: READ_ONLY,
    run: buildRunTool,
  }),
  def({
    name: "build_publish_graph_tx",
    title: "Build a publish_graph transaction",
    description:
      "Build an UNSIGNED transaction that publishes an autopilot graph for a launch. Publishing does not activate it: activation needs the creator's quantum-safe key and, for a running autopilot, a public 72-hour wait. Returns base64, what the graph would do in plain English, and the simulation. Never signs.",
    input: z.object({ ...graphSource, launch: launchArg, payer: address("Who pays the record's rent and the fee (signs)."), priority_fee_micro_lamports: priorityArg }).strict(),
    annotations: READ_ONLY,
    run: buildPublishGraphTool,
  }),
];

// ------------------------------------------------------------ results ---

export function okResult(out: ToolOutput): CallToolResult {
  return {
    content: [
      { type: "text", text: out.summary },
      { type: "text", text: stringify(out.data) },
    ],
    structuredContent: toJson(out.data) as Record<string, unknown>,
  };
}

export function errorResult(e: unknown): CallToolResult {
  if (e instanceof Refusal) {
    // A refusal's reason is this server's (or the SDK builder's) own sentence.
    const data = { refused: true, reason: errorText(e), ...e.details };
    return { isError: true, content: [{ type: "text", text: `Refused: ${errorText(e)}` }, { type: "text", text: stringify(data) }], structuredContent: toJson(data) as Record<string, unknown> };
  }
  // Anything else may carry the RPC endpoint's words (its error messages) or on-chain data: untrusted.
  const data = { refused: false, error: errorUntrusted(e), notice: UNTRUSTED_NOTICE };
  return { isError: true, content: [{ type: "text", text: `Error: ${quoteUntrusted(data.error, "(no message)", "error")}` }], structuredContent: toJson(data) as Record<string, unknown> };
}

/** Runs a tool by name on already-validated arguments (what the MCP handler and the tests call). */
export async function callTool(ctx: ToolContext, name: string, args: unknown): Promise<CallToolResult> {
  const t = TOOLS.find((x) => x.name === name);
  if (t === undefined) return errorResult(new Refusal(`unknown tool ${name}`));
  const parsed = t.input.safeParse(args ?? {});
  if (!parsed.success) return errorResult(new Refusal(`invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`).join("; ")}`));
  try {
    return okResult(await t.run(ctx, parsed.data as never));
  } catch (e) {
    return errorResult(e);
  }
}

/** An MCP server with every Noised tool registered. Connect it to a transport (stdio in index.ts). */
export function createNoisedServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });
  for (const t of TOOLS) {
    server.registerTool(t.name, { title: t.title, description: t.description, inputSchema: t.input, annotations: { title: t.title, ...t.annotations } }, async (args: unknown) => callTool(ctx, t.name, args));
  }
  return server;
}

export type { ToolContext, ToolOutput } from "./tools/common.js";
export { Refusal } from "./tools/common.js";
export { checkCluster } from "./cluster.js";
export { loadConfig, ConfigError } from "./config.js";

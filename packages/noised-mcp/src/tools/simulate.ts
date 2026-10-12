/**
 * Simulate tools: a transfer against launch rules (and the launch's built-in
 * guard), and an autopilot graph over time against a mock market. Pure
 * computation with the SDK's port of the programs' own logic; the market
 * model is an assumption and every result says which.
 */
import {
  LAUNCH_TIMING,
  ProgError,
  simulateGraph,
  simulateTransfer,
  type BuiltinGuard,
  type GraphTimeline,
  type LaunchAccount,
  type OperatorRequest,
  type TransferInput,
  type TransferKind,
} from "@noisedlabs/sdk";

import { errorText, Refusal, sol, tokens, type ToolContext, type ToolOutput } from "./common.js";
import { readBoundRules, readGraph, readRules, type GraphSource, type RulesSource } from "./rules.js";

export interface SimulateTransferArgs extends RulesSource {
  kind: TransferKind;
  at: number | string;
  amount: number | string;
  receiver_balance?: number | string | undefined;
  supply?: number | string | undefined;
  to?: string | undefined;
  from?: string | undefined;
  program?: string | undefined;
  instructions?: number | undefined;
  use_launch_guard?: boolean | undefined;
}

export async function simulateTransferTool(ctx: ToolContext, args: SimulateTransferArgs): Promise<ToolOutput> {
  const hasRules = [args.rules_text, args.rules_base64, args.rules_hex].some((x) => x !== undefined && x !== "");
  if (!hasRules && args.launch === undefined) throw new Refusal("give the rules (rules_text, rules_base64 or rules_hex) and/or a `launch` whose built-in guard to try");
  let rules: Uint8Array | null = null;
  let launch: LaunchAccount | null = null;
  let explanation: string[] = [];
  let rulesSource = "given";
  if (hasRules) {
    const r = await readRules(ctx, args);
    if (!r.valid) throw new Refusal("these rules are not valid, so the chain would refuse them", { errors: r.errors });
    rules = r.bytes;
    launch = r.launch;
    explanation = r.explanation;
  } else {
    // The launch's own bound rules, if any.
    const b = await readBoundRules(ctx, args.launch!);
    launch = b.launch;
    rulesSource = b.bound.rulesHash === null ? "none bound on-chain" : "bound on-chain";
    if (b.bound.rulesHash !== null) {
      if (b.bound.record === null) throw new Refusal("the launch's bound rules record is missing on-chain");
      const r = await readRules(ctx, { rules_base64: Buffer.from(b.bound.record.bytes).toString("base64"), launch: args.launch, guard_secs: args.guard_secs, token_decimals: args.token_decimals });
      if (!r.valid) throw new Refusal("the launch's bound rules do not verify", { errors: r.errors });
      rules = r.bytes;
      explanation = r.explanation;
    }
  }
  const input: TransferInput = { kind: args.kind, at: args.at, amount: args.amount };
  if (args.receiver_balance !== undefined) input.receiverBalance = args.receiver_balance;
  if (args.to !== undefined) input.to = args.to;
  if (args.from !== undefined) input.from = args.from;
  if (args.program !== undefined) input.program = args.program;
  if (args.instructions !== undefined) input.instructions = args.instructions;
  const guardSecs = args.guard_secs ?? launch?.guardSecs;
  if (guardSecs !== undefined) input.guardSecs = guardSecs;
  const decimals = args.token_decimals ?? launch?.tokenDecimal;
  if (decimals !== undefined) input.tokenDecimals = decimals;
  if (args.supply !== undefined) input.supply = args.supply;
  else if (launch?.market !== undefined) input.supply = launch.market.supply;
  let builtin: BuiltinGuard | null = null;
  if (launch !== null && (args.use_launch_guard ?? true)) {
    builtin = { snipeShieldSecs: launch.openDelaySecs + LAUNCH_TIMING.EXECUTION_GRACE_SECS, maxBuyBps: launch.maxBuyBps, maxWalletBps: launch.maxWalletBps, p2pLocked: launch.p2pLocked };
    input.builtin = builtin;
  }
  let verdict;
  try {
    verdict = simulateTransfer(rules, input);
  } catch (e) {
    if (e instanceof ProgError) throw new Refusal(`cannot simulate this transfer: ${e.message}`);
    throw e;
  }
  const data = {
    allowed: verdict.allowed,
    stage: verdict.stage,
    refusal: verdict.refusal ?? null,
    rule: verdict.rule,
    code: verdict.code,
    codeName: verdict.codeName,
    why: verdict.why,
    input: { ...input, builtin: builtin ?? null },
    rulesSource,
    rulesExplanation: explanation,
    note: "Sells are never blocked, and every rule ends with the launch guard. This is the SDK's exact port of the hook's checks.",
  };
  return { summary: `${verdict.allowed ? "ALLOWED" : `REFUSED (${verdict.refusal ?? "rule"})`}: ${verdict.why}`, data };
}

export interface SimulateAutopilotArgs extends GraphSource {
  epochs?: number | undefined;
  step_secs?: number | undefined;
  migration_price: number | string;
  pool_fee_bps: number;
  pool_sol: number | string;
  price_change_per_step_pct?: number | undefined;
  prices?: (number | string)[] | undefined;
  fee_inflow_sol_per_step?: number | string | undefined;
  initial_treasury_sol?: number | string | undefined;
  initial_treasury_tokens?: number | string | undefined;
  supply_tokens?: number | string | undefined;
  graduated_at_step?: number | null | undefined;
  operator_policy?: "fillable" | "max" | "skip" | undefined;
}

const num = (v: number | string, what: string): number => {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Refusal(`${what} must be a non-negative number`);
  return n;
};

export async function simulateAutopilotTool(ctx: ToolContext, args: SimulateAutopilotArgs): Promise<ToolOutput> {
  const g = await readGraph(ctx, args);
  const decimals = args.token_decimals ?? g.graph.tokenDecimals ?? 6;
  const migrationPrice = num(args.migration_price, "migration_price");
  if (migrationPrice <= 0) throw new Refusal("migration_price must be above 0 (SOL per token)");
  const poolSol = typeof args.pool_sol === "string" && args.pool_sol.trim().toLowerCase() === "none" ? "none" : num(args.pool_sol, "pool_sol");
  const pct = args.price_change_per_step_pct ?? 0;
  if (!Number.isFinite(pct) || pct <= -100) throw new Refusal("price_change_per_step_pct must be above -100");
  const prices = args.prices?.map((p, i) => num(p, `prices[${i}]`));
  if (prices !== undefined && (prices.length === 0 || prices.some((p) => p <= 0))) throw new Refusal("prices must be positive SOL-per-token numbers");
  const priceFn = (step: number): number => (prices !== undefined ? prices[Math.min(step, prices.length - 1)]! : migrationPrice * (1 + pct / 100) ** step);
  const inflow = args.fee_inflow_sol_per_step === undefined ? 0 : num(args.fee_inflow_sol_per_step, "fee_inflow_sol_per_step");
  const policy = args.operator_policy ?? "fillable";
  let t: GraphTimeline;
  try {
    t = simulateGraph(g.graph, {
      epochs: args.epochs ?? 30,
      stepSecs: args.step_secs ?? 86_400,
      migrationPrice,
      poolFeeBps: args.pool_fee_bps,
      poolSol,
      priceFn,
      feeInflowFn: () => inflow,
      initialTreasury: {
        ...(args.initial_treasury_sol === undefined ? {} : { sol: num(args.initial_treasury_sol, "initial_treasury_sol") }),
        ...(args.initial_treasury_tokens === undefined ? {} : { tokens: num(args.initial_treasury_tokens, "initial_treasury_tokens") }),
      },
      ...(args.supply_tokens === undefined ? {} : { supply: num(args.supply_tokens, "supply_tokens") }),
      tokenDecimals: decimals,
      graduatedAtStep: args.graduated_at_step === undefined ? 0 : args.graduated_at_step,
      operator: (_req: OperatorRequest) => (policy === "skip" ? null : policy),
    });
  } catch (e) {
    if (e instanceof ProgError) throw new Refusal(`cannot simulate: ${e.message}`);
    throw new Refusal(`cannot simulate: ${errorText(e)}`);
  }
  const blockedByReason: Record<string, number> = {};
  for (const s of t.steps) for (const b of s.blocked) blockedByReason[b.reason] = (blockedByReason[b.reason] ?? 0) + 1;
  const runs = t.steps.flatMap((s) => s.runs);
  // The SDK's timeline lists a keeper's partial buybacks as runs too (one event per transaction); a step's run is
  // complete only when it is not partial.
  const partialRuns = runs.filter((r) => r.partial).length;
  const data = {
    graph: { source: g.source, hash: g.hash },
    totals: {
      ...t.totals,
      completedRuns: runs.length - partialRuns,
      partialRuns,
      burnedText: tokens(t.totals.burned, decimals),
      solSpentText: sol(t.totals.solSpent),
      distributedText: sol(t.totals.distributed),
      tipsText: sol(t.totals.tips),
    },
    final: { ...t.final, treasurySolText: sol(t.final.treasurySol), treasuryTokensText: tokens(t.final.treasuryTokens, decimals), supplyText: tokens(t.final.supply, decimals) },
    assumptions: t.assumptions,
    steps: t.steps.slice(0, 120).map((s) => ({
      step: s.step,
      price: s.price,
      refPrice: s.refPrice,
      treasurySol: s.treasurySol,
      treasuryTokens: s.treasuryTokens,
      burned: s.burned,
      solSpent: s.solSpent,
      distributed: s.distributed,
      tips: s.tips,
      runs: s.runs.length,
      partialRuns: s.runs.filter((r) => r.partial).length,
      blocked: s.blocked.length,
    })),
    runs: runs.slice(0, 60).map((r) => ({ step: r.step, node: r.node, action: r.action, by: r.by, amount: r.amount, partial: r.partial, tokensBought: r.tokensBought, burned: r.burned, tip: r.tip, price: r.price, refPrice: r.refPrice })),
    runsShown: Math.min(runs.length, 60),
    blockedByReason,
    disclaimer: "A simulation against an assumed market (price path, pool depth, fee inflow), using the program's own decision logic. Not a prediction.",
  };
  const summary = [
    `Simulated ${t.steps.length} step(s) of ${g.source} (hash ${g.hash.slice(0, 16)}…): ${t.totals.runs} run(s)${partialRuns === 0 ? "" : ` (${partialRuns} of them partial buybacks, which leave their step's run open)`}, ${t.totals.blocked} hold-back(s).`,
    `Bought back with ${sol(t.totals.solSpent)}, burned ${tokens(t.totals.burned, decimals)}, paid ${sol(t.totals.distributed)} to recipients, ${sol(t.totals.tips)} in tips.`,
    `End: treasury ${sol(t.final.treasurySol)} and ${tokens(t.final.treasuryTokens, decimals)}; supply ${tokens(t.final.supply, decimals)}.`,
    "Assumptions:",
    ...t.assumptions.map((a) => `- ${a}`),
  ].join("\n");
  return { summary, data };
}

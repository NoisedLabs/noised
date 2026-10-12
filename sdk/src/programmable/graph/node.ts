/** Node building blocks: triggers, action specs and node defaults (shared by the builder, DSL and templates). */
import { DEFAULT_TOKEN_DECIMALS, PXG1 } from "../constants.js";
import { ProgError } from "../errors.js";
import { type CondLike, condOf } from "../cond/when.js";
import { type Duration, type Percent, type SolAmount, type TokenAmount, toBps, toLamports, toSeconds, toTokenUnits } from "../units.js";
import type { Action, GraphNode, Trigger } from "./model.js";

/** Due every `d` (at least 10 minutes) since the node's last run. */
export const every = (d: Duration): Trigger => ({ kind: "every", secs: toSeconds(d, "every") });
/** Due once after node `id` succeeded. */
export const after = (id: string): Trigger => ({ kind: "after", node: id });
/** Due once after the token graduates. */
export const onGraduation = (): Trigger => ({ kind: "graduated" });
/** Due whenever the node's condition holds. */
export const whenever = (): Trigger => ({ kind: "when" });

/** An action with human amounts; the graph builder resolves them. */
export type ActionSpec =
  | { kind: "buybackBurn"; maxIn: SolAmount; maxPremiumBps: number }
  | { kind: "burn"; maxTokens: TokenAmount }
  | { kind: "distributeSol"; maxPerRun: SolAmount };

/** Buy back up to `maxIn` SOL per run and burn what it buys; refuses above reference price + premium. */
export function buybackBurn(o: { maxIn: SolAmount; maxPremiumBps?: number | Percent }): ActionSpec {
  return { kind: "buybackBurn", maxIn: o.maxIn, maxPremiumBps: o.maxPremiumBps === undefined ? 300 : toBps(o.maxPremiumBps, "premium") };
}

/** Burn up to `maxTokens` treasury tokens per run. */
export function burn(o: { maxTokens: TokenAmount } | TokenAmount): ActionSpec {
  return { kind: "burn", maxTokens: typeof o === "object" ? o.maxTokens : o };
}

/** Pay up to `maxPerRun` SOL per run to the recipients, by share. */
export function distributeSol(o: { maxPerRun: SolAmount } | SolAmount): ActionSpec {
  return { kind: "distributeSol", maxPerRun: typeof o === "object" ? o.maxPerRun : o };
}

export interface NodeOptions {
  /** Budget per epoch: SOL (buyback, distribute) or tokens (burn). Default: per-run max x max runs. */
  budgetPerEpoch?: SolAmount | TokenAmount;
  /** Budget epoch (default "1d", at least "1h"). */
  epoch?: Duration;
  /** Max runs per epoch (default: how often the trigger can fire in an epoch, else 1). */
  maxRunsPerEpoch?: number;
  /** Only the operator may run this node (it picks timing and amount within the limits). */
  operatorGated?: boolean;
}

/** Resolves an action spec to raw amounts. */
export function resolveAction(a: ActionSpec, tokenDecimals = DEFAULT_TOKEN_DECIMALS): Action {
  switch (a.kind) {
    case "buybackBurn":
      return { kind: "buybackBurn", maxInLamports: toLamports(a.maxIn, "buyback max"), maxPremiumBps: a.maxPremiumBps };
    case "burn":
      return { kind: "burn", maxTokens: toTokenUnits(a.maxTokens, tokenDecimals, "burn max") };
    case "distributeSol":
      return { kind: "distributeSol", maxLamports: toLamports(a.maxPerRun, "distribute max") };
  }
}

/** Builds a node with the builder's defaults. */
export function makeNode(
  id: string,
  trigger: Trigger,
  w: CondLike | null | undefined,
  action: ActionSpec | Action,
  opts: NodeOptions = {},
  tokenDecimals = DEFAULT_TOKEN_DECIMALS,
): GraphNode {
  const act: Action = "maxIn" in action || "maxPerRun" in action || action.kind === "burn" ? resolveAction(action as ActionSpec, tokenDecimals) : action;
  const epochSecs = toSeconds(opts.epoch ?? "1d", "epoch");
  if (epochSecs < PXG1.MIN_EPOCH_SECS) throw new ProgError("EpochTooShort", "a budget epoch lasts at least 1 hour");
  const p1 = act.kind === "buybackBurn" ? act.maxInLamports : act.kind === "burn" ? act.maxTokens : act.maxLamports;
  const runs =
    opts.maxRunsPerEpoch ?? (trigger.kind === "every" && trigger.secs > 0 ? Math.min(0xffff, Math.max(1, Math.floor(epochSecs / trigger.secs))) : 1);
  const budget =
    opts.budgetPerEpoch === undefined
      ? p1 * BigInt(runs)
      : act.kind === "burn"
        ? toTokenUnits(opts.budgetPerEpoch, tokenDecimals, "budget")
        : toLamports(opts.budgetPerEpoch, "budget");
  return {
    id,
    trigger,
    when: w === null || w === undefined ? null : condOf(w),
    action: act,
    operatorGated: opts.operatorGated ?? false,
    epochSecs,
    budgetPerEpoch: budget,
    maxRunsPerEpoch: runs,
  };
}

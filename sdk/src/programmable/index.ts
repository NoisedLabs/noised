/**
 * Programmable launches (design/prog/PROGRAMMABLE_V1.md §5): launch rules
 * (PXR1) and autopilot graphs (PXG1) — builders, text DSLs, the visual
 * canvas model, byte-exact compile / decompile / verify / hash, plain-English
 * explanations, a transfer simulator and a treasury simulator.
 *
 * API contract: the maintainers' SDK API notes. DSL grammars: ./README.md.
 */

// ------------------------------------------------------------ constants ---
export {
  ACTION,
  AUTOPILOT,
  BPS_DENOMINATOR,
  BPS_FLAG,
  DEFAULT_TOKEN_DECIMALS,
  EFFECT,
  KNOWN_PROGRAMS,
  LAMPORTS_PER_SOL,
  LAUNCH_TIMING,
  OP,
  NOISED_SHIELD_PROGRAM,
  NOISED_VAULT_PROGRAM,
  PXG1,
  PXR1,
  RULE_CODE_TEXT,
  RULE_CODES,
  RULE_DENIED,
  RULES_SKIPPED_PROGRAMS,
  TRIGGER,
  U64_MAX,
  VM,
} from "./constants.js";
export type { OpCode, RuleCodeName } from "./constants.js";

// ------------------------------------------------------------ errors ---
export { DslError, isVerifyErrorCode, ProgError, VERIFY_ERRORS } from "./errors.js";
export type { ModelErrorCode, ProgErrorAt, ProgErrorCode, VerifyErrorCode } from "./errors.js";

// ------------------------------------------------------------ bytes / units ---
export {
  DEFAULT_ADDRESS,
  addressBytes,
  bytesEqual,
  decodeBase58,
  encodeBase58,
  fromHex,
  isAddress,
  shortAddress,
  toAddress,
  toHex,
} from "./bytes.js";
export type { Address, KeyInput } from "./bytes.js";
export {
  bpsOfSupply,
  formatBps,
  formatDate,
  formatDuration,
  formatDurationLong,
  formatPeriod,
  formatSol,
  formatTokens,
  isPercentLike,
  isqrt,
  lamportsToSol,
  parseDecimal,
  priceToSqrtPriceQ64,
  sqrtPriceQ64ToPrice,
  sqrtPriceQ64ToPriceText,
  toBps,
  toLamports,
  toSeconds,
  toTokenUnits,
  toUnix,
  unitsToTokens,
} from "./units.js";
export type { Decimal, Duration, Percent, SolAmount, TokenAmount } from "./units.js";
export { graphHash, graphHashHex, rulesHash, rulesHashHex, ZERO_HASH } from "./hash.js";

// ------------------------------------------------------------ conditions ---
export { evalCondition, exceeds, isGraphLeafOp, isRuleLeafOp, isValidBpsArg, threshold, verifyCondition } from "./cond/vm.js";
export type { CondContext, CondNode } from "./cond/vm.js";
export {
  checkCondSize,
  compileCond,
  condDepth,
  condSize,
  decompileCond,
  isGraphLeaf,
  isRuleLeaf,
  leaves,
  MAX_TREE_NODES,
  normalizeCond,
  toAmount,
} from "./cond/ast.js";
export { MAX_NESTING } from "./dsl/core.js";
export type { Amount, Cond, CondOpName, GraphLeaf, PriceQty, RuleLeaf, TokenQty } from "./cond/ast.js";
export { all, any, Condition, condOf, not, when } from "./cond/when.js";
export type { CondLike, KeyRef, SupplyAmount } from "./cond/when.js";

// ------------------------------------------------------------ launch rules ---
export { decodeRulesRaw, encodeRulesRaw, verifyRules, verifyRulesBytes } from "./rules/codec.js";
export type { RawRule, RawRuleSet, RulesVerifyOptions, VerifyResult } from "./rules/codec.js";
export { checkGuardSecs, compileRules, decompileRules, isLabel, keyName, normalizeRules, rulesToRaw } from "./rules/model.js";
export type { Rule, RuleEffect, RuleKey, RuleSet, RulesCompileOptions, RulesDecompileOptions } from "./rules/model.js";
export { rules, RulesBuilder } from "./rules/builder.js";
export type { RuleOptions, RulesOptions } from "./rules/builder.js";
export { ruleCode, ruleCodeName, ruleCodeText } from "./rules/codes.js";
export type { RuleCodeLike } from "./rules/codes.js";
export { explainRule, explainRules } from "./rules/explain.js";
export type { ExplainRulesOptions } from "./rules/explain.js";
export { evaluateRuleSet, ruleCondition, simulateTransfer } from "./rules/evaluate.js";
export type { BuiltinGuard, HookRefusal, RuleEvalCtx, RuleOutcome, TransferInput, TransferKind, TransferVerdict } from "./rules/evaluate.js";
export { RULE_WARNING_LONG_SECS, ruleWarnings } from "./rules/warnings.js";
export type { RuleWarning, RuleWarningKind, RuleWarningsOptions } from "./rules/warnings.js";
export { parseRules, printRules, tryParseRules } from "./rules/dsl.js";
export type { ParseRulesOptions, ParseRulesResult } from "./rules/dsl.js";

// ------------------------------------------------------------ autopilot graphs ---
export { afterAcyclic, decodeGraphRaw, encodeGraphRaw, verifyGraph, verifyGraphBytes } from "./graph/codec.js";
export type { GraphVerifyResult, RawGNode, RawGraph, RawRecipient } from "./graph/codec.js";
export {
  actionMax,
  actionUnit,
  compileGraph,
  condNodeRefs,
  decompileGraph,
  defaultNodeIds,
  graphToRaw,
  isNodeId,
  normalizeGraph,
  renameNode,
} from "./graph/model.js";
export type { Action, ActionKind, Graph, GraphDecompileOptions, GraphNode, Recipient, Trigger, TriggerKind } from "./graph/model.js";
export { after, buybackBurn, burn, distributeSol, every, graph, GraphBuilder, makeNode, onGraduation, resolveAction, whenever } from "./graph/builder.js";
export type { ActionSpec, GraphOptions, NodeOptions } from "./graph/builder.js";
export { explainGraph, explainNode } from "./graph/explain.js";
export type { ExplainGraphOptions } from "./graph/explain.js";
export {
  compiledGraph,
  currentEpoch,
  currentEpochRaw,
  epochView,
  findDueNodes,
  graphCondition,
  graphDue,
  graphRunCap,
  graphRunnable,
  graphRunsInEpoch,
  graphShares,
  newAutopilotState,
  NOT_DUE,
  nodeCondition,
  nodeDue,
  nodeStatus,
  nodeStatuses,
  afterObservation,
  observePrice,
  priceAboveRef,
  priceStateOf,
  recordRun,
  runCap,
  runValue,
  shares,
  statusReader,
  storePriceState,
  takeTip,
} from "./graph/runtime.js";
export type {
  AutopilotEnv,
  AutopilotState,
  BlockReason,
  CompiledGraph,
  NodeRuntime,
  NodeStatus,
  NotDueCode,
  RawGraphCtx,
  RawNodeState,
  TipOptions,
} from "./graph/runtime.js";
export {
  bucketOf,
  buybackCap,
  emptyObservations,
  follow as followReference,
  keeperFloor,
  lowest as lowestObserved,
  minOut as buybackMinOut,
  newPriceState,
  observe as recordObservation,
  priceQ64,
  seen as observationWindow,
  tokenValue,
  withinPremium,
} from "./graph/reference.js";
export type { ObsBucket, PriceState, Seen } from "./graph/reference.js";
// Off-chain estimate of a buyback's swap (fee + price impact): whether the program's minimum out can be met.
export { buybackFills, estimateBuybackOut, largestFillable, minPremiumForFee, poolAfterBuyback, premiumCoversFee } from "./graph/market.js";
// The program's own decisions (programs/noised-autopilot src/logic.rs), exact: what the simulator and keepers use.
export {
  activationPayload,
  AUTH_DOMAINS,
  AUTH_KIND,
  AUTOPILOT_ERRORS,
  autopilotErrorCode,
  autopilotErrorName,
  burnPrice,
  checkActivation,
  checkApply,
  checkFreezeWindow,
  checkFresh,
  FREEZE_DEFAULT_VALID_SECS,
  freezePayload,
  markIndex,
  notDueError,
  paddedStates,
  planMaxTip,
  planPartial,
  planRun,
  planSpent,
  planValue,
  recordRunRaw,
  revokePayload,
  runAmount,
  takeTipRaw,
} from "./autopilot/logic.js";
export type { ActivationCheck, AuthMark, AutopilotErrorName, Outcome, RecordRunOptions, RunInput, RunPlan, TipCounters } from "./autopilot/logic.js";
export { MAX_SIM_STEPS, simulateGraph } from "./graph/simulate.js";
export type { BlockedEvent, GraphTimeline, OperatorRequest, RunEvent, SimulateGraphOptions, TimelineStep } from "./graph/simulate.js";
export {
  autoLayout,
  canvasToGraph,
  compileCanvas,
  connectNodes,
  decompileCanvas,
  disconnectEdge,
  edgeId,
  graphToCanvas,
  validateCanvas,
} from "./graph/canvas.js";
export type { Canvas, CanvasEdge, CanvasIssue, CanvasNode, LayoutOptions } from "./graph/canvas.js";
export { parseGraph, printGraph, tryParseGraph } from "./graph/dsl.js";
export type { ParseGraphOptions, ParseGraphResult } from "./graph/dsl.js";

// ------------------------------------------------------------ templates ---
export {
  GRAPH_TEMPLATES,
  graphTemplate,
  mergeRuleSets,
  MIN_TX_IX_COUNT_THRESHOLD,
  ORDINARY_BUY_MAX_INSTRUCTIONS,
  RULE_TEMPLATES,
  ruleTemplate,
  tradingWindow,
} from "./templates.js";
export type { GraphTemplate, GraphTemplateId, RuleTemplate, RuleTemplateId, TemplateParam } from "./templates.js";

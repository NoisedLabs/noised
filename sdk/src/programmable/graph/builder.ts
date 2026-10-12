/**
 * Code-first autopilot graphs:
 *
 *   graph()
 *     .node("buyback", every("1d"), when.treasurySolGte(1),
 *           buybackBurn({ maxIn: 0.5, maxPremiumBps: 300 }), { budgetPerEpoch: 2, epoch: "1d" })
 *     .node("burn-rest", after("buyback"), null, burn({ maxTokens: 1_000_000 }))
 *     .compile();
 */
import { DEFAULT_TOKEN_DECIMALS } from "../constants.js";
import { type KeyInput, toAddress } from "../bytes.js";
import type { CondLike } from "../cond/when.js";
import { graphHash } from "../hash.js";
import { type Percent, toBps } from "../units.js";
import { type Canvas, graphToCanvas } from "./canvas.js";
import { printGraph } from "./dsl.js";
import { explainGraph } from "./explain.js";
import { type Action, compileGraph, type Graph, normalizeGraph, type Trigger } from "./model.js";
import { type ActionSpec, makeNode, type NodeOptions } from "./node.js";

export { after, buybackBurn, burn, distributeSol, every, makeNode, onGraduation, resolveAction, whenever } from "./node.js";
export type { ActionSpec, NodeOptions } from "./node.js";

export interface GraphOptions {
  operator?: KeyInput;
  tokenDecimals?: number;
}

export class GraphBuilder {
  private readonly g: Graph;

  constructor(opts: GraphOptions = {}) {
    this.g = { operator: opts.operator === undefined ? null : toAddress(opts.operator), recipients: [], nodes: [] };
    if (opts.tokenDecimals !== undefined) this.g.tokenDecimals = opts.tokenDecimals;
  }

  private get dec(): number {
    return this.g.tokenDecimals ?? DEFAULT_TOKEN_DECIMALS;
  }

  /** Names the operator (e.g. an AI agent's key) for operator-gated nodes. */
  operator(key: KeyInput): this {
    this.g.operator = toAddress(key);
    return this;
  }

  /** Adds a distributeSol payee with a share ("70%", "25bps" or a number of bps). */
  recipient(address: KeyInput, share: Percent | number, label?: string): this {
    const r = { address: toAddress(address), bps: toBps(share, "share") };
    this.g.recipients.push(label === undefined ? r : { ...r, label });
    return this;
  }

  /** Adds a node: trigger -> (condition) -> action, within its budget. */
  node(id: string, trigger: Trigger, w: CondLike | null, action: ActionSpec | Action, opts: NodeOptions = {}): this {
    this.g.nodes.push(makeNode(id, trigger, w, action, opts, this.dec));
    return this;
  }

  /** The canonical graph. */
  build(): Graph {
    return normalizeGraph(this.g);
  }

  /** Verified PXG1 bytes. */
  compile(): Uint8Array {
    return compileGraph(this.g);
  }

  hash(): Uint8Array {
    return graphHash(this.compile());
  }

  explain(): string[] {
    return explainGraph(this.build());
  }

  /** The text-DSL form. */
  toText(): string {
    return printGraph(this.build());
  }

  /** The canvas model (auto layout). */
  toCanvas(): Canvas {
    return graphToCanvas(this.build());
  }
}

/** Starts an autopilot graph. */
export function graph(opts: GraphOptions = {}): GraphBuilder {
  return new GraphBuilder(opts);
}

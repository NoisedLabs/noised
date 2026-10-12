/**
 * Read tools: launches, a token's verification, launch rules, an autopilot
 * and its due steps. Read-only: nothing here builds or signs anything.
 */
import {
  actionMax,
  actionUnit,
  activeRecipients,
  autopilotAddress,
  autopilotPdas,
  checkQsl1,
  clusterUnixTime,
  explainGraph,
  explainNode,
  fetchAutopilot,
  fetchDueNodes,
  fetchLaunch,
  fetchLaunchByMint,
  launchPhase,
  listLaunches,
  MIGRATION_FEE_TIERS_BPS,
  parseMint,
  printGraph,
  QSL1_LEVEL_NAMES,
  qslBadge,
  toHex,
  tokenMetadataOf,
  verifyLaunch,
  type DueNodes,
  type Graph,
  type LaunchAccount,
  type NodeStatus,
} from "@noisedlabs/sdk";
import { detailText, errorUntrusted, quoteUntrusted, UNTRUSTED_NOTICE, untrusted, type UntrustedText } from "../untrusted.js";
import { amountText, boundRulesReader, iso, priceText, pubkey, Refusal, sol, toBase64, type ToolContext, type ToolOutput } from "./common.js";
import { readBoundRules, readRules, type RulesSource } from "./rules.js";
import { keeperFloorOf } from "./runRules.js";

// ------------------------------------------------------------ launches ---

function marketStrings(l: LaunchAccount): { name: UntrustedText | null; symbol: UntrustedText | null; uri: UntrustedText | null } {
  const m = l.market;
  return {
    name: untrusted(m?.name, "token name (on-chain, chosen by the creator)", 64),
    symbol: untrusted(m?.symbol, "token symbol (on-chain, chosen by the creator)", 16),
    uri: untrusted(m?.uri, "token link (on-chain, chosen by the creator)", 300),
  };
}

async function clusterNow(ctx: ToolContext): Promise<bigint> {
  try {
    return await clusterUnixTime(ctx.conn);
  } catch {
    return BigInt(Math.floor(Date.now() / 1000));
  }
}

function launchSummary(l: LaunchAccount, now: bigint): Record<string, unknown> {
  const s = marketStrings(l);
  return {
    launch: l.publicKey,
    mint: l.baseMint,
    creator: l.creator,
    status: l.status,
    phase: launchPhase(l, now),
    name: s.name,
    symbol: s.symbol,
    launchedAt: iso(l.launchTs),
    guardEndsAt: iso(l.guardEndTs),
    curveComplete: l.market?.curveComplete ?? false,
    migrated: l.market?.migrated ?? false,
  };
}

export async function listLaunchesTool(ctx: ToolContext, args: { status?: "configured" | "live" | "all" | undefined; limit?: number | undefined; offset?: number | undefined }): Promise<ToolOutput> {
  const all = await listLaunches(ctx.conn);
  const now = await clusterNow(ctx);
  const status = args.status ?? "all";
  const filtered = status === "all" ? all : all.filter((l) => l.status === status);
  const offset = args.offset ?? 0;
  const limit = args.limit ?? 25;
  const page = filtered.slice(offset, offset + limit);
  const items = page.map((l) => launchSummary(l, now));
  const lines = page.map((l, i) => {
    const s = marketStrings(l);
    return `${offset + i + 1}. ${quoteUntrusted(s.name, "(no name yet)")} ${quoteUntrusted(s.symbol, "")} - ${l.status}, ${launchPhase(l, now)} - launch ${l.publicKey.toBase58()}`;
  });
  return {
    summary: [`${filtered.length} launch(es)${status === "all" ? "" : ` with status ${status}`}; showing ${page.length} from #${offset + 1}.`, ...lines].join("\n"),
    data: { notice: UNTRUSTED_NOTICE, total: filtered.length, offset, limit, launches: items },
  };
}

export async function getLaunchTool(ctx: ToolContext, args: { launch?: string | undefined; mint?: string | undefined }): Promise<ToolOutput> {
  if ((args.launch === undefined) === (args.mint === undefined)) throw new Refusal("give exactly one of `launch` (the launch account) or `mint` (the token)");
  const l = args.launch !== undefined ? await fetchLaunch(ctx.conn, pubkey(args.launch)) : await fetchLaunchByMint(ctx.conn, pubkey(args.mint!));
  if (l === null) throw new Refusal(args.launch !== undefined ? "no Noised launch exists at this address" : "this token is not a Noised launch (no launch certificate)");
  const now = await clusterNow(ctx);
  const s = marketStrings(l);
  let autopilot: Record<string, unknown> = { address: autopilotAddress(l.publicKey), exists: false };
  try {
    const a = await fetchAutopilot(ctx.conn, l.publicKey);
    if (a !== null) {
      autopilot = { address: a.publicKey, exists: true, hasActiveGraph: a.hasActiveGraph, frozen: a.frozen, graduated: a.graduated, operator: a.operatorOrNull, treasury: autopilotPdas(l.publicKey).treasury };
    }
  } catch (e) {
    autopilot = { address: autopilotAddress(l.publicKey), exists: null, error: errorUntrusted(e) };
  }
  let customRules: Record<string, unknown>;
  try {
    const b = await boundRulesReader(ctx)(ctx.conn, l);
    customRules = { readable: true, bound: b.rulesHash !== null, boundIn: b.boundIn, rulesHash: b.rulesHash, record: b.record?.address ?? null };
  } catch (e) {
    customRules = { readable: false, error: errorUntrusted(e) };
  }
  const feeBps = MIGRATION_FEE_TIERS_BPS[l.migrationFeeOption] ?? null;
  const m = l.market;
  const data = {
    notice: UNTRUSTED_NOTICE,
    ...launchSummary(l, now),
    uri: s.uri,
    times: { launchedAt: iso(l.launchTs), commitEndsAt: iso(l.commitEndTs), executeEndsAt: iso(l.executeEndTs), guardEndsAt: iso(l.guardEndTs) },
    params: {
      tokenDecimals: l.tokenDecimal,
      openDelaySecs: l.openDelaySecs,
      guardSecs: l.guardSecs,
      maxWalletBps: l.maxWalletBps,
      maxBuyBps: l.maxBuyBps,
      p2pLocked: l.p2pLocked,
      platformFeeBps: l.platformFeeBps,
      migrationFeeOption: l.migrationFeeOption,
      poolFeeBpsAfterGraduation: feeBps,
      migrationQuoteThreshold: l.migrationQuoteThreshold,
      batchWalletCap: l.batchWalletCap,
      batchTotalCap: l.batchTotalCap,
      paramsHash: l.paramsHash,
      pqIdentity: l.pqIdentity,
    },
    feeRecipients: activeRecipients(l).map((r) => ({ wallet: r.wallet, bps: r.bps })),
    batch: { totalCommitted: l.totalCommitted, executed: l.executed, quoteSpent: l.quoteSpent, tokensOut: l.tokensOut },
    market:
      m === undefined
        ? null
        : {
            supply: m.supply,
            initialSupply: m.initialSupply,
            curvePriceSqrtQ64: m.sqrtPrice,
            curvePrice: priceText(m.sqrtPrice, l.tokenDecimal),
            curveSol: m.quoteReserve,
            curveComplete: m.curveComplete,
            migrated: m.migrated,
            dammPool: m.dammPool,
            launchGuardActive: m.hookActive,
          },
    customRules,
    autopilot,
  };
  const summary = [
    `Launch ${l.publicKey.toBase58()}: ${quoteUntrusted(s.name, "(no name yet)")} ${quoteUntrusted(s.symbol, "")}, token ${l.baseMint.toBase58()}.`,
    `Status: ${l.status}, phase ${launchPhase(l, now)}${m === undefined ? "" : m.migrated ? ", graduated (liquidity locked in its DAMM v2 pool)" : m.curveComplete ? ", curve complete" : ""}.`,
    `Launch guard until ${iso(l.guardEndTs) ?? "n/a"}; sells are never blocked.${customRules["readable"] === true ? (customRules["bound"] === true ? " Custom launch rules are bound (get_rules explains them)." : " No custom launch rules.") : ""}`,
    autopilot["exists"] === true ? `Autopilot: ${String(autopilot["address"])} (${autopilot["hasActiveGraph"] === true ? "a graph is active" : "no active graph"}).` : "No autopilot yet.",
  ].join("\n");
  return { summary, data };
}

// ------------------------------------------------------------ verify ---

export async function verifyTokenTool(ctx: ToolContext, args: { mint: string; commitment?: "confirmed" | "finalized" | undefined; list_operators?: boolean | undefined }): Promise<ToolOutput> {
  const mint = pubkey(args.mint);
  const qsl = await checkQsl1(ctx.conn, mint, { commitment: args.commitment ?? "finalized" });
  const report = await verifyLaunch(ctx.conn, mint, { listOperators: args.list_operators ?? false });

  // Every on-chain string a verifier sentence could quote: the mint's metadata, the record, its document.
  const onChain: (string | null | undefined)[] = [];
  try {
    const acc = await ctx.conn.getAccountInfo(mint, "confirmed");
    if (acc !== null) {
      const md = tokenMetadataOf(parseMint(acc.owner, new Uint8Array(acc.data)));
      if (md !== null) onChain.push(md.name, md.symbol, md.uri, ...md.additionalMetadata.flat());
    }
  } catch {
    // reported by the verifier
  }
  const rec = report.metadata?.record ?? null;
  const doc = report.metadata?.document ?? null;
  onChain.push(rec?.name, rec?.symbol, rec?.uri, rec?.tokenUri, doc?.name, doc?.symbol, doc?.description, ...(doc?.links.map((l) => l.url) ?? []));

  const badge = qslBadge(qsl);
  const metadata =
    report.metadata === null
      ? null
      : {
          address: report.metadata.address,
          verified: report.metadata.verified,
          name: untrusted(rec?.name, "token name (on-chain metadata record, written by the creator)", 64),
          symbol: untrusted(rec?.symbol, "token symbol (on-chain metadata record, written by the creator)", 16),
          description: untrusted(doc?.description, "token description (on-chain, written by the creator)", 1_000),
          links: (doc?.links ?? []).map((l) => ({
            kind: l.kind,
            host: untrusted(l.host, `${l.kind} link's host (on-chain, chosen by the creator)`, 100),
            url: untrusted(l.url, `${l.kind} link (on-chain, chosen by the creator)`, 300),
          })),
          hasIcon: doc?.icon !== null && doc?.icon !== undefined,
          // The SDK's sentences about the document quote the creator's own fields (a name of any length, any text).
          documentProblems: (doc?.problems ?? []).map((p) => untrusted(p, "problem found in the creator's metadata document (quotes text the creator wrote)", 300)!),
        };
  const o = report.pqOrigin;
  const prog = qsl.programmable;
  const tag = badge.programmable;
  const data = {
    notice: UNTRUSTED_NOTICE,
    mint,
    qsl: {
      standard: qsl.standard,
      level: qsl.level,
      levelName: qsl.level === 0 ? null : QSL1_LEVEL_NAMES[qsl.level],
      wouldBe: qsl.wouldBe,
      candidate: qsl.candidate,
      cluster: qsl.cluster,
      graduated: qsl.graduated,
      migrated: qsl.migrated,
      badge: { title: badge.title, tone: badge.tone, summary: badge.summary, lines: badge.lines },
      // A tag next to the level ("programmable"), never a level: launch rules and automation are not a safety feature.
      programmable: {
        present: prog.present,
        verified: prog.verified,
        tag: tag?.text ?? null,
        summary: tag?.summary ?? null,
        warnings: prog.warnings.map((w) => ({ kind: w.kind, component: w.component, plain: w.plain })),
        rules: prog.rules === undefined ? null : { hash: prog.rules.hashHex, address: prog.rules.address, explanation: prog.rules.explain, verified: prog.rules.verified },
        autopilot:
          prog.autopilot === undefined
            ? null
            : { address: prog.autopilot.address, activeGraph: prog.autopilot.activeGraphHex, explanation: prog.autopilot.explain, frozen: prog.autopilot.frozen, operator: prog.autopilot.operator, verified: prog.autopilot.verified },
        checks: prog.checks.map((c) => ({ id: c.id, component: c.component, title: c.title, status: c.status, ok: c.ok, plain: c.plain, detail: detailText(c.detail, onChain) })),
      },
      reasons: qsl.reasons,
      blocking: qsl.blocking,
      checks: qsl.checks.map((c) => ({ id: c.id, level: c.level, title: c.title, status: c.status, ok: c.ok, plain: c.plain, detail: detailText(c.detail, onChain) })),
      info: qsl.info.map((i) => ({ id: i.id, title: i.title, status: i.status, plain: i.plain, detail: detailText(i.detail, onChain) })),
      slot: qsl.slot,
    },
    verification: {
      overall: report.overall,
      phase: report.phase,
      checks: report.checks.map((c) => ({ id: c.id, label: c.label, status: c.status, detail: detailText(c.detail, onChain) })),
      pqOrigin: o === null ? null : { verified: o.verified, signatureValid: o.signatureValid, identity: o.identity, identityId: o.identityId, leaf: o.leaf, attestation: o.attestation, notBefore: iso(o.window.notBefore), notAfter: iso(o.window.notAfter) },
      // A party's note may quote an RPC error ("could not list ...").
      trustedParties: report.trustedParties.map((t) => ({ name: t.name, kind: t.kind, address: t.address, note: untrusted(t.note, "verifier note (may quote the RPC endpoint's answers)", 400) })),
    },
    metadata,
    rules: report.rules === null ? null : { hash: report.rules.hash, address: report.rules.address, explanation: report.rules.explanation, boundInPolicy: report.rules.boundInPolicy, verified: report.rules.verified },
  };
  const failing = report.checks.filter((c) => c.status === "fail").map((c) => c.label);
  const problems = metadata?.documentProblems.length ?? 0;
  const summary = [
    `${badge.title}: ${badge.summary}`,
    qsl.level === 0 && qsl.wouldBe > 0
      ? `It would be QSL-1 level ${qsl.wouldBe} (${QSL1_LEVEL_NAMES[qsl.wouldBe as 1 | 2]})${qsl.candidate ? " once the programs are final and it is read on mainnet" : ""}.`
      : null,
    ...qsl.reasons.slice(0, 5).map((r) => `- ${r}`),
    tag === null ? "No launch rules or automation (not programmable)." : `${tag.text}: ${tag.summary}`,
    ...(tag === null ? [] : tag.warnings.slice(0, 5).map((w) => `- ${w}`)),
    `Independent verifier: overall ${report.overall}${failing.length > 0 ? `; failing: ${failing.join(", ")}` : ""}.`,
    o === null ? "No post-quantum attestation." : `Post-quantum origin ${o.verified ? "verified" : "NOT verified"} (one-time leaf ${o.leaf}).`,
    metadata === null ? null : `Name in the record: ${quoteUntrusted(metadata.name)}.`,
    problems === 0 ? null : `The creator's metadata document has ${problems} problem(s) (listed as untrusted text in metadata.documentProblems).`,
  ].filter((x): x is string => x !== null && x !== "");
  return { summary: summary.join("\n"), data };
}

// ------------------------------------------------------------ rules ---

export async function getRulesTool(ctx: ToolContext, args: RulesSource): Promise<ToolOutput> {
  const given = [args.rules_text, args.rules_base64, args.rules_hex].some((x) => x !== undefined && x !== "");
  let onChain: Record<string, unknown> | undefined;
  if (!given && args.launch !== undefined) {
    // The launch's own rules, as bound on-chain.
    const b = await readBoundRules(ctx, args.launch);
    onChain = b.onChain;
    if (b.bound.rulesHash === null) {
      return {
        summary: `Launch ${b.launch.publicKey.toBase58()} has no custom launch rules${b.bound.boundIn === null ? " (not attested yet)" : ""}: only its built-in launch guard applies, and sells are never blocked.`,
        data: { valid: true, none: true, source: "on-chain", onChain },
      };
    }
    if (b.bound.record === null) {
      return {
        summary: `Launch ${b.launch.publicKey.toBase58()} names rules hash ${String(onChain["rulesHash"])}, but no rules record with that hash is on-chain.`,
        data: { valid: false, errors: ["the bound rules record is missing"], source: "on-chain", onChain },
      };
    }
    args = { ...args, rules_base64: toBase64(b.bound.record.bytes) };
  }
  const r = await readRules(ctx, args);
  if (!r.valid) {
    return {
      summary: [`These rules are NOT valid: the chain would refuse them.`, ...r.errors.map((e) => `- ${e}`)].join("\n"),
      data: { valid: false, errors: r.errors, source: r.source, ...(onChain === undefined ? {} : { onChain }) },
    };
  }
  if (onChain !== undefined) r.onChain = onChain;
  const guardLine =
    onChain === undefined
      ? []
      : [
          onChain["enforcedByLaunchGuard"] === true
            ? "The Launch Guard enforces exactly these rules."
            : onChain["enforcedByLaunchGuard"] === false
              ? "WARNING: the Launch Guard's rules differ from the bound record."
              : "Bound in the attestation; the Launch Guard installs them at launch.",
        ];
  return {
    summary: [`Launch rules (${onChain === undefined ? r.source : `bound on-chain in the ${String(onChain["boundIn"])}`}), hash ${r.rulesHash}, ${r.sizeBytes} bytes:`, ...r.explanation.map((l) => `- ${l}`), ...guardLine].join("\n"),
    data: {
      valid: true,
      source: onChain === undefined ? r.source : "on-chain",
      rulesHash: r.rulesHash,
      sizeBytes: r.sizeBytes,
      bytesBase64: r.bytesBase64,
      guardSecs: r.guardSecs,
      text: r.text,
      rules: r.set,
      explanation: r.explanation,
      ...(r.onChain === undefined ? {} : { onChain: r.onChain }),
    },
  };
}

// ------------------------------------------------------------ autopilot ---

export interface LoadedAutopilot {
  due: DueNodes;
  launch: LaunchAccount | null;
  decimals: number;
  poolFeeBps: number | null;
  /** What keepers' partial buybacks moved of each node's open run (the SDK's decoding of `partial_spent`). */
  partialSpent: bigint[];
  /** A keeper buyback's floor: 1% of the pool's SOL (null: no pool yet). */
  floor: bigint | null;
}

export async function loadAutopilot(ctx: ToolContext, launchAddr: string, poolFeeBps?: number): Promise<LoadedAutopilot> {
  const launch = pubkey(launchAddr);
  const l = await fetchLaunch(ctx.conn, launch);
  if (l === null) throw new Refusal("no Noised launch exists at this address");
  const fee = poolFeeBps ?? MIGRATION_FEE_TIERS_BPS[l.migrationFeeOption] ?? null;
  const due = await fetchDueNodes(ctx.conn, launch, fee === null ? {} : { poolFeeBps: fee });
  if (due === null) throw new Refusal("this launch has no autopilot (nobody has run init_autopilot for it)");
  return { due, launch: l, decimals: l.tokenDecimal, poolFeeBps: fee, partialSpent: due.view.autopilot.partialSpent, floor: keeperFloorOf(due) };
}

function nodeDefinition(g: Graph, i: number): Record<string, unknown> {
  const n = g.nodes[i]!;
  const unit = actionUnit(n.action);
  const dec = g.tokenDecimals ?? 6;
  return {
    index: i,
    id: n.id,
    action: n.action.kind,
    unit: unit === "lamports" ? "lamports (wSOL)" : "raw token units",
    trigger: n.trigger,
    operatorOnly: n.operatorGated,
    maxPerRun: actionMax(n.action),
    maxPerRunText: amountText(actionMax(n.action), unit, dec),
    ...(n.action.kind === "buybackBurn" ? { maxPremiumBps: n.action.maxPremiumBps } : {}),
    budgetPerEpoch: n.budgetPerEpoch,
    budgetPerEpochText: amountText(n.budgetPerEpoch, unit, dec),
    epochSecs: n.epochSecs,
    maxRunsPerEpoch: n.maxRunsPerEpoch,
    explanation: explainNode(g, i),
  };
}

/** A node's status as JSON: the SDK's (`NodeStatus`), with the run left open by partial buybacks. */
interface NodeStatusJson {
  due: boolean;
  operatorOnly: boolean;
  reason: NodeStatus["reason"];
  why: string;
  programError: string | null;
  bounds: Record<string, unknown> | null;
  openRun: Record<string, unknown> | null;
  minOut: bigint | null;
  expectedOut: bigint | null;
}

function nodeStatusJson(a: LoadedAutopilot, i: number, st: NodeStatus): NodeStatusJson {
  const n = a.due.graph?.nodes[i];
  const unit = n === undefined ? "lamports" : actionUnit(n.action);
  const dec = a.decimals;
  const p1 = n === undefined ? 0n : actionMax(n.action);
  const spent = a.partialSpent[i] ?? 0n;
  const keeperBuyback = n?.action.kind === "buybackBurn" && !st.operatorOnly;
  return {
    due: st.due,
    operatorOnly: st.operatorOnly,
    reason: st.reason,
    why: st.why,
    programError: st.error,
    bounds: st.due
      ? {
          min: st.minAmount,
          max: st.maxAmount,
          suggested: st.amount,
          minText: amountText(st.minAmount, unit, dec),
          maxText: amountText(st.maxAmount, unit, dec),
          suggestedText: amountText(st.amount, unit, dec),
          ...(keeperBuyback
            ? {
                // A keeper's smaller buyback is partial: it leaves the rest of the run open and must leave at least the floor of it.
                cap: st.cap,
                floor: a.floor,
                suggestedIsPartial: st.partial,
              }
            : {}),
        }
      : null,
    openRun: spent > 0n ? { partialSpent: spent, partialSpentText: amountText(spent, unit, dec), restOfRun: p1 > spent ? p1 - spent : 0n } : null,
    minOut: st.due ? st.minOut : null,
    expectedOut: st.due ? st.expectedOut : null,
  };
}

function nextSteps(a: LoadedAutopilot): string[] {
  const out: string[] = [];
  const d = a.due;
  if (d.applyPendingFirst) out.push("A queued graph is due: apply_pending must run before any step (anyone can send it).");
  if (d.graph === null) out.push(d.view.active === null ? "No graph is active yet: nothing can run." : "The autopilot's mint is not bound yet: nothing can run.");
  d.statuses.forEach((s, i) => {
    if (s.reason === "notObserved") out.push(`Step ${i} waits for a price check: build_update_price_tx, send it, wait at least a minute, then build_run_tx.`);
  });
  for (const i of d.due) {
    const s = d.statuses[i]!;
    out.push(s.operatorOnly ? `Step ${i} is ready for the operator: build_run_tx with the operator and an amount within its bounds.` : `Step ${i} is ready: anyone can build_run_tx it and earn the tip.`);
  }
  if (out.length === 0) out.push("Nothing is due now.");
  return out;
}

export async function getAutopilotTool(ctx: ToolContext, args: { launch: string; pool_fee_bps?: number | undefined }): Promise<ToolOutput> {
  const a = await loadAutopilot(ctx, args.launch, args.pool_fee_bps);
  const { view, graph, state, statuses } = a.due;
  const ap = view.autopilot;
  const dec = a.decimals;
  const nodes =
    graph === null
      ? []
      : graph.nodes.map((_, i) => {
          const rt = state?.nodes[i];
          const st = statuses[i];
          return {
            ...nodeDefinition(graph, i),
            state: rt === undefined ? null : { lastRun: iso(rt.lastRun), runsInEpoch: rt.runsInEpoch, spentInEpoch: rt.spentInEpoch, epochStart: iso(rt.epochStart) },
            status: st === undefined ? null : nodeStatusJson(a, i, st),
          };
        });
  const pool = view.pool;
  const data = {
    launch: ap.launch,
    autopilot: ap.publicKey,
    clusterTime: iso(view.now),
    frozen: ap.frozen,
    graduated: ap.graduated,
    mintBound: ap.mintBound,
    mint: ap.mintBound ? ap.mint : null,
    operator: ap.operatorOrNull,
    activeGraphHash: ap.hasActiveGraph ? toHex(ap.activeGraph) : null,
    activatedAt: iso(ap.activatedAt),
    pending:
      view.pending === null
        ? null
        : { graphHash: toHex(view.pending.graphHash), activateAt: iso(view.pending.activateAt), operator: view.pending.operator, explanation: explainGraph(view.pending.graph) },
    applyPendingFirst: a.due.applyPendingFirst,
    treasury: {
      address: view.treasury.address,
      wsolAccount: view.treasury.wsol,
      tokenAccount: view.treasury.token,
      sol: view.treasury.sol,
      solText: sol(view.treasury.sol),
      tokens: view.treasury.tokens,
      tokensText: amountText(view.treasury.tokens, "tokens", dec),
    },
    referencePrice: { sqrtPriceQ64: ap.refSqrtPrice, text: priceText(ap.refSqrtPrice, dec), updatedAt: iso(ap.refUpdatedAt) },
    pool: pool === null ? null : { address: pool.address, sqrtPriceQ64: pool.sqrtPrice, spotText: priceText(pool.sqrtPrice, dec), sol: pool.sol, solText: sol(pool.sol) },
    poolFeeBps: a.poolFeeBps,
    tipsThisEpoch: ap.tipsInEpoch,
    graph:
      graph === null
        ? null
        : { operator: graph.operator, recipients: graph.recipients.map((r) => ({ address: r.address, bps: r.bps })), text: printGraph(graph), explanation: explainGraph(graph) },
    nodes,
    due: a.due.due,
    nextSteps: nextSteps(a),
  };
  const summary = [
    `Autopilot ${ap.publicKey.toBase58()} for launch ${ap.launch.toBase58()}${ap.frozen ? " (frozen forever)" : ""}.`,
    `Treasury: ${sol(view.treasury.sol)} and ${amountText(view.treasury.tokens, "tokens", dec)}. Reference price: ${priceText(ap.refSqrtPrice, dec)}${pool === null ? "; not graduated (no pool yet)" : `; pool spot ${priceText(pool.sqrtPrice, dec)}, pool depth ${sol(pool.sol)}`}.`,
    `Operator: ${ap.operatorOrNull?.toBase58() ?? "none"}.`,
    ...(graph === null
      ? []
      : graph.nodes.map((n, i) => {
          const st = statuses[i];
          if (st === undefined) return `Step ${i} (${n.id}): not now - n/a`;
          const spent = a.partialSpent[i] ?? 0n;
          const open = spent > 0n ? ` (partial buybacks already moved ${amountText(spent, actionUnit(n.action), dec)} of this run)` : "";
          return `Step ${i} (${n.id}): ${st.due ? `DUE${st.operatorOnly ? " (operator only)" : ""}, up to ${amountText(st.maxAmount, actionUnit(n.action), dec)}${open}` : `not now - ${st.why}`}`;
        })),
    ...nextSteps(a),
  ].join("\n");
  return { summary, data };
}

export async function getDueNodesTool(ctx: ToolContext, args: { launch: string; pool_fee_bps?: number | undefined }): Promise<ToolOutput> {
  const a = await loadAutopilot(ctx, args.launch, args.pool_fee_bps);
  const { graph, statuses } = a.due;
  const all = statuses.map((s, i) => ({ index: i, id: graph?.nodes[i]?.id ?? null, action: graph?.nodes[i]?.action.kind ?? null, ...nodeStatusJson(a, i, s) }));
  const due = all.filter((x) => x.due === true);
  const blocked = all.filter((x) => x.due !== true).map((x) => ({ index: x.index, id: x.id, reason: x.reason, why: x.why, programError: x.programError }));
  const data = { launch: a.due.view.autopilot.launch, clusterTime: iso(a.due.view.now), applyPendingFirst: a.due.applyPendingFirst, poolFeeBps: a.poolFeeBps, due, blocked, nextSteps: nextSteps(a) };
  const summary = [
    due.length === 0 ? "No step is due now." : `${due.length} step(s) due: ${due.map((d) => `${d.index}${statuses[d.index]!.operatorOnly ? " (operator only)" : ""}`).join(", ")}.`,
    ...nextSteps(a),
  ].join("\n");
  return { summary, data };
}


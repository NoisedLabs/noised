/**
 * Build tools: UNSIGNED autopilot transactions, each with a plain-English
 * "what this does", what it costs, and the RPC's simulation of it. The
 * server never signs and holds no key: whoever must sign (listed in
 * `signersRequired`) reviews the transaction and signs it in their own
 * wallet or signer. A transaction that comes back from the SDK carrying any
 * signature is never returned.
 *
 * The chain enforces every limit. These tools also refuse, before building,
 * anything the program would refuse, decided by the SDK's port of the
 * program (`NodeStatus`, `planRun`: runRules.ts): a step that is not due, an
 * amount outside the step's on-chain bounds (or a keeper's partial buyback
 * that leaves too little for the rest of its run, 6041), a payout no
 * recipient can receive (6042), a wrong operator, a graph payee that could
 * never receive its share, a cluster that is not the configured one.
 *
 * A run transaction never creates or pays for anyone else's account: the
 * SDK's `buildRunTx` skips a recipient without a wSOL account (the program
 * keeps its share in the treasury) and creates only the caller's own wSOL
 * account for the tip; this server re-checks every instruction before
 * returning it. A run's costs are the SDK's `RunCosts`.
 *
 * The simulation comes from the RPC endpoint: its logs and error text are
 * returned as untrusted text; only error codes the SDK knows are named in
 * trusted text.
 */
import {
  actionUnit,
  AUTOPILOT,
  autopilotErrorCode,
  buildPublishGraphTx,
  buildRunTx,
  buildUpdatePriceTx,
  explainGraph,
  explainNode,
  KNOWN_ACCOUNTS,
  planPartial,
  planSpent,
  plainErrorMessage,
  priorityFeeLamports,
  PROGRAM_IDS,
  PUBLISH_GRAPH_LEGACY_MAX_BYTES,
  rentExemptLamports,
  simulateAndExplain,
  toHex,
  WSOL_MINT,
  wsolAta,
  type AutopilotErrorName,
  type RunCosts,
} from "@noisedlabs/sdk";
import { PublicKey, type Transaction } from "@solana/web3.js";

import { checkCluster } from "../cluster.js";
import { errorUntrusted, quoteUntrusted, rpcText, UNTRUSTED_NOTICE, type UntrustedText } from "../untrusted.js";
import { amountText, errorText, pubkey, Refusal, sol, type ToolContext, type ToolOutput } from "./common.js";
import { loadAutopilot } from "./read.js";
import { readGraph, type GraphSource } from "./rules.js";
import { expectedTip, planStep, programErrorText } from "./runRules.js";

const SIGN_NOTE = "UNSIGNED. This server never signs and holds no keys: review what it does, then sign with the keys listed in signersRequired in your own wallet or signer, and send it before its blockhash expires (about a minute).";

/** The base fee per signature (lamports). */
const LAMPORTS_PER_SIGNATURE = 5_000n;

/** Re-checks the endpoint's cluster before anything is built (it must still be the one checked at start). */
async function guardCluster(ctx: ToolContext): Promise<void> {
  let now;
  try {
    now = await checkCluster(ctx.conn, ctx.config.cluster, ctx.config.allowMainnet);
  } catch (e) {
    // checkCluster's messages are its own (they never repeat what the endpoint said).
    throw new Refusal(`refusing to build: ${errorText(e)}`);
  }
  if (now.genesisHash !== ctx.cluster.genesisHash) throw new Refusal("refusing to build: the endpoint now serves another cluster than at start");
}

// The SDK builders' own refusals: plain Errors with these openings, worded by the SDK from data it checked
// (addresses, amounts, program error names). Anything else (an RPC error, whose message the endpoint chose) is not
// promoted to a refusal: it comes back as an error with its message marked untrusted.
const SDK_REFUSAL = /^(refusing to build: |refusing to publish this graph: |the transaction would be \d+ bytes, over the \d+-byte legacy limit|a \d+-byte graph does not fit a legacy transaction)/;

/**
 * The SDK's builders throw "refusing to build: ... (the program would fail with X)": surface those as refusals, with
 * the program's error (and its code) in the structured result.
 */
async function sdkBuild<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof Error && Object.getPrototypeOf(e) === Error.prototype && SDK_REFUSAL.test(e.message)) {
      const m = /\(the program would fail with (\w+)\)$/.exec(e.message);
      if (m === null) throw new Refusal(errorText(e));
      throw new Refusal(errorText(`${e.message.slice(0, m.index)}(the program would fail with ${programErrorText(m[1]!)})`), { programError: m[1]! });
    }
    throw e;
  }
}

const priority = (p: string | undefined): { computeUnitPrice?: bigint } => (p === undefined ? {} : { computeUnitPrice: BigInt(p) });

/** What sending a transaction costs its fee payer: the SDK's `RunCosts` (a run's are `buildRunTx`'s own), and how many signatures it needs. */
export type TxCosts = RunCosts & { signatures: number };

/**
 * The costs of a transaction the SDK builds without stating them (update_price, publish_graph): 5,000 lamports a
 * signature, the priority fee (price x compute-unit limit, the SDK's `priorityFeeLamports`), and `rentLamports` for
 * the account it creates.
 */
export function feeCosts(tx: Transaction, rentLamports: bigint): TxCosts {
  const signatures = tx.compileMessage().header.numRequiredSignatures;
  let limit: number | null = null;
  let price = 0n;
  let others = 0;
  for (const ix of tx.instructions) {
    if (!ix.programId.equals(KNOWN_ACCOUNTS.computeBudget)) {
      others += 1;
      continue;
    }
    const d = Buffer.from(ix.data);
    if (d[0] === 2 && d.length >= 5) limit = d.readUInt32LE(1);
    if (d[0] === 3 && d.length >= 9) price = d.readBigUInt64LE(1);
  }
  const signatureFeeLamports = LAMPORTS_PER_SIGNATURE * BigInt(signatures);
  const pf = price === 0n ? 0n : priorityFeeLamports(price, limit ?? Math.min(200_000 * others, 1_400_000));
  return { signatures, signatureFeeLamports, priorityFeeLamports: pf, rentLamports, totalLamports: signatureFeeLamports + pf + rentLamports };
}

/** One line: what the transaction costs `payer`; `rentFor` names the account whose rent it pays. */
function costLine(c: TxCosts, payer: string, rentFor: string): string {
  const parts = [`${sol(c.signatureFeeLamports)} network fee (${c.signatures} signature(s), ${c.signatureFeeLamports} lamports)`];
  if (c.priorityFeeLamports > 0n) parts.push(`up to ${sol(c.priorityFeeLamports)} priority fee (${c.priorityFeeLamports} lamports)`);
  if (c.rentLamports > 0n) parts.push(`${sol(c.rentLamports)} rent for ${rentFor} (${c.rentLamports} lamports)`);
  return `Cost to ${payer}: ${parts.join(" + ")} = ${c.totalLamports} lamports in all.`;
}

async function finish(ctx: ToolContext, tx: Transaction, whatThisDoes: string[], extra: Record<string, unknown>, warnings: string[], costs: TxCosts): Promise<ToolOutput> {
  // Never signed: the SDK's builders only build; anything carrying a signature is not this server's to return.
  if (tx.signatures.some((s) => s.signature !== null)) throw new Error("a built transaction carries a signature; this server never returns signed transactions");
  const message = tx.compileMessage();
  const signers = message.accountKeys.slice(0, message.header.numRequiredSignatures).map((k) => k.toBase58());
  const base64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  let simulation: Record<string, unknown>;
  let simLine: string;
  try {
    const r = await simulateAndExplain(ctx.conn, tx, ctx.config.commitment);
    // Error codes the SDK knows (named from its own tables); anything the endpoint wrote (the error text, the logs)
    // stays untrusted text.
    const errorCode = r.errorCode ?? null;
    const plain = errorCode !== null && errorCode.program === "noised_autopilot" ? plainErrorMessage(PROGRAM_IDS.autopilot, errorCode.code) : null;
    const error: UntrustedText | null = r.error === null ? null : rpcText(r.error, "simulation error");
    simulation = {
      ok: r.ok,
      error,
      errorCode,
      errorPlain: plain,
      failedInstruction: r.failedInstruction ?? null,
      unitsConsumed: r.unitsConsumed,
      feeLamports: r.feeLamports,
      programs: r.programs.map((p) => ({ programId: p.programId, name: p.name })),
      unknownPrograms: r.unknownPrograms,
      logs: r.logs.slice(-40).map((l) => rpcText(l, "simulation log line", 300)),
    };
    if (r.unknownPrograms.length > 0) warnings.push(`The transaction calls programs this SDK does not know (${r.unknownPrograms.map((p) => p.toBase58()).join(", ")}): do not sign it.`);
    simLine = r.ok
      ? `Simulation: succeeds (${typeof r.unitsConsumed === "number" ? r.unitsConsumed : "?"} compute units).`
      : `Simulation: FAILS${errorCode === null ? "" : ` with ${errorCode.name} (${errorCode.code})`}.${plain === null ? "" : ` ${plain}`} The endpoint's error text: ${quoteUntrusted(error, "(none)", "RPC")}. Do not send it as is.`;
  } catch (e) {
    const err = errorUntrusted(e);
    simulation = { ok: null, error: err };
    simLine = `Simulation could not run: ${quoteUntrusted(err, "(no message)", "error")}.`;
  }
  const data = {
    notice: UNTRUSTED_NOTICE,
    unsignedTransaction: {
      base64,
      encoding: "base64",
      format: "legacy",
      feePayer: tx.feePayer ?? null,
      recentBlockhash: tx.recentBlockhash ?? null,
      lastValidBlockHeight: tx.lastValidBlockHeight ?? null,
      sizeBytes: base64.length === 0 ? 0 : Buffer.from(base64, "base64").length,
      signersRequired: signers,
    },
    whatThisDoes,
    costs,
    simulation,
    warnings,
    signNote: SIGN_NOTE,
    cluster: ctx.cluster.cluster,
    ...extra,
  };
  const summary = [...whatThisDoes, `Must be signed by: ${signers.join(", ")}.`, simLine, ...warnings.map((w) => `Warning: ${w}`), SIGN_NOTE].join("\n");
  return { summary, data };
}

// ------------------------------------------------------------ update_price ---

export async function buildUpdatePriceTool(ctx: ToolContext, args: { launch: string; payer: string; priority_fee_micro_lamports?: string | undefined }): Promise<ToolOutput> {
  await guardCluster(ctx);
  const launch = pubkey(args.launch);
  const payer = pubkey(args.payer);
  const tx = await sdkBuild(() => buildUpdatePriceTx(ctx.conn, payer, launch, priority(args.priority_fee_micro_lamports)));
  const costs = feeCosts(tx, 0n);
  return finish(
    ctx,
    tx,
    [
      `Records the pool's current price for launch ${launch.toBase58()}'s autopilot (update_price). It moves no funds; the payer pays only the network fee.`,
      "The reference price follows the pool slowly (it rises at most 5% an hour). A buyback needs a price check at least a minute old: send this, wait a minute, then run the buyback.",
      costLine(costs, payer.toBase58(), "no account"),
    ],
    { action: "update_price", launch },
    [],
    costs,
  );
}

// ------------------------------------------------------------ run ---

export interface BuildRunArgs {
  launch: string;
  node: number;
  caller: string;
  operator?: string | undefined;
  amount?: string | undefined;
  pool_fee_bps?: number | undefined;
  priority_fee_micro_lamports?: string | undefined;
}

/**
 * Re-checks the SDK's run transaction before it is returned: compute budget, the autopilot's `run`, and the
 * creation of the caller's OWN wSOL account (its tip account, at its canonical address, paid by the caller) are all
 * it may hold. Anything else (another owner's account, another program) is refused, never rewritten. Returns the
 * accounts it creates.
 */
function ownAccountsOnly(tx: Transaction, caller: PublicKey): PublicKey[] {
  const creates: PublicKey[] = [];
  for (const ix of tx.instructions) {
    if (ix.programId.equals(KNOWN_ACCOUNTS.computeBudget) || ix.programId.equals(PROGRAM_IDS.autopilot)) continue;
    if (ix.programId.equals(KNOWN_ACCOUNTS.associatedToken)) {
      const [funder, ata, owner, mint] = ix.keys.map((k) => k.pubkey);
      if (funder?.equals(caller) === true && owner?.equals(caller) === true && mint?.equals(WSOL_MINT) === true && ata?.equals(wsolAta(caller)) === true) {
        creates.push(ata);
        continue;
      }
      throw new Refusal(`refusing to build: the run transaction would create an account for ${(owner ?? ata ?? ix.programId).toBase58()}; this server never creates or pays for anyone else's account`);
    }
    throw new Refusal(`refusing to build: the run transaction would call an unexpected program (${ix.programId.toBase58()})`);
  }
  return creates;
}

export async function buildRunTool(ctx: ToolContext, args: BuildRunArgs): Promise<ToolOutput> {
  await guardCluster(ctx);
  const launch = pubkey(args.launch);
  const caller = pubkey(args.caller);
  const a = await loadAutopilot(ctx, args.launch, args.pool_fee_bps);
  const d = a.due;
  if (d.applyPendingFirst) throw new Refusal("refusing to build: a queued graph is due and must be applied first (apply_pending); every run fails until then (PendingUpdateDue)");
  if (d.graph === null) throw new Refusal(d.view.active === null ? "refusing to build: no graph is active (NoActiveGraph)" : "refusing to build: the autopilot's mint is not bound yet (MintNotBound)");
  const g = d.graph;
  const n = g.nodes[args.node];
  const st = d.statuses[args.node];
  if (n === undefined || st === undefined) throw new Refusal(`refusing to build: the active graph has no step ${args.node} (it has ${g.nodes.length}: 0 to ${g.nodes.length - 1}) (${programErrorText("NoSuchNode")})`);
  const unit = actionUnit(n.action);
  const dec = a.decimals;
  const text = (x: bigint): string => amountText(x, unit, dec);
  if (!st.due) {
    throw new Refusal(`refusing to build: step ${args.node} (${n.id}) cannot run now: ${st.why}${st.error === null ? "" : ` (the program would fail with ${programErrorText(st.error)})`}`, { reason: st.reason, programError: st.error });
  }
  const kind = n.action.kind;
  const isBuyback = kind === "buybackBurn";
  const floor = isBuyback ? a.floor : null;
  const bounds = {
    min: st.minAmount,
    max: st.maxAmount,
    minText: text(st.minAmount),
    maxText: text(st.maxAmount),
    cap: st.cap,
    partialSpent: a.partialSpent[args.node] ?? 0n,
    ...(floor === null ? {} : { floor }),
  };
  const stored = d.view.autopilot.operatorOrNull;
  const warnings: string[] = [];
  let amount: bigint | null = args.amount === undefined ? null : BigInt(args.amount);
  let operator: PublicKey | null = null;
  if (st.operatorOnly) {
    if (stored === null) throw new Refusal(`refusing to build: this step is operator-only and the operator was removed (${programErrorText("NoOperator")})`);
    if (args.operator === undefined) throw new Refusal(`refusing to build: step ${args.node} is operator-only; pass operator = ${stored.toBase58()} (it must sign)`, { operator: stored });
    operator = pubkey(args.operator);
    if (!operator.equals(stored)) throw new Refusal(`refusing to build: ${operator.toBase58()} is not this autopilot's operator (${stored.toBase58()}); the program would fail with ${programErrorText("WrongOperator")}`, { operator: stored });
    if (amount === null) throw new Refusal(`refusing to build: an operator-only step needs the operator's amount, from ${bounds.minText} to ${bounds.maxText} (raw ${bounds.min} to ${bounds.max})`, { bounds });
  } else {
    if (args.operator !== undefined) warnings.push("This step is not operator-only: the operator argument was ignored (anyone may run it).");
    if (amount !== null && !isBuyback) {
      throw new Refusal(`refusing to build: only operator-only steps and buybacks take an amount; this step always moves its full allowed amount (${programErrorText("AmountNotAllowed")})`, { programError: "AmountNotAllowed" });
    }
    if (isBuyback && amount === null && st.amount < st.maxAmount) {
      // The SDK's choice for a keeper: the largest buyback the pool fills that leaves at least the floor of the run.
      amount = st.amount;
      warnings.push(`The full ${bounds.maxText} would not fill against the pool now: this is a PARTIAL buyback of ${text(amount)} (the largest that fills and leaves at least 1% of the pool's SOL for the rest of the run).`);
    }
  }

  // The program's own decision for exactly this run (the SDK's planRun on the account as read).
  const planned = planStep(d, args.node, amount, operator);
  if (!planned.ok) {
    const error: AutopilotErrorName = planned.error;
    const plain = plainErrorMessage(PROGRAM_IDS.autopilot, autopilotErrorCode(error));
    if (amount === null) throw new Refusal(`refusing to build: step ${args.node} (${n.id}) cannot run now (the program would fail with ${programErrorText(error)})`, { programError: error });
    const hint = error === "RemainderTooSmall" && floor !== null ? ` Choose at most ${text(st.cap > floor ? st.cap - floor : 0n)}, or omit the amount to move ${bounds.maxText} as one full run.` : "";
    throw new Refusal(
      `refusing to build: ${text(amount)} (raw ${amount}) is outside this step's on-chain bounds right now: ${bounds.minText} to ${bounds.maxText} (raw ${bounds.min} to ${bounds.max})${plain === null ? "" : `; ${plain}`} (the program would fail with ${programErrorText(error)}). The chain enforces these limits; a caller can only choose within them.${hint}`,
      { bounds, requested: amount, programError: error },
    );
  }
  const plan = planned.value;
  const partial = planPartial(plan);
  const moved = planSpent(plan);
  if (isBuyback && amount !== null && amount > st.amount) {
    warnings.push(`Estimate: a buyback of ${text(amount)} may not return the program's minimum out against the pool now (largest that fills: ${text(st.amount)}); the simulation below shows the outcome.`);
  }

  // The SDK builds the run: a recipient without a wSOL account is skipped (its share stays in the treasury), nobody
  // creates a recipient's account, and a payout nobody can receive is refused (NoRecipientAccount, 6042).
  const built = await sdkBuild(() => buildRunTx(ctx.conn, caller, launch, args.node, { amount, operator, ...priority(args.priority_fee_micro_lamports) }));
  const creates = ownAccountsOnly(built.tx, caller);
  // The SDK's RunCosts, with the signature fee of the message as built: the SDK counts the operator as a second signer
  // on an operator-only step even when the caller is the operator (one key, one signature).
  const signatures = built.tx.compileMessage().header.numRequiredSignatures;
  const signatureFeeLamports = LAMPORTS_PER_SIGNATURE * BigInt(signatures);
  const costs: TxCosts = { ...built.costs, signatureFeeLamports, totalLamports: built.costs.totalLamports - built.costs.signatureFeeLamports + signatureFeeLamports, signatures };
  if (creates.length > 0 && costs.rentLamports === 0n) {
    warnings.push("The endpoint reported no rent for the caller's own wSOL account this transaction creates; creating one normally costs about 0.00204 SOL (the caller's, back when it closes the account).");
  }

  // A payout: each recipient's share (the plan's), and whether the program can pay it (the SDK's skipped recipients).
  let recipients: { address: PublicKey; wsolAccount: PublicKey; share: bigint; hasAccount: boolean }[] = [];
  let paid: bigint | null = null;
  let kept = 0n;
  if (plan.kind === "distribute") {
    const skipped = new Set(built.skippedRecipients.map((k) => k.toBase58()));
    recipients = g.recipients.map((r, i) => {
      const address = new PublicKey(r.address);
      return { address, wsolAccount: wsolAta(address), share: plan.shares[i] ?? 0n, hasAccount: !skipped.has(address.toBase58()) };
    });
    paid = recipients.reduce((s, x) => s + (x.hasAccount ? x.share : 0n), 0n);
    kept = recipients.reduce((s, x) => s + (x.hasAccount ? 0n : x.share), 0n);
    for (const x of recipients) {
      if (x.share > 0n && !x.hasAccount) {
        warnings.push(`Recipient ${x.address.toBase58()} has no wSOL account (${x.wsolAccount.toBase58()}): the program skips it and its share (${sol(x.share)}) stays in the treasury. This transaction does not create that account; the recipient can create its own to be paid next time.`);
      }
    }
  }

  const tip = expectedTip(d, args.node, plan, kept);
  const graduated = d.view.autopilot.graduated;
  const restOfRun = st.cap > moved ? st.cap - moved : 0n;
  const what = [
    `Runs step ${args.node} ("${n.id}") of launch ${launch.toBase58()}'s autopilot: ${explainNode(g, args.node)}`,
    plan.kind === "buyback"
      ? `This run swaps ${text(moved)} of treasury wSOL for the token in the locked pool (the program's minimum out: ${plan.minOut} raw units, from the reference price) and burns every token bought, in the same instruction.`
      : plan.kind === "burn"
        ? `This run burns ${text(moved)} from the treasury.`
        : `This run pays ${text(moved)} from the treasury to the graph's declared recipients, by their shares: ${sol(paid ?? 0n)} to recipients with a wSOL account${kept > 0n ? `, ${sol(kept)} stays in the treasury (recipients without one)` : ""}.`,
    ...(partial
      ? [
          `PARTIAL buyback: it spends from this step's budget and earns its share of a tip, but it is not the step's run: the step stays due, and the rest of this run (${text(restOfRun)}) can be bought back later. Partial runs never add up to more than the run would move.`,
        ]
      : []),
    `The caller ${caller.toBase58()} pays the network fee and should receive a tip from the treasury of ${sol(tip)} (${tip} lamports), by the program's tip rules on the state read now: at most ${sol(AUTOPILOT.TIP_LAMPORTS)} a run${partial ? " (a partial buyback earns its share of it)" : ""} and a tenth of what the run moves${kind === "burn" && !graduated ? "; a burn before graduation earns no tip" : ""}.`,
    costLine(costs, `the caller ${caller.toBase58()}`, "the caller's own wSOL account (the caller gets it back by closing that account)"),
    creates.length > 0
      ? `It first creates the caller's own wSOL account (${creates.map((c) => c.toBase58()).join(", ")}) to receive the tip, paid by the caller. It never creates or pays for anyone else's account.`
      : "It creates no account and never pays for anyone else's.",
    st.operatorOnly ? `Operator-only step: the operator ${operator!.toBase58()} must sign; it chose this amount within the on-chain bounds (${bounds.minText} to ${bounds.maxText}).` : "Anyone may run this step; the program checks again that it is due, its budget and its condition.",
    "The program enforces every limit: value can only go to burns, the pool (bought tokens burned), declared recipients and bounded tips. The treasury never sells the token.",
  ];
  return finish(
    ctx,
    built.tx,
    what,
    {
      action: "run",
      launch,
      node: args.node,
      nodeId: n.id,
      kind: built.action,
      operatorOnly: st.operatorOnly,
      amount,
      moves: moved,
      partial,
      bounds,
      minOut: plan.kind === "buyback" ? plan.minOut : null,
      expectedOut: plan.kind === "buyback" && moved === st.amount ? st.expectedOut : null,
      expectedTipLamports: tip,
      creates,
      ...(plan.kind === "distribute"
        ? {
            recipients: recipients.map((x) => ({ address: x.address, wsolAccount: x.wsolAccount, share: x.share, hasAccount: x.hasAccount, paid: x.share > 0n && x.hasAccount })),
            skippedRecipients: built.skippedRecipients,
            paidLamports: paid,
            keptLamports: kept,
          }
        : {}),
    },
    warnings,
    costs,
  );
}

// ------------------------------------------------------------ publish_graph ---

/** The program's `GraphRecord::space` for a graph of `len` bytes. */
const graphRecordSpace = (len: number): number => 78 + len;

export async function buildPublishGraphTool(ctx: ToolContext, args: GraphSource & { launch: string; payer: string; priority_fee_micro_lamports?: string | undefined }): Promise<ToolOutput> {
  await guardCluster(ctx);
  const launch = pubkey(args.launch);
  const payer = pubkey(args.payer);
  const g = await readGraph(ctx, { ...args, launch: undefined }, false);
  if (g.bytes.length > PUBLISH_GRAPH_LEGACY_MAX_BYTES) {
    throw new Refusal(
      `refusing to build: this ${g.bytes.length}-byte graph does not fit a wallet (legacy) transaction (at most ${PUBLISH_GRAPH_LEGACY_MAX_BYTES} bytes). It needs a v1 transaction signed by a keypair, and this server never holds keys: publish it with the SDK's buildPublishGraphV1Tx from a throwaway payer.`,
    );
  }
  // The SDK checks the graph's payees first (a payee that could never receive its share is refused; cautions, such as
  // a payee without a wSOL account yet, come back as warnings).
  const r = await sdkBuild(() => buildPublishGraphTx(ctx.conn, payer, launch, g.bytes, priority(args.priority_fee_micro_lamports)));
  const explanation = explainGraph(g.graph);
  if (r.status === "already-published") {
    return {
      summary: [
        `This graph (hash ${toHex(r.graphHash)}) is already published for launch ${launch.toBase58()} at ${r.address.toBase58()}: nothing to send.`,
        ...explanation.map((l) => `- ${l}`),
        ...r.warnings.map((w) => `Warning: ${w}`),
      ].join("\n"),
      data: { status: "already-published", graphHash: toHex(r.graphHash), address: r.address, explanation, warnings: r.warnings, graphSource: g.source },
    };
  }
  const costs = feeCosts(r.tx, await rentExemptLamports(ctx.conn, graphRecordSpace(g.bytes.length)));
  return finish(
    ctx,
    r.tx,
    [
      `Publishes this autopilot graph (${g.bytes.length} bytes, hash ${toHex(r.graphHash)}) for launch ${launch.toBase58()} at ${r.address.toBase58()}. The payer pays the record's rent on top of the network fee.`,
      "Publishing changes nothing by itself: the graph runs only after the creator activates it with their quantum-safe key, and replacing a running graph also waits 72 hours in public.",
      costLine(costs, payer.toBase58(), "the graph record (held while the record exists)"),
      "What the graph would do:",
      ...explanation.map((l) => `- ${l}`),
    ],
    { action: "publish_graph", launch, graphHash: toHex(r.graphHash), address: r.address, graphSource: g.source },
    [...r.warnings],
    costs,
  );
}

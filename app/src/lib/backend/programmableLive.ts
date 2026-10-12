/**
 * LIVE programmable backend (SDK 0.9.0, P1c programs): creator launch rules (publish_rules, bound by the attestation's
 * message v3; the Launch Guard enforces them) and Autopilot (init, bind, publish, pq_authorize signed by the launch's
 * quantum identity, activate / apply, freeze, operator removal, run), all through the SDK's builders, which re-read the
 * chain and refuse what the programs would refuse.
 *
 * Two things work differently from the simulated chain:
 *   - `pq_authorize` carries a 2.5 KB quantum signature, so it is a v1 transaction from a temporary keypair
 *     (`prepareAuthorizeFromPayer`); a wallet cannot send it as one legacy transaction (`walletAuthorize: false`);
 *   - the run history is not indexed here (an empty list).
 *
 * SDK 0.9.0 (audit 4): the operator's removal signs payload v3 (it names the activation in force, `activeAuth`); every
 * quantum signature runs under the browser's signing lock with the caller's clock and second-RPC checks; a due step's
 * tip is the SDK's keeper estimate (burns valued at the burn price, partial buybacks, skipped payees) and its costs are
 * what the caller pays (fees, and only the caller's own wSOL account for the tip); payees are checked with
 * `checkGraphRecipients`.
 */
import * as sdk from "@noisedlabs/sdk";
import { PublicKey, type Connection } from "@solana/web3.js";

import { expectedRunTip } from "../programmable";
import type { AutopilotInfo, AutopilotSetupCost, DueStep, LaunchRulesInfo, ProgrammableBackend, RulesRecord } from "./programmable";

/** Said where a step needs the creator's wallet and a temporary account together (the Autopilot page does both). */
export const PROGRAMMABLE_UNAVAILABLE = "This step is not available on this network yet.";

const isZero = (b: Uint8Array): boolean => b.every((x) => x === 0);
const SIGNATURE_FEE = 5_000n;
/** A token account (SPL / Token-2022 base size): the autopilot's treasury accounts. */
const TOKEN_ACCOUNT_BYTES = 165;

const rent = async (conn: Connection, size: number): Promise<bigint> => BigInt(await conn.getMinimumBalanceForRentExemption(size));

function recordOf(r: sdk.LaunchRulesAccount): RulesRecord {
  return { address: r.publicKey, hash: Uint8Array.from(r.rulesHash), bytes: Uint8Array.from(r.bytes), publishedAt: 0 };
}

async function fetchLaunchRules(conn: Connection, launch: PublicKey): Promise<LaunchRulesInfo> {
  const [a, l] = await Promise.all([sdk.fetchAttestation(conn, launch), sdk.fetchLaunch(conn, launch)]);
  const attestedHash = a === null || !a.attested ? null : Uint8Array.from(a.rulesHash);
  const rec = attestedHash !== null && !isZero(attestedHash) ? await sdk.fetchLaunchRules(conn, launch, attestedHash) : null;
  return {
    attestedHash,
    record: rec === null ? null : recordOf(rec),
    bound: rec !== null,
    guardSecs: l?.guardSecs ?? 0,
    openedAt: l !== null && l.status === "live" ? Number(l.launchTs) : null,
  };
}

function infoOf(v: sdk.AutopilotView, decimals: number, poolFeeBps: number): AutopilotInfo {
  const a = v.autopilot;
  return {
    address: a.publicKey,
    launch: a.launch,
    mint: a.mintBound ? a.mint : null,
    treasury: v.treasury.address,
    graphHash: a.hasActiveGraph ? Uint8Array.from(a.activeGraph) : null,
    pending:
      v.pending === null
        ? null
        : { graphHash: Uint8Array.from(v.pending.graphHash), activateAt: Number(v.pending.activateAt), authorizedAt: Number(a.authMarks[0]?.slot ?? 0n), operator: v.pending.operator },
    frozen: a.frozen,
    operator: a.operatorOrNull,
    activeAuth: a.hasActiveGraph ? a.activeAuthOrNull : null,
    nodes: a.nodes.map((n) => ({ lastRun: Number(n.lastRun), runsInEpoch: n.runsInEpoch, spentInEpoch: n.spentInEpoch, epochStart: Number(n.epochStart) })),
    refSqrtPrice: a.refSqrtPrice,
    refUpdatedAt: Number(a.refUpdatedAt),
    tipsInEpoch: a.tipsInEpoch,
    tipEpochStart: Number(a.tipEpochStart),
    treasurySol: v.treasury.sol,
    treasuryTokens: v.treasury.tokens,
    // Totals are not indexed on this network yet.
    totalBurned: 0n,
    totalBoughtWithSol: 0n,
    totalPaid: 0n,
    totalTips: 0n,
    graduated: a.graduated,
    spotSqrtPrice: v.pool?.sqrtPrice ?? 0n,
    poolSol: v.pool?.sol ?? 0n,
    poolFeeBps,
    decimals,
  };
}

async function fetchAutopilot(conn: Connection, launch: PublicKey): Promise<AutopilotInfo | null> {
  const [v, l] = await Promise.all([sdk.fetchAutopilotView(conn, launch), sdk.fetchLaunch(conn, launch)]);
  if (v === null) return null;
  const fee = l === null ? 100 : (sdk.MIGRATION_FEE_TIERS_BPS[l.migrationFeeOption] ?? 100);
  return infoOf(v, l?.tokenDecimal ?? 6, fee);
}

/** Lamports per signature (the runtime's fee). */
const SIGNATURE_FEE_LAMPORTS = 5_000n;

/**
 * The steps that can run now, each with the SDK's keeper estimate of its tip and what running it costs `caller` (the
 * fee for each signer, and the rent of `caller`'s own wSOL account for the tip when it has none: never a recipient's;
 * no priority fee is added). Without a caller the rent can't be known and `costs` is null.
 */
async function findDueSteps(conn: Connection, launch: PublicKey, caller?: PublicKey | null): Promise<DueStep[]> {
  const d = await sdk.fetchDueNodes(conn, launch);
  if (d === null || d.graph === null || d.applyPendingFirst) return [];
  const a = d.view.autopilot;
  const graph = d.graph;
  const observations = sdk.autopilotStateOf(a, graph.nodes.length).observations ?? [];
  // Payees without a wSOL account are skipped by the program (their share stays in the treasury: audit 4, M4).
  const payees = graph.recipients.map((r) => new PublicKey(r.address));
  const without = payees.length === 0 || !d.due.some((i) => graph.nodes[i]?.action.kind === "distributeSol") ? [] : (await sdk.checkGraphRecipients(conn, payees)).withoutAccount;
  const skipped = payees.map((p) => without.some((w) => w.equals(p)));
  let tipAccountRent: bigint | null = null;
  if (caller !== undefined && caller !== null) {
    const ata = sdk.associatedTokenAddress(caller, sdk.WSOL_MINT, sdk.KNOWN_ACCOUNTS.splToken);
    tipAccountRent = (await conn.getAccountInfo(ata, "confirmed")) === null ? BigInt(await conn.getMinimumBalanceForRentExemption(165)) : 0n;
  }
  const out: DueStep[] = [];
  for (const i of d.due) {
    const st = d.statuses[i];
    const n = graph.nodes[i];
    if (!st || !n) continue;
    const partial = n.action.kind === "buybackBurn" && st.partial;
    const tip = expectedRunTip({
      graph,
      node: i,
      amount: st.amount,
      partial,
      skipped,
      graduated: a.graduated,
      reference: a.refSqrtPrice,
      observations,
      now: Number(d.view.now),
      tipEpochStart: a.tipEpochStart,
      tipsInEpoch: a.tipsInEpoch,
      treasurySol: d.view.treasury.sol,
    });
    const fee = SIGNATURE_FEE_LAMPORTS * (st.operatorOnly ? 2n : 1n);
    out.push({
      node: i,
      what: sdk.explainNode(graph, i, { addresses: "short" }),
      tip,
      costs: tipAccountRent === null ? null : { signatureFeeLamports: fee, priorityFeeLamports: 0n, rentLamports: tipAccountRent, totalLamports: fee + tipAccountRent },
      partial,
      skippedRecipients: n.action.kind === "distributeSol" ? skipped.filter(Boolean).length : 0,
      operatorOnly: st.operatorOnly,
      minAmount: st.minAmount,
      maxAmount: st.maxAmount,
      unit: n.action.kind === "burn" ? "tokens" : "lamports",
    });
  }
  return out;
}

async function autopilotSetupCost(conn: Connection, graphBytes: number): Promise<AutopilotSetupCost> {
  const [account, tokenAccount, graphRecord, authorize] = await Promise.all([
    rent(conn, sdk.autopilotAccountSize()),
    rent(conn, TOKEN_ACCOUNT_BYTES),
    rent(conn, 8 + 1 + 1 + 32 + 32 + 4 + graphBytes),
    sdk.fundingLamportsForAuthorize(conn),
  ]);
  return {
    // The account and its treasury's two token accounts (wSOL and the token, at binding), two transactions.
    init: account + 2n * tokenAccount + 2n * SIGNATURE_FEE,
    publish: graphRecord + SIGNATURE_FEE,
    authorize,
    activate: 2n * SIGNATURE_FEE,
  };
}

export const programmableLive: ProgrammableBackend = {
  available: true,
  walletAuthorize: false,
  fetchLaunchRules,
  fetchRulesRecord: async (conn, launch, hash) => {
    const r = await sdk.fetchLaunchRules(conn, launch, hash);
    return r === null ? null : recordOf(r);
  },
  buildPublishRulesTx: async (conn, payer, launch, bytes) => {
    const r = await sdk.buildPublishRulesTx(conn, payer, { launch, rules: bytes });
    if (r.status === "already-published") throw new Error("These launch rules are already published.");
    return { tx: r.tx, address: r.rules, hash: r.rulesHash };
  },
  rulesRecordRent: (conn, size) => rent(conn, sdk.launchRulesSpace(size)),
  // Attestation v3: the signed message itself carries the rules hash (planLaunch({ rules })); nothing to record here.
  bindRulesToAttestation: () => undefined,
  fetchAutopilot,
  fetchMigrationPrice: async (conn, launch) => {
    const v = await sdk.fetchAutopilotView(conn, launch);
    return v === null || v.autopilot.refSqrtPrice === 0n ? null : v.autopilot.refSqrtPrice;
  },
  fetchGraphBytes: (conn, launch, hash) => sdk.fetchGraphBytes(conn, launch, hash),
  listAutopilotRuns: async () => [],
  findDueSteps,
  fetchAuthorization: async (conn, launch, kind, payloadHash) => {
    const a = await sdk.fetchAuthorization(conn, launch, kind, payloadHash);
    return a === null || !a.authorized ? null : { address: a.publicKey, kind: a.kind, payloadHash: Uint8Array.from(a.payloadHash), unixTime: Number(a.unixTime), slot: Number(a.slot) };
  },
  fetchIdentityLeaves: async (conn, pqId) => {
    const i = await sdk.fetchIdentity(conn, pqId);
    return i === null ? new Uint8Array(sdk.PQ_IDENTITY.LEAF_BITMAP_LEN) : Uint8Array.from(i.used);
  },
  buildInitAutopilotTx: async (conn, payer, launch) => ({ tx: await sdk.buildInitAutopilotTx(conn, payer, launch), address: sdk.autopilotAddress(launch) }),
  buildBindMintTx: async (conn, payer, launch) => {
    const [v, l] = await Promise.all([sdk.fetchAutopilotView(conn, launch), sdk.fetchLaunch(conn, launch)]);
    if (v === null || v.autopilot.mintBound || l === null || l.status !== "live") return null;
    return { tx: await sdk.buildBindMintTx(conn, payer, launch) };
  },
  autopilotSetupCost,
  prepareAuthorizeFromPayer: async (conn, payer, launch, args) => {
    const kind = args.kind as sdk.AuthorizeKind;
    const built = await sdk.buildPqAuthorizeTx(conn, {
      launch,
      creator: args.creator,
      identity: args.identity,
      ledger: args.ledger,
      kind,
      payloadHash: args.payloadHash,
      payer,
      // Freeze payload v2: the SDK refuses to sign an approval that could not land before its last second (or that would
      // stay usable more than 24 hours: audit 4, ID-F5).
      ...(kind === 2 && args.freezeNotAfter !== undefined ? { freezeNotAfter: BigInt(args.freezeNotAfter) } : {}),
      // Audit 4: the browser's cross-tab signing lock, a second RPC for the clock, and a confirmed extra signature.
      ...(args.signingLock === undefined ? {} : { signingLock: args.signingLock }),
      ...(args.secondConnection === undefined ? {} : { secondConnection: args.secondConnection }),
      ...(args.acknowledgeExtraSignatures === true ? { acknowledgeExtraSignatures: true } : {}),
    });
    if (built.status === "already-authorized") return null;
    if (built.status === "leaf-landed") {
      const o = await sdk.confirmAuthorization(conn, launch, kind, args.payloadHash, { ledger: args.ledger });
      if (o.status === "authorized") return null;
      throw new Error(`The quantum signature landed without authorizing (${o.status}).`);
    }
    return {
      tx: built.tx,
      send: async () => {
        const o = await sdk.sendPqAuthorizeTx(conn, built, { ledger: args.ledger });
        if (o.status !== "authorized") throw new Error(`The quantum signature did not authorize the change (${o.status}).`);
        return built.signature;
      },
    };
  },
  signAuthorization: async () => {
    throw new Error("On this network the quantum signature is sent from a temporary account (prepareAuthorizeFromPayer).");
  },
  checkGraphRecipients: (conn, recipients) => sdk.checkGraphRecipients(conn, recipients),
  buildPublishGraphTx: async (conn, payer, launch, bytes) => {
    // The SDK refuses payees that could never receive (audit 4, C1) before anything is built.
    const r = await sdk.buildPublishGraphTx(conn, payer, launch, bytes);
    if (r.status === "already-published") throw new Error("These steps are already published.");
    return { tx: r.tx, hash: r.graphHash, address: r.address };
  },
  // A 2.5 KB quantum signature does not fit a wallet's legacy transaction: the page uses a temporary account instead.
  buildPqAuthorizeTx: async () => {
    throw new Error("On this network the quantum signature is sent from a temporary account (prepareAuthorizeFromPayer).");
  },
  buildActivateGraphTx: async (conn, payer, launch, graphHash, activateAt) => ({ tx: await sdk.buildActivateTx(conn, payer, launch, { graphHash, activateAt: BigInt(activateAt) }) }),
  buildApplyPendingTx: async (conn, payer, launch) => ({ tx: await sdk.buildApplyPendingTx(conn, payer, launch) }),
  buildFreezeGraphTx: async (conn, payer, launch, notAfter) => ({ tx: await sdk.buildFreezeTx(conn, payer, launch, { notAfter: BigInt(notAfter) }) }),
  buildRevokeOperatorTx: async (conn, payer, launch) => ({ tx: await sdk.buildRevokeOperatorTx(conn, payer, launch) }),
  buildRunStepTx: async (conn, caller, launch, node, opts = {}) => {
    // Never creates a recipient's wSOL account (audit 4, M4): only the caller's own, for the tip.
    const r = await sdk.buildRunTx(conn, caller, launch, node, { amount: opts.amount ?? null, operator: opts.operator ?? null });
    return { tx: r.tx, costs: r.costs, skippedRecipients: r.skippedRecipients };
  },
};

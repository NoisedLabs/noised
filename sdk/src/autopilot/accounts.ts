/**
 * The autopilot's accounts (programs/noised-autopilot src/state.rs), read
 * only: decoders for `Autopilot` and `GraphRecord`, their fetchers, the
 * model state the keeper and the simulator use (`autopilotStateOf`), one
 * read of everything a UI or keeper needs (`fetchAutopilotView`) and the
 * keeper's view of what is due (`fetchDueNodes`). Nothing here signs or sends.
 *
 * A graph is fetched only by its hash (the active one, the queued one, or
 * one a creator is about to authorize), at the address its content hashes
 * to; the decoder re-hashes the bytes and verifies them, so a record is
 * exactly the PXG1 program its address names.
 */
import { PublicKey, type Connection } from "@solana/web3.js";

import { bytesEqual, isAllZero } from "../codec/bytes.js";
import { MIGRATION_FEE_TIERS_BPS, PROGRAM_IDS } from "../constants.js";
import { idlCodecs } from "../idl/index.js";
import { fetchLaunch } from "../launch/accounts.js";
import { clusterUnixTime } from "../launch/window.js";
import { decodeDammPool } from "../meteora/state.js";
import { authorizationAddress, autopilotAddress, autopilotPdas, graphRecordAddress } from "../pda.js";
import { activationPayload } from "../programmable/autopilot/logic.js";
import { AUTOPILOT } from "../programmable/constants.js";
import { decompileGraph, type Graph } from "../programmable/graph/model.js";
import { verifyGraph } from "../programmable/graph/codec.js";
import { graphHash as hashGraph } from "../programmable/hash.js";
import { type AutopilotEnv, type AutopilotState, nodeStatuses, type NodeStatus } from "../programmable/graph/runtime.js";
import { getAccounts, ownedBy } from "../rpc/fetch.js";
import { parseTokenAccount } from "../token/mint.js";

/** One node's run state, as stored (`NodeRecord`). */
export interface AutopilotNodeRecord {
  lastRun: bigint;
  lastSeq: bigint;
  epochStart: bigint;
  runsInEpoch: number;
  spentInEpoch: bigint;
}

/** The latest authorization used of one kind (activate, freeze, revoke). */
export interface AutopilotAuthMark {
  slot: bigint;
  key: PublicKey;
}

/** An observation bucket: the lowest and highest pool sqrt price seen in 15 minutes (empty while `min` is 0). */
export interface AutopilotObsBucket {
  index: bigint;
  firstAt: bigint;
  min: bigint;
  max: bigint;
}

/** The `Autopilot` account (version 1, 1,244 bytes since audit round 4) with a few derived fields. */
export interface AutopilotAccount {
  publicKey: PublicKey;
  version: number;
  bump: number;
  treasuryBump: number;
  launch: PublicKey;
  /** The launch's mint once bound (`bind_mint`); the default key before. */
  mint: PublicKey;
  /** The launch's DAMM v2 pool once bound (`bind_pool`); the default key before (not graduated). */
  dammPool: PublicKey;
  /** Hash of the graph that runs (all zero: none). */
  activeGraph: Uint8Array;
  /** A queued graph (all zero: none) and when it may take effect. */
  pendingGraph: Uint8Array;
  pendingActivateAt: bigint;
  pendingOperator: PublicKey;
  activatedAt: bigint;
  frozen: boolean;
  /** The active graph's operator (the default key: none, or revoked). */
  operator: PublicKey;
  authMarks: AutopilotAuthMark[];
  seq: bigint;
  /** The reference sqrt price (Q64.64): the migration price at first. */
  refSqrtPrice: bigint;
  refUpdatedAt: bigint;
  refAllowance: bigint;
  refAllowanceAt: bigint;
  observations: AutopilotObsBucket[];
  tipEpochStart: bigint;
  tipsInEpoch: bigint;
  /** 16 entries, indexed like the active graph's nodes. */
  nodes: AutopilotNodeRecord[];
  /**
   * The launchpad `Authorization` that activated the running graph (audit 4,
   * A4-S; set by `apply_pending`; the default key until a graph is active).
   * With `activeGraph` and `activeActivateAt` it re-verifies the running
   * graph's LMS approval from account state (`activationPayload(autopilot,
   * activeGraph, activeActivateAt)` -> `["auth", launch, [1], payload]` must
   * be this address), and a revocation names it (`revokePayload` v3).
   */
  activeAuth: PublicKey;
  /** The `activate_at` that authorization signed (unix seconds; 0 until a graph is active). */
  activeActivateAt: bigint;
  /**
   * 16 entries, indexed like the nodes: what keepers' partial buybacks moved
   * of each node's open run (audit 4, A4-2). A run moves at most `p1` minus
   * this; a completed run, or a new graph, clears it.
   */
  partialSpent: bigint[];
  // ---- derived ----
  /** `bind_mint` ran. */
  mintBound: boolean;
  /** `bind_pool` ran: the launch graduated. */
  graduated: boolean;
  hasActiveGraph: boolean;
  hasPendingGraph: boolean;
  /** The operator, or null (none or revoked). */
  operatorOrNull: PublicKey | null;
  /** `activeAuth`, or null while no graph was activated (the default key). */
  activeAuthOrNull: PublicKey | null;
}

const isDefault = (k: PublicKey): boolean => k.equals(PublicKey.default);

/**
 * Decodes an `Autopilot` account. Refuses another version, and an account
 * that is not the `["autopilot", launch]` address of the launch it names.
 */
export function decodeAutopilot(publicKey: PublicKey, data: Uint8Array): AutopilotAccount {
  const raw = idlCodecs().autopilot.decodeAccount<
    Omit<AutopilotAccount, "publicKey" | "mintBound" | "graduated" | "hasActiveGraph" | "hasPendingGraph" | "operatorOrNull" | "activeAuthOrNull">
  >("Autopilot", data);
  if (raw.version !== 1) throw new Error(`autopilot account has version ${raw.version}; this SDK reads version 1`);
  if (!autopilotAddress(raw.launch).equals(publicKey)) throw new Error("autopilot account is not the PDA of the launch it names");
  return {
    ...raw,
    publicKey,
    mintBound: !isDefault(raw.mint),
    graduated: !isDefault(raw.dammPool),
    hasActiveGraph: !isAllZero(raw.activeGraph),
    hasPendingGraph: !isAllZero(raw.pendingGraph),
    operatorOrNull: isDefault(raw.operator) ? null : raw.operator,
    activeAuthOrNull: isDefault(raw.activeAuth) ? null : raw.activeAuth,
  };
}

/** A published graph (`GraphRecord`), verified. */
export interface GraphRecordAccount {
  publicKey: PublicKey;
  version: number;
  bump: number;
  launch: PublicKey;
  graphHash: Uint8Array;
  /** The PXG1 bytes (verified: `verifyGraph`). */
  bytes: Uint8Array;
  /** The graph, decompiled (ids n0, n1, ... unless the caller names them). */
  graph: Graph;
}

/**
 * Decodes a `GraphRecord`. Refuses a record whose bytes do not hash to its
 * stored hash, that is not at `["graph", launch, hash]`, or whose bytes do
 * not verify as PXG1 (the program verified them when they were published).
 */
export function decodeGraphRecord(publicKey: PublicKey, data: Uint8Array): GraphRecordAccount {
  const raw = idlCodecs().autopilot.decodeAccount<{ version: number; bump: number; launch: PublicKey; graphHash: Uint8Array; bytes: Uint8Array }>("GraphRecord", data);
  if (raw.version !== 1) throw new Error(`graph record has version ${raw.version}; this SDK reads version 1`);
  if (!bytesEqual(hashGraph(raw.bytes), raw.graphHash)) throw new Error("graph record's bytes do not hash to its stored hash");
  if (!graphRecordAddress(raw.launch, raw.graphHash).equals(publicKey)) throw new Error("graph record is not at the address of its launch and hash");
  const v = verifyGraph(raw.bytes);
  if (!v.ok) throw new Error(`graph record's bytes do not verify as PXG1 (${v.code})`);
  return { ...raw, publicKey, graph: decompileGraph(raw.bytes) };
}

/**
 * The model state of an autopilot (what `nodeStatus`, `findDueNodes` and
 * `planRun` read): node states for the active graph's `nodeCount` nodes
 * (default 16), the reference, its allowance and observations, the tip
 * counters, the stored operator and what partial buybacks moved of each
 * node's open run (`partialSpent`). Unix times become numbers.
 */
export function autopilotStateOf(a: AutopilotAccount, nodeCount = 16): AutopilotState {
  const n = (v: bigint): number => Number(v);
  return {
    nodes: a.nodes.slice(0, nodeCount).map((r) => ({ lastRun: n(r.lastRun), lastSeq: n(r.lastSeq), epochStart: n(r.epochStart), runsInEpoch: r.runsInEpoch, spentInEpoch: r.spentInEpoch })),
    seq: n(a.seq),
    refSqrtPriceQ64: a.refSqrtPrice,
    tipsInEpoch: a.tipsInEpoch,
    tipEpochStart: n(a.tipEpochStart),
    observations: a.observations.map((b) => ({ index: n(b.index), firstAt: n(b.firstAt), min: b.min, max: b.max })),
    refAllowance: a.refAllowance,
    refAllowanceAt: n(a.refAllowanceAt),
    refUpdatedAt: n(a.refUpdatedAt),
    operator: a.operatorOrNull === null ? null : a.operatorOrNull.toBase58(),
    partialSpent: a.partialSpent.slice(0, nodeCount),
  };
}

/** The launch's autopilot, or null if `init_autopilot` has not run. */
export async function fetchAutopilot(conn: Connection, launch: PublicKey): Promise<AutopilotAccount | null> {
  const address = autopilotAddress(launch);
  const [acc] = await getAccounts(conn, [address]);
  const owned = ownedBy(acc ?? null, PROGRAM_IDS.autopilot, "Autopilot");
  if (owned === null) return null;
  const a = decodeAutopilot(address, owned.data);
  if (!a.launch.equals(launch)) throw new Error("autopilot account belongs to another launch");
  return a;
}

/** The graph published for `launch` with this hash, or null if nobody published it. */
export async function fetchGraph(conn: Connection, launch: PublicKey, graphHash: Uint8Array): Promise<GraphRecordAccount | null> {
  const address = graphRecordAddress(launch, graphHash);
  const [acc] = await getAccounts(conn, [address]);
  const owned = ownedBy(acc ?? null, PROGRAM_IDS.autopilot, "GraphRecord");
  if (owned === null) return null;
  const g = decodeGraphRecord(address, owned.data);
  if (!g.launch.equals(launch) || !bytesEqual(g.graphHash, graphHash)) throw new Error("graph record belongs to another launch or hash");
  return g;
}

/** Just the bytes of `fetchGraph` (what `explainGraph` / `decompileGraph` take), or null. */
export async function fetchGraphBytes(conn: Connection, launch: PublicKey, graphHash: Uint8Array): Promise<Uint8Array | null> {
  return (await fetchGraph(conn, launch, graphHash))?.bytes ?? null;
}

/** Everything about a launch's autopilot in one read. */
export interface AutopilotView {
  autopilot: AutopilotAccount;
  /** The active graph (null: none yet). */
  active: GraphRecordAccount | null;
  /** The queued graph and when it takes effect (null: none). */
  pending: (GraphRecordAccount & { activateAt: bigint; operator: PublicKey | null }) | null;
  treasury: { address: PublicKey; wsol: PublicKey; token: PublicKey | null; sol: bigint; tokens: bigint };
  /** The bound pool (null before graduation): its sqrt price and SOL (wSOL vault). */
  pool: { address: PublicKey; sqrtPrice: bigint; sol: bigint; tokenAVault: PublicKey; tokenBVault: PublicKey } | null;
  /** The cluster clock when read (unix seconds). */
  now: bigint;
}

function tokenAmount(acc: { owner: PublicKey; data: Uint8Array } | null | undefined): bigint {
  if (acc === null || acc === undefined || acc.data.length === 0) return 0n;
  return parseTokenAccount(acc.owner, acc.data).amount;
}

/**
 * One read of a launch's autopilot: the account, the active and queued
 * graphs (verified), the treasury's balances, the pool and the cluster
 * clock. Null if the launch has no autopilot.
 */
export async function fetchAutopilotView(conn: Connection, launch: PublicKey): Promise<AutopilotView | null> {
  const autopilot = await fetchAutopilot(conn, launch);
  if (autopilot === null) return null;
  const pdas = autopilotPdas(launch, autopilot.mintBound ? autopilot.mint : null);
  const zero = new PublicKey(new Uint8Array(32));
  const addresses = [
    pdas.treasuryWsol,
    pdas.treasuryToken ?? zero,
    autopilot.graduated ? autopilot.dammPool : zero,
    autopilot.hasActiveGraph ? graphRecordAddress(launch, autopilot.activeGraph) : zero,
    autopilot.hasPendingGraph ? graphRecordAddress(launch, autopilot.pendingGraph) : zero,
  ];
  const [wsol, token, poolAcc, activeAcc, pendingAcc] = await getAccounts(conn, addresses);
  const record = (acc: typeof activeAcc, i: number, hash: Uint8Array): GraphRecordAccount | null => {
    const owned = ownedBy(acc ?? null, PROGRAM_IDS.autopilot, "GraphRecord");
    if (owned === null) return null;
    const g = decodeGraphRecord(addresses[i]!, owned.data);
    if (!bytesEqual(g.graphHash, hash)) throw new Error("graph record holds another hash");
    return g;
  };
  const active = autopilot.hasActiveGraph ? record(activeAcc, 3, autopilot.activeGraph) : null;
  const pendingRec = autopilot.hasPendingGraph ? record(pendingAcc, 4, autopilot.pendingGraph) : null;
  let pool: AutopilotView["pool"] = null;
  if (autopilot.graduated) {
    const owned = ownedBy(poolAcc ?? null, PROGRAM_IDS.dammV2, "DAMM v2 pool");
    if (owned === null) throw new Error("the autopilot's pool account is missing");
    const p = decodeDammPool(owned.data);
    const [vaultB] = await getAccounts(conn, [p.tokenBVault]);
    pool = { address: autopilot.dammPool, sqrtPrice: p.sqrtPrice, sol: tokenAmount(vaultB), tokenAVault: p.tokenAVault, tokenBVault: p.tokenBVault };
  }
  return {
    autopilot,
    active,
    pending:
      pendingRec === null
        ? null
        : { ...pendingRec, activateAt: autopilot.pendingActivateAt, operator: isDefault(autopilot.pendingOperator) ? null : autopilot.pendingOperator },
    treasury: { address: pdas.treasury, wsol: pdas.treasuryWsol, token: pdas.treasuryToken, sol: tokenAmount(wsol), tokens: tokenAmount(token) },
    pool,
    now: await clusterUnixTime(conn),
  };
}

/** `fetchDueNodes` options. */
export interface FetchDueNodesOptions {
  /**
   * The pool's trading fee in bps (default: `MIGRATION_FEE_TIERS_BPS[launch.migrationFeeOption]`, the pool's base
   * fee; pass the current fee if the pool charges a dynamic fee on top).
   */
  poolFeeBps?: number;
  /** Evaluate at this unix time instead of the cluster clock (e.g. a minute after an `update_price`). */
  now?: number;
}

/** What a keeper reads before running anything. */
export interface DueNodes {
  view: AutopilotView;
  /** The active graph (decompiled), or null. */
  graph: Graph | null;
  state: AutopilotState | null;
  env: AutopilotEnv | null;
  /** Every node's status (empty without an active graph). */
  statuses: NodeStatus[];
  /** Indices of the nodes that can run now (`statuses[i].due`; check `operatorOnly`). */
  due: number[];
  /** A queued graph is due: `apply_pending` must run first (every run fails with PendingUpdateDue until then). */
  applyPendingFirst: boolean;
}

/**
 * The keeper's view: every node's status on live state, decided by the
 * program's own logic (`nodeStatus`), with the pool's fee and depth so a
 * buyback is due only if its swap can fill (estimate), and the amount to
 * pass (`statuses[i].amount`). Read-only; build the run with `buildRunTx`.
 * Run `update_price` first when a buyback reports `notObserved`.
 */
export async function fetchDueNodes(conn: Connection, launch: PublicKey, opts: FetchDueNodesOptions = {}): Promise<DueNodes | null> {
  const view = await fetchAutopilotView(conn, launch);
  if (view === null) return null;
  const now = opts.now ?? Number(view.now);
  const applyPendingFirst = view.pending !== null && BigInt(now) >= view.pending.activateAt;
  if (view.active === null || !view.autopilot.mintBound) return { view, graph: null, state: null, env: null, statuses: [], due: [], applyPendingFirst };
  let fee = opts.poolFeeBps;
  if (fee === undefined) {
    const l = await fetchLaunch(conn, launch);
    fee = l === null ? undefined : MIGRATION_FEE_TIERS_BPS[l.migrationFeeOption];
  }
  const graph = view.active.graph;
  const state = autopilotStateOf(view.autopilot, graph.nodes.length);
  const env: AutopilotEnv = {
    now,
    treasurySol: view.treasury.sol,
    treasuryTokens: view.treasury.tokens,
    graduated: view.autopilot.graduated,
    spotSqrtPriceQ64: view.pool?.sqrtPrice ?? 0n,
  };
  if (view.pool !== null) env.poolSol = view.pool.sol;
  if (fee !== undefined) env.poolFeeBps = fee;
  const statuses = applyPendingFirst ? [] : nodeStatuses(graph, state, env);
  return { view, graph, state, env, statuses, due: statuses.flatMap((s, i) => (s.due ? [i] : [])), applyPendingFirst };
}

/** The autopilot's `NodeRan` event (one per successful `run`), decoded; audit round 4 appended `partial`, `skipped` and `kept`. */
export interface NodeRanEvent {
  readonly name: "NodeRan";
  readonly autopilot: PublicKey;
  readonly node: number;
  readonly action: number;
  readonly seq: bigint;
  /** What the run counted against the node's budget: lamports swapped (BUYBACK_BURN), due to the recipients (DISTRIBUTE_SOL: paid plus `kept`), tokens burned (BURN). */
  readonly spent: bigint;
  readonly bought: bigint;
  readonly burned: bigint;
  readonly tip: bigint;
  readonly caller: PublicKey;
  readonly spotSqrtPrice: bigint;
  readonly refSqrtPrice: bigint;
  /** A keeper's partial buyback (audit 4, A4-2): it spent from the budget, but the node's run stays open (no `last_run`, not counted as a run). */
  readonly partial: boolean;
  /** DISTRIBUTE_SOL: bit `i` set when recipient `i` had no wSOL account (audit 4, M4): its share was not paid. */
  readonly skipped: number;
  /** Lamports of those shares, which stayed in the treasury. */
  readonly kept: bigint;
  /** Derived: lamports actually paid (`spent - kept` for a distribution; `spent` otherwise). */
  readonly paid: bigint;
  /** Derived: the indices of the skipped recipients (graph order). */
  readonly skippedRecipients: number[];
}

/** Any other autopilot event, decoded by its IDL definition (field names in camelCase). */
export interface OtherAutopilotEvent {
  readonly name: "AutopilotInitialized" | "GraphActivated" | "GraphFrozen" | "GraphPublished" | "GraphQueued" | "MintBound" | "OperatorRevoked" | "PoolBound" | "ReferencePriceUpdated";
  readonly [field: string]: unknown;
}

export type AutopilotEvent = NodeRanEvent | OtherAutopilotEvent;

/**
 * Decode an autopilot event from `discriminator || payload` (the "Program
 * data:" log bytes, IDL-driven); null for any other bytes. `NodeRan` carries
 * the audit-4 fields (`partial`, `skipped`, `kept`) and the derived `paid`
 * and `skippedRecipients`.
 */
export function decodeAutopilotEvent(data: Uint8Array): AutopilotEvent | null {
  const codec = idlCodecs().autopilot;
  for (const ev of codec.idl.events ?? []) {
    const disc = Uint8Array.from(ev.discriminator);
    if (data.length <= disc.length || !bytesEqual(data.subarray(0, disc.length), disc)) continue;
    const fields = codec.decodeType<Record<string, unknown>>(ev.name, data.subarray(disc.length));
    if (ev.name !== "NodeRan") return { name: ev.name, ...fields } as OtherAutopilotEvent;
    const r = fields as unknown as Omit<NodeRanEvent, "name" | "paid" | "skippedRecipients">;
    const skippedRecipients: number[] = [];
    for (let i = 0; i < 8; i++) if ((r.skipped & (1 << i)) !== 0) skippedRecipients.push(i);
    const paid = r.action === 3 ? (r.spent > r.kept ? r.spent - r.kept : 0n) : r.spent;
    return { name: "NodeRan", ...r, paid, skippedRecipients };
  }
  return null;
}

/**
 * Whether the account's `active_auth` is the authorization of the running
 * graph's activation at `active_activate_at` (audit 4, A4-S): its address
 * must be `["auth", launch, [1], activationPayload(autopilot, activeGraph,
 * activeActivateAt)]`. Null when no graph runs or no activation is recorded;
 * otherwise the payload and whether the address matches (verify the
 * authorization itself with `verifyAuthorization`).
 */
export function activeActivation(a: AutopilotAccount): { payloadHash: Uint8Array; authorization: PublicKey; matches: boolean } | null {
  if (!a.hasActiveGraph || a.activeAuthOrNull === null) return null;
  const payloadHash = activationPayload(a.publicKey, a.activeGraph, a.activeActivateAt);
  const authorization = authorizationAddress(a.launch, 1, payloadHash);
  return { payloadHash, authorization, matches: authorization.equals(a.activeAuth) };
}

/** The autopilot account's size (1,244 bytes since audit round 4), from the IDL. */
export function autopilotAccountSize(): number {
  const n = idlCodecs().autopilot.accountSize("Autopilot");
  if (n !== AUTOPILOT.ACCOUNT_LEN) throw new Error(`the autopilot IDL gives ${n} bytes, the program ${AUTOPILOT.ACCOUNT_LEN}`);
  return n;
}

/**
 * Autopilot transaction builders (programs/noised-autopilot), for the
 * instructions that need nothing from the launchpad beyond what is deployed:
 * `init_autopilot`, `bind_mint`, `bind_pool`, `publish_graph`,
 * `apply_pending`, `update_price` and `run`. `activate`, `freeze` and
 * `revoke_operator` need the launchpad's `pq_authorize` (an `Authorization`
 * account, `../pq/authorize.ts`) and are built in `./governance.ts`.
 *
 * Account order and flags come from the autopilot's IDL. Builders return
 * unsigned legacy `Transaction`s with a measured, tight
 * `SetComputeUnitLimit` (`AUTOPILOT_COMPUTE_UNITS`; LiteSVM measurements of
 * the program with a margin) and, with `computeUnitPrice`, a priority fee.
 * Every builder re-reads the accounts and refuses what the program would
 * refuse deterministically, with the program's error name in the message.
 * A graph too large for a legacy transaction is published as a v1
 * transaction (`buildPublishGraphV1Tx`, signed by a keypair).
 */
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { PublicKey, Transaction, type AccountMeta, type Connection, type Keypair, type TransactionInstruction } from "@solana/web3.js";

import { encodeBase58 } from "../codec/base58.js";
import { buildInstruction } from "../codec/ix.js";
import { DAMM_V2_MIGRATION_CONFIGS, KNOWN_ACCOUNTS, PROGRAM_IDS, WSOL_MINT } from "../constants.js";
import { idlCodecs } from "../idl/index.js";
import { fetchLaunch } from "../launch/accounts.js";
import { checkGraphRecipients } from "../launch/recipients.js";
import { autopilotPdas, certificateAddress, dammV2PoolAddress, graphRecordAddress, wsolAta } from "../pda.js";
import { ACTION } from "../programmable/constants.js";
import { verifyGraph, verifyGraphBytes } from "../programmable/graph/codec.js";
import { graphHash } from "../programmable/hash.js";
import { computeBudgetInstructions, computeUnitLimitOf, computeUnitPriceOf, priorityFeeLamports, type ComputeBudgetOptions } from "../rpc/computeBudget.js";
import { getAccounts, ownedBy } from "../rpc/fetch.js";
import { LAMPORTS_PER_SIGNATURE, rentExemptLamports } from "../rpc/index.js";
import { parseTokenAccount, TOKEN_ACCOUNT_SIZE } from "../token/mint.js";
import { compileV1Message, signV1Message, V1_MAX_TRANSACTION_SIZE } from "../tx/v1.js";
import type { LaunchAccount } from "../types.js";
import { decodeGraphRecord, fetchAutopilot, fetchAutopilotView, type AutopilotAccount, type GraphRecordAccount } from "./accounts.js";

/**
 * Compute-unit limits per instruction, from the program's LiteSVM runs
 * (programs/noised-autopilot/tests/litesvm, `transaction_sizes_and_compute_at_the_limits`)
 * with a margin: init_autopilot 41.8k (it creates the treasury's wSOL
 * account), bind_mint 22.4k, bind_pool 12.2k, publish_graph 12.3k (92
 * bytes) to 18.6k (2,044 bytes), apply_pending 12.3k, update_price 11.8k,
 * run: a burn 37.6k-39.5k, a distribution 49.4k (2 recipients) to 83.9k
 * (8), a buyback 62.7k-66.0k (a DAMM v2 swap and a burn), and the
 * governance instructions (P1c, `./governance.ts`): activate 15.2k (it reads
 * the graph record), freeze 12.6k, revoke_operator 12.5k. Re-measured after
 * audit round 4 (same state, A/B; LiteSVM compute log kept by the maintainers):
 * update_price 11,934, run BUYBACK_BURN 64,345 (a keeper's partial one
 * 64,543), run BURN 37,707, run DISTRIBUTE_SOL to 8 recipients 76,149,
 * revoke_operator 13,595, activate 16,199, apply_pending 13,317, freeze
 * 13,824, init_autopilot 39,802: every limit below keeps its margin. Each
 * idempotent token-account creation in the same transaction (only the
 * caller's own tip account, since audit 4) adds `createAccount`.
 */
export const AUTOPILOT_COMPUTE_UNITS = {
  initAutopilot: 80_000,
  bindMint: 60_000,
  bindPool: 30_000,
  publishGraph: 40_000,
  applyPending: 30_000,
  updatePrice: 30_000,
  runBurn: 80_000,
  runDistribute: 140_000,
  runBuyback: 150_000,
  createAccount: 30_000,
  activate: 40_000,
  freeze: 30_000,
  revokeOperator: 30_000,
} as const;

/** Legacy transaction size limit (bytes). */
const LEGACY_LIMIT = 1_232;

const codec = (): ReturnType<typeof idlCodecs>["autopilot"] => idlCodecs().autopilot;

async function finish(conn: Connection, feePayer: PublicKey, ixs: TransactionInstruction[], units: number, opts: ComputeBudgetOptions): Promise<Transaction> {
  const tx = new Transaction();
  tx.add(...computeBudgetInstructions(opts, units));
  tx.add(...ixs);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.feePayer = feePayer;
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  const size = legacySize(tx);
  if (size > LEGACY_LIMIT) throw new Error(`the transaction would be ${size} bytes, over the ${LEGACY_LIMIT}-byte legacy limit`);
  return tx;
}

/** Wire size of a legacy transaction once every required signer has signed. */
export function legacySize(tx: Transaction): number {
  const message = tx.compileMessage();
  return 1 + 64 * message.header.numRequiredSignatures + message.serialize().length;
}

const refuse = (error: string, why: string): Error => new Error(`refusing to build: ${why} (the program would fail with ${error})`);

async function launchOf(conn: Connection, launch: PublicKey): Promise<LaunchAccount> {
  const l = await fetchLaunch(conn, launch);
  if (l === null) throw refuse("NotALaunch", `launch ${launch.toBase58()} does not exist`);
  return l;
}

async function autopilotOf(conn: Connection, launch: PublicKey): Promise<AutopilotAccount> {
  const a = await fetchAutopilot(conn, launch);
  if (a === null) throw refuse("AccountNotInitialized", "this launch has no autopilot yet (buildInitAutopilotTx)");
  return a;
}

// ------------------------------------------------------------ setup ---

/**
 * `init_autopilot` (anyone, once per launch, configured or live): creates
 * the autopilot (its reference price starts at the launch's migration price,
 * read from its DBC config) and the treasury's wSOL account. `payer` pays
 * both rents.
 */
export async function buildInitAutopilotTx(conn: Connection, payer: PublicKey, launch: PublicKey, opts: ComputeBudgetOptions = {}): Promise<Transaction> {
  const l = await launchOf(conn, launch);
  if ((await fetchAutopilot(conn, launch)) !== null) throw refuse("already in use", "the launch already has an autopilot");
  const p = autopilotPdas(launch);
  const ix = buildInstruction(codec(), PROGRAM_IDS.autopilot, "init_autopilot", {
    payer,
    launch,
    dbcConfig: l.dbcConfig,
    autopilot: p.autopilot,
    treasury: p.treasury,
    wsolMint: WSOL_MINT,
    treasuryWsol: p.treasuryWsol,
  });
  return finish(conn, payer, [ix], AUTOPILOT_COMPUTE_UNITS.initAutopilot, opts);
}

/**
 * `bind_mint` (anyone, once, after the launch went live): binds the
 * autopilot to the launch's certified mint and creates the treasury's token
 * account (`payer` pays its rent).
 */
export async function buildBindMintTx(conn: Connection, payer: PublicKey, launch: PublicKey, opts: ComputeBudgetOptions = {}): Promise<Transaction> {
  const l = await launchOf(conn, launch);
  if (l.status !== "live") throw refuse("LaunchNotLive", "the launch is not live yet");
  const a = await autopilotOf(conn, launch);
  if (a.mintBound) throw refuse("MintAlreadyBound", "the autopilot's mint is already bound");
  const p = autopilotPdas(launch, l.baseMint);
  const ix = buildInstruction(codec(), PROGRAM_IDS.autopilot, "bind_mint", {
    payer,
    autopilot: p.autopilot,
    launch,
    certificate: certificateAddress(l.baseMint),
    mint: l.baseMint,
    treasury: p.treasury,
    treasuryToken: p.treasuryToken,
  });
  return finish(conn, payer, [ix], AUTOPILOT_COMPUTE_UNITS.bindMint, opts);
}

/** `buildBindPoolTx` options. */
export interface BindPoolOptions extends ComputeBudgetOptions {
  /** The DAMM v2 config DBC migrated through (default: the canonical one of the launch's migration fee option). */
  dammConfig?: PublicKey;
}

/**
 * `bind_pool` (anyone, once, after DBC migrated the curve): binds the
 * autopilot to the DAMM v2 pool DBC created. From then on the launch counts
 * as graduated and buybacks can run.
 */
export async function buildBindPoolTx(conn: Connection, payer: PublicKey, launch: PublicKey, opts: BindPoolOptions = {}): Promise<Transaction> {
  const a = await autopilotOf(conn, launch);
  if (!a.mintBound) throw refuse("MintNotBound", "bind the mint first (buildBindMintTx)");
  if (a.graduated) throw refuse("PoolAlreadyBound", "the autopilot's pool is already bound");
  let config = opts.dammConfig;
  if (config === undefined) {
    const l = await launchOf(conn, launch);
    config = DAMM_V2_MIGRATION_CONFIGS[l.migrationFeeOption];
    if (config === undefined) throw new Error(`no canonical DAMM v2 config for migration fee option ${l.migrationFeeOption}: pass dammConfig`);
  }
  const pool = dammV2PoolAddress(config, a.mint, WSOL_MINT);
  const [poolAcc] = await getAccounts(conn, [pool]);
  if (poolAcc === null || poolAcc === undefined || !poolAcc.owner.equals(PROGRAM_IDS.dammV2)) {
    throw refuse("NotGraduated", "the launch has not migrated to its DAMM v2 pool yet");
  }
  const ix = buildInstruction(codec(), PROGRAM_IDS.autopilot, "bind_pool", { autopilot: a.publicKey, dammConfig: config, dammPool: pool });
  return finish(conn, payer, [ix], AUTOPILOT_COMPUTE_UNITS.bindPool, opts);
}

// ------------------------------------------------------------ graphs ---

/** `publish_graph(bytes)`: the instruction alone (pure). The record is `["graph", launch, graphHash(bytes)]`. */
export function publishGraphInstruction(payer: PublicKey, launch: PublicKey, bytes: Uint8Array): TransactionInstruction {
  return buildInstruction(codec(), PROGRAM_IDS.autopilot, "publish_graph", { payer, launch, graph: graphRecordAddress(launch, graphHash(bytes)) }, { bytes });
}

/**
 * The size of a legacy `publish_graph` transaction of a graph of `len`
 * bytes, with both compute-budget instructions (limit and price; 12 bytes
 * less without a priority fee).
 */
export function publishGraphLegacySize(len: number, opts: { priorityFee?: boolean } = {}): number {
  const key = (b: number): PublicKey => new PublicKey(new Uint8Array(32).fill(b));
  const tx = new Transaction();
  tx.add(...computeBudgetInstructions(opts.priorityFee === false ? {} : { computeUnitPrice: 1n }, AUTOPILOT_COMPUTE_UNITS.publishGraph));
  tx.add(publishGraphInstruction(key(1), key(2), new Uint8Array(len)));
  tx.feePayer = key(1);
  tx.recentBlockhash = encodeBase58(new Uint8Array(32));
  return legacySize(tx);
}

/**
 * The largest graph (bytes) a legacy `publish_graph` transaction carries
 * (with both compute-budget instructions: `publishGraphLegacySize(len)` is
 * 1,232 bytes or less); larger ones go in a v1 transaction
 * (`buildPublishGraphV1Tx`).
 */
export const PUBLISH_GRAPH_LEGACY_MAX_BYTES = 898;

/** The graph is already published (by anyone): nothing to send. */
export interface PublishGraphAlreadyPublished {
  status: "already-published";
  record: GraphRecordAccount;
  graphHash: Uint8Array;
  address: PublicKey;
  /** Cautions about the graph's payees (`checkGraphRecipients`). */
  warnings: string[];
}

/** A legacy publish transaction to sign and send. */
export interface PublishGraphReady {
  status: "ready";
  tx: Transaction;
  graphHash: Uint8Array;
  address: PublicKey;
  sizeBytes: number;
  /** Cautions about the graph's payees (`checkGraphRecipients`): another program's account, or a payee without a wSOL account yet. */
  warnings: string[];
}

async function publishCommon(
  conn: Connection,
  launch: PublicKey,
  bytes: Uint8Array,
): Promise<{ hash: Uint8Array; address: PublicKey; existing: GraphRecordAccount | null; warnings: string[] }> {
  const v = verifyGraph(bytes);
  if (!v.ok) throw refuse("InvalidGraph", `the graph does not verify as PXG1 (${v.code}: ${v.message})`);
  await launchOf(conn, launch);
  // Audit 4, C1: the graph's payees, checked like fee recipients (a PQ vault of another mint would lose its share forever).
  const payees = await checkGraphRecipients(conn, verifyGraphBytes(bytes).recipients.map((r) => new PublicKey(r.key)));
  if (!payees.ok) throw new Error(`refusing to publish this graph: a payee could never receive its share:\n${payees.refusals.join("\n")}`);
  const hash = graphHash(bytes);
  const address = graphRecordAddress(launch, hash);
  const [acc] = await getAccounts(conn, [address]);
  const owned = ownedBy(acc ?? null, PROGRAM_IDS.autopilot, "GraphRecord");
  return { hash, address, existing: owned === null ? null : decodeGraphRecord(address, owned.data), warnings: payees.warnings };
}

/**
 * `publish_graph` (anyone, idempotent) as a legacy transaction from
 * `payer` (it pays the record's rent): verifies the graph first (the
 * program's own checks) and its payees like fee recipients (audit 4, C1:
 * `checkGraphRecipients`; a payee that could never receive its share is
 * refused, cautions are in `warnings`), and reports a graph already
 * published at its address. Refuses a graph above
 * `PUBLISH_GRAPH_LEGACY_MAX_BYTES`: publish it with `buildPublishGraphV1Tx`.
 */
export async function buildPublishGraphTx(conn: Connection, payer: PublicKey, launch: PublicKey, bytes: Uint8Array, opts: ComputeBudgetOptions = {}): Promise<PublishGraphReady | PublishGraphAlreadyPublished> {
  const c = await publishCommon(conn, launch, bytes);
  if (c.existing !== null) return { status: "already-published", record: c.existing, graphHash: c.hash, address: c.address, warnings: c.warnings };
  if (bytes.length > PUBLISH_GRAPH_LEGACY_MAX_BYTES) {
    throw new Error(`a ${bytes.length}-byte graph does not fit a legacy transaction (at most ${PUBLISH_GRAPH_LEGACY_MAX_BYTES} bytes): publish it with buildPublishGraphV1Tx`);
  }
  const tx = await finish(conn, payer, [publishGraphInstruction(payer, launch, bytes)], AUTOPILOT_COMPUTE_UNITS.publishGraph, opts);
  return { status: "ready", tx, graphHash: c.hash, address: c.address, sizeBytes: legacySize(tx), warnings: c.warnings };
}

/** A signed v1 publish transaction (any graph, up to 2,044 bytes: at most 2,338 bytes on the wire, 2,346 with a priority fee). */
export interface PublishGraphV1Ready {
  status: "ready";
  /** Signed v1 wire bytes (`sendRawTransaction`). */
  tx: Uint8Array;
  signature: string;
  graphHash: Uint8Array;
  address: PublicKey;
  sizeBytes: number;
  blockhash: string;
  lastValidBlockHeight: number;
  /** Cautions about the graph's payees (`checkGraphRecipients`). */
  warnings: string[];
}

/** v1 loaded-accounts-data limit of a publish (the autopilot program and the system program, with margin). */
export const PUBLISH_GRAPH_LOADED_ACCOUNTS_BYTES = 2 * 1024 * 1024;

/**
 * `publish_graph` as a v1 transaction (SIMD-0385, 4,096 bytes), signed by
 * `payer` (a keypair: a throwaway fee payer, as for the token metadata).
 * Any verified graph fits (the largest, 2,044 bytes, makes a 2,338-byte
 * transaction). Its payees are checked like `buildPublishGraphTx`'s.
 */
export async function buildPublishGraphV1Tx(conn: Connection, payer: Keypair, launch: PublicKey, bytes: Uint8Array, opts: ComputeBudgetOptions = {}): Promise<PublishGraphV1Ready | PublishGraphAlreadyPublished> {
  const c = await publishCommon(conn, launch, bytes);
  if (c.existing !== null) return { status: "already-published", record: c.existing, graphHash: c.hash, address: c.address, warnings: c.warnings };
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const signed = signPublishV1(payer, launch, bytes, blockhash, opts);
  return { status: "ready", ...signed, graphHash: c.hash, address: c.address, blockhash, lastValidBlockHeight, warnings: c.warnings };
}

function signPublishV1(payer: Keypair, launch: PublicKey, bytes: Uint8Array, blockhash: string, opts: ComputeBudgetOptions): { tx: Uint8Array; signature: string; sizeBytes: number } {
  const limit = computeUnitLimitOf(opts, AUTOPILOT_COMPUTE_UNITS.publishGraph);
  const price = computeUnitPriceOf(opts);
  const message = compileV1Message(payer.publicKey, [publishGraphInstruction(payer.publicKey, launch, bytes)], blockhash, {
    computeUnitLimit: limit,
    loadedAccountsDataSizeLimit: PUBLISH_GRAPH_LOADED_ACCOUNTS_BYTES,
    ...(price === null || price === 0n ? {} : { priorityFeeLamports: priorityFeeLamports(price, limit) }),
  });
  const tx = signV1Message(message, [payer]);
  if (tx.length > V1_MAX_TRANSACTION_SIZE) throw new Error(`the publish transaction would be ${tx.length} bytes (limit ${V1_MAX_TRANSACTION_SIZE})`);
  return { tx, signature: encodeBase58(tx.subarray(message.bytes.length, message.bytes.length + 64)), sizeBytes: tx.length };
}

/** The exact v1 publish size of a graph of `len` bytes (no network; a priority fee adds 8). */
export function publishGraphV1Size(len: number, opts: { priorityFee?: boolean } = {}): number {
  const payer = new PublicKey(new Uint8Array(32).fill(7));
  const message = compileV1Message(payer, [publishGraphInstruction(payer, new PublicKey(new Uint8Array(32).fill(2)), new Uint8Array(len))], encodeBase58(new Uint8Array(32)), {
    computeUnitLimit: AUTOPILOT_COMPUTE_UNITS.publishGraph,
    loadedAccountsDataSizeLimit: PUBLISH_GRAPH_LOADED_ACCOUNTS_BYTES,
    ...(opts.priorityFee === true ? { priorityFeeLamports: 1n } : {}),
  });
  return message.bytes.length + 64 * message.header.numRequiredSignatures;
}

/**
 * `apply_pending` (anyone, at or after the queued graph's time): the queued
 * graph becomes the active one, with fresh node states.
 */
export async function buildApplyPendingTx(conn: Connection, payer: PublicKey, launch: PublicKey, opts: ComputeBudgetOptions = {}): Promise<Transaction> {
  const a = await autopilotOf(conn, launch);
  if (a.frozen) throw refuse("Frozen", "the graph is frozen forever");
  if (!a.hasPendingGraph) throw refuse("NoPendingUpdate", "no graph is queued");
  const ix = buildInstruction(codec(), PROGRAM_IDS.autopilot, "apply_pending", { autopilot: a.publicKey, graph: graphRecordAddress(launch, a.pendingGraph) });
  return finish(conn, payer, [ix], AUTOPILOT_COMPUTE_UNITS.applyPending, opts);
}

// ------------------------------------------------------------ keepers ---

/**
 * `update_price` (anyone, any time after graduation, free): observes the
 * pool's price and moves the reference toward what the last 15 to 30
 * minutes of observations agree on. A buyback needs observations spanning a
 * minute: send this, wait a minute, then run.
 */
export async function buildUpdatePriceTx(conn: Connection, payer: PublicKey, launch: PublicKey, opts: ComputeBudgetOptions = {}): Promise<Transaction> {
  const a = await autopilotOf(conn, launch);
  if (!a.graduated) throw refuse("NotGraduated", "the launch has not graduated (bind_pool first)");
  const ix = buildInstruction(codec(), PROGRAM_IDS.autopilot, "update_price", { autopilot: a.publicKey, dammPool: a.dammPool });
  return finish(conn, payer, [ix], AUTOPILOT_COMPUTE_UNITS.updatePrice, opts);
}

/** `buildRunTx` options. */
export interface RunTxOptions extends ComputeBudgetOptions {
  /**
   * The amount to run with (lamports, or raw tokens for a burn). Required on
   * an operator-gated node (the operator chooses, 1 to the node's most);
   * on a keeper buyback, an amount below the most (at least 1% of the pool's
   * SOL) when the full amount would not fill; refused anywhere else.
   */
  amount?: bigint | null;
  /** The operator, who must sign: required for operator-gated nodes. */
  operator?: PublicKey | null;
  /** The wSOL account that receives the tip (default: the caller's own wSOL ATA, created by the caller if missing). */
  tipAccount?: PublicKey;
}

/** What a run transaction costs its caller (lamports), before the tip it earns. */
export interface RunCosts {
  /** The signature fee: 5,000 lamports per signer (the caller, and the operator on an operator-only step). */
  signatureFeeLamports: bigint;
  /** The priority fee (`computeUnitPrice` x the compute limit), 0 without one. */
  priorityFeeLamports: bigint;
  /**
   * Rent of the accounts the transaction creates: only the caller's own wSOL
   * account for the tip (2,039,280 lamports, the caller's to reclaim by
   * closing it). Never a recipient's (audit 4, M4).
   */
  rentLamports: bigint;
  /** The sum. */
  totalLamports: bigint;
}

/** A run transaction and what it does. */
export interface RunTx {
  tx: Transaction;
  node: number;
  action: "buybackBurn" | "burn" | "distributeSol";
  operatorGated: boolean;
  /** Token accounts the transaction creates first (idempotent): only the caller's own tip account, when missing. */
  creates: PublicKey[];
  /**
   * A distribution: the recipients (owners, graph order) that have no wSOL
   * account at their canonical address (or one that cannot receive: not a
   * wSOL account of that owner, or frozen). The program skips them and their
   * share stays in the treasury (audit 4, M4); nobody pays to create their
   * accounts. Empty for other actions.
   */
  skippedRecipients: PublicKey[];
  /** What the transaction costs the caller (fees and rent), before its tip. */
  costs: RunCosts;
  sizeBytes: number;
}

/**
 * `run(node, amount)`: runs one node of the active graph (anyone; the
 * operator, signing, for operator-gated nodes) and tips the caller. Checks
 * first what the program would refuse whatever the market does: no active
 * graph or mint, a queued graph that is due (apply it first), no such
 * node, an operator-gated node without the operator or an amount, an amount
 * on a keeper node that is not a buyback, a buyback before graduation.
 * Whether the node is due, and how much to run, is `fetchDueNodes`.
 *
 * Accounts: the named ones from the IDL (the pool writable for a buyback
 * only) and the remaining ones the program expects: a buyback DAMM v2's
 * pool authority, token A and B vaults, event authority and program; a
 * distribution each recipient's canonical wSOL account address, writable,
 * in the graph's order, whether or not an account exists there. The caller
 * never creates a recipient's account (audit 4, M4): the program skips a
 * recipient without one (its share stays in the treasury; `skippedRecipients`)
 * and refuses a distribution that could pay nobody (`NoRecipientAccount`,
 * 6042, refused here first). Only the caller's own tip account is created
 * when missing (the default `tipAccount`). `costs` states what the caller
 * pays.
 */
export async function buildRunTx(conn: Connection, caller: PublicKey, launch: PublicKey, node: number, opts: RunTxOptions = {}): Promise<RunTx> {
  const view = await fetchAutopilotView(conn, launch);
  if (view === null) throw refuse("AccountNotInitialized", "this launch has no autopilot");
  const a = view.autopilot;
  if (!a.mintBound) throw refuse("MintNotBound", "the autopilot's mint is not bound yet");
  if (view.active === null) throw refuse("NoActiveGraph", "no graph is active");
  if (view.pending !== null && view.now >= view.pending.activateAt) throw refuse("PendingUpdateDue", "a queued graph is due: apply it first (buildApplyPendingTx)");
  const raw = verifyGraphBytes(view.active.bytes);
  const n = raw.nodes[node];
  if (!Number.isInteger(node) || n === undefined) throw refuse("NoSuchNode", `the active graph has no node ${node}`);
  const gated = n.operatorGated === 1;
  const amount = opts.amount ?? null;
  if (amount !== null && (amount <= 0n || amount > (1n << 64n) - 1n)) throw refuse("InvalidAmount", "the amount must be 1 to u64::MAX");
  if (gated) {
    if (a.operatorOrNull === null) throw refuse("NoOperator", "this step is operator-only and the operator was removed");
    if (opts.operator === undefined || opts.operator === null || !opts.operator.equals(a.operatorOrNull)) {
      throw refuse("WrongOperator", `this step is operator-only: pass the operator ${a.operatorOrNull.toBase58()}, who must sign`);
    }
    if (amount === null) throw refuse("InvalidAmount", "an operator-only step needs the operator's amount (1 to the step's most)");
  } else if (amount !== null && n.action !== ACTION.BUYBACK_BURN) {
    throw refuse("AmountNotAllowed", "only operator-only steps and buybacks take an amount");
  }
  const isBuyback = n.action === ACTION.BUYBACK_BURN;
  if (isBuyback && (!a.graduated || view.pool === null)) throw refuse("NotGraduated", "buybacks start after graduation (bind_pool)");

  const p = autopilotPdas(launch, a.mint);
  const tip = opts.tipAccount ?? wsolAta(caller);
  const remaining: AccountMeta[] = [];
  const skippedRecipients: PublicKey[] = [];
  if (isBuyback) {
    remaining.push(
      { pubkey: KNOWN_ACCOUNTS.dammV2PoolAuthority, isSigner: false, isWritable: false },
      { pubkey: view.pool!.tokenAVault, isSigner: false, isWritable: true },
      { pubkey: view.pool!.tokenBVault, isSigner: false, isWritable: true },
      { pubkey: KNOWN_ACCOUNTS.dammV2EventAuthority, isSigner: false, isWritable: false },
      { pubkey: PROGRAM_IDS.dammV2, isSigner: false, isWritable: false },
    );
  } else if (n.action === ACTION.DISTRIBUTE_SOL) {
    // Every recipient's canonical wSOL address, writable, in graph order; never created by the caller (audit 4, M4).
    const owners = raw.recipients.map((r) => new PublicKey(r.key));
    const atas = owners.map((o) => wsolAta(o));
    const accs = atas.length === 0 ? [] : await getAccounts(conn, atas);
    owners.forEach((owner, i) => {
      remaining.push({ pubkey: atas[i]!, isSigner: false, isWritable: true });
      if (!canReceiveWsol(accs[i] ?? null, owner)) skippedRecipients.push(owner);
    });
    if (owners.length > 0 && skippedRecipients.length === owners.length) {
      throw refuse(
        "NoRecipientAccount",
        "no recipient of this distribution has a wSOL account to receive its share, and a keeper never pays to create one: the run would pay nobody. A recipient (or the creator) can create its own wSOL account first",
      );
    }
  }
  const ix = buildInstruction(
    codec(),
    PROGRAM_IDS.autopilot,
    "run",
    {
      caller,
      operator: gated ? opts.operator! : null,
      autopilot: a.publicKey,
      graph: graphRecordAddress(launch, a.activeGraph),
      treasury: p.treasury,
      treasuryWsol: p.treasuryWsol,
      treasuryToken: p.treasuryToken!,
      mint: a.mint,
      wsolMint: WSOL_MINT,
      dammPool: a.graduated ? a.dammPool : null,
      tipAccount: tip,
    },
    { node, amount },
    remaining,
  );
  // The pool is writable in the transaction for a buyback only (its swap writes it).
  if (isBuyback) for (const k of ix.keys) if (k.pubkey.equals(a.dammPool)) k.isWritable = true;

  // Only the caller's own tip account is created when missing (default tipAccount); never a recipient's.
  const creates: PublicKey[] = [];
  if (opts.tipAccount === undefined) {
    const [tipAcc] = await getAccounts(conn, [tip]);
    if (tipAcc === null || tipAcc === undefined) creates.push(tip);
  } else if (!(await tipAccountOk(conn, tip))) {
    throw refuse("ConstraintTokenMint", "the tip account must be an existing wSOL account (SPL Token)");
  }
  const pre = creates.map((ata) => createAssociatedTokenAccountIdempotentInstruction(caller, ata, caller, WSOL_MINT, KNOWN_ACCOUNTS.splToken));
  const base = isBuyback ? AUTOPILOT_COMPUTE_UNITS.runBuyback : n.action === ACTION.BURN ? AUTOPILOT_COMPUTE_UNITS.runBurn : AUTOPILOT_COMPUTE_UNITS.runDistribute;
  const units = base + pre.length * AUTOPILOT_COMPUTE_UNITS.createAccount;
  let tx: Transaction;
  try {
    tx = await finish(conn, caller, [...pre, ix], units, opts);
  } catch (e) {
    if (pre.length > 0 && e instanceof Error && /legacy limit/.test(e.message)) {
      throw new Error(`${e.message}: create your own wSOL account for the tip first (buildCreateRunAccountsTx), then run`);
    }
    throw e;
  }
  const kind = isBuyback ? "buybackBurn" : n.action === ACTION.BURN ? "burn" : "distributeSol";
  const signers = gated ? 2n : 1n;
  const price = computeUnitPriceOf(opts);
  const priority = price === null || price === 0n ? 0n : priorityFeeLamports(price, computeUnitLimitOf(opts, units));
  const rent = creates.length === 0 ? 0n : BigInt(creates.length) * (await rentExemptLamports(conn, TOKEN_ACCOUNT_SIZE));
  const costs: RunCosts = {
    signatureFeeLamports: LAMPORTS_PER_SIGNATURE * signers,
    priorityFeeLamports: priority,
    rentLamports: rent,
    totalLamports: LAMPORTS_PER_SIGNATURE * signers + priority + rent,
  };
  return { tx, node, action: kind, operatorGated: gated, creates, skippedRecipients, costs, sizeBytes: legacySize(tx) };
}

/**
 * Whether `acc` (at `owner`'s canonical wSOL address) can receive a
 * distribution's share, as the program decides (`is_wsol_account_of`): an
 * SPL Token account of the wSOL mint, owned by `owner`, initialized and not
 * frozen.
 */
function canReceiveWsol(acc: { owner: PublicKey; data: Uint8Array } | null, owner: PublicKey): boolean {
  if (acc === null || !acc.owner.equals(KNOWN_ACCOUNTS.splToken)) return false;
  try {
    const t = parseTokenAccount(acc.owner, acc.data);
    return t.mint.equals(WSOL_MINT) && t.owner.equals(owner) && t.state === 1;
  } catch {
    return false;
  }
}

async function tipAccountOk(conn: Connection, tip: PublicKey): Promise<boolean> {
  const [acc] = await getAccounts(conn, [tip]);
  if (acc === null || acc === undefined || !acc.owner.equals(KNOWN_ACCOUNTS.splToken) || acc.data.length < 64) return false;
  return new PublicKey(acc.data.subarray(0, 32)).equals(WSOL_MINT);
}

/** `buildCreateRunAccountsTx` options. */
export interface CreateRunAccountsOptions extends ComputeBudgetOptions {
  /**
   * Also create the recipients' wSOL accounts (default false: only the
   * payer's own). For a creator or a recipient who chooses to pay for them;
   * a keeper never should (audit 4, M4: each costs 2,039,280 lamports of
   * rent, which the recipient can reclaim by closing it, against a tip of at
   * most 100,000). A recipient without one is skipped by the program and
   * its share stays in the treasury.
   */
  recipients?: boolean | undefined;
}

/**
 * Creates, idempotently, the payer's own wSOL account (where a keeper's tip
 * goes) when it does not exist yet and, only with `recipients: true`, the
 * graph's recipients' wSOL accounts. Null when there is nothing to create.
 */
export async function buildCreateRunAccountsTx(conn: Connection, payer: PublicKey, launch: PublicKey, opts: CreateRunAccountsOptions = {}): Promise<Transaction | null> {
  const view = await fetchAutopilotView(conn, launch);
  if (view === null || view.active === null) throw refuse("NoActiveGraph", "no graph is active");
  const raw = verifyGraphBytes(view.active.bytes);
  const owners = [payer, ...(opts.recipients === true ? raw.recipients.map((r) => new PublicKey(r.key)) : [])];
  const atas = owners.map((o) => wsolAta(o));
  const accs = await getAccounts(conn, atas);
  const missing = owners.flatMap((o, i) => (accs[i] === null || accs[i] === undefined ? [{ owner: o, ata: atas[i]! }] : []));
  if (missing.length === 0) return null;
  const ixs = missing.map((m) => createAssociatedTokenAccountIdempotentInstruction(payer, m.ata, m.owner, WSOL_MINT, KNOWN_ACCOUNTS.splToken));
  return finish(conn, payer, ixs, missing.length * AUTOPILOT_COMPUTE_UNITS.createAccount, opts);
}


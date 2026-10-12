/**
 * The autopilot's accounts and transactions (programs/noised-autopilot):
 * the IDL copy, PDAs, decoders and fetchers (read-only), the keeper's view
 * and the builders of init_autopilot, bind_mint, bind_pool, publish_graph
 * (legacy and v1), apply_pending, update_price and run: account order and
 * flags from the IDL, remaining accounts as the program expects them,
 * refusals before anything is signed, sizes and compute limits.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { decodeV1Transaction } from "../src/tx/v1.js";
import {
  AUTOPILOT,
  AUTOPILOT_COMPUTE_UNITS,
  AUTOPILOT_ERRORS,
  DAMM_V2_MIGRATION_CONFIGS,
  IDLS,
  KNOWN_ACCOUNTS,
  PROGRAM_IDS,
  PUBLISH_GRAPH_LEGACY_MAX_BYTES,
  WSOL_MINT,
  activationPayload,
  authorizationAddress,
  autopilotAccountSize,
  autopilotAddress,
  autopilotPdas,
  autopilotStateOf,
  autopilotTreasuryAddress,
  buildApplyPendingTx,
  buildBindMintTx,
  buildBindPoolTx,
  buildCreateRunAccountsTx,
  buildInitAutopilotTx,
  buildPublishGraphTx,
  buildPublishGraphV1Tx,
  buildRunTx,
  buildUpdatePriceTx,
  buybackBurn,
  burn,
  certificateAddress,
  compileGraph,
  dammV2PoolAddress,
  decodeAutopilot,
  decodeGraphRecord,
  distributeSol,
  every,
  explainProgramError,
  fetchAutopilot,
  fetchAutopilotView,
  fetchDueNodes,
  fetchGraph,
  fetchGraphBytes,
  graph,
  graphHash,
  graphRecordAddress,
  legacySize,
  nodeStatus,
  publishGraphLegacySize,
  publishGraphV1Size,
  when,
  whenever,
  wsolAta,
  type Graph,
} from "../src/index.js";
import { associatedTokenAddress } from "../src/pda.js";
import { key, tokenAccountBytes, wallet } from "./helpers.js";
import { accountBytes, NOW, world, zeroed, type World } from "./world.js";

const AP = PROGRAM_IDS.autopilot;
const SPL = KNOWN_ACCOUNTS.splToken;
const T22 = KNOWN_ACCOUNTS.token2022;
const SOL = 1_000_000_000n;
const OPERATOR = key("ap/operator");
const zero32 = new Uint8Array(32);
/** Wallets (on the curve): payees the SDK's recipient check accepts (audit 4, C1). */
const recipients = Array.from({ length: 8 }, (_, i) => wallet(`ap/recipient/${i}`));

/** The graph most tests run: a keeper buyback, a burn after it, a distribution, an operator-only buyback. */
const G: Graph = graph({ operator: OPERATOR })
  .recipient(recipients[0]!, "70%", "team")
  .recipient(recipients[1]!, "30%")
  .node("buy", every("1h"), when.graduated(), buybackBurn({ maxIn: 1, maxPremiumBps: 300 }), { maxRunsPerEpoch: 24, budgetPerEpoch: 24 })
  .node("burn", every("1d"), null, burn(1_000))
  .node("share", every("1d"), null, distributeSol(0.5))
  .node("ai", whenever(), when.graduated(), buybackBurn({ maxIn: 0.5 }), { operatorGated: true, budgetPerEpoch: 2, maxRunsPerEpoch: 4 })
  .build();
const BYTES = compileGraph(G);
const HASH = graphHash(BYTES);
const REF = 1n << 59n; // the reference sqrt price (about 1e-6 SOL per token at 6 decimals)

interface ApWorld {
  w: World;
  ap: PublicKey;
  pool: PublicKey;
  value: Record<string, unknown>;
  put(): void;
}

/** A live launch (test/world.ts) with an autopilot: mint bound, graduated or not, `G` active. */
function apWorld(o: { graduated?: boolean; graph?: Uint8Array; withAutopilot?: boolean } = {}): ApWorld {
  const w = world();
  const launch = w.launch;
  const p = autopilotPdas(launch, w.mint);
  const bytes = o.graph ?? BYTES;
  const hash = graphHash(bytes);
  const pool = dammV2PoolAddress(DAMM_V2_MIGRATION_CONFIGS[2]!, w.mint, WSOL_MINT);
  const graduated = o.graduated ?? true;
  const node = { lastRun: 0n, lastSeq: 0n, epochStart: 0n, runsInEpoch: 0, spentInEpoch: 0n };
  const value: Record<string, unknown> = {
    version: 1,
    bump: 255,
    treasuryBump: 254,
    launch,
    mint: w.mint,
    dammPool: graduated ? pool : PublicKey.default,
    activeGraph: hash,
    pendingGraph: zero32,
    pendingActivateAt: 0n,
    pendingOperator: PublicKey.default,
    activatedAt: BigInt(NOW - 86_400),
    frozen: false,
    operator: OPERATOR,
    authMarks: [0, 1, 2].map(() => ({ slot: 0n, key: PublicKey.default })),
    seq: 0n,
    refSqrtPrice: REF,
    refUpdatedAt: 0n,
    refAllowance: 0n,
    refAllowanceAt: 0n,
    // Observed for the last 10 minutes at the reference: a buyback may run now.
    observations: [
      { index: BigInt(Math.floor(NOW / 900)), firstAt: BigInt(NOW - 600 + (NOW % 900 >= 600 ? 0 : 0)), min: REF, max: REF },
      { index: BigInt(Math.floor(NOW / 900) - 1), firstAt: BigInt(NOW - 900), min: REF, max: REF },
    ],
    tipEpochStart: 0n,
    tipsInEpoch: 0n,
    nodes: Array.from({ length: 16 }, () => ({ ...node })),
  };
  const t: ApWorld = {
    w,
    ap: p.autopilot,
    pool,
    value,
    put() {
      if (o.withAutopilot !== false) w.conn.set(p.autopilot, { owner: AP, data: accountBytes("autopilot", "Autopilot", value) });
    },
  };
  t.put();
  w.conn.set(graphRecordAddress(launch, hash), { owner: AP, data: accountBytes("autopilot", "GraphRecord", { version: 1, bump: 255, launch, graphHash: hash, bytes }) });
  w.conn.set(p.treasuryWsol, { owner: SPL, data: tokenAccountBytes({ mint: WSOL_MINT, owner: p.treasury, amount: 50n * SOL }) });
  w.conn.set(p.treasuryToken!, { owner: T22, data: tokenAccountBytes({ mint: w.mint, owner: p.treasury, amount: 5_000_000_000n, token2022: true }) });
  const poolState = zeroed("dammV2", "Pool");
  Object.assign(poolState, { tokenAMint: w.mint, tokenBMint: WSOL_MINT, tokenAVault: key("ap/va"), tokenBVault: key("ap/vb"), creator: KNOWN_ACCOUNTS.dbcPoolAuthority, sqrtPrice: REF });
  w.conn.set(pool, { owner: PROGRAM_IDS.dammV2, data: accountBytes("dammV2", "Pool", poolState) });
  w.conn.set(key("ap/vb"), { owner: SPL, data: tokenAccountBytes({ mint: WSOL_MINT, owner: KNOWN_ACCOUNTS.dammV2PoolAuthority, amount: 200n * SOL }) });
  return t;
}

const conn = (t: ApWorld) => t.w.conn.asConnection();
const names = (ixName: string): string[] => IDLS.autopilot.instructions.find((i) => i.name === ixName)!.accounts.map((a) => a.name);

describe("autopilot program: IDL, PDAs, sizes, errors", () => {
  it("the IDL is the autopilot's: address, instructions, the Autopilot account's 1,244 bytes (audit round 4 appended 168)", () => {
    expect(IDLS.autopilot.address).toBe(AP.toBase58());
    expect(IDLS.autopilot.instructions.map((i) => i.name).sort()).toEqual([
      "activate", "apply_pending", "bind_mint", "bind_pool", "freeze", "init_autopilot", "publish_graph", "revoke_operator", "run", "update_price",
    ]);
    expect(autopilotAccountSize()).toBe(1_244);
    // The appended fields sit where the program and the vectors put them; their rent is what init_autopilot pays more.
    const fields = (IDLS.autopilot.types ?? []).find((t) => t.name === "Autopilot")!.type as unknown as { fields: { name: string }[] };
    expect(fields.fields.slice(-3).map((f) => f.name)).toEqual(["active_auth", "active_activate_at", "partial_spent"]);
    expect([AUTOPILOT.OFFSETS.activeAuth, AUTOPILOT.OFFSETS.activeActivateAt, AUTOPILOT.OFFSETS.partialSpent]).toEqual([1_076, 1_108, 1_116]);
    expect(AUTOPILOT.A4_EXTRA_RENT_LAMPORTS).toBe(168n * 6_960n);
  });

  it("PDAs follow the IDL's seeds: autopilot, treasury, graph record; the authorization under the launchpad", () => {
    const launch = key("ap/launch");
    const seedOf = (ix: string, acc: string): string => {
      const a = IDLS.autopilot.instructions.find((i) => i.name === ix)!.accounts.find((x) => x.name === acc)! as unknown as { pda: { seeds: { kind: string; value?: number[] }[] } };
      return new TextDecoder().decode(Uint8Array.from(a.pda.seeds[0]!.value!));
    };
    expect([seedOf("init_autopilot", "autopilot"), seedOf("init_autopilot", "treasury"), seedOf("run", "graph")]).toEqual(["autopilot", "treasury", "graph"]);
    expect(autopilotAddress(launch).equals(PublicKey.findProgramAddressSync([Buffer.from("autopilot"), launch.toBytes()], AP)[0])).toBe(true);
    expect(autopilotTreasuryAddress(launch).equals(PublicKey.findProgramAddressSync([Buffer.from("treasury"), launch.toBytes()], AP)[0])).toBe(true);
    expect(graphRecordAddress(launch, HASH).equals(PublicKey.findProgramAddressSync([Buffer.from("graph"), launch.toBytes(), HASH], AP)[0])).toBe(true);
    const payload = activationPayload(autopilotAddress(launch), HASH, 1_800_000_000n);
    expect(authorizationAddress(launch, 1, payload).equals(PublicKey.findProgramAddressSync([Buffer.from("auth"), launch.toBytes(), Uint8Array.of(1), payload], PROGRAM_IDS.launchpad)[0])).toBe(true);
    const p = autopilotPdas(launch, key("ap/mint"));
    expect(p.treasuryWsol.equals(wsolAta(p.treasury))).toBe(true);
    expect(p.treasuryToken!.equals(associatedTokenAddress(p.treasury, key("ap/mint"), T22))).toBe(true);
  });

  it("AUTOPILOT_ERRORS (what planRun and the builders name) are the IDL's errors, in order", () => {
    expect(IDLS.autopilot.errors!.map((e) => [e.code, e.name])).toEqual(AUTOPILOT_ERRORS.map((n, i) => [6000 + i, n]));
  });

  it("program errors are named from the IDL (6030 SwapShortfall)", () => {
    expect(explainProgramError(AP.toBase58(), 6030)).toEqual({ program: "noised_autopilot", name: "SwapShortfall", message: "The swap did not take exactly the amount in or returned less than the minimum" });
    expect(explainProgramError(AP.toBase58(), 6034)!.name).toBe("PriceNotObserved");
  });
});

describe("autopilot accounts (read-only)", () => {
  it("decodeAutopilot: every field, derived flags; refuses another version or address", async () => {
    const t = apWorld();
    const a = (await fetchAutopilot(conn(t), t.w.launch))!;
    expect(a.publicKey.equals(t.ap)).toBe(true);
    expect([a.mintBound, a.graduated, a.hasActiveGraph, a.hasPendingGraph, a.frozen]).toEqual([true, true, true, false, false]);
    expect(a.operatorOrNull!.equals(OPERATOR)).toBe(true);
    expect(a.refSqrtPrice).toBe(REF);
    expect(a.nodes).toHaveLength(16);
    const data = t.w.conn.get(t.ap)!.data;
    expect(() => decodeAutopilot(key("elsewhere"), data)).toThrow(/PDA/);
    t.value["version"] = 2;
    t.put();
    await expect(fetchAutopilot(conn(t), t.w.launch)).rejects.toThrow(/version 2/);
    expect(await fetchAutopilot(conn(t), key("no-such-launch"))).toBeNull();
  });

  it("decodeGraphRecord: the bytes must hash to the record's hash and address, and verify", async () => {
    const t = apWorld();
    const g = (await fetchGraph(conn(t), t.w.launch, HASH))!;
    expect(g.bytes).toEqual(BYTES);
    expect(g.graph.nodes).toHaveLength(4);
    expect(await fetchGraphBytes(conn(t), t.w.launch, HASH)).toEqual(BYTES);
    expect(await fetchGraph(conn(t), t.w.launch, sha256(Uint8Array.of(1)))).toBeNull();
    const at = graphRecordAddress(t.w.launch, HASH);
    const tampered = Uint8Array.from(BYTES);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    expect(() => decodeGraphRecord(at, accountBytes("autopilot", "GraphRecord", { version: 1, bump: 255, launch: t.w.launch, graphHash: HASH, bytes: tampered }))).toThrow(/hash/);
    const bad = Uint8Array.from(BYTES.subarray(0, 20));
    const badHash = graphHash(bad);
    expect(() => decodeGraphRecord(graphRecordAddress(t.w.launch, badHash), accountBytes("autopilot", "GraphRecord", { version: 1, bump: 255, launch: t.w.launch, graphHash: badHash, bytes: bad }))).toThrow(/PXG1/);
    expect(() => decodeGraphRecord(key("x"), t.w.conn.get(at)!.data)).toThrow(/address/);
  });

  it("fetchAutopilotView: graphs, treasury balances, the pool and the clock in one read", async () => {
    const t = apWorld();
    const v = (await fetchAutopilotView(conn(t), t.w.launch))!;
    expect(v.active!.bytes).toEqual(BYTES);
    expect(v.pending).toBeNull();
    expect([v.treasury.sol, v.treasury.tokens]).toEqual([50n * SOL, 5_000_000_000n]);
    expect(v.pool).toMatchObject({ sqrtPrice: REF, sol: 200n * SOL });
    expect(v.now).toBe(BigInt(NOW));
  });

  it("autopilotStateOf + nodeStatus: the program's decision on live state; fetchDueNodes is the keeper's view", async () => {
    const t = apWorld();
    const a = (await fetchAutopilot(conn(t), t.w.launch))!;
    const s = autopilotStateOf(a, 4);
    expect(s.refSqrtPriceQ64).toBe(REF);
    expect(s.operator).toBe(OPERATOR.toBase58());
    const env = { now: NOW, treasurySol: 50n * SOL, treasuryTokens: 5_000_000_000n, graduated: true, spotSqrtPriceQ64: REF, poolSol: 200n * SOL, poolFeeBps: 100 };
    expect(nodeStatus(G, s, env, 0)).toMatchObject({ due: true, maxAmount: SOL, minAmount: 2n * SOL > SOL ? SOL : 2n * SOL });
    const d = (await fetchDueNodes(conn(t), t.w.launch))!;
    expect(d.env!.poolFeeBps).toBe(100); // MIGRATION_FEE_TIERS_BPS[2]
    expect(d.due).toEqual([0, 1, 2, 3]);
    expect(d.statuses[3]!.operatorOnly).toBe(true);
    expect(d.applyPendingFirst).toBe(false);
    // A queued graph that is due must be applied first.
    t.value["pendingGraph"] = HASH;
    t.value["pendingActivateAt"] = BigInt(NOW - 1);
    t.put();
    const p = (await fetchDueNodes(conn(t), t.w.launch))!;
    expect(p.applyPendingFirst).toBe(true);
    expect(p.due).toEqual([]);
  });
});

describe("autopilot builders", () => {
  const ixOf = (tx: { instructions: { programId: PublicKey }[] }) => tx.instructions.find((i) => i.programId.equals(AP)) as unknown as { keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[]; data: Buffer };
  const disc = (name: string): number[] => IDLS.autopilot.instructions.find((i) => i.name === name)!.discriminator;
  const limitOf = (tx: { instructions: { programId: PublicKey; data: Buffer }[] }): number => {
    const ix = tx.instructions.find((i) => i.programId.equals(KNOWN_ACCOUNTS.computeBudget) && i.data[0] === 2)!;
    return ix.data.readUInt32LE(1);
  };

  it("init_autopilot: the IDL's accounts, the DBC config from the launch; refused twice", async () => {
    const t = apWorld({ withAutopilot: false });
    const payer = key("ap/payer");
    const tx = await buildInitAutopilotTx(conn(t), payer, t.w.launch);
    const ix = ixOf(tx);
    expect([...ix.data.subarray(0, 8)]).toEqual(disc("init_autopilot"));
    expect(ix.keys).toHaveLength(names("init_autopilot").length);
    expect(ix.keys[0]).toMatchObject({ isSigner: true, isWritable: true });
    expect(ix.keys[2]!.pubkey.equals(t.w.dbcConfig)).toBe(true);
    expect(ix.keys[3]!.pubkey.equals(t.ap)).toBe(true);
    expect(limitOf(tx)).toBe(AUTOPILOT_COMPUTE_UNITS.initAutopilot);
    expect(legacySize(tx)).toBeLessThanOrEqual(1_232);
    t.put();
    const t2 = apWorld();
    await expect(buildInitAutopilotTx(conn(t2), payer, t2.w.launch)).rejects.toThrow(/already has an autopilot/);
  });

  it("bind_mint and bind_pool: refused out of order, built with the certificate and the migrated pool", async () => {
    const t = apWorld({ graduated: false });
    const payer = key("ap/payer");
    await expect(buildBindMintTx(conn(t), payer, t.w.launch)).rejects.toThrow(/MintAlreadyBound/);
    t.value["mint"] = PublicKey.default;
    t.put();
    const tx = await buildBindMintTx(conn(t), payer, t.w.launch);
    const ix = ixOf(tx);
    expect(ix.keys[3]!.pubkey.equals(certificateAddress(t.w.mint))).toBe(true);
    expect(ix.keys[6]!.pubkey.equals(autopilotPdas(t.w.launch, t.w.mint).treasuryToken!)).toBe(true);
    await expect(buildBindPoolTx(conn(t), payer, t.w.launch)).rejects.toThrow(/MintNotBound/);
    t.value["mint"] = t.w.mint;
    t.put();
    const bp = await buildBindPoolTx(conn(t), payer, t.w.launch);
    expect(ixOf(bp).keys.map((k) => k.pubkey.toBase58())).toEqual([t.ap.toBase58(), DAMM_V2_MIGRATION_CONFIGS[2]!.toBase58(), t.pool.toBase58()]);
    t.w.conn.delete(t.pool);
    await expect(buildBindPoolTx(conn(t), payer, t.w.launch)).rejects.toThrow(/NotGraduated/);
  });

  it("publish_graph: verified first; legacy up to 898 bytes, v1 above (the largest graph: 2,338 bytes); already-published reported", async () => {
    const t = apWorld();
    const payer = key("ap/payer");
    expect(publishGraphLegacySize(PUBLISH_GRAPH_LEGACY_MAX_BYTES)).toBeLessThanOrEqual(1_232);
    expect(publishGraphLegacySize(PUBLISH_GRAPH_LEGACY_MAX_BYTES + 1)).toBeGreaterThan(1_232);
    expect(publishGraphV1Size(2_044)).toBe(2_338); // the LiteSVM measurement of the largest graph
    expect(await buildPublishGraphTx(conn(t), payer, t.w.launch, BYTES)).toMatchObject({ status: "already-published" });
    const other = compileGraph(graph().node("b", every("1d"), null, burn(5)).build());
    const ready = await buildPublishGraphTx(conn(t), payer, t.w.launch, other);
    if (ready.status !== "ready") throw new Error("expected ready");
    expect(ready.address.equals(graphRecordAddress(t.w.launch, graphHash(other)))).toBe(true);
    expect(ready.sizeBytes).toBe(publishGraphLegacySize(other.length, { priorityFee: false }));
    await expect(buildPublishGraphTx(conn(t), payer, t.w.launch, other.subarray(0, 30))).rejects.toThrow(/InvalidGraph/);
    // A large graph: 8 recipients, 16 nodes.
    let big = graph();
    recipients.forEach((r) => (big = big.recipient(r, 1_250)));
    big = big.node("d", every("1h"), null, distributeSol(1));
    for (let i = 0; i < 15; i++) big = big.node(`b${i}`, every("1h"), when.treasurySolGte(i + 1), burn(1));
    const bigBytes = compileGraph(big.build());
    expect(bigBytes.length).toBeGreaterThan(PUBLISH_GRAPH_LEGACY_MAX_BYTES);
    await expect(buildPublishGraphTx(conn(t), payer, t.w.launch, bigBytes)).rejects.toThrow(/buildPublishGraphV1Tx/);
    const kp = Keypair.generate();
    const v1 = await buildPublishGraphV1Tx(conn(t), kp, t.w.launch, bigBytes);
    if (v1.status !== "ready") throw new Error("expected ready");
    const d = decodeV1Transaction(v1.tx);
    expect(d.instructions).toHaveLength(1);
    expect(v1.sizeBytes).toBe(publishGraphV1Size(bigBytes.length));
  });

  it("apply_pending and update_price: refused without a queued graph / before graduation", async () => {
    const t = apWorld({ graduated: false });
    const payer = key("ap/payer");
    await expect(buildApplyPendingTx(conn(t), payer, t.w.launch)).rejects.toThrow(/NoPendingUpdate/);
    await expect(buildUpdatePriceTx(conn(t), payer, t.w.launch)).rejects.toThrow(/NotGraduated/);
    t.value["pendingGraph"] = HASH;
    t.value["dammPool"] = t.pool;
    t.put();
    const ap = await buildApplyPendingTx(conn(t), payer, t.w.launch);
    expect(ixOf(ap).keys[1]!.pubkey.equals(graphRecordAddress(t.w.launch, HASH))).toBe(true);
    const up = await buildUpdatePriceTx(conn(t), payer, t.w.launch);
    expect(ixOf(up).keys.map((k) => [k.pubkey.toBase58(), k.isWritable])).toEqual([[t.ap.toBase58(), true], [t.pool.toBase58(), false]]);
    t.value["frozen"] = true;
    t.put();
    await expect(buildApplyPendingTx(conn(t), payer, t.w.launch)).rejects.toThrow(/Frozen/);
  });

  it("run, a keeper buyback: DAMM v2's accounts after the named ones, the pool writable, the tip account created", async () => {
    const t = apWorld();
    const caller = key("ap/keeper");
    const r = await buildRunTx(conn(t), caller, t.w.launch, 0);
    const ix = ixOf(r.tx);
    expect([...ix.data]).toEqual([...disc("run"), 0, 0]); // node 0, amount None
    const n = names("run").length;
    expect(ix.keys[0]).toMatchObject({ isSigner: true });
    expect(ix.keys[1]!.pubkey.equals(AP)).toBe(true); // no operator (Anchor's None)
    const pool = ix.keys.find((k) => k.pubkey.equals(t.pool))!;
    expect(pool.isWritable).toBe(true);
    expect(ix.keys.slice(n).map((k) => [k.pubkey.toBase58(), k.isWritable])).toEqual([
      [KNOWN_ACCOUNTS.dammV2PoolAuthority.toBase58(), false],
      [key("ap/va").toBase58(), true],
      [key("ap/vb").toBase58(), true],
      [KNOWN_ACCOUNTS.dammV2EventAuthority.toBase58(), false],
      [PROGRAM_IDS.dammV2.toBase58(), false],
    ]);
    expect(r.creates.map((k) => k.toBase58())).toEqual([wsolAta(caller).toBase58()]);
    expect(limitOf(r.tx)).toBe(AUTOPILOT_COMPUTE_UNITS.runBuyback + AUTOPILOT_COMPUTE_UNITS.createAccount);
    expect(r.sizeBytes).toBeLessThanOrEqual(1_232);
    // A keeper may size a buyback down: Some(amount).
    const smaller = await buildRunTx(conn(t), caller, t.w.launch, 0, { amount: SOL / 2n });
    expect([...ixOf(smaller.tx).data.subarray(8)]).toEqual([0, 1, ...new Uint8Array(new BigUint64Array([SOL / 2n]).buffer)]);
  });

  it("run, review U13: an operator-only step needs the operator (signing) and its amount; keepers can't pass amounts on burns", async () => {
    const t = apWorld();
    const caller = key("ap/keeper");
    await expect(buildRunTx(conn(t), caller, t.w.launch, 3)).rejects.toThrow(/WrongOperator/);
    await expect(buildRunTx(conn(t), caller, t.w.launch, 3, { operator: OPERATOR })).rejects.toThrow(/InvalidAmount/);
    await expect(buildRunTx(conn(t), caller, t.w.launch, 3, { operator: key("someone"), amount: 1n })).rejects.toThrow(/WrongOperator/);
    const r = await buildRunTx(conn(t), OPERATOR, t.w.launch, 3, { operator: OPERATOR, amount: SOL / 4n });
    expect(ixOf(r.tx).keys[1]).toMatchObject({ isSigner: true });
    expect(r.operatorGated).toBe(true);
    await expect(buildRunTx(conn(t), caller, t.w.launch, 1, { amount: 5n })).rejects.toThrow(/AmountNotAllowed/);
    await expect(buildRunTx(conn(t), caller, t.w.launch, 9)).rejects.toThrow(/NoSuchNode/);
    t.value["operator"] = PublicKey.default;
    t.put();
    await expect(buildRunTx(conn(t), OPERATOR, t.w.launch, 3, { operator: OPERATOR, amount: 1n })).rejects.toThrow(/NoOperator/);
  });

  it("run, a distribution (audit 4, M4): every recipient's canonical wSOL address in the graph's order, writable, never created by the caller; one without an account is skipped; none at all is refused (NoRecipientAccount); a burn takes none", async () => {
    const t = apWorld();
    const caller = key("ap/keeper");
    t.w.conn.set(wsolAta(caller), { owner: SPL, data: tokenAccountBytes({ mint: WSOL_MINT, owner: caller, amount: 0n }) });
    // Nobody has a wSOL account: the run could pay nobody, so it is refused before anything is sent (6042).
    await expect(buildRunTx(conn(t), caller, t.w.launch, 2)).rejects.toThrow(/NoRecipientAccount/);
    // Recipient 0 has one, recipient 1 does not: both addresses are passed, recipient 1 is skipped, nothing is created.
    t.w.conn.set(wsolAta(recipients[0]!), { owner: SPL, data: tokenAccountBytes({ mint: WSOL_MINT, owner: recipients[0]!, amount: 0n }) });
    const r = await buildRunTx(conn(t), caller, t.w.launch, 2);
    const ix = ixOf(r.tx);
    expect(ix.keys.slice(names("run").length).map((k) => [k.pubkey.toBase58(), k.isWritable])).toEqual([
      [wsolAta(recipients[0]!).toBase58(), true],
      [wsolAta(recipients[1]!).toBase58(), true],
    ]);
    expect(r.creates).toEqual([]);
    expect(r.skippedRecipients.map((k) => k.toBase58())).toEqual([recipients[1]!.toBase58()]);
    expect(r.tx.instructions.some((i) => i.programId.equals(KNOWN_ACCOUNTS.associatedToken))).toBe(false);
    expect(r.costs).toEqual({ signatureFeeLamports: 5_000n, priorityFeeLamports: 0n, rentLamports: 0n, totalLamports: 5_000n });
    // A wSOL account owned by someone else, or frozen, at a recipient's address cannot receive: skipped too.
    t.w.conn.set(wsolAta(recipients[1]!), { owner: SPL, data: tokenAccountBytes({ mint: WSOL_MINT, owner: key("someone else"), amount: 0n }) });
    expect((await buildRunTx(conn(t), caller, t.w.launch, 2)).skippedRecipients).toHaveLength(1);
    expect(ix.keys.find((k) => k.pubkey.equals(t.pool))!.isWritable).toBe(false); // read-only unless a buyback
    const burnRun = await buildRunTx(conn(t), caller, t.w.launch, 1);
    expect(ixOf(burnRun.tx).keys).toHaveLength(names("run").length);
    expect([burnRun.creates, burnRun.skippedRecipients]).toEqual([[], []]);
    expect(limitOf(burnRun.tx)).toBe(AUTOPILOT_COMPUTE_UNITS.runBurn);
  });

  it("run, eight recipients: fits a legacy transaction, the caller creating only its own tip account; buildCreateRunAccountsTx creates recipients' accounts only when asked (a creator, never a keeper)", async () => {
    let g = graph();
    recipients.forEach((r) => (g = g.recipient(r, 1_250)));
    const bytes = compileGraph(g.node("share", every("1d"), null, distributeSol(1)).build());
    const t = apWorld({ graph: bytes });
    t.value["activeGraph"] = graphHash(bytes);
    t.value["operator"] = PublicKey.default;
    t.put();
    const caller = key("ap/keeper");
    t.w.conn.set(wsolAta(recipients[7]!), { owner: SPL, data: tokenAccountBytes({ mint: WSOL_MINT, owner: recipients[7]!, amount: 0n }) });
    const first = await buildRunTx(conn(t), caller, t.w.launch, 0);
    expect(first.sizeBytes).toBeLessThanOrEqual(1_232);
    expect(first.creates.map((k) => k.toBase58())).toEqual([wsolAta(caller).toBase58()]); // its own tip account only
    expect(first.skippedRecipients).toHaveLength(7);
    expect(first.costs.rentLamports).toBe(BigInt((128 + 165) * 3_480 * 2)); // 2,039,280: the caller's to reclaim
    expect(first.costs.totalLamports).toBe(5_000n + 2_039_280n);
    // The payer's own account only, unless the recipients' are asked for explicitly.
    const own = (await buildCreateRunAccountsTx(conn(t), caller, t.w.launch))!;
    expect(own.instructions.filter((i) => i.programId.equals(KNOWN_ACCOUNTS.associatedToken))).toHaveLength(1);
    const all = (await buildCreateRunAccountsTx(conn(t), caller, t.w.launch, { recipients: true }))!;
    expect(all.instructions.filter((i) => i.programId.equals(KNOWN_ACCOUNTS.associatedToken))).toHaveLength(8);
    for (const o of [caller, ...recipients]) t.w.conn.set(wsolAta(o), { owner: SPL, data: tokenAccountBytes({ mint: WSOL_MINT, owner: o, amount: 0n }) });
    expect(await buildCreateRunAccountsTx(conn(t), caller, t.w.launch, { recipients: true })).toBeNull();
    const r = await buildRunTx(conn(t), caller, t.w.launch, 0);
    expect(r.sizeBytes).toBeLessThanOrEqual(1_232);
    expect(ixOf(r.tx).keys.slice(names("run").length)).toHaveLength(8);
    expect([r.creates, r.skippedRecipients]).toEqual([[], []]);
  });

  it("run is refused while a queued graph is due, without an active graph, and for a buyback before graduation", async () => {
    const t = apWorld();
    const caller = key("ap/keeper");
    t.value["pendingGraph"] = HASH;
    t.value["pendingActivateAt"] = BigInt(NOW);
    t.put();
    await expect(buildRunTx(conn(t), caller, t.w.launch, 0)).rejects.toThrow(/PendingUpdateDue/);
    t.value["pendingGraph"] = zero32;
    t.value["activeGraph"] = zero32;
    t.put();
    await expect(buildRunTx(conn(t), caller, t.w.launch, 0)).rejects.toThrow(/NoActiveGraph/);
    const u = apWorld({ graduated: false });
    await expect(buildRunTx(conn(u), caller, u.w.launch, 0)).rejects.toThrow(/NotGraduated/);
  });
});

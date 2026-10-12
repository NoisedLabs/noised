/**
 * Switching an autopilot to a graph end to end (`src/autopilot/flow.ts`) and
 * the keeper (`src/autopilot/keeper.ts`):
 *
 * - `planGraphActivation`: a first graph starts after the margin, a
 *   replacement 72 hours plus the margin later; too-early times, a frozen
 *   autopilot and an invalid graph are refused;
 * - `getGraphActivationStatus` through every stage (no autopilot, not
 *   published, awaiting / burned authorization, ready, queued, due, active,
 *   frozen, superseded) and `buildNextGraphActivationTx` building each step
 *   (init, publish legacy or v1, authorize with the PQ identity, activate,
 *   apply) or nothing while waiting;
 * - the freeze flow (review 4, R5): `planFreeze` (the running graph, usable
 *   until the cluster time plus an hour by default; Frozen, NoActiveGraph
 *   and past times refused), `getFreezeStatus` (awaiting / burned
 *   authorization, ready, frozen, expired, superseded) and
 *   `buildNextFreezeTx` (the kind-2 approval, never signed with less than
 *   the landing margin left, then `freeze(notAfter)`);
 * - `planKeeperStep`: a due queued graph first, a buyback waiting for a price
 *   check gets `update_price` then a minute's wait, never a buyback without
 *   observations spanning a minute on the cluster's clock, operator-only
 *   steps left alone; `runKeeper` looping over it.
 */
import { Keypair, PublicKey, type Transaction } from "@solana/web3.js";
import { beforeAll, describe, expect, it } from "vitest";

import { fromHex } from "../src/codec/bytes.js";
import { DAMM_V2_MIGRATION_CONFIGS, KNOWN_ACCOUNTS, PQ_IDENTITY, PROGRAM_IDS, WSOL_MINT } from "../src/constants.js";
import { IDLS } from "../src/idl/index.js";
import { authorizationAddress, autopilotPdas, dammV2PoolAddress, graphRecordAddress } from "../src/pda.js";
import { PUBLISH_GRAPH_LEGACY_MAX_BYTES } from "../src/autopilot/builders.js";
import { buildNextGraphActivationTx, getGraphActivationStatus, GRAPH_TIMELOCK_SECS, planGraphActivation, type GraphActivationPlan } from "../src/autopilot/flow.js";
import { buildNextFreezeTx, getFreezeStatus, planFreeze, type FreezePlan } from "../src/autopilot/freeze.js";
import { KEEPER_OBSERVATION_WAIT_SECS, KEEPER_OBSERVER_INTERVAL_SECS, planKeeperStep, runKeeper } from "../src/autopilot/keeper.js";
import { activationPayload, FREEZE_DEFAULT_VALID_SECS, freezePayload } from "../src/programmable/autopilot/logic.js";
import { deriveIdentity, type PqIdentity } from "../src/pq/identity.js";
import { createMemoryLeafLedger } from "../src/pq/leafLedger.js";
import { burn, buybackBurn, compileGraph, distributeSol, every, graph, graphHash, unixToIso, unixToUtcText, when, whenever } from "../src/index.js";
import { AttestConnection } from "./attest_world.js";
import { key, readJson, tokenAccountBytes, wallet } from "./helpers.js";
import { accountBytes, clock, NOW, world, zeroed, type World } from "./world.js";

const AP = PROGRAM_IDS.autopilot;
const SPL = KNOWN_ACCOUNTS.splToken;
const T22 = KNOWN_ACCOUNTS.token2022;
const SOL = 1_000_000_000n;
const OPERATOR = key("flow/operator");
const PAYER = key("flow/payer");
const zero32 = new Uint8Array(32);
const SYSVAR_CLOCK = new PublicKey("SysvarC1ock11111111111111111111111111111111");
const SYSVAR_OWNER = new PublicKey("Sysvar1111111111111111111111111111111111111");
const REF = 1n << 59n;

/** The running graph, then the one the flow switches to. */
const G1 = compileGraph(graph().node("burn", every("1d"), null, burn(1_000)).build());
const G2 = compileGraph(graph().node("burn", every("2d"), null, burn(500)).build());
const H1 = graphHash(G1);
const H2 = graphHash(G2);

let identity: PqIdentity;
beforeAll(async () => {
  identity = await deriveIdentity(fromHex(readJson<{ derivation: { master: string } }>("./vectors/lms.json").derivation.master), "localnet", 0);
});

interface FlowWorld {
  w: World;
  conn: AttestConnection;
  ap: PublicKey;
  value: Record<string, unknown>;
  put(): void;
  setClock(unix: bigint): void;
  publish(hash: Uint8Array, bytes: Uint8Array): void;
  authorize(kind: number, payloadHash: Uint8Array, o?: { slot?: bigint; unixTime?: bigint; empty?: boolean }): PublicKey;
}

function autopilotValue(w: World, o: { active?: Uint8Array | null; graduated?: boolean; pool?: PublicKey }): Record<string, unknown> {
  const active = o.active ?? null;
  return {
    version: 1,
    bump: 255,
    treasuryBump: 254,
    launch: w.launch,
    mint: w.mint,
    dammPool: o.graduated === true ? o.pool! : PublicKey.default,
    activeGraph: active ?? zero32,
    pendingGraph: zero32,
    pendingActivateAt: 0n,
    pendingOperator: PublicKey.default,
    activatedAt: active === null ? 0n : BigInt(NOW - 86_400),
    frozen: false,
    operator: PublicKey.default,
    authMarks: [0, 1, 2].map(() => ({ slot: 0n, key: PublicKey.default })),
    seq: 0n,
    refSqrtPrice: REF,
    refUpdatedAt: 0n,
    refAllowance: 0n,
    refAllowanceAt: 0n,
    observations: [0, 1].map(() => ({ index: 0n, firstAt: 0n, min: 0n, max: 0n })),
    tipEpochStart: 0n,
    tipsInEpoch: 0n,
    nodes: Array.from({ length: 16 }, () => ({ lastRun: 0n, lastSeq: 0n, epochStart: 0n, runsInEpoch: 0, spentInEpoch: 0n })),
  };
}

/** A live launch naming the vector identity (identity 0 of lms.json, localnet); its autopilot only with `autopilot: true`. */
function flowWorld(o: { autopilot?: boolean; active?: Uint8Array | null } = {}): FlowWorld {
  const w = world();
  w.launchState["pqIdentity"] = identity.identityId;
  w.build();
  // The same accounts in a connection that also answers rent (the approval's funding).
  const conn = new AttestConnection();
  for (const [k, a] of w.conn.accounts) conn.accounts.set(k, a);
  const p = autopilotPdas(w.launch, w.mint);
  const value = autopilotValue(w, { active: o.active ?? null });
  const t: FlowWorld = {
    w,
    conn,
    ap: p.autopilot,
    value,
    put() {
      conn.set(p.autopilot, { owner: AP, data: accountBytes("autopilot", "Autopilot", value) });
    },
    setClock(unix) {
      conn.set(SYSVAR_CLOCK, { owner: SYSVAR_OWNER, data: clock(Number(unix)) });
    },
    publish(hash, bytes) {
      conn.set(graphRecordAddress(w.launch, hash), { owner: AP, data: accountBytes("autopilot", "GraphRecord", { version: 1, bump: 255, launch: w.launch, graphHash: hash, bytes }) });
    },
    authorize(kind, payloadHash, a = {}) {
      const [address, bump] = PublicKey.findProgramAddressSync([new TextEncoder().encode("auth"), w.launch.toBytes(), Uint8Array.of(kind), payloadHash], PROGRAM_IDS.launchpad);
      const empty = a.empty === true;
      const data = new Uint8Array(2_669);
      data.set(
        accountBytes("launchpad", "Authorization", {
          version: empty ? 0 : 1,
          bump: empty ? 0 : bump,
          launch: empty ? PublicKey.default : w.launch,
          pqIdentity: empty ? zero32 : identity.identityId,
          kind: empty ? 0 : kind,
          payloadHash: empty ? zero32 : payloadHash,
          messageHash: new Uint8Array(32).fill(9),
          unixTime: empty ? 0n : (a.unixTime ?? BigInt(NOW)),
          slot: empty ? 0n : (a.slot ?? 400_000_000n),
          leaf: empty ? 0 : 7,
          signature: empty ? new Uint8Array(0) : new Uint8Array(PQ_IDENTITY.SIGNATURE_LEN),
        }),
      );
      conn.set(address, { owner: PROGRAM_IDS.launchpad, data });
      return address;
    },
  };
  if (o.autopilot === true) t.put();
  if (o.active !== undefined && o.active !== null) t.publish(o.active, G1);
  return t;
}

const c = (t: FlowWorld) => t.conn.asConnection();

describe("planGraphActivation", () => {
  it("a first graph: the cluster time plus the margin (default 600 s); the plan names the approval it needs", async () => {
    const t = flowWorld();
    const plan = await planGraphActivation(c(t), t.w.launch, G2);
    expect(plan.firstGraph).toBe(true);
    expect(plan.earliestActivateAt).toBe(BigInt(NOW));
    expect(plan.activateAt).toBe(BigInt(NOW) + 600n);
    expect(plan.kind).toBe(1);
    expect(plan.graphHash).toEqual(H2);
    expect(plan.payloadHash).toEqual(activationPayload(t.ap, H2, plan.activateAt));
    expect(plan.authorization.equals(authorizationAddress(t.w.launch, 1, plan.payloadHash))).toBe(true);
    expect(plan.explanation.length).toBeGreaterThan(1);
    expect((await planGraphActivation(c(t), t.w.launch, G2, { marginSecs: 0n })).activateAt).toBe(BigInt(NOW));
    await expect(planGraphActivation(c(t), t.w.launch, G2, { activateAt: BigInt(NOW) - 1n })).rejects.toThrow(/ActivationInPast/);
  });

  it("a replacement: 72 hours plus the margin; earlier is refused (TimelockTooShort); frozen or invalid graphs are refused", async () => {
    const t = flowWorld({ autopilot: true, active: H1 });
    const plan = await planGraphActivation(c(t), t.w.launch, G2);
    expect(plan.firstGraph).toBe(false);
    expect(plan.earliestActivateAt).toBe(BigInt(NOW) + GRAPH_TIMELOCK_SECS);
    expect(plan.activateAt).toBe(BigInt(NOW) + 259_200n + 600n);
    await expect(planGraphActivation(c(t), t.w.launch, G2, { activateAt: BigInt(NOW) + 259_199n })).rejects.toThrow(/TimelockTooShort/);
    await expect(planGraphActivation(c(t), t.w.launch, G2.subarray(0, 20))).rejects.toThrow(/PXG1/);
    t.value["frozen"] = true;
    t.put();
    await expect(planGraphActivation(c(t), t.w.launch, G2)).rejects.toThrow(/frozen/);
  });
});

describe("getGraphActivationStatus + buildNextGraphActivationTx: every stage of a first graph", () => {
  const apData = (tx: Transaction) => tx.instructions.find((i) => i.programId.equals(AP))!.data;
  const disc = (name: string): number[] => IDLS.autopilot.instructions.find((i) => i.name === name)!.discriminator;

  it("init -> publish -> authorize (the PQ identity signs) -> activate -> wait -> apply -> active", async () => {
    const t = flowWorld();
    const plan = await planGraphActivation(c(t), t.w.launch, G2);
    const opts = { payer: PAYER, identity, ledger: createMemoryLeafLedger(), creator: t.w.launchState["creator"] as PublicKey, allowLocalnet: true };

    let s = await getGraphActivationStatus(c(t), t.w.launch, plan);
    expect([s.stage, s.next, s.applyAt, s.secondsLeft]).toEqual(["no-autopilot", "init-autopilot", plan.activateAt, 600n]);
    expect(s.plain).toMatch(/isn't set up/);
    let next = await buildNextGraphActivationTx(c(t), t.w.launch, plan, opts);
    expect(next?.step).toBe("init-autopilot");
    if (next?.step !== "init-autopilot") throw new Error("unreachable");
    expect([...apData(next.result).subarray(0, 8)]).toEqual(disc("init_autopilot"));

    t.put();
    s = await getGraphActivationStatus(c(t), t.w.launch, plan);
    expect([s.stage, s.next]).toEqual(["graph-not-published", "publish-graph"]);
    next = await buildNextGraphActivationTx(c(t), t.w.launch, plan, opts);
    if (next?.step !== "publish-graph") throw new Error(`expected publish-graph, got ${next?.step}`);
    expect(next.result.status).toBe("ready");
    expect(next.result.address.equals(graphRecordAddress(t.w.launch, H2))).toBe(true);

    t.publish(H2, G2);
    s = await getGraphActivationStatus(c(t), t.w.launch, plan);
    expect([s.stage, s.next]).toEqual(["awaiting-authorization", "authorize"]);
    expect(s.plain).toBe(`This plan is saved. Next, approve it with your launch's quantum key. It would switch on at ${unixToUtcText(plan.activateAt)}.`);
    // Absolute dates (audit 4, ID-F5).
    expect(plan.activateAtIso).toBe(unixToIso(plan.activateAt));
    expect(plan.activateAtIso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(s.applyAtIso).toBe(plan.activateAtIso);
    await expect(buildNextGraphActivationTx(c(t), t.w.launch, plan, { payer: PAYER })).rejects.toThrow(/identity and its leaf ledger/);
    next = await buildNextGraphActivationTx(c(t), t.w.launch, plan, opts);
    if (next?.step !== "authorize") throw new Error(`expected authorize, got ${next?.step}`);
    expect(next.result.status).toBe("ready");
    expect(next.result.kind).toBe(1);
    expect(next.result.payloadHash).toEqual(plan.payloadHash);
    expect(next.result.authorizationAddress.equals(plan.authorization)).toBe(true);

    t.authorize(1, plan.payloadHash, { empty: true });
    s = await getGraphActivationStatus(c(t), t.w.launch, plan);
    expect([s.stage, s.next]).toEqual(["authorization-burned", "authorize"]);

    t.authorize(1, plan.payloadHash);
    s = await getGraphActivationStatus(c(t), t.w.launch, plan);
    expect([s.stage, s.next, s.secondsLeft]).toEqual(["ready-to-activate", "activate", 600n]);
    expect(s.plain).toBe(`Approved. Next, schedule it: it can switch on in about 10 minutes, at ${unixToUtcText(plan.activateAt)} (anyone can send this step).`);
    next = await buildNextGraphActivationTx(c(t), t.w.launch, plan, opts);
    if (next?.step !== "activate") throw new Error(`expected activate, got ${next?.step}`);
    expect([...apData(next.result).subarray(0, 8)]).toEqual(disc("activate"));
    expect(apData(next.result).readBigInt64LE(8)).toBe(plan.activateAt);

    // activate landed: queued with its time, the approval marked used.
    t.value["pendingGraph"] = H2;
    t.value["pendingActivateAt"] = plan.activateAt;
    (t.value["authMarks"] as unknown[])[0] = { slot: 400_000_000n, key: plan.authorization };
    t.put();
    s = await getGraphActivationStatus(c(t), t.w.launch, plan);
    expect([s.stage, s.next, s.applyAt, s.secondsLeft]).toEqual(["queued", "wait", plan.activateAt, 600n]);
    expect(s.plain).toBe(`Scheduled: this plan switches on in about 10 minutes (${unixToUtcText(plan.activateAt)}).`);
    expect(await buildNextGraphActivationTx(c(t), t.w.launch, plan, opts)).toBeNull();

    t.setClock(plan.activateAt);
    s = await getGraphActivationStatus(c(t), t.w.launch, plan);
    expect([s.stage, s.next, s.secondsLeft]).toEqual(["due", "apply-pending", 0n]);
    next = await buildNextGraphActivationTx(c(t), t.w.launch, plan, opts);
    if (next?.step !== "apply-pending") throw new Error(`expected apply-pending, got ${next?.step}`);
    expect([...apData(next.result).subarray(0, 8)]).toEqual(disc("apply_pending"));

    t.value["activeGraph"] = H2;
    t.value["pendingGraph"] = zero32;
    t.value["pendingActivateAt"] = 0n;
    t.put();
    s = await getGraphActivationStatus(c(t), t.w.launch, plan);
    expect([s.stage, s.next, s.applyAt]).toEqual(["active", "done", null]);
    expect(s.plain).toBe("This plan is running.");
    expect(await buildNextGraphActivationTx(c(t), t.w.launch, plan, opts)).toBeNull();
  });

  it("a replacement queued says the 72-hour wait; frozen; superseded by a newer change or by a start time that passed", async () => {
    const t = flowWorld({ autopilot: true, active: H1 });
    t.publish(H2, G2);
    const plan = await planGraphActivation(c(t), t.w.launch, G2);
    t.authorize(1, plan.payloadHash, { slot: 500n });
    expect((await getGraphActivationStatus(c(t), t.w.launch, plan)).stage).toBe("ready-to-activate");

    // A newer activation was used: this approval can no longer be.
    (t.value["authMarks"] as unknown[])[0] = { slot: 501n, key: key("flow/newer") };
    t.put();
    let s = await getGraphActivationStatus(c(t), t.w.launch, plan);
    expect([s.stage, s.next, s.applyAt]).toEqual(["superseded", "none", null]);
    expect(await buildNextGraphActivationTx(c(t), t.w.launch, plan, { payer: PAYER })).toBeNull();

    // Queued (a replacement): the plain line mentions the wait.
    t.value["pendingGraph"] = H2;
    t.value["pendingActivateAt"] = plan.activateAt;
    t.put();
    s = await getGraphActivationStatus(c(t), t.w.launch, plan);
    expect([s.stage, s.secondsLeft]).toEqual(["queued", 259_800n]);
    expect(s.plain).toBe(`Scheduled: this plan switches on in about 3 days (${unixToUtcText(plan.activateAt)}). Changes to a running plan wait 72 hours so everyone can see them coming.`);

    // Frozen (the freeze cancels the queued graph).
    t.value["pendingGraph"] = zero32;
    t.value["frozen"] = true;
    t.put();
    s = await getGraphActivationStatus(c(t), t.w.launch, plan);
    expect([s.stage, s.next]).toEqual(["frozen", "none"]);
    expect(s.plain).toMatch(/locked for good/);

    // A first graph whose start time passed before it was queued.
    const f = flowWorld({ autopilot: true });
    f.publish(H2, G2);
    const first = await planGraphActivation(c(f), f.w.launch, G2);
    f.authorize(1, first.payloadHash);
    f.setClock(first.activateAt + 1n);
    s = await getGraphActivationStatus(c(f), f.w.launch, first);
    expect([s.stage, s.next]).toEqual(["superseded", "none"]);
    expect(s.plain).toMatch(/start time in this plan is too early now/);
  });

  it("a large graph is published in a v1 transaction by the throwaway payer; a modified plan is refused", async () => {
    const t = flowWorld({ autopilot: true });
    const recipients = Array.from({ length: 8 }, (_, i) => wallet(`flow/r${i}`));
    let big = graph();
    recipients.forEach((r) => (big = big.recipient(r, 1_250)));
    big = big.node("d", every("1h"), null, distributeSol(1));
    for (let i = 0; i < 15; i++) big = big.node(`b${i}`, every("1h"), when.treasurySolGte(i + 1), burn(1));
    const bigBytes = compileGraph(big.build());
    expect(bigBytes.length).toBeGreaterThan(PUBLISH_GRAPH_LEGACY_MAX_BYTES);
    const plan = await planGraphActivation(c(t), t.w.launch, bigBytes);
    await expect(buildNextGraphActivationTx(c(t), t.w.launch, plan, { payer: PAYER })).rejects.toThrow(/pass throwaway/);
    const next = await buildNextGraphActivationTx(c(t), t.w.launch, plan, { payer: PAYER, throwaway: Keypair.generate() });
    if (next?.step !== "publish-graph" || next.result.status !== "ready") throw new Error("expected a v1 publish");
    expect(next.result.tx).toBeInstanceOf(Uint8Array);
    const tampered: GraphActivationPlan = { ...plan, activateAt: plan.activateAt + 1n };
    await expect(getGraphActivationStatus(c(t), t.w.launch, tampered)).rejects.toThrow(/modified plan/);
  });
});

// ------------------------------------------------------------------ freeze ---

describe("planFreeze", () => {
  it("default: the running graph, usable until the cluster time plus an hour; the plan names the approval it needs", async () => {
    const t = flowWorld({ autopilot: true, active: H1 });
    const plan = await planFreeze(c(t), t.w.launch);
    expect(plan.kind).toBe(2);
    expect(plan.notAfter).toBe(BigInt(NOW) + 3_600n);
    expect(plan.notAfter).toBe(BigInt(NOW) + FREEZE_DEFAULT_VALID_SECS);
    expect(plan.graphHash).toEqual(H1);
    expect(plan.autopilot.equals(t.ap)).toBe(true);
    expect(plan.payloadHash).toEqual(freezePayload(t.ap, H1, plan.notAfter));
    expect(plan.authorization.equals(authorizationAddress(t.w.launch, 2, plan.payloadHash))).toBe(true);
    expect(plan.cancelsPendingGraph).toBe(false);
    // The window follows the cluster clock.
    t.setClock(BigInt(NOW) + 50n);
    expect((await planFreeze(c(t), t.w.launch)).notAfter).toBe(BigInt(NOW) + 3_650n);
  });

  it("validForSecs or an explicit notAfter (not both); a past notAfter, Frozen and NoActiveGraph are refused up front", async () => {
    const t = flowWorld({ autopilot: true, active: H1 });
    expect((await planFreeze(c(t), t.w.launch, { validForSecs: 600 })).notAfter).toBe(BigInt(NOW) + 600n);
    expect((await planFreeze(c(t), t.w.launch, { validForSecs: 86_400n })).notAfter).toBe(BigInt(NOW) + 86_400n);
    expect((await planFreeze(c(t), t.w.launch, { notAfter: BigInt(NOW) })).notAfter).toBe(BigInt(NOW));
    await expect(planFreeze(c(t), t.w.launch, { notAfter: BigInt(NOW) - 1n })).rejects.toThrow(/has already passed.*FreezeExpired/);
    await expect(planFreeze(c(t), t.w.launch, { notAfter: BigInt(NOW) + 10n, validForSecs: 10 })).rejects.toThrow(/not both/);
    for (const bad of [0, -1, 1.5, 0n]) await expect(planFreeze(c(t), t.w.launch, { validForSecs: bad })).rejects.toThrow(/validForSecs/);
    await expect(planFreeze(c(t), t.w.launch, { notAfter: NOW as unknown as bigint })).rejects.toThrow(TypeError);
    // A queued graph is cancelled by the freeze.
    t.value["pendingGraph"] = H2;
    t.value["pendingActivateAt"] = BigInt(NOW) + 300_000n;
    t.put();
    expect((await planFreeze(c(t), t.w.launch)).cancelsPendingGraph).toBe(true);
    t.value["frozen"] = true;
    t.put();
    await expect(planFreeze(c(t), t.w.launch)).rejects.toThrow(/already frozen forever \(Frozen\)/);
    await expect(planFreeze(c(flowWorld({ autopilot: true })), t.w.launch)).rejects.toThrow(/nothing to freeze \(NoActiveGraph\)/);
    await expect(planFreeze(c(flowWorld()), t.w.launch)).rejects.toThrow(/no autopilot/);
  });
});

describe("getFreezeStatus + buildNextFreezeTx", () => {
  const apData = (tx: Transaction) => tx.instructions.find((i) => i.programId.equals(AP))!.data;
  const disc = (name: string): number[] => IDLS.autopilot.instructions.find((i) => i.name === name)!.discriminator;

  it("authorize (the PQ identity signs kind 2 until notAfter) -> freeze(notAfter) -> frozen", async () => {
    const t = flowWorld({ autopilot: true, active: H1 });
    const plan = await planFreeze(c(t), t.w.launch);
    const ledger = createMemoryLeafLedger();
    const opts = { payer: PAYER, identity, ledger, creator: t.w.launchState["creator"] as PublicKey, allowLocalnet: true };

    let s = await getFreezeStatus(c(t), t.w.launch, plan);
    expect([s.stage, s.next, s.expiresAt, s.secondsLeft]).toEqual(["awaiting-authorization", "authorize", plan.notAfter, 3_600n]);
    expect(s.plain).toBe(`Next, approve locking automation with your launch's quantum key. This plan can be used for about 1 hour, until ${unixToUtcText(plan.notAfter)}.`);
    expect([plan.notAfterIso, s.expiresAtIso]).toEqual([unixToIso(plan.notAfter), unixToIso(plan.notAfter)]);
    await expect(buildNextFreezeTx(c(t), t.w.launch, plan, { payer: PAYER })).rejects.toThrow(/identity and its leaf ledger/);
    let next = await buildNextFreezeTx(c(t), t.w.launch, plan, opts);
    if (next?.step !== "authorize") throw new Error(`expected authorize, got ${next?.step}`);
    expect(next.result.status).toBe("ready");
    expect(next.result.kind).toBe(2);
    expect(next.result.payloadHash).toEqual(plan.payloadHash);
    expect(next.result.freezeNotAfter).toBe(plan.notAfter);
    expect(next.result.authorizationAddress.equals(plan.authorization)).toBe(true);

    t.authorize(2, plan.payloadHash, { empty: true });
    s = await getFreezeStatus(c(t), t.w.launch, plan);
    expect([s.stage, s.next]).toEqual(["authorization-burned", "authorize"]);

    t.authorize(2, plan.payloadHash);
    s = await getFreezeStatus(c(t), t.w.launch, plan);
    expect([s.stage, s.next, s.secondsLeft]).toEqual(["ready-to-freeze", "freeze", 3_600n]);
    expect(s.plain).toBe(`Approved. Next, lock it (anyone can send this step). The approval expires in about 1 hour, at ${unixToUtcText(plan.notAfter)}.`);
    next = await buildNextFreezeTx(c(t), t.w.launch, plan, opts);
    if (next?.step !== "freeze") throw new Error(`expected freeze, got ${next?.step}`);
    expect([...apData(next.result).subarray(0, 8)]).toEqual(disc("freeze"));
    expect(apData(next.result).readBigInt64LE(8)).toBe(plan.notAfter);
    expect(next.result.instructions.find((i) => i.programId.equals(AP))!.keys[2]!.pubkey.equals(plan.authorization)).toBe(true);

    // At not_after exactly: still usable.
    t.setClock(plan.notAfter);
    s = await getFreezeStatus(c(t), t.w.launch, plan);
    expect([s.stage, s.secondsLeft]).toEqual(["ready-to-freeze", 0n]);
    expect((await buildNextFreezeTx(c(t), t.w.launch, plan, opts))?.step).toBe("freeze");
    // A landing margin refuses to build it (plain error).
    await expect(buildNextFreezeTx(c(t), t.w.launch, plan, { ...opts, landingMarginSecs: 1n })).rejects.toThrow(/the freeze approval expired at .*sign a new one.*FreezeExpired/);

    // freeze landed.
    t.value["frozen"] = true;
    (t.value["authMarks"] as unknown[])[1] = { slot: 400_000_000n, key: plan.authorization };
    t.put();
    s = await getFreezeStatus(c(t), t.w.launch, plan);
    expect([s.stage, s.next, s.expiresAt, s.secondsLeft]).toEqual(["frozen", "done", null, null]);
    expect(s.plain).toBe("Locked for good: the running plan can never change again.");
    expect(await buildNextFreezeTx(c(t), t.w.launch, plan, opts)).toBeNull();
  });

  it("expired once the cluster clock is past notAfter (plan again); never signed with less than the landing margin left", async () => {
    const t = flowWorld({ autopilot: true, active: H1 });
    const plan = await planFreeze(c(t), t.w.launch);
    const ledger = createMemoryLeafLedger();
    const opts = { payer: PAYER, identity, ledger, creator: t.w.launchState["creator"] as PublicKey, allowLocalnet: true };

    // 59 s left: the approval is not signed (default margin 60 s), no leaf reserved.
    t.setClock(plan.notAfter - 59n);
    expect((await getFreezeStatus(c(t), t.w.launch, plan)).stage).toBe("awaiting-authorization");
    await expect(buildNextFreezeTx(c(t), t.w.launch, plan, opts)).rejects.toThrow(/refusing to sign: this freeze approval would expire at .*Plan a new freeze/);
    expect(await ledger.list(identity.identityId)).toEqual([]);
    // With a smaller margin it is.
    const next = await buildNextFreezeTx(c(t), t.w.launch, plan, { ...opts, landingMarginSecs: 59n });
    expect(next?.step === "authorize" && next.result.status).toBe("ready");

    // Past notAfter: expired, nothing to build, whether approved or not.
    t.setClock(plan.notAfter + 1n);
    let s = await getFreezeStatus(c(t), t.w.launch, plan);
    expect([s.stage, s.next, s.expiresAt, s.secondsLeft]).toEqual(["expired", "none", plan.notAfter, 0n]);
    expect(s.plain).toBe(`This freeze approval expired at ${unixToUtcText(plan.notAfter)} (an approval to lock automation only works for a limited time). Plan the freeze again and approve the new plan.`);
    expect(await buildNextFreezeTx(c(t), t.w.launch, plan, opts)).toBeNull();
    t.authorize(2, plan.payloadHash);
    s = await getFreezeStatus(c(t), t.w.launch, plan);
    expect(s.stage).toBe("expired");
    expect(await buildNextFreezeTx(c(t), t.w.launch, plan, opts)).toBeNull();
    // A new plan from now works again.
    const fresh = await planFreeze(c(t), t.w.launch);
    expect(fresh.notAfter).toBe(plan.notAfter + 1n + 3_600n);
    expect((await getFreezeStatus(c(t), t.w.launch, fresh)).stage).toBe("awaiting-authorization");
  });

  it("superseded: the running graph changed, a newer activation was used, or frozen on another graph; a modified plan is refused", async () => {
    const t = flowWorld({ autopilot: true, active: H1 });
    const plan = await planFreeze(c(t), t.w.launch);
    t.authorize(2, plan.payloadHash, { slot: 500n });
    expect((await getFreezeStatus(c(t), t.w.launch, plan)).stage).toBe("ready-to-freeze");

    // A newer activation was used: a freeze signed before it can't cancel it.
    (t.value["authMarks"] as unknown[])[0] = { slot: 501n, key: key("flow/newer") };
    t.put();
    let s = await getFreezeStatus(c(t), t.w.launch, plan);
    expect([s.stage, s.next, s.expiresAt]).toEqual(["superseded", "none", null]);
    expect(s.plain).toMatch(/newer change was scheduled after this approval/);
    expect(await buildNextFreezeTx(c(t), t.w.launch, plan, { payer: PAYER })).toBeNull();

    // Another graph took over.
    t.value["activeGraph"] = H2;
    t.put();
    s = await getFreezeStatus(c(t), t.w.launch, plan);
    expect([s.stage, s.next]).toEqual(["superseded", "none"]);
    expect(s.plain).toMatch(/running plan changed since this freeze was planned/);

    // Frozen on that other graph.
    t.value["frozen"] = true;
    t.put();
    s = await getFreezeStatus(c(t), t.w.launch, plan);
    expect([s.stage, s.next]).toEqual(["superseded", "none"]);
    expect(s.plain).toMatch(/already locked with a different plan/);

    const tampered: FreezePlan = { ...plan, notAfter: plan.notAfter + 1n };
    await expect(getFreezeStatus(c(t), t.w.launch, tampered)).rejects.toThrow(/modified plan/);
    await expect(getFreezeStatus(c(t), key("flow/other-launch"), plan)).rejects.toThrow(/another launch/);
  });
});

// ------------------------------------------------------------------ keeper ---

/** A keeper buyback every hour, and an operator-only buyback the keeper must leave alone. */
const KG = compileGraph(
  graph({ operator: OPERATOR })
    .node("buy", every("1h"), when.graduated(), buybackBurn({ maxIn: 1, maxPremiumBps: 300 }), { maxRunsPerEpoch: 24, budgetPerEpoch: 24 })
    .node("ai", whenever(), when.graduated(), buybackBurn({ maxIn: 0.5 }), { operatorGated: true, budgetPerEpoch: 2, maxRunsPerEpoch: 4 })
    .build(),
);
const KH = graphHash(KG);

interface KeeperWorld {
  w: World;
  value: Record<string, unknown>;
  put(): void;
  now: number;
  setClock(unix: number): void;
}

/** A graduated launch whose autopilot runs `KG`, with no price observed yet (NOW is the start of a 15-minute bucket). */
function keeperWorld(): KeeperWorld {
  const w = world();
  const p = autopilotPdas(w.launch, w.mint);
  const pool = dammV2PoolAddress(DAMM_V2_MIGRATION_CONFIGS[2]!, w.mint, WSOL_MINT);
  const value = autopilotValue(w, { active: KH, graduated: true, pool });
  value["operator"] = OPERATOR;
  const t: KeeperWorld = {
    w,
    value,
    now: NOW,
    put() {
      w.conn.set(p.autopilot, { owner: AP, data: accountBytes("autopilot", "Autopilot", value) });
    },
    setClock(unix) {
      t.now = unix;
      w.conn.set(SYSVAR_CLOCK, { owner: SYSVAR_OWNER, data: clock(unix) });
    },
  };
  t.put();
  w.conn.set(graphRecordAddress(w.launch, KH), { owner: AP, data: accountBytes("autopilot", "GraphRecord", { version: 1, bump: 255, launch: w.launch, graphHash: KH, bytes: KG }) });
  w.conn.set(p.treasuryWsol, { owner: SPL, data: tokenAccountBytes({ mint: WSOL_MINT, owner: p.treasury, amount: 50n * SOL }) });
  w.conn.set(p.treasuryToken!, { owner: T22, data: tokenAccountBytes({ mint: w.mint, owner: p.treasury, amount: 5_000_000_000n, token2022: true }) });
  const poolState = zeroed("dammV2", "Pool");
  Object.assign(poolState, { tokenAMint: w.mint, tokenBMint: WSOL_MINT, tokenAVault: key("flow/va"), tokenBVault: key("flow/vb"), creator: KNOWN_ACCOUNTS.dbcPoolAuthority, sqrtPrice: REF });
  w.conn.set(pool, { owner: PROGRAM_IDS.dammV2, data: accountBytes("dammV2", "Pool", poolState) });
  w.conn.set(key("flow/vb"), { owner: SPL, data: tokenAccountBytes({ mint: WSOL_MINT, owner: KNOWN_ACCOUNTS.dammV2PoolAuthority, amount: 200n * SOL }) });
  return t;
}

/** What `update_price` at `now` records (the first observation of the bucket). */
function observeAt(t: KeeperWorld, now: number): void {
  t.value["observations"] = [{ index: BigInt(Math.floor(now / 900)), firstAt: BigInt(now), min: REF, max: REF }, { index: 0n, firstAt: 0n, min: 0n, max: 0n }];
  t.put();
}

const ixName = (tx: Transaction): string => {
  const ix = tx.instructions.find((i) => i.programId.equals(AP))!;
  return IDLS.autopilot.instructions.find((i) => i.discriminator.every((b, j) => ix.data[j] === b))!.name;
};

describe("planKeeperStep", () => {
  const caller = key("flow/keeper");

  it("a buyback waiting for a price check: the keeper's OWN update_price, then a minute's wait, then the run (never the operator's step)", async () => {
    const t = keeperWorld();
    const conn = t.w.conn.asConnection();
    let step = await planKeeperStep(conn, caller, t.w.launch);
    expect(step.kind).toBe("update-price");
    if (step.kind !== "update-price") throw new Error("unreachable");
    expect([step.thenWaitSecs, step.because]).toEqual([60, "no-own-check"]);
    expect(KEEPER_OBSERVATION_WAIT_SECS).toBe(60);
    expect(KEEPER_OBSERVER_INTERVAL_SECS).toBe(600);
    expect(ixName(step.tx)).toBe("update_price");
    expect(step.detail).toMatch(/step 0\)/);
    expect(step.costs).toEqual({ signatureFeeLamports: 5_000n, priorityFeeLamports: 0n, rentLamports: 0n, totalLamports: 5_000n });

    observeAt(t, NOW);
    const own = { ownObservationAt: BigInt(NOW) };
    step = await planKeeperStep(conn, caller, t.w.launch, own);
    expect(step).toMatchObject({ kind: "wait", untilSecs: BigInt(NOW + 60) });

    t.setClock(NOW + 59);
    expect((await planKeeperStep(conn, caller, t.w.launch, own)).kind).toBe("wait");
    t.setClock(NOW + 60);
    step = await planKeeperStep(conn, caller, t.w.launch, own);
    expect(step.kind).toBe("run");
    if (step.kind !== "run") throw new Error("unreachable");
    expect(step.node).toBe(0);
    expect(step.run.action).toBe("buybackBurn");
    expect(step.run.operatorGated).toBe(false);
    expect(ixName(step.tx)).toBe("run");
    // Costs stated: the fee and its own tip account's rent (created once), never a recipient's; the tip it should earn.
    expect(step.costs).toEqual(step.run.costs);
    expect(step.costs.signatureFeeLamports).toBe(5_000n);
    expect(step.expectedTipLamports).toBeGreaterThan(0n);
    expect(step.expectedTipLamports).toBeLessThanOrEqual(100_000n);
    expect(step.detail).toMatch(/Costs about \d+ lamports; the tip should be about \d+/);
  });

  it("audit 4, OBS: never a buyback on others' observations alone: the keeper makes its own check first, even when observations exist", async () => {
    const t = keeperWorld();
    observeAt(t, NOW - 600); // someone else's observation, ten minutes old: the program would accept a buyback now
    const conn = t.w.conn.asConnection();
    const step = await planKeeperStep(conn, caller, t.w.launch);
    expect(step).toMatchObject({ kind: "update-price", because: "no-own-check" });
    // An own check older than the window (the previous bucket) does not count.
    expect(await planKeeperStep(conn, caller, t.w.launch, { ownObservationAt: BigInt(NOW - 3_600) })).toMatchObject({ kind: "update-price", because: "own-check-too-old" });
    // A minute-old own check the program never saw (no observation in the window): checked again.
    const u = keeperWorld();
    expect(await planKeeperStep(u.w.conn.asConnection(), caller, u.w.launch, { ownObservationAt: BigInt(NOW - 120) })).toMatchObject({ kind: "update-price", because: "own-check-not-seen" });
  });

  it("never a buyback judged due at a later time while the keeper's own observation is under a minute old", async () => {
    const t = keeperWorld();
    observeAt(t, NOW - 30);
    const step = await planKeeperStep(t.w.conn.asConnection(), caller, t.w.launch, { now: NOW + 100, ownObservationAt: BigInt(NOW - 30) });
    expect(step).toMatchObject({ kind: "wait", untilSecs: BigInt(NOW + 30) });
  });

  it("a due queued graph is applied before anything else; no autopilot is idle", async () => {
    const t = keeperWorld();
    observeAt(t, NOW - 600);
    t.value["pendingGraph"] = KH;
    t.value["pendingActivateAt"] = BigInt(NOW - 1);
    t.put();
    const step = await planKeeperStep(t.w.conn.asConnection(), caller, t.w.launch);
    expect(step.kind).toBe("apply-pending");
    if (step.kind !== "apply-pending") throw new Error("unreachable");
    expect(ixName(step.tx)).toBe("apply_pending");
    expect(await planKeeperStep(t.w.conn.asConnection(), caller, key("flow/no-launch"))).toMatchObject({ kind: "idle", detail: "This launch has no autopilot." });
  });
});

describe("runKeeper", () => {
  it("update_price -> wait at least a minute -> run -> idle, sending each step once", async () => {
    const t = keeperWorld();
    const sent: string[] = [];
    const slept: number[] = [];
    const result = await runKeeper(t.w.conn.asConnection(), {
      caller: Keypair.fromSeed(new Uint8Array(32).fill(4)),
      launch: t.w.launch,
      send: async (tx) => {
        const name = ixName(tx);
        sent.push(name);
        if (name === "update_price") observeAt(t, t.now);
        if (name === "run") {
          const nodes = t.value["nodes"] as Record<string, unknown>[];
          nodes[0] = { lastRun: BigInt(t.now), lastSeq: 1n, epochStart: BigInt(t.now), runsInEpoch: 1, spentInEpoch: SOL };
          t.value["seq"] = 1n;
          t.put();
        }
        return `sig-${sent.length}`;
      },
      sleep: async (ms) => {
        slept.push(ms);
        t.setClock(t.now + Math.ceil(ms / 1_000));
      },
    });
    expect(result.stopped).toBe("idle");
    expect(result.steps.map((s) => s.kind)).toEqual(["update-price", "wait", "run", "idle"]);
    expect(sent).toEqual(["update_price", "run"]);
    expect(result.signatures).toEqual(["sig-1", "sig-2"]);
    expect(result.steps[2]!.node).toBe(0);
    expect(slept).toEqual([61_000]);
    expect(t.now).toBeGreaterThanOrEqual(NOW + 60);
    // What it cost: two fees and the keeper's own tip account (created by its first run), never a recipient's.
    expect(result.costLamports).toBe(5_000n + 5_000n + result.steps[2]!.costs!.rentLamports);
    expect(result.steps[2]!.expectedTipLamports).toBeGreaterThan(0n);
  });

  it("stops on a failed send, and when a price check does not count", async () => {
    const t = keeperWorld();
    const failing = await runKeeper(t.w.conn.asConnection(), {
      caller: Keypair.generate(),
      launch: t.w.launch,
      send: async () => {
        throw new Error("blockhash expired");
      },
      sleep: async () => undefined,
    });
    expect([failing.stopped, failing.detail]).toEqual(["error", "sending failed: blockhash expired"]);
    // Its own price check never shows up on-chain (sent, but nothing observed): it stops after the minute.
    const noEffect = await runKeeper(t.w.conn.asConnection(), {
      caller: Keypair.generate(),
      launch: t.w.launch,
      send: async () => "sig",
      sleep: async (ms) => void t.setClock(t.now + Math.ceil(ms / 1_000)),
    });
    expect(noEffect.stopped).toBe("error");
    expect(noEffect.signatures).toEqual(["sig"]);
    expect(noEffect.steps.map((s) => s.kind)).toEqual(["update-price", "wait"]);
    expect(noEffect.detail).toMatch(/price check did not count/);
  });
});

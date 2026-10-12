/**
 * "Back into the token" through the creator's launch flow (lib/launchFlow.ts) on the simulated chain:
 *   - the fee recipients name the launch's own Autopilot treasury (known before the launch exists) and create_launch
 *     accepts it;
 *   - after the launch opens, the flow switches the buyback on from the temporary account, signed by the quantum key
 *     (pq_authorize at the identity's next one-time key), with no waiting period for a first autopilot, and applies it at
 *     its start; still only the two wallet reviews of every launch;
 *   - fees distributed afterwards reach the treasury the autopilot spends (all of the creator share, or the split's);
 *   - where Autopilot is not live (live builds), a launch with one, or with fees to the token, is refused before
 *     anything is created, paid for or shown to the wallet.
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { backend as mock } from "../src/lib/backend/mock";
import { programmableLive } from "../src/lib/backend/programmableLive";
import {
  AUTOPILOT_LEAD_SECS,
  AUTOPILOT_NOT_LIVE,
  configureLaunchFlows,
  estimateLaunchFunding,
  FEES_TO_TOKEN_NOT_LIVE,
  memoryLaunchStore,
  OPEN_LEAD_SECS,
  resetLaunchFlowsForTests,
  runnerForTests,
  startLaunchFlow,
  type FlowEnv,
  type LaunchProgressStore,
  type WalletStep,
} from "../src/lib/launchFlow";
import { seedState } from "../src/lib/mock/fixtures";
import { resetProgrammableForTests } from "../src/lib/mock/programmable";
import { replaceStateForTests, state } from "../src/lib/mock/store";
import * as adapter from "../src/lib/noised";
import { activationPayload, AUTH_KIND, graphHashOf } from "../src/lib/programmable";
import { buybackBuild, launchTreasury } from "../src/pages/create/quick";
import { TEST_PHRASE } from "./support/records";

const phx = { ...adapter, ...mock };
const conn = new Connection("http://127.0.0.1:8899");
const SOL = 1_000_000_000n;
const nowSecs = (): number => Math.floor(Date.now() / 1000);

let identity: adapter.PqIdentity;
beforeAll(async () => {
  identity = await adapter.pqIdentity.deriveIdentityFromPhrase(TEST_PHRASE, "devnet", 0);
}, 120_000);

let creator: PublicKey;
let store: LaunchProgressStore;
let ledger: adapter.LeafLedger;
let walletCalls: WalletStep[];

function env(over: Partial<FlowEnv> = {}): FlowEnv {
  return {
    conn,
    cluster: "devnet",
    store,
    backend: phx,
    wallet: () => creator,
    walletTx: async (step) => {
      walletCalls.push(step);
      const tx = await step.build();
      const sim = await phx.simulateAndExplain(conn, tx);
      if (!sim.ok) return { status: "failed", error: sim.error ?? "?" };
      return { status: "confirmed", signature: await phx.sendAndConfirm(conn, tx) };
    },
    signer: async () => ({ identity, leaves: ledger }),
    keyUnlocked: () => true,
    now: async () => BigInt(nowSecs()),
    clusterRefusal: async () => null,
    lock: (_name, fn) => fn(),
    ...over,
  };
}

async function land(tx: adapter.AnyTransaction): Promise<string> {
  const sim = await phx.simulateAndExplain(conn, tx);
  if (!sim.ok) throw new Error(`simulation failed: ${sim.error ?? "?"}`);
  return phx.sendAndConfirm(conn, tx);
}

function demoUser(): PublicKey {
  const u = Keypair.generate().publicKey;
  phx.fundDemoWallet(u);
  return u;
}

/** Fair preset, the creator's identity, the given recipients. */
const params = (recipients: adapter.FeeRecipient[]): adapter.LaunchParams => ({ ...adapter.PRESETS.fair.params, recipients, pqIdentity: identity.identityId });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  replaceStateForTests(seedState());
  resetProgrammableForTests();
  creator = Keypair.generate().publicKey;
  phx.fundDemoWallet(creator);
  store = memoryLaunchStore();
  ledger = adapter.leafLedger.createMemoryLeafLedger();
  walletCalls = [];
});

afterEach(() => {
  resetLaunchFlowsForTests();
  vi.useRealTimers();
});

/** Runs a launch with the buyback through to "done"; returns its address and the buyback's fingerprint. */
async function launchWithBuyback(recipients: (treasury: PublicKey) => adapter.FeeRecipient[]): Promise<{ launch: PublicKey; hash: Uint8Array; id: string }> {
  configureLaunchFlows(env());
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const { launch, treasury } = launchTreasury(creator, seed);
  const p = params(recipients(treasury));
  const graph = buybackBuild(p.tokenDecimal);
  if (!graph.ok) throw new Error("buyback does not build");
  const id = await startLaunchFlow({ cluster: "devnet", creator, params: p, metadata: { name: "Burn Back", symbol: "BURN" }, identityIndex: 0, lmsPublicKey: identity.keyPair.publicKey, opensAt: "asap", launchSeed: seed, autopilot: graph.bytes });
  const r = runnerForTests(id);
  if (!r) throw new Error("no runner");
  await r.kick();
  expect(r.snapshot().stage).toBe("open");
  expect(r.snapshot().autopilot).toBe(true);
  expect(r.snapshot().launch.equals(launch)).toBe(true);
  // Opens at its time; then the Autopilot is switched on from the temporary account.
  vi.setSystemTime(Date.now() + (Number(OPEN_LEAD_SECS) + 1) * 1_000);
  await r.kick();
  let v = r.snapshot();
  expect(v.mint).not.toBeNull();
  expect(v.stage).toBe("autopilot");
  expect(v.done).toBe(false);
  // Signed and queued: a first autopilot needs no waiting period, only the room to land (two minutes).
  const info = await phx.programmable.fetchAutopilot(conn, launch);
  expect(info?.pending?.graphHash).toEqual(graph.hash);
  const at = info?.pending?.activateAt ?? 0;
  expect(at - nowSecs()).toBeLessThanOrEqual(Number(AUTOPILOT_LEAD_SECS));
  expect(at).toBeGreaterThanOrEqual(nowSecs());
  expect(v.autopilotAt).toBe(BigInt(at));
  // The quantum key signed exactly that start (kind 1, the program's payload) at its next one-time key.
  const auth = await phx.programmable.fetchAuthorization(conn, launch, AUTH_KIND.GRAPH_ACTIVATE, activationPayload(adapter.autopilotAddress(launch), graph.hash, at).hash);
  expect(auth).not.toBeNull();
  const used = await phx.programmable.fetchIdentityLeaves(conn, identity.identityId);
  expect(used.reduce((n, b) => n + [...b.toString(2)].filter((c) => c === "1").length, 0)).toBe(2); // the launch, then the autopilot
  // At its start the flow applies it, then returns the leftover SOL.
  vi.setSystemTime((at + 1) * 1_000);
  await r.kick();
  v = r.snapshot();
  expect(v.done).toBe(true);
  expect(v.abandoned).toBe(false);
  const on = await phx.programmable.fetchAutopilot(conn, launch);
  expect(on?.graphHash).toEqual(graph.hash);
  expect(on?.pending).toBeNull();
  expect(on?.frozen).toBe(false);
  // Still the two wallet reviews of every launch: the temporary account paid for the Autopilot.
  expect(walletCalls.map((w) => w.title)).toEqual(["Create the BURN launch (1 of 2)", "Fund the temporary fee account (2 of 2)"]);
  const progress = await store.get(id);
  expect(progress?.autopilotDone).toBe(true);
  expect(progress?.payerSecret).toBeNull();
  // init, publish, the quantum signature, activate, apply.
  expect(progress?.sent.autopilot).toHaveLength(5);
  return { launch, hash: graph.hash, id };
}

/** Trading after the batch, then fees claimed and distributed (anyone may). Returns the creator share in lamports. */
async function tradeAndDistribute(launch: PublicKey): Promise<{ creatorShare: bigint }> {
  const live = await phx.fetchLaunch(conn, launch);
  if (!live) throw new Error("no launch");
  const alice = demoUser();
  await land(await phx.buildCommitTx(conn, alice, launch, 2n * SOL));
  vi.setSystemTime(new Date(Number(live.commitEndTs) * 1000 + 2_000));
  const cranker = demoUser();
  await land(await phx.buildExecuteBatchTx(conn, cranker, launch));
  vi.setSystemTime(new Date(Number(live.executeEndTs) * 1000 + 1_000));
  await land((await phx.buildSwapTx(conn, cranker, live.baseMint, "buy", SOL / 50n, 300)).tx);
  await land(await phx.buildClaimFeesTx(conn, cranker, launch));
  const l = state().launches[launch.toBase58()];
  if (!l) throw new Error("no mock launch");
  const collected = l.authorityQuote;
  expect(collected).toBeGreaterThan(0n);
  const split = phx.splitFees(collected, l.state.platformFeeBps, l.state.recipients.slice(0, l.state.recipientCount));
  if (!split) throw new Error("no split");
  await land(await phx.buildDistributeTx(conn, cranker, launch));
  return { creatorShare: split.recipients.reduce((a, b) => a + b, 0n) };
}

describe("fees back into the token (demo)", () => {
  it("launches, switches the daily buyback on with the quantum key, and every distributed fee reaches the treasury it spends", async () => {
    const { launch, hash } = await launchWithBuyback((treasury) => [{ wallet: treasury, bps: 10_000 }]);
    const before = (await phx.programmable.fetchAutopilot(conn, launch))?.treasurySol ?? -1n;
    expect(before).toBe(0n);
    const creatorWsol = await phx.getTokenBalance(conn, creator, phx.WSOL_MINT);
    const { creatorShare } = await tradeAndDistribute(launch);
    const after = await phx.programmable.fetchAutopilot(conn, launch);
    expect(after?.treasurySol).toBe(creatorShare);
    expect(after?.graphHash).toEqual(hash);
    // Nothing went to the creator's wallet.
    expect(await phx.getTokenBalance(conn, creator, phx.WSOL_MINT)).toBe(creatorWsol);
    // Before graduation the buyback is not due (it buys from the locked pool only after graduation).
    expect(await phx.programmable.findDueSteps(conn, launch)).toEqual([]);
  }, 120_000);

  it("a split pays the wallet its share and the treasury the rest", async () => {
    const { launch } = await launchWithBuyback((treasury) => [
      { wallet: creator, bps: 6_000 },
      { wallet: treasury, bps: 4_000 },
    ]);
    const wsolBefore = await phx.getTokenBalance(conn, creator, phx.WSOL_MINT);
    await tradeAndDistribute(launch);
    const toWallet = (await phx.getTokenBalance(conn, creator, phx.WSOL_MINT)) - wsolBefore;
    const toTreasury = (await phx.programmable.fetchAutopilot(conn, launch))?.treasurySol ?? 0n;
    expect(toWallet).toBeGreaterThan(0n);
    expect(toTreasury).toBeGreaterThan(0n);
    // 60 / 40 (floors of each share: within a lamport).
    const ratio = Number((toWallet * 1_000n) / toTreasury) / 1_000;
    expect(ratio).toBeGreaterThan(1.49);
    expect(ratio).toBeLessThan(1.51);
  }, 120_000);

  it("fees paid to the treasury before its autopilot exists are the autopilot's from the start", async () => {
    configureLaunchFlows(env());
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const { launch, treasury } = launchTreasury(creator, seed);
    // Fees to the token, no autopilot yet (it can be set up later from the token's page).
    const id = await startLaunchFlow({ cluster: "devnet", creator, params: params([{ wallet: treasury, bps: 10_000 }]), metadata: { name: "Later", symbol: "LATR" }, identityIndex: 0, lmsPublicKey: identity.keyPair.publicKey, opensAt: "asap", launchSeed: seed });
    const r = runnerForTests(id);
    await r?.kick();
    vi.setSystemTime(Date.now() + (Number(OPEN_LEAD_SECS) + 1) * 1_000);
    await r?.kick();
    expect(r?.snapshot().done).toBe(true);
    expect(r?.snapshot().autopilot).toBe(false);
    const { creatorShare } = await tradeAndDistribute(launch);
    expect(await phx.programmable.fetchAutopilot(conn, launch)).toBeNull();
    await land((await phx.programmable.buildInitAutopilotTx(conn, demoUser(), launch)).tx);
    expect((await phx.programmable.fetchAutopilot(conn, launch))?.treasurySol).toBe(creatorShare);
  }, 120_000);

  it("step 2 already funds the Autopilot: the review's estimate includes it, and no third wallet review is needed", async () => {
    const g = buybackBuild(6);
    if (!g.ok) throw new Error("no graph");
    const metadata = { name: "Burn Back", symbol: "BURN" };
    const without = await estimateLaunchFunding(phx, conn, metadata);
    const withAp = await estimateLaunchFunding(phx, conn, metadata, g.bytes.length);
    expect(without.autopilot).toBe(0n);
    const c = await phx.programmable.autopilotSetupCost(conn, g.bytes.length);
    expect(withAp.autopilot).toBe(c.init + c.publish + c.authorize + c.activate);
    expect(withAp.total - without.total).toBe(withAp.autopilot);
    expect(graphHashOf(g.bytes)).toEqual(g.hash);
  });
});

describe("where Autopilot is not live", () => {
  it("a launch with an Autopilot, or with fees to the token, is refused before anything is created, paid for or shown to the wallet", async () => {
    configureLaunchFlows(env({ backend: { ...phx, programmable: { ...programmableLive, available: false } } }));
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const { treasury } = launchTreasury(creator, seed);
    const g = buybackBuild(6);
    if (!g.ok) throw new Error("no graph");
    const base = { cluster: "devnet" as const, creator, metadata: { name: "Nope", symbol: "NOPE" }, identityIndex: 0, lmsPublicKey: identity.keyPair.publicKey, opensAt: "asap" as const, launchSeed: seed };
    await expect(startLaunchFlow({ ...base, params: params([{ wallet: creator, bps: 10_000 }]), autopilot: g.bytes })).rejects.toThrow(AUTOPILOT_NOT_LIVE);
    await expect(startLaunchFlow({ ...base, params: params([{ wallet: treasury, bps: 10_000 }]) })).rejects.toThrow(FEES_TO_TOKEN_NOT_LIVE);
    await expect(
      startLaunchFlow({
        ...base,
        params: params([
          { wallet: creator, bps: 5_000 },
          { wallet: treasury, bps: 5_000 },
        ]),
      }),
    ).rejects.toThrow(FEES_TO_TOKEN_NOT_LIVE);
    expect(await store.list()).toEqual([]);
    expect(walletCalls).toEqual([]);
    // Wallet-only fees still launch there.
    const id = await startLaunchFlow({ ...base, params: params([{ wallet: creator, bps: 10_000 }]) });
    expect(id).toMatch(/^devnet:/);
  });

  it("steps that do not verify are refused before anything starts", async () => {
    configureLaunchFlows(env());
    await expect(
      startLaunchFlow({ cluster: "devnet", creator, params: params([{ wallet: creator, bps: 10_000 }]), metadata: { name: "Bad", symbol: "BAD" }, identityIndex: 0, lmsPublicKey: identity.keyPair.publicKey, opensAt: "asap", autopilot: Uint8Array.of(1, 2, 3) }),
    ).rejects.toThrow(/do not verify/);
    expect(await store.list()).toEqual([]);
  });
});

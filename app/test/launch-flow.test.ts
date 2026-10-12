/**
 * The creator's launch flow (src/lib/launchFlow.ts) against the simulated
 * chain: create -> fund the temporary account -> store the details ->
 * sign with the quantum key -> open at the signed time -> return the
 * leftover SOL, decided from the chain on every step, resumed from the
 * stored progress after a "reload" (a new runner on the same store), with
 * the SDK's refusals handled in plain words.
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { backend as mock } from "../src/lib/backend/mock";
import {
  chooseWindow,
  configureLaunchFlows,
  decodeParams,
  encodeParams,
  memoryLaunchStore,
  newProgress,
  OPEN_LEAD_SECS,
  payerOf,
  planOf,
  resetLaunchFlowsForTests,
  resumeLaunchFlows,
  runnerForTests,
  startLaunchFlow,
  launchFlowAction,
  WINDOW_SECS,
  type FlowEnv,
  type FlowView,
  type LaunchProgressStore,
  type WalletStep,
} from "../src/lib/launchFlow";
import { seedState } from "../src/lib/mock/fixtures";
import { identityBitmapForTests, refuseNextAttestForTests } from "../src/lib/mock/launchFlow";
import { replaceStateForTests, solBalance, state } from "../src/lib/mock/store";
import * as adapter from "../src/lib/noised";
import { TEST_PHRASE } from "./support/records";

const phx = { ...adapter, ...mock };
const conn = new Connection("http://127.0.0.1:8899");

let identity: adapter.PqIdentity;
beforeAll(async () => {
  identity = await adapter.pqIdentity.deriveIdentityFromPhrase(TEST_PHRASE, "devnet", 0);
}, 60_000);

let creator: PublicKey;
let store: LaunchProgressStore;
let ledger: adapter.LeafLedger;
let unlocked: boolean;
let walletCalls: WalletStep[];
let approve: "yes" | "cancel";

function env(over: Partial<FlowEnv> = {}): FlowEnv {
  return {
    conn,
    cluster: "devnet",
    store,
    backend: phx,
    wallet: () => creator,
    walletTx: async (step) => {
      walletCalls.push(step);
      if (approve === "cancel") return { status: "cancelled" };
      const tx = await step.build();
      const sim = await phx.simulateAndExplain(conn, tx);
      if (!sim.ok) return { status: "failed", error: sim.error ?? "?" };
      return { status: "confirmed", signature: await phx.sendAndConfirm(conn, tx) };
    },
    signer: async () => {
      if (!unlocked) throw new Error("Unlock your quantum key first.");
      return { identity, leaves: ledger };
    },
    keyUnlocked: () => unlocked,
    now: async () => BigInt(Math.floor(Date.now() / 1000)),
    clusterRefusal: async () => null,
    lock: (_name, fn) => fn(),
    ...over,
  };
}

const ICON = new Uint8Array(4 * 32 * 32).map((_, i) => (i % 4 === 3 ? 255 : (i * 37) % 251));

async function newLaunch(opensAt: "asap" | bigint = "asap"): Promise<string> {
  const png = await adapter.encodeIndexedPng(ICON, 32, 32, 16);
  const doc = adapter.buildMetadataDoc({ name: "Flow Test", symbol: "FLOW", description: "A token made by the flow test.", iconPng: png, links: { website: "https://example.org" } });
  const params: adapter.LaunchParams = { ...adapter.PRESETS.fair.params, recipients: [{ wallet: creator, bps: 10_000 }], pqIdentity: identity.identityId };
  return startLaunchFlow({ cluster: "devnet", creator, params, metadata: { name: "Flow Test", symbol: "FLOW", doc }, identityIndex: 0, lmsPublicKey: identity.keyPair.publicKey, opensAt });
}

function runner(id: string): NonNullable<ReturnType<typeof runnerForTests>> {
  const r = runnerForTests(id);
  if (r === null) throw new Error("no runner");
  return r;
}

async function view(id: string): Promise<FlowView> {
  await runner(id).kick();
  return runner(id).snapshot();
}

/** Move the clock (Date only: the runner's own timers stay real and are not awaited). */
function advance(secs: number): void {
  vi.setSystemTime(Date.now() + secs * 1_000);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  replaceStateForTests(seedState());
  creator = Keypair.generate().publicKey;
  phx.fundDemoWallet(creator);
  store = memoryLaunchStore();
  ledger = adapter.leafLedger.createMemoryLeafLedger();
  unlocked = true;
  walletCalls = [];
  approve = "yes";
  configureLaunchFlows(env());
});

afterEach(() => {
  resetLaunchFlowsForTests();
  vi.useRealTimers();
});

describe("the launch flow", () => {
  it("runs every step: create, fund, details, quantum signature, opening at the signed time, leftover back", async () => {
    const before = solBalance(state(), creator);
    const id = await newLaunch();
    let v = await view(id);
    // Two wallet reviews (create, fund), then the details and the signature went by themselves.
    expect(walletCalls.map((w) => w.title)).toEqual(["Create the FLOW launch (1 of 2)", "Fund the temporary fee account (2 of 2)"]);
    expect(v.stage).toBe("open");
    expect(v.activity).toMatch(/Waiting for the opening time/);
    expect(v.window).not.toBeNull();
    const launch = new PublicKey(v.launch);
    const a = await phx.fetchAttestation(conn, launch);
    expect(a?.attested).toBe(true);
    expect(a?.notAfter).toBe((a?.notBefore ?? 0n) + WINDOW_SECS);
    // Opens about OPEN_LEAD_SECS after the signature: inside the window this runner opens it by itself.
    advance(Number(OPEN_LEAD_SECS) + 1);
    v = await view(id);
    expect(v.done).toBe(true);
    expect(v.mint).not.toBeNull();
    const live = await phx.fetchLaunchByMint(conn, v.mint as PublicKey);
    expect(live?.market?.symbol).toBe("FLOW");
    // The record the identity signed is the token's: its document carries the icon and the link.
    const meta = await phx.fetchTokenMetaForMint(conn, v.mint as PublicKey);
    const doc = adapter.parseMetadataDoc(meta?.tokenMeta.doc ?? new Uint8Array(0), { name: "Flow Test", symbol: "FLOW" });
    expect(doc.ok).toBe(true);
    expect(doc.icon?.width).toBe(32);
    expect(doc.links.map((l) => l.host)).toEqual(["example.org"]);
    // The temporary account is empty and its key is gone from the store; the leftover went back.
    const p = await store.get(id);
    expect(p?.payerSecret).toBeNull();
    expect(solBalance(state(), new PublicKey(p?.payer ?? ""))).toBe(0n);
    expect(BigInt(p?.returned ?? "0")).toBeGreaterThan(0n);
    expect(solBalance(state(), creator)).toBeLessThan(before);
    // The temporary account was funded once, for every step, the opening included: two wallet reviews in all.
    expect(walletCalls).toHaveLength(2);
  }, 60_000);

  it("resumes after a reload from the stored progress: same plan, same temporary account, same leaf", async () => {
    unlocked = false;
    const id = await newLaunch();
    let v = await view(id);
    // Created, funded, details stored; the key is locked, so the signature waits.
    expect(v.stage).toBe("sign");
    expect(v.need).toEqual({ kind: "key", message: "Unlock your quantum key to sign your launch." });
    const stored = await store.get(id);
    expect(stored?.payerSecret).toMatch(/^[0-9a-f]{128}$/);
    // A reload: a new page with the same store; the key is unlocked again.
    resetLaunchFlowsForTests();
    unlocked = true;
    configureLaunchFlows(env());
    await resumeLaunchFlows();
    v = await view(id);
    expect(v.stage).toBe("open");
    const again = await store.get(id);
    expect(again?.payer).toBe(stored?.payer);
    expect(again?.launchSeed).toBe(stored?.launchSeed);
    // One signature, one leaf.
    expect(identityBitmapForTests(identity.identityId).reduce((n, b) => n + [...b.toString(2)].filter((x) => x === "1").length, 0)).toBe(1);
  }, 60_000);

  it("never opens the wallet's review by itself after a reload", async () => {
    const params: adapter.LaunchParams = { ...adapter.PRESETS.fair.params, recipients: [{ wallet: creator, bps: 10_000 }], pqIdentity: identity.identityId };
    const p = newProgress({ cluster: "devnet", creator, params, metadata: { name: "Reload", symbol: "RLD" }, identityIndex: 0, lmsPublicKey: identity.keyPair.publicKey, opensAt: "asap" }, BigInt(Math.floor(Date.now() / 1000)));
    // Saved by a page that was closed while it was about to show the wallet's review.
    expect(p.go).toBe(true);
    await store.put(p);
    await resumeLaunchFlows();
    const v = await view(p.id);
    expect(v.need).toEqual({ kind: "go", stage: "create", lamports: null });
    expect(walletCalls).toEqual([]);
    await launchFlowAction(p.id, { kind: "go" });
    expect(walletCalls.map((w) => w.title)).toEqual(["Create the RLD launch (1 of 2)", "Fund the temporary fee account (2 of 2)"]);
  }, 60_000);

  it("asks before any wallet step after a cancel or a reload", async () => {
    approve = "cancel";
    const id = await newLaunch();
    let v = await view(id);
    expect(v.need).toEqual({ kind: "go", stage: "create", lamports: null });
    expect(walletCalls).toHaveLength(1);
    // Nothing more is shown to the wallet until the person asks.
    await view(id);
    expect(walletCalls).toHaveLength(1);
    approve = "yes";
    await launchFlowAction(id, { kind: "go" });
    v = runner(id).snapshot();
    expect(v.stage).toBe("open");
    expect(walletCalls).toHaveLength(3);
  }, 60_000);
});

/** The leaves the simulated chain marks used for the test identity. */
function usedLeaves(): number[] {
  return adapter.pqIdentity.usedLeaves(identityBitmapForTests(identity.identityId));
}

describe("refusals, retries and resends", () => {
  it("signs nothing new while an earlier signature of the launch could still land (SDK 0.5.0: PendingAttestationError), then signs", async () => {
    let refuse = true;
    const buildPlannedAttestTx: typeof phx.buildPlannedAttestTx = async (c, plan, opts) => {
      if (refuse) {
        const until = BigInt(Math.floor(Date.now() / 1000)) + 120n;
        throw new adapter.PendingAttestationError(plan.launch, [
          {
            leaf: 7,
            messageHash: new Uint8Array(32),
            message: new Uint8Array(189),
            lmsSignature: new Uint8Array(2508),
            window: { notBefore: until - 600n, notAfter: until },
            windowIso: { notBefore: adapter.unixToIso(until - 600n), notAfter: adapter.unixToIso(until) },
            metadataHash: new Uint8Array(32),
            rulesHash: new Uint8Array(32),
            landingNow: "attests",
            leafSetOnChain: false,
            detail: "an earlier window",
          },
        ]);
      }
      return phx.buildPlannedAttestTx(c, plan, opts);
    };
    configureLaunchFlows(env({ backend: { ...phx, buildPlannedAttestTx } }));
    const id = await newLaunch();
    let v = await view(id);
    expect(v.stage).toBe("sign");
    expect(v.need).toBeNull();
    expect(v.activity).toMatch(/^An earlier signature for this launch has not landed yet and could still open it until /);
    expect(usedLeaves()).toHaveLength(0);
    // It waits for that window (a scheduled tick), it does not give up or ask the person.
    expect(runner(id).scheduled()).toBe(true);
    refuse = false;
    advance(121);
    v = await view(id);
    expect(usedLeaves()).toHaveLength(1);
    expect(v.need?.kind).not.toBe("retry");
  }, 60_000);

  it("shows a signature that did not count, signs again only when asked, and stops after two (the SDK's cap)", async () => {
    let burnNext = 1;
    const sendAttestLaunchTx: typeof phx.sendAttestLaunchTx = async (c, built, opts) => {
      // It arrives with less than a minute of its window left: the program only burns its leaf.
      if (burnNext > 0) {
        burnNext--;
        vi.setSystemTime(Number(built.window.notAfter - 30n) * 1_000);
      }
      return phx.sendAttestLaunchTx(c, built, opts);
    };
    configureLaunchFlows(env({ backend: { ...phx, sendAttestLaunchTx } }));
    const id = await newLaunch();
    let v = await view(id);
    expect(v.stage).toBe("sign");
    expect(v.need?.kind).toBe("sign-again");
    expect(v.burns).toHaveLength(1);
    expect(v.burns[0]?.reasons).toEqual(["invalid-window"]);
    expect(usedLeaves()).toHaveLength(1);
    // Nothing more is signed until the person asks.
    v = await view(id);
    expect(usedLeaves()).toHaveLength(1);
    burnNext = 1;
    await launchFlowAction(id, { kind: "sign-again" });
    v = runner(id).snapshot();
    expect(v.need?.kind).toBe("sign-again");
    expect(usedLeaves()).toHaveLength(2);
    // A third signature after two that did not count: the SDK refuses (each one spends a one-time signature).
    await launchFlowAction(id, { kind: "sign-again" });
    v = runner(id).snapshot();
    expect(v.need).toMatchObject({ kind: "stopped", message: expect.stringMatching(/^Stopped after 2 signatures that did not count/) });
    expect(usedLeaves()).toHaveLength(2);
    // The person can still get the leftover SOL back.
    await launchFlowAction(id, { kind: "return-leftover" });
    v = runner(id).snapshot();
    expect(v.done).toBe(true);
    expect(v.abandoned).toBe(true);
    const p = await store.get(id);
    expect(p?.payerSecret).toBeNull();
    expect(solBalance(state(), new PublicKey(p?.payer ?? ""))).toBe(0n);
  }, 60_000);

  it("after a landing that did not count while its window is still good, stores the details again and signs a NEW message", async () => {
    let dropRecord = true;
    const sendAttestLaunchTx: typeof phx.sendAttestLaunchTx = async (c, built, opts) => {
      // The record is lost before the signature lands (a dropped fork): the program only burns the leaf.
      if (dropRecord) {
        dropRecord = false;
        delete state().tokenMetas[built.tokenMeta.toBase58()];
      }
      return phx.sendAttestLaunchTx(c, built, opts);
    };
    configureLaunchFlows(env({ backend: { ...phx, sendAttestLaunchTx } }));
    const id = await newLaunch();
    let v = await view(id);
    expect(v.need?.kind).toBe("sign-again");
    expect(v.burns.map((x) => x.reasons)).toEqual([["record-missing"]]);
    const burned = v.burns[0]?.window;
    // The details are on Solana again before anything else is signed.
    const stored = await store.get(id);
    if (stored === null) throw new Error("no progress");
    expect(state().tokenMetas[planOf(stored, 1_800_000_000n).tokenMeta.toBase58()]).toBeDefined();
    await launchFlowAction(id, { kind: "sign-again" });
    v = runner(id).snapshot();
    expect(v.stage).toBe("open");
    // Another message (its window one second later, the clock has not moved), at another leaf.
    expect(v.window?.notBefore).toBe(BigInt(burned?.notBefore ?? "0") + 1n);
    expect(usedLeaves()).toHaveLength(2);
    const a = await phx.fetchAttestation(conn, v.launch);
    expect(a?.attested).toBe(true);
  }, 60_000);

  it("after a refused account (ConstraintSeeds), sends the SAME signature again: one leaf, never a new message", async () => {
    let sends = 0;
    const sendAttestLaunchTx: typeof phx.sendAttestLaunchTx = async (c, built, opts) => {
      sends++;
      return phx.sendAttestLaunchTx(c, built, opts);
    };
    configureLaunchFlows(env({ backend: { ...phx, sendAttestLaunchTx } }));
    unlocked = false;
    const id = await newLaunch();
    await view(id);
    // The next two attest transactions name an account the program refuses: the test run catches it, nothing is sent.
    refuseNextAttestForTests(2);
    unlocked = true;
    let v = await view(id);
    expect(v.busy).toBe(true);
    expect(v.activity).toMatch(/Trying again: .*ConstraintSeeds/);
    expect(sends).toBe(0);
    const first = await ledger.list(identity.identityId);
    expect(first).toHaveLength(1);
    v = await view(id);
    expect(sends).toBe(0);
    v = await view(id);
    expect(v.stage).toBe("open");
    expect(sends).toBe(1);
    // One record, one leaf: the signature that landed is the one made first.
    const records = await ledger.list(identity.identityId);
    expect(records.map((r) => [r.leaf, r.signature])).toEqual(first.map((r) => [r.leaf, r.signature]));
    const a = await phx.fetchAttestation(conn, v.launch);
    expect(a?.leaf).toBe(first[0]?.leaf);
    expect(usedLeaves()).toEqual([first[0]?.leaf]);
  }, 60_000);

  it("resends a signature that did not land after a reload: the same leaf and the same bytes", async () => {
    let drop = true;
    const sendAttestLaunchTx: typeof phx.sendAttestLaunchTx = async (c, built, opts) => {
      if (drop) throw new Error("the attestation did not land (blockhash expired)");
      return phx.sendAttestLaunchTx(c, built, opts);
    };
    configureLaunchFlows(env({ backend: { ...phx, sendAttestLaunchTx } }));
    const id = await newLaunch();
    let v = await view(id);
    expect(v.activity).toMatch(/sent again with the same signature/);
    const signed = await ledger.list(identity.identityId);
    expect(signed).toHaveLength(1);
    expect(usedLeaves()).toEqual([]);
    const window = (await store.get(id))?.window;
    expect(window).not.toBeNull();
    // A reload.
    resetLaunchFlowsForTests();
    drop = false;
    configureLaunchFlows(env({ backend: { ...phx, sendAttestLaunchTx } }));
    await resumeLaunchFlows();
    v = await view(id);
    expect(v.stage).toBe("open");
    expect((await store.get(id))?.window).toEqual(window);
    expect((await ledger.list(identity.identityId)).map((r) => [r.leaf, r.signature])).toEqual(signed.map((r) => [r.leaf, r.signature]));
    expect(usedLeaves()).toEqual([signed[0]?.leaf]);
  }, 60_000);

  it("signs a new window when the one it signed can no longer land (it never did): a new message at a new leaf", async () => {
    let drop = true;
    const sendAttestLaunchTx: typeof phx.sendAttestLaunchTx = async (c, built, opts) => {
      if (drop) throw new Error("the attestation did not land (blockhash expired)");
      return phx.sendAttestLaunchTx(c, built, opts);
    };
    configureLaunchFlows(env({ backend: { ...phx, sendAttestLaunchTx } }));
    const id = await newLaunch();
    await view(id);
    const first = (await store.get(id))?.window;
    const signed = await ledger.list(identity.identityId);
    expect(signed).toHaveLength(1);
    // Much later (the page was closed): less than the landing margin and a minute of that window is left.
    vi.setSystemTime(Number(BigInt(first?.notAfter ?? "0") - 200n) * 1_000);
    drop = false;
    const v = await view(id);
    expect(v.stage).toBe("open");
    const now = BigInt(Math.floor(Date.now() / 1000));
    expect(v.window).toEqual({ notBefore: now + OPEN_LEAD_SECS, notAfter: now + OPEN_LEAD_SECS + WINDOW_SECS });
    const records = await ledger.list(identity.identityId);
    expect(records).toHaveLength(2);
    expect(usedLeaves()).toEqual(records.filter((r) => r.status === "landed").map((r) => r.leaf));
  }, 60_000);

  it("when the opening time passes unused, asks for a new time and signs it at the next leaf, replacing the old one (audit round 3 F1)", async () => {
    const id = await newLaunch();
    let v = await view(id);
    expect(v.stage).toBe("open");
    const old = await phx.fetchAttestation(conn, v.launch);
    // Nobody opened it in its hour.
    vi.setSystemTime(Number((old?.notAfter ?? 0n) + 5n) * 1_000);
    v = await view(id);
    expect(v.need).toEqual({ kind: "new-time", closedAt: old?.notAfter });
    expect(usedLeaves()).toHaveLength(1);
    await launchFlowAction(id, { kind: "new-time", opensAt: "asap" });
    v = runner(id).snapshot();
    expect(v.stage).toBe("open");
    expect(v.need).toBeNull();
    const fresh = await phx.fetchAttestation(conn, v.launch);
    expect(fresh?.attested).toBe(true);
    expect(fresh?.leaf).not.toBe(old?.leaf);
    expect(fresh?.notBefore).toBe(BigInt(Math.floor(Date.now() / 1000)) + OPEN_LEAD_SECS);
    expect(usedLeaves()).toHaveLength(2);
    // The details were stored once and reused.
    expect(fresh?.metadataHash).toEqual(old?.metadataHash);
    advance(Number(OPEN_LEAD_SECS) + 1);
    v = await view(id);
    expect(v.done).toBe(true);
    expect(v.mint).not.toBeNull();
  }, 60_000);

  it("moves a picked opening that came too close (a window needs at least 60 s left when the signature lands)", async () => {
    unlocked = false;
    const t0 = BigInt(Math.floor(Date.now() / 1000));
    const id = await newLaunch(t0 + 600n);
    await view(id);
    advance(700);
    unlocked = true;
    const v = await view(id);
    expect(v.stage).toBe("open");
    expect(v.note).toMatch(/The time you picked was too close/);
    expect(v.window?.notBefore).toBe(BigInt(Math.floor(Date.now() / 1000)) + OPEN_LEAD_SECS);
  }, 60_000);

  it("refuses to sign or send anything when the connection is not this build's cluster", async () => {
    configureLaunchFlows(env({ clusterRefusal: async () => "This build targets devnet, but the RPC endpoint serves mainnet." }));
    const id = await newLaunch();
    const v = await view(id);
    expect(v.need).toEqual({ kind: "stopped", message: "Refusing to sign or send: This build targets devnet, but the RPC endpoint serves mainnet." });
    expect(walletCalls).toEqual([]);
  }, 60_000);

  it("asks the creator's wallet to create it, never another one", async () => {
    unlocked = false;
    approve = "cancel";
    const id = await newLaunch();
    await view(id);
    // A reload with another wallet connected: nothing is shown to it.
    resetLaunchFlowsForTests();
    walletCalls = [];
    const other = Keypair.generate().publicKey;
    configureLaunchFlows(env({ wallet: () => other }));
    await resumeLaunchFlows();
    const v = await view(id);
    expect(v.need).toMatchObject({ kind: "wallet", message: expect.stringMatching(/^Connect the wallet that set up this launch/) });
    expect(walletCalls).toEqual([]);
  }, 60_000);
});

describe("plans and windows", () => {
  it("keeps the exact parameters through storage", () => {
    const params: adapter.LaunchParams = { ...adapter.PRESETS.community.params, recipients: [{ wallet: Keypair.generate().publicKey, bps: 10_000 }], pqIdentity: new Uint8Array(32).fill(7) };
    expect(decodeParams(encodeParams(params))).toEqual(params);
  });

  it("picks a window with room to sign it: one hour, never sooner than the lead time", () => {
    const now = 1_800_000_000n;
    expect(chooseWindow(now, "asap")).toEqual({ notBefore: now + OPEN_LEAD_SECS, notAfter: now + OPEN_LEAD_SECS + WINDOW_SECS, moved: false });
    expect(chooseWindow(now, now + 600n)).toEqual({ notBefore: now + 600n, notAfter: now + 600n + WINDOW_SECS, moved: false });
    // A time that came too close moves to the soonest one, and says so.
    expect(chooseWindow(now, now + 10n)).toEqual({ notBefore: now + OPEN_LEAD_SECS, notAfter: now + OPEN_LEAD_SECS + WINDOW_SECS, moved: true });
  });

  it("stores a plan that gives the same launch and refuses a uri mode", () => {
    const p = newProgress(
      {
        cluster: "devnet",
        creator: Keypair.generate().publicKey,
        params: { ...adapter.PRESETS.fair.params, recipients: [{ wallet: Keypair.generate().publicKey, bps: 10_000 }], pqIdentity: new Uint8Array(32).fill(3) },
        metadata: { name: "A", symbol: "B" },
        identityIndex: 0,
        lmsPublicKey: new Uint8Array(56),
        opensAt: "asap",
      },
      1_800_000_000n,
    );
    expect(planOf(p, 1_800_000_100n).launch.toBase58()).toBe(p.launch);
    expect(payerOf(p)?.publicKey.toBase58()).toBe(p.payer);
    expect(() =>
      newProgress({ cluster: "devnet", creator: Keypair.generate().publicKey, params: decodeParams(p.params), metadata: { name: "A", symbol: "B", flags: 1, doc: "x" }, identityIndex: 0, lmsPublicKey: new Uint8Array(56), opensAt: "asap" }, 1_800_000_000n),
    ).toThrow(/never sets a uri mode/);
  });
});


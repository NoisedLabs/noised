/**
 * Extra launch rules through the creator's launch flow (lib/launchFlow.ts):
 *   - demo builds: the rules are published from the temporary account before
 *     the quantum key signs, the signature binds them (attestation v3), the
 *     launch opens with exactly them, and the hook refuses what they forbid
 *     with RuleDenied (review U7);
 *   - where rules are not live (live builds), a launch with rules is refused
 *     before anything is created, paid for or shown to the wallet (review U8).
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { backend as mock } from "../src/lib/backend/mock";
import { programmableLive } from "../src/lib/backend/programmableLive";
import { configureLaunchFlows, memoryLaunchStore, OPEN_LEAD_SECS, resetLaunchFlowsForTests, RULES_NOT_LIVE, runnerForTests, startLaunchFlow, type FlowEnv, type LaunchProgressStore, type WalletStep } from "../src/lib/launchFlow";
import { guard } from "../src/lib/mock/common";
import { seedState } from "../src/lib/mock/fixtures";
import { resetProgrammableForTests } from "../src/lib/mock/programmable";
import { replaceStateForTests, state } from "../src/lib/mock/store";
import * as adapter from "../src/lib/noised";
import { compileRuleSet, rulesHashOf, type RuleSet } from "../src/lib/programmable";
import { RULE_DENIED } from "../src/lib/programErrors";
import { TEST_PHRASE } from "./support/records";

const phx = { ...adapter, ...mock };
const conn = new Connection("http://127.0.0.1:8899");

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
    now: async () => BigInt(Math.floor(Date.now() / 1000)),
    clusterRefusal: async () => null,
    lock: (_name, fn) => fn(),
    ...over,
  };
}

const params = (): adapter.LaunchParams => ({ ...adapter.PRESETS.fair.params, recipients: [{ wallet: creator, bps: 10_000 }], pqIdentity: identity.identityId });

/** One rule: while the early limits last, no single buy above 0.01% of the supply (below the preset's own max buy). */
function rulesFor(p: adapter.LaunchParams): Uint8Array {
  const set: RuleSet = { guardSecs: p.guardSecs, tokenDecimals: p.tokenDecimal, keys: [], rules: [{ from: 0, to: null, effect: "capAmount", cap: { bps: 1 }, when: { op: "buy" }, code: 3 }] };
  const b = compileRuleSet(set);
  if (!b.ok) throw new Error(b.message);
  return b.bytes;
}

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

describe("a launch with extra rules (demo)", () => {
  it("publishes them, binds them in the quantum signature, opens with exactly them, and the hook enforces them", async () => {
    configureLaunchFlows(env());
    const p = params();
    const rules = rulesFor(p);
    const id = await startLaunchFlow({ cluster: "devnet", creator, params: p, metadata: { name: "Rules Test", symbol: "RULE" }, identityIndex: 0, lmsPublicKey: identity.keyPair.publicKey, opensAt: "asap", rules });
    const r = runnerForTests(id);
    if (!r) throw new Error("no runner");
    await r.kick();
    let v = r.snapshot();
    expect(v.stage).toBe("open");
    // Still two wallet reviews: the temporary account paid for the rules too.
    expect(walletCalls).toHaveLength(2);
    const launch = new PublicKey(v.launch);
    expect((await store.get(id))?.sent.rules).toBeTruthy();
    const info = await phx.programmable.fetchLaunchRules(conn, launch);
    expect(info.attestedHash).toEqual(rulesHashOf(rules));
    expect(info.bound).toBe(true);
    expect(info.record?.bytes).toEqual(rules);
    vi.setSystemTime(Date.now() + (Number(OPEN_LEAD_SECS) + 1) * 1_000);
    await r.kick();
    v = r.snapshot();
    expect(v.mint).not.toBeNull();
    // After the snipe shield: a buy of 0.1% of the supply passes the built-in limits and is refused by the rule.
    vi.setSystemTime(Date.now() + (p.openDelaySecs + adapter.POLICY.EXECUTION_GRACE_SECS + 60) * 1_000);
    const l = state().launches[launch.toBase58()];
    if (!l) throw new Error("no launch");
    const nowSecs = Math.floor(Date.now() / 1000);
    const buyer = Keypair.generate().publicKey;
    const big = guard(l, nowSecs, { amount: l.initialSupply / 1_000n, isBuy: true, isSell: false, sourceOwner: adapter.KNOWN_ACCOUNTS.dbcPoolAuthority, destinationOwner: buyer, destinationBalanceAfter: l.initialSupply / 1_000n, txIxCount: 6 }, []);
    expect(big).toMatchObject({ kind: "program", code: RULE_DENIED.code });
    const small = guard(l, nowSecs, { amount: l.initialSupply / 100_000n, isBuy: true, isSell: false, sourceOwner: adapter.KNOWN_ACCOUNTS.dbcPoolAuthority, destinationOwner: buyer, destinationBalanceAfter: l.initialSupply / 100_000n, txIxCount: 6 }, []);
    expect(small).toBeNull();
    // A sell is never refused.
    expect(guard(l, nowSecs, { amount: l.initialSupply / 1_000n, isBuy: false, isSell: true, sourceOwner: buyer, destinationOwner: adapter.KNOWN_ACCOUNTS.dbcPoolAuthority, destinationBalanceAfter: 0n }, [])).toBeNull();
  }, 90_000);

  it("a launch without rules binds none (the zero hash)", async () => {
    configureLaunchFlows(env());
    const id = await startLaunchFlow({ cluster: "devnet", creator, params: params(), metadata: { name: "No Rules", symbol: "NONE" }, identityIndex: 0, lmsPublicKey: identity.keyPair.publicKey, opensAt: "asap" });
    const r = runnerForTests(id);
    await r?.kick();
    const launch = new PublicKey(r?.snapshot().launch ?? PublicKey.default);
    const info = await phx.programmable.fetchLaunchRules(conn, launch);
    expect(info.attestedHash).toEqual(new Uint8Array(32));
    expect(info.record).toBeNull();
  }, 90_000);
});

describe("where rules are not live (review U8)", () => {
  it("a launch with rules is refused before anything is created, paid for or shown to the wallet", async () => {
    configureLaunchFlows(env({ backend: { ...phx, programmable: { ...programmableLive, available: false } } }));
    const p = params();
    await expect(
      startLaunchFlow({ cluster: "devnet", creator, params: p, metadata: { name: "Rules Test", symbol: "RULE" }, identityIndex: 0, lmsPublicKey: identity.keyPair.publicKey, opensAt: "asap", rules: rulesFor(p) }),
    ).rejects.toThrow(RULES_NOT_LIVE);
    expect(await store.list()).toEqual([]);
    expect(walletCalls).toEqual([]);
  });
});

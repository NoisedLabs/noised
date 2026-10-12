/**
 * Programmable launches on the simulated chain (lib/mock/programmable.ts),
 * every transaction simulated before it is sent like the UI does. The demo
 * is never more permissive than the programs (programs/noised-autopilot,
 * PROGRAMMABLE_V1 §2):
 *   - rules: published only while configured, verified, content-addressed;
 *     an attestation binds a rule set only when it is published; the hook
 *     enforces only that set; nothing unsigned is ever shown (review U7);
 *   - pq_authorize: only the launch's own identity, a real LMS signature of
 *     the exact message, one-time keys spent (review U16);
 *   - activation: 72 h after both the authorization and the activation
 *     landed; authorizations are used once and in order (review U9);
 *   - run: the operator signs its steps and must give an amount (review U13);
 *     a keeper gives one for buybacks only; a buyback refuses when the pool
 *     returns less than the bound allows (review U5); the reference starts at
 *     the migration price and rises at most 5% an hour; a payout pays floor
 *     shares and the dust stays (review U10);
 *   - removing the operator stays possible on a frozen graph (review U12);
 *   - a freeze approval (payload v2, review 4 R5) names its last second: the
 *     freeze is refused after it (FreezeExpired), and lands before it.
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { backend as mock } from "../src/lib/backend/mock";
import { attestationLanded, attestationRulesOk, launchRulesProblem } from "../src/lib/mock/common";
import { seedState } from "../src/lib/mock/fixtures";
import { autopilotAddress, fundTreasuryForTests, governanceForTests, migrationSqrtPrice, resetProgrammableForTests, setPriceStateForTests, treasuryAddress } from "../src/lib/mock/programmable";
import { replaceStateForTests, state, tokenBalance } from "../src/lib/mock/store";
import * as adapter from "../src/lib/noised";
import type * as T from "../src/lib/noised";
import {
  activationPayload,
  authMessage,
  AUTH_KIND,
  buildGraph,
  compileRuleSet,
  freezePayload,
  graphFromBytes,
  graphNode,
  paymentShares,
  revokePayload,
  rulesHashOf,
  type AuthPayload,
  type Graph,
} from "../src/lib/programmable";
import { TEST_PHRASE } from "./support/records";

const phx = { ...adapter, ...mock, ...mock.programmable };
const conn = new Connection("http://127.0.0.1:8899");
const now = (): number => Math.floor(Date.now() / 1000);
const H = 3_600;

let creator: adapter.PqIdentity;
let stranger: adapter.PqIdentity;
let ledger: adapter.LeafLedger;
beforeAll(async () => {
  creator = await adapter.pqIdentity.deriveIdentityFromPhrase(TEST_PHRASE, "devnet", 0);
  stranger = await adapter.pqIdentity.deriveIdentityFromPhrase(TEST_PHRASE, "devnet", 1);
}, 120_000);

function demoUser(): PublicKey {
  const user = Keypair.generate().publicKey;
  phx.fundDemoWallet(user);
  return user;
}

async function launchBySymbol(symbol: string): Promise<T.LaunchAccount> {
  const l = (await phx.listLaunches(conn)).find((x) => x.market?.symbol === symbol || (x.status === "configured" && symbol === "QRY"));
  if (!l) throw new Error(`fixture ${symbol} missing`);
  return l;
}

/** The fixture launch now names the test creator's quantum identity (as if it had created it). */
async function mine(symbol: string): Promise<T.LaunchAccount> {
  const l = await launchBySymbol(symbol);
  const s = state();
  const m = s.launches[l.publicKey.toBase58()];
  if (!m) throw new Error("no such launch");
  m.state.pqIdentity = Uint8Array.from(creator.identityId);
  return launchBySymbol(symbol);
}

async function land(tx: T.AnyTransaction): Promise<string> {
  const sim = await phx.simulateAndExplain(conn, tx);
  if (!sim.ok) throw new Error(`simulation failed: ${sim.error ?? "?"}`);
  expect(sim.unknownPrograms).toEqual([]);
  return phx.sendAndConfirm(conn, tx);
}

async function refusal(build: () => Promise<{ tx: T.AnyTransaction } | T.AnyTransaction>): Promise<string> {
  try {
    const b = await build();
    const tx = "tx" in b ? b.tx : b;
    const sim = await phx.simulateAndExplain(conn, tx);
    expect(sim.ok).toBe(false);
    return sim.error ?? "";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** The identity's real LMS signature of the 140-byte message, at its next one-time key (the app's own path). */
async function sign(id: adapter.PqIdentity, l: T.LaunchAccount, p: AuthPayload): Promise<{ kind: number; payloadHash: Uint8Array; lmsPublicKey: Uint8Array; leaf: number; signature: Uint8Array }> {
  const message = authMessage({ program: adapter.PROGRAM_IDS.launchpad, launch: l.publicKey, creator: l.creator, kind: p.kind, payloadHash: p.hash }).bytes;
  const used = await phx.fetchIdentityLeaves(conn, id.identityId);
  const s = await adapter.leafLedger.signAtNextLeaf(ledger, id.keyPair, message, used);
  return { kind: p.kind, payloadHash: p.hash, lmsPublicKey: id.publicKey, leaf: s.leaf, signature: s.signature };
}

async function authorize(l: T.LaunchAccount, p: AuthPayload, payer: PublicKey): Promise<void> {
  await land((await phx.buildPqAuthorizeTx(conn, payer, l.publicKey, await sign(creator, l, p))).tx);
}

function burnGraph(decimals: number, tokens = 1_000n): Graph {
  return { operator: null, recipients: [], tokenDecimals: decimals, nodes: [graphNode("burn", { kind: "every", secs: 86_400 }, null, { kind: "burn", maxTokens: tokens * 10n ** BigInt(decimals) }, {}, decimals)] };
}

async function publish(l: T.LaunchAccount, g: Graph, payer: PublicKey): Promise<Uint8Array> {
  const b = buildGraph(g);
  if (!b.ok) throw new Error(b.issues[0]?.message);
  await land((await phx.buildPublishGraphTx(conn, payer, l.publicKey, b.bytes)).tx);
  return b.hash;
}

/** A first graph, switched on: authorized for `at`, activated, applied once due. */
async function switchOn(l: T.LaunchAccount, g: Graph, payer: PublicKey): Promise<Uint8Array> {
  const hash = await publish(l, g, payer);
  const at = now() + 60;
  await authorize(l, activationPayload(autopilotAddress(l.publicKey), hash, at), payer);
  await land((await phx.buildActivateGraphTx(conn, payer, l.publicKey, hash, at)).tx);
  vi.setSystemTime(Date.now() + 90_000);
  await land((await phx.buildApplyPendingTx(conn, payer, l.publicKey)).tx);
  return hash;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
  replaceStateForTests(seedState());
  resetProgrammableForTests();
  ledger = adapter.leafLedger.createMemoryLeafLedger();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("demo fixtures", () => {
  it("show every programmable state, and only signed rules", async () => {
    const mrdn = await phx.fetchAutopilot(conn, (await launchBySymbol("MRDN")).publicKey);
    expect(mrdn?.graphHash).not.toBeNull();
    expect((await phx.fetchAutopilot(conn, (await launchBySymbol("CNDR")).publicKey))?.frozen).toBe(true);
    const bstn = await phx.fetchAutopilot(conn, (await launchBySymbol("BSTN")).publicKey);
    expect(bstn?.pending?.activateAt).toBeGreaterThan(now());
    const aegs = await phx.fetchLaunchRules(conn, (await launchBySymbol("AEGS")).publicKey);
    expect(aegs.bound).toBe(true);
    expect(aegs.record?.hash).toEqual(aegs.attestedHash);
  });
});

describe("launch rules", () => {
  const set = { guardSecs: 3600, tokenDecimals: 9, keys: [], rules: [{ from: 0, to: null, effect: "capBalance" as const, cap: { bps: 100 }, when: { op: "true" as const }, code: 3 }] };

  it("are published only while the launch is configured, verified first, content-addressed", async () => {
    const qry = await launchBySymbol("QRY");
    const b = compileRuleSet({ ...set, guardSecs: qry.guardSecs });
    if (!b.ok) throw new Error(b.message);
    const payer = demoUser();
    await land((await phx.buildPublishRulesTx(conn, payer, qry.publicKey, b.bytes)).tx);
    expect((await phx.fetchRulesRecord(conn, qry.publicKey, b.hash))?.bytes).toEqual(b.bytes);
    const mrdn = (await launchBySymbol("MRDN")).publicKey;
    expect(await refusal(() => phx.buildPublishRulesTx(conn, payer, mrdn, b.bytes))).toMatch(/WrongLaunchState/);
    expect(await refusal(() => phx.buildPublishRulesTx(conn, payer, qry.publicKey, Uint8Array.of(1, 2, 3)))).toMatch(/InvalidRules/);
  });

  it("a published set nobody signed is never shown as the launch's rules (review U7)", async () => {
    const qry = await launchBySymbol("QRY");
    const b = compileRuleSet({ ...set, guardSecs: qry.guardSecs });
    if (!b.ok) throw new Error(b.message);
    await land((await phx.buildPublishRulesTx(conn, demoUser(), qry.publicKey, b.bytes)).tx);
    const info = await phx.fetchLaunchRules(conn, qry.publicKey);
    // QRY is attested without rules (zero hash): the published set is not its rules.
    expect(info.attestedHash).toEqual(new Uint8Array(32));
    expect(info.record).toBeNull();
    expect(info.bound).toBe(false);
  });

  it("an attestation binds rules only when they are published; the launch refuses while they are missing (review U7)", async () => {
    const qry = await launchBySymbol("QRY");
    const b = compileRuleSet({ ...set, guardSecs: qry.guardSecs });
    if (!b.ok) throw new Error(b.message);
    const key = qry.publicKey.toBase58();
    const message = new Uint8Array(32).fill(7);
    phx.bindRulesToAttestation(qry.publicKey, message, b.hash);
    // Not published: this message would only burn its leaf.
    expect(attestationRulesOk(state(), key, message, new Uint8Array(32))).toBe(false);
    // A message that binds no rules attests as before.
    expect(attestationRulesOk(state(), key, new Uint8Array(32).fill(8), new Uint8Array(32))).toBe(true);
    // Attestation v3: the message's own rules hash binds the same way.
    expect(attestationRulesOk(state(), key, new Uint8Array(32).fill(9), b.hash)).toBe(false);
    // Had it landed, the launch would not open.
    attestationLanded(state(), key, message, new Uint8Array(32));
    expect(launchRulesProblem(state(), key)).toMatchObject({ kind: "runtime" });
    await land((await phx.buildPublishRulesTx(conn, demoUser(), qry.publicKey, b.bytes)).tx);
    expect(attestationRulesOk(state(), key, message, new Uint8Array(32))).toBe(true);
    expect(attestationRulesOk(state(), key, new Uint8Array(32).fill(9), b.hash)).toBe(true);
    expect(launchRulesProblem(state(), key)).toBeNull();
    const info = await phx.fetchLaunchRules(conn, qry.publicKey);
    expect(info.attestedHash).toEqual(b.hash);
    expect(info.bound).toBe(true);
    expect(rulesHashOf(info.record?.bytes ?? null)).toEqual(b.hash);
  });
});

describe("quantum authorizations (review U16)", () => {
  it("only the launch's own identity, with a valid signature of the exact change, at an unused one-time key", async () => {
    const l = await mine("BSTN");
    const payer = demoUser();
    const p = freezePayload(autopilotAddress(l.publicKey), new Uint8Array(32).fill(3), now() + H);
    // Another identity: refused before anything is sent.
    expect(await refusal(async () => phx.buildPqAuthorizeTx(conn, payer, l.publicKey, await sign(stranger, l, p)))).toMatch(/WrongIdentity/);
    // A signature of another message: refused.
    const good = await sign(creator, l, p);
    const other = await sign(creator, l, freezePayload(autopilotAddress(l.publicKey), new Uint8Array(32).fill(4), now() + H));
    expect(await refusal(() => phx.buildPqAuthorizeTx(conn, payer, l.publicKey, { ...good, signature: other.signature, leaf: other.leaf }))).toMatch(/InvalidPqSignature/);
    // The right one lands, spends its key, and is recorded with its slot.
    await land((await phx.buildPqAuthorizeTx(conn, payer, l.publicKey, good)).tx);
    const used = await phx.fetchIdentityLeaves(conn, creator.identityId);
    expect(adapter.pqIdentity.leafUsed(used, good.leaf)).toBe(true);
    const a = await phx.fetchAuthorization(conn, l.publicKey, AUTH_KIND.GRAPH_FREEZE, p.hash);
    expect(a?.slot).toBeGreaterThan(0);
  });
});

describe("activation (review U9, U10)", () => {
  it("the reference price starts at the launch's migration price", async () => {
    const lntn = await launchBySymbol("LNTN");
    await land((await phx.buildInitAutopilotTx(conn, demoUser(), lntn.publicKey)).tx);
    const info = await phx.fetchAutopilot(conn, lntn.publicKey);
    const m = state().launches[lntn.publicKey.toBase58()];
    if (!m) throw new Error("no launch");
    expect(info?.refSqrtPrice).toBe(migrationSqrtPrice(m));
    expect(await phx.fetchMigrationPrice(conn, lntn.publicKey)).toBe(migrationSqrtPrice(m));
    expect(info?.refSqrtPrice).toBeGreaterThan(0n);
  });

  it("a first graph switches on at its signed time, never in the past", async () => {
    const l = await mine("LNTN");
    const payer = demoUser();
    await land((await phx.buildInitAutopilotTx(conn, payer, l.publicKey)).tx);
    const hash = await publish(l, burnGraph(l.tokenDecimal), payer);
    const past = now() - 10;
    await authorize(l, activationPayload(autopilotAddress(l.publicKey), hash, past), payer);
    expect(await refusal(() => phx.buildActivateGraphTx(conn, payer, l.publicKey, hash, past))).toMatch(/ActivationInPast/);
    // Unsigned time: refused.
    expect(await refusal(() => phx.buildActivateGraphTx(conn, payer, l.publicKey, hash, now() + 600))).toMatch(/InvalidAuthorization/);
  });

  it("a change waits 72 hours after both its signature and its activation landed (a late activation is refused)", async () => {
    const l = await mine("BSTN");
    const payer = demoUser();
    const ap = autopilotAddress(l.publicKey);
    const next = await publish(l, burnGraph(l.tokenDecimal, 7n), payer);
    const signedAt = now();
    const at = signedAt + 72 * H + 60;
    await authorize(l, activationPayload(ap, next, at), payer);
    // Activated 10 minutes later: at is less than 72 hours after the activation lands.
    vi.setSystemTime(Date.now() + 10 * 60_000);
    expect(await refusal(() => phx.buildActivateGraphTx(conn, payer, l.publicKey, next, at))).toMatch(/TimelockTooShort/);
    // The same change signed with a time 72 h + 1 h out lands.
    const ok = now() + 73 * H;
    await authorize(l, activationPayload(ap, next, ok), payer);
    await land((await phx.buildActivateGraphTx(conn, payer, l.publicKey, next, ok)).tx);
    expect((await phx.fetchAutopilot(conn, l.publicKey))?.pending?.activateAt).toBe(ok);
  });

  it("a superseded authorization can't be replayed: A then B queued, A again is stale (review U9)", async () => {
    const l = await mine("BSTN");
    const payer = demoUser();
    const ap = autopilotAddress(l.publicKey);
    const a = await publish(l, burnGraph(l.tokenDecimal, 11n), payer);
    const b = await publish(l, burnGraph(l.tokenDecimal, 12n), payer);
    const atA = now() + 73 * H;
    await authorize(l, activationPayload(ap, a, atA), payer);
    vi.setSystemTime(Date.now() + 2_000);
    const atB = now() + 73 * H;
    await authorize(l, activationPayload(ap, b, atB), payer);
    await land((await phx.buildActivateGraphTx(conn, payer, l.publicKey, b, atB)).tx);
    expect(await refusal(() => phx.buildActivateGraphTx(conn, payer, l.publicKey, a, atA))).toMatch(/StaleAuthorization/);
    expect(governanceForTests(l.publicKey)?.pending?.graphHash).toEqual(b);
  });

  it("a freeze signed before the latest activation can't cancel it (review U9)", async () => {
    const l = await mine("BSTN");
    const payer = demoUser();
    const ap = autopilotAddress(l.publicKey);
    const info = await phx.fetchAutopilot(conn, l.publicKey);
    if (!info?.graphHash) throw new Error("no running graph");
    const until = now() + H;
    await authorize(l, freezePayload(ap, info.graphHash, until), payer);
    vi.setSystemTime(Date.now() + 2_000);
    const next = await publish(l, burnGraph(l.tokenDecimal, 13n), payer);
    const at = now() + 73 * H;
    await authorize(l, activationPayload(ap, next, at), payer);
    await land((await phx.buildActivateGraphTx(conn, payer, l.publicKey, next, at)).tx);
    expect(await refusal(() => phx.buildFreezeGraphTx(conn, payer, l.publicKey, until))).toMatch(/StaleAuthorization/);
    expect(governanceForTests(l.publicKey)?.frozen).toBe(false);
    expect(governanceForTests(l.publicKey)?.pending?.graphHash).toEqual(next);
  });

  it("a freeze approval names its last second: refused after it (FreezeExpired), never under another time (review 4, R5)", async () => {
    const l = await mine("BSTN");
    const payer = demoUser();
    const ap = autopilotAddress(l.publicKey);
    const info = await phx.fetchAutopilot(conn, l.publicKey);
    if (!info?.graphHash) throw new Error("no running graph");
    const until = now() + H;
    await authorize(l, freezePayload(ap, info.graphHash, until), payer);
    // Another not_after than the one signed: no such authorization.
    expect(await refusal(() => phx.buildFreezeGraphTx(conn, payer, l.publicKey, until + 1))).toMatch(/InvalidAuthorization/);
    // Past it: FreezeExpired, nothing frozen.
    vi.setSystemTime(Date.now() + (H + 5) * 1_000);
    expect(await refusal(() => phx.buildFreezeGraphTx(conn, payer, l.publicKey, until))).toMatch(/FreezeExpired/);
    expect(governanceForTests(l.publicKey)?.frozen).toBe(false);
  });

  it("a freeze used within its hour lands, and the temporary-account path refuses to sign one that can't land", async () => {
    const l = await mine("BSTN");
    const payer = demoUser();
    const ap = autopilotAddress(l.publicKey);
    const info = await phx.fetchAutopilot(conn, l.publicKey);
    if (!info?.graphHash) throw new Error("no running graph");
    const late = now() + 30;
    const p = freezePayload(ap, info.graphHash, late);
    const signer = Keypair.generate();
    phx.fundDemoWallet(signer.publicKey);
    await expect(phx.prepareAuthorizeFromPayer(conn, signer, l.publicKey, { kind: 2, payloadHash: p.hash, creator: l.creator, identity: creator, ledger, freezeNotAfter: late })).rejects.toThrow(/expired/);
    const until = now() + H;
    await authorize(l, freezePayload(ap, info.graphHash, until), payer);
    vi.setSystemTime(Date.now() + (H - 120) * 1_000);
    await land((await phx.buildFreezeGraphTx(conn, payer, l.publicKey, until)).tx);
    expect(governanceForTests(l.publicKey)?.frozen).toBe(true);
  });
});

describe("run", () => {
  it("a due buyback runs for anyone, burns what it buys, and the tip is at most a tenth of what it moved", async () => {
    const l = await launchBySymbol("MRDN");
    const keeper = demoUser();
    const due = await phx.findDueSteps(conn, l.publicKey);
    expect(due.map((d) => d.node)).toEqual([0]);
    const before = await phx.fetchAutopilot(conn, l.publicKey);
    await land((await phx.buildRunStepTx(conn, keeper, l.publicKey, 0)).tx);
    const after = await phx.fetchAutopilot(conn, l.publicKey);
    if (!before || !after) throw new Error("no autopilot");
    const spent = before.treasurySol - after.treasurySol;
    expect(after.totalBurned).toBeGreaterThan(before.totalBurned);
    const tip = after.totalTips - before.totalTips;
    expect(tip).toBeGreaterThan(0n);
    expect(tip * 10n).toBeLessThanOrEqual(spent - tip);
  });

  it("a buyback refuses when the pool returns less than the bound allows: a 3% premium in a 10% pool never fills (review U5)", async () => {
    const l = await launchBySymbol("MRDN");
    const m = state().launches[l.publicKey.toBase58()];
    if (!m) throw new Error("no launch");
    m.dammFeeBps = 1_000;
    expect(await refusal(() => phx.buildRunStepTx(conn, demoUser(), l.publicKey, 0))).toMatch(/SwapShortfall/);
    // So it is not offered as due: running it could only fail.
    expect(await phx.findDueSteps(conn, l.publicKey)).toEqual([]);
  });

  it("a keeper gives an amount for buybacks only, never below 1% of the pool's SOL", async () => {
    const l = await launchBySymbol("MRDN");
    const keeper = demoUser();
    const [d] = await phx.findDueSteps(conn, l.publicKey);
    if (!d) throw new Error("nothing due");
    expect(d.minAmount).toBeLessThanOrEqual(d.maxAmount);
    if (d.minAmount > 1n) expect(await refusal(() => phx.buildRunStepTx(conn, keeper, l.publicKey, 0, { amount: d.minAmount - 1n }))).toMatch(/AmountTooSmall/);
    expect(await refusal(() => phx.buildRunStepTx(conn, keeper, l.publicKey, 0, { amount: d.maxAmount + 1n }))).toMatch(/InvalidAmount/);
    const lntn = await mine("LNTN");
    await land((await phx.buildInitAutopilotTx(conn, keeper, lntn.publicKey)).tx);
    await switchOn(lntn, burnGraph(lntn.tokenDecimal), keeper);
    fundTreasuryForTests(lntn.publicKey, 0n, 10_000n * 10n ** BigInt(lntn.tokenDecimal));
    expect(await refusal(() => phx.buildRunStepTx(conn, keeper, lntn.publicKey, 0, { amount: 1n }))).toMatch(/AmountNotAllowed/);
    await land((await phx.buildRunStepTx(conn, keeper, lntn.publicKey, 0)).tx);
  });

  it("an operator step needs the operator's own signature and an amount (review U13); removing it works when frozen (review U12)", async () => {
    const l = await mine("LNTN");
    const payer = demoUser();
    const agent = demoUser();
    await land((await phx.buildInitAutopilotTx(conn, payer, l.publicKey)).tx);
    const g: Graph = {
      operator: agent.toBase58(),
      recipients: [],
      tokenDecimals: l.tokenDecimal,
      nodes: [graphNode("agent", { kind: "every", secs: 3_600 }, null, { kind: "burn", maxTokens: 100n * 10n ** BigInt(l.tokenDecimal) }, { epochSecs: 86_400, operatorGated: true }, l.tokenDecimal)],
    };
    const hash = await switchOn(l, g, payer);
    fundTreasuryForTests(l.publicKey, 0n, 10_000n * 10n ** BigInt(l.tokenDecimal));
    const [d] = await phx.findDueSteps(conn, l.publicKey);
    expect(d?.operatorOnly).toBe(true);
    // Anyone else, even with the right amount: WrongOperator. The operator without an amount: InvalidAmount.
    expect(await refusal(() => phx.buildRunStepTx(conn, payer, l.publicKey, 0, { amount: 5n }))).toMatch(/WrongOperator/);
    expect(await refusal(() => phx.buildRunStepTx(conn, agent, l.publicKey, 0, { operator: agent }))).toMatch(/InvalidAmount/);
    expect(await refusal(() => phx.buildRunStepTx(conn, agent, l.publicKey, 0, { operator: agent, amount: (d?.maxAmount ?? 0n) + 1n }))).toMatch(/InvalidAmount/);
    await land((await phx.buildRunStepTx(conn, agent, l.publicKey, 0, { operator: agent, amount: 7n })).tx);
    const runs = await phx.listAutopilotRuns(conn, l.publicKey);
    expect(runs[0]?.byOperator).toBe(true);
    // Freeze, then remove the operator anyway.
    const ap = autopilotAddress(l.publicKey);
    const until = now() + H;
    await authorize(l, freezePayload(ap, hash, until), payer);
    await land((await phx.buildFreezeGraphTx(conn, payer, l.publicKey, until)).tx);
    // Payload v3 (audit 4, A4-3): the removal names the activation in force (the autopilot's activeAuth).
    const inForce = (await phx.fetchAutopilot(conn, l.publicKey))?.activeAuth ?? null;
    expect(inForce).not.toBeNull();
    // A removal signed for another activation is refused (InvalidAuthorization): it can never carry over.
    await authorize(l, revokePayload(ap, hash, agent, PublicKey.default), payer);
    expect(await refusal(() => phx.buildRevokeOperatorTx(conn, payer, l.publicKey))).toMatch(/InvalidAuthorization/);
    await authorize(l, revokePayload(ap, hash, agent, inForce ?? PublicKey.default), payer);
    await land((await phx.buildRevokeOperatorTx(conn, payer, l.publicKey)).tx);
    const after = await phx.fetchAutopilot(conn, l.publicKey);
    expect(after?.frozen).toBe(true);
    expect(after?.operator).toBeNull();
    expect(await refusal(() => phx.buildRunStepTx(conn, agent, l.publicKey, 0, { operator: agent, amount: 7n }))).toMatch(/NoOperator/);
  });

  it("a payout pays the floor of each share; the rounding dust stays in the treasury (review U10)", async () => {
    const l = await launchBySymbol("CNDR");
    const before = await phx.fetchAutopilot(conn, l.publicKey);
    if (!before) throw new Error("no autopilot");
    // 0.333333333 SOL: 60% and 40% of it are not whole lamports.
    fundTreasuryForTests(l.publicKey, 333_333_333n - before.treasurySol, 0n);
    vi.setSystemTime(Date.now() + 6 * 86_400_000);
    const g = (await phx.fetchGraphBytes(conn, l.publicKey, before.graphHash ?? new Uint8Array(32))) as Uint8Array;
    expect(g).not.toBeNull();
    const keeper = demoUser();
    const graph = buildGraphFromBytes(g, l.tokenDecimal);
    const holds = (): bigint[] => graph.recipients.map((r) => tokenBalance(state(), new PublicKey(r.address), adapter.WSOL_MINT));
    const held = holds();
    await land((await phx.buildRunStepTx(conn, keeper, l.publicKey, 0)).tx);
    const after = await phx.fetchAutopilot(conn, l.publicKey);
    const shares = paymentShares(graph, 333_333_333n);
    const paid = shares.reduce((a, b) => a + b, 0n);
    expect(paid).toBe(333_333_332n);
    // Each recipient gets exactly its floor share: nothing is paid that the treasury did not lose.
    expect(holds().map((h, i) => h - (held[i] ?? 0n))).toEqual(shares);
    expect((after?.totalPaid ?? 0n) - before.totalPaid).toBe(paid);
    const tip = (after?.totalTips ?? 0n) - before.totalTips;
    expect(after?.treasurySol).toBe(333_333_333n - paid - tip);
  });

  it("the reference follows the pool up at most 5% of price an hour (review U10)", async () => {
    const l = await launchBySymbol("MRDN");
    const info = await phx.fetchAutopilot(conn, l.publicKey);
    if (!info) throw new Error("no autopilot");
    const low = (info.spotSqrtPrice * 8n) / 10n;
    setPriceStateForTests(l.publicKey, low);
    for (let i = 0; i < 12; i++) {
      vi.setSystemTime(Date.now() + 300_000);
      await phx.fetchAutopilot(conn, l.publicKey);
    }
    const after = await phx.fetchAutopilot(conn, l.publicKey);
    const r = Number(after?.refSqrtPrice ?? 0n) / Number(low);
    expect(r).toBeGreaterThan(1);
    // At most 1.0246 in sqrt price per hour = at most 5% in price.
    expect(r * r).toBeLessThanOrEqual(1.0501);
    expect(treasuryAddress(l.publicKey)).toBeInstanceOf(PublicKey);
  });
});

function buildGraphFromBytes(bytes: Uint8Array, decimals: number): Graph {
  const g = graphFromBytes(bytes, decimals);
  if (!g) throw new Error("graph does not decode");
  return g;
}

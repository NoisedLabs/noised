/**
 * SDK 0.9.0 (audit 4) in the app:
 *   - the SDK's refusals before a quantum signature, in plain words: a key
 *     used on another device or app (UnknownLeavesError), a clock the network
 *     disagrees with (ClockSkewError), three earlier signatures that never
 *     landed (SignatureCapError); and the one-device line of the key screen;
 *   - "used elsewhere": the import clears it; a written confirmation is
 *     offered only for a small count, after the record was read again and,
 *     with a second RPC, read the same there; a large count never;
 *   - a freeze approval lasts at most 24 hours (the slider stops there);
 *   - the simulated chain runs the SDK's guards (clock, cap, unknown leaves,
 *     24 hours) for an Autopilot authorization, values a burn's tip at the
 *     burn price (nothing before graduation), pays only payees with a wSOL
 *     account (the rest is kept) and refuses a payout nobody can receive;
 *   - the launch flow stops on each refusal with what the person can do, and
 *     passes the browser's signing lock and a second RPC to the SDK;
 *   - a simulation counts completed runs (a partial buyback is not one).
 */
import * as sdk from "@noisedlabs/sdk";
import { AUTOPILOT } from "@noisedlabs/sdk/programmable";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { backend as mock } from "../src/lib/backend/mock";
import { confirmUnknown, recheckUnknown, unknownLeaves } from "../src/lib/keyElsewhere";
import {
  configureLaunchFlows,
  launchFlowAction,
  memoryLaunchStore,
  resetLaunchFlowsForTests,
  runnerForTests,
  startLaunchFlow,
  type FlowEnv,
  type LaunchProgressStore,
} from "../src/lib/launchFlow";
import { seedState } from "../src/lib/mock/fixtures";
import { DEMO_CLOCK_OFFSET_KEY, mockCheckClockSkew } from "../src/lib/mock/guard";
import { autopilotAddress, fundTreasuryForTests, governanceForTests, resetProgrammableForTests } from "../src/lib/mock/programmable";
import { replaceStateForTests, state, tokenKey } from "../src/lib/mock/store";
import * as adapter from "../src/lib/noised";
import type * as T from "../src/lib/noised";
import {
  activationPayload,
  buildGraph,
  expectedRunTip,
  FREEZE_MAX_SECS,
  FREEZE_VALID_SECS,
  FREEZE_WINDOW_CHOICES,
  freezeExpiryProblem,
  freezeNotAfter,
  graphNode,
  type AuthPayload,
  type Graph,
} from "../src/lib/programmable";
import {
  clockSkewText,
  confirmable,
  confirmationMatches,
  CONFIRM_PHRASE,
  isoOf,
  ONE_DEVICE_LINE,
  signRefusalOf,
  UNKNOWN_LEAVES_CONFIRM_MAX,
  UNKNOWN_LEAVES_TEXT,
  utcText,
} from "../src/lib/signErrors";
import { completedRuns } from "../src/pages/autopilot/SimPanel";
import { TEST_PHRASE } from "./support/records";

const phx = { ...adapter, ...mock, ...mock.programmable };
const conn = new Connection("http://127.0.0.1:8899");
const now = (): number => Math.floor(Date.now() / 1000);
const utf8 = (t: string): Uint8Array => new TextEncoder().encode(t);

let creator: adapter.PqIdentity;
let other: adapter.PqIdentity;
beforeAll(async () => {
  creator = await adapter.pqIdentity.deriveIdentityFromPhrase(TEST_PHRASE, "devnet", 0);
  other = await adapter.pqIdentity.deriveIdentityFromPhrase(TEST_PHRASE, "devnet", 3);
}, 120_000);

describe("the refusals, in plain words", () => {
  it("a clock the network disagrees with: the owner's sentence, nothing to confirm", () => {
    expect(clockSkewText(600n)).toBe("Your device clock and the network disagree by 600 seconds — fix your clock or try another network connection.");
    expect(clockSkewText(1)).toBe("Your device clock and the network disagree by 1 second — fix your clock or try another network connection.");
    const e = new sdk.ClockSkewError(1_800_000_000n, 1_800_000_600n, null, 600n, 120n);
    expect(signRefusalOf(e)).toEqual({ kind: "clock", skewSecs: 600, message: clockSkewText(600) });
  });

  it("a key used elsewhere: calm, with the count; confirmable only for a few", () => {
    const e = new sdk.UnknownLeavesError(new Uint8Array(32).fill(7), [3, 9], 5, 3, 11, false);
    const r = signRefusalOf(e);
    expect(r).toMatchObject({ kind: "unknown-leaves", count: 2, identityIdHex: "07".repeat(32) });
    expect(r?.message).toBe(`${UNKNOWN_LEAVES_TEXT} (2 signatures this device doesn't know.)`);
    expect(UNKNOWN_LEAVES_TEXT).toBe("This quantum key was used on another device or app. Import that device's records before signing again.");
    expect(UNKNOWN_LEAVES_CONFIRM_MAX).toBe(3);
    expect([0, 1, 2, 3, 4, 300, 1_023].map(confirmable)).toEqual([false, true, true, true, false, false, false]);
    expect(CONFIRM_PHRASE).toBe("I have no unsent signatures elsewhere");
    expect(confirmationMatches("  i have no unsent signatures ELSEWHERE ")).toBe(true);
    expect(confirmationMatches("I have no unsent signatures")).toBe(false);
    expect(ONE_DEVICE_LINE).toBe("Use one device per quantum key unless you import its records.");
  });

  it("three earlier signatures that never landed", () => {
    const e = new sdk.SignatureCapError(PublicKey.default, "attestation", [1, 2, 3], 3);
    expect(signRefusalOf(e)).toMatchObject({ kind: "cap", count: 3 });
    expect(signRefusalOf(e)?.message).toMatch(/^3 earlier signatures of this launch never landed\. .*unless you confirm one more\.$/);
    expect(signRefusalOf(new Error("anything else"))).toBeNull();
  });

  it("absolute dates are the SDK's", () => {
    expect(utcText(1_800_000_000)).toBe(sdk.unixToUtcText(1_800_000_000n));
    expect(isoOf(1_800_000_000n)).toBe(sdk.unixToIso(1_800_000_000n));
    expect(isoOf(1_800_000_000)).toMatch(/^2027-01-15T\d\d:\d\d:\d\dZ$/);
  });
});

describe("a freeze approval lasts at most 24 hours (audit 4, ID-F5)", () => {
  it("the slider stops at the SDK's limit; one hour by default", () => {
    expect(FREEZE_MAX_SECS).toBe(sdk.PQ_IDENTITY.FREEZE_MAX_VALID_SECS);
    expect(BigInt(FREEZE_MAX_SECS)).toBe(sdk.FREEZE_MAX_VALID_SECS);
    expect(Math.max(...FREEZE_WINDOW_CHOICES)).toBe(86_400);
    expect(FREEZE_WINDOW_CHOICES).toContain(FREEZE_VALID_SECS);
    expect(freezeNotAfter(1_000)).toBe(1_000 + 3_600);
    expect(freezeNotAfter(1_000, 86_400)).toBe(87_400);
    expect(() => freezeNotAfter(1_000, 86_401)).toThrow(RangeError);
    expect(freezeExpiryProblem(1_000 + 86_401, 1_000)).toMatch(/at most 24 hours/);
    expect(freezeExpiryProblem(1_000 + 86_400, 1_000)).toBeNull();
  });
});

describe("a key used elsewhere (UnknownLeavesError)", () => {
  /** A bitmap with `leaves` set, as another device's landings would set them (never signed in this process). */
  const bitmap = (leaves: number[]): Uint8Array => {
    const used = new Uint8Array(sdk.PQ_IDENTITY.LEAF_BITMAP_LEN);
    for (const q of leaves) adapter.pqIdentity.markLeafUsed(used, q);
    return used;
  };

  it("nothing is signed; a confirmation is offered only for a few, read the same on two connections, and only then accepted", async () => {
    const ledger = adapter.leafLedger.createMemoryLeafLedger();
    const used = bitmap([1_001, 1_002]);
    await expect(adapter.leafLedger.signAtNextLeaf(ledger, other.keyPair, utf8("a change"), used)).rejects.toBeInstanceOf(sdk.UnknownLeavesError);
    expect(await ledger.list(other.identityId)).toEqual([]);
    expect(await unknownLeaves(ledger, other.identityId, used)).toEqual([1_001, 1_002]);
    const a = {} as Connection;
    const b = {} as Connection;
    let onB = used;
    const read = async (c: Connection): Promise<Uint8Array> => (c === a ? used : onB);
    expect(await recheckUnknown({ conn: a, second: b, ledger, identityId: other.identityId, read })).toMatchObject({ count: 2, secondAgrees: true, canConfirm: true, why: null });
    expect(await recheckUnknown({ conn: a, second: null, ledger, identityId: other.identityId, read })).toMatchObject({ count: 2, secondAgrees: null, canConfirm: true });
    // The second connection shows another record: one of them lies, so nothing may be confirmed.
    onB = bitmap([1_001, 1_002, 1_003]);
    const split = await recheckUnknown({ conn: a, second: b, ledger, identityId: other.identityId, read });
    expect(split).toMatchObject({ secondAgrees: false, canConfirm: false });
    expect(split.why).toMatch(/two network connections show different records/);
    // A confirmation names the count the person saw: another count is refused by the SDK.
    await expect(confirmUnknown(ledger, other.publicKey, used, 1)).rejects.toThrow(/not the 1 confirmed/);
    expect(await confirmUnknown(ledger, other.publicKey, used, 2)).toBe(2);
    const s = await adapter.leafLedger.signAtNextLeaf(ledger, other.keyPair, utf8("a change"), used);
    expect([1_001, 1_002]).not.toContain(s.leaf);
  });

  it("a large count is never confirmable here (a lying connection would show exactly that)", async () => {
    const ledger = adapter.leafLedger.createMemoryLeafLedger();
    const used = bitmap([900, 901, 902, 903]);
    const read = async (): Promise<Uint8Array> => used;
    const r = await recheckUnknown({ conn: {} as Connection, second: null, ledger, identityId: other.identityId, read });
    expect(r).toMatchObject({ count: 4, canConfirm: false });
    expect(r.why).toMatch(/more than 3 signatures, so it can't be confirmed here/);
    await expect(confirmUnknown(ledger, other.publicKey, used, 4)).rejects.toThrow(/can't be confirmed here/);
    const all = bitmap(Array.from({ length: 1_000 }, (_, i) => i));
    await expect(confirmUnknown(ledger, other.publicKey, all, 1_000)).rejects.toThrow(/can't be confirmed here/);
    expect(await ledger.list(other.identityId)).toEqual([]);
  });

  it("importing the other device's records clears it", async () => {
    const theirs = adapter.leafLedger.createMemoryLeafLedger();
    const used = new Uint8Array(sdk.PQ_IDENTITY.LEAF_BITMAP_LEN);
    for (const m of ["one", "two"]) {
      const s = await adapter.leafLedger.signAtNextLeaf(theirs, other.keyPair, utf8(`their ${m}`), used);
      adapter.pqIdentity.markLeafUsed(used, s.leaf);
    }
    const mine = adapter.leafLedger.createMemoryLeafLedger();
    expect(await unknownLeaves(mine, other.identityId, used)).toHaveLength(2);
    await adapter.leafLedger.importLeafRecords(mine, other.publicKey, await adapter.leafLedger.exportLeafRecords(theirs, other.identityId));
    expect(await unknownLeaves(mine, other.identityId, used)).toEqual([]);
    const s = await adapter.leafLedger.signAtNextLeaf(mine, other.keyPair, utf8("mine"), used);
    expect(adapter.pqIdentity.leafUsed(used, s.leaf)).toBe(false);
  });
});

// ------------------------------------------------------------- simulated chain ---

function demoUser(): PublicKey {
  const user = Keypair.generate().publicKey;
  phx.fundDemoWallet(user);
  return user;
}

async function launchBySymbol(symbol: string): Promise<T.LaunchAccount> {
  const l = (await phx.listLaunches(conn)).find((x) => x.market?.symbol === symbol);
  if (!l) throw new Error(`fixture ${symbol} missing`);
  return l;
}

/** The fixture launch now names the test creator's quantum identity (as if it had created it). */
async function mine(symbol: string): Promise<T.LaunchAccount> {
  const l = await launchBySymbol(symbol);
  const m = state().launches[l.publicKey.toBase58()];
  if (!m) throw new Error("no such launch");
  m.state.pqIdentity = Uint8Array.from(creator.identityId);
  return launchBySymbol(symbol);
}

async function land(tx: T.AnyTransaction): Promise<string> {
  const sim = await phx.simulateAndExplain(conn, tx);
  if (!sim.ok) throw new Error(`simulation failed: ${sim.error ?? "?"}`);
  return phx.sendAndConfirm(conn, tx);
}

async function refusal(build: () => Promise<{ tx: T.AnyTransaction }>): Promise<string> {
  try {
    const b = await build();
    const sim = await phx.simulateAndExplain(conn, b.tx);
    expect(sim.ok).toBe(false);
    return sim.error ?? "";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

let ledger: adapter.LeafLedger;

/** The app's own signing path on the simulated chain (the backend's signAuthorization, with the SDK's guards). */
async function signFor(l: T.LaunchAccount, p: AuthPayload, extra: Partial<{ freezeNotAfter: number; acknowledgeExtraSignatures: boolean; ledger: adapter.LeafLedger }> = {}) {
  return phx.signAuthorization(conn, l.publicKey, { kind: p.kind, payloadHash: p.hash, creator: l.creator, identity: creator, ledger: extra.ledger ?? ledger, ...extra });
}

async function authorize(l: T.LaunchAccount, p: AuthPayload, payer: PublicKey): Promise<void> {
  const s = await signFor(l, p);
  await land((await phx.buildPqAuthorizeTx(conn, payer, l.publicKey, { kind: p.kind, payloadHash: p.hash, lmsPublicKey: s.lmsPublicKey, leaf: s.leaf, signature: s.signature })).tx);
}

function burnGraph(decimals: number): Graph {
  return { operator: null, recipients: [], tokenDecimals: decimals, nodes: [graphNode("burn", { kind: "every", secs: 86_400 }, null, { kind: "burn", maxTokens: 1_000n * 10n ** BigInt(decimals) }, {}, decimals)] };
}

async function switchOn(l: T.LaunchAccount, g: Graph, payer: PublicKey): Promise<Uint8Array> {
  const b = buildGraph(g);
  if (!b.ok) throw new Error(b.issues[0]?.message);
  await land((await phx.buildPublishGraphTx(conn, payer, l.publicKey, b.bytes)).tx);
  const at = now() + 60;
  await authorize(l, activationPayload(autopilotAddress(l.publicKey), b.hash, at), payer);
  await land((await phx.buildActivateGraphTx(conn, payer, l.publicKey, b.hash, at)).tx);
  vi.setSystemTime(Date.now() + 90_000);
  await land((await phx.buildApplyPendingTx(conn, payer, l.publicKey)).tx);
  return b.hash;
}

describe("the simulated chain runs the SDK's guards before an Autopilot signature", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    replaceStateForTests(seedState());
    resetProgrammableForTests();
    ledger = adapter.leafLedger.createMemoryLeafLedger();
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("a clock the network disagrees with refuses a time it would sign (the demo's network-clock scenario)", async () => {
    const l = await mine("LNTN");
    const store = new Map<string, string>([[DEMO_CLOCK_OFFSET_KEY, "600"]]);
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    expect(() => mockCheckClockSkew()).toThrow(sdk.ClockSkewError);
    const p = activationPayload(autopilotAddress(l.publicKey), new Uint8Array(32).fill(1), now() + 600);
    const e = await signFor(l, p).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(sdk.ClockSkewError);
    expect(signRefusalOf(e)?.message).toBe(clockSkewText(600));
    expect(await ledger.list(creator.identityId)).toEqual([]);
    store.delete(DEMO_CLOCK_OFFSET_KEY);
    expect((await signFor(l, p)).leaf).toBeGreaterThanOrEqual(0);
  });

  it("a freeze approval longer than 24 hours is never signed", async () => {
    const l = await mine("LNTN");
    const until = now() + 86_400 + 600;
    const p = { ...activationPayload(autopilotAddress(l.publicKey), new Uint8Array(32).fill(2), until), kind: 2 as const };
    await expect(signFor(l, p, { freezeNotAfter: until })).rejects.toThrow(/at most 24 hours/);
    expect(await ledger.list(creator.identityId)).toEqual([]);
  });

  it("three approvals of one kind that never landed: the fourth only when confirmed (SignatureCapError)", async () => {
    const l = await mine("LNTN");
    const ap = autopilotAddress(l.publicKey);
    for (let i = 0; i < 3; i++) await signFor(l, activationPayload(ap, new Uint8Array(32).fill(i + 1), now() + 600 + i));
    const fourth = activationPayload(ap, new Uint8Array(32).fill(9), now() + 900);
    const e = await signFor(l, fourth).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(sdk.SignatureCapError);
    expect(signRefusalOf(e)).toMatchObject({ kind: "cap", count: 3 });
    expect((await signFor(l, fourth, { acknowledgeExtraSignatures: true })).leaf).toBeGreaterThanOrEqual(0);
  });

  it("a key used on another device refuses before anything is reserved; a confirmation of a few, read again, clears it", async () => {
    const l = await mine("LNTN");
    const payer = demoUser();
    await land((await phx.buildInitAutopilotTx(conn, payer, l.publicKey)).tx);
    await switchOn(l, burnGraph(l.tokenDecimal), payer);
    const mineBefore = await ledger.list(creator.identityId);
    // Another device's signature landed: its leaf is set on-chain, and this browser never made it.
    const used = await phx.fetchIdentityLeaves(conn, creator.identityId);
    const elsewhere = Array.from({ length: 1_024 }, (_, q) => 1_023 - q).find((q) => !adapter.pqIdentity.leafUsed(used, q) && !mineBefore.some((r) => r.leaf === q)) ?? 1_000;
    const m = state().identities[adapter.identityAddressFromId(creator.identityId).toBase58()];
    if (!m) throw new Error("no identity account");
    adapter.pqIdentity.markLeafUsed(m.used, elsewhere);
    const p = activationPayload(autopilotAddress(l.publicKey), new Uint8Array(32).fill(5), now() + 600);
    const e = await signFor(l, p).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(sdk.UnknownLeavesError);
    expect(signRefusalOf(e)).toMatchObject({ kind: "unknown-leaves", count: 1 });
    // Nothing was reserved or signed (the earlier approval was only reconciled: landed, as its record shows).
    expect((await ledger.list(creator.identityId)).map((r) => [r.leaf, r.messageHash])).toEqual(mineBefore.map((r) => [r.leaf, r.messageHash]));
    expect((await ledger.list(creator.identityId)).every((r) => r.status === "landed" && r.attested === true)).toBe(true);
    // Read again (no second connection on the simulated chain), confirmed with the count shown, then it signs.
    const rc = await recheckUnknown({ conn, second: null, ledger, identityId: creator.identityId, read: (c, id) => phx.fetchIdentityLeaves(c, id) });
    expect(rc).toMatchObject({ count: 1, canConfirm: true });
    expect(await confirmUnknown(ledger, creator.publicKey, rc.used, rc.count)).toBe(1);
    expect((await signFor(l, p)).leaf).not.toBe(elsewhere);
  });

  it("the operator's removal names the activation in force (payload v3)", async () => {
    const l = await mine("LNTN");
    const payer = demoUser();
    await land((await phx.buildInitAutopilotTx(conn, payer, l.publicKey)).tx);
    await switchOn(l, burnGraph(l.tokenDecimal), payer);
    const info = await phx.fetchAutopilot(conn, l.publicKey);
    expect(info?.activeAuth).not.toBeNull();
    // The activation that switched it on (auth_marks[0]) is the one in force.
    expect(info?.activeAuth?.toBase58()).toBe(governanceForTests(l.publicKey)?.authMarks[0]?.key);
  });
});

describe("runs on the simulated chain (audit 4: burn price, skipped payees)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    replaceStateForTests(seedState());
    resetProgrammableForTests();
    ledger = adapter.leafLedger.createMemoryLeafLedger();
  });
  afterEach(() => vi.useRealTimers());

  it("a burn before graduation earns no tip (its tokens are valued at the burn price: nothing yet)", async () => {
    const l = await mine("LNTN");
    const keeper = demoUser();
    await land((await phx.buildInitAutopilotTx(conn, keeper, l.publicKey)).tx);
    await switchOn(l, burnGraph(l.tokenDecimal), keeper);
    fundTreasuryForTests(l.publicKey, 1_000_000_000n, 10_000n * 10n ** BigInt(l.tokenDecimal));
    const [d] = await phx.findDueSteps(conn, l.publicKey, keeper);
    expect(d?.tip).toBe(0n);
    // What running it costs the keeper: the fee, and its own wSOL account for the tip (never a recipient's).
    expect(d?.costs?.signatureFeeLamports).toBe(5_000n);
    expect(d?.costs?.totalLamports).toBe((d?.costs?.signatureFeeLamports ?? 0n) + (d?.costs?.rentLamports ?? 0n));
    const before = await phx.fetchAutopilot(conn, l.publicKey);
    const built = await phx.buildRunStepTx(conn, keeper, l.publicKey, 0);
    expect(built.costs.totalLamports).toBe(d?.costs?.totalLamports);
    await land(built.tx);
    const after = await phx.fetchAutopilot(conn, l.publicKey);
    expect(after?.totalTips).toBe(before?.totalTips);
  });

  it("a payout pays only payees with a wSOL account; the others' shares stay; nobody can receive: refused (NoRecipientAccount)", async () => {
    const l = await launchBySymbol("CNDR");
    const before = await phx.fetchAutopilot(conn, l.publicKey);
    if (!before) throw new Error("no autopilot");
    fundTreasuryForTests(l.publicKey, 1_000_000_000n - before.treasurySol, 0n);
    vi.setSystemTime(Date.now() + 6 * 86_400_000);
    const g = await phx.fetchGraphBytes(conn, l.publicKey, before.graphHash ?? new Uint8Array(32));
    if (g === null) throw new Error("no graph");
    const { graphFromBytes, paymentShares } = await import("../src/lib/programmable");
    const graph = graphFromBytes(g, l.tokenDecimal);
    if (graph === null) throw new Error("graph does not decode");
    const [first, second] = graph.recipients.map((r) => new PublicKey(r.address));
    if (!first || !second) throw new Error("two recipients expected");
    const check = await phx.checkGraphRecipients(conn, [first, second]);
    expect(check).toMatchObject({ ok: true, withoutAccount: [] });
    delete state().tokens[tokenKey(second, adapter.WSOL_MINT)];
    const after = await phx.checkGraphRecipients(conn, [first, second]);
    expect(after.withoutAccount.map((k) => k.toBase58())).toEqual([second.toBase58()]);
    expect(after.warnings.join("\n")).toMatch(/has no wSOL account yet: until it creates one, the autopilot skips it/);
    const [d] = await phx.findDueSteps(conn, l.publicKey);
    expect(d?.skippedRecipients).toBe(1);
    const keeper = demoUser();
    const built = await phx.buildRunStepTx(conn, keeper, l.publicKey, 0);
    expect(built.skippedRecipients.map((k) => k.toBase58())).toEqual([second.toBase58()]);
    await land(built.tx);
    const paid = await phx.fetchAutopilot(conn, l.publicKey);
    const shares = paymentShares(graph, 1_000_000_000n);
    expect((paid?.totalPaid ?? 0n) - before.totalPaid).toBe(shares[0]);
    const [run] = await phx.listAutopilotRuns(conn, l.publicKey);
    expect(run?.skippedRecipients).toBe(1);
    // Nobody can receive: not offered, and refused.
    delete state().tokens[tokenKey(first, adapter.WSOL_MINT)];
    vi.setSystemTime(Date.now() + 8 * 86_400_000);
    expect(await phx.findDueSteps(conn, l.publicKey)).toEqual([]);
    expect(await refusal(() => phx.buildRunStepTx(conn, keeper, l.publicKey, 0))).toMatch(/NoRecipientAccount/);
  });

  it("a payee that could never receive is refused by the check (a token account is not a wallet)", async () => {
    const l = await launchBySymbol("MRDN");
    const mint = l.status === "live" ? l.baseMint : PublicKey.default;
    const r = await phx.checkGraphRecipients(conn, [mint]);
    expect(r.ok).toBe(false);
    expect(r.refusals[0]).toMatch(/^recipients\[0\] \(/);
  });
});

describe("the tip a due step should earn (the SDK's keeper estimate)", () => {
  const g = (action: Graph["nodes"][number]["action"]): Graph => ({ operator: null, recipients: [{ address: Keypair.generate().publicKey.toBase58(), bps: 6_000 }, { address: Keypair.generate().publicKey.toBase58(), bps: 4_000 }], tokenDecimals: 6, nodes: [graphNode("x", { kind: "every", secs: 86_400 }, null, action, {}, 6)] });
  const base = { node: 0, graduated: true, reference: 1n << 64n, observations: [], now: 1_800_000_000, tipEpochStart: 1_800_000_000 - (1_800_000_000 % 86_400), tipsInEpoch: 0n, treasurySol: 100_000_000_000n };

  it("a partial buyback earns its share of a tip; a payout's skipped share does not count", () => {
    const full = expectedRunTip({ ...base, graph: g({ kind: "buybackBurn", maxInLamports: 10_000_000_000n, maxPremiumBps: 300 }), amount: 10_000_000_000n, partial: false });
    const half = expectedRunTip({ ...base, graph: g({ kind: "buybackBurn", maxInLamports: 10_000_000_000n, maxPremiumBps: 300 }), amount: 5_000_000_000n, partial: true });
    expect(full).toBe(AUTOPILOT.TIP_LAMPORTS);
    expect(half).toBe(AUTOPILOT.TIP_LAMPORTS / 2n);
    const pay = g({ kind: "distributeSol", maxLamports: 100_000n });
    expect(expectedRunTip({ ...base, graph: pay, amount: 100_000n, partial: false })).toBe(10_000n);
    expect(expectedRunTip({ ...base, graph: pay, amount: 100_000n, partial: false, skipped: [false, true] })).toBe(6_000n);
    expect(expectedRunTip({ ...base, graduated: false, graph: g({ kind: "burn", maxTokens: 10n ** 12n }), amount: 10n ** 12n, partial: false })).toBe(0n);
  });
});

describe("a simulation counts completed runs", () => {
  it("a partial buyback is not a run of its own", () => {
    const run = (partial: boolean) => ({ partial }) as unknown as import("../src/lib/programmable").RunEvent;
    expect(completedRuns({ steps: [{ runs: [run(false), run(true)] }, { runs: [run(false)] }] } as never)).toBe(2);
  });
});

// ----------------------------------------------------------------- launch flow ---

describe("the launch flow stops on the SDK's refusals, in plain words", () => {
  let store: LaunchProgressStore;
  let flowLedger: adapter.LeafLedger;
  let owner: PublicKey;
  const calls: string[] = [];
  const lock: adapter.LedgerLock = <T,>(name: string, fn: () => Promise<T>): Promise<T> => {
    calls.push(name);
    return fn();
  };
  const second = { rpcEndpoint: "https://second.example" } as unknown as Connection;

  function env(over: Partial<FlowEnv> = {}): FlowEnv {
    return {
      conn,
      cluster: "devnet",
      store,
      backend: { ...adapter, ...mock },
      wallet: () => owner,
      walletTx: async (step) => {
        const tx = await step.build();
        const sim = await mock.simulateAndExplain(conn, tx);
        if (!sim.ok) return { status: "failed", error: sim.error ?? "?" };
        return { status: "confirmed", signature: await mock.sendAndConfirm(conn, tx) };
      },
      signer: async () => ({ identity: creator, leaves: flowLedger, lock }),
      secondConnection: () => second,
      keyUnlocked: () => true,
      now: async () => BigInt(Math.floor(Date.now() / 1000)),
      clusterRefusal: async () => null,
      lock: (_name, fn) => fn(),
      ...over,
    };
  }

  async function newLaunch(): Promise<string> {
    const icon = new Uint8Array(4 * 32 * 32).map((_, i) => (i % 4 === 3 ? 255 : (i * 37) % 251));
    const png = await adapter.encodeIndexedPng(icon, 32, 32, 16);
    const doc = adapter.buildMetadataDoc({ name: "Guard Test", symbol: "GRD", description: "A token made by the guard test.", iconPng: png, links: {} });
    const params: adapter.LaunchParams = { ...adapter.PRESETS.fair.params, recipients: [{ wallet: owner, bps: 10_000 }], pqIdentity: creator.identityId };
    return startLaunchFlow({ cluster: "devnet", creator: owner, params, metadata: { name: "Guard Test", symbol: "GRD", doc }, identityIndex: 0, lmsPublicKey: creator.keyPair.publicKey, opensAt: "asap" });
  }

  const view = async (id: string) => {
    const r = runnerForTests(id);
    if (r === null) throw new Error("no runner");
    await r.kick();
    return r.snapshot();
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    replaceStateForTests(seedState());
    resetProgrammableForTests();
    owner = Keypair.generate().publicKey;
    mock.fundDemoWallet(owner);
    store = memoryLaunchStore();
    flowLedger = adapter.leafLedger.createMemoryLeafLedger();
    calls.length = 0;
  });
  afterEach(() => {
    resetLaunchFlowsForTests();
    vi.useRealTimers();
  });

  it("passes this browser's signing lock and a second RPC to the SDK; a refusal stops with what to do, and nothing is signed", async () => {
    const seen: Parameters<typeof adapter.buildPlannedAttestTx>[2][] = [];
    let refuse: "unknown" | "cap" | "clock" | null = "unknown";
    const buildPlannedAttestTx: typeof adapter.buildPlannedAttestTx = async (c, plan, opts) => {
      seen.push(opts);
      if (refuse === "unknown") throw new sdk.UnknownLeavesError(creator.identityId, [5, 6], 2, 0, 9, false);
      if (refuse === "cap" && opts.acknowledgeExtraSignatures !== true) throw new sdk.SignatureCapError(plan.launch, "attestation", [1, 2, 3], 3);
      if (refuse === "clock") throw new sdk.ClockSkewError(1n, 601n, null, 600n, 120n);
      return mock.buildPlannedAttestTx(c, plan, { ...opts, acknowledgeExtraSignatures: undefined });
    };
    configureLaunchFlows(env({ backend: { ...adapter, ...mock, buildPlannedAttestTx } }));
    const id = await newLaunch();
    let v = await view(id);
    expect(v.stage).toBe("sign");
    expect(v.need).toEqual({ kind: "key-used-elsewhere", count: 2, identityIdHex: Buffer.from(creator.identityId).toString("hex"), message: `${UNKNOWN_LEAVES_TEXT} (2 signatures this device doesn't know.)` });
    expect(seen[0]?.signingLock).toBe(lock);
    expect(seen[0]?.secondConnection).toBe(second);
    expect(seen[0]?.acknowledgeExtraSignatures).toBeUndefined();
    expect(await flowLedger.list(creator.identityId)).toEqual([]);

    refuse = "clock";
    await launchFlowAction(id, { kind: "retry" });
    v = await view(id);
    expect(v.need).toEqual({ kind: "retry", message: clockSkewText(600) });

    refuse = "cap";
    await launchFlowAction(id, { kind: "retry" });
    v = await view(id);
    expect(v.need).toMatchObject({ kind: "signature-cap", count: 3 });
    await launchFlowAction(id, { kind: "sign-extra" });
    v = await view(id);
    expect(seen.at(-1)?.acknowledgeExtraSignatures).toBe(true);
    expect(v.need).toBeNull();
    expect(v.window).not.toBeNull();
    // The confirmation covered that one signature: the next one is counted again.
    expect((await store.get(id))?.extraSignature).toBe(false);
  }, 60_000);
});
